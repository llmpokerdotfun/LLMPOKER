/**
 * Independent verification of the shuffle (FR-6.3, acceptance criterion #4).
 *
 * Nothing in this file trusts the engine or the contract beyond the raw inputs
 * it is handed: seed, nonce, anchor block hash, block numbers and the deck the
 * chain stored. Everything else is recomputed.
 */

import { bytesToHex, isHexString } from './bytes.js';
import type { Card } from './cards.js';
import { isCompleteDeck } from './cards.js';
import { dealHoldem } from './dealing.js';
import {
  commitmentFor,
  DEFAULT_ANCHOR_CONFIRMATIONS,
  entropyFrom,
  isWithinRevealWindow,
  REVEAL_WINDOW_BLOCKS,
  shuffleDeck,
} from './rng.js';
import type { HandResult, ProofVerification, RngProof } from './types.js';

export interface VerifyOptions {
  /** Require the proof to be fully revealed (default `true`). */
  requireReveal?: boolean;
  /** Confirmations the reveal block must have over the anchor block (FR-6.5). */
  minAnchorConfirmations?: number;
}

function check(name: string, ok: boolean, detail?: string): { name: string; ok: boolean; detail?: string } {
  return detail === undefined ? { name, ok } : { name, ok, detail };
}

/**
 * Recomputes a proof from scratch.
 *
 * Checks performed, in order:
 *  1. shape — hashes are 32-byte hex, deck holds 52 distinct cards,
 *  2. `commitment == keccak256(deckSeed ‖ nonce)`,
 *  3. `anchorBlock == commitBlock + 1` (FR-6.1),
 *  4. reveal inside `(commitBlock, commitBlock + 256]` (FR-6.6),
 *  5. reveal at least `K` confirmations after the anchor (FR-6.5 / NFR-6),
 *  6. `entropy == keccak256(deckSeed ‖ anchorBlockHash)`,
 *  7. `deck == FisherYates(entropy)` — the whole point.
 */
export function verifyRngProof(proof: RngProof, options: VerifyOptions = {}): ProofVerification {
  const requireReveal = options.requireReveal ?? true;
  const minConfirmations = options.minAnchorConfirmations ?? DEFAULT_ANCHOR_CONFIRMATIONS;
  const checks: { name: string; ok: boolean; detail?: string }[] = [];

  // 1. shape
  const seedOk = proof.deckSeed === null || isHexString(proof.deckSeed, 32);
  const anchorHashOk = proof.anchorBlockHash === null || isHexString(proof.anchorBlockHash, 32);
  const commitmentOkShape = isHexString(proof.commitment, 32);
  const nonceOk = /^[0-9]+$/.test(proof.nonce);
  checks.push(check('proof.shape', seedOk && anchorHashOk && commitmentOkShape && nonceOk, 'hashes are 0x + 32 bytes, nonce is decimal'));
  checks.push(check('proof.deck_is_permutation', isCompleteDeck(proof.deck), `deck length ${proof.deck.length}`));

  const revealed = proof.deckSeed !== null && proof.anchorBlockHash !== null;
  if (requireReveal) {
    checks.push(
      check(
        'proof.revealed',
        revealed && proof.revealBlock !== null && proof.entropy !== null,
        'proof must carry deckSeed, anchorBlockHash, revealBlock and entropy',
      ),
    );
  }

  // 2. commitment
  if (proof.deckSeed !== null && nonceOk) {
    const recomputedCommitment = `0x${bytesToHex(commitmentFor(proof.deckSeed, BigInt(proof.nonce)))}`;
    checks.push(
      check(
        'rng.commitment_matches_seed',
        recomputedCommitment === proof.commitment.toLowerCase(),
        `expected ${proof.commitment}, recomputed ${recomputedCommitment}`,
      ),
    );
  }

  // 3. anchor is the block right after the commitment
  if (proof.commitBlock !== null && proof.anchorBlock !== null) {
    checks.push(
      check(
        'rng.anchor_is_next_block',
        proof.anchorBlock === proof.commitBlock + 1,
        `commitBlock ${proof.commitBlock}, anchorBlock ${proof.anchorBlock}`,
      ),
    );
  }

  // 4. reveal window
  if (proof.commitBlock !== null && proof.revealBlock !== null) {
    checks.push(
      check(
        'rng.reveal_within_window',
        isWithinRevealWindow(proof.commitBlock, proof.revealBlock),
        `revealBlock ${proof.revealBlock} must be in (${proof.commitBlock}, ${proof.commitBlock + REVEAL_WINDOW_BLOCKS}]`,
      ),
    );
  }

  // 5. finality
  if (proof.anchorBlock !== null && proof.revealBlock !== null) {
    checks.push(
      check(
        'rng.anchor_confirmations',
        proof.revealBlock - proof.anchorBlock >= minConfirmations,
        `${proof.revealBlock - proof.anchorBlock} confirmations, need >= ${minConfirmations}`,
      ),
    );
  }

  // 6. entropy
  let recomputedEntropy: string | null = null;
  if (proof.deckSeed !== null && proof.anchorBlockHash !== null) {
    recomputedEntropy = `0x${bytesToHex(entropyFrom(proof.deckSeed, proof.anchorBlockHash))}`;
    checks.push(
      check(
        'rng.entropy_matches',
        proof.entropy !== null && recomputedEntropy === proof.entropy.toLowerCase(),
        `expected ${proof.entropy ?? '(null)'}, recomputed ${recomputedEntropy}`,
      ),
    );
  }

  // 7. the shuffle itself
  if (recomputedEntropy !== null) {
    const { deck } = shuffleDeck(recomputedEntropy);
    const matches = deck.length === proof.deck.length && deck.every((c, idx) => c === proof.deck[idx]);
    checks.push(
      check(
        'rng.shuffle_matches_stored_deck',
        matches,
        matches ? undefined : `recomputed ${deck.slice(0, 8).join(',')}… vs stored ${proof.deck.slice(0, 8).join(',')}…`,
      ),
    );
  }

  return { ok: checks.every((c) => c.ok), checks };
}

/**
 * Strongest available check: recompute the deck from the proof **and** confirm
 * that the cards the hand history says were dealt are exactly the cards the
 * canonical dealing procedure produces from that deck.
 *
 * This is what catches a rigged engine that publishes a fair-looking deck but
 * deals something else.
 */
export function verifyHandDeal(result: HandResult, proof: RngProof): ProofVerification {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];
  const shuffled = proof.entropy !== null ? shuffleDeck(proof.entropy).deck : null;

  if (shuffled === null) {
    return { ok: false, checks: [check('deal.deck_available', false, 'proof has no entropy/deck')] };
  }

  checks.push(check('deal.deck_source', true, `deck recomputed from proof for hand ${result.handId}`));

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

  const expected = dealHoldem(shuffled, result.dealingOrder, { burnCards: result.burns.length > 0 });
  const expectedBoard = expected.board.join(',');
  const actualBoard = result.board.join(',');
  checks.push(
    check('deal.board_matches_shuffle', expectedBoard === actualBoard, `expected [${expectedBoard}] got [${actualBoard}]`),
  );

  for (const seat of result.seats) {
    const actual = (seat.holeCards ?? []).join(',');
    if (seat.holeCards === null || seat.holeCards === undefined) continue;
    const exp = (expected.holes.get(seat.seat) ?? []).join(',');
    checks.push(
      check(`deal.seat_${seat.seat}_hole_cards_match`, exp === actual, `expected [${exp}] got [${actual}]`),
    );
  }

  const burnsMatch = expected.burns.join(',') === result.burns.join(',');
  checks.push(check('deal.burns_match', burnsMatch, `expected [${expected.burns.join(',')}] got [${result.burns.join(',')}]`));

  return { ok: checks.every((c) => c.ok), checks };
}

/** Convenience: the deck a verifier expects for a hand, as card ids. */
export function expectedDeck(proof: RngProof): Card[] | null {
  if (proof.entropy === null) return null;
  return shuffleDeck(proof.entropy).deck;
}
