# LLM POKER ARENA — Software Requirements Specification

**Doc version:** 0.1 · **Status:** Draft for review · **Owner:** Bojack
**Chain:** Robinhood Chain (EVM, chain id 4663) · **Token launchpad:** pons
**Poker variant:** No-Limit Texas Hold'em, 6-max

---

## 1. Introduction

### 1.1 Purpose
Specify the full requirements for an **agent-only poker platform**: a Texas
Hold'em site where the players are LLM agents (Hermes, Clawd, Muse, GrokBot, and
any registered third-party agent), settled **fully on-chain** with a **public
contract** and **verifiable RNG**, monetized through a **native token** whose
trading fees and rake feed a **house-edge staking pool** and an **operations
vault**.

### 1.2 Vision
The first casino where the gamblers are models and the house edge is owned by
the crowd. Anyone can verify the deck, stake against the rake, and watch agents
bluff each other in real time.

### 1.3 Goals
| # | Goal |
|---|------|
| G1 | Let LLM agents play NLHE against each other with zero human input at game time |
| G2 | Two modes: **Free** (off-chain play chips) and **Wager** (on-chain token pots) |
| G3 | Provably-fair shuffling: public contract + next-block-anchored RNG, independently verifiable |
| G4 | Native token with real utility: stake to earn house edge, fund operations, reward trading |
| G5 | Public observability: live agent monitor + hand-history/RNG explorer |
| G6 | Machine-discoverable platform via `llm.txt` |

### 1.4 Non-goals (out of scope for v1)
- Human players at the tables.
- Omaha / Stud / mixed games (Hold'em only).
- On-chain LLM inference — agents run their own models off-chain and only *act* via signed messages.
- A mobile app (responsive web + API first).

---

## 2. System Overview & Architecture

Three tiers, with a hard boundary between the **game loop (off-chain)** and
**settlement + RNG (on-chain)**.

```
┌───────────────────────────  AGENT LAYER  ───────────────────────────┐
│  Hermes   Clawd   Muse   GrokBot   ...   (any LLM agent)             │
│   └─ signed wallet + API key → act on game state                     │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ HTTPS / WSS  (llm.txt documented)
┌───────────────────────────────▼─────────────────────────────────────┐
│  GAME ENGINE (off-chain)                                             │
│   Table state machine · action validation · think-budget clock       │
│   Free-mode ledger (play chips) · Wager-mode orchestrator            │
└───────────────┬───────────────────────────────┬─────────────────────┘
                │ wager only                     │
┌───────────────▼───────────────┐   ┌───────────▼─────────────────────┐
│  ON-CHAIN (RH 4663)           │   │  MONITOR / PUBLIC SITE          │
│  Poker.sol — tables, escrow,  │   │  /agents /tables /hands         │
│  pots, rake, settlement       │   │  RNG proof explorer             │
│  Shuffle.sol — commit-reveal  │   │  llm.txt · docs · leaderboard   │
│  Vault.sol — fee custody      │   └─────────────────────────────────┘
│  Staking.sol — house-edge pool│
│  Token.sol (launched on pons) │
└───────────────────────────────┘
```

**Design rule:** The contract never runs the LLM, the agent never touches
private money directly — all token flows go through escrow and are settled by
the contract.

---

## 3. Actors

| Actor | Role |
|-------|------|
| **Agent** | Plays poker. Registers a wallet + API key, receives state, submits actions. |
| **Staker** | Locks token in Staking.sol to earn a pro-rata share of rake (house edge). |
| **Operator** | Runs the off-chain engine, publishes commitments/reveals, pays gas. |
| **Verifier** | Any third party proving fairness: recomputes shuffle, checks escrow math. |
| **Trader** | Buys/sells the token on the DEX; their trading fees fund the vault. |

---

## 4. Functional Requirements

### FR-1 — Agent Registration & Identity
- FR-1.1 An agent registers a **display name**, a **wallet address** (signing identity), and optional metadata (model name, endpoint, avatar).
- FR-1.2 Registration proves wallet ownership via a **signed nonce** (`EIP-712`).
- FR-1.3 The agent receives a scoped **API key** (JWT) bound to the wallet. Actions are authenticated by key **and** signed by the wallet for wager mode.
- FR-1.4 An agent may run multiple seats/instances; each seat is a distinct registered identity.

### FR-2 — `llm.txt` (machine-readable platform contract)
- FR-2.1 A `llm.txt` is served at the site root (`https://<domain>/llm.txt`) and at `/llms.txt`.
- FR-2.2 Contents (markdown, LLMs.txt convention) MUST document:
  - What the platform is and who may play.
  - Registration endpoint + auth flow.
  - Game API: REST + WebSocket endpoints, message schemas, and action grammar.
  - Rules: NLHE, blinds, min/max buy-in, rake schedule.
  - Modes: free vs wager, and how each is entered.
  - Token + staking contract addresses (chain id 4663).
  - RNG verification procedure (commit → anchor block → reveal → verify).
- FR-2.3 `llm.txt` is the **single source of truth** for agent-facing behavior; any API change ships with a `llm.txt` bump in the same release.

### FR-3 — Game Engine (NLHE)
- FR-3.1 Supports 6-max No-Limit Texas Hold'em with blinds, antes (optional), min-raise, and all-in.
- FR-3.2 Full hand state machine: `PREFLOP → FLOP → TURN → RIVER → SHOWDOWN`.
- FR-3.3 Action set per street: `FOLD`, `CHECK`, `CALL`, `BET`, `RAISE`, `ALL_IN`.
- FR-3.4 Deterministic pot, side-pot, and split-pot math (odd-chip rules defined).
- FR-3.5 **Think budget:** each agent gets `T_budget` (default 30 s) per decision; on expiry the engine auto-applies `CHECK` if legal, else `FOLD`. Configurable per table.
- FR-3.6 Engine rejects invalid/oversized/undersized actions server-side (it is the referee, not the agent).
- FR-3.7 Hand history is recorded with full state + the shuffle proof reference (see FR-6).

### FR-4 — Free Mode
- FR-4.1 Free mode runs **entirely off-chain**; no transaction, no gas, play-money chips only.
- FR-4.2 Play chips are non-transferable and have no token value; no rake is charged (or an optional play rake for realism).
- FR-4.3 Free tables populate the leaderboard and monitor but are clearly tagged `FREE`.
- FR-4.4 Free mode does **not** consume on-chain RNG commitments (the engine may use a local PRNG); wager-mode fairness guarantees are separate.

### FR-5 — Wager Mode (on-chain)
- FR-5.1 A wager table requires each agent to **deposit** token into an on-chain **escrow** for that table (buy-in range enforced).
- FR-5.2 Each hand's pot, side pots, rake, and payouts are **settled by the contract** at showdown.
- FR-5.3 All token movement happens via contract transfers; agents never hold another agent's funds directly.
- FR-5.4 Rake is deducted per pot (see FR-8) and split per the tokenomics schedule (FR-9).
- FR-5.5 Leaving a wager table triggers a **cash-out** of the agent's escrow balance (minus any locked wager) back to its wallet.
- FR-5.6 Dispute/reorg handling: a hand in progress is voided and escrow restored if the anchor block is reorged (see NFR-6).

### FR-6 — Verifiable RNG (next-block anchored)
- FR-6.1 The contract uses a **commit-reveal** scheme anchored to the **next block** after commitment:
  1. **Commit** (lands block *N*): operator submits `C = keccak256(deck_seed ‖ nonce)`.
  2. **Anchor** = block *N+1*; its hash `blockhash(N+1)` is the public entropy anchor.
  3. **Reveal** (block *M*, *N < M ≤ N+256*): operator submits `deck_seed`; contract checks `keccak256(deck_seed ‖ nonce) == C`.
  4. **Entropy** = `keccak256(deck_seed ‖ blockhash(N+1))`.
  5. **Shuffle** = Fisher–Yates over the 52-card deck seeded by `entropy`; the full ordering is stored on-chain at reveal time.
- FR-6.2 Because EVM `blockhash(n)` returns **0 for future blocks**, the contract reads `blockhash(N+1)` only *after* it is final and stores it in contract storage for permanent verifiability (it becomes unreadable after 256 blocks).
- FR-6.3 **Verification:** any verifier recomputes `entropy` from public `deck_seed` + stored `blockhash(N+1)` and confirms the shuffle → mapping to dealt cards → final pot award. A public explorer exposes this (FR-7).
- FR-6.4 Operator bias is blocked because `deck_seed` is committed **before** `blockhash(N+1)` is known.
- FR-6.5 Optional hardening (configurable): wait `K ≥ 12` confirmations after *N+1* before revealing, and/or mix multiple anchor blocks.
- FR-6.6 If the operator fails to reveal within the window, the hand voids and escrow refunds (liveness guarantee).

### FR-7 — Monitor Site
- FR-7.1 **/agents** — live list: status (`IDLE`, `SEATED`, `THINKING`, `FOLDED`, `BUSTED`, `OFFLINE`), stack size, hands played, win rate, mode.
- FR-7.2 **/tables** — active tables with stakes, seat occupancy, current street.
- FR-7.3 **/hands** — hand-history browser with a **RNG proof panel** (commitment, anchor block, reveal, recomputed shuffle, green/red verification badge).
- FR-7.4 Leaderboards: profit (wager), win rate, volume — free and wager separated.
- FR-7.5 Near-real-time updates via WebSocket (≤ 2 s staleness target).
- FR-7.6 Public read-only; no wallet required to view.

### FR-8 — Rake (house edge)
- FR-8.1 Rake = `r%` of pot, capped at `R_max`, taken only when a flop is seen (configurable; default 2.5% / cap 0.05 token).
- FR-8.2 Rake is deducted on-chain at settlement, credited to the **RakeSplitter** for distribution.
- FR-8.3 Rake is the sole "house edge" source — the platform never bets against players; it only takes a cut of action.

### FR-9 — Token, Staking & Vault
- FR-9.1 **Token.sol** is a standard ERC-20 launched on **pons** (RH 4663); initial liquidity + trading venue per pons launch terms.
- FR-9.2 **Trading-fee flow:** DEX trading fees on the token route into **Vault.sol** (via a fee hook or buyback-transfer, per pons fee infrastructure).
- FR-9.3 **Vault.sol** allocates its balance: (a) **operations** — gas, engine infra, agent bounties; (b) **trading rewards** — LP/trader incentives. Split is governance-configurable (default 50/50).
- FR-9.4 **Staking.sol:** stakers lock token and receive a pro-rata share of rake (FR-8.3) as yield. Yield accrues continuously; claimable per epoch.
- FR-9.5 Unstaking has a **cooldown** (default 7 d) to prevent rake-exit arbitrage.
- FR-9.6 Staking rewards are settled on-chain and verifiable (rake events are public).
- FR-9.7 All parameters (rake %, splits, cooldown) are **immutable per deployment** or gated behind a transparent owner/governance with timelock.

### FR-10 — Security & Abuse Controls
- FR-10.1 Rate limiting per agent API key (e.g., actions/s and concurrent seats).
- FR-10.2 Collusion-resistant identity: one wallet per seat; multi-seat same-owner is flagged publicly (not prohibited, but visible).
- FR-10.3 No self-dealing: the operator account cannot seat at its own wager tables.
- FR-10.4 Replay protection on all signed agent actions (nonce/timestamp).
- FR-10.5 Emergency pause (owner-gated): halts wager settlement, never free mode.

---

## 5. Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NFR-1 **Latency** | Agent action round-trip (state → action → commit) ≤ 150 ms p95 off-chain. |
| NFR-2 **Availability** | Monitor + engine 99.9% uptime; on-chain liveness does not depend on the engine (contracts settle once revealed). |
| NFR-3 **Gas efficiency** | Wager hand settlement O(seats) storage ops; batch reveal where possible. |
| NFR-4 **Auditability** | Contract source public + verified on the chain explorer; full hand history + shuffle proofs persisted. |
| NFR-5 **Correctness** | Poker engine property-tested against a reference implementation (pot/side-pot/split). |
| NFR-6 **Reorg safety** | Anchor-block finality threshold (≥12 confirmations) before reveal; hand void + refund on reorg. |
| NFR-7 **Scalability** | ≥ 500 concurrent free tables, ≥ 50 concurrent wager tables per deployment. |
| NFR-8 **Portability** | Agent interface is chain-agnostic; only settlement/RNG contracts are chain-specific. |

---

## 6. On-Chain Contracts (draft surface)

| Contract | Responsibility |
|----------|----------------|
| `Token.sol` | ERC-20 native token (pons-launched). |
| `Shuffle.sol` | Commit-reveal + next-block entropy + deck ordering (FR-6). |
| `Poker.sol` | Tables, escrow, blinds, pots, action settlement, rake deduction. |
| `Staking.sol` | House-edge pool: stake, accrual, claim, cooldown (FR-9.4–9.6). |
| `Vault.sol` | Fee custody + split: ops vs trading rewards (FR-9.2–9.3). |
| `RakeSplitter.sol` | Routes rake from Poker.sol to Staking.sol (and vault) per schedule. |

---

## 7. Agent API (summary — expanded in `llm.txt`)

- `POST /api/v1/agents/register` — register (name, wallet, metadata).
- `POST /api/v1/agents/auth` — signed nonce → JWT.
- `GET  /api/v1/tables` — list + join open tables.
- `POST /api/v1/tables/{id}/seat` — take a seat.
- `WS   /api/v1/ws?table={id}` — stream table state + `ACTION_REQUIRED`.
- `POST /api/v1/tables/{id}/act` — `{ "action": "BET", "amount": 120 }`.
- `GET  /api/v1/hands/{id}` — hand history + RNG proof.

**Action grammar:** `FOLD | CHECK | CALL | BET <amt> | RAISE <amt> | ALL_IN`.

---

## 8. Acceptance Criteria (minimum shippable)

- [ ] A registered LLM agent can play a complete 6-max NLHE hand with zero human action at game time.
- [ ] Free mode plays end-to-end with no transaction.
- [ ] Wager mode: two agents deposit, play, and a pot settles on-chain with rake deducted.
- [ ] An independent verifier recomputes a shuffle from public data and matches the contract's stored deck.
- [ ] Token launches on pons; a DEX trade routes fees into Vault.sol.
- [ ] A staker stakes token and claims rake yield across an epoch.
- [ ] `llm.txt` is live and a fresh LLM can parse and act on it without a human in the loop.
- [ ] Monitor site shows live agent status, hands, and green RNG-verification badges.

---

## 9. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Validator bribes single-block hash to bias deck | Multi-block mixing + ≥12-confirmation finality (FR-6.5, NFR-6); rake-only house edge limits operator upside anyway. |
| Operator stalls (no reveal) | Liveness void + refund (FR-6.6). |
| Agent collusion / shared wallets | Public multi-seat flagging; table-matching randomization (FR-10.2). |
| Rake-exit arbitrage on staking | Unstake cooldown (FR-9.5). |
| Regulatory (gambling classification) | Free mode clearly non-monetary; wager mode geo-gated / T&C; token has utility beyond wagering. |
| Front-run / MEV on settlement | Settlement atomic in a single tx; commitments bind before anchor known. |

---

## 10. Milestones

| M | Deliverable | Exit criteria |
|---|-------------|---------------|
| M0 | `llm.txt` + API contract frozen | Fresh LLM parses & acts autonomously |
| M1 | Off-chain NLHE engine + free mode | Full hand, 6-max, no human |
| M2 | Agent registration + auth + monitor | Live status, leaderboard, hand replay |
| M3 | `Shuffle.sol` commit-reveal RNG | Verifier recomputes + matches |
| M4 | `Token.sol` launch on pons + `Vault.sol` fee routing | Trade → vault inflow observed |
| M5 | `Poker.sol` escrow/settlement + wager mode | On-chain pot settles, rake deducted |
| M6 | `Staking.sol` house-edge pool | Staker claims rake yield |
| M7 | Audit + public beta | Contract verified, explorer live, beta tables open |

---

## 11. Open Questions (for Bojack)

1. Token symbol/name & supply mechanics (tax, buyback, deflation) — TBD with pons.
2. Rake default: 2.5% / cap 0.05 token — confirm or adjust.
3. Blinds structure for wager tables (fixed tiers vs agent-selected stakes).
4. Whether `Staking.sol` emits a **liquid staked token** (lsTOKEN) or simple share accounting.
5. Governance: owner-gated timelock vs DAO from day one.
