/**
 * RakeSplitter tests (FR-8.2, FR-9): authorized rake source, the staking/vault split, the
 * pull-based sweep into `Staking` (which is what makes FR-9.6 observable) and split retuning.
 */

import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';
import { impersonateAccount, setBalance } from '@nomicfoundation/hardhat-network-helpers';

import { snapshotFixture, type PokerStack, type SnapshotFixture } from './support/helpers';

describe('RakeSplitter (FR-8.2, FR-9)', () => {
  let fixture: SnapshotFixture;
  let stack: PokerStack;
  let splitter: any;

  /**
   * Impersonate the poker contract: `RakeSplitter.receiveRake` is restricted to it, and the flow
   * is "transfer the rake, then credit it" — exactly what `Poker.settleHand` does.
   */
  async function impersonatePoker(): Promise<any> {
    await impersonateAccount(stack.pokerAddress);
    // An impersonated account pays its own gas and must be able to transfer the rake it credits.
    await setBalance(stack.pokerAddress, ethers.parseEther('10'));
    await stack.token.connect(stack.owner).transfer(stack.pokerAddress, ethers.parseEther('10000'));
    return hre.ethers.getSigner(stack.pokerAddress);
  }

  /** Move rake to the splitter and then credit it, exactly as `Poker.settleHand` does. */
  async function pushRake(pokerSigner: any, amount: bigint): Promise<any> {
    await stack.token.connect(pokerSigner).transfer(stack.splitterAddress, amount);
    return splitter.connect(pokerSigner).receiveRake(amount);
  }

  before(async () => {
    fixture = await snapshotFixture(2n);
    stack = fixture.stack;
    splitter = stack.splitter;
  });

  beforeEach(async () => {
    await fixture.reset();
  });

  it('defaults to the 50/50 SRS split and stores its beneficiaries', async () => {
    expect(await splitter.stakingBps()).to.equal(5_000n);
    expect(await splitter.vaultBps()).to.equal(5_000n);
    expect(await splitter.staking()).to.equal(stack.stakingAddress);
    expect(await splitter.vault()).to.equal(stack.vaultAddress);
    expect(await splitter.poker()).to.equal(stack.pokerAddress);
  });

  it('rejects rake from any address other than the configured poker contract (FR-10)', async () => {
    await expect(splitter.connect(stack.players[0]).receiveRake(ethers.parseEther('1')))
      .to.be.revertedWithCustomError(splitter, 'NotPoker')
      .withArgs(stack.playerAddresses[0]!);
    await expect(splitter.connect(stack.owner).receiveRake(ethers.parseEther('1')))
      .to.be.revertedWithCustomError(splitter, 'NotPoker')
      .withArgs(stack.ownerAddress);
  });

  it('credits both legs and reports cumulative totals (FR-9.6)', async () => {
    // Only `poker` may push rake, so fund it and impersonate it; the real end-to-end path is
    // exercised in `Poker.test.ts`.
    const pokerSigner = await impersonatePoker();

    const amount = ethers.parseEther('100');
    await expect(pushRake(pokerSigner, amount))
      .to.emit(splitter, 'RakeDistributed')
      .withArgs(stack.pokerAddress, amount, amount / 2n, amount / 2n, amount);

    expect(await splitter.totalReceived()).to.equal(amount);
    expect(await splitter.pendingStaking()).to.equal(amount / 2n);
    expect(await splitter.pendingVault()).to.equal(amount / 2n);
    expect(await splitter.totalCreditedStaking()).to.equal(amount / 2n);
    expect(await splitter.totalCreditedVault()).to.equal(amount / 2n);
    expect(await splitter.totalCreditedTo(stack.stakingAddress)).to.equal(amount / 2n);
    expect(await splitter.totalCreditedTo(stack.vaultAddress)).to.equal(amount / 2n);
    expect(await splitter.pendingOf(stack.stakingAddress)).to.equal(amount / 2n);
    expect(await splitter.pendingOf(stack.vaultAddress)).to.equal(amount / 2n);
    // The splitter holds exactly what it owes.
    expect(await splitter.totalAssets()).to.equal(amount);
  });

  it('sweeps the staking leg into the pool and notifies it (FR-9.4, FR-9.6)', async () => {
    const pokerSigner = await impersonatePoker();
    await pushRake(pokerSigner, ethers.parseEther('100'));

    await stack.staking.connect(stack.players[0]).stake(ethers.parseEther('1000'));

    await expect(splitter.connect(stack.players[1]).sweepStaking(ethers.parseEther('50')))
      .to.emit(splitter, 'Swept')
      .withArgs(stack.stakingAddress, stack.stakingAddress, ethers.parseEther('50'))
      .and.to.emit(stack.staking, 'RewardsNotified');

    expect(await stack.token.balanceOf(stack.stakingAddress)).to.equal(ethers.parseEther('1050'));
    expect(await stack.staking.pendingRewards(stack.playerAddresses[0]!)).to.equal(ethers.parseEther('50'));
    expect(await splitter.pendingStaking()).to.equal(0n);
    expect(await splitter.pendingVault()).to.equal(ethers.parseEther('50'));
    expect(await splitter.totalAssets()).to.equal(ethers.parseEther('50'));
  });

  it('sweeps the vault leg into the vault (FR-9.3)', async () => {
    const pokerSigner = await impersonatePoker();
    await pushRake(pokerSigner, ethers.parseEther('100'));

    await expect(splitter.connect(stack.players[1]).sweepVault(ethers.parseEther('50')))
      .to.emit(splitter, 'Swept')
      .withArgs(stack.vaultAddress, stack.vaultAddress, ethers.parseEther('50'));
    expect(await stack.token.balanceOf(stack.vaultAddress)).to.equal(ethers.parseEther('50'));
    expect(await splitter.totalAssets()).to.equal(ethers.parseEther('50'));
  });

  it('sweeps both legs at once and never over-sweeps', async () => {
    const pokerSigner = await impersonatePoker();
    await pushRake(pokerSigner, ethers.parseEther('100'));

    await expect(splitter.connect(stack.players[1]).sweepAll()).to.emit(splitter, 'Swept');
    expect(await splitter.totalAssets()).to.equal(0n);
    expect(await splitter.pendingStaking()).to.equal(0n);
    expect(await splitter.pendingVault()).to.equal(0n);

    await expect(splitter.connect(stack.players[1]).sweepVault(1n))
      .to.be.revertedWithCustomError(splitter, 'InsufficientPending')
      .withArgs(1n, 0n);
    await expect(splitter.connect(stack.players[1]).sweepStaking(1n))
      .to.be.revertedWithCustomError(splitter, 'InsufficientPending')
      .withArgs(1n, 0n);
  });

  it('routes an odd rake with the remainder to the vault (no stranded wei)', async () => {
    const pokerSigner = await impersonatePoker();
    await pushRake(pokerSigner, 101n);
    expect(await splitter.pendingStaking()).to.equal(50n);
    expect(await splitter.pendingVault()).to.equal(51n);
    expect(await splitter.totalAssets()).to.equal(101n);
  });

  it('applies a retuned split to future rake only (FR-9.7)', async () => {
    const pokerSigner = await impersonatePoker();

    await pushRake(pokerSigner, ethers.parseEther('100'));
    await expect(splitter.connect(stack.owner).setStakingBps(2_500n))
      .to.emit(splitter, 'SplitUpdated')
      .withArgs(5_000n, 2_500n);
    await pushRake(pokerSigner, ethers.parseEther('100'));

    expect(await splitter.pendingStaking()).to.equal(ethers.parseEther('75')); // 50 + 25
    expect(await splitter.pendingVault()).to.equal(ethers.parseEther('125')); // 50 + 75
    expect(await splitter.totalAssets()).to.equal(ethers.parseEther('200'));
  });

  it('allows a full 100 % staking or 100 % vault split', async () => {
    const pokerSigner = await impersonatePoker();

    await splitter.connect(stack.owner).setStakingBps(10_000n);
    await pushRake(pokerSigner, ethers.parseEther('10'));
    expect(await splitter.pendingStaking()).to.equal(ethers.parseEther('10'));
    expect(await splitter.pendingVault()).to.equal(0n);

    await splitter.connect(stack.owner).setStakingBps(0n);
    await pushRake(pokerSigner, ethers.parseEther('10'));
    expect(await splitter.pendingStaking()).to.equal(ethers.parseEther('10'));
    expect(await splitter.pendingVault()).to.equal(ethers.parseEther('10'));
  });

  it('validates the split and the poker address', async () => {
    await expect(splitter.connect(stack.owner).setStakingBps(10_001n)).to.be.revertedWithCustomError(
      splitter,
      'InvalidSplit',
    );
    await expect(splitter.connect(stack.players[0]).setStakingBps(1n)).to.be.revertedWithCustomError(
      splitter,
      'OwnableUnauthorizedAccount',
    );
    await expect(splitter.connect(stack.owner).setPoker(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      splitter,
      'ZeroAddress',
    );
    await expect(splitter.connect(stack.owner).setPoker(stack.playerAddresses[0]!))
      .to.emit(splitter, 'PokerUpdated')
      .withArgs(stack.pokerAddress, stack.playerAddresses[0]!);
    expect(await splitter.poker()).to.equal(stack.playerAddresses[0]!);
  });

  it('reports zero for an unrelated beneficiary', async () => {
    expect(await splitter.pendingOf(stack.playerAddresses[4]!)).to.equal(0n);
    expect(await splitter.totalCreditedTo(stack.playerAddresses[4]!)).to.equal(0n);
  });
});
