'use strict';
// ── deflated-sharpe.js — 8.3: Deflated Sharpe Ratio ────────────────────────
// Adjusts Sharpe ratio for multiple testing bias (Bailey & Lopez de Prado, 2014).
// When you test many strategy variants, some will show high Sharpe by chance.
// The Deflated Sharpe Ratio (DSR) adjusts for this, giving a true p-value.
//
// DSR = SR × sqrt(T) / sqrt(1 - γ₃×SR + (γ₄/4)×SR²)
// where γ₃ = skewness, γ₄ = excess kurtosis, T = number of observations

class DeflatedSharpe {
  /**
   * @param {number[]} returns       Strategy bar/daily returns
   * @param {number}   nTrials       Number of strategy variants tested (for SR* computation)
   * @param {number}   sr_benchmark  Benchmark SR to beat (default 0)
   */
  constructor(returns, nTrials = 1, srBenchmark = 0) {
    this.returns     = returns;
    this.nTrials     = nTrials;
    this.srBenchmark = srBenchmark;
  }

  // Sample moments
  _moments(returns) {
    const n    = returns.length;
    if (n < 4) return { mean:0, std:1, skew:0, kurt:0 };
    const mean = returns.reduce((s,v)=>s+v,0)/n;
    const diffs = returns.map(v=>v-mean);
    const m2   = diffs.reduce((s,v)=>s+v**2,0)/n;
    const m3   = diffs.reduce((s,v)=>s+v**3,0)/n;
    const m4   = diffs.reduce((s,v)=>s+v**4,0)/n;
    const std  = Math.sqrt(m2) || 1e-6;
    return { mean, std, skew: m3/std**3, kurt: m4/std**4 - 3 };
  }

  // Expected maximum SR from nTrials (approximation)
  _expectedMaxSR(nTrials, meanSR, stdSR) {
    // E[max SR] ≈ μ + σ × (γ - ln(ln(N)) + ln(4π/ln(N)))×0.5
    const eulerMascheroni = 0.5772;
    const lnN = Math.log(nTrials + 1);
    return meanSR + stdSR * (eulerMascheroni - Math.log(Math.log(nTrials)) + Math.log(4 * Math.PI / lnN)) * 0.5;
  }

  // Compute standard normal CDF (approximation)
  _normCDF(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    const pdf  = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
    return x >= 0 ? 1 - pdf * poly : pdf * poly;
  }

  compute() {
    const { mean, std, skew, kurt } = this._moments(this.returns);
    const T   = this.returns.length;
    const SR  = mean / std;  // unadjusted Sharpe (per bar)

    // Probabilistic SR: P(SR > SR_benchmark)
    const sr_std = Math.sqrt((1 - skew * SR + (kurt / 4) * SR**2) / (T - 1));
    const z      = (SR - this.srBenchmark) / (sr_std || 1e-6);
    const psr    = this._normCDF(z);

    // SR* = expected max SR from nTrials (assumes iid Sharpe estimates)
    const sr_star = this.nTrials > 1
      ? this._expectedMaxSR(this.nTrials, 0, Math.sqrt(1 / (T - 1)))
      : this.srBenchmark;

    // DSR = P(SR > SR*) under non-normal returns
    const dsr_z   = (SR - sr_star) / (sr_std || 1e-6);
    const dsr     = this._normCDF(dsr_z);

    return {
      SR:          parseFloat((SR * Math.sqrt(252)).toFixed(4)),  // annualised
      PSR:         parseFloat(psr.toFixed(4)),
      DSR:         parseFloat(dsr.toFixed(4)),
      SR_star:     parseFloat((sr_star * Math.sqrt(252)).toFixed(4)),
      skewness:    parseFloat(skew.toFixed(4)),
      excessKurt:  parseFloat(kurt.toFixed(4)),
      nTrials:     this.nTrials,
      significant: dsr > 0.95,  // 95% confidence
      interpretation: dsr > 0.95
        ? `Deflated Sharpe PASSES (DSR=${(dsr*100).toFixed(1)}%) — edge is real`
        : `Deflated Sharpe FAILS (DSR=${(dsr*100).toFixed(1)}%) — likely over-fitted`,
    };
  }
}

module.exports = { DeflatedSharpe };
