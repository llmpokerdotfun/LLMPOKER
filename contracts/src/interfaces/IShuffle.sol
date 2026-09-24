// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IShuffle
 * @notice Read surface of `Shuffle.sol` consumed by `Poker.sol` (SRS §6, FR-6).
 */
interface IShuffle {
    /// @notice Lifecycle of one verifiable-RNG hand (FR-6.1).
    enum State {
        None,
        Committed,
        Revealed,
        Voided
    }

    /// @notice Emitted when the operator publishes a commitment (FR-6.1 step 1).
    /// @param handId Commitment key, also the hand identifier used by `Poker.sol`.
    /// @param commitment `keccak256(abi.encodePacked(bytes32 deckSeed, uint256 nonce))`.
    /// @param nonce Per-hand monotonic nonce.
    /// @param commitBlock Block `N` in which the commitment landed.
    event Committed(bytes32 indexed handId, bytes32 commitment, uint256 nonce, uint256 commitBlock);

    /// @notice Emitted when the operator reveals the seed and the deck is derived (FR-6.1).
    /// @param handId Commitment key.
    /// @param commitment The original commitment.
    /// @param deckSeed The revealed seed.
    /// @param nonce The committed nonce.
    /// @param commitBlock Block `N`.
    /// @param anchorBlock Always `commitBlock + 1`.
    /// @param anchorBlockHash `blockhash(anchorBlock)`, captured into storage (FR-6.2).
    /// @param entropy `keccak256(abi.encodePacked(bytes32 deckSeed, bytes32 anchorBlockHash))`.
    /// @param revealBlock Block `M`, `N < M <= N + 256`.
    /// @param deck The shuffled 52-card ordering, index 0 = first card dealt.
    event Revealed(
        bytes32 indexed handId,
        bytes32 commitment,
        bytes32 deckSeed,
        uint256 nonce,
        uint256 commitBlock,
        uint256 anchorBlock,
        bytes32 anchorBlockHash,
        bytes32 entropy,
        uint256 revealBlock,
        uint8[52] deck
    );

    /// @notice Emitted when a hand voids because the reveal window expired (FR-6.6).
    event Voided(bytes32 indexed handId, uint256 commitBlock, uint256 voidedAtBlock);

    /// @notice Commitment stored for `handId`.
    function commitmentOf(bytes32 handId) external view returns (bytes32);

    /// @notice Lifecycle state of `handId`.
    function stateOf(bytes32 handId) external view returns (State);

    /// @notice Stored anchor hash for `handId` (zero before reveal) (FR-6.2).
    function anchorBlockHashOf(bytes32 handId) external view returns (bytes32);

    /// @notice Stored entropy for `handId` (zero before reveal).
    function entropyOf(bytes32 handId) external view returns (bytes32);

    /// @notice Shuffled deck for `handId` (all zero before reveal).
    function deckOf(bytes32 handId) external view returns (uint8[52] memory);

    /// @notice True when a reveal happened and no void has been recorded.
    function isRevealed(bytes32 handId) external view returns (bool);

    /// @notice Earliest block at which `handId` becomes voidable (FR-6.6).
    function voidableFromBlockOf(bytes32 handId) external view returns (uint256);
}
