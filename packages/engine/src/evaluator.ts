/**
 * Texas Hold'em hand evaluator for 5, 6 and 7 cards.
 *
 * The evaluator is pure and dependency-free: it only knows about `Card`
 * integers (`card = rank * 4 + suit`, rank `0..12` = `2 3 4 5 6 7 8 9 T J Q K A`)
 * from `@llmpoker/shared`. Given the same cards it always returns the same
 * `HandRank`, so showdowns and hand replays are deterministic (NFR-5).
 *
 * ## Score encoding
 *
 * `score` is a plain integer (a safe integer, `< 2^53`):
 *
 * ```text
 * score = categoryIndex * 16^5 + r0*16^4 + r1*16^3 + r2*16^2 + r3*16 + r4
 * ```
 *
 * where `categoryIndex` is the index of the hand's category in
 * {@link CATEGORY_ORDER} (`HIGH_CARD` = 0 … `ROYAL_FLUSH` = 9) and each `ri`
 * is a rank value `0..12`. Unused trailing slots are `0`. Higher is better and
 * equal scores are an exact tie (chop), because the category and the complete
 * ordered rank pattern are both folded into the number.
 *
 * The rank patterns (`ranks`) are:
 *
 * | category | `ranks` |
 * |---|---|
 * | high card / flush / straight | the five ranks, descending |
 * | pair | `[pairRank, k1, k2, k3, 0]` |
 * | two pair | `[hiPair, loPair, kicker, 0, 0]` |
 * | trips | `[tripRank, k1, k2, 0, 0]` |
 * | full house | `[tripRank, pairRank, 0, 0, 0]` |
 * | quads | `[quadRank, kicker, 0, 0, 0]` |
 *
 * Straights use `[high, high-1, high-2, high-3, high-4]`, except the **wheel**
 * (`A 2 3 4 5`), where the ace plays low. There is no rank below the deuce in
 * the `0..12` encoding, so the wheel's pattern is `[3, 2, 1, 0, 0]` — the
 * fifth slot is the documented low-ace sentinel `0`, *not* `12`. Consequently
 * the wheel is the weakest straight and loses to a six-high straight.
 *
 * ## Descriptions
 *
 * `description` is display text: `'Ace-high'`, `'Pair of Kings'`,
 * `'Aces and Kings'`, `'Three Queens'`, `'Wheel straight'`,
 * `'King-high flush'`, `'Aces full of Kings'`, `'Four Jacks'`,
 * `'Steel wheel straight flush'`, `'Royal flush'`, …
 */

import type { Card, HandCategory } from '@llmpoker/shared';
import { cardRank, cardSuit, cardToString, isCard } from '@llmpoker/shared';

export interface HandRank {
  category: HandCategory;
  /** Higher is better; equal score means an exact tie (chop). */
  score: number;
  /** Exactly 5 cards, most significant first. */
  best: Card[];
  /** The ordered rank pattern (0..12) that produced the score, padded with 0. */
  ranks: number[];
  /** Human readable, e.g. `'Aces full of Kings'`, `'King-high flush'`. */
  description: string;
}

/** Category strength order, weakest first (index = the category's strength). */
export const CATEGORY_ORDER: readonly HandCategory[] = [
  'HIGH_CARD',
  'PAIR',
  'TWO_PAIR',
  'TRIPS',
  'STRAIGHT',
  'FLUSH',
  'FULL_HOUSE',
  'QUADS',
  'STRAIGHT_FLUSH',
  'ROYAL_FLUSH',
];

/** `16^5`: the stride between two categories. */
const CATEGORY_SCORE_STRIDE = 16 ** 5;
/** `[16^4, 16^3, 16^2, 16, 1]`: the per-slot strides inside a category. */
const RANK_SCORE_STRIDES = [16 ** 4, 16 ** 3, 16 ** 2, 16, 1] as const;

const CATEGORY_INDEX: ReadonlyMap<HandCategory, number> = new Map(
  CATEGORY_ORDER.map((category, index) => [category, index] as const),
);

/** Five rank values `0..12`, most significant first. */
type RankPattern = [number, number, number, number, number];
/** Indexes of the five cards of one 5-of-n subset. */
type Combo5 = readonly [number, number, number, number, number];

/** The rank pattern + cards of a hand, before the score is folded in. */
interface RankedFive {
  readonly category: HandCategory;
  readonly ranks: RankPattern;
  readonly best: Card[];
  readonly description: string;
}

const RANK_NAMES = [
  'Deuce',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Jack',
  'Queen',
  'King',
  'Ace',
] as const;

const RANK_PLURALS = [
  'Twos',
  'Threes',
  'Fours',
  'Fives',
  'Sixes',
  'Sevens',
  'Eights',
  'Nines',
  'Tens',
  'Jacks',
  'Queens',
  'Kings',
  'Aces',
] as const;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Best 5-card hand from exactly 5 cards. Throws on wrong input length / duplicate cards / out-of-range cards. */
export function evaluate5(cards: readonly Card[]): HandRank {
  if (cards.length !== 5) {
    throw new Error(`evaluate5 expects exactly 5 cards, got ${cards.length}`);
  }
  assertDistinctCards(cards);
  return makeHand(rankFive(cards));
}

/** Best 5-card hand from exactly 7 cards. */
export function evaluate7(cards: readonly Card[]): HandRank {
  if (cards.length !== 7) {
    throw new Error(`evaluate7 expects exactly 7 cards, got ${cards.length}`);
  }
  assertDistinctCards(cards);
  return evaluateBest(cards);
}

/** Best 5-card hand from 5, 6 or 7 cards. */
export function evaluate(cards: readonly Card[]): HandRank {
  if (cards.length !== 5 && cards.length !== 6 && cards.length !== 7) {
    throw new Error(`evaluate expects 5, 6 or 7 cards, got ${cards.length}`);
  }
  assertDistinctCards(cards);
  return evaluateBest(cards);
}

/** > 0 when a beats b, < 0 when b beats a, 0 for an exact tie. */
export function compareRanks(a: HandRank, b: HandRank): number {
  if (a.score === b.score) return 0;
  return a.score > b.score ? 1 : -1;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function assertDistinctCards(cards: readonly Card[]): void {
  const seen = new Uint8Array(52);
  for (const card of cards) {
    if (!isCard(card)) throw new RangeError(`card out of range: ${String(card)}`);
    if (seen[card] === 1) throw new Error(`duplicate card: ${cardToString(card)}`);
    seen[card] = 1;
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function categoryIndex(category: HandCategory): number {
  const index = CATEGORY_INDEX.get(category);
  if (index === undefined) throw new Error(`unknown hand category: ${category}`);
  return index;
}

function encodeScore(index: number, ranks: RankPattern): number {
  const [s0, s1, s2, s3, s4] = RANK_SCORE_STRIDES;
  return (
    index * CATEGORY_SCORE_STRIDE +
    ranks[0] * s0 +
    ranks[1] * s1 +
    ranks[2] * s2 +
    ranks[3] * s3 +
    ranks[4] * s4
  );
}

function scoreOf(ranked: RankedFive): number {
  return encodeScore(categoryIndex(ranked.category), ranked.ranks);
}

function makeHand(ranked: RankedFive): HandRank {
  return {
    category: ranked.category,
    score: scoreOf(ranked),
    best: ranked.best,
    ranks: ranked.ranks,
    description: ranked.description,
  };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function rankName(rank: number): string {
  const name = RANK_NAMES[rank];
  if (name === undefined) throw new RangeError(`rank out of range: ${rank}`);
  return name;
}

function rankPlural(rank: number): string {
  const name = RANK_PLURALS[rank];
  if (name === undefined) throw new RangeError(`rank out of range: ${rank}`);
  return name;
}

function requireAt<T>(values: readonly T[], index: number, what: string): T {
  const value = values[index];
  if (value === undefined) throw new Error(`internal error: missing ${what}`);
  return value;
}

/** Highest card first; ties broken by suit (card id) so the result is stable. */
function byRankDesc(a: Card, b: Card): number {
  const byRank = cardRank(b) - cardRank(a);
  return byRank !== 0 ? byRank : a - b;
}

function cardsOfRank(cards: readonly Card[], rank: number): Card[] {
  return cards.filter((card) => cardRank(card) === rank).sort((a, b) => a - b);
}

/** `[3, 2, 1, 0, 0]` for the wheel (ace low), `[high … high-4]` otherwise. */
function straightPattern(high: number): RankPattern {
  if (high === 3) return [3, 2, 1, 0, 0];
  return [high, high - 1, high - 2, high - 3, high - 4];
}

/** The five straight cards, most significant first (wheel: `5 4 3 2 A`). */
function straightCards(cards: readonly Card[], high: number): Card[] {
  if (high !== 3) return [...cards].sort(byRankDesc);
  // Wheel: the ace plays low, so it is the least significant card.
  return [3, 2, 1, 0, 12].map((rank) => {
    const card = cards.find((candidate) => cardRank(candidate) === rank);
    if (card === undefined) throw new Error('internal error: incomplete straight');
    return card;
  });
}

function distinctDescendingRanks(cards: readonly Card[]): number[] {
  return [...new Set(cards.map((card) => cardRank(card)))].sort((a, b) => b - a);
}

/** `null` when the distinct ranks are not a straight, else the straight's high rank (wheel → `3`). */
function straightHighOf(descRanks: readonly number[]): number | null {
  if (descRanks.length !== 5) return null;
  const high = requireAt(descRanks, 0, 'straight high card');
  const low = requireAt(descRanks, 4, 'straight low card');
  if (high - low === 4) return high;
  // Wheel: A 5 4 3 2. The ace plays low, so the high card of the straight is the five.
  if (high === 12 && requireAt(descRanks, 1, 'wheel') === 3 && requireAt(descRanks, 2, 'wheel') === 2) {
    return 3;
  }
  return null;
}

function straightDescription(high: number): string {
  return high === 3 ? 'Wheel straight' : `${rankName(high)}-high straight`;
}

function straightFlushDescription(high: number): string {
  if (high === 12) return 'Royal flush';
  return high === 3 ? 'Steel wheel straight flush' : `${rankName(high)}-high straight flush`;
}

/** Descending ranks that are not part of `used` — the kickers, most significant first. */
function kickersOf(descRanks: readonly number[], used: readonly number[]): number[] {
  return descRanks.filter((rank) => !used.includes(rank));
}

function toPattern(values: readonly number[]): RankPattern {
  return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 0, values[4] ?? 0];
}

// ---------------------------------------------------------------------------
// 5-card ranking
// ---------------------------------------------------------------------------

/**
 * Ranks exactly five distinct, in-range cards. Category and rank pattern are
 * decided by explicit counts: category order is straight flush > quads >
 * full house > flush > straight > trips > two pair > pair > high card.
 */
function rankFive(cards: readonly Card[]): RankedFive {
  const rankCounts = new Array<number>(13).fill(0);
  const suitCounts = new Array<number>(4).fill(0);
  for (const card of cards) {
    const rank = cardRank(card);
    rankCounts[rank] = (rankCounts[rank] ?? 0) + 1;
    const suit = cardSuit(card);
    suitCounts[suit] = (suitCounts[suit] ?? 0) + 1;
  }

  const descRanks = distinctDescendingRanks(cards);
  const isFlush = suitCounts.some((count) => count === 5);
  const straightHigh = straightHighOf(descRanks);

  const countOf = (rank: number): number => rankCounts[rank] ?? 0;
  const quadsRank = descRanks.find((rank) => countOf(rank) === 4);
  const tripsRank = descRanks.find((rank) => countOf(rank) === 3);
  const pairRanks = descRanks.filter((rank) => countOf(rank) === 2);

  if (isFlush && straightHigh !== null) {
    return {
      category: straightHigh === 12 ? 'ROYAL_FLUSH' : 'STRAIGHT_FLUSH',
      ranks: straightPattern(straightHigh),
      best: straightCards(cards, straightHigh),
      description: straightFlushDescription(straightHigh),
    };
  }

  if (quadsRank !== undefined) {
    const kicker = kickersOf(descRanks, [quadsRank])[0] ?? 0;
    return {
      category: 'QUADS',
      ranks: [quadsRank, kicker, 0, 0, 0],
      best: [...cardsOfRank(cards, quadsRank), ...cardsOfRank(cards, kicker)],
      description: `Four ${rankPlural(quadsRank)}`,
    };
  }

  if (tripsRank !== undefined && pairRanks.length > 0) {
    const pairRank = requireAt(pairRanks, 0, 'full house pair');
    return {
      category: 'FULL_HOUSE',
      ranks: [tripsRank, pairRank, 0, 0, 0],
      best: [...cardsOfRank(cards, tripsRank), ...cardsOfRank(cards, pairRank)],
      description: `${rankPlural(tripsRank)} full of ${rankPlural(pairRank)}`,
    };
  }

  if (isFlush) {
    const high = requireAt(descRanks, 0, 'flush high card');
    return {
      category: 'FLUSH',
      ranks: toPattern(descRanks),
      best: [...cards].sort(byRankDesc),
      description: `${rankName(high)}-high flush`,
    };
  }

  if (straightHigh !== null) {
    return {
      category: 'STRAIGHT',
      ranks: straightPattern(straightHigh),
      best: straightCards(cards, straightHigh),
      description: straightDescription(straightHigh),
    };
  }

  if (tripsRank !== undefined) {
    const kickers = kickersOf(descRanks, [tripsRank]);
    return {
      category: 'TRIPS',
      ranks: toPattern([tripsRank, ...kickers]),
      best: [...cardsOfRank(cards, tripsRank), ...kickers.flatMap((rank) => cardsOfRank(cards, rank))],
      description: `Three ${rankPlural(tripsRank)}`,
    };
  }

  if (pairRanks.length === 2) {
    const hiPair = requireAt(pairRanks, 0, 'high pair');
    const loPair = requireAt(pairRanks, 1, 'low pair');
    const kicker = requireAt(kickersOf(descRanks, [hiPair, loPair]), 0, 'two pair kicker');
    return {
      category: 'TWO_PAIR',
      ranks: [hiPair, loPair, kicker, 0, 0],
      best: [
        ...cardsOfRank(cards, hiPair),
        ...cardsOfRank(cards, loPair),
        ...cardsOfRank(cards, kicker),
      ],
      description: `${rankPlural(hiPair)} and ${rankPlural(loPair)}`,
    };
  }

  if (pairRanks.length === 1) {
    const pairRank = requireAt(pairRanks, 0, 'pair rank');
    const kickers = kickersOf(descRanks, [pairRank]);
    return {
      category: 'PAIR',
      ranks: toPattern([pairRank, ...kickers]),
      best: [...cardsOfRank(cards, pairRank), ...kickers.flatMap((rank) => cardsOfRank(cards, rank))],
      description: `Pair of ${rankPlural(pairRank)}`,
    };
  }

  const high = requireAt(descRanks, 0, 'high card');
  return {
    category: 'HIGH_CARD',
    ranks: toPattern(descRanks),
    best: [...cards].sort(byRankDesc),
    description: `${rankName(high)}-high`,
  };
}

// ---------------------------------------------------------------------------
// 5-of-n search (6 or 7 cards)
// ---------------------------------------------------------------------------

function combosOf(n: number): Combo5[] {
  const combos: Combo5[] = [];
  for (let a = 0; a + 4 < n; a++) {
    for (let b = a + 1; b + 3 < n; b++) {
      for (let c = b + 1; c + 2 < n; c++) {
        for (let d = c + 1; d + 1 < n; d++) {
          for (let e = d + 1; e < n; e++) {
            combos.push([a, b, c, d, e]);
          }
        }
      }
    }
  }
  return combos;
}

const COMBOS_OF_6: readonly Combo5[] = combosOf(6);
const COMBOS_OF_7: readonly Combo5[] = combosOf(7);

/**
 * Best 5-card hand from 5, 6 or 7 cards.
 *
 * Correctness over cleverness: for 6 or 7 cards every `C(n, 5)` five-card
 * subset is ranked with the exact same `rankFive` used by {@link evaluate5},
 * and the highest score wins (the first one wins a tie, which is fine: tied
 * scores are exact chops and the caller only compares scores).
 */
function evaluateBest(cards: readonly Card[]): HandRank {
  if (cards.length === 5) return makeHand(rankFive(cards));

  const combos = cards.length === 6 ? COMBOS_OF_6 : COMBOS_OF_7;
  const hand: Card[] = new Array<Card>(5).fill(0);
  let bestRanked: RankedFive | null = null;
  let bestScore = -1;

  for (const combo of combos) {
    for (let slot = 0; slot < 5; slot++) {
      hand[slot] = requireAt(cards, requireAt(combo, slot, 'subset slot'), 'card');
    }
    const ranked = rankFive(hand);
    const score = scoreOf(ranked);
    if (score > bestScore) {
      bestScore = score;
      bestRanked = ranked;
    }
  }

  if (bestRanked === null) throw new Error('internal error: no 5-card subset found');
  return makeHand(bestRanked);
}
