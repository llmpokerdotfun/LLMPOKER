/**
 * Byte/hex/quantity helpers.
 *
 * Part of `@llmpoker/shared`, which has **zero runtime dependencies** on purpose:
 * the RNG verification path must be auditable and runnable in Node, in a browser
 * and inside a Solidity contract's mental model without pulling in a library.
 */

const HEX = '0123456789abcdef';

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX[(b >> 4) & 0x0f]! + HEX[b & 0x0f]!;
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  let h = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) h = `0${h}`;
  if (!/^[0-9a-fA-F]*$/.test(h)) throw new Error(`invalid hex string: ${hex}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function isHexString(value: unknown, byteLength?: number): value is string {
  if (typeof value !== 'string') return false;
  if (!/^0x[0-9a-fA-F]*$/.test(value)) return false;
  if (value.length % 2 !== 0) return false;
  if (byteLength !== undefined && value.length !== 2 + byteLength * 2) return false;
  return true;
}

/** Big-endian fixed-width unsigned integer encoding (matches `abi.encodePacked(uint256)`). */
export function uint256ToBytes(value: bigint | number): Uint8Array {
  let v = typeof value === 'bigint' ? value : BigInt(value);
  if (v < 0n) throw new Error('uint256 cannot be negative');
  if (v >= 1n << 256n) throw new Error('uint256 overflow');
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function bytesToUint256(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = 0; i < bytes.length; i++) v = (v << 8n) | BigInt(bytes[i]!);
  return v;
}

export function bytesToBigIntBE(bytes: Uint8Array, start = 0, length = bytes.length - start): bigint {
  let v = 0n;
  for (let i = start; i < start + length; i++) v = (v << 8n) | BigInt(bytes[i]!);
  return v;
}

/**
 * Abi-packed nonce encoding: a `uint256` nonce is always written as exactly 32
 * big-endian bytes. This removes every ambiguity from `keccak256(seed ‖ nonce)`
 * across TypeScript, Solidity (`abi.encodePacked(bytes32,uint256)`) and a human
 * recomputing the commitment by hand.
 */
export function encodeNonce(nonce: bigint | number): Uint8Array {
  return uint256ToBytes(nonce);
}
