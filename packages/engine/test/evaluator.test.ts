import { describe, expect, it } from 'vitest';
import type { Card, HandCategory } from '@llmpoker/shared';
import { DECK_SIZE, cardsToString, stringToCard } from '@llmpoker/shared';
import { CATEGORY_ORDER, compareRanks, evaluate, evaluate5, evaluate7 } from '../src/evaluator.js';
import type { HandRank } from '../src/evaluator.js';

/** `hand('As', 'Kd', ...)` → cards, for readability. */
const hand = (...specs: string[]): Card[] => specs.map(stringToCard);

const RANK_STRIDES = [16 ** 4, 16 ** 3, 16 ** 2, 16, 1] as const;

function expectedScore(category: HandCategory, ranks: readonly number[]): number {
  const [s0, s1, s2, s3, s4] = RANK_STRIDES;
  const index = CATEGORY_ORDER.indexOf(category);
  return (
    index * 16 ** 5 +
    (ranks[0] ?? 0) * s0 +
    (ranks[1] ?? 0) * s1 +
    (ranks[2] ?? 0) * s2 +
    (ranks[3] ?? 0) * s3 +
    (ranks[4] ?? 0) * s4
  );
}

function expectSubsetOf(best: readonly Card[], pool: readonly Card[]): void {
  expect(best).toHaveLength(5);
  expect(new Set(best).size).toBe(5);
  for (const card of best) expect(pool).toContain(card);
}

// ---------------------------------------------------------------------------
// Deterministic pseudo-random deals (xorshift32 + partial Fisher–Yates)
// ---------------------------------------------------------------------------

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

function deal(rand: () => number, count: number): Card[] {
  const deck = Array.from({ length: DECK_SIZE }, (_, index) => index);
  for (let i = 0; i < count; i++) {
    const j = i + (rand() % (DECK_SIZE - i));
    const tmp = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = tmp;
  }
  return deck.slice(0, count);
}

/** Independent reference: the max score over all 5-card subsets. */
function bestSubset5(cards: readonly Card[]): { score: number; category: HandCategory } {
  const n = cards.length;
  let bestScore = -1;
  let bestCategory: HandCategory = 'HIGH_CARD';
  for (let a = 0; a + 4 < n; a++) {
    for (let b = a + 1; b + 3 < n; b++) {
      for (let c = b + 1; c + 2 < n; c++) {
        for (let d = c + 1; d + 1 < n; d++) {
          for (let e = d + 1; e < n; e++) {
            const ranked = evaluate5([cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!]);
            if (ranked.score > bestScore) {
              bestScore = ranked.score;
              bestCategory = ranked.category;
            }
          }
        }
      }
    }
  }
  return { score: bestScore, category: bestCategory };
}

// ---------------------------------------------------------------------------
// 1. Every category, twice, with exact category / description / ranks / score
// ---------------------------------------------------------------------------

interface CategoryCase {
  name: string;
  cards: string[];
  category: HandCategory;
  description: string;
  ranks: number[];
}

const CATEGORY_CASES: CategoryCase[] = [
  {
    name: 'high card: ace-high',
    cards: ['As', 'Kd', '9h', '5c', '3s'],
    category: 'HIGH_CARD',
    description: 'Ace-high',
    ranks: [12, 11, 7, 3, 1],
  },
  {
    name: 'high card: queen-high',
    cards: ['Qh', 'Jd', '8s', '6c', '2h'],
    category: 'HIGH_CARD',
    description: 'Queen-high',
    ranks: [10, 9, 6, 4, 0],
  },
  {
    name: 'pair: aces',
    cards: ['As', 'Ad', '9h', '5c', '3s'],
    category: 'PAIR',
    description: 'Pair of Aces',
    ranks: [12, 7, 3, 1, 0],
  },
  {
    name: 'pair: sevens',
    cards: ['7h', '7d', 'Ks', '4c', '2h'],
    category: 'PAIR',
    description: 'Pair of Sevens',
    ranks: [5, 11, 2, 0, 0],
  },
  {
    name: 'two pair: aces and kings',
    cards: ['As', 'Ad', 'Kh', 'Kc', '3s'],
    category: 'TWO_PAIR',
    description: 'Aces and Kings',
    ranks: [12, 11, 1, 0, 0],
  },
  {
    name: 'two pair: nines and fours',
    cards: ['9h', '9d', '4s', '4c', 'Ah'],
    category: 'TWO_PAIR',
    description: 'Nines and Fours',
    ranks: [7, 2, 12, 0, 0],
  },
  {
    name: 'trips: queens',
    cards: ['Qs', 'Qd', 'Qh', '7c', '2s'],
    category: 'TRIPS',
    description: 'Three Queens',
    ranks: [10, 5, 0, 0, 0],
  },
  {
    name: 'trips: threes',
    cards: ['3h', '3d', '3s', 'Ac', 'Kh'],
    category: 'TRIPS',
    description: 'Three Threes',
    ranks: [1, 12, 11, 0, 0],
  },
  {
    name: 'straight: nine-high',
    cards: ['9s', '8d', '7h', '6c', '5s'],
    category: 'STRAIGHT',
    description: 'Nine-high straight',
    ranks: [7, 6, 5, 4, 3],
  },
  {
    name: 'straight: ace-high (broadway)',
    cards: ['Ah', 'Kd', 'Qh', 'Jc', 'Ts'],
    category: 'STRAIGHT',
    description: 'Ace-high straight',
    ranks: [12, 11, 10, 9, 8],
  },
  {
    name: 'flush: ace-high',
    cards: ['Ah', 'Kh', '9h', '5h', '3h'],
    category: 'FLUSH',
    description: 'Ace-high flush',
    ranks: [12, 11, 7, 3, 1],
  },
  {
    name: 'flush: king-high',
    cards: ['Kd', 'Jd', '9d', '7d', '4d'],
    category: 'FLUSH',
    description: 'King-high flush',
    ranks: [11, 9, 7, 5, 2],
  },
  {
    name: 'full house: aces full of kings',
    cards: ['As', 'Ad', 'Ah', 'Kc', 'Kd'],
    category: 'FULL_HOUSE',
    description: 'Aces full of Kings',
    ranks: [12, 11, 0, 0, 0],
  },
  {
    name: 'full house: eights full of threes',
    cards: ['8h', '8d', '8s', '3c', '3d'],
    category: 'FULL_HOUSE',
    description: 'Eights full of Threes',
    ranks: [6, 1, 0, 0, 0],
  },
  {
    name: 'quads: jacks',
    cards: ['Js', 'Jd', 'Jh', 'Jc', '2s'],
    category: 'QUADS',
    description: 'Four Jacks',
    ranks: [9, 0, 0, 0, 0],
  },
  {
    name: 'quads: fours',
    cards: ['4h', '4d', '4s', '4c', 'Ad'],
    category: 'QUADS',
    description: 'Four Fours',
    ranks: [2, 12, 0, 0, 0],
  },
  {
    name: 'straight flush: nine-high',
    cards: ['9h', '8h', '7h', '6h', '5h'],
    category: 'STRAIGHT_FLUSH',
    description: 'Nine-high straight flush',
    ranks: [7, 6, 5, 4, 3],
  },
  {
    name: 'straight flush: steel wheel',
    cards: ['As', '2s', '3s', '4s', '5s'],
    category: 'STRAIGHT_FLUSH',
    description: 'Steel wheel straight flush',
    ranks: [3, 2, 1, 0, 0],
  },
  {
    name: 'royal flush: spades',
    cards: ['As', 'Ks', 'Qs', 'Js', 'Ts'],
    category: 'ROYAL_FLUSH',
    description: 'Royal flush',
    ranks: [12, 11, 10, 9, 8],
  },
  {
    name: 'royal flush: hearts, unsorted input',
    cards: ['Th', 'Jh', 'Qh', 'Kh', 'Ah'],
    category: 'ROYAL_FLUSH',
    description: 'Royal flush',
    ranks: [12, 11, 10, 9, 8],
  },
];

describe('evaluate5 — the ten categories', () => {
  it.each(CATEGORY_CASES)('$name', ({ cards, category, description, ranks }) => {
    const cardsIn = hand(...cards);
    const rank = evaluate5(cardsIn);
    expect(rank.category).toBe(category);
    expect(rank.description).toBe(description);
    expect(rank.ranks).toEqual(ranks);
    expect(rank.score).toBe(expectedScore(category, ranks));
    expect(rank.best).toHaveLength(5);
    expect([...rank.best].sort((a, b) => a - b)).toEqual([...cardsIn].sort((a, b) => a - b));
  });

  it('covers every category in CATEGORY_ORDER at least twice', () => {
    for (const category of CATEGORY_ORDER) {
      const count = CATEGORY_CASES.filter((testCase) => testCase.category === category).length;
      expect(count, `cases for ${category}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('CATEGORY_ORDER is weakest-first', () => {
    expect(CATEGORY_ORDER).toEqual([
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
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Ordering across categories
// ---------------------------------------------------------------------------

const REPRESENTATIVES: { category: HandCategory; cards: Card[] }[] = [
  { category: 'HIGH_CARD', cards: hand('Ah', 'Kd', '9h', '5c', '3s') },
  { category: 'PAIR', cards: hand('2s', '2d', '7h', '5c', '3s') },
  { category: 'TWO_PAIR', cards: hand('2s', '2d', '3h', '3c', '5s') },
  { category: 'TRIPS', cards: hand('2s', '2d', '2h', '5c', '3s') },
  { category: 'STRAIGHT', cards: hand('6s', '5d', '4h', '3c', '2s') },
  { category: 'FLUSH', cards: hand('2h', '5h', '7h', '9h', 'Jh') },
  { category: 'FULL_HOUSE', cards: hand('2s', '2d', '2h', '3c', '3s') },
  { category: 'QUADS', cards: hand('2s', '2d', '2h', '2c', '3s') },
  { category: 'STRAIGHT_FLUSH', cards: hand('6s', '5s', '4s', '3s', '2s') },
  { category: 'ROYAL_FLUSH', cards: hand('As', 'Ks', 'Qs', 'Js', 'Ts') },
];

describe('ordering', () => {
  it('every category beats every weaker category, and scores strictly increase', () => {
    const ranks: HandRank[] = REPRESENTATIVES.map(({ cards, category }) => {
      const rank = evaluate5(cards);
      expect(rank.category, cardsToString(cards)).toBe(category);
      return rank;
    });

    for (let stronger = 0; stronger < ranks.length; stronger++) {
      for (let weaker = 0; weaker < stronger; weaker++) {
        const a = ranks[stronger]!;
        const b = ranks[weaker]!;
        expect(
          compareRanks(a, b),
          `${a.category} should beat ${b.category}`,
        ).toBeGreaterThan(0);
        expect(compareRanks(b, a), `${b.category} should lose to ${a.category}`).toBeLessThan(0);
        expect(a.score, `${a.category} vs ${b.category}`).toBeGreaterThan(b.score);
      }
      expect(compareRanks(ranks[stronger]!, ranks[stronger]!)).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Kicker resolution
// ---------------------------------------------------------------------------

describe('kicker resolution', () => {
  it('same pair, different first kicker', () => {
    const kingKicker = evaluate5(hand('As', 'Ad', 'Kh', '9c', '3s'));
    const queenKicker = evaluate5(hand('As', 'Ad', 'Qh', '9c', '3s'));
    expect(kingKicker.category).toBe('PAIR');
    expect(queenKicker.category).toBe('PAIR');
    expect(compareRanks(kingKicker, queenKicker)).toBeGreaterThan(0);
  });

  it('same pair, different third kicker', () => {
    const three = evaluate5(hand('As', 'Ad', 'Kh', '9c', '3s'));
    const two = evaluate5(hand('As', 'Ad', 'Kh', '9c', '2s'));
    expect(compareRanks(three, two)).toBeGreaterThan(0);
  });

  it('two pair: high pair dominates, then low pair, then kicker', () => {
    const acesAndKings = evaluate5(hand('As', 'Ad', 'Kh', 'Kc', '3s'));
    const acesAndQueens = evaluate5(hand('As', 'Ad', 'Qh', 'Qc', '3s'));
    expect(compareRanks(acesAndKings, acesAndQueens)).toBeGreaterThan(0);

    const kingsAndTwos = evaluate5(hand('Ks', 'Kd', '2h', '2c', '3s'));
    const queensAndJacks = evaluate5(hand('Qs', 'Qd', 'Jh', 'Jc', 'As'));
    expect(compareRanks(kingsAndTwos, queensAndJacks)).toBeGreaterThan(0);

    const highKicker = evaluate5(hand('As', 'Ad', 'Kh', 'Kc', '4s'));
    const lowKicker = evaluate5(hand('As', 'Ad', 'Kh', 'Kc', '3s'));
    expect(compareRanks(highKicker, lowKicker)).toBeGreaterThan(0);
  });

  it('trips: trip rank first, then kickers', () => {
    const aceKingKickers = evaluate5(hand('Qs', 'Qd', 'Qh', 'Ac', 'Ks'));
    const kingJackKickers = evaluate5(hand('Qs', 'Qd', 'Qh', 'Kc', 'Js'));
    expect(compareRanks(aceKingKickers, kingJackKickers)).toBeGreaterThan(0);

    const aceThree = evaluate5(hand('Qs', 'Qd', 'Qh', 'Ac', '3s'));
    const aceTwo = evaluate5(hand('Qs', 'Qd', 'Qh', 'Ac', '2s'));
    expect(compareRanks(aceThree, aceTwo)).toBeGreaterThan(0);

    const kings = evaluate5(hand('Ks', 'Kd', 'Kh', '3c', '2s'));
    const queensWithAceKicker = evaluate5(hand('Qs', 'Qd', 'Qh', 'Ac', 'Ks'));
    expect(compareRanks(kings, queensWithAceKicker)).toBeGreaterThan(0);

    const eightsHighKicker = evaluate5(hand('8s', '8d', '8h', 'Ac', '2s'));
    const eightsLowKicker = evaluate5(hand('8s', '8d', '8h', 'Kc', 'Qs'));
    expect(compareRanks(eightsHighKicker, eightsLowKicker)).toBeGreaterThan(0);
  });

  it('flush: compares all five ranks', () => {
    const fiveHigh = evaluate5(hand('Ah', 'Kh', '9h', '5h', '3h'));
    const fourHigh = evaluate5(hand('Ah', 'Kh', '9h', '5h', '2h'));
    expect(compareRanks(fiveHigh, fourHigh)).toBeGreaterThan(0);

    const nineHigh = evaluate5(hand('Ah', 'Kh', '9h', '5h', '3h'));
    const eightHigh = evaluate5(hand('Ad', 'Kd', '8d', '5d', '3d'));
    expect(compareRanks(nineHigh, eightHigh)).toBeGreaterThan(0);
  });

  it('quads: quad rank first, then kicker', () => {
    const threeKicker = evaluate5(hand('Js', 'Jd', 'Jh', 'Jc', '3s'));
    const twoKicker = evaluate5(hand('Js', 'Jd', 'Jh', 'Jc', '2s'));
    expect(compareRanks(threeKicker, twoKicker)).toBeGreaterThan(0);

    const nines = evaluate5(hand('9s', '9d', '9h', '9c', '2s'));
    const eightsWithAce = evaluate5(hand('8s', '8d', '8h', '8c', 'As'));
    expect(compareRanks(nines, eightsWithAce)).toBeGreaterThan(0);
  });

  it('full house: trips rank first, then the pair rank', () => {
    const acesFullOfDeuces = evaluate5(hand('As', 'Ad', 'Ah', '2c', '2d'));
    const kingsFullOfAces = evaluate5(hand('Ks', 'Kd', 'Kh', 'Ac', 'Ad'));
    expect(compareRanks(acesFullOfDeuces, kingsFullOfAces)).toBeGreaterThan(0);

    const acesFullOfKings = evaluate5(hand('As', 'Ad', 'Ah', 'Kc', 'Kd'));
    const acesFullOfQueens = evaluate5(hand('As', 'Ad', 'Ah', 'Qc', 'Qd'));
    expect(compareRanks(acesFullOfKings, acesFullOfQueens)).toBeGreaterThan(0);
  });

  it('high card: compares down to the fifth card', () => {
    const three = evaluate5(hand('As', 'Kd', '9h', '5c', '3s'));
    const two = evaluate5(hand('As', 'Kd', '9h', '5c', '2s'));
    expect(compareRanks(three, two)).toBeGreaterThan(0);

    const four = evaluate5(hand('Ah', 'Kc', '9s', '5d', '4h'));
    expect(compareRanks(four, three)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Ties (chops): identical ranks in different suits
// ---------------------------------------------------------------------------

describe('ties', () => {
  const TIE_CASES: [string, string[]][] = [
    ['high card', ['As', 'Kd', '9h', '5c', '3s']],
    ['pair', ['As', 'Ad', 'Kh', '9c', '3s']],
    ['two pair', ['As', 'Ad', 'Kh', 'Kc', '3s']],
    ['trips', ['Qs', 'Qd', 'Qh', '7c', '2s']],
    ['straight', ['9s', '8d', '7h', '6c', '5s']],
    ['flush', ['Ah', 'Kh', '9h', '5h', '3h']],
    ['full house', ['As', 'Ad', 'Ah', 'Ks', 'Kd']],
    ['quads', ['Js', 'Jd', 'Jh', 'Jc', '2s']],
    ['straight flush', ['9h', '8h', '7h', '6h', '5h']],
    ['royal flush', ['As', 'Ks', 'Qs', 'Js', 'Ts']],
    ['wheel straight', ['As', '2d', '3h', '4c', '5s']],
  ];

  it.each(TIE_CASES)('%s in swapped suits chops', (_name, cards) => {
    const original = evaluate5(hand(...cards));
    // Swap every card to the "next" suit in a rotation, preserving ranks.
    const swapped = evaluate5(
      cards.map((spec) => {
        const card = stringToCard(spec);
        const rank = Math.floor(card / 4);
        const suit = card % 4;
        return rank * 4 + ((suit + 2) % 4);
      }),
    );
    expect(swapped.category).toBe(original.category);
    expect(swapped.description).toBe(original.description);
    expect(swapped.score).toBe(original.score);
    expect(compareRanks(original, swapped)).toBe(0);
    expect(compareRanks(swapped, original)).toBe(0);
  });

  it('a pair with a different kicker is not a tie', () => {
    const acesKingKicker = evaluate5(hand('As', 'Ad', 'Kh', '9c', '3s'));
    const acesQueenKicker = evaluate5(hand('Ah', 'Ac', 'Qh', '9c', '3s'));
    expect(acesKingKicker.score).not.toBe(acesQueenKicker.score);
    expect(compareRanks(acesKingKicker, acesQueenKicker)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Wheel, steel wheel, royal flush
// ---------------------------------------------------------------------------

describe('wheel straights', () => {
  it('A-2-3-4-5 is a five-high (wheel) straight with the ace playing low', () => {
    const wheel = evaluate5(hand('As', '2d', '3h', '4c', '5s'));
    expect(wheel.category).toBe('STRAIGHT');
    expect(wheel.description).toBe('Wheel straight');
    expect(wheel.ranks).toEqual([3, 2, 1, 0, 0]);
    expect(wheel.ranks).not.toContain(12);
    expect(wheel.score).toBe(expectedScore('STRAIGHT', [3, 2, 1, 0, 0]));

    // Six-high straight is the next straight up and must beat the wheel.
    const sixHigh = evaluate5(hand('6s', '5d', '4h', '3c', '2s'));
    expect(sixHigh.category).toBe('STRAIGHT');
    expect(sixHigh.description).toBe('Six-high straight');
    expect(compareRanks(sixHigh, wheel)).toBeGreaterThan(0);
    expect(compareRanks(wheel, sixHigh)).toBeLessThan(0);
  });

  it('the wheel beats trips and loses to a flush', () => {
    const wheel = evaluate5(hand('As', '2d', '3h', '4c', '5s'));
    expect(compareRanks(wheel, evaluate5(hand('As', 'Ad', 'Ah', 'Kc', 'Qd')))).toBeGreaterThan(0);
    expect(compareRanks(wheel, evaluate5(hand('2h', '5h', '7h', '9h', 'Jh')))).toBeLessThan(0);
  });

  it('the wheel is the weakest straight of all', () => {
    const wheel = evaluate5(hand('As', '2d', '3h', '4c', '5s'));
    for (const cards of [
      hand('6s', '5d', '4h', '3c', '2s'),
      hand('9s', '8d', '7h', '6c', '5s'),
      hand('Th', '9d', '8h', '7c', '6s'),
      hand('Ah', 'Kd', 'Qh', 'Jc', 'Ts'),
    ]) {
      expect(compareRanks(evaluate5(cards), wheel), cardsToString(cards)).toBeGreaterThan(0);
    }
  });

  it('the steel wheel is a straight flush and loses to a six-high straight flush', () => {
    const steelWheel = evaluate5(hand('As', '2s', '3s', '4s', '5s'));
    expect(steelWheel.category).toBe('STRAIGHT_FLUSH');
    expect(steelWheel.description).toBe('Steel wheel straight flush');
    expect(steelWheel.ranks).toEqual([3, 2, 1, 0, 0]);

    const sixHighFlush = evaluate5(hand('6h', '5h', '4h', '3h', '2h'));
    expect(sixHighFlush.category).toBe('STRAIGHT_FLUSH');
    expect(compareRanks(sixHighFlush, steelWheel)).toBeGreaterThan(0);

    // ... but it still beats every non-straight-flush hand, quads included.
    const quadAces = evaluate5(hand('As', 'Ad', 'Ah', 'Ac', 'Ks'));
    expect(compareRanks(steelWheel, quadAces)).toBeGreaterThan(0);
  });

  it('A-K-Q-J-T suited is a royal flush and beats every other hand', () => {
    const royal = evaluate5(hand('As', 'Ks', 'Qs', 'Js', 'Ts'));
    expect(royal.category).toBe('ROYAL_FLUSH');
    expect(royal.ranks).toEqual([12, 11, 10, 9, 8]);

    const others: Card[][] = [
      hand('Kh', 'Qh', 'Jh', 'Th', '9h'), // king-high straight flush
      hand('As', 'Ad', 'Ah', 'Ac', 'Ks'), // quad aces
      hand('As', 'Ad', 'Ah', 'Ks', 'Kd'), // aces full
      hand('2h', '5h', '7h', '9h', 'Jh'), // flush
      hand('Ah', 'Kd', 'Qh', 'Jc', 'Ts'), // broadway straight
      hand('As', '2d', '3h', '4c', '5s'), // wheel
    ];
    for (const cards of others) {
      expect(compareRanks(royal, evaluate5(cards)), cardsToString(cards)).toBeGreaterThan(0);
    }
    expect(compareRanks(royal, evaluate5(hand('Ah', 'Kh', 'Qh', 'Jh', 'Th')))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. evaluate7 picks the right five of seven
// ---------------------------------------------------------------------------

describe('evaluate7', () => {
  it('prefers a flush over a made straight in the same seven cards', () => {
    const cards = hand('As', 'Ks', '9s', '5s', '3s', '2d', '4h');
    const rank = evaluate7(cards);
    expect(rank.category).toBe('FLUSH');
    expect(rank.description).toBe('Ace-high flush');
    expect([...rank.best].sort((a, b) => a - b)).toEqual(
      hand('As', 'Ks', '9s', '5s', '3s').sort((a, b) => a - b),
    );
    expectSubsetOf(rank.best, cards);
    expect(evaluate5(rank.best).score).toBe(rank.score);
  });

  it('finds a board-paired full house', () => {
    const cards = hand('As', 'Ad', 'Ah', 'Kc', 'Kd', '7s', '2h');
    const rank = evaluate7(cards);
    expect(rank.category).toBe('FULL_HOUSE');
    expect(rank.description).toBe('Aces full of Kings');
    expect(rank.ranks).toEqual([12, 11, 0, 0, 0]);
    expectSubsetOf(rank.best, cards);
    expect(evaluate5(rank.best).score).toBe(rank.score);
  });

  it('prefers aces full over kings full when both are available', () => {
    const cards = hand('As', 'Ad', 'Ah', 'Kc', 'Kd', 'Ks', '2h');
    const rank = evaluate7(cards);
    expect(rank.category).toBe('FULL_HOUSE');
    expect(rank.description).toBe('Aces full of Kings');
  });

  it('makes trips from a pocket pair', () => {
    const cards = hand('8s', '8d', '8h', 'Kc', 'Qd', '3s', '2h');
    const rank = evaluate7(cards);
    expect(rank.category).toBe('TRIPS');
    expect(rank.description).toBe('Three Eights');
    expect(rank.ranks).toEqual([6, 11, 10, 0, 0]);
    expectSubsetOf(rank.best, cards);
    expect(evaluate5(rank.best).score).toBe(rank.score);
  });

  it('finds quads with the best kicker', () => {
    const cards = hand('9h', '9d', '9s', '9c', 'As', 'Kd', 'Qh');
    const rank = evaluate7(cards);
    expect(rank.category).toBe('QUADS');
    expect(rank.description).toBe('Four Nines');
    expect(rank.ranks).toEqual([7, 12, 0, 0, 0]);
    expectSubsetOf(rank.best, cards);
    expect(evaluate5(rank.best).score).toBe(rank.score);
  });

  it('finds the straight flush hidden among other cards', () => {
    const cards = hand('9h', '8h', '7h', '6h', '5h', 'As', 'Ad');
    const rank = evaluate7(cards);
    expect(rank.category).toBe('STRAIGHT_FLUSH');
    expect(rank.description).toBe('Nine-high straight flush');
    expectSubsetOf(rank.best, cards);
    expect(evaluate5(rank.best).score).toBe(rank.score);
  });

  it('finds a royal flush among seven cards', () => {
    const cards = hand('As', 'Ks', 'Qs', 'Js', 'Ts', '2d', '7c');
    const rank = evaluate7(cards);
    expect(rank.category).toBe('ROYAL_FLUSH');
    expect(rank.ranks).toEqual([12, 11, 10, 9, 8]);
    expectSubsetOf(rank.best, cards);
  });

  it('picks the wheel when it is the best available straight', () => {
    const cards = hand('As', '2d', '3h', '4c', '5s', 'Kd', 'Qh');
    const rank = evaluate7(cards);
    expect(rank.category).toBe('STRAIGHT');
    expect(rank.description).toBe('Wheel straight');
    expect(rank.best).toEqual(hand('5s', '4c', '3h', '2d', 'As'));
    expectSubsetOf(rank.best, cards);
  });

  it('returns five cards that are a subset of the input for arbitrary deals', () => {
    const rand = createRng(0x5eed);
    for (let i = 0; i < 300; i++) {
      const cards = deal(rand, 7);
      const rank = evaluate7(cards);
      expectSubsetOf(rank.best, cards);
      expect(rank.ranks).toHaveLength(5);
      expect(evaluate5(rank.best).score, cardsToString(cards)).toBe(rank.score);
    }
  });

  it('evaluate handles 5, 6 and 7 cards', () => {
    expect(evaluate(hand('As', 'Ks', 'Qs', 'Js', 'Ts')).category).toBe('ROYAL_FLUSH');
    expect(evaluate(hand('As', 'Ks', 'Qs', 'Js', 'Ts', '9s')).category).toBe('ROYAL_FLUSH');
    expect(evaluate(hand('As', 'Ks', 'Qs', 'Js', 'Ts', '9s', '8s')).category).toBe('ROYAL_FLUSH');
  });
});

// ---------------------------------------------------------------------------
// 7. Property test vs brute force (NFR-5)
// ---------------------------------------------------------------------------

describe('property: evaluate7 vs exhaustive brute force', () => {
  it('equals the max over all 21 five-card subsets for 2000 seeded deals', () => {
    const rand = createRng(0x1234abcd);
    for (let i = 0; i < 2000; i++) {
      const cards = deal(rand, 7);
      const got = evaluate7(cards);
      const reference = bestSubset5(cards);
      const label = `deal #${i}: ${cardsToString(cards)}`;
      expect(got.score, label).toBe(reference.score);
      expect(got.category, label).toBe(reference.category);
      expect(got.best.length, label).toBe(5);
      expect(evaluate5(got.best).score, label).toBe(got.score);
    }
  });

  it('also holds for evaluate() with 6 cards', () => {
    const rand = createRng(0x77aa33ee);
    for (let i = 0; i < 500; i++) {
      const cards = deal(rand, 6);
      const got = evaluate(cards);
      const reference = bestSubset5(cards);
      const label = `deal #${i}: ${cardsToString(cards)}`;
      expect(got.score, label).toBe(reference.score);
      expect(got.category, label).toBe(reference.category);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Property: compareRanks agrees with score
// ---------------------------------------------------------------------------

describe('property: compareRanks', () => {
  it('is sign-consistent with score and antisymmetric over 2000 seeded pairs', () => {
    const rand = createRng(0x0badf00d);
    for (let i = 0; i < 2000; i++) {
      const a = evaluate7(deal(rand, 7));
      const b = evaluate7(deal(rand, 7));
      const expected = Math.sign(a.score - b.score);
      const ab = compareRanks(a, b);
      const ba = compareRanks(b, a);
      const label = `pair #${i}: ${cardsToString(a.best)} vs ${cardsToString(b.best)}`;

      expect(ab > 0, label).toBe(expected > 0);
      expect(ab < 0, label).toBe(expected < 0);
      expect(ab === 0, label).toBe(expected === 0);
      expect(ba > 0, label).toBe(expected < 0);
      expect(ba < 0, label).toBe(expected > 0);
      expect(ba === 0, label).toBe(expected === 0);
      expect(compareRanks(a, a), label).toBe(0);
      expect(compareRanks(b, b), label).toBe(0);
    }
  });

  it('reports 0 for independently built identical-rank hands', () => {
    const a = evaluate7(hand('As', 'Ks', 'Qs', 'Js', 'Ts', '2d', '7c'));
    const b = evaluate7(hand('Ah', 'Kh', 'Qh', 'Jh', 'Th', '2c', '7d'));
    expect(a.score).toBe(b.score);
    expect(compareRanks(a, b)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Validation
// ---------------------------------------------------------------------------

describe('evaluate5 validation', () => {
  const WRONG_LENGTH_CASES: [string, Card[]][] = [
    ['empty', hand()],
    ['four cards', hand('As', 'Kd', 'Qh', 'Js')],
    ['six cards', hand('As', 'Kd', 'Qh', 'Js', 'Ts', '9s')],
  ];

  it.each(WRONG_LENGTH_CASES)('throws on the wrong number of cards: %s', (_name, cards) => {
    expect(() => evaluate5(cards)).toThrow(/5 cards/);
  });

  const INVALID_CARD_CASES: [string, Card[], RegExp][] = [
    ['duplicate card', hand('As', 'As', 'Kd', 'Qh', 'Js'), /duplicate/],
    ['card above the deck', [52, 1, 2, 3, 4], /out of range/],
    ['negative card', [-1, 1, 2, 3, 4], /out of range/],
    ['non-integer card', [1.5, 1, 2, 3, 4], /out of range/],
    ['NaN card', [Number.NaN, 1, 2, 3, 4], /out of range/],
  ];

  it.each(INVALID_CARD_CASES)('throws on invalid cards: %s', (_name, cards, pattern) => {
    expect(() => evaluate5(cards)).toThrow(pattern);
  });

  it('evaluate7 and evaluate validate their own lengths', () => {
    expect(() => evaluate7(hand('As', 'Kd', 'Qh', 'Js', 'Ts', '9s'))).toThrow(/7 cards/);
    expect(() => evaluate(hand('As', 'Kd', 'Qh', 'Js'))).toThrow(/5, 6 or 7 cards/);
    expect(() => evaluate(hand('As', 'Kd', 'Qh', 'Js', 'Ts', '9s', '8s', '7s'))).toThrow(
      /5, 6 or 7 cards/,
    );
    expect(() => evaluate7(hand('As', 'As', 'Qh', 'Js', 'Ts', '9s', '8s'))).toThrow(/duplicate/);
  });
});

// ---------------------------------------------------------------------------
// 10. Scores are safe integers
// ---------------------------------------------------------------------------

describe('property: score is a safe integer', () => {
  it('holds for every hand and every 5-card subset produced in the property test', () => {
    const rand = createRng(0xc0ffee);
    for (let i = 0; i < 2000; i++) {
      const cards = deal(rand, 7);
      const rank = evaluate7(cards);
      expect(Number.isSafeInteger(rank.score), cardsToString(cards)).toBe(true);
      expect(rank.score).toBeGreaterThan(0);
      expect(rank.score).toBeLessThan(2 ** 53);

      const n = cards.length;
      for (let a = 0; a + 4 < n; a++) {
        for (let b = a + 1; b + 3 < n; b++) {
          for (let c = b + 1; c + 2 < n; c++) {
            for (let d = c + 1; d + 1 < n; d++) {
              for (let e = d + 1; e < n; e++) {
                const subset = evaluate5([cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!]);
                expect(Number.isSafeInteger(subset.score)).toBe(true);
                expect(subset.score).toBeGreaterThan(0);
              }
            }
          }
        }
      }
    }
  });

  it('the strongest possible hand scores far below 2^53', () => {
    const royal = evaluate5(hand('As', 'Ks', 'Qs', 'Js', 'Ts'));
    expect(royal.score).toBe(expectedScore('ROYAL_FLUSH', [12, 11, 10, 9, 8]));
    expect(royal.score).toBeLessThan(2 ** 53);
  });
});
