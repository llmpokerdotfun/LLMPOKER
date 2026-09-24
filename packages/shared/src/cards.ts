/**
 * Card and deck encoding.
 *
 * A card is a single byte in `0..51` with `card = rank * 4 + suit`:
 *
 * | field | values |
 * |-------|--------|
 * | rank  | `0..12` = `2 3 4 5 6 7 8 9 T J Q K A` |
 * | suit  | `0..3`  = `c d h s` |
 *
 * A point of order (so the rest of the system is deterministic): the shuffled
 * deck is an array of 52 distinct card bytes, produced by
 * {@link shuffleDeck}. Anyone can rebuild it from public data — see
 * `docs/RNG.md`.
 */

export const RANKS = '23456789TJQKA';
export const SUITS = 'cdhs';

/** Inclusive rank range: deuce = 0 … ace = 12. */
export type Rank = number;
/** 0 = clubs, 1 = diamonds, 2 = hearts, 3 = spades. */
export type Suit = 0 | 1 | 2 | 3;
/** 0..51, see module docs. */
export type Card = number;

export const DECK_SIZE = 52;
export const CARDS_PER_HAND = 2;

export function makeCard(rank: Rank, suit: Suit): Card {
  if (rank < 0 || rank > 12) throw new RangeError(`rank out of range: ${rank}`);
  if (suit < 0 || suit > 3) throw new RangeError(`suit out of range: ${suit}`);
  return rank * 4 + suit;
}

export function cardRank(card: Card): Rank {
  return (card / 4) | 0;
}

export function cardSuit(card: Card): Suit {
  return (card % 4) as Suit;
}

export function rankChar(rank: Rank): string {
  const c = RANKS[rank];
  if (c === undefined) throw new RangeError(`rank out of range: ${rank}`);
  return c;
}

export function suitChar(suit: Suit): string {
  const c = SUITS[suit];
  if (c === undefined) throw new RangeError(`suit out of range: ${suit}`);
  return c;
}

/** `"As"`, `"Th"`, `"2c"` … */
export function cardToString(card: Card): string {
  return `${rankChar(cardRank(card))}${suitChar(cardSuit(card))}`;
}

/** Accepts `"As"`, `"as"`, `"A s"`-free strict form. Throws on invalid input. */
export function stringToCard(text: string): Card {
  const t = text.trim();
  if (t.length !== 2) throw new Error(`invalid card: ${JSON.stringify(text)}`);
  const rank = RANKS.indexOf(t[0]!.toUpperCase());
  const suit = SUITS.indexOf(t[1]!.toLowerCase());
  if (rank < 0 || suit < 0) throw new Error(`invalid card: ${JSON.stringify(text)}`);
  return makeCard(rank, suit as Suit);
}

export function cardsToString(cards: readonly Card[]): string {
  return cards.map(cardToString).join(' ');
}

/** The canonical, **unshuffled** deck: `[0, 1, … 51]` (2c, 2d, 2h, 2s, 3c, …). */
export function freshDeck(): Card[] {
  const deck = new Array<Card>(DECK_SIZE);
  for (let i = 0; i < DECK_SIZE; i++) deck[i] = i;
  return deck;
}

export function isCard(value: unknown): value is Card {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < DECK_SIZE;
}

/** Validates that `deck` is a permutation of the 52 distinct cards. */
export function isCompleteDeck(deck: readonly number[]): boolean {
  if (deck.length !== DECK_SIZE) return false;
  const seen = new Uint8Array(DECK_SIZE);
  for (const c of deck) {
    if (!isCard(c) || seen[c] === 1) return false;
    seen[c] = 1;
  }
  return true;
}

export function assertCompleteDeck(deck: readonly number[]): void {
  if (!isCompleteDeck(deck)) throw new Error('deck is not a permutation of 52 distinct cards');
}
