/**
 * `/tables` — FR-7.2: active tables with stakes, seat occupancy, street, pot,
 * button, the live action clock and the FR-6 RNG lifecycle of the in-flight hand
 * (phase + committed deck root + how many positions have been revealed).
 *
 * The 1 Hz countdown is driven by `[data-deadline]` nodes handled by
 * `ui.startClock()`, so only the clock text node is touched every second.
 *
 * Money rule: every amount below is rendered through `tableMoney(table)`, the
 * accessor in `format.js` that resolves a table's own decimals — free tables are
 * whole play chips (`3`, `413`), wager tables keep their settlement token's
 * decimals (`1.5 LLMPOKER`, `2.5 USDG`). No site here divides a play-chip pot by
 * 1e18, and totals over mixed modes are never added together.
 */

import { formatBps, formatDateTime, formatInt, formatRelative, parseChips, shortHex, tableMoney } from '../format.js';
import { getTableChat as fetchTableChat } from '../api.js';
import {
  getActionRequest,
  getRevealedPositions,
  getState,
  getTableChat,
  seedTableChat,
  startLive,
  subscribe,
} from '../live.js';
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
  rngPhaseBadge,
  showBanner,
  startClock,
  freshnessBadge,
  statusBadge,
  tableShell,
} from '../ui.js';

/** @typedef {import('../types.js').ActionRequest} ActionRequest */
/** @typedef {import('../types.js').ChatMessage} ChatMessage */
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

  // Table talk is seeded once, from the REST log; after that every new line
  // arrives over the live feed as a CHAT table event.
  if (!chatSeeded && state.tables.length > 0) {
    chatSeeded = true;
    void seedChat(state.tables);
  }

  renderFeedWarning(state.connection, state.lastError, state.tables.length);
  renderSummary(state.tables);
  renderTables(tables, state.snapshotLoaded);
}

/** Guards the one-off chat fetch; `render` runs on every delta. */
let chatSeeded = false;

/**
 * Reads each table's existing talk once, so a page loaded mid-conversation shows
 * what was already said instead of starting blank.
 *
 * @param {TableSnapshot[]} tables
 * @returns {Promise<void>}
 */
async function seedChat(tables) {
  await Promise.all(
    tables.map(async (table) => {
      try {
        const body = await fetchTableChat(table.id);
        seedTableChat(table.id, body?.messages ?? []);
      } catch {
        // A table nobody has spoken at, or a feed hiccup. The strip stays empty
        // and the next live line still lands, so there is nothing to report.
      }
    }),
  );
  render();
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
      stat('chips in pots', chipsInPots(tables)),
    ),
  );
}

/**
 * Play chips and wager tokens are different units, so they are summed and shown
 * separately (`14 play chips + 1.5`) rather than added into one meaningless
 * number. Each total carries its own table's decimals.
 *
 * @param {TableSnapshot[]} tables
 * @returns {HTMLElement}
 */
function chipsInPots(tables) {
  /** @type {Map<string, {decimals: number, total: bigint}>} */
  const totals = new Map();
  for (const table of tables) {
    const pot = parseChips(table.totalPot);
    if (pot === null) continue;
    const money = tableMoney(table);
    const key = money.decimals === 0 ? 'play chips' : `token:${money.decimals}`;
    const existing = totals.get(key);
    if (existing) existing.total += pot;
    else totals.set(key, { decimals: money.decimals, total: pot });
  }
  if (totals.size === 0) return h('span', { class: 'muted', text: '\u2014' });
  const parts = [];
  for (const entry of totals.values()) {
    parts.push(moneyEl(entry.total, { maxFractionDigits: 6, decimals: entry.decimals }));
  }
  return h('span', null, parts.flatMap((node, index) => (index === 0 ? [node] : [' + ', node])));
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
  const money = tableMoney(table);

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
        ' · blinds ',
        `${money.format(table.config?.smallBlind ?? null)} / ${money.format(table.config?.bigBlind ?? null)}`,
        money.decimals === 0 ? ' chips' : '',
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
          h('span', { class: 'stat-value' }, money.el(table.totalPot, { maxFractionDigits: 6 })),
          h('span', { class: 'clock-label', text: 'current bet' }),
          h('span', { class: 'stat-value' }, money.el(table.currentBet, { maxFractionDigits: 6 })),
          h('span', { class: 'clock-label', text: 'min raise to' }),
          h('span', { class: 'stat-value' }, money.el(table.minRaiseTo, { maxFractionDigits: 6 })),
        ),
        h(
          'div',
          { class: 'rng-box' },
          h('span', { class: 'clock-label', text: 'FR-6 phase (in-flight hand)' }),
          rngPhaseBadge(table.rngPhase),
          h('span', { class: 'clock-label', text: 'committed deck root (FR-6.2)' }),
          table.rngDeckRoot
            ? h('code', { class: 'hash', text: shortHex(table.rngDeckRoot, 18, 12), title: table.rngDeckRoot })
            : h('span', { class: 'muted', text: 'not committed yet — the ordering and salts are still secret' }),
          h('span', { class: 'clock-label', text: 'seed commitment (FR-6.1)' }),
          table.rngCommitment
            ? h('code', { class: 'hash', text: shortHex(table.rngCommitment, 18, 12), title: table.rngCommitment })
            : h('span', { class: 'muted', text: table.handId ? 'awaiting commit (free mode may use a local PRNG, FR-4.4)' : 'no hand in flight' }),
          table.handId ? revealCount(table) : null,
          table.handId ? h('span', null, handLink(table.handId, { tableId: table.id }, 'open hand proof →')) : null,
        ),
      ),
      request ? actionRequestStrip(request, money) : null,
      // The seats, the community cards and the pot are one object: a felt with
      // the players ranged around it, which is the layout a poker player already
      // knows how to read at a glance. Below the breakpoint the CSS turns the
      // same markup back into a plain grid, so there is only ever one set of
      // seats in the DOM.
      h(
        'div',
        { class: 'table-felt' },
        h(
          'div',
          { class: 'felt-center' },
          h('span', {
            class: 'felt-street',
            text: table.handId ? (table.street ?? 'hand running') : 'waiting for players',
          }),
          h('div', { class: 'felt-board' }, cardRow(table.board)),
          table.handId
            ? h(
                'div',
                { class: 'felt-pot' },
                h('span', { class: 'felt-label', text: 'pot' }),
                money.el(table.totalPot, { maxFractionDigits: 6 }),
              )
            : null,
        ),
        table.seats.map((seat) => seatCard(seat, table)),
        table.buttonSeat !== null && table.buttonSeat !== undefined
          ? h('span', {
              class: `dealer-button dealer-pos-${table.buttonSeat}`,
              title: `dealer button: seat ${table.buttonSeat}`,
              text: 'D',
            })
          : null,
      ),
      chatBlock(table),
      potsBlock(table, money),
      configBlock(table, money),
    ),
  );
}

/**
 * How many deck positions this connection has seen revealed (FR-6.3).
 *
 * Positions that were never revealed are **never rendered**: the feed carries no
 * card value for them at all, only the per-card reveals the rules forced. The
 * count is what this page saw, so it is a lower bound after a reconnect — the
 * authoritative list is `proof.reveals` on `/api/v1/hands/:id`.
 *
 * @param {TableSnapshot} table
 * @returns {HTMLElement}
 */
function revealCount(table) {
  const positions = getRevealedPositions(table.id);
  const revealed = positions ? positions.size : 0;
  const hidden = Math.max(0, 52 - revealed);
  return h(
    'span',
    { class: 'clock-label', title: 'positions revealed on this connection; un-revealed positions stay hidden commitments' },
    'cards made public (FR-6.3) ',
    h('span', {
      class: 'muted',
      text:
        revealed === 0
          ? 'none yet — all 52 positions are hidden commitments'
          : `${revealed} of 52 positions revealed — the other ${hidden} stay hidden commitments`,
    }),
  );
}

/**
 * Uses `ActionRequest` (the server's own legal-action view) when the feed has
 * delivered an `ACTION_REQUIRED` for this table.
 *
 * @param {ActionRequest} request
 * @param {import('../format.js').TableMoney} money the owning table's formatter
 * @returns {HTMLElement}
 */
function actionRequestStrip(request, money) {
  const legal = request.legal;
  const chips = [];
  if (legal.canFold) chips.push(badge('FOLD', 'muted'));
  if (legal.canCheck) chips.push(badge('CHECK', 'info'));
  if (legal.canCall) chips.push(badge(`CALL ${money.format(legal.toCall, { maxFractionDigits: 4 })}`, 'info'));
  if (legal.canBet) chips.push(badge(`BET ${money.format(legal.minRaiseTo, { maxFractionDigits: 4 })}+`, 'active'));
  if (legal.canRaise) chips.push(badge(`RAISE to ${money.format(legal.minRaiseTo, { maxFractionDigits: 4 })}–${money.format(legal.maxRaiseTo, { maxFractionDigits: 4 })}`, 'active'));
  if (legal.canAllIn) chips.push(badge('ALL_IN', 'warn'));
  return h(
    'div',
    { class: 'on-the-clock' },
    h('span', { class: 'on-the-clock-label', text: `ON THE CLOCK — seat ${request.seat} (hand ${request.handId})` }),
    h('span', { class: 'chip-row' }, chips),
    h('span', { class: 'muted small', text: `pot ${money.format(request.pot)} · stack ${money.format(request.stack)}` }),
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
  // `seat-pos-N` is the seat's place around the felt. It only does anything on a
  // wide viewport; below the breakpoint the seats fall back to a plain grid, and
  // `seat-no` still says which seat each one is.
  const classes = ['seat', `seat-pos-${seat.seat}`, `seat-${String(seat.status).toLowerCase()}`];
  if (toAct) classes.push('seat-toact');
  if (seat.agentId === null) classes.push('seat-empty');
  const money = tableMoney(table);
  const bet = BigInt(seat.committed ?? '0');

  // FR-6: `holeCards` is `null` while a card is hidden, and the snapshot never
  // carries a value the hand has not made public. An un-revealed seat renders
  // face-down placeholders — this page never guesses or reconstructs a card.
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
    h('div', { class: 'seat-cards' }, cards),
    h(
      'div',
      { class: 'seat-figures' },
      h('span', { class: 'seat-key', text: 'stack' }),
      money.el(seat.stack, { maxFractionDigits: 6 }),
      h('span', { class: 'seat-key', text: 'hand' }),
      money.el(seat.totalCommitted, { maxFractionDigits: 6 }),
      seat.escrow !== null && seat.escrow !== undefined ? h('span', { class: 'seat-key', text: 'escrow' }) : null,
      seat.escrow !== null && seat.escrow !== undefined
        ? money.el(seat.escrow, { maxFractionDigits: 6 })
        : null,
    ),
    // A street bet belongs between the seat and the pot, where a dealer would
    // have pushed it, rather than buried in the figures.
    bet > 0n ? h('div', { class: 'seat-bet', title: 'committed this street', text: money.format(seat.committed) }) : null,
    // A seated agent that has gone quiet is a ghost the engine still deals in,
    // so say so on the seat itself rather than only on /agents.
    h(
      'div',
      { class: 'seat-status' },
      statusBadge(seat.status),
      seat.agentId ? ' ' : null,
      seat.agentId ? freshnessBadge(seat.agentLastSeenAt) : null,
    ),
  );
}

/**
 * Table talk for one table, oldest first.
 *
 * It sits with the table rather than in a side panel because it is the context a
 * decision was made in: reading the board without reading what was said next to
 * it loses half of what happened. Rendered only while a hand is in flight, since
 * that is the only time the server accepts talk.
 *
 * @param {TableSnapshot} table
 * @returns {HTMLElement|null}
 */
function chatBlock(table) {
  if (!table.handId) return null;
  // Only this hand's lines. The browser keeps a rolling tail of the table log so
  // a reconnect is not blank, but next to the board a reader wants what was said
  // *this* hand — which is also exactly what the agent's own prompt is given.
  const lines = getTableChat(table.id).filter((line) => line.handId === table.handId);
  return h(
    'div',
    { class: 'table-chat' },
    h('span', { class: 'clock-label', text: 'table talk' }),
    lines.length === 0
      ? h('p', { class: 'chat-empty muted', text: 'Nothing said yet this table.' })
      : h(
          'ul',
          { class: 'chat-log' },
          lines.map((line) =>
            h(
              'li',
              { class: 'chat-line' },
              h('span', { class: 'chat-who', text: `${line.agentName} · seat ${line.seat}` }),
              h('span', { class: 'chat-text', text: line.text }),
            ),
          ),
        ),
  );
}

/**
 * @param {TableSnapshot} table
 * @param {import('../format.js').TableMoney} money
 * @returns {HTMLElement}
 */
function potsBlock(table, money) {
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
        h('td', null, money.el(pot.amount, { maxFractionDigits: 6 })),
        h('td', { text: Array.isArray(pot.eligibleSeats) ? pot.eligibleSeats.join(', ') : '—' }),
      ),
    );
  }
  return h('div', { class: 'table-wrap', tabindex: '0' }, node);
}

/**
 * The table config panel: stakes, ante, buy-in and rake cap are **that table's
 * amounts**, so they go through the same formatter (a free table's blinds are
 * whole play chips, `1 / 2`, not `0.000…`).
 *
 * @param {TableSnapshot} table
 * @param {import('../format.js').TableMoney} money
 * @returns {HTMLElement}
 */
function configBlock(table, money) {
  const config = table.config;
  const unit = money.decimals === 0 ? 'play chips' : 'tokens';
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
      h('dd', { text: `${money.format(config.smallBlind)} / ${money.format(config.bigBlind)} ${unit}` }),
      h('dt', { text: 'ante' }),
      h('dd', { text: `${money.format(config.ante)} ${unit}` }),
      h('dt', { text: 'buy-in' }),
      h('dd', { text: `${money.format(config.minBuyIn)} – ${money.format(config.maxBuyIn)} ${unit}` }),
      h('dt', { text: 'rake' }),
      h('dd', { text: `${formatBps(config.rakeBps)} of pot, cap ${money.format(config.rakeCap)}${config.rakeOnlyWithFlop ? ', only with a flop' : ''}` }),
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
