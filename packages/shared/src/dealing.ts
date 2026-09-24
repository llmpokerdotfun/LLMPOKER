/**
 * The canonical dealing procedure.
 *
 * `shuffleDeck` produces a 52-card ordering; **this file defines which index
 * goes where**, so a verifier can go from the public commitment all the way to
 * "the cards this seat was dealt" without trusting the engine.
 *
 * Procedure:
 *  1. one card to each seat in `dealingOrder`, twice (the order starts at the
 *     small blind and runs clockwise; heads-up that means the button first),
 *  2. if `burnCards` (default, standard poker): burn 1, flop 3, burn 1, turn 1,
 *     burn 1, river 1,
 *  3. otherwise: flop 3, turn 1, river 1 with no burns.
 *
 * {@link dealIndexMap} computes the index assignment on its own and
 * {@link dealHoldem} is implemented in terms of it, so the mapping used by the
 * FR-6.3 per-card reveals can never drift from the mapping used to deal.
 */

import type { Card } from './cards.js';
import { assertCompleteDeck, CARDS_PER_HAND, DECK_SIZE } from './cards.js';
import type { Street } from './types.js';

export interface DealOptions {
  /** Burn a card before flop/turn/river. Default `true`. */
  burnCards: boolean;
}

/** Which deck position feeds which hole card, board slot and burn. */
export interface DealIndexMap {
  /** Hole-card deck positions by seat, in the order the seat receives them. */
  holes: Map<number, number[]>;
  /** Deck positions of the flop, turn and river, in that order. */
  board: number[];
  /** Deck positions of the burn cards (empty when `burnCards` is false). */
  burns: number[];
}

/**
 * Index assignment for a hand. Pure index arithmetic — no deck required — which
 * is what lets a verifier check a live hand's per-card reveals without knowing
 * any hidden card.
 */
export function dealIndexMap(dealingOrder: readonly number[], options: DealOptions = { burnCards: true }): DealIndexMap {
  if (dealingOrder.length < 2) throw new Error('need at least 2 seats to deal a hand');
  const holes = new Map<number, number[]>();
  let cursor = 0;

  for (const seat of dealingOrder) holes.set(seat, []);
  for (let round = 0; round < CARDS_PER_HAND; round++) {
    for (const seat of dealingOrder) holes.get(seat)!.push(cursor++);
  }

  const burns: number[] = [];
  const burn = (): void => {
    if (options.burnCards) burns.push(cursor++);
  };

  burn();
  const flop = [cursor++, cursor++, cursor++];
  burn();
  const turn = [cursor++];
  burn();
  const river = [cursor++];

  const highest = Math.max(...flop, ...turn, ...river, ...(burns.length > 0 ? burns : [0]));
  if (highest >= DECK_SIZE) throw new Error('dealing order needs more than 52 cards');
  return { holes, board: [...flop, ...turn, ...river], burns };
}

export interface DealResult {
  /** Hole cards by seat. */
  holes: Map<number, Card[]>;
  /** Deck positions of each seat's hole cards. */
  holeIndices: Map<number, number[]>;
  /** Seats in dealing order (starting at the small blind). */
  dealingOrder: number[];
  /** Cards burnt (empty when `burnCards` is false). */
  burns: Card[];
  /** Deck positions of the burns. */
  burnIndices: number[];
  flop: Card[];
  turn: Card[];
  river: Card[];
  /** flop ‖ turn ‖ river */
  board: Card[];
  /** Deck positions of the board cards. */
  boardIndices: number[];
  /** Index into `deck` just past the last consumed card. */
  nextIndex: number;
}

export function dealHoldem(
  deck: readonly Card[],
  dealingOrder: readonly number[],
  options: DealOptions = { burnCards: true },
): DealResult {
  assertCompleteDeck(deck);
  const map = dealIndexMap(dealingOrder, options);
  const take = (index: number): Card => {
    const card = deck[index];
    if (card === undefined) throw new Error(`deck exhausted at index ${index}`);
    return card;
  };

  const holes = new Map<number, Card[]>();
  for (const [seat, indices] of map.holes) holes.set(seat, indices.map(take));

  const flop = map.board.slice(0, 3).map(take);
  const turn = [take(map.board[3]!)];
  const river = [take(map.board[4]!)];

  return {
    holes,
    holeIndices: map.holes,
    dealingOrder: [...dealingOrder],
    burns: map.burns.map(take),
    burnIndices: map.burns,
    flop,
    turn,
    river,
    board: map.board.map(take),
    boardIndices: map.board,
    nextIndex: Math.max(...map.board) + 1,
  };
}

/**
 * Seats get cards starting at the small blind and running clockwise.
 * For heads-up the button *is* the small blind (FR-3.1 standard rules).
 */
export function dealingOrderFor(
  seatsInHand: readonly number[],
  smallBlindSeat: number,
  maxSeats: number,
): number[] {
  const start = seatsInHand.indexOf(smallBlindSeat);
  if (start < 0) throw new Error('small blind seat is not in the hand');
  const order: number[] = [];
  for (let k = 0; k < seatsInHand.length; k++) {
    order.push(seatsInHand[(start + k) % seatsInHand.length]!);
  }
  for (const s of order) {
    if (s < 0 || s >= maxSeats) throw new Error(`seat ${s} out of range 0..${maxSeats - 1}`);
  }
  return order;
}

/** Cards that are public on `street`. */
export function boardForStreet(deal: DealResult, street: Street): Card[] {
  switch (street) {
    case 'PREFLOP':
      return [];
    case 'FLOP':
      return [...deal.flop];
    case 'TURN':
      return [...deal.flop, ...deal.turn];
    case 'RIVER':
    case 'SHOWDOWN':
    case 'COMPLETE':
      return [...deal.board];
    default:
      return [];
  }
}

export const TOTAL_DEALT_WITH_BURNS = DECK_SIZE - (CARDS_PER_HAND * 2 + 3 + 1 + 1 + 3);
