/**
 * End-to-end acceptance run (SRS §8).
 *
 * Boots a real server on an ephemeral port, registers three autonomous agents
 * (each proves wallet ownership with a genuine EIP-712 signature), seats them at
 * a free table, and lets them play hands with **no human input**: every action is
 * decided from the `ACTION_REQUIRED` frame the agent receives over its own
 * WebSocket. Then it re-verifies every published hand independently.
 *
 * Run with `npm run e2e`.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import WebSocket from 'ws';
import {
  AGENT_REGISTRATION_TYPES,
  type ActionRequest,
  type HandHistory,
  type ServerMessage,
  type TableSnapshot,
  cardToString,
} from '@llmpoker/shared';
import { verifyAuditLog, verifyHandHistory } from '@llmpoker/verifier';
import { LocalChain, LocalEscrow } from '../packages/server/src/chain.js';
import { loadConfig } from '../packages/server/src/config.js';
import { buildApp } from '../packages/server/src/app.js';
import { Orchestrator } from '../packages/server/src/orchestrator.js';
import { Store } from '../packages/server/src/store.js';

const HANDS_TO_PLAY = Number(process.env.E2E_HANDS ?? 3);
const TABLE_ID = 'free-0-1';

interface AgentHandle {
  name: string;
  wallet: Wallet;
  apiKey: string;
  agentId: string;
  token: string;
  socket: WebSocket | null;
  /** The turn currently waiting for this agent, if any. */
  pending: ActionRequest | null;
  decisions: number;
  timeouts: number;
}

const log = (message: string): void => console.log(message);

async function post(base: string, path: string, body: unknown, apiKey?: string): Promise<unknown> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${path} → ${response.status}: ${text}`);
  return text === '' ? null : JSON.parse(text);
}

async function get<T>(base: string, path: string): Promise<T> {
  const response = await fetch(`${base}${path}`);
  if (!response.ok) throw new Error(`GET ${path} → ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

/** Registers an agent and completes the signed-nonce auth flow (FR-1.2/1.3). */
async function createAgent(base: string, name: string): Promise<AgentHandle> {
  const wallet = Wallet.createRandom();
  const registration = (await post(base, '/api/v1/agents/register', {
    name,
    wallet: wallet.address,
    metadata: { model: name.toLowerCase(), endpoint: `https://${name.toLowerCase()}.example/think` },
  })) as { agent: { id: string }; apiKey: string; challenge: { nonce: string; deadline: number; typedData: unknown } };

  const typedData = registration.challenge.typedData as {
    domain: Record<string, unknown>;
    message: Record<string, unknown>;
  };
  const signature = await wallet.signTypedData(
    typedData.domain,
    { AgentRegistration: AGENT_REGISTRATION_TYPES.AgentRegistration },
    typedData.message,
  );

  const auth = (await post(base, '/api/v1/agents/auth', {
    agentId: registration.agent.id,
    wallet: wallet.address,
    nonce: registration.challenge.nonce,
    deadline: registration.challenge.deadline,
    signature,
  })) as { token: string };

  return {
    name,
    wallet,
    apiKey: registration.apiKey,
    agentId: registration.agent.id,
    token: auth.token,
    socket: null,
    pending: null,
    decisions: 0,
    timeouts: 0,
  };
}

/** Attaches the agent's private table feed so it receives its own turns. */
function attachSocket(base: string, agent: AgentHandle): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = base.replace(/^http/, 'ws') + `/api/v1/ws?table=${TABLE_ID}&token=${agent.token}`;
    const socket = new WebSocket(url);
    agent.socket = socket;
    socket.on('message', (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type === 'ACTION_REQUIRED') agent.pending = message.request;
      if (message.type === 'SUBSCRIBED') resolve();
    });
    socket.on('error', reject);
    setTimeout(() => resolve(), 1_000);
  });
}

/**
 * The agent's entire poker brain: a legal, position-aware policy. The point of
 * the acceptance test is that no human is involved, not that the bot is strong.
 */
function decide(request: ActionRequest, aggressionSeed: number): { action: string; amount?: string } {
  const { legal } = request;
  if (legal.canCheck) {
    // Occasionally fire a small bet (~15% of the time, deterministic per hand).
    if (legal.canBet && aggressionSeed % 7 === 0) {
      const target = BigInt(legal.minRaiseTo);
      if (target < BigInt(legal.maxRaiseTo)) return { action: 'BET', amount: target.toString() };
    }
    return { action: 'CHECK' };
  }
  const toCall = BigInt(legal.toCall);
  // Call cheap bets, fold expensive ones, and raise with a strong seed.
  if (legal.canRaise && aggressionSeed % 11 === 0) {
    return { action: 'RAISE', amount: legal.minRaiseTo };
  }
  if (toCall * 2n <= BigInt(request.pot)) return { action: 'CALL' };
  return { action: 'FOLD' };
}

async function main(): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), 'llmpoker-e2e-'));
  const config = loadConfig({
    LLMPOKER_ROOT: process.cwd(),
    LLMPOKER_DATA_DIR: dataDir,
    LLMPOKER_PERSIST: 'true',
    LLMPOKER_BLOCK_TIME_MS: '20',
    LLMPOKER_TICK_MS: '25',
    LLMPOKER_FREE_TABLES: '1',
    LLMPOKER_WAGER_TABLES: '0',
    LLMPOKER_SETTLEMENT: 'local',
    LLMPOKER_LOG_LEVEL: 'warn',
  });

  const store = new Store({ dataDir, persist: true });
  const anchor = new LocalChain(config.blockTimeMs, 1_000);
  const settlement = new LocalEscrow();
  const orchestrator = new Orchestrator({ config, store, anchor, settlement });
  orchestrator.init();
  const { app, close } = await buildApp({ config, store, orchestrator });
  orchestrator.start();

  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  log(`server listening on ${base} (data in ${dataDir})`);

  try {
    const health = await get<{ ok: boolean; chainId: number; rngAnchor: string; settlement: string }>(
      base,
      '/api/v1/health',
    );
    log(`health: chainId=${health.chainId} anchor=${health.rngAnchor} settlement=${health.settlement}`);

    const names = ['Hermes', 'Clawd', 'Muse'];
    const agents: AgentHandle[] = [];
    for (const name of names) {
      const agent = await createAgent(base, name);
      agents.push(agent);
      log(`registered ${name}: ${agent.agentId} (wallet ${agent.wallet.address})`);
    }

    for (const agent of agents) {
      await post(base, `/api/v1/tables/${TABLE_ID}/seat`, { buyIn: '200' }, agent.apiKey);
      await attachSocket(base, agent);
    }
    const seated = await get<TableSnapshot>(base, `/api/v1/tables/${TABLE_ID}`);
    log(`seated: ${seated.seats.filter((s) => s.agentId).map((s) => `${s.agentName}@${s.seat}`).join(', ')}`);

    // Track hand completions over the public monitor feed (FR-7.5).
    const completed: string[] = [];
    const monitor = new WebSocket(base.replace(/^http/, 'ws') + '/api/v1/ws');
    let monitorFrames = 0;
    monitor.on('message', (raw: Buffer) => {
      monitorFrames += 1;
      const message = JSON.parse(raw.toString()) as ServerMessage;
      if (message.type === 'MONITOR_EVENT' && message.event.kind === 'HAND_COMPLETE') {
        completed.push(message.event.handId);
      }
    });
    await new Promise<void>((resolve) => monitor.on('open', () => resolve()));

    const byId = new Map(agents.map((a) => [a.agentId, a]));
    const deadline = Date.now() + 90_000;
    let guard = 0;

    while (completed.length < HANDS_TO_PLAY && Date.now() < deadline && guard++ < 5_000) {
      let acted = false;
      for (const agent of agents) {
        const request = agent.pending;
        if (!request) continue;
        agent.pending = null;
        const choice = decide(request, request.handId.length + request.seat);
        const response = await fetch(`${base}/api/v1/tables/${TABLE_ID}/act`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${agent.apiKey}` },
          body: JSON.stringify(choice),
        });
        if (!response.ok) {
          const text = await response.text();
          if (text.includes('NOT_YOUR_TURN') || text.includes('already complete')) continue;
          throw new Error(`agent ${agent.name} action rejected: ${response.status} ${text}`);
        }
        agent.decisions += 1;
        acted = true;
        log(
          `  ${agent.name} (seat ${request.seat}, ${request.street}) → ${choice.action}${choice.amount ? ` ${choice.amount} chips` : ''}`,
        );
      }
      if (!acted) await new Promise((r) => setTimeout(r, 20));
    }

    monitor.close();
    for (const agent of agents) agent.socket?.close();

    if (completed.length < HANDS_TO_PLAY) {
      throw new Error(`only ${completed.length}/${HANDS_TO_PLAY} hands completed before the deadline`);
    }
    log(`\nplayed ${completed.length} hands with zero human input (${guard} polling iterations)`);

    // ---- independent verification of everything that was published --------
    const list = await get<{ hands: { handId: string; proofVerified: boolean }[]; total: number }>(
      base,
      `/api/v1/hands?tableId=${TABLE_ID}`,
    );
    log(`hand history entries: ${list.total}`);

    let verified = 0;
    for (const summary of list.hands) {
      const history = await get<HandHistory>(base, `/api/v1/hands/${summary.handId}`);
      const verdict = verifyHandHistory(history);
      const serverVerdict = await get<{ proof: { ok: boolean }; deal: { ok: boolean }; settlement: { ok: boolean } }>(
        base,
        `/api/v1/verify/hands/${summary.handId}`,
      );
      if (!verdict.ok) {
        throw new Error(
          `hand ${summary.handId} failed verification:\n${JSON.stringify(
            [...verdict.proof.checks, ...verdict.deal.checks, ...verdict.settlement.checks].filter((c) => !c.ok),
            null,
            2,
          )}`,
        );
      }
      if (!(serverVerdict.proof.ok && serverVerdict.deal.ok && serverVerdict.settlement.ok)) {
        throw new Error(`server verdict disagrees for ${summary.handId}`);
      }
      verified += 1;
      log(
        `  ${summary.handId}: proof+deal+settlement+replay OK | board ${history.result.board.map(cardToString).join(' ')}`,
      );
    }

    // ---- the append-only audit log is independently verifiable ------------
    const audit = verifyAuditLog(readFileSync(join(dataDir, 'hands.jsonl'), 'utf8'));
    log(`audit log: ${audit.passed}/${audit.total} verified, ${audit.failed} failed, ${audit.malformed.length} malformed`);
    if (audit.failed > 0 || audit.malformed.length > 0) throw new Error('audit log verification failed');

    // ---- chips conserved, monitor live ------------------------------------
    const agentsNow = await get<{ agents: { id: string; freeChips: string; stack: string | null }[] }>(
      base,
      '/api/v1/monitor/agents',
    );
    const total = agentsNow.agents.reduce(
      (acc, a) => acc + BigInt(a.freeChips) + BigInt(a.stack ?? '0'),
      0n,
    );
    // Each agent starts with 10 000 play chips; the only way the total grows is
    // the busted-seat top-up in free mode (FR-4.2).
    const STARTING_PLAY_CHIPS = 10_000n * BigInt(agents.length);
    const toppedUp = agents
      .map((a) => store.getAgent(a.agentId)!)
      .reduce((acc, record) => acc + BigInt(record.stats.topUpsReceived), 0n);
    if (total !== STARTING_PLAY_CHIPS + toppedUp) {
      throw new Error(`play chips are not conserved: ${total} (expected ${STARTING_PLAY_CHIPS} + ${toppedUp} top-ups)`);
    }

    const leaderboard = await get<{ rows: { name: string; handsPlayed: number; winRate: number }[] }>(
      base,
      '/api/v1/leaderboards?mode=FREE',
    );

    log('\n--- acceptance report ---');
    log(`agents: ${agents.map((a) => `${a.name}:${a.decisions} decisions`).join(', ')}`);
    log(`ws frames observed by spectators: ${monitorFrames}`);
    log(`hands verified independently: ${verified}/${list.total}`);
    log(`play chips conserved: ${total} (incl. ${toppedUp} free-mode top-ups)`);
    log(
      `leaderboard: ${leaderboard.rows
        .map((r) => `${r.name} ${r.handsPlayed}h ${(r.winRate * 100).toFixed(0)}%`)
        .join(', ')}`,
    );
    log('\nACCEPTANCE RUN PASSED');
    void byId;
  } finally {
    await close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('\nACCEPTANCE RUN FAILED');
    console.error(error);
    process.exit(1);
  });
