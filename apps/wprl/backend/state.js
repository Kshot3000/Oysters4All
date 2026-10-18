// Tiny durable cursor store: processed deposits/withdrawals, scan positions.
// JSON file with atomic write (write temp + rename). Values must be JSON-serializable;
// BigInts are stored as decimal strings by convention (see withdraw.js).

import fs from "node:fs";
import path from "node:path";

export class StateStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.data = {};
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      this.data = JSON.parse(raw);
      // A JSON array passes the typeof check but cannot persist string keys
      // (JSON.stringify drops them), so records would save silently and be
      // lost on the next restart — treat it as an empty store like scalars.
      if (!this.data || typeof this.data !== "object" || Array.isArray(this.data)) this.data = {};
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
      this.data = {};
    }
  }

  save() {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n");
    fs.renameSync(tmp, this.filePath);
  }

  get(key, fallback = undefined) {
    return Object.prototype.hasOwnProperty.call(this.data, key)
      ? this.data[key]
      : fallback;
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
  }

  has(key) {
    return Object.prototype.hasOwnProperty.call(this.data, key);
  }

  delete(key) {
    delete this.data[key];
    this.save();
  }
}
