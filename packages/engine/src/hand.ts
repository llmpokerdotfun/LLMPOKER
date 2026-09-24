/**
 * One hand of 6-max No-Limit Texas Hold'em — the referee (FR-3).
 *
 * Design rules the rest of the system relies on:
 *
 * * **Pure and deterministic.** `createHand` / `applyAction` never read a clock
 *   or a random source: the deck is handed in and time is passed explicitly. A
 *   hand is therefore fully replayable from its history ({@link replayHand}).
 * * **The engine is the referee, not the agent** (FR-3.6). Out-of-turn, illegal,
 *   undersized and oversized actions raise {@link EngineError} with a code — they
 *   are never coerced into something legal.
 * * **Events are public.** `HandStep.events` is safe to broadcast to every
 *   spectator. The turn notification — which contains private hole cards — is
 *   returned separately as `HandStep.actionRequest` and must only be delivered to
 *   the seat on the clock.
 * * **Integer-exact money.** Every chip is a `bigint`; payouts are asserted to
 *   balance exactly at settlement (FR-3.4, NFR-5).
 */

import {
  type ActionOrigin,
  type ActionRecord,
  type ActionRequest,
  type Card,
  type Chips,
  type HandResult,
  type LegalActions,
  type PlayerAction,
  type PotAward,
  type RevealedHand,
  type Street,
  type TableConfig,
  type TableEvent,
  EngineError,
  MAX_SEATS,
  assertCompleteDeck,
  boardForStreet,
  computeRake,
  dealHoldem,
  dealingOrderFor,
  type DealResult,
} from '@llmpoker/shared';
import { type HandRank, compareRanks, evaluate7 } from './evaluator.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface HandSeatState {
  seat: number;
  agentId: string | null;
  agentName: string | null;
  /** Stack at the start of the hand. */
  startingStack: Chips;
  /** Chips behind. */
  stack: Chips;
  /** Chips put in on the current street. */
  committed: Chips;
  /** Chips put in across the whole hand (antes included). */
  totalCommitted: Chips;
  holeCards: Card[];
  folded: boolean;
  allIn: boolean;
  /** Has acted since the last aggressive action on this street. */
  actedThisRound: boolean;
  /** False when facing a short all-in that did not reopen the betting. */
  canRaise: boolean;
}

export interface Pot {
  index: number;
  amount: Chips;
  /** Seats that can win this pot (not folded). */
  eligible: number[];
}

export interface HandState {
  handId: string;
  tableId: string;
  handNumber: number;
  config: TableConfig;
  street: Street;
  buttonSeat: number;
  smallBlindSeat: number;
  bigBlindSeat: number;
  /** Seats in the order they were dealt to (starts at the small blind). */
  dealingOrder: number[];
  seats: HandSeatState[];
  deck: Card[];
  deal: DealResult;
  board: Card[];
  burnCards: Card[];
  /** Live side-pot structure (no rake applied until settlement). */
  pots: Pot[];
  currentBet: Chips;
  /** Size of the last full bet/raise; drives `minRaiseTo`. */
  lastFullRaise: Chips;
  toActSeat: number | null;
  lastAggressorSeat: number | null;
  /** Search cursor for the next actor: scanning starts one seat clockwise. */
  searchFromSeat: number;
  actions: ActionRecord[];
  seq: number;
  sawFlop: boolean;
  complete: boolean;
  startedAt: number;
  endedAt: number | null;
  deadlineTs: number | null;
  result: HandResult | null;
}

export interface HandStep {
  state: HandState;
  /** Public events — safe to broadcast to spectators. */
  events: TableEvent[];
  /** Private turn notification for `state.toActSeat` only. */
  actionRequest: ActionRequest | null;
}

export interface CreateHandParams {
  handId: string;
  tableId: string;
  handNumber: number;
  config: TableConfig;
  buttonSeat: number;
  players: { seat: number; agentId: string; agentName: string; stack: Chips }[];
  /** 52 distinct cards, already shuffled (see FR-6). */
  deck: readonly Card[];
  now: number;
}

// ---------------------------------------------------------------------------
// Seat helpers
// ---------------------------------------------------------------------------

/** Seats that were dealt into this hand. */
export function seatedPlayers(state: HandState): HandSeatState[] {
  return state.seats.filter((s) => s.agentId !== null);
}

/** Seats still in the hand (dealt in and not folded). */
export function contestingSeats(state: HandState): HandSeatState[] {
  return state.seats.filter((s) => s.agentId !== null && !s.folded);
}

/** Seats that can still take an action (contesting and not all-in). */
export function actionableSeats(state: HandState): HandSeatState[] {
  return contestingSeats(state).filter((s) => !s.allIn);
}

export function seatState(state: HandState, seat: number): HandSeatState {
  const s = state.seats[seat];
  if (!s) throw new EngineError('SEAT_NOT_FOUND', `seat ${seat} is out of range`);
  return s;
}

export function totalPot(state: HandState): Chips {
  let sum = 0n;
  for (const s of state.seats) sum += s.totalCommitted;
  return sum;
}

/**
 * Side pots from every seat's total contribution. Layers with identical
 * eligibility are merged, so a normal hand yields exactly one pot.
 */
export function buildPots(seats: readonly HandSeatState[]): Pot[] {
  const contributors = seats.filter((s) => s.totalCommitted > 0n && s.agentId !== null);
  if (contributors.length === 0) return [];

  const levels = [...new Set(contributors.map((s) => s.totalCommitted))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const pots: Pot[] = [];
  let previous = 0n;

  for (const level of levels) {
    const atLevel = seats.filter((s) => s.totalCommitted >= level && s.agentId !== null);
    const amount = (level - previous) * BigInt(atLevel.length);
    let eligible = atLevel
      .filter((s) => !s.folded)
      .map((s) => s.seat)
      .sort((a, b) => a - b);
    if (eligible.length === 0) {
      // Defensive: chips must never be orphaned. A layer whose only contributors
      // folded is unreachable in legal play, but if it ever happened the layer is
      // contested by whoever is still in the pot.
      eligible = seats
        .filter((s) => s.agentId !== null && !s.folded)
        .map((s) => s.seat)
        .sort((a, b) => a - b);
    }
    if (amount > 0n && eligible.length > 0) {
      const last = pots[pots.length - 1];
      if (last && last.eligible.join(',') === eligible.join(',')) {
        last.amount += amount;
      } else {
        pots.push({ index: pots.length, amount, eligible });
      }
    }
    previous = level;
  }
  return pots.map((p, i) => ({ ...p, index: i }));
}

export function currentPots(state: HandState): Pot[] {
  return buildPots(state.seats);
}

/**
 * FR-6.3: deck positions whose cards the game rules have made public so far.
 *
 * Only board cards qualify while a hand is live — a burn is never public, and
 * hole cards only become public at showdown, which the end-of-hand audit covers.
 * This is therefore exactly what the operator may reveal mid-hand; revealing
 * anything else would trip the hidden-card invariant the verifier enforces.
 */
export function revealedBoardPositions(state: HandState): number[] {
  return state.deal.boardIndices.slice(0, state.board.length);
}

// ---------------------------------------------------------------------------
// Legal actions
// ---------------------------------------------------------------------------

/**
 * `minRaiseTo`/`maxRaiseTo` are **total-this-street** targets ("raise to"),
 * matching the `RAISE <amt>` grammar in SRS §7.
 */
export function legalActions(state: HandState, seat: number): LegalActions {
  const me = seatState(state, seat);
  const toCallRaw = state.currentBet - me.committed;
  const toCall = toCallRaw > 0n ? toCallRaw : 0n;
  const maxTo = me.committed + me.stack;

  const canCheck = toCall === 0n;
  const canCall = toCall > 0n && me.stack > 0n;
  const canBet = canCheck && me.stack > 0n;
  const canRaise = toCall > 0n && me.canRaise && maxTo > state.currentBet;

  const minBet = state.config.bigBlind;
  let minRaiseTo: Chips;
  if (state.currentBet === 0n) {
    minRaiseTo = minBet < maxTo ? minBet : maxTo;
  } else {
    const target = state.currentBet + state.lastFullRaise;
    minRaiseTo = target < maxTo ? target : maxTo;
  }

  // The legal BET/RAISE targets: minimum, every all-in-sized step down from the
  // maximum, plus the classic pot-sized points an agent is likely to want.
  const targets = new Set<bigint>();
  if (canBet || canRaise) {
    targets.add(minRaiseTo);
    targets.add(maxTo);
    if (maxTo > minRaiseTo) {
      const potNow = totalPot(state);
      for (const fraction of [2n, 3n, 4n]) {
        const sized = minRaiseTo + (potNow - (potNow % fraction)) / fraction;
        if (sized > minRaiseTo && sized < maxTo) targets.add(sized);
      }
      targets.add(maxTo - 1n);
    }
  }
  const sizedTargets = [...targets].filter((t) => t >= 0n).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    canFold: true,
    canCheck,
    canCall,
    canBet,
    canRaise,
    canAllIn: me.stack > 0n,
    toCall: toCall.toString(),
    minRaiseTo: minRaiseTo.toString(),
    maxRaiseTo: maxTo.toString(),
    sizedTargets: sizedTargets.map((t) => t.toString()),
  };
}

/** FR-3.5: on think-budget expiry the engine applies CHECK when legal, else FOLD. */
export function autoActionForTimeout(state: HandState): PlayerAction {
  if (state.toActSeat === null) throw new EngineError('ILLEGAL_STATE', 'no seat is on the clock');
  const legal = legalActions(state, state.toActSeat);
  return legal.canCheck ? { action: 'CHECK' } : { action: 'FOLD' };
}

// ---------------------------------------------------------------------------
// Hand creation
// ---------------------------------------------------------------------------

function emptySeat(seat: number, player: CreateHandParams['players'][number] | undefined, holes: Card[]): HandSeatState {
  return {
    seat,
    agentId: player?.agentId ?? null,
    agentName: player?.agentName ?? null,
    startingStack: player?.stack ?? 0n,
    stack: player?.stack ?? 0n,
    committed: 0n,
    totalCommitted: 0n,
    holeCards: holes,
    folded: player === undefined,
    allIn: false,
    actedThisRound: false,
    canRaise: true,
  };
}

/** Creates a hand: posts antes/blinds, deals, and puts the first seat on the clock. */
export function createHand(params: CreateHandParams): HandStep {
  const { handId, tableId, handNumber, config, buttonSeat, players, deck, now } = params;
  assertCompleteDeck(deck);
  if (players.length < 2) throw new EngineError('ILLEGAL_STATE', 'a hand needs at least 2 players');
  if (config.maxSeats < 2 || config.maxSeats > MAX_SEATS) {
    throw new EngineError('ILLEGAL_STATE', `maxSeats must be 2..${MAX_SEATS}`);
  }

  const seen = new Set<number>();
  for (const p of players) {
    if (!Number.isInteger(p.seat) || p.seat < 0 || p.seat >= config.maxSeats) {
      throw new EngineError('SEAT_NOT_FOUND', `seat ${p.seat} is out of range`);
    }
    if (seen.has(p.seat)) throw new EngineError('ALREADY_SEATED', `seat ${p.seat} is listed twice`);
    seen.add(p.seat);
    if (p.stack <= 0n) throw new EngineError('INSUFFICIENT_FUNDS', `seat ${p.seat} has no chips`);
  }

  const ordered = [...players].sort((a, b) => a.seat - b.seat);
  const buttonIdx = ordered.findIndex((p) => p.seat === buttonSeat);
  if (buttonIdx < 0) throw new EngineError('ILLEGAL_STATE', `button seat ${buttonSeat} is not in the hand`);

  // Blinds: heads-up the button posts the small blind (standard NLHE).
  let smallBlindSeat: number;
  let bigBlindSeat: number;
  if (ordered.length === 2) {
    smallBlindSeat = ordered[buttonIdx]!.seat;
    bigBlindSeat = ordered[(buttonIdx + 1) % 2]!.seat;
  } else {
    smallBlindSeat = ordered[(buttonIdx + 1) % ordered.length]!.seat;
    bigBlindSeat = ordered[(buttonIdx + 2) % ordered.length]!.seat;
  }

  const dealingOrder = dealingOrderFor(
    ordered.map((p) => p.seat),
    smallBlindSeat,
    config.maxSeats,
  );
  const deal = dealHoldem(deck, dealingOrder, { burnCards: config.burnCards });

  const seats: HandSeatState[] = [];
  for (let s = 0; s < config.maxSeats; s++) {
    const player = ordered.find((p) => p.seat === s);
    seats.push(emptySeat(s, player, player ? [...(deal.holes.get(s) ?? [])] : []));
  }

  // Preflop: heads-up the small blind (button) acts first, otherwise the seat
  // after the big blind does.
  const searchFromSeat =
    ordered.length === 2
      ? (smallBlindSeat - 1 + config.maxSeats) % config.maxSeats
      : bigBlindSeat;

  const state: HandState = {
    handId,
    tableId,
    handNumber,
    config,
    street: 'PREFLOP',
    buttonSeat,
    smallBlindSeat,
    bigBlindSeat,
    dealingOrder,
    seats,
    deck: [...deck],
    deal,
    board: [],
    burnCards: [...deal.burns],
    pots: [],
    currentBet: 0n,
    lastFullRaise: config.bigBlind,
    toActSeat: null,
    lastAggressorSeat: null,
    searchFromSeat,
    actions: [],
    seq: 0,
    sawFlop: false,
    complete: false,
    startedAt: now,
    endedAt: null,
    deadlineTs: null,
    result: null,
  };

  const events: TableEvent[] = [
    {
      type: 'HAND_STARTED',
      handId,
      handNumber,
      buttonSeat,
      blinds: { sb: smallBlindSeat, bb: bigBlindSeat },
      ante: config.ante.toString(),
    },
  ];

  if (config.ante > 0n) {
    for (const s of dealingOrder) {
      const amount = postChips(state, s, config.ante, { countsTowardBet: false });
      if (amount > 0n) events.push({ type: 'BLIND_POSTED', seat: s, amount: amount.toString(), kind: 'ANTE' });
    }
  }

  const sbAmount = postChips(state, smallBlindSeat, config.smallBlind, { countsTowardBet: true });
  events.push({ type: 'BLIND_POSTED', seat: smallBlindSeat, amount: sbAmount.toString(), kind: 'SMALL_BLIND' });
  const bbAmount = postChips(state, bigBlindSeat, config.bigBlind, { countsTowardBet: true });
  events.push({ type: 'BLIND_POSTED', seat: bigBlindSeat, amount: bbAmount.toString(), kind: 'BIG_BLIND' });

  state.currentBet = state.seats.reduce((max, s) => (s.committed > max ? s.committed : max), 0n);
  state.lastAggressorSeat = bigBlindSeat;

  for (const s of dealingOrder) events.push({ type: 'HOLE_CARDS_DEALT', seat: s });

  state.pots = buildPots(state.seats);
  const step = progress(state, events, now);
  return step;
}

/**
 * Moves chips from a stack into the pot, capped by the stack (all-in for less).
 * Antes do not count toward the current street bet, so `countsTowardBet` is
 * false for them.
 */
function postChips(state: HandState, seat: number, amount: Chips, options: { countsTowardBet: boolean }): Chips {
  const s = seatState(state, seat);
  const paid = amount < s.stack ? amount : s.stack;
  if (paid <= 0n) return 0n;
  s.stack -= paid;
  if (options.countsTowardBet) s.committed += paid;
  s.totalCommitted += paid;
  if (s.stack === 0n) s.allIn = true;
  return paid;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function findNextActor(state: HandState, from: number): number | null {
  const n = state.config.maxSeats;
  for (let k = 1; k <= n; k++) {
    const seat = (from + k) % n;
    const s = state.seats[seat];
    if (!s || s.agentId === null || s.folded || s.allIn) continue;
    if (!s.actedThisRound || s.committed < state.currentBet) return seat;
  }
  return null;
}

/**
 * Applies one action. `now` feeds the think-budget deadline and action
 * timestamps; `origin` records whether the agent acted or the engine did
 * (timeout / forced).
 */
export function applyAction(
  prev: HandState,
  seat: number,
  action: PlayerAction,
  now: number,
  origin: ActionOrigin = 'AGENT',
): HandStep {
  if (prev.complete) throw new EngineError('HAND_COMPLETE', `hand ${prev.handId} is already complete`);
  if (prev.toActSeat === null) throw new EngineError('ILLEGAL_STATE', 'no seat is on the clock');
  if (prev.toActSeat !== seat) {
    throw new EngineError('NOT_YOUR_TURN', `seat ${seat} cannot act; seat ${prev.toActSeat} is on the clock`);
  }

  const state = cloneState(prev);
  const events: TableEvent[] = [];
  const me = seatState(state, seat);
  if (me.agentId === null) throw new EngineError('SEAT_EMPTY', `seat ${seat} is empty`);
  if (me.folded) throw new EngineError('ILLEGAL_ACTION', `seat ${seat} has folded`);
  if (me.allIn) throw new EngineError('ILLEGAL_ACTION', `seat ${seat} is all-in`);

  const legal = legalActions(state, seat);
  const minRaiseTo = BigInt(legal.minRaiseTo);
  const maxRaiseTo = BigInt(legal.maxRaiseTo);
  const toCall = state.currentBet - me.committed;
  let paid = 0n;
  let target: Chips | null = null;

  switch (action.action) {
    case 'FOLD':
      me.folded = true;
      me.actedThisRound = true;
      break;

    case 'CHECK':
      if (!legal.canCheck) {
        throw new EngineError('ILLEGAL_ACTION', `cannot check: ${toCall} to call`);
      }
      me.actedThisRound = true;
      break;

    case 'CALL': {
      if (!legal.canCall) throw new EngineError('ILLEGAL_ACTION', 'nothing to call');
      paid = toCall < me.stack ? toCall : me.stack;
      me.actedThisRound = true;
      break;
    }

    case 'ALL_IN':
      if (!legal.canAllIn) throw new EngineError('ILLEGAL_ACTION', 'nothing to put in');
      paid = me.stack;
      target = me.committed + paid;
      break;

    case 'BET': {
      if (!legal.canBet) throw new EngineError('ILLEGAL_ACTION', 'cannot bet here; use RAISE or CALL');
      const amount = requireAmount(action);
      if (amount > maxRaiseTo) {
        throw new EngineError('RAISE_TOO_LARGE', `bet of ${amount} exceeds the ${legal.maxRaiseTo} maximum`);
      }
      if (amount < minRaiseTo && amount !== maxRaiseTo) {
        throw new EngineError('RAISE_TOO_SMALL', `bet of ${amount} is below the ${legal.minRaiseTo} minimum`);
      }
      if (amount <= me.committed) throw new EngineError('INVALID_AMOUNT', `bet of ${amount} is not above the current bet`);
      paid = amount - me.committed;
      target = amount;
      break;
    }

    case 'RAISE': {
      if (!legal.canRaise) {
        throw new EngineError(
          'ILLEGAL_ACTION',
          me.canRaise ? 'nothing to raise: call or fold' : 'betting was not reopened by a short all-in',
        );
      }
      const amount = requireAmount(action);
      if (amount > maxRaiseTo) {
        throw new EngineError('RAISE_TOO_LARGE', `raise to ${amount} exceeds the ${legal.maxRaiseTo} maximum`);
      }
      if (amount < minRaiseTo && amount !== maxRaiseTo) {
        throw new EngineError('RAISE_TOO_SMALL', `raise to ${amount} is below the ${legal.minRaiseTo} minimum`);
      }
      paid = amount - me.committed;
      target = amount;
      break;
    }

    default:
      throw new EngineError('ILLEGAL_ACTION', `unsupported action ${String((action as PlayerAction).action)}`);
  }

  // Apply the chips.
  if (paid > 0n) {
    if (paid > me.stack) throw new EngineError('INSUFFICIENT_STACK', `seat ${seat} cannot pay ${paid}`);
    me.stack -= paid;
    me.committed += paid;
    me.totalCommitted += paid;
    if (me.stack === 0n) me.allIn = true;
  }

  // Every action other than a fold counts as having acted for this round; a
  // fold is recorded the same way (its chips stay in the pot).
  me.actedThisRound = true;

  const wasAggressive = target !== null && target > state.currentBet;
  if (wasAggressive) {
    const increment = target! - state.currentBet;
    const fullRaise = increment >= state.lastFullRaise;
    if (fullRaise) state.lastFullRaise = increment;
    for (const other of state.seats) {
      if (other.seat === seat || other.agentId === null || other.folded || other.allIn) continue;
      if (fullRaise) {
        other.actedThisRound = false;
        other.canRaise = true;
      } else if (other.actedThisRound) {
        // A short all-in does not reopen the betting for seats that already acted.
        other.actedThisRound = false;
        other.canRaise = false;
      }
    }
    state.currentBet = target!;
    state.lastAggressorSeat = seat;
  } else if (action.action !== 'FOLD') {
    me.canRaise = true;
  }

  state.seq += 1;
  const record: ActionRecord = {
    seq: state.seq,
    handId: state.handId,
    street: state.street,
    seat,
    action: action.action,
    amount: (target ?? paid).toString(),
    origin,
    paid: paid.toString(),
    potAfter: totalPot(state).toString(),
    at: now,
  };
  state.actions.push(record);
  state.pots = buildPots(state.seats);
  state.searchFromSeat = seat;
  events.push({ type: 'ACTION_TAKEN', record });

  return progress(state, events, now);
}

function requireAmount(action: PlayerAction): Chips {
  if (action.amount === undefined) throw new EngineError('INVALID_AMOUNT', `${action.action} requires an amount`);
  if (action.amount < 0n) throw new EngineError('INVALID_AMOUNT', 'amount cannot be negative');
  return action.amount;
}

// ---------------------------------------------------------------------------
// Progression
// ---------------------------------------------------------------------------

function openStreet(state: HandState, events: TableEvent[]): void {
  for (const s of state.seats) {
    s.committed = 0n;
    s.actedThisRound = false;
    s.canRaise = true;
  }
  state.currentBet = 0n;
  state.lastFullRaise = state.config.bigBlind;
  state.lastAggressorSeat = null;
  state.searchFromSeat = state.buttonSeat;

  const next: Street = state.street === 'PREFLOP' ? 'FLOP' : state.street === 'FLOP' ? 'TURN' : 'RIVER';
  state.street = next;
  state.board = boardForStreet(state.deal, next);
  if (next === 'FLOP') state.sawFlop = true;
  const burns = state.config.burnCards ? (next === 'FLOP' ? 1 : next === 'TURN' ? 2 : 3) : 0;
  events.push({ type: 'STREET_ADVANCED', street: next, board: [...state.board], burns });
}

/**
 * Drives the hand forward as far as it can without agent input: opens streets,
 * runs out the board when everyone is all-in, and settles at the end.
 */
function progress(state: HandState, events: TableEvent[], now: number): HandStep {
  state.toActSeat = null;
  state.deadlineTs = null;

  for (let guard = 0; guard < 16; guard++) {
    if (state.complete) break;

    if (contestingSeats(state).length <= 1) {
      settle(state, events, now);
      break;
    }
    if (actionableSeats(state).length === 0) {
      if (state.street === 'RIVER') {
        settle(state, events, now);
        break;
      }
      openStreet(state, events);
      continue;
    }

    const next = findNextActor(state, state.searchFromSeat);
    if (next === null) {
      if (state.street === 'RIVER') {
        settle(state, events, now);
        break;
      }
      openStreet(state, events);
      continue;
    }

    state.toActSeat = next;
    state.deadlineTs = now + state.config.thinkBudgetMs;
    break;
  }

  return { state, events, actionRequest: actionRequestFor(state) };
}

/** The private turn notification for the seat on the clock (FR-3.5, FR-7.x). */
export function actionRequestFor(state: HandState): ActionRequest | null {
  if (state.toActSeat === null) return null;
  const me = seatState(state, state.toActSeat);
  return {
    tableId: state.tableId,
    handId: state.handId,
    seat: state.toActSeat,
    street: state.street,
    legal: legalActions(state, state.toActSeat),
    pot: totalPot(state).toString(),
    board: [...state.board],
    holeCards: [...me.holeCards],
    stack: me.stack.toString(),
    deadlineTs: state.deadlineTs ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

/** Returns an uncalled overbet to the seat that made it (standard rule). */
function refundUncalled(state: HandState): { seat: number; amount: Chips } | null {
  const contributors = state.seats
    .filter((s) => s.agentId !== null && s.totalCommitted > 0n)
    .sort((a, b) => (a.totalCommitted > b.totalCommitted ? -1 : a.totalCommitted < b.totalCommitted ? 1 : 0));
  const top = contributors[0];
  if (!top) return null;
  const second = contributors[1]?.totalCommitted ?? 0n;
  const excess = top.totalCommitted - second;
  if (excess <= 0n) return null;
  top.totalCommitted -= excess;
  top.committed = top.committed > excess ? top.committed - excess : 0n;
  top.stack += excess;
  if (top.stack > 0n) top.allIn = false;
  return { seat: top.seat, amount: excess };
}

/**
 * Splits `amount` between `winners`, sending any indivisible remainder to the
 * first winner clockwise from the button (FR-3.4 odd-chip rule).
 */
export function splitPot(amount: Chips, winners: number[], buttonSeat: number, maxSeats: number): { seat: number; amount: Chips }[] {
  if (winners.length === 0) return [];
  const ordered = [...winners].sort((a, b) => {
    const da = (a - buttonSeat + maxSeats) % maxSeats;
    const db = (b - buttonSeat + maxSeats) % maxSeats;
    return da - db;
  });
  const share = amount / BigInt(ordered.length);
  const remainder = amount - share * BigInt(ordered.length);
  return ordered.map((seat, i) => ({ seat, amount: share + (BigInt(i) < remainder ? 1n : 0n) }));
}

function settle(state: HandState, events: TableEvent[], now: number): void {
  if (state.complete) return;

  refundUncalled(state);
  const pots = buildPots(state.seats);
  const contesting = contestingSeats(state);

  let ranks = new Map<number, HandRank>();
  const reveals: RevealedHand[] = [];

  if (contesting.length > 1) {
    for (const s of contesting) {
      const rank = evaluate7([...s.holeCards, ...state.board]);
      ranks.set(s.seat, rank);
      reveals.push({ seat: s.seat, cards: [...s.holeCards], category: rank.category, description: rank.description });
    }
    events.push({ type: 'SHOWDOWN', reveals });
  } else if (contesting.length === 1) {
    const only = contesting[0]!;
    const rank = state.board.length === 5 ? evaluate7([...only.holeCards, ...state.board]) : null;
    reveals.push({
      seat: only.seat,
      cards: [...only.holeCards],
      category: rank?.category ?? null,
      description: rank?.description ?? null,
    });
  }

  const awards: PotAward[] = [];
  let totalRake = 0n;

  for (const pot of pots) {
    const eligible = pot.eligible.filter((s) => state.seats[s]!.agentId !== null);
    if (eligible.length === 0) continue;

    const rake = computeRake(pot.amount, state.config, state.sawFlop);
    totalRake += rake;
    const distributable = pot.amount - rake;

    let winners: number[];
    if (contesting.length <= 1) {
      winners = eligible.includes(contesting[0]?.seat ?? -1) ? [contesting[0]!.seat] : [eligible[0]!];
    } else {
      let best: HandRank | null = null;
      winners = [];
      for (const seat of eligible) {
        const rank = ranks.get(seat);
        if (!rank) continue;
        if (best === null || compareRanks(rank, best) > 0) {
          best = rank;
          winners = [seat];
        } else if (compareRanks(rank, best) === 0) {
          winners.push(seat);
        }
      }
    }

    const payouts = splitPot(distributable, winners, state.buttonSeat, state.config.maxSeats);
    for (const p of payouts) {
      state.seats[p.seat]!.stack += p.amount;
    }
    const oddChipSeat = distributable % BigInt(Math.max(winners.length, 1)) !== 0n ? (payouts[0]?.seat ?? null) : null;
    const award: PotAward = {
      potIndex: pot.index,
      amount: pot.amount.toString(),
      rake: rake.toString(),
      winners: payouts.map((p) => ({ seat: p.seat, amount: p.amount.toString() })),
      oddChipSeat,
    };
    awards.push(award);
    events.push({ type: 'POT_AWARDED', award });
  }

  state.street = 'COMPLETE';
  state.complete = true;
  state.endedAt = now;
  state.toActSeat = null;
  state.deadlineTs = null;
  state.pots = pots;

  const seatResults = state.seats.map((s) => {
    const net = s.stack - s.startingStack;
    return {
      seat: s.seat,
      agentId: s.agentId,
      startingStack: s.startingStack.toString(),
      endingStack: s.stack.toString(),
      net: net.toString(),
      holeCards: s.agentId === null ? null : [...s.holeCards],
      folded: s.folded,
      allIn: s.allIn,
    };
  });

  const settledSum = seatResults.reduce((acc, r) => acc + BigInt(r.net), 0n);

  const result: HandResult = {
    handId: state.handId,
    tableId: state.tableId,
    handNumber: state.handNumber,
    mode: state.config.mode,
    streetReached: highestStreet(state),
    board: [...state.board],
    startedAt: state.startedAt,
    endedAt: now,
    buttonSeat: state.buttonSeat,
    dealingOrder: [...state.dealingOrder],
    burns: [...state.burnCards],
    seats: seatResults,
    actions: state.actions.map((a) => ({ ...a })),
    pots: awards,
    totalPot: pots.reduce((acc, p) => acc + p.amount, 0n).toString(),
    totalRake: totalRake.toString(),
    showdown: reveals,
    zeroSumVerified: settledSum + totalRake === 0n,
  };
  state.result = result;
  events.push({ type: 'HAND_COMPLETE', result });
}

function highestStreet(state: HandState): Street {
  if (state.board.length === 5) return 'RIVER';
  if (state.board.length === 4) return 'TURN';
  if (state.board.length === 3) return 'FLOP';
  return 'PREFLOP';
}

// ---------------------------------------------------------------------------
// Cloning & replay
// ---------------------------------------------------------------------------

function cloneState(s: HandState): HandState {
  return {
    ...s,
    seats: s.seats.map((x) => ({ ...x, holeCards: [...x.holeCards] })),
    deck: [...s.deck],
    board: [...s.board],
    burnCards: [...s.burnCards],
    dealingOrder: [...s.dealingOrder],
    pots: s.pots.map((p) => ({ ...p, eligible: [...p.eligible] })),
    actions: s.actions.map((a) => ({ ...a })),
    deal: { ...s.deal, holes: new Map(s.deal.holes), board: [...s.deal.board], burns: [...s.deal.burns] },
  };
}

/**
 * Re-runs a recorded hand from its history and returns the recomputed result.
 * Deterministic by construction, so this is the engine's own regression test and
 * the tool the CLI verifier uses to prove a published hand history is the hand
 * that was actually played (NFR-4, NFR-5).
 */
export function replayHand(params: { result: HandResult; deck: readonly Card[]; config: TableConfig }): HandResult {
  const { result, deck, config } = params;
  const players = result.seats
    .filter((s) => s.agentId !== null)
    .map((s) => ({ seat: s.seat, agentId: s.agentId!, agentName: '', stack: BigInt(s.startingStack) }));

  let step = createHand({
    handId: result.handId,
    tableId: result.tableId,
    handNumber: result.handNumber,
    config,
    buttonSeat: result.buttonSeat,
    players,
    deck,
    now: result.startedAt,
  });

  for (const a of result.actions) {
    step = applyAction(
      step.state,
      a.seat,
      { action: a.action, amount: BigInt(a.amount) },
      result.startedAt + a.seq,
      a.origin,
    );
  }

  if (!step.state.result) throw new EngineError('ILLEGAL_STATE', 'replay did not reach settlement');
  return step.state.result;
}
