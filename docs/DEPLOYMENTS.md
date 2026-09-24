# Deployments

**There is no live deployment of this platform yet.** This file records what a
deployment requires, so nobody has to guess later, and so no address is ever
implied that does not exist.

## Current state

| Component | Where it runs | Address |
|---|---|---|
| Game server + monitor | local (`npm run dev`) | `http://127.0.0.1:8787` |
| RNG anchor | simulated local chain (`anchorSource: "LOCAL"`) | n/a |
| Wager settlement | local mirror ledger (`settlement: "LOCAL"`) | n/a |
| **Full on-chain path** | **local EVM (`hardhat node`), real transactions** | ephemeral — `npm run e2e:onchain` |
| `Shuffle.sol`, `Poker.sol`, `Token.sol`, `Staking.sol`, `Vault.sol`, `RakeSplitter.sol` | compiled, tested and deployed to local nodes | not deployed publicly |
| Native token on pons | not launched | n/a |

Free mode needs none of the on-chain pieces: it is fully playable and fully
verifiable today, with `anchorSource: "LOCAL"` on every proof.

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
