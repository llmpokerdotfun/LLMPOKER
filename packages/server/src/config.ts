/** Server configuration, resolved from the environment with safe defaults. */

import { resolve } from 'node:path';
import { CHAIN_ID, DEFAULT_ANCHOR_CONFIRMATIONS } from '@llmpoker/shared';

export type SettlementMode = 'none' | 'local' | 'onchain';
export type AnchorMode = 'local' | 'onchain';

export interface ContractAddresses {
  token: string | null;
  poker: string | null;
  shuffle: string | null;
  staking: string | null;
  vault: string | null;
  rakeSplitter: string | null;
}

export interface ServerConfig {
  version: string;
  host: string;
  port: number;
  chainId: number;
  chainName: string;
  publicBaseUrl: string;
  /** Where hand histories and the agent registry are written. */
  dataDir: string;
  repoRoot: string;
  monitorDir: string;
  persist: boolean;
  jwtSecret: string;
  tokenTtlSeconds: number;
  /** Local anchor block production. */
  blockTimeMs: number;
  freeAnchorConfirmations: number;
  wagerAnchorConfirmations: number;
  rngAnchor: AnchorMode;
  settlement: SettlementMode;
  contracts: ContractAddresses;
  operatorAddress: string | null;
  /** Enables the operator-only admin surface (FR-10.5). Unset ⇒ admin routes 403. */
  operatorToken: string | null;
  rpcUrl: string | null;
  operatorPrivateKey: string | null;
  /**
   * Development chains only: allow `evm_mine` so an automining node can produce
   * the anchor blocks the FR-6 phases wait for. Must stay false on a public chain.
   */
  mineBlocks: boolean;
  /** How often to poll the RPC for receipts. Ethers' 4s default dominates a hand. */
  rpcPollMs: number;
  /** Tables created at boot. */
  freeTables: number;
  wagerTables: number;
  freeTableTier: number;
  wagerTableTier: number;
  /** FR-10.1 rate limiting. */
  rateLimitPerSecond: number;
  maxConcurrentSeats: number;
  /** Think-budget watchdog interval. */
  tickIntervalMs: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`invalid number in environment: ${value}`);
  return parsed;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const repoRoot = resolve(env.LLMPOKER_ROOT ?? process.cwd());
  const dataDir = resolve(env.LLMPOKER_DATA_DIR ?? resolve(repoRoot, 'data'));
  const settlement = (env.LLMPOKER_SETTLEMENT ?? 'local') as SettlementMode;
  const anchor = (env.LLMPOKER_ANCHOR ?? (env.RH_RPC_URL ? 'onchain' : 'local')) as AnchorMode;

  if (!['none', 'local', 'onchain'].includes(settlement)) {
    throw new Error(`LLMPOKER_SETTLEMENT must be none|local|onchain (got ${settlement})`);
  }
  if (!['local', 'onchain'].includes(anchor)) {
    throw new Error(`LLMPOKER_ANCHOR must be local|onchain (got ${anchor})`);
  }

  return {
    version: env.LLMPOKER_VERSION ?? '0.1.0',
    host: env.HOST ?? '127.0.0.1',
    port: num(env.PORT, 8787),
    chainId: num(env.LLMPOKER_CHAIN_ID, CHAIN_ID),
    chainName: env.LLMPOKER_CHAIN_NAME ?? 'Robinhood Chain',
    publicBaseUrl: env.LLMPOKER_PUBLIC_URL ?? `http://${env.HOST ?? '127.0.0.1'}:${num(env.PORT, 8787)}`,
    dataDir,
    repoRoot,
    monitorDir: resolve(repoRoot, 'packages/monitor/public'),
    persist: bool(env.LLMPOKER_PERSIST, true),
    jwtSecret: env.LLMPOKER_JWT_SECRET ?? 'llmpoker-development-secret-change-me',
    tokenTtlSeconds: num(env.LLMPOKER_TOKEN_TTL, 60 * 60 * 12),
    blockTimeMs: num(env.LLMPOKER_BLOCK_TIME_MS, 1_000),
    freeAnchorConfirmations: num(env.LLMPOKER_FREE_CONFIRMATIONS, 1),
    wagerAnchorConfirmations: num(env.LLMPOKER_WAGER_CONFIRMATIONS, DEFAULT_ANCHOR_CONFIRMATIONS),
    rngAnchor: anchor,
    settlement,
    contracts: {
      token: env.LLMPOKER_TOKEN_ADDRESS ?? null,
      poker: env.LLMPOKER_POKER_ADDRESS ?? null,
      shuffle: env.LLMPOKER_SHUFFLE_ADDRESS ?? null,
      staking: env.LLMPOKER_STAKING_ADDRESS ?? null,
      vault: env.LLMPOKER_VAULT_ADDRESS ?? null,
      rakeSplitter: env.LLMPOKER_RAKE_SPLITTER_ADDRESS ?? null,
    },
    operatorAddress: env.LLMPOKER_OPERATOR_ADDRESS ?? null,
    operatorToken: env.LLMPOKER_OPERATOR_TOKEN ?? null,
    rpcUrl: env.LLMPOKER_RPC_URL?.trim() || env.RH_RPC_URL?.trim() || null,
    operatorPrivateKey: env.DEPLOYER_PRIVATE_KEY ?? env.LLMPOKER_OPERATOR_KEY ?? null,
    mineBlocks: bool(env.LLMPOKER_MINE_BLOCKS, false),
    rpcPollMs: num(env.LLMPOKER_RPC_POLL_MS, 250),
    freeTables: num(env.LLMPOKER_FREE_TABLES, 3),
    wagerTables: num(env.LLMPOKER_WAGER_TABLES, 2),
    freeTableTier: num(env.LLMPOKER_FREE_TIER, 0),
    wagerTableTier: num(env.LLMPOKER_WAGER_TIER, 0),
    rateLimitPerSecond: num(env.LLMPOKER_RATE_LIMIT, 10),
    maxConcurrentSeats: num(env.LLMPOKER_MAX_SEATS_PER_AGENT, 3),
    tickIntervalMs: num(env.LLMPOKER_TICK_MS, 250),
    logLevel: (env.LLMPOKER_LOG_LEVEL ?? 'info') as ServerConfig['logLevel'],
  };
}

/** Wager tables are only allowed when a settlement path is configured. */
export function wagerEnabled(config: ServerConfig): boolean {
  if (config.settlement === 'none') return false;
  if (config.settlement === 'onchain') {
    return Boolean(config.rpcUrl && config.operatorPrivateKey && config.contracts.poker);
  }
  return true;
}
