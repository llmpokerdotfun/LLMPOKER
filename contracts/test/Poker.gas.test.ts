/**
 * Gas / complexity guarantees (NFR-3).
 *
 * Wager settlement must be O(seats) in storage operations. These tests assert that a full
 * 6-seat hand settles comfortably inside a block, that the cost grows roughly linearly (not
 * quadratically) in the seat count, and they print the measured gas so the number is visible in
 * the test output rather than merely asserted.
 */

import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

import {
  RAKE,
  TABLE_CONFIG,
  TABLE_ID,
  USDG_TABLE_CONFIG,
  USDG_TABLE_ID,
  commitHiddenDeck,
  createUsdgWagerTable,
  createWagerTable,
  derivedDeckFromHash,
  snapshotFixture,
  usdg,
  type PokerStack,
  type SnapshotFixture,
} from './support/helpers';
import { cardProof, commitmentForDeck } from './support/merkle';

const LEGAL_BUY_IN = ethers.parseEther('20');

function handIdOf(label: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

describe('Poker gas profile (NFR-3)', () => {
  let fixture: SnapshotFixture;
  let stack: PokerStack;
  let poker: any;

  before(async () => {
    fixture = await snapshotFixture(2n);
    stack = fixture.stack;
    poker = stack.poker;
  });

  beforeEach(async () => {
    await fixture.reset();
    await createWagerTable(stack);
  });

  /** Seat `count` players, run a hand and return the measured settlement gas. */
  async function measureSettlement(count: number, label: string): Promise<bigint> {
    // Each measurement needs a clean table so seats start from a zero escrow balance.
    await fixture.reset();
    await createWagerTable(stack);

    const seats = Array.from({ length: count }, (_, i) => i);
    for (const seat of seats) {
      await poker.connect(stack.players[seat]!).deposit(TABLE_ID, seat, LEGAL_BUY_IN);
    }

    const handId = handIdOf(label);
    const seed = ethers.keccak256(ethers.toUtf8Bytes(`${label}-seed`));
    await commitHiddenDeck(stack, handId, seed, 1n);
    await poker.connect(stack.operator).openHand(TABLE_ID, handId, seats);

    const contributions = seats.map(() => ethers.parseEther('10'));
    for (const [index, seat] of seats.entries()) {
      await poker.connect(stack.operator).commitHand(TABLE_ID, handId, seat, contributions[index]!);
    }

    const pot = contributions.reduce((a, b) => a + b, 0n);
    const rake = (pot * TABLE_CONFIG.rakeBps) / 10_000n > TABLE_CONFIG.rakeCap ? TABLE_CONFIG.rakeCap : (pot * TABLE_CONFIG.rakeBps) / 10_000n;

    const tx = await poker
      .connect(stack.operator)
      .settleHand(TABLE_ID, handId, contributions, [0], [pot - rake], true);
    const receipt = await tx.wait();
    return receipt!.gasUsed as bigint;
  }

  it('settles a 6-seat hand well under the block gas limit and reports the measurement', async () => {
    const gasUsed = await measureSettlement(6, 'gas-6max');
    const blockGasLimit = BigInt(await hre.network.provider.send('eth_getBlockByNumber', ['latest', false]).then((b: any) => BigInt(b.gasLimit)));

    // eslint-disable-next-line no-console
    console.log(
      `[NFR-3] 6-seat settleHand gas: ${gasUsed.toString()} (block gas limit ${blockGasLimit.toString()}, ` +
        `${((Number(gasUsed) / Number(blockGasLimit)) * 100).toFixed(3)}% of a block)`,
    );

    expect(gasUsed).to.be.lessThan(blockGasLimit / 4n);
    // A 6-seat settlement that needed more than a million gas would mean per-seat work is doing
    // something superlinear; the current implementation is comfortably below that.
    expect(gasUsed).to.be.lessThan(1_000_000n);
  });

  it('grows about linearly in the seat count (O(seats), not O(seats^2))', async () => {
    const gasTwo = await measureSettlement(2, 'gas-2');
    const gasFour = await measureSettlement(4, 'gas-4');
    const gasSix = await measureSettlement(6, 'gas-6');

    // eslint-disable-next-line no-console
    console.log(
      `[NFR-3] settleHand gas by seat count: 2 -> ${gasTwo.toString()}, 4 -> ${gasFour.toString()}, 6 -> ${gasSix.toString()}`,
    );

    const perSeat = (gasSix - gasTwo) / 4n;
    // eslint-disable-next-line no-console
    console.log(`[NFR-3] marginal gas per extra seat: ${perSeat.toString()}`);

    // Linear growth: doubling the seat count from 2 to 6 (3x) must not quadruple the cost, and
    // the incremental cost per seat must stay bounded.
    expect(gasSix).to.be.lessThan(gasTwo * 3n);
    expect(perSeat).to.be.lessThan(60_000n);
    // Monotone in the seat count (each seat is real work).
    expect(gasFour).to.be.greaterThan(gasTwo);
    expect(gasSix).to.be.greaterThan(gasFour);
  });

  /** Seat `count` players at the USDG table, run a hand and return the measured settlement gas. */
  async function measureUsdgSettlement(count: number, label: string): Promise<bigint> {
    await fixture.reset();
    await createUsdgWagerTable(stack);

    const seats = Array.from({ length: count }, (_, i) => i);
    const perSeat = usdg('10');
    for (const seat of seats) {
      await poker.connect(stack.players[seat]!).deposit(USDG_TABLE_ID, seat, perSeat);
    }

    const handId = handIdOf(label);
    const seed = ethers.keccak256(ethers.toUtf8Bytes(`${label}-seed`));
    await commitHiddenDeck(stack, handId, seed, 1n);
    await poker.connect(stack.operator).openHand(USDG_TABLE_ID, handId, seats);

    const contributions = seats.map(() => perSeat);
    for (const [index, seat] of seats.entries()) {
      await poker.connect(stack.operator).commitHand(USDG_TABLE_ID, handId, seat, contributions[index]!);
    }

    const pot = perSeat * BigInt(seats.length);
    const bpsRake = (pot * USDG_TABLE_CONFIG.rakeBps) / 10_000n;
    const rake = bpsRake > USDG_TABLE_CONFIG.rakeCap ? USDG_TABLE_CONFIG.rakeCap : bpsRake;

    const tx = await poker
      .connect(stack.operator)
      .settleHand(USDG_TABLE_ID, handId, contributions, [0], [pot - rake], true);
    const receipt = await tx.wait();
    return receipt!.gasUsed as bigint;
  }

  it('settles a 6-seat USDG (6-decimal) hand for the same gas as LLMPOKER', async () => {
    const llmpokerGas = await measureSettlement(6, 'gas-6max-dual-llm');
    const usdgGas = await measureUsdgSettlement(6, 'gas-6max-dual-usdg');
    const blockGasLimit = BigInt(
      await hre.network.provider
        .send('eth_getBlockByNumber', ['latest', false])
        .then((b: any) => BigInt(b.gasLimit)),
    );

    // eslint-disable-next-line no-console
    console.log(
      `[NFR-3] 6-seat settleHand gas: LLMPOKER (18 decimals) = ${llmpokerGas.toString()}, ` +
        `USDG (6 decimals) = ${usdgGas.toString()} (block gas limit ${blockGasLimit.toString()})`,
    );

    // The settlement path is decimal-agnostic: the per-table token is one extra storage read and
    // the per-token escrow running total is one extra write, so the two currencies must land
    // within a small constant of each other rather than scaling with the amount.
    expect(usdgGas).to.be.lessThan(1_000_000n);
    expect(usdgGas).to.be.greaterThan(llmpokerGas - 60_000n);
    expect(usdgGas).to.be.lessThan(llmpokerGas + 60_000n);
    expect(usdgGas).to.be.lessThan(blockGasLimit / 4n);
  });

  it('reports the gas of the other wager entry points for the record', async () => {
    await poker.connect(stack.players[0]!).deposit(TABLE_ID, 0, LEGAL_BUY_IN);
    const depositReceipt = await (
      await poker.connect(stack.players[1]!).deposit(TABLE_ID, 1, LEGAL_BUY_IN)
    ).wait();

    const handId = handIdOf('gas-parts');
    const seed = ethers.keccak256(ethers.toUtf8Bytes('gas-parts-seed'));
    // Phase 1 only, so the gas of `commitSeed` can be reported on its own.
    const commitSeedReceipt = await (
      await stack.shuffle
        .connect(stack.operator)
        .commitSeed(handId, ethers.keccak256(ethers.solidityPacked(['bytes32', 'uint256'], [seed, 1n])), 1n)
    ).wait();
    const openReceipt = await (await poker.connect(stack.operator).openHand(TABLE_ID, handId, [0, 1])).wait();
    const commitReceipt = await (
      await poker.connect(stack.operator).commitHand(TABLE_ID, handId, 0, ethers.parseEther('10'))
    ).wait();

    // Phase 2 needs the anchor hash of block N+1; by now the chain is well past it, and the two
    // intervening transactions already cover the confirmation requirement.
    const anchorBlock = await hre.ethers.provider.getBlock(commitSeedReceipt!.blockNumber + 1);
    const { deck, salts, leaves, root } = commitmentForDeck(
      handId,
      await derivedDeckFromHash(stack, seed, anchorBlock!.hash!),
    );
    const commitDeckReceipt = await (
      await stack.shuffle.connect(stack.operator).commitDeck(handId, root, leaves)
    ).wait();
    const revealCardReceipt = await (
      await stack.shuffle.connect(stack.operator).revealCard(handId, 0, deck[0]!, salts[0]!, cardProof({ deck, salts, leaves, root }, 0))
    ).wait();

    // Settle so seat 1 (a participant with unspent escrow) can cash out, then cash out.
    await poker
      .connect(stack.operator)
      .settleHand(TABLE_ID, handId, [ethers.parseEther('10'), 0n], [0], [ethers.parseEther('10') - RAKE.cap], true);
    const cashOutReceipt = await (await poker.connect(stack.players[1]!).cashOut(TABLE_ID, 1)).wait();

    // eslint-disable-next-line no-console
    console.log(
      '[NFR-3] per-call gas: deposit=',
      depositReceipt!.gasUsed.toString(),
      'openHand=',
      openReceipt!.gasUsed.toString(),
      'commitHand(pot)=',
      commitReceipt!.gasUsed.toString(),
      'commitSeed=',
      commitSeedReceipt!.gasUsed.toString(),
      'commitDeck(52-leaf Merkle root)=',
      commitDeckReceipt!.gasUsed.toString(),
      'revealCard(1 Merkle proof)=',
      revealCardReceipt!.gasUsed.toString(),
      'cashOut=',
      cashOutReceipt!.gasUsed.toString(),
    );

    // The deck commitment hashes a 64-leaf tree; the per-card reveal checks one path of 10 nodes.
    expect(commitDeckReceipt!.gasUsed).to.be.lessThan(1_500_000n);
    expect(revealCardReceipt!.gasUsed).to.be.lessThan(1_500_000n);
    expect(cashOutReceipt!.gasUsed).to.be.lessThan(150_000n);
  });
});
