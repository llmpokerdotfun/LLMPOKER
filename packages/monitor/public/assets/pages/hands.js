/**
 * `/hands` — FR-7.3: hand-history browser plus the RNG proof explorer.
 *
 * Routing is the URL itself: no `?id=` means the paginated list, `?id=<handId>`
 * means the detail view. Filters are a plain GET form, pagination is plain
 * anchors, so the page works without any history API tricks.
 *
 * The detail view recomputes the proof **in the browser** (`verifyLocally`,
 * which imports `/vendor/shared/index.js`) and shows that verdict next to the
 * server's `/api/v1/verify/hands/:id` result, flagging any disagreement.
 */

import { getHand, getHands, getHandVerification } from '../api.js';
import { HANDS_PAGE_SIZE } from '../constants.js';
import { formatDateTime, formatInt, formatRelative, formatTokens, shortHex } from '../format.js';
import { agentName, getState, onHandComplete, startLive } from '../live.js';
import { renderProofPanel, verifyLocally } from '../proof.js';
import {
  badge,
  banner,
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

/** @typedef {import('../types.js').ActionRecord} ActionRecord */
/** @typedef {import('../types.js').HandHistory} HandHistory */
/** @typedef {import('../types.js').HandSummary} HandSummary */
/** @typedef {import('../types.js').HandVerificationResponse} HandVerificationResponse */
/** @typedef {import('../types.js').PotAward} PotAward */
/** @typedef {import('../types.js').Street} Street */

const STREETS = /** @type {Street[]} */ (['PREFLOP', 'FLOP', 'TURN', 'RIVER', 'SHOWDOWN']);

/**
 * @typedef {Object} Route
 * @property {string|null} id
 * @property {'ALL'|'FREE'|'WAGER'} mode
 * @property {string} tableId
 * @property {string} agentId
 * @property {number} offset
 * @property {number} limit
 */

/**
 * Mount points, resolved from the static skeleton in `hands.html`.
 * @type {{banner: HTMLElement, filters: HTMLElement, tableList: HTMLElement, view: HTMLElement}}
 */
const dom = {
  banner: requireElement('page-banner'),
  filters: requireElement('hands-filters'),
  tableList: requireElement('hands-table-options'),
  view: requireElement('hands-view'),
};

/** Monotonic guard so a slow response cannot overwrite a newer view. */
let renderToken = 0;
/** @type {number|null} */
let handsRefreshTimer = null;

function main() {
  renderChrome('/hands');

  renderFilters();
  renderRoute();

  startLive();
  onHandComplete(onLiveHand);
  startClock();
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) renderRoute();
  });
}

/** @returns {Route} */
function currentRoute() {
  const search = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  const rawMode = (search.get('mode') ?? hash.get('mode') ?? 'ALL').toUpperCase();
  const limit = Number(search.get('limit'));
  const offset = Number(search.get('offset'));
  return {
    id: search.get('id') ?? hash.get('id') ?? null,
    mode: rawMode === 'FREE' || rawMode === 'WAGER' ? rawMode : 'ALL',
    tableId: search.get('tableId') ?? '',
    agentId: search.get('agentId') ?? '',
    offset: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0,
    limit: Number.isFinite(limit) && limit > 0 && limit <= 200 ? Math.floor(limit) : HANDS_PAGE_SIZE,
  };
}

/**
 * @param {Route} route
 * @param {Record<string, string|number|null|undefined>} [overrides]
 * @returns {string} href for the given route state
 */
function hrefFor(route, overrides = {}) {
  const next = { ...route, ...overrides };
  const search = new URLSearchParams();
  if (next.id) search.set('id', next.id);
  if (next.mode !== 'ALL') search.set('mode', next.mode);
  if (next.tableId) search.set('tableId', next.tableId);
  if (next.agentId) search.set('agentId', next.agentId);
  if (next.limit !== HANDS_PAGE_SIZE) search.set('limit', String(next.limit));
  if (next.offset > 0) search.set('offset', String(next.offset));
  const qs = search.toString();
  return qs === '' ? '/hands' : `/hands?${qs}`;
}

function renderFilters() {
  if (!dom.filters) return;
  const route = currentRoute();
  const modeSelect = dom.filters.querySelector('select[name="mode"]');
  if (modeSelect instanceof HTMLSelectElement) modeSelect.value = route.mode;
  const tableInput = dom.filters.querySelector('input[name="tableId"]');
  if (tableInput instanceof HTMLInputElement) tableInput.value = route.tableId;
  const agentInput = dom.filters.querySelector('input[name="agentId"]');
  if (agentInput instanceof HTMLInputElement) agentInput.value = route.agentId;
  const limitSelect = dom.filters.querySelector('select[name="limit"]');
  if (limitSelect instanceof HTMLSelectElement) limitSelect.value = String(route.limit);
}

/** Populates the table-id datalist from the live snapshot. */
function renderTableOptions() {
  if (!dom.tableList) return;
  clearNode(dom.tableList);
  for (const table of getState().tables) {
    dom.tableList.appendChild(h('option', { value: table.id, label: `${table.name} (${table.mode})` }));
  }
}

function renderRoute() {
  renderFilters();
  renderTableOptions();
  const route = currentRoute();
  if (route.id) void renderDetail(route);
  else void renderList(route);
}

/**
 * @param {HandSummary} summary
 * @returns {void}
 */
function onLiveHand(summary) {
  const route = currentRoute();
  if (route.id) return; // the detail view is immutable history
  const state = getState();
  if (!state.snapshotLoaded) return;
  if (handsRefreshTimer !== null) return;
  handsRefreshTimer = window.setTimeout(() => {
    handsRefreshTimer = null;
    if (route.offset === 0) void renderList(currentRoute());
    else showBanner(dom.banner, banner('info', `Hand ${summary.handId} just finished`, 'Reload to see it in this page, or go to page 1.', null));
  }, 2500);
}

// ---------------------------------------------------------------------------
// List view
// ---------------------------------------------------------------------------

/**
 * @param {Route} route
 * @returns {Promise<void>}
 */
async function renderList(route) {
  const token = ++renderToken;
  clearNode(dom.view);
  dom.view.appendChild(panel('Hand history', 'GET /api/v1/hands', h('p', { class: 'muted', text: 'Loading…' })));

  /** @type {HandSummary[]} */
  let hands = [];
  let total = 0;
  try {
    const data = await getHands({
      limit: route.limit,
      offset: route.offset,
      tableId: route.tableId,
      agentId: route.agentId,
      mode: route.mode === 'ALL' ? '' : route.mode,
    });
    hands = Array.isArray(data?.hands) ? data.hands : [];
    total = typeof data?.total === 'number' ? data.total : hands.length;
    showBanner(dom.banner, null);
  } catch (err) {
    if (token !== renderToken) return;
    clearNode(dom.view);
    dom.view.appendChild(panel('Hand history', 'GET /api/v1/hands', errorBanner(err, 'the hand list')));
    return;
  }
  if (token !== renderToken) return;

  const { table, tbody } = tableShell([
    { label: 'ended' },
    { label: 'table' },
    { label: 'hand' },
    { label: 'mode' },
    { label: 'street' },
    { label: 'board' },
    { label: 'pot' },
    { label: 'rake' },
    { label: 'players', className: 'num' },
    { label: 'winner(s)' },
    { label: 'commitment' },
    { label: 'N / N+1 / M' },
    { label: 'proof' },
  ]);

  if (hands.length === 0) {
    tbody.appendChild(emptyRow(13, 'No hands match these filters.'));
  }
  for (const hand of hands) {
    tbody.appendChild(
      h(
        'tr',
        null,
        h(
          'td',
          { class: 'nowrap' },
          h('span', { dataset: { relative: String(hand.endedAt ?? '') }, text: formatRelative(hand.endedAt) }),
          h('span', { class: 'muted small block', text: formatDateTime(hand.endedAt) }),
        ),
        h('td', null, h('a', { class: 'link', href: hrefFor(route, { id: null, tableId: hand.tableId, offset: 0 }), text: hand.tableName ?? hand.tableId, title: hand.tableId })),
        h('td', { class: 'nowrap', text: `#${formatInt(hand.handNumber)}` }),
        h('td', null, modeTag(hand.mode)),
        h('td', { text: hand.streetReached ?? '—' }),
        h('td', null, cardRow(hand.board)),
        h('td', null, moneyEl(hand.totalPot, { maxFractionDigits: 6 })),
        h('td', null, moneyEl(hand.totalRake, { maxFractionDigits: 6 })),
        h('td', { class: 'num', text: formatInt(hand.playerCount) }),
        h('td', { text: winnersText(hand) }),
        h('td', null, h('code', { class: 'hash', text: shortHex(hand.commitment, 10, 6), title: hand.commitment || 'no commitment in this summary' })),
        h('td', { class: 'nowrap muted', text: `${blockText(hand.commitBlock)} / ${blockText(hand.anchorBlock)} / ${blockText(hand.revealBlock)}` }),
        h(
          'td',
          { class: 'nowrap' },
          hand.fromLive
            ? badge('pending', 'pending', 'arrived on the live feed; the authoritative record follows')
            : badge(hand.proofVerified ? 'VERIFIED' : 'FAILED', hand.proofVerified ? 'verified' : 'failed'),
          ' ',
          handLink(hand.handId, { mode: route.mode === 'ALL' ? '' : route.mode, tableId: route.tableId, agentId: route.agentId, offset: route.offset, limit: route.limit }),
        ),
      ),
    );
  }

  const page = Math.floor(route.offset / route.limit) + 1;
  const pages = Math.max(1, Math.ceil(total / route.limit));
  const pager = h(
    'nav',
    { class: 'pager', 'aria-label': 'Pagination' },
    route.offset > 0
      ? h('a', { class: 'button', href: hrefFor(route, { id: null, offset: Math.max(0, route.offset - route.limit) }), text: '← Newer' })
      : h('span', { class: 'button button-disabled', text: '← Newer' }),
    h('span', { class: 'pager-info', text: `page ${formatInt(page)} of ${formatInt(pages)} · ${formatInt(total)} hand(s)` }),
    route.offset + hands.length < total
      ? h('a', { class: 'button', href: hrefFor(route, { id: null, offset: route.offset + route.limit }), text: 'Older →' })
      : h('span', { class: 'button button-disabled', text: 'Older →' }),
  );

  const filtersText = [
    route.mode === 'ALL' ? 'all modes' : `mode ${route.mode}`,
    route.tableId ? `table ${route.tableId}` : null,
    route.agentId ? `agent ${route.agentId}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  clearNode(dom.view);
  dom.view.appendChild(
    panel(
      'Hand history',
      `GET /api/v1/hands?limit=${route.limit}&offset=${route.offset} · ${filtersText} · ${formatInt(total)} hand(s)`,
      h(
        'p',
        { class: 'note' },
        'Every row carries the commit-reveal proof fields. Open ',
        h('strong', { text: 'proof' }),
        ' to recompute the shuffle in this browser and compare it with the server verdict.',
      ),
      h('div', { class: 'table-wrap' }, table),
      pager,
    ),
  );
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

/**
 * @param {number|null|undefined} block
 * @returns {string}
 */
function blockText(block) {
  return typeof block === 'number' ? String(block) : '—';
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

/**
 * @param {Route} route
 * @returns {Promise<void>}
 */
async function renderDetail(route) {
  const token = ++renderToken;
  const handId = route.id ?? '';
  clearNode(dom.view);
  dom.view.appendChild(panel('Hand detail', `GET /api/v1/hands/${handId}`, h('p', { class: 'muted', text: 'Loading…' })));

  const [historyResult, verifyResult] = await Promise.allSettled([getHand(handId), getHandVerification(handId)]);
  if (token !== renderToken) return;

  if (historyResult.status === 'rejected') {
    clearNode(dom.view);
    dom.view.appendChild(
      panel(
        'Hand detail',
        handId,
        errorBanner(historyResult.reason, `hand ${handId}`),
        h('p', { class: 'note' }, h('a', { class: 'link', href: hrefFor(route, { id: null }), text: '← back to the hand list' })),
      ),
    );
    return;
  }

  const history = /** @type {HandHistory} */ (historyResult.value);
  const server = verifyResult.status === 'fulfilled' ? /** @type {HandVerificationResponse} */ (verifyResult.value) : null;
  const serverError = verifyResult.status === 'rejected' ? /** @type {Error} */ (verifyResult.reason) : null;

  const proofContainer = h('section', { class: 'panel proof-panel' });
  clearNode(dom.view);
  showBanner(dom.banner, null);
  dom.view.appendChild(handHeader(history, route));
  dom.view.appendChild(handBody(history));
  dom.view.appendChild(proofContainer);

  // In-browser recomputation happens after first paint so the hand is visible
  // immediately even if the shared bundle is slow or missing.
  const client = await verifyLocally(history);
  if (token !== renderToken) return;
  if (client.error) {
    showBanner(
      dom.banner,
      banner(
        'warning',
        'In-browser proof verification is unavailable',
        client.error.message,
        'The hand and the server verdict are still shown. Build @llmpoker/shared so /vendor/shared/index.js exists to enable independent verification.',
      ),
    );
  }
  renderProofPanel(proofContainer, { history, client, server, serverError });
  startClock();
}

/**
 * @param {HandHistory} history
 * @param {Route} route
 * @returns {HTMLElement}
 */
function handHeader(history, route) {
  const result = history.result;
  return panel(
    `Hand ${result.handId}`,
    `${result.mode} · table ${result.tableId} · hand #${formatInt(result.handNumber)} · street reached ${result.streetReached}`,
    h(
      'div',
      { class: 'stat-grid' },
      stat('hand id', h('code', { class: 'hash', text: result.handId, title: result.handId })),
      stat('mode', modeTag(result.mode)),
      stat('board', cardRow(result.board)),
      stat('total pot', moneyEl(result.totalPot, { maxFractionDigits: 6 })),
      stat('total rake', moneyEl(result.totalRake, { maxFractionDigits: 6 })),
      stat('button seat', `seat ${formatInt(result.buttonSeat)}`),
      stat('started', formatDateTime(result.startedAt)),
      stat('ended', formatDateTime(result.endedAt)),
      stat(
        'chips zero-sum',
        result.zeroSumVerified
          ? badge('verified', 'verified', 'stack deltas sum to zero across all seats')
          : badge('not verified', 'failed', 'the engine did not assert zero-sum settlement for this hand'),
      ),
      stat(
        'proof (server flag)',
        history.proof.verified
          ? badge('verified', 'verified', 'the server stored this proof as verified')
          : badge('not verified', 'failed', 'RngProof.verified is false'),
      ),
    ),
    h(
      'p',
      { class: 'note' },
      h('a', { class: 'link', href: hrefFor(route, { id: null }), text: '← back to the hand list' }),
      ' · ',
      h('a', { class: 'link', href: `/tables#${encodeURIComponent(result.tableId)}`, text: 'table' }),
      ' · ',
      h('a', { class: 'link', href: `/agents`, text: 'agents' }),
    ),
  );
}

/**
 * @param {string} label
 * @param {any} value
 * @returns {HTMLElement}
 */
function stat(label, value) {
  return h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: label }), h('span', { class: 'stat-value' }, value));
}

/**
 * @param {HandHistory} history
 * @returns {HTMLElement}
 */
function handBody(history) {
  const result = history.result;
  return h(
    'div',
    { class: 'detail-stack' },
    seatsSection(history),
    showdownSection(history),
    actionsSection(history),
    potsSection(history),
    h(
      'section',
      { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', { class: 'panel-title', text: 'Dealing facts' })),
      h(
        'div',
        { class: 'panel-body' },
        h(
          'dl',
          { class: 'kv-inline wide' },
          h('dt', { text: 'dealing order (from SB)' }),
          h('dd', { text: (result.dealingOrder ?? []).join(' → ') || '—' }),
          h('dt', { text: 'burns' }),
          h('dd', null, cardRow(result.burns)),
          h('dt', { text: 'cards consumed' }),
          h('dd', {
            text: `${formatInt((result.dealingOrder?.length ?? 0) * 2 + ((result.burns?.length ?? 0) > 0 ? 8 : 5))} of 52 (RNG.md §4)`,
          }),
          h('dt', { text: 'deck length published' }),
          h('dd', { text: `${formatInt(history.deck?.length ?? 0)} cards` }),
        ),
      ),
    ),
  );
}

/**
 * @param {HandHistory} history
 * @returns {HTMLElement}
 */
function seatsSection(history) {
  const result = history.result;
  const { table, tbody } = tableShell([
    { label: 'seat', className: 'num' },
    { label: 'agent' },
    { label: 'hole cards' },
    { label: 'start' },
    { label: 'end' },
    { label: 'net' },
    { label: 'state' },
  ]);
  for (const seat of result.seats) {
    tbody.appendChild(
      h(
        'tr',
        { class: seat.folded ? 'row-dim' : null },
        h('td', { class: 'num', text: String(seat.seat) }),
        h('td', { text: seat.agentId ? agentName(seat.agentId) : '—', title: seat.agentId ?? '' }),
        h('td', null, cardRow(seat.holeCards)),
        h('td', null, moneyEl(seat.startingStack, { maxFractionDigits: 6 })),
        h('td', null, moneyEl(seat.endingStack, { maxFractionDigits: 6 })),
        h('td', null, moneyEl(seat.net, { maxFractionDigits: 6, signed: true })),
        h(
          'td',
          null,
          seat.folded ? badge('folded', 'muted') : null,
          ' ',
          seat.allIn ? badge('all-in', 'warn') : null,
          ' ',
          !seat.folded && !seat.allIn ? badge('live', 'active') : null,
        ),
      ),
    );
  }
  return panel(
    'Seats',
    'starting stack / ending stack / net, with the hole cards recorded in the history',
    h('div', { class: 'table-wrap' }, table),
  );
}

/**
 * @param {HandHistory} history
 * @returns {HTMLElement}
 */
function showdownSection(history) {
  const showdown = history.result.showdown ?? [];
  if (showdown.length === 0) {
    return panel(
      'Showdown',
      'no hand was tabled (everyone folded, or the hand ended early)',
      h('p', { class: 'muted', text: 'No revealed hands in this history.' }),
    );
  }
  const { table, tbody } = tableShell([
    { label: 'seat', className: 'num' },
    { label: 'agent' },
    { label: 'cards' },
    { label: 'category' },
    { label: 'description' },
  ]);
  for (const reveal of showdown) {
    const seatInfo = history.result.seats.find((s) => s.seat === reveal.seat);
    tbody.appendChild(
      h(
        'tr',
        null,
        h('td', { class: 'num', text: String(reveal.seat) }),
        h('td', { text: seatInfo?.agentId ? agentName(seatInfo.agentId) : '—' }),
        h('td', null, cardRow(reveal.cards)),
        h('td', { text: reveal.category ?? '—' }),
        h('td', { text: reveal.description ?? '—' }),
      ),
    );
  }
  return panel('Showdown', 'what each seat tabled at the end of the hand', h('div', { class: 'table-wrap' }, table));
}

/**
 * @param {HandHistory} history
 * @returns {HTMLElement}
 */
function actionsSection(history) {
  const actions = history.result.actions ?? [];
  const container = h('section', { class: 'panel' });
  container.appendChild(
    h(
      'div',
      { class: 'panel-head' },
      h('h2', { class: 'panel-title', text: 'Actions by street' }),
      h('p', { class: 'panel-subtitle', text: 'seq · seat · action · paid · pot after · origin (AGENT / TIMEOUT / ENGINE)' }),
    ),
  );
  const body = h('div', { class: 'panel-body' });
  if (actions.length === 0) {
    body.appendChild(h('p', { class: 'muted', text: 'No actions were recorded.' }));
    container.appendChild(body);
    return container;
  }
  for (const street of STREETS) {
    const list = actions.filter((action) => action.street === street);
    if (list.length === 0) continue;
    const { table, tbody } = tableShell([
      { label: 'seq', className: 'num' },
      { label: 'seat', className: 'num' },
      { label: 'agent' },
      { label: 'action' },
      { label: 'amount' },
      { label: 'paid' },
      { label: 'pot after' },
      { label: 'origin' },
      { label: 'at' },
    ]);
    for (const action of list) {
      const seatInfo = history.result.seats.find((s) => s.seat === action.seat);
      tbody.appendChild(actionRow(action, seatInfo?.agentId ?? null));
    }
    body.appendChild(
      h(
        'div',
        { class: 'street-group' },
        h('h3', { class: 'subblock-title', text: `${street} (${list.length})` }),
        h('div', { class: 'table-wrap' }, table),
      ),
    );
  }
  container.appendChild(body);
  return container;
}

/**
 * @param {ActionRecord} action
 * @param {string|null} agentId
 * @returns {HTMLElement}
 */
function actionRow(action, agentId) {
  return h(
    'tr',
    { class: action.origin === 'AGENT' ? null : 'row-warn' },
    h('td', { class: 'num', text: String(action.seq) }),
    h('td', { class: 'num', text: String(action.seat) }),
    h('td', { text: agentId ? agentName(agentId) : '—' }),
    h('td', null, badge(action.action, action.action === 'FOLD' ? 'muted' : 'info')),
    h('td', null, moneyEl(action.amount, { maxFractionDigits: 6 })),
    h('td', null, moneyEl(action.paid, { maxFractionDigits: 6 })),
    h('td', null, moneyEl(action.potAfter, { maxFractionDigits: 6 })),
    h('td', null, statusBadge(action.origin), action.origin === 'AGENT' ? null : h('span', { class: 'muted small', text: ' auto-applied' })),
    h('td', { class: 'muted nowrap', text: formatDateTime(action.at) }),
  );
}

/**
 * @param {HandHistory} history
 * @returns {HTMLElement}
 */
function potsSection(history) {
  const result = history.result;
  const pots = result.pots ?? [];
  const { table, tbody } = tableShell([
    { label: 'pot' },
    { label: 'amount' },
    { label: 'rake' },
    { label: 'winner(s)' },
    { label: 'odd chip' },
  ]);
  if (pots.length === 0) {
    tbody.appendChild(emptyRow(5, 'No pot awards recorded.'));
  }
  for (const pot of pots) {
    tbody.appendChild(
      h(
        'tr',
        null,
        h('td', { text: pot.potIndex === 0 ? 'main' : `side ${pot.potIndex}` }),
        h('td', null, moneyEl(pot.amount, { maxFractionDigits: 6 })),
        h('td', null, moneyEl(pot.rake, { maxFractionDigits: 6 })),
        h(
          'td',
          null,
          (pot.winners ?? []).map((winner) => {
            const seatInfo = result.seats.find((s) => s.seat === winner.seat);
            return h(
              'span',
              { class: 'winner' },
              `${seatInfo?.agentId ? agentName(seatInfo.agentId) : `seat ${winner.seat}`} `,
              moneyEl(winner.amount, { maxFractionDigits: 6 }),
              ' ',
            );
          }),
        ),
        h('td', { text: pot.oddChipSeat === null || pot.oddChipSeat === undefined ? '—' : `seat ${pot.oddChipSeat}` }),
      ),
    );
  }
  return panel(
    'Pots and awards',
    'rake is deducted per pot at settlement (FR-8.1, FR-8.2); the odd chip rule is in FR-3.4',
    h('div', { class: 'table-wrap' }, table),
    h(
      'p',
      { class: 'note' },
      'total pot ',
      moneyEl(result.totalPot, { maxFractionDigits: 6 }),
      ' · total rake ',
      moneyEl(result.totalRake, { maxFractionDigits: 6 }),
      ' · ',
      result.zeroSumVerified ? badge('zero-sum verified', 'verified') : badge('zero-sum NOT verified', 'failed'),
    ),
  );
}

main();
