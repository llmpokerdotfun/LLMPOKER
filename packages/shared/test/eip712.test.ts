import { describe, expect, it } from 'vitest';
import { TypedDataEncoder, keccak256 as ethersKeccak256, solidityPackedKeccak256, toUtf8Bytes } from 'ethers';
import {
  AGENT_ACTION_TYPES,
  AGENT_REGISTRATION_TYPES,
  ACTION_ENUM,
  EIP712_DOMAIN_TYPE,
  actionFromEnum,
  actionToEnum,
  agentActionDigest,
  bytesToHex,
  commitmentFor,
  domainSeparator,
  hashTypedDataHex,
  keccak256,
  uint256ToBytes,
  utf8ToBytes,
  type Eip712Domain,
} from '../src/index.js';

const DOMAIN: Eip712Domain = {
  name: 'LLM Poker Arena',
  version: '1',
  chainId: 4663,
  verifyingContract: '0x1234567890abcdef1234567890abcdef12345678',
};

/**
 * `ethers` is the reference implementation for everything the chain will also
 * compute: Keccak-256, `abi.encodePacked` hashing and EIP-712 digests. The
 * dependency-free implementation in `@llmpoker/shared` must agree byte for byte.
 */
describe('keccak256 cross-check against ethers', () => {
  it('agrees on random-ish inputs', () => {
    for (let i = 0; i < 40; i++) {
      const text = `agent-${i}-${'x'.repeat(i % 17)}`;
      expect(bytesToHex(keccak256(utf8ToBytes(text)))).toBe(ethersKeccak256(toUtf8Bytes(text)).slice(2));
    }
  });
});

describe('commitment encoding matches Solidity abi.encodePacked', () => {
  it('is keccak256(bytes32 seed ‖ uint256 nonce)', () => {
    const seed = `0x${'3f'.repeat(32)}`;
    for (const nonce of [0n, 1n, 42n, 2n ** 64n, 2n ** 256n - 1n]) {
      const ours = `0x${bytesToHex(commitmentFor(seed, nonce))}`;
      const theirs = solidityPackedKeccak256(['bytes32', 'uint256'], [seed, nonce]);
      expect(ours).toBe(theirs);
    }
  });

  it('treats the nonce as exactly 32 big-endian bytes', () => {
    const seed = `0x${'00'.repeat(32)}`;
    expect(solidityPackedKeccak256(['bytes32', 'uint256'], [seed, 1n])).toBe(
      `0x${bytesToHex(commitmentFor(seed, 1n))}`,
    );
    expect(uint256ToBytes(1n)).toEqual(new Uint8Array([...new Uint8Array(31), 1]));
  });
});

describe('EIP-712 digests match ethers', () => {
  it('has the same domain separator', () => {
    const theirs = TypedDataEncoder.hashDomain(DOMAIN);
    const ours = `0x${bytesToHex(domainSeparator(DOMAIN))}`;
    expect(ours).toBe(theirs);
    expect(EIP712_DOMAIN_TYPE.EIP712Domain).toHaveLength(4);
  });

  it('hashes an AgentRegistration message identically', () => {
    const message = {
      name: 'Hermes',
      wallet: '0xabc0000000000000000000000000000000000001',
      nonce: 12345678901234567890n,
      metadataHash: `0x${'11'.repeat(32)}`,
      deadline: 1_760_000_000,
    };
    const theirs = TypedDataEncoder.hash(DOMAIN, AGENT_REGISTRATION_TYPES, message);
    const ours = hashTypedDataHex(DOMAIN, AGENT_REGISTRATION_TYPES, 'AgentRegistration', message);
    expect(ours).toBe(theirs);
  });

  it('hashes an AgentAction message identically, across every action enum', () => {
    for (const [action, value] of Object.entries(ACTION_ENUM)) {
      const message = {
        agentId: 'agent_7f3a',
        tableId: 'wager-micro-1',
        handId: 'hand_000123',
        seat: 4,
        action: value,
        amount: 250_000_000_000_000_000n,
        nonce: 9n,
        deadline: 1_760_000_100,
      };
      const theirs = TypedDataEncoder.hash(DOMAIN, AGENT_ACTION_TYPES, message);
      const ours = agentActionDigest(DOMAIN, {
        agentId: message.agentId,
        tableId: message.tableId,
        handId: message.handId,
        seat: message.seat,
        action: action as keyof typeof ACTION_ENUM,
        amount: message.amount,
        nonce: message.nonce,
        deadline: message.deadline,
      });
      expect(ours).toBe(theirs);
      expect(actionFromEnum(value)).toBe(action);
    }
  });

  it('binds the digest to the chain, the contract and every field', () => {
    const base = {
      agentId: 'a',
      tableId: 't',
      handId: 'h',
      seat: 1,
      action: 'CALL' as const,
      amount: 0n,
      nonce: 1n,
      deadline: 100,
    };
    const digest = agentActionDigest(DOMAIN, base);
    expect(agentActionDigest({ ...DOMAIN, chainId: 1 }, base)).not.toBe(digest);
    expect(
      agentActionDigest({ ...DOMAIN, verifyingContract: '0x0000000000000000000000000000000000000001' }, base),
    ).not.toBe(digest);
    expect(agentActionDigest(DOMAIN, { ...base, seat: 2 })).not.toBe(digest);
    expect(agentActionDigest(DOMAIN, { ...base, amount: 1n })).not.toBe(digest);
    expect(agentActionDigest(DOMAIN, { ...base, nonce: 2n })).not.toBe(digest);
    expect(agentActionDigest(DOMAIN, { ...base, deadline: 101 })).not.toBe(digest);
    expect(agentActionDigest(DOMAIN, { ...base, action: 'FOLD' })).not.toBe(digest);
    expect(agentActionDigest(DOMAIN, { ...base, tableId: 'other' })).not.toBe(digest);
  });

  it('rejects a value that does not fit the declared width', () => {
    expect(() =>
      hashTypedDataHex(DOMAIN, AGENT_ACTION_TYPES, 'AgentAction', {
        agentId: 'a',
        tableId: 't',
        handId: 'h',
        seat: 256, // seat is uint8
        action: 0n,
        amount: 0n,
        nonce: 0n,
        deadline: 0n,
      }),
    ).toThrow(/does not fit in uint8/);
  });

  it('encodes the action enum in a fixed order (part of the signed payload)', () => {
    expect(ACTION_ENUM).toEqual({ FOLD: 0, CHECK: 1, CALL: 2, BET: 3, RAISE: 4, ALL_IN: 5 });
  });
});
