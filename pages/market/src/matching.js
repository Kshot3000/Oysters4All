/* Pearl Bazaar — matching engine.
 *
 * Pure order-book + matching logic for PRL-20 listings. Zero dependencies,
 * no I/O, no crypto: amounts are BigInt grains (PRL) and BigInt token base
 * units. Deterministic and fully unit-testable.
 *
 * Model:
 *  - Asks are firm listings of a whole transfer lot: { amt } tokens for a
 *    total { priceGrains }. One ask = one lot UTXO, filled atomically on
 *    chain; the engine may still partially consume an ask against a smaller
 *    bid (the remainder stays on the book for the seller to re-list).
 *  - Bids are buy intents: { amount } tokens at a maximum total { maxPrice }.
 *  - Price-time priority: best ask = lowest per-token price, then earliest;
 *    best bid = highest per-token price, then earliest. A bid crosses an ask
 *    iff bid.maxPrice/amount >= ask.priceGrains/amt (compared exactly with
 *    BigInt cross-multiplication — no float dust).
 *  - Execution price is the resting order's price (the ask's here).
 *  - Self-trade prevention: a bid never matches its own address's asks.
 *  - Expired asks are excluded from matching and can be purged.
 */

const toBig = (v, name) => {
  try {
    const b = typeof v === "bigint" ? v : BigInt(String(v).trim());
    return b;
  } catch {
    throw new Error(`bad ${name}: ${v}`);
  }
};

let seqCounter = 1;
const nextSeq = () => seqCounter++;

export function resetSeqForTests() { seqCounter = 1; }

/** Compare per-token prices a/b vs c/d without floats.
 *  Returns -1/0/1 for (a/b) vs (c/d), all BigInt, b,d > 0. */
export function cmpPrice(a, b, c, d) {
  const l = a * d, r = c * b;
  return l < r ? -1 : l > r ? 1 : 0;
}

/** Does bid (maxPrice for amount) cross ask (priceGrains for amt)? */
export function crosses(bidMaxPrice, bidAmount, askPriceGrains, askAmt) {
  return bidMaxPrice * askAmt >= askPriceGrains * bidAmount;
}

export class OrderBook {
  constructor(tick, { now = () => Date.now() } = {}) {
    if (!/^[a-z0-9]{1,16}$/.test(String(tick || "").toLowerCase()))
      throw new Error(`bad ticker: ${tick}`);
    this.tick = String(tick).toLowerCase();
    this.now = now;
    this.asks = new Map(); // id -> ask
    this.bids = new Map(); // id -> bid
  }

  /* ---------------- order entry ---------------- */

  /** Ask: { id?, tick?, amt, priceGrains, seller, expiry, created?, listing? } */
  addAsk(a) {
    const tick = String(a.tick ?? this.tick).toLowerCase();
    if (tick !== this.tick) throw new Error(`ticker mismatch: ${a.tick} != ${this.tick}`);
    const amt = toBig(a.amt, "amt");
    const priceGrains = toBig(a.priceGrains, "priceGrains");
    if (amt <= 0n) throw new Error("ask amt must be > 0");
    if (priceGrains <= 0n) throw new Error("ask priceGrains must be > 0");
    if (!a.seller || typeof a.seller !== "string") throw new Error("ask needs a seller address");
    const expiry = Number(a.expiry);
    if (!Number.isFinite(expiry) || expiry <= this.now()) throw new Error("ask expiry must be in the future");
    const id = String(a.id ?? `ask-${nextSeq()}`);
    if (this.asks.has(id)) throw new Error(`duplicate ask id: ${id}`);
    const ask = {
      id, tick, amt, remaining: amt, priceGrains,
      seller: a.seller, expiry,
      created: Number(a.created ?? this.now()),
      seq: nextSeq(),
      listing: a.listing ?? null,
    };
    this.asks.set(id, ask);
    return ask;
  }

  /** Bid: { id?, tick?, amount, maxPrice, buyerAddress, created? } */
  addBid(b) {
    const tick = String(b.tick ?? this.tick).toLowerCase();
    if (tick !== this.tick) throw new Error(`ticker mismatch: ${b.tick} != ${this.tick}`);
    const amount = toBig(b.amount, "amount");
    const maxPrice = toBig(b.maxPrice, "maxPrice");
    if (amount <= 0n) throw new Error("bid amount must be > 0");
    if (maxPrice <= 0n) throw new Error("bid maxPrice must be > 0");
    if (!b.buyerAddress || typeof b.buyerAddress !== "string")
      throw new Error("bid needs a buyerAddress");
    const id = String(b.id ?? `bid-${nextSeq()}`);
    if (this.bids.has(id)) throw new Error(`duplicate bid id: ${id}`);
    const bid = {
      id, tick, amount, remaining: amount, maxPrice,
      buyerAddress: b.buyerAddress,
      created: Number(b.created ?? this.now()),
      seq: nextSeq(),
    };
    this.bids.set(id, bid);
    return bid;
  }

  cancelAsk(id) { return this.asks.delete(String(id)); }
  cancelBid(id) { return this.bids.delete(String(id)); }

  /** Remove asks past expiry. Returns removed ids. */
  purgeExpired(nowMs = this.now()) {
    const gone = [];
    for (const [id, ask] of this.asks) {
      if (ask.expiry <= nowMs) { this.asks.delete(id); gone.push(id); }
    }
    return gone;
  }

  /* ---------------- views ---------------- */

  asksSorted(nowMs = this.now()) {
    return [...this.asks.values()]
      .filter((a) => a.expiry > nowMs && a.remaining > 0n)
      .sort((x, y) =>
        cmpPrice(x.priceGrains, x.amt, y.priceGrains, y.amt) ||
        x.created - y.created || x.seq - y.seq);
  }

  bidsSorted() {
    return [...this.bids.values()]
      .filter((b) => b.remaining > 0n)
      .sort((x, y) =>
        cmpPrice(y.maxPrice, y.amount, x.maxPrice, x.amount) || // highest first
        x.created - y.created || x.seq - y.seq);
  }

  /** Depth ladder: [{ priceGrainsPerToken (string), amount (string), orders }] per side. */
  depth(n = 25, nowMs = this.now()) {
    const ladder = (orders, isAsk) => {
      const levels = new Map();
      for (const o of orders) {
        // rational price key: reduce by gcd for stable grouping
        const num = isAsk ? o.priceGrains : o.maxPrice;
        const den = isAsk ? o.amt : o.amount;
        const g = gcd(num, den);
        const key = `${num / g}/${den / g}`;
        const cur = levels.get(key) ?? { num, den, amount: 0n, orders: 0 };
        cur.amount += o.remaining;
        cur.orders += 1;
        levels.set(key, cur);
      }
      const arr = [...levels.values()].map((l) => ({
        priceNum: l.num.toString(), priceDen: l.den.toString(),
        amount: l.amount.toString(), orders: l.orders,
      }));
      arr.sort((x, y) => {
        const c = cmpPrice(BigInt(x.priceNum), BigInt(x.priceDen), BigInt(y.priceNum), BigInt(y.priceDen));
        return isAsk ? c : -c;
      });
      return arr.slice(0, n);
    };
    return { asks: ladder(this.asksSorted(nowMs), true), bids: ladder(this.bidsSorted(), false) };
  }

  /* ---------------- matching ---------------- */

  /** Match resting bids against resting asks (price-time priority).
   *  Returns { trades: [{tick, amount, priceGrains, buyer, seller, askId, bidId, ts}] }.
   *  Partial fills allowed on both sides; exhausted orders are removed. */
  match(nowMs = this.now()) {
    const trades = [];
    for (;;) {
      const bids = this.bidsSorted();
      if (!bids.length) break;
      const bid = bids[0];
      // best ask that is not the bidder's own and crosses
      const ask = this.asksSorted(nowMs).find(
        (a) => a.seller !== bid.buyerAddress &&
               crosses(bid.maxPrice, bid.amount, a.priceGrains, a.amt)
      );
      if (!ask) break; // top bid crosses nothing tradable
      const fillAmt = bid.remaining < ask.remaining ? bid.remaining : ask.remaining;
      // execution at the resting ask's price; floor keeps grains integral
      const fillPrice = (fillAmt * ask.priceGrains) / ask.amt;
      trades.push({
        tick: this.tick,
        amount: fillAmt.toString(),
        priceGrains: fillPrice.toString(),
        buyer: bid.buyerAddress,
        seller: ask.seller,
        askId: ask.id,
        bidId: bid.id,
        ts: nowMs,
      });
      bid.remaining -= fillAmt;
      ask.remaining -= fillAmt;
      if (bid.remaining === 0n) this.bids.delete(bid.id);
      if (ask.remaining === 0n) this.asks.delete(ask.id);
    }
    return { trades };
  }
}

function gcd(a, b) {
  a = a < 0n ? -a : a; b = b < 0n ? -b : b;
  while (b) { const t = a % b; a = b; b = t; }
  return a || 1n;
}

/** Multi-ticker board of books with a known token universe. */
export class Market {
  constructor({ knownTickers = [], now = () => Date.now() } = {}) {
    this.now = now;
    this.known = new Set(knownTickers.map((t) => String(t).toLowerCase()));
    this.books = new Map();
  }

  addKnownTicker(tick) {
    const t = String(tick).toLowerCase();
    if (!/^[a-z0-9]{1,16}$/.test(t)) throw new Error(`bad ticker: ${tick}`);
    this.known.add(t);
  }

  book(tick) {
    const t = String(tick).toLowerCase();
    if (!this.known.has(t)) throw new Error(`unknown ticker: ${tick}`);
    if (!this.books.has(t)) this.books.set(t, new OrderBook(t, { now: this.now }));
    return this.books.get(t);
  }

  addAsk(a) { return this.book(a.tick).addAsk(a); }
  addBid(b) { return this.book(b.tick).addBid(b); }

  /** Match every book. Returns { tick: { trades } }. */
  matchAll(nowMs = this.now()) {
    const out = {};
    for (const [tick, b] of this.books) {
      const r = b.match(nowMs);
      if (r.trades.length) out[tick] = r;
    }
    return out;
  }

  purgeAll(nowMs = this.now()) {
    const gone = {};
    for (const [tick, b] of this.books) {
      const g = b.purgeExpired(nowMs);
      if (g.length) gone[tick] = g;
    }
    return gone;
  }
}
