import { describe, expect, it } from 'vitest';
import {
  ACTION_GRAMMAR,
  ACTIONS,
  computeRake,
  defaultFreeTableConfig,
  defaultWagerTableConfig,
  parseActionText,
  formatActionText,
  validateActionShape,
  tokenStringToChips,
  chipsToTokenString,
  parseChips,
  formatChips,
  cardToString,
  cardsToString,
  stringToCard,
  makeCard,
  cardRank,
  cardSuit,
  freshDeck,
  isCompleteDeck,
  isCard,
  MAX_SEATS,
  CHAIN_ID,
  formatActionText as fmt,
} from '../src/index.js';

describe('card encoding', () => {
  it('round-trips every card', () => {
    for (let card = 0; card < 52; card++) {
      expect(isCard(card)).toBe(true);
      expect(stringToCard(cardToString(card))).toBe(card);
    }
    expect(cardToString(makeCard(12, 3))).toBe('As');
    expect(stringToCard('as')).toBe(makeCard(12, 3));
    expect(stringToCard('Th')).toBe(makeCard(8, 2));
    expect(cardRank(makeCard(12, 3))).toBe(12);
    expect(cardSuit(makeCard(12, 3))).toBe(3);
    expect(cardsToString([makeCard(12, 3), makeCard(12, 2)])).toBe('As Ah');
  });

  it('rejects malformed cards', () => {
    for (const bad of ['', 'A', 'Asx', '1s', 'Ax', 'ZZ']) {
      expect(() => stringToCard(bad)).toThrow(/invalid card/);
    }
    expect(() => makeCard(13, 0)).toThrow(/rank out of range/);
    expect(() => makeCard(0, 4)).toThrow(/suit out of range/);
    expect(isCard(-1)).toBe(false);
    expect(isCard(52)).toBe(false);
    expect(isCard(1.5)).toBe(false);
  });

  it('the fresh deck is the canonical 52-card ordering', () => {
    const deck = freshDeck();
    expect(deck).toHaveLength(52);
    expect(deck[0]).toBe(0);
    expect(deck[51]).toBe(51);
    expect(isCompleteDeck(deck)).toBe(true);
    expect(isCompleteDeck([...deck.slice(0, 51), 0])).toBe(false);
    expect(isCompleteDeck(deck.slice(0, 51))).toBe(false);
  });
});

describe('action grammar (SRS §7)', () => {
  it('parses every documented form, case-insensitively', () => {
    expect(parseActionText('FOLD')).toEqual({ action: 'FOLD' });
    expect(parseActionText('  check ')).toEqual({ action: 'CHECK' });
    expect(parseActionText('call')).toEqual({ action: 'CALL' });
    expect(parseActionText('BET 120')).toEqual({ action: 'BET', amount: 120n });
    expect(parseActionText('raise 1500000000000000000')).toEqual({ action: 'RAISE', amount: 1_500_000_000_000_000_000n });
    expect(parseActionText('all_in')).toEqual({ action: 'ALL_IN' });
    expect(ACTION_GRAMMAR).toBe('FOLD | CHECK | CALL | BET <amt> | RAISE <amt> | ALL_IN');
    expect(ACTIONS).toHaveLength(6);
  });

  it('rejects malformed input instead of guessing', () => {
    expect(() => parseActionText('')).toThrow(/expected one of/);
    expect(() => parseActionText('PUSH 10')).toThrow(/expected one of/);
    expect(() => parseActionText('BET')).toThrow(/requires an amount/);
    expect(() => parseActionText('BET 1.5')).toThrow(/integer number of chips/);
    expect(() => parseActionText('BET -5')).toThrow(/integer number of chips/);
    expect(() => parseActionText('CALL 10')).toThrow(/takes no amount/);
    expect(() => parseActionText('RAISE 10 20')).toThrow(/trailing input/);
  });

  it('formats actions back into the grammar', () => {
    for (const text of ['FOLD', 'CHECK', 'CALL', 'ALL_IN', 'BET 5', 'RAISE 250']) {
      expect(fmt(parseActionText(text))).toBe(text);
    }
    expect(formatActionText({ action: 'BET', amount: 7n })).toBe('BET 7');
  });

  it('validates the JSON action shape used by the API', () => {
    expect(validateActionShape({ action: 'CHECK' })).toEqual({ ok: true, action: { action: 'CHECK' } });
    expect(validateActionShape({ action: 'raise', amount: '250' })).toEqual({
      ok: true,
      action: { action: 'RAISE', amount: 250n },
    });
    expect(validateActionShape({ action: 'BET', amount: 5 })!.action).toEqual({ action: 'BET', amount: 5n });
    expect(validateActionShape({ action: 'BET' }).ok).toBe(false);
    expect(validateActionShape({ action: 'BET', amount: '1.5' }).ok).toBe(false);
    expect(validateActionShape({ action: 'CALL', amount: 10 }).ok).toBe(false);
    expect(validateActionShape({ action: 'NOPE' }).ok).toBe(false);
    expect(validateActionShape('BET 5').ok).toBe(false);
    expect(validateActionShape(null).ok).toBe(false);
  });
});

describe('money', () => {
  it('converts between token strings and chips', () => {
    expect(tokenStringToChips('1.5')).toBe(1_500_000_000_000_000_000n);
    expect(tokenStringToChips('0.05')).toBe(50_000_000_000_000_000n);
    expect(tokenStringToChips('10')).toBe(10_000_000_000_000_000_000n);
    expect(tokenStringToChips('0')).toBe(0n);
    expect(chipsToTokenString(1_500_000_000_000_000_000n)).toBe('1.5');
    expect(chipsToTokenString(50_000_000_000_000_000n)).toBe('0.05');
    expect(chipsToTokenString(0n)).toBe('0');
    expect(chipsToTokenString(1n)).toBe('0.000000000000000001');
    expect(formatChips(2_000_000_000_000_000_000n)).toBe('2 TOKEN');
  });

  it('rejects malformed amounts and never loses precision', () => {
    expect(() => tokenStringToChips('1.2345678901234567890')).toThrow(/too many decimals/);
    expect(() => tokenStringToChips('abc')).toThrow(/invalid token amount/);
    expect(() => parseChips(-1)).toThrow();
    expect(() => parseChips(1.5)).toThrow(/invalid chip amount/);
    expect(parseChips('123')).toBe(123n);
    const huge = 123_456_789_012_345_678_901_234_567_890n;
    expect(parseChips(huge.toString())).toBe(huge);
    expect(chipsToTokenString(huge)).toBe('123456789012.34567890123456789');
  });
});

describe('chain + table defaults (FR-8, FR-9)', () => {
  it('targets Robinhood Chain and a 6-max table', () => {
    expect(CHAIN_ID).toBe(4663);
    expect(MAX_SEATS).toBe(6);
    expect(defaultFreeTableConfig('f', 'Free').maxSeats).toBe(6);
    expect(defaultWagerTableConfig('w', 'Wager').maxSeats).toBe(6);
  });

  it('applies the documented rake schedule', () => {
    const config = { rakeBps: 250, rakeCap: tokenStringToChips('0.05'), rakeOnlyWithFlop: true };
    const pot = tokenStringToChips('1');
    expect(computeRake(pot, config, true)).toBe(tokenStringToChips('0.025'));
    expect(computeRake(pot, config, false)).toBe(0n);
    expect(computeRake(tokenStringToChips('100'), config, true)).toBe(tokenStringToChips('0.05'));
    expect(computeRake(pot, { ...config, rakeBps: 0 }, true)).toBe(0n);
    expect(computeRake(1n, config, true)).toBe(0n); // integer division floors
  });

  it('free tables charge no rake and wager tables follow the SRS defaults', () => {
    const free = defaultFreeTableConfig('f', 'Free');
    expect(free.rakeBps).toBe(0);
    expect(free.rakeCap).toBe(0n);
    expect(free.escrowRequired).toBe(false);
    expect(free.autoTopUp).toBeGreaterThan(0n);

    const wager = defaultWagerTableConfig('w', 'Wager');
    expect(wager.rakeBps).toBe(250);
    expect(wager.rakeCap).toBe(tokenStringToChips('0.05'));
    expect(wager.escrowRequired).toBe(true);
    expect(wager.autoTopUp).toBeNull();
    expect(wager.bigBlind).toBe(wager.smallBlind * 2n);
    expect(wager.minBuyIn).toBeGreaterThanOrEqual(wager.bigBlind * 10n);
  });
});
