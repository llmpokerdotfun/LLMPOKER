# `@llmpoker/contracts` — on-chain layer

Solidity 0.8.24 + Hardhat 2 implementation of the on-chain half of LLM Poker Arena
(`SRS.md` §6, FR-5/6/8/9/10). Robinhood Chain, chain id **4663**.

```bash
npm run compile      # hardhat compile
npm test             # hardhat test            (144 tests, in-process network only)
npm run typecheck    # tsc -p tsconfig.json --noEmit
npm run deploy:local # hardhat run scripts/deploy.ts --network hardhat
npm run deploy:rh    # hardhat run scripts/deploy.ts --network robinhood
```

## Layout

```
src/Shuffle.sol        verifiable RNG: commit-reveal, next-block anchor, on-chain Fisher-Yates
src/Poker.sol          wager tables, per-seat escrow, pot settlement, on-chain rake
src/RakeSplitter.sol   rake routing: staking pool + fee vault
src/Staking.sol        house-edge pool: stake, accrue, claim, 7-day cooldown
src/Vault.sol          fee custody, operations vs trading-rewards split
src/Token.sol          ERC-20 + EIP-2612 permit (pons launch)
src/interfaces/*.sol   IShuffle, IRakeSplitter, IVault, IStaking, IToken
test/*.test.ts         mocha + chai suites (see "Test map" below)
scripts/deploy.ts      deployment + role wiring
```

## Requirement coverage

| Contract | SRS requirements |
|---|---|
| `Shuffle.sol` | FR-6.1–6.6 (commit, next-block anchor, reveal window, finality, void), FR-6.3 verifier surface, NFR-4, NFR-6 |
| `Poker.sol` | FR-5.1–5.6 (escrow, buy-in bounds, settlement, cash-out, void/refund), FR-8.1–8.3 (rake), FR-10.3 (operator cannot seat), FR-10.5 (pause) |
| `RakeSplitter.sol` | FR-8.2 (rake credited on-chain), FR-9 routing, FR-9.6 (public distribution events), FR-10 (authorized source) |
| `Staking.sol` | FR-9.4 (pro-rata yield), FR-9.5 (7-day cooldown), FR-9.6 (on-chain, observable rewards) |
| `Vault.sol` | FR-9.2 (fee inflow hook), FR-9.3 (ops vs trading-rewards split, role-gated withdrawal) |
| `Token.sol` | FR-9.1 (ERC-20, 18 decimals), FR-9.7 (declared, bounded minting policy) |
| tests | NFR-3 (O(seats) settlement, measured gas), NFR-6 (finality + reorg void) |

`Shuffle.sol` is a byte-exact implementation of `docs/RNG.md` §3; all six committed vectors in
`packages/shared/vectors/rng-vectors.json` are reproduced, including `wordsConsumed`.

## Test map

| File | Covers |
|---|---|
| `test/Shuffle.vectors.test.ts` | the six committed RNG vectors (deck **and** `wordsConsumed`), commitment/entropy parity with `packages/shared/src/rng.ts` |
| `test/Shuffle.lifecycle.test.ts` | commit/reveal happy path, wrong seed, pre-finality reveal, past-window reveal, void/expiry, immutability, confirmation bounds |
| `test/Poker.test.ts` | table config, buy-in bounds, operator seating ban, exact escrow movement, rake bps/cap/flop-only, double-settlement, void/refund, pause |
| `test/Poker.gas.test.ts` | 6-seat settlement gas + linearity in the seat count (NFR-3, printed to the test output) |
| `test/RakeSplitter.test.ts` | split schedule, authorized source, sweeps into staking/vault, cumulative totals |
| `test/Staking.test.ts` | stake/accrue/claim, cooldown, rounding dust, the stake-before-distribution defence, solvency |
| `test/Vault.test.ts` | ops/trading split, `notifyFees` hook, per-bucket access control |
| `test/Token.test.ts` | supply, transfers, permit, minting policy |
| `test/support/helpers.ts` | shared deployment fixture + snapshot reset (not a spec file) |

## Resolved ambiguities (choices made, and why)

The SRS leaves several conventions open. These are the ones this implementation picks; each is
also stated in the relevant contract NatSpec.

1. **Rake policy source of truth (SRS §11 Q2).** `Poker.sol` exposes
   `DEFAULT_RAKE_ONLY_WITH_FLOP = true` and always calls the pure `computeRake(pot, bps, cap,
   sawFlop, onlyWithFlop)` with it, mirroring `computeRake` in `packages/shared/src/config.ts`
   exactly (integer floor division, cap applied after the bps term, `0` without a flop). The
   policy is a public constant instead of a hidden argument so it is auditable on-chain.
2. **Rake split schedule (SRS §11 Q4 / FR-9).** A single owner-configurable `stakingBps`
   (default 5000, i.e. 50/50) with the vault taking the remainder, so a distribution can never
   strand dust. The SRS does not fix the split anywhere.
3. **Token symbol/name and supply (SRS §11 Q1).** Both are constructor arguments; nothing is
   hard-coded, and `scripts/deploy.ts` reads `TOKEN_NAME` / `TOKEN_SYMBOL` / `TOKEN_SUPPLY`.
   Default is 1e9 with 18 decimals.
4. **Token minting.** The SRS never asks for an inflatable token, and FR-9.7 wants parameters
   "immutable per deployment or gated behind a transparent owner/governance with timelock". A
   permanent mint authority is the one parameter that can dilute stakers and escrowed pots with
   no timelock, so the **default deployment is fixed-supply**: the constructor arg `maxMintable`
   is `0` (`TOKEN_MAX_MINTABLE` env), `ownerMint` then always reverts with `MintCapExceeded`, and
   `mintingPolicy()` reports `fixedSupply == true` on-chain. A non-zero cap is available for pons
   launch mechanics and is bounded by that immutable ceiling; renouncing ownership removes the
   capped path entirely. **There is no unbounded mint.**
5. **Who may seat.** `createTable` is owner-only, which is what makes FR-10.3 enforceable
   on-chain: the `operator` address is rejected by `deposit` at every wager table the owner
   created, and the prohibition follows `setOperator`. Free tables are off-chain and have no
   contract entry point at all (FR-4.1).
6. **Rake transfer style.** `Poker.sol` transfers the rake and then calls
   `RakeSplitter.receiveRake`, which verifies its own balance covers the credit. No allowance is
   required from `Poker`, so a settlement cannot fail on an approval misconfiguration. The
   splitter then holds both legs until a permissionless `sweepStaking` / `sweepVault` (or
   `sweepAll`) pushes them out; `sweepStaking` also calls `Staking.notifyRewards` so the pool
   accrues against tokens it already holds (FR-9.6).
7. **Chips leave escrow when they are committed**, not at settlement. `commitHand` debits the
   seat's escrow immediately, so the pot is collateralised from the moment the engine declares
   it and `token.balanceOf(Poker)` always equals the sum of the per-seat escrow — the strongest
   solvency statement available when escrow is per-seat rather than pooled. A void simply
   credits the recorded contributions back (FR-5.6).
8. **`settleHand` verifies what is verifiable on-chain**: seat membership, seat-aligned
   per-seat contributions matching what `commitHand` recorded, `sum(contributions) == pot`,
   `sum(awards) == pot - rake`, the rake itself, and hand/shuffle state. It deliberately does
   **not** evaluate poker hands — hand evaluation stays off-chain, and the deck that produced
   the hand is recomputable from `Shuffle.sol` by anyone (FR-6.3). The engine can thus
   misreport *who won*, which is exactly why the RNG is public, but it can never move a token it
   was not authorized for.
9. **Odd-chip / split-pot awards** are explicit calldata: the engine decides the odd chip and
   the contract only checks `sum(awards) == pot - rake` (FR-3.4 stays off-chain).
10. **Reorg path with an unrevealable shuffle.** A reorg can orphan the anchor block so the
    operator can no longer reveal inside the window, leaving `Shuffle` permanently `Committed`.
    `Poker.voidInvalidAnchor` lets the owner restore escrow once the reveal window has provably
    expired (`Shuffle.voidableFromBlockOf`). It is owner-gated, cannot settle anything, and can
    only return chips to the seats that contributed them. `Poker.voidHand` remains
    permissionless for the ordinary FR-6.6 timeout path.
11. **Staking reward scheme.** Cumulative reward-per-share accumulator (`rewardPerShareStored`,
    scaled 1e18) with per-account checkpoints, no time-based rate. Every entry point syncs the
    caller first, so no stake can earn retroactively; queued (cooldown) principal is moved out of
    the accumulator and earns nothing, which closes the flash-stake/exit arbitrage. Rounding dust
    is booked to the public `undistributedRewards` bucket and folded into the next distribution
    instead of vanishing, and a `minStake` floor keeps the pool from running dust-sized.
12. **EVM target.** The compiler emits `paris`-target bytecode (Hardhat's default for 0.8.24), so
    the contracts do not depend on `PUSH0`/`MCOPY` being available; this also let OpenZeppelin be
    pinned to `5.1.0`, whose minimum pragma is `^0.8.20` and which does not use `mcopy`.

## Environment / build notes

* **`contracts/package.json` has no `"type": "module"`.** Hardhat 2 loads its config with
  `require()`, and `ts-node` derives ESM/CJS from that field: with `"type": "module"` Hardhat
  aborts with `Error HH19: Your project is an ESM project ... but your Hardhat config file uses
  the .js extension`. `contracts/tsconfig.json` therefore compiles with `module: commonjs`, which
  is also what makes the TypeScript tests loadable. Nothing else in the workspace depends on the
  field.
* **`@nomicfoundation/hardhat-toolbox` is not imported.** In this environment its transitive
  `solidity-coverage` plugin throws `TypeError: subtask is not a function` at load time (from
  inside `hardhat/config`'s live re-exports, before the Hardhat context exists), which aborts
  config loading and leaves `hre.ethers` undefined. The toolbox only bundles plugins, so
  `hardhat.config.ts` imports the ones this suite uses — `@nomicfoundation/hardhat-ethers` and
  `@nomicfoundation/hardhat-chai-matchers`. `@nomicfoundation/hardhat-toolbox` remains a
  `devDependency` and is used for nothing else.
* **OpenZeppelin is pinned to `5.1.0`** (exact). 5.2+ pulls in `utils/Bytes.sol`, which uses the
  `mcopy` opcode and therefore requires a `cancun` (or later) EVM target; pinning keeps the
  compiler on `0.8.24` + `paris` as specified, with no behavioural difference for
  ERC20/Ownable/AccessControl/ReentrancyGuard/Pausable/SafeERC20.
* **`viaIR: true`** is enabled: `Poker.settleHand` verifies seat-aligned contributions, awards and
  rake in one frame, and the IR pipeline is what keeps a 6-seat settlement inside the EVM stack
  limit (NFR-3).
* **`robinhood` network is conditional.** It is only registered when `RH_RPC_URL` is set
  (`DEPLOYER_PRIVATE_KEY` optional), so a machine with no deployment secrets can still run the
  whole suite: `hardhat test` never touches the network beyond the in-process one.

## Measured gas (Hardhat in-process network, `test/Poker.gas.test.ts`)

| Operation | Gas |
|---|---|
| `settleHand`, 6 seats | **240 069** (0.40 % of a 60M block) |
| `settleHand` marginal cost per extra seat | ~2 996 |
| `settleHand`, 2 / 4 seats | 228 073 / 234 071 |
| `deposit` | 109 257 |
| `openHand` (6 seats) | 156 363 |
| `commitHand` | 85 862 |
| `Shuffle.reveal` (13 keccak words + 52-byte deck store) | 203 414 |
| `cashOut` | 59 222 |

`settleHand` is O(seats) storage work (FR-5.2, NFR-3) and the full on-chain shuffle fits
comfortably in a single transaction.

## Security notes

* No `tx.origin`, no `selfdestruct`, no unbounded loops over user-controlled arrays; every loop
  is bounded by `MAX_SEATS` (6) or by fixed-size calldata the caller must pay for.
* `ReentrancyGuard` on every function that moves tokens (`Poker.deposit`/`cashOut`/`settleHand`/
  `voidHand`/`voidInvalidAnchor`, `Vault.notifyFees`/`withdraw*`, `Staking.stake`/`requestUnstake`
  /`cancelUnstake`/`claim`, `RakeSplitter.receiveRake`/`sweep*`).
* `SafeERC20` for every token interaction; `Pausable` gates wager inflow and settlement but never
  `cashOut` (FR-10.5).
* The owner can never rewrite a recorded commitment, anchor hash, entropy or deck, cannot
  redirect escrow, and cannot force a settlement. Pausing is the only owner power over live
  hands, and it cannot trap already-settled funds.
* `pragma solidity 0.8.24;` exactly, optimizer on (200 runs), no floating pragmas.

## Known limitations / follow-ups

* **Staking interest is not modeled** — yield is exactly what `RakeSplitter` forwards; there is no
  emission schedule, so FR-9.4's "claimable per epoch" is satisfied by claim-on-demand rather
  than a discrete epoch counter.
* **`Staking` supports one pending unstake request at a time.** That is sufficient for the FR-9.5
  cooldown and keeps the accounting single-pass; a multi-request queue would be a UX upgrade, not
  a correctness one.
* **`Vault.notifyFees` is a per-call pull hook.** If pons ships an automatic fee-forwarder, point
  it at `notifyFees` (with an approval) or add a thin adapter; nothing about the split changes.
* **No on-chain hand evaluation** (see choice 8). The verifier path
  (`packages/verifier`, `packages/shared/src/dealing.ts`) is what ties a published deck to the
  dealt cards and the recorded hand.
