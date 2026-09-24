// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IRakeSplitter
 * @notice Interface between `Poker.sol` (rake source) and `RakeSplitter.sol`
 *         (SRS §6, FR-8.2).
 */
interface IRakeSplitter {
    /// @notice Emitted for every rake distribution (FR-9.6).
    /// @param source Address that pushed the rake (`Poker.sol`).
    /// @param total Total rake received.
    /// @param stakingShare Amount owed to the staking pool.
    /// @param vaultShare Amount owed to the vault.
    /// @param totalDistributed Cumulative rake received since deployment.
    event RakeDistributed(
        address indexed source,
        uint256 total,
        uint256 stakingShare,
        uint256 vaultShare,
        uint256 totalDistributed
    );

    /// @notice Emitted when a beneficiary sweeps its accrued share.
    /// @param beneficiary `staking` or `vault`.
    /// @param to Recipient of the transfer.
    /// @param amount Amount swept.
    event Swept(address indexed beneficiary, address indexed to, uint256 amount);

    /// @notice Accept a rake payment from the poker contract (FR-8.2).
    /// @dev Pull-based: `Poker.sol` must have transferred the tokens first and approved this
    ///      contract for `amount`.
    function receiveRake(uint256 amount) external;

    /// @notice Amount currently owed to `beneficiary` and not yet swept.
    function pendingOf(address beneficiary) external view returns (uint256);

    /// @notice Cumulative rake received since deployment.
    function totalReceived() external view returns (uint256);

    /// @notice Cumulative amount credited to `beneficiary`.
    function totalCreditedTo(address beneficiary) external view returns (uint256);

    /// @notice The only address allowed to push rake (the poker contract).
    function poker() external view returns (address);
}
