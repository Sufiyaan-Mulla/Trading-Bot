'use strict';
// ── Risk-Adjusted Return Tracker ──────────────────────────────────────────────
// Tracks rolling Sharpe ratio and Calmar ratio in real-time.
// Institutions care most about these — raw P&L without risk adjustment is misleading.
//
// Sharpe = (mean return - risk-free rate) / std(returns)
// Calmar = annualised return / max drawdown
// Recovery Factor = total P&L / max drawdown

class RiskAdjustedTracker {
  constructor({ log = console.log, riskFreeRate = 0.05 } = {}) {
    this.log           = log;
    this._rfr          = riskFreeRate / 252;  // daily risk-free rate
    this._returns      = [];      // per-trade return % values
    this._equityCurve  = [];      // running capital values
    this._peakCapital  = 0;
    this._maxDrawdown  = 0;
    this._startCapital = null;
    this._startTime    = null;
  }

  /**
   * Record a completed trade.
   * @param {number} pnl          trade P&L in currency units
   * @param {number} capital      capital after this trade
   * @param {number} prevCapital  capital before this trade
   */
  record(pnl, capital, prevCapital) {
    if (this._startCapital === null) {
      this._startCapital = prevCapital;
      this._startTime    = Date.now();
      this._peakCapital  = prevCapital;
    }

    const retPct = prevCapital > 0 ? pnl / prevCapital : 0;
    this._returns.push(retPct);
    if (this._returns.length > 1000) this._returns.shift();

    this._equityCurve.push(capital);
    if (this._equityCurve.length > 1000) this._equityCurve.shift();

    if (capital > this._peakCapital) this._peakCapital = capital;
    const dd = this._peakCapital - capital;
    if (dd > this._maxDrawdown) this._maxDrawdown = dd;
  }

  /** Sharpe ratio over last N trades (annualised, assuming ~252 trades/year) */
  sharpe(n = null) {
    const r = n ? this._returns.slice(-n) : this._returns;
    if (r.length < 2) return null;

    const mean = r.reduce((s, v) => s + v, 0) / r.length;
    const variance = r.reduce((s, v) => s + (v - mean) ** 2, 0) / (r.length - 1);
    const std  = Math.sqrt(variance);
    if (std === 0) return null;

    const excessReturn = mean - this._rfr;
    return parseFloat((excessReturn / std * Math.sqrt(252)).toFixed(3));
  }

  /** Calmar ratio = annualised return / max drawdown */
  calmar() {
    if (!this._startCapital || this._maxDrawdown === 0) return null;

    const totalReturn = (this._equityCurve.at(-1) || this._startCapital) - this._startCapital;
    const yearsElapsed = (Date.now() - this._startTime) / (365.25 * 24 * 3600 * 1000) || (1 / 252);
    const annualisedReturn = totalReturn / yearsElapsed;

    return parseFloat((annualisedReturn / this._maxDrawdown).toFixed(3));
  }

  /** Recovery factor = total P&L / max drawdown */
  recoveryFactor() {
    if (this._maxDrawdown === 0 || !this._startCapital) return null;
    const totalPnl = (this._equityCurve.at(-1) || this._startCapital) - this._startCapital;
    return parseFloat((totalPnl / this._maxDrawdown).toFixed(3));
  }

  /** Sortino ratio — only penalises downside volatility */
  sortino(n = null) {
    const r = n ? this._returns.slice(-n) : this._returns;
    if (r.length < 2) return null;

    const mean     = r.reduce((s, v) => s + v, 0) / r.length;
    const negReturns = r.filter(v => v < 0);
    if (!negReturns.length) return null;

    // FIX: Sortino downside variance uses total N in denominator (semi-variance), not just neg count
    const downsideVariance = r.reduce((s, v) => s + Math.min(v, 0) ** 2, 0) / r.length;
    const downsideStd = Math.sqrt(downsideVariance);
    if (downsideStd === 0) return null;

    return parseFloat(((mean - this._rfr) / downsideStd * Math.sqrt(252)).toFixed(3));
  }

  status() {
    return {
      trades:          this._returns.length,
      sharpe:          this.sharpe(),
      sharpe20:        this.sharpe(20),
      sortino:         this.sortino(),
      calmar:          this.calmar(),
      recoveryFactor:  this.recoveryFactor(),
      maxDrawdown:     parseFloat(this._maxDrawdown.toFixed(2)),
      peakCapital:     parseFloat(this._peakCapital.toFixed(2)),
    };
  }
}

module.exports = { RiskAdjustedTracker };
