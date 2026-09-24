/**
 * Verifiable RNG — canonical implementation of FR-6.
 *
 * The exact procedure (see `docs/RNG.md` for the prose version):
 *
 * 1. `deckSeed`  — 32 secret random bytes drawn by the operator.
 * 2. `commit`    — operator publishes `C = keccak256(abi.encodePacked(bytes32
 *                   deckSeed, uint256 nonce))` in block `N`. `nonce` is a
 *                   per-hand uint256 monotonic per table.
 * 3. `anchor`    — block `N+1`; its hash `H` is captured on-chain and stored, so
 *                   it stays readable after the 256-block `blockhash` window.
 * 4. `reveal`    — operator publishes `deckSeed` in block `M`, `N < M <= N+256`
 *                   (and after `K` confirmations of `N+1`). The contract
 *                   recomputes `C` and rejects a mismatch.
 * 5. `entropy`   — `keccak256(abi.encodePacked(bytes32 deckSeed, bytes32 H))`.
 * 6. `shuffle`   — Fisher–Yates over `[0..51]`, driven by a Keccak counter-mode
 *                   stream keyed by `entropy` (see {@link shuffleDeck}).
 *
 * Because `deckSeed` is fixed before `H` exists, the operator cannot steer the
 * deck; because `H` is a public chain fact, anyone can recompute step 5 and 6.
 */

import { bytesToBigIntBE, bytesToHex, hexToBytes, isHexString, uint256ToBytes } from './bytes.js';
import { assertCompleteDeck, DECK_SIZE, type Card } from './cards.js';
import { keccak256, keccak256Concat } from './keccak.js';

/** Number of blocks after commit within which a reveal must land (FR-6.1, FR-6.6). */
export const REVEAL_WINDOW_BLOCKS = 256;

/** Confirmations required after the anchor block before revealing (FR-6.5 / NFR-6). */
export const DEFAULT_ANCHOR_CONFIRMATIONS = 12;

/** `C = keccak256(abi.encodePacked(bytes32 deckSeed, uint256 nonce))`. */
export function commitmentFor(deckSeed: Uint8Array | string, nonce: bigint | number): Uint8Array {
  const seed = typeof deckSeed === 'string' ? hexToBytes(deckSeed) : deckSeed;
  if (seed.length !== 32) throw new Error('deckSeed must be 32 bytes');
  return keccak256Concat([seed, uint256ToBytes(nonce)]);
}

export function commitmentHex(deckSeed: Uint8Array | string, nonce: bigint | number): string {
  return `0x${bytesToHex(commitmentFor(deckSeed, nonce))}`;
}

/** `entropy = keccak256(abi.encodePacked(bytes32 deckSeed, bytes32 anchorBlockHash))`. */
export function entropyFrom(deckSeed: Uint8Array | string, anchorBlockHash: Uint8Array | string): Uint8Array {
  const seed = typeof deckSeed === 'string' ? hexToBytes(deckSeed) : deckSeed;
  const anchor = typeof anchorBlockHash === 'string' ? hexToBytes(anchorBlockHash) : anchorBlockHash;
  if (seed.length !== 32) throw new Error('deckSeed must be 32 bytes');
  if (anchor.length !== 32) throw new Error('anchorBlockHash must be 32 bytes');
  return keccak256Concat([seed, anchor]);
}

export function entropyHex(deckSeed: Uint8Array | string, anchorBlockHash: Uint8Array | string): string {
  return `0x${bytesToHex(entropyFrom(deckSeed, anchorBlockHash))}`;
}

/**
 * The deterministic keccak counter-mode stream that drives the shuffle.
 *
 * `word(k) = keccak256(abi.encodePacked(bytes32 entropy, uint256 k))`
 * `draw64(i)` = big-endian `uint64` from bytes `8*(i mod 4) .. 8*(i mod 4)+8` of
 * `word(floor(i/4))`.
 *
 * Hex words big-endian: this is the one place where byte order could silently
 * diverge between Solidity and TypeScript, so it is pinned by tests that compare
 * against a Solidity harness.
 */
export interface DrawStream {
  /** Next 64-bit draw, uniform over `[0, 2^64)`. */
  next64(): bigint;
  /** Number of keccak words consumed so far. */
  readonly wordsConsumed: number;
  /** Number of 64-bit draws returned so far. */
  readonly drawsConsumed: number;
}

export function createDrawStream(entropy: Uint8Array | string): DrawStream {
  const e = typeof entropy === 'string' ? hexToBytes(entropy) : entropy;
  if (e.length !== 32) throw new Error('entropy must be 32 bytes');
  let wordIndex = 0;
  let word: Uint8Array = new Uint8Array(0);
  let drawInWord = 4;
  let draws = 0;
  return {
    next64(): bigint {
      if (drawInWord >= 4) {
        word = keccak256Concat([e, uint256ToBytes(wordIndex)]);
        wordIndex += 1;
        drawInWord = 0;
      }
      const offset = drawInWord * 8;
      drawInWord += 1;
      draws += 1;
      return bytesToBigIntBE(word, offset, 8);
    },
    get wordsConsumed() {
      return wordIndex;
    },
    get drawsConsumed() {
      return draws;
    },
  };
}

export interface ShuffleResult {
  /** The shuffled deck: 52 distinct card bytes. Index 0..51 is the deal order (burns included). */
  deck: Card[];
  entropy: Uint8Array;
  /** keccak words consumed by the draw stream (deterministic, useful for verifier parity checks). */
  wordsConsumed: number;
  /** 64-bit draws consumed, including rejections. */
  drawsConsumed: number;
}

/**
 * Fisher–Yates shuffle, seeded by `entropy`.
 *
 * Unbiased by construction: each swap index is drawn with rejection sampling
 * (draws `>= floor(2^64 / range) * range` are discarded) rather than a plain
 * modulo, so no card position is favoured.
 */
export function shuffleDeck(entropy: Uint8Array | string): ShuffleResult {
  const e = typeof entropy === 'string' ? hexToBytes(entropy) : entropy;
  if (e.length !== 32) throw new Error('entropy must be 32 bytes');
  const stream = createDrawStream(e);
  const deck: Card[] = new Array(DECK_SIZE);
  for (let i = 0; i < DECK_SIZE; i++) deck[i] = i;

  const TWO64 = 1n << 64n;
  for (let i = DECK_SIZE - 1; i > 0; i--) {
    const range = BigInt(i + 1);
    const limit = (TWO64 / range) * range;
    let d = stream.next64();
    while (d >= limit) d = stream.next64();
    const j = Number(d % range);
    const tmp = deck[i]!;
    deck[i] = deck[j]!;
    deck[j] = tmp;
  }

  assertCompleteDeck(deck);
  return { deck, entropy: e, wordsConsumed: stream.wordsConsumed, drawsConsumed: stream.drawsConsumed };
}

/** Convenience: entropy → shuffled deck. */
export function deckFromEntropy(entropy: Uint8Array | string): Card[] {
  return shuffleDeck(entropy).deck;
}

/** Convenience: reveal data → shuffled deck. */
export function deckFromReveal(
  deckSeed: Uint8Array | string,
  anchorBlockHash: Uint8Array | string,
): Card[] {
  return deckFromEntropy(entropyFrom(deckSeed, anchorBlockHash));
}

/** Draws 32 fresh bytes from the platform CSPRNG (`globalThis.crypto`). */
export function randomDeckSeed(): Uint8Array {
  const c = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error('no CSPRNG available on globalThis.crypto; pass a seed explicitly');
  }
  const seed = new Uint8Array(32);
  c.getRandomValues(seed);
  return seed;
}

export function randomDeckSeedHex(): string {
  return `0x${bytesToHex(randomDeckSeed())}`;
}

/** True when `revealBlock` is inside the allowed reveal window for `commitBlock`. */
export function isWithinRevealWindow(commitBlock: number, revealBlock: number): boolean {
  return revealBlock > commitBlock && revealBlock <= commitBlock + REVEAL_WINDOW_BLOCKS;
}

export function assertHex32(value: string, label: string): void {
  if (!isHexString(value, 32)) throw new Error(`${label} must be a 0x-prefixed 32-byte hex string`);
}

export { keccak256 };
