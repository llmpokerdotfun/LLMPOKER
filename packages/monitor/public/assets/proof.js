/**
 * RNG proof explorer (FR-6.3, FR-7.3).
 *
 * Two independent verdicts are shown side by side and are never conflated:
 *
 *  * **in your browser** — `verifyRngProof()` / `verifyHandDeal()` from the
 *    built `@llmpoker/shared` bundle, run on the raw public proof fields;
 *  * **the server's** — `/api/v1/verify/hands/:id`, its own recomputation.
 *
 * If the two disagree, the panel says so loudly. If the shared bundle is not
 * built yet, the panel degrades to the server verdict plus an explicit,
 * human-readable banner instead of blanking out (FR-7.6).
 */

import { formatDateTime, cardToString, shortHex } from './format.js';
import {
  badge,
  banner,
  cardEl,
  clearNode,
  emptyRow,
  h,
  kvGrid,
  tableShell,
} from './ui.js';
import { getSharedError, loadShared, sharedUnavailableMessage } from './vendor.js';

/**
 * @typedef {import('./types.js').HandHistory} HandHistory
 * @typedef {import('./types.js').HandVerificationResponse} HandVerificationResponse
 * @typedef {import('./types.js').ProofCheck} ProofCheck
 * @typedef {import('./types.js').ProofVerification} ProofVerification
 * @typedef {import('./types.js').RngProof} RngProof
 */

/**
 * @typedef {Object} ClientVerification
 * @property {ProofVerification|null} rng `verifyRngProof()` result.
 * @property {ProofVerification|null} deal `verifyHandDeal()` result.
 * @property {number[]|null} expectedDeck Deck recomputed from the proof.
 * @property {Error|null} error Set when the shared bundle could not be used.
 */

/**
 * Recomputes the proof in the browser using the shared bundle.
 *
 * @param {HandHistory} history
 * @returns {Promise<ClientVerification>}
 */
export async function verifyLocally(history) {
  /** @type {ClientVerification} */
  const out = { rng: null, deal: null, expectedDeck: null, error: null };
  const shared = await loadShared();
  if (!shared) {
    out.error = getSharedError() ?? new Error(sharedUnavailableMessage());
    return out;
  }
  const proof = history.proof;
  // A hand in flight legitimately has no reveal yet: verify what is public
  // instead of reporting a spurious failure.
  const options = proof.deckSeed === null || proof.anchorBlockHash === null ? { requireReveal: false } : {};
  out.rng = guard('client.verifyRngProof', () => shared.verifyRngProof(proof, options));
  out.deal = guard('client.verifyHandDeal', () => shared.verifyHandDeal(history.result, proof));
  try {
    out.expectedDeck = shared.expectedDeck(proof);
  } catch {
    out.expectedDeck = null;
  }
  return out;
}

/**
 * @param {string} name
 * @param {() => any} fn
 * @returns {ProofVerification}
 */
function guard(name, fn) {
  try {
    const result = fn();
    if (!result || !Array.isArray(result.checks)) throw new Error('verifier returned an unexpected shape');
    return result;
  } catch (err) {
    return { ok: false, checks: [{ name, ok: false, detail: err instanceof Error ? err.message : String(err) }] };
  }
}

/**
 * True once the proof carries everything needed for a full recomputation.
 *
 * @param {RngProof} proof
 * @returns {boolean}
 */
export function isRevealed(proof) {
  return proof.deckSeed !== null && proof.anchorBlockHash !== null && proof.entropy !== null;
}

/**
 * The headline badge: the **browser** verdict when it is available, because
 * that is the trustless one.
 *
 * @param {HandHistory} history
 * @param {ClientVerification} client
 * @returns {{label: string, kind: string, note: string}}
 */
export function proofVerdict(history, client) {
  if (!isRevealed(history.proof)) {
    return {
      label: 'PENDING REVEAL',
      kind: 'pending',
      note: 'the operator has not revealed deckSeed yet — the hand is not settled',
    };
  }
  if (client.error) {
    return {
      label: 'SERVER ONLY',
      kind: 'pending',
      note: 'in-browser recomputation unavailable; the server verdict below is not independently checked here',
    };
  }
  const ok = client.rng?.ok === true && client.deal?.ok === true;
  return {
    label: ok ? 'VERIFIED' : 'FAILED',
    kind: ok ? 'verified' : 'failed',
    note: ok
      ? 'commitment, anchor, entropy and the full 52-card deck were recomputed in your browser'
      : 'at least one check failed in your browser — do not trust this hand',
  };
}

/**
 * @param {HandVerificationResponse|null} server
 * @param {ClientVerification} client
 * @returns {string[]} human-readable disagreements (empty when they agree).
 */
export function disagreements(server, client) {
  /** @type {string[]} */
  const diffs = [];
  if (!server || client.error) return diffs;
  if (client.rng && server.proof && client.rng.ok !== server.proof.ok) {
    diffs.push(
      `verifyRngProof: browser says ${client.rng.ok ? 'ok' : 'FAILED'}, server says ${server.proof.ok ? 'ok' : 'FAILED'}`,
    );
  }
  if (client.deal && server.deal && client.deal.ok !== server.deal.ok) {
    diffs.push(
      `verifyHandDeal: browser says ${client.deal.ok ? 'ok' : 'FAILED'}, server says ${server.deal.ok ? 'ok' : 'FAILED'}`,
    );
  }
  return diffs;
}

/**
 * Renders the whole proof panel into `container`.
 *
 * @param {HTMLElement} container
 * @param {{history: HandHistory, client: ClientVerification, server: HandVerificationResponse|null, serverError: Error|null}} ctx
 * @returns {void}
 */
export function renderProofPanel(container, ctx) {
  const { history, client, server, serverError } = ctx;
  const proof = history.proof;
  clearNode(container);

  const verdict = proofVerdict(history, client);
  container.appendChild(
    h(
      'div',
      { class: 'panel-head' },
      h('h2', { class: 'panel-title', text: 'RNG proof' }),
      h('span', { class: `proof-badge proof-${verdict.kind}` }, proofBadgeIcon(verdict.kind), verdict.label),
      h('p', { class: 'panel-subtitle', text: verdict.note }),
    ),
  );

  if (client.error) {
    container.appendChild(banner('warning', 'In-browser verification unavailable', sharedUnavailableMessage(), null));
  }

  const diffs = disagreements(server, client);
  if (diffs.length > 0) {
    container.appendChild(
      banner(
        'error',
        'Browser and server verdicts disagree',
        'The server claims a different result from your own recomputation. Treat this hand as unverified until it is explained.',
        diffs.join('\n'),
      ),
    );
  }

  container.appendChild(renderComparison(server, client, serverError));
  container.appendChild(renderFields(history));
  container.appendChild(renderChecksBlock('Recomputed in your browser (trustless)', client));
  container.appendChild(renderServerBlock(server, serverError));
  container.appendChild(renderDeck(proof, client.expectedDeck, history));
  container.appendChild(
    h(
      'details',
      { class: 'raw-block' },
      h('summary', { text: 'Raw proof JSON (what a verifier would fetch)' }),
      h('pre', { text: JSON.stringify(proof, null, 2) }),
    ),
  );
}

/**
 * @param {string} kind
 * @returns {string}
 */
function proofBadgeIcon(kind) {
  if (kind === 'verified') return '\u2713 VERIFIED';
  if (kind === 'failed') return '\u2717 FAILED';
  return '\u2026 PENDING';
}

/**
 * @param {HandVerificationResponse|null} server
 * @param {ClientVerification} client
 * @param {Error|null} serverError
 * @returns {HTMLElement}
 */
function renderComparison(server, client, serverError) {
  const { table, tbody } = tableShell([
    { label: 'Check' },
    { label: 'In your browser' },
    { label: 'Server (/api/v1/verify)' },
    { label: 'Agree' },
  ]);

  const rows = [
    {
      label: 'verifyRngProof() — commitment, anchor, entropy, shuffle',
      client: client.rng,
      server: server ? server.proof : null,
    },
    {
      label: 'verifyHandDeal() — hole cards, board, burns vs the deck',
      client: client.deal,
      server: server ? server.deal : null,
    },
  ];

  for (const row of rows) {
    const clientOk = row.client ? row.client.ok : null;
    const serverOk = row.server ? row.server.ok : null;
    const agree = clientOk === null || serverOk === null ? null : clientOk === serverOk;
    tbody.appendChild(
      h(
        'tr',
        null,
        h('td', { text: row.label }),
        h('td', null, verdictCell(clientOk, 'not run')),
        h('td', null, verdictCell(serverOk, serverError ? 'unavailable' : 'no data')),
        h('td', null, agree === null ? h('span', { class: 'muted', text: '—' }) : agree ? badge('yes', 'verified') : badge('NO', 'failed')),
      ),
    );
  }

  return h(
    'div',
    { class: 'proof-subblock' },
    h('h3', { class: 'subblock-title', text: 'Independent recomputations' }),
    h('div', { class: 'table-wrap' }, table),
  );
}

/**
 * @param {boolean|null} ok
 * @param {string} missing
 * @returns {HTMLElement}
 */
function verdictCell(ok, missing) {
  if (ok === null) return h('span', { class: 'muted', text: missing });
  return badge(ok ? 'ok' : 'fail', ok ? 'verified' : 'failed');
}

/**
 * @param {HandHistory} history
 * @returns {HTMLElement}
 */
function renderFields(history) {
  const proof = history.proof;
  return h(
    'div',
    { class: 'proof-subblock' },
    h('h3', { class: 'subblock-title', text: 'Public proof fields' }),
    kvGrid([
      { label: 'hand', value: `${proof.handId} · #${proof.handNumber}`, title: `table ${proof.tableId}` },
      { label: 'commitment C', value: hashNode(proof.commitment), title: proof.commitment },
      { label: 'deckSeed (revealed)', value: hashNode(proof.deckSeed), title: proof.deckSeed ?? 'not revealed' },
      { label: 'nonce', value: proof.nonce, title: 'per-table uint256, strictly increasing' },
      { label: 'commit block N', value: blockNode(proof.commitBlock, proof.commitTxHash) },
      { label: 'anchor block N+1', value: blockNode(proof.anchorBlock, proof.anchorBlockHash) },
      { label: 'reveal block M', value: blockNode(proof.revealBlock, proof.revealTxHash) },
      { label: 'entropy', value: hashNode(proof.entropy), title: proof.entropy ?? 'not revealed' },
      { label: 'server stored verdict', value: proof.verified ? badge('verified', 'verified') : badge('not verified', 'failed'), title: proof.verifiedAt ? `verified at ${formatDateTime(proof.verifiedAt)}` : 'no verification timestamp' },
      { label: 'chain id', value: String(proof.chainId) },
    ]),
    serverNote(history),
  );
}

/**
 * @param {HandHistory} history
 * @returns {HTMLElement}
 */
function serverNote(history) {
  const proof = history.proof;
  if (proof.commitBlock === null || proof.revealBlock === null) {
    return h('p', {
      class: 'note',
      text:
        'Block numbers are missing, so the reveal window (N < M <= N+256) and the 12-confirmation ' +
        'finality rule cannot be checked for this hand.',
    });
  }
  return h('p', {
    class: 'note',
    text:
      `Window: reveal block ${proof.revealBlock} must be in (${proof.commitBlock}, ${proof.commitBlock + 256}]; ` +
      'finality requires at least 12 confirmations past the anchor (FR-6.5 / NFR-6).',
  });
}

/**
 * @param {string|null} value
 * @returns {HTMLElement}
 */
function hashNode(value) {
  if (!value) return h('span', { class: 'muted', text: '— (not revealed)' });
  return h('code', { class: 'hash', text: shortHex(value, 14, 10), title: value });
}

/**
 * @param {number|null} block
 * @param {string|null} txHash
 * @returns {HTMLElement}
 */
function blockNode(block, txHash) {
  if (block === null || block === undefined) return h('span', { class: 'muted', text: '—' });
  return h(
    'span',
    null,
    h('span', { class: 'block-number', text: String(block) }),
    txHash ? h('code', { class: 'hash', text: ` ${shortHex(txHash, 10, 6)}`, title: txHash }) : null,
  );
}

/**
 * @param {string} title
 * @param {ClientVerification} client
 * @returns {HTMLElement}
 */
function renderChecksBlock(title, client) {
  if (!client.rng && !client.deal) {
    return h(
      'div',
      { class: 'proof-subblock' },
      h('h3', { class: 'subblock-title', text: title }),
      h('p', { class: 'muted', text: 'Not available — the shared proof module could not be loaded.' }),
    );
  }
  return h(
    'div',
    { class: 'proof-subblock' },
    h('h3', { class: 'subblock-title', text: title }),
    checksTable('verifyRngProof()', client.rng),
    checksTable('verifyHandDeal()', client.deal),
  );
}

/**
 * @param {HandVerificationResponse|null} server
 * @param {Error|null} serverError
 * @returns {HTMLElement}
 */
function renderServerBlock(server, serverError) {
  const children = [h('h3', { class: 'subblock-title', text: 'Server recomputation (/api/v1/verify/hands/:id)' })];
  if (!server) {
    children.push(
      h('p', {
        class: 'muted',
        text: serverError
          ? `Not available: ${serverError.message}`
          : 'The server has not published a verification for this hand yet.',
      }),
    );
  } else {
    children.push(checksTable('verifyRngProof()', server.proof));
    children.push(checksTable('verifyHandDeal()', server.deal));
  }
  return h('div', { class: 'proof-subblock' }, children);
}

/**
 * Renders every individual check with its name, pass/fail and detail.
 *
 * @param {string} title
 * @param {ProofVerification|null} verification
 * @returns {HTMLElement}
 */
function checksTable(title, verification) {
  const { table, tbody } = tableShell(
    [{ label: 'Check' }, { label: 'Result' }, { label: 'Detail' }],
    { className: 'check-table' },
  );
  if (!verification || !Array.isArray(verification.checks) || verification.checks.length === 0) {
    tbody.appendChild(emptyRow(3, 'no checks returned'));
    return h('div', { class: 'check-group' }, h('h4', { class: 'check-title' }, title, ' ', h('span', { class: 'muted', text: '(no data)' })), h('div', { class: 'table-wrap' }, table));
  }
  for (const check of verification.checks) {
    tbody.appendChild(
      h(
        'tr',
        { class: check.ok ? 'check-ok' : 'check-fail' },
        h('td', null, h('code', { class: 'check-name', text: check.name })),
        h('td', null, badge(check.ok ? 'pass' : 'FAIL', check.ok ? 'verified' : 'failed')),
        h('td', { class: 'check-detail', text: check.detail ?? '' }),
      ),
    );
  }
  return h(
    'div',
    { class: 'check-group' },
    h(
      'h4',
      { class: 'check-title' },
      title,
      ' ',
      badge(verification.ok ? 'all passed' : 'failed', verification.ok ? 'verified' : 'failed'),
    ),
    h('div', { class: 'table-wrap' }, table),
  );
}

/**
 * The full 52-card ordering, with per-index mismatch highlighting against the
 * deck recomputed from the proof.
 *
 * @param {RngProof} proof
 * @param {number[]|null} expected
 * @param {HandHistory} history
 * @returns {HTMLElement}
 */
function renderDeck(proof, expected, history) {
  const deck = Array.isArray(proof.deck) ? proof.deck : [];
  const grid = h('div', { class: 'deck-grid' });
  let mismatches = 0;
  deck.forEach((card, index) => {
    const expectedCard = Array.isArray(expected) && index < expected.length ? expected[index] : null;
    const mismatch = expectedCard !== null && expectedCard !== card;
    if (mismatch) mismatches++;
    grid.appendChild(
      h(
        'div',
        {
          class: `deck-slot${mismatch ? ' deck-mismatch' : ''}`,
          title: `deck[${index}] = ${cardToString(card)}${mismatch ? ` — expected ${cardToString(expectedCard)}` : ''}`,
        },
        h('span', { class: 'deck-index', text: String(index) }),
        cardEl(card),
      ),
    );
  });

  const seats = Array.isArray(history.result.dealingOrder) ? history.result.dealingOrder.length : 0;
  const burns = Array.isArray(history.result.burns) ? history.result.burns.length : 0;
  const consumed = seats * 2 + (burns > 0 ? 8 : 5);

  return h(
    'div',
    { class: 'proof-subblock' },
    h('h3', { class: 'subblock-title', text: `Stored deck ordering (${deck.length} cards)` }),
    h('p', {
      class: 'note',
      text:
        `Deal map: ${seats} seats × 2 cards${burns > 0 ? ' + 3 burns + flop/turn/river' : ' + flop/turn/river (no burns)'}` +
        ` = the first ${consumed} indices are consumed; the remaining ${Math.max(0, deck.length - consumed)} are published anyway so the proof is complete.`,
    }),
    mismatches > 0
      ? banner('error', `${mismatches} card${mismatches === 1 ? '' : 's'} do not match the recomputed shuffle`, 'Highlighted below.', null)
      : null,
    grid,
    h(
      'details',
      { class: 'raw-block' },
      h('summary', { text: 'Deck as text (index: card)' }),
      h('pre', { text: deck.map((card, index) => `${String(index).padStart(2, '0')}: ${cardToString(card)}`).join('  ') }),
    ),
  );
}
