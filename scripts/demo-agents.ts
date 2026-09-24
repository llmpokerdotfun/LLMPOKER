/**
 * Demo agents: drives a **running** server so the site has something to look at.
 *
 * Unlike `e2e-agent-hand.ts` (which boots its own server and asserts), this is a
 * long-running driver. Each agent opens its own WebSocket feed with its API key,
 * and answers the real `ACTION_REQUIRED` frames the server sends it — the same
 * path a third-party agent takes. Free mode needs no wallet signature, so API
 * keys are enough.
 *
 *   npm run demo                      # against http://127.0.0.1:8787
 *   LLMPOKER_API=http://host:8787 DEMO_AGENTS=6 npm run demo
 */

import WebSocket from 'ws';
import type { ActionRequest, ServerMessage } from '@llmpoker/shared';

const API = (process.env.LLMPOKER_API ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const SQUAD = Number(process.env.DEMO_AGENTS ?? 4);
const NAMES = ['Hermes', 'Clawd', 'Muse', 'GrokBot', 'Athena', 'Nyx', 'Vega', 'Orion'];

interface DemoAgent {
  name: string;
  agentId: string;
  apiKey: string;
  wallet: string;
  seat: number | null;
  decisions: number;
  pending: ActionRequest | null;
  socket: WebSocket | null;
}

const log = (message: string): void => console.log(`[demo] ${message}`);

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${response.status}: ${text}`);
  return (text === '' ? null : JSON.parse(text)) as T;
}

/** A deterministic pseudo-address: the demo does not need a real key. */
function demoWallet(index: number): string {
  return `0x${(index + 1).toString(16).padStart(2, '0').repeat(20).slice(0, 40)}`;
}

async function registerAgents(): Promise<DemoAgent[]> {
  const agents: DemoAgent[] = [];
  for (let i = 0; i < SQUAD; i++) {
    const name = NAMES[i % NAMES.length]!;
    const body = await api<{ agent: { id: string }; apiKey: string; wallet?: string }>(
      '/api/v1/agents/register',
      {
        method: 'POST',
        body: JSON.stringify({
          name,
          wallet: demoWallet(i),
          metadata: { model: name.toLowerCase(), demo: true },
        }),
      },
    );
    agents.push({
      name,
      agentId: body.agent.id,
      apiKey: body.apiKey,
      wallet: demoWallet(i),
      seat: null,
      decisions: 0,
      pending: null,
      socket: null,
    });
    log(`registered ${name} (${body.agent.id})`);
  }
  return agents;
}

/** Seats the squad across the free tables and attaches one feed per agent. */
async function seatAndSubscribe(
  agents: DemoAgent[],
  tables: { id: string; config: { maxBuyIn: string } }[],
): Promise<void> {
  const perTable = Math.max(2, Math.ceil(agents.length / tables.length));
  let cursor = 0;

  for (const table of tables) {
    const tableId = table.id;
    // Buy in at the table's own maximum: the range is per-table, so a hard-coded
    // amount is wrong the moment a tier changes.
    const buyIn = table.config.maxBuyIn;
    for (let i = 0; i < perTable && cursor < agents.length; i++, cursor++) {
      const agent = agents[cursor]!;
      try {
        const seated = await api<{ seat: number }>(`/api/v1/tables/${tableId}/seat`, {
          method: 'POST',
          headers: { authorization: `Bearer ${agent.apiKey}` },
          body: JSON.stringify({ buyIn }),
        });
        agent.seat = seated.seat;
        log(`${agent.name} seated at ${tableId} seat ${seated.seat} with ${buyIn}`);
      } catch (error) {
        log(`could not seat ${agent.name} at ${tableId}: ${(error as Error).message}`);
        continue;
      }

      const socket = new WebSocket(
        `${API.replace(/^http/, 'ws')}/api/v1/ws?table=${tableId}&token=${agent.apiKey}`,
      );
      agent.socket = socket;
      socket.on('message', (raw: Buffer) => {
        const message = JSON.parse(raw.toString()) as ServerMessage;
        if (message.type === 'ACTION_REQUIRED') agent.pending = message.request;
      });
      socket.on('error', (error: Error) => log(`${agent.name} feed error: ${error.message}`));
    }
  }
}

/** Legal, mildly positional, and never folds when checking is free. */
function decide(request: ActionRequest, seed: number): { action: string; amount?: string } {
  const legal = request.legal;
  if (legal.canCheck) {
    if (legal.canBet && seed % 5 === 0 && BigInt(legal.minRaiseTo) < BigInt(legal.maxRaiseTo)) {
      return { action: 'BET', amount: legal.minRaiseTo };
    }
    return { action: 'CHECK' };
  }
  if (legal.canRaise && seed % 7 === 0 && BigInt(legal.minRaiseTo) < BigInt(legal.maxRaiseTo)) {
    return { action: 'RAISE', amount: legal.minRaiseTo };
  }
  const toCall = BigInt(legal.toCall);
  return toCall * 2n <= BigInt(request.pot) ? { action: 'CALL' } : { action: 'FOLD' };
}

async function main(): Promise<void> {
  const health = await api<{ freeTables: number; freeGate: { enabled: boolean } }>('/api/v1/health');
  log(`server OK: ${health.freeTables} free tables, token gate ${health.freeGate.enabled ? 'ON' : 'off'}`);
  if (health.freeGate.enabled) {
    log('note: the free-table token gate is ON — agents without 50 000 LLMPOKER will be refused');
  }

  const { tables } = await api<{ tables: { id: string; mode: string; config: { maxBuyIn: string } }[] }>(
    '/api/v1/tables',
  );
  const freeTables = tables.filter((t) => t.mode === 'FREE');
  if (freeTables.length === 0) throw new Error('no free tables exist on this server');

  const agents = await registerAgents();
  await seatAndSubscribe(agents, freeTables);
  log('answering ACTION_REQUIRED frames — leave this running and open the site');

  let acted = 0;
  for (;;) {
    let didSomething = false;
    for (const agent of agents) {
      const request = agent.pending;
      if (!request) continue;
      agent.pending = null;
      const choice = decide(request, agent.decisions + request.handId.length);
      try {
        await api(`/api/v1/tables/${request.tableId}/act`, {
          method: 'POST',
          headers: { authorization: `Bearer ${agent.apiKey}` },
          body: JSON.stringify(choice),
        });
        agent.decisions += 1;
        acted += 1;
        didSomething = true;
        if (acted % 25 === 0) log(`${acted} actions so far (${agent.name}: ${request.street})`);
      } catch (error) {
        const message = (error as Error).message;
        if (!message.includes('NOT_YOUR_TURN') && !message.includes('no live hand') && !message.includes('already complete')) {
          log(`${agent.name}: ${message}`);
        }
      }
    }
    if (!didSomething) await new Promise((r) => setTimeout(r, 150));
  }
}

main().catch((error: unknown) => {
  console.error('[demo] failed:', error);
  process.exit(1);
});
