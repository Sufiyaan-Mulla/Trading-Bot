'use strict';
// ── risk-parity.js — 3.1: Risk Parity Allocation ─────────────────────────────
// Allocates position sizes so each asset contributes EQUAL portfolio variance.
// Classic risk parity: weight_i = (1/σ_i) / Σ(1/σ_j)
// Ensures no single pair dominates portfolio volatility.

class RiskParity {
  /**
   * @param {string[]} assets         Asset names
   * @param {object}   opts
   * @param {number}   opts.lookback  ATR lookback window for vol estimation (default 20)
   * @param {number}   opts.maxWt     Max weight per asset (default 0.5 = 50%)
   * @param {number}   opts.minWt     Min weight per asset (default 0.05 = 5%)
   */
  constructor(assets = [], opts = {}) {
    this.assets    = assets;
    this.lookback  = opts.lookback || 20;
    this.maxWt     = opts.maxWt    || 0.50;
    this.minWt     = opts.minWt    || 0.05;
    this._vols     = {};  // asset → rolling vol estimate
  }

  // Update volatility estimate for an asset
  updateVol(asset, price, prevPrice) {
    if (!prevPrice || prevPrice <= 0) return;
    const ret = Math.abs(price / prevPrice - 1);
    if (!this._vols[asset]) this._vols[asset] = { ema: ret, count: 1 };
    const alpha = 2 / (this.lookback + 1);
    this._vols[asset].ema   = alpha * ret + (1 - alpha) * this._vols[asset].ema;
    this._vols[asset].count++;
  }

  // Compute risk parity weights for all assets
  weights(assets) {
    const use = assets || this.assets;
    const invVols = {};
    let total = 0;

    for (const a of use) {
      const vol = this._vols[a]?.ema || 0.01;  // fallback 1% daily vol
      invVols[a] = 1 / Math.max(vol, 0.0001);
      total += invVols[a];
    }

    const weights = {};
    for (const a of use) {
      weights[a] = Math.min(this.maxWt, Math.max(this.minWt, invVols[a] / (total || 1)));
    }

    // Renormalise after clamping
    const sum = Object.values(weights).reduce((s,v) => s+v, 0);
    for (const a of use) weights[a] = parseFloat((weights[a] / sum).toFixed(4));

    return weights;
  }

  // Get position size multiplier for a single asset (relative to equal weighting)
  sizeMultiplier(asset, allAssets) {
    const w = this.weights(allAssets || [asset]);
    const equalWt = 1 / (allAssets?.length || 1);
    return parseFloat(((w[asset] || equalWt) / equalWt).toFixed(4));
  }

  getVol(asset) { return this._vols[asset]?.ema ?? null; }
  hasVol(asset) { return this._vols[asset]?.count >= 5; }
}

module.exports = { RiskParity };
