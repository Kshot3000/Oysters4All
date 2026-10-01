// Pearl Atlas bundle entry — re-exports the audited descriptor core plus the
// in-browser self-test. Assigns window.PearlDescriptor explicitly (no esbuild
// globalName: the IIFE wrapper would clobber it — see AGENTS.md).
import * as Core from "./descriptor-core.js";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { tapLeafHash, taggedHash } from "../../sign/src/crypto.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

export const version = 1;
export const ATTRIBUTION = {
  x: "@kshot9000",
  prl: "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d",
};

/**
 * Pinned self-test battery, runnable in the browser (Verify tab) and in node.
 * Every vector is independently checkable: official BIP-380/BIP-393 checksums,
 * a known-answer BIP-86 address, and control-block recomputation.
 */
export function selfTest() {
  const lines = [];
  const t = (name, cond, extra = "") => lines.push({ name, ok: !!cond, extra: String(extra) });
  try {
    // 1. Official BIP-380 checksum vectors
    t("BIP-380: raw(deadbeef) seals to #89f8spxm",
      Core.descChecksum("raw(deadbeef)") === "89f8spxm", Core.descChecksum("raw(deadbeef)"));
    // 2. Official BIP-393 vectors (checksums computed with the BIP-380 reference code)
    const wpkh393 = "wpkh([deadbeef/84h/0h/0h]xpub6ERApfZwUNrhLCkDtcHTcxd75RbzS1ed54G1LkBUHQVHQKqhMkhgbmJbZRkrgZw4koxb5JaHWkY4ALHY2grBGRjaDMzQLcgJvLJuZZvRcEL/0/*)#kf3v6fpx";
    t("BIP-393: wpkh vector checksum verifies", Core.descCheckChecksum(wpkh393).ok);
    const tr393 = "tr(xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ/0/*)#8e7pq23w";
    t("BIP-393: tr vector checksum verifies", Core.descCheckChecksum(tr393).ok);
    // 3. Known-answer BIP-86 address (abandon mnemonic, Pearl coin type 808276)
    const seed = mnemonicToSeedSync(
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
    const xpub = HDKey.fromMasterSeed(seed).derive("m/86'/808276'/0'").publicExtendedKey;
    const d0 = Core.deriveDescriptor(`tr([deadbeef/86h/808276h/0h]${xpub}/0/*)`, { index: 0 });
    t("BIP-86: index 0 derives the known prl1 address",
      d0.address === "prl1pr6yuq8u2r95wjzzgpdy8cpnncpl7l8zgy6x5q0367pnc53s2famqg7pt74", d0.address);
    // 4. Control blocks recompute to the same Merkle root the address commits to.
    //    Rebuild: root = fold TapBranch over (leafHash, control-block path),
    //    with the BIP-341 lexicographic ordering, and check the internal key.
    const d = Core.deriveDescriptor(`tr(${xpub}/0/*,pk(${xpub}/1/*))`, { index: 3 });
    let cbOk = d.leaves.length === 1;
    for (const leaf of d.leaves) {
      const c = hexToBytes(leaf.controlBlock);
      if (bytesToHex(c.slice(1, 33)) !== d.internalXOnly) { cbOk = false; break; }
      let h = tapLeafHash(hexToBytes(leaf.scriptHex));
      const path = c.slice(33);
      for (let o = 0; o < path.length; o += 32) {
        const sib = path.slice(o, o + 32);
        const [x, y] = bytesToHex(h) <= bytesToHex(sib) ? [h, sib] : [sib, h];
        const xy = new Uint8Array(64); xy.set(x, 0); xy.set(y, 32);
        h = taggedHash("TapBranch", xy);
      }
      if (bytesToHex(h) !== d.merkleRoot) { cbOk = false; break; }
    }
    t("control blocks recompute to the address Merkle root", cbOk,
      `leaves=${d.leaves.length} root=${String(d.merkleRoot).slice(0, 16)}…`);
    // 5. Multipath expansion (BIP-389)
    const ex = Core.expandDescriptorMultipath(`tr(${xpub}<0;1>/*)`);
    t("BIP-389: <0;1> expands to two descriptors", ex.length === 2, ex.length);
    // 6. Checksum round-trip
    const sealed = Core.descAddChecksum("wpkh(0260b2003c386519fc9eadf2b5cf124dd8eea4c4e68d5e154050a9346ea98ce600)");
    t("checksum round-trips (add then verify)", Core.descCheckChecksum(sealed).ok, sealed.slice(-9));
    // 7. Loud refusal on garbage
    let refused = false;
    try { Core.parseDescriptor("tr("); } catch { refused = true; }
    t("garbage descriptors are refused loudly", refused);
  } catch (e) {
    lines.push({ name: "self-test harness", ok: false, extra: String((e && e.message) || e) });
  }
  return { ok: lines.every((l) => l.ok), lines };
}

window.PearlDescriptor = { version, ATTRIBUTION, selfTest, ...Core };
