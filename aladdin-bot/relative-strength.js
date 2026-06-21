'use strict';
// ── relative-strength.js ──────────────────────────────────────────────────────
// Cross-asset relative-strength + volatility-adjusted opportunity ranker.
//
// Fixes: Strategy partial — "Rank symbols by relative strength and
// volatility-adjusted opportunity."
//
// Method:
//   For each asset in the watchlist:
//     1. Rate-of-change (ROC) over multiple lookbacks (5, 10, 20 bars)
//        → normalised to a z-score vs the asset's own history
//     2. Volatility-adjusted ROC = ROC / ATR  (opportunity per unit of risk)
//     3. Composite score = weighted sum across lookbacks
//     4. Cross-asset rank: highest score = strongest momentum relative to peers
//
// Used by _selectBestAsset() in the engine to replace the simple momentum score.
//
// Usage:
//   const { RelativeStrength } = require('./relative-strength');
//   const rs = new RelativeStrength();
//   rs.update('EURUSD', prices, atrs);
//   rs.update('GBPUSD', prices, atrs);
//   const ranked = rs.rank();   // [{ asset, score, roc, volatilityAdj, rank }]
//   const best   = ranked[0].asset;
// ─────────────────────────────────────────────────────────────────────────────

const LOOKBACKS    = [5, 10, 20];
const WEIGHTS      = [0.5, 0.3, 0.2];   // shorter lookback weighted more
const HISTORY_SIZE = 100;               // bars kept per asset for z-score calc

class RelativeStrength {
  constructor(opts = {}) {
    this.lookbacks = opts.lookbacks || LOOKBACKS;
    this.weights   = opts.weights   || WEIGHTS;
    this._data     = new Map();   // asset → { prices, atrs, scores }
  }

  // ── Feed price + ATR data for one asset ───────────────────────────────────
  update(asset, prices, atrs) {
    if (!prices || prices.length < Math.max(...this.lookbacks) + 5) return;
    if (!this._data.has(asset)) this._data.set(asset, { rocHistory: [] });
    const entry = this._data.get(asset);

    // Compute ROC for each lookback
    const last  = prices.length - 1;
    const atr   = atrs ? atrs[atrs.length - 1] : (prices[last] * 0.001);
    const rocs  = this.lookbacks.map(lb => {
      const prev = prices[last - lb];
      if (!prev || prev === 0) return 0;
      return (prices[last] - prev) / prev;
    });

    // Volatility-adjusted ROC (per unit of ATR as % of price)
    const atrPct   = atr / prices[last];
    const volAdj   = atrPct > 0 ? rocs.map(r => r / atrPct) : rocs;

    // Composite score
    const composite = rocs.reduce((s, r, i) => s + r * this.weights[i], 0);

    // Rolling history for z-score
    entry.rocHistory.push(composite);
    if (entry.rocHistory.length > HISTORY_SIZE) entry.rocHistory.shift();

    entry.lastRocs   = rocs;
    entry.composite  = composite;
    entry.volAdj     = volAdj.reduce((s, v, i) => s + v * this.weights[i], 0);
    entry.atrPct     = atrPct;
    entry.lastPrice  = prices[last];
  }

  // ── Rank all assets by volatility-adjusted strength ───────────────────────
  // Returns array sorted best → worst
  rank() {
    const results = [];
    for (const [asset, entry] of this._data.entries()) {
      if (entry.rocHistory.length < 1) continue;
      const zScore = this._zScore(entry.composite, entry.rocHistory);
      results.push({
        asset,
        score:        parseFloat((entry.volAdj || entry.composite || 0).toFixed(6)),
        composite:    parseFloat((entry.composite || 0).toFixed(6)),
        zScore:       parseFloat(zScore.toFixed(3)),
        volatilityAdj:parseFloat((entry.volAdj || 0).toFixed(6)),
        atrPct:       parseFloat(((entry.atrPct || 0) * 100).toFixed(4)),
        rocs:         (entry.lastRocs || []).map(r => parseFloat(r.toFixed(6))),
      });
    }

    // Sort descending by volatility-adjusted score
    results.sort((a, b) => b.score - a.score);

    // Add rank
    results.forEach((r, i) => { r.rank = i + 1; });
    return results;
  }

  // ── Best asset for direction ───────────────────────────────────────────────
  // direction: 'LONG' (strongest), 'SHORT' (weakest), 'BEST' (abs strongest)
  best(direction = 'LONG') {
    const ranked = this.rank();
    if (!ranked.length) return null;
    if (direction === 'LONG')  return ranked[0];
    if (direction === 'SHORT') return ranked[ranked.length - 1];
    return ranked.reduce((b, r) => Math.abs(r.score) > Math.abs(b.score) ? r : b, ranked[0]);
  }

  // ── Cross-sectional z-score ────────────────────────────────────────────────
  // How strong is this asset vs its own history?
  _zScore(value, history) {
    if (history.length < 5) return 0;
    const mean = history.reduce((s, v) => s + v, 0) / history.length;
    const std  = Math.sqrt(history.reduce((s, v) => s + (v - mean) ** 2, 0) / history.length);
    return std === 0 ? 0 : (value - mean) / std;
  }

  // ── Clear data for all or one asset ───────────────────────────────────────
  clear(asset) {
    if (asset) this._data.delete(asset);
    else this._data.clear();
  }

  assets() { return [...this._data.keys()]; }
}

module.exports = { RelativeStrength };
