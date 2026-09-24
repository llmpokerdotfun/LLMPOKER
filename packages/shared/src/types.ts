/**
 * Domain + protocol types for the whole platform.
 *
 * Money is `bigint` everywhere (chips with 18 decimals, mirroring the on-chain
 * `uint256`). Anything crossing an HTTP/WS boundary is serialised with chips as
 * **decimal strings** (`"1500000000000000000"`) so no precision is ever lost in
 * `JSON.parse`.
 */

import type { Card } from './cards.js';

/** Chips are indivisible base units (1 token = 1e18). */
export type Chips = bigint;
/** Chips as they appear on the wire. */
export type ChipsJson = string;
export const CHIP_DECIMALS = 18;
export const CHIPS_PER_TOKEN = 10n ** BigInt(CHIP_DECIMALS);

export type Mode = 'FREE' | 'WAGER';

export type Street = 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER' | 'SHOWDOWN' | 'COMPLETE';

export type ActionType = 'FOLD' | 'CHECK' | 'CALL' | 'BET' | 'RAISE' | 'ALL_IN';

export type AgentStatus = 'IDLE' | 'SEATED' | 'THINKING' | 'FOLDED' | 'BUSTED' | 'OFFLINE';

export type TableStatus = 'OPEN' | 'RUNNING' | 'PAUSED' | 'CLOSED';

export type SeatStatus = 'EMPTY' | 'SITTING_OUT' | 'ACTIVE' | 'FOLDED' | 'ALL_IN' | 'BUSTED';

/** Why an action was applied without the agent asking for it. */
export type ActionOrigin = 'AGENT' | 'TIMEOUT' | 'ENGINE';

// ---------------------------------------------------------------------------
// Tables & seating
// ---------------------------------------------------------------------------

export const MAX_SEATS = 6;

export interface TableConfig {
  id: string;
  name: string;
  mode: Mode;
  maxSeats: number;
  /** Blinds/ante/buy-ins are in chips (base units). */
  smallBlind: Chips;
  bigBlind: Chips;
  ante: Chips;
  minBuyIn: Chips;
  maxBuyIn: Chips;
  /** FR-3.5 think budget per decision. */
  thinkBudgetMs: number;
  /** FR-8.1 rake, basis points of the pot (250 = 2.5%). */
  rakeBps: number;
  /** FR-8.1 rake cap in chips per pot. */
  rakeCap: Chips;
  /** Rake is only taken once a flop is seen. */
  rakeOnlyWithFlop: boolean;
  /** Burn one card before flop/turn/river (standard poker; affects the deal index map). */
  burnCards: boolean;
  /** Start the next hand automatically when >= 2 funded seats are present. */
  autoStart: boolean;
  /** Delay between hands. */
  handIntervalMs: number;
  /** Buy-in escrow requirement for wager tables (FR-5.1). */
  escrowRequired: boolean;
}

/** The safe subset of a table config that a client sees. */
export interface TableSnapshot {
  id: string;
  name: string;
  mode: Mode;
  status: TableStatus;
  config: TableConfig;
  seats: SeatSnapshot[];
  buttonSeat: number | null;
  handId: string | null;
  handNumber: number;
  street: Street | null;
  board: Card[];
  pots: PotSnapshot[];
  totalPot: ChipsJson;
  currentBet: ChipsJson;
  minRaiseTo: ChipsJson;
  toActSeat: number | null;
  /** Unix ms when the seat on the clock must have acted (FR-3.5). */
  actionDeadlineTs: number | null;
  /** FR-6: commitment published for the in-flight hand, if any. */
  rngCommitment: string | null;
  startedAt: number;
  updatedAt: number;
}

export interface SeatSnapshot {
  seat: number;
  status: SeatStatus;
  agentId: string | null;
  agentName: string | null;
  /** Chips behind. */
  stack: ChipsJson;
  /** Committed on the current street. */
  committed: ChipsJson;
  /** Committed across the whole hand. */
  totalCommitted: ChipsJson;
  holeCards: Card[] | null;
  /** Wager mode: escrowed balance available to this seat. */
  escrow: ChipsJson | null;
}

export interface PotSnapshot {
  index: number;
  amount: ChipsJson;
  eligibleSeats: number[];
}

// ---------------------------------------------------------------------------
// Agents & auth
// ---------------------------------------------------------------------------

export interface AgentMetadata {
  model?: string;
  endpoint?: string;
  avatar?: string;
  description?: string;
  /** Free-form operator tags, surfaced publicly (see FR-10.2 multi-seat flagging). */
  operator?: string;
}

export interface Agent {
  id: string;
  name: string;
  /** Lowercased 0x address — the signing identity. */
  wallet: string;
  metadata: AgentMetadata;
  createdAt: number;
  lastSeenAt: number | null;
  /** Public flag: this wallet already backs other agent ids (FR-10.2). */
  sharedWallet: boolean;
}

export interface AgentSnapshot extends Agent {
  status: AgentStatus;
  seatedAt: { tableId: string; seat: number } | null;
  stack: ChipsJson | null;
  handsPlayed: number;
  handsWon: number;
  freeChips: ChipsJson;
  escrow: ChipsJson;
  netWagerProfit: ChipsJson;
}

/** EIP-712 payload signed by the wallet to claim an agent identity (FR-1.2). */
export interface RegistrationTypedData {
  name: string;
  wallet: string;
  nonce: string;
  metadataHash: string;
  deadline: number;
}

/** EIP-712 payload signed for every state-changing wager action (FR-1.3, FR-10.4). */
export interface ActionTypedData {
  agentId: string;
  tableId: string;
  handId: string;
  seat: number;
  action: ActionType;
  amount: ChipsJson;
  nonce: string;
  deadline: number;
}

// ---------------------------------------------------------------------------
// Hands
// ---------------------------------------------------------------------------

export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  canBet: boolean;
  canRaise: boolean;
  canAllIn: boolean;
  /** Chips required to call (0 when checking is free). */
  toCall: ChipsJson;
  /** Smallest legal total bet/raise target for this seat, in chips. */
  minRaiseTo: ChipsJson;
  /** Largest legal total bet/raise target for this seat ("all-in" ceiling). */
  maxRaiseTo: ChipsJson;
  /** The full set of legal `BET`/`RAISE` targets, for a bounded search. */
  sizedTargets: ChipsJson[];
}

export interface ActionRequest {
  tableId: string;
  handId: string;
  seat: number;
  street: Street;
  legal: LegalActions;
  pot: ChipsJson;
  board: Card[];
  holeCards: Card[];
  /** Chips behind the acting seat. */
  stack: ChipsJson;
  deadlineTs: number;
}

export interface ActionRecord {
  seq: number;
  handId: string;
  street: Street;
  seat: number;
  action: ActionType;
  amount: ChipsJson;
  origin: ActionOrigin;
  /** Chips added by this action. */
  paid: ChipsJson;
  potAfter: ChipsJson;
  at: number;
}

export interface RevealedHand {
  seat: number;
  cards: Card[];
  /** e.g. "FULL_HOUSE", `null` when the seat mucked or was not shown. */
  category: HandCategory | null;
  /** Human readable, e.g. "Kings full of Tens". */
  description: string | null;
}

export type HandCategory =
  | 'HIGH_CARD'
  | 'PAIR'
  | 'TWO_PAIR'
  | 'TRIPS'
  | 'STRAIGHT'
  | 'FLUSH'
  | 'FULL_HOUSE'
  | 'QUADS'
  | 'STRAIGHT_FLUSH'
  | 'ROYAL_FLUSH';

export interface PotAward {
  potIndex: number;
  amount: ChipsJson;
  rake: ChipsJson;
  winners: { seat: number; amount: ChipsJson }[];
  /** Populated when a pot is split and chips cannot divide evenly (FR-3.4). */
  oddChipSeat?: number | null;
}

export interface HandResult {
  handId: string;
  tableId: string;
  handNumber: number;
  mode: Mode;
  streetReached: Street;
  board: Card[];
  startedAt: number;
  endedAt: number;
  buttonSeat: number;
  /** Seats in the order they were dealt to (starts at the small blind). Part of the proof. */
  dealingOrder: number[];
  /** Cards burnt before flop/turn/river (empty when the table deals without burns). */
  burns: Card[];
  seats: {
    seat: number;
    agentId: string | null;
    startingStack: ChipsJson;
    endingStack: ChipsJson;
    net: ChipsJson;
    holeCards: Card[] | null;
    folded: boolean;
    allIn: boolean;
  }[];
  actions: ActionRecord[];
  pots: PotAward[];
  totalPot: ChipsJson;
  totalRake: ChipsJson;
  showdown: RevealedHand[];
  /** Total chips leaving/entering stacks must sum to zero. */
  zeroSumVerified: boolean;
}

/** A hand history entry: the result plus everything needed to re-verify it. */
export interface HandHistory {
  result: HandResult;
  proof: RngProof;
  deck: Card[];
}

// ---------------------------------------------------------------------------
// RNG proof (FR-6)
// ---------------------------------------------------------------------------

export interface RngProof {
  handId: string;
  tableId: string;
  handNumber: number;
  /** keccak256(seed ‖ nonce), 0x-prefixed 32 bytes. */
  commitment: string;
  /** Revealed seed, 0x-prefixed 32 bytes. `null` until revealed. */
  deckSeed: string | null;
  nonce: string;
  commitBlock: number | null;
  commitTxHash: string | null;
  anchorBlock: number | null;
  anchorBlockHash: string | null;
  revealBlock: number | null;
  revealTxHash: string | null;
  /** keccak256(seed ‖ anchorBlockHash). */
  entropy: string | null;
  /** The stored 52-card ordering, as card ids. */
  deck: Card[];
  verified: boolean;
  verifiedAt: number | null;
  /** Chain id of the settlement chain (4663 = Robinhood Chain). */
  chainId: number;
}

export interface ProofVerification {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
}

// ---------------------------------------------------------------------------
// Player actions
// ---------------------------------------------------------------------------

export interface PlayerAction {
  action: ActionType;
  /** Required for BET/RAISE; ignored for FOLD/CHECK/CALL/ALL_IN. */
  amount?: Chips;
}

export type EngineErrorCode =
  | 'NOT_YOUR_TURN'
  | 'ILLEGAL_ACTION'
  | 'INVALID_AMOUNT'
  | 'RAISE_TOO_SMALL'
  | 'RAISE_TOO_LARGE'
  | 'INSUFFICIENT_STACK'
  | 'HAND_NOT_FOUND'
  | 'HAND_COMPLETE'
  | 'SEAT_NOT_FOUND'
  | 'SEAT_EMPTY'
  | 'TABLE_FULL'
  | 'INSUFFICIENT_FUNDS'
  | 'TABLE_NOT_FOUND'
  | 'ALREADY_SEATED'
  | 'ILLEGAL_STATE';

export class EngineError extends Error {
  readonly code: EngineErrorCode;

  constructor(code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Hand/table events (also the WS vocabulary)
// ---------------------------------------------------------------------------

export type TableEvent =
  | { type: 'HAND_STARTED'; handId: string; handNumber: number; buttonSeat: number; blinds: { sb: number; bb: number }; ante: ChipsJson }
  | { type: 'BLIND_POSTED'; seat: number; amount: ChipsJson; kind: 'SMALL_BLIND' | 'BIG_BLIND' | 'ANTE' }
  | { type: 'HOLE_CARDS_DEALT'; seat: number }
  | { type: 'ACTION_REQUIRED'; seat: number; request: ActionRequest }
  | { type: 'ACTION_TAKEN'; record: ActionRecord }
  | { type: 'STREET_ADVANCED'; street: Street; board: Card[]; burns: number }
  | { type: 'SHOWDOWN'; reveals: RevealedHand[] }
  | { type: 'POT_AWARDED'; award: PotAward }
  | { type: 'HAND_COMPLETE'; result: HandResult }
  | { type: 'RNG_COMMITTED'; commitment: string; nonce: string }
  | { type: 'RNG_REVEALED'; proof: RngProof }
  | { type: 'SEAT_CHANGED'; seat: number; status: SeatStatus; stack: ChipsJson }
  | { type: 'TABLE_STATE'; table: TableSnapshot };

export interface Envelope<T> {
  seq: number;
  at: number;
  tableId: string;
  payload: T;
}

// ---------------------------------------------------------------------------
// WebSocket protocol (FR-7.5, SRS §7)
// ---------------------------------------------------------------------------

export type ClientMessage =
  | { type: 'SUBSCRIBE'; tableId: string }
  | { type: 'UNSUBSCRIBE'; tableId: string }
  | { type: 'PING' };

export type ServerMessage =
  | { type: 'WELCOME'; serverTime: number; chainId: number; version: string }
  | { type: 'SUBSCRIBED'; tableId: string; table: TableSnapshot }
  | { type: 'UNSUBSCRIBED'; tableId: string }
  | { type: 'TABLE_STATE'; table: TableSnapshot }
  | { type: 'TABLE_EVENT'; tableId: string; envelope: Envelope<TableEvent> }
  | { type: 'ACTION_REQUIRED'; tableId: string; request: ActionRequest }
  | { type: 'HAND_COMPLETE'; tableId: string; result: HandResult }
  | { type: 'AGENT_STATUS'; agent: AgentSnapshot }
  | { type: 'ERROR'; code: string; message: string }
  | { type: 'PONG'; serverTime: number };

// ---------------------------------------------------------------------------
// API request/response bodies (SRS §7)
// ---------------------------------------------------------------------------

export interface RegisterRequest {
  name: string;
  wallet: string;
  metadata?: AgentMetadata;
}

export interface RegisterChallenge {
  /** Nonce the wallet must include in the EIP-712 signature. */
  nonce: string;
  deadline: number;
  typedData: unknown;
}

export interface RegisterResponse {
  agent: Agent;
  /** Returned exactly once, at registration. */
  apiKey: string;
  challenge: RegisterChallenge;
}

export interface AuthRequest {
  agentId: string;
  wallet: string;
  nonce: string;
  deadline: number;
  signature: string;
}

export interface AuthResponse {
  token: string;
  expiresAt: number;
  agent: Agent;
}

export interface SeatRequest {
  tableId: string;
  seat?: number;
  buyIn?: ChipsJson;
}

export interface ActRequest {
  tableId: string;
  handId: string;
  seat: number;
  action: ActionType;
  amount?: ChipsJson;
  nonce?: string;
  deadline?: number;
  signature?: string;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface LeaderboardRow {
  agentId: string;
  name: string;
  mode: Mode;
  handsPlayed: number;
  handsWon: number;
  winRate: number;
  netProfit: ChipsJson;
  volume: ChipsJson;
}
