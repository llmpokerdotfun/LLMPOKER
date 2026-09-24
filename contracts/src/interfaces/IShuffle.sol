// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IShuffle
 * @notice Read surface of `Shuffle.sol` consumed by `Poker.sol` (SRS §6, FR-6).
 *
 * @dev FR-6 as patched: "the seed and full deck ordering MUST NEVER be published on-chain while a
 *      hand is live. Only *commitments* are public during play." So this interface exposes the
 *      commitment phases and the *revealed* cards, never the hidden deck ordering.
 */
interface IShuffle {
    /// @notice Lifecycle of one verifiable-RNG hand (FR-6.1–6.4).
    enum Phase {
        None,
        /// @notice FR-6.1 phase 1: seed commitment recorded, seed still secret.
        SeedCommitted,
        /// @notice FR-6.2 phase 2: Merkle deck root recorded, ordering still secret.
        DeckCommitted,
        /// @notice FR-6.4 phase 4: seed + all salts audited against the deck root.
        Audited,
        /// @notice FR-6.7: hand voided, bond slashed, escrow refunded by `Poker.sol`.
        Voided
    }

    /// @notice Reason a hand was voided, surfaced in the `Voided` event.
    enum VoidReason {
        /// @notice No deck root was committed inside the reveal window (FR-6.7).
        NoDeckCommitment,
        /// @notice A deck root was committed but the seed/salt audit never happened (FR-6.7).
        AuditStalled
    }

    /// @notice FR-6.1 phase 1: the operator committed `keccak256(seed ‖ nonce)`; the seed is secret.
    event SeedCommitted(bytes32 indexed handId, bytes32 seedCommitment, uint256 nonce, uint256 commitBlock);

    /**
     * @notice FR-6.2 phase 2: the operator committed the Merkle root of the salted deck.
     * @dev The event carries **only** the root and the anchor hash. Neither the seed nor any card
     *      ordering is disclosed, which is what keeps unrevealed cards hidden (FR-6.8).
     * @param handId Hand identifier.
     * @param deckRoot `MerkleRoot(keccak256(card_i ‖ salt_i) for i in 1..52)`.
     * @param commitBlock Block `N` of the phase-1 commitment.
     * @param deckRootBlock Block `M` at which the root was published.
     * @param anchorBlock Always `commitBlock + 1` (FR-6.9).
     * @param anchorBlockHash `blockhash(anchorBlock)`, captured into storage (FR-6.9).
     * @param confirmations `deckRootBlock - anchorBlock` (FR-6.5).
     */
    event DeckCommitted(
        bytes32 indexed handId,
        bytes32 deckRoot,
        uint256 commitBlock,
        uint256 deckRootBlock,
        uint256 anchorBlock,
        bytes32 anchorBlockHash,
        uint256 confirmations
    );

    /**
     * @notice FR-6.3: one card became public because the game rules require it.
     * @param handId Hand identifier.
     * @param deckIndex Position in the shuffled deck, `0..51`.
     * @param card `rank * 4 + suit` for the card at that position.
     * @param leaf `keccak256(abi.encodePacked(uint8 card, bytes32 salt))`.
     * @param revealedBlock Block of the reveal.
     * @param revealedBy The operator that published it.
     */
    event CardRevealed(
        bytes32 indexed handId,
        uint8 indexed deckIndex,
        uint8 card,
        bytes32 leaf,
        uint256 revealedBlock,
        address revealedBy
    );

    /**
     * @notice FR-6.4: end-of-hand audit succeeded — the commitment is now fully proven.
     * @dev Emitting the seed and the whole deck is safe here because the hand is over; it is what
     *      makes the proof permanently verifiable (FR-6.4, NFR-4).
     * @param handId Hand identifier.
     * @param deckSeed The revealed seed.
     * @param entropy `keccak256(seed ‖ anchorBlockHash)`.
     * @param deckRoot The root that was committed at phase 2 (re-confirmed).
     * @param deck The recomputed deck ordering, published for verifiers.
     * @param auditBlock Block of the audit.
     */
    event Audited(
        bytes32 indexed handId,
        bytes32 deckSeed,
        bytes32 entropy,
        bytes32 deckRoot,
        uint8[52] deck,
        uint256 auditBlock
    );

    /**
     * @notice FR-6.4/FR-6.5: audit failed — the published deck root does not match `(seed, anchor)`.
     * @param handId Hand identifier.
     * @param committedRoot The root the operator published at phase 2.
     * @param expectedRoot The root derived from the revealed seed + anchor hash.
     * @param slashed Amount of bond slashed.
     */
    event AuditFailed(bytes32 indexed handId, bytes32 committedRoot, bytes32 expectedRoot, uint256 slashed);

    /**
     * @notice FR-6.7: hand voided and bond slashed (liveness).
     * @param handId Hand identifier.
     * @param reason Why it voided.
     * @param slashed Amount of bond slashed.
     * @param voidedBlock Block of the void.
     */
    event Voided(bytes32 indexed handId, VoidReason reason, uint256 slashed, uint256 voidedBlock);

    /// @notice Bond posted or topped up.
    event BondPosted(address indexed operator, uint256 amount, uint256 bond);
    /// @notice Slashed bond proceeds swept to a recipient.
    event BondSlashed(bytes32 indexed handId, uint256 amount, uint256 pool);
    /// @notice Slashed bond proceeds swept to a recipient.
    event SlashedBondSwept(address indexed to, uint256 amount);

    /// @notice FR-6.1: `keccak256(abi.encodePacked(bytes32 seed, uint256 nonce))`.
    function seedCommitmentOf(bytes32 handId) external view returns (bytes32);

    /// @notice FR-6.2: the committed Merkle deck root (zero before phase 2).
    function deckRootOf(bytes32 handId) external view returns (bytes32);

    /// @notice Lifecycle phase of `handId`.
    function phaseOf(bytes32 handId) external view returns (Phase);

    /// @notice Stored anchor hash for `handId` (zero before phase 2) (FR-6.9).
    function anchorBlockHashOf(bytes32 handId) external view returns (bytes32);

    /// @notice The card published at `deckIndex`, or `type(uint8).max` when still hidden (FR-6.3).
    function revealedCardAt(bytes32 handId, uint8 deckIndex) external view returns (uint8);

    /// @notice True when every one of the 52 positions has been published.
    function isFullyRevealed(bytes32 handId) external view returns (bool);

    /// @notice True when the end-of-hand audit succeeded (FR-6.4).
    function isAudited(bytes32 handId) external view returns (bool);

    /// @notice Phase-1 commitment exists for `handId` (FR-6.1).
    function hasCommitment(bytes32 handId) external view returns (bool);

    /// @notice Deck root committed and not voided — the gate `Poker.sol` uses to settle (FR-6.2).
    function isDeckCommitted(bytes32 handId) external view returns (bool);

    /// @notice Block from which `handId` may be voided for liveness failure (FR-6.7).
    function voidableFromBlockOf(bytes32 handId) external view returns (uint256);

    /**
     * @notice Check one FR-6.3 card reveal against a committed deck root.
     * @dev Exposed so the committed Merkle vectors can be checked on-chain as well as off-chain.
     */
    function verifyCardProof(bytes32 root, uint8 deckIndex, uint8 card, bytes32 salt, bytes32[] calldata proof)
        external
        pure
        returns (bool);
}
