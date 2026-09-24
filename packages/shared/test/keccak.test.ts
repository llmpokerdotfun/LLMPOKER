import { describe, expect, it } from 'vitest';
import { bytesToHex, hexToBytes, keccak256, keccak256Hex, utf8ToBytes } from '../src/index.js';

/**
 * The canonical fairness path must be a real Keccak-256 — the Ethereum variant
 * with `0x01` padding, not NIST SHA3-256 (`0x06`). These are the published
 * vectors, so a regression here invalidates every proof the platform emits.
 */
describe('keccak256', () => {
  const vectors: [string, string][] = [
    ['', 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'],
    ['abc', '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45'],
    [
      'The quick brown fox jumps over the lazy dog',
      '4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15',
    ],
    ['transfer(address,uint256)', 'a9059cbb2ab09eb219583f4a59a5d0623ade346d962bcd4e46b11da047c9049b'],
    ['hello world', '47173285a8d7341e5e972fc677286384f802f8ef42a5ec5f03bbfa254cb01fad'],
  ];

  it.each(vectors)('hashes %j to the published digest', (input, expected) => {
    expect(keccak256Hex(input)).toBe(`0x${expected}`);
  });

  it('is not SHA3-256 (different padding byte)', () => {
    // SHA3-256("") is a7ffc6f8bf1ed766... — Keccak-256 must differ.
    expect(keccak256Hex('')).not.toBe('0xa7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a');
  });

  it('handles inputs that exactly fill a rate block and beyond', () => {
    // The rate is 136 bytes; test the boundaries around block absorption.
    for (const length of [0, 1, 32, 135, 136, 137, 271, 272, 273, 1000]) {
      const data = new Uint8Array(length).map((_, i) => (i * 31 + 7) % 256);
      const digest = keccak256(data);
      expect(digest).toHaveLength(32);
      // deterministic
      expect(bytesToHex(keccak256(data))).toBe(bytesToHex(digest));
      // and equal to hashing a copy
      expect(bytesToHex(keccak256(Uint8Array.from(data)))).toBe(bytesToHex(digest));
    }
  });

  it('accepts bytes and round-trips hex', () => {
    const bytes = utf8ToBytes('llmpoker');
    expect(keccak256Hex(bytes)).toBe(keccak256Hex('llmpoker'));
    expect(bytesToHex(hexToBytes(keccak256Hex('x')))).toBe(keccak256Hex('x').slice(2));
  });

  it('differs for inputs that differ in one bit', () => {
    const a = new Uint8Array([0, 1, 2, 3]);
    const b = new Uint8Array([0, 1, 2, 2]);
    expect(bytesToHex(keccak256(a))).not.toBe(bytesToHex(keccak256(b)));
  });
});
