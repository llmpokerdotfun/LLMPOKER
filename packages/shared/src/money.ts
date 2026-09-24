/** Money helpers. Chips are `bigint` base units; 1 token = 1e18 chips. */

import { CHIP_DECIMALS, CHIPS_PER_TOKEN, type Chips, type ChipsJson } from './types.js';

export function isChipsJson(value: unknown): value is ChipsJson {
  return typeof value === 'string' && /^[0-9]+$/.test(value);
}

/** Accepts a bigint, a safe integer, or a decimal string of base units. */
export function parseChips(value: Chips | ChipsJson | number): Chips {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new RangeError('chips cannot be negative');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`invalid chip amount: ${value}`);
    return BigInt(value);
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value);
  throw new RangeError(`invalid chip amount: ${String(value)}`);
}

export function toChipsJson(value: Chips): ChipsJson {
  return value.toString();
}

/** `"1.5"` → `1500000000000000000n` (18 decimals by default). */
export function tokenStringToChips(text: string, decimals = CHIP_DECIMALS): Chips {
  const trimmed = text.trim();
  const m = /^(\d+)(?:\.(\d*))?$/.exec(trimmed);
  if (!m) throw new RangeError(`invalid token amount: ${JSON.stringify(text)}`);
  const whole = m[1]!;
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new RangeError(`too many decimals for ${decimals}-decimal token`);
  const padded = frac.padEnd(decimals, '0');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded === '' ? '0' : padded);
}

/** `1500000000000000000n` → `"1.5"` (trailing zeros trimmed). */
export function chipsToTokenString(value: Chips, decimals = CHIP_DECIMALS): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  const out = frac === '' ? whole.toString() : `${whole}.${frac}`;
  return neg ? `-${out}` : out;
}

/** `1500000000000000000n` → `"1.5 TOKEN"`. */
export function formatChips(value: Chips, symbol = 'TOKEN'): string {
  return `${chipsToTokenString(value)} ${symbol}`;
}

/** One big blind expressed in chips for a token-denominated config. */
export function tokens(value: string): Chips {
  return tokenStringToChips(value);
}

export { CHIP_DECIMALS, CHIPS_PER_TOKEN, type Chips, type ChipsJson };
