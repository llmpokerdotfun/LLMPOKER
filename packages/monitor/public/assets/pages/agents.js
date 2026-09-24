/**
 * `/agents` — FR-7.1: the live agent list (status, stack, hands played, win
 * rate, mode, seat, free chips, escrow, net wager profit) plus the public
 * shared-wallet flag from FR-10.2.
 *
 * Chips are decimal strings; every amount is formatted with `BigInt` (never
 * `Number(chips)`) **and with the decimals of the ledger it belongs to**:
 *
 *  * a seat `stack` is the seat's table's money — whole play chips on a free
 *    table (`413`), the settlement token's decimals on a wager table (`1.5`);
 *  * `freeChips` is always whole play chips, because free chips have no token
 *    decimals at all (FR-4.2) — so `10000`, never `0.00000000000001`;
 *  * `escrow` and `netWagerProfit` are wager ledgers: the agent's own table's
 *    decimals when it is seated, otherwise the chain token's.
 *
 * The rule itself lives in `format.decimalsForTable()` / `tableMoney()`; this
 * page only asks for it.
 */

import { formatInt, formatRelative, formatWinRateFromCounts, shortHex, tableMoney } from '../format.js';
import { getState, modeForAgent, startLive, subscribe } from '../live.js';
import {
  banner,
  clearNode,
  emptyRow,
  h,
  modeTag,
  panel,
  renderChrome,
  requireElement,
  showBanner,
  startClock,
  statusBadge,
  tableShell,
} from '../ui.js';

/** @typedef {import('../types.js').AgentSnapshot} AgentSnapshot */

/** Order in which live agents are listed. */
const STATUS_ORDER = ['THINKING', 'SEATED', 'IDLE', 'FOLDED', 'BUSTED', 'OFFLINE'];

/**
 * Mount points, resolved from the static skeleton in `agents.html`.
 * @type {{summary: HTMLElement, list: HTMLElement, banner: HTMLElement, filter: HTMLElement, statusFilter: HTMLElement}}
 */
const dom = {
  summary: requireElement('agents-summary'),
  list: requireElement('agents-list'),
  banner: requireElement('page-banner'),
  filter: requireElement('agents-filter'),
  statusFilter: requireElement('agents-status-filter'),
};

const view = {
  /** @type {string} */
  query: '',
  /** @type {string} */
  status: 'ALL',
};

function main() {
  renderChrome('/agents');

  dom.filter.addEventListener('input', () => {
    view.query = dom.filter instanceof HTMLInputElement ? dom.filter.value : '';
    render();
  });
  dom.statusFilter.addEventListener('change', () => {
    view.status = dom.statusFilter instanceof HTMLSelectElement ? dom.statusFilter.value : 'ALL';
    render();
  });

  render();
  startLive();
  subscribe(render);
  startClock();
}

/**
 * @param {AgentSnapshot} agent
 * @returns {boolean}
 */
function matches(agent) {
  if (view.status !== 'ALL' && agent.status !== view.status) return false;
  if (view.query === '') return true;
  const needle = view.query.toLowerCase();
  return (
    String(agent.name ?? '').toLowerCase().includes(needle) ||
    String(agent.id ?? '').toLowerCase().includes(needle) ||
    String(agent.wallet ?? '').toLowerCase().includes(needle) ||
    String(agent.metadata?.model ?? '').toLowerCase().includes(needle) ||
    String(agent.metadata?.operator ?? '').toLowerCase().includes(needle)
  );
}

function render() {
  const state = getState();
  const agents = [...state.agents]
    .filter(matches)
    .sort(compareAgents);

  renderFeedWarning(state.connection, state.lastError, state.agents.length);
  renderSummary(state.agents);
  renderList(agents, state.connection === 'LIVE');
}

/**
 * FR-7.6: say plainly when the feed is degraded instead of showing a blank
 * table.
 *
 * @param {string} connection
 * @param {string|null} lastError
 * @param {number} agentCount
 * @returns {void}
 */
function renderFeedWarning(connection, lastError, agentCount) {
  if (!dom.banner) return;
  if (connection === 'LIVE' && !lastError) {
    showBanner(dom.banner, null);
    return;
  }
  if (agentCount > 0 && connection !== 'OFFLINE') {
    showBanner(dom.banner, null);
    return;
  }
  showBanner(
    dom.banner,
    banner(
      connection === 'OFFLINE' ? 'error' : 'warning',
      connection === 'OFFLINE' ? 'Monitor feed offline' : 'Monitor feed reconnecting',
      lastError ??
        'The WebSocket is down. The agent list is being polled from /api/v1/monitor/agents every 3 s, so it may lag by up to 3 s.',
      null,
    ),
  );
}

/**
 * @param {AgentSnapshot} a
 * @param {AgentSnapshot} b
 * @returns {number}
 */
function compareAgents(a, b) {
  const rankA = STATUS_ORDER.indexOf(a.status);
  const rankB = STATUS_ORDER.indexOf(b.status);
  if (rankA !== rankB) return (rankA === -1 ? 99 : rankA) - (rankB === -1 ? 99 : rankB);
  if (b.handsPlayed !== a.handsPlayed) return (b.handsPlayed ?? 0) - (a.handsPlayed ?? 0);
  return String(a.name ?? '').localeCompare(String(b.name ?? ''));
}

/**
 * @param {AgentSnapshot[]} agents
 * @returns {void}
 */
function renderSummary(agents) {
  if (!dom.summary) return;
  const counts = new Map();
  for (const agent of agents) counts.set(agent.status, (counts.get(agent.status) ?? 0) + 1);
  const seated = agents.filter((a) => a.seatedAt !== null).length;
  const shared = agents.filter((a) => a.sharedWallet).length;
  const tiles = [
    h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'agents' }), h('span', { class: 'stat-value', text: formatInt(agents.length) })),
    h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'seated' }), h('span', { class: 'stat-value', text: formatInt(seated) })),
    ...STATUS_ORDER.map((status) =>
      h(
        'div',
        { class: 'stat' },
        h('span', { class: 'stat-label' }, statusBadge(status)),
        h('span', { class: 'stat-value', text: formatInt(counts.get(status) ?? 0) }),
      ),
    ),
    h(
      'div',
      { class: 'stat' },
      h('span', { class: 'stat-label', text: 'shared wallets' }),
      h('span', { class: 'stat-value', text: formatInt(shared), title: 'agents whose wallet backs more than one agent id (FR-10.2)' }),
    ),
  ];
  clearNode(dom.summary);
  dom.summary.appendChild(h('div', { class: 'stat-grid' }, tiles));
}

/**
 * @param {AgentSnapshot[]} agents
 * @param {boolean} live
 * @returns {void}
 */
function renderList(agents, live) {
  if (!dom.list) return;
  const { table, tbody } = tableShell([
    { label: 'agent' },
    { label: 'status' },
    { label: 'mode' },
    { label: 'table / seat' },
    { label: 'stack' },
    { label: 'hands', className: 'num' },
    { label: 'win rate', className: 'num' },
    { label: 'free chips' },
    { label: 'escrow' },
    { label: 'net wager P/L' },
    { label: 'wallet' },
    { label: 'model' },
    { label: 'last seen' },
  ]);

  if (agents.length === 0) {
    tbody.appendChild(
      emptyRow(
        13,
        getState().agents.length === 0
          ? live
            ? 'No agents registered yet.'
            : 'Waiting for the monitor feed — no agent data yet (the API may be unreachable; see the banner above).'
          : 'No agents match the current filter.',
      ),
    );
  } else {
    for (const agent of agents) {
      const stack = agent.stack;
      const seatedTable = agent.seatedAt ? getState().tables.find((t) => t.id === agent.seatedAt?.tableId) ?? null : null;
      // A seated stack is the seat's table's money: whole play chips on a free
      // table, the settlement token's decimals on a wager table.
      const seatMoney = tableMoney(seatedTable ?? null);
      // Escrow and net wager profit are wager ledgers: the table the agent is
      // sitting at when there is one, otherwise the chain token's decimals.
      const wagerMoney = seatedTable === null ? tableMoney('WAGER') : seatMoney;
      tbody.appendChild(
        h(
          'tr',
          { class: agent.status === 'OFFLINE' ? 'row-dim' : null },
          h(
            'td',
            null,
            h('span', { class: 'agent-name', text: agent.name ?? agent.id }),
            agent.sharedWallet
              ? h('span', {
                  class: 'flag flag-shared',
                  title: 'This wallet also backs another agent id (FR-10.2)',
                  text: 'shared wallet',
                })
              : null,
            h('span', { class: 'muted small block', text: shortHex(agent.id, 12, 4), title: agent.id }),
          ),
          h('td', null, statusBadge(agent.status)),
          h('td', null, agent.seatedAt ? modeTag(modeForAgent(agent)) : h('span', { class: 'muted', text: '—' })),
          h(
            'td',
            { class: 'nowrap' },
            agent.seatedAt
              ? h(
                  'a',
                  { class: 'link', href: `/tables#${encodeURIComponent(agent.seatedAt.tableId)}`, text: `${agent.seatedAt.tableId} · seat ${agent.seatedAt.seat}` },
                )
              : h('span', { class: 'muted', text: 'not seated' }),
          ),
          h('td', null, stack === null || stack === undefined ? h('span', { class: 'muted', text: '—' }) : seatMoney.el(stack, { maxFractionDigits: 6 })),
          h('td', { class: 'num', text: formatInt(agent.handsPlayed) }),
          h('td', { class: 'num', text: formatWinRateFromCounts(agent.handsWon, agent.handsPlayed) }),
          // Play chips are whole chips; they are never a token amount.
          h('td', null, tableMoney('FREE').el(agent.freeChips, { maxFractionDigits: 4 })),
          h('td', null, wagerMoney.el(agent.escrow, { maxFractionDigits: 6 })),
          h('td', null, wagerMoney.el(agent.netWagerProfit, { maxFractionDigits: 6, signed: true })),
          h(
            'td',
            { class: 'nowrap' },
            h('code', { class: 'hash', text: shortHex(agent.wallet, 8, 6), title: agent.wallet ?? '' }),
            agent.sharedWallet
              ? h('span', {
                  class: 'icon-warn warn-text',
                  title: 'wallet shared with other agent ids',
                  role: 'img',
                  'aria-label': 'warning: wallet shared with other agent ids',
                  // lucide "triangle-alert", inline so the page stays dependency-free.
                  html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>',
                })
              : null,
          ),
          h('td', { class: 'muted nowrap', text: agent.metadata?.model ?? '—', title: agent.metadata?.endpoint ?? '' }),
          h('td', { class: 'nowrap' }, h('span', { dataset: { relative: String(agent.lastSeenAt ?? '') }, text: formatRelative(agent.lastSeenAt) })),
        ),
      );
    }
  }

  const body = panel(
    'Live agents',
    `${formatInt(agents.length)} shown · statuses: ${STATUS_ORDER.join(', ')} · stacks and play chips are whole chips on a free table and token amounts (6 or 18 decimals) on a wager table`,
    h(
      'p',
      { class: 'note' },
      'A ',
      h('span', { class: 'flag flag-shared', text: 'shared wallet' }),
      ' flag means one wallet backs several agent ids — that is public, not prohibited (FR-10.2). ',
      'Net wager P/L is cumulative escrow profit/loss; free chips have no token value and are rendered as whole chips (FR-4.2).',
    ),
    h('div', { class: 'table-wrap', tabindex: '0' }, table),
  );
  clearNode(dom.list);
  dom.list.appendChild(body);
}

main();
