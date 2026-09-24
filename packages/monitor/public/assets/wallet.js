/**
 * EIP-1193 wallet module — the only place the site touches `window.ethereum`.
 *
 * Safety model:
 *  * **the site never holds a key and never signs anything by itself.** Every
 *    `request()` prompt happens inside the user's own wallet, and only after an
 *    explicit click;
 *  * every provider failure becomes a `WalletError` with a human-readable
 *    message. A missing wallet and a rejected prompt are *expected* states, so
 *    `connect()` resolves to `null` with `walletState.error` set rather than
 *    throwing — no page ever renders a stack trace;
 *  * no secret, no address and no chain id is ever read from anywhere except the
 *    provider's own answers.
 *
 * The module is pure state + provider plumbing: it renders nothing.
 */

import { shortHex } from './format.js';

/** @typedef {import('./types.js').ChainMetadata} ChainMetadata */

/** Message shown for the "no wallet installed" state (also used by the header button). */
export const NO_WALLET_MESSAGE =
  'No browser wallet was detected on this page. Install an EIP-1193 wallet (for example MetaMask), then reload.';

/** How long `waitForReceipt()` keeps polling before it reports "still pending". */
export const RECEIPT_TIMEOUT_MS = 120000;

/** Poll interval for `eth_getTransactionReceipt`. */
const RECEIPT_POLL_MS = 2500;

/**
 * The minimal EIP-1193 surface this module uses. Deliberately structural: any
 * injected wallet that implements `request()` works, and nothing here depends on
 * a vendor-specific global.
 *
 * @typedef {Object} Eip1193Provider
 * @property {(args: {method: string, params?: unknown[]}) => Promise<any>} request
 * @property {((event: string, handler: (...args: any[]) => void) => void)} [on]
 * @property {((event: string, handler: (...args: any[]) => void) => void)} [removeListener]
 */

/**
 * A wallet failure with a message that is safe to render (never a raw provider
 * object).
 */
export class WalletError extends Error {
  /**
   * @param {string} message human-readable and safe to show
   * @param {string} code stable code: `NO_WALLET` | `USER_REJECTED` | `PENDING_REQUEST` |
   *   `CHAIN_MISSING` | `BAD_CHAIN` | `NO_CHAIN` | `BAD_ADDRESS` | `BAD_CALLDATA` |
   *   `BAD_VALUE` | `NO_RECEIPT` | `RPC_ERROR`
   */
  constructor(message, code) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

/**
 * @typedef {Object} WalletState
 * @property {boolean} available an EIP-1193 provider was detected
 * @property {boolean} connected the wallet returned at least one account
 * @property {string|null} address the active account, 0x-prefixed
 * @property {number|null} chainId the wallet's current chain, as a number
 * @property {boolean} connecting a connect prompt is open
 * @property {string|null} error last human-readable failure, or `null`
 */

/** Live wallet state. Read it, never mutate it from outside this module. */
/** @type {WalletState} */
export const walletState = {
  available: false,
  connected: false,
  address: null,
  chainId: null,
  connecting: false,
  error: null,
};

/** @type {Set<(state: WalletState) => void>} */
const listeners = new Set();

/** @type {boolean} */
let eventsWired = false;

/**
 * @param {(state: WalletState) => void} listener
 * @returns {() => void} unsubscribe
 */
export function subscribeWallet(listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify() {
  for (const listener of Array.from(listeners)) {
    try {
      listener(walletState);
    } catch (err) {
      console.error('[wallet] listener failed', err);
    }
  }
}

/**
 * `window.ethereum`, when it looks like an EIP-1193 provider.
 *
 * @returns {Eip1193Provider|null}
 */
export function getProvider() {
  const holder = /** @type {{ethereum?: Eip1193Provider|null}} */ (/** @type {any} */ (window));
  const candidate = holder?.ethereum ?? null;
  return candidate && typeof candidate.request === 'function' ? candidate : null;
}

/** @returns {boolean} */
export function hasProvider() {
  return getProvider() !== null;
}

/**
 * @returns {Eip1193Provider}
 * @throws {WalletError} `NO_WALLET` when nothing is injected
 */
function requireProvider() {
  const provider = getProvider();
  if (!provider) {
    walletState.available = false;
    walletState.error = NO_WALLET_MESSAGE;
    notify();
    throw new WalletError(NO_WALLET_MESSAGE, 'NO_WALLET');
  }
  walletState.available = true;
  return provider;
}

/**
 * @param {unknown} value
 * @returns {boolean} true for a 0x-prefixed 20-byte hex address
 */
export function isAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * @param {string|null|undefined} address
 * @returns {string} `0x1234…abcd`, or an em dash
 */
export function shortAddress(address) {
  if (typeof address !== 'string' || address === '') return '\u2014';
  return shortHex(address, 6, 4);
}

/**
 * @param {unknown} value chain id as `0x…` hex or a number
 * @returns {number|null}
 */
export function parseChainId(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value)) {
    const parsed = Number.parseInt(value, 16);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * `value` as a `0x` hex quantity. Chip amounts arrive as decimal strings and are
 * converted with `BigInt` — never `Number()`.
 *
 * @param {unknown} value decimal string, `0x` string, safe integer, or null
 * @returns {string}
 * @throws {WalletError} `BAD_VALUE` when the value is not a non-negative integer
 */
export function toHexQuantity(value) {
  if (value === null || value === undefined || value === '') return '0x0';
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new WalletError('The server returned a non-integer transaction value — refusing to send anything.', 'BAD_VALUE');
    }
    return `0x${value.toString(16)}`;
  }
  const text = String(value).trim();
  if (/^0x[0-9a-fA-F]+$/.test(text)) return text;
  if (!/^\d+$/.test(text)) {
    throw new WalletError('The server returned a non-numeric transaction value — refusing to send anything.', 'BAD_VALUE');
  }
  try {
    return `0x${BigInt(text).toString(16)}`;
  } catch {
    throw new WalletError('The server returned an unreadable transaction value — refusing to send anything.', 'BAD_VALUE');
  }
}

/**
 * @param {unknown} err
 * @returns {number|null} the provider's numeric error code, if any
 */
function errorCode(err) {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = /** @type {{code?: unknown}} */ (err).code;
    if (typeof code === 'number') return code;
  }
  return null;
}

/**
 * @param {unknown} err
 * @returns {WalletError} always renderable
 */
function toWalletError(err) {
  if (err instanceof WalletError) return err;
  const code = errorCode(err);
  const message = err instanceof Error ? err.message : String(err);
  if (code === 4001 || /user (rejected|denied|refused)/i.test(message)) {
    return new WalletError('You rejected the request in your wallet — nothing was sent.', 'USER_REJECTED');
  }
  if (code === -32002) {
    return new WalletError('Your wallet already has a pending request — open it and finish that one first.', 'PENDING_REQUEST');
  }
  if (code === 4902 || /unrecognized chain|unknown chain|try adding the chain/i.test(message)) {
    return new WalletError('Your wallet does not know this chain yet.', 'CHAIN_MISSING');
  }
  return new WalletError(`The wallet returned an error: ${message}`, 'RPC_ERROR');
}

/**
 * Adopts whatever `eth_accounts` / `eth_requestAccounts` returned.
 *
 * @param {unknown} accounts
 * @returns {void}
 */
function applyAccounts(accounts) {
  const list = Array.isArray(accounts) ? accounts : [];
  const first = list.length > 0 ? list[0] : null;
  if (isAddress(first)) {
    walletState.address = first;
    walletState.connected = true;
  } else {
    walletState.address = null;
    walletState.connected = false;
  }
}

/**
 * @param {Eip1193Provider} provider
 * @returns {Promise<number|null>}
 */
async function readChainId(provider) {
  try {
    const value = await provider.request({ method: 'eth_chainId' });
    return parseChainId(value);
  } catch {
    return null;
  }
}

/**
 * Subscribes to the provider's own events once.
 *
 * @param {Eip1193Provider} provider
 * @returns {void}
 */
function wireEvents(provider) {
  if (eventsWired || typeof provider.on !== 'function') return;
  eventsWired = true;
  provider.on('accountsChanged', (accounts) => {
    applyAccounts(accounts);
    walletState.error = null;
    notify();
  });
  provider.on('chainChanged', (value) => {
    walletState.chainId = parseChainId(value);
    walletState.error = null;
    notify();
  });
  provider.on('disconnect', () => {
    walletState.connected = false;
    walletState.address = null;
    walletState.chainId = null;
    walletState.error = 'The wallet disconnected this page.';
    notify();
  });
}

/**
 * Restores an existing connection **without prompting** (`eth_accounts`). Safe
 * to call on every page load; resolves to the current address or `null`.
 *
 * @returns {Promise<{address: string, chainId: number|null}|null>}
 */
export async function restore() {
  const provider = getProvider();
  walletState.available = provider !== null;
  if (!provider) {
    walletState.connected = false;
    walletState.address = null;
    notify();
    return null;
  }
  wireEvents(provider);
  try {
    applyAccounts(await provider.request({ method: 'eth_accounts' }));
    walletState.chainId = await readChainId(provider);
    if (walletState.connected && walletState.address) {
      return { address: walletState.address, chainId: walletState.chainId };
    }
  } catch (err) {
    walletState.error = toWalletError(err).message;
  }
  notify();
  return null;
}

/**
 * Asks the wallet to connect (`eth_requestAccounts`) and reads its chain id.
 *
 * Never throws: "no wallet installed" and "user rejected" are normal outcomes.
 * Read `walletState.error` for the reason.
 *
 * @returns {Promise<{address: string, chainId: number|null}|null>}
 */
export async function connect() {
  const provider = getProvider();
  walletState.available = provider !== null;
  if (!provider) {
    walletState.connected = false;
    walletState.address = null;
    walletState.error = NO_WALLET_MESSAGE;
    notify();
    return null;
  }
  wireEvents(provider);
  walletState.connecting = true;
  walletState.error = null;
  notify();
  try {
    applyAccounts(await provider.request({ method: 'eth_requestAccounts' }));
    walletState.chainId = await readChainId(provider);
    if (!walletState.connected || !walletState.address) {
      walletState.error = 'The wallet returned no account — nothing is connected.';
      return null;
    }
    return { address: walletState.address, chainId: walletState.chainId };
  } catch (err) {
    const wrapped = toWalletError(err);
    walletState.connected = false;
    walletState.address = null;
    walletState.error = wrapped.message;
    return null;
  } finally {
    walletState.connecting = false;
    notify();
  }
}

/**
 * Clears this page's local view of the connection.
 *
 * The site cannot revoke a wallet's own authorization: the account stays
 * authorized inside the wallet until the user disconnects there. This only
 * forgets it here (and a reload may reconnect silently).
 *
 * @returns {void}
 */
export function forget() {
  walletState.connected = false;
  walletState.address = null;
  walletState.chainId = null;
  walletState.error = null;
  notify();
}

/**
 * Switches the wallet to `chain`, adding it first when the wallet has never
 * seen it (`4902`) and the API published an RPC URL.
 *
 * @param {ChainMetadata|null|undefined} chain the `chain` object from `/api/v1/health`
 * @returns {Promise<void>}
 * @throws {WalletError} with a renderable message (`NO_CHAIN`, `CHAIN_MISSING`, `BAD_CHAIN`, …)
 */
export async function ensureChain(chain) {
  const provider = requireProvider();
  if (!chain || typeof chain.chainId !== 'number') {
    throw new WalletError(
      'This page does not know which chain to use yet — /api/v1/health has not answered. Retry in a moment.',
      'NO_CHAIN',
    );
  }
  const target = `0x${chain.chainId.toString(16)}`;
  const current = await readChainId(provider);
  if (current === chain.chainId) return;

  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: target }] });
  } catch (err) {
    const wrapped = toWalletError(err);
    if (wrapped.code !== 'CHAIN_MISSING') throw wrapped;
    if (!chain.rpcUrl) {
      // Refusing with an explanation beats sending an add-chain request with a
      // made-up RPC URL.
      throw new WalletError(
        `${chain.name} (chain id ${chain.chainId}) is not in your wallet, and the platform has not published a ` +
          'public RPC URL yet, so this site cannot add the network for you. Add it in your wallet manually, then reload.',
        'CHAIN_MISSING',
      );
    }
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: target,
          chainName: chain.name,
          rpcUrls: [chain.rpcUrl],
          nativeCurrency: chain.nativeCurrency,
          blockExplorerUrls: chain.explorerUrl ? [chain.explorerUrl] : [],
        },
      ],
    });
  }

  const after = await readChainId(provider);
  if (after !== chain.chainId) {
    throw new WalletError(
      `Your wallet is still on chain ${after ?? 'unknown'} — switch it to ${chain.name} (chain id ${chain.chainId}) to continue.`,
      'BAD_CHAIN',
    );
  }
}

/**
 * Sends a **server-encoded** transaction through the wallet.
 *
 * `to`/`data`/`value` come from `/api/v1/staking/tx` and are passed through
 * unchanged: this module never assembles calldata. Requires an explicit user
 * click upstream — nothing here prompts on its own.
 *
 * @param {{to?: unknown, data?: unknown, value?: unknown}} tx
 * @returns {Promise<string>} the transaction hash
 * @throws {WalletError} `NO_WALLET` | `BAD_ADDRESS` | `BAD_CALLDATA` | `BAD_VALUE` | `USER_REJECTED` | `RPC_ERROR`
 */
export async function sendTransaction(tx) {
  const provider = requireProvider();
  const from = walletState.address;
  if (!from || !walletState.connected) {
    throw new WalletError('Connect a wallet first — there is no address to send from.', 'NO_WALLET');
  }
  if (!isAddress(tx?.to)) {
    throw new WalletError(
      'The server did not return a valid contract address for this action — refusing to send anything.',
      'BAD_ADDRESS',
    );
  }
  if (typeof tx.data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(tx.data)) {
    throw new WalletError(
      'The server did not return valid transaction data for this action — refusing to send anything.',
      'BAD_CALLDATA',
    );
  }
  const value = toHexQuantity(tx.value);
  try {
    const hash = await provider.request({
      method: 'eth_sendTransaction',
      params: [{ from, to: tx.to, data: tx.data, value }],
    });
    if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
      throw new WalletError('The wallet returned no transaction hash — check the wallet for the pending transaction.', 'NO_RECEIPT');
    }
    return hash;
  } catch (err) {
    throw toWalletError(err);
  }
}

/**
 * Reads the native balance as a **decimal string** of the chain's smallest unit
 * (`BigInt`, never `Number`).
 *
 * @param {string} address
 * @returns {Promise<string|null>} `null` when it cannot be read
 */
export async function readNativeBalance(address) {
  const provider = getProvider();
  if (!provider || !isAddress(address)) return null;
  try {
    const hex = await provider.request({ method: 'eth_getBalance', params: [address, 'latest'] });
    if (typeof hex !== 'string' || !/^0x[0-9a-fA-F]+$/.test(hex)) return null;
    return BigInt(hex).toString();
  } catch {
    return null;
  }
}

/**
 * Waits for a receipt. Never throws: `null` means "still pending after the
 * timeout", which the page reports as pending rather than as a failure.
 *
 * @param {string} hash
 * @param {number} [timeoutMs]
 * @returns {Promise<{status: string|null}|null>}
 */
export async function waitForReceipt(hash, timeoutMs = RECEIPT_TIMEOUT_MS) {
  const provider = getProvider();
  if (!provider || typeof hash !== 'string' || hash === '') return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
      if (receipt && typeof receipt === 'object' && 'status' in receipt) {
        const status = /** @type {{status?: unknown}} */ (receipt).status;
        return { status: typeof status === 'string' ? status : null };
      }
    } catch {
      /* transient RPC error — keep polling until the deadline */
    }
    await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_MS));
  }
  return null;
}
