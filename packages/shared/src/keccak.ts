/**
 * Self-contained Keccak-256 (the Ethereum variant, i.e. original Keccak padding
 * `0x01`, **not** NIST SHA3-256 which uses `0x06`).
 *
 * Why hand-rolled instead of a dependency? The fairness claim of the platform
 * rests on `keccak256` being reproducible by a third party. Keeping a single,
 * dependency-free, readable implementation that is shared by the engine, the
 * server, the CLI verifier and the browser monitor means there is exactly one
 * canonical hash path to audit. It is cross-checked against the published
 * Keccak-256 test vectors and against `ethers` in the test suite.
 */

import { bytesToHex, concatBytes } from './bytes.js';

const MASK64 = (1n << 64n) - 1n;
const RATE_BYTES = 136; // 1088-bit rate for Keccak-256

/** Rho rotation offsets, lane index = x + 5y. */
const RHO = new Uint8Array([
  0, 1, 62, 28, 27, //
  36, 44, 6, 55, 20, //
  3, 10, 43, 25, 39, //
  41, 45, 15, 21, 8, //
  18, 2, 61, 56, 14,
]);

/**
 * Round constants are derived from the degree-8 LFSR specified by Keccak
 * (`rc(t)`), so the table is generated rather than transcribed.
 */
function roundConstants(): bigint[] {
  const rc = (t: number): number => {
    const tt = t % 255;
    if (tt === 0) return 1;
    let r = 0x01;
    for (let i = 1; i <= tt; i++) {
      r = ((r << 1) ^ ((r >> 7) & 1) * 0x71) & 0xff;
    }
    return r & 1;
  };
  const out: bigint[] = [];
  for (let round = 0; round < 24; round++) {
    let c = 0n;
    for (let j = 0; j < 7; j++) {
      if (rc(j + 7 * round) === 1) c |= 1n << ((1n << BigInt(j)) - 1n);
    }
    out.push(c);
  }
  return out;
}

const RC = roundConstants();

function rotl64(v: bigint, n: number): bigint {
  if (n === 0) return v & MASK64;
  const k = BigInt(n);
  return ((v << k) | (v >> (64n - k))) & MASK64;
}

function permute(a: bigint[]): void {
  const c = new Array<bigint>(5);
  const d = new Array<bigint>(5);
  const b = new Array<bigint>(25);

  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      c[x] = a[x]! ^ a[x + 5]! ^ a[x + 10]! ^ a[x + 15]! ^ a[x + 20]!;
    }
    for (let x = 0; x < 5; x++) {
      d[x] = c[(x + 4) % 5]! ^ rotl64(c[(x + 1) % 5]!, 1);
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        a[i] = a[i]! ^ d[x]!;
      }
    }

    // rho + pi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(a[x + 5 * y]!, RHO[x + 5 * y]!);
      }
    }

    // chi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const i = x + 5 * y;
        a[i] = b[i]! ^ (~b[((x + 1) % 5) + 5 * y]! & MASK64 & b[((x + 2) % 5) + 5 * y]!);
      }
    }

    // iota
    a[0] = a[0]! ^ RC[round]!;
  }
}

function absorbBlock(state: bigint[], block: Uint8Array, offset: number): void {
  for (let lane = 0; lane < RATE_BYTES / 8; lane++) {
    let v = 0n;
    for (let j = 7; j >= 0; j--) {
      v = (v << 8n) | BigInt(block[offset + lane * 8 + j]!);
    }
    state[lane] = state[lane]! ^ v;
  }
  permute(state);
}

/** Keccak-256 of the given bytes. Returns 32 bytes. */
export function keccak256(data: Uint8Array): Uint8Array {
  const state = new Array<bigint>(25).fill(0n);
  let offset = 0;
  while (data.length - offset >= RATE_BYTES) {
    absorbBlock(state, data, offset);
    offset += RATE_BYTES;
  }

  const tail = new Uint8Array(RATE_BYTES);
  const remaining = data.length - offset;
  tail.set(data.subarray(offset, offset + remaining));
  tail[remaining] = 0x01; // Keccak domain/padding start bit
  tail[RATE_BYTES - 1] = tail[RATE_BYTES - 1]! | 0x80; // final padding bit
  absorbBlock(state, tail, 0);

  const out = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane++) {
    let v = state[lane]!;
    for (let j = 0; j < 8; j++) {
      out[lane * 8 + j] = Number(v & 0xffn);
      v >>= 8n;
    }
  }
  return out;
}

/** Keccak-256 over the concatenation of `chunks`, without an intermediate copy. */
export function keccak256Concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return keccak256(chunks[0]!);
  return keccak256(concatBytes(...chunks));
}

/** `0x`-prefixed lowercase hex of `keccak256(data)`. */
export function keccak256Hex(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return `0x${bytesToHex(keccak256(bytes))}`;
}
