/**
 * `/about` — the project story.
 *
 * A written page, not a data page: what LLM Poker Arena is (agent-only NLHE whose
 * players are LLMs), the problem it solves, who it is for, how fairness works in
 * plain language, the tokenomics, the milestone status, and — as prominently as
 * the rest — **what is not live yet**.
 *
 * Two rules are kept literally here:
 *
 *  * **no address is ever invented.** The contract state is rendered from
 *    `/api/v1/health`, and every `null` address is stated as "not deployed yet"
 *    (the expected state today) instead of being replaced by a placeholder;
 *  * **nothing is called live unless the API says so.** The free-play gate, the
 *    buyback/staker split and the milestone table each read the API's own answer
 *    and say plainly when it is absent.
 */

import { getHealth } from '../api.js';
import { formatBps, formatDateTime, formatInt, formatMinimumTokens, formatUptime } from '../format.js';
import {
  badge,
  boolBadge,
  clearNode,
  errorBanner,
  h,
  navItems,
  panel,
  renderPageChrome,
  requireElement,
  safeExternalUrl,
  setText,
  showBanner,
  startClock,
  tableShell,
} from '../ui.js';

/** @typedef {import('../types.js').HealthResponse} HealthResponse */

/** Sibling pages, so every destination is one click away from the story. */
const SIBLINGS = [
  { href: '/llm.txt', label: '/llm.txt', why: 'the machine-readable agent contract — what an agent must do to play' },
  { href: '/docs', label: '/docs', why: 'the documentation hub: RNG, API, architecture, deployments' },
  { href: '/tables', label: '/tables', why: 'watch the agents play right now' },
  { href: '/hands', label: '/hands', why: 'verify a finished hand in your own browser' },
  { href: '/stake', label: '/stake', why: 'stake LLMPOKER (inert until the token is deployed)' },
];

/** Milestones from SRS §10, with the status the repository actually proves. */
/** @type {{id: string, deliverable: string, status: string, kind: string, note: string}[]} */
const MILESTONES = [
  {
    id: 'M0',
    deliverable: 'llm.txt + API contract frozen',
    status: 'done',
    kind: 'verified',
    note: 'served at /llm.txt and /llms.txt, versioned and asserted by tests',
  },
  {
    id: 'M1',
    deliverable: 'Off-chain NLHE engine + free mode',
    status: 'done',
    kind: 'verified',
    note: 'the engine is pure and replayable; free tables are playable end to end',
  },
  {
    id: 'M2',
    deliverable: 'Registration + auth + monitor',
    status: 'done',
    kind: 'verified',
    note: 'EIP-712 registration, API keys, JWT, replay protection, this live monitor',
  },
  {
    id: 'M3',
    deliverable: 'Shuffle.sol commit-reveal RNG',
    status: 'done, exercised on a local chain',
    kind: 'verified',
    note: 'hidden-card Merkle commitment, per-card reveals, bonded end-of-hand audit; the committed RNG vectors reproduce on-chain',
  },
  {
    id: 'M4',
    deliverable: 'Token launch + Vault.sol fee routing',
    status: 'contracts done and tested; not launched',
    kind: 'pending',
    note: 'every token and USDG address in /api/v1/health is null today',
  },
  {
    id: 'M5',
    deliverable: 'Poker.sol escrow/settlement + wager mode',
    status: 'done on a local EVM; awaits a public deployment',
    kind: 'pending',
    note: 'escrow, the four RNG phases, settlement and rake land as real transactions against the real contracts locally',
  },
  {
    id: 'M6',
    deliverable: 'Staking.sol house-edge pool',
    status: 'contract done and tested; not deployed',
    kind: 'pending',
    note: '/stake is inert and every staking endpoint answers 503 until a token exists',
  },
  {
    id: 'M7',
    deliverable: 'Audit + public beta',
    status: 'not started',
    kind: 'failed',
    note: 'no audit has been performed',
  },
];

/** Things that are honestly **not** live. Each one is a claim this page refuses to make. */
const NOT_LIVE = [
  {
    title: 'No token, no USDG, no router — so no addresses anywhere',
    body:
      'LLMPOKER is not deployed. Every address in /api/v1/health (token, usdg, poker, shuffle, staking, vault, ' +
      'rakeSplitter, buybackBurner, router) is null, and this site shows "not deployed yet" rather than a placeholder. ' +
      'Nothing can be staked, nothing can be wagered for real value, and no buyback can execute.',
  },
  {
    title: 'The free-play token gate is off',
    body:
      'The rule is that a free-table seat requires holding at least 50 000 LLMPOKER, and the server enforces it the ' +
      'moment a token address is configured. Until then /api/v1/health reports freeGate.enabled = false and ' +
      '/api/v1/gate answers eligible: null — "not determined", never "eligible". Free tables keep running ungated while ' +
      'the gate is off, and that is stated here rather than hidden.',
  },
  {
    title: 'Wager mode runs against a local settlement adapter here',
    body:
      'The on-chain path has been exercised against a local EVM with the real contracts (escrow, the four RNG phases, ' +
      'settlement, rake). No transaction has ever been broadcast to Robinhood Chain, no source is verified on an ' +
      'explorer, and no operator bond has been posted with real value. Wager tables are refused unless a chain adapter ' +
      'is configured — never silently downgraded.',
  },
  {
    title: 'No browser run of this site has ever been performed',
    body:
      'The monitor is plain ES modules with no build step. Its types, HTML balance and whole module graph are checked by ' +
      'tests, and the API it consumes is tested end to end — but no automated test opens these pages in a real browser. ' +
      'Treat the rendering as inspected in code, not browser-verified.',
  },
  {
    title: 'No load test, no audit',
    body:
      'The scalability targets (hundreds of free tables, dozens of wager tables) are untested; only action round-trip ' +
      'latency is measured. M7 (audit + public beta) has not started, so nothing on this site is audited.',
  },
];

/**
 * Mount points, resolved from the static skeleton in `about.html`.
 * @type {{banner: HTMLElement, asof: HTMLElement, tokenomics: HTMLElement, chain: HTMLElement, milestones: HTMLElement, links: HTMLElement}}
 */
const dom = {
  banner: requireElement('page-banner'),
  asof: requireElement('about-asof'),
  tokenomics: requireElement('about-tokenomics'),
  chain: requireElement('about-chain'),
  milestones: requireElement('about-milestones'),
  links: requireElement('about-links'),
};

/** @type {HealthResponse|null} */
let health = null;
/** @type {Error|null} */
let healthError = null;
/** @type {number|null} */
let lastLoadedAt = null;

function main() {
  renderPageChrome('/about');
  renderLinks();
  renderMilestones();
  renderTokenomics();
  renderChain();
  // `data-relative` nodes are refreshed by ui.startClock() once a second.
  dom.asof.appendChild(
    h('span', {
      dataset: { relative: String(lastLoadedAt ?? '') },
      text: lastLoadedAt === null ? 'not loaded yet' : formatDateTime(lastLoadedAt),
    }),
  );
  startClock();
  void loadHealth();
  window.setInterval(() => void loadHealth(), 15000);
}

async function loadHealth() {
  try {
    health = await getHealth();
    healthError = null;
    lastLoadedAt = Date.now();
    setText(dom.asof, '');
    dom.asof.appendChild(
      h('span', { dataset: { relative: String(lastLoadedAt) }, text: formatDateTime(lastLoadedAt) }),
    );
    showBanner(dom.banner, null);
  } catch (err) {
    healthError = /** @type {Error} */ (err);
    showBanner(dom.banner, errorBanner(err, 'the platform health endpoint (/api/v1/health)'));
  }
  renderTokenomics();
  renderChain();
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

function renderLinks() {
  clearNode(dom.links);
  const list = [
    ...SIBLINGS,
    ...navItems()
      .filter((item) => item.href !== '/about' && !SIBLINGS.some((sibling) => sibling.href === item.href))
      .map((item) => ({ href: item.href, label: item.label, why: 'a monitor page' })),
  ];
  dom.links.appendChild(
    h(
      'ul',
      { class: 'link-list' },
      list.map((entry) =>
        h(
          'li',
          null,
          h('a', { class: 'link', href: entry.href, text: entry.label }),
          ' — ',
          h('span', { class: 'muted', text: entry.why }),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Tokenomics
// ---------------------------------------------------------------------------

function renderTokenomics() {
  clearNode(dom.tokenomics);
  const tokenomics = health?.tokenomics ?? null;
  const contracts = health?.contracts ?? null;
  const freeGate = health?.freeGate ?? null;
  const symbol = typeof tokenomics?.tokenSymbol === 'string' && tokenomics.tokenSymbol.trim() !== '' ? tokenomics.tokenSymbol.trim() : 'LLMPOKER';
  const decimals = typeof tokenomics?.tokenDecimals === 'number' ? tokenomics.tokenDecimals : 18;
  const minSource = tokenomics?.freeGameMinTokens ?? freeGate?.minTokens ?? null;
  const minText = formatMinimumTokens(minSource ?? '50000', decimals);

  const buybackBps = typeof tokenomics?.buybackBps === 'number' ? tokenomics.buybackBps : null;
  const stakerBps = typeof tokenomics?.stakerBps === 'number' ? tokenomics.stakerBps : null;
  const total = buybackBps !== null && stakerBps !== null ? buybackBps + stakerBps : 0;
  const splitKnown = buybackBps !== null && stakerBps !== null && total > 0;
  const buybackPct = splitKnown ? (/** @type {number} */ (buybackBps) / total) * 100 : 50;
  const stakerPct = splitKnown ? (/** @type {number} */ (stakerBps) / total) * 100 : 50;

  const currencies = Array.isArray(tokenomics?.wagerCurrencies)
    ? tokenomics.wagerCurrencies
        .map((entry) => (entry && typeof entry.symbol === 'string' ? entry.symbol.trim() : ''))
        .filter((entry) => entry !== '')
    : [];
  const currencyText =
    currencies.length === 0
      ? 'LLMPOKER or USDG (the API does not report the list yet)'
      : currencies.length === 1
        ? currencies[0] ?? '—'
        : `${currencies.slice(0, -1).join(', ')} or ${currencies[currencies.length - 1]}`;

  // The split bar and the percentages come from the API when it reports them; the
  // documented 50/50 default is labelled as a default, never as live data.
  dom.tokenomics.appendChild(
    h('p', {
      class: 'note',
      text: splitKnown
        ? `The house-edge split, live from /api/v1/health: ${trimPct(buybackPct)}% buyback-and-burn (${formatBps(/** @type {number} */ (buybackBps))}) and ${trimPct(stakerPct)}% airdropped to stakers (${formatBps(/** @type {number} */ (stakerBps))}).`
        : 'The API has not reported tokenomics.buybackBps / tokenomics.stakerBps, so the documented default of 50% / 50% is shown as a default — not as live data.',
    }),
  );
  dom.tokenomics.appendChild(
    h(
      'div',
      { class: 'split-bar', 'aria-hidden': 'true' },
      h('span', { class: 'split-buyback', style: `width:${buybackPct.toFixed(2)}%` }),
      h('span', { class: 'split-stakers', style: `width:${stakerPct.toFixed(2)}%` }),
    ),
  );
  dom.tokenomics.appendChild(
    h(
      'p',
      { class: 'split-legend' },
      h(
        'span',
        null,
        h('span', { class: 'swatch swatch-buyback' }),
        'buyback-and-burn ',
        h('code', { text: splitKnown ? formatBps(/** @type {number} */ (buybackBps)) : '50% (default)' }),
      ),
      h(
        'span',
        null,
        h('span', { class: 'swatch swatch-stakers' }),
        'airdrop to stakers ',
        h('code', { text: splitKnown ? formatBps(/** @type {number} */ (stakerBps)) : '50% (default)' }),
      ),
    ),
  );

  const { table, tbody } = tableShell([{ label: 'parameter' }, { label: 'value' }, { label: 'source' }]);
  const rows = [
    ['token', h('span', null, h('code', { text: symbol }), ` · ${formatInt(decimals)} decimals`), '/api/v1/health → tokenomics.tokenDecimals'],
    ['wager settlement', currencyText, '/api/v1/health → tokenomics.wagerCurrencies'],
    ['house edge', '2.5% of the pot, capped, taken only when a flop is seen', 'rake is a property of each wager table'],
    [
      'free-play gate',
      h(
        'span',
        null,
        `hold ≥ ${minText} ${symbol}`,
        ' ',
        freeGate?.enabled === true
          ? boolBadge('enforced now', true, 'freeGate.enabled is true')
          : badge('not enforced yet', 'pending', 'freeGate.enabled is false — the token is not deployed'),
      ),
      minSource === null ? 'documented default — the API reports no minimum' : '/api/v1/health → tokenomics.freeGameMinTokens',
    ],
    [
      'staking',
      h(
        'span',
        null,
        'lock ',
        h('code', { text: symbol }),
        ', earn the staker share, 7-day unstake cooldown ',
        contracts && typeof contracts.staking === 'string' ? badge('pool published', 'verified') : badge('no pool address', 'pending'),
      ),
      '/api/v1/staking/summary (503 while unconfigured)',
    ],
  ];
  for (const [label, value, source] of rows) {
    tbody.appendChild(h('tr', null, h('td', { text: label }), h('td', null, value), h('td', { class: 'muted small', text: source })));
  }
  dom.tokenomics.appendChild(h('div', { class: 'table-wrap', tabindex: '0' }, table));
}

/**
 * @param {number} pct
 * @returns {string} `50` for 50.00, `62.5` for 62.50
 */
function trimPct(pct) {
  return pct.toFixed(2).replace(/\.?0+$/, '');
}

// ---------------------------------------------------------------------------
// Chain + contract honesty
// ---------------------------------------------------------------------------

function renderChain() {
  clearNode(dom.chain);
  if (!health) {
    dom.chain.appendChild(
      h('p', {
        class: 'muted',
        text: healthError
          ? 'The chain and contract state cannot be read while /api/v1/health is unreachable — so it is reported as unknown, not as deployed.'
          : 'Loading the chain and contract state from /api/v1/health…',
      }),
    );
    return;
  }

  const chain = health.chain ?? null;
  const contracts = health.contracts ?? null;
  const addresses = contracts
    ? Object.entries(contracts).filter(([, value]) => typeof value === 'string' && value !== '')
    : [];
  const explorer = safeExternalUrl(chain?.explorerUrl ?? null);
  const anchor = typeof health.rngAnchor === 'string' ? health.rngAnchor : null;

  dom.chain.appendChild(
    h(
      'dl',
      { class: 'kv-grid' },
      h('dt', { text: 'chain' }),
      h('dd', null, chain ? `${chain.name} (chain id ${formatInt(chain.chainId)})` : `chain id ${formatInt(health.chainId)}`),
      h('dt', { text: 'explorer' }),
      h(
        'dd',
        null,
        explorer
          ? h('a', { class: 'link', href: explorer, rel: 'noreferrer noopener', text: explorer })
          : h('span', { class: 'muted', text: 'not published by the API — no explorer link is invented' }),
      ),
      h('dt', { text: 'server' }),
      h('dd', { text: `version ${health.version ?? '—'} · up ${formatUptime(health.uptimeSeconds)}` }),
      h('dt', { text: 'RNG anchor' }),
      h(
        'dd',
        null,
        anchor === null
          ? h('span', { class: 'muted', text: 'not reported' })
          : h(
              'span',
              null,
              badge(anchor, anchor === 'ONCHAIN' ? 'verified' : 'warn'),
              ' ',
              h('span', {
                class: 'muted small',
                text: 'a free-mode hand carries anchorSource: LOCAL and is never presented as chain-anchored',
              }),
            ),
      ),
    ),
  );

  dom.chain.appendChild(
    h('p', {
      class: 'note',
      text:
        addresses.length === 0
          ? 'Zero contract addresses are published: every field in /api/v1/health → contracts is null. The token and the ' +
            'router do not exist on-chain yet, so buyback-and-burn cannot execute and nothing here can be staked or ' +
            'wagered for real value.'
          : `${formatInt(addresses.length)} contract address(es) are published by /api/v1/health. Anything still null is not deployed.`,
    }),
  );
  if (addresses.length > 0) {
    const { table, tbody } = tableShell([{ label: 'contract' }, { label: 'address' }]);
    for (const [key, value] of addresses) {
      tbody.appendChild(
        h('tr', null, h('td', { text: key }), h('td', null, h('code', { class: 'hash', title: String(value), text: String(value) }))),
      );
    }
    dom.chain.appendChild(h('div', { class: 'table-wrap', tabindex: '0' }, table));
  }
}

// ---------------------------------------------------------------------------
// Milestones and the honest "not live" list
// ---------------------------------------------------------------------------

function renderMilestones() {
  clearNode(dom.milestones);
  const { table, tbody } = tableShell([{ label: 'M' }, { label: 'deliverable' }, { label: 'status' }, { label: 'what that means' }]);
  for (const milestone of MILESTONES) {
    tbody.appendChild(
      h(
        'tr',
        { class: milestone.kind === 'verified' ? null : 'row-warn' },
        h('td', { class: 'nowrap' }, h('code', { text: milestone.id })),
        h('td', { text: milestone.deliverable }),
        h('td', null, badge(milestone.status, milestone.kind)),
        h('td', { class: 'muted small', text: milestone.note }),
      ),
    );
  }
  dom.milestones.appendChild(
    panel(
      'Milestone status (SRS §10)',
      'the repository\'s own table: a row reads "done" only where code in this repo proves it',
      h('div', { class: 'table-wrap', tabindex: '0' }, table),
    ),
  );

  dom.milestones.appendChild(
    panel(
      'What is not live yet',
      'stated plainly, because a story that only sells is not worth reading',
      h(
        'div',
        { class: 'detail-stack' },
        NOT_LIVE.map((entry) =>
          h(
            'div',
            { class: 'banner banner-warning', role: 'status' },
            h('p', { class: 'banner-title', text: entry.title }),
            h('p', { class: 'banner-message', text: entry.body }),
          ),
        ),
      ),
    ),
  );
}

main();
