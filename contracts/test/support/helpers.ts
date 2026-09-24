/**
 * Shared fixture for the contracts test suite.
 *
 * Deploys the whole on-chain stack against the in-process Hardhat network (no fork, no live
 * RPC) so every test file gets the same wiring: Token → Vault → Staking → RakeSplitter →
 * BuybackBurner → Shuffle → Poker.
 *
 * The fixture also deploys a **USDG stand-in** (`MockDecimalsToken`, 6 decimals) so the suite can
 * prove that per-table settlement currencies never mix, and it wires the buyback leg end to end
 * (`splitter.setBuyback(burner)`, `burner.setSplitter(splitter)`).
 */

import { ethers } from 'ethers';
import hre from 'hardhat';
import type { Signer } from 'ethers';
import { mineUpTo, takeSnapshot } from '@nomicfoundation/hardhat-network-helpers';

import { cardProof, commitmentForDeck, type DeckCommitment } from './merkle';

const BPS_DENOMINATOR = 10_000n;

/** `USDG` decimals — the whole point of the dual-currency tests (SRS §6, FR-5.1). */
export const USDG_DECIMALS = 6n;

/** One USDG in base units (`1e6`), as opposed to `ethers.parseEther` for LLMPOKER. */
export function usdg(amount: string): bigint {
  return ethers.parseUnits(amount, Number(USDG_DECIMALS));
}

/** Rake defaults mirrored from `packages/shared/src/config.ts` and `Poker.DEFAULT_*`. */
export const RAKE = {
  /** `DEFAULT_RAKE_BPS` (FR-8.1). */
  bps: 250n,
  /** `DEFAULT_RAKE_CAP` = 0.05 token (FR-8.1). */
  cap: 50_000_000_000_000_000n,
} as const;

/** `UNSTAKE_COOLDOWN_SECONDS` from `packages/shared/src/config.ts` (FR-9.5). */
export const UNSTAKE_COOLDOWN_SECONDS = 7n * 24n * 60n * 60n;

/** `DEFAULT_CONFIRMATIONS` from `packages/shared/src/config.ts` (FR-6.5). */
export const DEFAULT_CONFIRMATIONS = 12n;

export type TableId = string;
export type HandId = string;
export type Address = string;

/** A deployed, fully wired stack plus its signers. */
export interface PokerStack {
  owner: Signer;
  operator: Signer;
  players: Signer[];
  token: any;
  usdg: any;
  vault: any;
  staking: any;
  splitter: any;
  buybackBurner: any;
  shuffle: any;
  poker: any;
  tokenAddress: Address;
  usdgAddress: Address;
  vaultAddress: Address;
  stakingAddress: Address;
  splitterAddress: Address;
  buybackBurnerAddress: Address;
  shuffleAddress: Address;
  pokerAddress: Address;
  playerAddresses: Address[];
  ownerAddress: Address;
  operatorAddress: Address;
}

/** The wager-table configuration used across the Poker tests (mirrors the `'low'` tier). */
export const TABLE_CONFIG = {
  smallBlind: 50_000_000_000_000_000n, // 0.05
  bigBlind: 100_000_000_000_000_000n, // 0.1
  minBuyIn: 5_000_000_000_000_000_000n, // 5
  maxBuyIn: 25_000_000_000_000_000_000n, // 25
  rakeBps: RAKE.bps,
  rakeCap: RAKE.cap,
  maxSeats: 6,
} as const;

/**
 * The USDG-denominated table: the same 6-max shape, expressed in 6-decimal base units.
 * `5_000_000n` is 5 USDG (not 5e18), which is exactly the decimal-agnosticism the contract
 * claims: only the off-chain amounts change.
 */
export const USDG_TABLE_CONFIG = {
  smallBlind: 50_000n, // 0.05 USDG
  bigBlind: 100_000n, // 0.10 USDG
  minBuyIn: 5_000_000n, // 5 USDG
  maxBuyIn: 25_000_000n, // 25 USDG
  rakeBps: RAKE.bps,
  rakeCap: 500_000n, // 0.5 USDG (250 bps of a 60 USDG pot = 1.5, so the cap binds)
  maxSeats: 6,
} as const;

export const TABLE_ID = ethers.encodeBytes32String('low-1');
export const USDG_TABLE_ID = ethers.encodeBytes32String('usdg-1');

/** `keccak256(abi.encodePacked(bytes32 tableId, uint8 seat))`, mirroring `Poker._seatKey`. */
export function seatKey(tableId: TableId, seat: number): string {
  return ethers.keccak256(ethers.solidityPacked(['bytes32', 'uint8'], [tableId, seat]));
}

/** `entropy = keccak256(abi.encodePacked(bytes32 deckSeed, bytes32 anchorBlockHash))` (RNG.md §2). */
export function entropyFrom(deckSeed: string, anchorBlockHash: string): string {
  return ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes32'], [deckSeed, anchorBlockHash]));
}

/** `commitment = keccak256(abi.encodePacked(bytes32 deckSeed, uint256 nonce))` (RNG.md §1). */
export function commitmentFor(deckSeed: string, nonce: bigint | number): string {
  return ethers.keccak256(ethers.solidityPacked(['bytes32', 'uint256'], [deckSeed, nonce]));
}

/** Bond the operator must hold to commit hands (FR-6.5); tests use a small value. */
export const TEST_REQUIRED_BOND = ethers.parseEther('100');

/** Post-`commitDeck` audit grace, at the contract minimum to keep tests cheap (FR-6.7). */
export const TEST_AUDIT_GRACE_BLOCKS = 64n;

/** `Shuffle.Phase` mirror (FR-6.1–6.4). */
export const PHASE = {
  None: 0n,
  SeedCommitted: 1n,
  DeckCommitted: 2n,
  Audited: 3n,
  Voided: 4n,
} as const;

/** `Shuffle.VoidReason` mirror (FR-6.7). */
export const VOID_REASON = {
  NoDeckCommitment: 0n,
  AuditStalled: 1n,
} as const;

/**
 * Deploy the full stack.
 * @param requiredConfirmations Shuffle finality threshold (FR-6.5); tests use small values to
 *        keep block mining cheap while still exercising the ordering constraint.
 */
export async function deployStack(requiredConfirmations: bigint = 12n): Promise<PokerStack> {
  const signers = await hre.ethers.getSigners();
  const owner = signers[0]!;
  const operator = signers[1]!;
  const players = signers.slice(2, 8);

  const tokenFactory = await hre.ethers.getContractFactory('Token', owner);
  const token = await tokenFactory.deploy(
    'LLM Poker Arena',
    'POKER',
    ethers.parseEther('1000000'),
    await owner.getAddress(),
    0n,
  );
  await token.waitForDeployment();

  const vaultFactory = await hre.ethers.getContractFactory('Vault', owner);
  const vault = await vaultFactory.deploy(await token.getAddress(), await owner.getAddress(), 5_000n);
  await vault.waitForDeployment();

  // USDG stand-in: a 6-decimal stablecoin. The real address is supply-time configuration
  // (`USDG_ADDRESS`); nothing in `src/` hard-codes one, which is what this fixture proves.
  const usdgFactory = await hre.ethers.getContractFactory('MockDecimalsToken', owner);
  const usdgToken = await usdgFactory.deploy('USDG', 'USDG', Number(USDG_DECIMALS));
  await usdgToken.waitForDeployment();

  const stakingFactory = await hre.ethers.getContractFactory('Staking', owner);
  const staking = await stakingFactory.deploy(
    await token.getAddress(),
    await owner.getAddress(),
    UNSTAKE_COOLDOWN_SECONDS,
    ethers.parseEther('1'),
  );
  await staking.waitForDeployment();

  const splitterFactory = await hre.ethers.getContractFactory('RakeSplitter', owner);
  const splitter = await splitterFactory.deploy(
    await staking.getAddress(),
    await vault.getAddress(),
    await owner.getAddress(),
    5_000n,
  );
  await splitter.waitForDeployment();

  // The buyback-and-burn leg: no router configured, which is the expected pre-launch state.
  const burnerFactory = await hre.ethers.getContractFactory('BuybackBurner', owner);
  const buybackBurner = await burnerFactory.deploy(await token.getAddress(), await owner.getAddress(), 0n);
  await buybackBurner.waitForDeployment();

  const shuffleFactory = await hre.ethers.getContractFactory('Shuffle', owner);
  const shuffle = await shuffleFactory.deploy(
    await token.getAddress(),
    await owner.getAddress(),
    requiredConfirmations,
    TEST_AUDIT_GRACE_BLOCKS,
    TEST_REQUIRED_BOND,
  );
  await shuffle.waitForDeployment();

  const pokerFactory = await hre.ethers.getContractFactory('Poker', owner);
  const poker = await pokerFactory.deploy(
    await shuffle.getAddress(),
    await splitter.getAddress(),
    await owner.getAddress(),
    await operator.getAddress(),
  );
  await poker.waitForDeployment();

  // Wiring: the splitter may only be pushed by Poker (FR-8.2), the staking pool only accrues
  // when the splitter says so (FR-9.6), and the buyback leg is credited to the burner, which in
  // turn only accepts fees from the splitter (FR-8.2).
  //
  // `getContractFactory().deploy()` is typed as `BaseContract`, which does not expose the
  // generated `Contract` index signature, so the wiring calls go through `ethers.Contract`
  // views. The `any` typed handles returned by this fixture keep the test files untyped.
  const splitterContract = splitter as ethers.Contract;
  const stakingContract = staking as ethers.Contract;
  const shuffleContract = shuffle as ethers.Contract;
  const tokenContract = token as ethers.Contract;
  const usdgContract = usdgToken as ethers.Contract;
  const burnerContract = buybackBurner as ethers.Contract;
  await splitterContract.setPoker!(await poker.getAddress());
  await splitterContract.setBuyback!(await buybackBurner.getAddress());
  await burnerContract.setSplitter!(await splitter.getAddress());
  await stakingContract.grantRole!(
    (await stakingContract.REWARDS_NOTIFIER_ROLE!()) as string,
    await splitter.getAddress(),
  );
  await shuffleContract.grantRole!((await shuffleContract.OPERATOR_ROLE!()) as string, await operator.getAddress());

  // Fund the operator and post its FR-6.5 bond.
  await (tokenContract.connect(owner) as ethers.Contract).transfer!(
    await operator.getAddress(),
    ethers.parseEther('2000'),
  );
  await (tokenContract.connect(operator) as ethers.Contract).approve!(
    await shuffle.getAddress(),
    ethers.MaxUint256,
  );
  await (shuffleContract.connect(operator) as ethers.Contract).postBond!(TEST_REQUIRED_BOND);

  // The deployer holds both currencies too, so tests can act as an external fee source.
  await (usdgContract.connect(owner) as ethers.Contract).mint!(await owner.getAddress(), usdg('1000000'));

  // Fund the players with both currencies and let Poker/Staking/Vault/Splitter pull.
  const spenders = [
    await poker.getAddress(),
    await splitter.getAddress(),
    await staking.getAddress(),
    await vault.getAddress(),
  ];
  for (const player of players) {
    const address = await player.getAddress();
    await (tokenContract.connect(owner) as ethers.Contract).transfer!(address, ethers.parseEther('2000'));
    // 1,000,000 USDG (6 decimals) per player is plenty for every wager test.
    await (usdgContract.connect(owner) as ethers.Contract).mint!(address, usdg('1000000'));
    for (const spender of spenders) {
      await (tokenContract.connect(player) as ethers.Contract).approve!(spender, ethers.MaxUint256);
      await (usdgContract.connect(player) as ethers.Contract).approve!(spender, ethers.MaxUint256);
    }
  }

  return {
    owner,
    operator,
    players,
    token,
    usdg: usdgToken,
    vault,
    staking,
    splitter,
    buybackBurner,
    shuffle,
    poker,
    tokenAddress: await token.getAddress(),
    usdgAddress: await usdgToken.getAddress(),
    vaultAddress: await vault.getAddress(),
    stakingAddress: await staking.getAddress(),
    splitterAddress: await splitter.getAddress(),
    buybackBurnerAddress: await buybackBurner.getAddress(),
    shuffleAddress: await shuffle.getAddress(),
    pokerAddress: await poker.getAddress(),
    playerAddresses: await Promise.all(players.map((p) => p.getAddress())),
    ownerAddress: await owner.getAddress(),
    operatorAddress: await operator.getAddress(),
  };
}

/** Create the shared LLMPOKER wager table (FR-5.1). */
export async function createWagerTable(
  stack: PokerStack,
  tableId: string = TABLE_ID,
  config: typeof TABLE_CONFIG = TABLE_CONFIG,
  settlementToken?: string,
): Promise<void> {
  await stack.poker
    .connect(stack.owner)
    .createTable(tableId, config, settlementToken ?? stack.tokenAddress);
}

/** Create the USDG-denominated wager table (FR-5.1, dual-currency). */
export async function createUsdgWagerTable(
  stack: PokerStack,
  tableId: string = USDG_TABLE_ID,
  config: typeof USDG_TABLE_CONFIG = USDG_TABLE_CONFIG,
): Promise<void> {
  await stack.poker.connect(stack.owner).createTable(tableId, config, stack.usdgAddress);
}

/**
 * FR-6.1 phase 1: commit the seed and mine until phase 2 is legal.
 *
 * The deck commitment is built **before** any further mining: Hardhat only serves
 * `blockhash`/`getBlock` for the most recent 256 blocks, so reading the anchor any later would
 * lose it. This mirrors what the operator must do in production.
 *
 * @returns The seed commitment, the commit block, and the deck commitment to publish at phase 2.
 */
export async function commitSeedPhase(stack: PokerStack, handId: string, deckSeed: string, nonce: bigint) {
  const seedCommitment = commitmentFor(deckSeed, nonce);
  const receipt = await (await stack.shuffle.connect(stack.operator).commitSeed(handId, seedCommitment, nonce)).wait();
  const commitBlock = receipt!.blockNumber;
  const anchorBlock = commitBlock + 1;

  // Mine to the anchor, read its hash (only possible once it exists, and only for 256 blocks),
  // then mine out the confirmations. This mirrors the sequence a production operator follows.
  await mineUpTo(anchorBlock);
  const anchor = await hre.ethers.provider.getBlock(anchorBlock);
  if (!anchor?.hash) throw new Error(`anchor block ${anchorBlock} is not readable`);
  const anchorBlockHash = anchor.hash;

  const confirmations = BigInt(await stack.shuffle.requiredConfirmations());
  await mineUpTo(anchorBlock + Number(confirmations));

  const deck = await derivedDeckFromHash(stack, deckSeed, anchorBlockHash);
  const commitmentRecord = commitmentForDeck(handId, deck);
  return { seedCommitment, commitBlock, anchorBlock, anchorBlockHash, deck, commitmentRecord };
}

/**
 * FR-6.2 phase 2: publish the Merkle deck root and capture the anchor hash.
 * @returns The parsed `DeckCommitted` args.
 */
export async function commitDeckPhase(
  stack: PokerStack,
  handId: string,
  commitmentRecord: DeckCommitment,
): Promise<{ deckRoot: string; anchorBlockHash: string; anchorBlock: bigint; confirmations: bigint }> {
  const receipt = await (
    await stack.shuffle.connect(stack.operator).commitDeck(handId, commitmentRecord.root, commitmentRecord.leaves)
  ).wait();
  const parsed = parseShuffleLog(stack, receipt, 'DeckCommitted');
  return {
    deckRoot: parsed.args[1],
    anchorBlockHash: parsed.args[5],
    anchorBlock: parsed.args[4] as bigint,
    confirmations: parsed.args[6] as bigint,
  };
}

/**
 * Build a *deliberately rigged* deck commitment: the real deck with two cards swapped.
 *
 * `DeckCommitted` cannot detect this (only the root's internal consistency is checkable at phase
 * 2), which is precisely the trust window the FR-6.5 bond prices; the audit slashes it.
 */
export function riggedCommitment(handId: string, realDeck: number[]): DeckCommitment {
  const rigged = [...realDeck];
  [rigged[0], rigged[1]] = [rigged[1]!, rigged[0]!];
  return commitmentForDeck(handId, rigged);
}

/**
 * Run phases 1 and 2 for a hand: commit the seed, wait out the confirmations, then commit the
 * deck root built from the deck that `(seed, anchorBlockHash)` actually derives.
 * @returns The deck, its commitment record and the block data verifiers need.
 */
export async function commitHiddenDeck(stack: PokerStack, handId: string, deckSeed: string, nonce: bigint) {
  const { seedCommitment, commitBlock, deck, commitmentRecord } = await commitSeedPhase(stack, handId, deckSeed, nonce);
  const committed = await commitDeckPhase(stack, handId, commitmentRecord);
  return { seedCommitment, commitBlock, deck, commitmentRecord, ...committed };
}

/** FR-6.3: publish one card with its proof. */
export async function revealCardPhase(
  stack: PokerStack,
  handId: string,
  commitmentRecord: DeckCommitment,
  index: number,
): Promise<number> {
  const card = commitmentRecord.deck[index]!;
  const salt = commitmentRecord.salts[index]!;
  const proof = cardProof(commitmentRecord, index);
  await stack.shuffle.connect(stack.operator).revealCard(handId, index, card, salt, proof);
  return card;
}

/** FR-6.4: run the end-of-hand audit against the committed deck. */
export async function auditPhase(
  stack: PokerStack,
  handId: string,
  deckSeed: string,
  commitmentRecord: DeckCommitment,
): Promise<void> {
  await stack.shuffle.connect(stack.operator).audit(handId, deckSeed, commitmentRecord.deck, commitmentRecord.salts);
}

/** Parse a named event out of a receipt produced by the `Shuffle` contract. */
export function parseShuffleLog(stack: PokerStack, receipt: any, name: string): any {
  const parsed = receipt.logs
    .map((log: any) => {
      try {
        return stack.shuffle.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((entry: any) => entry !== null && entry.name === name);
  if (!parsed) throw new Error(`${name} event not found`);
  return parsed;
}

/**
 * The deck that `(deckSeed, blockhash(anchorBlock))` actually derives, computed through the
 * contract's pure `computeDeck` (`docs/RNG.md` §3). The vector suite separately proves that
 * function reproduces the committed vectors, so using it here is not circular.
 *
 * A happy-path audit compares the *real* derived deck against the committed root, so tests that
 * expect a successful audit must run phases 2–4 over this ordering.
 */
export async function derivedDeckFromHash(stack: PokerStack, deckSeed: string, anchorBlockHash: string): Promise<number[]> {
  const entropy = entropyFrom(deckSeed, anchorBlockHash);
  const deck = (await stack.shuffle.computeDeck(entropy)) as bigint[];
  return Array.from(deck, (card) => Number(card));
}

/**
 * Convenience wrapper: read the anchor hash from the chain (only possible within the 256-block
 * `blockhash` window) and derive the deck from it.
 */
export async function derivedDeck(stack: PokerStack, deckSeed: string, anchorBlockNumber: number): Promise<number[]> {
  const anchor = await hre.ethers.provider.getBlock(anchorBlockNumber);
  if (!anchor?.hash) throw new Error(`anchor block ${anchorBlockNumber} is outside the blockhash window`);
  return derivedDeckFromHash(stack, deckSeed, anchor.hash);
}

/** Deterministic 32-byte seed for a hand's RNG. */
export function seedFor(handId: string): string {
  return ethers.keccak256(ethers.solidityPacked(['string', 'bytes32'], ['seed', handId]));
}

/** Deterministic 32-byte `handId`. */
export function handIdFor(label: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

/** Rake for a pot, mirroring `Poker.computeRake` and `computeRake` in shared `config.ts` (FR-8.1). */
export function expectedRake(pot: bigint, rakeBps: bigint, rakeCap: bigint, sawFlop: boolean): bigint {
  if (rakeBps === 0n) return 0n;
  if (!sawFlop) return 0n;
  const raw = (pot * rakeBps) / BPS_DENOMINATOR;
  return raw > rakeCap ? rakeCap : raw;
}

/**
 * Snapshot/restore fixture.
 *
 * Deploying the whole stack costs ~40 blocks of token transfers, so each `describe` block
 * deploys once in `before` and every test starts from that snapshot. `restore` also rewinds the
 * block number and timestamp, so block-window (FR-6.1) and cooldown (FR-9.5) tests stay
 * deterministic.
 */
export interface SnapshotFixture {
  stack: PokerStack;
  reset(): Promise<void>;
}

export async function snapshotFixture(requiredConfirmations: bigint = 2n): Promise<SnapshotFixture> {
  const stack = await deployStack(requiredConfirmations);
  const snapshot = await takeSnapshot();
  return {
    stack,
    async reset() {
      await snapshot.restore();
    },
  };
}
