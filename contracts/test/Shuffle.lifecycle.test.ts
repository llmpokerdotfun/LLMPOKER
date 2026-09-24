/**
 * Shuffle lifecycle tests for the **hidden-card** protocol (FR-6.1–6.9, NFR-6).
 *
 * The centrepiece is the confidentiality invariant (FR-6.8): while a hand is live the contract must
 * expose commitments only. These tests assert that across every observable the contract offers —
 * storage views, event logs and the ABI surface itself — rather than by trusting intent.
 */

import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';
import { mineUpTo, time } from '@nomicfoundation/hardhat-network-helpers';

import {
  PHASE,
  TEST_AUDIT_GRACE_BLOCKS,
  TEST_REQUIRED_BOND,
  VOID_REASON,
  commitDeckPhase,
  commitSeedPhase,
  commitmentFor,
  derivedDeck,
  derivedDeckFromHash,
  entropyFrom,
  handIdFor,
  parseShuffleLog,
  riggedCommitment,
  seedFor,
  snapshotFixture,
  type PokerStack,
  type SnapshotFixture,
} from './support/helpers';
import { PROOF_LENGTH, cardProof, commitmentForDeck, leafHash } from './support/merkle';

const CARD_HIDDEN = 255n;

describe('Shuffle — hidden-card commit/reveal lifecycle (FR-6)', () => {
  let fixture: SnapshotFixture;
  let stack: PokerStack;
  let shuffle: any;
  let confirmations: bigint;

  before(async () => {
    fixture = await snapshotFixture(2n);
    stack = fixture.stack;
    shuffle = stack.shuffle;
    confirmations = BigInt(await shuffle.requiredConfirmations());
  });

  beforeEach(async () => {
    await fixture.reset();
  });

  /** Run phases 1 + 2 for a fresh hand and hand back everything a verifier needs. */
  async function openHiddenHand(label: string, nonce = 1n) {
    const handId = handIdFor(label);
    const deckSeed = seedFor(handId);
    const committed = await commitSeedPhase(stack, handId, deckSeed, nonce);
    const deckCommitted = await commitDeckPhase(stack, handId, committed.commitmentRecord);
    return { handId, deckSeed, ...committed, ...deckCommitted };
  }

  describe('phase 1 — commit the seed (FR-6.1)', () => {
    it('records the commitment, nonce and commit block, with the seed still secret', async () => {
      const handId = handIdFor('phase1');
      const deckSeed = seedFor(handId);
      const seedCommitment = commitmentFor(deckSeed, 7n);

      const receipt = await (await shuffle.connect(stack.operator).commitSeed(handId, seedCommitment, 7n)).wait();

      expect(await shuffle.seedCommitmentOf(handId)).to.equal(seedCommitment);
      expect(await shuffle.nonceOf(handId)).to.equal(7n);
      expect(await shuffle.commitBlockOf(handId)).to.equal(BigInt(receipt.blockNumber));
      expect(await shuffle.anchorBlockOf(handId)).to.equal(BigInt(receipt.blockNumber + 1));
      expect(await shuffle.phaseOf(handId)).to.equal(PHASE.SeedCommitted);
      expect(await shuffle.hasCommitment(handId)).to.equal(true);
      expect(await shuffle.isDeckCommitted(handId)).to.equal(false);
      // Nothing about the deck exists yet.
      expect(await shuffle.deckRootOf(handId)).to.equal(ethers.ZeroHash);
      expect(await shuffle.anchorBlockHashOf(handId)).to.equal(ethers.ZeroHash);
    });

    it('emits SeedCommitted and nothing else', async () => {
      const handId = handIdFor('phase1-event');
      const seedCommitment = commitmentFor(seedFor(handId), 3n);

      const receipt = await (await shuffle.connect(stack.operator).commitSeed(handId, seedCommitment, 3n)).wait();
      const parsed = parseShuffleLog(stack, receipt, 'SeedCommitted');
      expect(parsed.args.handId).to.equal(handId);
      expect(parsed.args.seedCommitment).to.equal(seedCommitment);
      expect(parsed.args.nonce).to.equal(3n);

      const shuffleEvents = receipt.logs.filter((log: any) => {
        try {
          return shuffle.interface.parseLog(log) !== null;
        } catch {
          return false;
        }
      });
      expect(shuffleEvents.length).to.equal(1);
    });

    it('rejects a duplicate commitment for the same hand id (FR-10.4)', async () => {
      const handId = handIdFor('phase1-dup');
      await shuffle.connect(stack.operator).commitSeed(handId, commitmentFor(seedFor(handId), 1n), 1n);
      await expect(
        shuffle.connect(stack.operator).commitSeed(handId, commitmentFor(seedFor(handId), 1n), 2n),
      )
        .to.be.revertedWithCustomError(shuffle, 'CommitmentExists')
        .withArgs(handId);
    });

    it('rejects a zero hand id and a non-operator caller (FR-10.3)', async () => {
      await expect(shuffle.connect(stack.operator).commitSeed(ethers.ZeroHash, commitmentFor(seedFor(handIdFor('x')), 1n), 1n))
        .to.be.revertedWithCustomError(shuffle, 'UnknownHand')
        .withArgs(ethers.ZeroHash);
      await expect(
        shuffle.connect(stack.players[0]).commitSeed(handIdFor('nope'), commitmentFor(seedFor(handIdFor('y')), 1n), 1n),
      ).to.be.revertedWithCustomError(shuffle, 'AccessControlUnauthorizedAccount');
    });

    it('requires the operator bond before a hand can start (FR-6.5)', async () => {
      const poorOperator = stack.players[5]!;
      await shuffle.connect(stack.owner).grantRole(await shuffle.OPERATOR_ROLE(), stack.playerAddresses[5]!);
      await expect(
        shuffle.connect(poorOperator).commitSeed(handIdFor('unbonded'), commitmentFor(seedFor(handIdFor('z')), 1n), 1n),
      )
        .to.be.revertedWithCustomError(shuffle, 'InsufficientBond')
        .withArgs(0n, TEST_REQUIRED_BOND);

      const token = stack.token as ethers.Contract;
      await (token.connect(stack.owner) as ethers.Contract).transfer!(stack.playerAddresses[5]!, TEST_REQUIRED_BOND);
      await (token.connect(poorOperator) as ethers.Contract).approve!(stack.shuffleAddress, ethers.MaxUint256);
      await expect(shuffle.connect(poorOperator).postBond(TEST_REQUIRED_BOND))
        .to.emit(shuffle, 'BondPosted')
        .withArgs(stack.playerAddresses[5]!, TEST_REQUIRED_BOND, TEST_REQUIRED_BOND);
      await expect(shuffle.connect(poorOperator).commitSeed(handIdFor('bonded'), commitmentFor(seedFor(handIdFor('z2')), 1n), 1n))
        .to.not.be.reverted;
    });
  });

  describe('phase 2 — commit the deck, not the seed (FR-6.2, FR-6.9)', () => {
    it('stores only the root + anchor hash and never the ordering', async () => {
      const { handId, commitmentRecord, anchorBlockHash } = await openHiddenHand('phase2');

      expect(await shuffle.deckRootOf(handId)).to.equal(commitmentRecord.root);
      expect(await shuffle.anchorBlockHashOf(handId)).to.equal(anchorBlockHash);
      expect(await shuffle.phaseOf(handId)).to.equal(PHASE.DeckCommitted);
      expect(await shuffle.isDeckCommitted(handId)).to.equal(true);
      expect(await shuffle.isFullyRevealed(handId)).to.equal(false);
      expect(await shuffle.revealedCardAt(handId, 0)).to.equal(CARD_HIDDEN);
    });

    it('captures the hash of block commitBlock + 1 and enforces the confirmations (FR-6.5, NFR-6)', async () => {
      const handId = handIdFor('phase2-anchor');
      const deckSeed = seedFor(handId);
      const { commitBlock, anchorBlockHash, commitmentRecord } = await commitSeedPhase(stack, handId, deckSeed, 1n);
      const committed = await commitDeckPhase(stack, handId, commitmentRecord);

      expect(committed.anchorBlock).to.equal(BigInt(commitBlock + 1));
      expect(committed.anchorBlockHash).to.equal(anchorBlockHash);
      expect(committed.confirmations).to.be.greaterThanOrEqual(confirmations);
      expect(await shuffle.anchorBlockHashOf(handId)).to.equal(anchorBlockHash);
    });

    it('reverts before the anchor has enough confirmations', async () => {
      const handId = handIdFor('phase2-early');
      const deckSeed = seedFor(handId);
      const receipt = await (
        await shuffle.connect(stack.operator).commitSeed(handId, commitmentFor(deckSeed, 1n), 1n)
      ).wait();
      const commitBlock = BigInt(receipt!.blockNumber);
      await mineUpTo(commitBlock + 1n);
      const anchor = await hre.ethers.provider.getBlock(Number(commitBlock + 1n));
      const deck = await derivedDeckFromHash(stack, deckSeed, anchor!.hash!);
      const record = commitmentForDeck(handId, deck);
      // The confirmation guard fires before the commitment itself is examined, so no further
      // mining happens here: the anchor exists but is not yet `requiredConfirmations` old. The
      // attempt is mined one block after `mineUpTo`, i.e. at `commitBlock + 2`.
      await expect(shuffle.connect(stack.operator).commitDeck(handId, record.root, record.leaves))
        .to.be.revertedWithCustomError(shuffle, 'InsufficientConfirmations')
        .withArgs(commitBlock + 2n, commitBlock + 1n + confirmations);
    });

    it('reverts outside the reveal window (FR-6.7)', async () => {
      const handId = handIdFor('phase2-late');
      const deckSeed = seedFor(handId);
      const receipt = await (
        await shuffle.connect(stack.operator).commitSeed(handId, commitmentFor(deckSeed, 1n), 1n)
      ).wait();
      const commitBlock = BigInt(receipt!.blockNumber);
      // Build the commitment while the anchor block is still readable (256-block window).
      await mineUpTo(commitBlock + 1n);
      const anchor = await hre.ethers.provider.getBlock(Number(commitBlock + 1n));
      const deck = await derivedDeckFromHash(stack, deckSeed, anchor!.hash!);
      const record = commitmentForDeck(handId, deck);

      await mineUpTo(commitBlock + 257n);
      await expect(shuffle.connect(stack.operator).commitDeck(handId, record.root, record.leaves))
        .to.be.revertedWithCustomError(shuffle, 'OutsideRevealWindow')
        .withArgs(commitBlock, commitBlock + 258n);
    });

    it('rejects a root that is not the root of the supplied leaves', async () => {
      const handId = handIdFor('phase2-badroot');
      const deckSeed = seedFor(handId);
      const { commitmentRecord } = await commitSeedPhase(stack, handId, deckSeed, 1n);
      const wrongRoot = ethers.keccak256(ethers.toUtf8Bytes('not-the-root'));

      await expect(shuffle.connect(stack.operator).commitDeck(handId, wrongRoot, commitmentRecord.leaves))
        .to.be.revertedWithCustomError(shuffle, 'DeckRootMismatch')
        .withArgs(wrongRoot, commitmentRecord.root);
    });

    it('rejects a wrong leaf count and a phase-2 call without phase 1', async () => {
      const handId = handIdFor('phase2-counts');
      const deckSeed = seedFor(handId);
      const { commitmentRecord } = await commitSeedPhase(stack, handId, deckSeed, 1n);
      await expect(
        shuffle.connect(stack.operator).commitDeck(handId, commitmentRecord.root, commitmentRecord.leaves.slice(0, 10)),
      )
        .to.be.revertedWithCustomError(shuffle, 'InvalidLeafCount')
        .withArgs(10);

      await expect(shuffle.connect(stack.operator).commitDeck(handIdFor('no-phase1'), ethers.ZeroHash, []))
        .to.be.revertedWithCustomError(shuffle, 'UnknownHand');
    });

    it('is block-timestamp independent', async () => {
      const { handId, commitmentRecord, deckSeed } = await openHiddenHand('phase2-time');
      await time.increase(3600);
      await mineUpTo((await hre.ethers.provider.getBlockNumber()) + 1);
      expect(await shuffle.deckRootOf(handId)).to.equal(commitmentRecord.root);
      await expect(
        shuffle.connect(stack.operator).audit(handId, deckSeed, commitmentRecord.deck, commitmentRecord.salts),
      ).to.not.be.reverted;
    });
  });

  describe('phase 3 — progressive per-card reveal (FR-6.3)', () => {
    it('publishes exactly one card and leaves the other 51 hidden', async () => {
      const { handId, commitmentRecord } = await openHiddenHand('phase3');
      const index = 7;
      const card = commitmentRecord.deck[index]!;
      const salt = commitmentRecord.salts[index]!;
      const proof = cardProof(commitmentRecord, index);
      expect(proof.length).to.equal(PROOF_LENGTH);

      const receipt = await (await shuffle.connect(stack.operator).revealCard(handId, index, card, salt, proof)).wait();
      const parsed = parseShuffleLog(stack, receipt, 'CardRevealed');
      expect(parsed.args.handId).to.equal(handId);
      expect(parsed.args.deckIndex).to.equal(BigInt(index));
      expect(parsed.args.card).to.equal(BigInt(card));
      expect(parsed.args.leaf).to.equal(leafHash(card, salt));

      expect(await shuffle.revealedCardAt(handId, index)).to.equal(BigInt(card));
      for (const other of [0, 1, 6, 8, 51]) {
        expect(await shuffle.revealedCardAt(handId, other)).to.equal(CARD_HIDDEN);
      }
      expect(await shuffle.isFullyRevealed(handId)).to.equal(false);
      const [, , , , , , , , revealedCount] = await shuffle.handProofOf(handId);
      expect(revealedCount).to.equal(1n);
    });

    it('cannot be tricked into publishing a different card (FR-6.8)', async () => {
      const { handId, commitmentRecord } = await openHiddenHand('phase3-wrong-card');
      const index = 3;
      const realCard = commitmentRecord.deck[index]!;
      const salt = commitmentRecord.salts[index]!;
      const proof = cardProof(commitmentRecord, index);
      const otherCard = (realCard + 1) % 52;

      await expect(shuffle.connect(stack.operator).revealCard(handId, index, otherCard, salt, proof))
        .to.be.revertedWithCustomError(shuffle, 'InvalidMerkleProof')
        .withArgs(index);
      await expect(shuffle.connect(stack.operator).revealCard(handId, index, realCard, ethers.ZeroHash, proof))
        .to.be.revertedWithCustomError(shuffle, 'InvalidMerkleProof');
      await expect(
        shuffle.connect(stack.operator).revealCard(handId, index, realCard, salt, cardProof(commitmentRecord, index + 1)),
      ).to.be.revertedWithCustomError(shuffle, 'InvalidMerkleProof');
      await expect(shuffle.connect(stack.operator).revealCard(handId, index, realCard, salt, proof.slice(0, 2)))
        .to.be.revertedWithCustomError(shuffle, 'InvalidMerkleProof');
    });

    it('rejects a double reveal, an out-of-range index and a non-operator caller', async () => {
      const { handId, commitmentRecord } = await openHiddenHand('phase3-dup');
      const card = commitmentRecord.deck[0]!;
      const salt = commitmentRecord.salts[0]!;
      const proof = cardProof(commitmentRecord, 0);
      await shuffle.connect(stack.operator).revealCard(handId, 0, card, salt, proof);
      await expect(shuffle.connect(stack.operator).revealCard(handId, 0, card, salt, proof))
        .to.be.revertedWithCustomError(shuffle, 'CardAlreadyRevealed')
        .withArgs(0);
      await expect(shuffle.connect(stack.operator).revealCard(handId, 52, card, salt, proof))
        .to.be.revertedWithCustomError(shuffle, 'InvalidDeckIndex')
        .withArgs(52n);
      await expect(shuffle.connect(stack.players[0]).revealCard(handId, 1, card, salt, proof)).to.be.reverted;
      await expect(shuffle.revealedCardAt(handId, 52))
        .to.be.revertedWithCustomError(shuffle, 'InvalidDeckIndex')
        .withArgs(52n);
    });

    it('supports revealing the whole deck card by card, then reporting full reveal', async () => {
      const { handId, commitmentRecord } = await openHiddenHand('phase3-all');
      for (let index = 0; index < 52; index++) {
        await shuffle
          .connect(stack.operator)
          .revealCard(handId, index, commitmentRecord.deck[index]!, commitmentRecord.salts[index]!, cardProof(commitmentRecord, index));
      }
      expect(await shuffle.isFullyRevealed(handId)).to.equal(true);
      for (let index = 0; index < 52; index++) {
        expect(await shuffle.revealedCardAt(handId, index)).to.equal(BigInt(commitmentRecord.deck[index]!));
      }
      const [, , , , , , , , revealedCount] = await shuffle.handProofOf(handId);
      expect(revealedCount).to.equal(52n);
    });

    it('rejects revealCard before phase 2 and after the audit', async () => {
      const handId = handIdFor('phase3-gates');
      const deckSeed = seedFor(handId);
      const { commitmentRecord } = await commitSeedPhase(stack, handId, deckSeed, 1n);
      await expect(
        shuffle.connect(stack.operator).revealCard(handId, 0, 0, commitmentRecord.salts[0]!, cardProof(commitmentRecord, 0)),
      )
        .to.be.revertedWithCustomError(shuffle, 'WrongPhase')
        .withArgs(handId, PHASE.SeedCommitted);

      await commitDeckPhase(stack, handId, commitmentRecord);
      await shuffle.connect(stack.operator).audit(handId, deckSeed, commitmentRecord.deck, commitmentRecord.salts);
      await expect(
        shuffle.connect(stack.operator).revealCard(handId, 0, 0, commitmentRecord.salts[0]!, cardProof(commitmentRecord, 0)),
      )
        .to.be.revertedWithCustomError(shuffle, 'AlreadyAudited')
        .withArgs(handId);
    });
  });

  describe('phase 4 — end-of-hand audit (FR-6.4)', () => {
    it('verifies the commitment and publishes the full proof', async () => {
      const { handId, deckSeed, commitmentRecord, anchorBlockHash } = await openHiddenHand('phase4-ok');
      const anchorBlock = Number(await shuffle.anchorBlockOf(handId));
      const realDeck = await derivedDeck(stack, deckSeed, anchorBlock);

      const receipt = await (
        await shuffle.connect(stack.operator).audit(handId, deckSeed, commitmentRecord.deck, commitmentRecord.salts)
      ).wait();
      const parsed = parseShuffleLog(stack, receipt, 'Audited');

      expect(parsed.args.handId).to.equal(handId);
      expect(parsed.args[1]).to.equal(deckSeed);
      expect(parsed.args.entropy).to.equal(entropyFrom(deckSeed, anchorBlockHash));
      expect(parsed.args.deckRoot).to.equal(commitmentRecord.root);
      expect(Array.from(parsed.args.deck as bigint[], (c) => Number(c))).to.deep.equal(realDeck);

      expect(await shuffle.phaseOf(handId)).to.equal(PHASE.Audited);
      expect(await shuffle.isAudited(handId)).to.equal(true);
      expect(await shuffle.isFullyRevealed(handId)).to.equal(true);
      expect(await shuffle.auditBlockOf(handId)).to.be.greaterThan(0n);

      await expect(shuffle.connect(stack.operator).audit(handId, deckSeed, commitmentRecord.deck, commitmentRecord.salts))
        .to.be.revertedWithCustomError(shuffle, 'WrongPhase')
        .withArgs(handId, PHASE.Audited);
    });

    it('marks the whole deck public only after the audit', async () => {
      const { handId, deckSeed, commitmentRecord } = await openHiddenHand('phase4-public');
      expect(await shuffle.revealedCardAt(handId, 40)).to.equal(CARD_HIDDEN);
      await shuffle.connect(stack.operator).audit(handId, deckSeed, commitmentRecord.deck, commitmentRecord.salts);
      for (const index of [0, 13, 40, 51]) {
        expect(await shuffle.revealedCardAt(handId, index)).to.equal(BigInt(commitmentRecord.deck[index]!));
      }
    });

    it('reverts on a seed that does not open the phase-1 commitment', async () => {
      const { handId, commitmentRecord } = await openHiddenHand('phase4-badseal');
      const wrongSeed = ethers.keccak256(ethers.toUtf8Bytes('wrong-seed'));
      await expect(shuffle.connect(stack.operator).audit(handId, wrongSeed, commitmentRecord.deck, commitmentRecord.salts))
        .to.be.revertedWithCustomError(shuffle, 'SeedMismatch');
      expect(await shuffle.phaseOf(handId)).to.equal(PHASE.DeckCommitted);
    });

    it('rejects a non-permutation deck', async () => {
      const { handId, deckSeed, commitmentRecord } = await openHiddenHand('phase4-perm');
      const cards = [...commitmentRecord.deck];
      cards[0] = cards[1]!;
      await expect(shuffle.connect(stack.operator).audit(handId, deckSeed, cards, commitmentRecord.salts))
        .to.be.revertedWithCustomError(shuffle, 'DeckNotAPermutation');
    });
  });

  describe('confidentiality invariant (FR-6.8) — the point of the patch', () => {
    it('exposes no seed, entropy, ordering or card value while a hand is live', async () => {
      const handId = handIdFor('confidentiality');
      const { commitmentRecord, anchorBlockHash } = await openHiddenHand('confidentiality');

      // (a) No view leaks the ordering: every position reports the hidden sentinel.
      for (let index = 0; index < 52; index++) {
        expect(await shuffle.revealedCardAt(handId, index)).to.equal(CARD_HIDDEN);
      }
      const proof = await shuffle.handProofOf(handId);
      expect(proof.anchorBlockHash).to.equal(anchorBlockHash); // public chain fact, by design
      expect(proof.deckRoot).to.equal(commitmentRecord.root);

      // (b) The ABI offers no "give me the deck/seed" getter at all.
      const functionNames: string[] = shuffle.interface.fragments
        .filter((f: any) => f.type === 'function')
        .map((f: any) => f.name);
      expect(functionNames).to.not.include('deckOf');
      expect(functionNames).to.not.include('entropyOf');
      expect(functionNames).to.not.include('deckRootFromHand');

      // (c) `DeckCommitted` carries the root and the anchor hash, never a card or the seed.
      const otherHand = handIdFor('confidentiality-2');
      const otherSeed = seedFor(otherHand);
      const phase1 = await commitSeedPhase(stack, otherHand, otherSeed, 1n);
      const receipt = await (
        await shuffle.connect(stack.operator).commitDeck(otherHand, phase1.commitmentRecord.root, phase1.commitmentRecord.leaves)
      ).wait();
      const parsed = parseShuffleLog(stack, receipt, 'DeckCommitted');
      expect(parsed.args.deckRoot).to.equal(phase1.commitmentRecord.root);
      expect(Object.keys(parsed.args).some((key) => /card|seed/i.test(key))).to.equal(false);

      // (d) The committed root is not brute-forceable from card values alone: each leaf mixes in a
      //     secret 32-byte salt, so the same card at two positions yields two different hashes.
      const first = leafHash(commitmentRecord.deck[0]!, commitmentRecord.salts[0]!);
      const second = leafHash(commitmentRecord.deck[0]!, commitmentRecord.salts[1]!);
      expect(first).to.not.equal(second);
      expect(commitmentRecord.leaves).to.not.include(leafHash(commitmentRecord.deck[0]!, ethers.ZeroHash));

      // (e) The full deck + salts only materialise at the audit.
      expect(await shuffle.isAudited(handId)).to.equal(false);
    });

    it('gives a partially revealed hand exactly the cards the rules required', async () => {
      const { handId, commitmentRecord } = await openHiddenHand('confidentiality-3');
      // The flop, as the dealing map would publish it.
      for (const index of [3, 4, 5]) {
        await shuffle
          .connect(stack.operator)
          .revealCard(handId, index, commitmentRecord.deck[index]!, commitmentRecord.salts[index]!, cardProof(commitmentRecord, index));
      }
      const [, , , , , , , , revealedCount] = await shuffle.handProofOf(handId);
      expect(revealedCount).to.equal(3n);
      expect(await shuffle.isFullyRevealed(handId)).to.equal(false);
      expect(await shuffle.revealedCardAt(handId, 6)).to.equal(CARD_HIDDEN);
    });
  });

  describe('operator bond, slashing and liveness (FR-6.5, FR-6.7)', () => {
    it('voids and slashes when a rigged root cannot match the seed-derived deck', async () => {
      // A cheating operator commits a *rigged* ordering. Phase 2 cannot detect it (only the root's
      // internal consistency is checkable then) — that is exactly the trust window the bond prices.
      const handId = handIdFor('cheat');
      const deckSeed = seedFor(handId);
      const seedCommitment = commitmentFor(deckSeed, 1n);
      const receipt = await (await shuffle.connect(stack.operator).commitSeed(handId, seedCommitment, 1n)).wait();
      const commitBlock = BigInt(receipt!.blockNumber);
      await mineUpTo(commitBlock + 1n);
      const anchor = await hre.ethers.provider.getBlock(Number(commitBlock + 1n));
      const realDeck = await derivedDeckFromHash(stack, deckSeed, anchor!.hash!);
      const rigged = riggedCommitment(handId, realDeck);
      // Wait out the FR-6.5 confirmations before committing the rigged root.
      await mineUpTo(commitBlock + 1n + confirmations);
      await commitDeckPhase(stack, handId, rigged);

      const bondBefore = await shuffle.bondOf(stack.operatorAddress);
      const poolBefore = await shuffle.slashedBondPool();

      await expect(shuffle.connect(stack.operator).audit(handId, deckSeed, rigged.deck, rigged.salts))
        .to.emit(shuffle, 'AuditFailed')
        .and.to.emit(shuffle, 'Voided');

      expect(await shuffle.phaseOf(handId)).to.equal(PHASE.Voided);
      expect(await shuffle.isAudited(handId)).to.equal(false);
      expect(await shuffle.isDeckCommitted(handId)).to.equal(false);
      expect(bondBefore - (await shuffle.bondOf(stack.operatorAddress))).to.equal(TEST_REQUIRED_BOND);
      expect((await shuffle.slashedBondPool()) - poolBefore).to.equal(TEST_REQUIRED_BOND);
    });

    it('slashes the hand\u2019s operator, never the account that called void (FR-6.5)', async () => {
      const handId = handIdFor('slash-target');
      await shuffle.connect(stack.operator).commitSeed(handId, commitmentFor(seedFor(handId), 1n), 1n);
      await mineUpTo((await hre.ethers.provider.getBlockNumber()) + 300);

      // A player with no bond triggers the void; the operator's bond is what gets taken.
      const playerBondBefore = await shuffle.bondOf(stack.playerAddresses[0]!);
      const operatorBondBefore = await shuffle.bondOf(stack.operatorAddress);
      await shuffle.connect(stack.players[0]).void(handId);

      expect(await shuffle.bondOf(stack.playerAddresses[0]!)).to.equal(playerBondBefore);
      expect(operatorBondBefore - (await shuffle.bondOf(stack.operatorAddress))).to.equal(TEST_REQUIRED_BOND);
      expect(await shuffle.operatorOf(handId)).to.equal(stack.operatorAddress);
    });

    it('voids and slashes when no deck root arrives inside the window (FR-6.7)', async () => {
      const handId = handIdFor('liveness-no-deck');
      const receipt = await (
        await shuffle.connect(stack.operator).commitSeed(handId, commitmentFor(seedFor(handId), 1n), 1n)
      ).wait();
      const commitBlock = BigInt(receipt!.blockNumber);
      const voidableFrom = commitBlock + 257n;
      expect(await shuffle.voidableFromBlockOf(handId)).to.equal(voidableFrom);

      await expect(shuffle.connect(stack.players[0]).void(handId))
        .to.be.revertedWithCustomError(shuffle, 'NotVoidableYet')
        .withArgs(voidableFrom);

      await mineUpTo(voidableFrom);
      await expect(shuffle.connect(stack.players[0]).void(handId))
        .to.emit(shuffle, 'Voided')
        .withArgs(handId, VOID_REASON.NoDeckCommitment, TEST_REQUIRED_BOND, voidableFrom + 1n);

      expect(await shuffle.phaseOf(handId)).to.equal(PHASE.Voided);
      expect(await shuffle.voidableFromBlockOf(handId)).to.equal(ethers.MaxUint256);
      await expect(shuffle.connect(stack.players[0]).void(handId))
        .to.be.revertedWithCustomError(shuffle, 'HandClosed')
        .withArgs(handId);
    });

    it('voids and slashes when a deck root arrives but the audit stalls (FR-6.7)', async () => {
      const { handId } = await openHiddenHand('liveness-stalled');
      const deckRootBlock = await shuffle.deckRootBlockOf(handId);
      const voidableFrom = deckRootBlock + TEST_AUDIT_GRACE_BLOCKS + 1n;
      expect(await shuffle.voidableFromBlockOf(handId)).to.equal(voidableFrom);

      await expect(shuffle.connect(stack.players[1]).void(handId))
        .to.be.revertedWithCustomError(shuffle, 'NotVoidableYet')
        .withArgs(voidableFrom);

      await mineUpTo(voidableFrom);
      await expect(shuffle.connect(stack.players[1]).void(handId))
        .to.emit(shuffle, 'Voided')
        .withArgs(handId, VOID_REASON.AuditStalled, TEST_REQUIRED_BOND, voidableFrom + 1n);
      expect(await shuffle.phaseOf(handId)).to.equal(PHASE.Voided);
    });

    it('never voids or slashes a hand that was audited (FR-6.4)', async () => {
      const { handId, deckSeed, commitmentRecord } = await openHiddenHand('liveness-audited');
      await shuffle.connect(stack.operator).audit(handId, deckSeed, commitmentRecord.deck, commitmentRecord.salts);
      const bond = await shuffle.bondOf(stack.operatorAddress);
      await expect(shuffle.connect(stack.players[0]).void(handId))
        .to.be.revertedWithCustomError(shuffle, 'HandClosed')
        .withArgs(handId);
      expect(await shuffle.bondOf(stack.operatorAddress)).to.equal(bond);
    });

    it('rejects void for an unknown hand', async () => {
      await expect(shuffle.connect(stack.players[0]).void(handIdFor('never-committed')))
        .to.be.revertedWithCustomError(shuffle, 'UnknownHand');
    });

    it('routes slashed proceeds and never lets the slashed party take them', async () => {
      const handId = handIdFor('slash-sweep');
      await shuffle.connect(stack.operator).commitSeed(handId, commitmentFor(seedFor(handId), 1n), 1n);
      await mineUpTo((await hre.ethers.provider.getBlockNumber()) + 300);
      await shuffle.connect(stack.players[0]).void(handId);
      const pool = await shuffle.slashedBondPool();
      expect(pool).to.equal(TEST_REQUIRED_BOND);

      await expect(shuffle.connect(stack.players[0]).sweepSlashed(stack.playerAddresses[0]!, pool))
        .to.be.revertedWithCustomError(shuffle, 'AccessControlUnauthorizedAccount');
      await expect(shuffle.connect(stack.owner).sweepSlashed(ethers.ZeroAddress, pool))
        .to.be.revertedWithCustomError(shuffle, 'ZeroAddress');
      await expect(shuffle.connect(stack.owner).sweepSlashed(stack.playerAddresses[0]!, pool + 1n))
        .to.be.revertedWithCustomError(shuffle, 'NothingSlashed');

      const before = await stack.token.balanceOf(stack.vaultAddress);
      await expect(shuffle.connect(stack.owner).sweepSlashed(stack.vaultAddress, pool))
        .to.emit(shuffle, 'SlashedBondSwept')
        .withArgs(stack.vaultAddress, pool);
      expect((await stack.token.balanceOf(stack.vaultAddress)) - before).to.equal(pool);
      expect(await shuffle.slashedBondPool()).to.equal(0n);
    });

    it('takes only the bond that exists when the requirement is lifted', async () => {
      await shuffle.connect(stack.owner).setRequiredBond(0n);
      await expect(shuffle.connect(stack.operator).postBond(0n)).to.be.revertedWithCustomError(shuffle, 'ZeroAddress');

      const handId = handIdFor('zero-bond');
      await shuffle.connect(stack.operator).commitSeed(handId, commitmentFor(seedFor(handId), 1n), 1n);
      await mineUpTo((await hre.ethers.provider.getBlockNumber()) + 300);
      const poolBefore = await shuffle.slashedBondPool();
      await shuffle.connect(stack.players[0]).void(handId);
      // The operator's bond is zero by now, so nothing more can be taken.
      expect(await shuffle.slashedBondPool()).to.equal(poolBefore);
    });
  });

  describe('administration bounds (FR-6.5, FR-6.7, FR-9.7)', () => {
    it('defaults to 12 confirmations, a 256-block window and a bounded grace period', async () => {
      const defaulted = await snapshotFixture(12n);
      expect(await defaulted.stack.shuffle.requiredConfirmations()).to.equal(12n);
      expect(await defaulted.stack.shuffle.REVEAL_WINDOW_BLOCKS()).to.equal(256n);
      expect(await defaulted.stack.shuffle.MAX_REQUIRED_CONFIRMATIONS()).to.be.lessThan(256n);
    });

    it('rejects out-of-range constructor values', async () => {
      const [owner] = await hre.ethers.getSigners();
      if (!owner) throw new Error('no signer');
      const factory = await hre.ethers.getContractFactory('Shuffle', owner);
      const ownerAddress = await owner.getAddress();
      await expect(factory.deploy(stack.tokenAddress, ownerAddress, 0n, TEST_AUDIT_GRACE_BLOCKS, 0n))
        .to.be.revertedWithCustomError(factory, 'InvalidRequiredConfirmations');
      await expect(factory.deploy(stack.tokenAddress, ownerAddress, 129n, TEST_AUDIT_GRACE_BLOCKS, 0n))
        .to.be.revertedWithCustomError(factory, 'InvalidRequiredConfirmations');
      await expect(factory.deploy(stack.tokenAddress, ownerAddress, 12n, 1n, 0n))
        .to.be.revertedWithCustomError(factory, 'InvalidAuditGrace');
      await expect(factory.deploy(stack.tokenAddress, ownerAddress, 12n, 100_001n, 0n))
        .to.be.revertedWithCustomError(factory, 'InvalidAuditGrace');
      await expect(factory.deploy(ethers.ZeroAddress, ownerAddress, 12n, 64n, 0n))
        .to.be.revertedWithCustomError(factory, 'ZeroAddress');
    });

    it('lets the owner retune confirmations, audit grace and bond, within bounds only', async () => {
      await expect(shuffle.connect(stack.owner).setRequiredConfirmations(24n))
        .to.emit(shuffle, 'RequiredConfirmationsUpdated')
        .withArgs(2n, 24n);
      await expect(shuffle.connect(stack.owner).setRequiredConfirmations(0n)).to.be.revertedWithCustomError(
        shuffle,
        'InvalidRequiredConfirmations',
      );
      await expect(shuffle.connect(stack.owner).setAuditGraceBlocks(200n))
        .to.emit(shuffle, 'AuditGraceUpdated')
        .withArgs(TEST_AUDIT_GRACE_BLOCKS, 200n);
      await expect(shuffle.connect(stack.owner).setAuditGraceBlocks(1n)).to.be.revertedWithCustomError(
        shuffle,
        'InvalidAuditGrace',
      );
      await expect(shuffle.connect(stack.owner).setRequiredBond(ethers.parseEther('5')))
        .to.emit(shuffle, 'RequiredBondUpdated')
        .withArgs(TEST_REQUIRED_BOND, ethers.parseEther('5'));

      for (const call of [
        shuffle.connect(stack.players[0]).setRequiredConfirmations(24n),
        shuffle.connect(stack.players[0]).setAuditGraceBlocks(200n),
        shuffle.connect(stack.players[0]).setRequiredBond(1n),
      ]) {
        await expect(call).to.be.revertedWithCustomError(shuffle, 'AccessControlUnauthorizedAccount');
      }
    });
  });

  it('keeps independent hands independent (no cross-hand contamination)', async () => {
    const first = handIdFor('independence-a');
    const second = handIdFor('independence-b');
    const seedA = seedFor(first);
    const seedB = seedFor(second);

    const a = await commitSeedPhase(stack, first, seedA, 1n);
    const b = await commitSeedPhase(stack, second, seedB, 2n);
    const committedA = await commitDeckPhase(stack, first, a.commitmentRecord);
    const committedB = await commitDeckPhase(stack, second, b.commitmentRecord);

    expect(committedA.deckRoot).to.not.equal(committedB.deckRoot);
    expect(a.deck).to.not.deep.equal(b.deck);

    await shuffle.connect(stack.operator).audit(first, seedA, a.commitmentRecord.deck, a.commitmentRecord.salts);
    expect(await shuffle.isAudited(first)).to.equal(true);
    expect(await shuffle.isAudited(second)).to.equal(false);
    expect(await shuffle.phaseOf(second)).to.equal(PHASE.DeckCommitted);
  });
});
