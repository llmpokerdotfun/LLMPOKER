/** Server configuration, resolved from the environment with safe defaults. */

import { resolve } from 'node:path';
import { CHAIN_ID, DEFAULT_ANCHOR_CONFIRMATIONS } from '@llmpoker/shared';

export type SettlementMode = 'none' | 'local' | 'onchain';
export type AnchorMode = 'local' | 'onchain';

export interface ContractAddresses {
  token: string | null;
  /** Stablecoin accepted at wager tables alongside the native token. */
  usdg: string | null;
  poker: string | null;
  shuffle: string | null;
  staking: string | null;
  vault: string | null;
  rakeSplitter: string | null;
  /** Receives the buyback half of the house edge and burns LLMPOKER. */
  buybackBurner: string | null;
  /** DEX router the buyback uses to convert fees into LLMPOKER. */
  router: string | null;
}

/** Token parameters, needed to render amounts before the token is deployed. */
export interface TokenomicsConfig {
  tokenSymbol: string;
  tokenDecimals: number;
  /** Share of the house edge that buys back and burns the token, in basis points. */
  buybackBps: number;
  /** Share airdropped to stakers, in basis points. */
  stakerBps: number;
  /** LLMPOKER a free-table agent must hold before it may sit down. */
  freeGameMinTokens: bigint;
}

export interface ChainMetadata {
  chainId: number;
  name: string;
  rpcUrl: string | null;
  explorerUrl: string | null;
  nativeCurrency: { name: string; symbol: string; decimals: number };
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
  /**
   * Record every wagered action on-chain through `Poker.recordAction`, with the operator relaying
   * the agent's own EIP-712 signature (FR-10.4 companion).
   *
   * Off by default (`LLMPOKER_ACTIONS_ONCHAIN`), so a deployment that does not ask for it behaves
   * exactly as before: actions stay in the server's off-chain hand history. When on **and**
   * `settlement` is `onchain`, the orchestrator submits the record *before* applying the action to
   * the engine, so an action that cannot be recorded does not happen — the cost being one extra
   * operator transaction per action on the chain's block time. Free mode is never affected: it has
   * no `Poker.sol` to record into and stays entirely off-chain.
   */
  actionsOnChain: boolean;
  contracts: ContractAddresses;
  tokenomics: TokenomicsConfig;
  /** Chain metadata the site uses to offer add/switch-chain in a wallet. */
  chain: ChainMetadata;
  /**
   * Free-table token gate. `true` by default whenever a token address is set:
   * an agent must hold `tokenomics.freeGameMinTokens` to sit at a free table.
   * Set `LLMPOKER_FREE_GATE=false` to disable it explicitly.
   */
  freeGateEnabled: boolean;
  /** USDG decimals, for display only : contracts handle base units. */
  usdgDecimals: number;
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
  /** USDG-denominated wager tables (0 unless a USDG address is configured). */
  usdgWagerTables: number;
  freeTableTier: number;
  wagerTableTier: number;
  /** FR-10.1 rate limiting. */
  rateLimitPerSecond: number;
  maxConcurrentSeats: number;
  /** Think-budget watchdog interval. */
  tickIntervalMs: number;
  /**
   * FR-3.5 companion. Consecutive think-budget expiries by one seat before it is
   * treated as a ghost holding a chair and is unseated (its chips are returned).
   * A seat is only released between hands, because leaving mid-hand is illegal.
   * `0` disables the sweep entirely.
   */
  idleUnseatAfterTimeouts: number;
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
    // Default OFF: recording is opt-in so nothing changes for an operator that has not asked for it.
    actionsOnChain: bool(env.LLMPOKER_ACTIONS_ONCHAIN, false),
    contracts: {
      token: env.LLMPOKER_TOKEN_ADDRESS ?? null,
      usdg: env.LLMPOKER_USDG_ADDRESS ?? null,
      poker: env.LLMPOKER_POKER_ADDRESS ?? null,
      shuffle: env.LLMPOKER_SHUFFLE_ADDRESS ?? null,
      staking: env.LLMPOKER_STAKING_ADDRESS ?? null,
      vault: env.LLMPOKER_VAULT_ADDRESS ?? null,
      rakeSplitter: env.LLMPOKER_RAKE_SPLITTER_ADDRESS ?? null,
      buybackBurner: env.LLMPOKER_BUYBACK_BURNER_ADDRESS ?? null,
      router: env.LLMPOKER_ROUTER_ADDRESS ?? null,
    },
    tokenomics: {
      tokenSymbol: env.LLMPOKER_TOKEN_SYMBOL ?? 'LLMPOKER',
      tokenDecimals: num(env.LLMPOKER_TOKEN_DECIMALS, 18),
      buybackBps: num(env.LLMPOKER_BUYBACK_BPS, 5_000),
      stakerBps: num(env.LLMPOKER_STAKER_BPS, 5_000),
      freeGameMinTokens: BigInt(env.LLMPOKER_FREE_GATE_MIN_TOKENS ?? '50000'),
    },
    chain: {
      chainId: num(env.LLMPOKER_CHAIN_ID, CHAIN_ID),
      name: env.LLMPOKER_CHAIN_NAME ?? 'Robinhood Chain',
      rpcUrl: env.LLMPOKER_RPC_URL?.trim() || env.RH_RPC_URL?.trim() || null,
      explorerUrl: env.LLMPOKER_EXPLORER_URL?.trim() || null,
      nativeCurrency: {
        name: env.LLMPOKER_NATIVE_NAME ?? 'Ether',
        symbol: env.LLMPOKER_NATIVE_SYMBOL ?? 'ETH',
        decimals: num(env.LLMPOKER_NATIVE_DECIMALS, 18),
      },
    },
    // A token gate with no token address cannot gate anything, so it defaults to
    // off until the token is deployed — and says so through /api/v1/health.
    freeGateEnabled: bool(env.LLMPOKER_FREE_GATE, Boolean(env.LLMPOKER_TOKEN_ADDRESS)),
    usdgDecimals: num(env.LLMPOKER_USDG_DECIMALS, 6),
    operatorAddress: env.LLMPOKER_OPERATOR_ADDRESS ?? null,
    operatorToken: env.LLMPOKER_OPERATOR_TOKEN ?? null,
    rpcUrl: env.LLMPOKER_RPC_URL?.trim() || env.RH_RPC_URL?.trim() || null,
    operatorPrivateKey: env.DEPLOYER_PRIVATE_KEY ?? env.LLMPOKER_OPERATOR_KEY ?? null,
    mineBlocks: bool(env.LLMPOKER_MINE_BLOCKS, false),
    rpcPollMs: num(env.LLMPOKER_RPC_POLL_MS, 250),
    freeTables: num(env.LLMPOKER_FREE_TABLES, 3),
    wagerTables: num(env.LLMPOKER_WAGER_TABLES, 2),
    usdgWagerTables: num(env.LLMPOKER_USDG_WAGER_TABLES, 1),
    freeTableTier: num(env.LLMPOKER_FREE_TIER, 0),
    wagerTableTier: num(env.LLMPOKER_WAGER_TIER, 0),
    rateLimitPerSecond: num(env.LLMPOKER_RATE_LIMIT, 10),
    maxConcurrentSeats: num(env.LLMPOKER_MAX_SEATS_PER_AGENT, 3),
    tickIntervalMs: num(env.LLMPOKER_TICK_MS, 250),
    idleUnseatAfterTimeouts: num(env.LLMPOKER_IDLE_UNSEAT_TIMEOUTS, 5),
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
