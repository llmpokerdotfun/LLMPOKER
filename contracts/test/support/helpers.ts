/**
 * Shared fixture for the contracts test suite.
 *
 * Deploys the whole on-chain stack against the in-process Hardhat network (no fork, no live
 * RPC) so every test file gets the same wiring: Token → Vault → Staking → RakeSplitter →
 * Shuffle → Poker.
 */

import { ethers } from 'ethers';
import hre from 'hardhat';
import type { Signer } from 'ethers';
import { mineUpTo, takeSnapshot } from '@nomicfoundation/hardhat-network-helpers';

const BPS_DENOMINATOR = 10_000n;

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
  vault: any;
  staking: any;
  splitter: any;
  shuffle: any;
  poker: any;
  tokenAddress: Address;
  vaultAddress: Address;
  stakingAddress: Address;
  splitterAddress: Address;
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

export const TABLE_ID = ethers.encodeBytes32String('low-1');

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
    await token.getAddress(),
    await staking.getAddress(),
    await vault.getAddress(),
    await owner.getAddress(),
    5_000n,
  );
  await splitter.waitForDeployment();

  const shuffleFactory = await hre.ethers.getContractFactory('Shuffle', owner);
  const shuffle = await shuffleFactory.deploy(await owner.getAddress(), requiredConfirmations);
  await shuffle.waitForDeployment();

  const pokerFactory = await hre.ethers.getContractFactory('Poker', owner);
  const poker = await pokerFactory.deploy(
    await token.getAddress(),
    await shuffle.getAddress(),
    await splitter.getAddress(),
    await owner.getAddress(),
    await operator.getAddress(),
  );
  await poker.waitForDeployment();

  // Wiring: the splitter may only be pushed by Poker (FR-8.2), and the staking pool only
  // accrues when the splitter says so (FR-9.6).
  await splitter.connect(owner).setPoker(await poker.getAddress());
  await staking.connect(owner).grantRole(await staking.REWARDS_NOTIFIER_ROLE(), await splitter.getAddress());
  await shuffle.connect(owner).grantRole(await shuffle.OPERATOR_ROLE(), await operator.getAddress());

  // Fund the players and let Poker/Staking/Vault pull.
  const spenders = [
    await poker.getAddress(),
    await splitter.getAddress(),
    await staking.getAddress(),
    await vault.getAddress(),
  ];
  for (const player of players) {
    const address = await player.getAddress();
    await token.connect(owner).transfer(address, ethers.parseEther('2000'));
    for (const spender of spenders) {
      await token.connect(player).approve(spender, ethers.MaxUint256);
    }
  }

  return {
    owner,
    operator,
    players,
    token,
    vault,
    staking,
    splitter,
    shuffle,
    poker,
    tokenAddress: await token.getAddress(),
    vaultAddress: await vault.getAddress(),
    stakingAddress: await staking.getAddress(),
    splitterAddress: await splitter.getAddress(),
    shuffleAddress: await shuffle.getAddress(),
    pokerAddress: await poker.getAddress(),
    playerAddresses: await Promise.all(players.map((p) => p.getAddress())),
    ownerAddress: await owner.getAddress(),
    operatorAddress: await operator.getAddress(),
  };
}

/** Create the shared wager table (FR-5.1). */
export async function createWagerTable(
  stack: PokerStack,
  tableId: string = TABLE_ID,
  config: typeof TABLE_CONFIG = TABLE_CONFIG,
): Promise<void> {
  await stack.poker.connect(stack.owner).createTable(tableId, config);
}

/**
 * Commit a hand as the operator and mine just enough blocks for `reveal` to be legal.
 * @returns The commitment plus the commit block.
 */
export async function commitHand(
  stack: PokerStack,
  handId: string,
  deckSeed: string,
  nonce: bigint,
): Promise<{ commitment: string; commitBlock: number }> {
  const commitment = commitmentFor(deckSeed, nonce);
  const tx = await stack.shuffle.connect(stack.operator).commit(handId, commitment, nonce);
  const receipt = await tx.wait();
  const commitBlock = receipt!.blockNumber;
  const confirmations = BigInt(await stack.shuffle.requiredConfirmations());
  await mineUpTo(commitBlock + 1 + Number(confirmations));
  return { commitment, commitBlock };
}

/** Reveal a hand and return the parsed `Revealed` event args (FR-6.1). */
export async function revealHand(
  stack: PokerStack,
  handId: string,
  deckSeed: string,
): Promise<{ anchorBlockHash: string; entropy: string; deck: bigint[]; revealBlock: number; anchorBlock: bigint }> {
  const tx = await stack.shuffle.connect(stack.operator).reveal(handId, deckSeed);
  const receipt = await tx.wait();
  const parsed = receipt!.logs
    .map((log: any) => {
      try {
        return stack.shuffle.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((entry: any) => entry !== null && entry.name === 'Revealed');
  if (!parsed) throw new Error('Revealed event not found');
  return {
    anchorBlockHash: parsed.args.anchorBlockHash,
    entropy: parsed.args.entropy,
    deck: parsed.args.deck as bigint[],
    revealBlock: Number(parsed.args.revealBlock),
    anchorBlock: parsed.args.anchorBlock as bigint,
  };
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
