// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockDecimalsToken
 * @notice Test-only ERC-20 with **configurable decimals**, used to model USDG (6 decimals) in the
 *         contract test suite and in `scripts/deploy.ts` dry runs.
 *
 * @dev This is a test fixture, not a product contract: it holds no business logic, has no owner
 *      and no supply policy. It exists so the suite can prove that every money path is
 *      decimal-agnostic — USDG (6) and LLMPOKER (18) both flow through `Poker`, `RakeSplitter`
 *      and `BuybackBurner` in base units. The real USDG address is supplied at deploy time
 *      (`USDG_ADDRESS`) and is never hard-coded anywhere in `src/`.
 */
contract MockDecimalsToken is ERC20 {
    uint8 private immutable _decimals;

    /**
     * @param name_ ERC-20 name.
     * @param symbol_ ERC-20 symbol.
     * @param decimals_ Decimals reported by `decimals()` (6 for USDG, 18 for LLMPOKER).
     */
    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    /// @notice Decimals of this mock, fixed at construction.
    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /**
     * @notice Mint `amount` to `to`. Open by design: the mock is only ever deployed on a test
     *         network where every caller is already trusted with the whole chain.
     * @param to Recipient.
     * @param amount Amount, in base units.
     */
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
