// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IShuffle } from "./interfaces/IShuffle.sol";
import { IRakeSplitter } from "./interfaces/IRakeSplitter.sol";

/**
 * @title Poker
 * @notice On-chain custody, pot accounting and settlement for wager-mode NLHE (SRS Â§6, FR-5,
 *         FR-8, FR-10.3, FR-10.5).
 *
 * @dev **Trust model.** The off-chain engine is the referee of *action legality* (FR-3.6) but is
 *      never the custodian of money (FR-5.3, `docs/ARCHITECTURE.md` hard rule 6): every token
 *      sits in this contract's escrow, keyed by `(tableId, seat)`, and can only leave through
 *      `cashOut` (owner-signed), `settleHand` (operator, and only against the recorded seat
 *      contributions that sum exactly to the pot), or `voidHand` (permissionless, only after
 *      `Shuffle` records a void). The engine can therefore misreport *who won* â€” which is why
 *      the deck is verifiable â€” but it can never move a token it was not authorized for.
 *
 *      **What the contract does not do.** It does not evaluate poker hands, does not run the
 *      game loop and does not accept per-action bets: hole cards and board are recomputable
 *      from `Shuffle.sol` (FR-6.3) but hand evaluation is deliberately off-chain, so settlement
 *      takes winners and awards as calldata and *verifies the only things it can verify
 *      on-chain* â€” that contributions sum to the pot, that awards sum to pot minus the
 *      contract-computed rake, that the seats exist, and that the hand was opened against a
 *      revealed shuffle for which every participant actually moved chips.
 */
contract Poker is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Maximum seats at a wager table (6-max, SRS Â§1).
    uint8 public constant MAX_SEATS = 6;

    /// @notice Hard cap on any table's rake (10%, FR-8.1 / `validateTableConfig`).
    uint256 public constant MAX_RAKE_BPS = 1_000;

    /// @notice Rake denominator shared with `packages/shared/src/config.ts`.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /**
     * @notice Whether rake is charged only when a flop was dealt.
     * @dev SRS Â§11 Q2 leaves the rake policy open; `computeRake` in
     *      `packages/shared/src/config.ts` is called with `rakeOnlyWithFlop: true` by
     *      `defaultWagerTableConfig`, so `true` is the shipped convention and it is exposed
     *      on-chain (rather than hidden in an argument) so the policy is auditable.
     */
    bool public constant DEFAULT_RAKE_ONLY_WITH_FLOP = true;

    /// @notice Lifecycle of one on-chain hand (FR-5.2).
    enum HandStatus {
        None,
        Open,
        Settled,
        Voided
    }

    /// @notice Wager-table configuration (FR-5.1, FR-8.1).
    struct TableConfig {
        uint256 smallBlind;
        uint256 bigBlind;
        uint256 minBuyIn;
        uint256 maxBuyIn;
        uint16 rakeBps;
        uint256 rakeCap;
        uint8 maxSeats;
    }

    struct Table {
        TableConfig config;
        uint256 seatCount;
        uint256 pendingHands;
        bool exists;
    }

    struct Hand {
        HandStatus status;
        uint8 seatCount;
        uint256 contributorCount;
        uint256 pot;
        uint8[6] participants;
    }

    /// @notice Stake token escrowed by this contract (FR-5.1).
    IERC20 public immutable token;

    /// @notice Verifiable-RNG contract that gates every hand (FR-6).
    IShuffle public immutable shuffle;

    /// @notice Rake recipient (FR-8.2).
    IRakeSplitter public immutable rakeSplitter;

    /// @notice Off-chain engine allowed to run tables and settle hands (FR-10.3).
    address public operator;

    /// @dev `tableId => table`.
    mapping(bytes32 => Table) private _tables;

    /// @dev `keccak256(tableId, seat) => player address`.
    mapping(bytes32 => address) public seatOwner;

    /// @dev `keccak256(tableId, seat) => escrowed balance` (FR-5.1, FR-5.5).
    mapping(bytes32 => uint256) public escrowOf;

    /// @dev `keccak256(tableId, seat) => hand the seat is currently committed to`.
    mapping(bytes32 => bytes32) public pendingHandOf;

    /// @dev `tableId => handId => hand`.
    mapping(bytes32 => mapping(bytes32 => Hand)) private _hands;

    /// @dev `tableId => handId => seat => chips moved into the pot for that hand` (FR-5.2).
    mapping(bytes32 => mapping(bytes32 => mapping(uint8 => uint256))) public contributionOf;

    /// @notice Emitted when a wager table is created (FR-5.1).
    event TableCreated(bytes32 indexed tableId, TableConfig config, address operator);
    /// @notice Emitted when the operator is rotated (FR-10.3).
    event OperatorUpdated(address indexed previous, address indexed current);
    /// @notice Emitted on every escrow deposit (FR-5.1).
    event Deposited(bytes32 indexed tableId, uint8 indexed seat, address indexed player, uint256 amount, uint256 balance);
    /// @notice Emitted on every escrow withdrawal (FR-5.5).
    event CashedOut(bytes32 indexed tableId, uint8 indexed seat, address indexed player, uint256 amount);
    /// @notice Emitted when a seat joins a table (FR-5.1).
    event SeatTaken(bytes32 indexed tableId, uint8 indexed seat, address indexed player);
    /// @notice Emitted when a seat leaves a table (FR-5.5).
    event SeatReleased(bytes32 indexed tableId, uint8 indexed seat, address indexed player);
    /// @notice Emitted when the operator opens a hand against a shuffle commitment (FR-5.2).
    event HandOpened(bytes32 indexed tableId, bytes32 indexed handId, uint8 seatCount, uint256 openedAtBlock);
    /// @notice Emitted for every seat-by-seat pot contribution (FR-5.2).
    event HandCommitted(bytes32 indexed tableId, bytes32 indexed handId, uint8 indexed seat, uint256 amount, uint256 pot);
    /// @notice Emitted at settlement with the full pot/rake/award breakdown (FR-5.2, FR-8.2).
    event HandSettled(
        bytes32 indexed tableId,
        bytes32 indexed handId,
        uint256 pot,
        uint256 rake,
        uint256 sawFlop,
        uint8[] winners,
        uint256[] awards
    );
    /// @notice Emitted when a hand is voided and escrow restored (FR-5.6, FR-6.6).
    event HandVoided(bytes32 indexed tableId, bytes32 indexed handId, uint256 restored, bytes32 reason);

    /// @notice Caller lacks `OPERATOR` authority (FR-10.3).
    error NotOperator(address caller);
    /// @notice The operator may not seat at the tables it runs (FR-10.3).
    error OperatorCannotSeat(address operator);
    /// @notice Unknown table.
    error UnknownTable(bytes32 tableId);
    /// @notice Table already exists.
    error TableExists(bytes32 tableId);
    /// @notice Seat or table configuration outside bounds.
    error InvalidSeat(uint256 seat, uint256 maxSeats);
    /// @notice Blind/buy-in/rake configuration rejected (FR-8.1).
    error InvalidTableConfig(string reason);
    /// @notice Deposit outside `[minBuyIn, maxBuyIn]` (FR-5.1).
    error BuyInOutOfRange(uint256 resultingBalance, uint256 minBuyIn, uint256 maxBuyIn);
    /// @notice Seat is already occupied by a different player.
    error SeatOccupied(uint8 seat, address occupant);
    /// @notice The caller holds no position at this table.
    error NoPosition(bytes32 tableId, address player);
    /// @notice Escrow is locked by an open hand (FR-5.5).
    error HandPending(bytes32 handId);
    /// @notice Unknown hand.
    error UnknownHand(bytes32 tableId, bytes32 handId);
    /// @notice Hand is not in `Open` state.
    error HandNotOpen(bytes32 handId, HandStatus status);
    /// @notice `settleHand` while paused (FR-10.5).
    error SettlementPaused();
    /// @notice The hand's shuffle was never revealed on-chain (FR-6).
    error ShuffleNotRevealed(bytes32 handId);
    /// @notice The hand's shuffle voided, so it can only be voided here (FR-6.6).
    error ShuffleVoided(bytes32 handId);
    /// @notice The hand's shuffle is still pending, so it cannot be voided yet.
    error ShuffleStillPending(bytes32 handId);
    /// @notice Per-seat contributions do not sum to the declared pot (FR-5.2).
    error ContributionMismatch(uint256 declaredPot, uint256 summedContributions);
    /// @notice A seat's contribution exceeds its escrowed balance.
    error ContributionExceedsEscrow(uint8 seat, uint256 amount, uint256 escrow);
    /// @notice Awards do not sum to `pot - rake`.
    error AwardsMismatch(uint256 expected, uint256 actual);
    /// @notice A zero-address argument was supplied.
    error ZeroAddress();

    /**
     * @param token_ Stake token (the platform ERC-20).
     * @param shuffle_ Verifiable-RNG contract (FR-6).
     * @param rakeSplitter_ Rake recipient (FR-8.2).
     * @param initialOwner Owner: table creation authority, pause authority, operator rotation.
     * @param initialOperator Off-chain engine address (FR-10.3).
     */
    constructor(IERC20 token_, IShuffle shuffle_, IRakeSplitter rakeSplitter_, address initialOwner, address initialOperator)
        Ownable(initialOwner)
    {
        if (
            address(token_) == address(0) || address(shuffle_) == address(0) || address(rakeSplitter_) == address(0)
                || initialOwner == address(0) || initialOperator == address(0)
        ) {
            revert ZeroAddress();
        }
        token = IERC20(token_);
        shuffle = IShuffle(shuffle_);
        rakeSplitter = IRakeSplitter(rakeSplitter_);
        operator = initialOperator;
    }

    // ---------------------------------------------------------------------
    // Table administration
    // ---------------------------------------------------------------------

    /**
     * @notice Create a wager table.
     * @dev FR-5.1, FR-8.1, FR-10.3. Only the owner may create wager tables, and the same
     *      address can never deposit at one (see `deposit`), which is what makes "the
     *      operator cannot seat at its own tables" enforceable on-chain.
     * @param tableId Off-chain-stable table identifier.
     * @param config Blinds, buy-in bounds, rake schedule and seat count.
     */
    function createTable(bytes32 tableId, TableConfig calldata config) external onlyOwner {
        if (tableId == bytes32(0)) revert ZeroAddress();
        if (_tables[tableId].exists) revert TableExists(tableId);
        _validateTableConfig(config);

        _tables[tableId].config = config;
        _tables[tableId].exists = true;

        emit TableCreated(tableId, config, operator);
    }

    /**
     * @notice Rotate the operator key.
     * @dev FR-10.3. A rotated operator inherits the seating prohibition automatically.
     */
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        address previous = operator;
        operator = newOperator;
        emit OperatorUpdated(previous, newOperator);
    }

    // ---------------------------------------------------------------------
    // Escrow lifecycle (FR-5.1, FR-5.5, FR-10.5)
    // ---------------------------------------------------------------------

    /**
     * @notice Take `seat` at `tableId` with `amount` token, held in escrow by this contract.
     * @dev FR-5.1, FR-5.3, FR-10.3. Top-ups are allowed and the *resulting* balance must stay
     *      within `[minBuyIn, maxBuyIn]`, so the buy-in range is enforced across deposits.
     *      Deliberately blocked while paused: money must not enter escrow while settlement is
     *      halted (FR-10.5 halts wager flow, and `cashOut` stays open regardless).
     * @param tableId Table identifier.
     * @param seat Seat index, `0..maxSeats-1`.
     * @param amount Token amount to deposit.
     */
    function deposit(bytes32 tableId, uint8 seat, uint256 amount) external nonReentrant whenNotPaused {
        Table storage table = _tables[tableId];
        if (!table.exists) revert UnknownTable(tableId);
        if (seat >= table.config.maxSeats) revert InvalidSeat(seat, table.config.maxSeats);
        if (msg.sender == operator) revert OperatorCannotSeat(operator);
        if (amount == 0) revert BuyInOutOfRange(0, table.config.minBuyIn, table.config.maxBuyIn);

        bytes32 key = _seatKey(tableId, seat);
        address occupant = seatOwner[key];
        if (occupant == address(0)) {
            seatOwner[key] = msg.sender;
            table.seatCount += 1;
            emit SeatTaken(tableId, seat, msg.sender);
        } else if (occupant != msg.sender) {
            revert SeatOccupied(seat, occupant);
        }

        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 balance = escrowOf[key] + amount;
        if (balance < table.config.minBuyIn || balance > table.config.maxBuyIn) {
            revert BuyInOutOfRange(balance, table.config.minBuyIn, table.config.maxBuyIn);
        }
        escrowOf[key] = balance;

        emit Deposited(tableId, seat, msg.sender, amount, balance);
    }

    /**
     * @notice Withdraw the escrowed balance for a seat and give the seat up.
     * @dev FR-5.5, FR-10.5. **Never gated by `whenNotPaused`**: pausing halts wager settlement
     *      and must never trap already-settled escrow. Reverts only while a hand this seat has
     *      contributed to is still open.
     * @param tableId Table identifier.
     * @param seat Seat index owned by the caller.
     */
    function cashOut(bytes32 tableId, uint8 seat) external nonReentrant {
        Table storage table = _tables[tableId];
        if (!table.exists) revert UnknownTable(tableId);
        if (seat >= table.config.maxSeats) revert InvalidSeat(seat, table.config.maxSeats);

        bytes32 key = _seatKey(tableId, seat);
        if (seatOwner[key] != msg.sender) revert NoPosition(tableId, msg.sender);

        bytes32 handId = pendingHandOf[key];
        if (handId != bytes32(0) && _hands[tableId][handId].status == HandStatus.Open) {
            revert HandPending(handId);
        }

        uint256 amount = escrowOf[key];
        if (amount == 0) revert NoPosition(tableId, msg.sender);

        escrowOf[key] = 0;
        seatOwner[key] = address(0);
        pendingHandOf[key] = bytes32(0);
        if (table.seatCount != 0) {
            table.seatCount -= 1;
        }

        token.safeTransfer(msg.sender, amount);

        emit CashedOut(tableId, seat, msg.sender, amount);
        emit SeatReleased(tableId, seat, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Hand lifecycle (FR-5.2, FR-5.6, FR-8)
    // ---------------------------------------------------------------------

    /**
     * @notice Open a hand against a shuffle commitment that is already on-chain.
     * @dev FR-5.2, FR-6. The commitment must exist *before* the hand opens, which is what binds
     *      the deck before any chips move (FR-6.4). The seat list is the dealing order.
     * @param tableId Table identifier.
     * @param handId Commitment key produced by `Shuffle.commit`.
     * @param seats Seated players participating, in dealing order.
     */
    function openHand(bytes32 tableId, bytes32 handId, uint8[] calldata seats) external onlyOperator {
        Table storage table = _tables[tableId];
        if (!table.exists) revert UnknownTable(tableId);
        if (handId == bytes32(0)) revert ZeroAddress();
        if (seats.length < 2 || seats.length > table.config.maxSeats) {
            revert InvalidSeat(seats.length, table.config.maxSeats);
        }
        if (shuffle.commitmentOf(handId) == bytes32(0)) revert ShuffleNotRevealed(handId);

        Hand storage hand = _hands[tableId][handId];
        if (hand.status != HandStatus.None) revert HandNotOpen(handId, hand.status);

        hand.status = HandStatus.Open;
        hand.seatCount = uint8(seats.length);

        for (uint256 i = 0; i < seats.length; ++i) {
            uint8 seat = seats[i];
            if (seat >= table.config.maxSeats) revert InvalidSeat(seat, table.config.maxSeats);
            bytes32 key = _seatKey(tableId, seat);
            if (seatOwner[key] == address(0)) revert NoPosition(tableId, seatOwner[key]);

            // A seat listed twice would double-commit and double-count at settlement.
            bytes32 other = pendingHandOf[key];
            if (other != bytes32(0)) revert HandPending(other);

            hand.participants[i] = seat;
            pendingHandOf[key] = handId;
        }
        table.pendingHands += 1;

        emit HandOpened(tableId, handId, uint8(seats.length), block.number);
    }

    /**
     * @notice Record the chips one seat moved into the current pot.
     * @dev FR-5.2. Contributions are bounded by escrow at settlement time, so a seat can never
     *      promise more than it holds.
     * @param tableId Table identifier.
     * @param handId Open hand.
     * @param seat Contributing seat.
     * @param amount Chips moved into the pot.
     */
    function commitHand(bytes32 tableId, bytes32 handId, uint8 seat, uint256 amount) external onlyOperator {
        Table storage table = _tables[tableId];
        if (!table.exists) revert UnknownTable(tableId);
        if (seat >= table.config.maxSeats) revert InvalidSeat(seat, table.config.maxSeats);

        Hand storage hand = _hands[tableId][handId];
        if (hand.status != HandStatus.Open) revert HandNotOpen(handId, hand.status);
        if (amount == 0) revert ContributionMismatch(0, 0);
        if (pendingHandOf[_seatKey(tableId, seat)] != handId) revert NoPosition(tableId, seatOwner[_seatKey(tableId, seat)]);

        _hands[tableId][handId].pot += amount;
        contributionOf[tableId][handId][seat] += amount;

        emit HandCommitted(tableId, handId, seat, amount, _hands[tableId][handId].pot);
    }

    /**
     * @notice Settle a hand: verify the pot, deduct the on-chain rake and credit the winners.
     * @dev FR-5.2, FR-5.4, FR-8.1, FR-8.2, FR-10.5.
     *
     *      `contributions[i]` must be seat-aligned with the seat list passed to
     *      `openHand` (`contributions[i]` belongs to `participants[i]`) and must equal the
     *      amount already recorded by `commitHand`; extra trailing zero entries are
     *      tolerated so callers can pass a fixed-size array. Verified on-chain: seat
     *      membership, per-seat contribution bounds against escrow, `sum(contributions) == pot`,
     *      `sum(awards) == pot - rake`, and the rake itself. Not verified (and not verifiable)
     *      on-chain: who won the pot, and the hole-card/board mapping â€” the latter is
     *      recomputable from `Shuffle.sol` (FR-6.3).
     * @param tableId Table identifier.
     * @param handId Open hand.
     * @param contributions Seat-by-seat chips moved into the pot.
     * @param winners Seats receiving an award (a seat may appear at most once).
     * @param awards Awards matching `winners` index-for-index.
     * @param sawFlop Whether a flop was dealt; gates the rake when `DEFAULT_RAKE_ONLY_WITH_FLOP`.
     */
    function settleHand(
        bytes32 tableId,
        bytes32 handId,
        uint256[] calldata contributions,
        uint8[] calldata winners,
        uint256[] calldata awards,
        bool sawFlop
    ) external onlyOperator nonReentrant whenNotPaused {
        Table storage table = _tables[tableId];
        if (!table.exists) revert UnknownTable(tableId);

        Hand storage hand = _hands[tableId][handId];
        if (hand.status == HandStatus.None) revert UnknownHand(tableId, handId);
        if (hand.status != HandStatus.Open) revert HandNotOpen(handId, hand.status);

        IShuffle.State shuffleState = shuffle.stateOf(handId);
        if (shuffleState == IShuffle.State.Voided) revert ShuffleVoided(handId);
        if (shuffleState != IShuffle.State.Revealed) revert ShuffleNotRevealed(handId);

        uint256 pot = hand.pot;
        if (pot == 0) revert ContributionMismatch(0, 0);

        // (1) On-chain truth: what each seat actually moved.
        _verifyContributions(tableId, handId, hand, contributions, pot);

        // (2) Rake, computed on-chain from the table schedule (FR-8.1).
        uint256 rake =
            computeRake(pot, table.config.rakeBps, table.config.rakeCap, sawFlop, DEFAULT_RAKE_ONLY_WITH_FLOP);

        // (3) Awards must equal the whole post-rake pot.
        uint256 expectedAwards = pot - rake;
        uint256 awardSum = 0;
        for (uint256 i = 0; i < awards.length; ++i) {
            awardSum += awards[i];
        }
        if (awardSum != expectedAwards) revert AwardsMismatch(expectedAwards, awardSum);

        hand.status = HandStatus.Settled;
        table.pendingHands -= 1;

        // (4) Debts first, credits second: no award can be paid out of another seat's escrow.
        _applySettlement(tableId, hand, contributions, winners, awards, table.config.maxSeats);

        // (5) Rake leaves escrow atomically into the splitter (FR-8.2).
        if (rake != 0) {
            token.safeTransfer(address(rakeSplitter), rake);
            rakeSplitter.receiveRake(rake);
        }

        emit HandSettled(tableId, handId, pot, rake, sawFlop ? 1 : 0, winners, awards);
    }

    /**
     * @notice Void a hand and restore every contribution to escrow (FR-5.6, FR-6.6).
     * @dev Permissionless by design: the liveness guarantee must not depend on the operator.
     *      Only reachable once `Shuffle` has actually voided the hand, so it cannot be used to
     *      escape a losing settlement while the shuffle is still pending.
     * @param tableId Table identifier.
     * @param handId Open hand whose shuffle timed out.
     */
    function voidHand(bytes32 tableId, bytes32 handId) external nonReentrant {
        Table storage table = _tables[tableId];
        if (!table.exists) revert UnknownTable(tableId);

        Hand storage hand = _hands[tableId][handId];
        if (hand.status == HandStatus.None) revert UnknownHand(tableId, handId);
        if (hand.status != HandStatus.Open) revert HandNotOpen(handId, hand.status);

        IShuffle.State shuffleState = shuffle.stateOf(handId);
        if (shuffleState == IShuffle.State.Revealed) revert ShuffleStillPending(handId);
        if (shuffleState != IShuffle.State.Voided) revert ShuffleStillPending(handId);

        uint256 restored = 0;
        for (uint256 i = 0; i < hand.seatCount; ++i) {
            uint8 seat = hand.participants[i];
            uint256 amount = contributionOf[tableId][handId][seat];
            if (amount == 0) continue;
            escrowOf[_seatKey(tableId, seat)] += amount;
            contributionOf[tableId][handId][seat] = 0;
            restored += amount;
        }
        hand.status = HandStatus.Voided;
        table.pendingHands -= 1;

        emit HandVoided(tableId, handId, restored, "SHUFFLE_VOIDED");
    }

    /**
     * @notice Void a hand whose shuffle fell outside the blockhash window.
     * @dev FR-5.6, NFR-6. This is the reorg path: a reorg can orphan the anchor block so that
     *      the operator can no longer reveal inside the window, leaving `Shuffle` permanently
     *      `Committed`. Without this path the participants' chips would be stranded, so the
     *      owner (the same authority that can pause settlement) may restore escrow once the
     *      reveal window has provably expired. It can never settle a hand or move chips
     *      anywhere but back to the seats that contributed them.
     * @param tableId Table identifier.
     * @param handId Open hand whose reveal window expired.
     */
    function voidInvalidAnchor(bytes32 tableId, bytes32 handId) external onlyOwner nonReentrant {
        Table storage table = _tables[tableId];
        if (!table.exists) revert UnknownTable(tableId);

        Hand storage hand = _hands[tableId][handId];
        if (hand.status == HandStatus.None) revert UnknownHand(tableId, handId);
        if (hand.status != HandStatus.Open) revert HandNotOpen(handId, hand.status);

        IShuffle.State shuffleState = shuffle.stateOf(handId);
        if (shuffleState == IShuffle.State.Revealed) revert ShuffleStillPending(handId);
        if (shuffleState == IShuffle.State.Voided) revert ShuffleVoided(handId);

        uint256 voidableFrom = shuffle.voidableFromBlockOf(handId);
        if (block.number < voidableFrom) revert ShuffleStillPending(handId);

        uint256 restored = 0;
        for (uint256 i = 0; i < hand.seatCount; ++i) {
            uint8 seat = hand.participants[i];
            uint256 amount = contributionOf[tableId][handId][seat];
            if (amount == 0) continue;
            escrowOf[_seatKey(tableId, seat)] += amount;
            contributionOf[tableId][handId][seat] = 0;
            restored += amount;
        }
        hand.status = HandStatus.Voided;
        table.pendingHands -= 1;

        emit HandVoided(tableId, handId, restored, "ANCHOR_INVALID");
    }

    /**
     * @notice Halt wager deposits and settlement (FR-10.5).
     * @dev Does **not** gate `cashOut`, and has no effect on free mode, which never touches the
     *      chain (FR-4.1).
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Resume wager deposits and settlement (FR-10.5).
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /**
     * @notice Rake for a pot, mirroring `computeRake` in `packages/shared/src/config.ts`.
     * @dev FR-8.1: `floor(pot * bps / 10000)` capped at `rakeCap`, and zero when the policy
     *      requires a flop and none was dealt. Pure and public so the off-chain engine can price
     *      a pot with exactly the arithmetic settlement will use.
     * @param pot Pot size in base units.
     * @param rakeBps Rake in basis points.
     * @param rakeCap Maximum rake per pot.
     * @param sawFlop Whether a flop was dealt.
     * @param onlyWithFlop Whether the flop-only policy is active.
     */
    function computeRake(uint256 pot, uint256 rakeBps, uint256 rakeCap, bool sawFlop, bool onlyWithFlop)
        public
        pure
        returns (uint256)
    {
        if (rakeBps == 0) return 0;
        if (onlyWithFlop && !sawFlop) return 0;
        uint256 raw = (pot * rakeBps) / BPS_DENOMINATOR;
        return raw > rakeCap ? rakeCap : raw;
    }

    /// @notice Table configuration, reverting for unknown tables.
    function tableConfigOf(bytes32 tableId) external view returns (TableConfig memory) {
        if (!_tables[tableId].exists) revert UnknownTable(tableId);
        return _tables[tableId].config;
    }

    /// @notice Number of occupied seats at a table.
    function seatCountOf(bytes32 tableId) external view returns (uint256) {
        return _tables[tableId].seatCount;
    }

    /// @notice Number of hands currently open at a table.
    function pendingHandsOf(bytes32 tableId) external view returns (uint256) {
        return _tables[tableId].pendingHands;
    }

    /// @notice Escrowed balance of one seat (FR-5.1, FR-5.5).
    function escrowBalanceOf(bytes32 tableId, uint8 seat) external view returns (uint256) {
        return escrowOf[_seatKey(tableId, seat)];
    }

    /// @notice Current holder of one seat, or the zero address.
    function occupantOf(bytes32 tableId, uint8 seat) external view returns (address) {
        return seatOwner[_seatKey(tableId, seat)];
    }

    /// @notice Everything a verifier needs about one hand (FR-6.3, NFR-4).
    function handInfoOf(bytes32 tableId, bytes32 handId)
        external
        view
        returns (HandStatus status, uint256 pot, uint8 seatCount, uint8[6] memory participants)
    {
        Hand storage hand = _hands[tableId][handId];
        return (hand.status, hand.pot, hand.seatCount, hand.participants);
    }

    /**
     * @notice Total escrow this contract owes across every table and seat.
     * @dev NFR-4: `token.balanceOf(this) == totalEscrow + rake in flight` is checkable by any
     *      verifier, which is the strongest statement the contract can make about solvency when
     *      escrow is stored per seat rather than per contract balance.
     */
    function totalEscrowObserved() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator(msg.sender);
        _;
    }

    /**
     * @dev FR-5.2: every non-zero entry of `contributions` must match a seat that actually
     *      committed chips, must be affordable from that seat's escrow, and the entries must sum
     *      to the recorded pot. Split out of `settleHand` to keep the settlement frame within
     *      the EVM stack limit for 6 seats (NFR-3).
     */
    function _verifyContributions(
        bytes32 tableId,
        bytes32 handId,
        Hand storage hand,
        uint256[] calldata contributions,
        uint256 pot
    ) private view {
        uint256 summed = 0;
        for (uint256 i = 0; i < contributions.length; ++i) {
            uint256 amount = contributions[i];
            if (amount == 0) continue;
            if (i >= hand.seatCount) revert ContributionMismatch(pot, summed);
            uint8 seat = hand.participants[i];
            uint256 recorded = contributionOf[tableId][handId][seat];
            if (recorded != amount) revert ContributionMismatch(recorded, amount);
            uint256 balance = escrowOf[_seatKey(tableId, seat)];
            if (amount > balance) revert ContributionExceedsEscrow(seat, amount, balance);
            summed += amount;
        }
        if (summed != pot) revert ContributionMismatch(pot, summed);
    }

    /// @dev FR-5.2: move the committed chips out of escrow, then credit the winners.
    function _applySettlement(
        bytes32 tableId,
        Hand storage hand,
        uint256[] calldata contributions,
        uint8[] calldata winners,
        uint256[] calldata awards,
        uint8 maxSeats
    ) private {
        for (uint256 i = 0; i < contributions.length; ++i) {
            uint256 amount = contributions[i];
            if (amount == 0) continue;
            escrowOf[_seatKey(tableId, hand.participants[i])] -= amount;
        }
        for (uint256 i = 0; i < winners.length; ++i) {
            uint8 seat = winners[i];
            if (seat >= maxSeats) revert InvalidSeat(seat, maxSeats);
            escrowOf[_seatKey(tableId, seat)] += awards[i];
        }
    }

    function _seatKey(bytes32 tableId, uint8 seat) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(tableId, seat));
    }

    function _validateTableConfig(TableConfig calldata config) private pure {
        if (config.smallBlind == 0) revert InvalidTableConfig("smallBlind must be > 0");
        if (config.bigBlind != config.smallBlind * 2) revert InvalidTableConfig("bigBlind must be 2x smallBlind");
        if (config.minBuyIn < config.bigBlind * 10) revert InvalidTableConfig("minBuyIn must be >= 10 big blinds");
        if (config.maxBuyIn < config.minBuyIn) revert InvalidTableConfig("maxBuyIn must be >= minBuyIn");
        if (config.rakeBps > MAX_RAKE_BPS) revert InvalidTableConfig("rakeBps must be <= 1000");
        if (config.maxSeats < 2 || config.maxSeats > MAX_SEATS) revert InvalidTableConfig("maxSeats must be 2..6");
    }
}
