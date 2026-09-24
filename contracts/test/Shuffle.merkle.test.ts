/**
 * Merkle commitment parity (FR-6.2, FR-6.3, FR-6.4).
 *
 * This is the Merkle analogue of the RNG vector gate: `test/support/merkle.ts` is an independent
 * TypeScript implementation written from `SRS.md`, and these tests require it to agree byte for
 * byte with `Shuffle.sol` — the root of a whole tree, the validity of every leaf's proof, and the
 * end-to-end `entropy → Fisher–Yates → salted leaves → root` pipeline that `audit` re-checks.
 *
 * If they diverge, the off-chain engine would build roots the contract rejects, so a failure here
 * must be fixed in the implementation, never papered over in the test.
 */

import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';
import { mineUpTo } from '@nomicfoundation/hardhat-network-helpers';

import {
  PHASE,
  commitDeckPhase,
  derivedDeckFromHash,
  handIdFor,
  seedFor,
  snapshotFixture,
  type PokerStack,
  type SnapshotFixture,
} from './support/helpers';
import {
  DECK_SIZE,
  PROOF_LENGTH,
  TREE_SIZE,
  ZERO_LEAF,
  buildTree,
  cardProof,
  commitmentForDeck,
  hashPair,
  leafHash,
  merkleProof,
  merkleRoot,
  saltFor,
  verifyMerkleProof,
} from './support/merkle';

describe('Merkle commitment parity (FR-6.2, FR-6.3, FR-6.4)', () => {
  let fixture: SnapshotFixture;
  let stack: PokerStack;
  let shuffle: any;

  before(async () => {
    fixture = await snapshotFixture(2n);
    stack = fixture.stack;
    shuffle = stack.shuffle;
  });

  beforeEach(async () => {
    await fixture.reset();
  });

  function leavesFor(label: string): string[] {
    const handId = handIdFor(label);
    return Array.from({ length: DECK_SIZE }, (_, i) => leafHash(i % 52, saltFor(handId, i)));
  }

  /** Commit phase 1, wait out the confirmations, and return the anchor hash the operator must use. */
  async function commitSeedFor(label: string, nonce = 1n) {
    const handId = handIdFor(label);
    const deckSeed = seedFor(handId);
    const seedCommitment = ethers.keccak256(ethers.solidityPacked(['bytes32', 'uint256'], [deckSeed, nonce]));
    const receipt = await (await shuffle.connect(stack.operator).commitSeed(handId, seedCommitment, nonce)).wait();
    const commitBlock = receipt!.blockNumber;
    await mineUpTo(BigInt(commitBlock) + 1n);
    const anchorBlock = await hre.ethers.provider.getBlock(commitBlock + 1);
    if (!anchorBlock?.hash) throw new Error('anchor block is not readable');
    return { handId, deckSeed, commitBlock, anchorBlockHash: anchorBlock.hash };
  }

  describe('leaf encoding', () => {
    it('matches abi.encodePacked(uint8 card, bytes32 salt)', async () => {
      for (const card of [0, 1, 25, 51]) {
        const salt = saltFor(handIdFor('leaf'), card);
        expect(await shuffle.leafHash(card, salt)).to.equal(leafHash(card, salt));
      }
    });

    it('salts every position, so identical cards hash differently', async () => {
      const saltA = saltFor(handIdFor('salt'), 0);
      const saltB = saltFor(handIdFor('salt'), 1);
      expect(saltA).to.not.equal(saltB);
      expect(leafHash(7, saltA)).to.not.equal(leafHash(7, saltB));
    });
  });

  describe('interior node rule', () => {
    it('is order preserving: sibling order changes the parent', async () => {
      const a = leafHash(1, saltFor(handIdFor('pair'), 0));
      const b = leafHash(2, saltFor(handIdFor('pair'), 1));
      expect(hashPair(a, b)).to.not.equal(hashPair(b, a));
      expect(hashPair(a, b)).to.equal(
        ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32'], [a, b])),
      );
    });

    it('cannot have a leaf replayed as an interior node (different input widths)', async () => {
      const a = leafHash(3, saltFor(handIdFor('preimage'), 0));
      const b = leafHash(4, saltFor(handIdFor('preimage'), 1));
      const parent = hashPair(a, b);
      expect(parent).to.not.equal(a);
      expect(parent).to.not.equal(b);
      // A leaf hashes exactly 33 packed bytes; an interior node hashes 64 abi-encoded bytes. Two
      // bytes32 values are already 32 bytes each, so the width difference is what makes the
      // domains disjoint — a leaf preimage can never be 64 bytes.
      expect(ethers.dataLength(ethers.solidityPacked(['uint8', 'bytes32'], [3, a]))).to.equal(33);
      expect(ethers.dataLength(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32'], [a, b]))).to.equal(
        64,
      );
    });
  });

  describe('merkleRootOf', () => {
    it('agrees with the TypeScript implementation for a full 52-leaf deck', async () => {
      const leaves = leavesFor('root-52');
      expect(await shuffle.merkleRootOf(leaves)).to.equal(merkleRoot(leaves));
      expect(merkleRoot(leaves)).to.equal(buildTree(leaves).at(-1)![0]);
    });

    it('agrees for arbitrary leaf counts (padded to 64)', async () => {
      for (const count of [1, 2, 3, 8, 13, 32, 51, 52, 63, 64]) {
        const leaves = leavesFor(`root-${count}`).slice(0, count);
        expect(await shuffle.merkleRootOf(leaves), `leaf count ${count}`).to.equal(merkleRoot(leaves));
      }
    });

    it('agrees on an empty/degenerate leaf set (pure padding)', async () => {
      const zeros = Array.from({ length: DECK_SIZE }, () => ethers.ZeroHash);
      expect(await shuffle.merkleRootOf(zeros)).to.equal(merkleRoot(zeros));
      expect(await shuffle.merkleRootOf([])).to.equal(merkleRoot([]));
      expect(merkleRoot([])).to.equal(buildTree([]).at(-1)![0]);
      void ZERO_LEAF;
      void TREE_SIZE;
    });

    it('is order-sensitive: a different ordering gives a different root', async () => {
      const leaves = leavesFor('root-order');
      // Swapping within a leaf pair is invisible to a hash of the *sorted* pair (that is the
      // point of sorting two adjacent leaves), so the adversarial case is a real reordering.
      const reordered = [...leaves.slice().reverse()];
      expect(merkleRoot(reordered)).to.not.equal(merkleRoot(leaves));
      expect(await shuffle.merkleRootOf(reordered)).to.equal(merkleRoot(reordered));
      expect(await shuffle.merkleRootOf(reordered)).to.not.equal(await shuffle.merkleRootOf(leaves));

      // Shuffling the leaves of a *different* branch (indices 4 and 5) does change the root.
      const localSwap = [...leaves];
      [localSwap[4], localSwap[5]] = [localSwap[5]!, localSwap[4]!];
      expect(merkleRoot(localSwap)).to.not.equal(merkleRoot(leaves));
      expect(await shuffle.merkleRootOf(localSwap)).to.equal(merkleRoot(localSwap));
    });
  });

  describe('per-card proofs (FR-6.3)', () => {
    it('produces proofs the contract accepts, and rejects the corresponding forgeries', async () => {
      const { handId, deckSeed, anchorBlockHash } = await commitSeedFor('proofs');
      const deck = await derivedDeckFromHash(stack, deckSeed, anchorBlockHash);
      const commitment = commitmentForDeck(handId, deck);
      await mineUpTo((await hre.ethers.provider.getBlockNumber()) + 2);
      await commitDeckPhase(stack, handId, commitment);

      const index = 17;
      const card = commitment.deck[index]!;
      const salt = commitment.salts[index]!;
      const proof = cardProof(commitment, index);
      expect(proof.length).to.equal(PROOF_LENGTH);

      // A valid reveal is accepted, and both implementations agree it is valid.
      expect(verifyMerkleProof(commitment.root, leafHash(card, salt), index, proof)).to.equal(true);
      await expect(shuffle.connect(stack.operator).revealCard(handId, index, card, salt, proof)).to.not.be.reverted;
      expect(await shuffle.revealedCardAt(handId, index)).to.equal(BigInt(card));

      // Forgeries: each case is rejected by the TypeScript verifier *and* by the contract.
      const wrongCard = (card + 1) % 52;
      const forgeries: Array<[string, number, string, string[]]> = [
        ['wrong card', wrongCard, salt, proof],
        ['wrong salt', card, ethers.ZeroHash, proof],
        ['proof from another position', card, salt, cardProof(commitment, index + 1)],
        ['truncated proof', card, salt, proof.slice(0, 3)],
        ['proof with an extra level', card, salt, [...proof, ethers.ZeroHash]],
        ['all-zero proof', card, salt, proof.map(() => ethers.ZeroHash)],
      ];
      for (const [label, candidateCard, candidateSalt, candidateProof] of forgeries) {
        const leaf = leafHash(candidateCard, candidateSalt);
        expect(verifyMerkleProof(commitment.root, leaf, index, candidateProof), `${label}: TS rejects`).to.equal(
          false,
        );
        await expect(
          shuffle.connect(stack.operator).revealCard(handId, index + 1, candidateCard, candidateSalt, candidateProof),
          `${label}: contract rejects`,
        ).to.be.reverted;
      }
      // The genuine position is still unrevealed after all those failures.
      expect(await shuffle.revealedCardAt(handId, index + 1)).to.equal(255n);
    });

    it('verifies a proof for every one of the 52 positions in TypeScript', async () => {
      const handId = handIdFor('proofs-all');
      const deck = await derivedDeckFromHash(stack, seedFor(handId), ethers.keccak256(ethers.toUtf8Bytes('anchor')));
      const commitment = commitmentForDeck(handId, deck);
      for (let index = 0; index < DECK_SIZE; index++) {
        const proof = merkleProof(commitment.leaves, index);
        expect(proof.length).to.equal(PROOF_LENGTH);
        expect(verifyMerkleProof(commitment.root, commitment.leaves[index]!, index, proof)).to.equal(true);
        // A proof generated for another position must not verify this leaf. Adjacent indices can
        // share a direction pattern, so the adversarial case uses a far-away position.
        const other = (index + 31) % DECK_SIZE;
        const otherProof = merkleProof(commitment.leaves, other);
        expect(verifyMerkleProof(commitment.root, commitment.leaves[index]!, index, otherProof)).to.equal(false);
      }
    });
  });

  describe('end-to-end pipeline (FR-6.4)', () => {
    it('deckRootFromEntropy matches the TypeScript root for the same entropy and salts', async () => {
      const handId = handIdFor('pipeline');
      const anchorBlockHash = ethers.keccak256(ethers.toUtf8Bytes('pipeline-anchor'));
      const deck = await derivedDeckFromHash(stack, seedFor(handId), anchorBlockHash);
      const commitment = commitmentForDeck(handId, deck);
      const entropy = ethers.keccak256(
        ethers.solidityPacked(['bytes32', 'bytes32'], [seedFor(handId), anchorBlockHash]),
      );

      expect(await shuffle.deckRootFromEntropy(entropy, commitment.salts)).to.equal(commitment.root);
      expect(await shuffle.deckRootFromEntropy(entropy, commitment.salts)).to.equal(merkleRoot(commitment.leaves));
    });

    it('a committed root derived from the real anchor hash audits cleanly', async () => {
      const { handId, deckSeed, anchorBlockHash } = await commitSeedFor('pipeline-anchor');
      const deck = await derivedDeckFromHash(stack, deckSeed, anchorBlockHash);
      const commitment = commitmentForDeck(handId, deck);

      await mineUpTo((await hre.ethers.provider.getBlockNumber()) + 2);
      const committed = await commitDeckPhase(stack, handId, commitment);
      expect(committed.anchorBlockHash).to.equal(anchorBlockHash);
      expect(committed.deckRoot).to.equal(merkleRoot(commitment.leaves));
      expect(await shuffle.phaseOf(handId)).to.equal(PHASE.DeckCommitted);

      // The audit accepting is the strongest statement that all three implementations agree:
      // Solidity shuffle, Solidity Merkle and the independent TypeScript Merkle.
      await expect(shuffle.connect(stack.operator).audit(handId, deckSeed, commitment.deck, commitment.salts)).to.not
        .be.reverted;
      expect(await shuffle.phaseOf(handId)).to.equal(PHASE.Audited);
      expect(await shuffle.isFullyRevealed(handId)).to.equal(true);
    });
  });
});
