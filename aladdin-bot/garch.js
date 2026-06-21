'use strict';
// garch.js — Item 8: GARCH(1,1) Volatility Forecast
// Regime-conditioned variance prediction for position sizing.
// σ²_t = ω + α·ε²_{t-1} + β·σ²_{t-1}
// Default params (α=0.09, β=0.90) calibrated to FX daily data.

class GARCH {
  constructor(opts = {}) {
    this.omega   = opts.omega   ?? 1e-6;   // long-run variance baseline
    this.alpha   = opts.alpha   ?? 0.09;   // ARCH term (impact of last shock)
    this.beta    = opts.beta    ?? 0.90;   // GARCH term (variance persistence)
    this._var    = opts.initVar ?? 1e-4;   // initial variance estimate
    this._prevRet = 0;
    this._fitted = false;
  }

  // Update with a new return observation
  update(ret) {
    const eps2    = this._prevRet ** 2;
    this._var     = this.omega + this.alpha * eps2 + this.beta * this._var;
    this._prevRet = ret;
    this._fitted  = true;
    return this._var;
  }

  // Forecast N-step ahead variance
  forecast(nSteps = 1) {
    const lr = this.omega / (1 - this.alpha - this.beta + 1e-12);  // long-run variance
    let   v  = this._var;
    for (let i = 0; i < nSteps; i++) {
      v = this.omega + (this.alpha + this.beta) * v;
    }
    return { variance: v, vol: Math.sqrt(v), longRunVol: Math.sqrt(lr), steps: nSteps };
  }

  // Fit parameters via simple moment matching (MLE approximation)
  fit(returns) {
    if (returns.length < 30) return this;
    // Bug fix: NaN returns contaminate mean/variance/omega — filter them first
    const clean = returns.filter(r => typeof r === 'number' && isFinite(r));
    if (clean.length < 10) return this;  // insufficient clean data
    const mean = clean.reduce((s,v)=>s+v,0)/clean.length;
    const vars = clean.map(r=>(r-mean)**2);
    const avgVar = vars.reduce((s,v)=>s+v,0)/vars.length;
    // Bug fix: omega=0 when market is flat (avgVar=0), making longRunVol=0
    // and causing extreme size multipliers on first real volatility bar
    this.omega = Math.max(avgVar * (1 - this.alpha - this.beta), 1e-10);
    this._var  = vars.at(-1) || Math.max(avgVar, 1e-10);
    this._fitted = true;
    return this;
  }

  // Size multiplier: lower position size when GARCH vol forecast is elevated
  sizeMultiplier(targetVol) {
    const _currentVol = Math.sqrt(this._var);
    const _target     = targetVol || 0.01;
    return Math.min(1.5, Math.max(0.2, _target / Math.max(_currentVol, 1e-6)));
  }

  get currentVol() { return Math.sqrt(this._var); }
  get fitted()     { return this._fitted; }
}

module.exports = { GARCH };
