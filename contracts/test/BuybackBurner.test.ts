/**
 * BuybackBurner tests (FR-8.2, FR-9.2): fee intake access control, the **burn** path (LLMPOKER
 * fees burn directly; a fee token is swapped through the v2-shaped router and the output burned),
 * the **no-router hold** path that emits `BuybackPending` instead of pretending to swap, slippage
 * and deadline protection, and the spray-recovery path.
 *
 * The router here is `MockV2Router`, which implements the real `swapExactTokensForTokens` shape
 * (including the two v2 guard reverts) so the burner's call path is exercised as written.
 */

import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';
import { impersonateAccount, setBalance, time } from '@nomicfoundation/hardhat-network-helpers';

import { snapshotFixture, usdg, type PokerStack, type SnapshotFixture } from './support/helpers';

/** Mock router rate: 1 USDG (1e6) buys 1000 LLMPOKER (1e18 * 1000 / 1e6). */
const RATE = ethers.parseEther('1000');

describe('BuybackBurner (FR-8.2, FR-9.2)', () => {
  let fixture: SnapshotFixture;
  let stack: PokerStack;
  let burner: any;
  let router: any;
  /** The splitter, impersonated — it is the only account allowed to push fees by default. */
  let splitterSigner: any;

  before(async () => {
    fixture = await snapshotFixture(2n);
    stack = fixture.stack;
    burner = stack.buybackBurner;
  });

  beforeEach(async () => {
    await fixture.reset();
    const routerFactory = await hre.ethers.getContractFactory('MockV2Router', stack.owner);
    router = await routerFactory.deploy(stack.ownerAddress, RATE);
    await router.waitForDeployment();
    // Seed the router with LLMPOKER so it can pay out swaps.
    await stack.token.connect(stack.owner).transfer(await router.getAddress(), ethers.parseEther('100000'));

    // `RakeSplitter` is a contract, so its signer is impersonated here; the owner is funded with
    // both currencies in the fixture and acts as the external fee source.
    await impersonateAccount(stack.splitterAddress);
    await setBalance(stack.splitterAddress, ethers.parseEther('10'));
    splitterSigner = await hre.ethers.getSigner(stack.splitterAddress);
  });

  /** Push fees the way `RakeSplitter.sweepBuyback` does: transfer first, then credit. */
  async function pushFees(token: any, fromTokenHolder: any, amount: bigint): Promise<any> {
    await token.connect(fromTokenHolder).transfer(stack.buybackBurnerAddress, amount);
    return burner.connect(splitterSigner).receiveFees(await token.getAddress(), amount);
  }

  /**
   * The floor the burner derives when `minOut == 0`: `amount - amount * maxSlippageBps / 10000`,
   * read from the contract so the test cannot drift from the implementation.
   */
  async function burnerFloor(amount: bigint): Promise<bigint> {
    const bps = BigInt(await burner.maxSlippageBps());
    return amount - (amount * bps) / 10_000n;
  }

  /** Deploy a burner whose `splitter` is the poker stack's splitter (the fixture already does). */
  it('is inert until a router is configured and does not pretend to swap', async () => {    expect(await burner.router()).to.equal(ethers.ZeroAddress);
    expect(await burner.maxSlippageBps()).to.equal(100n);

    await pushFees(stack.usdg, stack.owner, usdg('10'));
    expect(await burner.pendingOf(stack.usdgAddress)).to.equal(usdg('10'));
    expect(await burner.totalFeesReceived(stack.usdgAddress)).to.equal(usdg('10'));

    // No router: the balance is held and the reason is public, rather than a fake swap.
    await expect(burner.connect(stack.players[0]).execute(stack.usdgAddress, [], 0n, 0n, 0n))
      .to.emit(burner, 'BuybackPending')
      .withArgs(stack.usdgAddress, usdg('10'), ethers.encodeBytes32String('NO_ROUTER'));

    expect(await burner.pendingOf(stack.usdgAddress)).to.equal(usdg('10'));
    expect(await stack.usdg.balanceOf(stack.buybackBurnerAddress)).to.equal(usdg('10'));
    expect(await burner.totalBurned()).to.equal(0n);
    // A second call is equally inert: nothing was lost.
    await burner.connect(stack.players[1]).execute(stack.usdgAddress, [], 0n, 0n, 0n);
    expect(await burner.pendingOf(stack.usdgAddress)).to.equal(usdg('10'));
  });

  it('burns LLMPOKER fees directly, with no swap and a real supply reduction', async () => {
    const amount = ethers.parseEther('25');
    await pushFees(stack.token, stack.owner, amount);

    const supplyBefore = await stack.token.totalSupply();
    const burnerBalanceBefore = await stack.token.balanceOf(stack.buybackBurnerAddress);

    await expect(burner.connect(stack.players[0]).execute(stack.tokenAddress, [], 0n, 0n, 0n))
      .to.emit(burner, 'Burned')
      .withArgs(stack.tokenAddress, amount, stack.playerAddresses[0]!)
      .and.to.emit(stack.token, 'Transfer')
      .withArgs(stack.buybackBurnerAddress, ethers.ZeroAddress, amount);

    expect(await burner.pendingOf(stack.tokenAddress)).to.equal(0n);
    expect(await burner.totalBurned()).to.equal(amount);
    expect(await stack.token.balanceOf(stack.buybackBurnerAddress)).to.equal(burnerBalanceBefore - amount);
    // The burn is real: total supply fell by exactly the burned amount.
    expect(await stack.token.totalSupply()).to.equal(supplyBefore - amount);
  });

  it('swaps a fee token through the pinned route and burns the LLMPOKER received', async () => {
    const amount = usdg('10');
    await pushFees(stack.usdg, stack.owner, amount);

    await burner
      .connect(stack.owner)
      .setRouterAndRoute(await router.getAddress(), stack.usdgAddress, [stack.usdgAddress, stack.tokenAddress]);
    expect(await burner.router()).to.equal(await router.getAddress());
    expect(await burner.routeOf(stack.usdgAddress)).to.deep.equal([stack.usdgAddress, stack.tokenAddress]);

    // The mock quotes 1000 LLMPOKER per USDG, so 10 USDG buys 10,000 LLMPOKER (18 decimals).
    const expectedOut = await router.quote(stack.usdgAddress, stack.tokenAddress, amount);
    expect(expectedOut).to.equal(ethers.parseEther('10000'));
    const supplyBefore = await stack.token.totalSupply();

    await expect(
      burner
        .connect(stack.players[1])
        .execute(stack.usdgAddress, [stack.usdgAddress, stack.tokenAddress], 0n, 0n, 0n),
    )
      .to.emit(burner, 'Burned')
      .withArgs(stack.usdgAddress, expectedOut, stack.playerAddresses[1]!);

    expect(await burner.totalBurned()).to.equal(expectedOut);
    expect(await stack.token.totalSupply()).to.equal(supplyBefore - expectedOut);
    // The fee token was consumed by the swap, not left behind.
    expect(await stack.usdg.balanceOf(stack.buybackBurnerAddress)).to.equal(0n);
    expect(await stack.usdg.balanceOf(await router.getAddress())).to.equal(amount);
    // No residual allowance survives the swap.
    expect(await stack.usdg.allowance(stack.buybackBurnerAddress, await router.getAddress())).to.equal(0n);
    expect(await router.swapCount()).to.equal(1n);
    // A real deadline was passed, not `block.timestamp`-derived zero.
    expect(await router.lastDeadline()).to.be.greaterThan(BigInt(await time.latest()));
  });

  it('enforces the slippage floor: a caller cannot loosen it, a bad trade reverts', async () => {
    const amount = usdg('10');
    await pushFees(stack.usdg, stack.owner, amount);
    await burner
      .connect(stack.owner)
      .setRouterAndRoute(await router.getAddress(), stack.usdgAddress, [stack.usdgAddress, stack.tokenAddress]);

    // The contract's floor is 99 % of the fee-token input (the route is LLMPOKER-terminated and
    // the mock converts 1:1 by token, so the units line up here).
    const floor = await burnerFloor(amount);

    await expect(
      burner
        .connect(stack.players[1])
        .execute(stack.usdgAddress, [stack.usdgAddress, stack.tokenAddress], floor - 1n, 0n, 0n),
    )
      .to.be.revertedWithCustomError(burner, 'InsufficientMinOut')
      .withArgs(floor - 1n, floor);

    // A caller-supplied `minOut` at the floor is accepted, and the router sees it.
    await burner
      .connect(stack.players[1])
      .execute(stack.usdgAddress, [stack.usdgAddress, stack.tokenAddress], floor, 0n, 0n);
    expect(await router.lastAmountOutMin()).to.equal(floor);

    // With `minOut == 0` the contract's own tolerance is passed to the router, not zero.
    await pushFees(stack.usdg, stack.owner, amount);
    await burner
      .connect(stack.players[1])
      .execute(stack.usdgAddress, [stack.usdgAddress, stack.tokenAddress], 0n, 0n, 0n);
    expect(await router.lastAmountOutMin()).to.equal(floor);

    // A stricter caller bound than the market can meet reverts at the router, and the pending
    // balance is left intact for a later attempt (the fee token was not consumed).
    await pushFees(stack.usdg, stack.owner, amount);
    await expect(
      burner
        .connect(stack.players[1])
        .execute(stack.usdgAddress, [stack.usdgAddress, stack.tokenAddress], ethers.parseEther('20000'), 0n, 0n),
    ).to.be.revertedWithCustomError(router, 'InsufficientOutputAmount');
    expect(await burner.pendingOf(stack.usdgAddress)).to.equal(amount);
    expect(await stack.usdg.balanceOf(stack.buybackBurnerAddress)).to.equal(amount);
  });

  it('rejects an expired deadline and an unpinned or malformed route', async () => {
    const amount = usdg('10');
    await pushFees(stack.usdg, stack.owner, amount);
    await burner
      .connect(stack.owner)
      .setRouterAndRoute(await router.getAddress(), stack.usdgAddress, [stack.usdgAddress, stack.tokenAddress]);

    const now = BigInt(await time.latest());
    await expect(
      burner.connect(stack.players[1]).execute(stack.usdgAddress, [stack.usdgAddress, stack.tokenAddress], 0n, 0n, now - 1n),
    )
      .to.be.revertedWithCustomError(burner, 'DeadlineExpired')
      .withArgs(now - 1n);

    // A route the owner never pinned is refused even though the router would accept it.
    await expect(
      burner
        .connect(stack.players[1])
        .execute(stack.usdgAddress, [stack.usdgAddress, stack.vaultAddress, stack.tokenAddress], 0n, 0n, 0n),
    ).to.be.revertedWithCustomError(burner, 'RouteNotConfigured');

    expect(await burner.pendingOf(stack.usdgAddress)).to.equal(amount);
  });

  it('only accepts fees from the splitter or a granted pusher (FR-10)', async () => {
    const amount = usdg('5');
    await stack.usdg.connect(stack.owner).transfer(stack.buybackBurnerAddress, amount);
    await expect(
      burner.connect(stack.players[0]).receiveFees(stack.usdgAddress, amount),
    )
      .to.be.revertedWithCustomError(burner, 'NotPusher')
      .withArgs(stack.playerAddresses[0]!);

    // A granted pusher may push; revoking closes the door again.
    await expect(burner.connect(stack.owner).setPusher(stack.playerAddresses[0]!, true))
      .to.emit(burner, 'PusherUpdated')
      .withArgs(stack.playerAddresses[0]!, true);
    expect(await burner.isPusher(stack.playerAddresses[0]!)).to.equal(true);
    await burner.connect(stack.players[0]).receiveFees(stack.usdgAddress, amount);
    expect(await burner.pendingOf(stack.usdgAddress)).to.equal(amount);

    await burner.connect(stack.owner).setPusher(stack.playerAddresses[0]!, false);
    await expect(burner.connect(stack.players[0]).receiveFees(stack.usdgAddress, 1n)).to.be.revertedWithCustomError(
      burner,
      'NotPusher',
    );

    // The configured splitter is always allowed, independent of the pusher flag.
    expect(await burner.splitter()).to.equal(stack.splitterAddress);
    await expect(
      burner.connect(stack.owner).setSplitter(ethers.ZeroAddress),
    ).to.be.revertedWithCustomError(burner, 'ZeroAddress');
  });

  it('rejects phantom credits and zero amounts', async () => {
    const amount = usdg('5');
    // Authorization is checked first, so only the configured splitter can even attempt a credit.
    await expect(
      burner.connect(stack.players[0]).receiveFees(stack.usdgAddress, amount),
    )
      .to.be.revertedWithCustomError(burner, 'NotPusher')
      .withArgs(stack.playerAddresses[0]!);

    // Nothing was transferred, so the credit must be rejected rather than booked.
    await expect(burner.connect(splitterSigner).receiveFees(stack.usdgAddress, amount))
      .to.be.revertedWithCustomError(burner, 'InsufficientFees')
      .withArgs(amount, 0n);

    await stack.usdg.connect(stack.owner).transfer(stack.buybackBurnerAddress, amount);
    await expect(burner.connect(splitterSigner).receiveFees(stack.usdgAddress, 0n)).to.be.revertedWithCustomError(
      burner,
      'ZeroAmount',
    );
    await expect(
      burner.connect(splitterSigner).receiveFees(ethers.ZeroAddress, amount),
    ).to.be.revertedWithCustomError(burner, 'ZeroAddress');
  });

  it('reverts execute for a token with nothing pending', async () => {
    await expect(burner.connect(stack.players[0]).execute(stack.usdgAddress, [], 0n, 0n, 0n))
      .to.be.revertedWithCustomError(burner, 'NothingToExecute')
      .withArgs(stack.usdgAddress);
  });

  it('sweeps a stray balance into the pending books, permissionlessly', async () => {
    const amount = usdg('3');
    // A plain transfer, no `receiveFees` call: the balance is unbooked.
    await stack.usdg.connect(stack.owner).transfer(stack.buybackBurnerAddress, amount);
    expect(await burner.pendingOf(stack.usdgAddress)).to.equal(0n);

    await expect(burner.connect(stack.players[2]).sweepStray(stack.usdgAddress))
      .to.emit(burner, 'FeesSwept')
      .withArgs(stack.usdgAddress, amount, amount);
    expect(await burner.pendingOf(stack.usdgAddress)).to.equal(amount);
    expect(await burner.totalFeesReceived(stack.usdgAddress)).to.equal(amount);

    // Sweeping again with nothing stray reverts rather than double-counting.
    await expect(burner.connect(stack.players[2]).sweepStray(stack.usdgAddress)).to.be.revertedWithCustomError(
      burner,
      'NothingToExecute',
    );
  });

  it('validates route configuration and owner-gated setters', async () => {
    await expect(
      burner.connect(stack.owner).setRouterAndRoute(ethers.ZeroAddress, stack.usdgAddress, [stack.usdgAddress, stack.tokenAddress]),
    ).to.be.revertedWithCustomError(burner, 'ZeroAddress');
    // A one-hop route cannot reach LLMPOKER.
    await expect(
      burner.connect(stack.owner).setRouterAndRoute(await router.getAddress(), stack.usdgAddress, [stack.usdgAddress]),
    ).to.be.revertedWithCustomError(burner, 'InvalidRoute');
    // A route whose first entry is not the fee token is refused.
    await expect(
      burner.connect(stack.owner).setRoute(stack.usdgAddress, [stack.tokenAddress, stack.usdgAddress]),
    ).to.be.revertedWithCustomError(burner, 'InvalidRoute');
    // A route whose last entry is not LLMPOKER is refused.
    await expect(
      burner
        .connect(stack.owner)
        .setRoute(stack.usdgAddress, [stack.usdgAddress, stack.vaultAddress]),
    ).to.be.revertedWithCustomError(burner, 'InvalidRoute');

    await expect(burner.connect(stack.players[0]).setRoute(stack.usdgAddress, [stack.usdgAddress, stack.tokenAddress]))
      .to.be.revertedWithCustomError(burner, 'OwnableUnauthorizedAccount');
    await expect(burner.connect(stack.players[0]).setMaxSlippageBps(1n)).to.be.revertedWithCustomError(
      burner,
      'OwnableUnauthorizedAccount',
    );
    await expect(burner.connect(stack.owner).setMaxSlippageBps(10_001n)).to.be.revertedWithCustomError(
      burner,
      'InvalidSlippage',
    );
    await expect(burner.connect(stack.owner).setMaxSlippageBps(250n))
      .to.emit(burner, 'MaxSlippageUpdated')
      .withArgs(100n, 250n);
    expect(await burner.maxSlippageBps()).to.equal(250n);
  });

  it('rejects an oversized slippage argument at execute time', async () => {
    await pushFees(stack.usdg, stack.owner, usdg('1'));
    await burner
      .connect(stack.owner)
      .setRouterAndRoute(await router.getAddress(), stack.usdgAddress, [stack.usdgAddress, stack.tokenAddress]);
    await expect(
      burner
        .connect(stack.players[1])
        .execute(stack.usdgAddress, [stack.usdgAddress, stack.tokenAddress], 0n, 10_001n, 0n),
    ).to.be.revertedWithCustomError(burner, 'InvalidSlippage');
  });

  it('cannot burn the same pending balance twice', async () => {
    const amount = ethers.parseEther('5');
    await pushFees(stack.token, stack.owner, amount);
    await burner.connect(stack.players[0]).execute(stack.tokenAddress, [], 0n, 0n, 0n);
    expect(await burner.totalBurned()).to.equal(amount);
    await expect(burner.connect(stack.players[0]).execute(stack.tokenAddress, [], 0n, 0n, 0n))
      .to.be.revertedWithCustomError(burner, 'NothingToExecute')
      .withArgs(stack.tokenAddress);
    expect(await burner.totalBurned()).to.equal(amount);
  });
});
