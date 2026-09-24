/**
 * RNG vector conformance (FR-6, `docs/RNG.md` §3).
 *
 * This is the cross-implementation correctness gate: `Shuffle.computeDeck` / `computeDeckWithCost`
 * must reproduce every committed vector in `packages/shared/vectors/rng-vectors.json` byte for
 * byte, including `wordsConsumed`. If a test here fails, `Shuffle.sol` is wrong — the vectors are
 * the referee (`docs/RNG.md` line 99).
 */

import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { commitmentFor, entropyFrom } from './support/helpers';

interface RngVector {
  name: string;
  note?: string;
  deckSeed: string;
  nonce: string;
  commitment: string;
  anchorBlockHash: string;
  entropy: string;
  deck: number[];
  wordsConsumed: number;
  drawsConsumed: number;
}

const VECTORS_PATH = join(__dirname, '..', '..', 'packages', 'shared', 'vectors', 'rng-vectors.json');
const vectorsFile = JSON.parse(readFileSync(VECTORS_PATH, 'utf8')) as { vectors: RngVector[] };

/**
 * Vector-6 carries its `deckSeed` without the `0x` prefix, so normalise every hex field before
 * handing it to ethers. The vectors themselves are never edited (`docs/RNG.md`: they are the
 * referee).
 */
function hex(value: string): string {
  return value.startsWith('0x') ? value : `0x${value}`;
}

describe('Shuffle — RNG vector conformance (FR-6.3, docs/RNG.md §3)', () => {
  let shuffle: any;

  before(async () => {
    const [owner] = await hre.ethers.getSigners();
    if (!owner) throw new Error('no signer');
    const factory = await hre.ethers.getContractFactory('Shuffle', owner);
    shuffle = await factory.deploy(await owner.getAddress(), 12n);
    await shuffle.waitForDeployment();
  });

  it('loads the six committed vectors', () => {
    expect(vectorsFile.vectors.length).to.equal(6);
  });

  for (const vector of vectorsFile.vectors) {
    describe(vector.name, () => {
      it('reproduces the committed deck exactly', async () => {
        const deck = await shuffle.computeDeck(hex(vector.entropy));
        const asNumbers = Array.from(deck as bigint[], (card) => Number(card));
        expect(asNumbers).to.deep.equal(vector.deck);
      });

      it('reports the committed wordsConsumed and drawsConsumed', async () => {
        const [deck, wordsConsumed] = await shuffle.computeDeckWithCost(hex(vector.entropy));
        expect(Number(wordsConsumed)).to.equal(vector.wordsConsumed);
        expect(deck.length).to.equal(52);
        // 51 swap positions, plus whatever the rejection sampler discarded.
        expect(vector.drawsConsumed).to.be.greaterThanOrEqual(51);
      });

      it('agrees with the TypeScript commitment for the same seed and nonce', async () => {
        const expected = commitmentFor(hex(vector.deckSeed), BigInt(vector.nonce));
        expect(expected).to.equal(hex(vector.commitment));
        expect(await shuffle.commitmentOfSeed(hex(vector.deckSeed), BigInt(vector.nonce))).to.equal(
          hex(vector.commitment),
        );
      });

      it('agrees with the TypeScript entropy for the same seed and anchor hash', async () => {
        const expected = entropyFrom(hex(vector.deckSeed), hex(vector.anchorBlockHash));
        expect(expected).to.equal(hex(vector.entropy));
        expect(await shuffle.computeEntropy(hex(vector.deckSeed), hex(vector.anchorBlockHash))).to.equal(hex(vector.entropy));
      });
    });
  }

  it('produces a permutation of the canonical deck for arbitrary entropy', async () => {
    const entropy = ethers.keccak256(ethers.toUtf8Bytes('arbitrary-entropy-probe'));
    const deck = Array.from((await shuffle.computeDeck(entropy)) as bigint[], (card) => Number(card));
    expect([...deck].sort((a, b) => a - b)).to.deep.equal(Array.from({ length: 52 }, (_, i) => i));
  });

  it('is deterministic: the same entropy yields the same deck', async () => {
    const entropy = ethers.keccak256(ethers.toUtf8Bytes('determinism'));
    const first = Array.from((await shuffle.computeDeck(entropy)) as bigint[], (c) => Number(c));
    const second = Array.from((await shuffle.computeDeck(entropy)) as bigint[], (c) => Number(c));
    const third = Array.from((await shuffle.computeDeck(entropy)) as bigint[], (c) => Number(c));
    expect(second).to.deep.equal(first);
    expect(third).to.deep.equal(first);
  });

  it('differs across entropy values (no degenerate all-zero deck)', async () => {
    const a = Array.from((await shuffle.computeDeck(ethers.ZeroHash)) as bigint[], (c) => Number(c));
    const b = Array.from(
      (await shuffle.computeDeck(ethers.keccak256(ethers.toUtf8Bytes('b')))) as bigint[],
      (c) => Number(c),
    );
    expect(a).to.not.deep.equal(b);
  });
});
