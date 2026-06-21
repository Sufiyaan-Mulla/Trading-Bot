'use strict';
// ── period-slicer.js ──────────────────────────────────────────────────────────
// Forces backtests to run separately on bull, bear, and sideways market slices.
//
// Fixes: Backtesting partial — "Test on bullish, bearish, and sideways periods."
//
// Method:
//   1. Classifies each bar's regime using a long EMA trend + ADX.
//   2. Groups consecutive bars of the same regime into slices.
//   3. Returns slices of a minimum length so each can be backtested independently.
//   4. Reports per-slice performance so operators can see where the strategy breaks.
//
// Usage:
//   const { PeriodSlicer } = require('./period-slicer');
//   const slicer = new PeriodSlicer();
//   const slices = slicer.slice(ohlcvCandles);
//   for (const s of slices) {
//     const result = runBacktest(s.candles);
//     console.log(s.regime, result.totalReturn);
//   }
// ─────────────────────────────────────────────────────────────────────────────

const MIN_SLICE_BARS = 30;   // ignore slices shorter than this
const EMA_PERIOD     = 50;
const ADX_PERIOD     = 14;
const ADX_THRESHOLD  = 20;   // below = ranging/sideways

class PeriodSlicer {
  constructor(opts = {}) {
    this.minSliceBars = opts.minSliceBars || MIN_SLICE_BARS;
    this.emaPeriod    = opts.emaPeriod    || EMA_PERIOD;
    this.adxThreshold = opts.adxThreshold || ADX_THRESHOLD;
  }

  // ── Classify and slice a candle array ─────────────────────────────────────
  // candles: [{ time, open, high, low, close, volume }]
  // Returns: [{ regime, start, end, bars, candles, summary }]
  slice(candles) {
    if (!candles || candles.length < this.minSliceBars * 2) return [];

    const closes = candles.map(c => c.close);
    const emas   = this._ema(closes, this.emaPeriod);
    const adxs   = this._adx(candles, ADX_PERIOD);
    const regimes = candles.map((c, i) => this._classify(c.close, emas[i], adxs[i]));

    // Group into consecutive slices
    const raw = [];
    let start = 0;
    for (let i = 1; i <= regimes.length; i++) {
      if (i === regimes.length || regimes[i] !== regimes[start]) {
        if (i - start >= this.minSliceBars) {
          raw.push({ regime: regimes[start], start, end: i - 1, indices: { from: start, to: i - 1 } });
        }
        start = i;
      }
    }

    // Attach candle slices and summary stats
    return raw.map(s => {
      const sliceCandles = candles.slice(s.start, s.end + 1);
      return { ...s, bars: sliceCandles.length, candles: sliceCandles, summary: this._summarise(sliceCandles) };
    });
  }

  // ── Classify a bar's regime ───────────────────────────────────────────────
  _classify(close, ema, adx) {
    if (ema == null || adx == null) return 'UNKNOWN';
    if (adx < this.adxThreshold) return 'SIDEWAYS';
    return close > ema ? 'BULL' : 'BEAR';
  }

  // ── EMA ───────────────────────────────────────────────────────────────────
  _ema(prices, period) {
    const k   = 2 / (period + 1);
    const out = new Array(prices.length).fill(null);
    let   ema = null;
    for (let i = 0; i < prices.length; i++) {
      if (i < period - 1) continue;
      if (ema == null) {
        ema = prices.slice(0, period).reduce((s, v) => s + v, 0) / period;
      } else {
        ema = prices[i] * k + ema * (1 - k);
      }
      out[i] = ema;
    }
    return out;
  }

  // ── Wilder-smoothed ADX ───────────────────────────────────────────────────
  _adx(candles, period) {
    const out = new Array(candles.length).fill(null);
    if (candles.length < period * 2) return out;
    const trs = [], pdms = [], mdms = [];
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i], p = candles[i - 1];
      trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
      const pdm = c.high - p.high, mdm = p.low - c.low;
      pdms.push(pdm > mdm && pdm > 0 ? pdm : 0);
      mdms.push(mdm > pdm && mdm > 0 ? mdm : 0);
    }
    let atr14 = trs.slice(0, period).reduce((s, v) => s + v, 0);
    let pdm14  = pdms.slice(0, period).reduce((s, v) => s + v, 0);
    let mdm14  = mdms.slice(0, period).reduce((s, v) => s + v, 0);
    const dxs = [];
    for (let i = period; i < trs.length; i++) {
      atr14 = atr14 - atr14 / period + trs[i];
      pdm14 = pdm14 - pdm14 / period + pdms[i];
      mdm14 = mdm14 - mdm14 / period + mdms[i];
      const pdi = atr14 > 0 ? pdm14 / atr14 * 100 : 0;
      const mdi = atr14 > 0 ? mdm14 / atr14 * 100 : 0;
      const sum = pdi + mdi;
      dxs.push(sum > 0 ? Math.abs(pdi - mdi) / sum * 100 : 0);
    }
    if (dxs.length < period) return out;
    let adx14 = dxs.slice(0, period).reduce((s, v) => s + v, 0) / period;
    out[period * 2] = adx14;
    for (let i = period; i < dxs.length; i++) {
      adx14 = (adx14 * (period - 1) + dxs[i]) / period;
      out[i + period + 1] = adx14;
    }
    return out;
  }

  // ── Slice summary statistics ──────────────────────────────────────────────
  _summarise(candles) {
    if (!candles.length) return {};
    const first = candles[0].close, last = candles[candles.length - 1].close;
    const highs = candles.map(c => c.high), lows = candles.map(c => c.low);
    const returns = [];
    for (let i = 1; i < candles.length; i++) {
      returns.push((candles[i].close - candles[i-1].close) / candles[i-1].close);
    }
    const mean = returns.reduce((s, v) => s + v, 0) / (returns.length || 1);
    const vol  = Math.sqrt(returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (returns.length || 1));
    return {
      totalReturn: parseFloat(((last - first) / first * 100).toFixed(2)),
      maxHigh:     parseFloat(Math.max(...highs).toFixed(5)),
      minLow:      parseFloat(Math.min(...lows).toFixed(5)),
      volatility:  parseFloat((vol * 100).toFixed(4)),
      sharpe:      vol > 0 ? parseFloat((mean / vol * Math.sqrt(252)).toFixed(3)) : 0,
    };
  }
}

// ── SurvivorshipFilter ─────────────────────────────────────────────────────────
// Marks instruments as delisted/unavailable and excludes them from backtest runs.
//
// Fixes: Backtesting partial — "Eliminate look-ahead bias and survivorship bias."
//
// Survivorship bias: testing only on instruments that still exist today
// overstates historical returns because losers (delisted) are excluded.
// This filter lets you register known-delisted instruments and ensures they're
// included during the period they were active, excluded after delisting.
class SurvivorshipFilter {
  constructor() {
    this._delisted = new Map();   // asset → delistedAtMs
    this._relisted = new Map();   // asset → relaunchedAtMs
  }

  // Register a delisting event
  markDelisted(asset, delistedAt) {
    const ts = typeof delistedAt === 'number' ? delistedAt : new Date(delistedAt).getTime();
    this._delisted.set(asset, ts);
  }

  // Register a re-launch (asset came back after delisting)
  markRelisted(asset, relaunchedAt) {
    const ts = typeof relaunchedAt === 'number' ? relaunchedAt : new Date(relaunchedAt).getTime();
    this._relisted.set(asset, ts);
    // Keep delisting record — isActive() uses both to determine the window
  }

  // Is this asset tradeable at a given timestamp?
  isActive(asset, atTimestampMs) {
    if (!this._delisted.has(asset)) return true;
    const delistedAt  = this._delisted.get(asset);
    const relaunchedAt = this._relisted.get(asset) || Infinity;
    return atTimestampMs < delistedAt || atTimestampMs >= relaunchedAt;
  }

  // Filter a candle array to only include bars when the asset was active
  filterCandles(asset, candles) {
    return candles.filter(c => {
      const ts = typeof c.time === 'number' ? (c.time < 1e12 ? c.time * 1000 : c.time) : new Date(c.time).getTime();
      return this.isActive(asset, ts);
    });
  }

  // Filter an asset list to those active at a given timestamp
  filterAssets(assets, atTimestampMs) {
    return assets.filter(a => this.isActive(a, atTimestampMs));
  }

  // Summary of all registered delistings
  delistings() {
    return [...this._delisted.entries()].map(([asset, ts]) => ({
      asset, delistedAt: new Date(ts).toISOString(),
      relisted: this._relisted.has(asset) ? new Date(this._relisted.get(asset)).toISOString() : null,
    }));
  }
}

module.exports = { PeriodSlicer, SurvivorshipFilter };
