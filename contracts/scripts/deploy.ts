/**
 * Deployment script for the LLM Poker Arena on-chain layer (SRS §6).
 *
 * Wiring order matters:
 *   1. `Token`         — fixed supply minted to the deployer (FR-9.1). This is LLMPOKER.
 *   2. `Vault`         — DEX fee custody, 50/50 ops/trading-rewards split (FR-9.2–9.3). It is
 *                        **no longer** a rake beneficiary.
 *   3. `Staking`       — house-edge pool, 7-day cooldown (FR-9.4–9.6).
 *   4. `RakeSplitter`  — 50/50 buyback/stakers schedule (FR-8.2, revised tokenomics).
 *   5. `BuybackBurner` — converts the buyback leg into LLMPOKER and burns it (FR-9.2).
 *   6. `Shuffle`       — 12-confirmation anchor finality (FR-6).
 *   7. `Poker`         — escrow, pots, settlement, per-table settlement currency (FR-5).
 *   8. Wire: `splitter.setBuyback(burner)`, `burner.setSplitter(splitter)`, `splitter.setPoker(poker)`,
 *      `staking.grantRole(REWARDS_NOTIFIER_ROLE, splitter)`,
 *      `shuffle.grantRole(OPERATOR_ROLE, operator)`.
 *   9. Wager tables: one LLMPOKER table only when `TOKEN_ADDRESS` is set and one USDG table only
 *      when `USDG_ADDRESS` is set. A missing address is reported, never guessed — nothing in this
 *      repo hard-codes a token address.
 *
 * Usage:
 *   npx hardhat run scripts/deploy.ts --network hardhat        # local, prints addresses
 *   RH_RPC_URL=... DEPLOYER_PRIVATE_KEY=... \
 *     npx hardhat run scripts/deploy.ts --network robinhood    # Robinhood Chain (id 4663)
 *
 * Env overrides (all optional):
 *   TOKEN_NAME, TOKEN_SYMBOL, TOKEN_SUPPLY, TOKEN_MAX_MINTABLE, OPERATOR_ADDRESS,
 *   REQUIRED_CONFIRMATIONS, AUDIT_GRACE_BLOCKS, REQUIRED_OPERATOR_BOND, BUYBACK_BPS,
 *   OPERATIONS_BPS, UNSTAKE_COOLDOWN_SECONDS, MIN_STAKE,
 *   RAKE_BPS, RAKE_CAP, MIN_BUY_IN, MAX_BUY_IN, SMALL_BLIND, BIG_BLIND, MAX_SEATS,
 *   TOKEN_ADDRESS, USDG_ADDRESS, DEX_ROUTER_ADDRESS, DEX_ROUTE
 *
 * `STAKING_BPS` is not an input any more: the staking leg is the `10000 - BUYBACK_BPS` remainder,
 * which is what keeps the split dust-free.
 *
 * `RAKE_CAP`, `MIN_BUY_IN`, `MAX_BUY_IN`, `SMALL_BLIND`, `BIG_BLIND` are **base units** and apply
 * to the LLMPOKER table (18 decimals). The USDG table uses `USDG_*` variants of the same names,
 * also in base units, because USDG has 6 decimals:
 *   USDG_SMALL_BLIND, USDG_BIG_BLIND, USDG_MIN_BUY_IN, USDG_MAX_BUY_IN, USDG_RAKE_CAP, USDG_RAKE_BPS
 */

import { ethers } from 'ethers';
import hre from 'hardhat';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Defaults mirror `packages/shared/src/config.ts` (SRS §11 Q1–Q3). */
const DEFAULTS = {
  tokenName: 'LLM Poker Arena',
  /** SRS §11 Q1: the symbol is still TBD with pons, so it is overridable at deploy time. */
  tokenSymbol: 'POKER',
  supply: ethers.parseEther('1000000000'), // 1e9
  /** `0` = fixed supply, no post-launch minting (FR-9.7). */
  maxMintable: 0n,
  requiredConfirmations: 12n, // FR-6.5 DEFAULT_CONFIRMATIONS
  /** FR-6.7: blocks allowed between the deck-root commitment and the end-of-hand audit. */
  auditGraceBlocks: 7_200n, // ~24h at 12s blocks
  /** FR-6.5: operator bond, sized to exceed the rake a single hand can earn. */
  requiredBond: ethers.parseEther('100'),
  /** FR-8.2 revised tokenomics: 50 % buyback-and-burn, the remainder to stakers. */
  buybackBps: 5_000n,
  operationsBps: 5_000n, // FR-9.3 default split
  cooldownSeconds: 7n * 24n * 60n * 60n, // FR-9.5 UNSTAKE_COOLDOWN_SECONDS
  minStake: ethers.parseEther('1'),
  // 'low' wager tier from config.ts (18-decimal LLMPOKER base units)
  smallBlind: ethers.parseEther('0.05'),
  bigBlind: ethers.parseEther('0.1'),
  minBuyIn: ethers.parseEther('5'),
  maxBuyIn: ethers.parseEther('25'),
  rakeBps: 250n, // FR-8.1 DEFAULT_RAKE_BPS
  rakeCap: ethers.parseEther('0.05'), // FR-8.1 DEFAULT_RAKE_CAP
  maxSeats: 6,
  // USDG (6 decimals) equivalents — 'low' tier scaled to 1e6 base units per USDG.
  usdgSmallBlind: 50_000n, // 0.05 USDG
  usdgBigBlind: 100_000n, // 0.10 USDG
  usdgMinBuyIn: 5_000_000n, // 5 USDG
  usdgMaxBuyIn: 25_000_000n, // 25 USDG
  usdgRakeCap: 500_000n, // 0.50 USDG
} as const;

function envBigInt(name: string, fallback: bigint): bigint {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : BigInt(raw);
}

function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

function envOptional(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw === undefined || raw === '' ? undefined : raw;
}

/** `true` when `value` looks like a usable 20-byte address. */
function isAddress(value: string | undefined): value is string {
  return value !== undefined && ethers.isAddress(value);
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
    auditGraceBlocks: envBigInt('AUDIT_GRACE_BLOCKS', DEFAULTS.auditGraceBlocks),
    requiredBond: envBigInt('REQUIRED_OPERATOR_BOND', DEFAULTS.requiredBond),
    buybackBps: envBigInt('BUYBACK_BPS', DEFAULTS.buybackBps),
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
    usdgSmallBlind: envBigInt('USDG_SMALL_BLIND', DEFAULTS.usdgSmallBlind),
    usdgBigBlind: envBigInt('USDG_BIG_BLIND', DEFAULTS.usdgBigBlind),
    usdgMinBuyIn: envBigInt('USDG_MIN_BUY_IN', DEFAULTS.usdgMinBuyIn),
    usdgMaxBuyIn: envBigInt('USDG_MAX_BUY_IN', DEFAULTS.usdgMaxBuyIn),
    usdgRakeBps: envBigInt('USDG_RAKE_BPS', DEFAULTS.rakeBps),
    usdgRakeCap: envBigInt('USDG_RAKE_CAP', DEFAULTS.usdgRakeCap),
  };

  // LLMPOKER is deployed by this script unless an existing address is supplied; USDG always comes
  // from the environment because it is a third-party stablecoin.
  const suppliedTokenAddress = envOptional('TOKEN_ADDRESS');
  const suppliedUsdgAddress = envOptional('USDG_ADDRESS');
  const routerAddress = envOptional('DEX_ROUTER_ADDRESS');

  console.log(`Deploying LLM Poker Arena contracts`);
  console.log(`  chain id        : ${chainId.toString()}`);
  console.log(`  deployer        : ${deployerAddress}`);
  console.log(`  operator        : ${operator}`);
  console.log('');

  let tokenAddress: string;
  if (isAddress(suppliedTokenAddress)) {
    tokenAddress = suppliedTokenAddress;
    console.log(`Token          ${tokenAddress}  (reused from TOKEN_ADDRESS; not deployed here)`);
  } else {
    if (suppliedTokenAddress !== undefined) {
      console.log(`Token          TOKEN_ADDRESS is not a valid address, deploying a new LLMPOKER instead`);
    }
    const token = await (
      await hre.ethers.getContractFactory('Token', deployer)
    ).deploy(config.tokenName, config.tokenSymbol, config.supply, deployerAddress, config.maxMintable);
    await token.waitForDeployment();
    tokenAddress = await token.getAddress();
    console.log(`Token          ${tokenAddress}  (${config.tokenSymbol}, supply ${config.supply})`);
  }

  const vault = await (
    await hre.ethers.getContractFactory('Vault', deployer)
  ).deploy(tokenAddress, deployerAddress, config.operationsBps);
  await vault.waitForDeployment();
  const vaultAddress = await vault.getAddress();
  console.log(`Vault          ${vaultAddress}  (operationsBps ${config.operationsBps}; DEX fees only)`);

  const staking = await (
    await hre.ethers.getContractFactory('Staking', deployer)
  ).deploy(tokenAddress, deployerAddress, config.cooldownSeconds, config.minStake);
  await staking.waitForDeployment();
  const stakingAddress = await staking.getAddress();
  console.log(`Staking        ${stakingAddress}  (cooldown ${config.cooldownSeconds}s)`);

  const splitter = await (
    await hre.ethers.getContractFactory('RakeSplitter', deployer)
  ).deploy(stakingAddress, vaultAddress, deployerAddress, config.buybackBps);
  await splitter.waitForDeployment();
  const splitterAddress = await splitter.getAddress();
  console.log(
    `RakeSplitter   ${splitterAddress}  (buybackBps ${config.buybackBps} / stakingBps ` +
      `${10_000n - config.buybackBps})`,
  );

  const buybackBurner = await (
    await hre.ethers.getContractFactory('BuybackBurner', deployer)
  ).deploy(tokenAddress, deployerAddress, 0n);
  await buybackBurner.waitForDeployment();
  const buybackBurnerAddress = await buybackBurner.getAddress();
  console.log(
    `BuybackBurner  ${buybackBurnerAddress}  (router ${routerAddress ?? 'unset -> buyback inert'})`,
  );

  const shuffle = await (
    await hre.ethers.getContractFactory('Shuffle', deployer)
  ).deploy(
    tokenAddress,
    deployerAddress,
    config.requiredConfirmations,
    config.auditGraceBlocks,
    config.requiredBond,
  );
  await shuffle.waitForDeployment();
  const shuffleAddress = await shuffle.getAddress();
  console.log(
    `Shuffle        ${shuffleAddress}  (confirmations ${config.requiredConfirmations}, ` +
      `auditGrace ${config.auditGraceBlocks} blocks, requiredBond ${config.requiredBond})`,
  );

  const poker = await (
    await hre.ethers.getContractFactory('Poker', deployer)
  ).deploy(shuffleAddress, splitterAddress, deployerAddress, operator);
  await poker.waitForDeployment();
  const pokerAddress = await poker.getAddress();
  console.log(`Poker          ${pokerAddress}  (operator ${operator}; per-table settlement token)`);

  console.log('');
  console.log('Wiring roles (FR-8.2, FR-9.6, FR-10.3)');
  // `ethers` types a `Contract` returned by `getContractFactory().deploy()` as `BaseContract`,
  // so the dynamic method calls are made through a local `Contract` view.
  const splitterContract = splitter as ethers.Contract;
  const burnerContract = buybackBurner as ethers.Contract;
  const stakingContract = staking as ethers.Contract;
  const shuffleContract = shuffle as ethers.Contract;
  const rewardsNotifierRole = (await stakingContract.REWARDS_NOTIFIER_ROLE!()) as string;
  const operatorRole = (await shuffleContract.OPERATOR_ROLE!()) as string;

  // Each entry is a thunk, not a live promise. Building the array eagerly would
  // *send* all five transactions at once and only then await them, so they race
  // on the account nonce: a public RPC whose nonce view lags rejects the later
  // ones with "nonce too low" and the wiring half-lands. Sending strictly one at
  // a time and waiting for each receipt is slower by a few seconds and correct.
  const wire: Array<[string, () => Promise<ethers.ContractTransactionResponse>]> = [
    ['splitter.setBuyback(buybackBurner)', () => splitterContract.setBuyback!(buybackBurnerAddress)],
    ['splitter.setPoker(poker)', () => splitterContract.setPoker!(pokerAddress)],
    ['buybackBurner.setSplitter(splitter)', () => burnerContract.setSplitter!(splitterAddress)],
    [
      'staking.grantRole(REWARDS_NOTIFIER_ROLE, splitter)',
      () => stakingContract.grantRole!(rewardsNotifierRole, splitterAddress),
    ],
    ['shuffle.grantRole(OPERATOR_ROLE, operator)', () => shuffleContract.grantRole!(operatorRole, operator)],
  ];
  for (const [label, send] of wire) {
    const receipt = await (await send()).wait();
    console.log(`  ${label}  (gas ${receipt?.gasUsed.toString() ?? 'n/a'})`);
  }

  // The burn is inert until a router is configured; the route is pinned per fee token because a
  // v2 router takes `path` as calldata and a keeper must not be able to choose it (see NatSpec).
  let routerConfigured = false;
  if (isAddress(routerAddress)) {
    const usdgForRoute = isAddress(suppliedUsdgAddress) ? suppliedUsdgAddress : undefined;
    if (usdgForRoute) {
      const route = envString('DEX_ROUTE', `${usdgForRoute},${tokenAddress}`)
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const receipt = await (
        await burnerContract.setRouterAndRoute!(routerAddress, usdgForRoute, route)
      ).wait();
      console.log(`  buybackBurner.setRouterAndRoute(usdg)  (gas ${receipt?.gasUsed.toString() ?? 'n/a'})`);
    } else {
      const receipt = await (
        await burnerContract.setRouterAndRoute!(routerAddress, tokenAddress, [tokenAddress, tokenAddress])
      ).wait();
      console.log(`  buybackBurner router set with the LLMPOKER self-route only  (gas ${receipt?.gasUsed.toString() ?? 'n/a'})`);
    }
    routerConfigured = true;
  } else {
    console.log('  buybackBurner router NOT set: the buyback holds fees and emits BuybackPending (expected)');
  }

  console.log('');
  console.log('Wager tables (FR-5.1, dual currency)');
  const pokerContract = poker as ethers.Contract;
  const tables: Record<string, { tableId: string; settlementToken: string }> = {};
  const missing: string[] = [];

  const createTable = async (
    label: string,
    tableIdText: string,
    settlementToken: string,
    tableConfig: Record<string, unknown>,
  ): Promise<void> => {
    const tableId = ethers.keccak256(ethers.toUtf8Bytes(tableIdText));
    const receipt = await (await pokerContract.createTable!(tableId, tableConfig, settlementToken)).wait();
    tables[label] = { tableId, settlementToken };
    console.log(
      `  ${label} table created  (tableId ${tableId}, settles in ${settlementToken}, ` +
        `gas ${receipt?.gasUsed.toString() ?? 'n/a'})`,
    );
  };

  if (suppliedTokenAddress === undefined || isAddress(suppliedTokenAddress)) {
    // `suppliedTokenAddress === undefined` means we deployed LLMPOKER above, so its address is
    // known; an explicit valid `TOKEN_ADDRESS` was reused as-is.
    await createTable('llmpoker', 'wager-llmpoker-1', tokenAddress, {
      smallBlind: config.smallBlind,
      bigBlind: config.bigBlind,
      minBuyIn: config.minBuyIn,
      maxBuyIn: config.maxBuyIn,
      rakeBps: config.rakeBps,
      rakeCap: config.rakeCap,
      maxSeats: config.maxSeats,
    });
  } else {
    missing.push(`TOKEN_ADDRESS=${suppliedTokenAddress} is not a valid address (LLMPOKER table skipped)`);
  }

  if (isAddress(suppliedUsdgAddress)) {
    await createTable('usdg', 'wager-usdg-1', suppliedUsdgAddress, {
      smallBlind: config.usdgSmallBlind,
      bigBlind: config.usdgBigBlind,
      minBuyIn: config.usdgMinBuyIn,
      maxBuyIn: config.usdgMaxBuyIn,
      rakeBps: config.usdgRakeBps,
      rakeCap: config.usdgRakeCap,
      maxSeats: config.maxSeats,
    });
  } else {
    missing.push('USDG_ADDRESS (USDG-denominated wager table skipped)');
  }

  if (missing.length > 0) {
    console.log('');
    console.log('Skipped for missing configuration (set these and re-run, or create the tables later):');
    for (const entry of missing) {
      console.log(`  - ${entry}`);
    }
  }
  if (routerAddress === undefined) {
    console.log('');
    console.log('Skipped for missing configuration (set these and re-run):');
    console.log('  - DEX_ROUTER_ADDRESS (buyback swap is inert until a v2 router is set)');
  } else if (!routerConfigured) {
    console.log('');
    console.log('Router supplied but not wired; check DEX_ROUTER_ADDRESS.');
  }

  console.log('');
  console.log('Addresses (record these):');
  const deployment = {
    chainId: chainId.toString(),
    token: tokenAddress,
    usdg: isAddress(suppliedUsdgAddress) ? suppliedUsdgAddress : null,
    vault: vaultAddress,
    staking: stakingAddress,
    rakeSplitter: splitterAddress,
    buybackBurner: buybackBurnerAddress,
    shuffle: shuffleAddress,
    poker: pokerAddress,
    dexRouter: isAddress(routerAddress) ? routerAddress : null,
    tables,
    owner: deployerAddress,
    operator,
  };
  console.log(JSON.stringify(deployment, null, 2));

  // Machine-readable copy, so the server and the on-chain end-to-end script can
  // read the addresses instead of scraping stdout.
  const outFile = join('deployments', `${hre.network.name}.json`);
  mkdirSync('deployments', { recursive: true });
  writeFileSync(outFile, `${JSON.stringify({ ...deployment, network: hre.network.name }, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${outFile}`);

  console.log('');
  console.log('Next steps:');
  console.log(`  1. Fund the operator key for gas and have it postBond(requiredBond) on Shuffle ${shuffleAddress} (FR-6.5).`);
  console.log('  2. Set USDG_ADDRESS / DEX_ROUTER_ADDRESS as soon as they are known, then re-run to create the');
  console.log('     USDG table and enable the buyback swap.');
  console.log('  3. Verify the sources on the chain explorer (NFR-4).');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
