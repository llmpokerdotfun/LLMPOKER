// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @title IBuybackDex
 * @notice Minimal DEX surfaces the `BuybackBurner` needs (SRS §6, FR-9.2). Deliberately
 *         Uniswap-v2-shaped (`swapExactTokensForTokens`) because the router address is supplied
 *         later and v2-style routers are what `SRS §11` anticipates.
 */
interface IBuybackDex {
    /**
     * @notice Swap an exact input amount along `path`, returning the amounts, input first.
     * @param amountIn Exact input amount.
     * @param amountOutMin Minimum acceptable output (slippage floor).
     * @param path Token route; first entry is the input token, last is the output token.
     * @param to Recipient of the output.
     * @param deadline Unix seconds after which the swap reverts.
     * @return amounts Amount at each hop, `amounts[0] == amountIn`, last entry the output.
     */
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/**
 * @title IERC20Burnable
 * @notice Minimal burn surface of `Token.sol`, used by `BuybackBurner` (FR-9.2).
 */
interface IERC20Burnable {
    /// @notice Burn `amount` from the caller's own balance; total supply and the caller's balance
    ///         are the only values that change.
    function burn(uint256 amount) external;
}
