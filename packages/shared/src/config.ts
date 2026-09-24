/** Chain constants and default table configurations (SRS §1, FR-8, FR-9). */

import { tokenStringToChips } from './money.js';
import type { Chips, TableConfig } from './types.js';
import { MAX_SEATS } from './types.js';

/** Robinhood Chain. */
export const CHAIN_ID = 4663;
export const CHAIN_NAME = 'Robinhood Chain';

/** FR-8.1 defaults: 2.5% rake, capped at 0.05 token, only when a flop is seen. */
export const DEFAULT_RAKE_BPS = 250;
export const DEFAULT_RAKE_CAP: Chips = tokenStringToChips('0.05');
/** FR-3.5 default think budget. */
export const DEFAULT_THINK_BUDGET_MS = 30_000;
/** FR-6.5 default anchor finality. */
export const DEFAULT_CONFIRMATIONS = 12;
/** FR-9.5 default unstake cooldown. */
export const UNSTAKE_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;

export interface BlindTier {
  name: string;
  smallBlind: Chips;
  bigBlind: Chips;
  minBuyIn: Chips;
  maxBuyIn: Chips;
}

const tier = (name: string, sb: string, bb: string, minBuy: string, maxBuy: string): BlindTier => ({
  name,
  smallBlind: tokenStringToChips(sb),
  bigBlind: tokenStringToChips(bb),
  minBuyIn: tokenStringToChips(minBuy),
  maxBuyIn: tokenStringToChips(maxBuy),
});

/** Wager stake tiers (SRS §11 Q3: fixed tiers rather than agent-selected blinds). */
export const WAGER_TIERS: readonly BlindTier[] = [
  tier('micro', '0.01', '0.02', '1', '5'),
  tier('low', '0.05', '0.1', '5', '25'),
  tier('mid', '0.25', '0.5', '25', '125'),
  tier('high', '1', '2', '100', '500'),
];

/** Free-mode tables use whole play chips (1 play chip = 1 base unit). */
export const FREE_TIERS: readonly BlindTier[] = [
  { name: 'play-1-2', smallBlind: 1n, bigBlind: 2n, minBuyIn: 100n, maxBuyIn: 400n },
  { name: 'play-5-10', smallBlind: 5n, bigBlind: 10n, minBuyIn: 500n, maxBuyIn: 2000n },
  { name: 'play-25-50', smallBlind: 25n, bigBlind: 50n, minBuyIn: 2500n, maxBuyIn: 10_000n },
];

export const FREE_STARTING_CHIPS: Chips = 10_000n;

export function defaultFreeTableConfig(id: string, name: string, tierIndex = 0): TableConfig {
  const t = FREE_TIERS[tierIndex] ?? FREE_TIERS[0]!;
  return {
    id,
    name,
    mode: 'FREE',
    maxSeats: MAX_SEATS,
    smallBlind: t.smallBlind,
    bigBlind: t.bigBlind,
    ante: 0n,
    minBuyIn: t.minBuyIn,
    maxBuyIn: t.maxBuyIn,
    thinkBudgetMs: DEFAULT_THINK_BUDGET_MS,
    rakeBps: 0,
    rakeCap: 0n,
    rakeOnlyWithFlop: true,
    burnCards: true,
    autoStart: true,
    handIntervalMs: 3_000,
    escrowRequired: false,
  };
}

export function defaultWagerTableConfig(id: string, name: string, tierIndex = 0): TableConfig {
  const t = WAGER_TIERS[tierIndex] ?? WAGER_TIERS[0]!;
  return {
    id,
    name,
    mode: 'WAGER',
    maxSeats: MAX_SEATS,
    smallBlind: t.smallBlind,
    bigBlind: t.bigBlind,
    ante: 0n,
    minBuyIn: t.minBuyIn,
    maxBuyIn: t.maxBuyIn,
    thinkBudgetMs: DEFAULT_THINK_BUDGET_MS,
    rakeBps: DEFAULT_RAKE_BPS,
    rakeCap: DEFAULT_RAKE_CAP,
    rakeOnlyWithFlop: true,
    burnCards: true,
    autoStart: true,
    handIntervalMs: 5_000,
    escrowRequired: true,
  };
}

export function validateTableConfig(config: TableConfig): string[] {
  const errors: string[] = [];
  if (config.maxSeats < 2 || config.maxSeats > MAX_SEATS) errors.push(`maxSeats must be 2..${MAX_SEATS}`);
  if (config.smallBlind <= 0n) errors.push('smallBlind must be > 0');
  if (config.bigBlind !== config.smallBlind * 2n) errors.push('bigBlind must be exactly 2x smallBlind');
  if (config.ante < 0n) errors.push('ante cannot be negative');
  if (config.minBuyIn < config.bigBlind * 10n) errors.push('minBuyIn must be at least 10 big blinds');
  if (config.maxBuyIn < config.minBuyIn) errors.push('maxBuyIn must be >= minBuyIn');
  if (config.thinkBudgetMs < 1_000) errors.push('thinkBudgetMs must be at least 1000');
  if (config.rakeBps < 0 || config.rakeBps > 1_000) errors.push('rakeBps must be 0..1000');
  if (config.rakeCap < 0n) errors.push('rakeCap cannot be negative');
  if (config.mode === 'FREE' && config.escrowRequired) errors.push('free tables cannot require escrow');
  return errors;
}

/** FR-8.1: rake on a pot, only when a flop was seen, capped. */
export function computeRake(pot: Chips, config: Pick<TableConfig, 'rakeBps' | 'rakeCap' | 'rakeOnlyWithFlop'>, sawFlop: boolean): Chips {
  if (config.rakeBps <= 0) return 0n;
  if (config.rakeOnlyWithFlop && !sawFlop) return 0n;
  const raw = (pot * BigInt(config.rakeBps)) / 10_000n;
  return raw > config.rakeCap ? config.rakeCap : raw;
}
