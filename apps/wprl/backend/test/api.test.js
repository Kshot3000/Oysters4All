import test from "node:test";
import assert from "node:assert/strict";
import { createApi } from "../reserves-api.js";

const CFG = {
  baseChainId: 11155111,
  tokenAddress: "0x2222222222222222222222222222222222222222",
  bridgeAddress: "0x1111111111111111111111111111111111111111",
  vaultAddress: "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d",
  prlFeeAddress: "prl1p62v09vuzyd8kdz9l23jaf3kph4wwx6jqcmhkkhg8lhr2qlxky8psu3zw9d",
  evmFeeAddress: "0x4b6f3BC697D9dAF3e8dE182aEc56eD208B9087f1",
};

function doubles({ vaultGrains = 100_000_000n, supplyWei = 1_000_000_000_000_000_000n } = {}) {
  return {
    cfg: CFG,
    oyster: { getBalanceGrains: async () => vaultGrains },
    provider: { getBlockNumber: async () => 999 },
    token: { totalSupply: async () => supplyWei },
    bridge: {
      totalMinted: async () => supplyWei,
      totalBurned: async () => 0n,
      BRIDGE_FEE_BPS: async () => 25n,
    },
  };
}

test("/reserves reports exact 1:1 backing", async () => {
  const { server, getReserves } = createApi(doubles());
  try {
    const r = await getReserves();
    assert.equal(r.pearlChain.vaultBalanceGrains, "100000000");
    assert.equal(r.pearlChain.vaultBalancePrl, "1.00000000");
    assert.equal(r.baseChain.totalSupplyGrains, "100000000");
    assert.equal(r.backing.backingBps, 10000);
    assert.equal(r.backing.backingRatioPct, "100.00");
    assert.equal(r.backing.fullyBacked, true);
    assert.equal(r.fees.feeBps, 25);
    assert.ok(r.checkedAt);
  } finally {
    server.close();
  }
});

test("/reserves flags under-collateralization honestly", async () => {
  const { server, getReserves } = createApi(doubles({ vaultGrains: 90_000_000n }));
  try {
    const r = await getReserves();
    assert.equal(r.backing.backingBps, 9000);
    assert.equal(r.backing.backingRatioPct, "90.00");
    assert.equal(r.backing.fullyBacked, false);
  } finally {
    server.close();
  }
});

test("/reserves handles zero supply without dividing by zero", async () => {
  const { server, getReserves } = createApi(doubles({ supplyWei: 0n, vaultGrains: 0n }));
  try {
    const r = await getReserves();
    assert.equal(r.backing.backingBps, null);
    assert.equal(r.backing.fullyBacked, false);
  } finally {
    server.close();
  }
});

test("HTTP server routes /reserves, /health, and 404", async () => {
  const { server } = createApi(doubles());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const get = (path) =>
    new Promise((resolve, reject) => {
      import("node:http").then(({ default: http }) => {
        http.get(`http://127.0.0.1:${port}${path}`, (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        }).on("error", reject);
      });
    });
  try {
    const r1 = await get("/reserves");
    assert.equal(r1.status, 200);
    assert.equal(r1.body.backing.backingRatioPct, "100.00");

    const r2 = await get("/health");
    assert.equal(r2.status, 200);
    assert.equal(r2.body.ok, true);
    assert.equal(r2.body.deps.baseRpc, "ok");

    const r3 = await get("/nope");
    assert.equal(r3.status, 404);
  } finally {
    server.close();
  }
});

test("/health reports 503 when a dependency is down", async () => {
  const d = doubles();
  d.provider = { getBlockNumber: async () => { throw new Error("connection refused"); } };
  const { server, getHealth } = createApi(d);
  try {
    const h = await getHealth();
    assert.equal(h.ok, false);
    assert.match(h.deps.baseRpc, /connection refused/);
  } finally {
    server.close();
  }
});
