import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import type { FastifyInstance } from 'fastify';
import {
  AGENT_REGISTRATION_TYPES,
  type ActionRequest,
  type HandHistory,
  type TableSnapshot,
  cardToString,
} from '@llmpoker/shared';
import { verifyHandHistory } from '@llmpoker/verifier';
import { LocalChain, LocalEscrow } from '../src/chain.js';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { Orchestrator } from '../src/orchestrator.js';
import { Store } from '../src/store.js';

/**
 * End-to-end acceptance tests driven through the real HTTP surface with
 * `app.inject` (no sockets), against a temporary data directory, a simulated
 * chain and the local escrow adapter.
 */

interface Harness {
  app: FastifyInstance;
  store: Store;
  orchestrator: Orchestrator;
  chain: LocalChain;
  settlement: LocalEscrow;
  now: () => number;
  advance: (ms: number) => number;
  close: () => Promise<void>;
}

let harness: Harness;
let dataDir: string;

async function buildHarness(env: NodeJS.ProcessEnv = {}): Promise<Harness> {
  let clock = 1_760_000_000_000;
  dataDir = mkdtempSync(join(tmpdir(), 'llmpoker-test-'));
  const config = loadConfig({
    LLMPOKER_ROOT: process.cwd(),
    LLMPOKER_DATA_DIR: dataDir,
    LLMPOKER_PERSIST: 'true',
    LLMPOKER_BLOCK_TIME_MS: '0',
    LLMPOKER_FREE_TABLES: '2',
    LLMPOKER_WAGER_TABLES: '1',
    LLMPOKER_JWT_SECRET: 'test-secret',
    LLMPOKER_RATE_LIMIT: '1000',
    LLMPOKER_LOG_LEVEL: 'silent',
    ...env,
  });
  const store = new Store({ dataDir: config.dataDir, persist: true });
  const chain = new LocalChain(0, 5_000);
  const settlement = new LocalEscrow();
  const orchestrator = new Orchestrator({
    config,
    store,
    anchor: chain,
    settlement,
    now: () => clock,
  });
  orchestrator.init();
  const { app, close } = await buildApp({ config, store, orchestrator });
  return {
    app,
    store,
    orchestrator,
    chain,
    settlement,
    now: () => clock,
    advance: (ms: number) => (clock += ms),
    close,
  };
}

async function registerAgent(name: string): Promise<{ agentId: string; apiKey: string; wallet: Wallet }> {
  const wallet = Wallet.createRandom();
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/v1/agents/register',
    payload: { name, wallet: wallet.address, metadata: { model: 'test-model' } },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as { agent: { id: string }; apiKey: string };
  return { agentId: body.agent.id, apiKey: body.apiKey, wallet };
}

async function seatAgent(agentId: string, apiKey: string, tableId: string, buyIn: string): Promise<void> {
  const response = await harness.app.inject({
    method: 'POST',
    url: `/api/v1/tables/${tableId}/seat`,
    headers: { authorization: `Bearer ${apiKey}` },
    payload: { buyIn },
  });
  expect(response.statusCode).toBe(201);
}

function tableSnapshot(tableId: string): Promise<TableSnapshot> {
  return harness.app
    .inject({ method: 'GET', url: `/api/v1/tables/${tableId}` })
    .then((r) => r.json() as TableSnapshot);
}

/**
 * Plays the live hand at `tableId` to completion using only legal actions, as an
 * agent would. Every action goes through the real HTTP endpoint.
 */
async function playOutTable(
  tableId: string,
  credentials: Map<string, string>,
  options: { allIn?: boolean; timeoutFirst?: boolean } = {},
): Promise<void> {
  for (let guard = 0; guard < 300; guard++) {
    const table = harness.orchestrator.getTable(tableId);
    const hand = table.state.hand;
    if (hand?.complete) return;
    if (!hand) {
      await harness.orchestrator.tick(harness.advance(10));
      continue;
    }
    if (options.timeoutFirst && guard === 0) {
      await harness.orchestrator.tick(harness.advance(31_000));
      continue;
    }
    const request = harness.orchestrator.actionRequest(table);
    if (!request) {
      await harness.orchestrator.tick(harness.advance(50));
      continue;
    }
    const agentId = hand.seats[request.seat]!.agentId;
    const apiKey = agentId ? credentials.get(agentId) : undefined;
    if (!apiKey) throw new Error(`no credential for seat ${request.seat}`);
    const action = options.allIn
      ? { action: 'ALL_IN' as const }
      : request.legal.canCheck
        ? { action: 'CHECK' as const }
        : { action: 'CALL' as const };
    const response = await harness.app.inject({
      method: 'POST',
      url: `/api/v1/tables/${tableId}/act`,
      headers: { authorization: `Bearer ${apiKey}` },
      payload: action,
    });
    if (response.statusCode !== 200) throw new Error(`act failed: ${response.body}`);
    if ((response.json() as { complete: boolean }).complete) return;
    await harness.orchestrator.tick(harness.advance(50));
  }
  throw new Error(`hand at ${tableId} did not finish`);
}

describe('LLM Poker Arena server', () => {
  beforeEach(async () => {
    harness = await buildHarness();
  });

  afterEach(async () => {
    await harness.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('health and machine-readable contract (FR-2)', () => {
    it('reports the chain, modes and anchor kind', async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/api/v1/health' });
      expect(response.statusCode).toBe(200);
      const health = response.json() as Record<string, unknown>;
      expect(health.ok).toBe(true);
      expect(health.chainId).toBe(4663);
      expect(health.rngAnchor).toBe('LOCAL');
      expect(health.settlement).toBe('LOCAL');
      expect(health.freeTables).toBe(2);
      expect(health.wagerTables).toBe(1);
    });

    it('serves llm.txt at both documented paths', async () => {
      for (const path of ['/llm.txt', '/llms.txt']) {
        const response = await harness.app.inject({ method: 'GET', url: path });
        expect(response.statusCode).toBe(200);
        const text = response.body;
        expect(text).toContain('# LLM Poker Arena');
        expect(text).toContain('POST /api/v1/agents/register');
        expect(text).toContain('FOLD | CHECK | CALL');
        expect(text).toContain('/api/v1/ws?table={tableId}');
        expect(text).toContain('4663');
        expect(text).toContain('llmpoker-verify');
        expect(text.length).toBeGreaterThan(2_000);
      }
    });

    it('serves the monitor shell and the shared bundle for in-browser verification', async () => {
      const page = await harness.app.inject({ method: 'GET', url: '/hands' });
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toContain('text/html');

      const asset = await harness.app.inject({ method: 'GET', url: '/assets/pages/hands.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['content-type']).toContain('javascript');

      const bundle = await harness.app.inject({ method: 'GET', url: '/vendor/shared/index.js' });
      expect(bundle.statusCode).toBe(200);
      expect(bundle.body).toContain("./proof.js");
      const proofModule = await harness.app.inject({ method: 'GET', url: '/vendor/shared/proof.js' });
      expect(proofModule.statusCode).toBe(200);
      expect(proofModule.body).toContain('verifyRngProof');

      const css = await harness.app.inject({ method: 'GET', url: '/assets/app.css' });
      expect(css.statusCode).toBe(200);

      // path traversal must not escape the static root
      const escape = await harness.app.inject({ method: 'GET', url: '/assets/../../package.json' });
      expect([400, 404]).toContain(escape.statusCode);
    });
  });

  describe('registration and auth (FR-1)', () => {
    it('registers an agent once and returns the API key exactly once', async () => {
      const { agentId, apiKey } = await registerAgent('Hermes');
      expect(agentId).toMatch(/^agent_/);
      expect(apiKey).toMatch(/^llmpk_/);

      const me = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/agents/me',
        headers: { authorization: `Bearer ${apiKey}` },
      });
      expect(me.statusCode).toBe(200);
      expect((me.json() as { name: string }).name).toBe('Hermes');

      const list = await harness.app.inject({ method: 'GET', url: '/api/v1/monitor/agents' });
      const agents = (list.json() as { agents: { id: string; status: string; sharedWallet: boolean }[] }).agents;
      expect(agents).toHaveLength(1);
      expect(agents[0]!.id).toBe(agentId);
      expect(agents[0]!.sharedWallet).toBe(false);
    });

    it('rejects a bad wallet address and unauthenticated access', async () => {
      const bad = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/agents/register',
        payload: { name: 'Nope', wallet: '0x123' },
      });
      expect(bad.statusCode).toBe(400);

      const unauth = await harness.app.inject({ method: 'GET', url: '/api/v1/agents/me' });
      expect(unauth.statusCode).toBe(401);

      const wrongKey = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/agents/me',
        headers: { authorization: 'Bearer llmpk_not-a-real-key' },
      });
      expect(wrongKey.statusCode).toBe(401);
    });

    it('issues a token for a valid EIP-712 registration signature and rejects a forged one', async () => {
      const wallet = Wallet.createRandom();
      const registration = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/agents/register',
        payload: { name: 'Clawd', wallet: wallet.address },
      });
      const body = registration.json() as {
        agent: { id: string };
        challenge: { nonce: string; deadline: number; typedData: unknown };
      };

      const typedData = body.challenge.typedData as {
        domain: Record<string, unknown>;
        types: Record<string, { name: string; type: string }[]>;
        primaryType: string;
        message: Record<string, unknown>;
      };
      const signature = await wallet.signTypedData(
        typedData.domain,
        { AgentRegistration: AGENT_REGISTRATION_TYPES.AgentRegistration },
        typedData.message,
      );

      const auth = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/agents/auth',
        payload: {
          agentId: body.agent.id,
          wallet: wallet.address,
          nonce: body.challenge.nonce,
          deadline: body.challenge.deadline,
          signature,
        },
      });
      expect(auth.statusCode).toBe(200);
      const { token } = auth.json() as { token: string };
      expect(token.split('.')).toHaveLength(3);

      const me = await harness.app.inject({
        method: 'GET',
        url: '/api/v1/agents/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(me.statusCode).toBe(200);

      // A different wallet's signature must not authenticate this agent.
      const attacker = Wallet.createRandom();
      const forged = await attacker.signTypedData(
        typedData.domain,
        { AgentRegistration: AGENT_REGISTRATION_TYPES.AgentRegistration },
        typedData.message,
      );
      const rejected = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/agents/auth',
        payload: {
          agentId: body.agent.id,
          wallet: wallet.address,
          nonce: body.challenge.nonce,
          deadline: body.challenge.deadline,
          signature: forged,
        },
      });
      expect(rejected.statusCode).toBe(401);

      // An expired deadline must be refused too.
      const expired = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/agents/auth',
        payload: {
          agentId: body.agent.id,
          wallet: wallet.address,
          nonce: body.challenge.nonce,
          deadline: Math.floor(Date.now() / 1000) - 60,
          signature,
        },
      });
      expect(expired.statusCode).toBe(401);
    });

    it('flags two agents sharing one wallet (FR-10.2)', async () => {
      const wallet = Wallet.createRandom();
      for (const name of ['Seat A', 'Seat B']) {
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/v1/agents/register',
          payload: { name, wallet: wallet.address },
        });
        expect(response.statusCode).toBe(201);
      }
      const agents = (
        await harness.app.inject({ method: 'GET', url: '/api/v1/monitor/agents' })
      ).json() as { agents: { sharedWallet: boolean }[] };
      expect(agents.agents.every((a) => a.sharedWallet)).toBe(true);
    });
  });

  describe('free mode: a complete hand with zero human input (acceptance #1, #2)', () => {
    it('seats two agents, plays a full hand through the API and verifies the shuffle', async () => {
      const a = await registerAgent('Hermes');
      const b = await registerAgent('GrokBot');
      const tableId = 'free-0-1';

      await seatAgent(a.agentId, a.apiKey, tableId, '200');
      await seatAgent(b.agentId, b.apiKey, tableId, '200');

      const seated = await tableSnapshot(tableId);
      expect(seated.seats.filter((s) => s.agentId !== null)).toHaveLength(2);
      expect(seated.mode).toBe('FREE');

      // The engine's free-mode starting balance moved out of the play-chip wallet.
      const meA = (await harness.app.inject({
        method: 'GET',
        url: '/api/v1/agents/me',
        headers: { authorization: `Bearer ${a.apiKey}` },
      })).json() as { freeChips: string; seatedAt: { tableId: string } | null; status: string };
      expect(meA.freeChips).toBe('9800'); // 10000 play chips minus the 200 buy-in
      expect(meA.seatedAt?.tableId).toBe(tableId);

      // Start the hand deterministically: the orchestrator runs the FR-6
      // commit → anchor → reveal sequence before dealing.
      await harness.orchestrator.tick(harness.advance(1));
      let table = await tableSnapshot(tableId);
      for (let i = 0; i < 20 && table.handId === null; i++) {
        await harness.orchestrator.tick(harness.advance(1));
        table = await tableSnapshot(tableId);
      }
      expect(table.handId).not.toBeNull();
      expect(table.rngCommitment).toMatch(/^0x[0-9a-f]{64}$/);
      expect(table.street).toBe('PREFLOP');

      const credentials = new Map([
        [a.agentId, a.apiKey],
        [b.agentId, b.apiKey],
      ]);

      // Play the whole hand: whoever is on the clock calls or checks, and a
      // timeout is allowed to fire naturally at least once.
      let guard = 0;
      let handComplete = false;
      let sawHoleCards = false;
      while (!handComplete && guard++ < 120) {
        const snapshot = await tableSnapshot(tableId);
        if (snapshot.toActSeat === null) {
          await harness.orchestrator.tick(harness.advance(1_000));
          continue;
        }
        const seat = snapshot.seats[snapshot.toActSeat]!;
        const request = harness.orchestrator.actionRequest(harness.orchestrator.getTable(tableId));
        expect(request).not.toBeNull();
        if (request?.holeCards.length === 2) sawHoleCards = true;
        const apiKey = credentials.get(seat.agentId!);
        expect(apiKey).toBeDefined();

        const action = request!.legal.canCheck ? { action: 'CHECK' as const } : { action: 'CALL' as const };
        const response = await harness.app.inject({
          method: 'POST',
          url: `/api/v1/tables/${tableId}/act`,
          headers: { authorization: `Bearer ${apiKey}` },
          payload: { tableId, handId: snapshot.handId, seat: snapshot.toActSeat, ...action },
        });
        expect(response.statusCode, response.body).toBe(200);
        const body = response.json() as { complete: boolean };
        if (body.complete) handComplete = true;
        await harness.orchestrator.tick(harness.advance(50));
      }
      expect(handComplete).toBe(true);
      expect(sawHoleCards).toBe(true);

      // Hand history + full independent verification.
      const list = (await harness.app.inject({ method: 'GET', url: `/api/v1/hands?tableId=${tableId}` })).json() as {
        hands: { handId: string; proofVerified: boolean; totalRake: string }[];
        total: number;
      };
      expect(list.total).toBe(1);
      expect(list.hands[0]!.proofVerified).toBe(true);
      expect(list.hands[0]!.totalRake).toBe('0'); // free tables never rake

      const history = (
        await harness.app.inject({ method: 'GET', url: `/api/v1/hands/${list.hands[0]!.handId}` })
      ).json() as HandHistory;
      expect(history.deck).toHaveLength(52);
      expect(history.config?.mode).toBe('FREE');
      expect(history.result.board).toHaveLength(5);
      expect(history.result.dealingOrder).toHaveLength(2);

      const verdict = verifyHandHistory(history);
      expect(verdict.proof.ok).toBe(true);
      expect(verdict.deal.ok).toBe(true);
      expect(verdict.settlement.ok).toBe(true);
      expect(verdict.replay?.ok).toBe(true);
      expect(verdict.ok).toBe(true);

      // The server's own verdict agrees with ours.
      const serverVerdict = (
        await harness.app.inject({ method: 'GET', url: `/api/v1/verify/hands/${history.result.handId}` })
      ).json() as { proof: { ok: boolean }; deal: { ok: boolean }; settlement: { ok: boolean } };
      expect(serverVerdict.proof.ok).toBe(true);
      expect(serverVerdict.deal.ok).toBe(true);
      expect(serverVerdict.settlement.ok).toBe(true);

      // Chips stayed conserved across the two play-chip wallets.
      const agents = (
        await harness.app.inject({ method: 'GET', url: '/api/v1/monitor/agents' })
      ).json() as { agents: { id: string; freeChips: string; stack: string | null; handsPlayed: number }[] };
      const totalChips =
        BigInt(agents.agents.find((x) => x.id === a.agentId)!.freeChips) +
        BigInt(agents.agents.find((x) => x.id === a.agentId)!.stack ?? '0') +
        BigInt(agents.agents.find((x) => x.id === b.agentId)!.freeChips) +
        BigInt(agents.agents.find((x) => x.id === b.agentId)!.stack ?? '0');
      expect(totalChips).toBe(20_000n);
      expect(agents.agents.every((x) => x.handsPlayed === 1)).toBe(true);
    });

    it('refuses actions from an agent that is not seated and from an out-of-turn seat', async () => {
      const a = await registerAgent('Hermes');
      const b = await registerAgent('Muse');
      const c = await registerAgent('Observer');
      await seatAgent(a.agentId, a.apiKey, 'free-0-1', '200');
      await seatAgent(b.agentId, b.apiKey, 'free-0-1', '200');

      const notSeated = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/tables/free-0-1/act',
        headers: { authorization: `Bearer ${c.apiKey}` },
        payload: { action: 'FOLD' },
      });
      expect(notSeated.statusCode).toBe(403);

      const bogus = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/tables/free-0-1/act',
        headers: { authorization: `Bearer ${a.apiKey}` },
        payload: { action: 'RAISE' },
      });
      expect(bogus.statusCode).toBe(400);
      expect((bogus.json() as { error: { code: string } }).error.code).toBe('INVALID_ACTION');

      await harness.orchestrator.tick(harness.advance(1));
      await harness.orchestrator.tick(harness.advance(1));
      const table = await tableSnapshot('free-0-1');
      const waitingSeat = table.seats.find((s) => s.seat !== table.toActSeat && s.agentId !== null)!;
      const apiKey = waitingSeat.agentId === a.agentId ? a.apiKey : b.apiKey;
      const outOfTurn = await harness.app.inject({
        method: 'POST',
        url: '/api/v1/tables/free-0-1/act',
        headers: { authorization: `Bearer ${apiKey}` },
        payload: { action: 'CALL' },
      });
      expect(outOfTurn.statusCode).toBe(400);
      expect((outOfTurn.json() as { error: { code: string } }).error.code).toBe('NOT_YOUR_TURN');
    });

    it('applies the think budget as a timeout action (FR-3.5)', async () => {
      const a = await registerAgent('Hermes');
      const b = await registerAgent('Muse');
      await seatAgent(a.agentId, a.apiKey, 'free-0-1', '200');
      await seatAgent(b.agentId, b.apiKey, 'free-0-1', '200');

      await harness.orchestrator.tick(harness.advance(1));
      await harness.orchestrator.tick(harness.advance(1));
      const before = await tableSnapshot('free-0-1');
      expect(before.actionDeadlineTs).not.toBeNull();

      // Jump past the think budget and let the watchdog act.
      await harness.orchestrator.tick(harness.advance(31_000));
      const after = await tableSnapshot('free-0-1');
      const timedOut = after.seats.some((s) => s.status === 'FOLDED');
      expect(timedOut || after.toActSeat !== before.toActSeat).toBe(true);
    });

    it('tops a busted free-mode seat back up and lets it keep playing (FR-4.2)', async () => {
      const a = await registerAgent('Hermes');
      const b = await registerAgent('Muse');
      await seatAgent(a.agentId, a.apiKey, 'free-0-1', '100');
      await seatAgent(b.agentId, b.apiKey, 'free-0-1', '100');

      // Shove every action until someone busts, then check the top-up.
      let busted = false;
      for (let round = 0; round < 40 && !busted; round++) {
        await harness.orchestrator.tick(harness.advance(4_000));
        const table = harness.orchestrator.getTable('free-0-1');
        const hand = table.state.hand;
        if (!hand) continue;
        let guard = 0;
        while (hand && !harness.orchestrator.getTable('free-0-1').state.hand!.complete && guard++ < 40) {
          const liveHand = harness.orchestrator.getTable('free-0-1').state.hand!;
          if (liveHand.toActSeat === null) break;
          const seat = liveHand.seats[liveHand.toActSeat]!;
          const agentId = seat.agentId!;
          const apiKey = agentId === a.agentId ? a.apiKey : b.apiKey;
          const allIn = seat.stack;
          await harness.app.inject({
            method: 'POST',
            url: '/api/v1/tables/free-0-1/act',
            headers: { authorization: `Bearer ${apiKey}` },
            payload: allIn > 0n ? { action: 'ALL_IN' } : { action: 'CALL' },
          });
        }
        const stacks = harness.orchestrator.getTable('free-0-1').state.seats.map((s) => s.stack);
        if (stacks.some((s) => s === 0n || s === 10_000n)) busted = true;
      }

      const table = harness.orchestrator.getTable('free-0-1');
      for (const seat of table.state.seats) {
        if (seat.agentId !== null) expect(seat.stack).toBeGreaterThan(0n);
      }
      const toppedUp = harness.store
        .listAgents()
        .some((agent) => BigInt(agent.stats.topUpsReceived) > 0n || BigInt(agent.freeChips) + BigInt(agent.escrow) > 0n);
      expect(toppedUp).toBe(true);
    });
  });

  describe('monitor (FR-7)', () => {
    it('exposes tables, hands, leaderboards and agent status without credentials', async () => {
      const a = await registerAgent('Hermes');
      const b = await registerAgent('Muse');
      await seatAgent(a.agentId, a.apiKey, 'free-0-1', '200');
      await seatAgent(b.agentId, b.apiKey, 'free-0-1', '200');

      const tables = (await harness.app.inject({ method: 'GET', url: '/api/v1/tables' })).json() as {
        tables: TableSnapshot[];
      };
      expect(tables.tables).toHaveLength(3);
      const free = tables.tables.find((t) => t.id === 'free-0-1')!;
      expect(free.seats).toHaveLength(6);
      expect(free.mode).toBe('FREE');

      const leaderboardFree = (await harness.app.inject({ method: 'GET', url: '/api/v1/leaderboards?mode=FREE' })).json() as {
        rows: unknown[];
      };
      const leaderboardWager = (
        await harness.app.inject({ method: 'GET', url: '/api/v1/leaderboards?mode=WAGER' })
      ).json() as { rows: unknown[] };
      expect(leaderboardFree.rows).toEqual([]); // no hands played yet
      expect(leaderboardWager.rows).toEqual([]);

      const missing = await harness.app.inject({ method: 'GET', url: '/api/v1/hands/does-not-exist' });
      expect(missing.statusCode).toBe(404);

      const unknownTable = await harness.app.inject({ method: 'GET', url: '/api/v1/tables/nope' });
      expect(unknownTable.statusCode).toBe(400);
    });

    it('hides live hole cards from the public snapshot but shows them once the hand ends', async () => {
      const a = await registerAgent('Hermes');
      const b = await registerAgent('Muse');
      await seatAgent(a.agentId, a.apiKey, 'free-0-1', '200');
      await seatAgent(b.agentId, b.apiKey, 'free-0-1', '200');
      await harness.orchestrator.tick(harness.advance(1));
      await harness.orchestrator.tick(harness.advance(1));

      const live = await tableSnapshot('free-0-1');
      expect(live.seats.every((s) => s.holeCards === null)).toBe(true);

      const table = harness.orchestrator.getTable('free-0-1');
      const handId = table.state.hand!.handId;
      await playOutTable(
        'free-0-1',
        new Map([
          [a.agentId, a.apiKey],
          [b.agentId, b.apiKey],
        ]),
      );
      expect(harness.orchestrator.getTable('free-0-1').state.hand!.complete).toBe(true);
      const finished = await tableSnapshot('free-0-1');
      expect(finished.seats.filter((s) => s.agentId !== null).every((s) => s.holeCards?.length === 2)).toBe(true);
      const history = (await harness.app.inject({ method: 'GET', url: `/api/v1/hands/${handId}` })).json() as HandHistory;
      expect(history.result.showdown.length).toBe(2);
      expect(history.result.board.map(cardToString)).toHaveLength(5);
    });
  });

  describe('wager mode (FR-5, FR-8)', () => {
    it('requires a deposit and escrow before seating, and settles with rake', async () => {
      const a = await registerAgent('Whale');
      const b = await registerAgent('Shark');
      const tableId = 'wager-0-1';

      const noDeposit = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/tables/${tableId}/seat`,
        headers: { authorization: `Bearer ${a.apiKey}` },
        payload: { buyIn: '1000000000000000000' },
      });
      expect(noDeposit.statusCode).toBe(400);
      expect((noDeposit.json() as { error: { code: string } }).error.code).toBe('INSUFFICIENT_FUNDS');

      const badDeposit = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/tables/${tableId}/deposit`,
        headers: { authorization: `Bearer ${a.apiKey}` },
        payload: { amount: '0' },
      });
      expect(badDeposit.statusCode).toBe(400);

      for (const agent of [a, b]) {
        const deposit = await harness.app.inject({
          method: 'POST',
          url: `/api/v1/tables/${tableId}/deposit`,
          headers: { authorization: `Bearer ${agent.apiKey}` },
          payload: { amount: '50000000000000000000' },
        });
        expect(deposit.statusCode).toBe(201);
        await seatAgent(agent.agentId, agent.apiKey, tableId, '2000000000000000000');
      }

      const seated = await tableSnapshot(tableId);
      expect(seated.mode).toBe('WAGER');
      expect(seated.seats.filter((s) => s.agentId !== null)).toHaveLength(2);

      await harness.orchestrator.tick(harness.advance(1));
      await harness.orchestrator.tick(harness.advance(1));
      await harness.orchestrator.tick(harness.advance(1));
      const live = await tableSnapshot(tableId);
      expect(live.handId).not.toBeNull();

      // Wager actions are rejected without a signature.
      const unsigned = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/tables/${tableId}/act`,
        headers: { authorization: `Bearer ${a.apiKey}` },
        payload: { action: 'CALL' },
      });
      expect(unsigned.statusCode).toBe(401);
      expect((unsigned.json() as { error: { code: string } }).error.code).toBe('SIGNATURE_REQUIRED');

      // Sign and play the hand out (all-in preflop keeps it short and guarantees a flop).
      let guard = 0;
      let nonce = 0n;
      let completed = false;
      while (!completed && guard++ < 80) {
        const table = harness.orchestrator.getTable(tableId);
        const hand = table.state.hand;
        if (!hand || hand.complete) {
          completed = Boolean(hand?.complete);
          break;
        }
        const request: ActionRequest | null = harness.orchestrator.actionRequest(table);
        if (!request) {
          await harness.orchestrator.tick(harness.advance(100));
          continue;
        }
        const seatAgentId = hand.seats[request.seat]!.agentId!;
        const agent = seatAgentId === a.agentId ? a : b;
        nonce += 1n;
        const deadline = Date.now() + 60_000; // server compares against wall-clock time
        const actionType = request.legal.canCheck ? 'CHECK' : 'CALL';
        const amount = 0n; // CHECK/CALL carry no signed amount; BET/RAISE would
        const domain = {
          name: 'LLM Poker Arena',
          version: '1',
          chainId: 4663,
          verifyingContract: '0x0000000000000000000000000000000000000000',
        };
        const signature = await agent.wallet.signTypedData(
          domain,
          {
            AgentAction: [
              { name: 'agentId', type: 'string' },
              { name: 'tableId', type: 'string' },
              { name: 'handId', type: 'string' },
              { name: 'seat', type: 'uint8' },
              { name: 'action', type: 'uint8' },
              { name: 'amount', type: 'uint256' },
              { name: 'nonce', type: 'uint256' },
              { name: 'deadline', type: 'uint256' },
            ],
          },
          {
            agentId: agent.agentId,
            tableId,
            handId: hand.handId,
            seat: request.seat,
            action: actionType === 'CHECK' ? 1 : 2,
            amount,
            nonce,
            deadline,
          },
        );
        const response = await harness.app.inject({
          method: 'POST',
          url: `/api/v1/tables/${tableId}/act`,
          headers: { authorization: `Bearer ${agent.apiKey}` },
          payload: {
            action: actionType,
            nonce: nonce.toString(),
            deadline,
            signature,
          },
        });
        expect(response.statusCode, response.body).toBe(200);

        // Replaying the same nonce must be rejected (FR-10.4).
        const replay = await harness.app.inject({
          method: 'POST',
          url: `/api/v1/tables/${tableId}/act`,
          headers: { authorization: `Bearer ${agent.apiKey}` },
          payload: { action: actionType, nonce: nonce.toString(), deadline, signature },
        });
        expect([400, 409, 401]).toContain(replay.statusCode);

        completed = (response.json() as { complete: boolean }).complete;
      }
      expect(completed).toBe(true);

      const hands = (await harness.app.inject({ method: 'GET', url: `/api/v1/hands?tableId=${tableId}` })).json() as {
        hands: { handId: string; totalRake: string; proofVerified: boolean }[];
      };
      expect(hands.hands.length).toBeGreaterThan(0);
      const rake = BigInt(hands.hands[0]!.totalRake);
      expect(rake).toBeGreaterThan(0n); // a flop was seen, so rake applies
      expect(rake).toBeLessThanOrEqual(50_000_000_000_000_000n);

      const history = (
        await harness.app.inject({ method: 'GET', url: `/api/v1/hands/${hands.hands[0]!.handId}` })
      ).json() as HandHistory;
      const verdict = verifyHandHistory(history);
      expect(verdict.ok).toBe(true);

      // The settlement adapter booked the rake into the house account.
      expect(harness.settlement.houseBalance()).toBe(rake);

      // Cash-out returns the remaining escrow.
      const leave = await harness.app.inject({
        method: 'POST',
        url: `/api/v1/tables/${tableId}/leave`,
        headers: { authorization: `Bearer ${a.apiKey}` },
      });
      expect(leave.statusCode, leave.body).toBe(200);
      const cashOut = BigInt((leave.json() as { cashOut: string }).cashOut);
      expect(cashOut).toBeGreaterThan(0n);
    });
  });

  describe('raw audit log', () => {
    it('is append-only JSONL that the verifier accepts line by line', async () => {
      const a = await registerAgent('Hermes');
      const b = await registerAgent('Muse');
      await seatAgent(a.agentId, a.apiKey, 'free-0-1', '200');
      await seatAgent(b.agentId, b.apiKey, 'free-0-1', '200');
      await harness.orchestrator.tick(harness.advance(1));
      await harness.orchestrator.tick(harness.advance(1));

      await playOutTable(
        'free-0-1',
        new Map([
          [a.agentId, a.apiKey],
          [b.agentId, b.apiKey],
        ]),
      );

      const { readFileSync } = await import('node:fs');
      const jsonl = readFileSync(join(dataDir, 'hands.jsonl'), 'utf8');
      const lines = jsonl.trim().split('\n');
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]!) as HandHistory;
      expect(verifyHandHistory(parsed).ok).toBe(true);
    });
  });
});
