// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IStaking } from "./interfaces/IStaking.sol";

/**
 * @title Staking
 * @notice The house-edge pool (SRS Â§6, FR-9.4â€“9.6): stakers lock the token and earn a pro-rata
 *         share of every rake distribution pushed by `RakeSplitter.sol`.
 *
 * @dev ### Reward accounting (the scheme, and why it is shaped this way)
 *
 *      Uses the classic **cumulative reward-per-share accumulator**:
 *
 *      ```
 *      rewardPerShareStored += reward * SCALE / totalStaked          // SCALE = 1e18
 *      pending(u) = stake[u] * (rewardPerShareStored - paidPerShare[u]) / SCALE + credit[u]
 *      ```
 *
 *      * **Rounding safety (first-depositor / dust problem).** The naive
 *        `reward * SCALE / totalStaked` truncates; integer division could silently burn a
 *        distribution when `totalStaked` dwarfs `reward`, and a griefing first depositor could
 *        stake `1 wei` to make every subsequent distribution round to zero. Two guards:
 *        (a) the remainder is credited to a public `undistributedRewards` bucket instead of
 *        vanishing, and is folded into the next distribution; (b) the pool refuses to run with
 *        a dust-sized stake, via the `minStake` floor on the first active stake. Individual
 *        `pending()` values are floors, so `sum(pending) <= undistributed + notified`, and the
 *        contract never owes more than it holds.
 *      * **"Stake right before a distribution" attack.** Every balance-changing entry point
 *        calls `_sync(account)` *first*, so a new stake is registered at the post-distribution
 *        accumulator and earns nothing retroactively. Because shares sit in the pool for the
 *        whole 7-day unstake cooldown (FR-9.5) â€” and are moved out of the accumulator (earning
 *        nothing) for the entire cooldown window â€” the classic flash-stake/exit arbitrage is
 *        unprofitable: entering or leaving costs at least one cooldown of exposure for at most
 *        one pro-rata share of the rake paid in that window.
 *      * **No time-based accrual.** Yield arrives only via `notifyRewards`; there is no
 *        rate-per-second bookkeeping, so there are no "empty pool" reward periods to strand.
 *
 *      Every distribution emits `RewardsNotified` and every claim emits `Claimed`, so FR-9.6
 *      ("settled on-chain and verifiable") holds with public events alone.
 */
contract Staking is IStaking, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Role allowed to push rake yield into the pool (the `RakeSplitter`).
    bytes32 public constant REWARDS_NOTIFIER_ROLE = keccak256("llmpoker.staking.rewardsNotifier");

    /// @notice Fixed-point scale for `rewardPerShareStored`.
    uint256 public constant SCALE = 1e18;

    /// @notice The staked token.
    IERC20 public immutable token;

    /// @notice Seconds between `requestUnstake` and the principal becoming claimable (FR-9.5).
    uint256 public cooldownSeconds;

    /// @notice Minimum amount for the first active stake, to keep the accumulator non-dusty.
    uint256 public minStake;

    /// @notice Cumulative reward per staked unit, scaled by `SCALE`.
    uint256 public rewardPerShareStored;

    /// @notice Reward per share already accounted to each account.
    mapping(address => uint256) public paidPerShare;

    /// @notice Rewards snapshotted for accounts that are between `requestUnstake` and `claim`.
    mapping(address => uint256) public credit;

    /// @notice Active (yield-earning) stake per account.
    mapping(address => uint256) public stakeOf;

    /// @notice Principal in cooldown per account (FR-9.5).
    mapping(address => uint256) public pendingUnstake;

    /// @notice Timestamp at which the pending principal becomes claimable.
    mapping(address => uint256) public unstakeAvailableAt;

    /// @notice Sum of all active stakes.
    uint256 public totalStaked;

    /// @notice Cumulative yield ever notified (FR-9.6).
    uint256 public totalNotified;

    /// @notice Yield that could not be represented in `rewardPerShareStored` (rounding dust).
    uint256 public undistributedRewards;

    /// @notice A zero-address argument was supplied.
    error ZeroAddress();

    /// @notice Stake or unstake amount was zero.
    error ZeroAmount();

    /// @notice First active stake below `minStake`.
    error BelowMinStake(uint256 amount, uint256 minStake);

    /// @notice Unstake request larger than the active stake.
    error InsufficientStake(uint256 requested, uint256 available);

    /// @notice An unstake request is already in flight.
    error UnstakeAlreadyPending(uint256 amount, uint256 availableAt);

    /// @notice `claim()` called before the cooldown elapsed.
    error CooldownActive(uint256 availableAt);

    /// @notice Nothing pending and nothing claimable.
    error NothingToClaim();

    /// @notice `cooldownSeconds` was set to zero or unreasonably large.
    error InvalidCooldown(uint256 seconds_);

    /// @notice `minStake` was set to zero.
    error InvalidMinStake(uint256 minStake_);

    /// @notice Emitted when the unstake cooldown changes (FR-9.5, FR-9.7).
    event CooldownUpdated(uint256 previous, uint256 current);

    /// @notice Emitted when the dust floor changes.
    event MinStakeUpdated(uint256 previous, uint256 current);

    /// @notice Emitted when rounding dust is carried into a later distribution.
    event UndistributedCarried(uint256 amount, uint256 newUndistributed);

    /**
     * @param token_ Token eligible for staking (the platform token).
     * @param initialAdmin Admin (and initial rewards notifier, for deployment convenience).
     * @param initialCooldownSeconds Cooldown before unstaked principal is claimable; the shipped
     *        default from `packages/shared/src/config.ts` is 604800 (7 days).
     * @param initialMinStake Floor for the first active stake; 0 disables the floor.
     */
    constructor(IERC20 token_, address initialAdmin, uint256 initialCooldownSeconds, uint256 initialMinStake) {
        if (address(token_) == address(0) || initialAdmin == address(0)) revert ZeroAddress();
        if (initialCooldownSeconds == 0 || initialCooldownSeconds > 365 days) {
            revert InvalidCooldown(initialCooldownSeconds);
        }
        cooldownSeconds = initialCooldownSeconds;
        minStake = initialMinStake;
        _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
        _grantRole(REWARDS_NOTIFIER_ROLE, initialAdmin);
    }

    /**
     * @notice Stake `amount` token into the house-edge pool.
     * @dev FR-9.4. Accrues pending rewards first, so a new deposit can never be back-paid for
     *      yield that was distributed before it existed.
     * @param amount Amount to stake, in base units.
     */
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _sync(msg.sender);
        uint256 newBalance = stakeOf[msg.sender] + amount;
        if (totalStaked == 0 && newBalance < minStake) revert BelowMinStake(newBalance, minStake);

        stakeOf[msg.sender] = newBalance;
        totalStaked += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount, newBalance);
    }

    /**
     * @notice Start the unstake cooldown for `amount` (FR-9.5).
     * @dev Moves the principal out of the yield-earning accumulator immediately, so the
     *      cooldown cannot be used to keep earning while queued to exit. Rewards accrued up to
     *      this call are snapshotted into `credit` and stay claimable at once.
     * @param amount Amount of active stake to queue.
     */
    function requestUnstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        uint256 existing = pendingUnstake[msg.sender];
        if (existing != 0) revert UnstakeAlreadyPending(existing, unstakeAvailableAt[msg.sender]);

        uint256 available = stakeOf[msg.sender];
        if (amount > available) revert InsufficientStake(amount, available);

        _sync(msg.sender);
        stakeOf[msg.sender] = available - amount;
        totalStaked -= amount;
        pendingUnstake[msg.sender] = amount;
        uint256 availableAt = block.timestamp + cooldownSeconds;
        unstakeAvailableAt[msg.sender] = availableAt;

        emit UnstakeRequested(msg.sender, amount, availableAt);
    }

    /**
     * @notice Cancel a pending unstake and return the principal to the yield-earning stake.
     * @dev FR-9.5. Re-registers the balance at the current accumulator: time spent in cooldown
     *      does not earn retroactively.
     */
    function cancelUnstake() external nonReentrant {
        uint256 amount = pendingUnstake[msg.sender];
        if (amount == 0) revert NothingToClaim();

        _sync(msg.sender);
        pendingUnstake[msg.sender] = 0;
        unstakeAvailableAt[msg.sender] = 0;
        stakeOf[msg.sender] += amount;
        totalStaked += amount;

        emit UnstakeCancelled(msg.sender, amount);
    }

    /**
     * @notice Claim accrued rewards, and the queued principal once the cooldown has elapsed.
     * @dev FR-9.4 / FR-9.6. Emits `Claimed` even for a reward-only claim; a matured principal
     *      payout additionally emits `Unstaked`. Reverts when there is nothing to do.
     */
    function claim() external nonReentrant {
        _sync(msg.sender);
        uint256 reward = credit[msg.sender];
        uint256 principal = pendingUnstake[msg.sender];

        if (principal != 0 && block.timestamp < unstakeAvailableAt[msg.sender]) {
            revert CooldownActive(unstakeAvailableAt[msg.sender]);
        }
        if (reward == 0 && principal == 0) revert NothingToClaim();

        if (reward != 0) {
            credit[msg.sender] = 0;
            emit Claimed(msg.sender, reward);
        }
        if (principal != 0) {
            pendingUnstake[msg.sender] = 0;
            unstakeAvailableAt[msg.sender] = 0;
            emit Unstaked(msg.sender, principal);
        }

        token.safeTransfer(msg.sender, reward + principal);
    }

    /**
     * @notice Notify a rake distribution and accrue it pro-rata to current stakes (FR-9.6).
     * @dev Called by `RakeSplitter.sol` after the tokens are transferred into this contract.
     *      Restricted to `REWARDS_NOTIFIER_ROLE` so no one can inflate `totalNotified` â€” the
     *      backing tokens must already be here for the eventual `claim()` to succeed.
     * @param amount Amount of token to distribute.
     */
    function notifyRewards(uint256 amount) external onlyRole(REWARDS_NOTIFIER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        uint256 total = amount + undistributedRewards;
        totalNotified += amount;

        if (totalStaked != 0) {
            uint256 perShare = (total * SCALE) / totalStaked;
            if (perShare == 0) {
                // FR-9.6: never silently swallow a distribution; carry it forward instead.
                undistributedRewards = total;
                emit UndistributedCarried(total, total);
            } else {
                uint256 distributed = (perShare * totalStaked) / SCALE;
                undistributedRewards = total - distributed;
                rewardPerShareStored += perShare;
                if (undistributedRewards != 0) {
                    emit UndistributedCarried(total - distributed, undistributedRewards);
                }
            }
        } else {
            undistributedRewards = total;
            emit UndistributedCarried(total, total);
        }

        emit RewardsNotified(msg.sender, amount, totalNotified, totalStaked);
    }

    /**
     * @notice Pro-rata claimable reward for `account`, excluding matured principal.
     * @dev FR-9.4. View-only; computes the same accumulator delta `claim()` would.
     */
    function pendingRewards(address account) external view returns (uint256) {
        uint256 delta = rewardPerShareStored - paidPerShare[account];
        return credit[account] + (stakeOf[account] * delta) / SCALE;
    }

    /**
     * @notice Everything `claim()` would pay right now, split by kind.
     * @dev Convenience for the monitor and for tests; reverts are made visible up front.
     */
    function previewClaim(address account)
        external
        view
        returns (uint256 rewards, uint256 principal, uint256 claimableAt, uint256 total)
    {
        uint256 delta = rewardPerShareStored - paidPerShare[account];
        rewards = credit[account] + (stakeOf[account] * delta) / SCALE;
        principal = pendingUnstake[account];
        claimableAt = unstakeAvailableAt[account];
        total = rewards + (principal != 0 && block.timestamp >= claimableAt ? principal : 0);
    }

    /**
     * @notice Change the unstake cooldown.
     * @dev FR-9.5 / FR-9.7. Applies only to requests made after the change; in-flight requests
     *      keep the `availableAt` they were given, so a cooldown can never be shortened out
     *      from under an existing request.
     */
    function setCooldown(uint256 newCooldownSeconds) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newCooldownSeconds == 0 || newCooldownSeconds > 365 days) revert InvalidCooldown(newCooldownSeconds);
        uint256 previous = cooldownSeconds;
        cooldownSeconds = newCooldownSeconds;
        emit CooldownUpdated(previous, newCooldownSeconds);
    }

    /**
     * @notice Change the dust floor for the first active stake.
     * @dev Rounding safety: see the contract-level NatSpec.
     */
    function setMinStake(uint256 newMinStake) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newMinStake == 0) revert InvalidMinStake(newMinStake);
        uint256 previous = minStake;
        minStake = newMinStake;
        emit MinStakeUpdated(previous, newMinStake);
    }

    /**
     * @dev FR-9.6: fold `account`'s pro-rata delta into `credit` and advance its checkpoint.
     *      Called before every balance change so no stake can earn retroactively.
     */
    function _sync(address account) private {
        uint256 delta = rewardPerShareStored - paidPerShare[account];
        if (delta != 0) {
            uint256 earned = (stakeOf[account] * delta) / SCALE;
            if (earned != 0) {
                credit[account] += earned;
            }
            paidPerShare[account] = rewardPerShareStored;
        }
    }
}
