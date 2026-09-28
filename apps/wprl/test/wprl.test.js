// wPRL Phase 1 test suite — node:test + node:assert + ethers v6
// Run: npx hardhat test
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { network } from "hardhat";
import { ethers } from "ethers";
import WPRLArtifact from "../artifacts/contracts/WPRL.sol/WPRL.json" with { type: "json" };
import BridgeArtifact from "../artifacts/contracts/WPRLBridge.sol/WPRLBridge.json" with { type: "json" };

// Kyle's addresses (from the project spec — do not change without his say-so)
const KYLE_EVM = "0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1";
const KYLE_PRL = "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d";

const WEI_PER_WPRL = 10n ** 18n; // 1 wPRL = 1e18 wei (18 decimals)
const WEI_PER_GRAIN = 10n ** 10n; // 1 grain = 1e10 wei (1 PRL = 1e8 grains)
const FEE_BPS = 25n; // 0.25%

const feeOf = (amount) => (amount * FEE_BPS) / 10000n;
const txid = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));


/** 4-byte selector of a custom-error signature, for matching revert data. */
const errSel = (sig) => ethers.id(sig).slice(0, 10);

const ERR = {
  access: errSel("AccessControlUnauthorizedAccount(address,bytes32)"),
  paused: errSel("EnforcedPause()"),
  allowance: errSel("ERC20InsufficientAllowance(address,uint256,uint256)"),
  replay: errSel("PearlTxidAlreadyUsed()"),
  zero: errSel("ZeroAmount()"),
  badPrl: errSel("InvalidPrlAddress()"),
};

/**
 * Assert that an ethers call reverts with an error whose message matches `pattern`.
 * (node:assert's rejects() misbehaves with ethers' thenables, so we do it manually.)
 */
async function expectRevert(promise, pattern) {
  try {
    await promise;
  } catch (e) {
    assert.match(String((e && e.message) || e), pattern instanceof RegExp ? pattern : new RegExp(pattern.slice(2)));
    return;
  }
  assert.fail("expected call to revert, but it succeeded");
}

describe("wPRL — Wrapped Pearl (Phase 1 contracts)", () => {
  let provider, owner, operator, alice, bob;
  let ownerAddr, operatorAddr, aliceAddr, bobAddr, bridgeAddr;
  let wprl, bridge;

  beforeEach(async () => {
    const connection = await network.create();
    provider = new ethers.BrowserProvider(connection.provider);
    [owner, operator, alice, bob] = [
      await provider.getSigner(0),
      await provider.getSigner(1),
      await provider.getSigner(2),
      await provider.getSigner(3),
    ];
    [ownerAddr, operatorAddr, aliceAddr, bobAddr] = await Promise.all([
      owner.getAddress(), operator.getAddress(), alice.getAddress(), bob.getAddress(),
    ]);

    const wprlFactory = new ethers.ContractFactory(WPRLArtifact.abi, WPRLArtifact.bytecode, owner);
    wprl = await wprlFactory.deploy(ownerAddr);
    await wprl.waitForDeployment();

    const bridgeFactory = new ethers.ContractFactory(BridgeArtifact.abi, BridgeArtifact.bytecode, owner);
    bridge = await bridgeFactory.deploy(await wprl.getAddress(), ownerAddr, KYLE_EVM);
    await bridge.waitForDeployment();
    bridgeAddr = await bridge.getAddress();

    // Wire the bridge as the token minter (the only MINTER_ROLE holder)
    const MINTER_ROLE = await wprl.MINTER_ROLE();
    await (await wprl.connect(owner).grantRole(MINTER_ROLE, bridgeAddr)).wait();
    // Separate operator key for day-to-day minting
    const OPERATOR_ROLE = await bridge.OPERATOR_ROLE();
    await (await bridge.connect(owner).grantRole(OPERATOR_ROLE, operatorAddr)).wait();
  });

  // ------------------------------------------------------------------
  describe("deployment & branding", () => {
    it("token is named 'Wrapped Pearl' / 'wPRL' with 18 decimals", async () => {
      assert.equal(await wprl.name(), "Wrapped Pearl");
      assert.equal(await wprl.symbol(), "wPRL");
      assert.equal(await wprl.decimals(), 18n);
    });

    it("bridge wires the right token, fee recipient and fee constants", async () => {
      assert.equal(await bridge.wprl(), await wprl.getAddress());
      assert.equal(await bridge.feeRecipient(), KYLE_EVM);
      assert.equal(await bridge.BRIDGE_FEE_BPS(), 25n);
      assert.equal(await bridge.BPS_DENOMINATOR(), 10000n);
      assert.equal(await bridge.WEI_PER_GRAIN(), WEI_PER_GRAIN);
    });

    it("owner holds admin roles; bridge is the sole token minter", async () => {
      const DEFAULT_ADMIN = await wprl.DEFAULT_ADMIN_ROLE();
      const MINTER_ROLE = await wprl.MINTER_ROLE();
      assert.equal(await wprl.hasRole(DEFAULT_ADMIN, ownerAddr), true);
      assert.equal(await wprl.hasRole(MINTER_ROLE, bridgeAddr), true);
      assert.equal(await wprl.hasRole(MINTER_ROLE, ownerAddr), false);
    });
  });

  // ------------------------------------------------------------------
  describe("unit conversion helpers (exact grain math)", () => {
    it("grainsToWei: 1e8 grains == 1 wPRL == 1e18 wei", async () => {
      assert.equal(await bridge.grainsToWei(100_000_000n), WEI_PER_WPRL);
    });

    it("grainsToWei: 1 grain == 1e10 wei", async () => {
      assert.equal(await bridge.grainsToWei(1n), WEI_PER_GRAIN);
    });

    it("weiToGrains: 1e18 wei == 1e8 grains", async () => {
      assert.equal(await bridge.weiToGrains(WEI_PER_WPRL), 100_000_000n);
    });

    it("weiToGrains truncates sub-grain dust", async () => {
      assert.equal(await bridge.weiToGrains(WEI_PER_GRAIN - 1n), 0n);
      assert.equal(await bridge.weiToGrains(WEI_PER_GRAIN + (WEI_PER_GRAIN - 1n)), 1n);
    });

    it("round-trips whole-grain amounts exactly", async () => {
      const grains = 123456789n;
      const wei = await bridge.grainsToWei(grains);
      assert.equal(await bridge.weiToGrains(wei), grains);
    });
  });

  // ------------------------------------------------------------------
  describe("mintDeposit (Pearl -> Base)", () => {
    it("operator mints wPRL 1:1 and emits DepositMinted", async () => {
      const amount = WEI_PER_WPRL; // 1 PRL deposit
      const id = txid("pearl-deposit-tx-1");
      const tx = await bridge.connect(operator).mintDeposit(aliceAddr, amount, id);
      const receipt = await tx.wait();
      const events = await bridge.queryFilter(
        bridge.filters.DepositMinted(), receipt.blockNumber, receipt.blockNumber
      );
      assert.equal(events.length, 1);
      assert.equal(events[0].args.user, aliceAddr);
      assert.equal(events[0].args.amountWei, amount);
      assert.equal(events[0].args.amountGrains, 100_000_000n);
      assert.equal(events[0].args.pearlTxid, id);
      assert.equal(await wprl.balanceOf(aliceAddr), amount);
      assert.equal(await bridge.totalMinted(), amount);
    });

    it("non-operator cannot mint", async () => {
      await expectRevert(
        bridge.connect(alice).mintDeposit(aliceAddr, WEI_PER_WPRL, txid("x")),
        ERR.access
      );
    });

    it("same Pearl txid cannot be reused (replay protection)", async () => {
      const id = txid("replay-me");
      await (await bridge.connect(operator).mintDeposit(aliceAddr, WEI_PER_WPRL, id)).wait();
      await expectRevert(
        bridge.connect(operator).mintDeposit(bobAddr, WEI_PER_WPRL, id),
        ERR.replay
      );
    });

    it("zero amount reverts", async () => {
      await expectRevert(
        bridge.connect(operator).mintDeposit(aliceAddr, 0n, txid("z")),
        ERR.zero
      );
    });

    it("direct token mint by non-minter reverts", async () => {
      await expectRevert(
        wprl.connect(alice).mint(aliceAddr, 100n),
        ERR.access
      );
    });
  });

  // ------------------------------------------------------------------
  describe("requestWithdraw (Base -> Pearl)", () => {
    const fund = async (to, amount) => {
      const id = txid(`dep-${to}-${amount}-${Math.random()}`);
      await (await bridge.connect(operator).mintDeposit(to, amount, id)).wait();
    };

    beforeEach(async () => {
      await fund(aliceAddr, 10n * WEI_PER_WPRL);
      await (await wprl.connect(alice).approve(bridgeAddr, 10n * WEI_PER_WPRL)).wait();
    });

    it("takes exactly 0.25% fee to Kyle's EVM address, burns the net", async () => {
      const amount = WEI_PER_WPRL; // 1 wPRL
      const expectedFee = feeOf(amount); // 0.0025 wPRL
      const expectedNet = amount - expectedFee;

      const kyleBefore = await wprl.balanceOf(KYLE_EVM);
      const supplyBefore = await wprl.totalSupply();

      const tx = await bridge.connect(alice).requestWithdraw(amount, KYLE_PRL);
      const receipt = await tx.wait();
      const events = await bridge.queryFilter(
        bridge.filters.WithdrawRequested(), receipt.blockNumber, receipt.blockNumber
      );
      assert.equal(events.length, 1);
      const a = events[0].args;
      assert.equal(a.user, aliceAddr);
      assert.equal(a.prlRecipient, KYLE_PRL);
      assert.equal(a.netWei, expectedNet);
      assert.equal(a.netGrains, expectedNet / WEI_PER_GRAIN);
      assert.equal(a.feeWei, expectedFee);
      assert.equal(a.nonce, 1n);

      assert.equal(await wprl.balanceOf(KYLE_EVM), kyleBefore + expectedFee);
      assert.equal(await wprl.totalSupply(), supplyBefore - expectedNet);
      assert.equal(await bridge.totalBurned(), expectedNet);
      assert.equal(await bridge.withdrawNonce(), 1n);
    });

    it("fee math is exact on several amounts", async () => {
      const cases = [400n, 10n ** 12n, 10n * WEI_PER_WPRL, 1_000_000n * WEI_PER_WPRL];
      for (const amount of cases) {
        await fund(bobAddr, amount);
        await (await wprl.connect(bob).approve(bridgeAddr, amount)).wait();
        const kyleBefore = await wprl.balanceOf(KYLE_EVM);
        await (await bridge.connect(bob).requestWithdraw(amount, KYLE_PRL)).wait();
        assert.equal(await wprl.balanceOf(KYLE_EVM), kyleBefore + feeOf(amount));
      }
    });

    it("rejects non-Pearl recipient addresses", async () => {
      const bad = ["", "0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "prl", "prl1"];
      for (const a of bad) {
        await expectRevert(
          bridge.connect(alice).requestWithdraw(WEI_PER_WPRL, a),
        ERR.badPrl
      );
      }
    });

    it("zero amount reverts", async () => {
      await expectRevert(
        bridge.connect(alice).requestWithdraw(0n, KYLE_PRL),
        ERR.zero
      );
    });

    it("reverts without allowance", async () => {
      await (await wprl.connect(alice).approve(bridgeAddr, 0n)).wait();
      await expectRevert(
        bridge.connect(alice).requestWithdraw(WEI_PER_WPRL, KYLE_PRL),
        ERR.allowance
      );
    });

    it("accounting invariant holds: supply == totalMinted - totalBurned", async () => {
      await fund(bobAddr, 5n * WEI_PER_WPRL);
      await (await wprl.connect(bob).approve(bridgeAddr, 5n * WEI_PER_WPRL)).wait();
      await (await bridge.connect(alice).requestWithdraw(2n * WEI_PER_WPRL, KYLE_PRL)).wait();
      await (await bridge.connect(bob).requestWithdraw(1n * WEI_PER_WPRL, KYLE_PRL)).wait();

      const [minted, burned, supply] = await Promise.all([
        bridge.totalMinted(), bridge.totalBurned(), wprl.totalSupply(),
      ]);
      assert.equal(supply, minted - burned);
    });
  });

  // ------------------------------------------------------------------
  describe("pause & role administration", () => {
    it("admin can pause; deposits and withdrawals revert while paused", async () => {
      const id = txid("pause-test");
      await (await bridge.connect(owner).pause()).wait();
      assert.equal(await bridge.paused(), true);

      // While paused, both directions revert with EnforcedPause.
      const pausedRe = new RegExp(ERR.paused.slice(2));
      for (const call of [
        () => bridge.connect(operator).mintDeposit(aliceAddr, WEI_PER_WPRL, id),
        () => bridge.connect(alice).requestWithdraw(WEI_PER_WPRL, KYLE_PRL),
      ]) {
        let reverted = false;
        try { await call(); } catch (e) {
          reverted = true;
          assert.match(String((e && e.message) || e), pausedRe);
        }
        assert.equal(reverted, true, "expected call to revert while paused");
      }

      await (await bridge.connect(owner).unpause()).wait();
      assert.equal(await bridge.paused(), false);

      // NOTE: explicit gasLimit below works around an EDR (Hardhat in-process
      // chain) eth_estimateGas quirk: after a pause->unpause cycle, estimateGas
      // evaluates against stale (still-paused) state while eth_call and real
      // mining see the correct unpaused state (verified: same tx mines fine
      // with explicit gas). Contract behavior is correct; this is test-env only.
      const txr = await bridge
        .connect(operator)
        .mintDeposit(aliceAddr, WEI_PER_WPRL, id, { gasLimit: 300000n });
      await txr.wait();
      assert.equal(await wprl.balanceOf(aliceAddr), WEI_PER_WPRL);
    });

    it("non-admin cannot pause", async () => {
      await expectRevert(bridge.connect(alice).pause(), ERR.access);
    });

    it("revoking OPERATOR_ROLE disables minting", async () => {
      const OPERATOR_ROLE = await bridge.OPERATOR_ROLE();
      await (await bridge.connect(owner).revokeRole(OPERATOR_ROLE, operatorAddr)).wait();
      await expectRevert(
        bridge.connect(operator).mintDeposit(aliceAddr, WEI_PER_WPRL, txid("r")),
        ERR.access
      );
    });

    it("revoking bridge MINTER_ROLE on the token disables minting", async () => {
      const MINTER_ROLE = await wprl.MINTER_ROLE();
      await (await wprl.connect(owner).revokeRole(MINTER_ROLE, bridgeAddr)).wait();
      await expectRevert(
        bridge.connect(operator).mintDeposit(aliceAddr, WEI_PER_WPRL, txid("r2")),
        ERR.access
      );
    });
  });
});
