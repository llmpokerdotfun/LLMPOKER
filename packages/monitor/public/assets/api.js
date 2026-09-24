/**
 * Read-only JSON API client for the monitor (FR-7.6 — no auth, no wallet).
 *
 * Every call rejects with an `ApiError` carrying a human-readable message, the
 * HTTP status (`0` for network/timeout) and a code, so pages can render an
 * error banner instead of a stack trace.
 */

import { API_BASE, WS_PATH } from './constants.js';

/** Default request timeout. */
export const REQUEST_TIMEOUT_MS = 12000;

export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status HTTP status, or `0` when the request never completed.
   * @param {string} code Stable machine code (`NETWORK`, `TIMEOUT`, `HTTP_404`, server code…).
   */
  constructor(message, status, code) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {Record<string, string|number|boolean|null|undefined>} params
 * @returns {string} `?a=1&b=2`, or `''` when nothing is set.
 */
export function buildQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs === '' ? '' : `?${qs}`;
}

/**
 * GET a JSON document.
 *
 * @param {string} path absolute path including any query string
 * @returns {Promise<any>}
 */
async function getJson(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  /** @type {Response} */
  let res;
  try {
    res = await fetch(path, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = controller.signal.aborted;
    const reason = err instanceof Error ? err.message : String(err);
    throw new ApiError(
      timedOut
        ? `Request timed out after ${REQUEST_TIMEOUT_MS} ms — ${path}`
        : `Network request failed (${reason}) — ${path}`,
      0,
      timedOut ? 'TIMEOUT' : 'NETWORK',
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    let message = `${res.status} ${res.statusText || 'request failed'} — ${path}`;
    try {
      const body = await res.json();
      if (body && typeof body === 'object' && body.error && typeof body.error.message === 'string') {
        message = body.error.message;
        if (typeof body.error.code === 'string') code = body.error.code;
      }
    } catch {
      /* body was not JSON — keep the status-line message */
    }
    throw new ApiError(message, res.status, code);
  }

  try {
    return await res.json();
  } catch {
    throw new ApiError(`Malformed JSON from ${path}`, res.status, 'BAD_JSON');
  }
}

/** `GET /api/v1/health` */
export function getHealth() {
  return getJson(`${API_BASE}/health`);
}

/** `GET /api/v1/monitor/agents` */
export function getAgents() {
  return getJson(`${API_BASE}/monitor/agents`);
}

/** `GET /api/v1/tables` */
export function getTables() {
  return getJson(`${API_BASE}/tables`);
}

/**
 * `GET /api/v1/tables/:id`
 * @param {string} tableId
 */
export function getTable(tableId) {
  return getJson(`${API_BASE}/tables/${encodeURIComponent(tableId)}`);
}

/**
 * `GET /api/v1/hands?limit&offset&tableId&agentId&mode`
 *
 * @param {{limit?: number, offset?: number, tableId?: string, agentId?: string, mode?: string}} [query]
 */
export function getHands(query = {}) {
  return getJson(`${API_BASE}/hands${buildQuery(query)}`);
}

/**
 * `GET /api/v1/hands/:id` — `{ result, proof, deck }`
 * @param {string} handId
 */
export function getHand(handId) {
  return getJson(`${API_BASE}/hands/${encodeURIComponent(handId)}`);
}

/**
 * `GET /api/v1/leaderboards?mode=FREE|WAGER`
 * @param {'FREE'|'WAGER'} mode
 */
export function getLeaderboard(mode) {
  return getJson(`${API_BASE}/leaderboards${buildQuery({ mode })}`);
}

/**
 * `GET /api/v1/verify/hands/:id` — the server's own independent recomputation.
 * May legitimately 404 for a hand whose proof is not yet revealed.
 *
 * @param {string} handId
 */
export function getHandVerification(handId) {
  return getJson(`${API_BASE}/verify/hands/${encodeURIComponent(handId)}`);
}

/**
 * @returns {string} absolute `ws://`/`wss://` URL of the monitor feed.
 */
export function monitorSocketUrl() {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}${WS_PATH}`;
}
