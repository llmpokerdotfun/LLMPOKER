/**
 * Reference agent whose every decision comes from a real LLM.
 *
 * `scripts/demo-agents.ts` shows the *transport* path and makes its moves with a
 * hard-coded heuristic. This script shows the *judgement* path: the server hands
 * the agent the exact legal action set for its turn, the agent turns that into a
 * prompt, and whatever the model returns is what gets played.
 *
 * There is deliberately **no heuristic fallback**. If the model does not produce
 * a legal action the agent does not act at all, and the table's think-budget
 * watchdog folds it (`origin: "TIMEOUT"`). Substituting a guess would defeat the
 * point of the exercise: the move is the model's, and a non-answer is a
 * non-answer.
 *
 *   LLM_API_KEY=sk-... npm run agent:llm
 *
 * Environment:
 *   LLMPOKER_API       base URL        (default http://127.0.0.1:8787)
 *   LLMPOKER_TABLE     table id        (default free-0-1)
 *   LLMPOKER_BUY_IN    play chips      (default: the table's own maxBuyIn)
 *   LLM_BASE_URL       OpenAI-compatible base (default https://api.openai.com/v1)
 *   LLM_API_KEY        required
 *   LLM_MODEL          default gpt-4o-mini
 *   LLM_TEMPERATURE    default 0.4
 *   LLM_AGENT_NAME     default "Reasoning Agent"
 *   LLM_AGENT_WALLET   optional 0x address, else derived from the name
 *   LLM_JSON_MODE      "1" to send response_format: json_object
 *   LLM_LOG_PROMPTS    "1" to print each prompt and raw reply
 *
 * Free tables only, on purpose: wager tables additionally require an EIP-712
 * signature per action, which is a wallet concern rather than an LLM one.
 */

import WebSocket from 'ws';
import {
  cardToString,
  type ActionRequest,
  type ActionType,
  type Card,
  type ServerMessage,
} from '@llmpoker/shared';

const API = (process.env.LLMPOKER_API ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const TABLE_ID = process.env.LLMPOKER_TABLE ?? 'free-0-1';
const BUY_IN = process.env.LLMPOKER_BUY_IN ?? null;
const AGENT_NAME = process.env.LLM_AGENT_NAME ?? 'Reasoning Agent';
const WALLET = process.env.LLM_AGENT_WALLET ?? derivedWallet(AGENT_NAME);

const LLM_BASE = (process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
const LLM_KEY = process.env.LLM_API_KEY ?? '';
const LLM_MODEL = process.env.LLM_MODEL ?? 'gpt-4o-mini';
const TEMPERATURE = Number(process.env.LLM_TEMPERATURE ?? 0.4);
const JSON_MODE = process.env.LLM_JSON_MODE === '1';
const LOG_PROMPTS = process.env.LLM_LOG_PROMPTS === '1';

const log = (message: string): void => console.log(`[llm-agent] ${message}`);

/** A stable pseudo-address so re-runs reuse the same identity. */
function derivedWallet(seed: string): string {
  let h = 2166136261;
  let out = '';
  for (let i = 0; out.length < 40; i++) {
    h ^= seed.charCodeAt(i % seed.length) + i;
    h = Math.imul(h, 16777619) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return `0x${out.slice(0, 40)}`;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) {
    let code = '';
    try {
      code = (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? '';
    } catch {
      /* non-JSON error body */
    }
    throw Object.assign(new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}: ${text}`), {
      status: response.status,
      code,
    });
  }
  return (text === '' ? null : JSON.parse(text)) as T;
}

/** The system prompt. Short and strict: one action, JSON only. */
const SYSTEM = `You are an expert no-limit Texas Hold'em player, playing 6-max on an
agent-only table. You are given the exact legal actions for your turn.

Choose exactly one action and reply with ONLY a JSON object, no prose:
{"action":"FOLD"|"CHECK"|"CALL"|"BET"|"RAISE"|"ALL_IN","amount":"<chips>","reasoning":"<one short sentence>"}

Rules you must respect:
- "amount" is required for BET and RAISE and must be omitted for the others.
- BET/RAISE amounts are the TOTAL you will have committed on this street
  ("raise to"), not the increment. It must be between minRaiseTo and maxRaiseTo.
- Only use an action the legal set allows.
- Chips are plain integers on a free table.
Play sound, aggressive-when-ahead poker. Do not invent cards you were not given.`;

/** Human-readable board/hole cards, e.g. ["As","Td"]. */
const cards = (list: readonly Card[]): string => list.map((c) => cardToString(c)).join(' ');

function userPrompt(request: ActionRequest, tableName: string): string {
  const { legal } = request;
  const allowed = [
    legal.canFold ? 'FOLD' : null,
    legal.canCheck ? 'CHECK' : null,
    legal.canCall ? `CALL (costs ${legal.toCall})` : null,
    legal.canBet ? `BET (to ${legal.minRaiseTo}..${legal.maxRaiseTo})` : null,
    legal.canRaise ? `RAISE (to ${legal.minRaiseTo}..${legal.maxRaiseTo})` : null,
    legal.canAllIn ? 'ALL_IN' : null,
  ].filter(Boolean);

  return [
    `Table: ${tableName} (${TABLE_ID})`,
    `Hand: ${request.handId}, street: ${request.street}`,
    `Your seat: ${request.seat}`,
    `Your whole cards: ${cards(request.holeCards)}`,
    request.board.length > 0 ? `Board: ${cards(request.board)}` : 'Board: (preflop, no community cards yet)',
    `Pot: ${request.pot}`,
    `Your stack behind: ${request.stack}`,
    `Chips to call: ${legal.toCall}`,
    `Raise/bet targets you may use: ${legal.sizedTargets.join(', ') || '(none)'}`,
    `LEGAL ACTIONS: ${allowed.join(' | ')}`,
    '',
    'Reply with the JSON object only.',
  ].join('\n');
}

interface Decision {
  action: ActionType;
  amount?: string;
  reasoning?: string;
}

const NAMED: readonly ActionType[] = ['FOLD', 'CHECK', 'CALL', 'BET', 'RAISE', 'ALL_IN'];

/** Pulls the first JSON object out of a model reply, tolerating code fences. */
function parseDecision(text: string): Decision | string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = (fenced?.[1] ?? text).trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return 'the reply contained no JSON object';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    return `the reply was not valid JSON (${(error as Error).message})`;
  }
  if (typeof parsed !== 'object' || parsed === null) return 'the reply was not a JSON object';
  const record = parsed as Record<string, unknown>;
  const name = typeof record.action === 'string' ? record.action.toUpperCase() : '';
  if (!(NAMED as readonly string[]).includes(name)) {
    return `"${String(record.action)}" is not one of FOLD, CHECK, CALL, BET, RAISE, ALL_IN`;
  }
  const decision: Decision = { action: name as ActionType };
  if (typeof record.reasoning === 'string') decision.reasoning = record.reasoning.slice(0, 160);
  if (record.amount !== undefined && record.amount !== null) {
    const amount = String(record.amount);
    if (!/^[0-9]+$/.test(amount)) return `amount ${JSON.stringify(record.amount)} is not a whole number of chips`;
    decision.amount = amount;
  }
  return decision;
}

/** Checks a decision against the exact legal set the server sent. */
function legality(decision: Decision, request: ActionRequest): string | null {
  const { legal } = request;
  const needsAmount = decision.action === 'BET' || decision.action === 'RAISE';
  if (needsAmount && decision.amount === undefined) return `${decision.action} needs an amount`;
  if (!needsAmount && decision.amount !== undefined) return `${decision.action} takes no amount`;

  if (decision.action === 'FOLD' && !legal.canFold) return 'FOLD is not legal here';
  if (decision.action === 'CHECK' && !legal.canCheck) return `CHECK is not legal; it costs ${legal.toCall} to call`;
  if (decision.action === 'CALL' && !legal.canCall) return 'CALL is not legal here';
  if (decision.action === 'BET' && !legal.canBet) return 'BET is not legal here';
  if (decision.action === 'RAISE' && !legal.canRaise) return 'RAISE is not legal here';
  if (decision.action === 'ALL_IN' && !legal.canAllIn) return 'ALL_IN is not legal here';

  if (needsAmount) {
    const amount = BigInt(decision.amount!);
    const min = BigInt(legal.minRaiseTo);
    const max = BigInt(legal.maxRaiseTo);
    if (amount < min || amount > max) return `amount ${amount} is outside ${min}..${max}`;
  }
  return null;
}

interface ChatReply {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

/** One turn of the model. Returns the parsed decision, or a complaint to re-ask with. */
async function askModel(request: ActionRequest, tableName: string, complaint?: string): Promise<Decision | string> {
  if (LLM_KEY === '') return 'LLM_API_KEY is not set, so no move can be decided';

  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: userPrompt(request, tableName) },
  ];
  if (complaint !== undefined) {
    messages.push({ role: 'user', content: `That was rejected: ${complaint}. Reply with a corrected JSON object only.` });
  }
  if (LOG_PROMPTS) log(`prompt:\n${messages[messages.length - 1]!.content}`);

  const body: Record<string, unknown> = { model: LLM_MODEL, messages, temperature: TEMPERATURE };
  if (JSON_MODE) body.response_format = { type: 'json_object' };

  let reply: ChatReply;
  try {
    const response = await fetch(`${LLM_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${LLM_KEY}` },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) return `the model endpoint returned ${response.status}: ${text.slice(0, 200)}`;
    reply = JSON.parse(text) as ChatReply;
  } catch (error) {
    return `could not reach the model endpoint (${(error as Error).message})`;
  }

  const content = reply.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') return 'the model returned an empty reply';
  if (LOG_PROMPTS) log(`reply: ${content.trim()}`);
  return parseDecision(content);
}

interface Snapshot {
  config: { name: string; maxBuyIn: string };
  seats: { seat: number; status: string; agentId: string | null }[];
  street: string;
}

async function main(): Promise<void> {
  log(`base ${API}, table ${TABLE_ID}, model ${LLM_MODEL} at ${LLM_BASE}`);

  const registration = await api<{ agent: { id: string }; apiKey: string }>('/api/v1/agents/register', {
    method: 'POST',
    body: JSON.stringify({ name: AGENT_NAME, wallet: WALLET, metadata: { model: LLM_MODEL, agent: 'agent-llm' } }),
  });
  const apiKey = registration.apiKey;
  const agentId = registration.agent.id;
  log(`registered ${AGENT_NAME} as ${agentId}`);

  const before = await api<Snapshot>(`/api/v1/tables/${TABLE_ID}`);
  const buyIn = BUY_IN ?? before.config.maxBuyIn;
  const seated = await api<{ seat: number }>(`/api/v1/tables/${TABLE_ID}/seat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ buyIn }),
  });
  const mySeat = seated.seat;
  log(`seated at ${TABLE_ID} seat ${mySeat} with ${buyIn} play chips`);

  /** Turns already answered, so a re-delivered frame cannot double-act. */
  const answered = new Set<string>();
  let deciding = false;
  let stopped = false;

  const stop = (why: string, code = 0): void => {
    if (stopped) return;
    stopped = true;
    log(`stopping: ${why}`);
    socket.close();
    process.exitCode = code;
  };

  /** Notices that we are no longer a player at this table (busted, or unseated). */
  const checkStillSeated = async (): Promise<void> => {
    try {
      const snapshot = await api<Snapshot>(`/api/v1/tables/${TABLE_ID}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
      const mine = snapshot.seats.find((s) => s.seat === mySeat);
      if (!mine || mine.agentId !== agentId) {
        stop(`seat ${mySeat} is no longer ours (status ${mine?.status ?? 'EMPTY'}); we are out of the table`, 0);
        return;
      }
      if (mine.status === 'BUSTED') {
        stop(`seat ${mySeat} is BUSTED; we are out of the table`, 0);
      }
    } catch (error) {
      const failure = error as { status?: number; code?: string };
      if (failure.status === 403 || failure.code === 'NOT_SEATED' || failure.code === 'SEAT_NOT_FOUND') {
        stop('the server says we are not seated here', 0);
      } else {
        log(`seat check failed (will retry): ${(error as Error).message}`);
      }
    }
  };

  const decide = async (request: ActionRequest, tableName: string): Promise<void> => {
    const turnKey = `${request.handId}:${request.street}:${request.deadlineTs}`;
    if (answered.has(turnKey) || deciding) return;
    deciding = true;
    answered.add(turnKey);
    if (answered.size > 500) answered.clear();

    try {
      let decision = await askModel(request, tableName);
      for (let attempt = 0; attempt < 2; attempt++) {
        if (typeof decision === 'string') {
          log(`model reply rejected (${decision}); re-asking`);
          decision = await askModel(request, tableName, decision);
          continue;
        }
        const problem = legality(decision, request);
        if (problem === null) break;
        log(`illegal move (${problem}); re-asking`);
        decision = await askModel(request, tableName, problem);
      }

      if (typeof decision === 'string') {
        log(`no legal move from the model (${decision}). Not acting: the think-budget watchdog will handle this turn.`);
        return;
      }
      const problem = legality(decision, request);
      if (problem !== null) {
        log(`giving up on ${request.handId} ${request.street}: ${problem}. Not acting.`);
        return;
      }

      const payload: { action: string; amount?: string } = { action: decision.action };
      if (decision.amount !== undefined) payload.amount = decision.amount;
      await api(`/api/v1/tables/${TABLE_ID}/act`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(payload),
      });
      log(
        `${request.street} seat ${request.seat}: ${decision.action}${decision.amount ? ` ${decision.amount}` : ''}` +
          `${decision.reasoning ? `  (${decision.reasoning})` : ''}`,
      );
    } catch (error) {
      const failure = error as { status?: number; code?: string };
      if (failure.status === 403 || failure.code === 'NOT_SEATED' || failure.code === 'SEAT_NOT_FOUND') {
        stop('the server refused our action because we are no longer seated', 0);
        return;
      }
      log(`action failed: ${(error as Error).message}`);
    } finally {
      deciding = false;
    }
  };

  const socket = new WebSocket(`${API.replace(/^http/, 'ws')}/api/v1/ws?table=${TABLE_ID}&token=${apiKey}`);

  socket.on('message', (raw: Buffer) => {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw.toString()) as ServerMessage;
    } catch {
      return;
    }
    if (message.type === 'ACTION_REQUIRED') {
      void decide(message.request, before.config.name);
    }
  });
  socket.on('error', (error: Error) => log(`feed error: ${error.message}`));
  socket.on('close', () => {
    if (!stopped) log('feed closed by the server');
    process.exitCode = process.exitCode ?? 0;
  });

  // The socket carries turns; this notices when the seat itself goes away.
  setInterval(() => {
    if (!stopped) void checkStillSeated();
  }, 5_000).unref?.();

  process.on('SIGINT', () => {
    stop('interrupted');
  });

  if (before.seats.filter((s) => s.agentId !== null).length < 1) {
    log('note: a hand needs at least 2 seated agents, so nothing is dealt until another agent sits down');
  }
}

main().catch((error: unknown) => {
  log(`fatal: ${(error as Error).message}`);
  process.exitCode = 1;
});
