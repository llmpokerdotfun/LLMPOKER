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
import { mineUpTo } from '@nomicfoundation/hardhat-network-helpers';

import {
  RAKE,
  TABLE_CONFIG,
  TABLE_ID,
  commitHand,
  createWagerTable,
  revealHand,
  snapshotFixture,
  type PokerStack,
  type SnapshotFixture,
} from './support/helpers';

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
    await commitHand(stack, handId, seed, 1n);
    await poker.connect(stack.operator).openHand(TABLE_ID, handId, seats);

    const contributions = seats.map(() => ethers.parseEther('10'));
    for (const [index, seat] of seats.entries()) {
      await poker.connect(stack.operator).commitHand(TABLE_ID, handId, seat, contributions[index]!);
    }
    await revealHand(stack, handId, seed);

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

  it('reports the gas of the other wager entry points for the record', async () => {
    await poker.connect(stack.players[0]!).deposit(TABLE_ID, 0, LEGAL_BUY_IN);
    const depositReceipt = await (
      await poker.connect(stack.players[1]!).deposit(TABLE_ID, 1, LEGAL_BUY_IN)
    ).wait();

    const handId = handIdOf('gas-parts');
    const seed = ethers.keccak256(ethers.toUtf8Bytes('gas-parts-seed'));
    const commitment = await (
      await stack.shuffle.connect(stack.operator).commit(handId, ethers.keccak256(ethers.solidityPacked(['bytes32', 'uint256'], [seed, 1n])), 1n)
    ).wait();
    const openReceipt = await (
      await poker.connect(stack.operator).openHand(TABLE_ID, handId, [0, 1])
    ).wait();
    const commitReceipt = await (
      await poker.connect(stack.operator).commitHand(TABLE_ID, handId, 0, ethers.parseEther('10'))
    ).wait();
    await mineUpTo(BigInt(commitment!.blockNumber) + 3n);
    const revealReceipt = await (await stack.shuffle.connect(stack.operator).reveal(handId, seed)).wait();

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
      'commitHand=',
      commitReceipt!.gasUsed.toString(),
      'reveal(52-card shuffle+store)=',
      revealReceipt!.gasUsed.toString(),
      'cashOut=',
      cashOutReceipt!.gasUsed.toString(),
    );

    // The whole on-chain shuffle — 13 keccak words plus a 52-byte storage write — fits in a
    // transaction with room to spare.
    expect(revealReceipt!.gasUsed).to.be.lessThan(1_500_000n);
    expect(cashOutReceipt!.gasUsed).to.be.lessThan(150_000n);
  });
});
