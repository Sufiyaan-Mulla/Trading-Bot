'use strict';
// vol-targeting.js — Volatility Targeting Position Sizer
// Instead of fixed notional, size positions so the portfolio maintains a CONSTANT
// annualised volatility target (e.g. 10%). When vol is high → smaller positions.
// This is the same mechanism used by risk-parity and volatility-managed funds.

class VolatilityTargeter {
  constructor(opts = {}) {
    this.annualVolTarget = opts.annualVolTarget ?? 0.10;  // 10% annualised vol target
    this.lookback        = opts.lookback        ?? 20;   // bars for realised vol estimate
    this.minMult         = opts.minMult         ?? 0.20; // never size below 20%
    this.maxMult         = opts.maxMult         ?? 2.00; // never lever above 200%
    this.barsPerYear     = opts.barsPerYear     ?? 252 * 24 * 2; // 30-min bars ≈ 12096/yr
  }

  // Compute realised volatility from recent returns
  realisedVol(prices) {
    if (!prices || prices.length < 3) return this.annualVolTarget;
    const n    = Math.min(prices.length, this.lookback + 1);
    const rets = prices.slice(-n).map((p,i,a) => i ? (p-a[i-1])/a[i-1] : 0).slice(1);
    if (!rets.length) return this.annualVolTarget;
    const mean = rets.reduce((s,v)=>s+v,0)/rets.length;
    const std  = Math.sqrt(rets.reduce((s,v)=>s+(v-mean)**2,0)/rets.length) || 1e-8;
    return std * Math.sqrt(this.barsPerYear);  // annualise
  }

  // Return a size multiplier so portfolio vol ≈ target
  sizeMultiplier(prices) {
    const rv   = this.realisedVol(prices);
    const mult = this.annualVolTarget / Math.max(rv, 1e-6);
    return Math.max(this.minMult, Math.min(this.maxMult, mult));
  }

  // Apply to a raw position size (in currency units)
  adjustSize(rawSize, prices) {
    return rawSize * this.sizeMultiplier(prices);
  }

  get currentTarget() { return this.annualVolTarget; }
}

module.exports = { VolatilityTargeter };
