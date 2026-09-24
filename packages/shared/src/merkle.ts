/**
 * The FR-6.2/6.3 hidden-card commitment: a Merkle commitment over the salted
 * shuffled deck, plus per-card inclusion proofs.
 *
 * This is the *only* place the deck becomes public information, and even then
 * only one card at a time. The encoding below is byte-for-byte identical to
 * `contracts/src/Shuffle.sol` (`_hashPair`, `_leavesFrom`, `_verifyMerkleProof`)
 * and is pinned by `packages/shared/vectors/merkle-vectors.json`, which the
 * Solidity suite reproduces through its own independent implementation.
 *
 * ```
 * leaf   = keccak256(abi.encodePacked(uint8 card, bytes32 salt))   // 33 bytes packed
 * inner  = keccak256(abi.encode(bytes32 left, bytes32 right))      // 64 bytes, ORDERED
 * shape  = 64 leaves: the 52 deck positions, then 12 padding leaves
 *          (ZERO_LEAF = keccak256(abi.encode(uint256(0))))
 * proof  = 6 sibling hashes, leaf level first
 * ```
 *
 * Two details that are load-bearing:
 *
 * 1. **Interior nodes are ordered, never sorted.** A sorted-pair rule
 *    (`keccak(min‖max)`) makes the root invariant under *every* permutation of
 *    the leaves — each permutation is a product of sibling swaps — so it would
 *    commit to the deck's *set* rather than its *sequence*, and the operator
 *    could deal any order at all. Second-preimage safety comes from the leaf
 *    shape instead: a leaf hashes 33 bytes, an interior node 64.
 * 2. **A salt is mandatory and must be unpredictable.** The leaf hides the card
 *    only because `salt` is secret until that card is revealed; with a 32-byte
 *    salt an unrevealed leaf is uniform over `2^256`, so the committed root
 *    leaks nothing about the hidden cards (FR-6.8). A zero or reused salt would
 *    make the leaves guessable one card at a time.
 */

import { bytesToHex, concatBytes, hexToBytes } from './bytes.js';
import { type Card, DECK_SIZE, isCard } from './cards.js';
import { keccak256 } from './keccak.js';

/** Leaves are padded to this power of two, so every proof is `log2(64) = 6` levels. */
export const DECK_TREE_SIZE = 64;
/** Sibling hashes in a proof for a 52-card deck. */
export const DECK_PROOF_LENGTH = 6;
/** Bytes of salt per deck position. */
export const SALT_BYTES = 32;

function asBytes(value: Uint8Array | string, label: string): Uint8Array {
  const bytes = typeof value === 'string' ? hexToBytes(value) : value;
  if (bytes.length !== 32) throw new Error(`${label} must be 32 bytes (got ${bytes.length})`);
  return bytes;
}

export function bytesToHex32(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new Error(`expected 32 bytes, got ${bytes.length}`);
  return `0x${bytesToHex(bytes)}`;
}

/** `keccak256(abi.encode(uint256(0)))` — the padding leaf used for positions 52..63. */
export const ZERO_LEAF: Uint8Array = keccak256(new Uint8Array(32));

/** `keccak256(abi.encodePacked(uint8 card, bytes32 salt))` (FR-6.2). */
export function leafHash(card: Card, salt: Uint8Array | string): Uint8Array {
  if (!isCard(card)) throw new Error(`card out of range: ${card}`);
  const saltBytes = asBytes(salt, 'salt');
  const packed = new Uint8Array(33);
  packed[0] = card;
  packed.set(saltBytes, 1);
  return keccak256(packed);
}

/** `keccak256(abi.encode(bytes32 left, bytes32 right))` — ordered (see module docs). */
export function hashPair(left: Uint8Array | string, right: Uint8Array | string): Uint8Array {
  return keccak256(concatBytes(asBytes(left, 'left'), asBytes(right, 'right')));
}

/** All tree levels; `levels[0]` is the padded leaf row, the last is `[root]`. */
export function buildDeckTree(leaves: readonly Uint8Array[]): Uint8Array[][] {
  if (leaves.length > DECK_TREE_SIZE) throw new Error(`too many leaves: ${leaves.length}`);
  const base: Uint8Array[] = [];
  for (let i = 0; i < DECK_TREE_SIZE; i++) base.push(leaves[i] ?? ZERO_LEAF);

  const levels: Uint8Array[][] = [base];
  let width = DECK_TREE_SIZE;
  while (width > 1) {
    const previous = levels[levels.length - 1]!;
    const next: Uint8Array[] = [];
    for (let i = 0; i < width; i += 2) next.push(hashPair(previous[i]!, previous[i + 1]!));
    levels.push(next);
    width /= 2;
  }
  return levels;
}

/** Merkle root over `leaves`, zero-padded to `DECK_TREE_SIZE`. */
export function merkleRoot(leaves: readonly Uint8Array[]): Uint8Array {
  const levels = buildDeckTree(leaves);
  return levels[levels.length - 1]![0]!;
}

/** Sibling hashes for `index`, leaf level first (FR-6.3 proof shape). */
export function merkleProof(leaves: readonly Uint8Array[], index: number): Uint8Array[] {
  if (!Number.isInteger(index) || index < 0 || index >= DECK_TREE_SIZE) {
    throw new Error(`index ${index} is outside 0..${DECK_TREE_SIZE - 1}`);
  }
  return merkleProofFromLevels(buildDeckTree(leaves), index);
}

/**
 * Sibling hashes from an already-built tree. The audit needs all 52 proofs at
 * once, and rebuilding a 64-leaf tree per position turns one tree build into 52.
 */
export function merkleProofFromLevels(levels: readonly Uint8Array[][], index: number): Uint8Array[] {
  if (!Number.isInteger(index) || index < 0 || index >= DECK_TREE_SIZE) {
    throw new Error(`index ${index} is outside 0..${DECK_TREE_SIZE - 1}`);
  }
  const proof: Uint8Array[] = [];
  let idx = index;
  for (let level = 0; level < levels.length - 1; level++) {
    proof.push(levels[level]![idx ^ 1]!);
    idx >>= 1;
  }
  return proof;
}

/** Recomputes the root from a leaf and its proof — the loop `Shuffle._verifyMerkleProof` runs. */
export function verifyMerkleProof(
  root: Uint8Array | string,
  leaf: Uint8Array | string,
  index: number,
  proof: readonly (Uint8Array | string)[],
): boolean {
  if (proof.length !== DECK_PROOF_LENGTH) return false;
  const target = bytesToHex(asBytes(root, 'root'));
  let node = asBytes(leaf, 'leaf');
  let idx = index;
  for (const sibling of proof) {
    node = (idx & 1) === 0 ? hashPair(node, sibling) : hashPair(sibling, node);
    idx >>= 1;
  }
  return bytesToHex(node) === target;
}

// ---------------------------------------------------------------------------
// Deck commitment
// ---------------------------------------------------------------------------

export interface DeckCommitment {
  /** 52 card values in deal order. */
  deck: Card[];
  /** 52 salts, one per position, secret until that position is revealed. */
  salts: Uint8Array[];
  /** 52 leaf hashes, one per position. */
  leaves: Uint8Array[];
  /** The root published at FR-6.2 phase 2. */
  root: Uint8Array;
}

/** `0x`-prefixed `keccak256(abi.encodePacked(uint8 card, bytes32 salt))`. */
export function leafHashHex(card: Card, salt: Uint8Array | string): string {
  return bytesToHex32(leafHash(card, salt));
}

/** Builds the salted commitment for a deck ordering (FR-6.2). Accepts hex or raw salts. */
export function commitDeckOrder(
  deck: readonly Card[],
  salts: readonly (Uint8Array | string)[],
): DeckCommitment {
  if (deck.length !== DECK_SIZE) throw new Error(`deck must hold ${DECK_SIZE} cards`);
  if (salts.length !== DECK_SIZE) throw new Error(`expected ${DECK_SIZE} salts`);
  const saltBytes = salts.map((salt, index) => Uint8Array.from(asBytes(salt, `salt[${index}]`)));
  const leaves = deck.map((card, index) => leafHash(card, saltBytes[index]!));
  return { deck: [...deck], salts: saltBytes, leaves, root: merkleRoot(leaves) };
}

/** Fresh 32-byte salts for a whole deck. */
export function randomSalts(count = DECK_SIZE): Uint8Array[] {
  const cryptoObj = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
    throw new Error('no CSPRNG available on globalThis.crypto; pass salts explicitly');
  }
  const getRandomValues = cryptoObj.getRandomValues.bind(cryptoObj);
  return Array.from({ length: count }, () => {
    const salt = new Uint8Array(SALT_BYTES);
    getRandomValues(salt);
    return salt;
  });
}

/** One card made public, with everything needed to check it against the root (FR-6.3). */
export interface CardReveal {
  /** Position in the shuffled deck, `0..51`. */
  index: number;
  card: Card;
  /** 0x-prefixed 32-byte salt. */
  salt: string;
  /** Merkle path, leaf level first (6 entries). */
  proof: string[];
}

/** Builds the reveal payload for one deck position. */
export function revealFor(commitment: DeckCommitment, index: number): CardReveal {
  const card = commitment.deck[index];
  const salt = commitment.salts[index];
  if (card === undefined || salt === undefined) throw new Error(`no deck position ${index}`);
  return {
    index,
    card,
    salt: bytesToHex32(salt),
    proof: merkleProof(commitment.leaves, index).map(bytesToHex32),
  };
}

/**
 * Reveals for many positions from a single tree build. Used by the FR-6.4 audit,
 * which publishes all 52 proofs at once.
 */
export function revealSetFor(commitment: DeckCommitment, indices: readonly number[]): CardReveal[] {
  const levels = buildDeckTree(commitment.leaves);
  return indices.map((index) => {
    const card = commitment.deck[index];
    const salt = commitment.salts[index];
    if (card === undefined || salt === undefined) throw new Error(`no deck position ${index}`);
    return {
      index,
      card,
      salt: bytesToHex32(salt),
      proof: merkleProofFromLevels(levels, index).map(bytesToHex32),
    };
  });
}

/** Verifies a reveal against the committed root (FR-6.3). */export function verifyCardReveal(root: Uint8Array | string, reveal: CardReveal): boolean {
  if (!isCard(reveal.card)) return false;
  if (!Number.isInteger(reveal.index) || reveal.index < 0 || reveal.index >= DECK_SIZE) return false;
  if (reveal.proof.length !== DECK_PROOF_LENGTH) return false;
  return verifyMerkleProof(root, leafHash(reveal.card, reveal.salt), reveal.index, reveal.proof);
}

/** Leaves for a fully revealed deck + salts, used by the FR-6.4 audit check. */
export function leavesForDeck(deck: readonly Card[], salts: readonly (Uint8Array | string)[]): Uint8Array[] {
  if (deck.length !== DECK_SIZE || salts.length !== DECK_SIZE) {
    throw new Error(`expected ${DECK_SIZE} cards and salts`);
  }
  return deck.map((card, index) => leafHash(card, salts[index]!));
}

export { DECK_SIZE };
