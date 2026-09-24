/** Shared test helpers. Not a test file (does not match the vitest include glob). */

import { keccak256, shuffleDeck, uint256ToBytes, type Card, type TableConfig } from '@llmpoker/shared';
import { defaultFreeTableConfig, defaultWagerTableConfig } from '@llmpoker/shared';

/** Deterministic pseudo-random generator so every failure is reproducible. */
export class Lcg {
  private state: bigint;

  constructor(seed: number | bigint) {
    this.state = (BigInt(seed) ^ 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
  }

  nextUint32(): number {
    this.state = (this.state * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
    return Number((this.state >> 32n) & 0xffffffffn);
  }

  /** Uniform integer in `[0, max)`. */
  nextInt(max: number): number {
    if (max <= 0) throw new RangeError('max must be positive');
    return this.nextUint32() % max;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('cannot pick from an empty list');
    return items[this.nextInt(items.length)]!;
  }
}

/** A deterministic, well-shuffled 52-card deck for tests. */
export function deckFor(seed: number | bigint): Card[] {
  return shuffleDeck(keccak256(uint256ToBytes(seed))).deck;
}

export function testConfig(overrides: Partial<TableConfig> = {}): TableConfig {
  const base = defaultFreeTableConfig('test-table', 'Test Table');
  return {
    ...base,
    smallBlind: 1n,
    bigBlind: 2n,
    minBuyIn: 20n,
    maxBuyIn: 10_000n,
    autoTopUp: null,
    handIntervalMs: 0,
    ...overrides,
  };
}

export function wagerConfig(overrides: Partial<TableConfig> = {}): TableConfig {
  const base = defaultWagerTableConfig('test-wager', 'Test Wager', 0);
  return {
    ...base,
    smallBlind: 10n,
    bigBlind: 20n,
    minBuyIn: 200n,
    maxBuyIn: 100_000n,
    rakeBps: 250,
    rakeCap: 1_000n,
    autoTopUp: null,
    ...overrides,
  };
}

/** Deep-clones a value, turning bigints into strings so it can be stringified. */
export function normalize(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}

/** Result comparison that ignores wall-clock timestamps (still deterministic data). */
export function stripTimes<T extends { startedAt: number; endedAt: number; actions: { at: number }[] }>(r: T): unknown {
  return normalize({ ...r, startedAt: 0, endedAt: 0, actions: r.actions.map((a) => ({ ...a, at: 0 })) });
}
