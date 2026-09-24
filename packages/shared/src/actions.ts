/**
 * The agent action grammar (SRS §7).
 *
 * ```
 * FOLD | CHECK | CALL | BET <amt> | RAISE <amt> | ALL_IN
 * ```
 *
 * `<amt>` is always an integer number of **chips** (base units, 1 token = 1e18
 * chips). For `BET` it is the total amount wagered this street; for `RAISE` it is
 * the **total** the seat will have committed this street (i.e. "raise *to*"),
 * which is the same convention the engine reports in `minRaiseTo`/`maxRaiseTo`.
 */

import type { Chips, PlayerAction } from './types.js';
import type { ActionType } from './types.js';

export const ACTIONS: readonly ActionType[] = ['FOLD', 'CHECK', 'CALL', 'BET', 'RAISE', 'ALL_IN'];

export const ACTION_GRAMMAR = 'FOLD | CHECK | CALL | BET <amt> | RAISE <amt> | ALL_IN';

export const AMOUNT_ACTIONS: readonly ActionType[] = ['BET', 'RAISE'];

export function isActionType(value: unknown): value is ActionType {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value.toUpperCase());
}

/** `"RAISE 120"` → `{ action: 'RAISE', amount: 120n }`. Case-insensitive. */
export function parseActionText(text: string): PlayerAction {
  const parts = text.trim().split(/\s+/);
  const head = parts[0]?.toUpperCase();
  if (head === undefined || !isActionType(head)) {
    throw new Error(`unknown action ${JSON.stringify(parts[0] ?? '')}; expected one of ${ACTION_GRAMMAR}`);
  }
  const amountText = parts[1];
  if (parts.length > 2) throw new Error(`unexpected trailing input in ${JSON.stringify(text)}`);
  if (AMOUNT_ACTIONS.includes(head)) {
    if (amountText === undefined) throw new Error(`${head} requires an amount, e.g. "${head} 120"`);
    if (!/^[0-9]+$/.test(amountText)) {
      throw new Error(`${head} amount must be an integer number of chips (got ${JSON.stringify(amountText)})`);
    }
    return { action: head, amount: BigInt(amountText) };
  }
  if (amountText !== undefined) throw new Error(`${head} takes no amount`);
  return { action: head };
}

/** `{ action: 'BET', amount: 120n }` → `"BET 120"`. */
export function formatActionText(action: PlayerAction): string {
  if (AMOUNT_ACTIONS.includes(action.action)) return `${action.action} ${action.amount ?? 0n}`;
  return action.action;
}

export interface ActionShapeResult {
  ok: boolean;
  error?: string;
  action?: PlayerAction;
}

/** Structural validation only — legality against the table is the engine's job. */
export function validateActionShape(input: unknown): ActionShapeResult {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'action must be an object' };
  const raw = input as { action?: unknown; amount?: unknown };
  const name = typeof raw.action === 'string' ? raw.action.toUpperCase() : undefined;
  if (name === undefined || !isActionType(name)) {
    return { ok: false, error: `unknown action; expected one of ${ACTION_GRAMMAR}` };
  }
  if (AMOUNT_ACTIONS.includes(name)) {
    if (raw.amount === undefined || raw.amount === null) return { ok: false, error: `${name} requires an amount` };
    let amount: Chips | null = null;
    if (typeof raw.amount === 'bigint') amount = raw.amount;
    else if (typeof raw.amount === 'number' && Number.isSafeInteger(raw.amount)) amount = BigInt(raw.amount);
    else if (typeof raw.amount === 'string' && /^[0-9]+$/.test(raw.amount)) amount = BigInt(raw.amount);
    if (amount === null) return { ok: false, error: 'amount must be an integer number of chips' };
    if (amount < 0n) return { ok: false, error: 'amount cannot be negative' };
    return { ok: true, action: { action: name, amount } };
  }
  if (raw.amount !== undefined && raw.amount !== null) {
    const a = String(raw.amount);
    if (a !== '0') return { ok: false, error: `${name} takes no amount` };
  }
  return { ok: true, action: { action: name } };
}
