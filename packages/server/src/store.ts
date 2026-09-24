/**
 * Persistence.
 *
 * Deliberately boring and dependency-free:
 *
 * * `data/agents.json` — agent registry, credentials and the play-chip ledger,
 *   rewritten atomically (temp file + rename) on every change.
 * * `data/hands.jsonl` — append-only audit log, one `HandHistory` per line.
 *   Because it is append-only and self-contained, it is exactly the artifact
 *   `llmpoker-verify log --file data/hands.jsonl` checks (NFR-4).
 *
 * A SQLite/Postgres backend is a drop-in replacement for this module; nothing
 * else in the server touches the filesystem.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { Agent, AgentMetadata, HandHistory, HandSummary, Mode, RngProof } from '@llmpoker/shared';
import { chipsToTokenString, toConfigJson } from '@llmpoker/shared';

export interface AgentStats {
  handsPlayed: number;
  handsWon: number;
  volume: string;
  netWagerProfit: string;
  freeHandsPlayed: number;
  freeHandsWon: number;
  topUpsReceived: string;
}

export interface AgentRecord {
  id: string;
  name: string;
  wallet: string;
  metadata: AgentMetadata;
  createdAt: number;
  lastSeenAt: number | null;
  /** sha256(apiKey) — the key itself is never stored. */
  apiKeyHash: string;
  apiKeyPrefix: string;
  /** Play chips not currently on a table (FR-4.2). */
  freeChips: string;
  /** Wager escrow mirror, per table (FR-5.1); the chain is the source of truth. */
  escrows: Record<string, string>;
  /** Aggregate of `escrows`, kept in sync for display. */
  escrow: string;
  stats: AgentStats;
  /** Highest action nonce seen per hand, for replay protection (FR-10.4). */
  actionNonces: Record<string, string>;
}

interface PersistedState {
  version: 1;
  agents: AgentRecord[];
}

const EMPTY_STATS: AgentStats = {
  handsPlayed: 0,
  handsWon: 0,
  volume: '0',
  netWagerProfit: '0',
  freeHandsPlayed: 0,
  freeHandsWon: 0,
  topUpsReceived: '0',
};

export interface StoreOptions {
  dataDir: string;
  persist: boolean;
  /** How many hand histories to keep in memory for the API (the log keeps all). */
  memoryHandLimit?: number;
}

export class Store {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly hands = new Map<string, HandHistory>();
  private readonly handOrder: string[] = [];
  private readonly options: StoreOptions;
  private readonly agentsFile: string;
  private readonly handsFile: string;
  private readonly memoryHandLimit: number;

  constructor(options: StoreOptions) {
    this.options = options;
    this.memoryHandLimit = options.memoryHandLimit ?? 2_000;
    this.agentsFile = join(options.dataDir, 'agents.json');
    this.handsFile = join(options.dataDir, 'hands.jsonl');
    if (options.persist) mkdirSync(options.dataDir, { recursive: true });
    this.load();
  }

  private load(): void {
    if (!this.options.persist) return;
    if (existsSync(this.agentsFile)) {
      try {
        const parsed = JSON.parse(readFileSync(this.agentsFile, 'utf8')) as PersistedState;
        for (const agent of parsed.agents ?? []) {
          this.agents.set(agent.id, { ...agent, stats: { ...EMPTY_STATS, ...agent.stats } });
        }
      } catch (error) {
        throw new Error(`cannot read ${this.agentsFile}: ${(error as Error).message}`);
      }
    }
    if (existsSync(this.handsFile)) {
      const lines = readFileSync(this.handsFile, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        if (line.trim() === '') continue;
        try {
          const history = JSON.parse(line) as HandHistory;
          this.rememberHand(history);
        } catch {
          // A malformed tail must not stop the server from starting; the audit
          // log is still verifiable line by line with the CLI.
        }
      }
    }
  }

  private persistAgents(): void {
    if (!this.options.persist) return;
    const payload: PersistedState = { version: 1, agents: [...this.agents.values()] };
    const tmp = `${this.agentsFile}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.agentsFile);
  }

  private rememberHand(history: HandHistory): void {
    this.hands.set(history.result.handId, history);
    this.handOrder.push(history.result.handId);
    while (this.handOrder.length > this.memoryHandLimit) {
      const evicted = this.handOrder.shift();
      if (evicted) this.hands.delete(evicted);
    }
  }

  // -- agents ---------------------------------------------------------------

  listAgents(): AgentRecord[] {
    return [...this.agents.values()];
  }

  getAgent(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  findAgentByWallet(wallet: string): AgentRecord | undefined {
    const target = wallet.toLowerCase();
    return [...this.agents.values()].find((a) => a.wallet === target);
  }

  agentsForWallet(wallet: string): AgentRecord[] {
    const target = wallet.toLowerCase();
    return [...this.agents.values()].filter((a) => a.wallet === target);
  }

  /** FR-1.1/FR-1.3: creates an agent and returns the plaintext API key once. */
  createAgent(params: { name: string; wallet: string; metadata: AgentMetadata; now: number }): {
    agent: AgentRecord;
    apiKey: string;
  } {
    const id = `agent_${randomBytes(6).toString('hex')}`;
    const apiKey = `llmpk_${randomBytes(24).toString('base64url')}`;
    const record: AgentRecord = {
      id,
      name: params.name,
      wallet: params.wallet.toLowerCase(),
      metadata: params.metadata,
      createdAt: params.now,
      lastSeenAt: null,
      apiKeyHash: hashApiKey(apiKey),
      apiKeyPrefix: apiKey.slice(0, 12),
      freeChips: (10_000n).toString(),
      escrows: {},
      escrow: '0',
      stats: { ...EMPTY_STATS },
      actionNonces: {},
    };
    this.agents.set(id, record);
    this.persistAgents();
    return { agent: record, apiKey };
  }

  authenticateApiKey(apiKey: string): AgentRecord | null {
    const hash = hashApiKey(apiKey);
    for (const agent of this.agents.values()) {
      if (safeEqual(agent.apiKeyHash, hash)) return agent;
    }
    return null;
  }

  updateAgent(id: string, patch: Partial<AgentRecord>): AgentRecord {
    const current = this.agents.get(id);
    if (!current) throw new Error(`unknown agent ${id}`);
    const next: AgentRecord = { ...current, ...patch, stats: { ...current.stats, ...(patch.stats ?? {}) } };
    this.agents.set(id, next);
    this.persistAgents();
    return next;
  }

  adjustFreeChips(id: string, delta: bigint): AgentRecord {
    const current = this.agents.get(id);
    if (!current) throw new Error(`unknown agent ${id}`);
    const next = BigInt(current.freeChips) + delta;
    if (next < 0n) throw new Error(`agent ${id} has insufficient play chips`);
    return this.updateAgent(id, { freeChips: next.toString() });
  }

  /** Moves escrow for one table and keeps the aggregate mirror in sync (FR-5.1). */
  adjustEscrow(id: string, tableId: string, delta: bigint): AgentRecord {
    const current = this.agents.get(id);
    if (!current) throw new Error(`unknown agent ${id}`);
    const next = BigInt(current.escrows[tableId] ?? '0') + delta;
    if (next < 0n) throw new Error(`agent ${id} has insufficient escrow at table ${tableId}`);
    const escrows = { ...current.escrows, [tableId]: next.toString() };
    const total = Object.values(escrows).reduce((acc, v) => acc + BigInt(v), 0n);
    return this.updateAgent(id, { escrows, escrow: total.toString() });
  }

  tableEscrow(id: string, tableId: string): bigint {
    return BigInt(this.agents.get(id)?.escrows[tableId] ?? '0');
  }

  /**
   * Overwrites the mirror for one table. Used in on-chain mode, where the chain
   * is the source of truth and the mirror is only a cache of what it says.
   */
  setTableEscrow(id: string, tableId: string, amount: bigint): AgentRecord {
    const current = this.agents.get(id);
    if (!current) throw new Error(`unknown agent ${id}`);
    if (amount < 0n) throw new Error(`negative escrow for ${id} at ${tableId}`);
    const escrows = { ...current.escrows, [tableId]: amount.toString() };
    const total = Object.values(escrows).reduce((acc, v) => acc + BigInt(v), 0n);
    return this.updateAgent(id, { escrows, escrow: total.toString() });
  }

  recordStats(
    id: string,
    params: { mode: Mode; net: bigint; volume: bigint; won: boolean; toppedUp?: bigint },
  ): AgentRecord {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`unknown agent ${id}`);
    const stats: AgentStats = {
      ...agent.stats,
      handsPlayed: agent.stats.handsPlayed + 1,
      handsWon: agent.stats.handsWon + (params.won ? 1 : 0),
      volume: (BigInt(agent.stats.volume) + params.volume).toString(),
      netWagerProfit: (BigInt(agent.stats.netWagerProfit) + (params.mode === 'WAGER' ? params.net : 0n)).toString(),
      freeHandsPlayed: agent.stats.freeHandsPlayed + (params.mode === 'FREE' ? 1 : 0),
      freeHandsWon: agent.stats.freeHandsWon + (params.mode === 'FREE' && params.won ? 1 : 0),
      topUpsReceived: (BigInt(agent.stats.topUpsReceived) + (params.toppedUp ?? 0n)).toString(),
    };
    return this.updateAgent(id, { stats });
  }

  // -- replay protection (FR-10.4) ------------------------------------------

  /**
   * Accepts a strictly increasing nonce for `agentId`+`handId`. Replayed or
   * stale actions are rejected.
   */
  acceptNonce(agentId: string, handId: string, nonce: bigint): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    const key = handId;
    const previous = agent.actionNonces[key];
    if (previous !== undefined && nonce <= BigInt(previous)) return false;
    agent.actionNonces[key] = nonce.toString();
    // Keep the map from growing without bound.
    const keys = Object.keys(agent.actionNonces);
    if (keys.length > 64) {
      for (const k of keys.slice(0, keys.length - 64)) delete agent.actionNonces[k];
    }
    this.persistAgents();
    return true;
  }

  markSeen(agentId: string, now: number): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.lastSeenAt = now;
  }

  // -- hands ----------------------------------------------------------------

  appendHand(history: HandHistory): void {
    this.rememberHand(history);
    if (this.options.persist) {
      // The audit log is JSON, and a TableConfig carries bigint chips: store the
      // wire form so the line is both valid JSON and re-readable by the verifier.
      const record = { ...history, config: history.config ? toConfigJson(history.config) : null };
      appendFileSync(this.handsFile, `${JSON.stringify(record)}\n`, 'utf8');
    }
  }

  getHand(handId: string): HandHistory | undefined {
    return this.hands.get(handId);
  }

  listHands(params: { limit?: number; offset?: number; tableId?: string; agentId?: string; mode?: Mode } = {}): {
    hands: HandSummary[];
    total: number;
  } {
    const limit = Math.min(params.limit ?? 50, 200);
    const offset = params.offset ?? 0;
    const all: HandSummary[] = [];
    for (const handId of [...this.handOrder].reverse()) {
      const history = this.hands.get(handId);
      if (!history) continue;
      const { result, proof } = history;
      if (params.tableId && result.tableId !== params.tableId) continue;
      if (params.mode && result.mode !== params.mode) continue;
      if (params.agentId && !result.seats.some((s) => s.agentId === params.agentId)) continue;
      const winners = result.pots.flatMap((p) =>
        p.winners.map((w) => ({
          seat: w.seat,
          name: result.seats.find((s) => s.seat === w.seat)?.agentId ?? null,
          amount: w.amount,
        })),
      );
      all.push({
        handId: result.handId,
        tableId: result.tableId,
        tableName: result.tableId,
        handNumber: result.handNumber,
        mode: result.mode,
        startedAt: result.startedAt,
        endedAt: result.endedAt,
        streetReached: result.streetReached,
        board: result.board,
        totalPot: result.totalPot,
        totalRake: result.totalRake,
        playerCount: result.seats.filter((s) => s.agentId !== null).length,
        winners,
        commitment: proof.commitment,
        commitBlock: proof.commitBlock,
        anchorBlock: proof.anchorBlock,
        deckRootBlock: proof.deckRootBlock,
        deckRoot: proof.deckRoot,
        audited: proof.audited,
        proofVerified: proof.verified,
      });
    }
    return { hands: all.slice(offset, offset + limit), total: all.length };
  }

  handCount(): number {
    return this.handOrder.length;
  }

  updateProof(handId: string, patch: Partial<RngProof>): void {
    const history = this.hands.get(handId);
    if (!history) return;
    history.proof = { ...history.proof, ...patch };
  }

  /** Used by the CLI-facing verifier endpoint and by tests. */
  allHandHistories(): HandHistory[] {
    return this.handOrder.map((id) => this.hands.get(id)!).filter(Boolean);
  }
}

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Public projection of an agent (never leaks credentials). */
export function toPublicAgent(record: AgentRecord, sharedWallet: boolean): Agent {
  return {
    id: record.id,
    name: record.name,
    wallet: record.wallet,
    metadata: record.metadata,
    createdAt: record.createdAt,
    lastSeenAt: record.lastSeenAt,
    sharedWallet,
  };
}

export function formatChipsForLog(chips: string): string {
  return chipsToTokenString(BigInt(chips));
}

export { EMPTY_STATS };
