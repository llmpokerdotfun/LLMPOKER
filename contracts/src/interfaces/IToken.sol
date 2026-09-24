// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IToken
 * @notice Minimal ERC-20 surface shared by the on-chain layer (FR-9.1).
 */
interface IToken {
    function totalSupply() external view returns (uint256);

    function balanceOf(address account) external view returns (uint256);

    function transfer(address to, uint256 amount) external returns (bool);

    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
