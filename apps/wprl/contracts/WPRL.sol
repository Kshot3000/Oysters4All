// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title wPRL — Wrapped Pearl
 * @author Kyle Cox (@kshot9000)
 * @notice ERC-20 representation of native PRL (Pearl Proof-of-Useful-Work L1)
 *         for EVM chains (Base, chain id 8453).
 *
 * @dev Branding: "wPRL — Wrapped Pearl (Pearl PoUW L1)". This token wraps the
 *      native PRL of the Pearl L1 (pearl-research-labs/pearl). It is NOT
 *      affiliated with any other token using the "PRL" ticker (e.g. Oyster
 *      Pearl, Perle on Solana, or any copycat). Always verify the contract
 *      address against the official deployment record.
 *
 * @dev UNIT CONVERSION (exact — verified against upstream):
 *      Pearl's smallest unit is the *grain*:
 *        1 PRL = 100,000,000 grains
 *        (GrainPerPearl = 1e8, pearl-research-labs/pearl, node/btcutil/const.go)
 *      wPRL uses the ERC-20 standard 18 decimals:
 *        1 wPRL = 10^18 wei
 *      Therefore:
 *        1 grain = 10^18 / 10^8 = 10^10 wei
 *        grains -> wei: wei = grains * 1e10            (exact)
 *        wei -> grains: grains = wei / 1e10            (integer division;
 *                                                     sub-grain dust is truncated)
 *
 * @dev TRUST MODEL (custodial, wBTC-style — read before use):
 *      Minting and burning are restricted to MINTER_ROLE, held by the
 *      WPRLBridge operator contract (whose OPERATOR_ROLE is held by the
 *      bridge operator). Native PRL backing is held off-chain in the
 *      operator's Pearl vault; there is no on-chain proof of reserves in
 *      this MVP. Users trust the operator to (a) hold 1:1 backing and
 *      (b) release native PRL when wPRL is burned. A public proof-of-reserves
 *      dashboard is part of the launch plan. This is NOT a trustless bridge.
 */
contract WPRL is ERC20, AccessControl {
    /// @notice Role allowed to mint new wPRL and burn wPRL. Held by the bridge contract.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /**
     * @param admin Address receiving DEFAULT_ADMIN_ROLE (Kyle's EVM address).
     *              The admin grants MINTER_ROLE to the bridge contract after deployment.
     */
    constructor(address admin) ERC20("Wrapped Pearl", "wPRL") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /**
     * @notice Mint `amount` wei of wPRL to `to`. Only the bridge (MINTER_ROLE).
     * @dev 1:1 backed — the operator must have verified a native PRL deposit
     *      of `amount / 1e10` grains before calling.
     */
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    /**
     * @notice Burn `amount` wei of wPRL from the caller's own balance.
     *         Only the bridge (MINTER_ROLE) — used during withdrawals.
     */
    function burn(uint256 amount) external onlyRole(MINTER_ROLE) {
        _burn(msg.sender, amount);
    }
}
