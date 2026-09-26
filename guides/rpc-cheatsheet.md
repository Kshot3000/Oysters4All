# Pearl `pearld` JSON-RPC Cheatsheet

Common JSON-RPC calls with `curl` examples, verified against the upstream
`node/docs/json_rpc_api.md` and `node/rpcserver.go` (upstream commit `3fe2267`).

**Prerequisites:** `pearld` running with the RPC server enabled — it is
**disabled by default** unless `rpcuser`+`rpcpass` are set in `~/.pearld/pearl.conf`
(see `node/sample-pearld.conf` upstream).

Default mainnet RPC endpoint: `http://127.0.0.1:44107` (testnet: `44109`).
Set your credentials once per shell session:

```sh
RPC=http://127.0.0.1:44107
RPCUSER=your_rpc_user
RPCPASS=your_rpc_pass

rpc() { # $1 = method, $2 = params JSON (default [])
  curl -s -u "$RPCUSER:$RPCPASS" -H 'Content-Type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":\"curl\",\"method\":\"$1\",\"params\":${2:-[]}}" "$RPC"
}
```

## Chain status

```sh
rpc getblockcount            # current height of best chain
rpc getbestblockhash         # hash of chain tip
rpc getblockchaininfo        # blocks, bestblockhash, chain, difficulty, headers
rpc getinfo                  # legacy btcd-style state object
rpc getdifficulty             # PoW difficulty as multiple of minimum
rpc getchaintips             # all known chain tips (forks included)
rpc getnetworkhashps         # estimated network hash rate (default: last 120 blocks)
```

## Blocks

```sh
HASH=$(rpc getblockhash '[100000]' | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"])')
rpc getblock "[\"$HASH\"]"             # verbosity 1 (default): parsed JSON
rpc getblock "[\"$HASH\", 0]"          # verbosity 0: raw hex
rpc getblockheader "[\"$HASH\"]"       # header only (verbose=true default)
```

## Transactions

```sh
rpc getrawtransaction '["<txid>"]'          # hex (verbose=0 default)
rpc getrawtransaction '["<txid>", 1]'       # decoded JSON object
rpc decoderawtransaction '["<rawhex>"]'     # decode a raw tx without a node lookup
rpc gettxout '["<txid>", 0]'                # UTXO at output index 0 (null if spent)
rpc sendrawtransaction '["<signedhex>"]'    # broadcast; NOTE: `allowhighfees` param is NOT implemented and has no effect
```

## Mempool & mining

```sh
rpc getmempoolinfo            # size, bytes, usage
rpc getrawmempool             # txids currently in mempool
rpc getmininginfo             # blocks, difficulty, networkhashps, pooledtx…
rpc getblocktemplate          # block template for miners; includes `requiredcertversion`
```

> Miners: read `requiredcertversion` from the template and build the matching
> ZK certificate (V3 = salted-seed, required at/after mainnet height 99000).
> Never hardcode fork heights. `setgenerate` requires `--miningaddr` because
> pearld has no integrated wallet.

## Network

```sh
rpc getconnectioncount        # number of active peers
rpc getnetworkinfo            # version, subversion, protocolversion, connections…
rpc getpeerinfo               # one object per connected peer
rpc uptime                    # node uptime in seconds
```

## Addresses & validation

```sh
rpc validateaddress '["prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d"]'
# → {"isvalid": true, ...}. NOTE: pearld has no wallet, so it only reports
# validity — use the Oyster wallet daemon for address creation and balances.
```

## Help

```sh
rpc help                      # list all commands
rpc help '["getblock"]'       # help for one command
rpc stop                      # shut down pearld (needs RPC auth)
```

## Notes
- All methods return JSON-RPC 2.0 envelopes: `{"jsonrpc":"2.0","id":…,"result":…}`.
- Address prefixes: `prl…` mainnet, `tprl…` testnet, `rprl…` regtest/simnet.
- This cheatsheet is also covered by the typed client in
  `examples/pearl-rpc-client` and the static explorer in `pages/explorer/`.

---

**Support this work — PRL:** `prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d`
· **X:** [@kshot9000](https://x.com/kshot9000)
