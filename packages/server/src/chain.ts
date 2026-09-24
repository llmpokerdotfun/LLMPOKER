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
import type { TableConfig } from '@llmpoker/shared';
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
  /**
   * Development chains only: ask the node to mine a block.
   *
   * A real chain produces blocks on its own, so the orchestrator simply waits. An
   * automining development node only mines when a transaction arrives, so a
   * multi-phase commit would otherwise wait forever for its own anchor block.
   * Never set on a public network.
   */
  advanceBlock?(): Promise<void>;
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
    private readonly canMineBlocks = false,
    private readonly rpcPollMs = 250,
  ) {
    if (!rpcUrl || !privateKey) throw new Error('on-chain anchoring requires RH_RPC_URL and an operator private key');
  }

  /** Development only: `evm_mine`, so an automining node can advance (see the interface). */
  async advanceBlock(): Promise<void> {
    if (!this.canMineBlocks) return;
    const provider = await this.getProvider();
    await provider.send('evm_mine', []);
  }

  private async ethers(): Promise<typeof import('ethers')> {
    return import('ethers');
  }

  private async getProvider(): Promise<import('ethers').JsonRpcProvider> {
    if (!this.provider) {
      const { JsonRpcProvider } = await this.ethers();
      // Ethers polls receipts every 4s by default, which dominates the wall clock
      // of a multi-transaction hand; and a nonce cache would make rapid
      // consecutive transactions from the operator key collide.
      this.provider = new JsonRpcProvider(this.rpcUrl, undefined, {
        pollingInterval: this.rpcPollMs,
        cacheTimeout: 0,
      });
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
    return new OnChainAnchor(
      config.rpcUrl,
      config.operatorPrivateKey,
      config.contracts.shuffle,
      config.mineBlocks,
      config.rpcPollMs,
    );
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

/** Chips one seat moved into the pot, seat-aligned with the `openHand` seat list. */
export interface SeatContribution {
  seat: number;
  amount: bigint;
}

export interface SettleHandParams {
  tableId: string;
  handId: string;
  /** Per-seat contributions, seat-aligned with the order passed to `openHand`. */
  contributions: SeatContribution[];
  winners: number[];
  /** Awards per winner; must sum to `pot - rake` or the contract reverts. */
  awards: bigint[];
  sawFlop: boolean;
  /** The rake the engine computed. The contract computes its own and rejects a mismatch. */
  rake: bigint;
}

/**
 * Settlement surface used by the wager orchestrator (FR-5).
 *
 * The chain is the source of truth for escrow, and the trust split is deliberate
 * (FR-5.3): **agents** deposit and cash out with their own keys — `Poker.deposit`
 * and `Poker.cashOut` are `msg.sender`-based and the operator is banned from
 * seating itself (FR-10.3) — while the **operator** only opens, commits and
 * settles hands. That is why `clientSideDeposits` exists: the server can only
 * *verify* an on-chain balance, never move an agent's tokens.
 */
export interface SettlementAdapter {
  readonly kind: 'LOCAL' | 'ONCHAIN' | 'NONE';
  /** True when deposits are the agent's own on-chain transaction. */
  readonly clientSideDeposits: boolean;
  /** Escrow the chain holds for a seat (FR-5.1). */
  escrowOf(tableId: string, seat: number): Promise<bigint>;
  /** Creates the table on-chain if needed (owner-only). `null` when it already exists. */
  ensureTable(config: TableConfig): Promise<SettlementReceipt | null>;
  /** FR-5.1/5.2: registers the participating seats before any chip is committed. */
  openHand(tableId: string, handId: string, seats: number[]): Promise<SettlementReceipt | null>;
  /** FR-5.2: moves one seat's contribution out of escrow into the pot. */
  commitHand(tableId: string, handId: string, seat: number, amount: bigint): Promise<SettlementReceipt | null>;
  /** FR-5.2/5.4: verifies the pot, takes rake on-chain and credits the winners. */
  settleHand(params: SettleHandParams): Promise<SettlementReceipt>;
  /** FR-5.6/6.6: voids a hand and restores every contribution to escrow. */
  voidHand(tableId: string, handId: string): Promise<SettlementReceipt | null>;
  /** Local mirror only; on-chain deposits are the agent's own transaction. */
  deposit(agentId: string, tableId: string, amount: bigint): Promise<SettlementReceipt | null>;
  /** Local mirror only; on-chain cash-outs are the agent's own transaction. */
  cashOut(agentId: string, tableId: string, amount: bigint): Promise<SettlementReceipt | null>;
  /**
   * Mirror-only settlement, applying each agent's net result. The local ledger
   * holds an agent's whole claim, so it settles by net; on-chain mode settles
   * through `settleHand` with explicit per-seat contributions instead.
   */
  settleMirror?(
    tableId: string,
    handId: string,
    moves: { agentId: string; delta: bigint }[],
    rake: bigint,
  ): Promise<SettlementReceipt>;
  balances(): Map<string, bigint>;
  /** Rake booked so far, as the adapter sees it (the splitter holds it on-chain). */
  houseBalance(): bigint;
  close(): Promise<void>;
}

export class LocalEscrow implements SettlementAdapter {
  readonly kind = 'LOCAL' as const;
  readonly clientSideDeposits = false;
  private readonly accounts = new Map<string, bigint>();
  private house = 0n;
  private block = 0;
  /** Local mirrors accept an openHand/commitHand call without doing anything. */
  private readonly openHands = new Map<string, Set<number>>();

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

  async escrowOf(tableId: string, seat: number): Promise<bigint> {
    const entry = [...this.accounts.entries()].find(([k]) => k.startsWith(`${tableId}:`) && k.endsWith(`#${seat}`));
    return entry ? entry[1] : 0n;
  }

  async ensureTable(_config: TableConfig): Promise<SettlementReceipt | null> {
    return null;
  }

  async openHand(tableId: string, handId: string, seats: number[]): Promise<SettlementReceipt | null> {
    this.openHands.set(`${tableId}:${handId}`, new Set(seats));
    return null;
  }

  async commitHand(): Promise<SettlementReceipt | null> {
    return null;
  }

  async voidHand(): Promise<SettlementReceipt | null> {
    return null;
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

  /** The local mirror settles by net delta: it holds the agent's whole claim. */
  async settleHand(params: SettleHandParams): Promise<SettlementReceipt> {
    const deltas = new Map<string, bigint>();
    for (const contribution of params.contributions) {
      deltas.set(String(contribution.seat), -(contribution.amount ?? 0n));
    }
    // The mirror is keyed by agent, so the caller passes net moves separately;
    // see `settle()` below, which is what the orchestrator uses for LOCAL mode.
    if (params.rake > 0n) this.house += params.rake;
    return this.receipt(`settle:${params.tableId}:${params.handId}`);
  }

  /** Mirror-mode settlement: apply each agent's net result and book the rake. */
  settleMirror(
    tableId: string,
    handId: string,
    moves: { agentId: string; delta: bigint }[],
    rake: bigint,
  ): Promise<SettlementReceipt> {
    return this.settle(tableId, handId, moves, rake);
  }

  /** Mirror-mode settlement: apply each agent's net result and book the rake. */
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

  async close(): Promise<void> {
    // nothing to release
  }
}

/** The `Poker.sol` surface the operator drives, mirroring `contracts/src/Poker.sol`. */
interface PokerContract {
  createTable(tableId: string, config: Record<string, unknown>): Promise<{ hash: string }>;
  openHand(tableId: string, handId: string, seats: number[]): Promise<{ hash: string }>;
  commitHand(tableId: string, handId: string, seat: number, amount: bigint): Promise<{ hash: string }>;
  settleHand(
    tableId: string,
    handId: string,
    contributions: bigint[],
    winners: number[],
    awards: bigint[],
    sawFlop: boolean,
  ): Promise<{ hash: string }>;
  voidHand(tableId: string, handId: string): Promise<{ hash: string }>;
  tableConfigOf(tableId: string): Promise<{ maxSeats: bigint } & unknown[]>;
  escrowBalanceOf(tableId: string, seat: number): Promise<bigint>;
  computeRake(
    pot: bigint,
    rakeBps: bigint,
    rakeCap: bigint,
    sawFlop: boolean,
    onlyWithFlop: boolean,
  ): Promise<bigint>;
  paused(): Promise<boolean>;
}

/**
 * Real settlement against a deployed `Poker.sol`.
 *
 * Deposits and cash-outs are deliberately absent: `Poker.deposit`/`cashOut` are
 * `msg.sender`-based precisely so the operator can never move an agent's tokens
 * (FR-5.3), so the server only *reads* escrow and drives the hand lifecycle.
 */
export class OnChainSettlement implements SettlementAdapter {
  readonly kind = 'ONCHAIN' as const;
  readonly clientSideDeposits = true;
  private provider: import('ethers').JsonRpcProvider | null = null;
  private poker: PokerContract | null = null;
  private rakeBooked = 0n;
  private readonly knownTables = new Set<string>();

  constructor(
    private readonly rpcUrl: string,
    private readonly privateKey: string,
    private readonly addresses: { poker: string; token: string },
    private readonly rpcPollMs = 250,
  ) {
    if (!rpcUrl || !privateKey) throw new Error('on-chain settlement requires an RPC URL and an operator key');
    if (!addresses.poker || !addresses.token) {
      throw new Error('on-chain settlement requires LLMPOKER_POKER_ADDRESS and LLMPOKER_TOKEN_ADDRESS');
    }
  }

  private async ethers(): Promise<typeof import('ethers')> {
    return import('ethers');
  }

  private async getProvider(): Promise<import('ethers').JsonRpcProvider> {
    if (!this.provider) {
      const { JsonRpcProvider } = await this.ethers();
      this.provider = new JsonRpcProvider(this.rpcUrl, undefined, {
        pollingInterval: this.rpcPollMs,
        cacheTimeout: 0,
      });
    }
    return this.provider;
  }

  private async getPoker(): Promise<PokerContract> {
    if (!this.poker) {
      const { Contract, Wallet } = await this.ethers();
      const provider = await this.getProvider();
      const abi = [
        'function createTable(bytes32 tableId, (uint256 smallBlind,uint256 bigBlind,uint256 minBuyIn,uint256 maxBuyIn,uint16 rakeBps,uint256 rakeCap,uint8 maxSeats) config)',
        'function openHand(bytes32 tableId, bytes32 handId, uint8[] seats)',
        'function commitHand(bytes32 tableId, bytes32 handId, uint8 seat, uint256 amount)',
        'function settleHand(bytes32 tableId, bytes32 handId, uint256[] contributions, uint8[] winners, uint256[] awards, bool sawFlop)',
        'function voidHand(bytes32 tableId, bytes32 handId)',
        'function tableConfigOf(bytes32 tableId) view returns ((uint256 smallBlind,uint256 bigBlind,uint256 minBuyIn,uint256 maxBuyIn,uint16 rakeBps,uint256 rakeCap,uint8 maxSeats))',
        'function escrowBalanceOf(bytes32 tableId, uint8 seat) view returns (uint256)',
        'function computeRake(uint256 pot, uint256 rakeBps, uint256 rakeCap, bool sawFlop, bool onlyWithFlop) pure returns (uint256)',
        'function paused() view returns (bool)',
      ];
      this.poker = new Contract(this.addresses.poker, abi, new Wallet(this.privateKey, provider)) as unknown as PokerContract;
    }
    return this.poker;
  }

  /** `tableId`/`handId` are the server's strings, hashed to the contract's `bytes32`. */
  private async id32(value: string): Promise<string> {
    const { keccak256, toUtf8Bytes } = await this.ethers();
    return keccak256(toUtf8Bytes(value));
  }

  private async mined(hash: string): Promise<SettlementReceipt> {
    const provider = await this.getProvider();
    const receipt = await provider.waitForTransaction(hash);
    if (!receipt) throw new Error(`transaction ${hash} was not mined`);
    return { kind: 'ONCHAIN', txHash: receipt.hash, block: receipt.blockNumber };
  }

  async escrowOf(tableId: string, seat: number): Promise<bigint> {
    const poker = await this.getPoker();
    return (await poker.escrowBalanceOf(await this.id32(tableId), seat)) as bigint;
  }

  async ensureTable(config: TableConfig): Promise<SettlementReceipt | null> {
    const poker = await this.getPoker();
    const tableId = await this.id32(config.id);
    if (this.knownTables.has(config.id)) return null;

    // `tableConfigOf` reverts with `UnknownTable` rather than returning zeros, so
    // a revert here means "not created yet" — which is exactly the case we create for.
    let exists = false;
    try {
      const existing = (await poker.tableConfigOf(tableId)) as unknown as { maxSeats: bigint };
      exists = Number(existing?.maxSeats ?? 0) > 0;
    } catch {
      exists = false;
    }
    if (exists) {
      this.knownTables.add(config.id);
      return null;
    }

    const tx = await poker.createTable(tableId, {
      smallBlind: config.smallBlind,
      bigBlind: config.bigBlind,
      minBuyIn: config.minBuyIn,
      maxBuyIn: config.maxBuyIn,
      rakeBps: config.rakeBps,
      rakeCap: config.rakeCap,
      maxSeats: config.maxSeats,
    });
    const receipt = await this.mined(tx.hash);
    this.knownTables.add(config.id);
    return { ...receipt, note: `createTable:${config.id}` };
  }

  async openHand(tableId: string, handId: string, seats: number[]): Promise<SettlementReceipt | null> {
    const poker = await this.getPoker();
    const tx = await poker.openHand(await this.id32(tableId), await this.id32(handId), seats);
    return { ...(await this.mined(tx.hash)), note: `openHand:${handId}` };
  }

  async commitHand(tableId: string, handId: string, seat: number, amount: bigint): Promise<SettlementReceipt | null> {
    if (amount === 0n) return null;
    const poker = await this.getPoker();
    const tx = await poker.commitHand(await this.id32(tableId), await this.id32(handId), seat, amount);
    return { ...(await this.mined(tx.hash)), note: `commitHand:${handId}:${seat}` };
  }

  /**
   * FR-5.2/5.4: the contract recomputes the rake from its own schedule and rejects
   * a settlement whose awards do not equal `pot - rake`. We ask it for its figure
   * first so an engine/contract rake divergence is reported as a clear error
   * rather than a bare revert.
   */
  async settleHand(params: SettleHandParams): Promise<SettlementReceipt> {
    const poker = await this.getPoker();
    const tableId = await this.id32(params.tableId);
    const handId = await this.id32(params.handId);

    const ordered = [...params.contributions].sort((a, b) => a.seat - b.seat);
    const contributions = ordered.map((c) => c.amount);
    const pot = contributions.reduce((acc, amount) => acc + amount, 0n);
    const config = (await poker.tableConfigOf(tableId)) as unknown as { rakeBps: bigint; rakeCap: bigint };
    const onChainRake = await poker.computeRake(pot, config.rakeBps, config.rakeCap, params.sawFlop, true);
    if (onChainRake !== params.rake) {
      throw new Error(
        `rake divergence: the engine computed ${params.rake} but Poker.sol computes ${onChainRake} ` +
          `(pot ${pot}, bps ${config.rakeBps}, cap ${config.rakeCap}, sawFlop ${params.sawFlop})`,
      );
    }

    // Collateralise the pot exactly as the engine declared it (FR-5.2).
    for (const contribution of ordered) {
      await this.commitHand(params.tableId, params.handId, contribution.seat, contribution.amount);
    }

    const tx = await poker.settleHand(tableId, handId, contributions, params.winners, params.awards, params.sawFlop);
    const receipt = await this.mined(tx.hash);
    this.rakeBooked += params.rake;
    return { ...receipt, note: `settleHand:${params.handId}` };
  }

  async voidHand(tableId: string, handId: string): Promise<SettlementReceipt | null> {
    const poker = await this.getPoker();
    const tx = await poker.voidHand(await this.id32(tableId), await this.id32(handId));
    return { ...(await this.mined(tx.hash)), note: `voidHand:${handId}` };
  }

  async deposit(): Promise<null> {
    throw new Error(
      'agents deposit their own token on-chain (Poker.deposit is msg.sender-based, FR-5.3); ' +
        'the server only verifies the resulting escrow balance',
    );
  }

  async cashOut(): Promise<null> {
    throw new Error(
      'agents cash out their own escrow on-chain (Poker.cashOut is msg.sender-based, FR-5.5); ' +
        'the server only verifies the resulting escrow balance',
    );
  }

  balances(): Map<string, bigint> {
    // On-chain escrow is per (table, seat), not per agent; read it with escrowOf().
    return new Map();
  }

  houseBalance(): bigint {
    return this.rakeBooked;
  }

  async close(): Promise<void> {
    this.provider?.destroy();
    this.provider = null;
    this.poker = null;
  }
}

export function createSettlement(config: ServerConfig): SettlementAdapter {
  if (config.settlement === 'onchain') {
    if (!config.rpcUrl || !config.operatorPrivateKey || !config.contracts.poker || !config.contracts.token) {
      throw new Error(
        'LLMPOKER_SETTLEMENT=onchain requires RH_RPC_URL (or LOCALHOST_RPC_URL), an operator key, ' +
          'LLMPOKER_POKER_ADDRESS and LLMPOKER_TOKEN_ADDRESS',
      );
    }
    return new OnChainSettlement(
      config.rpcUrl,
      config.operatorPrivateKey,
      { poker: config.contracts.poker, token: config.contracts.token },
      config.rpcPollMs,
    );
  }
  return new LocalEscrow();
}
