/**
 * Pure display formatting. No DOM, no network.
 *
 * Money rule (FR-7.1): chips cross the wire as **decimal strings** of base
 * units (1 token = 1e18 chips). Every conversion here is `BigInt`-based — this
 * file never calls `Number(chips)`, which would silently round a 1e18-scale
 * balance to a float.
 */

import { CHIP_DECIMALS } from './constants.js';

const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';

/** Em dash used for "no value". */
export const EM_DASH = '\u2014';

/**
 * Mirrors `cardToString()` from `packages/shared/src/cards.ts` exactly
 * (a card is `rank * 4 + suit`). Kept local so the monitor still renders when
 * `/vendor/shared/index.js` has not been built yet.
 *
 * @param {number|string|null|undefined} card
 * @returns {string} e.g. `"As"`, `"Th"`, `"2c"`, or `"??"` for garbage.
 */
export function cardToString(card) {
  const n = typeof card === 'string' ? Number(card) : card;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 51) return '??';
  return `${RANKS[Math.floor(n / 4)]}${SUITS[n % 4]}`;
}

/**
 * @param {number} card
 * @returns {boolean} true for diamonds and hearts.
 */
export function cardIsRed(card) {
  const suit = card % 4;
  return suit === 1 || suit === 2;
}

/**
 * Parses a chip amount without losing precision.
 * Accepts a decimal string (optionally negative — `net`/`netWagerProfit` can be
 * negative), a bigint, or a safe integer. Returns `null` for anything else
 * instead of throwing, so a malformed field renders as an em dash.
 *
 * @param {unknown} value
 * @returns {bigint|null}
 */
export function parseChips(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    try {
      return BigInt(value.trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Exact fixed-point rendering of chips as tokens, trailing zeros trimmed.
 * Mirrors `chipsToTokenString()` from `packages/shared/src/money.ts`.
 *
 * @param {unknown} value chip base units
 * @param {number} [decimals]
 * @returns {string} e.g. `"1500000000000000000"` -> `"1.5"`.
 */
export function chipsToTokenString(value, decimals = CHIP_DECIMALS) {
  const chips = parseChips(value);
  if (chips === null) return EM_DASH;
  const negative = chips < 0n;
  const abs = negative ? -chips : chips;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  const body = frac === '' ? whole.toString() : `${whole}.${frac}`;
  return negative ? `-${body}` : body;
}

/**
 * @param {string} text
 * @returns {string} `1234567.5` -> `1,234,567.5`
 */
export function groupThousands(text) {
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const dot = body.indexOf('.');
  const whole = dot === -1 ? body : body.slice(0, dot);
  const frac = dot === -1 ? '' : body.slice(dot);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${frac}`;
}

/**
 * Human-readable token amount with digit grouping.
 *
 * @param {unknown} value chip base units
 * @param {{decimals?: number, maxFractionDigits?: number, group?: boolean}} [options]
 *   `maxFractionDigits` truncates a long fraction and appends `…` (never
 *   silently rounds); callers should put the exact value in `title`.
 * @returns {string}
 */
export function formatTokens(value, options = {}) {
  const exact = chipsToTokenString(value, options.decimals ?? CHIP_DECIMALS);
  if (exact === EM_DASH) return exact;
  const limit = options.maxFractionDigits;
  let shown = exact;
  if (typeof limit === 'number' && limit >= 0) {
    const dot = exact.indexOf('.');
    if (dot !== -1 && exact.length - dot - 1 > limit) {
      shown = limit === 0 ? exact.slice(0, dot) : `${exact.slice(0, dot + 1 + limit)}\u2026`;
    }
  }
  return options.group === false ? shown : groupThousands(shown);
}

/**
 * @param {unknown} value chip base units
 * @param {{decimals?: number, maxFractionDigits?: number, plus?: boolean}} [options]
 * @returns {string} `"+1.5"` / `"-0.25"` (for trustless peer comparison).
 */
export function formatSignedTokens(value, options = {}) {
  const chips = parseChips(value);
  if (chips === null) return EM_DASH;
  const body = formatTokens(chips, options);
  if (chips > 0n && options.plus !== false) return `+${body}`;
  return body;
}

/**
 * Win rate as a percentage string.
 *
 * Shape guess (documented): the wire type is a bare `number` with no unit, so a
 * value `<= 1` is treated as a ratio and anything larger as an already-scaled
 * percentage. Both render correctly for the usual producers.
 *
 * @param {number|null|undefined} rate
 * @returns {string}
 */
export function formatWinRate(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return EM_DASH;
  const pct = rate <= 1 ? rate * 100 : rate;
  return `${pct.toFixed(1)}%`;
}

/**
 * @param {number|null|undefined} wins
 * @param {number|null|undefined} played
 * @returns {string} win rate derived from counters, e.g. `"42.9% (3/7)"`.
 */
export function formatWinRateFromCounts(wins, played) {
  if (typeof played !== 'number' || typeof wins !== 'number' || played <= 0) return EM_DASH;
  return `${((wins / played) * 100).toFixed(1)}% (${formatInt(wins)}/${formatInt(played)})`;
}

/**
 * @param {number|string|null|undefined} value
 * @returns {string} grouped integer, or an em dash.
 */
export function formatInt(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return EM_DASH;
  return groupThousands(String(Math.trunc(n)));
}

/**
 * Basis points as a percentage: `250` -> `"2.5%"`.
 * @param {number|null|undefined} bps
 * @returns {string}
 */
export function formatBps(bps) {
  if (typeof bps !== 'number' || !Number.isFinite(bps)) return EM_DASH;
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

/**
 * @param {number|null|undefined} ms
 * @returns {string} local `HH:MM:SS`.
 */
export function formatClockTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return EM_DASH;
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * @param {number|null|undefined} ms
 * @returns {string} local `YYYY-MM-DD HH:MM:SS`.
 */
export function formatDateTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return EM_DASH;
  const d = new Date(ms);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/**
 * @param {number|null|undefined} ts
 * @param {number} [now]
 * @returns {string} `"just now"`, `"12s ago"`, `"3m ago"`, `"2h ago"`, `"4d ago"`.
 */
export function formatRelative(ts, now = Date.now()) {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return EM_DASH;
  const delta = Math.max(0, now - ts);
  const s = Math.floor(delta / 1000);
  if (s < 2) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * @param {number|null|undefined} seconds
 * @returns {string} `"2d 3h 4m 5s"` (largest three units).
 */
export function formatUptime(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return EM_DASH;
  const total = Math.floor(seconds);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (d > 0 || h > 0) parts.push(`${h}h`);
  if (d > 0 || h > 0 || m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

/**
 * Countdown for the action clock (FR-3.5 / FR-7.2).
 *
 * @param {number|null|undefined} remainingMs
 * @returns {string} `"12.4s"`, `"1m 05s"`, `"0.0s"` when expired, `—` for null.
 */
export function formatCountdown(remainingMs) {
  if (typeof remainingMs !== 'number' || !Number.isFinite(remainingMs)) return EM_DASH;
  const clamped = Math.max(0, remainingMs);
  const totalSeconds = clamped / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`;
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${m}m ${pad2(s)}s`;
}

/**
 * @param {string|null|undefined} hex
 * @param {number} [head]
 * @param {number} [tail]
 * @returns {string} abbreviated hash/address, e.g. `0x1234…cdef`.
 */
export function shortHex(hex, head = 10, tail = 6) {
  if (typeof hex !== 'string' || hex === '') return EM_DASH;
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}\u2026${hex.slice(-tail)}`;
}

/**
 * @param {string|null|undefined} text
 * @param {number} [max]
 * @returns {string}
 */
export function truncate(text, max = 60) {
  if (typeof text !== 'string') return EM_DASH;
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}

/**
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}
