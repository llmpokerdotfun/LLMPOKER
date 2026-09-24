/**
 * Token tests (FR-9.1): fixed supply, ERC-20 behaviour, EIP-2612 permit and the declared
 * minting policy (FR-9.7).
 */

import { expect } from 'chai';
import { ethers } from 'ethers';
import hre from 'hardhat';

const NAME = 'LLM Poker Arena';
const SYMBOL = 'POKER';
const SUPPLY = ethers.parseEther('1000000');
const CAP = ethers.parseEther('100000');

async function deployToken(
  maxMintable: bigint = 0n,
  supply: bigint = SUPPLY,
): Promise<{ token: any; owner: any; alice: any; bob: any }> {
  const [owner, alice, bob] = await hre.ethers.getSigners();
  const factory = await hre.ethers.getContractFactory('Token', owner);
  const token = await factory.deploy(NAME, SYMBOL, supply, await owner.getAddress(), maxMintable);
  await token.waitForDeployment();
  return { token, owner, alice, bob };
}

describe('Token (FR-9.1)', () => {
  it('has 18 decimals and mints the whole initial supply to the deployer', async () => {
    const { token, owner } = await deployToken();
    expect(await token.name()).to.equal(NAME);
    expect(await token.symbol()).to.equal(SYMBOL);
    expect(await token.decimals()).to.equal(18n);
    expect(await token.totalSupply()).to.equal(SUPPLY);
    expect(await token.balanceOf(await owner.getAddress())).to.equal(SUPPLY);
  });

  it('reports a fixed-supply minting policy by default (FR-9.7)', async () => {
    const { token } = await deployToken();
    const [fixedSupply, cap, minted] = await token.mintingPolicy();
    expect(fixedSupply).to.equal(true);
    expect(cap).to.equal(0n);
    expect(minted).to.equal(SUPPLY);
    expect(await token.maxMintable()).to.equal(0n);
  });

  it('transfers between accounts and emits Transfer', async () => {
    const { token, owner, alice } = await deployToken();
    const amount = ethers.parseEther('123.45');
    await expect(token.connect(owner).transfer(await alice.getAddress(), amount))
      .to.emit(token, 'Transfer')
      .withArgs(await owner.getAddress(), await alice.getAddress(), amount);
    expect(await token.balanceOf(await alice.getAddress())).to.equal(amount);
    expect(await token.totalSupply()).to.equal(SUPPLY);
  });

  it('rejects a transfer larger than the balance', async () => {
    const { token, alice, bob } = await deployToken();
    await expect(
      token.connect(alice).transfer(await bob.getAddress(), 1n),
    ).to.be.revertedWithCustomError(token, 'ERC20InsufficientBalance');
  });

  it('supports approve + transferFrom', async () => {
    const { token, owner, alice, bob } = await deployToken();
    const amount = ethers.parseEther('10');
    await token.connect(owner).approve(await alice.getAddress(), amount);
    expect(await token.allowance(await owner.getAddress(), await alice.getAddress())).to.equal(amount);
    await token.connect(alice).transferFrom(await owner.getAddress(), await bob.getAddress(), amount);
    expect(await token.balanceOf(await bob.getAddress())).to.equal(amount);
    expect(await token.allowance(await owner.getAddress(), await alice.getAddress())).to.equal(0n);
  });

  it('supports EIP-2612 permit (FR-9.1, agent UX)', async () => {
    const { token, owner, alice } = await deployToken();
    const value = ethers.parseEther('25');
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const nonce = await token.nonces(await owner.getAddress());

    const domain = {
      name: NAME,
      version: '1',
      chainId: (await hre.ethers.provider.getNetwork()).chainId,
      verifyingContract: await token.getAddress(),
    };
    const types = {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    };
    const message = {
      owner: await owner.getAddress(),
      spender: await alice.getAddress(),
      value,
      nonce,
      deadline,
    };
    const signature = await owner.signTypedData(domain, types, message);
    const { v, r, s } = ethers.Signature.from(signature);

    await token.permit(await owner.getAddress(), await alice.getAddress(), value, deadline, v, r, s);
    expect(await token.allowance(await owner.getAddress(), await alice.getAddress())).to.equal(value);
    expect(await token.nonces(await owner.getAddress())).to.equal(nonce + 1n);

    // Replaying the same signature must fail (nonce already consumed).
    await expect(
      token.permit(await owner.getAddress(), await alice.getAddress(), value, deadline, v, r, s),
    ).to.be.revertedWithCustomError(token, 'ERC2612InvalidSigner');
  });

  it('exposes the capped owner mint only when a cap is configured (FR-9.1, FR-9.7)', async () => {
    // Cap the total supply at CAP, with only a quarter of it minted at construction.
    const initial = CAP / 4n;
    const { token, owner, alice } = await deployToken(CAP, initial);
    const [fixedSupply, cap] = await token.mintingPolicy();
    expect(fixedSupply).to.equal(false);
    expect(cap).to.equal(CAP);

    await expect(token.connect(owner).ownerMint(await alice.getAddress(), CAP - initial))
      .to.emit(token, 'Minted')
      .withArgs(await alice.getAddress(), CAP - initial, CAP);
    expect(await token.totalSupply()).to.equal(CAP);

    // The immutable cap now binds: no further minting is possible.
    await expect(token.connect(owner).ownerMint(await alice.getAddress(), 1n))
      .to.be.revertedWithCustomError(token, 'MintCapExceeded')
      .withArgs(1n, 0n);
  });

  it('blocks ownerMint entirely when maxMintable is zero', async () => {
    const { token, owner, alice } = await deployToken(0n);
    await expect(token.connect(owner).ownerMint(await alice.getAddress(), 1n))
      .to.be.revertedWithCustomError(token, 'MintCapExceeded')
      .withArgs(1n, 0n);
  });

  it('restricts ownerMint to the owner', async () => {
    const { token, alice } = await deployToken(CAP);
    await expect(token.connect(alice).ownerMint(await alice.getAddress(), 1n)).to.be.revertedWithCustomError(
      token,
      'OwnableUnauthorizedAccount',
    );
  });
});
