// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IStaking
 * @notice House-edge pool surface consumed by `RakeSplitter.sol`
 *         (SRS §6, FR-9.4–9.6).
 */
interface IStaking {
    /// @notice Emitted once per rake distribution, before pro-rata accrual (FR-9.6).
    event RewardsNotified(address indexed source, uint256 amount, uint256 totalNotified, uint256 totalStaked);

    /// @notice Emitted on stake (FR-9.4).
    event Staked(address indexed account, uint256 amount, uint256 share);

    /// @notice Emitted when an unstake cooldown starts (FR-9.5).
    event UnstakeRequested(address indexed account, uint256 amount, uint256 availableAt);

    /// @notice Emitted when a cooldown is cancelled (FR-9.5).
    event UnstakeCancelled(address indexed account, uint256 amount);

    /// @notice Emitted when rewards are claimed (FR-9.4, FR-9.6).
    event Claimed(address indexed account, uint256 reward);

    /// @notice Emitted when cooled-down principal leaves the pool (FR-9.5).
    event Unstaked(address indexed account, uint256 amount);

    /// @notice Notify a rake distribution (called by `RakeSplitter.sol`).
    function notifyRewards(uint256 amount) external;

    /// @notice Total token currently earning yield.
    function totalStaked() external view returns (uint256);

    /// @notice Pro-rata claimable reward for `account`.
    function pendingRewards(address account) external view returns (uint256);
}
