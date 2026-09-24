import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DECK_PROOF_LENGTH,
  DECK_SIZE,
  DECK_TREE_SIZE,
  ZERO_LEAF,
  bytesToHex,
  bytesToHex32,
  commitDeckOrder,
  hashPair,
  hexToBytes,
  isCompleteDeck,
  keccak256,
  leafHash,
  leafHashHex,
  merkleProof,
  merkleRoot,
  randomSalts,
  revealFor,
  shuffleDeck,
  verifyCardReveal,
  verifyMerkleProof,
} from '../src/index.js';

interface MerkleVector {
  name: string;
  deckSeed: string;
  anchorBlockHash: string;
  entropy: string;
  deck: number[];
  salts: string[];
  leaves: string[];
  root: string;
  proofs: Record<string, string[]>;
}

const vectorsFile = fileURLToPath(new URL('../vectors/merkle-vectors.json', import.meta.url));
const { vectors, orderSensitivity, encoding } = JSON.parse(readFileSync(vectorsFile, 'utf8')) as {
  vectors: MerkleVector[];
  orderSensitivity: {
    deckA: number[];
    saltsA: string[];
    rootA: string;
    deckB: number[];
    saltsB: string[];
    rootB: string;
  };
  encoding: { proofLength: number };
};

/**
 * These vectors are shared with `contracts/test/Shuffle.shared-vectors.test.ts`,
 * which requires `Shuffle.sol` to reproduce them. If this suite and that one
 * disagree, the engine would build deck roots the contract rejects - so the
 * vectors are the referee, exactly as with the RNG vectors.
 */
describe('committed Merkle vectors', () => {
  it('has five vectors and a canonical proof length', () => {
    expect(vectors.length).toBe(5);
    expect(encoding.proofLength).toBe(DECK_PROOF_LENGTH);
    expect(DECK_PROOF_LENGTH).toBe(6);
  });

  it.each(vectors.map((v) => [v.name, v] as const))('%s reproduces leaves, root and proofs', (_name, v) => {
    const leaves = v.deck.map((card, index) => leafHash(card, v.salts[index]!));
    expect(leaves.map(bytesToHex32)).toEqual(v.leaves);
    expect(bytesToHex32(merkleRoot(leaves))).toBe(v.root);

    for (const [index, proof] of Object.entries(v.proofs)) {
      const position = Number(index);
      expect(merkleProof(leaves, position).map(bytesToHex32)).toEqual(proof);
      expect(verifyMerkleProof(v.root, leafHash(v.deck[position]!, v.salts[position]!), position, proof)).toBe(true);
    }
  });

  it.each(vectors.map((v) => [v.name, v] as const))('%s rebuilds the deck from its seed and anchor', (_name, v) => {
    const deck = shuffleDeck(v.entropy).deck;
    expect(deck).toEqual(v.deck);
    expect(bytesToHex(commitDeckOrder(deck, v.salts).root)).toBe(bytesToHex(hexToBytes(v.root)));
  });

  it('rejects a tampered card, a moved proof, a bad salt and a short proof', () => {
    const v = vectors[0]!;
    const root = hexToBytes(v.root);
    const position = 25;
    const good = revealFor(commitDeckOrder(v.deck, v.salts), position);
    expect(verifyCardReveal(root, good)).toBe(true);

    expect(verifyCardReveal(root, { ...good, card: (good.card + 1) % DECK_SIZE })).toBe(false);
    expect(verifyCardReveal(root, { ...good, index: position + 1 })).toBe(false);
    expect(verifyCardReveal(root, { ...good, proof: [...good.proof.slice(0, 5), `0x${'11'.repeat(32)}`] })).toBe(false);
    expect(verifyCardReveal(root, { ...good, salt: `0x${'22'.repeat(32)}` })).toBe(false);
    expect(verifyCardReveal(root, { ...good, proof: good.proof.slice(0, 5) })).toBe(false);
  });

  it('is order sensitive - the trap a sorted-pair interior rule would fall into', () => {
    expect(orderSensitivity.rootA).not.toBe(orderSensitivity.rootB);
    expect([...orderSensitivity.deckA].sort((a, b) => a - b)).toEqual(
      [...orderSensitivity.deckB].sort((a, b) => a - b),
    );

    const leavesA = orderSensitivity.deckA.map((card, i) => leafHash(card, orderSensitivity.saltsA[i]!));
    const leavesB = orderSensitivity.deckB.map((card, i) => leafHash(card, orderSensitivity.saltsB[i]!));
    expect(bytesToHex32(merkleRoot(leavesA))).toBe(orderSensitivity.rootA);
    expect(bytesToHex32(merkleRoot(leavesB))).toBe(orderSensitivity.rootB);
  });

  it('is sensitive to sibling order, which a sorted-pair rule would not be', () => {
    // The orderSensitivity pair transposes deck positions 0 and 1 - siblings at
    // the leaf level. A sorted-pair interior rule hashes them to the same node
    // whatever their order, so the root could not notice the swap at all.
    const a = leafHash(orderSensitivity.deckA[0]!, orderSensitivity.saltsA[0]!);
    const b = leafHash(orderSensitivity.deckA[1]!, orderSensitivity.saltsA[1]!);
    expect(bytesToHex(hashPair(a, b))).not.toBe(bytesToHex(hashPair(b, a)));
  });
});

describe('leaf and tree shape', () => {
  it('hashes the leaf as abi.encodePacked(uint8 card, bytes32 salt), 33 bytes', () => {
    const card = 51; // As
    const salt = `0x${'ab'.repeat(32)}`;
    // The preimage is exactly one card byte followed by the 32 salt bytes.
    const expected = keccak256(new Uint8Array([card, ...hexToBytes(salt)]));
    expect(leafHash(card, salt)).toEqual(expected);
    expect(leafHashHex(card, salt)).toBe(`0x${bytesToHex(expected)}`);
    expect(leafHash(card, salt)).toHaveLength(32);
  });

  it('pads to 64 leaves with a canonical zero leaf', () => {
    const leaves = Array.from({ length: DECK_SIZE }, (_, i) =>
      leafHash(i, `0x${'00'.repeat(31)}0${(i % 16).toString(16)}`),
    );
    let height = 0;
    for (let width = DECK_TREE_SIZE; width > 1; width /= 2) height += 1;
    expect(height).toBe(DECK_PROOF_LENGTH);
    expect(merkleProof(leaves, 0)).toHaveLength(DECK_PROOF_LENGTH);
    expect(ZERO_LEAF).toHaveLength(32);

    // Padding is canonical: a 53rd leaf that IS the zero leaf cannot move the root...
    expect(bytesToHex(merkleRoot(leaves))).toBe(bytesToHex(merkleRoot([...leaves, ZERO_LEAF])));
    // ...but replacing a real leaf does.
    const altered = [...leaves];
    altered[9] = leafHash(9, `0x${'77'.repeat(32)}`);
    expect(bytesToHex(merkleRoot(leaves))).not.toBe(bytesToHex(merkleRoot(altered)));
  });

  it('produces distinct salts and a fresh commitment each time', () => {
    const a = randomSalts();
    const b = randomSalts();
    expect(a).toHaveLength(DECK_SIZE);
    expect(new Set(a.map(bytesToHex)).size).toBe(DECK_SIZE);
    const deck = Array.from({ length: DECK_SIZE }, (_, i) => i);
    expect(isCompleteDeck(deck)).toBe(true);
    expect(bytesToHex32(commitDeckOrder(deck, a).root)).not.toBe(bytesToHex32(commitDeckOrder(deck, b).root));
  });

  it('accepts both raw and hex salts, and rejects malformed inputs', () => {
    const deck = Array.from({ length: DECK_SIZE }, (_, i) => i);
    const bytes = randomSalts();
    const hex = bytes.map(bytesToHex32);
    expect(bytesToHex32(commitDeckOrder(deck, bytes).root)).toBe(bytesToHex32(commitDeckOrder(deck, hex).root));

    expect(() => leafHash(52, `0x${'00'.repeat(32)}`)).toThrow(/out of range/);
    expect(() => leafHash(1, `0x${'00'.repeat(31)}`)).toThrow(/32 bytes/);
    expect(() => commitDeckOrder([1, 2, 3], [])).toThrow(/52 cards/);
    expect(() => commitDeckOrder(deck, hex.slice(0, 10))).toThrow(/52 salts/);
    expect(() => merkleProof([ZERO_LEAF], 64)).toThrow(/outside/);
    expect(verifyMerkleProof(ZERO_LEAF, ZERO_LEAF, 0, [])).toBe(false);
  });
});
