/**
 * Staking tests (FR-9.4–9.6): pro-rata accrual funded by `RakeSplitter`, claim, the 7-day unstake
 * cooldown, rounding safety and the "stake right before a distribution" defence.
 */

import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';
import { impersonateAccount, setBalance, time } from '@nomicfoundation/hardhat-network-helpers';

import { snapshotFixture, UNSTAKE_COOLDOWN_SECONDS, type PokerStack, type SnapshotFixture } from './support/helpers';

const DUST_FLOOR = ethers.parseEther('1');

describe('Staking (FR-9.4–9.6)', () => {
  let fixture: SnapshotFixture;
  let stack: PokerStack;
  let staking: any;

  /**
   * Impersonate the poker contract: RakeSplitter.receiveRake is restricted to it, and this
   * suite only cares about what happens downstream in Staking (the real path is covered by
   * Poker.test.ts).
   */
  async function impersonatePoker(): Promise<any> {
    await impersonateAccount(stack.pokerAddress);
    await setBalance(stack.pokerAddress, ethers.parseEther('10'));
    const signer = await hre.ethers.getSigner(stack.pokerAddress);
    await stack.token.connect(stack.owner).transfer(stack.pokerAddress, ethers.parseEther('2000'));
    await stack.token.connect(signer).approve(stack.splitterAddress, ethers.MaxUint256);
    return signer;
  }

  let poker: any;

  before(async () => {
    fixture = await snapshotFixture(2n);
    stack = fixture.stack;
    staking = stack.staking;
  });

  beforeEach(async () => {
    await fixture.reset();
    poker = await impersonatePoker();
  });

  it('uses the 7-day cooldown from packages/shared/src/config.ts (FR-9.5)', async () => {
    expect(await staking.cooldownSeconds()).to.equal(UNSTAKE_COOLDOWN_SECONDS);
    expect(UNSTAKE_COOLDOWN_SECONDS).to.equal(604800n);
  });

  it('stakes and tracks the active balance and total', async () => {
    const amount = ethers.parseEther('100');
    await expect(staking.connect(stack.players[0]).stake(amount))
      .to.emit(staking, 'Staked')
      .withArgs(stack.playerAddresses[0]!, amount, amount);

    expect(await staking.stakeOf(stack.playerAddresses[0]!)).to.equal(amount);
    expect(await staking.totalStaked()).to.equal(amount);
    expect(await stack.token.balanceOf(stack.stakingAddress)).to.equal(amount);
  });

  it('rejects a zero stake and a below-floor first stake (rounding safety)', async () => {
    await expect(staking.connect(stack.players[0]).stake(0n)).to.be.revertedWithCustomError(staking, 'ZeroAmount');
    await expect(staking.connect(stack.players[0]).stake(1n))
      .to.be.revertedWithCustomError(staking, 'BelowMinStake')
      .withArgs(1n, DUST_FLOOR);
    // A second staker has no floor once the pool is non-empty.
    await staking.connect(stack.players[0]).stake(ethers.parseEther('10'));
    await staking.connect(stack.players[1]).stake(1n);
    expect(await staking.stakeOf(stack.playerAddresses[1]!)).to.equal(1n);
  });

  it('accrues rewards pro-rata when the splitter notifies (FR-9.4, FR-9.6)', async () => {
    await staking.connect(stack.players[0]).stake(ethers.parseEther('100'));
    await staking.connect(stack.players[1]).stake(ethers.parseEther('300'));

    const reward = ethers.parseEther('40');
    await expect(stack.splitter.connect(poker).receiveRake(reward)).to.emit(stack.splitter, 'RakeDistributed');
    await expect(stack.splitter.connect(stack.owner).sweepAll()).to.emit(staking, 'RewardsNotified');

    // 25 % / 75 % of the 40 staking leg (the splitter sends 50 % of the rake to staking).
    const stakingLeg = reward / 2n;
    expect(await staking.pendingRewards(stack.playerAddresses[0]!)).to.equal(stakingLeg / 4n);
    expect(await staking.pendingRewards(stack.playerAddresses[1]!)).to.equal((stakingLeg * 3n) / 4n);
    expect(await staking.totalNotified()).to.equal(stakingLeg);
  });

  it('pays a claim and emits Claimed (FR-9.4, FR-9.6)', async () => {
    await staking.connect(stack.players[0]).stake(ethers.parseEther('100'));
    await stack.splitter.connect(poker).receiveRake(ethers.parseEther('10'));
    await stack.splitter.connect(stack.owner).sweepStaking(ethers.parseEther('5'));

    const alice = stack.playerAddresses[0]!;
    const before = await stack.token.balanceOf(alice);
    await expect(staking.connect(stack.players[0]).claim())
      .to.emit(staking, 'Claimed')
      .withArgs(alice, ethers.parseEther('5'));
    expect((await stack.token.balanceOf(alice)) - before).to.equal(ethers.parseEther('5'));
    expect(await staking.pendingRewards(alice)).to.equal(0n);
    // Principal stays staked.
    expect(await staking.stakeOf(alice)).to.equal(ethers.parseEther('100'));
  });

  it('reverts a claim with nothing pending', async () => {
    await expect(staking.connect(stack.players[0]).claim()).to.be.revertedWithCustomError(staking, 'NothingToClaim');
  });

  it('defends against staking right before a distribution (FR-9.5 anti-arbitrage)', async () => {
    await staking.connect(stack.players[0]).stake(ethers.parseEther('1000'));

    // A second staker joins in the same block a distribution lands; the accumulator checkpoint
    // means the distribution cannot be captured retroactively.
    await staking.connect(stack.players[1]).stake(ethers.parseEther('1000'));
    await stack.splitter.connect(poker).receiveRake(ethers.parseEther('100'));
    await stack.splitter.connect(stack.owner).sweepStaking(ethers.parseEther('50'));

    const first = await staking.pendingRewards(stack.playerAddresses[0]!);
    const second = await staking.pendingRewards(stack.playerAddresses[1]!);
    expect(first + second).to.equal(ethers.parseEther('50'));
    expect(first).to.equal(second);

    // A late staker arriving *after* the distribution gets nothing from it.
    await staking.connect(stack.players[2]).stake(ethers.parseEther('1000'));
    expect(await staking.pendingRewards(stack.playerAddresses[2]!)).to.equal(0n);
    expect(await staking.pendingRewards(stack.playerAddresses[0]!)).to.equal(first);
  });

  it('moves principal through the cooldown and enforces it exactly (FR-9.5)', async () => {
    const alice = stack.playerAddresses[0]!;
    await staking.connect(stack.players[0]).stake(ethers.parseEther('100'));

    const requestTx = await staking.connect(stack.players[0]).requestUnstake(ethers.parseEther('100'));
    const receipt = await requestTx.wait();
    const block = await ethers.provider.getBlock(receipt!.blockNumber);
    const availableAt = BigInt(block!.timestamp) + UNSTAKE_COOLDOWN_SECONDS;

    await expect(requestTx).to.emit(staking, 'UnstakeRequested').withArgs(alice, ethers.parseEther('100'), availableAt);
    // The queued principal stops earning immediately and leaves the total.
    expect(await staking.totalStaked()).to.equal(0n);
    expect(await staking.pendingUnstake(alice)).to.equal(ethers.parseEther('100'));
    expect(await staking.unstakeAvailableAt(alice)).to.equal(availableAt);

    // One second before maturity the claim is still blocked.
    await time.increaseTo(availableAt - 1n);
    await expect(staking.connect(stack.players[0]).claim())
      .to.be.revertedWithCustomError(staking, 'CooldownActive')
      .withArgs(availableAt);

    await time.increaseTo(availableAt);
    const before = await stack.token.balanceOf(alice);
    await expect(staking.connect(stack.players[0]).claim()).to.emit(staking, 'Unstaked').withArgs(alice, ethers.parseEther('100'));
    expect((await stack.token.balanceOf(alice)) - before).to.equal(ethers.parseEther('100'));
    expect(await staking.pendingUnstake(alice)).to.equal(0n);
    expect(await staking.unstakeAvailableAt(alice)).to.equal(0n);
  });

  it('stops rewards accruing on principal that is in cooldown (FR-9.5)', async () => {
    const alice = stack.playerAddresses[0]!;
    const bob = stack.playerAddresses[1]!;
    await staking.connect(stack.players[0]).stake(ethers.parseEther('100'));
    await staking.connect(stack.players[1]).stake(ethers.parseEther('100'));
    await staking.connect(stack.players[0]).requestUnstake(ethers.parseEther('100'));

    await stack.splitter.connect(poker).receiveRake(ethers.parseEther('10'));
    await stack.splitter.connect(stack.owner).sweepStaking(ethers.parseEther('5'));

    // Alice earned nothing: only Bob's 100 was in the pool when the yield landed.
    expect(await staking.pendingRewards(alice)).to.equal(0n);
    expect(await staking.pendingRewards(bob)).to.equal(ethers.parseEther('5'));
  });

  it('allows cancelling a cooldown, re-registering the stake at the current accumulator', async () => {
    const alice = stack.playerAddresses[0]!;
    await staking.connect(stack.players[0]).stake(ethers.parseEther('100'));
    await staking.connect(stack.players[0]).requestUnstake(ethers.parseEther('100'));
    await expect(staking.connect(stack.players[0]).cancelUnstake())
      .to.emit(staking, 'UnstakeCancelled')
      .withArgs(alice, ethers.parseEther('100'));
    expect(await staking.stakeOf(alice)).to.equal(ethers.parseEther('100'));
    expect(await staking.totalStaked()).to.equal(ethers.parseEther('100'));
    await expect(staking.connect(stack.players[0]).cancelUnstake()).to.be.revertedWithCustomError(
      staking,
      'NothingToClaim',
    );
  });

  it('rejects a second concurrent unstake request and over-requests', async () => {
    await staking.connect(stack.players[0]).stake(ethers.parseEther('100'));
    await staking.connect(stack.players[0]).requestUnstake(ethers.parseEther('40'));
    await expect(staking.connect(stack.players[0]).requestUnstake(ethers.parseEther('1')))
      .to.be.revertedWithCustomError(staking, 'UnstakeAlreadyPending');
    await expect(staking.connect(stack.players[1]).requestUnstake(ethers.parseEther('1')))
      .to.be.revertedWithCustomError(staking, 'InsufficientStake');
    await expect(staking.connect(stack.players[0]).requestUnstake(0n)).to.be.revertedWithCustomError(
      staking,
      'ZeroAmount',
    );
  });

  it('books a distribution as undistributed dust when it rounds below one share (rounding safety)', async () => {
    // First stake must clear the floor; the second may be a single wei.
    await staking.connect(stack.players[0]).stake(ethers.parseEther('1'));
    await staking.connect(stack.players[1]).stake(1n);

    // A 1-wei staking leg is below one share of the accumulator, so it cannot be represented.
    await stack.splitter.connect(poker).receiveRake(2n);
    await stack.splitter.connect(stack.owner).sweepStaking(1n);
    expect(await staking.undistributedRewards()).to.equal(1n);
    expect(await staking.pendingRewards(stack.playerAddresses[0]!)).to.equal(0n);
    expect(await staking.pendingRewards(stack.playerAddresses[1]!)).to.equal(0n);

    // The dust is carried into the next distribution rather than stranded.
    await stack.splitter.connect(poker).receiveRake(ethers.parseEther('2'));
    await stack.splitter.connect(stack.owner).sweepStaking(ethers.parseEther('1'));

    const alice = await staking.pendingRewards(stack.playerAddresses[0]!);
    const bob = await staking.pendingRewards(stack.playerAddresses[1]!);
    const dust = await staking.undistributedRewards();
    expect(alice + bob + dust).to.equal(ethers.parseEther('1') + 1n);
    // The 1 wei went to the single-wei staker, who owns 1 wei out of 1e18 + 1 wei of shares.
    expect(bob).to.equal(1n);
    expect(alice).to.equal(ethers.parseEther('1') - 1n);
    expect(await staking.totalNotified()).to.equal(1n + ethers.parseEther('1'));
  });

  it('books a distribution as undistributed when the pool is empty (no silent loss)', async () => {
    await stack.splitter.connect(poker).receiveRake(ethers.parseEther('10'));
    await expect(stack.splitter.connect(stack.owner).sweepStaking(ethers.parseEther('5')))
      .to.emit(staking, 'UndistributedCarried')
      .withArgs(ethers.parseEther('5'), ethers.parseEther('5'));
    expect(await staking.undistributedRewards()).to.equal(ethers.parseEther('5'));

    // The carried amount is folded into the next distribution to real stakers.
    await staking.connect(stack.players[0]).stake(ethers.parseEther('100'));
    await stack.splitter.connect(poker).receiveRake(ethers.parseEther('10'));
    await stack.splitter.connect(stack.owner).sweepStaking(ethers.parseEther('5'));
    expect(await staking.pendingRewards(stack.playerAddresses[0]!)).to.equal(ethers.parseEther('10'));
    expect(await staking.undistributedRewards()).to.equal(0n);
  });

  it('requires the notifier role to distribute (FR-9.6)', async () => {
    await staking.connect(stack.players[0]).stake(ethers.parseEther('100'));
    await expect(staking.connect(stack.players[0]).notifyRewards(ethers.parseEther('1'))).to.be.revertedWithCustomError(
      staking,
      'AccessControlUnauthorizedAccount',
    );
    await expect(staking.connect(stack.owner).notifyRewards(0n)).to.be.revertedWithCustomError(
      staking,
      'ZeroAmount',
    );
  });

  it('rejects an out-of-range constructor cooldown and admin updates', async () => {
    const [owner] = await hre.ethers.getSigners();
    const factory = await hre.ethers.getContractFactory('Staking', owner);
    await expect(
      factory.deploy(stack.tokenAddress, stack.ownerAddress, 0n, DUST_FLOOR),
    ).to.be.revertedWithCustomError(factory, 'InvalidCooldown');

    await expect(staking.connect(stack.owner).setCooldown(0n)).to.be.revertedWithCustomError(
      staking,
      'InvalidCooldown',
    );
    await expect(staking.connect(stack.owner).setCooldown(UNSTAKE_COOLDOWN_SECONDS))
      .to.emit(staking, 'CooldownUpdated')
      .withArgs(UNSTAKE_COOLDOWN_SECONDS, UNSTAKE_COOLDOWN_SECONDS);
    await expect(staking.connect(stack.players[0]).setCooldown(60n)).to.be.revertedWithCustomError(
      staking,
      'AccessControlUnauthorizedAccount',
    );
    await expect(staking.connect(stack.owner).setMinStake(0n)).to.be.revertedWithCustomError(
      staking,
      'InvalidMinStake',
    );
  });

  it('previews a claim consistently with what claim() actually pays', async () => {
    const alice = stack.playerAddresses[0]!;
    await staking.connect(stack.players[0]).stake(ethers.parseEther('100'));
    await stack.splitter.connect(poker).receiveRake(ethers.parseEther('10'));
    await stack.splitter.connect(stack.owner).sweepStaking(ethers.parseEther('5'));
    await staking.connect(stack.players[0]).requestUnstake(ethers.parseEther('100'));

    const [rewards, principal, claimableAt, total] = await staking.previewClaim(alice);
    expect(rewards).to.equal(ethers.parseEther('5'));
    expect(principal).to.equal(ethers.parseEther('100'));
    // Still in cooldown, so the preview's `total` excludes the principal.
    expect(total).to.equal(ethers.parseEther('5'));

    await time.increaseTo(claimableAt);
    const [, , , matured] = await staking.previewClaim(alice);
    expect(matured).to.equal(ethers.parseEther('105'));
  });

  it('keeps the pool solvent: payouts never exceed what the splitter funded', async () => {
    for (const [index, amount] of [ethers.parseEther('100'), ethers.parseEther('250'), ethers.parseEther('7')].entries()) {
      await staking.connect(stack.players[index]!).stake(amount);
    }
    await stack.splitter.connect(poker).receiveRake(ethers.parseEther('21'));
    await stack.splitter.connect(stack.owner).sweepAll();

    const leg = ethers.parseEther('10.5');
    const claimable =
      (await staking.pendingRewards(stack.playerAddresses[0]!)) +
      (await staking.pendingRewards(stack.playerAddresses[1]!)) +
      (await staking.pendingRewards(stack.playerAddresses[2]!)) +
      (await staking.undistributedRewards());
    expect(claimable).to.equal(leg);
    expect(await stack.token.balanceOf(stack.stakingAddress)).to.be.greaterThanOrEqual(leg);
  });
});
