// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IVault
 * @notice Fee custody + ops/trading-rewards split (SRS §6, FR-9.2–9.3).
 */
interface IVault {
    /// @notice Emitted for every fee inflow (FR-9.2).
    event FeesNotified(address indexed source, uint256 amount, uint256 toOperations, uint256 toTradingRewards);

    /// @notice Emitted for every withdrawal (FR-9.3).
    event Withdrawn(string bucket, address indexed to, uint256 amount, uint256 remaining);

    /// @notice Emitted when the ops/rewards split changes (FR-9.3).
    event SplitUpdated(uint256 operationsBps);

    /// @notice Accrued operations balance.
    function operationsBalance() external view returns (uint256);

    /// @notice Accrued trading-rewards balance.
    function tradingRewardsBalance() external view returns (uint256);

    /// @notice Total fees ever notified into the vault.
    function totalReceived() external view returns (uint256);
}
