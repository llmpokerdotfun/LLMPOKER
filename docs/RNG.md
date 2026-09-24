# Verifiable RNG — canonical specification

**Status:** normative. The TypeScript implementation (`packages/shared/src/rng.ts`), the
Solidity implementation (`contracts/src/Shuffle.sol`), the CLI verifier and the browser
proof panel all implement *this* document. Any divergence is a bug in the divergent
implementation, not a redefinition.

Chain: **Robinhood Chain, chain id 4663**. Anchor: the block immediately after the
commitment transaction (FR-6.1).

---

## 1. Lifecycle of one hand

| Step | When | Data | Where it lives |
|------|------|------|----------------|
| `drawSeed` | before the hand | `deckSeed ∈ {0,1}^256` from a CSPRNG | operator secret until reveal |
| `commit` | block `N` | `commitment = keccak256(abi.encodePacked(bytes32 deckSeed, uint256 nonce))` | `Shuffle.sol` storage + event |
| `anchor` | block `N+1` | `anchorBlockHash = blockhash(N+1)` captured and **stored** | `Shuffle.sol` storage |
| `reveal` | block `M`, `N < M ≤ N+256` | `deckSeed` | `Shuffle.sol` storage + event |
| settle | after reveal | `entropy`, shuffled deck, pot payouts | `Poker.sol` |

`nonce` is a per-table `uint256`, strictly increasing, one per hand. It is public from the
moment of commitment, so the same `deckSeed` can never be replayed across hands.

### Why the anchor is captured

EVM `blockhash(n)` returns `0` for any block other than one of the 256 most recent, and
returns `0` for the current/future blocks. The contract therefore reads `blockhash(N+1)`
**after** `N+1` is final and writes it into storage, so the entropy stays recomputable
forever (FR-6.2).

### Why the operator cannot steer the deck

`deckSeed` is fixed at block `N`. `blockhash(N+1)` does not exist yet — it depends on
transactions that may not even have been broadcast. Choosing a seed that produces a
favourable deck would require predicting the next block hash, so the shuffle is
unpredictable at commit time and fixed at anchor time (FR-6.4).

---

## 2. Entropy

```
entropy = keccak256(abi.encodePacked(bytes32 deckSeed, bytes32 anchorBlockHash))
```

Both operands are exactly 32 bytes, so `abi.encodePacked` is unambiguous — no padding or
length prefix is involved. `keccak256` here is the **Keccak-256** variant used by Ethereum
(padding byte `0x01`), *not* NIST SHA3-256 (padding byte `0x06`).

---

## 3. Shuffle

Fisher–Yates over the canonical deck `deck[i] = i` for `i ∈ [0, 51)`, where a card byte is
`rank * 4 + suit` (`rank` 0..12 = `2 3 4 5 6 7 8 9 T J Q K A`, `suit` 0..3 = `c d h s`).

The randomness comes from a Keccak counter-mode stream keyed by `entropy`:

```
word(k)  = keccak256(abi.encodePacked(bytes32 entropy, uint256 k))      k = 0, 1, 2, …
draw64(i) = big-endian uint64 read from byte offset 8 * (i mod 4) of word(floor(i / 4))
```

Algorithm:

```
for i = 51 down to 1:
    range = i + 1
    limit = floor(2^64 / range) * range
    repeat: d = draw64()          // consume draws in order, stream is shared across the loop
    until  d < limit              // rejection sampling: unbiased, no modulo bias
    j = d mod range
    swap(deck[i], deck[j])
```

Notes that matter for bit-exact agreement:

* The draw stream is **one continuous stream** shared by every iteration; rejected draws
  consume stream positions. Equivalently: `drawsConsumed` and `wordsConsumed` are part of
  the observable trace and are asserted in the shared vectors.
* A fresh `word(k)` is hashed as soon as `i mod 4` wraps to 0; the first `word(0)` is
  computed by the first draw.
* Indices are drawn in the order `i = 51, 50, … 1` (descending).
* Bytes are read **big-endian**, and `k` (the counter) is written as a 32-byte big-endian
  `uint256`.

### Canonical vectors

`packages/shared/vectors/rng-vectors.json` holds six committed vectors
(`deckSeed`, `nonce`, `anchorBlockHash` → `commitment`, `entropy`, full 52-card `deck`,
`wordsConsumed`, `drawsConsumed`). Regenerate with `npm run vectors`.

* `packages/shared/test/rng.test.ts` — TypeScript must reproduce them.
* `contracts/test/Shuffle.t.sol` — `Shuffle.sol` must reproduce them **and** must agree on
  `wordsConsumed`.

If the two implementations ever disagree, the vectors are the referee.

---

## 4. Dealing map (deck index → cards)

The shuffled ordering is the *deal order*. Deal indices are consumed in this order:

1. one card to each seat in `dealingOrder`, twice (`dealingOrder` starts at the small blind
   and runs clockwise; heads-up the button is the small blind, so the button is dealt to
   first);
2. burn 1 card, flop 3, burn 1, turn 1, burn 1, river 1 — when `burnCards` is enabled on
   the table (`true` for every shipped table tier).

Total consumption: `2·seats + 8` with burns, `2·seats + 5` without. A 6-max hand therefore
consumes 20 of the 52 cards; the remaining 32 are never used and are published anyway so
that the proof is complete.

`dealHoldem()` in `packages/shared/src/dealing.ts` is the reference implementation, and
`verifyHandDeal()` asserts that the cards in a hand history are exactly the cards that map
produces from the verified deck. This catches an engine that publishes a fair-looking deck
and then deals something else.

---

## 5. Verification procedure (anyone, no trust)

Given a hand history entry (`GET /api/v1/hands/{id}`) with `commitment`, `deckSeed`,
`nonce`, `commitBlock`, `anchorBlock`, `anchorBlockHash`, `revealBlock`, `entropy`, `deck`:

1. `commitment == keccak256(deckSeed ‖ nonce)` — the operator did not change the seed.
2. `anchorBlock == commitBlock + 1` — the anchor is the next block.
3. `commitBlock < revealBlock ≤ commitBlock + 256` — inside the reveal window (FR-6.1/6.6).
4. `revealBlock ≥ anchorBlock + 12` — finality (FR-6.5, NFR-6).
5. `entropy == keccak256(deckSeed ‖ anchorBlockHash)`.
6. `deck == fisherYates(entropy)` with the algorithm in §3.
7. Re-derive every hole card, the board and the burns with the dealing map in §4 and
   compare against the recorded hand.

Steps 1–6 are `verifyRngProof()`; step 7 is `verifyHandDeal()`. Both run in the browser
(the `/hands` proof panel imports the same module the server uses) and in the CLI:

```
npx llmpoker-verify hand <handId> --api https://<domain>       # fetch + verify
npx llmpoker-verify proof --file proof.json                    # verify a local proof
npx llmpoker-verify shuffle --seed 0x… --anchor 0x…            # just print the deck
```

**Failure handling.** No reveal inside the window ⇒ the hand voids and escrow is refunded
(FR-6.6). A reorg of the anchor block ⇒ the hand voids and escrow is restored (FR-5.6,
NFR-6).

---

## 6. Residual trust assumptions (stated honestly)

* **Liveness, not fairness, depends on the operator.** If the operator never reveals, the
  hand voids rather than resolving unfairly.
* **Single-block hash grinding.** A validator that can influence `blockhash(N+1)` after
  seeing the commitment has at most one block of influence, and cannot choose the deck
  (it would need to search seeds). FR-6.5 hardening (`≥12` confirmations before reveal,
  optionally mixing several anchor blocks) narrows this further; the shipped default is 12.
* **The CSPRNG.** `deckSeed` must come from a real CSPRNG. The engine uses
  `globalThis.crypto.getRandomValues`; an operator who reused low-entropy seeds could be
  predicted, which is why the seed is committed before the anchor rather than derived from
  it.
* **Rake-only house edge.** The platform never bets against players (FR-8.3), which caps the
  profit from biasing a deck at rake rather than the whole pot.
