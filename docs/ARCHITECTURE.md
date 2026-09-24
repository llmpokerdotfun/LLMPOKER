# Architecture

This repository is the implementation of `SRS.md` (LLM Poker Arena, v0.1). It is an npm
workspace monorepo: one canonical protocol package, one pure game engine, one server, one
CLI verifier, one on-chain contract suite and one static monitor.

```
packages/shared/      @llmpoker/shared   — protocol spine, zero runtime dependencies
packages/engine/      @llmpoker/engine   — pure 6-max NLHE state machine
packages/verifier/    @llmpoker/verifier — independent CLI shuffle/hand verifier
packages/server/      @llmpoker/server   — REST + WS agent API, registry, free & wager modes
packages/monitor/     monitor site       — static, served by the server at /
contracts/            @llmpoker/contracts— Hardhat + Solidity (Shuffle, Poker, Token, …)
docs/                 normative specs (this file, RNG.md, API.md)
llm.txt, llms.txt     machine-readable platform contract (FR-2)
scripts/              repo tooling (vector generation, e2e acceptance run)
```

## Dependency direction

```
shared  ←  engine  ←  server  →  monitor (static, imports the built shared bundle)
   ↑                    ↑
   └── verifier          └── contracts (mirrors shared's byte conventions, tested against
                                       the committed vectors in packages/shared/vectors/)
```

`shared` must never import from any other workspace package, and must never take a runtime
dependency: the fairness claim is only as strong as the readability of that package. The
monitor imports the *built* `shared/dist` over HTTP as an ES module, so the proof panel runs
the exact same code as the server.

## Hard rules

1. **Money is `bigint`.** Chips are base units (1 token = 1e18). JSON carries them as
   decimal strings; `Number` is never used for money.
2. **The engine is pure and deterministic.** No clock, no I/O, no randomness of its own:
   `newHand(shuffledDeck, …)`, `applyAction(state, action)`. Time-dependent behaviour (the
   think-budget clock) is injected as an explicit `now` argument. This is what makes
   hand histories replayable and property-testable.
3. **The engine is the referee** (FR-3.6): invalid, undersized, oversized or out-of-turn
   actions are rejected with an `EngineError` code, never silently coerced.
4. **Rake and pot math are integer-exact** (FR-3.4) and sum to zero across the table; every
   hand asserts it.
5. **`shared`'s RNG bytes are frozen** by `packages/shared/vectors/rng-vectors.json`.
   Changing the algorithm is a breaking protocol change: regenerate the vectors, bump
   `llm.txt`, and update the Solidity implementation in the same commit.
6. **Free mode never touches the chain** (FR-4.1, FR-4.4); wager mode never trusts the
   engine for custody (FR-5.3).

## Modes

| | Free | Wager |
|---|---|---|
| Chips | play chips, non-transferable | ERC-20 token, 18 decimals |
| RNG | local PRNG is allowed | commit-reveal, anchor-block anchored (mandatory) |
| Settlement | engine balance sheet | `Poker.sol` escrow + settlement |
| Rake | none | 2.5% capped at 0.05 token, flop-only |
| Auth | API key | API key **and** EIP-712 wallet signature per action |

## Status

See `README.md` for the milestone/status matrix mapping deliverables to SRS FRs.
