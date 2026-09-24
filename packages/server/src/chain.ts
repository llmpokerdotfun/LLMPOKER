/**
 * The anchor provider (FR-6) and the settlement adapter (FR-5).
 *
 * Two implementations of each:
 *
 * * **LOCAL** — a simulated chain used for free-mode play and for tests. It
 *   produces real random block hashes *at production time*, so the fairness
 *   property still holds (the seed is committed before the anchor hash exists);
 *   it simply is not a public chain. Every proof it produces is labelled
 *   `LOCAL`, never passed off as a chain anchor.
 * * **ONCHAIN** — an ethers client against Robinhood Chain. Commitments and
 *   reveals are published as 0-value transactions with the payload in calldata,
 *   which needs no deployed contract, and the anchor hash is read from the block
 *   after the commit. The `Shuffle.sol` contract provides the on-chain-stored
 *   variant used by `Poker.sol` for settlement.
 */

import { EventEmitter } from 'node:events';
import { bytesToHex, hexToBytes, keccak256Concat, randomDeckSeed, uint256ToBytes } from '@llmpoker/shared';
import type { AnchorMode, ServerConfig } from './config.js';

export interface BlockRef {
  block: number;
  hash: string;
  txHash: string;
}

export interface AnchorProvider {
  readonly kind: 'LOCAL' | 'ONCHAIN';
  currentBlock(): Promise<number>;
  blockHash(block: number): Promise<string>;
  /** Publishes the commitment; returns the block it landed in. */
  submitCommitment(handId: string, commitment: string): Promise<BlockRef>;
  /** Publishes the reveal; returns the block it landed in. */
  submitReveal(handId: string, deckSeed: string): Promise<BlockRef>;
  /** True once `block` + `confirmations` has been produced. */
  isFinal(block: number, confirmations: number): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Simulated chain. Blocks are produced on a timer (or on demand in tests), and
 * each block hash is drawn from the CSPRNG when the block is produced, so it
 * cannot be known at commit time.
 */
export class LocalChain extends EventEmitter implements AnchorProvider {
  readonly kind = 'LOCAL' as const;
  private block = 0;
  private readonly hashes = new Map<number, string>();
  private readonly txHashes = new Map<string, BlockRef>();
  private timer: NodeJS.Timeout | null = null;
  private readonly blockTimeMs: number;

  constructor(blockTimeMs = 1_000, startBlock = 1_000) {
    super();
    this.blockTimeMs = blockTimeMs;
    this.block = startBlock;
    this.hashes.set(startBlock, `0x${bytesToHex(keccak256Concat([new TextEncoder().encode('llmpoker-genesis'), uint256ToBytes(BigInt(startBlock))]))}`);
  }

  start(): void {
    if (this.timer || this.blockTimeMs <= 0) return;
    this.timer = setInterval(() => this.produceBlock(), this.blockTimeMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Produces `count` blocks immediately (used by tests and by the reveal wait). */
  produceBlock(count = 1): number {
    for (let i = 0; i < count; i++) {
      this.block += 1;
      this.hashes.set(this.block, `0x${bytesToHex(randomDeckSeed())}`);
      this.emit('block', this.block);
    }
    return this.block;
  }

  async currentBlock(): Promise<number> {
    return this.block;
  }

  async blockHash(block: number): Promise<string> {
    const hash = this.hashes.get(block);
    if (!hash) throw new Error(`local chain has no block ${block} (window is ${this.block - 256}..${this.block})`);
    return hash;
  }

  private record(kind: 'commit' | 'reveal', handId: string, payload: string): BlockRef {
    const txHash = `0x${bytesToHex(keccak256Concat([new TextEncoder().encode(kind), hexToBytes(payload), uint256ToBytes(BigInt(this.block))]))}`;
    const ref: BlockRef = { block: this.block, hash: payload, txHash };
    this.txHashes.set(`${kind}:${handId}`, ref);
    return ref;
  }

  async submitCommitment(handId: string, commitment: string): Promise<BlockRef> {
    // Simulated mining latency: one block for the commitment to land.
    this.produceBlock(1);
    return this.record('commit', handId, commitment);
  }

  async submitReveal(handId: string, deckSeed: string): Promise<BlockRef> {
    this.produceBlock(1);
    return this.record('reveal', handId, deckSeed);
  }

  async isFinal(block: number, confirmations: number): Promise<boolean> {
    return this.block >= block + confirmations;
  }

  async close(): Promise<void> {
    this.stop();
  }
}

/**
 * Real chain anchor. Commit/reveal are published as 0-value self-transactions
 * with the 32-byte payload as calldata, so no contract deployment is required
 * for the RNG proof itself; the wager settlement path uses the deployed
 * contracts (see `contracts/`).
 */
export class OnChainAnchor implements AnchorProvider {
  readonly kind = 'ONCHAIN' as const;
  private provider: unknown;

  constructor(
    private readonly rpcUrl: string,
    private readonly privateKey: string,
  ) {
    if (!rpcUrl || !privateKey) throw new Error('on-chain anchoring requires RH_RPC_URL and an operator private key');
  }

  private async ethers(): Promise<typeof import('ethers')> {
    return import('ethers');
  }

  private async getProvider(): Promise<import('ethers').JsonRpcProvider> {
    if (!this.provider) {
      const { JsonRpcProvider } = await this.ethers();
      this.provider = new JsonRpcProvider(this.rpcUrl);
    }
    return this.provider as import('ethers').JsonRpcProvider;
  }

  async currentBlock(): Promise<number> {
    const provider = await this.getProvider();
    return provider.getBlockNumber();
  }

  async blockHash(block: number): Promise<string> {
    const provider = await this.getProvider();
    const found = await provider.getBlock(block);
    if (!found || !found.hash) throw new Error(`RPC has no usable block ${block}`);
    return found.hash;
  }

  private async send(payload: Uint8Array): Promise<BlockRef> {
    const { Wallet, hexlify } = await this.ethers();
    const provider = await this.getProvider();
    const wallet = new Wallet(this.privateKey, provider);
    const tx = await wallet.sendTransaction({ to: await wallet.getAddress(), value: 0n, data: hexlify(payload) });
    const receipt = await tx.wait();
    if (!receipt) throw new Error('transaction was not mined');
    const block = await provider.getBlock(receipt.blockNumber);
    return { block: receipt.blockNumber, hash: block?.hash ?? '', txHash: receipt.hash };
  }

  async submitCommitment(_handId: string, commitment: string): Promise<BlockRef> {
    return this.send(hexToBytes(commitment));
  }

  async submitReveal(_handId: string, deckSeed: string): Promise<BlockRef> {
    return this.send(hexToBytes(deckSeed));
  }

  async isFinal(block: number, confirmations: number): Promise<boolean> {
    return (await this.currentBlock()) >= block + confirmations;
  }

  async close(): Promise<void> {
    const provider = this.provider as { destroy?: () => void } | undefined;
    provider?.destroy?.();
    this.provider = null;
  }
}

export function createAnchor(config: ServerConfig): AnchorProvider {
  if (config.rngAnchor === 'onchain') {
    if (!config.rpcUrl || !config.operatorPrivateKey) {
      throw new Error('LLMPOKER_ANCHOR=onchain requires RH_RPC_URL and an operator private key');
    }
    return new OnChainAnchor(config.rpcUrl, config.operatorPrivateKey);
  }
  return new LocalChain(config.blockTimeMs);
}

export type AnchorKind = AnchorMode;

// ---------------------------------------------------------------------------
// Settlement (FR-5)
// ---------------------------------------------------------------------------

export interface EscrowAccount {
  agentId: string;
  tableId: string;
  amount: bigint;
}

export interface SettlementReceipt {
  kind: 'LOCAL' | 'ONCHAIN';
  txHash: string;
  block: number;
  note?: string;
}

/**
 * Settlement surface used by the wager orchestrator. `LocalEscrow` keeps a
 * mirror ledger so the whole wager flow (deposit → play → settle → rake →
 * cash-out) is exercisable without a chain; `OnChainSettlement` submits to
 * `Poker.sol`.
 */
export interface SettlementAdapter {
  readonly kind: 'LOCAL' | 'ONCHAIN' | 'NONE';
  deposit(agentId: string, tableId: string, amount: bigint): Promise<SettlementReceipt>;
  cashOut(agentId: string, tableId: string, amount: bigint): Promise<SettlementReceipt>;
  /** Settles one hand: moves chips between escrow balances and books the rake. */
  settle(
    tableId: string,
    handId: string,
    moves: { agentId: string; delta: bigint }[],
    rake: bigint,
  ): Promise<SettlementReceipt>;
  balances(): Map<string, bigint>;
  houseBalance(): bigint;
}

export class LocalEscrow implements SettlementAdapter {
  readonly kind = 'LOCAL' as const;
  private readonly accounts = new Map<string, bigint>();
  private house = 0n;
  private block = 0;

  private key(agentId: string, tableId: string): string {
    return `${tableId}:${agentId}`;
  }

  private receipt(note: string): SettlementReceipt {
    this.block += 1;
    const txHash = `0x${bytesToHex(
      keccak256Concat([new TextEncoder().encode(`local-settlement:${note}:${this.block}`), uint256ToBytes(BigInt(this.block))]),
    )}`;
    return { kind: 'LOCAL', txHash, block: this.block, note };
  }

  async deposit(agentId: string, tableId: string, amount: bigint): Promise<SettlementReceipt> {
    const key = this.key(agentId, tableId);
    this.accounts.set(key, (this.accounts.get(key) ?? 0n) + amount);
    return this.receipt(`deposit:${key}:${amount}`);
  }

  async cashOut(agentId: string, tableId: string, amount: bigint): Promise<SettlementReceipt> {
    const key = this.key(agentId, tableId);
    const current = this.accounts.get(key) ?? 0n;
    if (amount > current) throw new Error(`escrow underflow for ${key}: ${amount} > ${current}`);
    this.accounts.set(key, current - amount);
    return this.receipt(`cashout:${key}:${amount}`);
  }

  async settle(
    tableId: string,
    handId: string,
    moves: { agentId: string; delta: bigint }[],
    rake: bigint,
  ): Promise<SettlementReceipt> {
    for (const move of moves) {
      const key = this.key(move.agentId, tableId);
      const next = (this.accounts.get(key) ?? 0n) + move.delta;
      if (next < 0n) throw new Error(`settlement would make ${key} negative (${next})`);
      this.accounts.set(key, next);
    }
    if (rake > 0n) this.house += rake;
    return this.receipt(`settle:${tableId}:${handId}`);
  }

  balances(): Map<string, bigint> {
    return new Map(this.accounts);
  }

  houseBalance(): bigint {
    return this.house;
  }

  addRake(amount: bigint): void {
    this.house += amount;
  }
}

/** Placeholder for the real adapter; refuses to run without contracts. */
export class OnChainSettlement implements SettlementAdapter {
  readonly kind = 'ONCHAIN' as const;

  constructor() {
    throw new Error(
      'on-chain settlement requires deployed contracts and an ABI; use LLMPOKER_SETTLEMENT=local for development',
    );
  }

  async deposit(): Promise<SettlementReceipt> {
    throw new Error('not implemented');
  }

  async cashOut(): Promise<SettlementReceipt> {
    throw new Error('not implemented');
  }

  async settle(): Promise<SettlementReceipt> {
    throw new Error('not implemented');
  }

  balances(): Map<string, bigint> {
    return new Map();
  }

  houseBalance(): bigint {
    return 0n;
  }
}

export function createSettlement(config: ServerConfig): SettlementAdapter {
  if (config.settlement === 'onchain') return new OnChainSettlement();
  return new LocalEscrow();
}
