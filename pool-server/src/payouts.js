/**
 * payouts.js — PPLNS (pay-per-last-N-shares) accounting for the Pearl pool.
 *
 * - Each accepted non-stale, non-solo share adds weight = its difficulty to the
 *   trailing window (last N shares).
 * - When a block is found, the block reward (minus pool fee) is split across
 *   window wallets in exact grain units (1 PRL = 1e8 grains); remainders go by
 *   largest-remainder so the books always balance to the grain.
 * - Solo miners bypass PPLNS: a solo block pays its finder directly.
 * - State (balances, window, rounds) persists to a JSON file so restarts don't
 *   lose the books.
 *
 * This module only keeps the books. Moving real coins is the operator's job
 * (their wallet, their keys); `duePayouts()` + `markPaid()` is the interface.
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { formatPRL } from "./util.js";

const DEFAULTS = {
  windowShares: 1_000_000,   // N: trailing shares in the PPLNS window
  poolFeePct: 1.0,            // pool fee on block rewards
  finderBonusPct: 0.0,        // extra % of reward to the block finder
  stateFile: null,            // path for persistence (null = in-memory only)
  saveEveryShares: 1000,
};

export class Payouts {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    this.window = [];        // [{wallet, diff, at}] — trailing N shares
    this.windowWeight = 0;   // sum of diff in window (float, diffs are ints)
    this.balances = new Map(); // wallet -> { unpaid: BigInt-as-string, paid: string, blocks: n }
    this.rounds = [];        // paid rounds, newest last (bounded)
    this.blocksFound = 0;
    this._sinceSave = 0;
    if (this.cfg.stateFile && existsSync(this.cfg.stateFile)) this._load();
  }

  _bal(wallet) {
    let b = this.balances.get(wallet);
    if (!b) { b = { unpaid: "0", paid: "0", blocks: 0 }; this.balances.set(wallet, b); }
    return b;
  }

  /** Record an accepted share (called by the pool; solo/stale excluded upstream). */
  addShare({ wallet, diff, solo, height, at }) {
    if (solo) return; // solo miners don't earn PPLNS weight
    const d = Math.floor(diff);
    this.window.push({ wallet, diff: d, height, at });
    this.windowWeight += d;
    while (this.window.length > this.cfg.windowShares) {
      const old = this.window.shift();
      this.windowWeight -= old.diff;
    }
    if (++this._sinceSave >= this.cfg.saveEveryShares) this.save();
  }

  /**
   * Credit a found block. Reward split:
   *   fee = reward * poolFeePct
   *   bonus = reward * finderBonusPct -> finder
   *   rest -> PPLNS window wallets by weight (exact grains, largest remainder)
   * Solo blocks: full reward minus fee goes to the finder directly.
   */
  creditBlock({ height, rewardGrains, finderWallet, solo, at }) {
    const reward = BigInt(rewardGrains);
    const feePct = this.cfg.poolFeePct;
    const bonusPct = this.cfg.finderBonusPct;
    const fee = (reward * BigInt(Math.round(feePct * 1000))) / 100000n;
    const bonus = (reward * BigInt(Math.round(bonusPct * 1000))) / 100000n;
    const distributable = reward - fee - bonus;

    const round = {
      height, at: at || Date.now(), solo: !!solo,
      reward: reward.toString(), fee: fee.toString(), bonus: bonus.toString(),
      finder: finderWallet, payouts: [],
    };

    if (solo) {
      const b = this._bal(finderWallet);
      const amt = distributable + bonus; // solo finder keeps the bonus too
      b.unpaid = (BigInt(b.unpaid) + amt).toString();
      b.blocks += 1;
      round.payouts.push({ wallet: finderWallet, grains: amt.toString() });
    } else {
      // Aggregate window weight per wallet.
      const weights = new Map();
      for (const s of this.window) weights.set(s.wallet, (weights.get(s.wallet) || 0) + s.diff);
      const total = [...weights.values()].reduce((a, b) => a + b, 0);
      if (total > 0 && distributable > 0n) {
        // Exact-grain split with largest remainder.
        const rows = [];
        let assigned = 0n;
        for (const [wallet, w] of weights) {
          const exact = (distributable * BigInt(w)) / BigInt(total);
          const rem = (distributable * BigInt(w)) % BigInt(total);
          rows.push({ wallet, exact, rem });
          assigned += exact;
        }
        let leftover = distributable - assigned;
        rows.sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : 0));
        for (let i = 0; leftover > 0n && i < rows.length; i++, leftover--) rows[i].exact += 1n;
        for (const r of rows) {
          const b = this._bal(r.wallet);
          b.unpaid = (BigInt(b.unpaid) + r.exact).toString();
          round.payouts.push({ wallet: r.wallet, grains: r.exact.toString() });
        }
      }
      if (bonus > 0n) {
        const b = this._bal(finderWallet);
        b.unpaid = (BigInt(b.unpaid) + bonus).toString();
        round.payouts.push({ wallet: finderWallet, grains: bonus.toString(), kind: "finder-bonus" });
      }
      const fb = this._bal(finderWallet);
      fb.blocks += 1;
    }

    this.blocksFound++;
    this.rounds.push(round);
    if (this.rounds.length > 200) this.rounds.shift();
    // PPLNS: a new round starts — the window keeps trailing (standard).
    this.save();
    return round;
  }

  /** Wallets with unpaid >= minPayoutGrains. */
  duePayouts(minPayoutGrains) {
    const min = BigInt(minPayoutGrains);
    const out = [];
    for (const [wallet, b] of this.balances) {
      if (BigInt(b.unpaid) >= min) out.push({ wallet, unpaidGrains: b.unpaid, unpaidPRL: formatPRL(b.unpaid) });
    }
    out.sort((a, b) => (BigInt(b.unpaidGrains) > BigInt(a.unpaidGrains) ? 1 : -1));
    return out;
  }

  /** Record that the operator paid a wallet (moves unpaid -> paid). */
  markPaid(wallet, grains, txid = "") {
    const b = this._bal(wallet);
    const amt = BigInt(grains);
    if (amt > BigInt(b.unpaid)) throw new Error("markPaid: amount exceeds unpaid balance");
    b.unpaid = (BigInt(b.unpaid) - amt).toString();
    b.paid = (BigInt(b.paid) + amt).toString();
    this.save();
    return { wallet, paidGrains: grains.toString(), txid };
  }

  balancesView() {
    const out = [];
    for (const [wallet, b] of this.balances) {
      out.push({ wallet, unpaidGrains: b.unpaid, unpaidPRL: formatPRL(b.unpaid), paidPRL: formatPRL(b.paid), blocks: b.blocks });
    }
    out.sort((a, b) => (BigInt(b.unpaidGrains) > BigInt(a.unpaidGrains) ? 1 : -1));
    return out;
  }

  stats() {
    return {
      windowShares: this.window.length,
      windowMax: this.cfg.windowShares,
      poolFeePct: this.cfg.poolFeePct,
      finderBonusPct: this.cfg.finderBonusPct,
      blocksFound: this.blocksFound,
      miners: this.balances.size,
      rounds: this.rounds.slice(-20).reverse(),
    };
  }

  save() {
    this._sinceSave = 0;
    if (!this.cfg.stateFile) return;
    const data = {
      v: 1,
      window: this.window.slice(-this.cfg.windowShares),
      balances: [...this.balances.entries()],
      rounds: this.rounds.slice(-200),
      blocksFound: this.blocksFound,
    };
    // Atomic-ish: write temp then rename.
    writeFileSync(this.cfg.stateFile + ".tmp", JSON.stringify(data));
    renameSync(this.cfg.stateFile + ".tmp", this.cfg.stateFile);
  }

  _load() {
    try {
      const data = JSON.parse(readFileSync(this.cfg.stateFile, "utf8"));
      this.window = data.window || [];
      this.windowWeight = this.window.reduce((a, s) => a + s.diff, 0);
      this.balances = new Map(data.balances || []);
      this.rounds = data.rounds || [];
      this.blocksFound = data.blocksFound || 0;
    } catch {
      // Corrupt state file: start fresh rather than refuse to start.
    }
  }
}
