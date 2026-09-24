/**
 * The canonical dealing procedure.
 *
 * `shuffleDeck` produces a 52-card ordering; **this file defines which index
 * goes where**, so a verifier can go from the public deck ordering all the way
 * to "the cards this seat was dealt" without trusting the engine.
 *
 * Procedure:
 *  1. one card to each seat in `dealingOrder`, twice (the order starts at the
 *     small blind and runs clockwise; heads-up that means the button first),
 *  2. if `burnCards` (default, standard poker): burn 1, flop 3, burn 1, turn 1,
 *     burn 1, river 1,
 *  3. otherwise: flop 3, turn 1, river 1 with no burns.
 */

import type { Card } from './cards.js';
import { assertCompleteDeck, CARDS_PER_HAND, DECK_SIZE } from './cards.js';
import type { Street } from './types.js';

export interface DealOptions {
  /** Burn a card before flop/turn/river. Default `true`. */
  burnCards: boolean;
}

export interface DealResult {
  /** Hole cards by seat. */
  holes: Map<number, Card[]>;
  /** Seats in dealing order (starting at the small blind). */
  dealingOrder: number[];
  /** Cards burnt (empty when `burnCards` is false). */
  burns: Card[];
  flop: Card[];
  turn: Card[];
  river: Card[];
  /** flop ‖ turn ‖ river */
  board: Card[];
  /** Index into `deck` just past the last consumed card. */
  nextIndex: number;
}

export function dealHoldem(
  deck: readonly Card[],
  dealingOrder: readonly number[],
  options: DealOptions = { burnCards: true },
): DealResult {
  assertCompleteDeck(deck);
  if (dealingOrder.length < 2) throw new Error('need at least 2 seats to deal a hand');

  let i = 0;
  const take = (): Card => {
    const card = deck[i];
    if (card === undefined) throw new Error('deck exhausted while dealing');
    i += 1;
    return card;
  };

  const holes = new Map<number, Card[]>();
  for (const seat of dealingOrder) holes.set(seat, []);
  for (let round = 0; round < CARDS_PER_HAND; round++) {
    for (const seat of dealingOrder) {
      holes.get(seat)!.push(take());
    }
  }

  const burns: Card[] = [];
  const burn = (): void => {
    if (options.burnCards) burns.push(take());
  };

  burn();
  const flop = [take(), take(), take()];
  burn();
  const turn = [take()];
  burn();
  const river = [take()];

  return {
    holes,
    dealingOrder: [...dealingOrder],
    burns,
    flop,
    turn,
    river,
    board: [...flop, ...turn, ...river],
    nextIndex: i,
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
  // sanity: seats are 0..maxSeats-1
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
