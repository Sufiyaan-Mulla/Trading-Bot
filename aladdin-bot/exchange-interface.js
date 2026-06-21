'use strict';
const logger = require('./structured-logger');
const { RateLimitBackoff } = require('./rate-limit-backoff');
const { LatencyMonitor }   = require('./latency-monitor');
const _rlBackoff  = new RateLimitBackoff({ log: m => logger.warn(m) });
const _latMon     = new LatencyMonitor({ log: m => logger.warn(m) });
// ── exchange-interface.js ─────────────────────────────────────────────────────
// Shared interface (adapter pattern) for exchanges and data providers.
//
// Adapters:
//   PaperAdapter       — in-memory simulation (no real orders)
//   ReplayAdapter      — replays a historical candle CSV (for backtests)
//
// Interface (all adapters must implement):
//   async getPrice(asset)                  → { bid, ask, mid, ts }
//   async getCandles(asset, count, tf)     → [{ time, open, high, low, close, volume }]
//   async placeOrder(spec)                 → { orderId, status, fillPrice, filledAt }
//   async cancelOrder(orderId)             → { cancelled: bool }
//   async getOpenPositions()               → [{ asset, side, size, entryPrice }]
//   async getAccountBalance()              → { balance, equity, marginUsed }
//   get name()                             → string
// ─────────────────────────────────────────────────────────────────────────────

// ── Abstract Base ──────────────────────────────────────────────────────────────
class BaseExchangeAdapter {
  get name() { throw new Error('name must be implemented'); }

  async getPrice(asset)              { throw new Error('getPrice not implemented'); }
  async getCandles(asset, count, tf) { throw new Error('getCandles not implemented'); }
  async placeOrder(spec)             { throw new Error('placeOrder not implemented'); }
  async cancelOrder(orderId)         { throw new Error('cancelOrder not implemented'); }
  async getOpenPositions()           { throw new Error('getOpenPositions not implemented'); }
  async getAccountBalance()          { throw new Error('getAccountBalance not implemented'); }

  // Shared helper: validate order spec before sending
  _validateSpec(spec) {
    if (!spec.asset)  throw new Error('order spec missing asset');
    if (!spec.side)   throw new Error('order spec missing side (BUY/SELL)');
    if (!spec.size || spec.size <= 0 || !isFinite(spec.size)) throw new Error('order spec invalid size');
    if (!['BUY', 'SELL'].includes(spec.side.toUpperCase())) throw new Error('side must be BUY or SELL');
    if (spec.stopLoss   != null && (!isFinite(spec.stopLoss)  || spec.stopLoss  <= 0))
      throw new Error(`order spec invalid stopLoss=${spec.stopLoss}`);
    if (spec.takeProfit != null && (!isFinite(spec.takeProfit) || spec.takeProfit <= 0))
      throw new Error(`order spec invalid takeProfit=${spec.takeProfit}`);
  }
}

// ── Paper (simulation) Adapter ────────────────────────────────────────────────
class PaperAdapter extends BaseExchangeAdapter {
  constructor(opts = {}) {
    super();
    this._capital    = opts.capital || 10_000;
    this._equity     = this._capital;
    this._positions  = [];
    this._orders     = new Map();
    this._prices     = {};   // asset → price
    this._nextId     = 1;
  }

  get name() { return 'paper'; }

  setPrice(asset, price) { this._prices[asset] = price; }

  async getPrice(asset) {
    const mid = this._prices[asset] || 1.1000;
    const spread = mid * 0.0001;
    return { bid: mid - spread / 2, ask: mid + spread / 2, mid, ts: Date.now(), source: 'paper' };
  }

  async getCandles(asset, count = 100) {
    const base  = this._prices[asset] || 1.1000;
    // Items 92-93: replace Math.random (non-deterministic) with a seeded LCG so
    // paper-trading candle generation is reproducible across backtest runs.
    let seed = Array.from(asset).reduce((s, c) => (s * 31 + c.charCodeAt(0)) | 0, 0x1234) ^
               (Math.floor(Date.now() / 86_400_000) * 0x9e3779b9);
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) & 0xffffffff;
      return (seed >>> 0) / 0xffffffff;
    };
    const candles = [];
    let price = base;
    for (let i = count; i >= 0; i--) {
      const noise = (rng() - 0.5) * base * 0.001;
      const open  = price;
      price += noise;
      candles.push({ time: Date.now() - i * 300_000, open, high: Math.max(open, price), low: Math.min(open, price), close: price, volume: rng() * 1000 });
    }
    return candles;
  }

  async placeOrder(spec) {
    this._validateSpec(spec);
    const price     = (await this.getPrice(spec.asset)).mid;
    const fillPrice = spec.orderType === 'LIMIT' ? (spec.price || price) : price;
    const orderId   = String(this._nextId++);
    const order     = { orderId, spec, fillPrice, status: 'filled', filledAt: Date.now() };
    this._orders.set(orderId, order);

    // Update paper positions
    this._positions = this._positions.filter(p => p.asset !== spec.asset);
    this._positions.push({ asset: spec.asset, side: spec.side === 'BUY' ? 'LONG' : 'SHORT', size: spec.size, entryPrice: fillPrice });

    return { orderId, status: 'filled', fillPrice, filledAt: Date.now() };
  }

  async cancelOrder(orderId) {
    this._orders.delete(orderId);
    return { cancelled: true };
  }

  async getOpenPositions() { return [...this._positions]; }

  async getAccountBalance() { return { balance: this._equity, equity: this._equity, marginUsed: 0 }; }
}

// ── Factory ───────────────────────────────────────────────────────────────────
function createAdapter(type, opts = {}) {
  type = type || process.env.BROKER || 'paper';
  switch (type) {
    case 'paper':  return new PaperAdapter(opts);
    default: return new PaperAdapter(opts);
  }
}

// Item #55: Multi-account support — route orders to multiple sub-accounts simultaneously
class MultiAccountManager {
  constructor(adapters = []) {
    this._adapters = adapters;  // [{ id, adapter, riskMultiplier }]
  }

  async placeOrder(params) {
    const results = await Promise.allSettled(
      this._adapters.map(({ id, adapter, riskMultiplier = 1 }) =>
        adapter.placeOrder({ ...params, size: (params.size || 1) * riskMultiplier })
          .then(r => ({ account: id, ...r }))
      )
    );
    return results.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason?.message });
  }

  async getAccountBalance() {
    const results = await Promise.allSettled(
      this._adapters.map(({ id, adapter }) =>
        adapter.getAccountBalance().then(b => ({ account: id, ...b }))
      )
    );
    return results.filter(r => r.status === 'fulfilled').map(r => r.value);
  }
}

module.exports = { BaseExchangeAdapter, PaperAdapter, createAdapter, MultiAccountManager };
