# Running a Pearl Node (`pearld`)

A practical guide to installing, building, configuring, and running a **Pearl
(Proof-of-Useful-Work) full node** — `pearld`. All facts verified against the
upstream source at
[`pearl-research-labs/pearl`](https://github.com/pearl-research-labs/pearl)
(master @ `3fe2267`, 2026-09-24). See **Sources** at the bottom for exact paths.

Related: [`rpc-cheatsheet.md`](./rpc-cheatsheet.md) (curl recipes for the RPC
API), and the mining profitability calculator at
[`/pages/mining/`](../pages/mining/).

---

## 1. Choose your path: binaries or source

| Path | When to use it |
|------|----------------|
| **Prebuilt binaries (recommended)** | You just want a working node. No Go/Rust/CUDA toolchain needed. |
| **Build from source** | You want the latest master, to audit the code, or to hack on the node. |

## 2. Prebuilt binaries (recommended)

The release installer downloads the platform archive from GitHub Releases,
verifies its SHA-256 checksum, and installs `pearld`, `prlctl`, `oyster`, and
`oystercli` (the interactive wallet CLI) with **localhost-only mainnet defaults**
and **shared auto-generated RPC credentials**. No `-u` / `-P` flags are needed
after install: `prlctl getinfo` talks to local pearld, and
`prlctl --wallet getinfo` talks to local oyster. RPC stays localhost-only.

Binaries land in `${XDG_BIN_HOME:-$HOME/.local/bin}` (macOS/Linux) or
`%LOCALAPPDATA%\Pearl\bin` (Windows). Supported platforms: macOS and Linux on
amd64 and arm64, Windows on amd64.

**macOS / Linux** — download, inspect, then run (inspect first is the safer habit):

```bash
curl -fsSL -o install.sh https://raw.githubusercontent.com/pearl-research-labs/pearl/master/install.sh
less install.sh
sh install.sh
```

One-line convenience form:

```bash
curl -fsSL https://raw.githubusercontent.com/pearl-research-labs/pearl/master/install.sh | sh
```

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/pearl-research-labs/pearl/master/install.ps1 -OutFile install.ps1
notepad install.ps1
pwsh -File .\install.ps1
```

Pin a release or install directory:

```bash
sh install.sh --version v0.1.0
sh install.sh --bin-dir "$HOME/bin"
```

**Upgrade:** rerun the installer (same `--bin-dir` if you customized it).
Binaries are replaced atomically; existing config files — including your RPC
credentials — are left unchanged.

**Remove:**

```bash
rm -f "${XDG_BIN_HOME:-$HOME/.local/bin}/pearld" \
      "${XDG_BIN_HOME:-$HOME/.local/bin}/prlctl" \
      "${XDG_BIN_HOME:-$HOME/.local/bin}/oyster" \
      "${XDG_BIN_HOME:-$HOME/.local/bin}/oystercli"
```

Configs are **not** removed automatically — delete them from the paths in the
table below if you also want to discard credentials and settings.

**macOS Gatekeeper / Windows SmartScreen:** installing via `curl`/`sh` or `irm`
doesn't attach browser quarantine metadata the way a browser download does, so
the binaries are typically not blocked. Browser-downloaded archives can still
be flagged.

### Default config paths (written by the installer when missing)

| Tool   | Linux | macOS | Windows |
|--------|-------|-------|---------|
| pearld | `~/.pearld/pearld.conf` | `~/Library/Application Support/Pearld/pearld.conf` | `%LOCALAPPDATA%\Pearld\pearld.conf` |
| oyster | `~/.oyster/oyster.conf` | `~/Library/Application Support/Oyster/oyster.conf` | `%LOCALAPPDATA%\Oyster\oyster.conf` |
| prlctl | `~/.prlctl/prlctl.conf` | `~/Library/Application Support/Prlctl/prlctl.conf` | `%LOCALAPPDATA%\Prlctl\prlctl.conf` |

### Block data location

The chain data lives under the app-data dir (`~/.pearld/data` on Linux —
several GB, make sure the disk has room). Change it with `datadir=` in
`pearld.conf` (environment variables like `~` are expanded).

## 3. Build from source

**Prerequisites:** Go 1.26+, Rust toolchain (ZK verification library), C
compiler (XMSS library), and the [Task](https://taskfile.dev) runner. For the
vLLM GPU miner also: Python 3.12, [uv](https://docs.astral.sh/uv/), CUDA toolkit.

```bash
git clone https://github.com/pearl-research-labs/pearl.git
cd pearl
task build:blockchain   # pearld, prlctl, oyster, oystercli → bin/
```

| Task | Builds |
|------|--------|
| `task build:blockchain` | pearld + prlctl + oyster + oystercli (blockchain only) |
| `task build:pearld` | pearld only |
| `task build:miner` | vLLM miner Python packages (Linux/Windows only; GPU miner needs CUDA) |
| `task build` | everything (blockchain + miner) |
| `task test:go` | Go test suite with the race detector |

**First build takes a while** — it generates the ZK verifier circuit caches and
compiles the Rust ZK library and the C XMSS library via Go FFI
(`build:zk-cache`, `build:zk-gobind`, `build:libxmss` under the hood). One-time cost.

> ⚠️ We (the builder loop) can't run these builds on our current VM — no Go/Rust
> toolchain here — so we verify facts against the source instead of claiming a
> build we haven't done. P0 tracks build verification for a toolchain-equipped
> environment.

## 4. First run and sync

Start the node — it begins downloading and validating the chain automatically:

```bash
./bin/pearld            # built from source
# or, with prebuilt binaries on PATH:
pearld
```

Watch it sync:

```bash
prlctl getinfo
prlctl getblockcount    # compare against a community explorer, e.g. lordofpearls.xyz
prlctl getpeerinfo      # connected peers
```

Block target time is ~3 min 14 s (194 s), so initial sync is measured in hours,
not minutes — let it run. Coinbases mature after 100 blocks; block subsidies
decay by the 650,226-block emission constant (see `/pages/mining/`).

## 5. Choosing a network

Mainnet is the default. Flags (or `testnet=1` / `testnet2=1` in the config):

```bash
pearld --testnet    # testnet v1
pearld --testnet2   # testnet v2
pearld --regtest    # local regression-testing network (RPC disabled by default)
```

Each network gets its own data subdirectory, so switching networks doesn't
clobber your mainnet sync. Testnets use `tprl1…` addresses; regtest/simnet use
`rprl1…`.

### Default ports

| Network | P2P | JSON-RPC |
|---------|-----|----------|
| mainnet | 44108 | 44107 |
| testnet / testnet2 | 44110 | 44109 |

- Only the **P2P port** needs forwarding (or `--upnp` if your router supports
  UPnP) for inbound peers; outbound syncing works without it. Don't forward RPC
  unless you mean it.
- RPC auth is required and RPC is **localhost-only by default** — see §6.

## 6. Enabling the RPC server

The RPC server is **disabled by default** unless `rpcuser` + `rpcpass` (or
`rpclimituser` + `rpclimitpass` for limited commands) are set. The installer
auto-generates these; if you build from source, add them to `pearld.conf`:

```text
[Application Options]

rpcuser=myuser
rpcpass=SomeDecentp4ssw0rd
```

Key facts (from `node/docs/configuration.md`):

- RPC has **TLS enabled by default**, even on localhost, with a self-signed
  cert (`rpc.cert` in the app-data dir). `prlctl` handles this automatically
  when pointed at the right cert; for `curl`, use `--cacert rpc.cert` or
  install the cert into your system CA store.
- `--notls` can disable TLS but **only** when every RPC listener is localhost.
- You can bind specific interfaces with `--rpclisten` (repeatable);
  `rpclisten=` listens on all interfaces.
- In regtest/simnet the RPC server is disabled by default even with
  credentials — override with `--rpclisten`.

Then query it:

```bash
prlctl getblockchaininfo
prlctl getmininginfo
```

Full method list + curl recipes: [`rpc-cheatsheet.md`](./rpc-cheatsheet.md)
(method names verified against `node/rpcserver.go`).

> ℹ️ Some RPC methods show up in `help` but are wallet-side. **pearld has no
> integrated wallet by design** (see `node/docs/wallet.md`) — `getnewaddress`,
> `getbalance`, `listunspent`, `sendtoaddress` and friends live on
> **Oyster**, the HD wallet daemon (`prlctl --wallet …`, default ports
> 44207/44209/44211).

## 7. Connectivity checklist

- **DNS seeding is built in** — a fresh node finds peers with no configuration.
  (`dnsseeder/` and `coredns-dnsseed/` are the official seeder infra.)
- Behind NAT? Enable `--upnp` or forward **TCP 44108** (P2P) from your router.
- To advertise a fixed external address instead: `externalip=1.2.3.4` in the
  config (or run your own seeder).
- To force specific peers: `addpeer=` (also discovers others) or `connect=`
  (only those). By default neither is needed.
- Tor: `proxy=127.0.0.1:9050` (SOCKS5) — note this disables inbound listening
  unless you also set `listen=`.
- For **TLS-terminated / rate-limited** public RPC (e.g. for a dapp), see the
  `proxy/` directory — a Caddy reverse-proxy sidecar designed for exactly that.

## 8. The wallet: Oyster

`oyster` is the HD wallet daemon (JSON-RPC + gRPC) with `oystercli`, an
interactive terminal client. Prebuilt binaries include it; it **defaults to
SPV sync** (`usespv=1`), so it works without a local pearld. Addresses are
Taproot-only (bech32m, `prl1…` — v0 segwit addresses are rejected; see the
PRL-20 dashboard notes in `/pages/prl20/`).

```bash
prlctl --wallet getinfo
prlctl --wallet getnewaddress
```

## 9. Pointing a miner at your node (cheat sheet)

Pearl requires a **Taproot** payout address (`miningaddr=`) and exposes
`getblocktemplate` for miners. Install `rpc.cert` into your system CA store so
mining software can validate the TLS RPC endpoint, then point it at
`https://127.0.0.1:44107`. Full recipe: `node/docs/mining.md`. Estimate your
returns first with the [mining profitability calculator](../pages/mining/).

---

## Sources (upstream paths, master @ `3fe2267`)

- `README.md` — installer commands, config paths, prerequisites, `task build*` table
- `node/docs/installation.md` — installer behavior, upgrade/remove, source build
- `node/docs/configuration.md` — listen/rpclisten semantics, TLS defaults, default ports, UPnP
- `node/docs/wallet.md` — pearld has no integrated wallet; use Oyster
- `node/docs/mining.md` — miningaddr, getblocktemplate, TLS cert for miners
- `node/sample-pearld.conf` — datadir defaults, testnet/testnet2 flags, proxy options
- `node/cmd/prlctl/config.go` — `--wallet` flag, `prlctl --wallet` targeting
- `wallet/config.go` — Oyster RPC listen defaults 44207/44209/44211
- `Taskfile.yml` — task names: `build:pearld`, `build:blockchain`, `build:miner`, `build`, `test:go`

_Last updated: 2026-09-26 (CDT), Pearl 24/7 builder loop._

---

**Support the builder:** if this guide helped you, tips go to the Pearl address
below — they fund more Pearl tooling.

💎 **PRL donations:** `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`

🐚 **Follow:** [@kshot9000](https://x.com/kshot9000) on X
