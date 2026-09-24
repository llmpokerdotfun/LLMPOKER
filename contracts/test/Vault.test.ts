/**
 * Vault tests (FR-9.2–9.3): fee custody, the ops/trading-rewards split, the `notifyFees` DEX
 * hook and per-bucket withdrawal access control.
 */

import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';
import { snapshotFixture, type PokerStack, type SnapshotFixture } from './support/helpers';

describe('Vault (FR-9.2–9.3)', () => {
  let fixture: SnapshotFixture;
  let stack: PokerStack;
  let vault: any;

  before(async () => {
    fixture = await snapshotFixture(2n);
    stack = fixture.stack;
    vault = stack.vault;
  });

  beforeEach(async () => {
    await fixture.reset();
  });

  it('defaults to a 50/50 split (FR-9.3)', async () => {
    expect(await vault.DEFAULT_OPERATIONS_BPS()).to.equal(5_000n);
    expect(await vault.operationsBps()).to.equal(5_000n);
    expect(await vault.tradingRewardsBps()).to.equal(5_000n);
  });

  it('splits a notified fee 50/50 and emits FeesNotified (FR-9.2)', async () => {
    const amount = ethers.parseEther('100');
    const alice = stack.playerAddresses[0]!;

    await expect(vault.connect(stack.players[0]).notifyFees(amount))
      .to.emit(vault, 'FeesNotified')
      .withArgs(alice, amount, amount / 2n, amount / 2n);

    expect(await vault.operationsBalance()).to.equal(amount / 2n);
    expect(await vault.tradingRewardsBalance()).to.equal(amount / 2n);
    expect(await vault.totalReceived()).to.equal(amount);
    // Custody is real: the vault holds exactly what it owes.
    expect(await vault.totalAssets()).to.equal(amount);
    expect(await stack.token.balanceOf(stack.vaultAddress)).to.equal(amount);
  });

  it('routes an odd amount with the remainder to trading rewards (no stranded dust)', async () => {
    await vault.connect(stack.players[0]).notifyFees(101n);
    expect(await vault.operationsBalance()).to.equal(50n);
    expect(await vault.tradingRewardsBalance()).to.equal(51n);
    expect(await vault.totalAssets()).to.equal(101n);
  });

  it('honours a reconfigured split for future inflows only (FR-9.3, FR-9.7)', async () => {
    await vault.connect(stack.players[0]).notifyFees(ethers.parseEther('10'));
    await expect(vault.connect(stack.owner).setOperationsBps(2_000n))
      .to.emit(vault, 'SplitUpdated')
      .withArgs(2_000n);
    expect(await vault.tradingRewardsBps()).to.equal(8_000n);

    await vault.connect(stack.players[0]).notifyFees(ethers.parseEther('10'));
    expect(await vault.operationsBalance()).to.equal(ethers.parseEther('7')); // 5 + 2
    expect(await vault.tradingRewardsBalance()).to.equal(ethers.parseEther('13')); // 5 + 8
  });

  it('rejects an out-of-range split and a non-admin caller', async () => {
    await expect(vault.connect(stack.owner).setOperationsBps(10_001n)).to.be.revertedWithCustomError(
      vault,
      'InvalidSplit',
    );
    await expect(vault.connect(stack.players[0]).setOperationsBps(1_000n)).to.be.revertedWithCustomError(
      vault,
      'AccessControlUnauthorizedAccount',
    );
  });

  it('never lets the two buckets exceed the inflow (accounting is conservative)', async () => {
    for (const amount of [1n, 3n, 7n, 999n, ethers.parseEther('3')]) {
      const before = (await vault.operationsBalance()) + (await vault.tradingRewardsBalance());
      await vault.connect(stack.players[0]).notifyFees(amount);
      const after = (await vault.operationsBalance()) + (await vault.tradingRewardsBalance());
      expect(after - before).to.equal(amount);
    }
  });

  it('lets the operations role withdraw, and only that bucket', async () => {
    const amount = ethers.parseEther('100');
    await vault.connect(stack.players[0]).notifyFees(amount);
    const alice = stack.playerAddresses[1]!;

    const before = await stack.token.balanceOf(alice);
    await expect(vault.connect(stack.owner).withdrawOperations(alice, ethers.parseEther('30')))
      .to.emit(vault, 'Withdrawn')
      .withArgs('operations', alice, ethers.parseEther('30'), ethers.parseEther('20'));
    expect((await stack.token.balanceOf(alice)) - before).to.equal(ethers.parseEther('30'));
    expect(await vault.operationsBalance()).to.equal(ethers.parseEther('20'));
    // Trading rewards were untouched.
    expect(await vault.tradingRewardsBalance()).to.equal(ethers.parseEther('50'));

    await expect(
      vault.connect(stack.owner).withdrawOperations(stack.ownerAddress, ethers.parseEther('20.1')),
    )
      .to.be.revertedWithCustomError(vault, 'InsufficientBalance')
      .withArgs(ethers.parseEther('20.1'), ethers.parseEther('20'));
  });

  it('lets the trading-rewards role withdraw, and only that bucket', async () => {
    const amount = ethers.parseEther('100');
    await vault.connect(stack.players[0]).notifyFees(amount);
    const alice = stack.playerAddresses[2]!;

    await vault.connect(stack.owner).withdrawTradingRewards(alice, ethers.parseEther('50'));
    expect(await vault.tradingRewardsBalance()).to.equal(0n);
    expect(await vault.operationsBalance()).to.equal(ethers.parseEther('50'));
    await expect(
      vault.connect(stack.owner).withdrawTradingRewards(alice, 1n),
    ).to.be.revertedWithCustomError(vault, 'InsufficientBalance');
  });

  it('enforces role separation between the two buckets (FR-9.3)', async () => {
    const [owner] = await hre.ethers.getSigners();
    await vault.connect(owner).grantRole(await vault.OPERATIONS_ROLE(), stack.ownerAddress);
    const operationsOnly = stack.players[0]!;
    await vault.connect(owner).grantRole(await vault.OPERATIONS_ROLE(), stack.playerAddresses[0]!);
    await vault.connect(stack.players[1]).notifyFees(ethers.parseEther('10'));

    // The ops-only holder may not touch trading rewards.
    await expect(
      vault.connect(operationsOnly).withdrawTradingRewards(stack.playerAddresses[1]!, 1n),
    ).to.be.revertedWithCustomError(vault, 'AccessControlUnauthorizedAccount');
    await expect(vault.connect(operationsOnly).withdrawOperations(stack.playerAddresses[1]!, 1n)).to.not.be
      .reverted;
  });

  it('rejects zero-address recipients and zero-amount notifications', async () => {
    await vault.connect(stack.players[0]).notifyFees(ethers.parseEther('1'));
    await expect(
      vault.connect(stack.owner).withdrawOperations(ethers.ZeroAddress, 1n),
    ).to.be.revertedWithCustomError(vault, 'ZeroAddress');
    await expect(
      vault.connect(stack.owner).withdrawTradingRewards(ethers.ZeroAddress, 1n),
    ).to.be.revertedWithCustomError(vault, 'ZeroAddress');
    await expect(vault.connect(stack.players[0]).notifyFees(0n)).to.be.revertedWithCustomError(
      vault,
      'InsufficientBalance',
    );
  });

  it('requires the caller to actually hold the tokens it notifies (FR-9.2)', async () => {
    const poor = stack.players[5]!;
    await stack.token.connect(poor).transfer(stack.playerAddresses[0]!, await stack.token.balanceOf(await poor.getAddress()));
    expect(await stack.token.balanceOf(await poor.getAddress())).to.equal(0n);
    await expect(vault.connect(poor).notifyFees(ethers.parseEther('1'))).to.be.revertedWithCustomError(
      stack.token,
      'ERC20InsufficientBalance',
    );
  });
});
