/**
 * RNG proof explorer (FR-6, FR-7.3) — the four-phase commit/reveal timeline.
 *
 * The patched FR-6 rule is *"the seed and full deck ordering MUST NEVER be
 * published on-chain while a hand is live; only commitments are public during
 * play"*, so the panel is organised around {@link RngProof.phase}:
 *
 *  1. **SEED_COMMITTED** — `commitment = keccak256(seed ‖ nonce)`, the nonce and
 *     the commit block are public; the seed is secret.
 *  2. **DECK_COMMITTED** — `deckRoot`, its block, the anchor block/hash and the
 *     required confirmation depth; the ordering and all 52 salts are secret.
 *  3. **reveals** — one `(index, card, salt, proof[6])` per card the rules made
 *     public, each checked against `deckRoot` with `verifyCardReveal()`.
 *  4. **AUDITED** — `deckSeed`, `entropy`, the 52 salts and the full deck, so
 *     `entropy → FisherYates → leaves → Merkle root` can be recomputed and
 *     compared with the committed root forever.
 *
 * Two independent verdicts are shown side by side and are never conflated:
 *
 *  * **in your browser** — `verifyRngProof()` / `verifyPublicReveals()` /
 *    `verifyHandDeal()` from the built `@llmpoker/shared` bundle, run on the raw
 *    public proof fields;
 *  * **the server's** — `/api/v1/verify/hands/:id`, its own recomputation.
 *
 * If the two disagree, the panel says so loudly. If the shared bundle is not
 * built yet, the panel degrades to the server verdict plus an explicit,
 * human-readable banner instead of blanking out (FR-7.6).
 */

import { VENDOR_SHARED_URL } from './constants.js';
import { formatDateTime, cardToString, shortHex } from './format.js';
import {
  badge,
  banner,
  cardEl,
  clearNode,
  emptyRow,
  h,
  kvGrid,
  moneyEl,
  rngPhaseBadge,
  tableShell,
} from './ui.js';
import { getSharedError, loadShared, sharedUnavailableMessage } from './vendor.js';

/**
 * @typedef {import('./types.js').CardReveal} CardReveal
 * @typedef {import('./types.js').HandHistory} HandHistory
 * @typedef {import('./types.js').HandVerificationResponse} HandVerificationResponse
 * @typedef {import('./types.js').ProofCheck} ProofCheck
 * @typedef {import('./types.js').ProofVerification} ProofVerification
 * @typedef {import('./types.js').RngPhase} RngPhase
 * @typedef {import('./types.js').RngProof} RngProof
 * @typedef {import('./types.js').RngVoidReason} RngVoidReason
 */

/** How many deck positions a full commit covers (`DECK_TREE_SIZE` leaves / 52 cards). */
const DECK_POSITIONS = 52;

/**
 * The shared-bundle entry points this panel needs. A bundle without them
 * predates the patched FR-6, so it would "verify" a live hand against a scheme
 * that no longer exists — better to say so than to render a wrong verdict.
 */
const REQUIRED_SHARED_EXPORTS = ['verifyRngProof', 'verifyPublicReveals', 'verifyHandDeal', 'verifyCardReveal', 'expectedDeck'];

/**
 * @typedef {Object} ClientVerification
 * @property {ProofVerification|null} rng `verifyRngProof()` result.
 * @property {ProofVerification|null} reveals `verifyPublicReveals()` result.
 * @property {ProofVerification|null} deal `verifyHandDeal()` result.
 * @property {Map<number, boolean>|null} revealValidity per-reveal Merkle check against `deckRoot`.
 * @property {number[]|null} expectedDeck Deck recomputed from the proof (null while live).
 * @property {Error|null} error Set when the shared bundle could not be used or is too old.
 */

// ---------------------------------------------------------------------------
// In-browser recomputation
// ---------------------------------------------------------------------------

/**
 * Recomputes the proof in the browser using the shared bundle.
 *
 * While a hand is live the audit legitimately does not exist yet, so
 * `requireReveal` is only asserted once the hand reached the audit — the
 * "an audit must exist" check would otherwise fail a perfectly good live hand.
 *
 * @param {HandHistory} history
 * @returns {Promise<ClientVerification>}
 */
export async function verifyLocally(history) {
  /** @type {ClientVerification} */
  const out = { rng: null, reveals: null, deal: null, revealValidity: null, expectedDeck: null, error: null };
  const shared = await loadShared();
  if (!shared) {
    out.error = getSharedError() ?? new Error(sharedUnavailableMessage());
    return out;
  }
  const missing = REQUIRED_SHARED_EXPORTS.filter((name) => typeof shared[name] !== 'function');
  if (missing.length > 0) {
    out.error = new Error(
      `the shared bundle at ${VENDOR_SHARED_URL} is too old for the patched FR-6: it does not export ${missing.join(', ')}`,
    );
    return out;
  }

  const proof = history.proof;
  const requireReveal = proof.phase === 'AUDITED' || proof.phase === 'VOIDED';
  out.rng = guard('client.verifyRngProof', () => shared.verifyRngProof(proof, { requireReveal }));
  out.reveals = guard('client.verifyPublicReveals', () => shared.verifyPublicReveals(history.result, proof));
  out.deal = guard('client.verifyHandDeal', () => shared.verifyHandDeal(history.result, proof));
  out.revealValidity = checkReveals(shared, proof);
  try {
    out.expectedDeck = shared.expectedDeck(proof);
  } catch {
    out.expectedDeck = null;
  }
  return out;
}

/**
 * Checks each published reveal against the committed root. Uses the vendor
 * bundle (never a page-local Merkle implementation).
 *
 * @param {any} shared
 * @param {RngProof} proof
 * @returns {Map<number, boolean>|null} `null` when the bundle cannot do it.
 */
function checkReveals(shared, proof) {
  if (!Array.isArray(proof.reveals)) return null;
  if (typeof shared.verifyCardReveal !== 'function') return null;
  const root = typeof proof.deckRoot === 'string' ? proof.deckRoot : '';
  /** @type {Map<number, boolean>} */
  const validity = new Map();
  for (const reveal of proof.reveals) {
    try {
      validity.set(reveal.index, shared.verifyCardReveal(root, reveal) === true);
    } catch {
      validity.set(reveal.index, false);
    }
  }
  return validity;
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

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/**
 * @param {RngPhase|string} phase
 * @returns {boolean} true while the hand is live (`SEED_COMMITTED` or `DECK_COMMITTED`).
 */
function isLivePhase(phase) {
  return phase === 'SEED_COMMITTED' || phase === 'DECK_COMMITTED';
}

/**
 * True once the phase-4 audit has published everything needed for a full
 * recomputation (FR-6.4).
 *
 * @param {RngProof} proof
 * @returns {boolean}
 */
export function isRevealed(proof) {
  return proof.phase === 'AUDITED' && proof.deckSeed !== null && proof.entropy !== null;
}

/**
 * The headline badge: the **browser** verdict when it is available, because
 * that is the trustless one.
 *
 * While the hand is live the badge is based on `verifyRngProof()` +
 * `verifyPublicReveals()` only: `verifyHandDeal()` cannot pass before the audit
 * (that is `deal.requires_audit`, an expected state, not a failure). Once
 * `AUDITED`, all three must pass.
 *
 * @param {HandHistory} history
 * @param {ClientVerification} client
 * @returns {{label: string, kind: string, note: string}}
 */
export function proofVerdict(history, client) {
  const proof = history.proof;
  const phase = proof.phase;

  if (phase === 'VOIDED') {
    return {
      label: 'VOIDED',
      kind: 'voided',
      note: `the hand was voided (${voidReasonName(proof.voidedReason)}) and publishes no ordering — nothing about its deal can be proven`,
    };
  }
  if (phase === 'NONE') {
    return {
      label: 'PENDING',
      kind: 'pending',
      note: 'no FR-6.1 seed commitment has been published for this hand yet',
    };
  }
  if (client.error) {
    return {
      label: 'SERVER ONLY',
      kind: 'pending',
      note: 'in-browser recomputation unavailable; the server verdict below is not independently checked here',
    };
  }

  const live = isLivePhase(phase);
  // Phase 1 has no deck root yet, so there is nothing for verifyPublicReveals()
  // to check: a `reveals.root_available` failure there is "not committed yet",
  // not a verdict on the hand.
  const revealsApplicable = proof.deckRoot !== null;

  const passing = [client.rng?.ok === true];
  if (revealsApplicable) passing.push(client.reveals?.ok === true);
  if (!live) passing.push(client.deal?.ok === true);
  const ok = passing.every((value) => value);

  if (live) {
    return {
      label: ok ? 'VERIFIED' : 'FAILED',
      kind: ok ? 'verified' : 'failed',
      note: ok
        ? `${revealsApplicable ? 'the seed commitment and every public card reveal check out' : 'the seed commitment checks out'} in your browser; ` +
          'the 52-card ordering stays a hidden commitment until the FR-6.4 audit'
        : 'at least one in-browser check failed for this live hand — do not trust it',
    };
  }
  return {
    label: ok ? 'VERIFIED' : 'FAILED',
    kind: ok ? 'verified' : 'failed',
    note: ok
      ? 'commitment, anchor, entropy, the full 52-card deck and every published reveal were recomputed in your browser'
      : 'at least one check failed in your browser — do not trust this hand',
  };
}

/**
 * @param {RngVoidReason|null|undefined} reason
 * @returns {string}
 */
function voidReasonName(reason) {
  if (reason === 'NO_DECK_COMMITMENT') return 'NO_DECK_COMMITMENT';
  if (reason === 'AUDIT_STALLED') return 'AUDIT_STALLED';
  if (reason === 'AUDIT_FAILED') return 'AUDIT_FAILED';
  return 'reason not recorded';
}

/**
 * @param {RngVoidReason|null|undefined} reason
 * @returns {string} one sentence a non-specialist can act on.
 */
function voidReasonSentence(reason) {
  switch (reason) {
    case 'NO_DECK_COMMITMENT':
      return 'The operator never published the FR-6.2 deck commitment for this hand, so no ordering was ever committed and the deal is unprovable.';
    case 'AUDIT_STALLED':
      return 'The hand ended but the operator never published the FR-6.4 audit inside the liveness window, so the committed deck was never opened.';
    case 'AUDIT_FAILED':
      return 'The end-of-hand audit did not reproduce the committed root, which means the shuffle or the deal did not match what was committed.';
    default:
      return 'The hand was voided without a recorded reason.';
  }
}

/**
 * A single `ProofVerification` reduced to "would this pass, ignoring the checks
 * that cannot be evaluated yet". Used so a live hand is not reported as a
 * browser/server disagreement merely because the server always demands an audit.
 *
 * @param {ProofVerification|null|undefined} verification
 * @param {string[]} ignore check names that are legitimately not evaluable yet
 * @returns {{ok: boolean, skipped: string[], evaluated: number}|null} `null` when nothing is comparable.
 */
function comparable(verification, ignore) {
  if (!verification || !Array.isArray(verification.checks) || verification.checks.length === 0) return null;
  const skipped = [];
  let ok = true;
  let evaluated = 0;
  for (const check of verification.checks) {
    if (ignore.includes(check.name)) {
      skipped.push(check.name);
      continue;
    }
    evaluated += 1;
    if (!check.ok) ok = false;
  }
  if (evaluated === 0) return null;
  return { ok, skipped, evaluated };
}

/**
 * @param {ProofVerification|null|undefined} verification
 * @param {string} name
 * @returns {ProofCheck|null}
 */
function findCheck(verification, name) {
  if (!verification || !Array.isArray(verification.checks)) return null;
  return verification.checks.find((check) => check.name === name) ?? null;
}

/**
 * @param {RngProof} proof
 * @param {HandVerificationResponse|null} server
 * @param {ClientVerification} client
 * @returns {string[]} human-readable disagreements (empty when they agree).
 */
export function disagreements(proof, server, client) {
  /** @type {string[]} */
  const diffs = [];
  if (!server || client.error) return diffs;

  const live = isLivePhase(proof.phase);
  const rngServer = comparable(server.proof, live ? ['audit.present'] : []);
  if (client.rng && rngServer && client.rng.ok !== rngServer.ok) {
    const ignored = rngServer.skipped.length > 0 ? ` (ignoring ${rngServer.skipped.join(', ')}, which cannot pass before the audit)` : '';
    diffs.push(`verifyRngProof: browser says ${client.rng.ok ? 'ok' : 'FAILED'}, server says ${rngServer.ok ? 'ok' : 'FAILED'}${ignored}`);
  }

  // The server publishes no separate verifyPublicReveals() verdict: its own
  // proof verdict embeds the same per-reveal checks, and once audited its
  // verifyHandDeal() does too, so the rows below already cover them.
  const dealServer = live ? null : server.deal;
  if (client.deal && dealServer && client.deal.ok !== dealServer.ok) {
    diffs.push(`verifyHandDeal: browser says ${client.deal.ok ? 'ok' : 'FAILED'}, server says ${dealServer.ok ? 'ok' : 'FAILED'}`);
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

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
    container.appendChild(banner('warning', 'In-browser verification unavailable', client.error.message, sharedUnavailableMessage()));
  }

  if (proof.phase === 'VOIDED') {
    container.appendChild(voidBanner(proof));
  }

  const diffs = disagreements(proof, server, client);
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

  container.appendChild(phaseStepper(proof));
  container.appendChild(phase1Section(proof));
  container.appendChild(phase2Section(proof));
  container.appendChild(phase3Section(proof, client));
  container.appendChild(phase4Section(proof, client));
  container.appendChild(proofMeta(proof));
  container.appendChild(renderComparison(proof, server, client, serverError));
  container.appendChild(renderChecksBlock(proof, client));
  container.appendChild(renderServerBlock(proof, server, serverError));
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
  if (kind === 'voided') return '\u26a0 VOIDED';
  return '\u2026 PENDING';
}

/**
 * The FR-6 lifecycle as a stepper, driven by `proof.phase`. A voided hand shows
 * how far it got before it was abandoned.
 *
 * @param {RngProof} proof
 * @returns {HTMLElement}
 */
function phaseStepper(proof) {
  const seedDone = typeof proof.commitment === 'string' && proof.commitment !== '';
  const deckDone = proof.deckRoot !== null;
  const audited = proof.phase === 'AUDITED';
  const voided = proof.phase === 'VOIDED';
  const currentIndex =
    proof.phase === 'SEED_COMMITTED' ? 0 : proof.phase === 'DECK_COMMITTED' ? 1 : proof.phase === 'AUDITED' ? 2 : -1;

  const steps = [
    { label: '1 · Seed committed', sub: 'commitSeed: commitment, nonce, commit block N', done: seedDone },
    { label: '2 · Deck committed', sub: 'commitDeck: Merkle root of the 52 salted leaves', done: deckDone },
    { label: '3 · Audited', sub: 'deckSeed, entropy, 52 salts and the deck ordering', done: audited },
  ];

  const items = steps.map((step, index) => {
    // A voided hand keeps whatever actually happened visible: the commitment
    // and/or deck root it did publish stay checked, and no step is "current".
    const state = step.done ? 'done' : !voided && index === currentIndex ? 'current' : 'pending';
    return h(
      'li',
      { class: 'phase-step', dataset: { state } },
      h('span', { class: 'phase-step-marker', 'aria-hidden': 'true', text: state === 'done' ? '\u2713' : state === 'current' ? '\u25cf' : '\u25cb' }),
      h('span', { class: 'phase-step-label', text: step.label }),
      h('span', { class: 'phase-step-sub', text: step.sub }),
    );
  });

  if (voided) {
    items.push(
      h(
        'li',
        { class: 'phase-step', dataset: { state: 'void' } },
        h('span', { class: 'phase-step-marker', 'aria-hidden': 'true', text: '\u2717' }),
        h('span', { class: 'phase-step-label', text: 'Voided' }),
        h('span', { class: 'phase-step-sub', text: voidReasonName(proof.voidedReason) }),
      ),
    );
  }

  return h(
    'div',
    { class: 'proof-subblock' },
    h(
      'h3',
      { class: 'subblock-title' },
      'FR-6 lifecycle',
      ' ',
      rngPhaseBadge(proof.phase),
      ' ',
      h('span', { class: 'muted small', text: `phase = ${String(proof.phase)}` }),
    ),
    h('ol', { class: 'phase-stepper' }, items),
    h('p', { class: 'note', text: phaseNote(proof.phase) }),
  );
}

/**
 * @param {RngPhase|string} phase
 * @returns {string}
 */
function phaseNote(phase) {
  switch (phase) {
    case 'SEED_COMMITTED':
      return 'Phase 1: only the commitment C = keccak256(seed ‖ nonce), the nonce and the commit block are public. The seed itself — and therefore the whole ordering — is secret.';
    case 'DECK_COMMITTED':
      return 'Phase 2: the salted-deck Merkle root is public. The ordering and all 52 salts stay secret, so the root discloses no card.';
    case 'AUDITED':
      return 'Phase 4: the hand is over, so the audit has published deckSeed, entropy, the 52 salts and the full ordering, and the whole shuffle can be recomputed.';
    case 'VOIDED':
      return 'The hand was voided: FR-6 requires that a voided hand publishes no ordering at all.';
    default:
      return 'No FR-6 commitment has been published for this hand yet.';
  }
}

/**
 * @param {RngProof} proof
 * @returns {HTMLElement}
 */
function voidBanner(proof) {
  return banner(
    'error',
    `Hand voided — ${voidReasonName(proof.voidedReason)}`,
    voidReasonSentence(proof.voidedReason),
    'A voided hand is not a proof of a fair deal: FR-6 lets the protocol abandon a hand rather than publish an ordering, and records why. ' +
      'Only the cards actually revealed during play carry any evidence, and each of those still has to match the committed root.',
  );
}

/**
 * Phase 1 — the seed commitment (FR-6.1).
 *
 * @param {RngProof} proof
 * @returns {HTMLElement}
 */
function phase1Section(proof) {
  const live = isLivePhase(proof.phase);
  const seedPublished = typeof proof.deckSeed === 'string' && proof.deckSeed !== '';
  return h(
    'div',
    { class: 'proof-subblock' },
    h('h3', { class: 'subblock-title', text: 'Phase 1 — seed commitment (FR-6.1)' }),
    kvGrid([
      { label: 'commitment C', value: hashNode(proof.commitment), title: proof.commitment },
      { label: 'nonce', value: proof.nonce, title: 'per-table uint256, strictly increasing' },
      { label: 'commit block N', value: blockNode(proof.commitBlock, proof.commitTxHash) },
      {
        label: 'seed (deckSeed)',
        value: seedPublished
          ? hashNode(proof.deckSeed)
          : h('span', { class: 'muted', text: 'secret — withheld while the hand is live (FR-6)' }),
        title: seedPublished ? String(proof.deckSeed) : 'the seed is not published during play',
      },
    ]),
    h('p', {
      class: 'note',
      text: live
        ? 'The seed is still secret. Only the commitment is public, which is what stops anyone — including the operator — from reading the deck mid-hand; it also means no verifier can check the ordering yet, only that the commitment exists.'
        : seedPublished
          ? 'The audit published deckSeed, so C = keccak256(seed ‖ nonce) can now be recomputed and compared with the committed value.'
          : 'The seed is not published and this hand was never audited, so the commitment cannot be opened.',
    }),
  );
}

/**
 * Phase 2 — the committed deck root (FR-6.2).
 *
 * @param {RngProof} proof
 * @returns {HTMLElement}
 */
function phase2Section(proof) {
  const confirmations =
    typeof proof.anchorBlock === 'number' && typeof proof.deckRootBlock === 'number'
      ? proof.deckRootBlock - proof.anchorBlock
      : null;
  const required = typeof proof.requiredConfirmations === 'number' ? proof.requiredConfirmations : null;

  return h(
    'div',
    { class: 'proof-subblock' },
    h('h3', { class: 'subblock-title', text: 'Phase 2 — committed deck root (FR-6.2)' }),
    kvGrid([
      {
        label: 'deckRoot',
        value: proof.deckRoot !== null ? hashNode(proof.deckRoot) : h('span', { class: 'muted', text: 'not committed yet' }),
        title: proof.deckRoot ?? 'no deck commitment for this hand',
      },
      { label: 'deck root block M', value: blockNode(proof.deckRootBlock, proof.deckRootTxHash) },
      { label: 'anchor block N+1', value: blockNode(proof.anchorBlock, proof.anchorBlockHash) },
      { label: 'anchor block hash', value: hashNode(proof.anchorBlockHash), title: proof.anchorBlockHash ?? 'no anchor hash' },
      {
        label: 'anchor source',
        value: badge(proof.anchorSource, proof.anchorSource === 'ONCHAIN' ? 'verified' : 'warn', proof.anchorSource === 'ONCHAIN' ? 'a public chain block supplied the entropy' : 'free mode used the local anchor simulator (FR-4.4)'),
      },
      { label: 'required confirmations', value: required === null ? '\u2014' : String(required), title: 'confirmations the deck root must have over the anchor (FR-6.5)' },
      {
        label: 'confirmations present',
        value:
          confirmations === null
            ? h('span', { class: 'muted', text: '\u2014' })
            : badge(
                String(confirmations),
                required === null || confirmations >= required ? 'verified' : 'failed',
                `deckRootBlock \u2212 anchorBlock = ${confirmations}`,
              ),
      },
    ]),
    h('p', {
      class: 'note',
      text:
        'leaf_i = keccak256(card_i ‖ salt_i) over 52 positions, padded to a 64-leaf tree; deckRoot is the Merkle root of those leaves. ' +
        'Because every salt stays secret until its card is revealed, the root commits to the ordering without disclosing any card.',
    }),
  );
}

/**
 * Phase 3 — the cards the rules made public, each with its Merkle path (FR-6.3).
 *
 * @param {RngProof} proof
 * @param {ClientVerification} client
 * @returns {HTMLElement}
 */
function phase3Section(proof, client) {
  const reveals = Array.isArray(proof.reveals) ? proof.reveals : [];
  const distinct = new Set(reveals.map((reveal) => reveal.index));
  const hidden = Math.max(0, DECK_POSITIONS - distinct.size);
  const rootCommitted = proof.deckRoot !== null;

  const { table, tbody } = tableShell(
    [
      { label: 'deck index', className: 'num' },
      { label: 'card' },
      { label: 'salt (32 bytes)' },
      { label: 'Merkle proof (6 siblings, leaf first)' },
      { label: `validates against deckRoot` },
    ],
    { className: 'reveal-table' },
  );

  if (reveals.length === 0) {
    tbody.appendChild(
      emptyRow(5, rootCommitted ? 'No card has been made public in this hand yet.' : 'No deck root is committed yet, so there is nothing to reveal against.'),
    );
  }
  for (const reveal of reveals) {
    tbody.appendChild(revealRow(reveal, client));
  }

  const summary = h(
    'p',
    { class: 'reveal-summary' },
    h('strong', { text: `${distinct.size} of ${DECK_POSITIONS} positions revealed` }),
    hidden === 0
      ? ' — the whole deck is public, which is only allowed once the hand is over and audited'
      : ` — the other ${hidden} remain hidden commitments`,
  );

  return h(
    'div',
    { class: 'proof-subblock' },
    h('h3', { class: 'subblock-title', text: 'Phase 3 — cards made public (FR-6.3)' }),
    summary,
    h('div', { class: 'table-wrap' }, table),
    h('p', {
      class: 'note',
      text:
        'Only the cards the rules actually exposed are published: board cards as they are dealt, hole cards at showdown. ' +
        'Each row carries that card\u2019s salt and its 6-sibling Merkle path, which is checked against the committed deckRoot. ' +
        'Positions the hand never exposed have no card value anywhere in this panel — under FR-6 a live hand publishes no ordering at all.',
    }),
  );
}

/**
 * @param {CardReveal} reveal
 * @param {ClientVerification} client
 * @returns {HTMLElement}
 */
function revealRow(reveal, client) {
  const validity = client.revealValidity ? client.revealValidity.get(reveal.index) : null;
  const path = Array.isArray(reveal.proof) ? reveal.proof : [];
  const proofCell = h(
    'span',
    { class: 'merkle-proof' },
    path.map((hash) => h('code', { class: 'hash', text: shortHex(hash, 10, 6), title: hash })),
    path.length === 6 ? null : h('span', { class: 'muted small', text: ` (${path.length}/6 siblings)` }),
  );

  return h(
    'tr',
    { class: validity === false ? 'check-fail' : null },
    h('td', { class: 'num', text: String(reveal.index) }),
    h(
      'td',
      null,
      h('span', { class: 'card-cell' }, cardEl(reveal.card), h('span', { class: 'muted small', text: ` ${cardToString(reveal.card)}` })),
    ),
    h('td', null, hashNode(reveal.salt)),
    h('td', null, proofCell),
    h(
      'td',
      null,
      validity === null
        ? h('span', { class: 'muted', text: 'not checked (shared bundle unavailable)' })
        : badge(validity ? 'pass' : 'FAIL', validity ? 'verified' : 'failed', validity ? 'keccak path reproduces the committed root' : 'this reveal does not reproduce the committed root'),
    ),
  );
}

/**
 * Phase 4 — the end-of-hand audit (FR-6.4).
 *
 * While the hand is live this section states plainly that the fields are
 * withheld **by design**; version 6 of the protocol never publishes them early.
 *
 * @param {RngProof} proof
 * @param {ClientVerification} client
 * @returns {HTMLElement}
 */
function phase4Section(proof, client) {
  const audited = proof.phase === 'AUDITED';
  const deck = Array.isArray(proof.deck) ? proof.deck : [];

  if (!audited) {
    return h(
      'div',
      { class: 'proof-subblock' },
      h(
        'h3',
        { class: 'subblock-title' },
        'Phase 4 — end-of-hand audit (FR-6.4)',
        ' ',
        badge('not published yet', 'pending'),
      ),
      h('p', {
        class: 'note',
        text:
          'Withheld by design. While a hand is live FR-6 forbids publishing deckSeed, entropy, the 52 salts and the deck ordering, so ' +
          `proof.deck is an empty array (0 of ${DECK_POSITIONS} positions) because nothing has been published yet — not because data is missing. ` +
          (proof.phase === 'VOIDED'
            ? 'This hand was voided, and a voided hand publishes no ordering at all.'
            : 'The audit appears here as soon as the hand is over.'),
      }),
      kvGrid([
        { label: 'deck ordering', value: h('span', { class: 'muted', text: `not yet published (${deck.length} of ${DECK_POSITIONS} cards)` }) },
        { label: 'audited', value: badge('pending', 'pending', 'proof.audited is false while the hand is live') },
        { label: 'slashed bond', value: slashedNode(proof) },
      ]),
    );
  }

  const rebuilt = findCheck(client.rng, 'audit.deck_root_matches');
  const expected = client.expectedDeck;
  const mismatches = countDeckMismatches(deck, expected);

  return h(
    'div',
    { class: 'proof-subblock' },
    h(
      'h3',
      { class: 'subblock-title' },
      'Phase 4 — end-of-hand audit (FR-6.4)',
      ' ',
      badge('published', 'verified'),
    ),
    kvGrid([
      { label: 'deckSeed', value: hashNode(proof.deckSeed), title: proof.deckSeed ?? 'not published' },
      { label: 'entropy', value: hashNode(proof.entropy), title: proof.entropy ?? 'not published' },
      { label: 'audit block', value: blockNode(proof.auditBlock, proof.auditTxHash) },
      { label: 'audited', value: badge('true', 'verified', 'proof.audited is true in the AUDITED phase') },
      { label: 'slashed bond', value: slashedNode(proof) },
      {
        label: 'rebuilt root = committed root',
        value: rebuilt
          ? badge(rebuilt.ok ? 'equals' : 'DIFFERS', rebuilt.ok ? 'verified' : 'failed', rebuilt.detail ?? '')
          : h('span', { class: 'muted', text: 'not checked (shared bundle unavailable)' }),
        title: `committed ${proof.deckRoot ?? '(null)'}`,
      },
    ]),
    renderAuditDeck(proof, expected, mismatches),
    h('p', {
      class: 'note',
      text:
        'Recomputation: entropy = keccak256(deckSeed ‖ anchorBlockHash) \u2192 Fisher\u2013Yates \u2192 leaf_i = keccak256(card_i ‖ salt_i) \u2192 Merkle root, ' +
        'compared with the phase-2 commitment. This is what makes the commitment permanently provable (FR-6.4), even though nothing about the ordering was public during play.',
    }),
  );
}

/**
 * FR-6.5: the bond slashed when the audit proved a cheat. Rendered with the
 * BigInt-exact money helper — a chip amount is never coerced to a float.
 *
 * @param {RngProof} proof
 * @returns {HTMLElement}
 */
function slashedNode(proof) {
  const slashed = typeof proof.slashed === 'string' && /[1-9]/.test(proof.slashed);
  if (!slashed) return badge('none', 'verified', 'no bond was slashed for this hand');
  return h(
    'span',
    null,
    moneyEl(proof.slashed, { maxFractionDigits: 6 }),
    ' ',
    badge('slashed', 'failed', 'the audit proved a cheat, so the operator bond was slashed (FR-6.5)'),
  );
}

/**
 * Renders the audited 52-card ordering, highlighting any position that differs
 * from the ordering recomputed from the published entropy.
 *
 * @param {RngProof} proof
 * @param {number[]|null} expected
 * @param {number} mismatches
 * @returns {HTMLElement}
 */
function renderAuditDeck(proof, expected, mismatches) {
  const deck = Array.isArray(proof.deck) ? proof.deck : [];
  const grid = h('div', { class: 'deck-grid' });
  deck.forEach((card, index) => {
    const expectedCard = Array.isArray(expected) && index < expected.length ? expected[index] : null;
    const mismatch = expectedCard !== null && expectedCard !== undefined && expectedCard !== card;
    grid.appendChild(
      h(
        'div',
        {
          class: `deck-slot${mismatch ? ' deck-mismatch' : ''}`,
          title: `deck[${index}] = ${cardToString(card)}${mismatch ? ` — recomputed ${cardToString(expectedCard)}` : ''}`,
        },
        h('span', { class: 'deck-index', text: String(index) }),
        cardEl(card),
      ),
    );
  });

  return h(
    'div',
    { class: 'audit-deck' },
    h('h4', { class: 'check-title', text: `Audited deck ordering (${deck.length} of ${DECK_POSITIONS} cards)` }),
    mismatches > 0
      ? banner(
          'error',
          `${mismatches} card${mismatches === 1 ? '' : 's'} do not match the recomputed shuffle`,
          'Highlighted below. The committed root would not have rebuilt from this ordering, so the audit and the deal disagree.',
          null,
        )
      : null,
    deck.length === 0
      ? h('p', { class: 'muted', text: 'The audit published no deck ordering, which is itself a failure of the FR-6.4 audit.' })
      : grid,
    h(
      'details',
      { class: 'raw-block' },
      h('summary', { text: 'Deck as text (index: card)' }),
      h('pre', { text: deck.map((card, index) => `${String(index).padStart(2, '0')}: ${cardToString(card)}`).join('  ') }),
    ),
  );
}

/**
 * @param {number[]} deck
 * @param {number[]|null} expected
 * @returns {number}
 */
function countDeckMismatches(deck, expected) {
  if (!Array.isArray(expected)) return 0;
  let mismatches = 0;
  deck.forEach((card, index) => {
    if (index < expected.length && expected[index] !== card) mismatches += 1;
  });
  return mismatches;
}

/**
 * Bookkeeping fields that are neither a commitment nor an audit: identity, the
 * server's stored verdict and the settlement chain.
 *
 * @param {RngProof} proof
 * @returns {HTMLElement}
 */
function proofMeta(proof) {
  return h(
    'div',
    { class: 'proof-subblock' },
    h('h3', { class: 'subblock-title', text: 'Proof metadata' }),
    kvGrid([
      { label: 'hand', value: `${proof.handId} · #${proof.handNumber}`, title: `table ${proof.tableId}` },
      { label: 'phase', value: rngPhaseBadge(proof.phase), title: `proof.phase = ${String(proof.phase)}` },
      {
        label: 'server stored verdict',
        value: proof.verified ? badge('verified', 'verified') : badge('not verified', 'failed'),
        title: proof.verifiedAt ? `verified at ${formatDateTime(proof.verifiedAt)}` : 'no verification timestamp',
      },
      { label: 'verified at', value: proof.verifiedAt === null ? h('span', { class: 'muted', text: '\u2014' }) : formatDateTime(proof.verifiedAt) },
      { label: 'chain id', value: String(proof.chainId) },
    ]),
  );
}

// ---------------------------------------------------------------------------
// Side-by-side recomputations
// ---------------------------------------------------------------------------

/**
 * @param {RngProof} proof
 * @param {HandVerificationResponse|null} server
 * @param {ClientVerification} client
 * @param {Error|null} serverError
 * @returns {HTMLElement}
 */
function renderComparison(proof, server, client, serverError) {
  const live = isLivePhase(proof.phase);
  const { table, tbody } = tableShell([
    { label: 'Check' },
    { label: 'In your browser' },
    { label: 'Server (/api/v1/verify)' },
    { label: 'Agree' },
  ]);

  const rngServer = comparable(server?.proof, live ? ['audit.present'] : []);
  // The server does not publish a verifyPublicReveals() verdict of its own; it
  // embeds the same checks in its proof verdict (and, once audited, in its deal
  // verdict), so there is nothing to compare this row against one-for-one.
  const dealServer = live ? null : server?.deal ?? null;

  const rows = [
    {
      label: 'verifyRngProof() — commitment, anchor, hidden-card invariant, reveals, entropy',
      client: client.rng,
      server: rngServer,
      note: rngServer && rngServer.skipped.length > 0 ? `ignoring ${rngServer.skipped.join(', ')} (audit-gated)` : null,
    },
    {
      label: 'verifyPublicReveals() — every public card vs the committed root',
      client: client.reveals,
      server: null,
      note: 'the server embeds these checks in its proof verdict instead',
    },
    {
      label: 'verifyHandDeal() — hole cards, board, burns vs the audited deck',
      client: client.deal,
      server: dealServer,
      note: live ? 'not checkable until the FR-6.4 audit' : null,
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
        h('td', null, row.label, row.note ? h('span', { class: 'muted small block', text: row.note }) : null),
        h('td', null, verdictCell(clientOk, 'not run')),
        h('td', null, verdictCell(serverOk, serverError ? 'unavailable' : 'no comparable data')),
        h('td', null, agree === null ? h('span', { class: 'muted', text: '\u2014' }) : agree ? badge('yes', 'verified') : badge('NO', 'failed')),
      ),
    );
  }

  return h(
    'div',
    { class: 'proof-subblock' },
    h('h3', { class: 'subblock-title', text: 'Independent recomputations' }),
    h('div', { class: 'table-wrap' }, table),
    live
      ? h('p', {
          class: 'note',
          text:
            'While the hand is live the server\u2019s proof verdict still contains its audit-gated check (audit.present), which cannot pass before phase 4. ' +
            'It is excluded from the comparison above so a live hand is not reported as a disagreement for a reason that is not a disagreement.',
        })
      : null,
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
 * @param {RngProof} proof
 * @param {ClientVerification} client
 * @returns {HTMLElement}
 */
function renderChecksBlock(proof, client) {
  if (!client.rng && !client.reveals && !client.deal) {
    return h(
      'div',
      { class: 'proof-subblock' },
      h('h3', { class: 'subblock-title', text: 'Recomputed in your browser (trustless)' }),
      h('p', { class: 'muted', text: 'Not available — the shared proof module could not be loaded.' }),
    );
  }
  return h(
    'div',
    { class: 'proof-subblock' },
    h('h3', { class: 'subblock-title', text: 'Recomputed in your browser (trustless)' }),
    checksTable('verifyRngProof()', client.rng, proof.phase),
    checksTable('verifyPublicReveals()', client.reveals, proof.phase),
    checksTable('verifyHandDeal()', client.deal, proof.phase),
  );
}

/**
 * @param {RngProof} proof
 * @param {HandVerificationResponse|null} server
 * @param {Error|null} serverError
 * @returns {HTMLElement}
 */
function renderServerBlock(proof, server, serverError) {
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
    children.push(checksTable('verifyRngProof()', server.proof, proof.phase));
    children.push(checksTable('verifyHandDeal()', server.deal, proof.phase));
    if (server.settlement) children.push(checksTable('verifySettlement()', server.settlement, proof.phase));
  }
  return h('div', { class: 'proof-subblock' }, children);
}

/**
 * Renders every individual check with its name, pass/fail and detail.
 *
 * Two checks are *expected* to be false while a hand is live — `deal.requires_audit`
 * (the deck is only fully checkable after the audit) and, before the deck root
 * exists, `reveals.root_available`. They are labelled as pending rather than
 * reported as failures.
 *
 * @param {string} title
 * @param {ProofVerification|null|undefined} verification
 * @param {RngPhase|string} phase
 * @returns {HTMLElement}
 */
function checksTable(title, verification, phase) {
  const { table, tbody } = tableShell(
    [{ label: 'Check' }, { label: 'Result' }, { label: 'Detail' }],
    { className: 'check-table' },
  );
  if (!verification || !Array.isArray(verification.checks) || verification.checks.length === 0) {
    tbody.appendChild(emptyRow(3, 'no checks returned'));
    return h(
      'div',
      { class: 'check-group' },
      h('h4', { class: 'check-title' }, title, ' ', h('span', { class: 'muted', text: '(no data)' })),
      h('div', { class: 'table-wrap' }, table),
    );
  }

  let blocking = 0;
  for (const check of verification.checks) {
    const gated = isAuditGated(check, phase);
    if (!check.ok && !gated) blocking += 1;
    tbody.appendChild(
      h(
        'tr',
        { class: check.ok ? 'check-ok' : gated ? 'check-pending' : 'check-fail' },
        h('td', null, h('code', { class: 'check-name', text: check.name })),
        h(
          'td',
          null,
          check.ok
            ? badge('pass', 'verified')
            : gated
              ? badge('expected', 'pending', 'expected while the hand is live — not a failure')
              : badge('FAIL', 'failed'),
        ),
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
      blocking > 0
        ? badge('failed', 'failed')
        : verification.ok
          ? badge('all passed', 'verified')
          : badge('expected while live', 'pending', 'the only failing checks are audit-gated'),
    ),
    h('div', { class: 'table-wrap' }, table),
  );
}

/**
 * True for a failing check that cannot pass yet and must not read as a red
 * failure (FR-6: `deal.requires_audit`; `reveals.root_available` before phase 2).
 *
 * @param {ProofCheck} check
 * @param {RngPhase|string} phase
 * @returns {boolean}
 */
function isAuditGated(check, phase) {
  if (check.ok) return false;
  if (check.name === 'deal.requires_audit') return true;
  if (check.name === 'reveals.root_available') return phase !== 'AUDITED';
  return false;
}

/**
 * @param {string|null} value
 * @returns {HTMLElement}
 */
function hashNode(value) {
  if (!value) return h('span', { class: 'muted', text: '\u2014' });
  return h('code', { class: 'hash', text: shortHex(value, 14, 10), title: value });
}

/**
 * @param {number|null} block
 * @param {string|null} txHash
 * @returns {HTMLElement}
 */
function blockNode(block, txHash) {
  if (block === null || block === undefined) return h('span', { class: 'muted', text: '\u2014' });
  return h(
    'span',
    null,
    h('span', { class: 'block-number', text: String(block) }),
    txHash ? h('code', { class: 'hash', text: ` ${shortHex(txHash, 10, 6)}`, title: txHash }) : null,
  );
}
