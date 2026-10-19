import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";
import { get } from "node:http";
import { ApiServer } from "../src/api.js";

function stubPool() {
  return {
    networkId: "mainnet",
    blockCandidates: [],
    poolStats: () => ({
      uptimeSec: 1, minersOnline: 0, connections: 0, height: 1,
      templateSource: "synthetic-demo", certVersion: 3, network: "mainnet",
      activeDiffs: [], sharesValid: 0, sharesInvalid: 0, sharesStale: 0,
      sharesDuplicate: 0, blocksFound: 0, miners: [],
    }),
  };
}
function stubPayouts() {
  return {
    stats: () => ({ rounds: [] }),
    listPendingBlocks: () => [],
    balancesView: () => [],
    duePayouts: () => [],
  };
}

function tryGet(port, ms = 1500) {
  return new Promise((resolve) => {
    // agent:false — the shared global agent keeps sockets alive for
    // seconds after the response, which would itself hold a capped slot
    // and make the slot accounting below race the agent's idle timeout.
    const req = get({ host: "127.0.0.1", port, path: "/health", timeout: ms, agent: false }, (res) => {
      let b = "";
      res.on("data", (c) => { b += c; });
      res.on("end", () => resolve({ status: res.statusCode, body: b }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "timeout" }); });
    req.on("error", (e) => resolve({ status: 0, body: e.code || e.message }));
  });
}

test("api connections are capped globally; held partial requests cannot crowd out new clients", async () => {
  const api = new ApiServer({
    pool: stubPool(), payouts: stubPayouts(), config: {},
    host: "127.0.0.1", port: 0, log: () => {}, maxConnections: 2,
  });
  await api.start();
  const port = api.server.address().port;
  const held = [];
  const hold = () => {
    const s = connect(port, "127.0.0.1", () => s.write("GET /health HTTP/1.1\r\nHost: x\r\n"));
    s.on("error", () => {});
    held.push(s);
    return s;
  };
  const until = async (fn, ms = 3000) => {
    const t0 = Date.now();
    while (!fn()) {
      if (Date.now() - t0 > ms) throw new Error("condition not met in time");
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  try {
    // Baseline: a normal request succeeds.
    const ok = await tryGet(port);
    assert.equal(ok.status, 200);
    // Wait for the baseline socket to fully drain from the count, or it
    // would occupy one of the two slots the held sockets are about to fill.
    await until(() => api._conns.size === 0);
    // Two held partial requests fill the cap; a third client must not
    // get in (on the old code there was no cap and it succeeded).
    hold(); hold();
    await until(() => api._conns.size === 2);
    const blocked = await tryGet(port);
    assert.notEqual(blocked.status, 200);
    // Releasing a slot admits the next client again.
    held[0].destroy();
    await new Promise((r) => setTimeout(r, 300));
    const after = await tryGet(port);
    assert.equal(after.status, 200);
  } finally {
    for (const s of held) s.destroy();
    await api.stop();
  }
});
