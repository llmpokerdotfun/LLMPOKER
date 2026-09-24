import { describe, expect, it } from 'vitest';
import {
  type HandResult,
  type RngProof,
  bytesToHex,
  commitDeckOrder,
  commitmentFor,
  entropyFrom,
  isCompleteDeck,
  publicDeckPositions,
  randomSalts,
  revealFor,
  shuffleDeck,
  verifyHandDeal,
  verifyHiddenCardInvariant,
  verifyPublicReveals,
  verifyRngProof,
} from '@llmpoker/shared';
import { applyAction, createHand, legalActions, replayHand } from '../src/hand.js';
import { deckFor, stripTimes, wagerConfig } from './helpers.js';
import type { PlayerAction } from '@llmpoker/shared';

/**
 * End-to-end fairness test for the off-chain side of the patched FR-6:
 * seed → seed commitment → anchor → deck → Merkle root → per-card reveals →
 * audit, with the published hand history verified by independent recomputation.
 *
 * The two regimes are both covered: what a verifier can prove *while the hand is
 * live* (only commitments and individually proven cards), and what it can prove
 * after the audit (the whole ordering).
 */

const CONFIG = wagerConfig();
const SEED = `0x${'01'.repeat(32)}`;
const ANCHOR = `0x9f2d1b4c7e6a8d0f3b5c9a1e2d4f6078aabbccddeeff00112233445566778899`;
const SECONDS = `0x${'02'.repeat(32)}`;
const NONCE = 42n;
const COMMIT_BLOCK = 1_000;
const DECK_ROOT_BLOCK = COMMIT_BLOCK + 20;
const AUDIT_BLOCK = DECK_ROOT_BLOCK + 30;

/**
 * The deck the proof's seed and anchor imply. The hand must be played with
 * exactly this ordering, otherwise the reveals legitimately point at other cards.
 */
function proofDeck(): number[] {
  return shuffleDeck(entropyFrom(SEED, ANCHOR)).deck;
}

function playHand(deck: number[]): HandResult {
  const players = [0, 1, 2].map((seat) => ({
    seat,
    agentId: `agent-${seat}`,
    agentName: `Agent ${seat}`,
    stack: 10_000n,
  }));
  let step = createHand({
    handId: 'h-proof',
    tableId: CONFIG.id,
    handNumber: 1,
    config: CONFIG,
    buttonSeat: 0,
    players,
    deck,
    now: 1_700_000_000_000,
  });
  let guard = 0;
  while (!step.state.complete && guard++ < 200) {
    const seat = step.state.toActSeat!;
    const legal = legalActions(step.state, seat);
    const action: PlayerAction = legal.canCheck ? { action: 'CHECK' } : { action: 'CALL' };
    step = applyAction(step.state, seat, action, step.state.startedAt + (step.state.seq + 1) * 1000);
  }
  return step.state.result!;
}

/** Builds the proof a live hand would publish, plus the audit when asked. */
function buildProof(result: HandResult, options: { audited: boolean; leakDeck?: boolean }): RngProof {
  const entropy = entropyFrom(SEED, ANCHOR);
  const deck = shuffleDeck(entropy).deck;
  const salts = randomSalts();
  const commitment = commitDeckOrder(deck, salts);

  // The cards the rules have made public: the board always, hole cards at showdown.
  const positions = publicDeckPositions(result);
  const publicIndices = [
    ...positions.board.slice(0, result.board.length),
    ...[...positions.holes.values()].flat(),
  ];
  const reveals = [...new Set(publicIndices)].map((index) => revealFor(commitment, index));

  const base: RngProof = {
    handId: result.handId,
    tableId: result.tableId,
    handNumber: result.handNumber,
    phase: options.audited ? 'AUDITED' : 'DECK_COMMITTED',
    commitment: `0x${bytesToHex(commitmentFor(SEED, NONCE))}`,
    nonce: NONCE.toString(),
    commitBlock: COMMIT_BLOCK,
    commitTxHash: '0xtx1',
    anchorBlock: COMMIT_BLOCK + 1,
    anchorBlockHash: ANCHOR,
    deckRoot: `0x${bytesToHex(commitment.root)}`,
    deckRootBlock: DECK_ROOT_BLOCK,
    deckRootTxHash: '0xtx2',
    reveals,
    audited: options.audited,
    deckSeed: options.audited ? SEED : null,
    entropy: options.audited ? `0x${bytesToHex(entropy)}` : null,
    salts: options.audited ? salts.map((s) => `0x${bytesToHex(s)}`) : null,
    deck: options.audited || options.leakDeck ? deck : [],
    auditBlock: options.audited ? AUDIT_BLOCK : null,
    auditTxHash: options.audited ? '0xtx3' : null,
    slashed: null,
    voidedReason: null,
    anchorSource: 'ONCHAIN',
    requiredConfirmations: 12,
    verified: true,
    verifiedAt: 1,
    chainId: 4663,
  };
  return base;
}

describe('RNG proof verification (FR-6.3, acceptance criterion #4)', () => {
  it('verifies an audited hand: commitment, anchor, root, shuffle and reveals', () => {
    const result = playHand(proofDeck());
    const proof = buildProof(result, { audited: true });

    const verdict = verifyRngProof(proof);
    expect(verdict.checks.filter((c) => !c.ok)).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(isCompleteDeck(proof.deck)).toBe(true);
    expect(proof.reveals.length).toBeGreaterThan(0);

    expect(verifyPublicReveals(result, proof).ok).toBe(true);
    expect(verifyHandDeal(result, proof).ok).toBe(true);
  });

  it('verifies a live hand from commitments and per-card reveals alone', () => {
    const result = playHand(proofDeck());
    const live = buildProof(result, { audited: false });

    // The audit is not required to be present, and nothing secret is published.
    const verdict = verifyRngProof(live, { requireReveal: false });
    expect(verdict.checks.filter((c) => !c.ok)).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(live.deckSeed).toBeNull();
    expect(live.entropy).toBeNull();
    expect(live.salts).toBeNull();
    expect(live.deck).toEqual([]);

    // Every public card is proven against the committed root.
    expect(verifyPublicReveals(result, live).ok).toBe(true);

    // The full deal map is not checkable yet, and the verifier says so instead of
    // pretending the hand is unverifiable or verified.
    const deal = verifyHandDeal(result, live);
    expect(deal.ok).toBe(false);
    expect(deal.checks.some((c) => c.name === 'deal.requires_audit' && !c.ok)).toBe(true);
    expect(deal.checks.some((c) => c.name.startsWith('reveals.') && !c.ok)).toBe(false);
  });

  it('fails a live proof that leaks the ordering — the patched FR-6 invariant', () => {
    const result = playHand(proofDeck());
    const leaked = buildProof(result, { audited: false, leakDeck: true });

    const hidden = verifyHiddenCardInvariant(leaked);
    expect(hidden.ok).toBe(false);
    const ordering = hidden.checks.find((c) => c.name === 'hidden.no_ordering');
    expect(ordering?.ok).toBe(false);
    expect(ordering?.detail).toContain('52 cards');

    // And the whole-proof verdict must reject it too.
    expect(verifyRngProof(leaked, { requireReveal: false }).ok).toBe(false);
  });

  it('fails an audited proof that hides the ordering, and a voided one that publishes it', () => {
    const result = playHand(proofDeck());
    const audited = buildProof(result, { audited: true });
    const stripped: RngProof = { ...audited, deck: [], salts: null };
    expect(verifyRngProof(stripped).ok).toBe(false);

    const voided: RngProof = {
      ...audited,
      phase: 'VOIDED',
      voidedReason: 'AUDIT_STALLED',
      slashed: '100000000000000000000',
    };
    expect(verifyRngProof(voided, { requireReveal: false }).ok).toBe(false); // still publishes the ordering
  });

  it('detects a swapped seed, a wrong anchor, a bad root and a rigged deck', () => {
    const result = playHand(proofDeck());
    const proof = buildProof(result, { audited: true });

    expect(verifyRngProof({ ...proof, deckSeed: SECONDS }).ok).toBe(false);
    expect(verifyRngProof({ ...proof, anchorBlockHash: SECONDS }).ok).toBe(false);
    expect(verifyRngProof({ ...proof, deckRoot: SECONDS }).ok).toBe(false);
    expect(verifyRngProof({ ...proof, nonce: '43' }).ok).toBe(false);

    // A deck that is not what the seed implies: the Merkle root no longer matches.
    const rigged = [...proof.deck];
    const tmp = rigged[0]!;
    rigged[0] = rigged[1]!;
    rigged[1] = tmp;
    const riggedVerdict = verifyRngProof({ ...proof, deck: rigged });
    expect(riggedVerdict.ok).toBe(false);
    expect(riggedVerdict.checks.find((c) => c.name === 'audit.shuffle_matches_published_deck')?.ok).toBe(false);
    expect(riggedVerdict.checks.find((c) => c.name === 'audit.deck_root_matches')?.ok).toBe(false);
  });

  it('detects a reveal that does not match the committed position', () => {
    const result = playHand(proofDeck());
    const live = buildProof(result, { audited: false });
    const first = live.reveals[0]!;

    const swappedCard = { ...first, card: (first.card + 1) % 52 };
    const tampered: RngProof = { ...live, reveals: [swappedCard, ...live.reveals.slice(1)] };
    const verdict = verifyRngProof(tampered, { requireReveal: false });
    expect(verdict.ok).toBe(false);
    expect(verdict.checks.find((c) => c.name === 'rng.card_reveals_proven')?.ok).toBe(false);

    // …and the board check catches a card that was never revealed at its position.
    const dropped: RngProof = { ...live, reveals: live.reveals.slice(1) };
    const revealVerdict = verifyPublicReveals(result, dropped);
    expect(revealVerdict.ok).toBe(false);
    expect(revealVerdict.checks.some((c) => !c.ok && c.detail?.includes('without a Merkle reveal'))).toBe(true);
  });

  it('enforces the anchor-block rule, the deck-root window and finality', () => {
    const result = playHand(proofDeck());
    const proof = buildProof(result, { audited: true });

    expect(verifyRngProof({ ...proof, anchorBlock: COMMIT_BLOCK + 2 }).ok).toBe(false);
    expect(verifyRngProof({ ...proof, deckRootBlock: COMMIT_BLOCK + 300 }).ok).toBe(false);
    expect(verifyRngProof({ ...proof, deckRootBlock: COMMIT_BLOCK }).ok).toBe(false);
    // Only 5 confirmations over the anchor: fails the default K = 12…
    expect(verifyRngProof({ ...proof, deckRootBlock: COMMIT_BLOCK + 6 }).ok).toBe(false);
    // …but passes when the verifier lowers its own threshold.
    expect(verifyRngProof({ ...proof, deckRootBlock: COMMIT_BLOCK + 6 }, { minAnchorConfirmations: 5 }).ok).toBe(true);
  });

  it('requires the audit once the hand is over', () => {
    const result = playHand(proofDeck());
    const live = buildProof(result, { audited: false });
    const verdict = verifyRngProof(live); // default requireReveal: true
    expect(verdict.ok).toBe(false);
    expect(verdict.checks.find((c) => c.name === 'audit.present')?.ok).toBe(false);
  });
});

describe('hand history is the hand that was actually played', () => {
  it('replays the published history to the same result', () => {
    const result = playHand(deckFor(11));
    const replayed = replayHand({ result, deck: deckFor(11), config: CONFIG });
    expect(stripTimes(replayed)).toEqual(stripTimes(result));
    expect(result.board).toHaveLength(5);
  });

  it('verifies a hand that ran out after an all-in, including burns', () => {
    const proofDeck = deckFor(12);
    const players = [0, 1].map((seat) => ({
      seat,
      agentId: `agent-${seat}`,
      agentName: `Agent ${seat}`,
      stack: 1_000n,
    }));
    let step = createHand({
      handId: 'h-allin',
      tableId: CONFIG.id,
      handNumber: 1,
      config: CONFIG,
      buttonSeat: 0,
      players,
      deck: proofDeck,
      now: 0,
    });
    while (!step.state.complete) {
      const seat = step.state.toActSeat!;
      const legal = legalActions(step.state, seat);
      const action: PlayerAction = legal.canAllIn ? { action: 'ALL_IN' } : { action: 'CALL' };
      step = applyAction(step.state, seat, action, step.state.seq * 10);
    }
    const result = step.state.result!;
    expect(result.board).toHaveLength(5);
    expect(result.burns).toHaveLength(3);

    // Rebuild a proof over the deck this hand actually used.
    const salts = randomSalts();
    const commitment = commitDeckOrder(proofDeck, salts);
    const positions = publicDeckPositions(result);
    const proof: RngProof = {
      ...buildProof(result, { audited: true }),
      deck: proofDeck,
      deckRoot: `0x${bytesToHex(commitment.root)}`,
      salts: salts.map((s) => `0x${bytesToHex(s)}`),
      reveals: [...new Set([...positions.board, ...[...positions.holes.values()].flat()])].map((i) =>
        revealFor(commitment, i),
      ),
    };
    // This is the "rigged deck" scenario: the committed root opens honestly, but
    // it is NOT the deck the seed and anchor imply. The audit is what catches it.
    const audit = verifyRngProof(proof);
    expect(audit.ok).toBe(false);
    expect(audit.checks.find((c) => c.name === 'audit.shuffle_matches_published_deck')?.ok).toBe(false);

    // The reveals are still internally consistent with the committed root, which
    // is exactly why per-card proofs alone cannot catch this — only the audit can.
    expect(verifyPublicReveals(result, proof).ok).toBe(true);

    // And the deal-map check fails, because the dealt cards do not come from the
    // ordering the entropy implies.
    const deal = verifyHandDeal(result, proof);
    expect(deal.ok).toBe(false);
    expect(deal.checks.some((c) => c.name === 'deal.board_matches_shuffle' && !c.ok)).toBe(true);
    expect(result.zeroSumVerified).toBe(true);
  });
});
