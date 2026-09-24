/**
 * Deployment script for the LLM Poker Arena on-chain layer (SRS §6).
 *
 * Wiring order matters:
 *   1. `Token`   — fixed supply minted to the deployer (FR-9.1).
 *   2. `Vault`   — fee custody, 50/50 ops/trading-rewards split (FR-9.2–9.3).
 *   3. `Staking` — house-edge pool, 7-day cooldown (FR-9.4–9.6).
 *   4. `RakeSplitter` — 50/50 staking/vault schedule (FR-8.2).
 *   5. `Shuffle` — 12-confirmation anchor finality (FR-6).
 *   6. `Poker`   — escrow, pots, settlement (FR-5).
 *   7. Wire: `splitter.setPoker(poker)`, `staking.grantRole(REWARDS_NOTIFIER_ROLE, splitter)`,
 *      `shuffle.grantRole(OPERATOR_ROLE, operator)`.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.ts --network hardhat        # local, prints addresses
 *   RH_RPC_URL=... DEPLOYER_PRIVATE_KEY=... \
 *     npx hardhat run scripts/deploy.ts --network robinhood    # Robinhood Chain (id 4663)
 *
 * Env overrides (all optional):
 *   TOKEN_NAME, TOKEN_SYMBOL, TOKEN_SUPPLY, TOKEN_MAX_MINTABLE, OPERATOR_ADDRESS,
 *   REQUIRED_CONFIRMATIONS, STAKING_BPS, OPERATIONS_BPS, UNSTAKE_COOLDOWN_SECONDS,
 *   MIN_STAKE, RAKE_BPS, RAKE_CAP, MIN_BUY_IN, MAX_BUY_IN, SMALL_BLIND, BIG_BLIND, MAX_SEATS
 */

import { ethers } from 'ethers';
import hre from 'hardhat';

/** Defaults mirror `packages/shared/src/config.ts` (SRS §11 Q1–Q3). */
const DEFAULTS = {
  tokenName: 'LLM Poker Arena',
  /** SRS §11 Q1: the symbol is still TBD with pons, so it is overridable at deploy time. */
  tokenSymbol: 'POKER',
  supply: ethers.parseEther('1000000000'), // 1e9
  /** `0` = fixed supply, no post-launch minting (FR-9.7). */
  maxMintable: 0n,
  requiredConfirmations: 12n, // FR-6.5 DEFAULT_CONFIRMATIONS
  stakingBps: 5_000n, // FR-8.2 default split
  operationsBps: 5_000n, // FR-9.3 default split
  cooldownSeconds: 7n * 24n * 60n * 60n, // FR-9.5 UNSTAKE_COOLDOWN_SECONDS
  minStake: ethers.parseEther('1'),
  // 'low' wager tier from config.ts
  smallBlind: ethers.parseEther('0.05'),
  bigBlind: ethers.parseEther('0.1'),
  minBuyIn: ethers.parseEther('5'),
  maxBuyIn: ethers.parseEther('25'),
  rakeBps: 250n, // FR-8.1 DEFAULT_RAKE_BPS
  rakeCap: ethers.parseEther('0.05'), // FR-8.1 DEFAULT_RAKE_CAP
  maxSeats: 6,
};

function envBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : BigInt(raw);
}

function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

async function main(): Promise<void> {
  const [deployer] = await hre.ethers.getSigners();
  if (!deployer) throw new Error('no signer available: set DEPLOYER_PRIVATE_KEY for a live network');
  const deployerAddress = await deployer.getAddress();
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;

  const operator = envString('OPERATOR_ADDRESS', deployerAddress);
  const config = {
    tokenName: envString('TOKEN_NAME', DEFAULTS.tokenName),
    tokenSymbol: envString('TOKEN_SYMBOL', DEFAULTS.tokenSymbol),
    supply: envBigInt('TOKEN_SUPPLY', DEFAULTS.supply),
    maxMintable: envBigInt('TOKEN_MAX_MINTABLE', DEFAULTS.maxMintable),
    requiredConfirmations: envBigInt('REQUIRED_CONFIRMATIONS', DEFAULTS.requiredConfirmations),
    stakingBps: envBigInt('STAKING_BPS', DEFAULTS.stakingBps),
    operationsBps: envBigInt('OPERATIONS_BPS', DEFAULTS.operationsBps),
    cooldownSeconds: envBigInt('UNSTAKE_COOLDOWN_SECONDS', DEFAULTS.cooldownSeconds),
    minStake: envBigInt('MIN_STAKE', DEFAULTS.minStake),
    smallBlind: envBigInt('SMALL_BLIND', DEFAULTS.smallBlind),
    bigBlind: envBigInt('BIG_BLIND', DEFAULTS.bigBlind),
    minBuyIn: envBigInt('MIN_BUY_IN', DEFAULTS.minBuyIn),
    maxBuyIn: envBigInt('MAX_BUY_IN', DEFAULTS.maxBuyIn),
    rakeBps: envBigInt('RAKE_BPS', DEFAULTS.rakeBps),
    rakeCap: envBigInt('RAKE_CAP', DEFAULTS.rakeCap),
    maxSeats: Number(envBigInt('MAX_SEATS', BigInt(DEFAULTS.maxSeats))),
  };

  console.log(`Deploying LLM Poker Arena contracts`);
  console.log(`  chain id        : ${chainId.toString()}`);
  console.log(`  deployer        : ${deployerAddress}`);
  console.log(`  operator        : ${operator}`);
  console.log('');

  const token = await (
    await hre.ethers.getContractFactory('Token', deployer)
  ).deploy(config.tokenName, config.tokenSymbol, config.supply, deployerAddress, config.maxMintable);
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log(`Token          ${tokenAddress}  (${config.tokenSymbol}, supply ${config.supply})`);

  const vault = await (
    await hre.ethers.getContractFactory('Vault', deployer)
  ).deploy(tokenAddress, deployerAddress, config.operationsBps);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log(`Vault          ${vaultAddress}  (operationsBps ${config.operationsBps})`);

  const staking = await (
    await hre.ethers.getContractFactory('Staking', deployer)
  ).deploy(tokenAddress, deployerAddress, config.cooldownSeconds, config.minStake);
  await staking.waitForDeployment();
  const stakingAddress = await staking.getAddress();
  console.log(`Staking        ${stakingAddress}  (cooldown ${config.cooldownSeconds}s)`);

  const splitter = await (
    await hre.ethers.getContractFactory('RakeSplitter', deployer)
  ).deploy(tokenAddress, stakingAddress, vaultAddress, deployerAddress, config.stakingBps);
  await splitter.waitForDeployment();
  const splitterAddress = await splitter.getAddress();
  console.log(`RakeSplitter   ${splitterAddress}  (stakingBps ${config.stakingBps})`);

  const shuffle = await (
    await hre.ethers.getContractFactory('Shuffle', deployer)
  ).deploy(deployerAddress, config.requiredConfirmations);
  await shuffle.waitForDeployment();
  const shuffleAddress = await shuffle.getAddress();
  console.log(`Shuffle        ${shuffleAddress}  (requiredConfirmations ${config.requiredConfirmations})`);

  const poker = await (
    await hre.ethers.getContractFactory('Poker', deployer)
  ).deploy(tokenAddress, shuffleAddress, splitterAddress, deployerAddress, operator);
  await poker.waitForDeployment();
  const pokerAddress = await poker.getAddress();
  console.log(`Poker          ${pokerAddress}  (operator ${operator})`);

  console.log('');
  console.log('Wiring roles (FR-8.2, FR-9.6, FR-10.3)');
  // `ethers` types a `Contract` returned by `getContractFactory().deploy()` as `BaseContract`,
  // so the dynamic method calls are made through a local `Contract` view.
  const splitterContract = splitter as ethers.Contract;
  const stakingContract = staking as ethers.Contract;
  const shuffleContract = shuffle as ethers.Contract;
  const rewrewardsNotifierRole = (await stakingContract.REWARDS_NOTIFIER_ROLE!()) as string;
  const operatorRole = (await shuffleContract.OPERATOR_ROLE!()) as string;

  const wire: Array<[string, Promise<ethers.ContractTransactionResponse>]> = [
    ['splitter.setPoker(poker)', splitterContract.setPoker!(pokerAddress)],
    ['staking.grantRole(REWARDS_NOTIFIER_ROLE, splitter)', stakingContract.grantRole!(rewrewardsNotifierRole, splitterAddress)],
    ['shuffle.grantRole(OPERATOR_ROLE, operator)', shuffleContract.grantRole!(operatorRole, operator)],
  ];
  for (const [label, pending] of wire) {
    const receipt = await (await pending).wait();
    console.log(`  ${label}  (gas ${receipt?.gasUsed.toString() ?? 'n/a'})`);
  }

  console.log('');
  console.log('Addresses (record these):');
  console.log(
    JSON.stringify(
      {
        chainId: chainId.toString(),
        token: tokenAddress,
        vault: vaultAddress,
        staking: stakingAddress,
        rakeSplitter: splitterAddress,
        shuffle: shuffleAddress,
        poker: pokerAddress,
        owner: deployerAddress,
        operator,
      },
      null,
      2,
    ),
  );

  console.log('');
  console.log('Next steps:');
  console.log(`  1. createTable(bytes32 tableId, TableConfig) as the owner on Poker ${pokerAddress}.`);
  console.log('  2. Fund the operator key for commit/reveal gas.');
  console.log('  3. Verify the sources on the chain explorer (NFR-4).');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
