/**
 * HTTP + WebSocket surface (SRS §7).
 *
 * Public read-only endpoints need no credentials (FR-7.6); agent endpoints need
 * a bearer credential (API key or issued token) and, in wager mode, an EIP-712
 * signature per action (FR-1.3).
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { extname, join, normalize, resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import {
  type ActionType,
  type ActRequest,
  type ClientMessage,
  type Envelope,
  type HandSummary,
  type Mode,
  type MonitorEvent,
  type RegisterRequest,
  type ServerMessage,
  type TableEvent,
  EngineError,
  parseChips,
  validateActionShape,
  toChipsJson,
} from '@llmpoker/shared';
import { verifyRngProof, verifyHandDeal, verifyPublicReveals } from '@llmpoker/shared';
import { verifySettlement } from '@llmpoker/verifier';
import type { WebSocket } from 'ws';
import { actionDigest, createChallenge, createToken, eip712Domain, metadataHashFor, verifySignature, verifyToken } from './auth.js';
import { AGENT_ACTION_TYPES, AGENT_REGISTRATION_TYPES } from '@llmpoker/shared';
import { wagerEnabled, type ServerConfig } from './config.js';
import type { Orchestrator } from './orchestrator.js';
import { toPublicAgent, type AgentRecord, type Store } from './store.js';
import { ServiceUnavailableError, createChainServices, type ChainServices, type StakingAction } from './token.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

interface SocketState {
  socket: WebSocket;
  agentId: string | null;
  monitor: boolean;
  tableId: string | null;
  alive: boolean;
}

export interface AppDeps {
  config: ServerConfig;
  store: Store;
  orchestrator: Orchestrator;
  /** Wallet-facing chain reads/writes. Defaults to the live or disabled implementation. */
  chainServices?: ChainServices;
  log?: (level: 'info' | 'warn' | 'error' | 'debug', message: string, extra?: unknown) => void;
}

export interface BuiltApp {
  app: FastifyInstance;
  close: () => Promise<void>;
}

/** Token bucket per credential, for FR-10.1. */
class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  constructor(private readonly ratePerSecond: number) {}

  allow(key: string, now = Date.now()): boolean {
    if (this.ratePerSecond <= 0) return true;
    const bucket = this.buckets.get(key) ?? { tokens: this.ratePerSecond, updatedAt: now };
    const elapsed = (now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(this.ratePerSecond, bucket.tokens + elapsed * this.ratePerSecond);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }
}

/**
 * Chips are `bigint` internally and decimal strings on the wire (never lose
 * precision to `JSON.parse`), so every JSON reply and WebSocket frame goes
 * through this replacer.
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, jsonReplacer);
}

export async function buildApp(deps: AppDeps): Promise<BuiltApp> {
  const { config, store, orchestrator } = deps;
  const chainServices = deps.chainServices ?? createChainServices(config);
  const log = deps.log ?? (() => {});
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 256 * 1024 });
  app.setReplySerializer((payload: unknown) => (typeof payload === 'string' ? payload : stringifyJson(payload)));
  await app.register(websocket);

  const limiter = new RateLimiter(config.rateLimitPerSecond);
  const sockets = new Set<SocketState>();
  const domain = eip712Domain({ chainId: config.chainId, verifyingContract: config.contracts.poker });
  const seqByTable = new Map<string, number>();

  const envelope = <T>(tableId: string, payload: T): Envelope<T> => {
    const seq = (seqByTable.get(tableId) ?? 0) + 1;
    seqByTable.set(tableId, seq);
    return { seq, at: Date.now(), tableId, payload };
  };

  // -- helpers --------------------------------------------------------------

  const send = (state: SocketState, message: ServerMessage): void => {
    if (state.socket.readyState === state.socket.OPEN) {
      state.socket.send(stringifyJson(message));
    }
  };

  const broadcastMonitor = (event: MonitorEvent): void => {
    for (const state of sockets) {
      if (state.monitor) send(state, { type: 'MONITOR_EVENT', event });
    }
  };

  const authenticate = async (request: FastifyRequest): Promise<AgentRecord | null> => {
    const header = request.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) return null;
    const credential = header.slice('Bearer '.length).trim();
    if (credential.startsWith('llmpk_')) return store.authenticateApiKey(credential);
    const payload = verifyToken(credential, config.jwtSecret);
    if (!payload) return null;
    return store.getAgent(payload.sub) ?? null;
  };

  const requireAgent = async (request: FastifyRequest, reply: FastifyReply): Promise<AgentRecord | null> => {
    const agent = await authenticate(request);
    if (!agent) {
      await reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'a valid API key or token is required' } });
      return null;
    }
    if (!limiter.allow(agent.id)) {
      await reply.code(429).send({ error: { code: 'RATE_LIMITED', message: 'too many requests' } });
      return null;
    }
    return agent;
  };

  const handleError = (error: unknown, reply: FastifyReply, context: string): void => {
    if (error instanceof EngineError) {
      void reply.code(400).send({ error: { code: error.code, message: error.message } });
      return;
    }
    // Wallet-facing services: "not deployed yet" is 503, a refused gate is 403.
    if (error instanceof ServiceUnavailableError) {
      const status = error.code === 'TOKEN_GATE' ? 403 : 503;
      void reply.code(status).send({ error: { code: error.code, message: error.message } });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    log('error', `${context}: ${message}`);
    void reply.code(500).send({ error: { code: 'INTERNAL', message } });
  };

  // -- wiring orchestrator events to sockets --------------------------------

  orchestrator.on('table', (snapshot: ReturnType<Orchestrator['snapshot']>) => {
    broadcastMonitor({ kind: 'TABLE_UPDATED', table: snapshot });
    for (const state of sockets) {
      if (state.tableId === snapshot.id) send(state, { type: 'TABLE_STATE', table: snapshot });
    }
  });

  orchestrator.on('tableEvent', (tableId: string, events: TableEvent[]) => {
    for (const event of events) {
      const wrapped = envelope(tableId, event);
      broadcastMonitor({ kind: 'TABLE_EVENT', tableId, envelope: wrapped });
      for (const state of sockets) {
        if (state.tableId === tableId) {
          send(state, { type: 'TABLE_EVENT', tableId, envelope: wrapped });
        }
      }
    }
  });

  // The turn notification carries private hole cards: it is delivered only to
  // the seat's owner, never to the public monitor feed.
  orchestrator.on('actionRequired', (request) => {
    const table = orchestrator.tables.get(request.tableId);
    const agentId = table?.state.seats[request.seat]?.agentId ?? null;
    if (!agentId) return;
    for (const state of sockets) {
      if (state.agentId === agentId) send(state, { type: 'ACTION_REQUIRED', tableId: request.tableId, request });
    }
  });

  orchestrator.on('handComplete', (_history, summary: HandSummary) => {
    broadcastMonitor({
      kind: 'HAND_COMPLETE',
      tableId: summary.tableId,
      handId: summary.handId,
      result: orchestrator.tables.get(summary.tableId)?.histories.get(summary.handId)?.result as never,
    });
  });

  orchestrator.on('agent', (agent) => {
    broadcastMonitor({ kind: 'AGENT_UPDATED', agent });
  });

  orchestrator.on('error', (error: Error, context: string) => {
    log('error', `orchestrator ${context}: ${error.message}`);
  });

  // -- CORS for the read-only API -------------------------------------------

  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.header('access-control-allow-origin', '*');
      reply.header('access-control-allow-headers', 'content-type, authorization');
      reply.header('access-control-allow-methods', 'GET, POST, OPTIONS');
    }
    if (request.method === 'OPTIONS') await reply.code(204).send();
  });

  // -- public API -----------------------------------------------------------

  app.get('/api/v1/health', async () => ({
    ok: true,
    version: config.version,
    chainId: config.chainId,
    chainName: config.chainName,
    uptimeSeconds: Math.round(process.uptime()),
    freeTables: orchestrator.listTables().filter((t) => t.state.config.mode === 'FREE').length,
    wagerTables: orchestrator.listTables().filter((t) => t.state.config.mode === 'WAGER').length,
    agents: store.listAgents().length,
    hands: store.handCount(),
    rngAnchor: orchestrator.anchor.kind,
    settlement: orchestrator.settlement.kind,
    wagerEnabled: wagerEnabled(config),
    // Everything the landing page needs to render honestly: null addresses mean
    // "not live yet" and the UI says so rather than inventing a contract.
    chain: config.chain,
    contracts: config.contracts,
    tokenomics: {
      tokenSymbol: config.tokenomics.tokenSymbol,
      tokenDecimals: config.tokenomics.tokenDecimals,
      buybackBps: config.tokenomics.buybackBps,
      stakerBps: config.tokenomics.stakerBps,
      freeGameMinTokens: config.tokenomics.freeGameMinTokens.toString(),
      /** Wager tables accept these; either may be null until deployed. */
      wagerCurrencies: [
        { symbol: config.tokenomics.tokenSymbol, address: config.contracts.token, decimals: config.tokenomics.tokenDecimals },
        { symbol: 'USDG', address: config.contracts.usdg, decimals: config.usdgDecimals },
      ],
    },
    freeGate: {
      enabled: config.freeGateEnabled,
      minTokens: config.tokenomics.freeGameMinTokens.toString(),
      token: config.contracts.token,
    },
    walletServices: chainServices.available,
  }));

  // -- wallet-facing services (landing page + staking UI) -------------------

  app.get('/api/v1/gate', async (request, reply) => {
    const query = request.query as { wallet?: string };
    if (!query.wallet || !/^0x[0-9a-fA-F]{40}$/.test(query.wallet)) {
      return reply.code(400).send({ error: { code: 'INVALID_WALLET', message: 'wallet must be a 20-byte hex address' } });
    }
    try {
      const status = await chainServices.gate(query.wallet);
      return {
        ...status,
        balance: status.balance === null ? null : status.balance.toString(),
        required: status.required.toString(),
      };
    } catch (error) {
      return handleError(error, reply, 'gate');
    }
  });

  app.get('/api/v1/staking/summary', async (request, reply) => {
    const query = request.query as { wallet?: string };
    if (!query.wallet || !/^0x[0-9a-fA-F]{40}$/.test(query.wallet)) {
      return reply.code(400).send({ error: { code: 'INVALID_WALLET', message: 'wallet must be a 20-byte hex address' } });
    }
    try {
      const summary = await chainServices.stakingSummary(query.wallet);
      return {
        ...summary,
        staked: summary.staked.toString(),
        pendingRewards: summary.pendingRewards.toString(),
        totalStaked: summary.totalStaked.toString(),
        minStake: summary.minStake.toString(),
        totalRewardsNotified: summary.totalRewardsNotified.toString(),
        cooldown: summary.cooldown
          ? { ...summary.cooldown, amount: summary.cooldown.amount.toString() }
          : null,
      };
    } catch (error) {
      return handleError(error, reply, 'stakingSummary');
    }
  });

  /** Returns calldata for the *wallet* to send; the server never signs or holds keys. */
  app.get('/api/v1/staking/tx', async (request, reply) => {
    const query = request.query as { wallet?: string; action?: string; amount?: string };
    if (!query.wallet || !/^0x[0-9a-fA-F]{40}$/.test(query.wallet)) {
      return reply.code(400).send({ error: { code: 'INVALID_WALLET', message: 'wallet must be a 20-byte hex address' } });
    }
    const actions: StakingAction[] = ['approve', 'stake', 'unstake', 'cancel', 'claim'];
    if (!query.action || !actions.includes(query.action as StakingAction)) {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_ACTION', message: `action must be one of ${actions.join(', ')}` } });
    }
    let amount = 0n;
    if (query.action === 'approve' || query.action === 'stake' || query.action === 'unstake') {
      if (!query.amount || !/^[0-9]+$/.test(query.amount)) {
        return reply
          .code(400)
          .send({ error: { code: 'INVALID_AMOUNT', message: 'amount is required and must be an integer in base units' } });
      }
      amount = BigInt(query.amount);
    }
    try {
      return await chainServices.stakingTx(query.wallet, query.action as StakingAction, amount);
    } catch (error) {
      return handleError(error, reply, 'stakingTx');
    }
  });

  app.get('/api/v1/monitor/agents', async () => ({
    agents: orchestrator.listAgentSnapshots(),
    updatedAt: Date.now(),
  }));

  app.get('/api/v1/tables', async () => ({ tables: orchestrator.listTables().map((t) => orchestrator.snapshot(t)) }));

  app.get('/api/v1/tables/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return orchestrator.snapshot(orchestrator.getTable(id));
    } catch (error) {
      return handleError(error, reply, 'getTable');
    }
  });

  app.get('/api/v1/hands', async (request) => {
    const query = request.query as { limit?: string; offset?: string; tableId?: string; agentId?: string; mode?: Mode };
    return store.listHands({
      limit: query.limit ? Number(query.limit) : 50,
      offset: query.offset ? Number(query.offset) : 0,
      tableId: query.tableId,
      agentId: query.agentId,
      mode: query.mode,
    });
  });

  app.get('/api/v1/hands/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const history = store.getHand(id);
    if (!history) {
      return reply.code(404).send({ error: { code: 'HAND_NOT_FOUND', message: `no hand ${id}` } });
    }
    return history;
  });

  /** The server's own independent recomputation, for the monitor to compare against. */
  app.get('/api/v1/verify/hands/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const history = store.getHand(id);
    if (!history) return reply.code(404).send({ error: { code: 'HAND_NOT_FOUND', message: `no hand ${id}` } });
    const confirmations =
      history.result.mode === 'WAGER' ? config.wagerAnchorConfirmations : config.freeAnchorConfirmations;
    return {
      proof: verifyRngProof(history.proof, { requireReveal: true, minAnchorConfirmations: confirmations }),
      // FR-6.3: every card the hand published must open against the committed root.
      reveals: verifyPublicReveals(history.result, history.proof),
      deal: history.proof.phase === 'AUDITED' ? verifyHandDeal(history.result, history.proof) : { ok: false, checks: [] },
      settlement: verifySettlement(history.result),
    };
  });

  app.get('/api/v1/leaderboards', async (request) => {
    const query = request.query as { mode?: Mode };
    const mode: Mode = query.mode === 'WAGER' ? 'WAGER' : 'FREE';
    return { rows: orchestrator.leaderboard(mode) };
  });

  // -- agent lifecycle ------------------------------------------------------

  app.post('/api/v1/agents/register', async (request, reply) => {
    const body = request.body as RegisterRequest | undefined;
    if (!body || typeof body.name !== 'string' || typeof body.wallet !== 'string') {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'name and wallet are required' } });
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(body.wallet)) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'wallet must be a 20-byte hex address' } });
    }
    const { agent, apiKey } = store.createAgent({
      name: body.name.slice(0, 64),
      wallet: body.wallet,
      metadata: body.metadata ?? {},
      now: Date.now(),
    });
    const challenge = createChallenge(domain, { name: agent.name, wallet: agent.wallet, metadata: agent.metadata });
    log('info', `registered agent ${agent.id} (${agent.name})`);
    return reply.code(201).send({
      agent: toPublicAgent(agent, store.agentsForWallet(agent.wallet).length > 1),
      apiKey,
      challenge: { nonce: challenge.nonce, deadline: challenge.deadline, typedData: challenge.typedData },
    });
  });

  app.post('/api/v1/agents/auth', async (request, reply) => {
    const body = request.body as
      | { agentId?: string; wallet?: string; nonce?: string; deadline?: number; signature?: string }
      | undefined;
    if (!body?.agentId || !body.wallet || !body.nonce || !body.signature || !body.deadline) {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_BODY', message: 'agentId, wallet, nonce, deadline and signature are required' } });
    }
    const agent = store.getAgent(body.agentId);
    if (!agent) return reply.code(404).send({ error: { code: 'AGENT_NOT_FOUND', message: `no agent ${body.agentId}` } });
    if (agent.wallet !== body.wallet.toLowerCase()) {
      return reply.code(401).send({ error: { code: 'WALLET_MISMATCH', message: 'wallet does not match the agent' } });
    }
    if (body.deadline * 1000 < Date.now()) {
      return reply.code(401).send({ error: { code: 'EXPIRED', message: 'the signature deadline has passed' } });
    }

    const metadataHash = metadataHashFor(agent.name, agent.metadata);
    const check = await verifySignature({
      domain,
      types: AGENT_REGISTRATION_TYPES,
      primaryType: 'AgentRegistration',
      message: {
        name: agent.name,
        wallet: agent.wallet,
        nonce: BigInt(body.nonce),
        metadataHash,
        deadline: body.deadline,
      },
      signature: body.signature,
      expectedWallet: agent.wallet,
    });
    if (!check.ok) {
      return reply.code(401).send({ error: { code: 'BAD_SIGNATURE', message: check.error ?? 'signature rejected' } });
    }

    const token = createToken(agent.id, config.jwtSecret, config.tokenTtlSeconds);
    store.markSeen(agent.id, Date.now());
    return {
      token,
      expiresAt: Date.now() + config.tokenTtlSeconds * 1000,
      agent: toPublicAgent(agent, store.agentsForWallet(agent.wallet).length > 1),
    };
  });

  app.get('/api/v1/agents/me', async (request, reply) => {
    const agent = await requireAgent(request, reply);
    if (!agent) return;
    return orchestrator.agentSnapshot(agent);
  });

  // -- seating and play -----------------------------------------------------

  app.post('/api/v1/tables/:id/seat', async (request, reply) => {
    const agent = await requireAgent(request, reply);
    if (!agent) return;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { seat?: number; buyIn?: string };
    try {
      const buyIn = body.buyIn === undefined ? undefined : parseChips(body.buyIn);
      const result = await orchestrator.seat(agent.id, id, { seat: body.seat, buyIn });
      return reply.code(201).send({ seat: result.seat, table: result.snapshot });
    } catch (error) {
      return handleError(error, reply, 'seat');
    }
  });

  app.post('/api/v1/tables/:id/leave', async (request, reply) => {
    const agent = await requireAgent(request, reply);
    if (!agent) return;
    const { id } = request.params as { id: string };
    try {
      const result = await orchestrator.leave(agent.id, id);
      return { cashOut: toChipsJson(result.cashOut), escrow: toChipsJson(result.escrow) };
    } catch (error) {
      return handleError(error, reply, 'leave');
    }
  });

  app.post('/api/v1/tables/:id/deposit', async (request, reply) => {
    const agent = await requireAgent(request, reply);
    if (!agent) return;
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { amount?: string };
    if (body.amount === undefined) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'amount is required' } });
    }
    try {
      const result = await orchestrator.deposit(agent.id, id, parseChips(body.amount));
      return reply.code(201).send({ escrow: toChipsJson(result.escrow) });
    } catch (error) {
      return handleError(error, reply, 'deposit');
    }
  });

  app.post('/api/v1/tables/:id/act', async (request, reply) => {
    const agent = await requireAgent(request, reply);
    if (!agent) return;
    const { id } = request.params as { id: string };
    const body = request.body as ActRequest | undefined;

    const shape = validateActionShape(body);
    if (!shape.ok || !shape.action) {
      return reply.code(400).send({ error: { code: 'INVALID_ACTION', message: shape.error ?? 'invalid action' } });
    }

    const table = orchestrator.tables.get(id);
    if (!table) return reply.code(404).send({ error: { code: 'TABLE_NOT_FOUND', message: `no table ${id}` } });
    const seat = table.state.seats.find((s) => s.agentId === agent.id);
    if (!seat) {
      return reply.code(403).send({ error: { code: 'NOT_SEATED', message: `agent is not seated at ${id}` } });
    }
    const hand = table.state.hand;

    // FR-1.3 / FR-10.4: wager-mode actions are signed and nonce-protected.
    if (table.state.config.mode === 'WAGER') {
      if (!body?.signature || !body.nonce || !body.deadline || !hand) {
        return reply.code(401).send({
          error: {
            code: 'SIGNATURE_REQUIRED',
            message: 'wager-mode actions require { nonce, deadline, signature } over the AgentAction typed data',
          },
        });
      }
      const nonce = BigInt(body.nonce);
      if (typeof body.deadline === 'string') {
        return reply.code(400).send({ error: { code: 'INVALID_BODY', message: 'deadline must be a number' } });
      }
      const deadline = Number(body.deadline);
      if (deadline < Date.now()) {
        return reply.code(401).send({ error: { code: 'EXPIRED', message: 'the action deadline has passed' } });
      }
      const check = await verifySignature({
        domain,
        types: AGENT_ACTION_TYPES,
        primaryType: 'AgentAction',
        message: {
          agentId: agent.id,
          tableId: id,
          handId: hand.handId,
          seat: seat.seat,
          action: actionEnum(shape.action.action),
          amount: shape.action.amount ?? 0n,
          nonce,
          deadline,
        },
        signature: body.signature,
        expectedWallet: agent.wallet,
      });
      if (!check.ok) {
        return reply.code(401).send({ error: { code: 'BAD_SIGNATURE', message: check.error ?? 'signature rejected' } });
      }
      if (!store.acceptNonce(agent.id, hand.handId, nonce)) {
        return reply.code(409).send({ error: { code: 'REPLAY', message: 'nonce already used for this hand' } });
      }
      void actionDigest; // digest helper is exported for agents/tests
    }

    try {
      const step = await orchestrator.act(agent.id, id, shape.action);
      return {
        accepted: true,
        handId: step.table.hand?.handId ?? null,
        complete: Boolean(step.table.hand?.complete),
        table: orchestrator.snapshot(table),
      };
    } catch (error) {
      return handleError(error, reply, 'act');
    }
  });

  // -- operator surface (FR-10.5) -------------------------------------------

  /**
   * Operator-only routes. There is deliberately no operator surface without a
   * configured `LLMPOKER_OPERATOR_TOKEN`: an unauthenticated pause endpoint
   * would be a worse failure mode than having none at all.
   */
  const requireOperator = async (request: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const configured = config.operatorToken;
    const header = request.headers.authorization;
    const presented = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
    if (!configured) {
      await reply.code(403).send({
        error: { code: 'OPERATOR_DISABLED', message: 'set LLMPOKER_OPERATOR_TOKEN to enable the admin surface' },
      });
      return false;
    }
    const a = Buffer.from(presented);
    const b = Buffer.from(configured);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      await reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'operator token required' } });
      return false;
    }
    return true;
  };

  app.post('/api/v1/admin/tables/:id/pause', async (request, reply) => {
    if (!(await requireOperator(request, reply))) return;
    const { id } = request.params as { id: string };
    try {
      return { paused: true, table: orchestrator.pauseTable(id, true) };
    } catch (error) {
      return handleError(error, reply, 'pause');
    }
  });

  app.post('/api/v1/admin/tables/:id/resume', async (request, reply) => {
    if (!(await requireOperator(request, reply))) return;
    const { id } = request.params as { id: string };
    try {
      return { paused: false, table: orchestrator.pauseTable(id, false) };
    } catch (error) {
      return handleError(error, reply, 'resume');
    }
  });

  // -- WebSocket ------------------------------------------------------------

  app.get('/api/v1/ws', { websocket: true }, (connection, request) => {
    const socket = (connection as unknown as { socket: WebSocket }).socket ?? (connection as unknown as WebSocket);
    const query = request.query as { table?: string; token?: string };
    let agentId: string | null = null;
    if (query.token) {
      if (query.token.startsWith('llmpk_')) agentId = store.authenticateApiKey(query.token)?.id ?? null;
      else agentId = verifyToken(query.token, config.jwtSecret)?.sub ?? null;
    }

    const state: SocketState = {
      socket,
      agentId,
      monitor: !query.table,
      tableId: query.table ?? null,
      alive: true,
    };
    sockets.add(state);

    send(state, {
      type: 'WELCOME',
      serverTime: Date.now(),
      chainId: config.chainId,
      version: config.version,
    });

    if (query.table) {
      const table = orchestrator.tables.get(query.table);
      if (table) send(state, { type: 'SUBSCRIBED', tableId: query.table, table: orchestrator.snapshot(table) });
      else send(state, { type: 'ERROR', code: 'TABLE_NOT_FOUND', message: `no table ${query.table}` });
      const pending = orchestrator.actionRequest(table ?? { state: { hand: null } } as never);
      if (pending && agentId && table?.state.seats[pending.seat]?.agentId === agentId) {
        send(state, { type: 'ACTION_REQUIRED', tableId: pending.tableId, request: pending });
      }
    } else {
      send(state, {
        type: 'MONITOR_SNAPSHOT',
        serverTime: Date.now(),
        agents: orchestrator.listAgentSnapshots(),
        tables: orchestrator.listTables().map((t) => orchestrator.snapshot(t)),
      });
    }

    socket.on('message', (raw: Buffer) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        send(state, { type: 'ERROR', code: 'BAD_MESSAGE', message: 'messages must be JSON' });
        return;
      }
      switch (message.type) {
        case 'PING':
          send(state, { type: 'PONG', serverTime: Date.now() });
          state.alive = true;
          break;
        case 'SUBSCRIBE': {
          const table = orchestrator.tables.get(message.tableId);
          state.tableId = message.tableId;
          state.monitor = false;
          if (table) send(state, { type: 'SUBSCRIBED', tableId: message.tableId, table: orchestrator.snapshot(table) });
          else send(state, { type: 'ERROR', code: 'TABLE_NOT_FOUND', message: `no table ${message.tableId}` });
          break;
        }
        case 'UNSUBSCRIBE':
          state.tableId = null;
          state.monitor = true;
          send(state, { type: 'UNSUBSCRIBED', tableId: message.tableId });
          break;
        default:
          send(state, { type: 'ERROR', code: 'BAD_MESSAGE', message: 'unknown message type' });
      }
    });

    const ping = setInterval(() => {
      if (!state.alive) {
        socket.terminate();
        return;
      }
      state.alive = false;
      send(state, { type: 'PONG', serverTime: Date.now() });
    }, 30_000);
    ping.unref?.();

    const cleanup = (): void => {
      clearInterval(ping);
      sockets.delete(state);
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  });

  // -- llm.txt (FR-2) -------------------------------------------------------

  const serveRepoFile = async (reply: FastifyReply, relative: string, type: string): Promise<unknown> => {
    const path = resolve(config.repoRoot, relative);
    if (!path.startsWith(resolve(config.repoRoot)) || !existsSync(path)) {
      return reply.code(404).type('text/plain').send(`not found: ${relative}`);
    }
    return reply.type(type).send(await import('node:fs/promises').then((fs) => fs.readFile(path, 'utf8')));
  };

  app.get('/llm.txt', async (_request, reply) => serveRepoFile(reply, 'llm.txt', MIME['.txt']!));
  app.get('/llms.txt', async (_request, reply) => serveRepoFile(reply, 'llm.txt', MIME['.txt']!));
  app.get('/docs/:file', async (request, reply) => {
    const { file } = request.params as { file: string };
    if (!/^[a-zA-Z0-9._-]+$/.test(file)) {
      return reply.code(400).send({ error: { code: 'INVALID_PATH', message: 'bad document name' } });
    }
    return serveRepoFile(reply, join('docs', file), MIME[extname(file)] ?? 'text/plain; charset=utf-8');
  });

  // -- static monitor site (FR-7) -------------------------------------------

  const sendFile = (reply: FastifyReply, absolutePath: string, download = false): unknown => {
    const type = MIME[extname(absolutePath).toLowerCase()] ?? 'application/octet-stream';
    reply.header('content-type', type);
    if (download) reply.header('content-disposition', `attachment; filename="${absolutePath.split(/[\\/]/).pop()}"`);
    return reply.send(createReadStream(absolutePath));
  };

  const safeJoin = (root: string, relative: string): string | null => {
    const target = normalize(join(root, relative));
    return target.startsWith(normalize(root)) ? target : null;
  };

  const serveStatic = (reply: FastifyReply, root: string, relative: string): unknown => {
    const target = safeJoin(root, relative);
    if (!target || !existsSync(target) || !statSync(target).isFile()) {
      return reply.code(404).type('text/plain').send('not found');
    }
    return sendFile(reply, target);
  };

  const page = (file: string) => async (_request: FastifyRequest, reply: FastifyReply) =>
    serveStatic(reply, config.monitorDir, file);

  app.get('/', page('index.html'));
  app.get('/index.html', page('index.html'));
  app.get('/agents', page('agents.html'));
  app.get('/tables', page('tables.html'));
  app.get('/hands', page('hands.html'));
  app.get('/stake', page('stake.html'));
  app.get('/assets/*', async (request, reply) => {
    const wildcard = (request.params as Record<string, string>)['*'] ?? '';
    return serveStatic(reply, join(config.monitorDir, 'assets'), wildcard);
  });
  app.get('/vendor/shared/*', async (request, reply) => {
    const wildcard = (request.params as Record<string, string>)['*'] ?? '';
    return serveStatic(reply, resolve(config.repoRoot, 'packages/shared/dist'), wildcard);
  });
  app.get('/favicon.ico', async (_request, reply) => reply.code(204).send());

  // -- errors ---------------------------------------------------------------

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: `no route for ${request.url}` } });
    }
    return reply.code(404).type('text/plain').send('not found');
  });

  app.setErrorHandler(async (error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    const message = error instanceof Error ? error.message : String(error);
    if (request.url.startsWith('/api/')) {
      return reply.code(status && status >= 400 ? status : 500).send({ error: { code: 'ERROR', message } });
    }
    return reply.code(500).type('text/plain').send(message);
  });

  const close = async (): Promise<void> => {
    for (const state of sockets) state.socket.terminate();
    sockets.clear();
    await orchestrator.stop();
    await app.close();
  };

  return { app, close };
}

function actionEnum(action: ActionType): bigint {
  const map: Record<ActionType, number> = { FOLD: 0, CHECK: 1, CALL: 2, BET: 3, RAISE: 4, ALL_IN: 5 };
  return BigInt(map[action]);
}
