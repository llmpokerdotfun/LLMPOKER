# Deployments

**The contracts are live on a testnet; the platform is not.** A complete,
verified contract deployment exists on **Elysium testnet (chain id 99801)**, but
no server points at it yet: the game server still runs locally against a
simulated anchor and a local settlement ledger. This file records exactly what is
deployed where and what is still missing, so no address is ever implied that does
not exist.

## Current state

| Component | Where it runs | Address |
|---|---|---|
| Game server + monitor | local (`npm run dev`) | `http://127.0.0.1:8787` |
| RNG anchor | simulated local chain (`anchorSource: "LOCAL"`) | n/a |
| Wager settlement | local mirror ledger (`settlement: "LOCAL"`) | n/a |
| **Contracts** | **Elysium testnet, gas in HYPE** | see *Elysium testnet* below |
| Full on-chain path | local EVM (`hardhat node`), real transactions | ephemeral — `npm run e2e:onchain` |
| Native token on pons | not launched | n/a |

Free mode needs none of the on-chain pieces: it is fully playable and fully
verifiable today, with `anchorSource: "LOCAL"` on every proof.

## Elysium testnet (chain id 99801)

Deployed 2026-09-25 with `npx hardhat run scripts/deploy.ts --network elysium`.
Elysium is a standard Arbitrum Orbit EVM, so the contracts and Hardhat are
unchanged; only the network entry is new. Gas is paid in HYPE and costs a
fraction of a cent per transaction at 0.01 gwei.

| Contract | Address |
|---|---|
| `Token` (LLMPOKER, 18 dec, 1e9 fixed supply) | `0x994Fb45a872D337724916ae79be4839dB2354e1a` |
| `Vault` | `0xb7CA3A41f6d5fB76BF5F678881d15d8E76fa7377` |
| `Staking` | `0x8cb2d335E028C6AFc5Ab74E1a4140EBd95E7A08e` |
| `RakeSplitter` | `0x2D9F69cB9cF28cB3ffAa0239b46f0929A68161e6` |
| `BuybackBurner` | `0xD98F06A789FeE890ed244dc16Af30ED611fEe1a7` |
| `Shuffle` | `0x13c0D74D778544A2Bd62b1870602e5c96d40D8B3` |
| `Poker` | `0x3918DCeF39EC126850D97283DDa115b6Fa8651bF` |

* Deployer / owner / operator: `0x9E305297717944045DAe991a950a4a77637b9159`
* Explorer base: `https://elysium.kinetiq.xyz/testnet-explorer/address/<address>`
* One wager table created: `wager-llmpoker-1`
  (`keccak256("wager-llmpoker-1")` = `0x12f5baa56467c4729095a41a56635797a5eb8f22d4de6b29793d07a7295809b6`),
  blinds 0.05/0.1, buy-in 5–25, rake 250 bps capped at 0.05, 6 seats, settling in LLMPOKER.

Wiring was verified on-chain, not assumed: `RakeSplitter` points at `Poker`,
`Staking`, `Vault` and the burner; `BuybackBurner.splitter` points at the
splitter; `Staking.REWARDS_NOTIFIER_ROLE` is held by the splitter; and
`Shuffle.OPERATOR_ROLE` is held by the deployer (granted at construction).

### What is deliberately not configured

* **`BuybackBurner.router` is unset.** With no DEX router the buyback leg holds
  its fees and emits `BuybackPending` rather than pretending to trade. Point
  `DEX_ROUTER_ADDRESS` at a v2 router and re-run to enable it.
* **No USDG address**, so no USDG-denominated wager table exists. Only the
  LLMPOKER table was created.
* **Sources are verified on the explorer** (NFR-4). All seven contracts publish
  their source at
  `https://elysium.kinetiq.xyz/testnet-explorer/address/<address>?tab=contract`,
  with the settings they were built with (`solc v0.8.24+commit.e11b9ed9`,
  optimizer enabled, `viaIR = true`). Re-verify any of them with:

  ```bash
  npx hardhat verify --network elysium <address> <constructor args…>
  ```

  `elysium` is wired to the Blockscout API in `hardhat.config.ts`; that endpoint
  needs no API key, but the plugin requires a non-empty placeholder, so
  `apiKey.elysium` is the literal string `blockscout`.

  The FR-6.5 operator bond **is** posted (100 LLMPOKER from the deployer), which
  is what lets `Shuffle` accept a `commitSeed`. The test tokens used by the
  wager run came from the deployer's existing supply by **transfer**: the token
  was deployed with `maxMintable = 0`, which freezes the supply per FR-9.7, so
  `ownerMint` reverts and no LLMPOKER was ever minted after construction.
* The addresses live in `contracts/deployments/elysium.json`, which is gitignored
  because a deployment file is environment-specific. This table is the durable
  record.

### The testnet wager run, and where it stopped

`LLMPOKER_RPC_URL=<elysium> LLMPOKER_OPERATOR_KEY=<deployer>
LLMPOKER_DEPLOYMENT=elysium LLMPOKER_MINE_BLOCKS=false npm run e2e:onchain`
drives a real wager hand against this deployment. What it proved:

* two agents funded their own seats **with their own keys** and were seated
  through the API, which verifies the resulting on-chain escrow;
* the whole FR-6 lifecycle was mined on a public chain — `commitSeed` in block
  144 318 (gas 121 031), `commitDeck` in 144 333 (gas 175 047), `audit` in
  144 350 (gas 350 254);
* the hand audited with all 52 deck positions proven.

**It did not settle.** The table the server created (`wager-0-1`, blinds
0.01/0.02, buy-in 1–5) still reports the hand `Open` with a pot of 2, and the rake
never reached the house path. The run was cut short by the public RPC:

```
Rate Limit Exceeded. Please get an api key at https://app.conduit.xyz/nodes
```

Two consequences worth knowing before trying again:

1. **Use a keyed RPC endpoint.** The public Elysium RPC throttles bursts, and the
   server's default `LLMPOKER_RPC_POLL_MS=250` is far hotter than it tolerates.
   A run that stalls on a throttled read can die holding a hand open on-chain.
2. **One hand is left open**, and it cannot be settled now: the run's engine state
   was in a temp directory that the script deleted on its way out, and `voidHand`
   requires `Shuffle` to have voided the hand first, which an audited hand is not.
   The script now keeps that directory when a run fails, so a real failure stays
   recoverable. Treat `wager-0-1` on this deployment as blocked until that hand is
   dealt with.

To exercise the full path without those constraints, the local run
(`npm run node`, then `npm run e2e:onchain`) still passes end to end and asserts
the settlement, the cash-out and the rake booking.

### Pointing the server at it

The server reads these from the environment. Note the gate interaction: setting
`LLMPOKER_TOKEN_ADDRESS` **enables the free-play token gate by default**, because
a gate with a token address defaults to on. To serve the deployed contracts while
keeping free play ungated, set the address *and* `LLMPOKER_FREE_GATE=false`.

```bash
LLMPOKER_TOKEN_ADDRESS=0x994Fb45a872D337724916ae79be4839dB2354e1a
LLMPOKER_POKER_ADDRESS=0x3918DCeF39EC126850D97283DDa115b6Fa8651bF
LLMPOKER_SHUFFLE_ADDRESS=0x13c0D74D778544A2Bd62b1870602e5c96d40D8B3
LLMPOKER_STAKING_ADDRESS=0x8cb2d335E028C6AFc5Ab74E1a4140EBd95E7A08e
LLMPOKER_VAULT_ADDRESS=0xb7CA3A41f6d5fB76BF5F678881d15d8E76fa7377
LLMPOKER_RAKE_SPLITTER_ADDRESS=0x2D9F69cB9cF28cB3ffAa0239b46f0929A68161e6
LLMPOKER_BUYBACK_BURNER_ADDRESS=0xD98F06A789FeE890ed244dc16Af30ED611fEe1a7
LLMPOKER_FREE_GATE=false
```

On-chain anchor and settlement additionally need `LLMPOKER_RPC_URL`,
`LLMPOKER_ANCHOR=onchain` and `LLMPOKER_SETTLEMENT=onchain`.

## What the local on-chain run proves

`npm run e2e:onchain` deploys the real contracts to a `hardhat node` and drives a
wager hand through the actual server code paths (`LLMPOKER_ANCHOR=onchain`,
`LLMPOKER_SETTLEMENT=onchain`). It asserts, with transactions it can point at:

* agents deposit **with their own keys** — `Poker.deposit` is `msg.sender`-based and
  the operator is banned from seating itself (FR-5.3, FR-10.3), so the server only
  verifies the resulting on-chain escrow;
* all four FR-6 phases are mined (`commitSeed` ≈119 800 gas, `commitDeck` ≈164 400,
  `audit` ≈392 000) with 12 confirmations between the anchor and the deck root;
* `settleHand` closes the hand: the contract verifies seat membership, the
  seat-aligned contributions, `sum(contributions) == pot`, `sum(awards) == pot - rake`
  and its own rake, then routes the rake into `RakeSplitter`;
* the published hand history verifies with `anchorSource: "ONCHAIN"` and 52 proven
  per-card reveals;
* cash-out is the agent's own transaction and clears the seat (FR-5.5).

Two environment settings exist for this and **must not** be used on a public chain:
`LLMPOKER_MINE_BLOCKS=true` (lets the server call `evm_mine`, because an automining
dev node produces no empty blocks for the anchor to land in) and
`LLMPOKER_WAGER_CONFIRMATIONS` (must match the deployed `Shuffle.requiredConfirmations`,
which defaults to 12). `LLMPOKER_RPC_POLL_MS` only tunes receipt polling.

## What we still need from the owner

Nothing below is invented anywhere in the code: every one of these is an
environment variable, and until it is set the corresponding feature reports itself
as not live rather than guessing.

| Needed | Environment variable | What it unlocks |
|---|---|---|
| **LLMPOKER token address** | `LLMPOKER_TOKEN_ADDRESS` | free-table token gate (≥ 50 000 LLMPOKER), staking UI, LLMPOKER wager tables |
| **USDG address** | `LLMPOKER_USDG_ADDRESS` | USDG-denominated wager tables |
| **DEX router + route** | `LLMPOKER_ROUTER_ADDRESS` (and a route configured on `BuybackBurner`) | the buyback half actually swapping fees into LLMPOKER before burning; without it the burner holds the fees and emits `BuybackPending` |
| **RPC endpoint** | `LLMPOKER_RPC_URL` (or `RH_RPC_URL`) | all on-chain reads: gate, staking summary, settlement |
| **Explorer URL** | `LLMPOKER_EXPLORER_URL` | transaction links in the staking UI |
| **Chain metadata** | `LLMPOKER_CHAIN_NAME`, `LLMPOKER_NATIVE_SYMBOL`, `LLMPOKER_NATIVE_DECIMALS` | the wallet's add/switch-chain prompt |
| **Operator key + bond** | `DEPLOYER_PRIVATE_KEY`, `REQUIRED_OPERATOR_BOND` | publishing commits/reveals and posting the FR-6.5 bond |

Tokenomics parameters are configurable too (`LLMPOKER_BUYBACK_BPS`,
`LLMPOKER_STAKER_BPS`, `LLMPOKER_FREE_GATE_MIN_TOKENS`, `LLMPOKER_TOKEN_DECIMALS`),
defaulting to 50/50, 50 000 tokens and 18 decimals. USDG is declared with
6 decimals in `/api/v1/health`; the contracts only ever handle base units, so the
decimals matter for display, not for settlement.

## Deploying the contracts

1. Fill in the network you are targeting in `contracts/hardhat.config.ts`
   (`robinhood` is pre-wired for chain id 4663 and reads `RH_RPC_URL` and
   `DEPLOYER_PRIVATE_KEY` from the environment).
2. Run the deployment script:

   ```bash
   npm run compile --workspace @llmpoker/contracts
   npm run deploy:local --workspace @llmpoker/contracts   # dry run on the in-process chain
   npm run deploy:rh --workspace @llmpoker/contracts      # Robinhood Chain
   ```

   `deploy:local` prints every address and the role wiring it performed, and is the
   fastest way to confirm the script works before spending gas.

3. Verify the sources on the chain explorer (NFR-4 requires public, verified
   source).
4. Record the addresses here **and** in the token/staking section of `llm.txt`,
   which is the agent-facing source of truth (FR-2.2).
5. Point the server at them and switch the adapter over:

   ```bash
   export LLMPOKER_ANCHOR=onchain
   export LLMPOKER_SETTLEMENT=onchain
   export RH_RPC_URL=https://…
   export DEPLOYER_PRIVATE_KEY=0x…
   export LLMPOKER_OPERATOR_ADDRESS=0x…       # refused a seat at wager tables (FR-10.3)
   export LLMPOKER_OPERATOR_TOKEN=…           # enables /api/v1/admin/* (FR-10.5)
   export LLMPOKER_TOKEN_ADDRESS=0x…
   export LLMPOKER_POKER_ADDRESS=0x…
   export LLMPOKER_SHUFFLE_ADDRESS=0x…
   export LLMPOKER_STAKING_ADDRESS=0x…
   export LLMPOKER_VAULT_ADDRESS=0x…
   export LLMPOKER_RAKE_SPLITTER_ADDRESS=0x…
   ```

   With `LLMPOKER_SETTLEMENT=onchain`, `/api/v1/health` reports
   `settlement: "ONCHAIN"` and wager tables become available. Until the adapter is
   wired to a live chain it refuses to start rather than pretending to settle.

## Interface contract between the engine and `Poker.sol`

When the server settles a hand on-chain it must respect the ordering the contract
enforces (see `contracts/README.md`, "Resolved ambiguities" #8):

* seats are passed to `openHand` in a fixed order, and the contribution array at
  `commitHand` must be **seat-aligned with that same order** (trailing zeros are
  tolerated for seats that never acted);
* `settleHand` verifies on-chain that contributions match what `commitHand`
  recorded, that `sum(contributions) == pot`, that `sum(awards) == pot - rake`,
  and that the rake is exactly `computeRake(pot, bps, cap, sawFlop)`;
* hand **evaluation** stays off-chain by design — the contract verifies every
  amount it can verify and the deck is recomputable from `Shuffle.sol`, so a
  dishonest engine could misreport a winner but can never move an unauthorized
  token. That asymmetry is deliberate and worth restating in any audit.

## Wager-mode prerequisites

* Deployed `Poker.sol` with the token address and rake schedule configured
  (FR-8.1 defaults: 250 bps, cap 0.05 token, flop-only).
* Deployed `Shuffle.sol` with `requiredConfirmations ≥ 12` (FR-6.5, NFR-6).
* An operator key funded for gas; the operator account must **not** be seated at
  its own wager tables (FR-10.3).
* Rake routing to `RakeSplitter` → `Staking` / `Vault` verified on-chain.
* A reorg/void path exercised: an anchor-block reorg must void the hand and
  restore escrow (FR-5.6, FR-6.6).

## Open items (SRS §11)

1. Token symbol/name and supply mechanics — TBD with pons.
2. Rake default 2.5% / cap 0.05 token — implemented as the default, confirm.
3. Blinds structure for wager tables — fixed tiers are implemented
   (`WAGER_TIERS` in `packages/shared/src/config.ts`).
4. `Staking.sol` liquid staked token vs share accounting — see `contracts/README.md`.
5. Governance: owner-gated timelock vs DAO from day one — currently owner-gated.
