// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IRakeSplitter } from "./interfaces/IRakeSplitter.sol";
import { IStaking } from "./interfaces/IStaking.sol";
import { IBuybackBurner } from "./interfaces/IBuybackBurner.sol";

/**
 * @title RakeSplitter
 * @notice Routes the rake taken by `Poker.sol` to the LLMPOKER **buyback-and-burn** beneficiary
 *         and to the house-edge **staking** pool (SRS §6, FR-8.2, FR-9).
 *
 * @dev ### The split (revised tokenomics)
 *
 *      Of every rake payment, `buybackBps` (default 5000 = 50 %) is credited to the configured
 *      buyback beneficiary — `BuybackBurner.sol`, which converts it into LLMPOKER and burns it —
 *      and the remainder (default 50 %) is credited to the staking pool, which airdrops it
 *      pro-rata to stakers. **The old vault leg of the rake is gone**: `Vault.sol` still
 *      custodies DEX trading fees (FR-9.2) but no longer receives any part of the house edge.
 *
 *      The split is a single owner-configurable `buybackBps`; the staking leg is always the
 *      remainder, so the two always sum to exactly 100 % of the rake and no dust is stranded in
 *      the splitter.
 *
 *      ### Multi-token accounting (per-table settlement currency)
 *
 *      A wager table settles in the token it was created with (`Poker.createTable(..., IERC20)`),
 *      so the same rake pipeline must carry **USDG** (6 decimals) *and* LLMPOKER (18 decimals).
 *      Every balance here is therefore keyed by `(token, beneficiary)`, and `receiveRake` takes
 *      the token explicitly instead of assuming one platform token. The splitter only ever
 *      counts base units — it has no opinion about decimals (NFR-4).
 *
 *      ### Sweep, don't push
 *
 *      `receiveRake` only *credits*; tokens move when a beneficiary is swept, which is
 *      permissionless. A push-on-distribute design would let a single misconfigured or paused
 *      beneficiary revert every settlement; pull keeps settlement O(seats) and unblockable
 *      (NFR-3). The staking leg must be notified after the balance moves —
 *      `Staking.notifyRewards` accrues pro-rata against tokens already in the pool — which the
 *      pull model guarantees by construction.
 *
 *      ### Remainder / dust (deterministic)
 *
 *      `toBuyback = floor(amount * buybackBps / 10000)` and `toStaking = amount - toBuyback`, so
 *      the staking leg absorbs the odd base unit of a non-divisible amount (e.g. 101 wei at the
 *      50/50 default credits 50 to the buyback and 51 to staking). The two credits always sum to
 *      the full amount, so `token.balanceOf(splitter) == sum of pending credits` for every token
 *      at all times and no wei is ever stranded or lost to rounding.
 */
contract RakeSplitter is IRakeSplitter, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Basis-point denominator shared with `Poker.sol` and `packages/shared/src/config.ts`.
    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @notice Default buyback share of the rake: 50 % (the revised 50/50 tokenomics).
    uint256 public constant DEFAULT_BUYBACK_BPS = 5_000;

    /// @notice The house-edge pool that receives the staking leg (FR-9.4–9.6).
    IStaking public immutable staking;

    /// @notice The fee vault (FR-9.2–9.3). Kept for reference only: rake no longer routes here.
    address public immutable vault;

    /// @notice Share of rake routed to the buyback-and-burn beneficiary, in basis points.
    uint256 public buybackBps;

    /// @notice The only contract allowed to push rake (FR-8.2, FR-10).
    address public poker;

    /// @notice The buyback-and-burn beneficiary the buyback leg is credited to.
    address public buyback;

    /// @dev `keccak256(token, beneficiary) => credited and not yet swept`.
    mapping(bytes32 => uint256) public pending;
    /// @dev `keccak256(token, beneficiary) => cumulative amount credited`.
    mapping(bytes32 => uint256) public credited;
    /// @dev `token => cumulative rake received`.
    mapping(address => uint256) public receivedOf;

    /// @notice Sender is not the configured `poker` contract.
    error NotPoker(address caller);

    /// @notice A zero-address argument was supplied.
    error ZeroAddress();

    /// @notice `buybackBps` is above 10 000.
    error InvalidSplit(uint256 buybackBps);

    /// @notice Sweep larger than the credited balance.
    error InsufficientPending(uint256 requested, uint256 available);

    /// @notice Emitted when the rake split changes (FR-9.7).
    event SplitUpdated(uint256 previous, uint256 current);

    /// @notice Emitted when the authorized rake source changes (FR-10).
    event PokerUpdated(address previous, address current);

    /// @notice Emitted when the buyback-and-burn beneficiary changes.
    event BuybackUpdated(address previous, address current);

    /**
     * @param staking_ The house-edge pool.
     * @param vault_ The fee vault; retained as a recorded address, no longer a rake beneficiary.
     * @param initialOwner Owner allowed to retune the split, the poker source and the buyback.
     * @param initialBuybackBps Buyback share in basis points; 5000 = the 50/50 revised tokenomics.
     */
    constructor(IStaking staking_, address vault_, address initialOwner, uint256 initialBuybackBps)
        Ownable(initialOwner)
    {
        if (address(staking_) == address(0) || vault_ == address(0) || initialOwner == address(0)) {
            revert ZeroAddress();
        }
        if (initialBuybackBps > BPS_DENOMINATOR) revert InvalidSplit(initialBuybackBps);
        staking = staking_;
        vault = vault_;
        buybackBps = initialBuybackBps;
    }

    /**
     * @notice Accept a rake payment from the poker contract and credit the two legs.
     * @dev FR-8.2, FR-9.2. `Poker.sol` transfers the tokens first and then calls this, so the
     *      splitter only ever accounts for tokens it already holds — no allowance is needed from
     *      the poker contract, which keeps settlement to one `transfer` plus this credit and
     *      removes a whole class of approval misconfiguration. The token is passed explicitly
     *      because wager tables settle in their own currency (USDG or LLMPOKER).
     *
     *      **Deployment order matters**: `setBuyback` must be called before the first hand settles,
     *      otherwise the buyback leg accrues under the zero-address key and cannot be swept (the
     *      staking leg is unaffected). `scripts/deploy.ts` wires the burner immediately after the
     *      splitter exists, and `sweepBuyback` reverts rather than sending a leg nowhere, so the
     *      window is loud rather than silent.
     * @param token Rake token, in base units.
     * @param amount Rake amount, in base units.
     */
    function receiveRake(IERC20 token, uint256 amount) external nonReentrant {
        if (msg.sender != poker) revert NotPoker(msg.sender);
        if (address(token) == address(0)) revert ZeroAddress();
        if (amount == 0) revert InsufficientPending(0, 0);
        uint256 held = token.balanceOf(address(this));
        if (held < amount) revert InsufficientPending(amount, held);

        // Floor the buyback leg; the staking leg absorbs the remainder (see contract NatSpec).
        uint256 toBuyback = (amount * buybackBps) / BPS_DENOMINATOR;
        uint256 toStaking = amount - toBuyback;

        bytes32 buybackKey = _beneficiaryKey(token, buyback);
        bytes32 stakingKey = _beneficiaryKey(token, address(staking));
        pending[buybackKey] += toBuyback;
        pending[stakingKey] += toStaking;
        credited[buybackKey] += toBuyback;
        credited[stakingKey] += toStaking;
        uint256 total = receivedOf[address(token)] + amount;
        receivedOf[address(token)] = total;

        emit RakeDistributed(msg.sender, address(token), amount, toBuyback, toStaking, total);
    }

    /**
     * @notice Move the accrued staking leg of `token` into the pool and notify it
     *         (FR-9.4, FR-9.6).
     * @dev Permissionless: anybody may crank the splitter; funds can only reach the configured
     *      staking pool.
     * @param token Token whose staking leg is swept.
     * @param amount Amount to sweep; must not exceed the pending amount for that token.
     */
    function sweepStaking(IERC20 token, uint256 amount) external nonReentrant {
        uint256 swept = _sweep(token, address(staking), amount, address(staking));
        if (swept != 0) {
            staking.notifyRewards(swept);
        }
    }

    /**
     * @notice Move the accrued buyback leg of `token` to the buyback-and-burn beneficiary
     *         (FR-9.2).
     * @dev Permissionless for the same reason as `sweepStaking`. The beneficiary is notified
     *      through `IBuybackBurner.receiveFees` so `BuybackBurner` accounts for the fees it now
     *      holds; the burner's own permissionless `execute` performs the swap and the burn.
     * @param token Token whose buyback leg is swept.
     * @param amount Amount to sweep; must not exceed the pending amount for that token.
     */
    function sweepBuyback(IERC20 token, uint256 amount) external nonReentrant {
        uint256 swept = _sweep(token, buyback, amount, buyback);
        if (swept != 0) {
            IBuybackBurner(buyback).receiveFees(address(token), swept);
        }
    }

    /**
     * @notice Sweep both legs of `token` in one transaction.
     * @dev Convenience for keepers; equivalent to `sweepStaking(token, pending)` followed by
     *      `sweepBuyback(token, pending)` for the same token. A deployment with several settlement
     *      currencies calls this once per token, or uses the two-leg entry points directly.
     * @param token Token whose legs are both swept.
     */
    function sweepAll(IERC20 token) external nonReentrant {
        uint256 stakingAmount = pending[_beneficiaryKey(token, address(staking))];
        uint256 buybackAmount = pending[_beneficiaryKey(token, buyback)];

        if (stakingAmount != 0) {
            _sweep(token, address(staking), stakingAmount, address(staking));
            staking.notifyRewards(stakingAmount);
        }
        if (buybackAmount != 0) {
            _sweep(token, buyback, buybackAmount, buyback);
            IBuybackBurner(buyback).receiveFees(address(token), buybackAmount);
        }
    }

    /**
     * @notice Update the rake split.
     * @dev FR-9.7. Applies to future rake only; already-credited legs are untouched. The staking
     *      share is derived as `10000 - buybackBps`, so the two always sum to 100 %.
     * @param newBuybackBps New buyback share in basis points (`0..10000`).
     */
    function setBuybackBps(uint256 newBuybackBps) external onlyOwner {
        if (newBuybackBps > BPS_DENOMINATOR) revert InvalidSplit(newBuybackBps);
        uint256 previous = buybackBps;
        buybackBps = newBuybackBps;
        emit SplitUpdated(previous, newBuybackBps);
    }

    /**
     * @notice Point the buyback leg at the buyback-and-burn beneficiary.
     * @dev Wiring hook for `BuybackBurner.sol`; the burner address is supplied after both
     *      contracts exist, so it cannot be immutable. Credits already accrued to the previous
     *      beneficiary stay with it and are still sweepable.
     * @param newBuyback The buyback beneficiary (expected: `BuybackBurner`).
     */
    function setBuyback(address newBuyback) external onlyOwner {
        if (newBuyback == address(0)) revert ZeroAddress();
        address previous = buyback;
        buyback = newBuyback;
        emit BuybackUpdated(previous, newBuyback);
    }

    /**
     * @notice Point the splitter at the authorized poker contract.
     * @dev FR-10: without this restriction any address could inject "rake" and skew the pool's
     *      reported yield. Rotation is available for a Poker.sol redeploy.
     */
    function setPoker(address newPoker) external onlyOwner {
        if (newPoker == address(0)) revert ZeroAddress();
        address previous = poker;
        poker = newPoker;
        emit PokerUpdated(previous, newPoker);
    }

    /// @notice Staking share of the rake, in basis points (always `10000 - buybackBps`).
    function stakingBps() external view returns (uint256) {
        return BPS_DENOMINATOR - buybackBps;
    }

    /// @notice Vault share of the rake: always zero — the vault leg was replaced by the buyback.
    /// @dev `pure` because the answer is a constant of the revised tokenomics, not state.
    function vaultBps() external pure returns (uint256) {
        return 0;
    }

    /// @notice Amount of `token` owed to `beneficiary` and not yet swept.
    function pendingOf(IERC20 token, address beneficiary) external view returns (uint256) {
        return pending[_beneficiaryKey(token, beneficiary)];
    }

    /// @notice Cumulative amount of `token` credited to `beneficiary`.
    function totalCreditedTo(IERC20 token, address beneficiary) external view returns (uint256) {
        return credited[_beneficiaryKey(token, beneficiary)];
    }

    /// @notice Cumulative rake received in `token` since deployment.
    function totalReceivedOf(IERC20 token) external view returns (uint256) {
        return receivedOf[address(token)];
    }

    /// @notice Token held by the splitter; always the sum of every pending credit for `token`.
    function totalAssets(IERC20 token) external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    /// @dev FR-9.6: debit the credit and move the tokens. Returns the amount actually moved so
    ///      the caller can notify the beneficiary without re-reading storage. Reverting when the
    ///      beneficiary is unset is intended: a sweep is explicit and must not silently burn the
    ///      leg into an address nobody can recover from.
    function _sweep(IERC20 token, address beneficiary, uint256 amount, address to) private returns (uint256) {
        if (beneficiary == address(0)) revert ZeroAddress();
        bytes32 key = _beneficiaryKey(token, beneficiary);
        uint256 available = pending[key];
        if (amount > available) revert InsufficientPending(amount, available);
        pending[key] = available - amount;

        if (amount != 0) {
            token.safeTransfer(to, amount);
        }
        emit Swept(address(token), beneficiary, to, amount);
        return amount;
    }

    /// @dev `(token, beneficiary)` balance key. Mirrors `Poker._seatKey` in spirit: one keccak
    ///      over packed fields, so a 20-byte address and a 20-byte token cannot collide.
    function _beneficiaryKey(IERC20 token, address beneficiary) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(token, beneficiary));
    }
}
