/**
 * Wallet-facing chain services for the site: the free-table token gate and the
 * staking read/write helpers.
 *
 * Two rules shape this module:
 *
 * 1. **The server never holds a user's key.** Staking writes are returned as
 *    pre-encoded transactions (`to`/`data`/`value`) for the *browser* wallet to
 *    send. The server only builds calldata, so a compromised server cannot move a
 *    staker's tokens.
 * 2. **The gate fails closed.** If the gate is enabled and the balance cannot be
 *    read, seating is refused rather than allowed — a token gate that opens when
 *    the RPC blinks is not a gate. Every refusal carries a machine code.
 */

import { formatChips, type Chips } from '@llmpoker/shared';
import type { ServerConfig } from './config.js';

export class ServiceUnavailableError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ServiceUnavailableError';
    this.code = code;
  }
}

export interface GateStatus {
  /** False when §no token is configured yet: seating is then ungated. */
  enabled: boolean;
  /** `null` when the gate is disabled — deliberately not `true`. */
  eligible: boolean | null;
  balance: Chips | null;
  required: Chips;
  requiredTokens: string;
  symbol: string;
  decimals: number;
  token: string | null;
  /** Present when the gate is enabled but the balance could not be read. */
  reason?: string;
}

export interface StakingSummary {
  wallet: string;
  token: string;
  symbol: string;
  decimals: number;
  staked: Chips;
  pendingRewards: Chips;
  /** Principal released only after the cooldown (FR-9.5). */
  cooldown: { amount: Chips; unlockAt: number; claimable: boolean } | null;
  totalStaked: Chips;
  cooldownSeconds: number;
  minStake: Chips;
  /** Total ever notified as staker yield, so the site can show real activity. */
  totalRewardsNotified: Chips;
}

export type StakingAction = 'approve' | 'stake' | 'unstake' | 'cancel' | 'claim';

export interface TxRequest {
  to: string;
  data: string;
  value: '0';
  chainId: number;
  action: StakingAction;
  summary: string;
}

export interface ChainServices {
  readonly available: boolean;
  gate(wallet: string): Promise<GateStatus>;
  /** Enforces the gate; throws `ServiceUnavailableError` when it must fail closed. */
  requireFreeTableAccess(wallet: string): Promise<void>;
  stakingSummary(wallet: string): Promise<StakingSummary>;
  stakingTx(wallet: string, action: StakingAction, amount: Chips): Promise<TxRequest>;
  close(): Promise<void>;
}

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const STAKING_ABI = [
  'function stake(uint256 amount)',
  'function requestUnstake(uint256 amount)',
  'function cancelUnstake()',
  'function claim()',
  'function stakeOf(address) view returns (uint256)',
  'function pendingUnstake(address) view returns (uint256)',
  'function unstakeAvailableAt(address) view returns (uint256)',
  'function pendingRewards(address) view returns (uint256)',
  'function totalStaked() view returns (uint256)',
  'function totalRewardsNotified() view returns (uint256)',
  'function cooldownSeconds() view returns (uint256)',
  'function minStake() view returns (uint256)',
  'function token() view returns (address)',
];

interface Erc20 {
  balanceOf(account: string): Promise<bigint>;
  decimals(): Promise<bigint>;
  symbol(): Promise<string>;
  allowance(owner: string, spender: string): Promise<bigint>;
  approve: { (spender: string, amount: bigint): Promise<{ hash: string }>; getFragment?: unknown };
}
interface Staking {
  stake(amount: bigint): Promise<unknown>;
  requestUnstake(amount: bigint): Promise<unknown>;
  cancelUnstake(): Promise<unknown>;
  claim(): Promise<unknown>;
  stakeOf(account: string): Promise<bigint>;
  pendingUnstake(account: string): Promise<bigint>;
  unstakeAvailableAt(account: string): Promise<bigint>;
  pendingRewards(account: string): Promise<bigint>;
  totalStaked(): Promise<bigint>;
  totalRewardsNotified(): Promise<bigint>;
  cooldownSeconds(): Promise<bigint>;
  minStake(): Promise<bigint>;
  token(): Promise<string>;
}

function isAddress(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Live implementation. Constructed only when an RPC and a token are configured;
 * otherwise the app falls back to {@link DisabledChainServices}.
 */
class LiveChainServices implements ChainServices {
  readonly available = true;
  private provider: import('ethers').JsonRpcProvider | null = null;
  private readonly balanceCache = new Map<string, { value: bigint; at: number }>();
  private readonly cacheMs = 30_000;

  constructor(private readonly config: ServerConfig) {}

  private async ethers(): Promise<typeof import('ethers')> {
    return import('ethers');
  }

  private async getProvider(): Promise<import('ethers').JsonRpcProvider> {
    if (!this.provider) {
      const { JsonRpcProvider } = await this.ethers();
      this.provider = new JsonRpcProvider(this.config.rpcUrl!, undefined, {
        pollingInterval: this.config.rpcPollMs,
        cacheTimeout: 0,
      });
    }
    return this.provider;
  }

  private async tokenContract(): Promise<Erc20> {
    const address = this.config.contracts.token;
    if (!isAddress(address)) throw new ServiceUnavailableError('TOKEN_NOT_CONFIGURED', 'no token address configured');
    const { Contract } = await this.ethers();
    return new Contract(address, ERC20_ABI, await this.getProvider()) as unknown as Erc20;
  }

  private async stakingContract(): Promise<Staking> {
    const address = this.config.contracts.staking;
    if (!isAddress(address)) {
      throw new ServiceUnavailableError('STAKING_NOT_CONFIGURED', 'no staking address configured');
    }
    const { Contract } = await this.ethers();
    return new Contract(address, STAKING_ABI, await this.getProvider()) as unknown as Staking;
  }

  /** Cached so a busy table does not turn every action into an RPC round-trip. */
  async tokenBalance(wallet: string): Promise<bigint> {
    const key = wallet.toLowerCase();
    const cached = this.balanceCache.get(key);
    if (cached && Date.now() - cached.at < this.cacheMs) return cached.value;
    const contract = await this.tokenContract();
    const value = await contract.balanceOf(wallet);
    this.balanceCache.set(key, { value, at: Date.now() });
    return value;
  }

  async gate(wallet: string): Promise<GateStatus> {
    const { tokenSymbol, tokenDecimals, freeGameMinTokens } = this.config.tokenomics;
    const required = freeGameMinTokens * 10n ** BigInt(tokenDecimals);
    const base = {
      enabled: this.config.freeGateEnabled,
      required,
      requiredTokens: freeGameMinTokens.toString(),
      symbol: tokenSymbol,
      decimals: tokenDecimals,
      token: this.config.contracts.token,
    };
    if (!this.config.freeGateEnabled) return { ...base, enabled: false, eligible: null, balance: null };
    try {
      const balance = await this.tokenBalance(wallet);
      return { ...base, enabled: true, balance, eligible: balance >= required };
    } catch (error) {
      // Fail closed: no balance, no seat.
      return {
        ...base,
        enabled: true,
        balance: null,
        eligible: false,
        reason: `could not read the token balance: ${(error as Error).message}`,
      };
    }
  }

  async requireFreeTableAccess(wallet: string): Promise<void> {
    if (!this.config.freeGateEnabled) return;
    const status = await this.gate(wallet);
    if (status.eligible === true) return;
    if (status.balance === null) {
      throw new ServiceUnavailableError(
        'GATE_UNAVAILABLE',
        `the free-table token gate is active but the balance could not be read (${status.reason ?? 'unknown error'})`,
      );
    }
    throw new ServiceUnavailableError(
      'TOKEN_GATE',
      `a free-table seat requires at least ${formatChips(status.required, status.symbol)}; ` +
        `this wallet holds ${formatChips(status.balance, status.symbol)}`,
    );
  }

  async stakingSummary(wallet: string): Promise<StakingSummary> {
    const staking = await this.stakingContract();
    const tokenAddress = await staking.token();
    const [staked, pendingUnstake, unlockAt, pendingRewards, totalStaked, cooldownSeconds, minStake, notified] =
      await Promise.all([
        staking.stakeOf(wallet),
        staking.pendingUnstake(wallet),
        staking.unstakeAvailableAt(wallet),
        staking.pendingRewards(wallet),
        staking.totalStaked(),
        staking.cooldownSeconds(),
        staking.minStake(),
        staking.totalRewardsNotified(),
      ]);
    const unlockSeconds = Number(unlockAt);
    return {
      wallet,
      token: tokenAddress,
      symbol: this.config.tokenomics.tokenSymbol,
      decimals: this.config.tokenomics.tokenDecimals,
      staked,
      pendingRewards,
      cooldown:
        pendingUnstake > 0n
          ? {
              amount: pendingUnstake,
              unlockAt: unlockSeconds * 1000,
              claimable: unlockSeconds * 1000 <= Date.now(),
            }
          : null,
      totalStaked,
      cooldownSeconds: Number(cooldownSeconds),
      minStake,
      totalRewardsNotified: notified,
    };
  }

  /**
   * Builds the transaction the *wallet* should send. Nothing here signs or
   * broadcasts: the browser asks for calldata and its own wallet submits it.
   */
  async stakingTx(_wallet: string, action: StakingAction, amount: Chips): Promise<TxRequest> {
    // `wallet` is accepted for symmetry with the summaries and for future
    // per-wallet policy (allowlists); the calldata itself is wallet-independent.
    const { Interface } = await this.ethers();
    const stakingAddress = this.config.contracts.staking;
    if (!isAddress(stakingAddress)) {
      throw new ServiceUnavailableError('STAKING_NOT_CONFIGURED', 'no staking address configured');
    }
    const tokenAddress = this.config.contracts.token;
    const stakingInterface = new Interface(STAKING_ABI);
    const erc20Interface = new Interface(ERC20_ABI);
    const symbol = this.config.tokenomics.tokenSymbol;
    const { formatChips: fmt } = await import('@llmpoker/shared');

    switch (action) {
      case 'approve':
        if (!isAddress(tokenAddress)) {
          throw new ServiceUnavailableError('TOKEN_NOT_CONFIGURED', 'no token address configured');
        }
        if (amount <= 0n) throw new ServiceUnavailableError('INVALID_AMOUNT', 'approve amount must be positive');
        return {
          to: tokenAddress,
          data: erc20Interface.encodeFunctionData('approve', [stakingAddress, amount]),
          value: '0',
          chainId: this.config.chainId,
          action,
          summary: `approve ${fmt(amount, symbol)} for staking`,
        };
      case 'stake':
        if (amount <= 0n) throw new ServiceUnavailableError('INVALID_AMOUNT', 'stake amount must be positive');
        return {
          to: stakingAddress,
          data: stakingInterface.encodeFunctionData('stake', [amount]),
          value: '0',
          chainId: this.config.chainId,
          action,
          summary: `stake ${fmt(amount, symbol)}`,
        };
      case 'unstake':
        if (amount <= 0n) throw new ServiceUnavailableError('INVALID_AMOUNT', 'unstake amount must be positive');
        return {
          to: stakingAddress,
          data: stakingInterface.encodeFunctionData('requestUnstake', [amount]),
          value: '0',
          chainId: this.config.chainId,
          action,
          summary: `request unstake of ${fmt(amount, symbol)} (7-day cooldown)`,
        };
      case 'cancel':
        return {
          to: stakingAddress,
          data: stakingInterface.encodeFunctionData('cancelUnstake', []),
          value: '0',
          chainId: this.config.chainId,
          action,
          summary: 'cancel the pending unstake',
        };
      case 'claim':
        return {
          to: stakingAddress,
          data: stakingInterface.encodeFunctionData('claim', []),
          value: '0',
          chainId: this.config.chainId,
          action,
          summary: 'claim staker rewards',
        };
      default:
        throw new ServiceUnavailableError('INVALID_ACTION', `unknown staking action: ${String(action)}`);
    }
  }

  async close(): Promise<void> {
    this.provider?.destroy();
    this.provider = null;
  }
}

/** Used when no chain/token is configured: everything says "not live yet". */
class DisabledChainServices implements ChainServices {
  readonly available = false;

  constructor(private readonly config: ServerConfig) {}

  private unavailable(what: string, code: string): never {
    throw new ServiceUnavailableError(
      code,
      `${what} is not live yet: it needs an RPC URL and a deployed contract address`,
    );
  }

  async gate(_wallet: string): Promise<GateStatus> {
    return {
      enabled: false,
      eligible: null,
      balance: null,
      required: this.config.tokenomics.freeGameMinTokens * 10n ** BigInt(this.config.tokenomics.tokenDecimals),
      requiredTokens: this.config.tokenomics.freeGameMinTokens.toString(),
      symbol: this.config.tokenomics.tokenSymbol,
      decimals: this.config.tokenomics.tokenDecimals,
      token: this.config.contracts.token,
      reason: 'the token gate is not active yet',
    };
  }

  async requireFreeTableAccess(): Promise<void> {
    // Ungated until a token exists to gate on.
    return;
  }

  async stakingSummary(): Promise<StakingSummary> {
    this.unavailable('staking', 'STAKING_NOT_CONFIGURED');
  }

  async stakingTx(): Promise<TxRequest> {
    this.unavailable('staking', 'STAKING_NOT_CONFIGURED');
  }

  async close(): Promise<void> {
    return;
  }
}

export function createChainServices(config: ServerConfig): ChainServices {
  const hasChain = Boolean(config.rpcUrl) && (isAddress(config.contracts.token) || isAddress(config.contracts.staking));
  return hasChain ? new LiveChainServices(config) : new DisabledChainServices(config);
}
