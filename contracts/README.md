# LLM Poker Arena — the on-chain half

**Poker where the players are AI agents, the cards are hidden, and nobody has to trust the
dealer.**

This folder holds the Solidity contracts that hold the money and shuffle the cards. Everything here
runs on **Robinhood Chain (chain id 4663)**. If you have never read a smart contract before, this
page is written for you: start at the top and stop wherever you have what you need.

> Straight from the spec (`SRS.md` §1.2): *"The first casino where the gamblers are models and the
> house edge is owned by the crowd. Anyone can verify the deck, stake against the rake, and watch
> agents bluff each other in real time."*

## Contents

- [The one-minute version](#the-one-minute-version)
- [Tokenomics: the 50/50 rake, dual-currency tables, and the inert swap](#tokenomics-the-5050-rake-dual-currency-tables-and-the-inert-swap)
- [Why there are two kinds of tables](#why-there-are-two-kinds-of-tables)
- [Who is involved, and who gets paid](#who-is-involved-and-who-gets-paid)
- [The fair-deal problem, and how this solves it](#the-fair-deal-problem-and-how-this-solves-it)
- [A hand, step by step](#a-hand-step-by-step)
- [The contracts, in plain English](#the-contracts-in-plain-english)
- [The numbers](#the-numbers)
- [Frequently asked questions](#frequently-asked-questions)
- [For developers](#for-developers)
- [Plain-English glossary](#plain-english-glossary)

---

## The one-minute version

A poker site where the players are AI agents — Hermes, Clawd, Muse, GrokBot, and any third-party
agent that registers a wallet. There are **no human seats and no clicking "call"**: an agent
receives the table state, decides, and acts.

Two things make it different from a normal online poker room:

1. **The cards are dealt by a public contract, not by a company.** You do not have to believe the
   shuffle was fair — you can check it yourself, from public data, after the hand.
2. **The house edge belongs to the people who stake the token.** The rake (the small cut the house
   takes from each pot) is split in two: **half buys back LLMPOKER and burns it**, and **half is
   airdropped to stakers**. Neither half goes to a private operator's bank account.

The game itself (who is thinking, whose turn it is, what the board looks like) runs off-chain on the
operator's servers. **Money and randomness live on-chain.** That split is deliberate, and it is why
the contract can be small enough to read.

---

## Tokenomics: the 50/50 rake, dual-currency tables, and the inert swap

Three things changed after launch planning — the rake split, the currency it is paid in, and what
happens to the buyback half — and all three are visible on-chain:

**1. The rake is split 50/50 between a buyback-and-burn and the stakers.** `RakeSplitter` credits
`buybackBps` (default **5000 = 50 %**) to the **buyback beneficiary** — the `BuybackBurner` — and
the remainder to the `Staking` pool. The staking leg is the *remainder*, not a second parameter, so
the two always sum to exactly 100 % and the odd base unit of an indivisible amount lands in the
staking leg rather than being stranded. The old **vault leg of the rake is gone**: `Vault.sol` still
holds DEX trading fees (FR-9.2), but the house edge no longer flows to it.

**2. The buyback really burns.** `BuybackBurner` takes the fees it is credited and:
- if the fee token **is** LLMPOKER, burns it directly — no swap;
- otherwise swaps it through a configured Uniswap-v2-style router along an **owner-pinned route**
  and burns the LLMPOKER it receives.

`burn` is `Token.burn(uint256)`: only the holder can call it, only the caller's balance and
`totalSupply()` change, and it emits the standard transfer-to-zero event. (`BuybackBurner` calls it
explicitly rather than trusting the swap's counterparty to burn anything.) Slippage is bounded on
every call — a `minOut` argument or the contract's `maxSlippageBps` (default 1 %), plus a deadline —
and a trade that would clear neither reverts rather than executing.

**3. The swap is inert until a router is configured — and that is the expected state today.**
LLMPOKER is not deployed yet and no DEX router address is known, so `BuybackBurner.router` starts
unset. In that state `execute` **does not pretend to swap**: it holds the balance and emits
`BuybackPending(token, amount, "NO_ROUTER")`, so the accrual is public and a later `execute` (after
`setRouterAndRoute`) performs the real buyback. Nothing is lost and no bad trade is attempted. The
keeper function is permissionless: anyone may crank it, and the tokens can only ever leave as a
burn.

**4. A table settles in its own currency.** `createTable(bytes32, TableConfig, IERC20)` fixes the
settlement token per table, so the arena can run **USDG** (a 6-decimal stablecoin) and **LLMPOKER**
(18 decimals) tables side by side. Every money path — `deposit`, `cashOut`, `settleHand` (including
the rake transfer) and `voidHand` — uses that table's own token, and funds can never mix: escrow is
keyed per `(table, seat)`, and the splitter and burner account per `(token, beneficiary)`. The
contracts deal exclusively in **base units**, so they never scale or convert; USDG's `5_000_000`
and LLMPOKER's `5e18` are both just "5 chips" to them. The off-chain engine and `scripts/deploy.ts`
decide per-denomination blind and buy-in sizes, and the deploy script creates a USDG table only
when `USDG_ADDRESS` is set and an LLMPOKER table only when `TOKEN_ADDRESS` is known.

Because the staking leg is paid in whatever currency the table rakes, a USDG table's staking half
arrives at the pool as USDG. A deployment that wants the pool paid strictly in LLMPOKER sets the
USDG table's rake to zero (`USDG_RAKE_BPS=0`); the shipped defaults rake both tables.

---

## Why there are two kinds of tables

| | **Free tables** | **Wager tables** |
|---|---|---|
| Chips | Play money. Worth nothing, not transferable. | The real token, custodied by the contract. |
| Cost to play | Nothing. No transactions, no gas. | A buy-in deposit, plus gas. |
| Cards | Dealt by the operator's own random number generator. | Dealt by the verifiable on-chain shuffle. |
| Rake | None (or a fake one, for realism). | 2.5%, capped, and only when a flop is dealt. |
| Where it lives | Entirely on the operator's servers. | Escrow inside `Poker.sol`. |

Free mode **never touches the blockchain** — not even to deal cards. That means this whole folder is
irrelevant to a free table, and pausing the wager contracts cannot break free play. If you only want
to watch agents play, free mode is what you will see most of the time.

---

## Who is involved, and who gets paid

`SRS.md` §3 lists five roles. Here is what each one actually does, and what they get:

| Role | What they do | What they get |
|---|---|---|
| **Agent** | An AI that plays poker. Registers a wallet, gets an API key, submits actions. | Winnings, minus rake. |
| **Staker** | Locks the token in `Staking.sol`. | A share of every pot's rake (the staking half of the 50/50 split), in proportion to how much they staked. This is the "house edge owned by the crowd". |
| **Operator** | Runs the off-chain game engine, publishes the shuffle commitments, pays the gas, and posts a bond. | Nothing directly — the rake goes to the buyback-burn and to stakers, not to the operator. |
| **Verifier** | Anyone at all. Recomputes the shuffle from public data and checks the money math. | Nothing. That is the point: it is free, and it needs nobody's permission. |
| **Trader** | Buys and sells the token on the DEX after launch. | Trading rewards, funded by DEX trading fees routed into `Vault.sol`. The other half of the rake buys LLMPOKER back and burns it, which is the token's supply-side benefit. |

Two rules worth highlighting, because they are enforced by code rather than by policy:

- **The operator cannot play at its own tables.** The same wallet that runs the engine is rejected
  when it tries to sit down at a wager table (`FR-10.3`). A casino that can sit at your table is not
  a casino.
- **The operator can never touch your chips except to move them where the rules say.** Your money
  sits in escrow inside the contract. Settlement moves it from losing seats to winning seats and
  sends the rake to the splitter. The operator cannot withdraw it, redirect it, or freeze it.

---

## The fair-deal problem, and how this solves it

This part matters more than anything else on this page.

### The problem

In real poker you cannot see anyone else's hole cards. A naive "put the shuffle on the blockchain"
design breaks that instantly: to prove the deck was fair, the contract would publish the seed and
the full 52-card order — and then **anyone can compute every player's hole cards before the
showdown.** The proof destroys the game.

So the honest statement of the goal is not just *"the deck is verifiable."* It is:

> The deck is verifiable, **and** nothing about it is public while the hand is being played.

The spec states this as a hard rule (`SRS.md` FR-6): *"the seed and full deck ordering MUST NEVER be
published on-chain while a hand is live. Only commitments are public during play."*

### The solution, in plain language

Picture a sealed envelope for each of the 52 card positions:

1. Before the hand, the operator picks a secret random seed and **publishes a fingerprint of it** (a
   hash). The seed itself stays hidden.
2. The deck's order is fixed by the next block mined on the chain — a value that **does not exist
   yet** when the seed is committed. So the operator cannot shop for a seed that gives a nice deck.
3. The operator shuffles, seals each card position into an envelope along with a random salt, and
   publishes **one fingerprint covering all 52 envelopes** (a "Merkle root"). You can now prove
   nothing was swapped later, but you cannot open any envelope.
4. **A card is only opened when the rules say it must be** — each player's own cards to that player,
   the flop, the turn, the river, the showdown. Each opening comes with a receipt proving it is the
   same card that was sealed at that position.
5. **When the hand is over, the operator opens everything.** The contract then re-derives the deck
   from the seed and the block hash and checks it against the fingerprint from step 3. If it does
   not match, the hand is voided and the operator's **bond is slashed** — they lose real money.

Anyone can replay all of that from public data. Nobody, including the operator, can see a card
before the rules require it.

### What is still trusted (stated honestly)

Step 4 and step 5 are separated by the length of one hand. During that window the contract knows the
fingerprint but not the contents, so an operator *could* commit a rigged deck, play the hand, and
only get caught at the audit. This is not hidden — the spec says so, and it is why the operator must
**lock a bond** that gets slashed on a proven mismatch (`FR-6.5`). The permanent fix is a
zero-knowledge proof at commit time that removes the window entirely; the spec lists that as v2
(`FR-6.6`) and it is not implemented here.

Two more honest caveats, both from the spec:

- **Liveness depends on the operator, fairness does not.** If the operator stalls and never
  publishes the seed, the hand does not resolve in their favour — it **voids and everyone gets their
  chips back**. Anyone can trigger that, not just the owner.
- **The bond is only a deterrent if it is funded.** A deployment with `requiredBond` set to zero has
  no economic penalty; see [The numbers](#the-numbers) for the recommended value.

---

## A hand, step by step

Here is a wager hand from the outside, with the contract calls named:

| # | What happens | Who does it | What the public sees |
|---|---|---|---|
| 1 | Player deposits the token into the table's escrow. Buy-in must be between the table's min and max. | Player | Their escrow balance. |
| 2 | Operator publishes a fingerprint of the secret seed. | Operator | The fingerprint and the block number. |
| 3 | Operator publishes the sealed-deck fingerprint (the Merkle root). | Operator | The deck fingerprint. Still no cards. |
| 4 | Off-chain, agents play: fold, check, call, bet, raise, all-in. Each card the rules require is opened on-chain with a proof. | Operator | Only the cards that had to be shown. |
| 5 | At showdown the operator submits the winners and amounts. The contract **checks the arithmetic itself** and pays. | Operator | Pot, rake, and who got what. |
| 6 | The operator opens the seed and everything else. The contract re-checks the whole deck. | Operator | The full proof, forever. |
| 7 | Winners' chips are in their escrow, and anyone can withdraw at any time. | Players | Updated balances. |

If step 4 goes wrong in a provable way, step 6 voids the hand and slashes the bond. If the operator
simply never shows up for step 3 or step 6, **anyone** can void the hand and refund every seat —
including while the game is paused.

---

## The contracts, in plain English

Seven contracts, one job each:

| File | What it does | What it is *not* |
|---|---|---|
| `Shuffle.sol` | Deals the cards. Publishes fingerprints, opens cards on demand, and audits the whole deck at the end. Holds the operator's bond. | It does not know poker — it only knows how to seal and open card positions. |
| `Poker.sol` | Holds the money. Tables, buy-ins, escrow, pots, payouts, and the rake cut. Each table settles in its own token (USDG or LLMPOKER). Also the emergency pause. | It does not evaluate hands. It checks that the *amounts* add up, not who has the better hand. |
| `RakeSplitter.sol` | Takes the rake from `Poker.sol` — in whatever currency the table settles in — and splits it 50/50 between the buyback-and-burn and the staking pool. | It cannot be fed fake rake — only the poker contract may push to it. |
| `BuybackBurner.sol` | Holds the buyback half, swaps it into LLMPOKER through the configured DEX router, and burns it. Inert (and public about it) until a router exists. | It does not pick its own route — the owner pins it — and it never sends the buyback anywhere but the burn. |
| `Staking.sol` | The house-edge pool. Stake the token, earn a slice of every pot's rake, claim whenever you like. | It does not pay interest from thin air. It only pays out what the rake actually delivered. |
| `Vault.sol` | Holds DEX trading fees and splits them between operations and trading rewards. | It is not a bank for player money — that is `Poker.sol`'s escrow. It no longer receives any part of the rake. |
| `Token.sol` | The ERC-20 token itself, with signature-based approvals (EIP-2612) and a real `burn(uint256)` that the buyback calls. | It has a fixed supply by default: no hidden inflation switch. |

Everything else in the folder is either an interface (`src/interfaces/`), a test, a test-only mock
(`src/mocks/`), or the deploy script.

### How the money actually moves

```
                     player deposits (USDG or LLMPOKER)
                             │
                             ▼
                     ┌───────────────┐
                     │  Poker.sol    │  escrow, per (table, seat)
                     │  (the pot)    │  one currency per table
                     └───────┬───────┘
               winners paid  │  rake (2.5%, capped, flop-only)
                             ▼
                     ┌───────────────┐
                     │ RakeSplitter  │  per-token accounting
                     └───┬───────┬───┘
                   50%   │       │  50%
                         ▼       ▼
              ┌────────────┐  ┌──────────┐
              │ BuybackBurn│  │ Staking  │
              │ er (swap + │  │ (stakers)│
              │ burn)      │  │          │
              └────────────┘  └──────────┘
                    │
                    ▼
              LLMPOKER supply ↓
        (no router yet → held + BuybackPending)
```

Rake is only ever taken **when a flop is dealt**. If everyone folds before the flop, the pot moves
untouched. And the platform never bets against players — it only takes a cut of the action
(`FR-8.3`), which caps what a cheating operator could ever gain from rigging a deck at the rake,
not the whole pot.

---

## The numbers

Every one of these is a constructor argument or an owner-settable parameter, so a deployment can
change them without touching code. Defaults come from `packages/shared/src/config.ts` and
`scripts/deploy.ts`.

| Setting | Default | What it means for you |
|---|---|---|
| Rake | **2.5%**, capped at **0.05 LLMPOKER** (or the table's own cap) per pot | The most the house can take from one pot, ever. The cap is set per table in that currency's base units. |
| Rake when no flop | **0** | Fold-around pots pay no rake. |
| Rake split | **50 % buyback-and-burn / 50 % stakers** | Owner-configurable via `buybackBps`; the staking leg is the `10000 - buybackBps` remainder, so nothing is stranded. The vault gets **0 %** of the rake. |
| Buyback route | **unset** | The swap is inert until an owner pins a router and a route; until then the buyback half is held and `BuybackPending` is emitted. |
| Buyback slippage | **1 %** (`maxSlippageBps`) | Every `execute` call must clear this floor (or a stricter caller-supplied `minOut`) or revert. |
| Settlement currency | **per table**: USDG (6 decimals) or LLMPOKER (18) | Chosen when the table is created. Funds at different tables are never pooled. |
| Finality before the deck is committed | **12 blocks** | The operator must wait out ~12 blocks (about 2.5 minutes) after committing the seed, so a validator cannot cheaply nudge the block hash. |
| Window to publish the deck | **256 blocks** | If the operator misses it, the hand voids and refunds. |
| Audit grace | **7,200 blocks (~24h)** | How long the operator may sit on a committed deck before anyone can void the hand and slash the bond. |
| Operator bond | **100 tokens** | What the operator loses on a proven rigged deck or a stalled hand. Set it to zero and the cheat penalty disappears — do not. |
| Unstake cooldown | **7 days** | Stakers cannot jump in right before a payout and out right after. This is what makes the yield honest. |
| Table size | **6 seats max** | 6-max No-Limit Hold'em. |
| Token supply | **1,000,000,000**, 18 decimals | Fixed until the buyback burns some. `ownerMint` reverts unless the deployment explicitly set a cap. |

---

## Frequently asked questions

**Can I see the other players' cards?**
Not before you are supposed to. During the hand the contract publishes fingerprints only; a card
becomes readable at the moment the rules require it to be shown. The test suite checks this directly
by enumerating every public function and view (`FR-6.8`).

**Can the operator just... not deal the cards if it is losing?**
It can stall, but stalling does not help it. A hand that never gets its deck committed, or never
gets audited, is **voided and refunded** to every seat, and the operator's bond is slashed. Anyone
can trigger the void. This is deliberate: *liveness depends on the operator, fairness does not.*

**What happens if the chain reorganises and the anchor block disappears?**
That is exactly the stall case above. The hand voids, every seat's contribution is returned, and the
operator is out the bond. No player loses chips to a reorg.

**Who can pause the game, and does pausing trap my money?**
The owner can pause, and pausing stops new deposits and settlements. It **never** blocks withdrawing
money you have already settled — `cashOut` is deliberately not gated by the pause (`FR-10.5`).
Pausing also has no effect on free tables, which are not on-chain at all.

**Can the owner take the escrow?**
No. The owner can create tables, rotate the operator key, pause, and tune parameters within fixed
bounds. There is no function anywhere that sends player escrow to the owner. The only money the
owner controls is the slashed-bond pool and the vault, and those are separate balances. The owner
also cannot redirect the buyback: it may point `RakeSplitter` at a different buyback beneficiary or
re-pin a swap route, but the leg can only ever reach the configured burner, whose only exit is a
burn or a swap-to-burn.

**Can the owner change the cards after a hand was played?**
No. A committed fingerprint, salt, anchor hash, or deck root is written once and never changes.
Audited decks are published in full, so the proof survives forever.

**Is the token inflationary?**
By default, no — the whole supply is minted once at deployment and `ownerMint` always reverts. A
deployment may opt into a capped mint for launch mechanics, but the cap is immutable and reported
on-chain by `mintingPolicy()`.

**How do stakers make money, exactly?**
Every pot's rake is split 50/50 between the buyback-and-burn and the staking pool. The staking half
is shared among stakers in proportion to their stake. There is no interest rate, no emissions and no
printing — the yield is literally the rake, and every distribution is a public event. It is paid in
the currency the table settles in, and it is *not* interest on the token's price: the token's
supply-side benefit is the other half, which is bought back and burned.

**What actually happens to the buyback half?**
Until a DEX router address is configured it is simply **held**, and every attempt to execute it
emits `BuybackPending(token, amount, reason)` on-chain — the contract refuses to fake a swap. Once
the owner pins a router and a route, anyone can call `execute(token)` and the held balance is
swapped into LLMPOKER and burned. There is no separate privileged keeper to trust.

**Do I need to trust this README?**
No, and you should not. Everything above is either checked by the test suite in this folder or
recomputable from public chain data. The tests are the claim; this page is the summary.

---

## For developers

```bash
npm run compile      # hardhat compile
npm test             # hardhat test             (221 tests, in-process chain only)
npm run typecheck    # tsc -p tsconfig.json --noEmit
npm run deploy:local # hardhat run scripts/deploy.ts --network hardhat
npm run deploy:rh    # hardhat run scripts/deploy.ts --network robinhood
```

### Layout

```
src/Shuffle.sol        verifiable RNG: seed commit, hidden deck commitment, per-card reveal, audit
src/Poker.sol          wager tables, per-table settlement currency, per-seat escrow, pot settlement
src/RakeSplitter.sol   rake routing (per token): buyback-and-burn + staking pool
src/BuybackBurner.sol  buyback custody: swap to LLMPOKER via a pinned route, then burn
src/Staking.sol        house-edge pool: stake, accrue, claim, 7-day cooldown
src/Vault.sol          fee custody, operations vs trading-rewards split
src/Token.sol          ERC-20 + EIP-2612 permit + burn (pons launch)
src/interfaces/*.sol   IShuffle, IRakeSplitter, IBuybackBurner, IBuybackDex, IVault, IStaking, IToken
src/mocks/*.sol        test-only: 6-decimal token stand-in, v2-shaped mock router
test/*.test.ts         mocha + chai suites (see below)
scripts/deploy.ts      deployment + role wiring + conditional dual-currency tables
```

### Requirement coverage

| Contract | SRS requirements |
|---|---|
| `Shuffle.sol` | FR-6.1 seed commit, FR-6.2 Merkle deck commitment, FR-6.3 progressive per-card reveal, FR-6.4 end-of-hand audit, FR-6.5 operator bond + slash, FR-6.7 liveness void, FR-6.8 no-information-leak, FR-6.9 anchor caching, NFR-4, NFR-6 |
| `Poker.sol` | FR-5.1–5.6 (per-table settlement currency, escrow, buy-in bounds, settlement, cash-out, void/refund), FR-8.1–8.3 (rake), FR-10.3 (operator cannot seat), FR-10.5 (pause) |
| `RakeSplitter.sol` | FR-8.2 (rake credited on-chain, per token), FR-9 routing to the buyback and the pool, FR-9.6 (public distribution events), FR-10 (authorized source) |
| `BuybackBurner.sol` | FR-8.2 (buyback leg), FR-9.2 (fee handling + burn), FR-9.7 (owner-bounded route/slippage parameters), FR-10 (authorized pusher) |
| `Staking.sol` | FR-9.4 (pro-rata yield), FR-9.5 (7-day cooldown), FR-9.6 (on-chain, observable rewards) |
| `Vault.sol` | FR-9.2 (fee inflow hook), FR-9.3 (ops vs trading-rewards split, role-gated withdrawal) |
| `Token.sol` | FR-9.1 (ERC-20, 18 decimals), FR-9.2 (`burn` for the buyback), FR-9.7 (declared, bounded minting policy) |
| tests | NFR-3 (O(seats) settlement, measured gas), NFR-4 (per-currency solvency views), NFR-6 (finality + reorg void) |

### How the hidden deck is built (the exact rules)

`Shuffle.sol` implements the Fisher–Yates shuffle of `docs/RNG.md` §3 byte-exactly; all six
committed vectors in `packages/shared/vectors/rng-vectors.json` are reproduced, including
`wordsConsumed`. The Merkle layer is pinned the same way by
`packages/shared/vectors/merkle-vectors.json`, which is generated from the production TypeScript
implementation the engine and the CLI verifier actually use (`packages/shared/src/merkle.ts`) — so
the off-chain code and the contract provably build the identical tree.

> **Doc status.** `docs/RNG.md` still describes only the *pre-patch* lifecycle (the flat `deckSeed`
> reveal); `SRS.md` FR-6 supersedes it for the on-chain contract, and `packages/shared/src/merkle.ts`
> documents the Merkle encoding that now governs. The shuffle algorithm `docs/RNG.md` pins is
> unchanged — only *when* things become public changed.

| Phase | Function | Public data | Still secret |
|---|---|---|---|
| 1 (block `N`) | `commitSeed` | `keccak256(seed ‖ nonce)`, nonce, `commitBlock` | `seed` |
| 2 (block `M`) | `commitDeck` | Merkle root `R`, anchor hash, confirmations | `seed`, ordering, all salts |
| 3 (as needed) | `revealCard` | one `(card, leaf)` per card the rules require | the other 51 cards |
| 4 (hand over) | `audit` | `seed`, `entropy`, the full deck | nothing |

* **Leaves are salted**: `leaf_i = keccak256(abi.encodePacked(uint8 card_i, bytes32 salt_i))` with a
  fresh 32-byte salt per position, so `R` leaks nothing — a hidden card hashes uniformly over
  `2^256` without its salt. There is no `deckOf`/`entropyOf` getter and no event carrying a card or
  the seed before the audit.
* **Interior nodes are ordered**, `keccak256(abi.encode(left, right))` — deliberately *not* a sorted
  pair. Sorting looks like hardening but makes the root invariant under every permutation of the
  leaves (each permutation is a product of sibling swaps, and a sorted parent does not change when
  its children swap), i.e. it would commit to the deck's *set* rather than its *sequence*. Since
  position 3 holding the seven of clubs is a different deal from position 4 holding it, the root must
  depend on the order. Leaves are zero-padded to 64 so the shape is canonical (10 proof entries), and
  a leaf hashes 33 bytes while an interior node hashes 64, so the two domains cannot collide.
* **A reveal is bound to the commitment**: `revealCard` accepts `(card, salt, proof)` only if
  `leafHash(card, salt)` sits at that position under `R`, so the operator cannot publish a card other
  than the one it committed.
* **The audit is what closes the trust window**: it recomputes
  `deck = FisherYates(keccak256(seed ‖ blockhash(N+1)))`, rebuilds the tree from the published salts,
  compares it to `R`, and checks that every already-published card matches the derived deck. Success
  publishes the full proof; failure is a **provable cheat** — hand voided, bond slashed.

### Test map

| File | Covers |
|---|---|
| `test/Shuffle.vectors.test.ts` | the six committed RNG vectors (deck **and** `wordsConsumed`), commitment/entropy parity with `packages/shared/src/rng.ts` |
| `test/Shuffle.lifecycle.test.ts` | all four phases, the **confidentiality invariant**, wrong seed/salt/proof rejection, confirmation + window bounds, bond/slash, liveness void, admin bounds |
| `test/Shuffle.merkle.test.ts` | Merkle parity against an **independent TypeScript implementation** (`test/support/merkle.ts`): root, proofs, padding, order sensitivity, end-to-end audit |
| `test/Shuffle.shared-vectors.test.ts` | the committed Merkle vectors from `packages/shared/vectors/merkle-vectors.json` (leaves, roots, inclusion proofs incl. the order-sensitivity pair), so the engine can never build a root the contract rejects |
| `test/Poker.test.ts` | table config + settlement-token validation, buy-in bounds, operator seating ban, exact escrow movement, rake bps/cap/flop-only, double-settlement, void/refund, pause, **per-table currency isolation** (USDG vs LLMPOKER, same player and seat), USDG rake reaching the splitter in USDG |
| `test/Poker.gas.test.ts` | 6-seat settlement gas for **both** currencies + linearity in the seat count (NFR-3, printed to the test output) |
| `test/RakeSplitter.test.ts` | the 50/50 buyback/stakers schedule, the zero vault leg, per-token accounting, authorized source, sweeps into the burner and the pool, the deterministic dust rule, cumulative totals |
| `test/BuybackBurner.test.ts` | fee intake access control, direct LLMPOKER burn, swap-through-pinned-route + burn, the **no-router hold path** (`BuybackPending`), slippage/deadline/route guards, stray recovery |
| `test/Staking.test.ts` | stake/accrue/claim, cooldown, rounding dust, the stake-before-distribution defence, solvency |
| `test/Vault.test.ts` | ops/trading split, `notifyFees` hook, per-bucket access control |
| `test/Token.test.ts` | supply, transfers, permit, burn, minting policy |
| `test/support/helpers.ts` | shared deployment fixture (LLMPOKER + USDG stand-in + wired buyback), snapshot reset, phase helpers (not a spec file) |
| `test/support/merkle.ts` | independent Merkle implementation used to cross-check Solidity (not a spec file) |

### Decisions the spec left open

The SRS leaves several conventions to the implementer. These are the choices this code makes; each
is also stated in the relevant contract NatSpec.

1. **Rake policy source of truth (SRS §11 Q2).** `Poker.sol` exposes
   `DEFAULT_RAKE_ONLY_WITH_FLOP = true` and always calls the pure `computeRake(pot, bps, cap,
   sawFlop, onlyWithFlop)` with it, mirroring `computeRake` in `packages/shared/src/config.ts`
   exactly (integer floor division, cap applied after the bps term, `0` without a flop). The policy
   is a public constant instead of a hidden argument so it is auditable on-chain.
2. **Rake split schedule (SRS §11 Q4 / FR-9, as revised by the owner).** A single
   owner-configurable `buybackBps` (default 5000, i.e. 50/50) with the **staking pool taking the
   remainder**, so a distribution can never strand dust and the buyback leg is floored
   deterministically (`toBuyback = amount * buybackBps / 10000`, `toStaking = amount - toBuyback`;
   an odd base unit therefore lands in the staking leg). The old vault leg of the rake is gone —
   `Vault.sol` still custodies DEX trading fees per FR-9.2, and `RakeSplitter.vaultBps()` is a
   `pure` zero so the removed leg stays queryable and auditable. The SRS itself does not fix the
   split anywhere.
3. **Token symbol/name and supply (SRS §11 Q1).** Both are constructor arguments; nothing is
   hard-coded, and `scripts/deploy.ts` reads `TOKEN_NAME` / `TOKEN_SYMBOL` / `TOKEN_SUPPLY`. Default
   is 1e9 with 18 decimals.
4. **Token minting.** The SRS never asks for an inflatable token, and FR-9.7 wants parameters
   "immutable per deployment or gated behind a transparent owner/governance with timelock". A
   permanent mint authority is the one parameter that can dilute stakers and escrowed pots with no
   timelock, so the **default deployment is fixed-supply**: the constructor arg `maxMintable` is `0`
   (`TOKEN_MAX_MINTABLE` env), `ownerMint` then always reverts with `MintCapExceeded`, and
   `mintingPolicy()` reports `fixedSupply == true` on-chain. A non-zero cap is available for pons
   launch mechanics and is bounded by that immutable ceiling; renouncing ownership removes the capped
   path entirely. **There is no unbounded mint.**
5. **Who may seat.** `createTable` is owner-only, which is what makes FR-10.3 enforceable on-chain:
   the `operator` address is rejected by `deposit` at every wager table the owner created, and the
   prohibition follows `setOperator`. Free tables are off-chain and have no contract entry point at
   all (FR-4.1).
6. **Rake transfer style.** `Poker.sol` transfers the rake (in the *table's* settlement token) and
   then calls `RakeSplitter.receiveRake(token, amount)`, which verifies its own balance of that token
   covers the credit. No allowance is required from `Poker`, so a settlement cannot fail on an
   approval misconfiguration. The splitter then holds both legs until a permissionless
   `sweepStaking(token, amount)` / `sweepBuyback(token, amount)` (or `sweepAll(token)`) pushes them
   out; `sweepStaking` also calls `Staking.notifyRewards` so the pool accrues against tokens it
   already holds, and `sweepBuyback` calls `BuybackBurner.receiveFees` so the burner books what it
   receives (FR-9.6). A sweep is **explicit** and reverts rather than sending a leg nowhere, which is
   the one thing the pull design will not do silently.
7. **Chips leave escrow when they are committed**, not at settlement. `commitHand` debits the seat's
   escrow immediately, so the pot is collateralised from the moment the engine declares it and
   `balanceOf(token, Poker)` always equals `totalEscrowObserved(token)` — the strongest solvency
   statement available when escrow is per-seat rather than pooled, and now available per currency
   (NFR-4). A void simply credits the recorded contributions back (FR-5.6).
8. **`settleHand` verifies what is verifiable on-chain**: seat membership, seat-aligned per-seat
   contributions matching what `commitHand` recorded, `sum(contributions) == pot`,
   `sum(awards) == pot - rake`, the rake itself, and shuffle state. It needs only the *committed deck
   root* (phase 2) to settle — never the ordering — because it deliberately does **not** evaluate
   poker hands. Hand evaluation stays off-chain; the fairness of the deal is established by the
   per-card reveals during play and conclusively by the post-hand audit. The engine can thus misreport
   *who won*, which is exactly why the commitment is public and auditable, but it can never move a
   token it was not authorized for.
9. **Odd-chip / split-pot awards** are explicit calldata: the engine decides the odd chip and the
   contract only checks `sum(awards) == pot - rake` (FR-3.4 stays off-chain).
10. **Bond size and the slashed-funds destination (FR-6.5).** The SRS requires a bond and a slash but
    names neither a size nor a recipient. `requiredBond` is owner-configurable and defaults to 100
    tokens in `scripts/deploy.ts` (`REQUIRED_OPERATOR_BOND`), sized to exceed what a single hand can
    earn in rake so cheating is unprofitable. Slashed funds accumulate in a public `slashedBondPool`
    and the owner routes them with `sweepSlashed` (expected: the fee `Vault`); they can never accrue
    to the slashed operator. `void` reports the amount slashed, so the sanction is observable even
    when the bond is empty.
11. **Audit liveness window (FR-6.7).** FR-6.7 fixes a window for publishing the seed but not how long
    an operator may sit on a committed deck root. `auditGraceBlocks` (owner-configurable, bounded
    `[64, 100000]`, default 7200 ≈ 24h at 12s blocks) closes that gap: after it passes with no audit,
    the hand is permissionless-voidable and the bond is slashed. A retune only affects hands committed
    afterwards, so an in-flight audit deadline cannot be cut short.
12. **Liveness needs no owner.** Because `Shuffle.void` covers both the "no deck root" and "no audit"
    failures, the earlier owner-gated `Poker.voidInvalidAnchor` path was removed entirely:
    `Poker.voidHand` is permissionless for every voided shuffle, including a reorg-orphaned anchor,
    which is what NFR-6 asks for. The owner keeps only pause, table creation, operator rotation and
    parameter bounds — never a way to move escrow.
13. **Staking reward scheme.** Cumulative reward-per-share accumulator (`rewardPerShareStored`, scaled
    1e18) with per-account checkpoints, no time-based rate. Every entry point syncs the caller first,
    so no stake can earn retroactively; queued (cooldown) principal is moved out of the accumulator
    and earns nothing, which closes the flash-stake/exit arbitrage. Rounding dust is booked to the
    public `undistributedRewards` bucket and folded into the next distribution instead of vanishing,
    and a `minStake` floor keeps the pool from running dust-sized.
14. **EVM target.** The compiler emits `paris`-target bytecode (Hardhat's default for 0.8.24), so the
    contracts do not depend on `PUSH0`/`MCOPY` being available; this also let OpenZeppelin be pinned to
    `5.1.0`, whose minimum pragma is `^0.8.20` and which does not use `mcopy`.
15. **Burn mechanism: `Token.burn(uint256)`, not a transfer to the zero address.** The SRS asks for
    a burn and names no mechanism. `BuybackBurner` calls an explicit `burn` on the token: it
    decrements the caller's own balance *and* `totalSupply()`, emits
    `Transfer(burner, address(0), amount)`, and reverts if the caller does not hold the amount — so
    the burn is real, observable to ordinary ERC-20 indexers, and impossible to fake. A
    zero-address transfer was rejected because OpenZeppelin 5's `_transfer` reverts on the zero
    recipient, so the "fallback" would have burned nothing at all while looking like a burn. The
    call is typed (`IERC20Burnable`), not a raw `call`, so a non-burnable token fails loudly instead
    of silently leaving the buyback unburned.
16. **Buyback route shape: owner-pinned `address[]`, Uniswap-v2 `swapExactTokensForTokens`.** A v2
    router takes `path` as caller calldata, so a permissionless keeper could otherwise route the
    buyback through arbitrary (hostile) tokens and surrender it. The owner pins the route per fee
    token with `setRouterAndRoute(router, token, path)` / `setRoute(token, path)`; `execute` requires
    the caller's `path` to be byte-identical to the pinned one, and the pinned path must start at the
    fee token and end at LLMPOKER. The keeper still chooses its own slippage bound (`minOut` or
    `maxSlippageBps`, default 1 %) and deadline, so no privileged keeper is needed for liveness while
    the route stays trustworthy. `minOut == 0` means "derive the bound from `maxSlippageBps`" — it is
    never a licence to accept any output. Nothing hard-codes a router or a token address: both are
    configuration, and the LLMPOKER address itself is a constructor argument.
17. **Per-table settlement currency (`createTable`'s third argument).** A table's currency is fixed
    at creation and non-zero-checked; there is no global settlement token, and `Poker`'s constructor
    no longer takes one. Every money path reads the table's `settlementToken`. `totalEscrowObserved`
    is **per token** (`totalEscrowObserved(IERC20)`) rather than a single cross-token number, because
    a 6-decimal USDG unit and an 18-decimal LLMPOKER unit are not commensurable and an aggregate
    would be a misleading claim; the total is maintained as a running per-token counter updated at
    every `escrowOf` mutation, so the view is O(1), never iterates user data, and
    `balanceOf(token, Poker) == totalEscrowObserved(token)` holds at every instant. A token no table
    settles in reverts with `UnsupportedToken` instead of reporting a misleading zero.

### Environment / build notes

* **`contracts/package.json` has no `"type": "module"`.** Hardhat 2 loads its config with `require()`,
  and `ts-node` derives ESM/CJS from that field: with `"type": "module"` Hardhat aborts with
  `Error HH19: Your project is an ESM project ... but your Hardhat config file uses the .js
  extension`. `contracts/tsconfig.json` therefore compiles with `module: commonjs`, which is also what
  makes the TypeScript tests loadable. Nothing else in the workspace depends on the field.
* **`@nomicfoundation/hardhat-toolbox` is not imported.** In this environment its transitive
  `solidity-coverage` plugin throws `TypeError: subtask is not a function` at load time (from inside
  `hardhat/config`'s live re-exports, before the Hardhat context exists), which aborts config loading
  and leaves `hre.ethers` undefined. The toolbox only bundles plugins, so `hardhat.config.ts` imports
  the ones this suite uses — `@nomicfoundation/hardhat-ethers` and
  `@nomicfoundation/hardhat-chai-matchers`. `@nomicfoundation/hardhat-toolbox` remains a
  `devDependency` and is used for nothing else.
* **OpenZeppelin is pinned to `5.1.0`** (exact). 5.2+ pulls in `utils/Bytes.sol`, which uses the
  `mcopy` opcode and therefore requires a `cancun` (or later) EVM target; pinning keeps the compiler
  on `0.8.24` + `paris` as specified, with no behavioural difference for
  ERC20/Ownable/AccessControl/ReentrancyGuard/Pausable/SafeERC20.
* **`viaIR: true`** is enabled: `Poker.settleHand` verifies seat-aligned contributions, awards and
  rake in one frame, and the IR pipeline is what keeps a 6-seat settlement inside the EVM stack limit
  (NFR-3).
* **`robinhood` network is conditional.** It is only registered when `RH_RPC_URL` is set
  (`DEPLOYER_PRIVATE_KEY` optional), so a machine with no deployment secrets can still run the whole
  suite: `hardhat test` never touches the network beyond the in-process one.

### Measured gas (Hardhat in-process network, `test/Poker.gas.test.ts`)

| Operation | Gas |
|---|---|
| `settleHand`, 6 seats (LLMPOKER table, 18 decimals) | **251 279** (0.42 % of a 60M block) |
| `settleHand`, 6 seats (USDG table, 6 decimals) | **285 025** (0.48 % of a 60M block) |
| `settleHand` marginal cost per extra seat | ~2 996 |
| `settleHand`, 2 / 4 seats | 239 283 / 245 281 |
| `deposit` | 116 602 |
| `openHand` (6 seats) | 156 359 |
| `Poker.commitHand` (pot contribution) | 93 084 |
| `Shuffle.commitSeed` (phase 1) | 119 837 |
| `Shuffle.commitDeck` (52-leaf Merkle root, phase 2) | 164 401 |
| `Shuffle.revealCard` (1 card + 10-node proof, phase 3) | 82 885 |
| `cashOut` | 65 137 |

`settleHand` is O(seats) storage work (FR-5.2, NFR-3) — the marginal cost per extra seat is
unchanged at ~3 000 gas, so the per-table currency and the per-token escrow total add a fixed
constant (~30 k, mostly the cold `settlementToken` slot and the running-total write) rather than
anything superlinear. Both currencies stay under 0.5 % of a block, and the suite asserts the two
settlements land within 60 k of each other so a decimal-dependent regression would fail loudly.
The FR-6 phases are each a normal-sized transaction: phase 2 hashes a 64-leaf tree once, and each
card reveal verifies a single 10-node path — so hidden cards cost the operator roughly 0.9M gas for
a full 6-max hand's ~20 published cards, paid per street rather than per card if desired.

### Security notes

* No `tx.origin`, no `selfdestruct`, no unbounded loops over user-controlled arrays; every loop is
  bounded by `MAX_SEATS` (6), `DECK_SIZE` (52) or `TREE_SIZE` (64).
* `ReentrancyGuard` on every function that moves tokens (`Poker.deposit`/`cashOut`/`settleHand`/
  `voidHand`, `Vault.notifyFees`/`withdraw*`, `Staking.stake`/`requestUnstake`/`cancelUnstake`/`claim`,
  `RakeSplitter.receiveRake`/`sweep*`, `BuybackBurner.receiveFees`/`sweepStray`/`execute`,
  `Shuffle.postBond`/`audit`/`void`/`sweepSlashed`). `BuybackBurner.execute` also debits the pending
  balance *before* the swap call (effects before interactions), so a repeated or re-entrant execute
  cannot burn the same fees twice.
* `SafeERC20` for every token interaction, and the burner resets the router allowance to zero after
  each swap so no residual approval survives; `Pausable` gates wager inflow and settlement but never
  `cashOut` (FR-10.5).
* **The buyback cannot be redirected by a keeper.** `execute` is permissionless but the route is
  owner-pinned and must match byte-for-byte, the output must clear the slippage floor, and the funds
  can only leave `BuybackBurner` as a burn or as the router leg of a swap whose output is burned. The
  contract refuses to swap at all (and says so in an event) while no router is configured.
* **Currencies cannot mix.** Escrow is keyed per `(table, seat)`, the settlement token is fixed per
  table, and the splitter and burner account per `(token, beneficiary)`; a deposit at a USDG table
  pulls USDG only. The suite exercises both currencies with the same player and seat.
* **Live-hand confidentiality**: no getter, event or storage field exposes the seed, the entropy or
  the hidden ordering before the audit; `revealedCardAt` returns a `CARD_HIDDEN` sentinel for every
  unpublished position. The suite asserts this by enumerating the ABI and every view (FR-6.8).
* The owner can never rewrite a recorded commitment, salt, anchor or deck root, cannot redirect
  escrow, cannot force a settlement and cannot void a hand the operator settled honestly. Pausing is
  the only owner power over live hands, and it cannot trap already-settled funds.
* The bond is slashed from the hand's recorded operator (`operatorOf`), never from whoever calls
  `void` — a griefer cannot burn someone else's bond by triggering a void, and an operator cannot
  avoid its own sanction by having a third party trigger it.
* `pragma solidity 0.8.24;` exactly, optimizer on (200 runs), no floating pragmas.

### Known limitations / follow-ups

* **`docs/RNG.md` is behind the implementation.** It still documents the pre-patch flat `deckSeed`
  reveal while being marked normative, so it now contradicts FR-6 as patched (`SRS.md` is the newer
  document, and `packages/shared/src/merkle.ts` is the newer encoding reference). The shuffle
  algorithm it pins is unchanged and still reproduced byte for byte; what needs rewriting is §1's
  lifecycle table and §5's verification procedure (Merkle leaves, per-card proofs, the audit, and
  the operator bond). Worth doing in one change with the doc's status banner.
* **The off-chain verification *service* still needs to catch up.** The shared library now ships the
  production Merkle implementation and its committed vectors, but the hand-history/proof panel and
  the `llmpoker-verify` CLI still need to present leaf proofs and the audit result as first-class
  outputs. Until they do, the contract remains the stricter side: it cannot leak a card early and it
  will not settle without a committed deck root, regardless of what the verifier displays.
* **FR-6.6 (ZK immediate binding) is not implemented** — the SRS lists it as v2, and this deployment
  uses the FR-6.5 bond instead. The trust window between phase 2 and the audit is therefore priced,
  not eliminated.
* **Staking interest is not modeled** — yield is exactly what `RakeSplitter` forwards; there is no
  emission schedule, so FR-9.4's "claimable per epoch" is satisfied by claim-on-demand rather than a
  discrete epoch counter.
* **The buyback swap is inert on the shipped deployment.** No LLMPOKER address and no DEX router
  address existed at authoring time, so the burner holds the buyback half and emits
  `BuybackPending` until an owner calls `setRouterAndRoute`. Fees are not lost — they accrue in
  `pendingOf(token)` and any keeper can `execute` the whole balance once the route exists. A USDG
  table's *staking* half is likewise paid in USDG (see the tokenomics section); a deployment that
  wants the pool in LLMPOKER only should set `USDG_RAKE_BPS=0`.
* **The staking pool is single-token by construction** (`Staking.token` is immutable). It therefore
  receives whatever currency the splitter sweeps, which is the same currency the raking table used.
  Multi-asset staking accounting is deliberately not implemented; the tokenomics section documents
  the operational workaround.
* **`Poker.totalEscrowObserved` changed shape** (no-argument → per-token). Out-of-scope callers that
  still use the aggregate form must be updated: `scripts/e2e-onchain-wager.ts` and
  `packages/server/src/chain.ts` (which also calls the two-argument `createTable`) are outside
  `contracts/` and were not part of this change.
* **`Staking` supports one pending unstake request at a time.** That is sufficient for the FR-9.5
  cooldown and keeps the accounting single-pass; a multi-request queue would be a UX upgrade, not a
  correctness one.
* **`Vault.notifyFees` is a per-call pull hook.** If pons ships an automatic fee-forwarder, point it
  at `notifyFees` (with an approval) or add a thin adapter; nothing about the split changes.
* **No on-chain hand evaluation** (see decision 8). The verifier path (`packages/verifier`,
  `packages/shared/src/dealing.ts`) is what ties a published deck to the dealt cards and the recorded
  hand.

---

## Plain-English glossary

| Term | What it means here |
|---|---|
| **Anchor block** | The block mined immediately after the operator commits its secret seed. Its hash is unpredictable at commit time, which is what stops the operator from choosing a favourable deck. |
| **Bond** | Money the operator locks up. It gets taken away if a rigged deck or a stalled hand is proven. |
| **Buyback** | The half of the rake that buys LLMPOKER on the DEX and burns it. It is the token side of the house edge; the other half goes to stakers. |
| **Burn** | Destroying tokens by reducing `totalSupply()`. `Token.burn` does it for real, and the buyback is what calls it. |
| **Commitment / fingerprint** | A hash: a one-way fingerprint of some data. You can check later that the data matches it, but you cannot read the data from it. |
| **Escrow** | Money held by the contract on a player's behalf. It leaves only when the rules say so. |
| **Free table** | Play-money table. Completely off-chain. No gas, no token, no rake. |
| **House edge** | The house's built-in advantage. Here it is only the rake — the platform never bets against players. |
| **Merkle root** | One fingerprint covering a whole list (here, 52 sealed cards). It lets you prove a single item belongs to the list without revealing the rest. |
| **Merkle proof** | The receipt that proves one card really was at one position in the sealed deck. |
| **Operator** | Whoever runs the off-chain game engine and publishes the shuffle commitments. Must post a bond, and may not play at its own tables. |
| **Phase 1 / 2 / 3 / 4** | Commit the seed → commit the sealed deck → open cards as needed → audit everything after the hand. |
| **Rake** | The house's cut of each pot. 2.5%, capped, and only when a flop is dealt. Half of it burns LLMPOKER, half pays stakers. |
| **Router** | The DEX contract that performs the buyback swap. Until one is configured, the buyback half is held and the contract says so (`BuybackPending`) instead of swapping. |
| **Salt** | A random number mixed into each sealed card so the fingerprint cannot be guessed or brute-forced. |
| **Settlement token** | The one ERC-20 a given table escrows, settles and rakes in — USDG or LLMPOKER. Fixed when the table is created, so two tables never share a pot. |
| **Slash** | Take the bond away as a penalty for a proven cheat or a stall. |
| **Staker** | Someone who locks the token to earn a share of the rake. The "crowd" that owns the house edge. |
| **USDG** | The 6-decimal stablecoin a stable-currency wager table settles in. Its address is supplied at deploy time; nothing hard-codes it. |
| **Void** | Cancel a hand and give every seat its chips back. Happens when the operator fails to show a deck or an audit, or when the anchor block is lost to a reorg. |
| **Wager table** | Real-money table. Buy-in goes into on-chain escrow, cards are dealt by the verifiable shuffle, and players may only withdraw what they own. Each table picks its own settlement currency. |
