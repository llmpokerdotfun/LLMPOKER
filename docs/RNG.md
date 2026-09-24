# Verifiable RNG with hidden cards — canonical specification

**Status:** normative. `packages/shared/src/{rng,merkle,proof}.ts`, `contracts/src/Shuffle.sol`,
the CLI verifier and the browser proof panel all implement *this* document. Any divergence is a
bug in the divergent implementation, not a redefinition.

Chain: **Robinhood Chain, chain id 4663**.

---

## 0. The invariant this scheme exists to protect

> **The seed and the full deck ordering MUST NEVER be published while a hand is live.
> Only commitments are public during play.**

A naive commit-reveal shuffle (`commit C`, later `reveal deckSeed` and the whole ordering) is
*provably fair and completely unplayable*: publishing the ordering mid-hand lets every player
compute every opponent's hole cards before the showdown. The proof destroys the game.

So the commitment is not to the ordering, it is to **52 sealed envelopes**:

| Phase | Public | Still secret |
|---|---|---|
| 1 — `commitSeed` (block `N`) | `keccak256(seed ‖ nonce)`, nonce, `commitBlock` | the seed |
| 2 — `commitDeck` (block `M`) | Merkle root `R` over the salted deck, `anchorBlockHash` | the ordering, all 52 salts |
| 3 — `revealCard` (as the rules demand) | one `(index, card, salt, proof[6])` per public card | the other 51 positions |
| 4 — `audit` (hand over) | `seed`, `entropy`, the ordering, all salts | nothing |

Unrevealed positions are preimage-hiding: `salt_i` is 32 fresh random bytes, so with an unknown
salt a hidden leaf is uniform over `2^256` and `R` discloses nothing about it (FR-6.8).

---

## 1. Lifecycle of one hand

### Phase 1 — commit the seed (FR-6.1)

```
commitment = keccak256(abi.encodePacked(bytes32 seed, uint256 nonce))
```

`seed ∈ {0,1}^256` from a CSPRNG; `nonce` is a per-table `uint256`, strictly increasing, one per
hand, published with the commitment. The commitment lands in block `N`.

### Anchor (FR-6.2, FR-6.9)

`anchorBlock = N + 1`. Its hash is read **after** the block exists and again after the finality
threshold; if the two reads differ the anchor was reorged and the hand is voided before a card is
dealt (FR-5.6, NFR-6). The hash is cached into contract storage, because EVM `blockhash(n)`
returns `0` beyond 256 blocks and for future blocks.

Because `seed` is fixed in block `N` and `blockhash(N+1)` cannot exist yet, the operator cannot
choose a deck it likes: steering would require predicting the next block hash (FR-6.4).

### Phase 2 — commit the deck, not the seed (FR-6.2)

```
deck    = FisherYates(keccak256(abi.encodePacked(bytes32 seed, bytes32 anchorBlockHash)))
leaf_i  = keccak256(abi.encodePacked(uint8 deck[i], bytes32 salt_i))      i = 0..51
inner   = keccak256(abi.encode(bytes32 left, bytes32 right))             // ORDERED, never sorted
tree    = 52 leaves padded with ZERO_LEAF = keccak256(abi.encode(uint256(0))) to 64
R       = tree root                                                       // 6 levels, proof length 6
```

Only `R` is published. Neither the ordering nor any salt leaves the operator yet.

Two details are load-bearing:

* **Interior nodes are ordered.** A sorted-pair rule (`keccak(min‖max)`) makes the root invariant
  under sibling swaps, so transposing two adjacent deck positions would leave `R` unchanged — it
  would commit to the deck's *set*, not its *sequence*, and the operator could deal any order at
  all. Second-preimage safety comes from the leaf shape instead: a leaf hashes 33 bytes (1 card +
  32 salt), an interior node hashes 64.
* **Salts must be unpredictable and distinct.** `packages/shared/vectors/merkle-vectors.json`
  carries an `orderSensitivity` pair — the same 52 cards in a different sequence must produce
  different roots — and the verifier rejects an audit whose salts repeat.

### Phase 3 — progressive per-card reveal (FR-6.3)

A card may be published only when the rules require it, and only with:

```
reveal = { index, card, salt, proof[6] }
verify: walk the 6 siblings from leafHash(card, salt) up to the committed root R
```

Publication order follows the dealing map (§4): the 3 flop cards, then the turn, then the river.
Burns are never published. Hole cards are not published during play at all — they arrive with the
audit. So at any moment during a hand, the only information a spectator has is the commitment, the
root, and the cards already face-up on the table.

### Phase 4 — end-of-hand audit (FR-6.4, FR-6.5)

Once the hand is over the operator publishes `seed`, all 52 salts and the ordering. The contract
(and any verifier) then recomputes:

1. `entropy = keccak256(seed ‖ anchorBlockHash)`,
2. `deck = FisherYates(entropy)`,
3. `R' = MerkleRoot(leaves(deck, salts))`,
4. compare `R'` with the `R` committed in phase 2, and `keccak256(seed ‖ nonce)` with the phase-1
   commitment.

Any mismatch is a **provable cheat**: the hand is voided and the operator's bond is slashed
(FR-6.5). A failed audit cannot be explained away — the root was fixed before the cards were dealt.

### Liveness and voiding (FR-6.7)

Two failure modes are permissionless-voidable, each slashing the hand's own operator (never the
caller):

* no deck root inside the 256-block window, or
* a deck root with no audit inside the owner-configured `auditGraceBlocks`.

Voiding refunds every seat's escrow (FR-6.6). Liveness depends on the operator; fairness does not.

---

## 2. Entropy

```
entropy = keccak256(abi.encodePacked(bytes32 seed, bytes32 anchorBlockHash))
```

Both operands are exactly 32 bytes, so `abi.encodePacked` is unambiguous. `keccak256` is the
**Keccak-256** variant used by Ethereum (padding byte `0x01`), *not* NIST SHA3-256 (`0x06`).

---

## 3. Shuffle

Fisher–Yates over the canonical deck `deck[i] = i` for `i ∈ [0, 51)`, where a card byte is
`rank * 4 + suit` (`rank` 0..12 = `2 3 4 5 6 7 8 9 T J Q K A`, `suit` 0..3 = `c d h s`).

Randomness comes from a Keccak counter-mode stream keyed by `entropy`:

```
word(k)   = keccak256(abi.encodePacked(bytes32 entropy, uint256 k))      k = 0, 1, 2, …
draw64(i) = big-endian uint64 read from byte offset 8 * (i mod 4) of word(floor(i / 4))
```

```
for i = 51 down to 1:
    range = i + 1
    limit = floor(2^64 / range) * range
    repeat: d = draw64()          // consume draws in order, one shared stream
    until  d < limit              // rejection sampling: unbiased, no modulo bias
    j = d mod range
    swap(deck[i], deck[j])
```

Notes that matter for bit-exact agreement:

* the draw stream is **one continuous stream** shared by every iteration; rejected draws consume
  positions, which is why `drawsConsumed`/`wordsConsumed` are part of the observable trace;
* a fresh `word(k)` is hashed when `i mod 4` wraps; the first `word(0)` is computed by the first draw;
* draws are consumed for `i = 51, 50, … 1` (descending);
* bytes are read **big-endian** and `k` is written as a 32-byte big-endian `uint256`.

### Canonical vectors

| File | Pins | Reproduced by |
|---|---|---|
| `packages/shared/vectors/rng-vectors.json` | the shuffle: `deckSeed, nonce, anchorBlockHash → commitment, entropy, deck, wordsConsumed, drawsConsumed` (6 vectors) | `packages/shared/test/rng.test.ts`, `contracts/test/Shuffle.vectors.test.ts` |
| `packages/shared/vectors/merkle-vectors.json` | the commitment layer: `entropy → deck`, leaves, root, inclusion proofs for 5 positions (5 vectors + an `orderSensitivity` pair) | `packages/shared/test/merkle.test.ts`, `contracts/test/Shuffle.shared-vectors.test.ts` |

Regenerate both with `npm run vectors`. **The vectors are the referee**: when the first Solidity
`Shuffle.sol` used `floor(2^256/range)*range` as the rejection bound instead of the spec's `2^64`,
the vector test caught it and the Solidity was fixed — not the vectors. The same happened when a
sorted-pair interior rule was tried: the `orderSensitivity` pair refused it.

---

## 4. Dealing map (deck index → cards)

The shuffled ordering is the *deal order*. Indices are consumed in this order:

1. one card to each seat in `dealingOrder`, twice (`dealingOrder` starts at the small blind and runs
   clockwise; heads-up the button is the small blind, so the button is dealt to first);
2. burn 1, flop 3, burn 1, turn 1, burn 1, river 1 — when `burnCards` is enabled (true for every
   shipped table tier).

Total consumption: `2·seats + 8` with burns, `2·seats + 5` without.

`dealIndexMap()` in `packages/shared/src/dealing.ts` computes this assignment with **pure index
arithmetic and no deck**, and `dealHoldem()` is implemented in terms of it. That is what lets a
verifier check a live hand's per-card reveals without knowing any hidden card, and it guarantees
the reveal positions can never drift from the positions actually dealt.

---

## 5. Verification procedure

### While a hand is live (`phase` is `SEED_COMMITTED` or `DECK_COMMITTED`)

`verifyRngProof(proof, { requireReveal: false })` plus `verifyPublicReveals(result, proof)`:

1. **shape** — 32-byte hashes, decimal nonce, a known phase;
2. **hidden-card invariant** — `deckSeed`, `entropy` and `salts` are `null` and `deck` is empty.
   A server that leaked any of them fails here, by name (`hidden.no_seed`, `hidden.no_ordering`, …);
3. `anchorBlock == commitBlock + 1`, `commitBlock < deckRootBlock ≤ commitBlock + 256`,
   `deckRootBlock − anchorBlock ≥ requiredConfirmations`;
4. **every published card opens against `R`** — `verifyCardReveal(R, reveal)`;
5. the board card at each dealt position matches the card in the reveal for that position
   (`verifyPublicReveals`, using §4's index map).

A verifier must **not** expect the whole deck here: `verifyHandDeal` legitimately reports
`deal.requires_audit` instead of a pass. That is the point of the scheme.

### After the hand (`phase` is `AUDITED`)

Everything above, plus:

6. `commitment == keccak256(seed ‖ nonce)`;
7. `entropy == keccak256(seed ‖ anchorBlockHash)`;
8. `deck == FisherYates(entropy)`;
9. `keccak256(leaves(deck, salts))` rebuilds to exactly `R`, and the salts are distinct;
10. every reveal agrees with the audited deck;
11. the deal map: holes, board and burns are exactly what §4 produces from the audited deck.

`verifyRngProof` covers 1–3 and 6–10, `verifyPublicReveals` covers 4–5 and 10,
`verifyHandDeal` covers 11. All three run in the browser (the monitor imports the same module the
server uses) and in the CLI:

```
npx llmpoker-verify hand <handId> --api https://<domain>    # fetch + verify
npx llmpoker-verify log  --file data/hands.jsonl            # the whole audit log
npx llmpoker-verify proof --file proof.json                 # a saved proof
npx llmpoker-verify shuffle --seed 0x… --anchor 0x…         # print the deck
npx llmpoker-verify commitment --seed 0x… --nonce 42         # print the phase-1 commitment
```

**Failure handling.** No reveal inside the window ⇒ the hand voids and escrow is refunded (FR-6.6).
A reorg of the anchor block ⇒ the hand is voided before dealing (FR-5.6). A failed audit ⇒ void plus
bond slash (FR-6.5).

---

## 6. Residual trust assumptions (stated honestly)

* **Liveness, not fairness, depends on the operator.** If it never reveals, the hand voids rather
  than resolving unfairly.
* **Phase 2 → audit is a priced trust window.** Between committing `R` and publishing the seed, the
  operator *knows* the deck while the players do not. It cannot change it (the root is fixed), but it
  can act on it — that is what the bond prices, and what FR-6.6's ZK immediate binding would
  eliminate. The bond must be non-zero in production (`REQUIRED_OPERATOR_BOND`, default 100 tokens
  in `contracts/scripts/deploy.ts`, sized to exceed what one hand can earn in rake).
* **The CSPRNG.** `seed` and every salt must come from a real CSPRNG. A weak seed is unguessable
  only if it is unpredictable; a weak salt makes individual hidden cards guessable from `R`.
* **Single-block hash grinding.** A validator able to influence `blockhash(N+1)` after seeing the
  commitment gets at most one block of influence and still cannot choose the deck without
  predicting its own future hash; FR-6.5 hardening (≥12 confirmations before committing the deck)
  narrows this further, and the shipped wager default is 12.
* **Rake-only house edge.** The platform never bets against players (FR-8.3), which caps what a
  biased deck could earn at rake rather than the whole pot.
* **The audit is not a proof of *who won*.** Hand evaluation is off-chain by design; the contract
  verifies every amount it can verify, and the deck is recomputable. A dishonest engine could
  misreport a winner, which is precisely why the commitment exists and why the ordering is published
  at the end for anyone to check.
