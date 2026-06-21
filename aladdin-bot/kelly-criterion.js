'use strict';
// ── kelly-criterion.js ────────────────────────────────────────────────────────
const { TRADING_CONFIG } = require('./trading-config');

class KellyCriterion {
  static calculate(trades, confidence) {
    const cfg = TRADING_CONFIG;
    // BUG-53 fix: use only recent trades (default last 50) — early trades from different
    // regimes/strategies pollute win rate and payoff ratio, causing oversized positions
    const lookback = cfg.kellyLookback || 50;
    const recent = trades.length > lookback ? trades.slice(-lookback) : trades;

    if (recent.length === 0) {
      // BUG-6 fix: use consistent label 'fixed_insufficient_data' for all cases
      // where Kelly cannot run (0 trades and <minTrades are the same situation)
      return { fraction: cfg.positionSize,
        details: { method: 'fixed_insufficient_data', fraction: cfg.positionSize,
          tradesAnalysed: 0, required: cfg.kellyMinTrades } };
    }
    if (!cfg.kellyEnabled || recent.length < cfg.kellyMinTrades) {
      return {
        fraction: cfg.positionSize,
        details: { method: recent.length < cfg.kellyMinTrades ? 'fixed_insufficient_data' : 'disabled',
          tradesAnalysed: recent.length, required: cfg.kellyMinTrades, fraction: cfg.positionSize }
      };
    }
    const wins   = recent.filter(t => t.profit > 0);
    const losses = recent.filter(t => t.profit <= 0);

    const winRate    = wins.length / recent.length;
    if (wins.length === 0) {
      return { fraction: cfg.kellyMinSize || cfg.positionSize * 0.5,
        details: { method: 'fixed_all_losses', fraction: cfg.kellyMinSize, tradesAnalysed: recent.length } };
    }
    // B16: NaN-safe profitPercent helper — works for backtest trades missing capitalAtRisk
    // Fallback chain: profitPercent → profit/capitalAtRisk → profit/cost → 0
    const _pct = (t) => {
      const p = t.profitPercent;
      if (p != null && isFinite(p) && p !== 0) return Math.abs(p) / 100;
      const car = t.capitalAtRisk || t.cost || t.positionCost || 0;
      if (car > 0 && isFinite(t.profit)) return Math.abs(t.profit) / car;
      return 0;
    };

    if (losses.length === 0) {
    const avgW = wins.reduce((s,t) => s + _pct(t), 0) / wins.length;
      const halfKelly = Math.min(cfg.kellyMaxSize, Math.max(cfg.kellyMinSize, avgW * 0.5));
      // BUG-7 fix: include all expected detail fields so dashboard/logs never see undefined
      return { fraction: halfKelly,
        details: { method: 'half_kelly_all_wins', fraction: halfKelly,
          tradesAnalysed: recent.length, winRate: '100.0', lossRate: '0.0',
          payoffRatio: 'N/A', rawKelly: (avgW * 0.5 * 100).toFixed(2),
          scaledKelly: (halfKelly * 100).toFixed(2), confWeight: '100.0',
          finalFraction: (halfKelly * 100).toFixed(2), confidence } };
    }
    const lossRate   = 1 - winRate;
    const avgWinPct  = wins.reduce((s,t) => s + Math.abs(isFinite(t.profitPercent) ? t.profitPercent : (t.profit / Math.max(t.capitalAtRisk||1000, 1) * 100)), 0) / wins.length / 100;
    const avgLossPct = losses.reduce((s,t) => s + _pct(t), 0) / losses.length;
    if (!avgLossPct || isNaN(avgLossPct)) {
      return { fraction: cfg.positionSize,
        details: { method: 'fixed_invalid_loss_data', fraction: cfg.positionSize } };
    }
    const payoffRatio    = avgWinPct / avgLossPct;
    const rawKelly       = (payoffRatio * winRate - lossRate) / payoffRatio;
    const scaledKelly    = rawKelly * cfg.kellyFraction;
    const confWeight     = Math.max(0, Math.min(1, (confidence - 50) / 45));
    const blendedFraction = cfg.kellyMinSize + (scaledKelly - cfg.kellyMinSize) * confWeight;
    const finalFraction   = Math.max(cfg.kellyMinSize, Math.min(cfg.kellyMaxSize, blendedFraction));
    return {
      fraction: finalFraction,
      details: { method: 'kelly', tradesAnalysed: recent.length, lookback,
        winRate: (winRate*100).toFixed(1), lossRate: (lossRate*100).toFixed(1),
        payoffRatio: payoffRatio.toFixed(3), rawKelly: (rawKelly*100).toFixed(2),
        scaledKelly: (scaledKelly*100).toFixed(2), confWeight: (confWeight*100).toFixed(1),
        finalFraction: (finalFraction*100).toFixed(2), confidence }
    };
  }
}

// #75: Integrate SessionRiskBudget for session-specific risk caps
const _origCalc = KellyCriterion.calculate.bind(KellyCriterion);
KellyCriterion.calculate = function(trades, confidence, session) {
  const result = _origCalc(trades, confidence);
  try {
    const { SessionRiskBudget } = require('./risk-improvements');
    const budget = new SessionRiskBudget();
    const sessionMax = budget.getMaxRisk(session || new Date().getUTCHours());
    if (result.fraction > sessionMax) {
      result.fraction = sessionMax;
      result.details  = result.details || {};
      result.details.sessionCap = sessionMax;
      result.details.session    = session;
    }
  } catch(_) {}
  return result;
};

// Item #37: Seasonal pattern bias — monthly Kelly adjustment
// Some pairs have statistically significant monthly tendencies
const SEASONAL_BIAS = {
  // [month_0_to_11]: adjustment multiplier (1.0 = neutral)
  EURUSD: [1.0, 0.9, 1.0, 1.0, 0.9, 0.95, 0.9, 0.95, 1.0, 1.05, 0.95, 0.9],  // USD strong Sept-Oct
  USDJPY: [1.0, 1.0, 1.0, 0.95, 1.0, 0.9, 0.9, 1.0, 1.05, 1.0, 0.95, 1.0],
};

KellyCriterion.seasonalMultiplier = function(asset) {
  const month = new Date().getUTCMonth();
  const table = SEASONAL_BIAS[asset] || SEASONAL_BIAS[(asset||'').replace('/','')];
  return table ? (table[month] || 1.0) : 1.0;
};

module.exports = { KellyCriterion };
