/**
 * The game orchestrator: it owns the tables, drives hands to completion, runs
 * the FR-6 commit-reveal lifecycle around every hand, settles results, and
 * fans events out to the monitor.
 *
 * Everything time-dependent funnels through `tick(now)`, so the whole server is
 * deterministic in tests: construct it, call `tick` with explicit timestamps,
 * and assert. Nothing here talks HTTP.
 */

import { EventEmitter } from 'node:events';
import {
  type ActionRequest,
  type AgentSnapshot,
  type Card,
  type Chips,
  type HandHistory,
  type HandSummary,
  type Mode,
  type PlayerAction,
  type RngProof,
  type SeatStatus,
  type TableConfig,
  type TableEvent,
  type TableSnapshot,
  bytesToHex,
  commitmentHex,
  defaultFreeTableConfig,
  defaultWagerTableConfig,
  EngineError,
  entropyHex,
  randomDeckSeed,
  shuffleDeck,
  toChipsJson,
  verifyRngProof,
} from '@llmpoker/shared';
import {
  actionRequestFor,
  actOnTable,
  canStartHand,
  createTable,
  leaveTable,
  nextButtonSeat,
  seatAgent,
  startHand,
  timeoutAction,
} from '@llmpoker/engine';
import type { TableState, TableStep } from '@llmpoker/engine';
import { LocalChain, type AnchorProvider, type SettlementAdapter } from './chain.js';
import type { ServerConfig } from './config.js';
import { wagerEnabled } from './config.js';
import { type AgentRecord, Store, toPublicAgent } from './store.js';

export interface ManagedTable {
  state: TableState;
  proofs: Map<string, RngProof>;
  histories: Map<string, HandHistory>;
  /** Epoch ms before which the next hand must not start. */
  nextHandAt: number;
  /** A commit/reveal/start sequence is in flight. */
  busy: boolean;
  /** Per-table monotonic hand nonce (FR-6.1). */
  nonce: bigint;
  startedHands: number;
}

export interface OrchestratorEvents {
  table: (snapshot: TableSnapshot) => void;
  tableEvent: (tableId: string, events: TableEvent[]) => void;
  actionRequired: (request: ActionRequest) => void;
  handComplete: (history: HandHistory, summary: HandSummary) => void;
  agent: (snapshot: AgentSnapshot) => void;
  error: (error: Error, context: string) => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface OrchestratorOptions {
  config: ServerConfig;
  store: Store;
  anchor: AnchorProvider;
  settlement: SettlementAdapter;
  /** Injected clock so tests control time. */
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error' | 'debug', message: string, extra?: unknown) => void;
}

export class Orchestrator extends EventEmitter {
  readonly config: ServerConfig;
  readonly store: Store;
  readonly anchor: AnchorProvider;
  readonly settlement: SettlementAdapter;
  readonly tables = new Map<string, ManagedTable>();
  private readonly now: () => number;
  private readonly log: NonNullable<OrchestratorOptions['log']>;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(options: OrchestratorOptions) {
    super();
    this.config = options.config;
    this.store = options.store;
    this.anchor = options.anchor;
    this.settlement = options.settlement;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
  }

  // -- lifecycle ------------------------------------------------------------

  /** Creates the configured tables. Wager tables are skipped unless settlement is configured. */
  init(): void {
    const free = this.config.freeTables;
    for (let i = 0; i < free; i++) {
      const tableId = `free-${this.config.freeTableTier}-${i + 1}`;
      const config = defaultFreeTableConfig(tableId, `Free Table ${i + 1}`, this.config.freeTableTier);
      this.addTable(config);
    }
    if (wagerEnabled(this.config)) {
      for (let i = 0; i < this.config.wagerTables; i++) {
        const tableId = `wager-${this.config.wagerTableTier}-${i + 1}`;
        const config = defaultWagerTableConfig(tableId, `Wager Table ${i + 1}`, this.config.wagerTableTier);
        this.addTable(config);
      }
    } else {
      this.log('warn', 'wager tables disabled: no settlement path configured');
    }
  }

  addTable(config: TableConfig): ManagedTable {
    const state = createTable(config, this.now());
    const managed: ManagedTable = {
      state,
      proofs: new Map(),
      histories: new Map(),
      nextHandAt: 0,
      busy: false,
      nonce: 0n,
      startedHands: 0,
    };
    this.tables.set(config.id, managed);
    return managed;
  }

  start(): void {
    if (this.timer) return;
    if (this.anchor instanceof LocalChain) this.anchor.start();
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => this.emit('error', error as Error, 'tick'));
    }, this.config.tickIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.anchor.close();
  }

  getTable(tableId: string): ManagedTable {
    const table = this.tables.get(tableId);
    if (!table) throw new EngineError('TABLE_NOT_FOUND', `unknown table ${tableId}`);
    return table;
  }

  listTables(): ManagedTable[] {
    return [...this.tables.values()];
  }

  // -- the tick -------------------------------------------------------------

  /** Runs the think-budget watchdog and starts hands that are due. */
  async tick(now = this.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const table of this.tables.values()) {
        const hand = table.state.hand;
        if (hand && !hand.complete && hand.deadlineTs !== null && hand.deadlineTs <= now) {
          try {
            const step = timeoutAction(table.state, now);
            this.applyStep(table, step, now);
          } catch (error) {
            this.emit('error', error as Error, `timeout:${table.state.config.id}`);
          }
          continue;
        }
        if (canStartHand(table.state) && !table.busy && now >= table.nextHandAt) {
          await this.startNextHand(table, now);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  // -- hand lifecycle (FR-6 + FR-3) -----------------------------------------

  /**
   * FR-6: draw a seed, publish the commitment, wait for the anchor block, read
   * its hash, publish the reveal, derive the deck, then start the hand. The deck
   * is a pure function of public data by the time a single card is dealt.
   */
  async startNextHand(table: ManagedTable, now = this.now()): Promise<void> {
    if (table.busy) return;
    table.busy = true;
    const handNumber = table.state.handNumber + 1;
    const handId = `${table.state.config.id}-h${handNumber}`;
    const mode: Mode = table.state.config.mode;
    try {
      const seedBytes = randomDeckSeed();
      const seed = `0x${bytesToHex(seedBytes)}`;
      table.nonce += 1n;
      const nonce = table.nonce;
      const commitment = commitmentHex(seed, nonce);

      const commitRef = await this.anchor.submitCommitment(handId, commitment);
      const anchorBlock = commitRef.block + 1;
      const confirmations =
        mode === 'WAGER' ? this.config.wagerAnchorConfirmations : this.config.freeAnchorConfirmations;
      await this.waitForFinal(anchorBlock, confirmations);
      const anchorBlockHash = await this.anchor.blockHash(anchorBlock);
      const revealRef = await this.anchor.submitReveal(handId, seed);

      const entropy = entropyHex(seed, anchorBlockHash);
      const deck: Card[] = shuffleDeck(entropy).deck;

      const proof: RngProof = {
        handId,
        tableId: table.state.config.id,
        handNumber,
        commitment,
        deckSeed: seed,
        nonce: nonce.toString(),
        commitBlock: commitRef.block,
        commitTxHash: commitRef.txHash,
        anchorBlock,
        anchorBlockHash,
        revealBlock: revealRef.block,
        revealTxHash: revealRef.txHash,
        entropy,
        deck,
        anchorSource: this.anchor.kind === 'ONCHAIN' ? 'ONCHAIN' : 'LOCAL',
        requiredConfirmations: confirmations,
        verified: false,
        verifiedAt: null,
        chainId: this.config.chainId,
      };
      const verdict = verifyRngProof(proof, {
        minAnchorConfirmations: confirmations,
      });
      proof.verified = verdict.ok;
      proof.verifiedAt = now;
      if (!verdict.ok) {
        this.log('error', `hand ${handId} produced an unverifiable proof`, verdict.checks.filter((c) => !c.ok));
      }
      table.proofs.set(handId, proof);

      const step = startHand(table.state, {
        handId,
        deck,
        now,
        commitment,
        nonce: nonce.toString(),
      });
      table.startedHands += 1;
      this.applyStep(table, step, now);
      this.emit('table', this.snapshot(table));
    } catch (error) {
      this.emit('error', error as Error, `startHand:${table.state.config.id}`);
    } finally {
      table.busy = false;
    }
  }

  private async waitForFinal(block: number, confirmations: number): Promise<void> {
    const deadline = this.now() + 30_000;
    for (;;) {
      if (await this.anchor.isFinal(block, confirmations)) return;
      if (this.now() > deadline) throw new Error(`timed out waiting for block ${block} to finalize`);
      // A simulated chain advances on demand; a real chain is polled.
      if (this.anchor instanceof LocalChain) this.anchor.produceBlock(1);
      else await sleep(Math.min(500, Math.max(50, this.config.blockTimeMs)));
    }
  }

  private applyStep(table: ManagedTable, step: TableStep, now: number): void {
    table.state = step.table;
    if (step.events.length > 0) this.emit('tableEvent', table.state.config.id, step.events);
    if (step.actionRequest) this.emit('actionRequired', step.actionRequest);
    if (step.table.hand?.complete) this.finalizeHand(table, now);
    this.emit('table', this.snapshot(table));
  }

  /** Persists the hand, books the money and schedules the next hand. */
  private finalizeHand(table: ManagedTable, now: number): void {
    const hand = table.state.hand;
    const result = hand?.result;
    if (!hand || !result) return;
    const proof = table.proofs.get(result.handId);
    if (!proof) {
      this.log('error', `hand ${result.handId} completed without a proof record`);
      return;
    }

    const history: HandHistory = { result, proof, deck: proof.deck, config: table.state.config };
    table.histories.set(result.handId, history);
    this.store.appendHand(history);

    const rake = BigInt(result.totalRake);
    const mode = table.state.config.mode;

    // Book the money. Free mode already moved chips between seat stacks; wager
    // mode additionally moves escrow through the settlement adapter (FR-5.2).
    const moves: { agentId: string; delta: bigint }[] = [];
    for (const seatResult of result.seats) {
      if (!seatResult.agentId) continue;
      const net = BigInt(seatResult.net);
      const won = result.pots.some((p) => p.winners.some((w) => w.seat === seatResult.seat));
      this.store.recordStats(seatResult.agentId, {
        mode,
        net,
        volume: BigInt(seatResult.startingStack),
        won,
      });
      if (mode === 'WAGER') moves.push({ agentId: seatResult.agentId, delta: net });
      this.emit('agent', this.agentSnapshot(this.store.getAgent(seatResult.agentId)!));
    }

    if (mode === 'WAGER' && moves.length > 0) {
      // Only the settlement adapter moves: it holds the agent's whole claim on
      // the table (seat stack + escrow), so a hand result changes it by the net.
      // The off-table escrow mirror is untouched here — it is only moved by
      // deposit, buy-in and cash-out.
      void this.settlement
        .settle(table.state.config.id, result.handId, moves, rake)
        .catch((error: unknown) => this.emit('error', error as Error, 'settlement'));
    }

    const summary = this.handSummary(history);
    table.nextHandAt = now + table.state.config.handIntervalMs;
    this.emit('handComplete', history, summary);

    // Keep memory bounded: the audit log holds everything.
    if (table.histories.size > 200) {
      const oldest = [...table.histories.keys()].slice(0, table.histories.size - 200);
      for (const id of oldest) {
        table.histories.delete(id);
        table.proofs.delete(id);
      }
    }
  }

  // -- agent operations -----------------------------------------------------

  /** FR-5.1: funds the per-table escrow for wager play. */
  async deposit(agentId: string, tableId: string, amount: Chips, now = this.now()): Promise<{ escrow: Chips }> {
    const table = this.getTable(tableId);
    if (table.state.config.mode !== 'WAGER') {
      throw new EngineError('ILLEGAL_STATE', 'free tables do not use escrow');
    }
    const agent = this.requireAgent(agentId);
    if (amount <= 0n) throw new EngineError('INVALID_AMOUNT', 'deposit must be positive');
    await this.settlement.deposit(agentId, tableId, amount);
    const updated = this.store.adjustEscrow(agentId, tableId, amount);
    this.emit('agent', this.agentSnapshot(updated));
    this.log('info', `deposit ${amount} by ${agent.name} at ${tableId}`, { now });
    return { escrow: BigInt(updated.escrows[tableId] ?? '0') };
  }

  async seat(
    agentId: string,
    tableId: string,
    options: { seat?: number; buyIn?: Chips } = {},
    now = this.now(),
  ): Promise<{ seat: number; snapshot: TableSnapshot }> {
    const table = this.getTable(tableId);
    const agent = this.requireAgent(agentId);
    const config = table.state.config;

    const mySeats = this.listTables().filter((t) => t.state.seats.some((s) => s.agentId === agentId)).length;
    if (mySeats >= this.config.maxConcurrentSeats) {
      throw new EngineError('ALREADY_SEATED', `agent already holds ${mySeats} seats (max ${this.config.maxConcurrentSeats})`);
    }

    const buyIn = options.buyIn ?? config.minBuyIn;
    const escrowAvailable =
      config.mode === 'WAGER' ? this.store.tableEscrow(agentId, tableId) : BigInt(agent.freeChips);

    if (config.mode === 'FREE') {
      if (BigInt(agent.freeChips) < buyIn) {
        throw new EngineError('INSUFFICIENT_FUNDS', `agent has ${agent.freeChips} play chips, needs ${buyIn}`);
      }
    } else if (escrowAvailable < buyIn) {
      throw new EngineError(
        'INSUFFICIENT_FUNDS',
        `escrow at ${tableId} is ${escrowAvailable}; deposit at least ${buyIn} first`,
      );
    }

    const { table: next, seat } = seatAgent(table.state, {
      seat: options.seat,
      agentId,
      agentName: agent.name,
      buyIn,
      escrowAvailable,
    }, now);
    table.state = next;

    if (config.mode === 'FREE') {
      this.store.adjustFreeChips(agentId, -buyIn);
    } else {
      this.store.adjustEscrow(agentId, tableId, -buyIn);
    }

    // Grace period: a fresh arrival must not be locked out because a hand
    // started in the milliseconds before they sat down.
    table.nextHandAt = now + config.handIntervalMs;

    const snapshot = this.snapshot(table);
    this.emit('table', snapshot);
    this.emit('agent', this.agentSnapshot(this.store.getAgent(agentId)!));
    this.log('info', `seated ${agentId} at ${tableId}#${seat} with ${buyIn}`, { now });
    return { seat, snapshot };
  }

  async leave(agentId: string, tableId: string, now = this.now()): Promise<{ cashOut: Chips; escrow: Chips }> {
    const table = this.getTable(tableId);
    const seat = table.state.seats.find((s) => s.agentId === agentId);
    if (!seat) throw new EngineError('SEAT_NOT_FOUND', `agent ${agentId} is not seated at ${tableId}`);
    const agent = this.requireAgent(agentId);
    const { table: next, cashOut, escrow } = leaveTable(table.state, seat.seat, now);
    table.state = next;

    if (next.config.mode === 'FREE') {
      this.store.adjustFreeChips(agentId, cashOut + escrow);
    } else {
      // The agent's whole claim on the table is the stack plus untouched escrow;
      // the settlement adapter releases both (FR-5.5).
      const total = cashOut + escrow;
      if (total > 0n) await this.settlement.cashOut(agentId, tableId, total);
      if (escrow > 0n) this.store.adjustEscrow(agentId, tableId, -escrow);
    }
    void agent;

    table.nextHandAt = now + next.config.handIntervalMs;
    const snapshot = this.snapshot(table);
    this.emit('table', snapshot);
    this.emit('agent', this.agentSnapshot(this.store.getAgent(agentId)!));
    return { cashOut, escrow };
  }

  /** Applies an agent action. The caller has already authenticated the agent. */
  async act(agentId: string, tableId: string, action: PlayerAction, now = this.now()): Promise<TableStep> {
    const table = this.getTable(tableId);
    const seat = table.state.seats.find((s) => s.agentId === agentId);
    if (!seat) throw new EngineError('SEAT_NOT_FOUND', `agent ${agentId} is not seated at ${tableId}`);

    const hand = table.state.hand;
    if (!hand || hand.complete) throw new EngineError('HAND_NOT_FOUND', `table ${tableId} has no live hand`);

    const step = actOnTable(table.state, seat.seat, action, now, 'AGENT');
    this.applyStep(table, step, now);
    this.store.markSeen(agentId, now);

    // A hand that completes on this action also releases any agent whose whole
    // stack was lost (the engine already topped up or marked them busted).
    for (const s of table.state.seats) {
      if (step.table.hand?.complete && s.agentId) this.emit('agent', this.agentSnapshot(this.store.getAgent(s.agentId)!));
    }

    return step;
  }

  /** The private turn notification for the seat on the clock, if any. */
  actionRequest(table: ManagedTable): ActionRequest | null {
    const hand = table.state.hand;
    if (!hand || hand.complete) return null;
    return actionRequestFor(hand);
  }

  // -- projections ----------------------------------------------------------

  snapshot(table: ManagedTable, options: { forAgentId?: string } = {}): TableSnapshot {
    const state = table.state;
    const hand = state.hand;
    const handComplete = Boolean(hand?.complete);
    const handId = hand?.handId ?? null;
    const proof = handId ? table.proofs.get(handId) : undefined;

    return {
      id: state.config.id,
      name: state.config.name,
      mode: state.config.mode,
      status: state.status,
      config: state.config,
      seats: state.seats.map((seat) => {
        const handSeat = hand?.seats[seat.seat];
        const revealCards = handComplete || seat.agentId === options.forAgentId;
        return {
          seat: seat.seat,
          status: seat.status,
          agentId: seat.agentId,
          agentName: seat.agentName,
          stack: toChipsJson(seat.stack),
          committed: toChipsJson(handSeat?.committed ?? 0n),
          totalCommitted: toChipsJson(handSeat?.totalCommitted ?? 0n),
          holeCards: revealCards && handSeat && handSeat.agentId !== null ? [...handSeat.holeCards] : null,
          escrow: state.config.mode === 'WAGER' ? toChipsJson(seat.escrow) : null,
        };
      }),
      buttonSeat: state.buttonSeat,
      handId,
      handNumber: state.handNumber,
      street: hand ? hand.street : null,
      board: hand ? [...hand.board] : [],
      pots: (hand ? hand.pots : []).map((p) => ({
        index: p.index,
        amount: toChipsJson(p.amount),
        eligibleSeats: [...p.eligible],
      })),
      totalPot: toChipsJson(hand ? hand.seats.reduce((acc, s) => acc + s.totalCommitted, 0n) : 0n),
      currentBet: toChipsJson(hand?.currentBet ?? 0n),
      minRaiseTo: toChipsJson(hand?.currentBet ? hand.currentBet + hand.lastFullRaise : (hand?.config.bigBlind ?? 0n)),
      toActSeat: hand && !hand.complete ? hand.toActSeat : null,
      actionDeadlineTs: hand && !hand.complete ? hand.deadlineTs : null,
      rngCommitment: proof?.commitment ?? null,
      startedAt: state.createdAt,
      updatedAt: state.updatedAt,
    };
  }

  agentSnapshot(record: AgentRecord): AgentSnapshot {
    const seated = this.listTables()
      .map((t) => ({ table: t, seat: t.state.seats.find((s) => s.agentId === record.id) }))
      .find((x) => x.seat !== undefined);
    const status = seated
      ? seated.table.state.hand && !seated.table.state.hand.complete
        ? seated.table.state.hand.toActSeat === seated.seat!.seat
          ? 'THINKING'
          : seated.seat!.status === 'FOLDED'
            ? 'FOLDED'
            : 'SEATED'
        : 'SEATED'
      : 'IDLE';

    return {
      ...toPublicAgent(record, this.store.agentsForWallet(record.wallet).length > 1),
      status,
      seatedAt: seated && seated.seat ? { tableId: seated.table.state.config.id, seat: seated.seat.seat } : null,
      stack: seated && seated.seat ? toChipsJson(seated.seat.stack) : null,
      handsPlayed: record.stats.handsPlayed,
      handsWon: record.stats.handsWon,
      freeChips: record.freeChips,
      escrow: record.escrow,
      netWagerProfit: record.stats.netWagerProfit,
    };
  }

  listAgentSnapshots(): AgentSnapshot[] {
    return this.store.listAgents().map((a) => this.agentSnapshot(a));
  }

  handSummary(history: HandHistory): HandSummary {
    const { result, proof } = history;
    return {
      handId: result.handId,
      tableId: result.tableId,
      tableName: this.tables.get(result.tableId)?.state.config.name ?? result.tableId,
      handNumber: result.handNumber,
      mode: result.mode,
      startedAt: result.startedAt,
      endedAt: result.endedAt,
      streetReached: result.streetReached,
      board: result.board,
      totalPot: result.totalPot,
      totalRake: result.totalRake,
      playerCount: result.seats.filter((s) => s.agentId !== null).length,
      winners: result.pots.flatMap((p) =>
        p.winners.map((w) => ({
          seat: w.seat,
          name: this.store.getAgent(result.seats.find((s) => s.seat === w.seat)?.agentId ?? '')?.name ?? null,
          amount: w.amount,
        })),
      ),
      commitment: proof.commitment,
      commitBlock: proof.commitBlock,
      anchorBlock: proof.anchorBlock,
      revealBlock: proof.revealBlock,
      proofVerified: proof.verified,
    };
  }

  leaderboard(mode: Mode) {
    const rows = this.store
      .listAgents()
      .map((agent) => {
        const played = mode === 'FREE' ? agent.stats.freeHandsPlayed : agent.stats.handsPlayed - agent.stats.freeHandsPlayed;
        const won = mode === 'FREE' ? agent.stats.freeHandsWon : agent.stats.handsWon - agent.stats.freeHandsWon;
        return {
          agentId: agent.id,
          name: agent.name,
          mode,
          handsPlayed: played,
          handsWon: won,
          winRate: played === 0 ? 0 : won / played,
          netProfit: mode === 'WAGER' ? agent.stats.netWagerProfit : '0',
          volume: agent.stats.volume,
        };
      })
      .filter((row) => row.handsPlayed > 0)
      .sort((a, b) => Number(BigInt(b.netProfit) - BigInt(a.netProfit)) || b.handsPlayed - a.handsPlayed);
    return rows;
  }

  /** Seats whose status changed since the last hand — used by the monitor. */
  seatStatuses(table: ManagedTable): { seat: number; status: SeatStatus }[] {
    return table.state.seats.map((s) => ({ seat: s.seat, status: s.status }));
  }

  private requireAgent(agentId: string): AgentRecord {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new EngineError('SEAT_NOT_FOUND', `unknown agent ${agentId}`);
    return agent;
  }
}

export { nextButtonSeat };
export type { TableState };
