// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IVault } from "./interfaces/IVault.sol";

/**
 * @title Vault
 * @notice Fee custody and allocation for the platform (SRS Â§6, FR-9.2â€“9.3): every inflow is
 *         split between the **operations** bucket (gas, engine infra, agent bounties) and the
 *         **trading-rewards** bucket (LP/trader incentives).
 *
 * @dev FR-9.2 explicitly leaves the pons fee infrastructure open (SRS Â§11), so the DEX fee
 *      route is implemented as an explicit `notifyFees` hook: anything that can move
 *      tokens â€” a pons fee-splitter, a buyback-transfer, or a keeper â€” calls it and the split
 *      is applied on-chain with an event. Nothing about the hook presumes a specific DEX.
 *
 *      Default split is 50/50 (FR-9.3) and the admin may move `operationsBps` anywhere in
 *      `[0, 10000]`; the trading-rewards share is always the remainder, so the two buckets
 *      always sum to 100% of a distribution. Two distinct roles exist because the SRS assigns
 *      two distinct purposes to the money, and a single operator key should not be able to
 *      drain both.
 */
contract Vault is IVault, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Role allowed to withdraw the operations bucket (FR-9.3).
    bytes32 public constant OPERATIONS_ROLE = keccak256("llmpoker.vault.operations");

    /// @notice Role allowed to withdraw the trading-rewards bucket (FR-9.3).
    bytes32 public constant TRADING_REWARDS_ROLE = keccak256("llmpoker.vault.tradingRewards");

    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @notice Default operations share: 50% (FR-9.3).
    uint256 public constant DEFAULT_OPERATIONS_BPS = 5_000;

    /// @notice The only token this vault custodies.
    IERC20 public immutable token;

    /// @notice Share of every inflow routed to operations, in basis points.
    uint256 public operationsBps;

    /// @notice Accrued, not-yet-withdrawn operations balance.
    uint256 public operationsBalance;

    /// @notice Accrued, not-yet-withdrawn trading-rewards balance.
    uint256 public tradingRewardsBalance;

    /// @notice Cumulative fees ever notified into the vault.
    uint256 public totalReceived;

    /// @notice A zero-address argument was supplied.
    error ZeroAddress();

    /// @notice `operationsBps` is above 10 000.
    error InvalidSplit(uint256 operationsBps);

    /// @notice Withdrawal larger than the bucket balance.
    error InsufficientBalance(uint256 requested, uint256 available);

    /**
     * @param token_ ERC-20 held by the vault (the platform token).
     * @param initialAdmin Address receiving `DEFAULT_ADMIN_ROLE` and both withdrawal roles.
     * @param initialOperationsBps Operations share in basis points; 5000 = the FR-9.3 default.
     */
    constructor(IERC20 token_, address initialAdmin, uint256 initialOperationsBps) {
        if (address(token_) == address(0) || initialAdmin == address(0)) revert ZeroAddress();
        if (initialOperationsBps > BPS_DENOMINATOR) revert InvalidSplit(initialOperationsBps);
        token = token_;
        operationsBps = initialOperationsBps;
        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(OPERATIONS_ROLE, initialAdmin);
        _grantRole(TRADING_REWARDS_ROLE, initialAdmin);
    }

    /**
     * @notice Route `amount` of token into the vault and split it ops/rewards.
     * @dev FR-9.2. Callable by anyone holding the tokens and an approval, which is what makes it
     *      usable as a DEX fee hook. Pull-based (`safeTransferFrom`) so nobody can announce fees
     *      they never paid.
     * @param amount Amount of token to route, in base units.
     */
    function notifyFees(uint256 amount) external nonReentrant {
        if (amount == 0) revert InsufficientBalance(0, 0);
        token.safeTransferFrom(msg.sender, address(this), amount);

        uint256 toOperations = (amount * operationsBps) / BPS_DENOMINATOR;
        uint256 toTradingRewards = amount - toOperations;

        operationsBalance += toOperations;
        tradingRewardsBalance += toTradingRewards;
        totalReceived += amount;

        emit FeesNotified(msg.sender, amount, toOperations, toTradingRewards);
    }

    /**
     * @notice Withdraw from the operations bucket.
     * @dev FR-9.3. Access-controlled per bucket; the caller chooses the recipient so a
     *      multi-sig can pay a vendor directly.
     * @param to Recipient.
     * @param amount Amount to withdraw.
     */
    function withdrawOperations(address to, uint256 amount) external onlyRole(OPERATIONS_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 available = operationsBalance;
        if (amount > available) revert InsufficientBalance(amount, available);
        operationsBalance = available - amount;
        token.safeTransfer(to, amount);
        emit Withdrawn("operations", to, amount, operationsBalance);
    }

    /**
     * @notice Withdraw from the trading-rewards bucket.
     * @dev FR-9.3.
     * @param to Recipient.
     * @param amount Amount to withdraw.
     */
    function withdrawTradingRewards(address to, uint256 amount) external onlyRole(TRADING_REWARDS_ROLE) nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 available = tradingRewardsBalance;
        if (amount > available) revert InsufficientBalance(amount, available);
        tradingRewardsBalance = available - amount;
        token.safeTransfer(to, amount);
        emit Withdrawn("tradingRewards", to, amount, tradingRewardsBalance);
    }

    /**
     * @notice Update the ops/rewards split.
     * @dev FR-9.3 / FR-9.7. Applies to future distributions only; already-accrued bucket
     *      balances keep their classification, so no accounting can be rewritten retroactively.
     * @param newOperationsBps New operations share in basis points (`0..10000`).
     */
    function setOperationsBps(uint256 newOperationsBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newOperationsBps > BPS_DENOMINATOR) revert InvalidSplit(newOperationsBps);
        operationsBps = newOperationsBps;
        emit SplitUpdated(newOperationsBps);
    }

    /// @notice Currently configured trading-rewards share, in basis points.
    function tradingRewardsBps() external view returns (uint256) {
        return BPS_DENOMINATOR - operationsBps;
    }

    /// @notice Total token held by the vault, including any stray transfers.
    function totalAssets() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
}
