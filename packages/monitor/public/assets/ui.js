/**
 * DOM toolkit: escaping, element construction, badges, banners, page chrome,
 * cards and the 1 Hz clock updater.
 *
 * Safety model: `h()` builds nodes with `createElement`/`textContent`, so
 * server-provided strings (agent names, table names, endpoints — all written by
 * third-party agents) can never become markup. `escapeHtml()` exists for the
 * few places where a template string is genuinely the clearest way to build
 * markup; every interpolation there goes through it.
 */

import { CHIP_DECIMALS, EXPECTED_CHAIN_ID } from './constants.js';
import {
  EM_DASH,
  cardIsRed,
  cardToString,
  chipsToTokenString,
  formatCountdown,
  formatRelative,
  formatTokens,
  setMoneyContext,
  setMoneyElement,
} from './format.js';
import { NO_WALLET_MESSAGE, connect, restore, shortAddress, subscribeWallet, walletState } from './wallet.js';

/** @type {Record<string, string>} */
const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes a value for interpolation into HTML text or a quoted attribute.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? '');
}

/**
 * Element builder.
 *
 * Supported props: `class`, `text`, `html` (escaped by the caller), `dataset`
 * (object), `style` (string), `on*` (function -> `addEventListener`), and any
 * other attribute name. `null`/`undefined`/`false` props are skipped.
 *
 * @param {string} tag
 * @param {Record<string, any>|null} [props]
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const node = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = String(value);
      else if (key === 'text') node.textContent = String(value);
      else if (key === 'html') node.innerHTML = String(value);
      else if (key === 'dataset' && typeof value === 'object') {
        for (const [dataKey, dataValue] of Object.entries(value)) {
          if (dataValue === null || dataValue === undefined) continue;
          node.dataset[dataKey] = String(dataValue);
        }
      } else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else {
        node.setAttribute(key, value === true ? '' : String(value));
      }
    }
  }
  appendChildren(node, children);
  return node;
}

/**
 * @param {Node} node
 * @param {any[]} children
 * @returns {void}
 */
export function appendChildren(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (Array.isArray(child)) {
      appendChildren(node, child);
      continue;
    }
    if (child instanceof Node) node.appendChild(child);
    else node.appendChild(document.createTextNode(String(child)));
  }
}

/**
 * @param {Element|null|undefined} node
 * @returns {void}
 */
export function clearNode(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {HTMLElement|null}
 */
export function qs(selector, root = document) {
  const found = root.querySelector(selector);
  return found instanceof HTMLElement ? found : null;
}

/**
 * Fetches a required mount point from the page skeleton. Throwing here (with
 * the id in the message) beats a silent `null` later in a render pass.
 *
 * @param {string} id element id, without `#`
 * @returns {HTMLElement}
 */
export function requireElement(id) {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLElement)) {
    throw new Error(`monitor page skeleton is missing #${id}`);
  }
  return node;
}

/**
 * @param {Element|null|undefined} node
 * @param {unknown} value
 * @returns {void}
 */
export function setText(node, value) {
  if (node) node.textContent = value === null || value === undefined ? EM_DASH : String(value);
}

// ---------------------------------------------------------------------------
// Badges and tags
// ---------------------------------------------------------------------------

/** @type {Record<string, string>} */
const STATUS_KIND = {
  IDLE: 'muted',
  SEATED: 'info',
  THINKING: 'active',
  FOLDED: 'muted',
  BUSTED: 'danger',
  OFFLINE: 'offline',
  OPEN: 'info',
  RUNNING: 'active',
  PAUSED: 'warn',
  CLOSED: 'muted',
  EMPTY: 'muted',
  SITTING_OUT: 'warn',
  ACTIVE: 'active',
  ALL_IN: 'warn',
  AGENT: 'muted',
  TIMEOUT: 'warn',
  ENGINE: 'info',
};

/**
 * @param {string} label
 * @param {string} kind CSS suffix (`badge-<kind>`)
 * @param {string} [title]
 * @returns {HTMLElement}
 */
export function badge(label, kind, title) {
  return h('span', { class: `badge badge-${kind}`, title: title ?? null, text: label });
}

/**
 * @param {string|null|undefined} status
 * @returns {HTMLElement}
 */
export function statusBadge(status) {
  const value = status ?? 'UNKNOWN';
  return badge(value, STATUS_KIND[value] ?? 'muted');
}

/** Past this age an agent is a ghost: still seated, no longer playing. */
export const STALE_AFTER_MS = 60_000;
/** Below this an agent merely looks slow rather than gone. */
export const QUIET_AFTER_MS = 15_000;

/**
 * `"42s ago"`, `"12m ago"`, `"3h ago"`.
 *
 * @param {number} age milliseconds since the agent was last heard from
 * @returns {string}
 */
function ageLabel(age) {
  const seconds = Math.max(0, Math.round(age / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/**
 * How recently we heard from an agent.
 *
 * This exists to make a dead-but-seated agent visible. The engine keeps dealing
 * such a seat in and it keeps timing out, and without this it looks identical to
 * a live agent that simply folded. Status is never colour-only: each state also
 * carries a word.
 *
 * @param {number|null|undefined} lastSeenAt epoch ms, or null if never seen
 * @param {number} [now]
 * @returns {HTMLElement}
 */
export function freshnessBadge(lastSeenAt, now = Date.now()) {
  if (lastSeenAt === null || lastSeenAt === undefined) {
    return badge('no contact', 'danger', 'this agent has never been heard from');
  }
  const age = now - lastSeenAt;
  if (age > STALE_AFTER_MS) return badge('not responding', 'danger', `last heard from ${ageLabel(age)}`);
  if (age > QUIET_AFTER_MS) return badge('quiet', 'warn', `last heard from ${ageLabel(age)}`);
  return badge('live', 'active', `last heard from ${ageLabel(age)}`);
}

/**
 * True when an agent has gone quiet long enough to be treated as gone.
 *
 * @param {number|null|undefined} lastSeenAt epoch ms, or null if never seen
 * @param {number} [now]
 * @returns {boolean}
 */
export function isStale(lastSeenAt, now = Date.now()) {
  return lastSeenAt === null || lastSeenAt === undefined || now - lastSeenAt > STALE_AFTER_MS;
}

/**
 * @param {string|null|undefined} mode
 * @returns {HTMLElement}
 */
export function modeTag(mode) {
  if (mode !== 'FREE' && mode !== 'WAGER') return badge('—', 'muted');
  return badge(mode, mode === 'WAGER' ? 'wager' : 'free', mode === 'WAGER' ? 'On-chain token table' : 'Off-chain play chips');
}

/**
 * @param {string} label
 * @param {boolean} ok
 * @param {string} [title]
 * @returns {HTMLElement}
 */
export function boolBadge(label, ok, title) {
  return badge(label, ok ? 'verified' : 'failed', title);
}

/**
 * FR-6 lifecycle (`RngPhase`): short human label for each phase.
 *
 * @type {Record<string, string>}
 */
const RNG_PHASE_LABEL = {
  NONE: 'no commitment',
  SEED_COMMITTED: 'seed committed',
  DECK_COMMITTED: 'deck committed',
  AUDITED: 'audited',
  VOIDED: 'voided',
};

/** @type {Record<string, string>} */
const RNG_PHASE_KIND = {
  NONE: 'muted',
  SEED_COMMITTED: 'info',
  DECK_COMMITTED: 'active',
  AUDITED: 'verified',
  VOIDED: 'failed',
};

/** @type {Record<string, string>} */
const RNG_PHASE_TITLE = {
  NONE: 'FR-6: no seed commitment published for this hand yet',
  SEED_COMMITTED: 'FR-6.1: commitment published — the seed itself is still secret',
  DECK_COMMITTED: 'FR-6.2: the salted-deck Merkle root is committed — ordering and salts stay secret',
  AUDITED: 'FR-6.4: the hand ended and the audit published the seed, entropy, salts and deck ordering',
  VOIDED: 'FR-6.7: the hand was voided and publishes no ordering',
};

/**
 * @param {import('./types.js').RngPhase|string|null|undefined} phase
 * @returns {string} human label, `—` for an unknown/absent phase
 */
export function rngPhaseLabel(phase) {
  if (typeof phase !== 'string') return '\u2014';
  return RNG_PHASE_LABEL[phase] ?? phase;
}

/**
 * Badge for the FR-6 lifecycle phase of a hand.
 *
 * @param {import('./types.js').RngPhase|string|null|undefined} phase
 * @returns {HTMLElement}
 */
export function rngPhaseBadge(phase) {
  const key = typeof phase === 'string' ? phase : 'NONE';
  return badge(rngPhaseLabel(key), RNG_PHASE_KIND[key] ?? 'muted', RNG_PHASE_TITLE[key] ?? `phase = ${key}`);
}

// ---------------------------------------------------------------------------
// Cards and money
// ---------------------------------------------------------------------------

/**
 * Renders one card as a small face-up tile.
 *
 * @param {number} card card id `0..51`
 * @param {{muted?: boolean, title?: string, dim?: boolean}} [options]
 * @returns {HTMLElement}
 */
export function cardEl(card, options = {}) {
  const text = cardToString(card);
  const classes = ['card', cardIsRed(card) ? 'card-red' : 'card-black'];
  if (options.muted) classes.push('card-muted');
  if (options.dim) classes.push('card-dim');
  const html = `<span class="card-rank">${escapeHtml(text.slice(0, 1))}</span><span class="card-suit">${escapeHtml(text.slice(1))}</span>`;
  return h('span', {
    class: classes.join(' '),
    html,
    title: options.title ?? text,
  });
}

/**
 * @param {number[]|null|undefined} cards
 * @param {{muted?: boolean, dim?: boolean}} [options]
 * @returns {HTMLElement}
 */
export function cardRow(cards, options = {}) {
  if (!Array.isArray(cards) || cards.length === 0) {
    return h('span', { class: 'muted', text: EM_DASH });
  }
  return h(
    'span',
    { class: 'card-row' },
    cards.map((card) => cardEl(card, options)),
  );
}

/**
 * Face-down placeholders (hole cards that have not been revealed).
 *
 * @param {number} count
 * @returns {HTMLElement}
 */
export function faceDownCards(count) {
  const tiles = [];
  for (let i = 0; i < count; i++) {
    tiles.push(h('span', { class: 'card card-back', title: 'not revealed', 'aria-label': 'hidden card' }, h('span', { class: 'card-back-mark', text: '?' })));
  }
  return h('span', { class: 'card-row' }, tiles);
}

/**
 * Renders a chip amount. Always BigInt-exact; `title` carries the raw base-unit
 * string plus the decimals the amount was read with, so no precision — and no
 * unit — is ever hidden from a verifier.
 *
 * `decimals` must come from `format.decimalsForTable()` / `tableMoney()`: a free
 * table's amounts are whole play chips (`0`), a wager table's are the settlement
 * token's (`6` for USDG, `18` for LLMPOKER). Passing nothing means "18", which is
 * only right for a genuine token balance.
 *
 * @param {unknown} chips
 * @param {{maxFractionDigits?: number, signed?: boolean, className?: string, decimals?: number}} [options]
 *   `decimals` selects the unit; it is never used to round the value.
 * @returns {HTMLElement}
 */
export function moneyEl(chips, options = {}) {
  const decimals = typeof options.decimals === 'number' ? options.decimals : CHIP_DECIMALS;
  const exact = chipsToTokenString(chips, decimals);
  const shown = formatTokens(chips, { maxFractionDigits: options.maxFractionDigits, decimals });
  const value = options.signed && shown !== EM_DASH && !shown.startsWith('-') ? `+${shown}` : shown;
  const classes = ['money'];
  if (shown.startsWith('-')) classes.push('money-neg');
  if (options.className) classes.push(options.className);
  return h('span', {
    class: classes.join(' '),
    text: value,
    title: `${exact} ${decimals === 0 ? 'play chips' : 'tokens'} (base units, ${decimals} decimals)`,
  });
}

/**
 * @param {unknown} chips
 * @param {{maxFractionDigits?: number, decimals?: number}} [options]
 * @returns {string} token amount as plain text.
 */
export function moneyText(chips, options = {}) {
  return formatTokens(chips, options);
}

// ---------------------------------------------------------------------------
// Banners
// ---------------------------------------------------------------------------

/**
 * @param {'error'|'warning'|'info'|'success'} kind
 * @param {string} title
 * @param {string|null} [message]
 * @param {string|null} [details]
 * @returns {HTMLElement}
 */
export function banner(kind, title, message, details) {
  return h(
    'div',
    { class: `banner banner-${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    h('p', { class: 'banner-title', text: title }),
    message ? h('p', { class: 'banner-message', text: message }) : null,
    details ? h('pre', { class: 'banner-details', text: details }) : null,
  );
}

/**
 * Replaces the contents of a banner slot.
 *
 * @param {Element|null|undefined} slot
 * @param {Node|null|undefined} node
 * @returns {void}
 */
export function showBanner(slot, node) {
  if (!slot) return;
  clearNode(slot);
  if (node) slot.appendChild(node);
}

/**
 * Turns any thrown value into an explicit, readable banner — never a stack
 * trace (FR-7.6).
 *
 * @param {unknown} err
 * @param {string} context what could not be loaded, e.g. `"the agent list"`
 * @returns {HTMLElement}
 */
export function errorBanner(err, context) {
  const message = err instanceof Error ? err.message : String(err);
  const status = err && typeof err === 'object' && 'status' in err ? Number(err.status) : null;
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : null;
  let title = `Could not load ${context}`;
  if (status === 0) title = `Cannot reach the API (${context})`;
  else if (status === 503) title = `Service unavailable (${context})`;
  else if (status === 404) title = `Not found (${context})`;
  return banner('error', title, message, code ? `code: ${code}` : null);
}

// ---------------------------------------------------------------------------
// Page chrome (FR-7 header/footer)
// ---------------------------------------------------------------------------

/** @type {{href: string, label: string}[]} */
const NAV = [
  { href: '/', label: 'Home' },
  { href: '/tables', label: 'Tables' },
  { href: '/agents', label: 'Agents' },
  { href: '/hands', label: 'Hands' },
  { href: '/stake', label: 'Stake' },
  { href: '/docs', label: 'Docs' },
  { href: '/about', label: 'About' },
];

/**
 * Only `http(s)` URLs may become `href`s. Server-provided `explorerUrl` values
 * go through this so a hostile/broken API cannot inject a `javascript:` link.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
export function safeExternalUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : null;
}

/** @type {boolean} */
let walletWired = false;

/**
 * Chain id the connected wallet is expected to be on. Defaults to the
 * documented settlement chain; a page that has read `/api/v1/health` overrides
 * it with the chain the server actually reports.
 *
 * @type {number|null}
 */
let expectedChainId = null;

/**
 * @param {number|null|undefined} chainId
 * @returns {void}
 */
export function setExpectedChainId(chainId) {
  if (typeof chainId === 'number' && Number.isFinite(chainId)) {
    expectedChainId = Math.trunc(chainId);
    renderWalletButton();
  }
}

/**
 * Renders the header wallet control: a connect button when disconnected, the
 * truncated address (linking to `/stake`) when connected, and an explicit
 * "no wallet detected" control when the browser injects no EIP-1193 provider.
 *
 * @returns {void}
 */
function renderWalletButton() {
  const slot = document.getElementById('wallet-slot');
  if (!slot) return;
  clearNode(slot);
  const state = walletState;
  const expected = expectedChainId ?? EXPECTED_CHAIN_ID;

  if (state.connected && state.address) {
    const wrongChain = typeof state.chainId === 'number' && state.chainId !== expected;
    slot.appendChild(
      h('a', {
        class: `button button-wallet${wrongChain ? ' button-wallet-warn' : ''}`,
        href: '/stake',
        title: `Wallet ${state.address} — open the staking page`,
        text: shortAddress(state.address),
      }),
    );
    slot.appendChild(
      h('span', {
        class: `wallet-note${wrongChain ? ' warn-text' : ' muted'}`,
        text: wrongChain ? `wrong network (${state.chainId}) — expected ${expected}` : `chain ${state.chainId ?? '\u2014'}`,
      }),
    );
    return;
  }

  if (!state.available) {
    slot.appendChild(
      h('button', {
        class: 'button button-wallet',
        type: 'button',
        disabled: true,
        title: NO_WALLET_MESSAGE,
        text: 'Connect wallet',
      }),
    );
    slot.appendChild(h('span', { class: 'wallet-note muted', text: 'no wallet detected' }));
    return;
  }

  slot.appendChild(
    h('button', {
      class: 'button button-wallet',
      type: 'button',
      disabled: state.connecting,
      title: 'Connect an EIP-1193 wallet to check free-play eligibility and stake',
      text: state.connecting ? 'Connecting…' : 'Connect wallet',
      onclick: () => void connectFromHeader(),
    }),
  );
  slot.appendChild(h('span', { class: 'wallet-note muted', text: state.connecting ? 'check your wallet' : 'EIP-1193' }));
}

/**
 * `connect()` never throws — "no wallet" and "user rejected" land in
 * `walletState.error`, which is announced through the header live region.
 *
 * @returns {Promise<void>}
 */
async function connectFromHeader() {
  const result = await connect();
  announce(result ? `Wallet connected: ${result.address}` : walletState.error ?? 'Wallet not connected.');
}

/**
 * @param {string} message
 * @returns {void}
 */
function announce(message) {
  const live = document.getElementById('wallet-live');
  if (live) live.textContent = message;
}

/**
 * Wires the header wallet control once (state subscription + a silent
 * `eth_accounts` restore that never prompts).
 *
 * @returns {void}
 */
export function mountWalletButton() {
  renderWalletButton();
  if (walletWired) return;
  walletWired = true;
  subscribeWallet(renderWalletButton);
  void restore();
}

/**
 * The site's top-level destinations, in header order. Exported so a page that
 * wants to link its siblings (e.g. the documentation hub) does not repeat them.
 *
 * @returns {{href: string, label: string}[]}
 */
export function navItems() {
  return NAV.map((item) => ({ ...item }));
}

/**
 * The chrome every page renders: the wallet control, the header nav (which links
 * `/docs` and `/about`) and the footer (which links them too). Every page calls
 * this, so those two links exist on **every** page by construction.
 *
 * @param {string} activePath one of `/`, `/tables`, `/agents`, `/hands`, `/stake`, `/docs`, `/about`
 * @returns {void}
 */
export function renderPageChrome(activePath) {
  renderChrome(activePath);
}

/**
 * Renders the shared header nav and footer into `#site-header` / `#site-footer`,
 * including the connect-wallet control.
 *
 * @param {string} activePath one of `/`, `/tables`, `/agents`, `/hands`, `/stake`, `/docs`, `/about`
 * @param {{tokenomics?: import('./types.js').Tokenomics|null}|null} [health]
 *   when `/api/v1/health` has already answered, its `tokenomics` teaches every
 *   later `tableMoney()` call the wager currencies' decimals (see `format.js`).
 * @returns {void}
 */
export function renderChrome(activePath, health) {
  if (health) setMoneyContext({ tokenomics: health.tokenomics ?? null });
  const header = document.getElementById('site-header');
  if (header) {
    clearNode(header);
    header.appendChild(
      h(
        'div',
        { class: 'site-header-inner' },
        h(
          'a',
          { class: 'brand', href: '/' },
          h('span', { class: 'brand-mark', text: '\u2660' }),
          h('span', { class: 'brand-name', text: 'LLM Poker Arena' }),
          h('span', { class: 'brand-sub', text: 'agent-only poker on-chain' }),
        ),
        h(
          'nav',
          { class: 'nav', 'aria-label': 'Sections' },
          NAV.map((item) =>
            h('a', {
              class: 'nav-link',
              href: item.href,
              text: item.label,
              'aria-current': item.href === activePath ? 'page' : null,
            }),
          ),
        ),
        h(
          'div',
          { class: 'header-meta' },
          h('div', { class: 'wallet-slot', id: 'wallet-slot' }),
          h('span', { class: 'visually-hidden', id: 'wallet-live', role: 'status', 'aria-live': 'polite' }),
          h('span', {
            class: 'conn',
            id: 'conn-indicator',
            dataset: { state: 'OFFLINE' },
            title: 'Monitor feed state — live WebSocket, reconnecting, or offline',
            text: 'OFFLINE',
          }),
          h('span', { class: 'chain', id: 'chain-label', text: 'chain —' }),
        ),
      ),
    );
    mountWalletButton();
  }

  const footer = document.getElementById('site-footer');
  if (footer) {
    clearNode(footer);
    footer.appendChild(
      h(
        'div',
        { class: 'site-footer-inner' },
        h('p', {
          class: 'footer-line',
          text:
            'LLM Poker Arena — agent-only no-limit Texas Hold\u2019em, settled on-chain with a shuffle you can ' +
            'verify yourself. Reading this site needs no wallet; connecting one is only for staking, and the site ' +
            'never holds a key or signs anything for you.',
        }),
        h(
          'p',
          { class: 'footer-line' },
          h('a', { href: '/tables', text: '/tables' }),
          ' \u00b7 ',
          h('a', { href: '/agents', text: '/agents' }),
          ' \u00b7 ',
          h('a', { href: '/hands', text: '/hands' }),
          ' \u00b7 ',
          h('a', { href: '/stake', text: '/stake' }),
          ' \u00b7 ',
          h('a', { href: '/docs', text: '/docs' }),
          ' \u00b7 ',
          h('a', { href: '/about', text: '/about' }),
          ' \u00b7 ',
          h('a', { href: '/llm.txt', text: '/llm.txt' }),
          ' (the machine-readable agent contract; ',
          h('a', { href: '/llms.txt', text: '/llms.txt' }),
          ' is the same document)',
        ),
        h(
          'p',
          { class: 'footer-line muted' },
          'Shuffles are commit-reveal, anchored to the next block after the commitment; ',
          'every proof on ',
          h('a', { href: '/hands', text: '/hands' }),
          ' is recomputed in your own browser from public fields. ',
          h('span', { id: 'footer-version', text: 'version —' }),
          ' \u00b7 chain ',
          h('span', { id: 'footer-chain', text: '—' }),
          ' \u00b7 data: /api/v1 (read-only) + ws /api/v1/ws',
        ),
      ),
    );
  }
}

/**
 * Updates the connection indicator (`LIVE` / `RECONNECTING` / `OFFLINE`).
 *
 * @param {'LIVE'|'RECONNECTING'|'OFFLINE'} state
 * @param {string} [title]
 * @returns {void}
 */
export function setConnectionIndicator(state, title) {
  const node = document.getElementById('conn-indicator');
  if (!node) return;
  node.dataset.state = state;
  node.textContent = state;
  if (title) node.title = title;
}

/**
 * Shows chain id / server version once the monitor feed (or `/health`) reports
 * them.
 *
 * @param {{chainId?: number|null, version?: string|null}} info
 * @returns {void}
 */
export function setChromeInfo(info) {
  if (typeof info.chainId === 'number' && Number.isFinite(info.chainId)) {
    const label = document.getElementById('chain-label');
    if (label) label.textContent = `chain ${info.chainId}`;
    const footerChain = document.getElementById('footer-chain');
    if (footerChain) footerChain.textContent = String(info.chainId);
  }
  if (typeof info.version === 'string' && info.version !== '') {
    const footerVersion = document.getElementById('footer-version');
    if (footerVersion) footerVersion.textContent = `version ${info.version}`;
  }
}

// ---------------------------------------------------------------------------
// Structure helpers
// ---------------------------------------------------------------------------

/**
 * Section wrapper: `<section class="panel"><h2>title</h2>…</section>`.
 *
 * @param {string} title
 * @param {string|null} subtitle
 * @param {...any} children
 * @returns {HTMLElement}
 */
export function panel(title, subtitle, ...children) {
  return h(
    'section',
    { class: 'panel' },
    h(
      'div',
      { class: 'panel-head' },
      h('h2', { class: 'panel-title', text: title }),
      subtitle ? h('p', { class: 'panel-subtitle', text: subtitle }) : null,
    ),
    h('div', { class: 'panel-body' }, children),
  );
}

/**
 * Data table shell; rows are appended to the returned `tbody`.
 *
 * @param {{label: string, className?: string, title?: string}[]} columns
 * @param {{className?: string, caption?: string}} [options]
 * @returns {{table: HTMLElement, tbody: HTMLElement, thead: HTMLElement}}
 */
export function tableShell(columns, options = {}) {
  const thead = h(
    'thead',
    null,
    h(
      'tr',
      null,
      columns.map((column) =>
        h('th', { class: column.className ?? null, title: column.title ?? null, scope: 'col', text: column.label }),
      ),
    ),
  );
  const tbody = h('tbody');
  const table = h(
    'table',
    { class: `data-table ${options.className ?? ''}`.trim() },
    options.caption ? h('caption', { text: options.caption }) : null,
    thead,
    tbody,
  );
  return { table, tbody, thead };
}

/**
 * Full-width "nothing here" row.
 *
 * @param {number} colspan
 * @param {string} message
 * @returns {HTMLElement}
 */
export function emptyRow(colspan, message) {
  return h('tr', { class: 'empty-row' }, h('td', { colspan, text: message }));
}

/**
 * Definition grid for key/value details.
 *
 * @param {{label: string, value: any, title?: string}[]} pairs
 * @returns {HTMLElement}
 */
export function kvGrid(pairs) {
  const nodes = [];
  for (const pair of pairs) {
    nodes.push(h('dt', { text: pair.label }));
    /** @type {HTMLElement} */
    let valueNode;
    if (pair.value instanceof HTMLElement) valueNode = pair.value;
    else valueNode = h('span', { text: pair.value === null || pair.value === undefined ? EM_DASH : String(pair.value) });
    if (pair.title) valueNode.setAttribute('title', pair.title);
    nodes.push(h('dd', null, valueNode));
  }
  return h('dl', { class: 'kv-grid' }, nodes);
}

/**
 * Anchor to a hand detail view; keeps the caller's list state in the query.
 *
 * @param {string} handId
 * @param {Record<string, string|number|null|undefined>} [params]
 * @param {string} [label]
 * @returns {HTMLElement}
 */
export function handLink(handId, params = {}, label = 'proof') {
  const search = new URLSearchParams();
  search.set('id', handId);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  return h('a', { class: 'link', href: `/hands?${search.toString()}`, text: label });
}

// ---------------------------------------------------------------------------
// 1 Hz clock updater
// ---------------------------------------------------------------------------

/**
 * Starts a 1 s ticker that refreshes every `[data-deadline]` (action clock
 * countdown, FR-7.2) and `[data-relative]` (freshness) node under `root`.
 *
 * @param {ParentNode} [root]
 * @returns {() => void} stop function
 */
export function startClock(root = document) {
  const tick = () => refreshClocks(root);
  tick();
  const handle = setInterval(tick, 1000);
  return () => clearInterval(handle);
}

/**
 * @param {ParentNode} [root]
 * @returns {void}
 */
export function refreshClocks(root = document) {
  const now = Date.now();
  for (const node of root.querySelectorAll('[data-deadline]')) {
    const deadline = parseTimestamp(node.getAttribute('data-deadline'));
    const remaining = deadline - now;
    node.textContent = formatCountdown(remaining);
    node.classList.toggle('clock-urgent', remaining > 0 && remaining <= 5000);
    node.classList.toggle('clock-expired', remaining <= 0);
  }
  for (const node of root.querySelectorAll('[data-relative]')) {
    node.textContent = formatRelative(parseTimestamp(node.getAttribute('data-relative')), now);
  }
}

/**
 * `data-*` attributes are strings; an absent timestamp arrives as `''` or
 * `'null'` and must become `NaN` (not `0`, which would read as 1970).
 *
 * @param {string|null} raw
 * @returns {number}
 */
function parseTimestamp(raw) {
  if (raw === null) return NaN;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined') return NaN;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : NaN;
}

// `moneyEl` is this module's money renderer, so it is also the one
// `format.tableMoney().el()` uses — one rendering path, not two.
setMoneyElement(moneyEl);
