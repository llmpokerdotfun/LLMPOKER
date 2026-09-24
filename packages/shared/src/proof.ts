/**
 * Independent verification of the shuffle (FR-6.3, acceptance criterion #4).
 *
 * Nothing here trusts the engine or the contract beyond the raw inputs it is
 * handed. The patched FR-6 splits verification into two regimes, and this file
 * enforces the boundary between them:
 *
 * **While a hand is live** (`phase` is `SEED_COMMITTED` or `DECK_COMMITTED`)
 * only *commitments* exist publicly. The verifier proves that
 *   * the seed commitment is well-formed and, once the audit arrives, opens it;
 *   * every card that has become public is the card at the committed position,
 *     by checking its Merkle path against `deckRoot`;
 *   * **no seed, entropy, salt or ordering has been disclosed** — the invariant
 *     that makes the hidden-card scheme meaningful. A server that leaked the deck
 *     early would fail verification, not merely be frowned upon.
 *
 * **Once the hand is over** (`phase` is `AUDITED`) the operator must publish the
 * seed and all 52 salts, and the verifier recomputes
 * `entropy → FisherYates(entropy) → leaves → Merkle root` and compares each step
 * with what was committed in phase 1 and phase 2.
 */

import { bytesToHex, isHexString } from './bytes.js';
import { type Card, isCompleteDeck } from './cards.js';
import { type DealOptions, dealHoldem, dealIndexMap } from './dealing.js';
import {
  DECK_PROOF_LENGTH,
  DECK_SIZE,
  leavesForDeck,
  merkleRoot,
  verifyCardReveal,
  type CardReveal,
} from './merkle.js';
import {
  DEFAULT_ANCHOR_CONFIRMATIONS,
  REVEAL_WINDOW_BLOCKS,
  commitmentFor,
  entropyFrom,
  isWithinRevealWindow,
  shuffleDeck,
} from './rng.js';
import type { HandResult, ProofVerification, RngProof } from './types.js';

export interface VerifyOptions {
  /** Require the end-of-hand audit to be present (default `true`). */
  requireReveal?: boolean;
  /** Minimum confirmations the deck root must have over the anchor (FR-6.5). */
  minAnchorConfirmations?: number;
}

type Check = { name: string; ok: boolean; detail?: string };

function check(name: string, ok: boolean, detail?: string): Check {
  return detail === undefined ? { name, ok } : { name, ok, detail };
}

function isLivePhase(phase: RngProof['phase']): boolean {
  return phase === 'SEED_COMMITTED' || phase === 'DECK_COMMITTED';
}

function hex32(value: string | null): boolean {
  return value === null || isHexString(value, 32);
}

/**
 * FR-6 (patched) invariant: while a hand is live, nothing that reveals the
 * ordering may be public. Returns the individual checks so a failure says exactly
 * which field leaked.
 */
export function verifyHiddenCardInvariant(proof: RngProof): ProofVerification {
  const checks: Check[] = [];
  const live = isLivePhase(proof.phase);
  const audited = proof.phase === 'AUDITED';

  if (live) {
    checks.push(check('hidden.no_seed', proof.deckSeed === null, 'deckSeed must stay secret while the hand is live'));
    checks.push(check('hidden.no_entropy', proof.entropy === null, 'entropy must stay secret while the hand is live'));
    checks.push(check('hidden.no_salts', proof.salts === null, 'salts must stay secret while the hand is live'));
    checks.push(check('hidden.no_ordering', proof.deck.length === 0, `deck must be empty while live (got ${proof.deck.length} cards)`));
    checks.push(check('hidden.not_audited', proof.audited === false, 'audited must be false while the hand is live'));
  }

  if (audited) {
    checks.push(check('audit.seed_published', isHexString(proof.deckSeed, 32), 'the audit must publish the seed'));
    checks.push(check('audit.entropy_published', isHexString(proof.entropy, 32), 'the audit must publish the entropy'));
    checks.push(
      check('audit.salts_published', Array.isArray(proof.salts) && proof.salts.length === DECK_SIZE, `expected ${DECK_SIZE} salts`),
    );
    checks.push(check('audit.deck_published', isCompleteDeck(proof.deck), `expected ${DECK_SIZE} distinct cards`));
    checks.push(check('audit.flagged', proof.audited === true, 'audited must be true in the AUDITED phase'));
  }

  if (proof.phase === 'VOIDED') {
    checks.push(check('void.no_ordering', proof.deck.length === 0, 'a voided hand publishes no ordering'));
    checks.push(check('void.reason_recorded', proof.voidedReason !== null, 'a voided hand must record why'));
  }

  // Card values may only appear as individual, proven reveals.
  for (const reveal of proof.reveals) {
    checks.push(
      check(
        `hidden.reveal_${reveal.index}_proven`,
        proof.deckRoot !== null && verifyCardReveal(proof.deckRoot, reveal),
        `reveal at deck index ${reveal.index} must carry a Merkle path to the committed root`,
      ),
    );
  }

  return { ok: checks.every((c) => c.ok), checks };
}

/** The public cards a hand has exposed so far, by deck position. */
export function publicDeckPositions(result: HandResult): { board: number[]; holes: Map<number, number[]> } {
  const burnCards = result.burns.length > 0 || result.board.length === 0;
  const map = dealIndexMap(result.dealingOrder, { burnCards });
  const holes = new Map<number, number[]>();
  for (const seat of result.seats) {
    const indices = map.holes.get(seat.seat);
    if (indices && seat.holeCards) holes.set(seat.seat, indices);
  }
  return { board: map.board, holes };
}

/**
 * Checks the cards a hand has made public against the committed root: the board
 * always, and hole cards whenever the history exposes them. This is the check
 * that works *during* a hand, before any audit exists.
 */
export function verifyPublicReveals(result: HandResult, proof: RngProof): ProofVerification {
  const checks: Check[] = [];
  if (proof.deckRoot === null) {
    return { ok: false, checks: [check('reveals.root_available', false, 'no committed deck root')] };
  }

  const byIndex = new Map<number, CardReveal>();
  for (const reveal of proof.reveals) byIndex.set(reveal.index, reveal);
  checks.push(
    check(
      'reveals.no_duplicate_positions',
      byIndex.size === proof.reveals.length,
      `a deck position can only be revealed once (${proof.reveals.length} reveals, ${byIndex.size} distinct)`,
    ),
  );

  const positions = publicDeckPositions(result);

  result.board.forEach((card, offset) => {
    const index = positions.board[offset];
    if (index === undefined) return;
    const reveal = byIndex.get(index);
    checks.push(
      check(
        `reveals.board_${offset}_at_index_${index}`,
        reveal !== undefined && reveal.card === card,
        reveal === undefined
          ? `board card ${offset} (deck index ${index}) was published without a Merkle reveal`
          : `expected card ${card} at index ${index}, reveal says ${reveal.card}`,
      ),
    );
  });

  for (const seat of result.seats) {
    if (!seat.holeCards || seat.holeCards.length === 0) continue;
    const indices = positions.holes.get(seat.seat) ?? [];
    seat.holeCards.forEach((card, offset) => {
      const index = indices[offset];
      if (index === undefined) return;
      const reveal = byIndex.get(index);
      checks.push(
        check(
          `reveals.seat_${seat.seat}_card_${offset}_at_index_${index}`,
          reveal !== undefined && reveal.card === card,
          reveal === undefined
            ? `hole card for seat ${seat.seat} was published without a Merkle reveal`
            : `expected card ${card} at index ${index}, reveal says ${reveal.card}`,
        ),
      );
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * Recomputes a proof from scratch. See the module docs for the two regimes; the
 * checks are ordered to mirror the FR-6 phases.
 */
export function verifyRngProof(proof: RngProof, options: VerifyOptions = {}): ProofVerification {
  const requireAudit = options.requireReveal ?? true;
  const minConfirmations =
    options.minAnchorConfirmations ?? proof.requiredConfirmations ?? DEFAULT_ANCHOR_CONFIRMATIONS;
  const checks: Check[] = [];

  // -- shape ---------------------------------------------------------------
  checks.push(
    check(
      'proof.shape',
      isHexString(proof.commitment, 32) && /^[0-9]+$/.test(proof.nonce) && hex32(proof.deckRoot) && hex32(proof.anchorBlockHash),
      'commitment, deckRoot and anchorBlockHash are 0x + 32 bytes; nonce is decimal',
    ),
  );
  checks.push(
    check(
      'proof.phase_known',
      ['NONE', 'SEED_COMMITTED', 'DECK_COMMITTED', 'AUDITED', 'VOIDED'].includes(proof.phase),
      `phase = ${String(proof.phase)}`,
    ),
  );
  checks.push(
    check(
      'proof.anchor_source',
      proof.anchorSource === 'ONCHAIN' || proof.anchorSource === 'LOCAL',
      `anchorSource = ${String(proof.anchorSource)}`,
    ),
  );

  // -- the hidden-card invariant (the heart of the patched FR-6) -----------
  const hidden = verifyHiddenCardInvariant(proof);
  checks.push(...hidden.checks);

  // -- FR-6.1: the seed commitment ----------------------------------------
  if (proof.deckSeed !== null && /^[0-9]+$/.test(proof.nonce)) {
    const recomputed = `0x${bytesToHex(commitmentFor(proof.deckSeed, BigInt(proof.nonce)))}`;
    checks.push(
      check(
        'rng.commitment_matches_seed',
        recomputed === proof.commitment.toLowerCase(),
        `expected ${proof.commitment}, recomputed ${recomputed}`,
      ),
    );
  }

  // -- FR-6.2: anchor block and reveal window ------------------------------
  if (proof.commitBlock !== null && proof.anchorBlock !== null) {
    checks.push(
      check(
        'rng.anchor_is_next_block',
        proof.anchorBlock === proof.commitBlock + 1,
        `commitBlock ${proof.commitBlock}, anchorBlock ${proof.anchorBlock}`,
      ),
    );
  }
  if (proof.commitBlock !== null && proof.deckRootBlock !== null) {
    checks.push(
      check(
        'rng.deck_root_within_window',
        isWithinRevealWindow(proof.commitBlock, proof.deckRootBlock),
        `deckRootBlock ${proof.deckRootBlock} must be in (${proof.commitBlock}, ${proof.commitBlock + REVEAL_WINDOW_BLOCKS}]`,
      ),
    );
  }
  if (proof.anchorBlock !== null && proof.deckRootBlock !== null) {
    checks.push(
      check(
        'rng.deck_root_confirmations',
        proof.deckRootBlock - proof.anchorBlock >= minConfirmations,
        `${proof.deckRootBlock - proof.anchorBlock} confirmations, need >= ${minConfirmations}`,
      ),
    );
  }

  // -- FR-6.3: every published card is the committed one -------------------
  if (proof.reveals.length > 0) {
    const bad = proof.reveals.filter((r) => !verifyCardReveal(proof.deckRoot ?? '', r));
    checks.push(
      check(
        'rng.card_reveals_proven',
        bad.length === 0,
        bad.length === 0
          ? `${proof.reveals.length} revealed card(s) match the committed root`
          : `${bad.length} reveal(s) fail their Merkle proof: indices ${bad.map((r) => r.index).join(', ')}`,
      ),
    );
  }

  // -- FR-6.4: the end-of-hand audit --------------------------------------
  if (requireAudit) {
    checks.push(
      check(
        'audit.present',
        proof.phase === 'AUDITED' || proof.phase === 'VOIDED',
        `audit must have happened (phase = ${proof.phase})`,
      ),
    );
  }

  if (proof.phase === 'AUDITED' && proof.deckSeed !== null && proof.anchorBlockHash !== null) {
    const recomputedEntropy = `0x${bytesToHex(entropyFrom(proof.deckSeed, proof.anchorBlockHash))}`;
    checks.push(
      check(
        'audit.entropy_matches',
        recomputedEntropy === (proof.entropy ?? '').toLowerCase(),
        `expected ${proof.entropy ?? '(null)'}, recomputed ${recomputedEntropy}`,
      ),
    );

    const shuffled = shuffleDeck(recomputedEntropy).deck;
    checks.push(
      check(
        'audit.shuffle_matches_published_deck',
        shuffled.length === proof.deck.length && shuffled.every((card, index) => card === proof.deck[index]),
        'the audited ordering must equal FisherYates(entropy)',
      ),
    );

    if (Array.isArray(proof.salts) && proof.salts.length === DECK_SIZE && isCompleteDeck(proof.deck)) {
      const rebuilt = `0x${bytesToHex(merkleRoot(leavesForDeck(proof.deck, proof.salts)))}`;
      checks.push(
        check(
          'audit.deck_root_matches',
          rebuilt === (proof.deckRoot ?? '').toLowerCase(),
          `expected root ${proof.deckRoot ?? '(null)'}, rebuilt ${rebuilt}`,
        ),
      );

      // Reveals must agree with the audit, not merely with the root.
      const mismatched = proof.reveals.filter((r) => proof.deck[r.index] !== r.card);
      checks.push(
        check(
          'audit.reveals_consistent',
          mismatched.length === 0,
          mismatched.length === 0
            ? `${proof.reveals.length} reveal(s) agree with the audited deck`
            : `reveals disagree with the audited deck at indices ${mismatched.map((r) => r.index).join(', ')}`,
        ),
      );

      // Salts must be distinct: a reused salt would let one revealed card
      // unmask the position of another.
      const saltSet = new Set(proof.salts.map((s) => s.toLowerCase()));
      checks.push(check('audit.salts_distinct', saltSet.size === DECK_SIZE, `${saltSet.size} distinct salts of ${DECK_SIZE}`));
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * Strongest available check: recompute the deck from the audit **and** confirm
 * that the cards the hand history says were dealt are exactly the cards the
 * canonical dealing procedure produces from that deck.
 *
 * This is what catches a rigged engine that publishes a fair-looking deck but
 * deals something else.
 */
export function verifyHandDeal(result: HandResult, proof: RngProof): ProofVerification {
  const checks: Check[] = [];

  if (proof.phase !== 'AUDITED') {
    return {
      ok: false,
      checks: [
        check(
          'deal.requires_audit',
          false,
          `the deck is only fully checkable after the FR-6.4 audit (phase = ${proof.phase}); use verifyPublicReveals() while the hand is live`,
        ),
        ...verifyPublicReveals(result, proof).checks,
      ],
    };
  }

  const shuffled = proof.entropy !== null ? shuffleDeck(proof.entropy).deck : null;
  if (shuffled === null) {
    return { ok: false, checks: [check('deal.deck_available', false, 'proof has no entropy')] };
  }
  checks.push(check('deal.deck_source', true, `deck recomputed from the audit for hand ${result.handId}`));

  const covered = new Set<Card>();
  for (const c of result.burns) covered.add(c);
  for (const c of result.board) covered.add(c);
  for (const s of result.seats) {
    for (const c of s.holeCards ?? []) covered.add(c);
  }
  checks.push(
    check(
      'deal.no_duplicate_cards_dealt',
      covered.size === result.burns.length + result.board.length + result.seats.reduce((n, s) => n + (s.holeCards?.length ?? 0), 0),
      'a card cannot appear twice across holes, board and burns',
    ),
  );

  // Two cards per seat are dealt before anything else, so the hole cards are
  // identical whether or not the table burns. A hand that ends preflop reveals no
  // public cards, and then the burn setting is unobservable — so only the hole
  // cards are checked, and the board/burn checks compare a prefix of what the
  // canonical procedure would have produced.
  const revealedNothingPublic = result.board.length === 0 && result.burns.length === 0;
  const burnCards: DealOptions['burnCards'] = revealedNothingPublic ? true : result.burns.length > 0;
  const expected = dealHoldem(shuffled, result.dealingOrder, { burnCards });

  for (const seat of result.seats) {
    if (seat.holeCards === null || seat.holeCards === undefined) continue;
    const actual = seat.holeCards.join(',');
    const exp = (expected.holes.get(seat.seat) ?? []).join(',');
    checks.push(check(`deal.seat_${seat.seat}_hole_cards_match`, exp === actual, `expected [${exp}] got [${actual}]`));
  }

  if (revealedNothingPublic) {
    checks.push(check('deal.board_matches_shuffle', true, 'hand ended preflop: no public cards to compare'));
    return { ok: checks.every((c) => c.ok), checks };
  }

  const expectedBoard = expected.board.slice(0, result.board.length).join(',');
  const actualBoard = result.board.join(',');
  checks.push(
    check('deal.board_matches_shuffle', expectedBoard === actualBoard, `expected [${expectedBoard}] got [${actualBoard}]`),
  );

  if (result.burns.length > 0) {
    const expectedBurns = expected.burns.slice(0, result.burns.length).join(',');
    checks.push(
      check('deal.burns_match', expectedBurns === result.burns.join(','), `expected [${expectedBurns}] got [${result.burns.join(',')}]`),
    );
  }

  // The public reveals must still line up with the dealt cards.
  checks.push(...verifyPublicReveals(result, proof).checks);

  return { ok: checks.every((c) => c.ok), checks };
}

/** Convenience: the deck a verifier expects for an audited hand, as card ids. */
export function expectedDeck(proof: RngProof): Card[] | null {
  if (proof.phase !== 'AUDITED' || proof.entropy === null) return null;
  return shuffleDeck(proof.entropy).deck;
}

export { DECK_PROOF_LENGTH, verifyCardReveal };
export type { CardReveal };
