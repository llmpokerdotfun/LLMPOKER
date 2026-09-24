// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IRakeSplitter } from "./interfaces/IRakeSplitter.sol";
import { IStaking } from "./interfaces/IStaking.sol";

/**
 * @title RakeSplitter
 * @notice Routes the rake taken by `Poker.sol` to the house-edge staking pool and the fee vault
 *         (SRS Â§6, FR-8.2, FR-9).
 *
 * @dev **Sweep, don't push.** The splitter credits each beneficiary and holds the tokens until
 *      the beneficiary calls `sweepStaking` / `sweepVault`. A push-on-distribute
 *      design would let a single misconfigured or paused beneficiary revert every settlement;
 *      pull keeps settlement O(seats) and unblockable (NFR-3). The staking leg additionally
 *      must be notified after the balance moves â€” `Staking.notifyRewards` accrues pro-rata
 *      against tokens already in the pool â€” which the pull model guarantees by construction.
 *
 *      The split is a single configurable `stakingBps` (SRS Â§11 Q4 leaves the SRS split open);
 *      the vault leg is always the remainder, so the two always sum to 100% of the rake, and
 *      the remainder routing means no dust is ever stranded in the splitter.
 */
contract RakeSplitter is IRakeSplitter, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant BPS_DENOMINATOR = 10_000;

    /// @notice The only token the splitter handles (the platform token).
    IERC20 public immutable token;

    /// @notice The house-edge pool that receives the staking leg (FR-9.4â€“9.6).
    IStaking public immutable staking;

    /// @notice The fee vault that receives the ops/trading leg (FR-9.3).
    address public immutable vault;

    /// @notice Share of rake routed to staking, in basis points (default 5000 = 50/50).
    uint256 public stakingBps;

    /// @notice The only contract allowed to push rake (FR-8.2, FR-10).
    address public poker;

    /// @notice Amount owed to `staking` and not yet swept.
    uint256 public pendingStaking;

    /// @notice Amount owed to `vault` and not yet swept.
    uint256 public pendingVault;

    /// @notice Cumulative rake received since deployment (FR-9.6 observability).
    uint256 public totalReceived;

    /// @notice Cumulative amount credited to `staking`.
    uint256 public totalCreditedStaking;

    /// @notice Cumulative amount credited to `vault`.
    uint256 public totalCreditedVault;

    /// @notice Sender is not the configured `poker` contract.
    error NotPoker(address caller);

    /// @notice A zero-address argument was supplied.
    error ZeroAddress();

    /// @notice `stakingBps` is above 10 000.
    error InvalidSplit(uint256 stakingBps);

    /// @notice Sweep larger than the credited balance.
    error InsufficientPending(uint256 requested, uint256 available);

    /// @notice Emitted when the rake split changes (FR-9.7).
    event SplitUpdated(uint256 previous, uint256 current);

    /// @notice Emitted when the authorized rake source changes (FR-10).
    event PokerUpdated(address previous, address current);

    /**
     * @param token_ Token moved as rake (the platform token).
     * @param staking_ The house-edge pool.
     * @param vault_ The fee vault.
     * @param initialOwner Owner allowed to retune the split and the poker address.
     * @param initialStakingBps Staking share in basis points; 5000 = the SRS default split.
     */
    constructor(IERC20 token_, IStaking staking_, address vault_, address initialOwner, uint256 initialStakingBps)
        Ownable(initialOwner)
    {
        if (address(token_) == address(0) || address(staking_) == address(0) || vault_ == address(0)) {
            revert ZeroAddress();
        }
        if (initialOwner == address(0)) revert ZeroAddress();
        if (initialStakingBps > BPS_DENOMINATOR) revert InvalidSplit(initialStakingBps);
        token = token_;
        staking = staking_;
        vault = vault_;
        stakingBps = initialStakingBps;
    }

    /**
     * @notice Accept a rake payment from the poker contract and credit the two legs.
     * @dev FR-8.2. Pull-based: the caller must have approved this contract for `amount`.
     * @param amount Rake amount, in base units.
     */
    function receiveRake(uint256 amount) external nonReentrant {
        if (msg.sender != poker) revert NotPoker(msg.sender);
        if (amount == 0) revert InsufficientPending(0, 0);

        token.safeTransferFrom(msg.sender, address(this), amount);

        uint256 toStaking = (amount * stakingBps) / BPS_DENOMINATOR;
        uint256 toVault = amount - toStaking;

        pendingStaking += toStaking;
        pendingVault += toVault;
        totalCreditedStaking += toStaking;
        totalCreditedVault += toVault;
        totalReceived += amount;

        emit RakeDistributed(msg.sender, amount, toStaking, toVault, totalReceived);
    }

    /**
     * @notice Move the accrued staking leg into the pool and notify it (FR-9.4, FR-9.6).
     * @dev Permissionless: anybody may crank the splitter; funds can only reach the configured
     *      staking pool.
     * @param amount Amount to sweep; must not exceed `pendingStaking`.
     */
    function sweepStaking(uint256 amount) external nonReentrant {
        uint256 available = pendingStaking;
        if (amount > available) revert InsufficientPending(amount, available);
        pendingStaking = available - amount;

        if (amount != 0) {
            token.safeTransfer(address(staking), amount);
            staking.notifyRewards(amount);
        }
        emit Swept(address(staking), address(staking), amount);
    }

    /**
     * @notice Move the accrued vault leg to the fee vault (FR-9.3).
     * @dev Permissionless for the same reason as `sweepStaking`.
     * @param amount Amount to sweep; must not exceed `pendingVault`.
     */
    function sweepVault(uint256 amount) external nonReentrant {
        uint256 available = pendingVault;
        if (amount > available) revert InsufficientPending(amount, available);
        pendingVault = available - amount;

        if (amount != 0) {
            token.safeTransfer(vault, amount);
        }
        emit Swept(vault, vault, amount);
    }

    /**
     * @notice Sweep both legs in one transaction.
     * @dev Convenience for keepers; equivalent to `sweepStaking(pendingStaking)` followed by
     *      `sweepVault(pendingVault)`.
     */
    function sweepAll() external nonReentrant {
        uint256 amountStaking = pendingStaking;
        uint256 amountVault = pendingVault;
        pendingStaking = 0;
        pendingVault = 0;

        if (amountStaking != 0) {
            token.safeTransfer(address(staking), amountStaking);
            staking.notifyRewards(amountStaking);
            emit Swept(address(staking), address(staking), amountStaking);
        }
        if (amountVault != 0) {
            token.safeTransfer(vault, amountVault);
            emit Swept(vault, vault, amountVault);
        }
    }

    /**
     * @notice Update the rake split.
     * @dev FR-9.7. Applies to future rake only; already-credited legs are untouched.
     * @param newStakingBps New staking share in basis points (`0..10000`).
     */
    function setStakingBps(uint256 newStakingBps) external onlyOwner {
        if (newStakingBps > BPS_DENOMINATOR) revert InvalidSplit(newStakingBps);
        uint256 previous = stakingBps;
        stakingBps = newStakingBps;
        emit SplitUpdated(previous, newStakingBps);
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

    /// @notice Vault share of the rake, in basis points.
    function vaultBps() external view returns (uint256) {
        return BPS_DENOMINATOR - stakingBps;
    }

    /// @notice Amount owed to `beneficiary` and not yet swept.
    function pendingOf(address beneficiary) external view returns (uint256) {
        if (beneficiary == address(staking)) return pendingStaking;
        if (beneficiary == vault) return pendingVault;
        return 0;
    }

    /// @notice Cumulative amount credited to `beneficiary`.
    function totalCreditedTo(address beneficiary) external view returns (uint256) {
        if (beneficiary == address(staking)) return totalCreditedStaking;
        if (beneficiary == vault) return totalCreditedVault;
        return 0;
    }

    /// @notice Token held by the splitter, which is always `pendingStaking + pendingVault`.
    function totalAssets() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
}
