/**
 * Dashboard (`/`): platform health, live tables, latest hands and the two
 * separated leaderboards (FR-7.4) — one request per mode.
 */

import { getHands, getHealth, getLeaderboard } from '../api.js';
import { DASHBOARD_HANDS, EXPECTED_CHAIN_ID, HANDS_PAGE_SIZE } from '../constants.js';
import { formatDateTime, formatInt, formatRelative, formatTokens, formatUptime, formatWinRateFromCounts } from '../format.js';
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
  showBanner,
  startClock,
  statusBadge,
  tableShell,
} from '../ui.js';

/** @typedef {import('../types.js').HandSummary} HandSummary */
/** @typedef {import('../types.js').HealthResponse} HealthResponse */
/** @typedef {import('../types.js').LeaderboardRow} LeaderboardRow */
/** @typedef {import('../types.js').TableSnapshot} TableSnapshot */

/**
 * Mount points, resolved from the static skeleton in `index.html`.
 * @type {{banner: HTMLElement, health: HTMLElement, tables: HTMLElement, hands: HTMLElement, leaderboard: HTMLElement}}
 */
const dom = {
  banner: requireElement('page-banner'),
  health: requireElement('health-panel'),
  tables: requireElement('live-tables-panel'),
  hands: requireElement('latest-hands-panel'),
  leaderboard: requireElement('leaderboard-panel'),
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
  /** @type {Record<string, LeaderboardRow[]|null>} */
  leaders: { FREE: null, WAGER: null },
  /** @type {Record<string, Error|null>} */
  leaderErrors: { FREE: null, WAGER: null },
  /** @type {'FREE'|'WAGER'} */
  leaderMode: 'FREE',
  /** @type {number|null} */
  handsTotal: null,
};

/** @type {number|null} */
let handsRefreshTimer = null;

function main() {
  renderChrome('/');

  renderHealth();
  renderLiveTables();
  renderHands();
  renderLeaderboard();

  startLive();
  subscribe(renderLiveTables);
  onHandComplete(onLiveHand);
  startClock();

  void loadHealth();
  void loadHands();
  void loadLeaderboard('FREE');
  void loadLeaderboard('WAGER');
  window.setInterval(() => void loadHealth(), 10000);
}

async function loadHealth() {
  try {
    view.health = await getHealth();
    view.healthError = null;
    showBanner(dom.banner, null);
  } catch (err) {
    view.healthError = /** @type {Error} */ (err);
    // FR-7.6: the API being unreachable must be stated, not implied by blanks.
    showBanner(dom.banner, errorBanner(err, 'the platform health endpoint (/api/v1/health)'));
  }
  renderHealth();
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
 * @param {'FREE'|'WAGER'} mode
 */
async function loadLeaderboard(mode) {
  try {
    const data = await getLeaderboard(mode);
    view.leaders[mode] = Array.isArray(data?.rows) ? data.rows : [];
    view.leaderErrors[mode] = null;
  } catch (err) {
    view.leaderErrors[mode] = /** @type {Error} */ (err);
  }
  renderLeaderboard();
}

/**
 * A hand that just finished arrives as a delta first (FR-7.5); it is shown
 * immediately and reconciled against `/api/v1/hands` a moment later.
 *
 * @param {HandSummary} summary
 */
function onLiveHand(summary) {
  const existing = view.hands.find((row) => row.handId === summary.handId);
  if (existing) return;
  view.hands = [summary, ...view.hands].slice(0, DASHBOARD_HANDS);
  renderHands();
  if (handsRefreshTimer !== null) return;
  handsRefreshTimer = window.setTimeout(() => {
    handsRefreshTimer = null;
    void loadHands();
  }, 2500);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderHealth() {
  if (!dom.health) return;
  const body = panel(
    'Platform health',
    'GET /api/v1/health — read-only, no auth',
    healthContent(),
  );
  clearNode(dom.health);
  dom.health.appendChild(body);
}

/** @returns {HTMLElement} */
function healthContent() {
  const health = view.health;
  if (!health) {
    if (view.healthError) return errorBanner(view.healthError, 'platform health');
    return h('p', { class: 'muted', text: 'Loading…' });
  }
  const chainMismatch = typeof health.chainId === 'number' && health.chainId !== EXPECTED_CHAIN_ID;
  const tiles = [
    stat('status', health.ok ? badge('ok', 'verified') : badge('degraded', 'warn')),
    stat('version', health.version ?? '—'),
    stat('chain id', chainMismatch ? badge(`${health.chainId}`, 'warn', `this monitor expects ${EXPECTED_CHAIN_ID}`) : String(health.chainId)),
    stat('uptime', formatUptime(health.uptimeSeconds)),
    stat('free tables', formatInt(health.freeTables)),
    stat('wager tables', formatInt(health.wagerTables)),
    stat('agents', formatInt(health.agents)),
    stat('hands played', formatInt(health.hands)),
  ];
  return h('div', null, h('div', { class: 'stat-grid' }, tiles), chainMismatch ? h('p', { class: 'note warn-text', text: `Chain id ${health.chainId} is not the expected settlement chain ${EXPECTED_CHAIN_ID}.` }) : null);
}

/**
 * @param {string} label
 * @param {any} value
 * @returns {HTMLElement}
 */
function stat(label, value) {
  return h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: label }), h('span', { class: 'stat-value' }, value));
}

function renderLiveTables() {
  if (!dom.tables) return;
  const state = getState();
  const tables = [...state.tables].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const running = tables.filter((t) => t.status === 'RUNNING');
  const seated = tables.reduce((sum, t) => sum + t.seats.filter((s) => s.agentId !== null).length, 0);

  const body = panel(
    'Live tables',
    `${formatInt(tables.length)} table(s) · ${formatInt(running.length)} running · ${formatInt(seated)} seat(s) filled${
      state.connection === 'LIVE' ? ' · live feed' : ' · polled every 3 s'
    }`,
    tables.length === 0
      ? h('p', { class: 'muted', text: state.snapshotLoaded ? 'No tables are open right now.' : 'Waiting for the monitor feed…' })
      : h('div', { class: 'tile-grid' }, tables.slice(0, 6).map(tableTile)),
    h(
      'p',
      { class: 'note' },
      h('a', { class: 'link', href: '/tables', text: 'All tables with seats, action clocks and RNG commitments →' }),
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
  const occupied = table.seats.filter((s) => s.agentId !== null).length;
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
      h('dd', { text: table.street ?? '—' }),
      h('dt', { text: 'seats' }),
      h('dd', { text: `${occupied}/${table.seats.length}` }),
      h('dt', { text: 'pot' }),
      h('dd', null, moneyEl(table.totalPot)),
      h('dt', { text: 'hand' }),
      h('dd', { text: table.handId ? `#${table.handNumber}` : '—' }),
      h('dt', { text: 'blinds' }),
      h('dd', { text: `${formatTokens(table.config.smallBlind)}/${formatTokens(table.config.bigBlind)}` }),
    ),
    h(
      'p',
      { class: 'note' },
      'updated ',
      h('span', { dataset: { relative: String(table.updatedAt ?? '') }, text: formatRelative(table.updatedAt) }),
      table.handId ? ' · ' : '',
      table.handId ? handLink(table.handId, { tableId: table.id }, 'latest hand proof') : null,
    ),
  );
}

function renderHands() {
  if (!dom.hands) return;
  const { table, tbody } = tableShell([
    { label: 'ended' },
    { label: 'table' },
    { label: 'hand' },
    { label: 'mode' },
    { label: 'board' },
    { label: 'pot' },
    { label: 'rake' },
    { label: 'winner(s)' },
    { label: 'players', className: 'num' },
    { label: 'proof' },
  ]);

  if (view.hands.length === 0) {
    tbody.appendChild(emptyRow(10, view.handsError ? 'Could not load hands — see the banner above.' : 'No hands recorded yet.'));
  } else {
    for (const hand of view.hands) {
      tbody.appendChild(
        h(
          'tr',
          null,
          h('td', { class: 'nowrap' }, h('span', { dataset: { relative: String(hand.endedAt ?? '') }, text: formatRelative(hand.endedAt) }), h('span', { class: 'muted small', text: ` ${formatDateTime(hand.endedAt).slice(11)}` })),
          h('td', { text: hand.tableName ?? hand.tableId }),
          h('td', { class: 'nowrap', text: `#${hand.handNumber}` }),
          h('td', null, modeTag(hand.mode)),
          h('td', null, cardRow(hand.board)),
          h('td', null, moneyEl(hand.totalPot, { maxFractionDigits: 4 })),
          h('td', null, moneyEl(hand.totalRake, { maxFractionDigits: 4 })),
          h('td', { text: winnersText(hand) }),
          h('td', { class: 'num', text: formatInt(hand.playerCount) }),
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

  const subtitle = view.handsTotal === null ? 'latest 10 hands' : `latest ${view.hands.length} of ${formatInt(view.handsTotal)} hands`;
  const body = panel(
    'Latest hands',
    `${subtitle} · GET /api/v1/hands?limit=${DASHBOARD_HANDS}&offset=0`,
    h('div', { class: 'table-wrap' }, table),
    h(
      'p',
      { class: 'note' },
      h('a', { class: 'link', href: `/hands?limit=${HANDS_PAGE_SIZE}`, text: 'Browse all hands with the RNG proof explorer →' }),
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
  if (winners.length === 0) return '—';
  return winners.map((w) => `${w.name ?? `seat ${w.seat}`} (${formatTokens(w.amount, { maxFractionDigits: 4 })})`).join(', ');
}

function renderLeaderboard() {
  if (!dom.leaderboard) return;
  const mode = view.leaderMode;
  const tabs = h(
    'div',
    { class: 'tabs', role: 'tablist' },
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
    content = errorBanner(error, `${mode} leaderboard`);
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
      { label: 'volume' },
    ]);
    rows.forEach((row, index) => {
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
          h('td', null, moneyEl(row.volume, { maxFractionDigits: 4 })),
        ),
      );
    });
    content = h('div', { class: 'table-wrap' }, table);
  }

  const body = panel(
    'Leaderboards',
    'free and wager are separate — GET /api/v1/leaderboards?mode=FREE|WAGER',
    tabs,
    h('div', { role: 'tabpanel' }, content),
  );
  clearNode(dom.leaderboard);
  dom.leaderboard.appendChild(body);
}

main();
