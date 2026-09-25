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
  type ChatMessage,
  type Chips,
  type DeckCommitment,
  type HandHistory,
  type HandSummary,
  type Mode,
  type PlayerAction,
  type RngProof,
  type SeatStatus,
  type TableConfig,
  type TableEvent,
  type TableSnapshot,
  actionToEnum,
  bytesToHex,
  bytesToHex32,
  CHAT_CONTEXT_MESSAGES,
  CHAT_LOG_LIMIT,
  CHAT_MAX_LENGTH,
  CHAT_MAX_PER_HAND,
  commitDeckOrder,
  commitmentHex,
  defaultFreeTableConfig,
  defaultWagerTableConfig,
  EngineError,
  entropyHex,
  randomDeckSeed,
  randomSalts,
  revealFor,
  revealSetFor,
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
  revealedBoardPositions,
  seatAgent,
  setTableStatus,
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
  /**
   * Live secrets for hands in flight: the seed and every salt. These are the
   * things that must never be published while the hand is live (FR-6), so they
   * live outside the proof object and are dropped the moment the audit publishes
   * them.
   */
  secrets: Map<string, { seed: string; salts: Uint8Array[]; commitment: DeckCommitment }>;
  histories: Map<string, HandHistory>;
  /**
   * On-chain mode only: the seat order handed to `Poker.openHand`, which
   * `settleHand` must match. Recorded when the hand opens and cleared after.
   */
  openHandSeats: number[] | null;
  /** Epoch ms before which the next hand must not start. */
  nextHandAt: number;
  /** A commit/reveal/start sequence is in flight. */
  busy: boolean;
  /** Per-table monotonic hand nonce (FR-6.1). */
  nonce: bigint;
  startedHands: number;
  /** Count of consecutive failed start attempts, so a retry gets a fresh hand id. */
  attempt: number;
  /**
   * Consecutive think-budget expiries per seat, cleared the moment that seat acts
   * on its own. Feeds the idle sweep in `tick()`.
   */
  timeouts: Map<number, number>;
  /** Seats over the timeout budget that are released as soon as the hand ends. */
  pendingUnseat: Set<number>;
  /**
   * Table talk, oldest first, trimmed to `CHAT_LOG_LIMIT`. Kept on the table
   * rather than in the engine: chat has no effect on the rules or on the deal,
   * so it must never be able to change a hand's outcome.
   */
  chat: ChatMessage[];
  /** Monotonic per table, so a reader can order and de-duplicate lines. */
  chatSeq: number;
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

/** Play chips every new agent is granted at registration (see store.createAgent). */
const FREE_CHIP_GRANT = 10_000n;

/**
 * The signed material the act handler verified, when on-chain action recording is enabled.
 *
 * Deliberately *not* part of the acting API: free play has no signatures and must keep working, so
 * an action without this option is simply not relayed. The signature is passed through untouched —
 * the orchestrator never re-derives or re-signs it, because the contract recovers the agent's wallet
 * from it and a single altered byte would (correctly) be rejected.
 */
export interface ActOnChainOptions {
  signature: string;
  nonce: bigint;
  deadline: number;
}

/** Seats that will be dealt into the next hand, in ascending order. */
function fundedSeatIndexes(state: TableState): number[] {
  return state.seats
    .filter((seat) => seat.agentId !== null && seat.stack >= state.config.bigBlind)
    .map((seat) => seat.seat)
    .sort((a, b) => a - b);
}

export interface OrchestratorOptions {
  config: ServerConfig;
  store: Store;
  anchor: AnchorProvider;
  settlement: SettlementAdapter;
  /**
   * Optional gate for free tables: an agent must pass this before it may sit
   * down (the LLMPOKER holding requirement). Throws to refuse. Injected so the
   * orchestrator stays chain-agnostic and testable without a node.
   */
  freeTableAccess?: (wallet: string) => Promise<void>;
  /** Injected clock so tests control time. */
  now?: () => number;
  log?: (level: 'info' | 'warn' | 'error' | 'debug', message: string, extra?: unknown) => void;
}

export class Orchestrator extends EventEmitter {
  readonly config: ServerConfig;
  readonly store: Store;
  readonly anchor: AnchorProvider;
  /**
   * The settlement adapter. Deliberately **not** `readonly`: `actionsOnChain` is gated on the
   * adapter's own `kind`, so a test can swap in an `ONCHAIN`-flagged recording stand-in without an
   * RPC or an operator key and still exercise the real relay path (see `actions-onchain.test.ts`).
   */
  settlement: SettlementAdapter;
  readonly tables = new Map<string, ManagedTable>();
  private readonly now: () => number;
  private readonly log: NonNullable<OrchestratorOptions['log']>;
  private readonly freeTableAccess: ((wallet: string) => Promise<void>) | undefined;
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
    this.freeTableAccess = options.freeTableAccess;
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
        const config = defaultWagerTableConfig(tableId, `Wager Table ${i + 1}`, this.config.wagerTableTier, 'TOKEN');
        this.addTable(config);
      }
      // USDG-denominated tables: the currency is fixed per table on-chain, so a
      // USDG table needs the address before it can exist at all.
      if (this.config.usdgWagerTables > 0 && this.config.contracts.usdg) {
        for (let i = 0; i < this.config.usdgWagerTables; i++) {
          const tableId = `wager-usdg-${i + 1}`;
          const config = defaultWagerTableConfig(tableId, `USDG Wager Table ${i + 1}`, this.config.wagerTableTier, 'USDG');
          this.addTable(config);
        }
      } else if (this.config.usdgWagerTables > 0) {
        this.log('warn', 'USDG wager tables skipped: set LLMPOKER_USDG_ADDRESS to enable them');
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
      secrets: new Map(),
      histories: new Map(),
      openHandSeats: null,
      nextHandAt: 0,
      busy: false,
      nonce: 0n,
      startedHands: 0,
      attempt: 0,
      timeouts: new Map(),
      pendingUnseat: new Set(),
      chat: [],
      chatSeq: 0,
    };
    this.tables.set(config.id, managed);
    return managed;
  }

  /**
   * On-chain mode: makes sure every wager table exists on `Poker.sol`.
   *
   * Agents deposit with their own keys before they can take a seat, so the table
   * has to exist at boot rather than at the first hand — otherwise their
   * `deposit` reverts with `UnknownTable` and they have no way to know why.
   */
  async ensureTables(): Promise<void> {
    if (!this.settlement.clientSideDeposits) return;
    for (const table of this.tables.values()) {
      if (table.state.config.mode !== 'WAGER') continue;
      try {
        const receipt = await this.settlement.ensureTable(table.state.config);
        if (receipt) this.log('info', `table ${table.state.config.id} created on-chain in ${receipt.txHash}`);
      } catch (error) {
        this.emit('error', error as Error, `ensureTable:${table.state.config.id}`);
      }
    }
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

  /** Runs the think-budget watchdog, releases idle seats, and starts hands due. */
  async tick(now = this.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const table of this.tables.values()) {
        // Release ghosts first, and unconditionally: the timeout branch below
        // `continue`s, so a table that times out on consecutive ticks would
        // otherwise starve the sweep forever. `leaveTable` refuses to leave
        // mid-hand (the committed chips belong to the pot), so it waits for a
        // gap between hands.
        const hand = table.state.hand;
        const live = Boolean(hand && !hand.complete);
        if (!live && !table.busy && table.pendingUnseat.size > 0) {
          await this.releaseIdleSeats(table, now);
        }

        const current = table.state.hand;
        if (current && !current.complete && current.deadlineTs !== null && current.deadlineTs <= now) {
          const seatOnClock = current.toActSeat;
          try {
            const step = timeoutAction(table.state, now);
            await this.applyStep(table, step, now);
            this.noteTimeout(table, seatOnClock);
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

  /**
   * Counts a think-budget expiry against the seat that was on the clock. A seat
   * that keeps checking or folding on the watchdog is present but not playing,
   * so it is queued for release; a single timeout (or a slow model) is not
   * enough, and the counter resets the moment the agent acts for itself.
   */
  private noteTimeout(table: ManagedTable, seat: number | null): void {
    if (seat === null) return;
    const limit = this.config.idleUnseatAfterTimeouts;
    if (limit <= 0) return;
    const record = table.state.seats[seat];
    if (!record?.agentId) return;

    const count = (table.timeouts.get(seat) ?? 0) + 1;
    table.timeouts.set(seat, count);
    if (count < limit) return;

    if (!table.pendingUnseat.has(seat)) {
      table.pendingUnseat.add(seat);
      this.log(
        'warn',
        `${record.agentName ?? record.agentId} at ${table.state.config.id}#${seat} timed out ${count} times in a row; it will be unseated once this hand ends`,
      );
    }
  }

  /** Releases every seat queued by `noteTimeout`, returning its chips (FR-5.5). */
  private async releaseIdleSeats(table: ManagedTable, now: number): Promise<void> {
    for (const seat of [...table.pendingUnseat]) {
      table.pendingUnseat.delete(seat);
      table.timeouts.delete(seat);
      const agentId = table.state.seats[seat]?.agentId;
      if (!agentId) continue;
      try {
        const { cashOut } = await this.leave(agentId, table.state.config.id, now);
        this.log(
          'warn',
          `unseated idle agent ${agentId} from ${table.state.config.id}#${seat}; returned ${cashOut} play chips`,
        );
      } catch (error) {
        this.emit('error', error as Error, `idle-unseat:${table.state.config.id}#${seat}`);
      }
    }
  }

  // -- hand lifecycle (FR-6 + FR-3) -----------------------------------------

  /**
   * FR-6: run the four phases and deal.
   *
   * 1. commit the seed (the seed stays in memory only),
   * 2. anchor it to the next block and commit the Merkle deck root — the ordering
   *    and the salts never leave this process until the audit,
   * 3. deal and reveal individual cards as the rules expose them,
   * 4. audit the whole deck once the hand is over.
   */
  async startNextHand(table: ManagedTable, now = this.now()): Promise<void> {
    if (table.busy) return;
    table.busy = true;
    const handNumber = table.state.handNumber + 1;
    // A hand id that failed mid-start is already committed on-chain and can never
    // be reused, so a retry gets a fresh suffix instead of reverting forever.
    const handId = table.attempt === 0 ? `${table.state.config.id}-h${handNumber}` : `${table.state.config.id}-h${handNumber}a${table.attempt}`;
    const mode: Mode = table.state.config.mode;
    try {
      // -- phase 1: commit the seed (FR-6.1) --------------------------------
      const seed = `0x${bytesToHex(randomDeckSeed())}`;
      table.nonce += 1n;
      const nonce = table.nonce;
      const commitment = commitmentHex(seed, nonce);
      const seedRef = await this.anchor.commitSeed(handId, commitment, nonce);

      // FR-5.1/5.2: in on-chain wager mode the contract must know which seats are
      // in this hand before any chip is committed, and it refuses to open a hand
      // whose seed is not already committed — which is exactly the state we are in.
      if (mode === 'WAGER' && this.settlement.clientSideDeposits) {
        await this.settlement.ensureTable(table.state.config);
        const seats = fundedSeatIndexes(table.state);
        const receipt = await this.settlement.openHand(table.state.config.id, handId, seats);
        table.openHandSeats = seats;
        if (receipt) this.log('info', `hand ${handId} opened on-chain in ${receipt.txHash}`);
      }

      // -- anchor: the next block, read after it exists and again once final --
      const anchorBlock = seedRef.block + 1;
      const confirmations =
        mode === 'WAGER' ? this.config.wagerAnchorConfirmations : this.config.freeAnchorConfirmations;
      const anchorHashAtCommit = await this.waitForAnchorHash(anchorBlock);
      await this.waitForFinal(anchorBlock, confirmations);
      const anchorBlockHash = await this.anchor.blockHash(anchorBlock);
      if (anchorBlockHash !== anchorHashAtCommit) {
        this.log('error', `anchor block ${anchorBlock} was reorged for ${handId}: hand voided (FR-5.6)`);
        table.nextHandAt = now + table.state.config.handIntervalMs;
        return;
      }

      // -- phase 2: commit the deck root, never the ordering (FR-6.2) --------
      const entropy = entropyHex(seed, anchorBlockHash);
      const deck: Card[] = shuffleDeck(entropy).deck;
      const salts = randomSalts();
      const commitmentDeck = commitDeckOrder(deck, salts);
      const deckRoot = bytesToHex32(commitmentDeck.root);
      const leaves = commitmentDeck.leaves.map(bytesToHex32);
      const deckRef = await this.anchor.commitDeck(handId, deckRoot, leaves);

      const proof: RngProof = {
        handId,
        tableId: table.state.config.id,
        handNumber,
        phase: 'DECK_COMMITTED',
        commitment,
        nonce: nonce.toString(),
        commitBlock: seedRef.block,
        commitTxHash: seedRef.txHash,
        anchorBlock,
        anchorBlockHash,
        deckRoot,
        deckRootBlock: deckRef.block,
        deckRootTxHash: deckRef.txHash,
        reveals: [],
        audited: false,
        deckSeed: null,
        entropy: null,
        salts: null,
        deck: [],
        auditBlock: null,
        auditTxHash: null,
        slashed: null,
        voidedReason: null,
        anchorSource: this.anchor.kind === 'ONCHAIN' ? 'ONCHAIN' : 'LOCAL',
        requiredConfirmations: confirmations,
        verified: false,
        verifiedAt: null,
        chainId: this.config.chainId,
      };

      const verdict = verifyRngProof(proof, { requireReveal: false, minAnchorConfirmations: confirmations });
      proof.verified = verdict.ok;
      proof.verifiedAt = now;
      if (!verdict.ok) {
        this.log('error', `hand ${handId} produced an unverifiable live proof`, verdict.checks.filter((c) => !c.ok));
      }
      table.proofs.set(handId, proof);
      // The secrets live beside the proof, never inside it (FR-6 invariant).
      table.secrets.set(handId, { seed, salts, commitment: commitmentDeck });

      this.emit('tableEvent', table.state.config.id, [
        {
          type: 'RNG_SEED_COMMITTED',
          commitment,
          nonce: nonce.toString(),
          commitBlock: seedRef.block,
        },
        {
          type: 'RNG_DECK_COMMITTED',
          deckRoot,
          deckRootBlock: deckRef.block,
          anchorBlock,
        },
      ]);

      const step = startHand(table.state, {
        handId,
        deck,
        now,
        commitment,
        nonce: nonce.toString(),
      });
      table.startedHands += 1;
      table.attempt = 0;
      await this.applyStep(table, step, now);
      this.emit('table', this.snapshot(table));
    } catch (error) {
      // The on-chain commitment for this hand id may already exist, so the next
      // attempt must use a different one (see `handId` above).
      if (table.openHandSeats) {
        // The hand is open on-chain and holding its seats; release them so the
        // table can deal again (FR-5.6). Best effort: the contract gates voiding
        // on its reveal window, and a revert here is not fatal.
        void this.settlement
          .voidHand(table.state.config.id, handId)
          .then(() => this.log('warn', `voided aborted hand ${handId} on-chain`))
          .catch((voidError: unknown) => this.log('warn', `could not void ${handId}: ${String(voidError)}`));
      }
      table.attempt += 1;
      table.openHandSeats = null;
      this.emit('error', error as Error, `startHand:${table.state.config.id}`);
    } finally {
      table.busy = false;
    }
  }

  /**
   * FR-6.3: publish the cards the rules have exposed since the last call. Only
   * board cards qualify while a hand is live — hole cards are revealed by the
   * audit at the end, never early.
   */
  private async publishReveals(table: ManagedTable, handId: string, now: number): Promise<void> {
    const hand = table.state.hand;
    const proof = table.proofs.get(handId);
    const secret = table.secrets.get(handId);
    if (!hand || !proof || !secret || proof.phase !== 'DECK_COMMITTED') return;

    const wanted = revealedBoardPositions(hand);
    const alreadyPublished = new Set(proof.reveals.map((r) => r.index));
    const events: TableEvent[] = [];

    for (const index of wanted) {
      if (alreadyPublished.has(index)) continue;
      const reveal = revealFor(secret.commitment, index);
      try {
        await this.anchor.revealCard(handId, reveal.index, reveal.card, reveal.salt, reveal.proof);
      } catch (error) {
        this.emit('error', error as Error, `revealCard:${handId}`);
        continue;
      }
      proof.reveals.push(reveal);
      events.push({ type: 'CARD_REVEALED', reveal });
    }

    if (events.length > 0) {
      proof.verifiedAt = now;
      this.emit('tableEvent', table.state.config.id, events);
    }
  }

  /**
   * FR-6.4: end-of-hand audit. Publishes the seed, the entropy, every salt and
   * the full ordering, then re-verifies the commitment — which is what makes the
   * hand permanently checkable. This is the only moment the ordering becomes
   * public, and by then the hand is over.
   */
  private async auditHand(table: ManagedTable, handId: string, now: number): Promise<void> {
    const proof = table.proofs.get(handId);
    const secret = table.secrets.get(handId);
    if (!proof || !secret || proof.phase === 'AUDITED') return;

    const saltsHex = secret.salts.map(bytesToHex32);
    try {
      const ref = await this.anchor.audit(handId, secret.seed, secret.commitment.deck, saltsHex);
      proof.auditBlock = ref.block;
      proof.auditTxHash = ref.txHash;
    } catch (error) {
      this.emit('error', error as Error, `audit:${handId}`);
    }

    proof.phase = 'AUDITED';
    proof.audited = true;
    proof.deckSeed = secret.seed;
    proof.entropy = entropyHex(secret.seed, proof.anchorBlockHash ?? '');
    proof.salts = saltsHex;
    proof.deck = [...secret.commitment.deck];
    // All 52 proofs from one tree build: rebuilding the tree per position made
    // the audit an order of magnitude slower than it needs to be.
    proof.reveals = revealSetFor(
      secret.commitment,
      secret.commitment.deck.map((_, index) => index),
    );

    const verdict = verifyRngProof(proof, { minAnchorConfirmations: proof.requiredConfirmations });
    proof.verified = verdict.ok;
    proof.verifiedAt = now;
    if (!verdict.ok) {
      this.log('error', `audit for ${handId} failed verification`, verdict.checks.filter((c) => !c.ok));
    }

    this.emit('tableEvent', table.state.config.id, [{ type: 'RNG_AUDITED', proof }]);
    // The secrets are no longer needed once they are public.
    table.secrets.delete(handId);
  }

  /** Blocks until the anchor block exists, then returns its hash (FR-6.2). */
  private async waitForAnchorHash(anchorBlock: number): Promise<string> {
    const deadline = this.now() + 30_000;
    for (;;) {
      if ((await this.anchor.currentBlock()) >= anchorBlock) return this.anchor.blockHash(anchorBlock);
      if (this.now() > deadline) throw new Error(`timed out waiting for anchor block ${anchorBlock}`);
      if (this.anchor instanceof LocalChain) this.anchor.produceBlock(1);
      // A real chain produces blocks on its own; a development node may need a nudge.
      else {
        await this.anchor.advanceBlock?.();
        await sleep(Math.min(500, Math.max(50, this.config.blockTimeMs)));
      }
    }
  }

  private async waitForFinal(block: number, confirmations: number): Promise<void> {
    const deadline = this.now() + 30_000;
    for (;;) {
      if (await this.anchor.isFinal(block, confirmations)) return;
      if (this.now() > deadline) throw new Error(`timed out waiting for block ${block} to finalize`);
      // A simulated chain advances on demand; a real chain is polled.
      if (this.anchor instanceof LocalChain) this.anchor.produceBlock(1);
      else {
        await this.anchor.advanceBlock?.();
        await sleep(Math.min(500, Math.max(50, this.config.blockTimeMs)));
      }
    }
  }

  private async applyStep(table: ManagedTable, step: TableStep, now: number): Promise<void> {
    table.state = step.table;
    const tableId = table.state.config.id;
    const handId = step.table.hand?.handId ?? null;

    // Table talk belongs to the server, not the engine, so it is attached to
    // every outgoing request here — both the `actionRequired` event the socket
    // layer forwards to the seat on the clock, and the ACTION_REQUIRED inside
    // the event list the table's subscribers see. Without this an agent would
    // receive a request with no talk in it.
    const chat = handId ? this.chatForHand(tableId, handId) : [];
    const events: TableEvent[] =
      chat.length === 0
        ? step.events
        : step.events.map((event) =>
            event.type === 'ACTION_REQUIRED' ? { ...event, request: { ...event.request, chat } } : event,
          );
    if (events.length > 0) this.emit('tableEvent', tableId, events);
    if (step.actionRequest) this.emit('actionRequired', { ...step.actionRequest, chat });

    if (handId) {
      // FR-6.3: publish whatever the rules just made public, and nothing else.
      await this.publishReveals(table, handId, now);
      if (step.table.hand?.complete) {
        // FR-6.4: the audit is what finally publishes the ordering.
        await this.auditHand(table, handId, now);
        this.finalizeHand(table, now);
      }
    }
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

    const history: HandHistory = {
      result,
      proof,
      deck: proof.deck,
      config: table.state.config,
      // Table talk belongs with the hand it was said during. It is carried in the
      // history but never in the proof, so a verifier ignores it entirely.
      chat: this.chatForHand(table.state.config.id, result.handId),
    };
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
      if (this.settlement.clientSideDeposits) {
        // On-chain: the contract is the ledger. `settleHand` collateralises each
        // seat's contribution first, computes its own rake, and rejects the
        // settlement if our awards do not equal `pot - rake`.
        const contributions = result.seats
          .filter((seat) => seat.agentId !== null)
          .map((seat) => ({ seat: seat.seat, amount: BigInt(seat.totalCommitted ?? '0') }));
        const openSeats = table.openHandSeats;
        if (!openSeats) {
          this.log('error', `hand ${result.handId} completed with no on-chain openHand record`);
        } else {
          void this.settlement
            .settleHand({
              tableId: table.state.config.id,
              handId: result.handId,
              // Seat-aligned with the order handed to openHand, as the contract requires.
              contributions: openSeats.map(
                (seat) => contributions.find((c) => c.seat === seat) ?? { seat, amount: 0n },
              ),
              winners: result.pots.flatMap((pot) => pot.winners.map((w) => w.seat)),
              awards: result.pots.flatMap((pot) => pot.winners.map((w) => BigInt(w.amount))),
              sawFlop: result.board.length >= 3,
              rake,
            })
            .then((receipt) => this.log('info', `hand ${result.handId} settled on-chain in ${receipt.txHash}`))
            .catch((error: unknown) => this.emit('error', error as Error, 'settleHand'));
        }
      } else {
        // Local mirror: it holds each agent's whole claim, so it settles by net.
        void this.settlement
          .settleMirror?.(table.state.config.id, result.handId, moves, rake)
          .catch((error: unknown) => this.emit('error', error as Error, 'settlement'));
      }
    }

    table.openHandSeats = null;
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

  /**
   * FR-5.1: funds the per-table escrow for wager play.
   *
   * In on-chain mode this is a **read**, not a transfer: `Poker.deposit` is
   * `msg.sender`-based on purpose (FR-5.3), so the agent moves its own tokens and
   * the server only verifies the resulting on-chain balance and caches it. The
   * agent must already hold the seat it funded.
   */
  async deposit(agentId: string, tableId: string, amount: Chips, now = this.now()): Promise<{ escrow: Chips }> {
    const table = this.getTable(tableId);
    if (table.state.config.mode !== 'WAGER') {
      throw new EngineError('ILLEGAL_STATE', 'free tables do not use escrow');
    }
    const agent = this.requireAgent(agentId);
    if (amount <= 0n) throw new EngineError('INVALID_AMOUNT', 'deposit must be positive');

    if (this.settlement.clientSideDeposits) {
      const seat = table.state.seats.find((s) => s.agentId === agentId);
      if (!seat) {
        throw new EngineError(
          'SEAT_NOT_FOUND',
          `on-chain mode: deposit your own token to the seat you intend to take, then POST /seat with that seat index`,
        );
      }
      const onChain = await this.settlement.escrowOf(tableId, seat.seat);
      const updated = this.store.setTableEscrow(agentId, tableId, onChain - seat.stack);
      this.emit('agent', this.agentSnapshot(updated));
      this.log('info', `verified on-chain escrow ${onChain} for ${agent.name} at ${tableId}#${seat.seat}`, { now });
      return { escrow: BigInt(updated.escrows[tableId] ?? '0') };
    }

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

    // Free tables are token-gated: an agent must hold the required LLMPOKER
    // balance. The hook throws with a machine code when it refuses, and fails
    // closed if the balance cannot be read off-chain.
    if (config.mode === 'FREE' && this.freeTableAccess) {
      await this.freeTableAccess(agent.wallet);
    }

    // FR-10.3: the operator account must never take a seat at its own wager table.
    if (config.mode === 'WAGER' && this.config.operatorAddress) {
      if (agent.wallet === this.config.operatorAddress.toLowerCase()) {
        throw new EngineError(
          'ILLEGAL_STATE',
          'the operator account cannot be seated at its own wager tables (FR-10.3)',
        );
      }
    }

    let escrowAvailable: Chips;
    if (config.mode === 'FREE') {
      escrowAvailable = BigInt(agent.freeChips);
      if (BigInt(agent.freeChips) < buyIn) {
        throw new EngineError('INSUFFICIENT_FUNDS', `agent has ${agent.freeChips} play chips, needs ${buyIn}`);
      }
    } else if (this.settlement.clientSideDeposits) {
      // The chain holds the agent's claim at a specific seat, so on-chain mode
      // needs that seat up front — the server cannot move the tokens for it.
      if (options.seat === undefined) {
        throw new EngineError(
          'ILLEGAL_STATE',
          'on-chain mode requires an explicit seat, so you can fund exactly that seat with Poker.deposit',
        );
      }
      escrowAvailable = await this.settlement.escrowOf(tableId, options.seat);
      if (escrowAvailable < buyIn) {
        throw new EngineError(
          'INSUFFICIENT_FUNDS',
          `on-chain escrow for seat ${options.seat} is ${escrowAvailable}; deposit at least ${buyIn} to it first`,
        );
      }
    } else {
      escrowAvailable = this.store.tableEscrow(agentId, tableId);
      if (escrowAvailable < buyIn) {
        throw new EngineError(
          'INSUFFICIENT_FUNDS',
          `escrow at ${tableId} is ${escrowAvailable}; deposit at least ${buyIn} first`,
        );
      }
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
    } else if (this.settlement.clientSideDeposits) {
      // Cache what the chain says minus the chips now on the table.
      this.store.setTableEscrow(agentId, tableId, escrowAvailable - buyIn);
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
    } else if (this.settlement.clientSideDeposits) {
      // FR-5.5: the agent releases its own on-chain escrow (`Poker.cashOut` is
      // msg.sender-based). The server only frees the seat and stops claiming it.
      this.store.setTableEscrow(agentId, tableId, 0n);
      this.log(
        'info',
        `${agent.name} left ${tableId}#${seat.seat}; ${cashOut + escrow} remains escrowed on-chain — call Poker.cashOut to withdraw it`,
      );
    } else {
      // The agent's whole claim on the table is the stack plus untouched escrow;
      // the settlement adapter releases both (FR-5.5).
      const total = cashOut + escrow;
      if (total > 0n) await this.settlement.cashOut(agentId, tableId, total);
      if (escrow > 0n) this.store.adjustEscrow(agentId, tableId, -escrow);
    }

    table.nextHandAt = now + next.config.handIntervalMs;
    const snapshot = this.snapshot(table);
    this.emit('table', snapshot);
    this.emit('agent', this.agentSnapshot(this.store.getAgent(agentId)!));
    return { cashOut, escrow };
  }

  /**
   * Table talk. Publishes one line from a seated agent.
   *
   * A line can only be said while a hand is live. That is not an arbitrary
   * restriction: a line only means something attached to the hand it was said
   * during, it is what makes the per-hand allowance enforceable, and it keeps
   * "what was said" from ever being ambiguous about which decision it preceded.
   */
  async say(agentId: string, tableId: string, text: unknown, now = this.now()): Promise<ChatMessage> {
    const table = this.getTable(tableId);
    const seat = table.state.seats.find((s) => s.agentId === agentId);
    if (!seat) throw new EngineError('SEAT_NOT_FOUND', `agent ${agentId} is not seated at ${tableId}`);

    const hand = table.state.hand;
    if (!hand || hand.complete) {
      throw new EngineError('HAND_NOT_FOUND', `table ${tableId} has no live hand to talk during`);
    }

    const clean = normaliseChat(text);
    if (clean === null || clean.length > CHAT_MAX_LENGTH) {
      throw new EngineError('CHAT_REJECTED', `chat must be 1..${CHAT_MAX_LENGTH} printable characters`);
    }

    const saidThisHand = table.chat.filter((m) => m.handId === hand.handId).length;
    if (saidThisHand >= CHAT_MAX_PER_HAND) {
      throw new EngineError('CHAT_LIMIT', `already said ${saidThisHand} lines this hand (max ${CHAT_MAX_PER_HAND})`);
    }

    const agent = this.store.getAgent(agentId);
    table.chatSeq += 1;
    const message: ChatMessage = {
      seq: table.chatSeq,
      tableId,
      handId: hand.handId,
      seat: seat.seat,
      agentId,
      agentName: agent?.name ?? seat.agentName ?? agentId,
      text: clean,
      at: now,
    };

    table.chat.push(message);
    if (table.chat.length > CHAT_LOG_LIMIT) table.chat.splice(0, table.chat.length - CHAT_LOG_LIMIT);
    this.emit('tableEvent', tableId, [{ type: 'CHAT', message }]);
    return message;
  }

  /**
   * Table talk for one hand, oldest first and bounded, ready to drop into a
   * decision prompt without letting talk crowd out the game state.
   */
  chatForHand(tableId: string, handId: string): ChatMessage[] {
    return this.getTable(tableId)
      .chat.filter((m) => m.handId === handId)
      .slice(-CHAT_CONTEXT_MESSAGES);
  }

  /** Everything still retained for a table, newest last. */
  chatLog(tableId: string): ChatMessage[] {
    return [...this.getTable(tableId).chat];
  }

  /**
   * Applies an agent action. The caller has already authenticated the agent.
   *
   * @param action The engine-facing action; illegality is the engine's to reject.
   * @param options The agent's signed material, present only for a wager-mode action when the
   *        operator has enabled on-chain recording. See `recordActionOnChain`.
   */
  async act(
    agentId: string,
    tableId: string,
    action: PlayerAction,
    options: { onChain?: ActOnChainOptions } = {},
    now = this.now(),
  ): Promise<TableStep> {
    const table = this.getTable(tableId);
    const seat = table.state.seats.find((s) => s.agentId === agentId);
    if (!seat) throw new EngineError('SEAT_NOT_FOUND', `agent ${agentId} is not seated at ${tableId}`);

    const hand = table.state.hand;
    if (!hand || hand.complete) throw new EngineError('HAND_NOT_FOUND', `table ${tableId} has no live hand`);

    // FR-10.4 companion: publish the signed action *before* it becomes real. An action the operator
    // cannot record is rejected outright rather than applied and left unverifiable — the point of
    // the record is that the hand history and the chain agree, and that only holds if the chain call
    // precedes the engine call. Errors propagate to the act handler; they are never swallowed.
    if (options.onChain) {
      await this.recordActionOnChain(table, agentId, seat.seat, hand.handId, action, options.onChain);
    }

    const step = actOnTable(table.state, seat.seat, action, now, 'AGENT');
    await this.applyStep(table, step, now);
    // The agent acted for itself: clear any idle strike against its seat.
    table.timeouts.delete(seat.seat);
    table.pendingUnseat.delete(seat.seat);
    this.store.markSeen(agentId, now);

    // A hand that completes on this action also releases any agent whose whole
    // stack was lost (the engine already topped up or marked them busted).
    for (const s of table.state.seats) {
      if (step.table.hand?.complete && s.agentId) this.emit('agent', this.agentSnapshot(this.store.getAgent(s.agentId)!));
    }

    return step;
  }

  /**
   * Relays one signed action to `Poker.recordAction`, or does nothing when recording is off.
   *
   * Recording needs **both** the operator's flag and a real chain to record into. With the local
   * mirror there is no `Poker.sol`, so relaying would be theatre — and the flag being off means the
   * mirror is never touched either, so an operator that has not opted in gets the old behaviour
   * exactly.
   *
   * The amount is the engine's own reading of the action rather than anything the operator invents:
   * `0` for FOLD/CHECK/CALL/ALL_IN and the signed size for BET/RAISE. It has to match the signed
   * payload or the contract's signature check fails, which is what makes the record trustworthy —
   * an operator can drop an action, but it cannot alter one.
   */
  private async recordActionOnChain(
    table: ManagedTable,
    agentId: string,
    seat: number,
    handId: string,
    action: PlayerAction,
    signed: ActOnChainOptions,
  ): Promise<void> {
    if (!this.config.actionsOnChain || this.settlement.kind !== 'ONCHAIN') return;
    const receipt = await this.settlement.recordAction({
      tableId: table.state.config.id,
      handId,
      seat,
      action: actionToEnum(action.action),
      amount: action.amount ?? 0n,
      nonce: signed.nonce,
      deadline: signed.deadline,
      agentId,
      // Passed through untouched: the contract recovers the agent's wallet from these bytes, so a
      // re-encrypted or re-derived signature would (correctly) be rejected.
      signature: signed.signature,
    });
    if (receipt) this.log('debug', `action ${action.action} on ${handId}#${seat} recorded on-chain in ${receipt.txHash}`);
  }

  /** The private turn notification for the seat on the clock, if any. */
  actionRequest(table: ManagedTable): ActionRequest | null {
    const hand = table.state.hand;
    if (!hand || hand.complete) return null;
    const base = actionRequestFor(hand);
    if (!base) return null;
    // The engine builds everything that is about the rules; table talk is the
    // server's, so it is attached here and never reaches the pure engine.
    return { ...base, chat: this.chatForHand(table.state.config.id, hand.handId) };
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
          agentLastSeenAt: seat.agentId ? (this.store.getAgent(seat.agentId)?.lastSeenAt ?? null) : null,
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
      rngDeckRoot: proof?.deckRoot ?? null,
      rngPhase: proof?.phase ?? 'NONE',
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
      deckRootBlock: proof.deckRootBlock,
      deckRoot: proof.deckRoot,
      audited: proof.audited,
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
          netProfit:
            mode === 'WAGER'
              ? agent.stats.netWagerProfit
              : // Free mode: the agent's play-chip standing against its grant,
                // minus any top-ups (which are new play money, not winnings).
                (
                  BigInt(agent.freeChips) +
                  this.listTables()
                    .flatMap((t) => t.state.seats)
                    .filter((s) => s.agentId === agent.id)
                    .reduce((acc, s) => acc + s.stack, 0n) -
                  FREE_CHIP_GRANT -
                  BigInt(agent.stats.topUpsReceived)
                ).toString(),
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

  /**
   * FR-10.5: emergency pause. A paused table stops dealing new hands; hands
   * already in flight are allowed to finish so no chips are stranded, and free
   * mode is never affected by the on-chain pause (which lives in `Poker.sol`
   * and only gates wager settlement).
   */
  pauseTable(tableId: string, paused: boolean, now = this.now()): TableSnapshot {
    const table = this.getTable(tableId);
    if (paused) {
      table.state = setTableStatus(table.state, 'PAUSED', now);
      table.nextHandAt = Number.POSITIVE_INFINITY;
    } else {
      table.state = setTableStatus(table.state, canStartHand(table.state) ? 'RUNNING' : 'OPEN', now);
      table.nextHandAt = now;
    }
    const snapshot = this.snapshot(table);
    this.emit('table', snapshot);
    this.log('warn', `${paused ? 'paused' : 'resumed'} table ${tableId}`);
    return snapshot;
  }

  /** True when the operator has paused this table (FR-10.5). */
  isPaused(tableId: string): boolean {
    return this.getTable(tableId).state.status === 'PAUSED';
  }

  private requireAgent(agentId: string): AgentRecord {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new EngineError('SEAT_NOT_FOUND', `unknown agent ${agentId}`);
    return agent;
  }
}

export { nextButtonSeat };
export type { TableState };

/**
 * Normalises one line of table talk.
 *
 * Control characters are removed rather than escaped. A newline or a NUL inside
 * a message would let a sender forge structure in whatever prompt a reader drops
 * the line into, which is a prompt-injection foothold between agents. Runs of
 * whitespace collapse so a line cannot be padded to look like something else.
 *
 * @returns the cleaned line, or `null` when nothing publishable is left.
 */
function normaliseChat(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const stripped = text
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped === '' ? null : stripped;
}
