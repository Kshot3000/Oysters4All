// Oyster wallet-RPC client: the ONLY component allowed to move native PRL.
//
// Verified against pearl-research-labs/pearl (wallet/rpc/legacyrpc/methods.go, 2026-09-28):
//   - getbalance [account] [minconf]     -> decimal PRL (float in JSON)
//   - listunspent [minconf] [maxconf] [addresses]
//   - sendtoaddress <addr> <amount>      -> txid. `amount` is DECIMAL PRL.
// pearld itself refuses these with "ask a connected instance of Oyster".
//
// All amounts cross this boundary as exact grains (BigInt) and are converted
// to 8-decimal PRL strings at the last moment (see convert.js).

import { RpcClient } from "./rpc.js";
import { prlValueToGrains, grainsToPrlString, isValidPrlAddress } from "./convert.js";

export class OysterWallet {
  constructor(rpc) {
    this.rpc = rpc instanceof RpcClient ? rpc : new RpcClient(rpc.url, rpc);
  }

  /** Wallet balance in exact grains (minconf confirmations). */
  async getBalanceGrains(minconf = 1) {
    const balance = await this.rpc.call("getbalance", ["*", minconf]);
    return prlValueToGrains(balance);
  }

  /** UTXOs, amounts normalized to grains. */
  async listUnspent(minconf = 1, maxconf = 9999999, addresses = []) {
    const utxos = await this.rpc.call("listunspent", [minconf, maxconf, addresses]);
    return (utxos ?? []).map((u) => ({
      txid: u.txid,
      vout: u.vout,
      address: u.address,
      grains: prlValueToGrains(u.amount),
      confirmations: u.confirmations,
      spendable: u.spendable,
    }));
  }

  /**
   * Release native PRL to `address`.
   * @param {string} address   prl1… recipient (validated)
   * @param {bigint} grains    exact grains to send
   * @returns {Promise<string>} Pearl txid
   */
  async sendToAddress(address, grains) {
    if (!isValidPrlAddress(address)) {
      throw new Error(`refusing to send PRL to invalid address: ${address}`);
    }
    const g = BigInt(grains);
    if (g <= 0n) throw new RangeError("send amount must be positive grains");
    const amountStr = grainsToPrlString(g);
    // sendtoaddress <address> <amount in PRL> — pass the amount as a STRING so
    // the wallet parses the exact decimal instead of a JSON float.
    return this.rpc.call("sendtoaddress", [address, amountStr]);
  }
}
