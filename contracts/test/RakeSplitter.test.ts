/**
 * RakeSplitter tests (FR-8.2, FR-9): authorized rake source, the 50/50 **buyback / stakers**
 * split, per-token accounting for the dual-currency wager tables, the pull-based sweeps (which is
 * what makes FR-9.6 observable) and split retuning.
 *
 * The old vault leg of the rake is gone: these tests assert it stays at zero and that the vault
 * address is recorded but never credited.
 */

import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';
import { impersonateAccount, setBalance } from '@nomicfoundation/hardhat-network-helpers';

import {
  snapshotFixture,
  usdg,
  type PokerStack,
  type SnapshotFixture,
} from './support/helpers';

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
    await stack.usdg.connect(stack.owner).mint(stack.pokerAddress, usdg('10000'));
    return hre.ethers.getSigner(stack.pokerAddress);
  }

  /** Move LLMPOKER rake to the splitter and then credit it, exactly as `Poker.settleHand` does. */
  async function pushRake(pokerSigner: any, amount: bigint): Promise<any> {
    await stack.token.connect(pokerSigner).transfer(stack.splitterAddress, amount);
    return splitter.connect(pokerSigner).receiveRake(stack.tokenAddress, amount);
  }

  /** Same, in USDG (6 decimals), to prove the splitter is decimal-agnostic. */
  async function pushUsdgRake(pokerSigner: any, amount: bigint): Promise<any> {
    await stack.usdg.connect(pokerSigner).transfer(stack.splitterAddress, amount);
    return splitter.connect(pokerSigner).receiveRake(stack.usdgAddress, amount);
  }

  before(async () => {
    fixture = await snapshotFixture(2n);
    stack = fixture.stack;
    splitter = stack.splitter;
  });

  beforeEach(async () => {
    await fixture.reset();
  });

  it('defaults to the 50/50 buyback/stakers split and stores its beneficiaries', async () => {
    expect(await splitter.buybackBps()).to.equal(5_000n);
    expect(await splitter.stakingBps()).to.equal(5_000n);
    // The vault leg of the rake is gone (FR-9.2 keeps the Vault for DEX fees only).
    expect(await splitter.vaultBps()).to.equal(0n);
    expect(await splitter.DEFAULT_BUYBACK_BPS()).to.equal(5_000n);
    expect(await splitter.buyback()).to.equal(stack.buybackBurnerAddress);
    expect(await splitter.staking()).to.equal(stack.stakingAddress);
    expect(await splitter.vault()).to.equal(stack.vaultAddress);
    expect(await splitter.poker()).to.equal(stack.pokerAddress);
  });

  it('rejects rake from any address other than the configured poker contract (FR-10)', async () => {
    await expect(splitter.connect(stack.players[0]).receiveRake(stack.tokenAddress, ethers.parseEther('1')))
      .to.be.revertedWithCustomError(splitter, 'NotPoker')
      .withArgs(stack.playerAddresses[0]!);
    await expect(splitter.connect(stack.owner).receiveRake(stack.tokenAddress, ethers.parseEther('1')))
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
      .withArgs(stack.pokerAddress, stack.tokenAddress, amount, amount / 2n, amount / 2n, amount);

    expect(await splitter.receivedOf(stack.tokenAddress)).to.equal(amount);
    expect(await splitter.pendingOf(stack.tokenAddress, stack.buybackBurnerAddress)).to.equal(amount / 2n);
    expect(await splitter.pendingOf(stack.tokenAddress, stack.stakingAddress)).to.equal(amount / 2n);
    expect(await splitter.totalCreditedTo(stack.tokenAddress, stack.buybackBurnerAddress)).to.equal(amount / 2n);
    expect(await splitter.totalCreditedTo(stack.tokenAddress, stack.stakingAddress)).to.equal(amount / 2n);
    // The vault is never credited any more.
    expect(await splitter.pendingOf(stack.tokenAddress, stack.vaultAddress)).to.equal(0n);
    expect(await splitter.totalCreditedTo(stack.tokenAddress, stack.vaultAddress)).to.equal(0n);
    // The splitter holds exactly what it owes.
    expect(await splitter.totalAssets(stack.tokenAddress)).to.equal(amount);
  });

  it('accounts per token: USDG and LLMPOKER rake never mix (dual currency)', async () => {
    const pokerSigner = await impersonatePoker();

    await pushRake(pokerSigner, ethers.parseEther('100'));
    await pushUsdgRake(pokerSigner, usdg('10')); // 10_000_000 base units

    expect(await splitter.receivedOf(stack.tokenAddress)).to.equal(ethers.parseEther('100'));
    expect(await splitter.receivedOf(stack.usdgAddress)).to.equal(usdg('10'));

    expect(await splitter.pendingOf(stack.tokenAddress, stack.buybackBurnerAddress)).to.equal(ethers.parseEther('50'));
    expect(await splitter.pendingOf(stack.usdgAddress, stack.buybackBurnerAddress)).to.equal(usdg('5'));

    // Balances are physically separate too.
    expect(await stack.token.balanceOf(stack.splitterAddress)).to.equal(ethers.parseEther('100'));
    expect(await stack.usdg.balanceOf(stack.splitterAddress)).to.equal(usdg('10'));

    expect(await splitter.totalAssets(stack.tokenAddress)).to.equal(ethers.parseEther('100'));
    expect(await splitter.totalAssets(stack.usdgAddress)).to.equal(usdg('10'));

    // Sweeping one token leaves the other untouched.
    await splitter.connect(stack.players[1]).sweepStaking(stack.usdgAddress, usdg('5'));
    expect(await stack.usdg.balanceOf(stack.stakingAddress)).to.equal(usdg('5'));
    expect(await splitter.receivedOf(stack.tokenAddress)).to.equal(ethers.parseEther('100'));
    expect(await stack.token.balanceOf(stack.splitterAddress)).to.equal(ethers.parseEther('100'));
  });

  it('sweeps the staking leg into the pool and notifies it (FR-9.4, FR-9.6)', async () => {
    const pokerSigner = await impersonatePoker();
    await pushRake(pokerSigner, ethers.parseEther('100'));

    await stack.staking.connect(stack.players[0]).stake(ethers.parseEther('1000'));

    await expect(splitter.connect(stack.players[1]).sweepStaking(stack.tokenAddress, ethers.parseEther('50')))
      .to.emit(splitter, 'Swept')
      .withArgs(stack.tokenAddress, stack.stakingAddress, stack.stakingAddress, ethers.parseEther('50'))
      .and.to.emit(stack.staking, 'RewardsNotified');

    expect(await stack.token.balanceOf(stack.stakingAddress)).to.equal(ethers.parseEther('1050'));
    expect(await stack.staking.pendingRewards(stack.playerAddresses[0]!)).to.equal(ethers.parseEther('50'));
    expect(await splitter.pendingOf(stack.tokenAddress, stack.stakingAddress)).to.equal(0n);
    expect(await splitter.pendingOf(stack.tokenAddress, stack.buybackBurnerAddress)).to.equal(ethers.parseEther('50'));
    expect(await splitter.totalAssets(stack.tokenAddress)).to.equal(ethers.parseEther('50'));
  });

  it('sweeps the buyback leg into the burner (the vault leg is gone)', async () => {
    const pokerSigner = await impersonatePoker();
    await pushRake(pokerSigner, ethers.parseEther('100'));

    await expect(splitter.connect(stack.players[1]).sweepBuyback(stack.tokenAddress, ethers.parseEther('50')))
      .to.emit(splitter, 'Swept')
      .withArgs(stack.tokenAddress, stack.buybackBurnerAddress, stack.buybackBurnerAddress, ethers.parseEther('50'))
      .and.to.emit(stack.buybackBurner, 'FeesReceived')
      .withArgs(stack.tokenAddress, stack.splitterAddress, ethers.parseEther('50'), ethers.parseEther('50'));

    expect(await stack.token.balanceOf(stack.buybackBurnerAddress)).to.equal(ethers.parseEther('50'));
    expect(await stack.buybackBurner.pendingOf(stack.tokenAddress)).to.equal(ethers.parseEther('50'));
    // The vault received nothing: FR-9.2's fee vault is no longer a rake beneficiary.
    expect(await stack.token.balanceOf(stack.vaultAddress)).to.equal(0n);
    expect(await splitter.totalAssets(stack.tokenAddress)).to.equal(ethers.parseEther('50'));
  });

  it('sweeps both legs of one token at once and never over-sweeps', async () => {
    const pokerSigner = await impersonatePoker();
    await pushRake(pokerSigner, ethers.parseEther('100'));

    await expect(splitter.connect(stack.players[1]).sweepAll(stack.tokenAddress)).to.emit(splitter, 'Swept');
    expect(await splitter.totalAssets(stack.tokenAddress)).to.equal(0n);
    expect(await splitter.pendingOf(stack.tokenAddress, stack.stakingAddress)).to.equal(0n);
    expect(await splitter.pendingOf(stack.tokenAddress, stack.buybackBurnerAddress)).to.equal(0n);

    await expect(splitter.connect(stack.players[1]).sweepBuyback(stack.tokenAddress, 1n))
      .to.be.revertedWithCustomError(splitter, 'InsufficientPending')
      .withArgs(1n, 0n);
    await expect(splitter.connect(stack.players[1]).sweepStaking(stack.tokenAddress, 1n))
      .to.be.revertedWithCustomError(splitter, 'InsufficientPending')
      .withArgs(1n, 0n);
  });

  it('routes an odd rake with the remainder to stakers (deterministic dust rule)', async () => {
    const pokerSigner = await impersonatePoker();
    await pushRake(pokerSigner, 101n);
    // The buyback leg floors; the staking leg absorbs the odd base unit.
    expect(await splitter.pendingOf(stack.tokenAddress, stack.buybackBurnerAddress)).to.equal(50n);
    expect(await splitter.pendingOf(stack.tokenAddress, stack.stakingAddress)).to.equal(51n);
    expect(await splitter.totalAssets(stack.tokenAddress)).to.equal(101n);
  });

  it('never strands dust for a spread of amounts (floor + remainder invariant)', async () => {
    const pokerSigner = await impersonatePoker();
    let total = 0n;
    for (const amount of [1n, 3n, 7n, 9_999n, 10_001n, 123_457n]) {
      await pushRake(pokerSigner, amount);
      total += amount;
    }
    const buyback = await splitter.pendingOf(stack.tokenAddress, stack.buybackBurnerAddress);
    const staking = await splitter.pendingOf(stack.tokenAddress, stack.stakingAddress);
    expect(buyback + staking).to.equal(total);
    expect(await splitter.totalAssets(stack.tokenAddress)).to.equal(total);
  });

  it('applies a retuned split to future rake only (FR-9.7)', async () => {
    const pokerSigner = await impersonatePoker();

    await pushRake(pokerSigner, ethers.parseEther('100'));
    await expect(splitter.connect(stack.owner).setBuybackBps(2_500n))
      .to.emit(splitter, 'SplitUpdated')
      .withArgs(5_000n, 2_500n);
    await pushRake(pokerSigner, ethers.parseEther('100'));

    // 25 % buyback after the retune, so the staking leg is the 75 % remainder.
    expect(await splitter.buybackBps()).to.equal(2_500n);
    expect(await splitter.stakingBps()).to.equal(7_500n);
    expect(await splitter.pendingOf(stack.tokenAddress, stack.buybackBurnerAddress)).to.equal(ethers.parseEther('75'));
    expect(await splitter.pendingOf(stack.tokenAddress, stack.stakingAddress)).to.equal(ethers.parseEther('125'));
    expect(await splitter.totalAssets(stack.tokenAddress)).to.equal(ethers.parseEther('200'));
  });

  it('allows a full 100 % buyback or 100 % staking split', async () => {
    const pokerSigner = await impersonatePoker();

    await splitter.connect(stack.owner).setBuybackBps(10_000n);
    await pushRake(pokerSigner, ethers.parseEther('10'));
    expect(await splitter.pendingOf(stack.tokenAddress, stack.buybackBurnerAddress)).to.equal(ethers.parseEther('10'));
    expect(await splitter.pendingOf(stack.tokenAddress, stack.stakingAddress)).to.equal(0n);

    await splitter.connect(stack.owner).setBuybackBps(0n);
    await pushRake(pokerSigner, ethers.parseEther('10'));
    expect(await splitter.pendingOf(stack.tokenAddress, stack.buybackBurnerAddress)).to.equal(ethers.parseEther('10'));
    expect(await splitter.pendingOf(stack.tokenAddress, stack.stakingAddress)).to.equal(ethers.parseEther('10'));
  });

  it('validates the split, the poker address and the buyback beneficiary', async () => {
    await expect(splitter.connect(stack.owner).setBuybackBps(10_001n)).to.be.revertedWithCustomError(
      splitter,
      'InvalidSplit',
    );
    await expect(splitter.connect(stack.players[0]).setBuybackBps(1n)).to.be.revertedWithCustomError(
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

    // `setBuyback` is owner-only and rejects the zero address (it is the wiring hook for
    // `BuybackBurner`, which does not exist yet at splitter-deploy time).
    await expect(splitter.connect(stack.players[0]).setBuyback(stack.playerAddresses[1]!)).to.be.revertedWithCustomError(
      splitter,
      'OwnableUnauthorizedAccount',
    );
    await expect(splitter.connect(stack.owner).setBuyback(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      splitter,
      'ZeroAddress',
    );
    await expect(splitter.connect(stack.owner).setBuyback(stack.playerAddresses[1]!))
      .to.emit(splitter, 'BuybackUpdated')
      .withArgs(stack.buybackBurnerAddress, stack.playerAddresses[1]!);
    expect(await splitter.buyback()).to.equal(stack.playerAddresses[1]!);
  });

  it('reverts a sweep while the beneficiary is unset instead of burning the leg', async () => {
    // A splitter wired before its burner cannot silently transfer the buyback leg nowhere.
    const splitterFactory = await hre.ethers.getContractFactory('RakeSplitter', stack.owner);
    const fresh = (await splitterFactory.deploy(
      stack.stakingAddress,
      stack.vaultAddress,
      stack.ownerAddress,
      5_000n,
    )) as any;
    await fresh.waitForDeployment();
    expect(await fresh.buyback()).to.equal(ethers.ZeroAddress);
    await expect(fresh.connect(stack.players[0]).sweepBuyback(stack.tokenAddress, 0n)).to.be.revertedWithCustomError(
      fresh,
      'ZeroAddress',
    );
  });

  it('reports zero for an unrelated beneficiary', async () => {
    expect(await splitter.pendingOf(stack.tokenAddress, stack.playerAddresses[4]!)).to.equal(0n);
    expect(await splitter.totalCreditedTo(stack.tokenAddress, stack.playerAddresses[4]!)).to.equal(0n);
    expect(await splitter.pendingOf(stack.usdgAddress, stack.playerAddresses[4]!)).to.equal(0n);
  });

  it('rejects a zero-token or zero-amount credit', async () => {
    const pokerSigner = await impersonatePoker();
    await expect(splitter.connect(pokerSigner).receiveRake(ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(
      splitter,
      'ZeroAddress',
    );
    await expect(splitter.connect(pokerSigner).receiveRake(stack.tokenAddress, 0n)).to.be.revertedWithCustomError(
      splitter,
      'InsufficientPending',
    );
    // Claiming rake the splitter does not hold is rejected (no phantom credits).
    await expect(
      splitter.connect(pokerSigner).receiveRake(stack.tokenAddress, ethers.parseEther('1')),
    )
      .to.be.revertedWithCustomError(splitter, 'InsufficientPending')
      .withArgs(ethers.parseEther('1'), 0n);
  });
});
