/**
 * api.js — read-only HTTP API for the pool dashboard (plus operator payout reads).
 *
 *  GET /health              liveness
 *  GET /api/config          public pool config (fee, scheme, ports, addresses)
 *  GET /api/stats           pool + payout summary
 *  GET /api/miners          connected miners
 *  GET /api/rounds          recent PPLNS rounds
 *  GET /api/blocks          archived block candidates
 *  GET /api/balances        payout balances
 *  GET /api/payouts/due     wallets above the payout threshold (operator)
 *
 * Bind to 127.0.0.1 by default; put it behind a reverse proxy for public access.
 * All amounts are in grains (1 PRL = 1e8 grains); PRL strings included for display.
 */
import { createServer } from "node:http";
import { formatPRL } from "./util.js";

export class ApiServer {
  constructor({ pool, payouts, config, host = "127.0.0.1", port = 8888, log = () => {} }) {
    this.pool = pool;
    this.payouts = payouts;
    this.config = config;
    this.host = host;
    this.port = port;
    this.log = log;
    this.server = null;
  }

  async start() {
    this.server = createServer((req, res) => this._handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => { this.server.off("error", reject); resolve(); });
    });
    this.log(`api listening on http://${this.host}:${this.port}`);
  }

  async stop() {
    if (this.server) await new Promise((r) => this.server.close(r));
  }

  _json(res, obj, status = 200) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Access-Control-Allow-Origin": "*",
    });
    res.end(body);
  }

  _handle(req, res) {
    try {
      const url = new URL(req.url, "http://x");
      const q = url.searchParams;
      switch (url.pathname) {
        case "/health":
          return this._json(res, { ok: true, time: new Date().toISOString() });
        case "/api/config":
          return this._json(res, this._publicConfig());
        case "/api/stats": {
          const ps = this.pool.poolStats();
          const pay = this.payouts.stats();
          return this._json(res, {
            pool: {
              uptimeSec: ps.uptimeSec, minersOnline: ps.minersOnline,
              connections: ps.connections, height: ps.height,
              templateSource: ps.templateSource, certVersion: ps.certVersion,
              network: ps.network, activeDiffs: ps.activeDiffs,
              sharesValid: ps.sharesValid, sharesInvalid: ps.sharesInvalid,
              sharesStale: ps.sharesStale, sharesDuplicate: ps.sharesDuplicate,
              blocksFound: ps.blocksFound,
            },
            payouts: pay,
          });
        }
        case "/api/miners":
          return this._json(res, { miners: this.pool.poolStats().miners });
        case "/api/rounds":
          return this._json(res, { rounds: this.payouts.stats().rounds });
        case "/api/blocks":
          return this._json(res, { candidates: this.pool.blockCandidates.map(stripProof) });
        case "/api/balances":
          return this._json(res, { balances: this.payouts.balancesView() });
        case "/api/payouts/due": {
          const min = q.get("min") || "100000000"; // default 1 PRL in grains
          return this._json(res, { minPayoutGrains: min, due: this.payouts.duePayouts(min) });
        }
        default:
          return this._json(res, { error: "not found" }, 404);
      }
    } catch (e) {
      return this._json(res, { error: e.message }, 500);
    }
  }

  _publicConfig() {
    const c = this.config;
    return {
      coin: "PRL",
      network: this.pool.networkId,
      scheme: "PPLNS",
      poolFeePct: c.payouts?.poolFeePct ?? 1.0,
      finderBonusPct: c.payouts?.finderBonusPct ?? 0.0,
      pplnsWindowShares: c.payouts?.windowShares ?? 1000000,
      minPayoutPRL: c.minPayoutPRL ?? "1",
      stratumPort: c.stratum?.port ?? 3333,
      stratumTls: !!c.stratum?.tls,
      certVersion: c.pool?.certVersion ?? 3,
      donation: c.donation || null,
    };
  }
}

/** Never ship full proof blobs over the dashboard API. */
function stripProof(c) {
  const { proofB64, ...rest } = c;
  return { ...rest, proofBytes: proofB64 ? Buffer.from(proofB64, "base64").length : 0 };
}

export { formatPRL };
