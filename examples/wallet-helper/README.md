# pearl-wallet-helper

TypeScript helpers for Pearl (PRL) wallets: **BIP-39 → BIP-32 → BIP-86**
Taproot address derivation plus a typed JSON-RPC client for the **Oyster**
wallet daemon's legacy RPC server.

Pearl addresses are **bech32m (BIP-350), witness v1+ only** (Taproot P2TR);
witness v0 is rejected by consensus policy. The Oyster wallet derives them
exactly per BIP-86. This package reproduces that derivation byte-for-byte and
validates addresses with the same rules as upstream
`node/btcutil/address.go` `decodeSegWitAddress`.

## Install

```bash
npm install
npm run build     # tsc → dist/
npm test          # build + 27 tests (node:test), incl. official BIP-86 vectors
npm run typecheck # tsc --noEmit
```

Try it (uses the public BIP-86 test mnemonic on testnet by default — no real keys):

```bash
npx tsx src/demo.ts testnet 0
PRL_MNEMONIC="word word ... ..." npx tsx src/demo.ts mainnet 0
```

## Usage

```ts
import {
  deriveAddressFromMnemonic,
  deriveAddressRange,
  accountExtendedKeys,
  validatePearlAddress,
  isValidPearlAddress,
  OysterClient,
  prlToGrains,
  grainsToPrl,
} from 'pearl-wallet-helper';

// 1. Derive a Pearl P2TR address (m/86'/808276'/0'/0/0 on mainnet)
const d = deriveAddressFromMnemonic(mnemonic, { network: 'mainnet', index: 0 });
console.log(d.address); // prl1p…
console.log(d.path);    // m/86'/808276'/0'/0/0

// 2. Scan a gap-limit window (e.g. for balance discovery)
const batch = deriveAddressRange(mnemonic, { network: 'testnet', startIndex: 0, count: 20 });

// 3. Watch-only: account xpub at m/86'/coin'/account'
const { xpub, path } = accountExtendedKeys(mnemonic, 'mainnet', 0);

// 4. Validate any address with upstream-equivalent policy
const info = validatePearlAddress('prl1p…');
console.log(info.network.name, info.isP2TR); // mainnet true
console.log(isValidPearlAddress('prl1p…', 'mainnet')); // true

// 5. Talk to a running Oyster wallet (legacy JSON-RPC)
const oyster = new OysterClient({
  network: 'testnet',           // default port 44209 (mainnet 44207)
  username: 'rpcuser',
  password: 'rpcpass',
  insecureTls: true,            // Oyster serves a self-signed rpc.cert
});
console.log(await oyster.getBalance());            // confirmed PRL
console.log(await oyster.listUnspent(1, 9999999)); // UTXOs
const txid = await oyster.sendToAddress('tprl1p…', 1.5, 0.0001);

console.log(prlToGrains('0.00000001')); // 1n  (1 PRL = 10^8 grains)
console.log(grainsToPrl(322964000000n)); // '3229.64'
```

## Protocol facts this package encodes

| Fact | Source |
|---|---|
| Addresses: bech32m, witness v1–16, program 2–40 bytes; v0 rejected | `node/btcutil/address.go` `decodeSegWitAddress` |
| HRPs: `prl` mainnet, `tprl` testnet/testnet2, `rprl` regtest/simnet | `node/chaincfg/params.go` `Bech32HRPSegwit` |
| BIP-86 coin types: **808276** mainnet, **1** all testnets | `node/chaincfg/params.go` (`HDCoinTypePearl`, `HDCoinTypeTestnet`); `wallet/waddrmgr/scoped_manager.go` `InitKeyScopes` |
| Derivation `m/86'/coin'/account'/change/index`, key-only TapTweak (`ComputeTaprootKeyNoScript` = BIP-341 `Q = P + int(HashTapTweak(bytes(P)))·G` with `lift_x`) | `wallet/waddrmgr/scoped_manager.go`, `node/txscript/taproot.go` |
| Oyster seeds: 12-word BIP-39 mnemonic → 64-byte seed via PBKDF2 | `wallet/walletsetup.go` |
| Oyster legacy RPC methods: `getbalance`, `getunconfirmedbalance`, `getnewaddress`, `listunspent`, `getreceivedbyaddress`, `sendtoaddress`, `validateaddress`, … | `wallet/rpc/legacyrpc/methods.go` |
| Oyster legacy RPC ports: mainnet **44207**, testnet **44209**, testnet2 **44211**, simnet 18554, regtest 18332 | `wallet/config.go` `LegacyRPCListeners` |
| Smallest unit: **grain** (10⁻⁸ PRL) | `node/btcutil` `GrainPerPearl` |

Verified against upstream mirror `pearl-research-labs/pearl` @ `3fe2267`
(2026-09-24, master). The crypto pipeline (BIP-39 → BIP-32 → BIP-86 tweak →
bech32m) is covered by known-answer tests using the **official BIP-86 test
vectors** (mnemonic `abandon … about`, `m/86'/0'/0'/0/0` →
`bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr`, etc.).

## Security notes

- This is an **offline key-derivation helper**. Never paste a real mnemonic
  into a shell command, a chat log, or an environment shared with other
  processes. Prefer hardware wallets / the Oyster daemon for real funds.
- `deriveAddressFromMnemonic` zeroes the seed buffer after use, but JS
  cannot guarantee memory wiping — treat any host that saw a mnemonic as
  exposed.
- `insecureTls: true` skips verification of Oyster's self-signed `rpc.cert`;
  use only on localhost, or install the wallet's CA properly.

## Layout

- `src/networks.ts` — network params (HRP, coin type, ports)
- `src/bech32.ts` — pure-TS bech32/bech32m codec + Pearl policy validation
- `src/bip32.ts` — BIP-32 master/child derivation, xprv/xpub serialization
- `src/taproot.ts` — BIP-86 `lift_x` + TapTweak + address derivation
- `src/oyster.ts` — Oyster legacy JSON-RPC client + PRL/grains conversion
- `test/` — 27 tests incl. official BIP-86 vectors and a stub-RPC server

---

Built for the Pearl Blockchain 24/7 builder.

- Pearl donation address: `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
- X: [@kshot9000](https://x.com/kshot9000)
