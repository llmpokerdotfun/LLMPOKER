/**
 * Agent authentication (FR-1.2, FR-1.3, FR-10.4).
 *
 * * registration proves wallet ownership with an EIP-712 signature over a
 *   server-issued nonce,
 * * the agent then receives a short-lived bearer token (HS256 JWT, hand-rolled on
 *   `node:crypto` — no dependency needed for one HMAC),
 * * wager-mode actions additionally carry an EIP-712 signature over the action
 *   itself, so a stolen API key alone cannot move money.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  type ActionType,
  type Eip712Domain,
  AGENT_REGISTRATION_TYPES,
  agentActionDigest,
  bytesToHex,
  hashTypedDataHex,
  keccak256,
  toTypedDataJson,
  utf8ToBytes,
} from '@llmpoker/shared';

export interface TokenPayload {
  sub: string;
  iat: number;
  exp: number;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export function createToken(agentId: string, secret: string, ttlSeconds: number, now = Date.now()): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const issuedAt = Math.floor(now / 1000);
  const payload: TokenPayload = { sub: agentId, iat: issuedAt, exp: issuedAt + ttlSeconds };
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

export function verifyToken(token: string, secret: string, now = Date.now()): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts as [string, string, string];
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number') return null;
    if (payload.exp * 1000 < now) return null;
    return payload;
  } catch {
    return null;
  }
}

export function eip712Domain(config: { chainId: number; verifyingContract: string | null }): Eip712Domain {
  return {
    name: 'LLM Poker Arena',
    version: '1',
    chainId: config.chainId,
    verifyingContract: config.verifyingContract ?? '0x0000000000000000000000000000000000000000',
  };
}

/**
 * Canonical metadata hash for the registration typed data. Deterministic in
 * (name, metadata) with sorted keys, so the server can recompute exactly what
 * the wallet signed at auth time without storing the challenge.
 */
export function metadataHashFor(name: string, metadata: Record<string, unknown> | object = {}): string {
  const fields = metadata as Record<string, unknown>;
  const sorted = Object.keys(fields)
    .sort()
    .map((key) => [key, fields[key]] as const);
  const canonical = JSON.stringify({ name, metadata: Object.fromEntries(sorted) });
  return `0x${bytesToHex(keccak256(utf8ToBytes(canonical)))}`;
}

/** A registration challenge: the nonce the wallet must sign. */
export function createChallenge(
  domain: Eip712Domain,
  params: { name: string; wallet: string; metadata?: Record<string, unknown> | object; metadataHash?: string },
) {
  const nonce = BigInt(`0x${randomBytes(16).toString('hex')}`);
  const deadline = Math.floor(Date.now() / 1000) + 15 * 60;
  const message = {
    name: params.name,
    wallet: params.wallet,
    nonce,
    metadataHash: params.metadataHash ?? metadataHashFor(params.name, params.metadata ?? {}),
    deadline,
  };
  return {
    nonce: nonce.toString(),
    deadline,
    typedData: toTypedDataJson(domain, AGENT_REGISTRATION_TYPES, 'AgentRegistration', {
      ...message,
      nonce: message.nonce.toString(),
    }),
    digest: hashTypedDataHex(domain, AGENT_REGISTRATION_TYPES, 'AgentRegistration', message),
    message,
  };
}

export interface SignatureCheck {
  ok: boolean;
  address: string | null;
  error?: string;
}

/** Verifies an EIP-712 signature with ethers and compares it to `expectedWallet`. */
export async function verifySignature(params: {
  domain: Eip712Domain;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
  signature: string;
  expectedWallet: string;
}): Promise<SignatureCheck> {
  let recovered: string;
  try {
    const { verifyTypedData } = await import('ethers');
    recovered = verifyTypedData(
      params.domain as unknown as Parameters<typeof verifyTypedData>[0],
      params.types as unknown as Parameters<typeof verifyTypedData>[1],
      params.message as unknown as Parameters<typeof verifyTypedData>[2],
      params.signature,
    );
  } catch (error) {
    return { ok: false, address: null, error: `invalid signature: ${(error as Error).message}` };
  }
  if (recovered.toLowerCase() !== params.expectedWallet.toLowerCase()) {
    return { ok: false, address: recovered, error: `signature is from ${recovered}, expected ${params.expectedWallet}` };
  }
  return { ok: true, address: recovered };
}

export interface ActionSignatureInput {
  agentId: string;
  tableId: string;
  handId: string;
  seat: number;
  action: ActionType;
  amount: bigint;
  nonce: bigint;
  deadline: number;
}

/** The digest an agent signs for a wager-mode action (FR-1.3, FR-10.4). */
export function actionDigest(domain: Eip712Domain, input: ActionSignatureInput): string {
  return agentActionDigest(domain, input);
}
