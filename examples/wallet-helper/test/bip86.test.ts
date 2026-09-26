/**
 * Known-answer tests against the official BIP-86 test vectors
 * (https://github.com/bitcoin/bips/blob/master/bip-0086.mediawiki,
 * "Test vectors" section).
 *
 * These validate the ENTIRE pipeline — BIP-39 seed, BIP-32 derivation,
 * lift_x parity handling, TapTweak, and bech32m encoding — against values
 * published by the BIP author. Pearl uses the same math with its own coin
 * types (808276 mainnet / 1 testnets) and HRPs (prl/tprl/rprl).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mnemonicToSeedSync } from 'bip39';
import {
  deriveAddressFromMnemonic,
  derivePath,
  encodeSegwitAddress,
  internalKeyFromPriv,
  masterKeyFromSeed,
  serializeXprv,
  serializeXpub,
  taprootOutputKey,
  validatePearlAddress,
  getNetwork,
} from '../src/index.js';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function hex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

describe('BIP-86 official test vectors (coin type 0)', () => {
  const seed = mnemonicToSeedSync(MNEMONIC);
  const master = masterKeyFromSeed(seed);

  it('account root m/86\'/0\'/0\' matches vector xprv/xpub', () => {
    const acct = derivePath(master, "m/86'/0'/0'");
    assert.equal(
      serializeXprv(acct, false),
      'xprv9xgqHN7yz9MwCkxsBPN5qetuNdQSUttZNKw1dcYTV4mkaAFiBVGQziHs3NRSWMkCzvgjEe3n9xV8oYywvM8at9yRqyaZVz6TYYhX98VjsUk',
    );
    assert.equal(
      serializeXpub(acct, false),
      'xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92pReUsQ',
    );
  });

  const cases = [
    {
      path: "m/86'/0'/0'/0/0",
      internalKey: 'cc8a4bc64d897bddc5fbc2f670f7a8ba0b386779106cf1223c6fc5d7cd6fc115',
      outputKey: 'a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c',
      address: 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr',
    },
    {
      path: "m/86'/0'/0'/0/1",
      internalKey: '83dfe85a3151d2517290da461fe2815591ef69f2b18a2ce63f01697a8b313145',
      outputKey: 'a82f29944d65b86ae6b5e5cc75e294ead6c59391a1edc5e016e3498c67fc7bbb',
      address: 'bc1p4qhjn9zdvkux4e44uhx8tc55attvtyu358kutcqkudyccelu0was9fqzwh',
    },
    {
      path: "m/86'/0'/0'/1/0",
      internalKey: '399f1b2f4393f29a18c937859c5dd8a77350103157eb880f02e8c08214277cef',
      outputKey: '882d74e5d0572d5a816cef0041a96b6c1de832f6f9676d9605c44d5e9a97d3dc',
      address: 'bc1p3qkhfews2uk44qtvauqyr2ttdsw7svhkl9nkm9s9c3x4ax5h60wqwruhk7',
    },
  ];

  for (const c of cases) {
    it(`${c.path} → internal/output key + address`, () => {
      const key = derivePath(master, c.path);
      const internal = internalKeyFromPriv(key.priv);
      assert.equal(hex(internal), c.internalKey, 'internal key mismatch');
      const output = taprootOutputKey(internal);
      assert.equal(hex(output), c.outputKey, 'tweaked output key mismatch');
      // Encode with the vector's HRP (bc) — the bech32m codec itself is
      // network-agnostic; Pearl just uses prl/tprl/rprl.
      assert.equal(encodeSegwitAddress('bc', 1, output), c.address);
    });
  }
});

describe('Pearl BIP-86 derivation', () => {
  it('mainnet m/86\'/808276\'/0\'/0/0 → valid prl1p P2TR address', () => {
    const d = deriveAddressFromMnemonic(MNEMONIC, { network: 'mainnet' });
    assert.equal(d.path, "m/86'/808276'/0'/0/0");
    assert.match(d.address, /^prl1p/);
    const info = validatePearlAddress(d.address);
    assert.equal(info.network.name, 'mainnet');
    assert.equal(info.version, 1);
    assert.equal(info.program.length, 32);
    assert.equal(info.isP2TR, true);
    assert.equal(info.variant, 'bech32m');
  });

  it('testnet m/86\'/1\'/0\'/0/0 → valid tprl1p address, distinct from mainnet', () => {
    const main = deriveAddressFromMnemonic(MNEMONIC, { network: 'mainnet' });
    const test = deriveAddressFromMnemonic(MNEMONIC, { network: 'testnet' });
    assert.match(test.address, /^tprl1p/);
    assert.notEqual(test.address, main.address);
    assert.equal(validatePearlAddress(test.address).network.name, 'testnet');
  });

  it('testnet2 shares testnet coin type (1) and HRP (tprl)', () => {
    const net = getNetwork('testnet2');
    assert.equal(net.coinType, 1);
    assert.equal(net.hrp, 'tprl');
  });

  it('change/index/account vary the address deterministically', () => {
    const a = deriveAddressFromMnemonic(MNEMONIC, { network: 'mainnet', index: 0 });
    const b = deriveAddressFromMnemonic(MNEMONIC, { network: 'mainnet', index: 0 });
    const c = deriveAddressFromMnemonic(MNEMONIC, { network: 'mainnet', index: 1 });
    const ch = deriveAddressFromMnemonic(MNEMONIC, { network: 'mainnet', change: 1, index: 0 });
    const acct = deriveAddressFromMnemonic(MNEMONIC, { network: 'mainnet', account: 1, index: 0 });
    assert.equal(a.address, b.address);
    assert.notEqual(a.address, c.address);
    assert.notEqual(a.address, ch.address);
    assert.notEqual(a.address, acct.address);
    assert.equal(ch.path, "m/86'/808276'/0'/1/0");
  });

  it('rejects invalid mnemonics and bad options', () => {
    assert.throws(() => deriveAddressFromMnemonic('not a mnemonic', { network: 'mainnet' }), /invalid BIP-39/);
    assert.throws(() => deriveAddressFromMnemonic(MNEMONIC, { network: 'mainnet', change: 2 as 0 }), /change must be 0 or 1/);
    assert.throws(() => deriveAddressFromMnemonic(MNEMONIC, { network: 'nope' as 'mainnet' }), /unknown Pearl network/);
  });
});
