/**
 * On-chain acceptance run (SRS §8): wager mode against a **real EVM**, with real
 * transactions and the real contracts.
 *
 * This is the only test that exercises `OnChainAnchor` (all four FR-6 phases
 * through `Shuffle.sol`) and `OnChainSettlement` (escrow -> `openHand` ->
 * `commitHand` -> `settleHand` -> rake into `RakeSplitter`). Nothing here is
 * simulated except the chain itself, which is a local `hardhat node`.
 *
 * Usage:
 *   npm run node -w @llmpoker/contracts     # terminal 1: a real JSON-RPC with funded accounts
 *   npm run e2e:onchain                     # terminal 2: deploys and runs the wager hand
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcProvider, Contract, Wallet, parseEther, keccak256, toUtf8Bytes } from 'ethers';
import type { HDNodeWallet } from 'ethers';
import { AGENT_ACTION_TYPES, type HandHistory } from '@llmpoker/shared';
import { verifyHandHistory } from '@llmpoker/verifier';
import { buildApp } from '../packages/server/src/app.js';
import { createAnchor, createSettlement } from '../packages/server/src/chain.js';
import { loadConfig } from '../packages/server/src/config.js';
import { Orchestrator } from '../packages/server/src/orchestrator.js';
import { Store } from '../packages/server/src/store.js';

const RPC_URL = process.env.LLMPOKER_RPC_URL ?? 'http://127.0.0.1:8545';
/** Hardhat's first development account (public test key): owner + operator. */
const OWNER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const TABLE_ID = 'wager-0-1';
const BUY_IN = parseEther('2');
const DEPOSIT = parseEther('10');

const log = (message: string): void => console.log(message);

interface Tx {
  wait(): Promise<unknown>;
}
interface Erc20Abi {
  transfer(to: string, amount: bigint): Promise<Tx>;
  approve(spender: string, amount: bigint): Promise<Tx>;
  balanceOf(account: string): Promise<bigint>;
}
interface PokerAbi {
  deposit(tableId: string, seat: number, amount: bigint): Promise<Tx>;
  cashOut(tableId: string, seat: number): Promise<Tx>;
  escrowBalanceOf(tableId: string, seat: number): Promise<bigint>;
  totalEscrowObserved(): Promise<bigint>;
  pendingHandsOf(tableId: string): Promise<bigint>;
}
interface ShuffleAbi {
  requiredBond(): Promise<bigint>;
  postBond(amount: bigint): Promise<Tx>;
  bondOf(account: string): Promise<bigint>;
}
interface StakingAbi {
  totalStaked(): Promise<bigint>;
}

/** `ethers.Contract` is dynamically typed; this keeps one cast per call site. */
function bind<T>(address: string, abi: string[], signer: Wallet | HDNodeWallet): T {
  return new Contract(address, abi, signer) as unknown as T;
}

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
];
const POKER_ABI = [
  'function deposit(bytes32 tableId, uint8 seat, uint256 amount)',
  'function cashOut(bytes32 tableId, uint8 seat)',
  'function escrowBalanceOf(bytes32 tableId, uint8 seat) view returns (uint256)',
  'function totalEscrowObserved() view returns (uint256)',
  'function pendingHandsOf(bytes32 tableId) view returns (uint256)',
];
const SHUFFLE_ABI = [
  'function requiredBond() view returns (uint256)',
  'function postBond(uint256 amount)',
  'function bondOf(address account) view returns (uint256)',
];

async function rpcAlive(): Promise<boolean> {
  try {
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Deploys with the repo's own script and reads its machine-readable output. */
function deploy(): Record<string, string> {
  log('deploying contracts to the local node...');
  // A shell is required on Windows, where `npx` resolves to `npx.cmd`.
  execSync('npx hardhat run scripts/deploy.ts --network localhost', {
    cwd: join(process.cwd(), 'contracts'),
    stdio: 'inherit',
    env: { ...process.env, RH_RPC_URL: RPC_URL },
  });
  return JSON.parse(
    readFileSync(join(process.cwd(), 'contracts', 'deployments', 'localhost.json'), 'utf8'),
  ) as Record<string, string>;
}

async function main(): Promise<void> {
  if (!(await rpcAlive())) {
    throw new Error(`no JSON-RPC at ${RPC_URL}. Start one first:\n  npm run node -w @llmpoker/contracts`);
  }
  const probe = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: 0, pollingInterval: 100 });
  const chainId = BigInt((await probe.send('eth_chainId', [])) as string);
  log(`connected to ${RPC_URL} (chain id ${chainId})`);

  const deployment = deploy();
  const addresses = {
    token: deployment.token!,
    poker: deployment.poker!,
    shuffle: deployment.shuffle!,
    rakeSplitter: deployment.rakeSplitter!,
    staking: deployment.staking!,
    vault: deployment.vault!,
  };
  log(`token ${addresses.token}\npoker ${addresses.poker}\nshuffle ${addresses.shuffle}`);

  // Created *after* the deploy: the deploy script spends nonces from the same
  // account, and a provider with a nonce cache would build stale transactions.
  const provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: 0, pollingInterval: 100 });
  const owner = new Wallet(OWNER_KEY, provider);
  const token = bind<Erc20Abi>(addresses.token, ERC20_ABI, owner);
  const poker = bind<PokerAbi>(addresses.poker, POKER_ABI, owner);
  const shuffle = bind<ShuffleAbi>(addresses.shuffle, SHUFFLE_ABI, owner);
  const staking = bind<StakingAbi>(addresses.staking, ['function totalStaked() view returns (uint256)'], owner);
  const tableId32 = keccak256(toUtf8Bytes(TABLE_ID));

  // FR-6.5: the operator must have bonded before it can commit a seed.
  const requiredBond = await shuffle.requiredBond();
  if (requiredBond > 0n) {
    log(`posting the FR-6.5 operator bond (${requiredBond})...`);
    await (await token.approve(addresses.shuffle, requiredBond)).wait();
    await (await shuffle.postBond(requiredBond)).wait();
    log(`  bond posted: ${await shuffle.bondOf(await owner.getAddress())}`);
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'llmpoker-onchain-'));
  const config = loadConfig({
    LLMPOKER_ROOT: process.cwd(),
    LLMPOKER_CHAIN_ID: '31337', // the chain we are actually on, so signed actions carry the right domain
    LLMPOKER_DATA_DIR: dataDir,
    LLMPOKER_PERSIST: 'true',
    LLMPOKER_ANCHOR: 'onchain',
    LLMPOKER_SETTLEMENT: 'onchain',
    LLMPOKER_RPC_URL: RPC_URL,
    DEPLOYER_PRIVATE_KEY: OWNER_KEY,
    LLMPOKER_TOKEN_ADDRESS: addresses.token,
    LLMPOKER_POKER_ADDRESS: addresses.poker,
    LLMPOKER_SHUFFLE_ADDRESS: addresses.shuffle,
    LLMPOKER_STAKING_ADDRESS: addresses.staking,
    LLMPOKER_RAKE_SPLITTER_ADDRESS: addresses.rakeSplitter,
    // The FR-6.5 default, and what the deployed Shuffle enforces: the server must
    // not try to commit the deck root before the contract will accept it.
    LLMPOKER_WAGER_CONFIRMATIONS: '12',
    LLMPOKER_MINE_BLOCKS: 'true', // an automining node produces no empty blocks by itself
    LLMPOKER_RPC_POLL_MS: '100',
    LLMPOKER_WAGER_TABLES: '1',
    LLMPOKER_FREE_TABLES: '1',
    LLMPOKER_TICK_MS: '150',
    LLMPOKER_LOG_LEVEL: 'warn',
  } as NodeJS.ProcessEnv);

  const store = new Store({ dataDir, persist: true });
  const anchor = createAnchor(config);
  const settlement = createSettlement(config);
  if (anchor.kind !== 'ONCHAIN' || settlement.kind !== 'ONCHAIN') {
    throw new Error(`expected on-chain adapters, got anchor=${anchor.kind} settlement=${settlement.kind}`);
  }
  log(
    `adapters: anchor=${anchor.kind} settlement=${settlement.kind} clientSideDeposits=${settlement.clientSideDeposits}`,
  );

  const orchestrator = new Orchestrator({ config, store, anchor, settlement });
  orchestrator.on('error', (error: Error, context: string) => log(`  [orchestrator:${context}] ${error.message}`));
  orchestrator.init();
  await orchestrator.ensureTables();
  const { app, close } = await buildApp({ config, store, orchestrator });
  orchestrator.start();

  try {
    // -- two agents, each funding its own seat with its own key (FR-5.3) -----
    const agents: { name: string; wallet: HDNodeWallet; apiKey: string; agentId: string; seat: number }[] = [];
    for (const [seat, name] of ['OnChainA', 'OnChainB'].entries()) {
      const wallet = Wallet.createRandom().connect(provider);
      const registration = await app.inject({
        method: 'POST',
        url: '/api/v1/agents/register',
        payload: { name, wallet: wallet.address, metadata: { model: name } },
      });
      if (registration.statusCode !== 201) throw new Error(`register failed: ${registration.body}`);
      const body = registration.json() as { agent: { id: string }; apiKey: string };
      agents.push({ name, wallet, apiKey: body.apiKey, agentId: body.agent.id, seat });

      await (await token.transfer(wallet.address, DEPOSIT * 4n)).wait();
      // An agent pays its own gas, so it needs ETH as well as token.
      await (await owner.sendTransaction({ to: wallet.address, value: parseEther('1') })).wait();
      const agentToken = bind<Erc20Abi>(addresses.token, ERC20_ABI, wallet);
      await (await agentToken.approve(addresses.poker, DEPOSIT)).wait();
      const agentPoker = bind<PokerAbi>(addresses.poker, POKER_ABI, wallet);
      await (await agentPoker.deposit(tableId32, seat, BUY_IN * 2n)).wait();
      log(
        `agent ${name} deposited ${BUY_IN * 2n} on-chain into seat ${seat} (escrow ${await poker.escrowBalanceOf(tableId32, seat)})`,
      );
    }

    // -- seat them through the API, which *verifies* the on-chain escrow -----
    for (const agent of agents) {
      const seated = await app.inject({
        method: 'POST',
        url: `/api/v1/tables/${TABLE_ID}/seat`,
        headers: { authorization: `Bearer ${agent.apiKey}` },
        payload: { seat: agent.seat, buyIn: BUY_IN.toString() },
      });
      if (seated.statusCode !== 201) throw new Error(`seat failed: ${seated.body}`);
      log(`agent ${agent.name} seated at seat ${agent.seat} through the API`);
    }

    // -- play one hand, all-in preflop, so a flop is seen and rake applies ---
    // Wager actions are signed per action (FR-1.3) with a strictly increasing
    // per-hand nonce (FR-10.4), exactly as a real agent must.
    const credentials = new Map(agents.map((a) => [a.agentId, a]));
    const nonces = new Map<string, bigint>();
    const actionEnum: Record<string, number> = { FOLD: 0, CHECK: 1, CALL: 2, BET: 3, RAISE: 4, ALL_IN: 5 };
    const domain = {
      name: 'LLM Poker Arena',
      version: '1',
      chainId: Number(config.chainId),
      verifyingContract: addresses.poker,
    };

    // The hand must be allowed to start, so pause is applied *once it is live*:
    // pausing an idle table stops it ever dealing (FR-10.5), and `Poker.cashOut`
    // rejects a seat whose hand is still Open, so we need this hand to settle.
    let completed = false;
    let paused = false;
    for (let guard = 0; guard < 2400 && !completed; guard++) {
      const table = orchestrator.getTable(TABLE_ID);
      const hand = table.state.hand;
      const request = hand && !hand.complete ? orchestrator.actionRequest(table) : null;
      if (!request) {
        await new Promise((r) => setTimeout(r, 100));
        continue;
      }
      if (!paused) {
        orchestrator.pauseTable(TABLE_ID, true);
        paused = true;
        log('hand is live; table paused (FR-10.5) so no further hand is dealt');
      }
      const agentId = hand!.seats[request.seat]!.agentId!;
      const agent = credentials.get(agentId)!;
      const handId = hand!.handId;
      const nonceKey = `${agentId}:${handId}`;
      const nonce = (nonces.get(nonceKey) ?? 0n) + 1n;
      nonces.set(nonceKey, nonce);
      const deadline = Date.now() + 120_000;
      const signature = await agent.wallet.signTypedData(
        domain,
        { AgentAction: AGENT_ACTION_TYPES.AgentAction! },
        {
          agentId,
          tableId: TABLE_ID,
          handId,
          seat: request.seat,
          action: actionEnum.ALL_IN,
          amount: 0n,
          nonce,
          deadline,
        },
      );
      const response = await app.inject({
        method: 'POST',
        url: `/api/v1/tables/${TABLE_ID}/act`,
        headers: { authorization: `Bearer ${agent.apiKey}` },
        payload: {
          action: 'ALL_IN',
          nonce: nonce.toString(),
          deadline,
          signature,
        },
      });
      if (response.statusCode !== 200) throw new Error(`act failed: ${response.body}`);
      completed = (response.json() as { complete: boolean }).complete;
    }
    if (!completed) throw new Error('the hand never finished');
    log('hand played');

    // Settlement is submitted asynchronously; wait for the audit to land on-chain.
    let history: HandHistory | undefined;
    for (let i = 0; i < 150 && !history; i++) {
      const list = store.listHands({ tableId: TABLE_ID });
      if (list.hands.length > 0) {
        const candidate = store.getHand(list.hands[0]!.handId);
        if (candidate?.proof.auditTxHash) history = candidate;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!history) throw new Error('no audited hand history was recorded');

    log(`\nhand ${history.result.handId}`);
    log(`  pot            ${history.result.totalPot}`);
    log(`  rake           ${history.result.totalRake}`);
    log(`  anchor source  ${history.proof.anchorSource}`);
    log(`  reveals        ${history.proof.reveals.length} proven cards`);

    const verdict = verifyHandHistory(history);
    if (!verdict.ok) {
      const failed = [
        ...verdict.proof.checks,
        ...verdict.reveals.checks,
        ...verdict.deal.checks,
        ...verdict.settlement.checks,
      ].filter((c) => !c.ok);
      throw new Error(`published hand failed verification:\n${JSON.stringify(failed, null, 2)}`);
    }
    if (history.proof.anchorSource !== 'ONCHAIN') throw new Error('the proof is not chain-anchored');

    // Every FR-6 phase must be a real transaction on the node.
    for (const [label, hash] of [
      ['commitSeed', history.proof.commitTxHash],
      ['commitDeck', history.proof.deckRootTxHash],
      ['audit', history.proof.auditTxHash],
    ] as const) {
      if (!hash) throw new Error(`${label} has no transaction hash`);
      const receipt = await provider.getTransactionReceipt(hash);
      if (!receipt) throw new Error(`${label} transaction ${hash} is not on-chain`);
      log(`  ${label} mined in block ${receipt.blockNumber} (gas ${receipt.gasUsed})`);
    }

    const escrowObserved = await poker.totalEscrowObserved();
    log(`  escrow observed on-chain after settlement: ${escrowObserved}`);
    if (escrowObserved === 0n) throw new Error('the contract holds no escrow after settlement');

    // Settlement is submitted after the audit, so wait for the *contract* to report
    // the hand closed before touching escrow — `settleHand` is what clears the
    // seat's pending hand, and `cashOut` refuses to run while one is open.
    let pending = 1n;
    for (let i = 0; i < 300 && pending !== 0n; i++) {
      pending = await poker.pendingHandsOf(tableId32);
      if (pending !== 0n) await new Promise((r) => setTimeout(r, 100));
    }
    log(`  pending hands on-chain after settlement: ${pending}`);
    if (pending !== 0n) throw new Error('the contract still reports an open hand; settlement did not land');

    // FR-5.5: cash-out is the agent's own transaction. The table was paused before
    // the hand was played out, so the seat is idle and the contract will accept it.
    const agentA = agents[0]!;
    const agentPoker = bind<PokerAbi>(addresses.poker, POKER_ABI, agentA.wallet);
    await (await agentPoker.cashOut(tableId32, agentA.seat)).wait();
    const escrowA = await poker.escrowBalanceOf(tableId32, agentA.seat);
    log(`  ${agentA.name} cashed out; seat escrow now ${escrowA}`);
    if (escrowA !== 0n) throw new Error('cash-out did not clear the seat escrow');

    // FR-8.2: the rake left escrow and reached the house path atomically with the
    // settlement, so it must now sit in the splitter, staking or the vault. (Those
    // contracts hold *rewards*, not staked principal, which is why `totalStaked`
    // stays 0 until somebody stakes.)
    const rake = BigInt(history.result.totalRake);
    const houseBalances =
      (await token.balanceOf(addresses.rakeSplitter)) +
      (await token.balanceOf(addresses.staking)) +
      (await token.balanceOf(addresses.vault));
    log(`\nrake taken: ${rake}`);
    log(`  RakeSplitter ${await token.balanceOf(addresses.rakeSplitter)}`);
    log(`  Staking      ${await token.balanceOf(addresses.staking)}`);
    log(`  Vault        ${await token.balanceOf(addresses.vault)}`);
    log(`  staked principal (FR-9.4): ${await staking.totalStaked()}`);
    if (houseBalances < rake) {
      throw new Error(`rake did not reach the house path: expected at least ${rake}, found ${houseBalances}`);
    }
    log('\nON-CHAIN ACCEPTANCE RUN PASSED');
  } finally {
    await close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    console.error('\nON-CHAIN ACCEPTANCE RUN FAILED');
    console.error(error);
    process.exit(1);
  });
