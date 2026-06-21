'use strict';
// ── fill-probability.js ───────────────────────────────────────────────────────
// Estimates the probability a limit order will fill before the trade times out.
//
// Model: empirical price-touch probability based on distance from current price,
// current volatility (ATR), time available, and historical fill rate tracking.
//
// Used by execution.js to decide LIMIT vs MARKET order:
//   if fillProbability(limitPrice, ...) < threshold → use MARKET instead
//
// Usage:
//   const { FillProbability } = require('./fill-probability');
//   const fp = new FillProbability();
//   const { probability, useLimit } = fp.estimate({
//     currentPrice: 1.1050, limitPrice: 1.1045, atr: 0.0010,
//     maxWaitMs: 30000, side: 'BUY'
//   });
// ─────────────────────────────────────────────────────────────────────────────

const MIN_FILL_PROB_TO_USE_LIMIT = 0.65;   // below this → switch to market
const HISTORY_SIZE = 100;

class FillProbability {
  constructor(opts = {}) {
    this.threshold  = opts.threshold || MIN_FILL_PROB_TO_USE_LIMIT;
    this._history   = [];   // [{ distanceATR, timeRatio, filled }]
  }

  // ── Estimate fill probability for a limit order ───────────────────────────
  // params:
  //   currentPrice  — latest mid price
  //   limitPrice    — desired fill price
  //   atr           — current ATR (14-period)
  //   maxWaitMs     — how long the order will sit before cancellation
  //   side          — 'BUY' | 'SELL'
  //   spread        — current bid/ask spread (optional, defaults to atr*0.1)
  //   barMs         — duration of one bar in ms (default 300_000 = 5 min)
  estimate({ currentPrice, limitPrice, atr, maxWaitMs = 30_000, side = 'BUY', spread = null, barMs = 300_000 }) {
    if (!atr || atr <= 0 || !currentPrice) return { probability: 0.5, useLimit: false, reason: 'insufficient data' };

    spread = spread || atr * 0.1;

    // Distance from current price to limit in ATR units
    const rawDist = side === 'BUY'
      ? currentPrice - limitPrice          // BUY limit is below current price
      : limitPrice   - currentPrice;       // SELL limit is above current price

    // Negative distance = limit is already inside / aggressive — very high fill prob
    if (rawDist <= 0) {
      return { probability: 0.95, useLimit: true, reason: 'limit already inside spread' };
    }

    const distanceATR  = rawDist / atr;
    const timeRatio    = maxWaitMs / barMs;  // how many bars available

    // ── Analytical estimate ───────────────────────────────────────────────
    // Price follows ~random walk with σ = ATR per bar.
    // Probability of touching target = exp(-2 * d / σ²) with time adjustment.
    // This is the reflection principle approximation for Brownian motion.
    const sigma        = atr;
    const barsAvail    = Math.max(1, timeRatio);
    const sigmaTotal   = sigma * Math.sqrt(barsAvail);   // total std over available time
    const zScore       = rawDist / sigmaTotal;
    // P(touch) ≈ 2 * Φ(-z) for first-passage time
    const pTouch       = 2 * this._normCDF(-zScore);
    // Cap at 0.97 (never certain) and adjust downward for spread cost
    const spreadPenalty = Math.min(0.15, spread / atr);
    const analytical   = Math.max(0, Math.min(0.97, pTouch - spreadPenalty));

    // ── Empirical correction (if we have fill history) ─────────────────
    const empirical    = this._empiricalEstimate(distanceATR, timeRatio);
    // Log transition from theoretical to empirical model
    if (empirical != null && this._history.length >= 5 && !this._empiricalActive) {
      this._empiricalActive = true;
      console.log('[FillProbability] Switched to empirical calibration after ' + this._history.length + ' fill samples');
      try { require('./telegram').send('📊 FillProbability: switched to empirical mode (' + this._history.length + ' samples)', 'status'); } catch(_) {}
    }
    const probability  = empirical != null
      ? 0.6 * analytical + 0.4 * empirical
      : analytical;

    const useLimit = probability >= this.threshold;

    return {
      probability:  parseFloat(probability.toFixed(4)),
      useLimit,
      distanceATR:  parseFloat(distanceATR.toFixed(3)),
      timeRatio:    parseFloat(timeRatio.toFixed(2)),
      analytical:   parseFloat(analytical.toFixed(4)),
      empirical:    empirical != null ? parseFloat(empirical.toFixed(4)) : null,
      reason: useLimit
        ? `fill prob ${(probability*100).toFixed(1)}% ≥ threshold`
        : `fill prob ${(probability*100).toFixed(1)}% < threshold — use market`,
    };
  }

  // ── Record the outcome of a limit order ───────────────────────────────────
  // Improves future estimates via empirical calibration.
  recordOutcome({ distanceATR, timeRatio, filled }) {
    this._history.push({ distanceATR, timeRatio, filled: filled ? 1 : 0 });
    if (this._history.length > HISTORY_SIZE) this._history.shift();
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  stats() {
    if (this._history.length < 5) return { insufficient: true };
    const filled  = this._history.filter(h => h.filled).length;
    const notFill = this._history.length - filled;
    return {
      total:     this._history.length,
      filled,
      notFilled: notFill,
      fillRate:  parseFloat((filled / this._history.length * 100).toFixed(1)),
    };
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _empiricalEstimate(distATR, timeRatio) {
    // Find similar historical cases (within 20% of distATR and timeRatio)
    const similar = this._history.filter(h =>
      Math.abs(h.distanceATR - distATR) / Math.max(distATR, 0.01) < 0.20 &&
      Math.abs(h.timeRatio   - timeRatio) / Math.max(timeRatio, 0.01) < 0.30
    );
    if (similar.length < 5) return null;
    return similar.reduce((s, h) => s + h.filled, 0) / similar.length;
  }

  // Standard normal CDF via Horner's method approximation
  _normCDF(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989422820 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
    return x >= 0 ? 1 - p : p;
  }

  static get MIN_FILL_PROB_TO_USE_LIMIT() { return MIN_FILL_PROB_TO_USE_LIMIT; }
}

module.exports = { FillProbability };
