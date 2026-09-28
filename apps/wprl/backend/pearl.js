// pearld chain-RPC client (port 44107): read-only chain queries.
//
// Verified against pearl-research-labs/pearl (node/rpcserver.go, 2026-09-28):
//   - searchrawtransactions <addr> <verbose=1> <skip> <count> <vinExtra=0> <reverse=false>
//       REQUIRES pearld --addrindex (errors otherwise). Returns decoded txs newest-first.
//   - getrawtransaction <txid> <verbose=1>  REQUIRES --txindex for confirmed txs.
//       Verbose output includes vout[].value (PRL, decimal), vout[].scriptPubKey.addresses,
//       confirmations, blockheight.
//   - getblockcount
// Wallet RPCs (getbalance/sendtoaddress/listunspent) are NOT on pearld — pearld
// answers them with "ask a connected instance of Oyster". See oyster.js.

import { RpcClient } from "./rpc.js";
import { prlValueToGrains } from "./convert.js";

export class PearlChain {
  constructor(rpc) {
    this.rpc = rpc instanceof RpcClient ? rpc : new RpcClient(rpc.url, rpc);
  }

  /** Current best-chain height. */
  getBlockCount() {
    return this.rpc.call("getblockcount");
  }

  /**
   * Decoded transactions touching `address`, newest first.
   * @param {number} skip  entries to skip (pagination cursor)
   * @param {number} count max entries (pearld caps at maxSearchRawTransactionsCount)
   */
  searchRawTransactions(address, skip = 0, count = 100) {
    return this.rpc.call("searchrawtransactions", [address, 1, skip, count, 0, false]);
  }

  /** Verbose decoded transaction by txid (throws if --txindex is off / unknown tx). */
  getRawTransaction(txid, verbose = 1) {
    return this.rpc.call("getrawtransaction", [txid, verbose]);
  }

  /**
   * Sum of confirmed outputs paying `address` in a verbose decoded tx, in grains.
   * @returns {{ totalGrains: bigint, outputs: Array<{n:number, grains:bigint, addresses:string[]}> }}
   */
  static outputsTo(tx, address) {
    let totalGrains = 0n;
    const outputs = [];
    for (const vout of tx.vout ?? []) {
      const addrs = vout?.scriptPubKey?.addresses ?? [];
      if (addrs.includes(address)) {
        const grains = prlValueToGrains(vout.value);
        totalGrains += grains;
        outputs.push({ n: vout.n, grains, addresses: addrs });
      }
    }
    return { totalGrains, outputs };
  }
}
