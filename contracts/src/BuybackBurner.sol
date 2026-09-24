// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IBuybackBurner } from "./interfaces/IBuybackBurner.sol";
import { IBuybackDex, IERC20Burnable } from "./interfaces/IBuybackDex.sol";

/**
 * @title BuybackBurner
 * @notice Converts the buyback half of the rake — every fee it is credited, in whatever token —
 *         into LLMPOKER and **burns** it (SRS §6, FR-8.2, FR-9.2).
 *
 * @dev ### Where the fees come from
 *
 *      `RakeSplitter.sweepBuyback` transfers the buyback leg and then calls `receiveFees`, so this
 *      contract never needs an allowance from anybody. `receiveFees` is restricted to the
 *      configured `splitter` plus any address holding the pusher role, because an open hook would
 *      let anybody announce fees they never paid and inflate the pending books.
 *
 *      ### Inert until a router is configured (the expected state today)
 *
 *      LLMPOKER is not deployed yet and no DEX router address is known, so `router` starts unset.
 *      `execute` **does not pretend to swap** in that state: it leaves the balance untouched and
 *      emits `BuybackPending(token, amount, reason)` so the accrual is publicly observable and a
 *      later `execute` (after `setRouterAndRoute`) performs the real buyback. No accounting is
 *      lost and no bad trade is ever attempted.
 *
 *      ### The route is owner-set, the caller only supplies bounds
 *
 *      A v2-style router takes `path` as calldata, so an unconstrained keeper could route through
 *      arbitrary tokens and surrender the buyback to a honeypot. The owner therefore pins the
 *      route per token with `setRouterAndRoute` / `setRoute`, and `execute` requires the caller's
 *      `path` to be **byte-identical** to it. The caller still chooses `minOut` /
 *      `maxSlippageBps` and `deadline`, so a keeper controls its own slippage bound but not the
 *      route — the strictest arrangement that still needs no privileged keeper.
 *
 *      ### Burn semantics (choice, and why)
 *
 *      `Token.burn(uint256)` is preferred over transferring to the zero address: it is a real,
 *      event-emitting supply reduction that checks the caller actually holds the amount, whereas
 *      a zero-address transfer relies on the token allowing it and (for OpenZeppelin-based
 *      tokens such as `Token.sol`) would burn nothing at all — `_transfer` reverts on a
 *      zero-address recipient. Only the holder can burn, and `totalSupply()` is the only quantity
 *      that changes. For a fee token that is not LLMPOKER the swap output is withdrawn to this
 *      contract and then burned, so LLMPOKER in the pool is genuinely reduced.
 *
 *      ### LLMPOKER fees burn directly
 *
 *      When `token == LLMPOKER` no swap happens: the pending balance is burned as-is, which is
 *      what "convert the buyback into LLMPOKER and burn it" degenerates to.
 */
contract BuybackBurner is IBuybackBurner, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Basis-point denominator for the slippage bound.
    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @notice Default LLMPOKER slippage tolerance when the caller supplies no `minOut` (1 %).
    uint256 public constant DEFAULT_MAX_SLIPPAGE_BPS = 100;

    /// @notice Default seconds a swap stays valid when the caller passes `deadline == 0` (5 min).
    uint256 public constant DEFAULT_DEADLINE_SECONDS = 300;

    /// @notice The token that is bought back and burned (LLMPOKER).
    IERC20 public immutable token;

    /// @notice The only contract allowed to push fees by default: the `RakeSplitter`.
    address public splitter;

    /// @notice DEX router used to convert fee tokens into LLMPOKER. Unset = buyback is inert.
    address public router;

    /// @notice Slippage tolerance applied when `execute` is called with `minOut == 0`, in bps.
    uint256 public maxSlippageBps;

    /// @dev `token => owner-pinned swap path` (first entry the fee token, last LLMPOKER).
    mapping(address => address[]) private _route;

    /// @dev `account => may push fees in addition to `splitter``.
    mapping(address => bool) private _pushers;

    /// @notice Pending (credited, not yet executed) fees per token, in base units.
    mapping(address => uint256) public pendingOf;

    /// @notice Cumulative fees ever credited per token, in base units.
    mapping(address => uint256) public totalFeesReceived;

    /// @notice Cumulative LLMPOKER burned by this contract.
    uint256 public totalBurned;

    /// @notice A zero-address argument was supplied.
    error ZeroAddress();

    /// @notice The caller may not push fees.
    error NotPusher(address caller);

    /// @notice `execute` was called for a token with no pending balance.
    error NothingToExecute(address token);

    /// @notice A zero-amount push or burn was supplied.
    error ZeroAmount();

    /// @notice The pushed amount is larger than the balance this contract actually holds.
    error InsufficientFees(uint256 amount, uint256 held);

    /// @notice `maxSlippageBps` above 100 %.
    error InvalidSlippage(uint256 maxSlippageBps);

    /// @notice Caller-supplied route does not match the owner-pinned route.
    error RouteNotConfigured(address token, address[] path);

    /// @notice Caller-supplied `minOut` is weaker than the configured slippage bound.
    error InsufficientMinOut(uint256 minOut, uint256 floor);

    /// @notice The swap transaction deadline already passed.
    error DeadlineExpired(uint256 deadline);

    /// @notice Configuring a route shorter than two entries, or one with wrong endpoints.
    error InvalidRoute(address token, address[] path);

    /// @notice The LLMPOKER token did not behave like a burnable ERC-20.
    error BurnFailed(address token, uint256 amount);

    /// @notice Emitted for every fee credit (FR-8.2).
    event FeesReceived(address indexed token, address indexed from, uint256 amount, uint256 pending);
    /// @notice Emitted when the owner pins a DEX router and a route.
    event RouterUpdated(address previous, address current);
    /// @notice Emitted when a token's swap path is pinned.
    event RouteUpdated(address indexed token, address[] path);
    /// @notice Emitted when the default slippage tolerance changes.
    event MaxSlippageUpdated(uint256 previous, uint256 current);
    /// @notice Emitted when the fee-pusher allowlist changes.
    event SplitterUpdated(address previous, address current);
    /// @notice Emitted when a pusher grant changes.
    event PusherUpdated(address indexed account, bool allowed);
    /// @notice Emitted when a buyback could not be executed yet (FR-9.6 observability).
    event BuybackPending(address indexed token, uint256 amount, bytes32 reason);
    /// @notice Emitted for every completed buyback-and-burn.
    event Burned(address indexed token, uint256 llmpokerAmount, address indexed caller);
    /// @notice Emitted when stray tokens are swept into the pending books.
    event FeesSwept(address indexed token, uint256 amount, uint256 pending);

    /**
     * @param token_ The token to buy back and burn (LLMPOKER).
     * @param initialOwner Owner that configures the router, routes and pushers.
     * @param initialSlippageBps Default slippage tolerance in bps; `0` selects
     *        `DEFAULT_MAX_SLIPPAGE_BPS`.
     */
    constructor(IERC20 token_, address initialOwner, uint256 initialSlippageBps) Ownable(initialOwner) {
        if (address(token_) == address(0) || initialOwner == address(0)) revert ZeroAddress();
        uint256 slippage = initialSlippageBps == 0 ? DEFAULT_MAX_SLIPPAGE_BPS : initialSlippageBps;
        if (slippage > BPS_DENOMINATOR) revert InvalidSlippage(slippage);
        token = token_;
        maxSlippageBps = slippage;
    }

    // ---------------------------------------------------------------------
    // Fee intake
    // ---------------------------------------------------------------------

    /**
     * @notice Credit `amount` of `token` as pending buyback fees.
     * @dev FR-8.2. Only the configured `splitter` or a pusher may push. The tokens must already
     *      have been transferred to this contract, so no allowance is required and nobody can
     *      announce fees they did not pay.
     * @param token_ Fee token, in base units.
     * @param amount Fee amount, in base units.
     */
    function receiveFees(address token_, uint256 amount) external nonReentrant {
        if (msg.sender != splitter && !_pushers[msg.sender]) revert NotPusher(msg.sender);
        _credit(token_, amount);
    }

    /**
     * @notice Credit any `token` balance this contract holds but has not booked yet.
     * @dev Permissionless recovery path: tokens sent straight here (a manual top-up, an airdrop,
     *      or an older splitter) become executable instead of being stuck. It can only ever add
     *      to the pending books, never move tokens out.
     * @param token_ Token to reconcile.
     */
    function sweepStray(IERC20 token_) external nonReentrant {
        uint256 held = token_.balanceOf(address(this));
        uint256 booked = pendingOf[address(token_)];
        if (held <= booked) revert NothingToExecute(address(token_));
        uint256 strays = held - booked;
        _credit(address(token_), strays);
        emit FeesSwept(address(token_), strays, pendingOf[address(token_)]);
    }

    // ---------------------------------------------------------------------
    // Keeper: convert and burn
    // ---------------------------------------------------------------------

    /**
     * @notice Convert the pending balance of `token` into LLMPOKER and burn it.
     * @dev FR-8.2, FR-9.2. Permissionless: any keeper may call it and the tokens can only ever
     *      leave as a burn (or as the swap leg whose output is burned), so an unprivileged caller
     *      has nothing to gain.
     *
     *      * `token == LLMPOKER` — burn the pending balance directly, no swap.
     *      * otherwise — with no `router` configured the balance is **held** and
     *        `BuybackPending(token, amount, reason)` is emitted (the expected state until a DEX
     *        router address is supplied); with a router configured the swap runs through the
     *        owner-pinned `routeOf(token)`.
     *
     *      Slippage: the bind is `floor = amount * (10000 - bps) / 10000` of the LLMPOKER the
     *      route is expected to return. With `minOut == 0` that floor **is** the bound passed to
     *      the router (the keeper is protected by the contract default, not by nothing); a
     *      caller-supplied `minOut` below the floor is rejected (`InsufficientMinOut`) and one
     *      above it is enforced as given. Either way a bad trade reverts instead of executing.
     * @param token_ Fee token whose pending balance is executed.
     * @param path Swap path; must equal the owner-pinned route for `token_`.
     * @param minOut Minimum LLMPOKER the swap must yield; `0` = derive from `maxSlippageBps`.
     * @param maxSlippageBps_ Caller slippage bound in bps; `0` = use the contract default.
     * @param deadline Unix seconds after which the swap is invalid; `0` = `block.timestamp` plus
     *        `DEFAULT_DEADLINE_SECONDS`.
     */
    function execute(address token_, address[] calldata path, uint256 minOut, uint256 maxSlippageBps_, uint256 deadline)
        external
        nonReentrant
    {
        uint256 amount = pendingOf[token_];
        if (amount == 0) revert NothingToExecute(token_);

        // Effects before interactions: the credit is debited before any external call, so a
        // re-entrant (or simply repeated) execute cannot burn the same fees twice.
        pendingOf[token_] = 0;

        if (token_ == address(token)) {
            _burn(amount);
            totalBurned += amount;
            emit Burned(token_, amount, msg.sender);
            return;
        }

        if (router == address(0)) {
            pendingOf[token_] = amount;
            emit BuybackPending(token_, amount, "NO_ROUTER");
            return;
        }

        address[] storage pinned = _route[token_];
        if (pinned.length < 2 || keccak256(abi.encode(path)) != keccak256(abi.encode(pinned))) {
            revert RouteNotConfigured(token_, path);
        }

        // The swap must still be valid when it executes; the deadline is context-independent, so
        // it is checked before the price-dependent bound below.
        uint256 resolvedDeadline = deadline == 0 ? block.timestamp + DEFAULT_DEADLINE_SECONDS : deadline;
        if (resolvedDeadline < block.timestamp) revert DeadlineExpired(resolvedDeadline);

        uint256 slippage = maxSlippageBps_ == 0 ? maxSlippageBps : maxSlippageBps_;
        if (slippage > BPS_DENOMINATOR) revert InvalidSlippage(slippage);
        // The floor the trade must clear: `amount` is the fee-token input, and the pinned route is
        // LLMPOKER-terminated, so a 1 % tolerance means at least 99 % of it must come back as
        // LLMPOKER. `minOut == 0` means "derive the bound from the configured tolerance".
        uint256 floor = (amount * (BPS_DENOMINATOR - slippage)) / BPS_DENOMINATOR;
        if (minOut != 0 && minOut < floor) revert InsufficientMinOut(minOut, floor);
        uint256 effectiveMinOut = minOut == 0 ? floor : minOut;

        uint256 received = _swapAndBurn(token_, amount, path, effectiveMinOut, resolvedDeadline);
        totalBurned += received;
        emit Burned(token_, received, msg.sender);
    }

    // ---------------------------------------------------------------------
    // Administration
    // ---------------------------------------------------------------------

    /**
     * @notice Pin the DEX router and the swap route for one fee token.
     * @dev The feature is inert until this is called with a real router: LLMPOKER is not deployed
     *      yet and no DEX address is known, so the deployment intentionally starts unconfigured.
     * @param newRouter V2-style router exposing `swapExactTokensForTokens`.
     * @param token_ Fee token the route starts from.
     * @param path Route, `[token_, ..., LLMPOKER]`, at least two entries.
     */
    function setRouterAndRoute(address newRouter, address token_, address[] calldata path) external onlyOwner {
        if (newRouter == address(0) || token_ == address(0)) revert ZeroAddress();
        _validateRoute(token_, path);
        address previous = router;
        router = newRouter;
        _route[token_] = path;
        emit RouterUpdated(previous, newRouter);
        emit RouteUpdated(token_, path);
    }

    /**
     * @notice Pin the swap route for one fee token without touching the router.
     * @dev FR-9.7: routes change as liquidity moves; the router address usually does not.
     * @param token_ Fee token the route starts from.
     * @param path Route, `[token_, ..., LLMPOKER]`, at least two entries.
     */
    function setRoute(address token_, address[] calldata path) external onlyOwner {
        if (token_ == address(0)) revert ZeroAddress();
        _validateRoute(token_, path);
        _route[token_] = path;
        emit RouteUpdated(token_, path);
    }

    /**
     * @notice Update the default slippage tolerance applied when a caller passes `minOut == 0`.
     * @dev FR-9.7. Bounded at 100 %; the floor is still enforced per call.
     * @param newSlippageBps New tolerance in basis points.
     */
    function setMaxSlippageBps(uint256 newSlippageBps) external onlyOwner {
        if (newSlippageBps > BPS_DENOMINATOR) revert InvalidSlippage(newSlippageBps);
        uint256 previous = maxSlippageBps;
        maxSlippageBps = newSlippageBps;
        emit MaxSlippageUpdated(previous, newSlippageBps);
    }

    /**
     * @notice Point the fee-pusher allowlist at the `RakeSplitter`.
     * @dev FR-10: only the splitter (and explicit pusher grants) may push fees.
     * @param newSplitter The `RakeSplitter` address.
     */
    function setSplitter(address newSplitter) external onlyOwner {
        if (newSplitter == address(0)) revert ZeroAddress();
        address previous = splitter;
        splitter = newSplitter;
        emit SplitterUpdated(previous, newSplitter);
    }

    /**
     * @notice Grant or revoke the fee-pusher role for `account`.
     * @dev FR-10. `allowed = false` revokes; the configured `splitter` is unaffected by this flag.
     * @param account Address whose pusher status changes.
     * @param allowed Whether the address may push fees.
     */
    function setPusher(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        _pushers[account] = allowed;
        emit PusherUpdated(account, allowed);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice The owner-pinned swap path for `token_` (empty when unconfigured).
    function routeOf(address token_) external view returns (address[] memory) {
        return _route[token_];
    }

    /// @notice Whether `account` may push fees in addition to the configured splitter.
    function isPusher(address account) external view returns (bool) {
        return _pushers[account];
    }

    /// @notice LLMPOKER held by this contract (pending buyback plus any stray balance).
    function llmpokerHeld() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// @dev FR-8.2: book a fee credit. The balance check keeps the books honest — a pusher that
    ///      claims a transfer larger than what this contract holds is rejected.
    function _credit(address token_, uint256 amount) private {
        if (token_ == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 held = IERC20(token_).balanceOf(address(this));
        if (amount > held) revert InsufficientFees(amount, held);

        uint256 next = pendingOf[token_] + amount;
        pendingOf[token_] = next;
        totalFeesReceived[token_] += amount;

        emit FeesReceived(token_, msg.sender, amount, next);
    }

    /// @dev Swap `amount` of `token_` for LLMPOKER through the pinned router and burn the output.
    ///      The approval is reset to zero afterwards so no residual allowance survives.
    function _swapAndBurn(address token_, uint256 amount, address[] calldata path, uint256 minOut, uint256 deadline)
        private
        returns (uint256)
    {
        IERC20 inToken = IERC20(token_);
        inToken.forceApprove(router, amount);

        uint256[] memory amounts =
            IBuybackDex(router).swapExactTokensForTokens(amount, minOut, path, address(this), deadline);
        uint256 received = amounts[amounts.length - 1];

        inToken.forceApprove(router, 0);
        _burn(received);
        return received;
    }

    /// @dev Burn LLMPOKER from this contract's own balance. `Token.burn` is a real supply
    ///      reduction: it decrements the caller's balance and `totalSupply()` and emits a
    ///      transfer to the zero address, so the burn is visible in the standard ERC-20 logs.
    ///      The call is typed through `IERC20Burnable` (not a raw call) so a non-burnable token
    ///      fails loudly instead of silently leaving the buyback unburned.
    function _burn(uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        IERC20Burnable(address(token)).burn(amount);
    }

    /// @dev A route must start at the fee token and end at LLMPOKER, or the "swap then burn"
    ///      invariant breaks.
    function _validateRoute(address token_, address[] calldata path) private view {
        if (path.length < 2 || path[0] != token_ || path[path.length - 1] != address(token)) {
            revert InvalidRoute(token_, path);
        }
    }
}
