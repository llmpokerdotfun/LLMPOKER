// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IBuybackBurner
 * @notice Interface between `RakeSplitter.sol` (fee source) and `BuybackBurner.sol`
 *         (SRS §6, FR-8.2, FR-9.2).
 */
interface IBuybackBurner {
    /**
     * @notice Credit `amount` of `token` as pending buyback fees, to be converted into LLMPOKER
     *         and burned by a later permissionless `execute`.
     * @dev The caller must have transferred the tokens first (push-free, allowance-free credit).
     * @param token Fee token, in base units.
     * @param amount Fee amount, in base units.
     */
    function receiveFees(address token, uint256 amount) external;

    /// @notice Pending (credited, not yet executed) fees for `token`.
    function pendingOf(address token) external view returns (uint256);

    /// @notice Cumulative fees ever credited for `token`.
    function totalFeesReceived(address token) external view returns (uint256);
}
