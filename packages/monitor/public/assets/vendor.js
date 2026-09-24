/**
 * Runtime loader for the built `@llmpoker/shared` ESM bundle.
 *
 * The monitor recomputes every RNG proof **in the browser** by calling the same
 * `verifyRngProof()` / `verifyHandDeal()` the server uses (FR-6.3, FR-7.3). The
 * bundle is served at `/vendor/shared/index.js`; on a checkout where the shared
 * package has not been built yet that URL 404s, so this module never throws at
 * import time — it resolves to `null` and callers render an explicit,
 * human-readable banner (FR-7.6).
 *
 * The specifier is intentionally a runtime variable rather than a static
 * import: a static `import '/vendor/shared/index.js'` would be a hard
 * load-time failure (blank page) and would also break `tsc --checkJs`, which
 * cannot resolve a server-only path.
 */

import { VENDOR_SHARED_URL } from './constants.js';

/** @typedef {any} SharedModule The shared bundle; typed `any` because it is resolved at runtime. */

/** @type {SharedModule|null} */
let shared = null;
/** @type {Error|null} */
let failure = null;
/** @type {Promise<SharedModule|null>|null} */
let pending = null;

/**
 * Loads the shared bundle once. Resolves to the module, or to `null` when it is
 * unavailable (never rejects).
 *
 * @returns {Promise<SharedModule|null>}
 */
export function loadShared() {
  if (pending === null) {
    pending = import(/* webpackIgnore: true */ VENDOR_SHARED_URL)
      .then((mod) => {
        shared = mod;
        failure = null;
        return /** @type {SharedModule} */ (mod);
      })
      .catch((err) => {
        failure = err instanceof Error ? err : new Error(String(err));
        shared = null;
        return null;
      });
  }
  return pending;
}

/** @returns {SharedModule|null} the bundle if it has already loaded. */
export function getShared() {
  return shared;
}

/** @returns {Error|null} why the bundle could not be loaded, if it could not. */
export function getSharedError() {
  return failure;
}

/**
 * Human-readable explanation for the "proof verification unavailable" banner.
 * @returns {string}
 */
export function sharedUnavailableMessage() {
  const detail = failure ? ` (${failure.message})` : '';
  return (
    `The shared proof module at ${VENDOR_SHARED_URL} could not be loaded${detail}. ` +
    'In-browser recomputation of the shuffle is disabled; the server verdict from ' +
    '/api/v1/verify/hands/:id is still shown, but it is not independently checked here.'
  );
}
