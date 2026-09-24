/**
 * The RNG pipeline (FR-6) and the settlement adapter (FR-5).
 *
 * Under the patched FR-6 the operator runs four phases per hand, and the *only*
 * thing that ever becomes public while a hand is live is a commitment or a card
 * the rules required:
 *
 * 1. `commitSeed`  — `keccak256(seed ‖ nonce)`; the seed stays secret.
 * 2. `commitDeck`  — the Merkle root over `keccak256(card_i ‖ salt_i)`; the
 *    ordering and every salt stay secret.
 * 3. `revealCard`  — one `(index, card, salt, proof)` per public card.
 * 4. `audit`       — after the hand, the seed and all salts, so the commitment
 *    can be proven forever.
 *
 * Two implementations:
 *
 * * **LOCAL** — a simulated chain for free-mode play and tests. Block hashes are
 *   drawn from the CSPRNG when the block is produced, so the fairness property
 *   still holds (the seed is fixed before the anchor exists); it simply is not a
 *   public chain. Every proof it produces is labelled `LOCAL`.
 * * **ONCHAIN** — an ethers client. `Shuffle.sol` is called for all four phases;
 *   commitments and reveals are transactions on Robinhood Chain.
 */

import { EventEmitter } from 'node:events';
import { bytesToHex, keccak256Concat, randomDeckSeed, uint256ToBytes } from '@llmpoker/shared';
import type { AnchorMode, ServerConfig } from './config.js';

export interface BlockRef {
  block: number;
  hash: string;
  txHash: string;
}

/** The `Shuffle.sol` surface the server calls, in the order FR-6 uses it. */
interface ShuffleContract {
  commitSeed(handId: string, seedCommitment: string, nonce: bigint): Promise<{ hash: string }>;
  commitDeck(handId: string, deckRoot: string, leaves: string[]): Promise<{ hash: string }>;
  revealCard(handId: string, deckIndex: number, card: number, salt: string, proof: string[]): Promise<{ hash: string }>;
  audit(handId: string, deckSeed: string, cards: number[], salts: string[]): Promise<{ hash: string }>;
}

export interface AnchorProvider {
  readonly kind: 'LOCAL' | 'ONCHAIN';
  currentBlock(): Promise<number>;
  blockHash(block: number): Promise<string>;
  /** FR-6.1 phase 1: publish the seed commitment. The seed itself stays secret. */
  commitSeed(handId: string, commitment: string, nonce: bigint): Promise<BlockRef>;
  /** FR-6.2 phase 2: publish the Merkle deck root (never the ordering). */
  commitDeck(handId: string, deckRoot: string, leaves: readonly string[]): Promise<BlockRef>;
  /** FR-6.3 phase 3: publish one card the rules made public, with its proof. */
  revealCard(handId: string, index: number, card: number, salt: string, proof: readonly string[]): Promise<BlockRef>;
  /** FR-6.4 phase 4: publish the seed and all salts once the hand is over. */
  audit(handId: string, deckSeed: string, deck: readonly number[], salts: readonly string[]): Promise<BlockRef>;
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

  private record(kind: 'seed' | 'deck' | 'card' | 'audit', handId: string, payload: string): BlockRef {
    const txHash = `0x${bytesToHex(
      keccak256Concat([
        new TextEncoder().encode(kind),
        new TextEncoder().encode(handId),
        new TextEncoder().encode(payload),
        uint256ToBytes(BigInt(this.block)),
      ]),
    )}`;
    const ref: BlockRef = { block: this.block, hash: payload, txHash };
    this.txHashes.set(`${kind}:${handId}`, ref);
    return ref;
  }

  async commitSeed(handId: string, commitment: string, nonce: bigint): Promise<BlockRef> {
    // Simulated mining latency: one block for the commitment to land. Only the
    // commitment is recorded — never the seed.
    this.produceBlock(1);
    return this.record('seed', handId, `${commitment}:${nonce}`);
  }

  async commitDeck(handId: string, deckRoot: string, leaves: readonly string[]): Promise<BlockRef> {
    this.produceBlock(1);
    // Only the root and its leaves are public here; no card value is derivable.
    return this.record('deck', handId, `${deckRoot}:${leaves.length}`);
  }

  async revealCard(
    handId: string,
    index: number,
    card: number,
    salt: string,
    proof: readonly string[],
  ): Promise<BlockRef> {
    return this.record('card', handId, `${deckRootKey(handId, index)}:${card}:${salt}:${proof.length}`);
  }

  async audit(handId: string, deckSeed: string, deck: readonly number[], salts: readonly string[]): Promise<BlockRef> {
    this.produceBlock(1);
    return this.record('audit', handId, `${deckSeed}:${deck.length}:${salts.length}`);
  }

  async isFinal(block: number, confirmations: number): Promise<boolean> {
    return this.block >= block + confirmations;
  }

  async close(): Promise<void> {
    this.stop();
  }
}

/** Keeps the local bookkeeping key readable without leaking the payload. */
function deckRootKey(handId: string, index: number): string {
  return `${handId}#${index}`;
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
    private readonly shuffleAddress: string | null,
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

  /**
   * Calls `Shuffle.sol` for every FR-6 phase. The fragments below mirror
   * `contracts/src/interfaces/IShuffle.sol`; if the contract surface changes,
   * this is the one place the server has to follow.
   *
   * NOTE: this path has never been exercised against a live RPC in this
   * repository. It refuses to construct without an RPC URL, an operator key and
   * the Shuffle address, and wager tables are only created when the adapter is
   * configured, so an unconfigured deployment fails loudly rather than silently
   * settling off-chain.
   */
  private async shuffleContract(): Promise<ShuffleContract> {
    if (!this.shuffleAddress) {
      throw new Error('on-chain anchoring requires LLMPOKER_SHUFFLE_ADDRESS');
    }
    const { Contract, Wallet } = await this.ethers();
    const provider = await this.getProvider();
    const wallet = new Wallet(this.privateKey, provider);
    const abi = [
      'function commitSeed(bytes32 handId, bytes32 seedCommitment, uint256 nonce)',
      'function commitDeck(bytes32 handId, bytes32 deckRoot, bytes32[] leaves)',
      'function revealCard(bytes32 handId, uint8 deckIndex, uint8 card, bytes32 salt, bytes32[] proof)',
      'function audit(bytes32 handId, bytes32 deckSeed, uint8[] cards, bytes32[] salts)',
    ];
    return new Contract(this.shuffleAddress, abi, wallet) as unknown as ShuffleContract;
  }

  private async handId32(handId: string): Promise<string> {
    const { keccak256, toUtf8Bytes } = await this.ethers();
    return keccak256(toUtf8Bytes(handId));
  }

  private async mined(hash: string): Promise<BlockRef> {
    const { keccak256, toUtf8Bytes } = await this.ethers();
    const provider = await this.getProvider();
    const receipt = await provider.waitForTransaction(hash);
    if (!receipt) throw new Error(`transaction ${hash} was not mined`);
    const block = await provider.getBlock(receipt.blockNumber);
    return { block: receipt.blockNumber, hash: block?.hash ?? keccak256(toUtf8Bytes(hash)), txHash: receipt.hash };
  }

  async commitSeed(handId: string, commitment: string, nonce: bigint): Promise<BlockRef> {
    const contract = await this.shuffleContract();
    const tx = await contract.commitSeed(await this.handId32(handId), commitment, nonce);
    return this.mined(tx.hash);
  }

  async commitDeck(handId: string, deckRoot: string, leaves: readonly string[]): Promise<BlockRef> {
    const contract = await this.shuffleContract();
    const tx = await contract.commitDeck(await this.handId32(handId), deckRoot, [...leaves]);
    return this.mined(tx.hash);
  }

  async revealCard(
    handId: string,
    index: number,
    card: number,
    salt: string,
    proof: readonly string[],
  ): Promise<BlockRef> {
    const contract = await this.shuffleContract();
    const tx = await contract.revealCard(await this.handId32(handId), index, card, salt, [...proof]);
    return this.mined(tx.hash);
  }

  async audit(handId: string, deckSeed: string, deck: readonly number[], salts: readonly string[]): Promise<BlockRef> {
    const contract = await this.shuffleContract();
    const tx = await contract.audit(await this.handId32(handId), deckSeed, [...deck], [...salts]);
    return this.mined(tx.hash);
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
    if (!config.contracts.shuffle) {
      throw new Error('LLMPOKER_ANCHOR=onchain requires LLMPOKER_SHUFFLE_ADDRESS (FR-6 phases live there)');
    }
    return new OnChainAnchor(config.rpcUrl, config.operatorPrivateKey, config.contracts.shuffle);
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
