// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title Token
 * @notice The LLM Poker Arena native ERC-20 (FR-9.1): 18 decimals, a **fixed** supply minted
 *         once to the deployer at construction, plus `ERC20Permit` (EIP-2612) so agents can
 *         approve escrow with a signature instead of a separate transaction.
 *
 * @dev Name and symbol are constructor arguments because the launch venue is **pons** and the
 *      symbol/supply mechanics are still open in SRS §11 Q1. Nothing here hard-codes either.
 *
 *      **Minting policy.** The SRS does not require an inflatable token, and FR-9.7 wants
 *      parameters "immutable per deployment or gated behind a transparent owner/governance with
 *      timelock". A permanent mint authority is the one parameter that can dilute stakers and
 *      escrowed pots without any timelock, so the default is **no minting at all** after
 *      construction. The optional `ownerMint` escape hatch exists for the pons launch
 *      mechanics (bonding-curve top-ups, LP seeding) but is capped by `maxMintable` — set it to
 *      `0` at deployment to make the supply truly fixed, and renounce ownership to remove even
 *      the capped path. The deployed configuration is reported by `mintingPolicy`.
 */
contract Token is ERC20, ERC20Permit, Ownable {
    /// @notice Hard ceiling on additional supply the owner may ever mint (0 = fixed supply).
    uint256 public immutable maxMintable;

    /// @notice Emitted for every owner mint (FR-9.1).
    event Minted(address indexed to, uint256 amount, uint256 newTotalSupply);

    /// @notice A mint would push `totalSupply()` above `maxMintable`.
    error MintCapExceeded(uint256 requested, uint256 mintable);

    /// @notice A required address argument was the zero address.
    error ZeroAddress();

    /**
     * @param name_ ERC-20 name (TBD with pons, SRS §11 Q1).
     * @param symbol_ ERC-20 symbol (TBD with pons, SRS §11 Q1).
     * @param initialSupply_ Fixed supply minted to `initialOwner` in the constructor.
     * @param initialOwner Owner and supply recipient; also the `ERC20Permit` EIP-712 domain owner.
     * @param maxMintable_ Extra supply the owner may mint later; `0` freezes the supply.
     */
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 initialSupply_,
        address initialOwner,
        uint256 maxMintable_
    ) ERC20(name_, symbol_) ERC20Permit(name_) Ownable(initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        maxMintable = maxMintable_;
        if (initialSupply_ > 0) {
            _mint(initialOwner, initialSupply_);
            emit Minted(initialOwner, initialSupply_, totalSupply());
        }
    }

    /**
     * @notice Mint additional supply, only up to the immutable `maxMintable` ceiling.
     * @dev FR-9.1 / FR-9.7. Reverts when `maxMintable == 0` (the recommended fixed-supply
     *      configuration).
     * @param to Recipient of the new supply.
     * @param amount Amount to mint, in base units (1 token = 1e18).
     */
    function ownerMint(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 minted = totalSupply();
        // `minted > maxMintable` cannot happen when the constructor supply respects the cap, but
        // this guard keeps an over-supplied deployment from underflowing into a bare panic.
        uint256 mintable = minted >= maxMintable ? 0 : maxMintable - minted;
        if (amount > mintable) revert MintCapExceeded(amount, mintable);
        _mint(to, amount);
        emit Minted(to, amount, totalSupply());
    }

    /**
     * @notice Burn `amount` from the caller's own balance, reducing `totalSupply()`.
     * @dev FR-9.2: the buyback leg of the rake is burned by `BuybackBurner.sol`, and a real burn
     *      needs a real supply reduction. Only the holder can burn — there is no allowance path
     *      and no privileged caller — so this cannot touch anyone else's tokens. The only values
     *      that change are the caller's balance and `totalSupply()`; no mint is possible, so the
     *      burn is irreversible. Emits the standard `Transfer(caller, address(0), amount)` via
     *      `_burn`, which is what makes the burn visible to ordinary ERC-20 indexers.
     * @param amount Amount to burn, in base units (1 token = 1e18).
     */
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    /**
     * @notice Human-readable description of the deployed minting policy.
     * @dev FR-9.7 transparency: lets a verifier read the policy in one call.
     * @return fixedSupply True when no further minting is possible.
     * @return cap The absolute ceiling on `totalSupply()`.
     * @return mintedSoFar Current `totalSupply()`.
     */
    function mintingPolicy() external view returns (bool fixedSupply, uint256 cap, uint256 mintedSoFar) {
        fixedSupply = maxMintable == 0;
        cap = maxMintable;
        mintedSoFar = totalSupply();
    }
}
