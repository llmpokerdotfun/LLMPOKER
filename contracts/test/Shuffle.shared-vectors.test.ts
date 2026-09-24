/**
 * Committed Merkle-vector conformance (FR-6.2, FR-6.3).
 *
 * `packages/shared/vectors/merkle-vectors.json` is generated from the
 * *production* TypeScript implementation (`packages/shared/src/merkle.ts`), which
 * is the code the engine and the CLI verifier actually use. This suite requires
 * `Shuffle.sol` to reproduce those leaves, roots and inclusion proofs exactly,
 * so the engine can never build a root the contract would reject.
 *
 * The `orderSensitivity` pair is the important one: two decks with the same
 * multiset of cards in a different sequence must produce different roots. A
 * sorted-pair interior rule would make them equal, i.e. commit to the deck's
 * *set* rather than its *sequence* — a silent, total loss of fairness.
 */

import { expect } from 'chai';
import hre from 'hardhat';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface MerkleVector {
  name: string;
  note: string;
  deckSeed: string;
  anchorBlockHash: string;
  entropy: string;
  deck: number[];
  salts: string[];
  leaves: string[];
  root: string;
  proofs: Record<string, string[]>;
}

interface OrderSensitivity {
  note: string;
  deckA: number[];
  saltsA: string[];
  rootA: string;
  deckB: number[];
  saltsB: string[];
  rootB: string;
}

const VECTORS_PATH = join(__dirname, '..', '..', 'packages', 'shared', 'vectors', 'merkle-vectors.json');
const file = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as {
  vectors: MerkleVector[];
  orderSensitivity: OrderSensitivity;
  encoding: Record<string, string>;
};

describe('Shuffle — committed Merkle vectors (FR-6.2, FR-6.3)', () => {
  let shuffle: any;

  before(async () => {
    const [owner] = await hre.ethers.getSigners();
    if (!owner) throw new Error('no signer');
    // The vectors only exercise the pure Merkle surface, so the bond token is a
    // throwaway deployment and no bond is ever posted.
    const tokenFactory = await hre.ethers.getContractFactory('Token', owner);
    const token = await tokenFactory.deploy(
      'LLM Poker',
      'LLMP',
      hre.ethers.parseEther('1000000'),
      await owner.getAddress(),
      0n,
    );
    await token.waitForDeployment();

    const factory = await hre.ethers.getContractFactory('Shuffle', owner);
    shuffle = await factory.deploy(await token.getAddress(), await owner.getAddress(), 12n, 7200n, 0n);
    await shuffle.waitForDeployment();
  });

  it('loads the committed vector file', () => {
    expect(file.vectors.length).to.be.greaterThan(0);
    expect(Number(file.encoding.proofLength)).to.equal(6);
  });

  for (const vector of file.vectors) {
    describe(vector.name, () => {
      it('reproduces every leaf hash', async () => {
        for (let i = 0; i < vector.deck.length; i++) {
          const leaf = await shuffle.leafHash(vector.deck[i], vector.salts[i]);
          expect(leaf, `leaf ${i}`).to.equal(vector.leaves[i]);
        }
      });

      it('reproduces the committed deck root from the leaves', async () => {
        expect(await shuffle.merkleRootOf(vector.leaves)).to.equal(vector.root);
      });

      it('reproduces leafHash independently of merkleRootOf (the contract is self-consistent)', async () => {
        // Rebuilding the root from the contract's own leafHash output must match too.
        const leaves: string[] = [];
        for (let i = 0; i < vector.deck.length; i++) {
          leaves.push(await shuffle.leafHash(vector.deck[i], vector.salts[i]));
        }
        expect(await shuffle.merkleRootOf(leaves)).to.equal(vector.root);
      });

      it('reproduces the whole entropy -> deck -> leaves -> root pipeline', async () => {
        const deck = (await shuffle.computeDeck(vector.entropy)) as bigint[];
        expect(deck.map((c) => Number(c))).to.deep.equal(vector.deck);
        expect(await shuffle.deckRootFromEntropy(vector.entropy, vector.salts)).to.equal(vector.root);
      });

      it('accepts every committed inclusion proof and rejects a tampered one', async () => {
        for (const [index, proof] of Object.entries(vector.proofs)) {
          const position = Number(index);
          const card = vector.deck[position]!;
          expect(
            await shuffle.verifyCardProof(vector.root, position, card, vector.salts[position], proof),
            `proof for index ${position}`,
          ).to.equal(true);

          // A different card at the same position must not verify.
          const wrongCard = (card + 1) % 52;
          expect(
            await shuffle.verifyCardProof(vector.root, position, wrongCard, vector.salts[position], proof),
            `tampered card at index ${position}`,
          ).to.equal(false);

          // Neither must a proof presented at the wrong position.
          const otherIndex = (position + 1) % 52;
          expect(
            await shuffle.verifyCardProof(vector.root, otherIndex, card, vector.salts[position], proof),
            `moved proof from index ${position}`,
          ).to.equal(false);
        }
      });
    });
  }

  describe('order sensitivity (the set-vs-sequence trap)', () => {
    it('gives different roots for the same cards in a different sequence', async () => {
      expect(file.orderSensitivity.rootA).to.not.equal(file.orderSensitivity.rootB);

      const leavesA: string[] = [];
      for (let i = 0; i < file.orderSensitivity.deckA.length; i++) {
        leavesA.push(await shuffle.leafHash(file.orderSensitivity.deckA[i], file.orderSensitivity.saltsA[i]));
      }
      const rootA = await shuffle.merkleRootOf(leavesA);
      expect(rootA).to.equal(file.orderSensitivity.rootA);

      const leavesB: string[] = [];
      for (let i = 0; i < file.orderSensitivity.deckB.length; i++) {
        leavesB.push(await shuffle.leafHash(file.orderSensitivity.deckB[i], file.orderSensitivity.saltsB[i]));
      }
      const rootB = await shuffle.merkleRootOf(leavesB);
      expect(rootB).to.equal(file.orderSensitivity.rootB);
      expect(rootB).to.not.equal(rootA);

      // The two decks really are the same multiset: only the sequence differs.
      expect([...file.orderSensitivity.deckA].sort((a, b) => a - b)).to.deep.equal(
        [...file.orderSensitivity.deckB].sort((a, b) => a - b),
      );
    });
  });
});
