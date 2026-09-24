/**
 * Shared constants for the monitor site.
 *
 * Everything here is either frozen by the server contract (asset/API paths) or
 * mirrored from `packages/shared/src/types.ts`.
 */

/** 1 token = 1e18 chips (base units) — `CHIP_DECIMALS` in shared. */
export const CHIP_DECIMALS = 18;

/** 6-max tables (FR-3.1). Seat indices are `0..MAX_SEATS-1`. */
export const MAX_SEATS = 6;

/** Read-only JSON API root (no auth, FR-7.6). */
export const API_BASE = '/api/v1';

/** Monitor WebSocket endpoint — no query string (frozen contract). */
export const WS_PATH = '/api/v1/ws';

/**
 * The **built** `@llmpoker/shared` ESM bundle, served by the server. The
 * browser imports this at runtime (dynamic `import()`) to recompute the shuffle
 * proof. It may not exist yet on a fresh checkout — every caller must degrade
 * gracefully (see `vendor.js`).
 */
export const VENDOR_SHARED_URL = '/vendor/shared/index.js';

/** Polling fallback while the WebSocket is down (FR-7.5). */
export const POLL_INTERVAL_MS = 3000;

/** `PING` cadence on the monitor socket. */
export const PING_INTERVAL_MS = 15000;

/** Tear down and reconnect if the socket goes quiet for this long (staleness guard). */
export const SOCKET_SILENCE_TIMEOUT_MS = 40000;

/** Reconnect backoff bounds. */
export const RECONNECT_MIN_MS = 500;
export const RECONNECT_MAX_MS = 10000;

/** After this many consecutive failures the indicator reads `OFFLINE` (still retrying). */
export const OFFLINE_AFTER_ATTEMPTS = 5;

/** Default page size for the hand-history browser. */
export const HANDS_PAGE_SIZE = 25;

/** Dashboard "latest hands" size. */
export const DASHBOARD_HANDS = 10;

/** Chain id of the settlement chain (Robinhood Chain, SRS §2). */
export const EXPECTED_CHAIN_ID = 4663;
