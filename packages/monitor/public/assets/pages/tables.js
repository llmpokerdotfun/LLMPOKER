/**
 * `/tables` — FR-7.2: active tables with stakes, seat occupancy, street, pot,
 * button, the live action clock and the RNG commitment of the in-flight hand.
 *
 * The 1 Hz countdown is driven by `[data-deadline]` nodes handled by
 * `ui.startClock()`, so only the clock text node is touched every second.
 */

import { formatBps, formatDateTime, formatInt, formatRelative, formatTokens, parseChips, shortHex } from '../format.js';
import { getActionRequest, getState, startLive, subscribe } from '../live.js';
import {
  badge,
  banner,
  cardRow,
  clearNode,
  faceDownCards,
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

/** @typedef {import('../types.js').ActionRequest} ActionRequest */
/** @typedef {import('../types.js').SeatSnapshot} SeatSnapshot */
/** @typedef {import('../types.js').TableSnapshot} TableSnapshot */

/**
 * Mount points, resolved from the static skeleton in `tables.html`.
 * @type {{summary: HTMLElement, list: HTMLElement, banner: HTMLElement, modeFilter: HTMLElement, filter: HTMLElement}}
 */
const dom = {
  summary: requireElement('tables-summary'),
  list: requireElement('tables-list'),
  banner: requireElement('page-banner'),
  modeFilter: requireElement('tables-mode-filter'),
  filter: requireElement('tables-filter'),
};

const view = {
  /** @type {'ALL'|'FREE'|'WAGER'} */
  mode: 'ALL',
  query: '',
};

function main() {
  renderChrome('/tables');

  dom.modeFilter.addEventListener('change', () => {
    const value = dom.modeFilter instanceof HTMLSelectElement ? dom.modeFilter.value : 'ALL';
    view.mode = value === 'FREE' || value === 'WAGER' ? value : 'ALL';
    render();
  });
  dom.filter.addEventListener('input', () => {
    view.query = dom.filter instanceof HTMLInputElement ? dom.filter.value.toLowerCase() : '';
    render();
  });

  render();
  startLive();
  subscribe(render);
  startClock();
}

/**
 * @param {TableSnapshot} table
 * @returns {boolean}
 */
function matches(table) {
  if (view.mode !== 'ALL' && table.mode !== view.mode) return false;
  if (view.query === '') return true;
  return (
    String(table.name ?? '').toLowerCase().includes(view.query) ||
    String(table.id ?? '').toLowerCase().includes(view.query)
  );
}

function render() {
  const state = getState();
  const tables = [...state.tables].filter(matches).sort((a, b) => {
    /** @param {TableSnapshot} t */
    const rank = (t) => (t.status === 'RUNNING' ? 0 : t.status === 'OPEN' ? 1 : 2);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return String(a.name ?? '').localeCompare(String(b.name ?? ''));
  });

  renderFeedWarning(state.connection, state.lastError, state.tables.length);
  renderSummary(state.tables);
  renderTables(tables, state.snapshotLoaded);
}

/**
 * @param {string} connection
 * @param {string|null} lastError
 * @param {number} tableCount
 * @returns {void}
 */
function renderFeedWarning(connection, lastError, tableCount) {
  if (!dom.banner) return;
  if ((connection === 'LIVE' && !lastError) || (tableCount > 0 && connection !== 'OFFLINE')) {
    showBanner(dom.banner, null);
    return;
  }
  showBanner(
    dom.banner,
    banner(
      connection === 'OFFLINE' ? 'error' : 'warning',
      connection === 'OFFLINE' ? 'Monitor feed offline' : 'Monitor feed reconnecting',
      lastError ??
        'The live WebSocket is down. Tables are being polled from /api/v1/tables every 3 s, so action clocks may lag by up to 3 s.',
      null,
    ),
  );
}

/**
 * @param {TableSnapshot[]} tables
 * @returns {void}
 */
function renderSummary(tables) {
  if (!dom.summary) return;
  const running = tables.filter((t) => t.status === 'RUNNING').length;
  const open = tables.filter((t) => t.status === 'OPEN').length;
  const seated = tables.reduce((sum, t) => sum + t.seats.filter((s) => s.agentId !== null).length, 0);
  const caps = tables.reduce((sum, t) => sum + t.seats.length, 0);
  const free = tables.filter((t) => t.mode === 'FREE').length;
  const wager = tables.filter((t) => t.mode === 'WAGER').length;
  const pots = tables.reduce((sum, table) => {
    const pot = parseChips(table.totalPot);
    return pot === null ? sum : sum + pot;
  }, 0n);

  clearNode(dom.summary);
  dom.summary.appendChild(
    h(
      'div',
      { class: 'stat-grid' },
      stat('tables', formatInt(tables.length)),
      stat('running', formatInt(running)),
      stat('open', formatInt(open)),
      stat('seats filled', `${formatInt(seated)}/${formatInt(caps)}`),
      stat('free / wager', `${formatInt(free)} / ${formatInt(wager)}`),
      stat('chips in pots', moneyEl(pots, { maxFractionDigits: 6 })),
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
 * @param {TableSnapshot[]} tables
 * @param {boolean} snapshotLoaded
 * @returns {void}
 */
function renderTables(tables, snapshotLoaded) {
  if (!dom.list) return;
  clearNode(dom.list);
  if (tables.length === 0) {
    dom.list.appendChild(
      panel(
        'Tables',
        'GET /api/v1/tables',
        h('p', {
          class: 'muted',
          text: snapshotLoaded ? 'No tables match the current filter.' : 'Waiting for the table snapshot from the monitor feed…',
        }),
      ),
    );
    return;
  }
  for (const table of tables) dom.list.appendChild(tableCard(table));
}

/**
 * @param {TableSnapshot} table
 * @returns {HTMLElement}
 */
function tableCard(table) {
  const request = getActionRequest(table.id);
  const deadline = request?.deadlineTs ?? table.actionDeadlineTs;
  const street = table.street ?? '—';
  const href = `/tables#${encodeURIComponent(table.id)}`;

  return h(
    'section',
    { class: 'panel table-card', id: `table-${table.id}` },
    h(
      'div',
      { class: 'panel-head' },
      h(
        'h2',
        { class: 'panel-title' },
        h('a', { class: 'plain-link', href, text: table.name }),
        ' ',
        modeTag(table.mode),
        ' ',
        statusBadge(table.status),
      ),
      h(
        'p',
        { class: 'panel-subtitle' },
        'table ',
        h('code', { class: 'hash', text: table.id }),
        ' · hand ',
        table.handId ? h('code', { class: 'hash', text: table.handId, title: table.handId }) : '—',
        ` · #${formatInt(table.handNumber)}`,
        ' · updated ',
        h('span', { dataset: { relative: String(table.updatedAt ?? '') }, text: formatRelative(table.updatedAt) }),
      ),
    ),
    h(
      'div',
      { class: 'panel-body' },
      h(
        'div',
        { class: 'table-topline' },
        h(
          'div',
          { class: 'clock-box' },
          h('span', { class: 'clock-label', text: 'street' }),
          h('span', { class: 'clock-value', text: street }),
          h('span', { class: 'clock-label', text: 'action clock' }),
          deadline === null || deadline === undefined
            ? h('span', { class: 'clock-value muted', text: 'no action pending' })
            : h(
                'span',
                { class: 'clock-value clock' },
                h('span', { class: 'clock-count', dataset: { deadline: String(deadline) }, text: '—' }),
                h('span', { class: 'clock-who', text: table.toActSeat === null ? '' : ` · seat ${table.toActSeat} to act` }),
                h('span', { class: 'clock-deadline muted small', text: ` · deadline ${formatDateTime(deadline)}` }),
              ),
        ),
        h(
          'div',
          { class: 'pot-box' },
          h('span', { class: 'clock-label', text: 'total pot' }),
          h('span', { class: 'stat-value' }, moneyEl(table.totalPot, { maxFractionDigits: 6 })),
          h('span', { class: 'clock-label', text: 'current bet' }),
          h('span', { class: 'stat-value' }, moneyEl(table.currentBet, { maxFractionDigits: 6 })),
          h('span', { class: 'clock-label', text: 'min raise to' }),
          h('span', { class: 'stat-value' }, moneyEl(table.minRaiseTo, { maxFractionDigits: 6 })),
        ),
        h(
          'div',
          { class: 'rng-box' },
          h('span', { class: 'clock-label', text: 'RNG commitment (in-flight hand)' }),
          table.rngCommitment
            ? h('code', { class: 'hash', text: shortHex(table.rngCommitment, 18, 12), title: table.rngCommitment })
            : h('span', { class: 'muted', text: table.handId ? 'awaiting commit (free mode may use a local PRNG, FR-4.4)' : 'no hand in flight' }),
          h(
            'span',
            { class: 'clock-label', text: 'board' },
            ' ',
            cardRow(table.board),
          ),
          table.handId ? h('span', null, handLink(table.handId, { tableId: table.id }, 'open hand proof →')) : null,
        ),
      ),
      request ? actionRequestStrip(request) : null,
      h(
        'div',
        { class: 'seats-grid' },
        table.seats.map((seat) => seatCard(seat, table)),
      ),
      potsBlock(table),
      configBlock(table),
    ),
  );
}

/**
 * Uses `ActionRequest` (the server's own legal-action view) when the feed has
 * delivered an `ACTION_REQUIRED` for this table.
 *
 * @param {ActionRequest} request
 * @returns {HTMLElement}
 */
function actionRequestStrip(request) {
  const legal = request.legal;
  const chips = [];
  if (legal.canFold) chips.push(badge('FOLD', 'muted'));
  if (legal.canCheck) chips.push(badge('CHECK', 'info'));
  if (legal.canCall) chips.push(badge(`CALL ${formatTokens(legal.toCall, { maxFractionDigits: 4 })}`, 'info'));
  if (legal.canBet) chips.push(badge(`BET ${formatTokens(legal.minRaiseTo, { maxFractionDigits: 4 })}+`, 'active'));
  if (legal.canRaise) chips.push(badge(`RAISE to ${formatTokens(legal.minRaiseTo, { maxFractionDigits: 4 })}–${formatTokens(legal.maxRaiseTo, { maxFractionDigits: 4 })}`, 'active'));
  if (legal.canAllIn) chips.push(badge('ALL_IN', 'warn'));
  return h(
    'div',
    { class: 'on-the-clock' },
    h('span', { class: 'on-the-clock-label', text: `ON THE CLOCK — seat ${request.seat} (hand ${request.handId})` }),
    h('span', { class: 'chip-row' }, chips),
    h('span', { class: 'muted small', text: `pot ${formatTokens(request.pot)} · stack ${formatTokens(request.stack)}` }),
  );
}

/**
 * @param {SeatSnapshot} seat
 * @param {TableSnapshot} table
 * @returns {HTMLElement}
 */
function seatCard(seat, table) {
  const isButton = table.buttonSeat === seat.seat;
  const toAct = table.toActSeat === seat.seat;
  const classes = ['seat', `seat-${String(seat.status).toLowerCase()}`];
  if (toAct) classes.push('seat-toact');
  if (seat.agentId === null) classes.push('seat-empty');

  let cards;
  if (seat.holeCards && seat.holeCards.length > 0) cards = cardRow(seat.holeCards);
  else if (seat.agentId !== null && table.handId) cards = faceDownCards(2);
  else cards = h('span', { class: 'muted', text: '—' });

  return h(
    'article',
    { class: classes.join(' ') },
    h(
      'div',
      { class: 'seat-head' },
      h('span', { class: 'seat-no', text: `seat ${seat.seat}` }),
      isButton ? badge('BTN', 'info', 'button') : null,
      toAct ? badge('TO ACT', 'active') : null,
    ),
    h(
      'div',
      { class: 'seat-agent' },
      seat.agentId === null
        ? h('span', { class: 'muted', text: 'empty' })
        : h('span', { text: seat.agentName ?? seat.agentId, title: seat.agentId }),
    ),
    h('div', { class: 'seat-status' }, statusBadge(seat.status)),
    h('div', { class: 'seat-cards' }, cards),
    h(
      'dl',
      { class: 'kv-inline' },
      h('dt', { text: 'stack' }),
      h('dd', null, moneyEl(seat.stack, { maxFractionDigits: 6 })),
      h('dt', { text: 'committed' }),
      h('dd', null, moneyEl(seat.committed, { maxFractionDigits: 6 })),
      h('dt', { text: 'hand total' }),
      h('dd', null, moneyEl(seat.totalCommitted, { maxFractionDigits: 6 })),
      seat.escrow !== null && seat.escrow !== undefined
        ? h('dt', { text: 'escrow' })
        : null,
      seat.escrow !== null && seat.escrow !== undefined
        ? h('dd', null, moneyEl(seat.escrow, { maxFractionDigits: 6 }))
        : null,
    ),
  );
}

/**
 * @param {TableSnapshot} table
 * @returns {HTMLElement}
 */
function potsBlock(table) {
  const pots = Array.isArray(table.pots) ? table.pots : [];
  if (pots.length === 0) {
    return h('p', { class: 'note', text: 'No pots are posted on this table yet.' });
  }
  const { table: node, tbody } = tableShell([
    { label: 'pot' },
    { label: 'amount' },
    { label: 'eligible seats' },
  ]);
  for (const pot of pots) {
    tbody.appendChild(
      h(
        'tr',
        null,
        h('td', { text: pot.index === 0 ? 'main' : `side ${pot.index}` }),
        h('td', null, moneyEl(pot.amount, { maxFractionDigits: 6 })),
        h('td', { text: Array.isArray(pot.eligibleSeats) ? pot.eligibleSeats.join(', ') : '—' }),
      ),
    );
  }
  return h('div', { class: 'table-wrap' }, node);
}

/**
 * @param {TableSnapshot} table
 * @returns {HTMLElement}
 */
function configBlock(table) {
  const config = table.config;
  return h(
    'details',
    { class: 'config-block' },
    h('summary', { text: 'Table config (stakes, rake, think budget, dealing)' }),
    h(
      'dl',
      { class: 'kv-inline wide' },
      h('dt', { text: 'mode' }),
      h('dd', null, modeTag(table.mode), config.escrowRequired ? badge('escrow required', 'wager') : null),
      h('dt', { text: 'stakes SB/BB' }),
      h('dd', { text: `${formatTokens(config.smallBlind)} / ${formatTokens(config.bigBlind)} tokens` }),
      h('dt', { text: 'ante' }),
      h('dd', { text: `${formatTokens(config.ante)} tokens` }),
      h('dt', { text: 'buy-in' }),
      h('dd', { text: `${formatTokens(config.minBuyIn)} – ${formatTokens(config.maxBuyIn)} tokens` }),
      h('dt', { text: 'rake' }),
      h('dd', { text: `${formatBps(config.rakeBps)} of pot, cap ${formatTokens(config.rakeCap)}${config.rakeOnlyWithFlop ? ', only with a flop' : ''}` }),
      h('dt', { text: 'think budget' }),
      h('dd', { text: `${formatInt(config.thinkBudgetMs / 1000)}s per decision (FR-3.5)` }),
      h('dt', { text: 'burn cards' }),
      h('dd', { text: config.burnCards ? 'yes (affects the deal map)' : 'no' }),
      h('dt', { text: 'auto start' }),
      h('dd', { text: config.autoStart ? `yes, every ${formatInt(config.handIntervalMs / 1000)}s` : 'no' }),
      h('dt', { text: 'max seats' }),
      h('dd', { text: formatInt(config.maxSeats) }),
      h('dt', { text: 'started' }),
      h('dd', { text: formatDateTime(table.startedAt) }),
    ),
  );
}

main();
