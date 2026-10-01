// Bundle smoke test: stub the browser surface, load the bundle, drive a
// full create -> inspect -> sign -> combine -> finalize -> extract flow.
const els = new Map();
function el(id) {
  if (!els.has(id)) {
    els.set(id, {
      id, value: "", textContent: "", innerHTML: "",
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener() {}, scrollIntoView() {},
      textContent_: "",
    });
  }
  return els.get(id);
}
global.window = {};
global.document = {
  getElementById: (id) => el(id),
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, appendChild() {}, remove() {}, click() {}, select() {} }),
  body: { appendChild() {} },
};
global.localStorage = { _m: new Map(), getItem(k) { return this._m.get(k) ?? null; }, setItem(k, v) { this._m.set(k, v); } };
Object.defineProperty(global, "navigator", { value: {}, configurable: true });
// node 24 already provides globalThis.crypto — no override needed

await import("../pearl-psbt.bundle.js");
const P = global.window.PearlPSBT;
if (!P) throw new Error("window.PearlPSBT not set by bundle");
console.log("window.PearlPSBT OK; tabs fn:", typeof P.gotoTab);

// full flow through the QA surface
const demo = P.loadDemo();
console.log("demo loaded, b64 len:", demo.length);
const d = P.inspectText(demo);
console.log("inspect: inputs", d.inputs.length, "issues", d.issues.length);
const keys = P.core.examplePrivkeys();
const sA = P.signText(demo, 0, 0, keys.keypath);
console.log("signed input 0:", sA.result.mode, "|", sA.result.keyNote.slice(0, 40));
const sB = P.signText(demo, 1, 1, keys.scriptpath);
console.log("signed input 1:", sB.result.mode);
const merged = P.combineText(sA.base64, sB.base64);
console.log("combined, b64 len:", merged.length);
const { ext } = P.finalizeText(merged);
console.log("finalized: txid", ext.txid, "| vsize", ext.vsize, "| hex chars", ext.hex.length);
const back = P.core.parseFinalTx(ext.hex);
console.log("reparsed witnesses:", back.witnesses.map((w) => w.length).join(","));
console.log("BUNDLE SMOKE OK");
