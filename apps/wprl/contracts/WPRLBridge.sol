// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "./WPRL.sol";

/**
 * @title WPRLBridge — custodial Pearl <-> Base bridge operator contract
 * @author Kyle Cox (@kshot9000)
 * @notice On-chain half of the wPRL custodial bridge (wBTC-style model).
 *
 * @dev HOW IT WORKS
 *      Deposit (Pearl -> Base, wrapped):
 *        1. User sends X PRL to the operator's Pearl vault address, PLUS the
 *           0.25% bridge fee as a separate output to Kyle's PRL fee address.
 *           (Fee on this leg is enforced off-chain by the operator when it
 *           verifies the deposit transaction.)
 *        2. The operator verifies the deposit on the Pearl chain, then calls
 *           mintDeposit(user, amountWei, pearlTxid). Each Pearl txid can only
 *           be used once (replay protection).
 *      Withdraw (Base -> Pearl, unwrapped):
 *        1. User approves the bridge and calls requestWithdraw(amountWei,
 *           prlRecipient). The contract takes the 0.25% fee in wPRL and sends
 *           it to feeRecipient, burns the remaining 99.75%, and emits
 *           WithdrawRequested.
 *        2. The operator watches for WithdrawRequested events and releases
 *           the net PRL (converted to grains) to prlRecipient on the Pearl chain.
 *
 * @dev FEES — 0.25% each way, defined once here:
 *      BRIDGE_FEE_BPS = 25 (basis points), denominator 10_000.
 *      - Pearl -> Base leg: fee paid in native PRL to
 *        prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d
 *        (enforced off-chain by the operator).
 *      - Base -> Pearl leg: fee taken in wPRL on-chain and sent to
 *        0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1 (Kyle's EVM address).
 *
 * @dev ACCOUNTING INVARIANT (1:1 backing target):
 *      wprl.totalSupply() == totalMinted - totalBurned   (always holds)
 *      Backing target: operator's Pearl vault balance in grains should equal
 *      wprl.totalSupply() / 1e10 grains. The proof-of-reserves dashboard
 *      checks this off-chain.
 *
 * @dev UNIT CONVERSION: 1 grain = 1e10 wei (see WPRL.sol NatSpec for proof).
 *      weiToGrains truncates sub-grain dust via integer division.
 */
contract WPRLBridge is AccessControl, Pausable {
    /// @notice The wPRL token this bridge mints/burns.
    WPRL public immutable wprl;

    /// @notice Role allowed to mint wPRL against verified Pearl deposits.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    /// @notice Bridge fee: 25 basis points = 0.25%, charged on every crossing.
    uint256 public constant BRIDGE_FEE_BPS = 25;
    /// @notice Basis-point denominator.
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Exact conversion: 1 grain (Pearl) = 1e10 wei (wPRL).
    uint256 public constant WEI_PER_GRAIN = 1e10;

    /// @notice Where Base-side fees go: Kyle's EVM address.
    address public immutable feeRecipient;

    /// @notice Cumulative wPRL minted against Pearl deposits (wei).
    uint256 public totalMinted;
    /// @notice Cumulative wPRL burned for Pearl releases (wei, net of fees).
    uint256 public totalBurned;
    /// @notice Monotonic withdrawal counter (also the event nonce).
    uint256 public withdrawNonce;

    /// @notice Pearl txids already used for a deposit (replay protection).
    mapping(bytes32 => bool) public usedPearlTxids;

    event DepositMinted(
        address indexed user,
        uint256 amountWei,
        uint256 amountGrains,
        bytes32 indexed pearlTxid
    );
    event WithdrawRequested(
        address indexed user,
        string prlRecipient,
        uint256 netWei,
        uint256 netGrains,
        uint256 feeWei,
        uint256 nonce
    );

    error ZeroAmount();
    error PearlTxidAlreadyUsed();
    error InvalidPrlAddress();

    /**
     * @param _wprl         Deployed WPRL token address.
     * @param admin         Address receiving DEFAULT_ADMIN_ROLE + OPERATOR_ROLE (Kyle).
     * @param _feeRecipient Address receiving Base-side wPRL fees (Kyle's EVM address).
     * @dev After deploying both contracts, the WPRL admin must grant MINTER_ROLE
     *      on the token to THIS bridge contract.
     */
    constructor(address _wprl, address admin, address _feeRecipient) {
        wprl = WPRL(_wprl);
        feeRecipient = _feeRecipient;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);
    }

    // ------------------------------------------------------------------
    // Deposits: Pearl -> Base
    // ------------------------------------------------------------------

    /**
     * @notice Mint wPRL to `user` after the operator verified a native PRL
     *         deposit (amount + 0.25% fee output) on the Pearl chain.
     * @param user       Recipient of the freshly minted wPRL (EVM address).
     * @param amountWei  Amount to mint, in wPRL wei (= grains * 1e10).
     * @param pearlTxid  Pearl deposit txid — each txid usable exactly once.
     */
    function mintDeposit(address user, uint256 amountWei, bytes32 pearlTxid)
        external
        onlyRole(OPERATOR_ROLE)
        whenNotPaused
    {
        if (amountWei == 0) revert ZeroAmount();
        if (usedPearlTxids[pearlTxid]) revert PearlTxidAlreadyUsed();
        usedPearlTxids[pearlTxid] = true;

        totalMinted += amountWei;
        wprl.mint(user, amountWei);

        emit DepositMinted(user, amountWei, weiToGrains(amountWei), pearlTxid);
    }

    // ------------------------------------------------------------------
    // Withdrawals: Base -> Pearl
    // ------------------------------------------------------------------

    /**
     * @notice Burn wPRL and request the equivalent native PRL (minus the
     *         0.25% fee) be released to `prlRecipient` on the Pearl chain.
     * @param amountWei    Total wPRL to unwrap (fee is taken from this).
     * @param prlRecipient Destination Pearl address — must be a mainnet
     *                     bech32m address starting with "prl1".
     * @dev Caller must approve the bridge for at least `amountWei` first.
     *      fee = amountWei * 25 / 10_000 -> feeRecipient (on-chain, in wPRL).
     *      net = amountWei - fee -> burned; operator releases net/1e10 grains.
     */
    function requestWithdraw(uint256 amountWei, string calldata prlRecipient)
        external
        whenNotPaused
    {
        if (amountWei == 0) revert ZeroAmount();
        if (!_isValidPrlAddress(prlRecipient)) revert InvalidPrlAddress();

        uint256 feeWei = (amountWei * BRIDGE_FEE_BPS) / BPS_DENOMINATOR;
        uint256 netWei = amountWei - feeWei;

        wprl.transferFrom(msg.sender, address(this), amountWei);
        if (feeWei > 0) {
            wprl.transfer(feeRecipient, feeWei);
        }
        wprl.burn(netWei);

        totalBurned += netWei;
        uint256 nonce = ++withdrawNonce;

        emit WithdrawRequested(
            msg.sender,
            prlRecipient,
            netWei,
            weiToGrains(netWei),
            feeWei,
            nonce
        );
    }

    // ------------------------------------------------------------------
    // Admin
    // ------------------------------------------------------------------

    /// @notice Pause deposits and withdrawals (admin only, emergency use).
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /// @notice Unpause deposits and withdrawals (admin only).
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ------------------------------------------------------------------
    // Pure helpers — exact unit conversion
    // ------------------------------------------------------------------

    /// @notice Convert Pearl grains to wPRL wei. Exact: wei = grains * 1e10.
    function grainsToWei(uint256 grains) public pure returns (uint256) {
        return grains * WEI_PER_GRAIN;
    }

    /// @notice Convert wPRL wei to Pearl grains. Truncates sub-grain dust.
    function weiToGrains(uint256 weiAmount) public pure returns (uint256) {
        return weiAmount / WEI_PER_GRAIN;
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    /**
     * @dev Guards against pasting an EVM address (or garbage) as the Pearl
     *      release destination. Pearl mainnet addresses are bech32m and start
     *      with "prl1" (see node/chaincfg/params.go Bech32HRPSegwit).
     */
    function _isValidPrlAddress(string calldata a) internal pure returns (bool) {
        bytes memory b = bytes(a);
        if (b.length < 8) return false; // "prl1" + at least a few data chars
        return b[0] == "p" && b[1] == "r" && b[2] == "l" && b[3] == "1";
    }
}
