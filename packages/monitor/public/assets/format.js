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
 * Parses a **user-entered token amount** (what a human types in a form, e.g.
 * `"1500.25"`) into chip base units, exactly.
 *
 * Returns `null` — never a rounded value — when the text is not a plain
 * non-negative decimal, when it has more fraction digits than the token has
 * decimals, or when it is absurdly long. Refusing beats silently sending a
 * different amount than the user typed.
 *
 * @param {string} text
 * @param {number} [decimals]
 * @returns {bigint|null}
 */
export function parseTokenInput(text, decimals = CHIP_DECIMALS) {
  if (typeof text !== 'string') return null;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const trimmed = text.replace(/[,\s_]/g, '');
  if (trimmed === '' || trimmed.length > 80) return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const dot = trimmed.indexOf('.');
  const whole = dot === -1 ? trimmed : trimmed.slice(0, dot);
  const frac = dot === -1 ? '' : trimmed.slice(dot + 1);
  if (frac.length > decimals) return null;
  const padded = frac.padEnd(decimals, '0');
  const base = 10n ** BigInt(decimals);
  try {
    return BigInt(whole) * base + BigInt(padded === '' ? '0' : padded);
  } catch {
    return null;
  }
}

/**
 * Chip base units for one of the API's **minimum/threshold** fields.
 *
 * Ambiguity, stated honestly: `llm.txt` says every chip amount is an 18-decimal
 * base-unit string, but the published `/api/v1/health` example shows
 * `freeGameMinTokens: "50000"`, which reads as *whole tokens*. Instead of ever
 * `Number()`-rounding a balance, the reading is chosen by digit count: a value
 * with at least `decimals` digits is base units, a shorter bare integer is whole
 * tokens. Callers should always show the raw server string in a `title`, so a
 * visitor can see exactly what the API published.
 *
 * @param {unknown} value
 * @param {number} [decimals]
 * @returns {bigint|null} `null` when the value is not parseable at all
 */
export function minimumToChips(value, decimals = CHIP_DECIMALS) {
  const normalized = typeof value === 'string' ? value.replace(/[,\s_]/g, '') : value;
  const parsed = parseChips(normalized);
  if (parsed === null) return null;
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  if (parsed < 0n) return parsed;
  if (/^\d+$/.test(String(normalized)) && String(normalized).length < decimals) {
    return parsed * 10n ** BigInt(decimals);
  }
  return parsed;
}

/**
 * Renders a minimum/threshold field with {@link minimumToChips} + {@link formatTokens}.
 *
 * @param {unknown} value
 * @param {number} [decimals]
 * @returns {string} e.g. `"50,000"`, or an em dash when the value is unusable
 */
export function formatMinimumTokens(value, decimals = CHIP_DECIMALS) {
  const chips = minimumToChips(value, decimals);
  if (chips === null) return EM_DASH;
  return formatTokens(chips, { decimals, maxFractionDigits: 0 });
}

// ---------------------------------------------------------------------------
// Money: "how many decimals does this amount have?" (single source of truth)
// ---------------------------------------------------------------------------

/**
 * The whole money rule of the monitor, in one place.
 *
 * **Free-mode chips are whole play chips**, one base unit each: the API returns
 * `totalPot: "3"`, `stack: "413"`, `autoTopUp: "10000"`. A wager table settles in
 * a real ERC-20 whose decimals are its own (`USDG` = 6 here, `LLMPOKER` = 18), so
 * the same `"3"` on a wager table would mean `0.000003`. Dividing a free pot by
 * 1e18 renders it as `0.000000000000000003` — which is the bug this function
 * exists to make impossible: **every money render site asks this helper instead
 * of assuming a decimals count.**
 *
 * The rule, by table:
 *
 * | table | decimals |
 * |---|---|
 * | `mode === 'FREE'` (and everything derived from it: stacks, committed, pot, bets, play chips, the free leaderboard) | `0` |
 * | `mode === 'WAGER'` with `settlementCurrency === 'USDG'` | `tokenomics.wagerCurrencies[USDG].decimals`, else `6` |
 * | `mode === 'WAGER'` with `settlementCurrency === 'TOKEN'` / `null` | `tokenomics.tokenDecimals`, else `18` |
 *
 * The context is read as a priority chain:
 *  1. an explicit `decimals` option (a response that reports its own, e.g. `/health`);
 *  2. the per-page {@link setMoneyContext} (set from `/api/v1/health` by `renderChrome`);
 *  3. the module default ({@link CHIP_DECIMALS}).
 *
 * @param {unknown} table a `TableConfig` / `TableSnapshot` / `HandSummary` / `HandHistory`, a bare `Mode` string, or nothing at all
 * @param {{decimals?: number|null, tokenomics?: TokenomicsLike|null, context?: MoneyContext|null}} [options]
 * @returns {number} a plain integer `0..36`; never `NaN`, never negative
 */
export function decimalsForTable(table, options = {}) {
  if (typeof options.decimals === 'number' && Number.isInteger(options.decimals) && options.decimals >= 0 && options.decimals <= 36) {
    return options.decimals;
  }

  const source = tableOrSnapshot(table);
  const context = normalizeContext(options.context ?? options.tokenomics ?? moneyContext ?? null);
  const tokenomics = context === null ? null : context.tokenomics;

  // A free table's amounts are whole play chips. This is the whole of the fix:
  // 0 decimals, and free chips can never be read as a token amount.
  if (source.mode === 'FREE') return 0;

  if (source.mode === 'WAGER') {
    const currency = typeof source.currency === 'string' ? source.currency.trim().toUpperCase() : '';
    if (currency === 'USDG') return currencyDecimals(tokenomics, 'USDG', 6);
    // TOKEN (LLMPOKER) — the documented default when the config names no currency.
    return integerOr(tokenomics?.tokenDecimals, CHIP_DECIMALS);
  }

  // No table at all: the context's own decimals, then the chain's token.
  return integerOr(tokenomics?.tokenDecimals, CHIP_DECIMALS);
}

/**
 * A formatter for one table's amounts, taken from the table (or hand) itself.
 * Every render site should use this: `tableMoney(table).el(chips)` cannot forget
 * the rule, because the amount's context travels with it.
 *
 * `el()` defers to `ui.moneyEl` — the single DOM money renderer — through a late
 * binding (no static import, so `format.js` stays free of DOM *and* free of a
 * cycle with `ui.js`); a Node test can call `format()`/`text()` and never needs a
 * `document`.
 *
 * @param {unknown} table a `TableConfig` / `TableSnapshot` / `HandSummary` / `HandHistory`, a bare `Mode` string, or nothing
 * @param {{decimals?: number|null, tokenomics?: TokenomicsLike|null, context?: MoneyContext|null}} [options]
 * @returns {TableMoney}
 */
export function tableMoney(table, options = {}) {
  const decimals = decimalsForTable(table, options);
  return {
    decimals,
    isFree: decimals === 0 && modeOf(table) === 'FREE',
    format: (chips, formatOptions) => formatTokens(chips, { ...formatOptions, decimals }),
    text: (chips) => chipsToTokenString(chips, decimals),
    el: (chips, elementOptions) => moneyElement(chips, { ...elementOptions, decimals }),
  };
}

/**
 * Overridable so a Node test of the pure modules does not need a DOM. `ui.js`
 * (which owns `moneyEl`) or a test can replace it with a plain string renderer.
 *
 * @type {(chips: unknown, options: {decimals: number, maxFractionDigits?: number, signed?: boolean, className?: string}) => any}
 */
let moneyElement = (chips, options) => formatTokens(chips, options);

/**
 * The tokenomics/context the decimals rule reads. Set once per page from
 * `/api/v1/health` by `ui.renderChrome()`, so a `WAGER` table's currency decimals
 * are known even on a page that never fetches `/health` itself.
 *
 * @param {{tokenomics?: TokenomicsLike|null}|null} context
 * @returns {void}
 */
export function setMoneyContext(context) {
  moneyContext = normalizeContext(context);
}

/** @type {MoneyContext|null} */
let moneyContext = null;

/**
 * @typedef {Object} TokenomicsLike
 * @property {number} [tokenDecimals]
 * @property {{symbol?: string, decimals?: number}[]} [wagerCurrencies]
 */

/**
 * @typedef {Object} MoneyContext
 * @property {TokenomicsLike|null|undefined} [tokenomics]
 */

/**
 * @typedef {Object} TableMoney
 * @property {number} decimals
 * @property {boolean} isFree true when the amounts are whole play chips
 * @property {(chips: unknown, options?: {maxFractionDigits?: number, group?: boolean, signed?: boolean}) => string} format
 * @property {(chips: unknown, options?: {maxFractionDigits?: number, group?: boolean}) => string} text
 * @property {(chips: unknown, options?: {maxFractionDigits?: number, signed?: boolean, className?: string}) => HTMLElement} el
 */

/**
 * @param {unknown} value
 * @returns {{mode: string|null, currency: string|null}}
 */
function tableOrSnapshot(value) {
  if (typeof value === 'string') return { mode: value.toUpperCase(), currency: null };
  if (!value || typeof value !== 'object') return { mode: null, currency: null };
  const record = /** @type {Record<string, any>} */ (value);
  // A `HandHistory` carries its own table config, and a `HandSummary` is a row.
  const config = record.config && typeof record.config === 'object' ? record.config : record;
  const mode = typeof config.mode === 'string' ? config.mode.toUpperCase() : typeof record.mode === 'string' ? record.mode.toUpperCase() : null;
  const currency =
    typeof config.settlementCurrency === 'string'
      ? config.settlementCurrency
      : typeof record.settlementCurrency === 'string'
        ? record.settlementCurrency
        : null;
  return { mode, currency };
}

/**
 * @param {unknown} table
 * @returns {string|null}
 */
function modeOf(table) {
  return tableOrSnapshot(table).mode;
}

/**
 * @param {unknown} value
 * @returns {MoneyContext|null}
 */
function normalizeContext(value) {
  if (!value || typeof value !== 'object') return null;
  const record = /** @type {Record<string, any>} */ (value);
  const tokenomics = record.tokenomics && typeof record.tokenomics === 'object' ? record.tokenomics : record;
  return { tokenomics: /** @type {TokenomicsLike} */ (tokenomics) };
}

/**
 * @param {TokenomicsLike|null|undefined} tokenomics
 * @param {string} symbol
 * @param {number} fallback
 * @returns {number}
 */
function currencyDecimals(tokenomics, symbol, fallback) {
  const list = tokenomics && Array.isArray(tokenomics.wagerCurrencies) ? tokenomics.wagerCurrencies : [];
  const entry = list.find((candidate) => candidate && typeof candidate.symbol === 'string' && candidate.symbol.trim().toUpperCase() === symbol);
  return integerOr(entry?.decimals, fallback);
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function integerOr(value, fallback) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 36 ? value : fallback;
}

/**
 * Wires the real DOM money renderer in. Called once by `ui.js`, whose
 * `moneyEl()` is the monitor's only money element builder — so `tableMoney().el()`
 * and a direct `moneyEl()` call can never drift apart in styling or in the
 * `title` that carries the raw base-unit string.
 *
 * @param {(chips: unknown, options: {decimals: number, maxFractionDigits?: number, signed?: boolean, className?: string}) => any} renderer
 * @returns {void}
 */
export function setMoneyElement(renderer) {
  if (typeof renderer === 'function') moneyElement = renderer;
}

/**
 * `12345` -> `"12.1 kB"`, `1234567` -> `"1.2 MB"`. Used for the size note on a
 * fetched document; a byte count is a wire fact, not an estimate.
 *
 * @param {unknown} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return EM_DASH;
  if (bytes < 1024) return `${Math.trunc(bytes)} B`;
  const units = ['kB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Reads a Unix timestamp and normalises it to **milliseconds**.
 *
 * Documented guess: project convention (`llm.txt`) is milliseconds, but an
 * on-chain `unlockAt` is usually seconds. A value below `1e12` (i.e. before the
 * year 33658 in ms, but a plausible seconds timestamp) is therefore read as
 * seconds. Returns `null` for anything unusable, so a countdown renders as an
 * em dash instead of 1970.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function toTimestampMs(value) {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed < 1e12 ? parsed * 1000 : parsed;
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
 * Basis points as a percentage: `250` -> `"2.5%"`, `1` -> `"0.01%"`.
 * @param {number|null|undefined} bps
 * @returns {string}
 */
export function formatBps(bps) {
  if (typeof bps !== 'number' || !Number.isFinite(bps)) return EM_DASH;
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
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
