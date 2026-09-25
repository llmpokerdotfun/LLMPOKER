// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import { IShuffle } from "./interfaces/IShuffle.sol";
import { IRakeSplitter } from "./interfaces/IRakeSplitter.sol";

/**
 * @title Poker
 * @notice On-chain custody, pot accounting and settlement for wager-mode NLHE (SRS §6, FR-5,
 *         FR-8, FR-10.3, FR-10.5).
 *
 * @dev **Trust model.** The off-chain engine is the referee of *action legality* (FR-3.6) but is
 *      never the custodian of money (FR-5.3, `docs/ARCHITECTURE.md` hard rule 6): every token
 *      sits in this contract's escrow, keyed by `(tableId, seat)`, and can only leave through
 *      `cashOut` (owner-signed), `settleHand` (operator, and only against the recorded seat
 *      contributions that sum exactly to the pot), or `voidHand` (permissionless, only after
 *      `Shuffle` records a void). The engine can therefore misreport *who won* — which is why
 *      the deck is verifiable — but it can never move a token it was not authorized for.
 *
 *      **What the contract does not do.** It does not evaluate poker hands, does not run the
 *      game loop and does not accept per-action bets: hole cards and board are recomputable
 *      from `Shuffle.sol` (FR-6.3) but hand evaluation is deliberately off-chain, so settlement
 *      takes winners and awards as calldata and *verifies the only things it can verify
 *      on-chain* — that contributions sum to the pot, that awards sum to pot minus the
 *      contract-computed rake, that the seats exist, and that the hand was opened against a
 *      revealed shuffle for which every participant actually moved chips.
 *
 *      **Per-table settlement currency.** A wager table settles in the ERC-20 it was created
 *      with (`createTable(..., IERC20 settlementToken)`): USDG for stable-currency tables and
 *      LLMPOKER for token tables. There is no global settlement token, so `deposit`, `cashOut`,
 *      `settleHand` (including the rake transfer) and `voidHand` all use the table's own token,
 *      and two tables with different tokens can never mix funds. `USDG` has **6 decimals** and
 *      `LLMPOKER` has **18**; this contract deals exclusively in base units and never scales or
 *      converts, so it does not care which is which — only the off-chain engine and the deploy
 *      script are responsible for choosing per-denomination blind and buy-in amounts.
 *
 *      **Wagered actions are recorded, never re-adjudicated.** `recordAction` lets the operator
 *      publish each agent action together with the agent's own EIP-712 signature, so the ordered
 *      sequence of actions in a hand becomes public and attributable without this contract ever
 *      learning the betting rules. Legality (min-raise, side pots, all-in caps, whose turn it is)
 *      stays in the pure engine — see the NatSpec on `recordAction` for exactly what the record
 *      does and does not prove.
 */
contract Poker is Ownable, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Maximum seats at a wager table (6-max, SRS §1).
    uint8 public constant MAX_SEATS = 6;

    /// @notice Hard cap on any table's rake (10%, FR-8.1 / `validateTableConfig`).
    uint256 public constant MAX_RAKE_BPS = 1_000;

    /// @notice Rake denominator shared with `packages/shared/src/config.ts`.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /**
     * @notice `keccak256` of the `AgentAction` EIP-712 type string the server signs.
     * @dev This is *the* compatibility surface with the off-chain signer
     *      (`AGENT_ACTION_TYPES` / `agentActionDigest` in `packages/shared/src/eip712.ts` and
     *      the act handler in `packages/server/src/app.ts`). It is public so the test suite can
     *      assert it against a value derived with `ethers` at run time: a hard-coded typehash
     *      that silently diverged from the server's would still verify *a* signature, just never
     *      a real agent's, and that failure would only surface in production.
     *
     *      `uint8` is deliberately NOT normalised to `uint256`: the server's type definition uses
     *      `uint8` for `seat`/`action`, and EIP-712 hashes the type string verbatim, so
     *      normalising either side would change the typehash and break every signature.
     */
    bytes32 public constant AGENT_ACTION_TYPEHASH = keccak256(
        "AgentAction(string agentId,string tableId,string handId,uint8 seat,uint8 action,uint256 amount,uint256 nonce,uint256 deadline)"
    );

    /// @notice `keccak256` of the EIP-712 domain type string, exactly as `eip712Domain` builds it.
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @notice EIP-712 domain name, matching `EIP712_DOMAIN_NAME` in `packages/shared/src/eip712.ts`.
    bytes32 private constant DOMAIN_NAME_HASH = keccak256("LLM Poker Arena");

    /// @notice EIP-712 domain version, matching `EIP712_DOMAIN_VERSION` in the shared package.
    bytes32 private constant DOMAIN_VERSION_HASH = keccak256("1");

    /// @notice Highest action enum value the record path accepts (`ALL_IN`).
    uint8 private constant MAX_ACTION_ENUM = 5;

    /// @notice Domain separator cached at deployment (standard OpenZeppelin fork protection).
    bytes32 private immutable _cachedDomainSeparator;
    /// @notice `block.chainid` the cached separator was built for.
    uint256 private immutable _cachedChainId;
    /// @notice `address(this)` the cached separator was built for.
    address private immutable _cachedThis;

    /**
     * @notice Whether rake is charged only when a flop was dealt.
     * @dev SRS §11 Q2 leaves the rake policy open; `computeRake` in
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
        /// @dev Settlement currency of this table, fixed at creation (FR-5.1).
        IERC20 settlementToken;
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

    /// @notice Verifiable-RNG contract that gates every hand (FR-6).
    IShuffle public immutable shuffle;

    /// @notice Rake recipient (FR-8.2).
    IRakeSplitter public immutable rakeSplitter;

    /// @notice Off-chain engine allowed to run tables and settle hands (FR-10.3).
    address public operator;

    /// @dev `tableId => table`.
    mapping(bytes32 => Table) private _tables;

    /// @dev `settlement token => was ever used by a table`. Gates the per-token escrow view.
    mapping(address => bool) private _settlementTokenSeen;

    /// @notice Running total of escrow this contract owes per settlement token (FR-5.1, NFR-4).
    /// @dev Updated at every mutation of `escrowOf`, so it is exactly `sum(escrowOf[key])` over
    ///      every table settling in that token, and it equals the contract's balance of that
    ///      token because the rake leaves the contract in the same transaction it is taken.
    mapping(address => uint256) public escrowTotalOf;

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

    /// @dev `handId => seat => highest action nonce recorded`. Strictly increasing per seat, so a
    ///      relayed signature can be submitted at most once even if the operator replays calldata.
    mapping(bytes32 => mapping(uint8 => uint256)) public lastActionNonce;

    /// @dev `handId => rolling commitment over the ordered action sequence` (see `_extendActionChain`).
    ///      One slot per hand, so the whole record costs a bounded amount of storage however many
    ///      actions the hand contains.
    mapping(bytes32 => bytes32) public actionChain;

    /// @dev `handId => number of actions recorded`. Exposed through `actionCountOf`.
    mapping(bytes32 => uint256) private _actionCount;

    /// @notice Emitted when a wager table is created (FR-5.1).
    event TableCreated(bytes32 indexed tableId, address indexed settlementToken, TableConfig config, address operator);
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
    /**
     * @notice Emitted for every agent action the operator relays, with the wallet that signed it.
     * @dev `signer` is the recovered address, which `recordAction` has already proved equal to the
     *      seat's occupant — so a verifier can attribute the action from the log alone, without
     *      re-deriving the seat owner at that historical block. `amount` is `0` for FOLD, CHECK,
     *      CALL and ALL_IN, exactly as the agent signed it (see `recordAction`).
     */
    event ActionRecorded(
        bytes32 indexed tableId,
        bytes32 indexed handId,
        uint8 indexed seat,
        uint8 action,
        uint256 amount,
        uint256 nonce,
        address signer
    );

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
    /// @notice The hand has no phase-1 shuffle commitment yet (FR-6.1).
    error ShuffleNotCommitted(bytes32 handId);
    /// @notice The hand's shuffle deck root was never committed, so it cannot settle (FR-6.2).
    error ShuffleDeckNotCommitted(bytes32 handId);
    /// @notice The hand's shuffle voided, so it can only be voided here (FR-6.7).
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
    /// @notice A zero settlement token was supplied for a table (FR-5.1).
    error InvalidSettlementToken();
    /// @notice No table settles in this token, so a per-token aggregate is meaningless.
    error UnsupportedToken(address token);
    /// @notice The action enum is outside `0..5` (see `AGENT_ACTION_TYPEHASH`).
    error InvalidActionEnum(uint8 action);
    /// @notice The action deadline passed before the record landed.
    error ActionExpired(uint256 deadline, uint256 nowTs);
    /// @notice The signature was not produced by the wallet occupying the acting seat.
    error ActionSignerMismatch(uint8 seat, address expected, address recovered);
    /// @notice The nonce is not strictly greater than the last one recorded for this seat and hand.
    error ActionNonceReused(uint8 seat, uint256 nonce, uint256 lastNonce);

    /**
     * @param shuffle_ Verifiable-RNG contract (FR-6).
     * @param rakeSplitter_ Rake recipient (FR-8.2). It receives the rake in each table's own
     *        settlement token, so it must accept more than one currency.
     * @param initialOwner Owner: table creation authority, pause authority, operator rotation.
     * @param initialOperator Off-chain engine address (FR-10.3).
     */
    constructor(IShuffle shuffle_, IRakeSplitter rakeSplitter_, address initialOwner, address initialOperator)
        Ownable(initialOwner)
    {
        if (
            address(shuffle_) == address(0) || address(rakeSplitter_) == address(0) || initialOwner == address(0)
                || initialOperator == address(0)
        ) {
            revert ZeroAddress();
        }
        shuffle = IShuffle(shuffle_);
        rakeSplitter = IRakeSplitter(rakeSplitter_);
        operator = initialOperator;

        // Cache the domain separator the way OpenZeppelin's `EIP712` does. The values are
        // immutable and known at construction, so every `recordAction` in this deployment's life
        // reads them from code rather than storage (NFR-3: recording must stay cheap enough to
        // run once per action on a ~0.8s-block chain). The chain id is cached *beside* the
        // separator so a fork — where `block.chainid` changes but the address may not — rebuilds
        // it instead of accepting signatures minted for the other chain.
        _cachedChainId = block.chainid;
        _cachedThis = address(this);
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    // ---------------------------------------------------------------------
    // Table administration
    // ---------------------------------------------------------------------

    /**
     * @notice Create a wager table that settles in `settlementToken`.
     * @dev FR-5.1, FR-8.1, FR-10.3. Only the owner may create wager tables, and the same
     *      address can never deposit at one (see `deposit`), which is what makes "the
     *      operator cannot seat at its own tables" enforceable on-chain.
     *
     *      The settlement currency is per table and fixed at creation: USDG (6 decimals) or
     *      LLMPOKER (18 decimals). The token is validated as non-zero; nothing else about it is
     *      assumed, and no token address is hard-coded anywhere.
     * @param tableId Off-chain-stable table identifier.
     * @param config Blinds, buy-in bounds, rake schedule and seat count.
     * @param settlementToken ERC-20 this table escrows, settles and rakes in.
     */
    function createTable(bytes32 tableId, TableConfig calldata config, IERC20 settlementToken) external onlyOwner {
        if (tableId == bytes32(0)) revert ZeroAddress();
        if (address(settlementToken) == address(0)) revert InvalidSettlementToken();
        if (_tables[tableId].exists) revert TableExists(tableId);
        _validateTableConfig(config);

        _tables[tableId].config = config;
        _tables[tableId].settlementToken = settlementToken;
        _tables[tableId].exists = true;
        _settlementTokenSeen[address(settlementToken)] = true;

        emit TableCreated(tableId, address(settlementToken), config, operator);
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
     * @notice Take `seat` at `tableId` with `amount` of the table's settlement token.
     * @dev FR-5.1, FR-5.3, FR-10.3. Top-ups are allowed and the *resulting* balance must stay
     *      within `[minBuyIn, maxBuyIn]`, so the buy-in range is enforced across deposits.
     *      Deliberately blocked while paused: money must not enter escrow while settlement is
     *      halted (FR-10.5 halts wager flow, and `cashOut` stays open regardless). The token
     *      pulled is the table's own currency, so a USDG table can never be funded with
     *      LLMPOKER (or vice versa).
     * @param tableId Table identifier.
     * @param seat Seat index, `0..maxSeats-1`.
     * @param amount Amount of the table's settlement token, in base units.
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

        table.settlementToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 balance = escrowOf[key] + amount;
        if (balance < table.config.minBuyIn || balance > table.config.maxBuyIn) {
            revert BuyInOutOfRange(balance, table.config.minBuyIn, table.config.maxBuyIn);
        }
        escrowOf[key] = balance;
        escrowTotalOf[address(table.settlementToken)] += amount;

        emit Deposited(tableId, seat, msg.sender, amount, balance);
    }

    /**
     * @notice Withdraw the escrowed balance for a seat and give the seat up.
     * @dev FR-5.5, FR-10.5. **Never gated by `whenNotPaused`**: pausing halts wager settlement
     *      and must never trap already-settled escrow. Reverts only while a hand this seat has
     *      contributed to is still open. Paid in the table's own settlement token.
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
        escrowTotalOf[address(table.settlementToken)] -= amount;

        table.settlementToken.safeTransfer(msg.sender, amount);

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
    function openHand(bytes32 tableId, bytes32 handId, uint8[] calldata seats)
        external
        onlyOperator
        whenNotPaused
    {
        Table storage table = _tables[tableId];
        if (!table.exists) revert UnknownTable(tableId);
        if (handId == bytes32(0)) revert ZeroAddress();
        if (seats.length < 2 || seats.length > table.config.maxSeats) {
            revert InvalidSeat(seats.length, table.config.maxSeats);
        }
        if (!shuffle.hasCommitment(handId)) revert ShuffleNotCommitted(handId);

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
     * @notice Record the chips one seat moved into the current pot and move them out of escrow.
     * @dev FR-5.2, FR-5.3. The chips are debited from the seat's escrow **here**, not at
     *      settlement, so the pot is collateralised from the moment the engine declares it and
     *      the contract's aggregate balance is the source of truth at every instant. A seat can
     *      therefore never promise chips it does not hold, and a voided hand simply credits the
     *      recorded contributions back (FR-5.6).
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
        bytes32 key = _seatKey(tableId, seat);
        if (pendingHandOf[key] != handId) revert NoPosition(tableId, seatOwner[key]);

        uint256 balance = escrowOf[key];
        if (amount > balance) revert ContributionExceedsEscrow(seat, amount, balance);
        escrowOf[key] = balance - amount;
        escrowTotalOf[address(table.settlementToken)] -= amount;

        hand.pot += amount;
        contributionOf[tableId][handId][seat] += amount;

        emit HandCommitted(tableId, handId, seat, amount, hand.pot);
    }

    /**
     * @notice Record one agent action for an open hand, authorised by the agent's own signature.
     * @dev **The operator relays; the agent keeps the pen.** The agent POSTs its signed action to
     *      the server exactly as before (free mode and the agent-facing HTTP contract are
     *      unchanged) and the operator submits this call, so an agent never needs gas — only a
     *      wallet to sign with. The signature is verified here over the *same* EIP-712 payload the
     *      server verifies (`AGENT_ACTION_TYPEHASH`, the `(name, version, chainId, address(this))`
     *      domain, `uint8` seat/action), and the recovered address must be the wallet that funded
     *      the seat — hence an action can only be attributed to the agent whose money is at risk
     *      in that seat.
     *
     *      **What this proves.** That the seat's occupant authorised *this* `(tableId, handId,
     *      seat, action, amount, nonce, deadline, agentId)` tuple, at most once, in a recorded
     *      order (`actionChain` is a rolling hash, so any reordering or removal changes it), and
     *      while the hand was open and the deadline had not passed.
     *
     *      **What this does NOT prove.** It does not prove the action was *legal*: min-raise
     *      sizing, side-pot and all-in arithmetic, whose turn it was and how much the agent was
     *      allowed to bet all live in the pure engine (`packages/engine`, FR-3.6) and are
     *      deliberately not reimplemented here. The recorded `amount` is therefore exactly what
     *      the agent signed, not a validated bet. Nor does it bind the action sequence into
     *      `settleHand` — settlement still trusts the engine's winners and contributions (see the
     *      note there); `actionChain` is published so a future settlement can bind to it.
     *
     *      **Amount convention.** `amount` is `0` for FOLD, CHECK, CALL and ALL_IN and non-zero
     *      only for BET/RAISE, because that is what the agent signs (`shape.action.amount ?? 0n`
     *      in `packages/server/src/app.ts`). The contract does not enforce it: the value is part
     *      of the signed payload and of `actionChain`, so changing it invalidates the signature.
     *
     *      Not gated by `whenNotPaused` and not `nonReentrant`: it makes no external call and
     *      moves no chips, so it cannot reenter anything. Keeping it live while settlement is
     *      paused means the record of an interrupted hand survives the pause instead of losing
     *      the actions that were already signed.
     * @param tableId Table the hand belongs to. Hashed by the caller (`keccak256(utf8)`).
     * @param handId Open hand. Hashed by the caller (`keccak256(utf8)`).
     * @param seat Acting seat.
     * @param action Action enum: `FOLD=0, CHECK=1, CALL=2, BET=3, RAISE=4, ALL_IN=5`.
     * @param amount Chips the action names; `0` unless BET/RAISE.
     * @param nonce Strictly increasing per `(handId, seat)` action nonce.
     * @param deadline Unix seconds after which the signature is void.
     * @param agentId Agent id string the signature covers (hashed like the server does).
     * @param signature 65-byte `r ‖ s ‖ v` over the EIP-712 digest.
     */
    function recordAction(
        bytes32 tableId,
        bytes32 handId,
        uint8 seat,
        uint8 action,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        string calldata agentId,
        bytes calldata signature
    ) external onlyOperator {
        Table storage table = _tables[tableId];
        if (!table.exists) revert UnknownTable(tableId);
        if (seat >= table.config.maxSeats) revert InvalidSeat(seat, table.config.maxSeats);

        Hand storage hand = _hands[tableId][handId];
        if (hand.status == HandStatus.None) revert UnknownHand(tableId, handId);
        if (hand.status != HandStatus.Open) revert HandNotOpen(handId, hand.status);

        if (deadline < block.timestamp) revert ActionExpired(deadline, block.timestamp);
        if (action > MAX_ACTION_ENUM) revert InvalidActionEnum(action);

        uint256 lastNonce = lastActionNonce[handId][seat];
        if (nonce <= lastNonce) revert ActionNonceReused(seat, nonce, lastNonce);

        // `occupantOf` reads the seat registry, so "the wallet that funded the seat is the wallet
        // that authorised the action" is enforced from on-chain state, not from anything the
        // operator supplies. A seat with no occupant recovers against the zero address, which no
        // signature can produce.
        address expected = seatOwner[_seatKey(tableId, seat)];
        address signer = _recoverActionSigner(tableId, handId, seat, action, amount, nonce, deadline, agentId, signature);
        if (signer != expected) revert ActionSignerMismatch(seat, expected, signer);

        lastActionNonce[handId][seat] = nonce;
        actionChain[handId] = _extendActionChain(actionChain[handId], tableId, handId, seat, action, amount, nonce);
        _actionCount[handId] += 1;

        emit ActionRecorded(tableId, handId, seat, action, amount, nonce, signer);
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
     *      on-chain: who won the pot, and the hole-card/board mapping — the latter is
     *      recomputable from `Shuffle.sol` (FR-6.3). The pot, the awards and the rake are all in
     *      the table's settlement token, in base units.
     *
     *      This signature is deliberately unchanged by the action record: settlement does **not**
     *      bind to `actionChain`, so it still trusts the engine for who won and for how much each
     *      seat put in. `actionChainOf(handId)` is available for a future version of this call to
     *      bind to, which is out of scope here.
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

        // FR-6.2: a hand can only settle against a committed (hidden) deck root. The contract does
        // not need the ordering to move chips — the engine reports the winners, and the deck is
        // auditable later — so no card, seed or ordering is required here.
        IShuffle.Phase shufflePhase = shuffle.phaseOf(handId);
        if (shufflePhase == IShuffle.Phase.Voided) revert ShuffleVoided(handId);
        if (shufflePhase != IShuffle.Phase.DeckCommitted && shufflePhase != IShuffle.Phase.Audited) {
            revert ShuffleDeckNotCommitted(handId);
        }

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

        // (4) Credit the winners. The contributors' chips were already moved out of escrow by
        // `commitHand`, so `creditSum == pot - rake <= balance` holds by construction and no
        // award can ever be paid out of another seat's escrow.
        _applySettlement(tableId, winners, awards, table.config.maxSeats, table.settlementToken);

        // (5) Rake leaves the contract for the splitter (FR-8.2), in the table's own settlement
        // token, so a USDG table's rake arrives at `RakeSplitter` as USDG and a LLMPOKER table's
        // rake arrives as LLMPOKER. It was never part of `escrowTotalOf`: the chips were debited
        // from escrow by `commitHand`, and only `pot - rake` is credited back to the winners, so
        // `escrowTotalOf(token)` and the contract's balance both fall by exactly `rake` here.
        if (rake != 0) {
            IERC20 settlementToken = table.settlementToken;
            settlementToken.safeTransfer(address(rakeSplitter), rake);
            rakeSplitter.receiveRake(settlementToken, rake);
        }

        emit HandSettled(tableId, handId, pot, rake, sawFlop ? 1 : 0, winners, awards);
    }

    /**
     * @notice Void a hand whose shuffle voided, restoring every contribution to escrow.
     * @dev FR-5.6, FR-6.7. Permissionless by design: the liveness guarantee must not depend on the
     *      operator. Reachable once `Shuffle` has recorded a `Voided` phase, which covers both
     *      liveness failures — no deck root inside the reveal window, and a deck root whose audit
     *      never arrived — as well as the reorg case where the anchor block was orphaned and the
     *      reveal window expired (NFR-6). Because `Shuffle.void` already returns early for handed
     *      states, this cannot be used to escape a losing settlement, and it can only ever move
     *      chips back to the seats that contributed them.
     * @param tableId Table identifier.
     * @param handId Open hand whose shuffle voided.
     */
    function voidHand(bytes32 tableId, bytes32 handId) external nonReentrant {
        Table storage table = _tables[tableId];
        if (!table.exists) revert UnknownTable(tableId);

        Hand storage hand = _hands[tableId][handId];
        if (hand.status == HandStatus.None) revert UnknownHand(tableId, handId);
        if (hand.status != HandStatus.Open) revert HandNotOpen(handId, hand.status);

        if (shuffle.phaseOf(handId) != IShuffle.Phase.Voided) revert ShuffleStillPending(handId);

        uint256 restored = 0;
        for (uint256 i = 0; i < hand.seatCount; ++i) {
            uint8 seat = hand.participants[i];
            uint256 amount = contributionOf[tableId][handId][seat];
            if (amount == 0) continue;
            escrowOf[_seatKey(tableId, seat)] += amount;
            contributionOf[tableId][handId][seat] = 0;
            restored += amount;
        }
        escrowTotalOf[address(table.settlementToken)] += restored;
        hand.status = HandStatus.Voided;
        table.pendingHands -= 1;

        emit HandVoided(tableId, handId, restored, "SHUFFLE_VOIDED");
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

    /// @notice Highest action nonce recorded for one seat of one hand (0 when none yet).
    function lastActionNonceOf(bytes32 handId, uint8 seat) external view returns (uint256) {
        return lastActionNonce[handId][seat];
    }

    /**
     * @notice Rolling commitment over the ordered action sequence of a hand.
     * @dev `keccak256(abi.encode(prev, tableId, handId, seat, action, amount, nonce))`, folded in
     *      as each action is recorded, starting from `bytes32(0)`. Two hands with the same
     *      multiset of actions in a different order end with different chains, so the record is
     *      tamper-evident for ordering and removal alike: a verifier replaying the emitted
     *      `ActionRecorded` events in log order reproduces this value exactly.
     * @param handId Hand to read.
     */
    function actionChainOf(bytes32 handId) external view returns (bytes32) {
        return actionChain[handId];
    }

    /// @notice Number of actions recorded for a hand.
    function actionCountOf(bytes32 handId) external view returns (uint256) {
        return _actionCount[handId];
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
     * @notice Total escrow this contract owes in `settlementToken`.
     * @dev NFR-4: maintained as a running per-token total, so the view is O(1) and never iterates
     *      user data (NFR-3). The invariant it reports is
     *      `escrowTotalOf(token) == settlementToken.balanceOf(this)`, because the rake leaves the
     *      contract in the same transaction it is taken (FR-8.2) — so any verifier can check
     *      solvency per currency in two calls.
     *
     *      It is **per token** on purpose: a single cross-token aggregate would be meaningless,
     *      since USDG (6 decimals) and LLMPOKER (18 decimals) base units are not commensurable.
     *      Reverts for a token no table settles in, so "no escrow" cannot be mistaken for
     *      "unsupported currency".
     * @param settlementToken Token to total.
     */
    function totalEscrowObserved(IERC20 settlementToken) external view returns (uint256) {
        if (!_settlementTokenSeen[address(settlementToken)]) revert UnsupportedToken(address(settlementToken));
        return escrowTotalOf[address(settlementToken)];
    }

    /**
     * @notice Escrow owed in `settlementToken` at one table (FR-5.1).
     * @dev Reads the same running per-token total guarded by the table's currency, so it is O(1)
     *      and the view a per-table monitor should use.
     * @param tableId Table identifier.
     * @param settlementToken Token to check against the table's currency.
     */
    function tableEscrowOf(bytes32 tableId, IERC20 settlementToken) external view returns (uint256) {
        Table storage table = _tables[tableId];
        if (!table.exists) revert UnknownTable(tableId);
        if (address(table.settlementToken) != address(settlementToken)) {
            revert UnsupportedToken(address(settlementToken));
        }
        return escrowTotalOf[address(settlementToken)];
    }

    /// @notice The settlement currency of a table, fixed at creation (FR-5.1).
    function settlementTokenOf(bytes32 tableId) external view returns (IERC20) {
        if (!_tables[tableId].exists) revert UnknownTable(tableId);
        return _tables[tableId].settlementToken;
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
     *      committed chips and the entries must sum to the recorded pot. Split out of
     *      `settleHand` to keep the settlement frame inside the EVM stack limit for 6 seats
     *      (NFR-3).
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
            summed += amount;
        }
        if (summed != pot) revert ContributionMismatch(pot, summed);
    }

    /**
     * @dev FR-5.2: credit the winners. The losers' chips were already debited from escrow in
     *      `commitHand`, so this loop only ever creates credits that are fully collateralised by
     *      the chips this contract is holding. `escrowTotalOf` moves with `escrowOf` so the
     *      per-token running total stays exact (NFR-4).
     */
    function _applySettlement(
        bytes32 tableId,
        uint8[] calldata winners,
        uint256[] calldata awards,
        uint8 maxSeats,
        IERC20 settlementToken
    ) private {
        uint256 credited = 0;
        for (uint256 i = 0; i < winners.length; ++i) {
            uint8 seat = winners[i];
            if (seat >= maxSeats) revert InvalidSeat(seat, maxSeats);
            escrowOf[_seatKey(tableId, seat)] += awards[i];
            credited += awards[i];
        }
        escrowTotalOf[address(settlementToken)] += credited;
    }

    function _seatKey(bytes32 tableId, uint8 seat) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(tableId, seat));
    }

    /**
     * @dev The EIP-712 domain separator for `(name, version, block.chainid, address(this))`.
     *      Rebuilt only when the cached values no longer describe this deployment — the standard
     *      OpenZeppelin approach, and the reason the cache is worth having on the hot path.
     */
    function _domainSeparator() private view returns (bytes32) {
        if (address(this) == _cachedThis && block.chainid == _cachedChainId) {
            return _cachedDomainSeparator;
        }
        return _buildDomainSeparator();
    }

    /// @dev `keccak256(abi.encode(DOMAIN_TYPEHASH, name, version, chainId, address(this)))`.
    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, DOMAIN_NAME_HASH, DOMAIN_VERSION_HASH, block.chainid, address(this))
        );
    }

    /**
     * @dev Recovers the signer of one action, reproducing the server's digest byte for byte.
     *
     *      `abi.encode` pads `uint8` and `uint256` alike to a 32-byte word, so `seat` and `action`
     *      encode exactly as the server's `uint256ToBytes(BigInt(value))` does for them
     *      (`encodeField` in `packages/shared/src/eip712.ts`). `agentId` is hashed here as
     *      `keccak256(bytes(agentId))` because the server declares it a `string` field, which
     *      EIP-712 hashes as `keccak256(utf8)`; `tableId` and `handId` arrive already hashed that way
     *      (the server's `id32`/`handId32` in `packages/server/src/chain.ts`). The digest is
     *      `keccak256(0x1901 ‖ domainSeparator ‖ structHash)`.
     */
    function _recoverActionSigner(
        bytes32 tableId,
        bytes32 handId,
        uint8 seat,
        uint8 action,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        string calldata agentId,
        bytes calldata signature
    ) private view returns (address) {
        bytes32 structHash = keccak256(
            abi.encode(
                AGENT_ACTION_TYPEHASH,
                keccak256(bytes(agentId)),
                tableId,
                handId,
                seat,
                action,
                amount,
                nonce,
                deadline
            )
        );
        return ECDSA.recover(MessageHashUtils.toTypedDataHash(_domainSeparator(), structHash), signature);
    }

    /**
     * @dev Folds one action into the hand's rolling commitment.
     *
     *      `abi.encode` (not `encodePacked`) is deliberate: packed encoding lets a caller move
     *      bytes between adjacent fields — `(seat, action)` as `(1, 2)` and `(0, 0x0102)` would
     *      pack to the same bytes — and a commitment that can be reinterpreted is not
     *      tamper-evident. The fixed-width encoding makes each field unambiguous.
     */
    function _extendActionChain(
        bytes32 previous,
        bytes32 tableId,
        bytes32 handId,
        uint8 seat,
        uint8 action,
        uint256 amount,
        uint256 nonce
    ) private pure returns (bytes32) {
        return keccak256(abi.encode(previous, tableId, handId, seat, action, amount, nonce));
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
