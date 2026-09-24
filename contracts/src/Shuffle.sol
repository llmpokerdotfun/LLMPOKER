// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IShuffle } from "./interfaces/IShuffle.sol";

/**
 * @title Shuffle
 * @notice Verifiable RNG for No-Limit Texas Hold'em: commit-reveal keyed to the block
 *         immediately after the commitment, with a permanently stored anchor hash and a
 *         fully on-chain Fisherâ€“Yates shuffle (SRS Â§6, FR-6.1â€“6.6, NFR-6).
 *
 * @dev Implements `docs/RNG.md` exactly; the random draw stream is
 *      `keccak256(abi.encodePacked(bytes32 entropy, uint256 k))` read as big-endian
 *      `uint64` words with rejection sampling, so `computeDeck` reproduces
 *      `packages/shared/vectors/rng-vectors.json` byte for byte â€” including
 *      `wordsConsumed`.
 *
 *      Lifecycle (FR-6.1):
 *      1. `commit(handId, commitment, nonce)` lands in block `N`.
 *      2. `anchorBlock = N + 1`; its hash is captured into storage at reveal time (FR-6.2).
 *      3. `reveal(handId, deckSeed)` in block `M` with `N < M <= N + 256` and
 *         `M >= N + 1 + requiredConfirmations` (FR-6.5, NFR-6).
 *      4. `entropy = keccak256(deckSeed || anchorBlockHash)` and the deck is stored.
 *      5. If no reveal lands in the window, anyone may `void(handId)` (FR-6.6).
 *
 *      The owner can never rewrite a commitment, anchor hash, entropy or deck: every one of
 *      those fields is written exactly once and there is no setter for them.
 */
contract Shuffle is IShuffle, AccessControl {
    /// @notice Role allowed to commit and reveal (the off-chain engine, FR-10.3).
    bytes32 public constant OPERATOR_ROLE = keccak256("llmpoker.shuffle.operator");

    /// @notice Blocks after `commitBlock` within which a reveal must land (FR-6.1, FR-6.6).
    uint256 public constant REVEAL_WINDOW_BLOCKS = 256;

    /// @notice Lower bound for `requiredConfirmations` (FR-6.5).
    uint256 public constant MIN_REQUIRED_CONFIRMATIONS = 1;

    /// @notice Upper bound for `requiredConfirmations`, keeping `reveal < commitBlock + 256`.
    uint256 public constant MAX_REQUIRED_CONFIRMATIONS = 128;

    /// @notice Blocks that must separate the anchor block and the reveal block (FR-6.5).
    uint256 public requiredConfirmations;

    struct Commitment {
        bytes32 commitment;
        bytes32 anchorBlockHash;
        bytes32 entropy;
        uint256 nonce;
        uint64 commitBlock;
        uint64 revealBlock;
        State state;
    }

    /// @dev `handId => commitment record`.
    mapping(bytes32 => Commitment) private _commitments;

    /// @dev `handId => shuffled deck` (deal order; index 0 is the first card dealt).
    mapping(bytes32 => uint8[52]) private _decks;

    /// @notice Emitted when the owner changes the finality threshold (FR-6.5).
    event RequiredConfirmationsUpdated(uint256 previous, uint256 current);

    /// @notice A commitment already exists for this hand id (FR-6.1).
    error CommitmentExists(bytes32 handId);

    /// @notice No commitment was ever recorded for this hand id.
    error UnknownHand(bytes32 handId);

    /// @notice The hand is already revealed or voided.
    error HandNotPending(bytes32 handId);

    /// @notice Reveal attempt landed in or before the anchor block, or past `commitBlock + 256`.
    error OutsideRevealWindow(uint256 commitBlock, uint256 revealBlock);

    /// @notice Not enough confirmations have passed since the anchor block (FR-6.5, NFR-6).
    error InsufficientConfirmations(uint256 revealBlock, uint256 earliestRevealBlock);

    /// @notice The revealed seed does not open the stored commitment.
    error CommitmentMismatch();

    /// @notice The reveal window has not expired yet, so the hand cannot be voided.
    error RevealWindowOpen(uint256 commitBlock, uint256 voidableFromBlock);

    /// @notice A required address argument was the zero address.
    error ZeroAddress();

    /// @notice `requiredConfirmations` outside `[MIN_REQUIRED_CONFIRMATIONS, MAX_REQUIRED_CONFIRMATIONS]`.
    error InvalidRequiredConfirmations(uint256 value);

    /**
     * @param initialOwner Address receiving `DEFAULT_ADMIN_ROLE` and `OPERATOR_ROLE`.
     * @param initialRequiredConfirmations Finality threshold; 12 reproduces the shipped default
     *        (FR-6.5) and must be inside `[1, 128]`.
     */
    constructor(address initialOwner, uint256 initialRequiredConfirmations) {
        if (initialOwner == address(0)) revert ZeroAddress();
        if (
            initialRequiredConfirmations < MIN_REQUIRED_CONFIRMATIONS
                || initialRequiredConfirmations > MAX_REQUIRED_CONFIRMATIONS
        ) {
            revert InvalidRequiredConfirmations(initialRequiredConfirmations);
        }
        requiredConfirmations = initialRequiredConfirmations;
        _grantRole(DEFAULT_ADMIN_ROLE, initialOwner);
        _grantRole(OPERATOR_ROLE, initialOwner);
    }

    /**
     * @notice Publish `keccak256(abi.encodePacked(bytes32 deckSeed, uint256 nonce))` for a hand.
     * @dev FR-6.1 step 1. Reverts when a commitment already exists for `handId` (FR-10.4 replay
     *      protection: one commitment per hand) and records `commitBlock` so the anchor block
     *      `commitBlock + 1` and the reveal window are fixed by consensus.
     * @param handId Commitment-derived hand identifier shared with `Poker.sol`.
     * @param commitment The commitment hash.
     * @param nonce Per-hand monotonic nonce that makes seed reuse across hands impossible.
     */
    function commit(bytes32 handId, bytes32 commitment, uint256 nonce) external onlyRole(OPERATOR_ROLE) {
        if (handId == bytes32(0)) revert UnknownHand(handId);
        Commitment storage record = _commitments[handId];
        if (record.state != State.None) revert CommitmentExists(handId);

        record.commitment = commitment;
        record.nonce = nonce;
        record.commitBlock = uint64(block.number);
        record.state = State.Committed;

        emit Committed(handId, commitment, nonce, block.number);
    }

    /**
     * @notice Reveal `deckSeed` inside the window and derive/store the shuffled deck on-chain.
     * @dev FR-6.1 steps 3â€“5, FR-6.2, FR-6.5, NFR-6. The anchor hash `blockhash(commitBlock + 1)`
     *      is read once and written to storage so the entropy stays recomputable forever.
     * @param handId Commitment-derived hand identifier.
     * @param deckSeed The seed committed in `commit`.
     */
    function reveal(bytes32 handId, bytes32 deckSeed) external onlyRole(OPERATOR_ROLE) {
        Commitment storage record = _commitments[handId];
        if (record.state == State.None) revert UnknownHand(handId);
        if (record.state != State.Committed) revert HandNotPending(handId);

        uint256 commitBlock = record.commitBlock;
        uint256 anchorBlock = commitBlock + 1;

        // FR-6.1: strictly after the commit block, never past the 256-block blockhash window.
        if (block.number <= commitBlock || block.number > commitBlock + REVEAL_WINDOW_BLOCKS) {
            revert OutsideRevealWindow(commitBlock, block.number);
        }
        // FR-6.5 / NFR-6: K confirmations of the anchor block before the seed is published.
        uint256 earliestRevealBlock = anchorBlock + requiredConfirmations;
        if (block.number < earliestRevealBlock) {
            revert InsufficientConfirmations(block.number, earliestRevealBlock);
        }

        // Capture the anchor hash the first time it is readable (FR-6.2). It can only be zero
        // past the 256-block window, which the check above already rejects.
        bytes32 anchorBlockHash = blockhash(anchorBlock);
        if (anchorBlockHash == bytes32(0)) revert OutsideRevealWindow(commitBlock, block.number);
        record.anchorBlockHash = anchorBlockHash;

        if (keccak256(abi.encodePacked(deckSeed, record.nonce)) != record.commitment) {
            revert CommitmentMismatch();
        }

        bytes32 entropy = entropyOf(deckSeed, anchorBlockHash);
        (uint8[52] memory deck,) = _computeDeck(entropy);

        record.entropy = entropy;
        record.revealBlock = uint64(block.number);
        record.state = State.Revealed;
        _decks[handId] = deck;

        emit Revealed(
            handId,
            record.commitment,
            deckSeed,
            record.nonce,
            commitBlock,
            anchorBlock,
            anchorBlockHash,
            entropy,
            block.number,
            deck
        );
    }

    /**
     * @notice Void a hand whose reveal window expired without a reveal (FR-6.6).
     * @dev Permissionless by design: the liveness guarantee must not depend on the operator.
     *      `Poker.sol` reads `stateOf` to restore every seat's escrow.
     * @param handId Commitment-derived hand identifier.
     */
    function void(bytes32 handId) external {
        Commitment storage record = _commitments[handId];
        if (record.state == State.None) revert UnknownHand(handId);
        if (record.state != State.Committed) revert HandNotPending(handId);

        uint256 voidableFromBlock = uint256(record.commitBlock) + REVEAL_WINDOW_BLOCKS + 1;
        if (block.number < voidableFromBlock) {
            revert RevealWindowOpen(record.commitBlock, voidableFromBlock);
        }

        record.state = State.Voided;
        emit Voided(handId, record.commitBlock, block.number);
    }

    /**
     * @notice Shuffled deck for `handId` in deal order (all zero before reveal).
     * @dev FR-6.3: the ordering is public on-chain so any verifier can recompute it.
     */
    function deckOf(bytes32 handId) external view returns (uint8[52] memory) {
        return _decks[handId];
    }

    /**
     * @notice Shuffled deck derived from `entropy`, plus the keccak words the draw stream used.
     * @dev FR-6.3, NFR-4: pure so anyone can call it without trusting the contract's storage.
     *      `wordsConsumed` is the observable trace pinned by
     *      `packages/shared/vectors/rng-vectors.json`.
     * @param entropy `keccak256(abi.encodePacked(bytes32 deckSeed, bytes32 anchorBlockHash))`.
     * @return deck The Fisherâ€“Yates ordering of the canonical deck `[0..51]`.
     * @return wordsConsumed Number of `keccak256` stream words hashed (>= 13 for a full shuffle).
     */
    function computeDeckWithCost(bytes32 entropy) external pure returns (uint8[52] memory deck, uint256 wordsConsumed) {
        return _computeDeck(entropy);
    }

    /**
     * @notice Shuffled deck derived from `entropy`.
     * @dev FR-6.3: canonical implementation of `docs/RNG.md` Â§3.
     * @param entropy `keccak256(abi.encodePacked(bytes32 deckSeed, bytes32 anchorBlockHash))`.
     */
    function computeDeck(bytes32 entropy) external pure returns (uint8[52] memory) {
        (uint8[52] memory deck,) = _computeDeck(entropy);
        return deck;
    }

    /**
     * @notice Canonical `entropy = keccak256(abi.encodePacked(bytes32 deckSeed, bytes32 anchorBlockHash))`.
     * @dev FR-6.1 step 4, `docs/RNG.md` Â§2.
     */
    function entropyOf(bytes32 deckSeed, bytes32 anchorBlockHash) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(deckSeed, anchorBlockHash));
    }

    /**
     * @notice Commitment hash for a `(deckSeed, nonce)` pair.
     * @dev FR-6.1 step 1 convenience for operators and verifiers.
     */
    function commitmentOfSeed(bytes32 deckSeed, uint256 nonce) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(deckSeed, nonce));
    }

    /**
     * @notice The anchor block for a committed hand (`commitBlock + 1`).
     * @dev FR-6.2: exposed so verifiers can check step 2 of `docs/RNG.md` Â§5.
     */
    function anchorBlockOf(bytes32 handId) external view returns (uint256) {
        uint256 commitBlock = _commitments[handId].commitBlock;
        if (commitBlock == 0) return 0;
        return commitBlock + 1;
    }

    /// @notice Earliest block at which `handId` may be revealed (FR-6.5).
    function earliestRevealBlockOf(bytes32 handId) external view returns (uint256) {
        Commitment storage record = _commitments[handId];
        if (record.state == State.None) return 0;
        return uint256(record.commitBlock) + 1 + requiredConfirmations;
    }

    /// @notice Earliest block at which `handId` becomes voidable (FR-6.6).
    function voidableFromBlockOf(bytes32 handId) external view returns (uint256) {
        Commitment storage record = _commitments[handId];
        if (record.state == State.None) return 0;
        return uint256(record.commitBlock) + REVEAL_WINDOW_BLOCKS + 1;
    }

    /// @notice True when `handId` was revealed and not subsequently voided (FR-6.3).
    function isRevealed(bytes32 handId) external view returns (bool) {
        return _commitments[handId].state == State.Revealed;
    }

    /// @notice Raw commitment record for `handId` (verifier convenience).
    function commitmentOf(bytes32 handId) external view returns (bytes32) {
        return _commitments[handId].commitment;
    }

    /// @notice Lifecycle state of `handId`.
    function stateOf(bytes32 handId) external view returns (State) {
        return _commitments[handId].state;
    }

    /// @notice Stored anchor hash for `handId` (zero before reveal) (FR-6.2).
    function anchorBlockHashOf(bytes32 handId) external view returns (bytes32) {
        return _commitments[handId].anchorBlockHash;
    }

    /// @notice Stored entropy for `handId` (zero before reveal).
    function entropyOf(bytes32 handId) external view returns (bytes32) {
        return _commitments[handId].entropy;
    }

    /// @notice Block in which `handId` was committed, or 0 when unknown.
    function commitBlockOf(bytes32 handId) external view returns (uint256) {
        return _commitments[handId].commitBlock;
    }

    /// @notice Block in which `handId` was revealed, or 0 when still pending/voided.
    function revealBlockOf(bytes32 handId) external view returns (uint256) {
        return _commitments[handId].revealBlock;
    }

    /// @notice Nonce committed for `handId`.
    function nonceOf(bytes32 handId) external view returns (uint256) {
        return _commitments[handId].nonce;
    }

    /**
     * @notice Update the anchor finality threshold.
     * @dev FR-6.5 / FR-9.7: bounded so `earliestRevealBlock` can never exceed the 256-block
     *      reveal window (which would make every hand un-revealable).
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
     * @dev `docs/RNG.md` Â§3, implemented verbatim.
     *
     *      `word(k) = keccak256(abi.encodePacked(bytes32 entropy, uint256 k))`, read as four
     *      big-endian `uint64` draws at byte offsets 0, 8, 16, 24. Rejected draws (those
     *      `>= floor(2^64 / range) * range`) consume stream positions, which is exactly why
     *      `wordsConsumed` is part of the committed vectors.
     */
    function _computeDeck(bytes32 entropy) internal pure returns (uint8[52] memory deck, uint256 wordsConsumed) {
        for (uint256 i = 0; i < 52; ++i) {
            deck[i] = uint8(i);
        }

        uint256 wordIndex = 0;
        uint256 drawInWord = 4; // forces a fresh word on the first draw
        bytes32 word = bytes32(0);

        // i = 51 down to 1; `i == 0` needs no draw.
        for (uint256 i = 51; i >= 1; --i) {
            uint256 range = i + 1;
            uint256 limit = (type(uint256).max / range) * range;

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
                uint256 shift = 192 - (drawInWord * 64);
                d = uint256(word) >> shift;
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
