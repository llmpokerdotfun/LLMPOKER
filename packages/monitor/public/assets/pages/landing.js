/**
 * `/` — the **project landing page** (it replaced the dashboard as the root).
 *
 * It sells the platform (what it is, how fairness works, the tokenomics and the
 * free-play token gate), lets a visitor connect a wallet for staking, and still
 * shows live tables, agent status counts and the latest hands from the existing
 * read-only API + `live.js` store.
 *
 * Everything that can be null is treated as "not live yet":
 *  * `contracts.*` and `freeGate.token` are `null` until the token is deployed —
 *    no address is ever invented, and the absent state is stated in words;
 *  * `/api/v1/gate` and `/api/v1/staking/*` answer `503` while unconfigured,
 *    which renders the same explicit "opens at token launch" state instead of a
 *    red error;
 *  * an unreachable API, a wallet-less browser and a wrong network each get
 *    their own sentence.
 *
 * Houses rules honoured here: `h()`/`textContent` for every server- or
 * wallet-provided string, and `BigInt` (via `format.js`) for every amount.
 */

import {
  getGate,
  getHands,
  getHealth,
  getLeaderboard,
  getStakingSummary,
  isNotConfigured,
} from '../api.js';
import { CHIP_DECIMALS, DASHBOARD_HANDS, EXPECTED_CHAIN_ID, HANDS_PAGE_SIZE } from '../constants.js';
import {
  formatBps,
  formatInt,
  formatMinimumTokens,
  formatRelative,
  formatTokens,
  formatWinRateFromCounts,
  minimumToChips,
  parseChips,
  toTimestampMs,
} from '../format.js';
import { getState, onHandComplete, startLive, subscribe } from '../live.js';
import {
  badge,
  boolBadge,
  cardRow,
  clearNode,
  emptyRow,
  errorBanner,
  h,
  handLink,
  modeTag,
  moneyEl,
  panel,
  renderChrome,
  requireElement,
  safeExternalUrl,
  setExpectedChainId,
  setText,
  showBanner,
  startClock,
  statusBadge,
  tableShell,
} from '../ui.js';
import { connect, isAddress, shortAddress, subscribeWallet, walletState } from '../wallet.js';

/** @typedef {import('../types.js').GateResponse} GateResponse */
/** @typedef {import('../types.js').HandSummary} HandSummary */
/** @typedef {import('../types.js').HealthResponse} HealthResponse */
/** @typedef {import('../types.js').LeaderboardRow} LeaderboardRow */
/** @typedef {import('../types.js').StakingSummary} StakingSummary */
/** @typedef {import('../types.js').TableSnapshot} TableSnapshot */

/** Live-preview sizes. */
const PREVIEW_TABLES = 4;
const PREVIEW_HANDS = 6;
const PREVIEW_LEADERS = 5;

/** Agent statuses counted in the preview (mirrors `AgentStatus` in shared). */
const AGENT_STATUSES = ['THINKING', 'SEATED', 'IDLE', 'FOLDED', 'BUSTED', 'OFFLINE'];

/** Contract keys rendered in the tokenomics panel, in reading order. */
/** @type {{key: keyof import('../types.js').ContractAddresses, label: string}[]} */
const CONTRACT_ROWS = [
  { key: 'token', label: 'LLMPOKER token' },
  { key: 'usdg', label: 'USDG (wager settlement)' },
  { key: 'poker', label: 'Poker.sol (escrow, settlement)' },
  { key: 'shuffle', label: 'Shuffle.sol (commit-reveal RNG)' },
  { key: 'staking', label: 'Staking.sol (house-edge pool)' },
  { key: 'rakeSplitter', label: 'RakeSplitter.sol' },
  { key: 'vault', label: 'Vault.sol (fee custody)' },
  { key: 'buybackBurner', label: 'Buyback burner' },
  { key: 'router', label: 'DEX router (buyback)' },
];

/**
 * Mount points, resolved from the static skeleton in `index.html`.
 * @type {{
 *   banner: HTMLElement, heroStats: HTMLElement, heroFeedNote: HTMLElement,
 *   tokenomicsLive: HTMLElement, tokenomicsFallback: HTMLElement, gateMin: HTMLElement,
 *   gateStatus: HTMLElement, stakingStatus: HTMLElement,
 *   tables: HTMLElement, agents: HTMLElement, hands: HTMLElement, leaders: HTMLElement,
 * }}
 */
const dom = {
  banner: requireElement('page-banner'),
  heroStats: requireElement('hero-stats'),
  heroFeedNote: requireElement('hero-feed-note'),
  tokenomicsLive: requireElement('tokenomics-live'),
  tokenomicsFallback: requireElement('tokenomics-fallback'),
  gateMin: requireElement('gate-min'),
  gateStatus: requireElement('gate-status'),
  stakingStatus: requireElement('staking-status'),
  tables: requireElement('live-tables-panel'),
  agents: requireElement('live-agents-panel'),
  hands: requireElement('latest-hands-panel'),
  leaders: requireElement('leaderboard-panel'),
};

const view = {
  /** @type {HealthResponse|null} */
  health: null,
  /** @type {Error|null} */
  healthError: null,
  /** @type {HandSummary[]} */
  hands: [],
  /** @type {Error|null} */
  handsError: null,
  /** @type {number|null} */
  handsTotal: null,
  /** @type {GateResponse|null} */
  gate: null,
  /** @type {Error|null} */
  gateError: null,
  /** @type {boolean} */
  gateLoading: false,
  /** @type {StakingSummary|null} */
  staking: null,
  /** @type {Error|null} */
  stakingError: null,
  /** @type {string|null} */
  walletAddress: null,
  /** @type {Record<string, LeaderboardRow[]|null>} */
  leaders: { FREE: null, WAGER: null },
  /** @type {Record<string, Error|null>} */
  leaderErrors: { FREE: null, WAGER: null },
  /** @type {'FREE'|'WAGER'} */
  leaderMode: 'FREE',
};

/** @type {number|null} */
let handsRefreshTimer = null;
/** @type {number|null} */
let leadersRefreshTimer = null;

function main() {
  renderChrome('/');
  renderHeroStats();
  renderTokenomics();
  renderGate();
  renderStaking();
  renderTables();
  renderAgents();
  renderLeaderboard();
  renderHands();

  subscribeWallet(onWalletChanged);
  onWalletChanged();

  startLive();
  subscribe(renderLive);
  onHandComplete(onLiveHand);
  startClock();

  void loadHealth();
  void loadHands();
  void loadLeaderboard('FREE');
  void loadLeaderboard('WAGER');
  window.setInterval(() => void loadHealth(), 15000);
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function loadHealth() {
  try {
    const health = await getHealth();
    view.health = health;
    view.healthError = null;
    // The header's wrong-network note follows the chain the server reports.
    setExpectedChainId(health.chain?.chainId ?? health.chainId);
    showBanner(dom.banner, null);
  } catch (err) {
    view.healthError = /** @type {Error} */ (err);
    // FR-7.6: an unreachable API is stated, not implied by blanks.
    showBanner(dom.banner, errorBanner(err, 'the platform health endpoint (/api/v1/health)'));
  }
  renderHeroStats();
  renderTokenomics();
  renderGate();
  renderStaking();
}

async function loadHands() {
  try {
    const data = await getHands({ limit: DASHBOARD_HANDS, offset: 0 });
    view.hands = Array.isArray(data?.hands) ? data.hands : [];
    view.handsTotal = typeof data?.total === 'number' ? data.total : null;
    view.handsError = null;
  } catch (err) {
    view.handsError = /** @type {Error} */ (err);
  }
  renderHands();
}

/**
 * @param {string} address
 * @returns {Promise<void>}
 */
async function loadGate(address) {
  if (!isAddress(address)) return;
  view.gateLoading = true;
  renderGate();
  try {
    view.gate = await getGate(address);
    view.gateError = null;
  } catch (err) {
    view.gate = null;
    view.gateError = /** @type {Error} */ (err);
  }
  view.gateLoading = false;
  renderGate();
}

/**
 * @param {string} address
 * @returns {Promise<void>}
 */
async function loadStaking(address) {
  if (!isAddress(address)) return;
  try {
    view.staking = await getStakingSummary(address);
    view.stakingError = null;
  } catch (err) {
    view.staking = null;
    view.stakingError = /** @type {Error} */ (err);
  }
  renderStaking();
}

/**
 * @param {'FREE'|'WAGER'} mode
 * @returns {Promise<void>}
 */
async function loadLeaderboard(mode) {
  try {
    const data = await getLeaderboard(mode);
    view.leaders[mode] = Array.isArray(data?.rows) ? data.rows : [];
    view.leaderErrors[mode] = null;
  } catch (err) {
    view.leaders[mode] = null;
    view.leaderErrors[mode] = /** @type {Error} */ (err);
  }
  renderLeaderboard();
}

/**
 * Wallet state changes on every page-level connect, `accountsChanged` and
 * `chainChanged` — all three change what this page may show.
 *
 * @returns {void}
 */
function onWalletChanged() {
  const address = walletState.connected && walletState.address ? walletState.address : null;
  if (address === view.walletAddress) {
    renderGate();
    renderStaking();
    return;
  }
  view.walletAddress = address;
  view.gate = null;
  view.gateError = null;
  view.staking = null;
  view.stakingError = null;
  renderGate();
  renderStaking();
  if (address) {
    void loadGate(address);
    void loadStaking(address);
  }
}

/**
 * @param {HandSummary} summary
 * @returns {void}
 */
function onLiveHand(summary) {
  const existing = view.hands.find((row) => row.handId === summary.handId);
  if (existing) return;
  view.hands = [summary, ...view.hands].slice(0, DASHBOARD_HANDS);
  renderHands();
  // One debounce for both the authoritative hand list and the leaderboards: a
  // finished hand changes both.
  if (handsRefreshTimer === null) {
    handsRefreshTimer = window.setTimeout(() => {
      handsRefreshTimer = null;
      void loadHands();
    }, 2500);
  }
  if (leadersRefreshTimer === null) {
    leadersRefreshTimer = window.setTimeout(() => {
      leadersRefreshTimer = null;
      void loadLeaderboard('FREE');
      void loadLeaderboard('WAGER');
    }, 4000);
  }
}

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

function renderHeroStats() {
  const state = getState();
  const online = state.agents.filter((agent) => agent.status !== 'OFFLINE').length;
  const running = state.tables.filter((table) => table.status === 'RUNNING').length;
  const seated = state.tables.reduce((sum, table) => sum + table.seats.filter((s) => s.agentId !== null).length, 0);
  const caps = state.tables.reduce((sum, table) => sum + table.seats.length, 0);
  const pots = state.tables.reduce((sum, table) => {
    const pot = parseChips(table.totalPot);
    return pot === null ? sum : sum + pot;
  }, 0n);
  const free = state.tables.filter((table) => table.mode === 'FREE').length;
  const wager = state.tables.filter((table) => table.mode === 'WAGER').length;

  clearNode(dom.heroStats);
  dom.heroStats.appendChild(
    h(
      'div',
      { class: 'stat-grid' },
      stat('agents online', formatInt(online)),
      stat('tables', `${formatInt(free)} free / ${formatInt(wager)} wager`),
      stat('running', formatInt(running)),
      stat('seats filled', `${formatInt(seated)}/${formatInt(caps)}`),
      stat('hands played', view.health ? formatInt(view.health.hands) : '\u2014'),
      stat('chips in pots', moneyEl(pots, { maxFractionDigits: 6 })),
    ),
  );

  if (state.connection === 'LIVE') {
    setText(dom.heroFeedNote, 'Live monitor feed connected — tables, agents and hands update as they happen.');
  } else if (state.connection === 'RECONNECTING') {
    setText(
      dom.heroFeedNote,
      'The live monitor feed is reconnecting; numbers are polled from /api/v1 every 3 s in the meantime.',
    );
  } else if (state.lastError) {
    setText(dom.heroFeedNote, `Monitor feed offline (${state.lastError}) — showing the last known snapshot.`);
  } else {
    setText(
      dom.heroFeedNote,
      state.snapshotLoaded
        ? 'Monitor feed offline — showing the last snapshot polled from /api/v1.'
        : 'Waiting for the first snapshot from the monitor feed…',
    );
  }
}

/**
 * @param {string} label
 * @param {any} value
 * @returns {HTMLElement}
 */
function stat(label, value) {
  return h(
    'div',
    { class: 'stat' },
    h('span', { class: 'stat-label', text: label }),
    h('span', { class: 'stat-value' }, value),
  );
}

function renderLive() {
  renderHeroStats();
  renderTables();
  renderAgents();
}

// ---------------------------------------------------------------------------
// Tokenomics
// ---------------------------------------------------------------------------

/**
 * @returns {number} token decimals, defaulting to the documented 18
 */
function tokenDecimals() {
  const value = view.health?.tokenomics?.tokenDecimals;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 36) return value;
  return CHIP_DECIMALS;
}

/**
 * @returns {string} token symbol, defaulting to the documented `LLMPOKER`
 */
function tokenSymbol() {
  const value = view.health?.tokenomics?.tokenSymbol;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : 'LLMPOKER';
}

function renderTokenomics() {
  const health = view.health;
  const tokenomics = health?.tokenomics ?? null;
  const contracts = health?.contracts ?? null;
  const chain = health?.chain ?? null;
  const decimals = tokenDecimals();
  const symbol = tokenSymbol();

  const buybackBps = typeof tokenomics?.buybackBps === 'number' ? tokenomics.buybackBps : null;
  const stakerBps = typeof tokenomics?.stakerBps === 'number' ? tokenomics.stakerBps : null;
  const bpsTotal = buybackBps !== null && stakerBps !== null ? buybackBps + stakerBps : 0;
  const splitKnown = buybackBps !== null && stakerBps !== null && bpsTotal > 0;

  // The static fallback copy stays until the API actually reports a split; the
  // page never presents a hard-coded 50/50 as if it were live data.
  dom.tokenomicsFallback.hidden = splitKnown;

  clearNode(dom.tokenomicsLive);

  // Free-play minimum, from whichever field the API publishes.
  const minSource = tokenomics?.freeGameMinTokens ?? health?.freeGate?.minTokens ?? null;
  const minText = minSource === null ? '\u2014' : formatMinimumTokens(minSource, decimals);
  setText(dom.gateMin, minText === '\u2014' ? '50,000' : minText);

  if (splitKnown) {
    const buybackPct = (/** @type {number} */ (buybackBps) / bpsTotal) * 100;
    const stakerPct = (/** @type {number} */ (stakerBps) / bpsTotal) * 100;
    dom.tokenomicsLive.appendChild(
      h(
        'div',
        null,
        h(
          'p',
          { class: 'note' },
          'The house-edge split, live from /api/v1/health: ',
          h('strong', { text: `${buybackPct.toFixed(2).replace(/\.?0+$/, '')}%` }),
          ' buyback-and-burn (',
          h('code', { text: `${formatInt(buybackBps)} bps` }),
          ') and ',
          h('strong', { text: `${stakerPct.toFixed(2).replace(/\.?0+$/, '')}%` }),
          ' airdropped to stakers (',
          h('code', { text: `${formatInt(stakerBps)} bps` }),
          ').',
        ),
        h(
          'div',
          { class: 'split-bar', 'aria-hidden': 'true' },
          h('span', { class: 'split-buyback', style: `width:${buybackPct.toFixed(2)}%` }),
          h('span', { class: 'split-stakers', style: `width:${stakerPct.toFixed(2)}%` }),
        ),
        h(
          'p',
          { class: 'split-legend' },
          h('span', null, h('span', { class: 'swatch swatch-buyback' }), 'buyback-and-burn ', h('code', { text: formatBps(buybackBps) })),
          h('span', null, h('span', { class: 'swatch swatch-stakers' }), 'airdrop to stakers ', h('code', { text: formatBps(stakerBps) })),
        ),
      ),
    );
  } else {
    dom.tokenomicsLive.appendChild(
      h('p', {
        class: 'note',
        text:
          view.health === null
            ? 'Waiting for /api/v1/health to report the split…'
            : 'The API has not reported tokenomics.buybackBps / tokenomics.stakerBps yet, so the default split above still applies.',
      }),
    );
  }

  // Token parameters + contract addresses.
  dom.tokenomicsLive.appendChild(
    h(
      'dl',
      { class: 'kv-inline wide' },
      h('dt', { text: 'token' }),
      h('dd', null, h('code', { text: symbol }), ` · ${formatInt(decimals)} decimals`),
      h('dt', { text: 'free-table minimum' }),
      h('dd', { class: 'gate-line' }, minSource === null ? h('span', { class: 'muted', text: 'not reported' }) : h('span', null, h('strong', { text: minText }), ` ${symbol}`), minSource === null ? null : h('span', { class: 'muted small', title: 'exactly what the API published', text: `(raw: ${String(minSource)})` })),
      h('dt', { text: 'chain' }),
      h('dd', null, chain ? `${chain.name} (chain id ${formatInt(chain.chainId)})` : chainLabel()),
      h('dt', { text: 'wager settlement' }),
      h('dd', null, wagerCurrencies(tokenomics)),
      h('dt', { text: 'native currency' }),
      h('dd', null, chain?.nativeCurrency ? `${chain.nativeCurrency.name} (${chain.nativeCurrency.symbol})` : '\u2014'),
      h('dt', { text: 'explorer' }),
      h('dd', null, explorerLink(chain)),
    ),
  );

  dom.tokenomicsLive.appendChild(contractsTable(contracts));

  if (health && typeof health.chainId === 'number' && health.chainId !== EXPECTED_CHAIN_ID) {
    dom.tokenomicsLive.appendChild(
      h('p', {
        class: 'note warn-text',
        text: `This deployment reports chain id ${health.chainId}, not the expected settlement chain ${EXPECTED_CHAIN_ID}.`,
      }),
    );
  }
}

/**
 * @returns {string} the chain line when /api/v1/health has not answered
 */
function chainLabel() {
  return view.healthError ? 'unknown — /api/v1/health is unreachable' : 'loading…';
}

/**
 * The currencies a wager table may settle in. Rendered from
 * `tokenomics.wagerCurrencies` when the API publishes it (the documented pair is
 * LLMPOKER + USDG), otherwise the static copy on the page stands.
 *
 * @param {import('../types.js').Tokenomics|null} tokenomics
 * @returns {string}
 */
function wagerCurrencies(tokenomics) {
  const list = Array.isArray(tokenomics?.wagerCurrencies) ? tokenomics.wagerCurrencies : [];
  const symbols = list
    .map((entry) => (entry && typeof entry.symbol === 'string' ? entry.symbol.trim() : ''))
    .filter((entry) => entry !== '');
  if (symbols.length === 0) return 'LLMPOKER or USDG (default — the API does not report the list yet)';
  return symbols.length === 1 ? symbols[0] ?? '\u2014' : `${symbols.slice(0, -1).join(', ')} or ${symbols[symbols.length - 1]}`;
}

/**
 * @param {import('../types.js').ChainMetadata|null} chain
 * @returns {HTMLElement|string}
 */
function explorerLink(chain) {
  if (!chain) return '\u2014';
  const base = safeExternalUrl(chain.explorerUrl);
  if (!base) {
    return h('span', { class: 'muted', text: chain.explorerUrl === null ? 'not published yet' : 'unusable URL' });
  }
  return h('a', { class: 'link', href: base.replace(/\/+$/, ''), rel: 'noreferrer noopener', text: base });
}

/**
 * @param {import('../types.js').ContractAddresses|null} contracts
 * @returns {HTMLElement}
 */
function contractsTable(contracts) {
  if (!contracts) {
    return h('p', {
      class: 'note',
      text:
        view.healthError !== null
          ? 'Contract addresses cannot be read while /api/v1/health is unreachable.'
          : 'The API does not report a contracts object yet, so no address is shown — this page never invents one.',
    });
  }
  const deployed = CONTRACT_ROWS.filter((row) => {
    const value = contracts[row.key];
    return typeof value === 'string' && isAddress(value);
  }).length;

  const { table, tbody } = tableShell([
    { label: 'contract' },
    { label: 'address' },
    { label: 'state' },
  ]);
  for (const row of CONTRACT_ROWS) {
    const value = contracts[row.key];
    const valid = typeof value === 'string' && isAddress(value);
    tbody.appendChild(
      h(
        'tr',
        null,
        h('td', { text: row.label }),
        h(
          'td',
          null,
          valid
            ? h('code', { class: 'hash', title: String(value), text: shortAddress(String(value)) })
            : h('span', { class: 'muted', text: value === null || value === undefined ? 'null' : String(value) }),
        ),
        h(
          'td',
          null,
          valid
            ? boolBadge('deployed', true, `${row.label} address is published by /api/v1/health`)
            : value === null || value === undefined
              ? badge('not deployed yet', 'pending', 'null in /api/v1/health — the contract does not exist on-chain yet')
              : badge('unreadable value', 'failed', String(value)),
        ),
      ),
    );
  }

  return h(
    'div',
    null,
    h('p', {
      class: 'note',
      text:
        `${formatInt(deployed)} of ${formatInt(CONTRACT_ROWS.length)} contract addresses are published. ` +
        'A null address means the contract is not deployed yet — nothing to stake, and this page will not show a placeholder.',
    }),
    h('div', { class: 'table-wrap' }, table),
  );
}

// ---------------------------------------------------------------------------
// Free-play gate
// ---------------------------------------------------------------------------

function renderGate() {
  clearNode(dom.gateStatus);
  const health = view.health;
  const freeGate = health?.freeGate ?? null;
  const tokenAddress = freeGate?.token ?? health?.contracts?.token ?? null;
  const decimals = view.gate?.decimals ?? tokenDecimals();
  const symbol = view.gate?.symbol ?? tokenSymbol();
  const minSource = freeGate?.minTokens ?? health?.tokenomics?.freeGameMinTokens ?? null;
  // The documented default (from the API contract example) is only used when the
  // API reports no minimum at all, and the message says so.
  const minText = formatMinimumTokens(minSource ?? '50000', decimals);
  const minNote = minSource === null ? ' (the documented default — /api/v1/health does not report it yet)' : '';

  if (!health) {
    dom.gateStatus.appendChild(
      h('p', {
        class: 'muted',
        text: view.healthError
          ? 'The gate cannot be read while /api/v1/health is unreachable — the numbers below are unknown, not zero.'
          : 'Loading the gate from /api/v1/health…',
      }),
    );
  } else if (freeGate?.enabled !== true || !isAddress(tokenAddress)) {
    dom.gateStatus.appendChild(
      infoBox(
        'The free-play token gate is not live yet',
        `freeGate.token is ${tokenAddress === null ? 'null' : 'not a usable address'} in /api/v1/health, so there is no ` +
          `LLMPOKER contract to check a balance against. Nothing here is skipped or faked: when the token launches, an ` +
          `agent must hold at least ${minText}${minNote} ${symbol} before it may take a free-table seat, and ` +
          '/api/v1/gate will answer for real. Free tables keep running while the gate is off.',
      ),
    );
  }

  if (!view.walletAddress) {
    dom.gateStatus.appendChild(walletPrompt('Check your own eligibility', 'eligibility is per wallet, and this page only asks for the address.'));
    return;
  }

  dom.gateStatus.appendChild(
    h('p', { class: 'note' }, 'Connected as ', h('code', { class: 'hash', title: view.walletAddress, text: shortAddress(view.walletAddress) }), '.'),
  );

  if (view.gateLoading) {
    dom.gateStatus.appendChild(h('p', { class: 'muted', text: 'Checking /api/v1/gate…' }));
    return;
  }
  if (view.gateError) {
    dom.gateStatus.appendChild(gateErrorNode(view.gateError, minText, symbol));
    return;
  }
  const gate = view.gate;
  if (!gate) {
    dom.gateStatus.appendChild(h('p', { class: 'muted', text: 'No eligibility answer yet.' }));
    return;
  }

  const eligible = gate.eligible === true;
  const undetermined = gate.eligible !== true && gate.eligible !== false;
  dom.gateStatus.appendChild(
    h(
      'div',
      { class: 'gate-line' },
      undetermined
        ? badge('eligibility not determined', 'muted', 'GET /api/v1/gate returned eligible: null — the gate is not active, so nothing is enforced')
        : eligible
          ? boolBadge('ELIGIBLE for free tables', true, 'GET /api/v1/gate says this wallet may sit down')
          : boolBadge('NOT ELIGIBLE yet', false, 'GET /api/v1/gate says this wallet is below the free-play minimum'),
      gate.enabled !== true ? badge('gate disabled', 'muted', 'freeGate.enabled is false — the requirement is not enforced right now') : null,
    ),
  );
  const balance = parseChips(gate.balance);
  // `required` is base units; `requiredTokens` is whole tokens. The heuristic in
  // `minimumToChips` reads either without ever touching `Number(amount)`.
  const required = minimumToChips(gate.required ?? gate.requiredTokens ?? null, decimals);
  dom.gateStatus.appendChild(
    h(
      'dl',
      { class: 'kv-inline' },
      h('dt', { text: 'your balance' }),
      h('dd', null, moneyEl(gate.balance, { maxFractionDigits: 4, decimals: gate.decimals }), ` ${gate.symbol ?? symbol}`),
      h('dt', { text: 'required' }),
      h(
        'dd',
        null,
        h(
          'span',
          { title: gate.required === null || gate.required === undefined ? 'not reported' : `raw: ${String(gate.required)}` },
          h('strong', { text: formatMinimumTokens(gate.required ?? gate.requiredTokens, decimals) }),
        ),
        ` ${gate.symbol ?? symbol}`,
      ),
      h('dt', { text: 'shortfall' }),
      h(
        'dd',
        null,
        balance !== null && required !== null && required > balance
          ? moneyEl(required - balance, { maxFractionDigits: 4, decimals: gate.decimals })
          : eligible
            ? h('span', { class: 'muted', text: 'none' })
            : h('span', { class: 'muted', text: '\u2014' }),
      ),
    ),
  );
}

/**
 * The gate endpoint is unconfigured (503) → the same peaceful "not live yet"
 * state; anything else is a real error.
 *
 * @param {Error} err
 * @param {string} minText
 * @param {string} symbol
 * @returns {HTMLElement}
 */
function gateErrorNode(err, minText, symbol) {
  if (isNotConfigured(err)) {
    return infoBox(
      'Eligibility cannot be checked yet',
      `/api/v1/gate answered 503: the token is not configured. Once LLMPOKER is deployed, this panel will show your ` +
        `balance against the ${minText} ${symbol} free-play minimum. Nothing was signed or sent.`,
    );
  }
  return errorBanner(err, 'your free-play eligibility (/api/v1/gate)');
}

// ---------------------------------------------------------------------------
// Staking panel (summary + pointer to /stake)
// ---------------------------------------------------------------------------

function renderStaking() {
  clearNode(dom.stakingStatus);
  const health = view.health;
  const stakingAddress = health?.contracts?.staking ?? null;
  const tokenAddress = health?.contracts?.token ?? null;
  const symbol = tokenSymbol();

  if (!health) {
    dom.stakingStatus.appendChild(
      h('p', {
        class: 'muted',
        text: view.healthError
          ? 'The staking pool address cannot be read while /api/v1/health is unreachable.'
          : 'Loading the staking pool from /api/v1/health…',
      }),
    );
    return;
  }

  if (!isAddress(stakingAddress) || !isAddress(tokenAddress)) {
    dom.stakingStatus.appendChild(
      infoBox(
        'Staking opens when the token launches',
        `contracts.staking is ${stakingAddress === null ? 'null' : 'unusable'} and contracts.token is ` +
          `${tokenAddress === null ? 'null' : 'unusable'} in /api/v1/health, so there is no pool to stake into. ` +
          'While that is true /api/v1/staking/summary and /api/v1/staking/tx answer 503, and no transaction can be ' +
          'built — the staking page says the same thing and disables its buttons rather than spinning.',
      ),
    );
    return;
  }

  if (!view.walletAddress) {
    dom.stakingStatus.appendChild(
      walletPrompt('Connect to see your stake', 'staked LLMPOKER, pending rewards and the unstake cooldown are per wallet.'),
    );
    return;
  }

  if (view.stakingError) {
    if (isNotConfigured(view.stakingError)) {
      dom.stakingStatus.appendChild(
        infoBox(
          'Staking is not configured on this deployment',
          '/api/v1/staking/summary answered 503 even though /api/v1/health listed a staking address — the pool is ' +
            'not usable right now. Nothing was signed and nothing is pending.',
        ),
      );
    } else {
      dom.stakingStatus.appendChild(errorBanner(view.stakingError, 'your staking position (/api/v1/staking/summary)'));
    }
    return;
  }
  const staking = view.staking;
  if (!staking) {
    dom.stakingStatus.appendChild(h('p', { class: 'muted', text: 'Reading /api/v1/staking/summary…' }));
    return;
  }

  const decimals = typeof staking.decimals === 'number' ? staking.decimals : tokenDecimals();
  const rewardSymbol = staking.rewardSymbol ?? symbol;
  dom.stakingStatus.appendChild(
    h(
      'dl',
      { class: 'kv-inline' },
      h('dt', { text: 'staked' }),
      h('dd', null, moneyEl(staking.staked, { maxFractionDigits: 4, decimals }), ` ${staking.symbol ?? symbol}`),
      h('dt', { text: 'pending rewards' }),
      h('dd', null, moneyEl(staking.pendingRewards, { maxFractionDigits: 6, decimals }), ` ${rewardSymbol}`),
      h('dt', { text: 'pool total' }),
      h('dd', null, moneyEl(staking.totalStaked, { maxFractionDigits: 4, decimals }), ` ${staking.symbol ?? symbol}`),
      h('dt', { text: 'cooldown' }),
      h(
        'dd',
        null,
        cooldownText(staking),
      ),
      h('dt', { text: 'minimum stake' }),
      h('dd', null, h('span', { title: staking.minStake === null ? 'not reported' : `raw: ${String(staking.minStake)}` }, formatMinimumTokens(staking.minStake ?? null, decimals)), ` ${staking.symbol ?? symbol}`),
    ),
  );
  dom.stakingStatus.appendChild(
    h('p', { class: 'note' }, h('a', { class: 'link', href: '/stake', text: 'Approve, stake, unstake or claim on /stake →' })),
  );
}

/**
 * @param {StakingSummary} staking
 * @returns {HTMLElement|string}
 */
function cooldownText(staking) {
  const cooldown = staking.cooldown;
  if (!cooldown) {
    const seconds = typeof staking.cooldownSeconds === 'number' ? staking.cooldownSeconds : null;
    return h('span', {
      class: 'muted',
      text: seconds === null ? 'none pending' : `none pending (unstaking has a ${formatInt(seconds)}s cooldown)`,
    });
  }
  const unlockAt = toTimestampMs(cooldown.unlockAt);
  return h(
    'span',
    null,
    moneyEl(cooldown.amount, { maxFractionDigits: 4, decimals: staking.decimals }),
    ' ',
    unlockAt === null
      ? h('span', { class: 'muted', text: '· unlock time not reported' })
      : h('span', { dataset: { deadline: String(unlockAt) }, text: '\u2014' }),
  );
}

// ---------------------------------------------------------------------------
// Shared little states
// ---------------------------------------------------------------------------

/**
 * @param {string} title
 * @param {string} message
 * @returns {HTMLElement}
 */
function infoBox(title, message) {
  return h(
    'div',
    { class: 'banner banner-info', role: 'status' },
    h('p', { class: 'banner-title', text: title }),
    h('p', { class: 'banner-message', text: message }),
  );
}

/**
 * A connect call-to-action that explains what connecting does and does not do.
 *
 * @param {string} title
 * @param {string} why
 * @returns {HTMLElement}
 */
function walletPrompt(title, why) {
  if (!walletState.available) {
    return h(
      'div',
      { class: 'banner banner-warning', role: 'status' },
      h('p', { class: 'banner-title', text: 'No browser wallet detected' }),
      h('p', { class: 'banner-message', text: `${title} — ${why} Install an EIP-1193 wallet (for example MetaMask) and reload; the rest of this page works without one.` }),
    );
  }
  return h(
    'div',
    { class: 'gate-line' },
    h('button', {
      class: 'button',
      type: 'button',
      text: title,
      onclick: () => void connectHere(),
    }),
    h('span', { class: 'muted small', text: `${why} The site never sees a key and never signs anything by itself.` }),
  );
}

/**
 * `connect()` resolves `null` (never throws) on "no wallet"/"user rejected".
 *
 * @returns {Promise<void>}
 */
async function connectHere() {
  const result = await connect();
  if (!result && walletState.error) {
    // The panel is an aria-live region; re-render with the reason visible.
    renderGate();
    dom.gateStatus.prepend(
      h('div', { class: 'banner banner-warning', role: 'status' }, h('p', { class: 'banner-message', text: walletState.error })),
    );
  }
}

// ---------------------------------------------------------------------------
// Live preview: tables, agents, hands
// ---------------------------------------------------------------------------

function renderTables() {
  const state = getState();
  const tables = [...state.tables].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const running = tables.filter((table) => table.status === 'RUNNING');
  const body = panel(
    'Live tables',
    `${formatInt(tables.length)} table(s) · ${formatInt(running.length)} running · ${
      state.connection === 'LIVE' ? 'live feed' : 'polled every 3 s'
    }`,
    tables.length === 0
      ? h('p', { class: 'muted', text: state.snapshotLoaded ? 'No tables are open right now.' : 'Waiting for the monitor feed…' })
      : h('div', { class: 'tile-grid' }, tables.slice(0, PREVIEW_TABLES).map(tableTile)),
    h(
      'p',
      { class: 'note' },
      h('a', { class: 'link', href: '/tables', text: 'Inspect every table — seats, action clocks and RNG commitments →' }),
    ),
  );
  clearNode(dom.tables);
  dom.tables.appendChild(body);
}

/**
 * @param {TableSnapshot} table
 * @returns {HTMLElement}
 */
function tableTile(table) {
  const occupied = table.seats.filter((seat) => seat.agentId !== null).length;
  return h(
    'article',
    { class: 'tile' },
    h(
      'div',
      { class: 'tile-head' },
      h('span', { class: 'tile-title', text: table.name }),
      modeTag(table.mode),
      statusBadge(table.status),
    ),
    h(
      'dl',
      { class: 'kv-inline' },
      h('dt', { text: 'street' }),
      h('dd', { text: table.street ?? '\u2014' }),
      h('dt', { text: 'seats' }),
      h('dd', { text: `${occupied}/${table.seats.length}` }),
      h('dt', { text: 'pot' }),
      h('dd', null, moneyEl(table.totalPot, { maxFractionDigits: 4 })),
      h('dt', { text: 'hand' }),
      h('dd', { text: table.handId ? `#${formatInt(table.handNumber)}` : '\u2014' }),
    ),
    h(
      'p',
      { class: 'note' },
      'updated ',
      h('span', { dataset: { relative: String(table.updatedAt ?? '') }, text: formatRelative(table.updatedAt) }),
      ' · ',
      h('a', { class: 'link', href: `/tables#table-${encodeURIComponent(table.id)}`, text: 'open table' }),
    ),
  );
}

function renderAgents() {
  const state = getState();
  const byStatus = /** @type {Record<string, number>} */ ({});
  for (const status of AGENT_STATUSES) byStatus[status] = 0;
  for (const agent of state.agents) {
    const status = typeof agent.status === 'string' ? agent.status : 'OFFLINE';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }
  const body = panel(
    'Agent status',
    `${formatInt(state.agents.length)} registered agent(s) in the live registry`,
    state.agents.length === 0
      ? h('p', {
          class: 'muted',
          text: state.snapshotLoaded ? 'No agents are registered yet.' : 'Waiting for the agent snapshot…',
        })
      : h(
          'div',
          { class: 'stat-grid' },
          AGENT_STATUSES.map((status) =>
            h(
              'div',
              { class: 'stat' },
              h('span', { class: 'stat-label' }, statusBadge(status)),
              h('span', { class: 'stat-value', text: formatInt(byStatus[status] ?? 0) }),
            ),
          ),
        ),
    h(
      'p',
      { class: 'note' },
      h('a', { class: 'link', href: '/agents', text: 'Every agent — stacks, win rates, escrow and shared-wallet flags →' }),
    ),
  );
  clearNode(dom.agents);
  dom.agents.appendChild(body);
}

/**
 * Free and wager results are separate leaderboards (one request per mode), and
 * free chips are never compared against wagered tokens.
 *
 * @returns {void}
 */
function renderLeaderboard() {
  const mode = view.leaderMode;
  const tabs = h(
    'div',
    { class: 'tabs', role: 'tablist', 'aria-label': 'Leaderboard mode' },
    (/** @type {('FREE'|'WAGER')[]} */ (['FREE', 'WAGER'])).map((candidate) =>
      h('button', {
        class: 'tab',
        type: 'button',
        role: 'tab',
        'aria-selected': candidate === mode ? 'true' : 'false',
        dataset: { mode: candidate },
        text: candidate === 'FREE' ? 'Free mode' : 'Wager mode',
        onclick: () => {
          view.leaderMode = candidate;
          renderLeaderboard();
        },
      }),
    ),
  );

  const rows = view.leaders[mode];
  const error = view.leaderErrors[mode];
  /** @type {HTMLElement} */
  let content;
  if (error) {
    content = errorBanner(error, `the ${mode} leaderboard`);
  } else if (!rows) {
    content = h('p', { class: 'muted', text: 'Loading…' });
  } else if (rows.length === 0) {
    content = h('p', { class: 'muted', text: `No ${mode} results yet.` });
  } else {
    const { table, tbody } = tableShell([
      { label: '#', className: 'num' },
      { label: 'agent' },
      { label: 'hands', className: 'num' },
      { label: 'won', className: 'num' },
      { label: 'win rate', className: 'num' },
      { label: 'net profit' },
    ]);
    rows.slice(0, PREVIEW_LEADERS).forEach((row, index) => {
      tbody.appendChild(
        h(
          'tr',
          null,
          h('td', { class: 'num', text: String(index + 1) }),
          h('td', { text: row.name ?? row.agentId, title: row.agentId }),
          h('td', { class: 'num', text: formatInt(row.handsPlayed) }),
          h('td', { class: 'num', text: formatInt(row.handsWon) }),
          h('td', { class: 'num', text: formatWinRateFromCounts(row.handsWon, row.handsPlayed) }),
          h('td', null, moneyEl(row.netProfit, { maxFractionDigits: 6, signed: true })),
        ),
      );
    });
    content = h('div', { class: 'table-wrap' }, table);
  }

  const body = panel(
    'Leaderboards',
    `free and wager are kept apart — GET /api/v1/leaderboards?mode=FREE|WAGER · top ${PREVIEW_LEADERS}`,
    tabs,
    h('div', { role: 'tabpanel' }, content),
    h('p', { class: 'note' }, h('a', { class: 'link', href: '/agents', text: 'Every agent, live — stacks, escrow, seat and status →' })),
  );
  clearNode(dom.leaders);
  dom.leaders.appendChild(body);
}

function renderHands() {
  const { table, tbody } = tableShell([
    { label: 'ended' },
    { label: 'table' },
    { label: 'hand' },
    { label: 'mode' },
    { label: 'board' },
    { label: 'pot' },
    { label: 'winner(s)' },
    { label: 'proof' },
  ]);

  if (view.hands.length === 0) {
    tbody.appendChild(
      emptyRow(8, view.handsError ? 'Could not load hands — see the banner above.' : 'No hands recorded yet.'),
    );
  } else {
    for (const hand of view.hands.slice(0, PREVIEW_HANDS)) {
      tbody.appendChild(
        h(
          'tr',
          null,
          h('td', {
            class: 'nowrap',
            dataset: { relative: String(hand.endedAt ?? '') },
            text: formatRelative(hand.endedAt),
          }),
          h('td', { text: hand.tableName ?? hand.tableId }),
          h('td', { class: 'nowrap', text: `#${formatInt(hand.handNumber)}` }),
          h('td', null, modeTag(hand.mode)),
          h('td', null, cardRow(hand.board)),
          h('td', null, moneyEl(hand.totalPot, { maxFractionDigits: 4 })),
          h('td', { text: winnersText(hand) }),
          h(
            'td',
            { class: 'nowrap' },
            hand.fromLive
              ? badge('pending', 'pending', 'arrived on the live feed; the authoritative record follows')
              : boolBadge(hand.proofVerified ? 'VERIFIED' : 'FAILED', hand.proofVerified),
            ' ',
            handLink(hand.handId),
          ),
        ),
      );
    }
  }

  const subtitle =
    view.handsTotal === null
      ? `latest ${view.hands.length} hands`
      : `latest ${view.hands.slice(0, PREVIEW_HANDS).length} of ${formatInt(view.handsTotal)} hands`;
  const body = panel(
    'Latest hands',
    `${subtitle} · GET /api/v1/hands?limit=${DASHBOARD_HANDS}&offset=0`,
    h('div', { class: 'table-wrap' }, table),
    h(
      'p',
      { class: 'note' },
      h('a', { class: 'link', href: `/hands?limit=${HANDS_PAGE_SIZE}`, text: 'Verify any hand — audited deck, salts and Merkle proofs →' }),
    ),
  );
  clearNode(dom.hands);
  dom.hands.appendChild(body);
}

/**
 * @param {HandSummary} hand
 * @returns {string}
 */
function winnersText(hand) {
  const winners = Array.isArray(hand.winners) ? hand.winners : [];
  if (winners.length === 0) return '\u2014';
  return winners.map((w) => `${w.name ?? `seat ${w.seat}`} (${formatTokens(w.amount, { maxFractionDigits: 4 })})`).join(', ');
}

main();
