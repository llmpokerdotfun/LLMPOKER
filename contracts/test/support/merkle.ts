/**
 * Independent TypeScript implementation of the FR-6.2/6.3 Merkle commitment.
 *
 * This file exists to be *different* from `Shuffle.sol`: it is written from `SRS.md` FR-6.2/6.3
 * alone and never calls the contract. The suite asserts that the two agree byte for byte, both for
 * a whole tree (`merkleRoot`) and for individual proofs (`leafHash` + `verifyMerkleProof`). If they
 * ever diverge, the off-chain engine would build roots the contract rejects — so this is the
 * Merkle analogue of the RNG vector gate.
 *
 * Encoding contract (must match the Solidity side):
 *   leaf   = keccak256(abi.encodePacked(uint8 card, bytes32 salt))
 *   inner  = keccak256(abi.encode(left, right))       // ORDERED, not sorted
 *   shape  = leaves padded with keccak256(abi.encode(uint256(0))) to the next power of two
 *
 * The interior rule must be order preserving: a sorted pair would make the root invariant under
 * every permutation of the leaves, i.e. a commitment to the deck's *set* rather than its sequence.
 */

import { ethers } from 'ethers';

/** SRS card encoding: `card = rank * 4 + suit`, `0..51`. */
export const DECK_SIZE = 52;
/** Leaves are padded to this power of two, so every proof is `log2(64) = 6` levels. */
export const TREE_SIZE = 64;
/** Number of sibling hashes in a proof for a 52-card deck. */
export const PROOF_LENGTH = 6;

/** `keccak256(abi.encode(uint256(0)))` — the padding leaf, mirroring `Shuffle.ZERO_LEAF`. */
export const ZERO_LEAF = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [0n]));

/** `keccak256(abi.encodePacked(uint8 card, bytes32 salt))` (FR-6.2). */
export function leafHash(card: number, salt: string): string {
  return ethers.keccak256(ethers.solidityPacked(['uint8', 'bytes32'], [card, salt]));
}

/** `keccak256(abi.encode(left, right))` — ordered, so the tree commits to the sequence. */
export function hashPair(a: string, b: string): string {
  return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32'], [a, b]));
}

/** All levels of the tree, `levels[0]` being the padded leaf row and the last being `[root]`. */
export function buildTree(leaves: string[]): string[][] {
  if (leaves.length > TREE_SIZE) throw new Error(`too many leaves: ${leaves.length}`);
  const base: string[] = [];
  for (let i = 0; i < TREE_SIZE; i++) base.push(i < leaves.length ? leaves[i]! : ZERO_LEAF);

  const levels: string[][] = [base];
  let width = TREE_SIZE;
  while (width > 1) {
    const prev = levels[levels.length - 1]!;
    const next: string[] = [];
    for (let i = 0; i < width; i += 2) next.push(hashPair(prev[i]!, prev[i + 1]!));
    levels.push(next);
    width /= 2;
  }
  return levels;
}

/** Merkle root over `leaves`, zero-padded to `TREE_SIZE`. */
export function merkleRoot(leaves: string[]): string {
  const levels = buildTree(leaves);
  return levels[levels.length - 1]![0]!;
}

/** Sibling hashes for `index`, leaf level first (FR-6.3 proof shape). */
export function merkleProof(leaves: string[], index: number): string[] {
  const levels = buildTree(leaves);
  const proof: string[] = [];
  let idx = index;
  for (let level = 0; level < levels.length - 1; level++) {
    proof.push(levels[level]![idx ^ 1]!);
    idx >>= 1;
  }
  return proof;
}

/** Recompute the root from a leaf and its proof — the exact loop `Shuffle._verifyMerkleProof` runs. */
export function verifyMerkleProof(root: string, leaf: string, index: number, proof: string[]): boolean {
  let node = leaf;
  let idx = index;
  for (const sibling of proof) {
    node = (idx & 1) === 0 ? hashPair(node, sibling) : hashPair(sibling, node);
    idx >>= 1;
  }
  return node.toLowerCase() === root.toLowerCase();
}

/** Deterministic 32-byte salt for a deck position, so tests are reproducible. */
export function saltFor(handId: string, index: number): string {
  return ethers.keccak256(ethers.solidityPacked(['string', 'bytes32', 'uint256'], ['salt', handId, index]));
}

/** Everything the contract needs for one hand's FR-6.2/6.3/6.4 calls. */
export interface DeckCommitment {
  /** 52 card values in deal order (`0..51`). */
  deck: number[];
  /** 52 salts, one per position. */
  salts: string[];
  /** 52 leaf hashes, one per position. */
  leaves: string[];
  /** The Merkle root to commit at phase 2. */
  root: string;
}

/** Salted commitment for a deck ordering (FR-6.2). */
export function commitmentForDeck(handId: string, deck: number[]): DeckCommitment {
  if (deck.length !== DECK_SIZE) throw new Error(`deck must have ${DECK_SIZE} cards`);
  const salts = deck.map((_, index) => saltFor(handId, index));
  const leaves = deck.map((card, index) => leafHash(card, salts[index]!));
  return { deck, salts, leaves, root: merkleRoot(leaves) };
}

/** FR-6.3 proof for one deck position. */
export function cardProof(commitment: DeckCommitment, index: number): string[] {
  return merkleProof(commitment.leaves, index);
}
