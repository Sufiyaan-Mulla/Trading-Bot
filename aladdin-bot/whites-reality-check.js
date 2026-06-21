'use strict';
// ── whites-reality-check.js — 8.2: White's Reality Check ────────────────────
// Determines if a strategy's Sharpe ratio is statistically significant
// vs the null of a random strategy, accounting for the multiple-testing
// problem when many parameter combinations were searched.
//
// Reference: White (2000), "A Reality Check for Data Snooping"
// Uses stationary bootstrap to generate the null distribution.

class WhitesRealityCheck {
  /**
   * @param {number[]} strategyReturns  Daily/bar returns of the best strategy
   * @param {number}   nBootstrap       Bootstrap iterations (default 1000)
   * @param {number}   blockSize        Expected block size (default 5 bars)
   */
  constructor(strategyReturns, nBootstrap = 1000, blockSize = 5) {
    this.returns    = strategyReturns || [];
    this.nBoot      = nBootstrap;
    this.blockSize  = blockSize;
  }

  // Stationary bootstrap resample
  _bootstrap(returns) {
    const n      = returns.length;
    const sample = [];
    let   i      = Math.floor(Math.random() * n);
    while (sample.length < n) {
      sample.push(returns[i % n]);
      // Geometric probability of starting new block
      if (Math.random() < 1 / this.blockSize) i = Math.floor(Math.random() * n);
      else i++;
    }
    return sample;
  }

  _sharpe(returns) {
    if (!returns.length) return 0;
    const mean = returns.reduce((s,v)=>s+v,0)/returns.length;
    const std  = Math.sqrt(returns.reduce((s,v)=>s+(v-mean)**2,0)/returns.length) || 1e-6;
    return mean / std * Math.sqrt(252);  // annualised
  }

  // Run the reality check
  run() {
    const observed = this._sharpe(this.returns);
    const nullDist = [];
    for (let b = 0; b < this.nBoot; b++) {
      const resample    = this._bootstrap(this.returns);
      // Null: demeaned returns (subtract mean so E[return]=0 under null)
      const mean        = resample.reduce((s,v)=>s+v,0)/resample.length;
      const demeaned    = resample.map(v=>v-mean);
      nullDist.push(this._sharpe(demeaned));
    }
    nullDist.sort((a,b)=>a-b);
    const pValue   = nullDist.filter(s => s >= observed).length / this.nBoot;
    const critical = nullDist[Math.floor(nullDist.length * 0.95)];  // 95th percentile
    return {
      observedSharpe: parseFloat(observed.toFixed(4)),
      pValue:         parseFloat(pValue.toFixed(4)),
      significant:    pValue < 0.05,
      criticalValue:  parseFloat(critical.toFixed(4)),
      nBootstrap:     this.nBoot,
      interpretation: pValue < 0.05
        ? `Edge is SIGNIFICANT (p=${(pValue*100).toFixed(1)}% < 5%)`
        : `Edge NOT significant (p=${(pValue*100).toFixed(1)}% ≥ 5%) — may be data snooping`,
    };
  }
}

module.exports = { WhitesRealityCheck };
