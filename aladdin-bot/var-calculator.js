'use strict';
// ── var-calculator.js ─────────────────────────────────────────────────────────
// Value at Risk (VaR), Expected Shortfall (CVaR), Sharpe, and Sortino ratios.
//
// Method: Historical Simulation — no distribution assumptions.
//   VaR(α):  The loss not exceeded with probability α.
//            e.g. VaR(95%) = $X means there is 5% chance of losing > $X
//   ES(α):   Expected Shortfall (CVaR) — average loss in the worst (1-α)%.
//            More informative than VaR: it answers "how bad is bad?"
//
// All calculations work on an array of trade P/L values (in $ or %).
//
// Usage:
//   const { RiskMetrics } = require('./var-calculator');
//   const m = RiskMetrics.calculate(trades, { confidence: [0.95, 0.99] });
//   console.log(m.var95, m.es95, m.sharpe, m.sortino);
// ─────────────────────────────────────────────────────────────────────────────

class RiskMetrics {

  // ── Main calculation ──────────────────────────────────────────────────────
  // trades: array of { profit, profitPercent } objects (closed trades)
  // opts.confidence: array of confidence levels, default [0.95, 0.99]
  // opts.riskFreeRate: daily risk-free rate (default 0 — conservative)
  // opts.capitalBase: starting capital for % calculations (default sum of costs)
  static calculate(trades, opts = {}) {
    opts = opts || {};
    const levels      = opts.confidence    || [0.95, 0.99];
    const rfRate      = opts.riskFreeRate  || 0;
    const capitalBase = opts.capitalBase   || 10_000;

    if (!trades || trades.length < 3) {
      return RiskMetrics._empty(levels);
    }

    // Extract P/L series (use profitPercent if available, else normalise by capitalBase)
    // Bug fix: NaN profits (e.g. from commission calculation errors) sort unpredictably,
    // corrupting VaR percentile indices and producing wrong risk limits.
    const returns = trades
      .map(t => t.profitPercent != null ? t.profitPercent / 100 : t.profit / capitalBase)
      .filter(v => typeof v === 'number' && isFinite(v));  // exclude NaN/Infinity

    const losses = returns.map(r => -r);   // positive = loss

    // Sort losses ascending for percentile work
    const sortedLosses = losses.slice().sort((a, b) => a - b);
    const n = sortedLosses.length;

    const result = {
      trades: n,
    };

    // ── VaR and Expected Shortfall at each confidence level ───────────────
    for (const level of levels) {
      const label = Math.round(level * 100);
      // BUG-06 fix: ceil gives true Nth percentile (floor was off by one)
      const idx    = Math.min(Math.ceil(n * level), n - 1);
      const varVal = sortedLosses[idx]; // loss at threshold

      // ES = average of all losses BEYOND VaR
      const tailStart  = Math.ceil(n * level);
      const tailLosses = sortedLosses.slice(tailStart);
      const esVal = tailLosses.length > 0
        ? tailLosses.reduce((s, v) => s + v, 0) / tailLosses.length
        : varVal;

      result[`var${label}`]  = parseFloat((varVal * 100).toFixed(3));    // as %
      result[`es${label}`]   = parseFloat((esVal * 100).toFixed(3));     // as %
      result[`var${label}$`] = parseFloat((varVal * capitalBase).toFixed(2)); // in $
      result[`es${label}$`]  = parseFloat((esVal * capitalBase).toFixed(2));  // in $
    }

    // ── Sharpe Ratio ──────────────────────────────────────────────────────
    // (mean return - risk-free rate) / std deviation of returns
    const mean  = returns.reduce((s, v) => s + v, 0) / n;
    const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1);
    const stdDev = Math.sqrt(variance);
    // Bug fix: zero variance (all-identical returns) causes Infinity sharpe
    if (stdDev < 1e-10) { result.sharpe = null; result.sortinoRatio = null; }

    result.sharpe = stdDev > 0
      ? parseFloat(((mean - rfRate) / stdDev).toFixed(3))
      : null;

    // Annualise: M5 bars = 288 bars/day × 252 trading days = 72,576 bars/year
    // sqrt(72576) ≈ 269.4 for intraday annualisation
    // opts.barsPerYear lets caller override (e.g. 252 for daily trades)
    const barsPerYear = opts.barsPerYear || (252 * 288);  // default: M5 intraday
    result.sharpeAnnualised = result.sharpe != null
      ? parseFloat((result.sharpe * Math.sqrt(barsPerYear)).toFixed(3))
      : null;

    // ── Sortino Ratio ─────────────────────────────────────────────────────
    // Like Sharpe but only penalises downside deviation (returns below rfRate)
    const downsideReturns = returns.filter(r => r < rfRate);
    const downsideVariance = downsideReturns.length > 1
      ? downsideReturns.reduce((s, v) => s + (v - rfRate) ** 2, 0) / (downsideReturns.length - 1)  // safe: length>1
      : 0;
    const downsideStd = Math.sqrt(downsideVariance);

    result.sortino = downsideStd > 0
      ? parseFloat(((mean - rfRate) / downsideStd).toFixed(3))
      : null;
    result.sortinoAnnualised = result.sortino != null
      ? parseFloat((result.sortino * Math.sqrt(barsPerYear)).toFixed(3))
      : null;

    // ── Max Consecutive Loss and Drawdown ─────────────────────────────────
    let peak = 0, equity = 0, maxDD = 0;
    for (const r of returns) {
      equity += r;
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? (peak - equity) / peak : 0;
      if (dd > maxDD) maxDD = dd;
    }
    result.maxDrawdownFromReturns = parseFloat((maxDD * 100).toFixed(3));

    // ── Interpretation labels ─────────────────────────────────────────────
    result.sharpeLabel  = RiskMetrics._sharpeLabel(result.sharpe);
    result.sortinoLabel = RiskMetrics._sharpeLabel(result.sortino);  // same scale
    result.riskProfile  = RiskMetrics._riskProfile(result);

    return result;
  }

  static _sharpeLabel(s) {
    if (s == null)  return 'insufficient_data';
    if (s >= 2.0)   return 'excellent';
    if (s >= 1.0)   return 'good';
    if (s >= 0.5)   return 'acceptable';
    if (s >= 0)     return 'marginal';
    return 'negative';
  }

  static _riskProfile(m) {
    const var95 = m.var95 || 0;
    if (var95 > 5)    return 'HIGH_RISK';
    if (var95 > 2)    return 'MODERATE_RISK';
    if (var95 > 0.5)  return 'LOW_RISK';
    return 'MINIMAL_RISK';
  }

  static _empty(levels) {
    const r = { trades: 0, sharpe: null, sortino: null, riskProfile: 'UNKNOWN' };
    for (const l of levels) {
      const label = Math.round(l * 100);
      r[`var${label}`] = 0; r[`es${label}`] = 0;
      r[`var${label}$`] = 0; r[`es${label}$`] = 0;
    }
    return r;
  }
}

module.exports = { RiskMetrics };
