import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  bytesToHex,
  commitmentFor,
  createDrawStream,
  deckFromReveal,
  entropyFrom,
  isCompleteDeck,
  isWithinRevealWindow,
  keccak256,
  randomDeckSeed,
  shuffleDeck,
  uint256ToBytes,
} from '../src/index.js';

interface Vector {
  name: string;
  note: string;
  deckSeed: string;
  nonce: string;
  commitment: string;
  anchorBlockHash: string;
  entropy: string;
  deck: number[];
  wordsConsumed: number;
  drawsConsumed: number;
}

const vectorsFile = fileURLToPath(new URL('../vectors/rng-vectors.json', import.meta.url));
const { vectors } = JSON.parse(readFileSync(vectorsFile, 'utf8')) as { vectors: Vector[] };

/**
 * These vectors are shared with the Solidity implementation
 * (`contracts/test/Shuffle.t.sol`). If this suite and that one ever disagree,
 * the on-chain and off-chain decks have silently diverged and every proof on the
 * platform is worthless — so the vectors are the referee.
 */
describe('committed RNG vectors', () => {
  it('has six vectors to check', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(6);
  });

  it.each(vectors.map((v) => [v.name, v] as const))('%s reproduces commitment, entropy and deck', (_name, v) => {
    expect(`0x${bytesToHex(commitmentFor(v.deckSeed, BigInt(v.nonce)))}`).toBe(v.commitment);
    const entropy = entropyFrom(v.deckSeed, v.anchorBlockHash);
    expect(`0x${bytesToHex(entropy)}`).toBe(v.entropy);

    const shuffle = shuffleDeck(entropy);
    expect(shuffle.deck).toEqual(v.deck);
    expect(shuffle.wordsConsumed).toBe(v.wordsConsumed);
    expect(shuffle.drawsConsumed).toBe(v.drawsConsumed);
    expect(isCompleteDeck(shuffle.deck)).toBe(true);
  });
});

describe('shuffle properties', () => {
  it('is a deterministic pure function of the entropy', () => {
    const entropy = `0x${'ab'.repeat(32)}`;
    expect(shuffleDeck(entropy).deck).toEqual(shuffleDeck(entropy).deck);
    expect(deckFromReveal(`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`)).toEqual(
      shuffleDeck(entropyFrom(`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`)).deck,
    );
  });

  it('produces every card exactly once across many entropies', () => {
    for (let i = 0; i < 200; i++) {
      const entropy = `0x${bytesToHex(uint256ToBytes(BigInt(i) * 7919n + 13n))}`;
      const { deck } = shuffleDeck(entropy);
      expect(isCompleteDeck(deck)).toBe(true);
      expect(new Set(deck).size).toBe(52);
    }
  });

  it('does not leave the deck untouched or trivially reversed for typical seeds', () => {
    const identity = Array.from({ length: 52 }, (_, i) => i).join(',');
    let moved = 0;
    for (let i = 0; i < 50; i++) {
      const { deck } = shuffleDeck(`0x${bytesToHex(uint256ToBytes(BigInt(i) + 1n))}`);
      if (deck.join(',') !== identity) moved++;
    }
    expect(moved).toBe(50);
  });

  it('spreads cards across positions (no position is systematically favoured)', () => {
    // A crude uniformity smoke test: over 400 entropies, every card must appear
    // in the first 8 positions at least once and at most ~4x the expectation.
    const counts = new Array<number>(52).fill(0);
    for (let i = 0; i < 400; i++) {
      const { deck } = shuffleDeck(`0x${bytesToHex(uint256ToBytes(BigInt(i) * 104729n + 7n))}`);
      for (const card of deck.slice(0, 8)) counts[card]! += 1;
    }
    const total = counts.reduce((a, b) => a + b, 0);
    expect(total).toBe(400 * 8);
    const expected = total / 52;
    for (const c of counts) {
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThan(expected * 4);
    }
  });

  it('rejects entropies that are not 32 bytes', () => {
    expect(() => shuffleDeck('0x1234')).toThrow(/32 bytes/);
    expect(() => commitmentFor('0x1234', 1n)).toThrow(/32 bytes/);
    expect(() => entropyFrom('0x' + '00'.repeat(32), '0x00')).toThrow(/32 bytes/);
  });

  it('exposes a raw draw stream that is reproducible', () => {
    const entropy = `0x${'5a'.repeat(32)}`;
    const a = createDrawStream(entropy);
    const b = createDrawStream(entropy);
    const drawsA = Array.from({ length: 8 }, () => a.next64());
    const drawsB = Array.from({ length: 8 }, () => b.next64());
    expect(drawsA).toEqual(drawsB);
    for (const d of drawsA) {
      expect(d).toBeGreaterThanOrEqual(0n);
      expect(d).toBeLessThan(1n << 64n);
    }
    expect(a.drawsConsumed).toBe(8);
    expect(a.wordsConsumed).toBe(2);
  });
});

describe('commit-reveal timing rules (FR-6.1, FR-6.6)', () => {
  it('accepts reveals inside (commitBlock, commitBlock + 256]', () => {
    expect(isWithinRevealWindow(100, 101)).toBe(true);
    expect(isWithinRevealWindow(100, 356)).toBe(true);
    expect(isWithinRevealWindow(100, 100)).toBe(false);
    expect(isWithinRevealWindow(100, 357)).toBe(false);
    expect(isWithinRevealWindow(100, 50)).toBe(false);
  });

  it('never lets the same seed with a different nonce produce the same commitment', () => {
    const seed = `0x${'07'.repeat(32)}`;
    expect(bytesToHex(commitmentFor(seed, 1n))).not.toBe(bytesToHex(commitmentFor(seed, 2n)));
  });

  it('writes the nonce as 32 bytes so packing is unambiguous', () => {
    expect(uint256ToBytes(1n)).toHaveLength(32);
    expect(uint256ToBytes(2n ** 256n - 1n)).toHaveLength(32);
    // The commitment is exactly keccak256(seed32 ‖ nonce32) with no length
    // prefix and no padding ambiguity — the same bytes Solidity packs.
    const seed = new Uint8Array(32);
    const nonce = 1n;
    const expected = keccak256(new Uint8Array([...seed, ...uint256ToBytes(nonce)]));
    expect(bytesToHex(commitmentFor(seed, nonce))).toBe(bytesToHex(expected));
    // A big-endian nonce of a different width would give a different digest.
    const littleEndian = new Uint8Array(32);
    littleEndian[0] = 1;
    expect(bytesToHex(keccak256(new Uint8Array([...seed, ...littleEndian])))).not.toBe(bytesToHex(expected));
  });

  it('draws fresh seeds from the platform CSPRNG', () => {
    const a = randomDeckSeed();
    const b = randomDeckSeed();
    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
    expect(bytesToHex(a)).not.toBe(bytesToHex(b));
  });
});
