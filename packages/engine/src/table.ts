/**
 * Table orchestration: seating, button rotation, hand lifecycle and the
 * free-mode ledger's stack bookkeeping.
 *
 * Like `hand.ts`, everything here is pure: time is passed in, results are
 * returned with public events, and no I/O happens.
 */

import {
  type ActionOrigin,
  type Card,
  type Chips,
  type HandResult,
  type PlayerAction,
  type SeatStatus,
  type TableConfig,
  type TableEvent,
  type TableStatus,
  type ActionRequest,
  EngineError,
  MAX_SEATS,
  validateTableConfig,
} from '@llmpoker/shared';
import { type HandState, type HandStep, applyAction, autoActionForTimeout, createHand, seatState } from './hand.js';

export interface TableSeatState {
  seat: number;
  agentId: string | null;
  agentName: string | null;
  status: SeatStatus;
  /** Chips on the table. */
  stack: Chips;
  /** Wager mode: escrowed chips held for this seat and not yet bought in. */
  escrow: Chips;
  /** Chips bought in over the table's lifetime (for the monitor). */
  totalBuyIn: Chips;
}

export interface TableState {
  config: TableConfig;
  status: TableStatus;
  seats: TableSeatState[];
  buttonSeat: number | null;
  handNumber: number;
  hand: HandState | null;
  lastResult: HandResult | null;
  /** FR-6: commitment published for the in-flight hand. */
  rngCommitment: string | null;
  rngNonce: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface TableStep {
  table: TableState;
  events: TableEvent[];
  actionRequest: ActionRequest | null;
}

export interface SeatParams {
  seat?: number;
  agentId: string;
  agentName: string;
  buyIn: Chips;
  /** Wager mode: chips escrowed on-chain and available to buy in with. */
  escrowAvailable?: Chips;
}

function cloneSeats(seats: TableSeatState[]): TableSeatState[] {
  return seats.map((s) => ({ ...s }));
}

function emptyTableSeat(seat: number): TableSeatState {
  return { seat, agentId: null, agentName: null, status: 'EMPTY', stack: 0n, escrow: 0n, totalBuyIn: 0n };
}

export function createTable(config: TableConfig, now: number): TableState {
  const errors = validateTableConfig(config);
  if (errors.length > 0) throw new EngineError('ILLEGAL_STATE', `invalid table config: ${errors.join('; ')}`);
  const seats: TableSeatState[] = [];
  for (let i = 0; i < config.maxSeats; i++) seats.push(emptyTableSeat(i));
  return {
    config,
    status: 'OPEN',
    seats,
    buttonSeat: null,
    handNumber: 0,
    hand: null,
    lastResult: null,
    rngCommitment: null,
    rngNonce: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function fundedSeats(table: TableState): TableSeatState[] {
  return table.seats.filter((s) => s.agentId !== null && s.stack >= table.config.bigBlind);
}

export function seatedSeats(table: TableState): TableSeatState[] {
  return table.seats.filter((s) => s.agentId !== null);
}

export function seatOfAgent(table: TableState, agentId: string): TableSeatState | null {
  return table.seats.find((s) => s.agentId === agentId) ?? null;
}

/** FR-1.4: an agent may hold several seats, but not two at the same table. */
export function seatAgent(prev: TableState, params: SeatParams, now: number): { table: TableState; seat: number } {
  const table: TableState = { ...prev, seats: cloneSeats(prev.seats), updatedAt: now };
  if (seatOfAgent(table, params.agentId)) {
    throw new EngineError('ALREADY_SEATED', `agent ${params.agentId} already holds a seat at ${table.config.id}`);
  }
  if (table.hand && !table.hand.complete) {
    throw new EngineError('ILLEGAL_STATE', 'cannot take a seat in the middle of a hand');
  }

  let seat = params.seat;
  if (seat === undefined) {
    const free = table.seats.find((s) => s.agentId === null);
    if (!free) throw new EngineError('TABLE_FULL', `table ${table.config.id} is full`);
    seat = free.seat;
  }
  if (!Number.isInteger(seat) || seat < 0 || seat >= table.config.maxSeats) {
    throw new EngineError('SEAT_NOT_FOUND', `seat ${seat} is out of range`);
  }
  const target = table.seats[seat]!;
  if (target.agentId !== null) throw new EngineError('TABLE_FULL', `seat ${seat} is taken`);

  const { minBuyIn, maxBuyIn } = table.config;
  if (params.buyIn < minBuyIn || params.buyIn > maxBuyIn) {
    throw new EngineError(
      'INSUFFICIENT_FUNDS',
      `buy-in must be between ${minBuyIn} and ${maxBuyIn} chips (got ${params.buyIn})`,
    );
  }
  const escrowAvailable = params.escrowAvailable ?? params.buyIn;
  if (escrowAvailable < params.buyIn) {
    throw new EngineError('INSUFFICIENT_FUNDS', `escrow ${escrowAvailable} does not cover a buy-in of ${params.buyIn}`);
  }

  target.agentId = params.agentId;
  target.agentName = params.agentName;
  target.status = 'SITTING_OUT';
  target.stack = params.buyIn;
  target.totalBuyIn = params.buyIn;
  target.escrow = escrowAvailable - params.buyIn;

  return { table, seat };
}

/** FR-5.5: cash-out — the caller credits the returned stack + escrow. */
export function leaveTable(
  prev: TableState,
  seat: number,
  now: number,
): { table: TableState; cashOut: Chips; escrow: Chips; agentId: string } {
  const table: TableState = { ...prev, seats: cloneSeats(prev.seats), updatedAt: now };
  const target = table.seats[seat];
  if (!target) throw new EngineError('SEAT_NOT_FOUND', `seat ${seat} is out of range`);
  if (target.agentId === null) throw new EngineError('SEAT_EMPTY', `seat ${seat} is empty`);
  if (table.hand && !table.hand.complete && seatState(table.hand, seat).agentId !== null) {
    throw new EngineError('ILLEGAL_STATE', 'cannot leave in the middle of a hand');
  }

  const seatHand = table.hand?.seats[seat];
  const committed = seatHand && table.hand && !table.hand.complete ? seatHand.totalCommitted : 0n;
  const cashOut = target.stack + committed;
  const escrow = target.escrow;
  const agentId = target.agentId;

  target.agentId = null;
  target.agentName = null;
  target.status = 'EMPTY';
  target.stack = 0n;
  target.escrow = 0n;
  target.totalBuyIn = 0n;

  if (table.hand && !table.hand.complete) {
    const hs = seatState(table.hand, seat);
    hs.folded = true;
    hs.agentId = null;
  }

  return { table, cashOut, escrow, agentId };
}

/** FR-5.1: top up an existing seat's stack from escrow. */
export function rebuy(
  prev: TableState,
  seat: number,
  amount: Chips,
  now: number,
): { table: TableState; agentId: string } {
  const table: TableState = { ...prev, seats: cloneSeats(prev.seats), updatedAt: now };
  const target = table.seats[seat];
  if (!target) throw new EngineError('SEAT_NOT_FOUND', `seat ${seat} is out of range`);
  if (target.agentId === null) throw new EngineError('SEAT_EMPTY', `seat ${seat} is empty`);
  if (amount <= 0n) throw new EngineError('INVALID_AMOUNT', 'rebuy amount must be positive');
  if (amount > target.escrow) throw new EngineError('INSUFFICIENT_FUNDS', 'escrow does not cover this rebuy');
  if (target.stack + amount > table.config.maxBuyIn) {
    throw new EngineError('INVALID_AMOUNT', `stack would exceed the ${table.config.maxBuyIn} maximum`);
  }
  target.escrow -= amount;
  target.stack += amount;
  target.totalBuyIn += amount;
  return { table, agentId: target.agentId };
}

export function canStartHand(table: TableState): boolean {
  if (table.status === 'CLOSED' || table.status === 'PAUSED') return false;
  if (table.hand && !table.hand.complete) return false;
  return fundedSeats(table).length >= 2;
}

/** Rotates the button to the next occupied seat (first hand picks the lowest seat). */
export function nextButtonSeat(table: TableState): number {
  const occupied = seatedSeats(table).map((s) => s.seat);
  if (occupied.length === 0) throw new EngineError('ILLEGAL_STATE', 'no seats are occupied');
  if (table.buttonSeat === null) return occupied[0]!;
  const n = table.config.maxSeats;
  for (let k = 1; k <= n; k++) {
    const candidate = (table.buttonSeat + k) % n;
    if (occupied.includes(candidate)) return candidate;
  }
  return occupied[0]!;
}

export interface StartHandParams {
  handId: string;
  deck: readonly Card[];
  now: number;
  /** FR-6: commitment published for this hand, if the table is a wager table. */
  commitment?: string;
  nonce?: string;
}

/** Starts the next hand: rotates the button, selects funded seats and deals. */
export function startHand(prev: TableState, params: StartHandParams): TableStep {
  if (!canStartHand(prev)) throw new EngineError('ILLEGAL_STATE', `table ${prev.config.id} cannot start a hand`);
  const table: TableState = { ...prev, seats: cloneSeats(prev.seats), updatedAt: params.now };

  const buttonSeat = nextButtonSeat(table);
  const players = fundedSeats(table).map((s) => ({
    seat: s.seat,
    agentId: s.agentId!,
    agentName: s.agentName ?? s.agentId!,
    stack: s.stack,
  }));

  const step: HandStep = createHand({
    handId: params.handId,
    tableId: table.config.id,
    handNumber: table.handNumber + 1,
    config: table.config,
    buttonSeat,
    players,
    deck: params.deck,
    now: params.now,
  });

  table.hand = step.state;
  table.handNumber += 1;
  table.buttonSeat = buttonSeat;
  table.status = 'RUNNING';
  table.rngCommitment = params.commitment ?? null;
  table.rngNonce = params.nonce ?? null;
  for (const s of seatedSeats(table)) {
    s.status = 'SITTING_OUT';
  }
  table.updatedAt = params.now;

  const events: TableEvent[] = [...step.events, ...syncSeatStatuses(table)];
  return { table, events, actionRequest: step.actionRequest };
}

function syncSeatStatuses(table: TableState): TableEvent[] {
  const events: TableEvent[] = [];
  for (const s of seatedSeats(table)) {
    const hand = table.hand?.seats[s.seat];
    const status: SeatStatus =
      hand && hand.agentId !== null ? (hand.folded ? 'FOLDED' : hand.allIn ? 'ALL_IN' : 'ACTIVE') : 'SITTING_OUT';
    if (status !== s.status) {
      s.status = status;
      events.push({ type: 'SEAT_CHANGED', seat: s.seat, status, stack: s.stack.toString() });
    }
  }
  return events;
}

/** Applies an agent action to the table's live hand. */
export function actOnTable(
  prev: TableState,
  seat: number,
  action: PlayerAction,
  now: number,
  origin: ActionOrigin = 'AGENT',
): TableStep {
  const hand = prev.hand;
  if (!hand || hand.complete) throw new EngineError('HAND_NOT_FOUND', `table ${prev.config.id} has no live hand`);

  const step = applyAction(hand, seat, action, now, origin);
  const table: TableState = { ...prev, seats: cloneSeats(prev.seats), hand: step.state, updatedAt: now };
  const events: TableEvent[] = [...step.events];

  if (step.state.complete) events.push(...finishHand(table, now));

  return { table, events, actionRequest: step.actionRequest };
}

/** FR-3.5: applies CHECK-if-legal-else-FOLD for the seat on the clock. */
export function timeoutAction(prev: TableState, now: number): TableStep {
  const hand = prev.hand;
  if (!hand || hand.complete || hand.toActSeat === null) {
    throw new EngineError('HAND_NOT_FOUND', `table ${prev.config.id} has no seat on the clock`);
  }
  const action = autoActionForTimeout(hand);
  return actOnTable(prev, hand.toActSeat, action, now, 'TIMEOUT');
}

/**
 * Settles the table after a hand: stacks are written back from the hand, busted
 * free-mode seats are topped up (FR-4.2) and finished seats are marked busted.
 */
function finishHand(table: TableState, now: number): TableEvent[] {
  const hand = table.hand!;
  const result = hand.result;
  if (!result) throw new EngineError('ILLEGAL_STATE', 'hand completed without a result');
  const events: TableEvent[] = [];
  table.lastResult = result;
  table.rngCommitment = null;
  table.rngNonce = null;

  for (const seatResult of result.seats) {
    const seat = table.seats[seatResult.seat]!;
    if (seat.agentId === null) continue;
    seat.stack = BigInt(seatResult.endingStack);
    if (seat.stack === 0n && table.config.autoTopUp !== null) {
      seat.stack = table.config.autoTopUp;
      seat.escrow += 0n;
      events.push({ type: 'SEAT_CHANGED', seat: seat.seat, status: 'ACTIVE', stack: seat.stack.toString() });
    }
    if (seat.stack < table.config.bigBlind) seat.status = 'BUSTED';
  }

  if (fundedSeats(table).length < 2) table.status = 'OPEN';
  table.updatedAt = now;
  return events;
}

export function setTableStatus(prev: TableState, status: TableStatus, now: number): TableState {
  return { ...prev, status, seats: cloneSeats(prev.seats), updatedAt: now };
}

export { MAX_SEATS };
