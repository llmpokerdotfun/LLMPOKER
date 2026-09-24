/**
 * EIP-712 typed-data hashing (FR-1.2, FR-10.4), implemented from the spec with
 * no dependencies so the server, the CLI and a third party all compute the same
 * digest. Cross-checked against `ethers` in the test suite.
 */

import { bytesToHex, concatBytes, hexToBytes, isHexString, uint256ToBytes, utf8ToBytes } from './bytes.js';
import { keccak256 } from './keccak.js';
import type { ActionType } from './types.js';

export const EIP712_DOMAIN_NAME = 'LLM Poker Arena';
export const EIP712_DOMAIN_VERSION = '1';

export interface Eip712Field {
  name: string;
  type: string;
}

export interface Eip712Domain {
  name: string;
  version: string;
  chainId: number | bigint;
  verifyingContract: string;
}

export interface Eip712TypeDefinition {
  [primaryType: string]: Eip712Field[];
}

function leftPad32(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) throw new Error(`value too large for a 32-byte word (${bytes.length} bytes)`);
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

function rightPad32(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) throw new Error(`value too large for a 32-byte word (${bytes.length} bytes)`);
  const out = new Uint8Array(32);
  out.set(bytes, 0);
  return out;
}

/** `Type(a,b)` concatenated with the referenced struct types, in dependency order. */
export function encodeType(primaryType: string, types: Eip712TypeDefinition): string {
  const deps = new Set<string>();
  const collect = (type: string): void => {
    if (deps.has(type)) return;
    const fields = types[type];
    if (!fields) return;
    deps.add(type);
    for (const f of fields) {
      const base = f.type.replace(/\[.*\]$/, '');
      if (types[base]) collect(base);
    }
  };
  collect(primaryType);

  const ordered = [primaryType, ...[...deps].filter((t) => t !== primaryType).sort()];
  return ordered.map((t) => `${t}(${(types[t] ?? []).map((f) => `${f.type} ${f.name}`).join(',')})`).join('');
}

export function typeHash(primaryType: string, types: Eip712TypeDefinition): Uint8Array {
  return keccak256(utf8ToBytes(encodeType(primaryType, types)));
}

function encodeField(type: string, value: unknown): Uint8Array {
  if (type === 'string') return keccak256(utf8ToBytes(String(value)));
  if (type === 'bytes') {
    const v = String(value);
    return keccak256(hexToBytes(v));
  }
  if (type === 'bool') return uint256ToBytes(value ? 1n : 0n);
  if (type === 'address') {
    const v = String(value);
    if (!isHexString(v, 20)) throw new Error(`invalid address: ${v}`);
    return leftPad32(hexToBytes(v));
  }
  if (type.startsWith('uint') || type.startsWith('int')) {
    const width = Number.parseInt(type.slice(type.startsWith('uint') ? 4 : 3), 10);
    const big = BigInt(value as bigint | number | string);
    if (big < 0n) throw new Error('negative ints are not supported');
    if (Number.isFinite(width) && width < 256 && big >= 1n << BigInt(width)) {
      throw new Error(`value ${big} does not fit in ${type}`);
    }
    return uint256ToBytes(big);
  }
  if (type.startsWith('bytes')) {
    const width = Number.parseInt(type.slice(5), 10);
    const bytes = hexToBytes(String(value));
    if (Number.isFinite(width) && bytes.length !== width) throw new Error(`expected ${width} bytes for ${type}`);
    return rightPad32(bytes);
  }
  throw new Error(`unsupported EIP-712 field type: ${type}`);
}

export function hashStruct(primaryType: string, message: Record<string, unknown>, types: Eip712TypeDefinition): Uint8Array {
  const fields = types[primaryType];
  if (!fields) throw new Error(`unknown EIP-712 type: ${primaryType}`);
  const chunks: Uint8Array[] = [typeHash(primaryType, types)];
  for (const field of fields) {
    if (!(field.name in message)) throw new Error(`missing EIP-712 field: ${field.name}`);
    chunks.push(encodeField(field.type, message[field.name]));
  }
  return keccak256(concatBytes(...chunks));
}

export const EIP712_DOMAIN_TYPE: Eip712TypeDefinition = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
};

export function domainSeparator(domain: Eip712Domain): Uint8Array {
  return hashStruct(
    'EIP712Domain',
    {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    EIP712_DOMAIN_TYPE,
  );
}

/** `keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message))`. */
export function hashTypedData(
  domain: Eip712Domain,
  types: Eip712TypeDefinition,
  primaryType: string,
  message: Record<string, unknown>,
): Uint8Array {
  return keccak256(
    concatBytes(new Uint8Array([0x19, 0x01]), domainSeparator(domain), hashStruct(primaryType, message, types)),
  );
}

export function hashTypedDataHex(
  domain: Eip712Domain,
  types: Eip712TypeDefinition,
  primaryType: string,
  message: Record<string, unknown>,
): string {
  return `0x${bytesToHex(hashTypedData(domain, types, primaryType, message))}`;
}

/** Ready-to-sign `eth_signTypedData_v4` payload. */
export function toTypedDataJson(
  domain: Eip712Domain,
  types: Eip712TypeDefinition,
  primaryType: string,
  message: Record<string, unknown>,
): unknown {
  return {
    types: { EIP712Domain: EIP712_DOMAIN_TYPE.EIP712Domain, ...types },
    primaryType,
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: Number(domain.chainId),
      verifyingContract: domain.verifyingContract,
    },
    message,
  };
}

// ---------------------------------------------------------------------------
// Platform-specific typed data
// ---------------------------------------------------------------------------

export const AGENT_REGISTRATION_TYPES: Eip712TypeDefinition = {
  AgentRegistration: [
    { name: 'name', type: 'string' },
    { name: 'wallet', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'metadataHash', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
  ],
};

export const AGENT_ACTION_TYPES: Eip712TypeDefinition = {
  AgentAction: [
    { name: 'agentId', type: 'string' },
    { name: 'tableId', type: 'string' },
    { name: 'handId', type: 'string' },
    { name: 'seat', type: 'uint8' },
    { name: 'action', type: 'uint8' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

/** Wire/ABI enum for the action grammar. Order is part of the signed payload. */
export const ACTION_ENUM: Record<ActionType, number> = {
  FOLD: 0,
  CHECK: 1,
  CALL: 2,
  BET: 3,
  RAISE: 4,
  ALL_IN: 5,
};

const ACTION_BY_ENUM: ActionType[] = ['FOLD', 'CHECK', 'CALL', 'BET', 'RAISE', 'ALL_IN'];

export function actionToEnum(action: ActionType): number {
  const v = ACTION_ENUM[action];
  if (v === undefined) throw new Error(`unknown action: ${action}`);
  return v;
}

export function actionFromEnum(value: number): ActionType {
  const a = ACTION_BY_ENUM[value];
  if (a === undefined) throw new Error(`unknown action enum: ${value}`);
  return a;
}

export function registrationDigest(
  domain: Eip712Domain,
  message: { name: string; wallet: string; nonce: bigint | number | string; metadataHash: string; deadline: number },
): string {
  return hashTypedDataHex(domain, AGENT_REGISTRATION_TYPES, 'AgentRegistration', {
    ...message,
    nonce: BigInt(message.nonce),
  });
}

export function agentActionDigest(
  domain: Eip712Domain,
  message: {
    agentId: string;
    tableId: string;
    handId: string;
    seat: number;
    action: ActionType;
    amount: bigint | number | string;
    nonce: bigint | number | string;
    deadline: number;
  },
): string {
  return hashTypedDataHex(domain, AGENT_ACTION_TYPES, 'AgentAction', {
    ...message,
    seat: BigInt(message.seat),
    action: BigInt(actionToEnum(message.action)),
    amount: BigInt(message.amount),
    nonce: BigInt(message.nonce),
    deadline: BigInt(message.deadline),
  });
}
