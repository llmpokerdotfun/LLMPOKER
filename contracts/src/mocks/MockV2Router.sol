// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockV2Router
 * @notice Test-only Uniswap-v2-shaped router: pulls the input token, sends a fixed-rate amount of
 *         the output token, and honours `amountOutMin` and `deadline` exactly like the real one.
 *
 * @dev This is a test fixture. It exists so the suite can exercise `BuybackBurner.execute` against
 *      the real `swapExactTokensForTokens` call shape — amount checks, deadline checks, approval
 *      consumption, SCTF-revert on slippage — without a fork. It performs no pricing and holds no
 *      protocol logic; the rate is a single storage value set by the test.
 */
contract MockV2Router is Ownable {
    using SafeERC20 for IERC20;

    /// @notice Output units per 1e18 of input (1e18 = 1:1).
    uint256 public rate;
    /// @notice Last deadline observed, so tests can assert the burner passed one.
    uint256 public lastDeadline;
    /// @notice Last `amountOutMin` observed.
    uint256 public lastAmountOutMin;
    /// @notice Number of swaps executed.
    uint256 public swapCount;

    /// @notice The swap reverted because the output would be below `amountOutMin`.
    error InsufficientOutputAmount(uint256 amountOut, uint256 amountOutMin);
    /// @notice The swap reverted because the deadline passed (mirrors the v2 router).
    error Expired(uint256 deadline);
    /// @notice The route does not have exactly two hops in the expected direction.
    error InvalidPath(address[] path);

    /// @param initialOwner Owner that may retune `rate`.
    /// @param initialRate Output per 1e18 input.
    constructor(address initialOwner, uint256 initialRate) Ownable(initialOwner) {
        rate = initialRate;
    }

    /// @notice Set the conversion rate (owner only).
    function setRate(uint256 newRate) external onlyOwner {
        rate = newRate;
    }

    /**
     * @notice Pull `amountIn` of `path[0]`, send `amountIn * rate / 1e18` of `path[1]` to `to`.
     * @dev Mirrors the v2 signature and its two guard reverts, which is all `BuybackBurner` relies
     *      on: a bad trade must revert rather than execute.
     */
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        if (deadline < block.timestamp) revert Expired(deadline);
        if (path.length != 2) revert InvalidPath(path);
        if (to == address(0)) revert InvalidPath(path);

        lastDeadline = deadline;
        lastAmountOutMin = amountOutMin;

        uint256 amountOut = _convert(path[0], path[1], amountIn);
        if (amountOut < amountOutMin) revert InsufficientOutputAmount(amountOut, amountOutMin);

        IERC20(path[0]).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(path[1]).safeTransfer(to, amountOut);

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOut;
        swapCount += 1;
    }

    /// @notice Conversion a route would produce right now, for test-side expectations.
    function quote(address tokenIn, address tokenOut, uint256 amountIn) external view returns (uint256) {
        return _convert(tokenIn, tokenOut, amountIn);
    }

    /**
     * @dev `amountIn * rate / 1e18`, rescaled by `10^(decimalsOut - decimalsIn)` so `rate` reads
     *      as "output tokens per input token" (`rate = 1e18` is 1:1) regardless of decimals. A
     *      real router does the same job through pool reserves; this keeps the fixture's expected
     *      values legible for a 6-decimal input and an 18-decimal output.
     */
    function _convert(address tokenIn, address tokenOut, uint256 amountIn) private view returns (uint256) {
        uint256 base = (amountIn * rate) / 1e18;
        uint8 decimalsIn = IERC20Metadata(tokenIn).decimals();
        uint8 decimalsOut = IERC20Metadata(tokenOut).decimals();
        if (decimalsOut > decimalsIn) return base * (10 ** (decimalsOut - decimalsIn));
        return base / (10 ** (decimalsIn - decimalsOut));
    }
}
