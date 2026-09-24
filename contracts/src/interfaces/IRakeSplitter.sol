// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IRakeSplitter
 * @notice Interface between `Poker.sol` (rake source) and `RakeSplitter.sol`
 *         (SRS §6, FR-8.2, FR-9).
 *
 * @dev The token is an argument on every money entry point because a wager table settles in the
 *      currency it was created with: USDG (6 decimals) or LLMPOKER (18 decimals). See
 *      `RakeSplitter` for the per-token accounting and the deterministic remainder rule.
 */
interface IRakeSplitter {
    /// @notice Emitted for every rake distribution (FR-9.6).
    /// @param source Address that pushed the rake (`Poker.sol`).
    /// @param token Settlement token the rake arrived in.
    /// @param total Total rake received, in base units.
    /// @param buybackShare Amount credited to the buyback-and-burn beneficiary.
    /// @param stakingShare Amount credited to the staking pool.
    /// @param totalDistributed Cumulative rake received in `token` since deployment.
    event RakeDistributed(
        address indexed source,
        address indexed token,
        uint256 total,
        uint256 buybackShare,
        uint256 stakingShare,
        uint256 totalDistributed
    );

    /// @notice Emitted when a beneficiary sweeps its accrued share.
    /// @param token Token swept.
    /// @param beneficiary Receiving role (staking pool or buyback burner).
    /// @param to Recipient of the transfer.
    /// @param amount Amount swept.
    event Swept(address indexed token, address indexed beneficiary, address indexed to, uint256 amount);

    /// @notice Accept a rake payment from the poker contract (FR-8.2).
    /// @dev Pull-based: `Poker.sol` must have transferred `amount` of `token` to this contract
    ///      first, and no allowance is required.
    /// @param token Settlement token the rake arrived in.
    /// @param amount Rake amount, in base units.
    function receiveRake(IERC20 token, uint256 amount) external;

    /// @notice Amount of `token` currently owed to `beneficiary` and not yet swept.
    function pendingOf(IERC20 token, address beneficiary) external view returns (uint256);

    /// @notice Cumulative amount of `token` credited to `beneficiary`.
    function totalCreditedTo(IERC20 token, address beneficiary) external view returns (uint256);

    /// @notice The only address allowed to push rake (the poker contract).
    function poker() external view returns (address);
}
