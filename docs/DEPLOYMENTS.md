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
| `Shuffle.sol`, `Poker.sol`, `Token.sol`, `Staking.sol`, `Vault.sol`, `RakeSplitter.sol` | compiled and tested against the in-process Hardhat network | not deployed |
| Native token on pons | not launched | n/a |

Free mode needs none of the on-chain pieces: it is fully playable and fully
verifiable today, with `anchorSource: "LOCAL"` on every proof.

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
