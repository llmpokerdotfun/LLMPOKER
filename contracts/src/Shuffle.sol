// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IShuffle } from "./interfaces/IShuffle.sol";

/**
 * @title Shuffle
 * @notice Verifiable RNG with **hidden cards**: seed commitment anchored to the next block, a
 *         Merkle commitment to the shuffled deck, progressive per-card reveals, and an
 *         end-of-hand audit backed by an operator bond (SRS §6, FR-6.1–6.9, NFR-6).
 *
 * @dev ### The invariant this contract exists to uphold
 *
 *      FR-6: *"the seed and full deck ordering MUST NEVER be published on-chain while a hand is
 *      live. Only commitments are public during play."* A naive commit-reveal shuffle breaks
 *      poker: publishing `deckSeed` (or `entropy`, or the ordering) lets every player read every
 *      opponent's hole cards before the showdown. So nothing here exposes the ordering while the
 *      hand is live:
 *
 *      | Phase | Function | Public data | Still secret |
 *      |---|---|---|---|
 *      | 1 (block `N`) | `commitSeed` | `keccak256(seed ‖ nonce)`, nonce, `commitBlock` | `seed` |
 *      | 2 (block `M`) | `commitDeck` | Merkle root `R`, anchor hash, confirmations | `seed`, ordering, all salts |
 *      | 3 (as needed) | `revealCard` | one `(card, leaf)` per card the rules require | the other 51 cards |
 *      | 4 (hand over) | `audit` | `seed`, `entropy`, the full deck | nothing |
 *
 *      Unrevealed positions are preimage-hiding commitments: `R` is a Merkle root over
 *      `keccak256(card_i ‖ salt_i)` with a 32-byte random salt per position, so `R` reveals
 *      nothing about any card without its salt (FR-6.8). With an unknown salt a hidden card's leaf
 *      hashes uniformly over `2^256`, so the unseen part of the deck is indistinguishable from a
 *      physical one.
 *
 *      ### Why the operator cannot steer the deck (FR-6.4)
 *
 *      `seed` is fixed in block `N`; `blockhash(N+1)` does not exist yet. Choosing a seed whose
 *      deck the operator likes would require predicting the next block hash. Because phase 2
 *      publishes only `R`, the operator also cannot *adapt* the ordering afterwards without being
 *      caught: `audit` recomputes `deck = FisherYates(keccak256(seed ‖ blockhash(N+1)))`, rebuilds
 *      the tree and compares it to `R`. A mismatch is a provable cheat and slashes the bond
 *      (FR-6.5).
 *
 *      ### Residual trust window, stated honestly
 *
 *      Between phase 2 and the audit the contract knows only `R`, so a cheating operator could
 *      commit a rigged deck, play the hand, settle, and only then be slashed at audit. The bond is
 *      what prices that (FR-6.5); FR-6.6 lists the ZK immediate-binding proof as the v2 fix that
 *      removes the window entirely. This contract implements the bonded variant.
 *
 *      ### Audit liveness
 *
 *      The seed must be published within the FR-6.7 window for the proof to exist at all. If no
 *      deck root arrives inside the reveal window the hand voids; if a root arrives but the audit
 *      never does, the hand also voids and the bond is slashed once `auditGraceBlocks` have
 *      passed. Both paths are permissionless, so liveness never depends on the operator.
 */
contract Shuffle is IShuffle, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Role allowed to commit, reveal cards, and audit (the off-chain engine, FR-10.3).
    bytes32 public constant OPERATOR_ROLE = keccak256("llmpoker.shuffle.operator");

    /// @notice Blocks after the phase-1 commitment within which phase 2 must land (FR-6.1, FR-6.7).
    uint256 public constant REVEAL_WINDOW_BLOCKS = 256;

    /// @notice Lower bound for `requiredConfirmations` (FR-6.5).
    uint256 public constant MIN_REQUIRED_CONFIRMATIONS = 1;

    /// @notice Upper bound for `requiredConfirmations`, keeping phase 2 inside the reveal window.
    uint256 public constant MAX_REQUIRED_CONFIRMATIONS = 128;

    /// @notice Lower bound for the post-`commitDeck` audit grace period (FR-6.7).
    uint256 public constant MIN_AUDIT_GRACE_BLOCKS = 64;

    /// @notice Upper bound for the post-`commitDeck` audit grace period (~24h at 12s blocks).
    uint256 public constant MAX_AUDIT_GRACE_BLOCKS = 100_000;

    /// @notice Number of cards in a deck (`docs/RNG.md` §3).
    uint256 public constant DECK_SIZE = 52;

    /// @dev Smallest power of two >= `DECK_SIZE`; the tree is padded with zero leaves to this size.
    uint256 private constant TREE_SIZE = 64;

    /// @dev `2^64`, the width of one draw from the keccak counter-mode stream (`docs/RNG.md` §3).
    uint256 private constant TWO_64 = 0x10000000000000000;

    /// @dev `2^64 - 1`, used to truncate a stream word to its big-endian `uint64` draw.
    uint256 private constant UINT64_MASK = 0xFFFFFFFFFFFFFFFF;

    /// @notice Sentinel returned by `revealedCardAt` for a card that is still hidden.
    uint8 public constant CARD_HIDDEN = type(uint8).max;

    /// @dev Shared empty-subtree constant (zero leaves are hashed as `abi.encode(uint256(0))`).
    bytes32 private constant ZERO_LEAF = keccak256(abi.encode(uint256(0)));

    /// @dev All 52 reveal bits set — the mask a fully public deck carries.
    uint64 private constant FULL_REVEAL_MASK = (uint64(1) << 52) - 1;

    /// @notice Blocks that must separate the anchor block and the phase-2 deck commitment (FR-6.5).
    uint256 public requiredConfirmations;

    /// @notice Blocks after `deckRootBlock` within which the audit must land (FR-6.7).
    uint256 public auditGraceBlocks;

    /// @notice Token the operator bond is denominated in.
    IERC20 public immutable token;

    /// @notice Bond the operator must hold to run this contract (FR-6.5).
    uint256 public requiredBond;

    /// @notice Bond currently posted by each operator.
    mapping(address => uint256) public bondOf;

    /// @notice Slashed bond proceeds awaiting `sweepSlashed` (FR-6.5).
    uint256 public slashedBondPool;

    struct Hand {
        bytes32 seedCommitment;
        bytes32 deckRoot;
        bytes32 anchorBlockHash;
        /// @dev Operator that committed the seed; the bond slashed on a proven cheat or stall.
        address operator;
        uint256 nonce;
        uint64 commitBlock;
        uint64 deckRootBlock;
        uint64 auditBlock;
        Phase phase;
        /// @dev `deckIndex => card`, valid only where the corresponding bit in `revealedMask` is set.
        uint8[52] revealedCards;
        /// @dev Bit `i` is set once position `i` has been published.
        uint64 revealedMask;
    }

    /// @dev `handId => hand record`.
    mapping(bytes32 => Hand) private _hands;

    /// @notice Emitted when the owner changes the finality threshold (FR-6.5).
    event RequiredConfirmationsUpdated(uint256 previous, uint256 current);
    /// @notice Emitted when the owner changes the audit grace period (FR-6.7).
    event AuditGraceUpdated(uint256 previous, uint256 current);
    /// @notice Emitted when the owner changes the required bond (FR-6.5).
    event RequiredBondUpdated(uint256 previous, uint256 current);

    /// @notice A phase-1 commitment already exists for this hand id (FR-6.1).
    error CommitmentExists(bytes32 handId);
    /// @notice No phase-1 commitment exists for this hand id.
    error UnknownHand(bytes32 handId);
    /// @notice The hand is not in the phase the call requires.
    error WrongPhase(bytes32 handId, Phase phase);
    /// @notice Phase 2 arrived before the anchor block was final (FR-6.5, NFR-6).
    error InsufficientConfirmations(uint256 blockNumber, uint256 earliestDeckCommitBlock);
    /// @notice Phase 2 arrived outside `(commitBlock, commitBlock + 256]` (FR-6.1, FR-6.7).
    error OutsideRevealWindow(uint256 commitBlock, uint256 blockNumber);
    /// @notice The anchor hash was unreadable (past the 256-block `blockhash` window) (FR-6.9).
    error AnchorUnavailable(uint256 anchorBlock);
    /// @notice The revealed seed does not open the phase-1 commitment.
    error SeedMismatch();
    /// @notice The supplied `deckRoot` is not the root of the supplied leaves.
    error DeckRootMismatch(bytes32 provided, bytes32 computed);
    /// @notice The tree rebuilt from the supplied `(card, salt)` pairs does not match the
    ///         committed root, i.e. the operator committed a different deck.
    error DeckRootMismatchOnAudit(bytes32 committedRoot, bytes32 rebuiltRoot);
    /// @notice A deck commitment / audit requires exactly 52 leaves.
    error InvalidLeafCount(uint256 provided);
    /// @notice The audited cards are not a permutation of the canonical 52-card deck.
    error DeckNotAPermutation();
    /// @notice The Merkle proof did not reproduce the committed root.
    error InvalidMerkleProof(uint8 deckIndex);
    /// @notice `deckIndex` is outside `0..51`.
    error InvalidDeckIndex(uint256 deckIndex);
    /// @notice This position has already been published.
    error CardAlreadyRevealed(uint8 deckIndex);
    /// @notice The hand is audited, so its cards are all public already.
    error AlreadyAudited(bytes32 handId);
    /// @notice Not enough bond posted to run a hand (FR-6.5).
    error InsufficientBond(uint256 available, uint256 required);
    /// @notice The hand cannot be voided yet (FR-6.7).
    error NotVoidableYet(uint256 voidableFromBlock);
    /// @notice The hand is already voided or audited.
    error HandClosed(bytes32 handId);
    /// @notice There is no slashed bond to sweep.
    error NothingSlashed();
    /// @notice A required address argument was the zero address.
    error ZeroAddress();
    /// @notice `requiredConfirmations` outside `[MIN, MAX]`.
    error InvalidRequiredConfirmations(uint256 value);
    /// @notice `auditGraceBlocks` outside `[MIN, MAX]`.
    error InvalidAuditGrace(uint256 value);

    /**
     * @param token_ ERC-20 the operator bond is denominated in (the platform token).
     * @param initialOwner Owner: `DEFAULT_ADMIN_ROLE` plus `OPERATOR_ROLE`.
     * @param initialRequiredConfirmations Finality threshold; 12 reproduces the shipped default
     *        (FR-6.5) and must be inside `[1, 128]`.
     * @param initialAuditGraceBlocks Blocks allowed between `commitDeck` and `audit` (FR-6.7).
     * @param initialRequiredBond Bond the operator must hold (0 disables bonding, FR-6.5).
     */
    constructor(
        IERC20 token_,
        address initialOwner,
        uint256 initialRequiredConfirmations,
        uint256 initialAuditGraceBlocks,
        uint256 initialRequiredBond
    ) {
        if (address(token_) == address(0) || initialOwner == address(0)) revert ZeroAddress();
        if (
            initialRequiredConfirmations < MIN_REQUIRED_CONFIRMATIONS
                || initialRequiredConfirmations > MAX_REQUIRED_CONFIRMATIONS
        ) {
            revert InvalidRequiredConfirmations(initialRequiredConfirmations);
        }
        if (initialAuditGraceBlocks < MIN_AUDIT_GRACE_BLOCKS || initialAuditGraceBlocks > MAX_AUDIT_GRACE_BLOCKS) {
            revert InvalidAuditGrace(initialAuditGraceBlocks);
        }
        token = IERC20(token_);
        requiredConfirmations = initialRequiredConfirmations;
        auditGraceBlocks = initialAuditGraceBlocks;
        requiredBond = initialRequiredBond;
        _grantRole(DEFAULT_ADMIN_ROLE, initialOwner);
        _grantRole(OPERATOR_ROLE, initialOwner);
    }

    // ---------------------------------------------------------------------
    // Operator bond (FR-6.5)
    // ---------------------------------------------------------------------

    /**
     * @notice Post or top up the operator bond.
     * @dev FR-6.5. The bond is the economic deterrent for the phase-2 → audit trust window; it is
     *      slashed on a proven deck-vs-commitment mismatch or on an audit liveness failure.
     * @param amount Amount of token to lock.
     */
    function postBond(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAddress();
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 bond = bondOf[msg.sender] + amount;
        bondOf[msg.sender] = bond;
        emit BondPosted(msg.sender, amount, bond);
    }

    /**
     * @notice Sweep slashed bond proceeds to a recipient.
     * @dev FR-6.5. Owner-gated. The SRS does not name a destination for slashed funds, so this
     *      implementation accumulates them in `slashedBondPool` and lets the owner route them
     *      (expected: the operations/trading-rewards `Vault`). Slashing proceeds can never accrue
     *      to the party that was slashed.
     * @param to Recipient.
     * @param amount Amount to sweep.
     */
    function sweepSlashed(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 pool = slashedBondPool;
        if (amount == 0 || amount > pool) revert NothingSlashed();
        slashedBondPool = pool - amount;
        token.safeTransfer(to, amount);
        emit SlashedBondSwept(to, amount);
    }

    // ---------------------------------------------------------------------
    // Phase 1 — commit the seed (FR-6.1)
    // ---------------------------------------------------------------------

    /**
     * @notice Publish `keccak256(abi.encodePacked(bytes32 seed, uint256 nonce))` for a hand.
     * @dev FR-6.1. The seed stays secret. `commitBlock` fixes the anchor block `commitBlock + 1`
     *      by consensus and starts the reveal window. Reverts when a commitment already exists for
     *      `handId` (FR-10.4 replay protection: one commitment per hand) and when the caller's bond
     *      is below `requiredBond` (FR-6.5).
     * @param handId Hand identifier shared with `Poker.sol`.
     * @param seedCommitment The commitment hash.
     * @param nonce Per-table monotonic nonce, public from this point (prevents seed replay).
     */
    function commitSeed(bytes32 handId, bytes32 seedCommitment, uint256 nonce) external onlyRole(OPERATOR_ROLE) {
        if (handId == bytes32(0)) revert UnknownHand(handId);
        if (bondOf[msg.sender] < requiredBond) revert InsufficientBond(bondOf[msg.sender], requiredBond);

        Hand storage hand = _hands[handId];
        if (hand.phase != Phase.None) revert CommitmentExists(handId);

        hand.seedCommitment = seedCommitment;
        hand.nonce = nonce;
        hand.commitBlock = uint64(block.number);
        hand.operator = msg.sender;
        hand.phase = Phase.SeedCommitted;

        emit SeedCommitted(handId, seedCommitment, nonce, block.number);
    }

    // ---------------------------------------------------------------------
    // Phase 2 — commit the deck, not the seed (FR-6.2)
    // ---------------------------------------------------------------------

    /**
     * @notice Publish the Merkle root of the salted shuffled deck.
     * @dev FR-6.2, FR-6.9. `leaves[i]` must be `keccak256(abi.encodePacked(uint8 card_i, bytes32
     *      salt_i))` for shuffled position `i`. The contract stores only the root, so the ordering
     *      stays hidden. The internal anchor capture caches `blockhash(commitBlock + 1)` for permanent
     *      recomputation. Requires `>= requiredConfirmations` of the anchor block (FR-6.5, NFR-6)
     *      and must land inside `(commitBlock, commitBlock + 256]` (FR-6.1, FR-6.7).
     * @param handId Hand identifier.
     * @param deckRoot The Merkle root over the 52 salted leaf hashes.
     * @param leaves The 52 leaf hashes, in deck order.
     */
    function commitDeck(bytes32 handId, bytes32 deckRoot, bytes32[] calldata leaves)
        external
        onlyRole(OPERATOR_ROLE)
    {
        Hand storage hand = _hands[handId];
        if (hand.phase == Phase.None) revert UnknownHand(handId);
        if (hand.phase != Phase.SeedCommitted) revert WrongPhase(handId, hand.phase);
        if (leaves.length != DECK_SIZE) revert InvalidLeafCount(leaves.length);

        uint256 commitBlock = hand.commitBlock;
        _requireInsideRevealWindow(commitBlock, block.number);

        bytes32 anchorBlockHash = _captureAnchor(hand, commitBlock, block.number);

        bytes32 computed = merkleRootOf(leaves);
        if (computed != deckRoot) revert DeckRootMismatch(deckRoot, computed);

        hand.deckRoot = deckRoot;
        hand.deckRootBlock = uint64(block.number);
        hand.phase = Phase.DeckCommitted;

        emit DeckCommitted(
            handId,
            deckRoot,
            commitBlock,
            block.number,
            commitBlock + 1,
            anchorBlockHash,
            block.number - (commitBlock + 1)
        );
    }

    // ---------------------------------------------------------------------
    // Phase 3 — progressive per-card reveal (FR-6.3)
    // ---------------------------------------------------------------------

    /**
     * @notice Publish one card and its Merkle proof, because the game rules require it.
     * @dev FR-6.3. The card is bound to the committed root by
     *      `keccak256(abi.encodePacked(card, salt))`, so the operator cannot publish a card other
     *      than the one committed at that position. Cards stay hidden until this is called: no
     *      player can read a card that has not been dealt.
     * @param handId Hand identifier.
     * @param deckIndex Position in the shuffled deck, `0..51`.
     * @param card `rank * 4 + suit` (SRS card encoding).
     * @param salt The 32-byte salt for that position.
     * @param proof Sibling hashes from the leaf level up to the root (10 entries for a 52-leaf deck).
     */
    function revealCard(bytes32 handId, uint8 deckIndex, uint8 card, bytes32 salt, bytes32[] calldata proof)
        external
        onlyRole(OPERATOR_ROLE)
    {
        Hand storage hand = _hands[handId];
        if (hand.phase == Phase.None) revert UnknownHand(handId);
        if (hand.phase == Phase.Audited) revert AlreadyAudited(handId);
        if (hand.phase != Phase.DeckCommitted) revert WrongPhase(handId, hand.phase);
        if (deckIndex >= DECK_SIZE) revert InvalidDeckIndex(deckIndex);

        uint64 mask = hand.revealedMask;
        uint64 bit = uint64(1) << uint64(deckIndex);
        if ((mask & bit) != 0) revert CardAlreadyRevealed(deckIndex);

        bytes32 leaf = leafHash(card, salt);
        if (!_verifyMerkleProof(hand.deckRoot, leaf, deckIndex, proof)) revert InvalidMerkleProof(deckIndex);

        hand.revealedMask = mask | bit;
        hand.revealedCards[deckIndex] = card;

        emit CardRevealed(handId, deckIndex, card, leaf, block.number, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Phase 4 — end-of-hand audit (FR-6.4, FR-6.5, FR-6.7)
    // ---------------------------------------------------------------------

    /**
     * @notice Reveal `seed` plus every salt and prove the commitment was honest.
     * @dev FR-6.4. Three independent checks, all on-chain:
     *
     *      1. `keccak256(seed ‖ nonce) == seedCommitment` — the seed is the committed one (reverts,
     *         so the operator can retry with the right seed);
     *      2. rebuilding the Merkle tree from `(card_i, salt_i)` equals the committed `deckRoot`;
     *      3. `FisherYates(keccak256(seed ‖ anchorBlockHash))` equals the same tree, and every
     *         already-published card matches the recomputed one.
     *
     *      A failure of (2) or (3) is a **provable cheat**: it records `AuditFailed`, voids the hand
     *      and slashes the operator bond (FR-6.5). Success emits the whole proof, which is safe
     *      because the hand is over.
     * @param handId Hand identifier.
     * @param deckSeed The seed committed at phase 1.
     * @param cards The 52 card values, in deck order.
     * @param salts The 52 salts, in deck order.
     */
    function audit(bytes32 handId, bytes32 deckSeed, uint8[] calldata cards, bytes32[] calldata salts)
        external
        nonReentrant
    {
        Hand storage hand = _hands[handId];
        if (hand.phase == Phase.None) revert UnknownHand(handId);
        if (hand.phase != Phase.DeckCommitted) revert WrongPhase(handId, hand.phase);
        if (cards.length != DECK_SIZE || salts.length != DECK_SIZE) revert InvalidLeafCount(cards.length);
        _requireCompleteDeck(cards);
        if (keccak256(abi.encodePacked(deckSeed, hand.nonce)) != hand.seedCommitment) revert SeedMismatch();

        bytes32 committedRoot = hand.deckRoot;

        // (2) The committed root must be the tree over the supplied salted leaves.
        bytes32 rebuiltRoot = merkleRootOf(_leavesFrom(cards, salts));
        if (rebuiltRoot != committedRoot) {
            _slashAndVoid(handId, hand, committedRoot, rebuiltRoot);
            return;
        }

        // (3) The authoritative deal: the deck derived from the committed seed and the anchor hash.
        bytes32 entropy = computeEntropy(deckSeed, hand.anchorBlockHash);
        (uint8[52] memory deck,) = _computeDeck(entropy);
        bytes32 expectedRoot = merkleRootOf(_leavesFromDeck(deck, salts));
        if (expectedRoot != committedRoot) {
            _slashAndVoid(handId, hand, committedRoot, expectedRoot);
            return;
        }

        // Every card that was already public must agree with the derived deck: this is what makes
        // the partial reveals binding.
        uint64 mask = hand.revealedMask;
        for (uint256 i = 0; i < DECK_SIZE; ++i) {
            if ((mask & (uint64(1) << uint64(i))) == 0) continue;
            if (hand.revealedCards[i] != deck[i]) {
                _slashAndVoid(handId, hand, committedRoot, expectedRoot);
                return;
            }
        }

        hand.phase = Phase.Audited;
        hand.auditBlock = uint64(block.number);
        // The audit is the point at which the ordering legitimately becomes public, so every
        // position is materialised and the reveal mask is complete (FR-6.4).
        for (uint256 i = 0; i < DECK_SIZE; ++i) {
            hand.revealedCards[i] = deck[i];
        }
        hand.revealedMask = FULL_REVEAL_MASK;

        emit Audited(handId, deckSeed, entropy, committedRoot, deck, block.number);
    }

    // ---------------------------------------------------------------------
    // Liveness — void (FR-6.7)
    // ---------------------------------------------------------------------

    /**
     * @notice Void a hand whose deck commitment or audit never arrived, slashing the bond.
     * @dev FR-6.7. Permissionless by design: the liveness guarantee must not depend on the
     *      operator. Two cases:
     *
     *      * no deck root inside the reveal window ⇒ `NoDeckCommitment`;
     *      * a deck root arrived but the audit never did (past `auditGraceBlocks`) ⇒ `AuditStalled`.
     *
     *      `Poker.sol` observes the `Voided` phase through `phaseOf` and restores every
     *      contribution to its seat.
     * @param handId Hand identifier.
     */
    function void(bytes32 handId) external nonReentrant {
        Hand storage hand = _hands[handId];
        if (hand.phase == Phase.None) revert UnknownHand(handId);
        if (hand.phase == Phase.Audited || hand.phase == Phase.Voided) revert HandClosed(handId);

        uint256 commitBlock = hand.commitBlock;
        VoidReason reason;

        if (hand.phase == Phase.SeedCommitted) {
            uint256 voidableFrom = commitBlock + REVEAL_WINDOW_BLOCKS + 1;
            if (block.number < voidableFrom) revert NotVoidableYet(voidableFrom);
            reason = VoidReason.NoDeckCommitment;
        } else {
            uint256 deadline = uint256(hand.deckRootBlock) + auditGraceBlocks;
            if (block.number <= deadline) revert NotVoidableYet(deadline + 1);
            reason = VoidReason.AuditStalled;
        }

        uint256 slashed = _slash(hand.operator, handId, requiredBond);
        hand.phase = Phase.Voided;
        emit Voided(handId, reason, slashed, block.number);
    }

    // ---------------------------------------------------------------------
    // Pure verification helpers (FR-6.2, FR-6.3, FR-6.4 — off-chain verifier parity)
    // ---------------------------------------------------------------------

    /**
     * @notice `keccak256(abi.encodePacked(uint8 card, bytes32 salt))`, the FR-6.2 leaf preimage.
     * @dev Both operands are fixed width (`uint8` occupies one byte, `bytes32` is 32), so
     *      `encodePacked` is unambiguous. Off-chain verifiers must use the same encoding.
     */
    function leafHash(uint8 card, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(card, salt));
    }

    /**
     * @notice Merkle root over `leaves`, zero-padded to the next power of two.
     * @dev Interior node rule: `keccak256(abi.encode(left, right))` — **order preserving**.
     *
     *      This is load-bearing. A "sorted pair" interior node makes the root invariant under any
     *      permutation of the leaves (every permutation is a product of sibling swaps, and a
     *      sorted parent does not change when its children swap), so it can only commit to a
     *      *set*, not to an ordering. A poker deck is an ordered sequence — position 3 holding the
     *      seven of clubs is a different deal from position 4 holding it — so the root has to
     *      depend on the order, and the sorted-pair hardening is deliberately rejected here.
     *
     *      Second-preimage safety comes from the leaf shape instead: a leaf is
     *      `keccak256(card ‖ salt)` over a fixed 33 bytes while an interior node hashes 64 bytes,
     *      so a leaf can never be replayed as an interior node. Leaves are padded to
     *      `TREE_SIZE = 64` with a constant so the tree shape is canonical, which makes every
     *      52-leaf deck proof exactly 10 entries long.
     * @param leaves Leaf hashes in deck order (52 for a deck).
     */
    function merkleRootOf(bytes32[] memory leaves) public pure returns (bytes32) {
        bytes32[TREE_SIZE] memory level;
        for (uint256 i = 0; i < TREE_SIZE; ++i) {
            level[i] = i < leaves.length ? leaves[i] : ZERO_LEAF;
        }

        uint256 width = TREE_SIZE;
        while (width > 1) {
            uint256 half = width / 2;
            for (uint256 i = 0; i < half; ++i) {
                level[i] = _hashPair(level[2 * i], level[2 * i + 1]);
            }
            width = half;
        }
        return level[0];
    }

    /**
     * @notice Convenience for verifiers: check one FR-6.3 card reveal against a committed root.
     * @dev The off-chain verifier runs the identical loop without trusting this contract; exposing
     *      it also makes the committed vectors in `packages/shared/vectors/merkle-vectors.json`
     *      checkable on-chain, so the two implementations cannot silently diverge.
     * @param root The committed Merkle deck root.
     * @param deckIndex Position in the shuffled deck, `0..51`.
     * @param card `rank * 4 + suit`.
     * @param salt The position's salt.
     * @param proof Six sibling hashes, leaf level first.
     */
    function verifyCardProof(bytes32 root, uint8 deckIndex, uint8 card, bytes32 salt, bytes32[] calldata proof)
        external
        pure
        returns (bool)
    {
        return _verifyMerkleProof(root, leafHash(card, salt), deckIndex, proof);
    }

    /**
     * @notice Convenience for verifiers: the deck root implied by `entropy` and `salts`.
     * @dev Runs the same pipeline `audit` checks: `entropy → Fisher–Yates → salted leaves → root`.
     *      An off-chain verifier recomputes this without trusting this contract.
     * @param entropy `keccak256(abi.encodePacked(bytes32 deckSeed, bytes32 anchorBlockHash))`.
     * @param salts The 52 salts in deck order.
     */
    function deckRootFromEntropy(bytes32 entropy, bytes32[] calldata salts) external pure returns (bytes32) {
        (uint8[52] memory deck,) = _computeDeck(entropy);
        return merkleRootOf(_leavesFromDeck(deck, salts));
    }

    /**
     * @notice Shuffled deck derived from `entropy`, plus the keccak words the draw stream used.
     * @dev Canonical `docs/RNG.md` §3 implementation; kept pure and public so the committed vectors
     *      in `packages/shared/vectors/rng-vectors.json` can be asserted against it, and so the
     *      audit is reproducible by anyone. **This never reads the hidden deck of a live hand** — it
     *      is a pure function of its argument, which is what makes "the contract can verify without
     *      knowing" possible.
     * @param entropy `keccak256(abi.encodePacked(bytes32 deckSeed, bytes32 anchorBlockHash))`.
     */
    function computeDeckWithCost(bytes32 entropy) external pure returns (uint8[52] memory deck, uint256 wordsConsumed) {
        return _computeDeck(entropy);
    }

    /**
     * @notice Shuffled deck derived from `entropy`.
     * @dev `docs/RNG.md` §3.
     * @param entropy `keccak256(abi.encodePacked(bytes32 deckSeed, bytes32 anchorBlockHash))`.
     */
    function computeDeck(bytes32 entropy) external pure returns (uint8[52] memory) {
        (uint8[52] memory deck,) = _computeDeck(entropy);
        return deck;
    }

    /**
     * @notice `entropy = keccak256(abi.encodePacked(bytes32 deckSeed, bytes32 anchorBlockHash))`.
     * @dev `docs/RNG.md` §2 / FR-6.4.
     */
    function computeEntropy(bytes32 deckSeed, bytes32 anchorBlockHash) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(deckSeed, anchorBlockHash));
    }

    /// @notice The FR-6.1 phase-1 commitment for a `(seed, nonce)` pair.
    function seedCommitmentOfSeed(bytes32 deckSeed, uint256 nonce) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(deckSeed, nonce));
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /**
     * @notice Everything a verifier needs about one hand's commitment state (FR-6.3, NFR-4).
     * @dev Deliberately exposes **no** hidden card and **no** seed before the audit.
     */
    function handProofOf(bytes32 handId)
        external
        view
        returns (
            Phase phase,
            bytes32 seedCommitment,
            bytes32 deckRoot,
            bytes32 anchorBlockHash,
            uint256 nonce,
            uint256 commitBlock,
            uint256 deckRootBlock,
            uint256 auditBlock,
            uint256 revealedCount
        )
    {
        Hand storage hand = _hands[handId];
        return (
            hand.phase,
            hand.seedCommitment,
            hand.deckRoot,
            hand.anchorBlockHash,
            hand.nonce,
            hand.commitBlock,
            hand.deckRootBlock,
            hand.auditBlock,
            _popcount(hand.revealedMask)
        );
    }

    /// @notice The anchor block for a committed hand (`commitBlock + 1`) (FR-6.9).
    function anchorBlockOf(bytes32 handId) external view returns (uint256) {
        uint256 commitBlock = _hands[handId].commitBlock;
        if (commitBlock == 0) return 0;
        return commitBlock + 1;
    }

    /// @notice Earliest block at which the deck root may be committed (FR-6.5).
    function earliestDeckCommitBlockOf(bytes32 handId) external view returns (uint256) {
        Hand storage hand = _hands[handId];
        if (hand.phase == Phase.None) return 0;
        return uint256(hand.commitBlock) + 1 + requiredConfirmations;
    }

    /// @notice Block from which `handId` may be voided for liveness failure (FR-6.7).
    function voidableFromBlockOf(bytes32 handId) external view returns (uint256) {
        Hand storage hand = _hands[handId];
        if (hand.phase == Phase.SeedCommitted) return uint256(hand.commitBlock) + REVEAL_WINDOW_BLOCKS + 1;
        if (hand.phase == Phase.DeckCommitted) return uint256(hand.deckRootBlock) + auditGraceBlocks + 1;
        return type(uint256).max;
    }

    /// @notice The card published at `deckIndex`, or `CARD_HIDDEN` when still secret (FR-6.3).
    function revealedCardAt(bytes32 handId, uint8 deckIndex) external view returns (uint8) {
        if (deckIndex >= DECK_SIZE) revert InvalidDeckIndex(deckIndex);
        Hand storage hand = _hands[handId];
        if (hand.phase != Phase.Audited && (hand.revealedMask & (uint64(1) << uint64(deckIndex))) == 0) {
            return CARD_HIDDEN;
        }
        return hand.revealedCards[deckIndex];
    }

    /// @notice True when all 52 positions are public.
    function isFullyRevealed(bytes32 handId) external view returns (bool) {
        Hand storage hand = _hands[handId];
        return hand.phase == Phase.Audited || hand.revealedMask == FULL_REVEAL_MASK;
    }

    /// @notice True when the end-of-hand audit succeeded (FR-6.4).
    function isAudited(bytes32 handId) external view returns (bool) {
        return _hands[handId].phase == Phase.Audited;
    }

    /// @notice Phase-1 commitment exists for `handId` (FR-6.1).
    function hasCommitment(bytes32 handId) external view returns (bool) {
        return _hands[handId].phase != Phase.None;
    }

    /// @notice Deck root committed and not voided — the gate `Poker.sol` uses to settle (FR-6.2).
    function isDeckCommitted(bytes32 handId) external view returns (bool) {
        Phase phase = _hands[handId].phase;
        return phase == Phase.DeckCommitted || phase == Phase.Audited;
    }

    /// @notice Lifecycle phase of `handId`.
    function phaseOf(bytes32 handId) external view returns (Phase) {
        return _hands[handId].phase;
    }

    /// @notice FR-6.1 commitment hash stored for `handId`.
    function seedCommitmentOf(bytes32 handId) external view returns (bytes32) {
        return _hands[handId].seedCommitment;
    }

    /// @notice FR-6.2 Merkle deck root stored for `handId` (zero before phase 2).
    function deckRootOf(bytes32 handId) external view returns (bytes32) {
        return _hands[handId].deckRoot;
    }

    /// @notice Stored anchor hash for `handId` (zero before phase 2) (FR-6.9).
    function anchorBlockHashOf(bytes32 handId) external view returns (bytes32) {
        return _hands[handId].anchorBlockHash;
    }

    /// @notice Phase-1 block for `handId`.
    function commitBlockOf(bytes32 handId) external view returns (uint256) {
        return _hands[handId].commitBlock;
    }

    /// @notice Phase-2 block for `handId`.
    function deckRootBlockOf(bytes32 handId) external view returns (uint256) {
        return _hands[handId].deckRootBlock;
    }

    /// @notice Audit block for `handId` (0 until audited).
    function auditBlockOf(bytes32 handId) external view returns (uint256) {
        return _hands[handId].auditBlock;
    }

    /// @notice Nonce committed at phase 1.
    function nonceOf(bytes32 handId) external view returns (uint256) {
        return _hands[handId].nonce;
    }

    /// @notice Operator whose bond backs `handId` (FR-6.5).
    function operatorOf(bytes32 handId) external view returns (address) {
        return _hands[handId].operator;
    }

    // ---------------------------------------------------------------------
    // Administration (FR-6.5, FR-6.7, FR-9.7)
    // ---------------------------------------------------------------------

    /**
     * @notice Update the anchor finality threshold.
     * @dev FR-6.5 / FR-9.7. Bounded so the earliest phase-2 block can never exceed the reveal
     *      window, which would make every hand un-committable.
     */
    function setRequiredConfirmations(uint256 newValue) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newValue < MIN_REQUIRED_CONFIRMATIONS || newValue > MAX_REQUIRED_CONFIRMATIONS) {
            revert InvalidRequiredConfirmations(newValue);
        }
        uint256 previous = requiredConfirmations;
        requiredConfirmations = newValue;
        emit RequiredConfirmationsUpdated(previous, newValue);
    }

    /**
     * @notice Update the audit grace period after a deck commitment.
     * @dev FR-6.7 / FR-9.7. Only affects hands committed afterwards: in-flight hands keep the
     *      deadline they were given, so a pending audit cannot be cut short.
     */
    function setAuditGraceBlocks(uint256 newValue) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newValue < MIN_AUDIT_GRACE_BLOCKS || newValue > MAX_AUDIT_GRACE_BLOCKS) {
            revert InvalidAuditGrace(newValue);
        }
        uint256 previous = auditGraceBlocks;
        auditGraceBlocks = newValue;
        emit AuditGraceUpdated(previous, newValue);
    }

    /**
     * @notice Update the bond an operator must hold to commit hands.
     * @dev FR-6.5. Only affects future `commitSeed` calls; existing bonds are untouched.
     */
    function setRequiredBond(uint256 newValue) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 previous = requiredBond;
        requiredBond = newValue;
        emit RequiredBondUpdated(previous, newValue);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// @dev FR-6.1/FR-6.7: phase 2 must be strictly after the commit block and inside the window.
    function _requireInsideRevealWindow(uint256 commitBlock, uint256 atBlock) private pure {
        if (atBlock <= commitBlock || atBlock > commitBlock + REVEAL_WINDOW_BLOCKS) {
            revert OutsideRevealWindow(commitBlock, atBlock);
        }
    }

    /// @dev FR-6.5/FR-6.9: enforce finality and cache `blockhash(commitBlock + 1)` into storage.
    function _captureAnchor(Hand storage hand, uint256 commitBlock, uint256 atBlock)
        private
        returns (bytes32 anchorBlockHash)
    {
        uint256 anchorBlock = commitBlock + 1;
        uint256 earliest = anchorBlock + requiredConfirmations;
        if (atBlock < earliest) revert InsufficientConfirmations(atBlock, earliest);

        anchorBlockHash = blockhash(anchorBlock);
        // `blockhash` returns zero for the current/future block and past 256 blocks. The window
        // check already excludes the latter and `atBlock > commitBlock` excludes the former, so
        // this is a defensive invariant rather than a reachable path.
        if (anchorBlockHash == bytes32(0)) revert AnchorUnavailable(anchorBlock);
        hand.anchorBlockHash = anchorBlockHash;
    }

    /// @dev FR-6.4/FR-6.5: a proven cheat voids the hand and slashes the operator's bond.
    function _slashAndVoid(bytes32 handId, Hand storage hand, bytes32 committedRoot, bytes32 expectedRoot) private {
        hand.phase = Phase.Voided;
        hand.auditBlock = uint64(block.number);
        uint256 slashed = _slash(hand.operator, handId, requiredBond);
        emit AuditFailed(handId, committedRoot, expectedRoot, slashed);
        emit Voided(handId, VoidReason.AuditStalled, slashed, block.number);
    }

    /// @dev Remove `amount` from `account`'s bond and park it for `sweepSlashed` (FR-6.5).
    function _slash(address account, bytes32 handId, uint256 amount) private returns (uint256 slashed) {
        uint256 bond = bondOf[account];
        slashed = amount > bond ? bond : amount;
        if (slashed != 0) {
            bondOf[account] = bond - slashed;
            slashedBondPool += slashed;
            emit BondSlashed(handId, slashed, slashedBondPool);
        }
    }

    /// @dev `keccak256(abi.encode(left, right))` — ordered, so the root commits to the sequence.
    function _hashPair(bytes32 a, bytes32 b) private pure returns (bytes32) {
        return keccak256(abi.encode(a, b));
    }

    /// @dev FR-6.3: recompute the path from `leaf` at `index` and compare to the committed root.
    function _verifyMerkleProof(bytes32 root, bytes32 leaf, uint256 index, bytes32[] calldata proof)
        private
        pure
        returns (bool)
    {
        bytes32 node = leaf;
        uint256 idx = index;
        for (uint256 i = 0; i < proof.length; ++i) {
            node = (idx & 1) == 0 ? _hashPair(node, proof[i]) : _hashPair(proof[i], node);
            idx >>= 1;
        }
        return node == root;
    }

    /// @dev FR-6.4: a deck is a permutation of `0..51`; anything else cannot be a shuffled deck.
    function _requireCompleteDeck(uint8[] calldata cards) private pure {
        uint64 seen;
        for (uint256 i = 0; i < DECK_SIZE; ++i) {
            uint8 card = cards[i];
            if (card >= DECK_SIZE) revert DeckNotAPermutation();
            uint64 bit = uint64(1) << uint64(card);
            if ((seen & bit) != 0) revert DeckNotAPermutation();
            seen |= bit;
        }
    }

    /// @dev Salted leaves for one `(card, salt)` pair per position.
    function _leavesFrom(uint8[] calldata cards, bytes32[] calldata salts) private pure returns (bytes32[] memory leaves) {
        leaves = new bytes32[](DECK_SIZE);
        for (uint256 i = 0; i < DECK_SIZE; ++i) {
            leaves[i] = leafHash(cards[i], salts[i]);
        }
    }

    /// @dev Salted leaves for a memory deck ordering.
    function _leavesFromDeck(uint8[52] memory deck, bytes32[] calldata salts)
        private
        pure
        returns (bytes32[] memory leaves)
    {
        if (salts.length != DECK_SIZE) revert InvalidLeafCount(salts.length);
        leaves = new bytes32[](DECK_SIZE);
        for (uint256 i = 0; i < DECK_SIZE; ++i) {
            leaves[i] = leafHash(deck[i], salts[i]);
        }
    }

    /// @dev Population count of the reveal mask.
    function _popcount(uint64 value) private pure returns (uint256 count) {
        while (value != 0) {
            value &= value - 1;
            unchecked {
                ++count;
            }
        }
    }

    /**
     * @dev `docs/RNG.md` §3, implemented verbatim.
     *
     *      `word(k) = keccak256(abi.encodePacked(bytes32 entropy, uint256 k))`, read as four
     *      big-endian `uint64` draws at byte offsets 0, 8, 16, 24. Rejected draws (those
     *      `>= floor(2^64 / range) * range`) consume stream positions, which is exactly why
     *      `wordsConsumed` is part of the committed vectors.
     */
    function _computeDeck(bytes32 entropy) internal pure returns (uint8[52] memory deck, uint256 wordsConsumed) {
        for (uint256 i = 0; i < DECK_SIZE; ++i) {
            deck[i] = uint8(i);
        }

        uint256 wordIndex = 0;
        uint256 drawInWord = 4; // forces a fresh word on the first draw
        bytes32 word = bytes32(0);

        // i = 51 down to 1; `i == 0` needs no draw.
        for (uint256 i = 51; i >= 1; --i) {
            uint256 range = i + 1;
            // Rejection bound for a uniform draw over `[0, 2^64)`: reject anything at or above
            // the largest multiple of `range` that fits in 64 bits (`docs/RNG.md` §3).
            uint256 limit = (TWO_64 / range) * range;

            uint256 d;
            bool rejected = true;
            while (rejected) {
                if (drawInWord >= 4) {
                    word = keccak256(abi.encodePacked(entropy, wordIndex));
                    unchecked {
                        ++wordIndex;
                    }
                    drawInWord = 0;
                }
                // Big-endian `uint64` read: the top 64 bits of the stream word.
                d = (uint256(word) >> (192 - (drawInWord * 64))) & UINT64_MASK;
                unchecked {
                    ++drawInWord;
                }
                rejected = d >= limit;
            }

            uint256 j = d % range;
            if (i != j) {
                (deck[i], deck[j]) = (deck[j], deck[i]);
            }
        }

        wordsConsumed = wordIndex;
    }
}
