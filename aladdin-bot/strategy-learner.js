'use strict';
// ── strategy-learner.js ───────────────────────────────────────────────────────
// Pure-statistical ML: analyses completed backtest trades and generates a
// learned strategy configuration.  No external dependencies, no Anthropic API.
//
// What it learns:
//   • Optimal minimum confidence threshold (highest band with ≥55% win rate)
//   • Confidence profile: avg winning vs avg losing confidence
//   • Exit-reason breakdown: which exits (signal / SL / TP) are most profitable
//   • Strategy-bias inference: trend vs mean-reversion based on conf distribution
//   • Regime multiplier adjustments fed back into StrategyManager.decide()
//   • Human-readable recommendation string
//
// API:
//   learnFromBacktest(trades, summary)  → config object (also saves to disk)
//   loadLearnedConfig()                 → config | null (reads from disk)
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

const LEARNED_CONFIG_PATH = path.join(__dirname, 'strategies', 'learned-config.json');
const SCHEMA_VERSION      = 1;
const MIN_BUCKET_SAMPLE   = 3;   // minimum trades in a band to trust its stats
const WIN_RATE_FLOOR      = 55;  // minimum win-rate % to accept a confidence band

// ── Confidence band definitions ───────────────────────────────────────────────
const CONF_BANDS = [
  { label: '40-50', min: 40, max: 50 },
  { label: '50-60', min: 50, max: 60 },
  { label: '60-70', min: 60, max: 70 },
  { label: '70-80', min: 70, max: 80 },
  { label: '80+',   min: 80, max: 101 },
];

function _mean(arr) {
  return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function _pct(n, d) {
  return d > 0 ? parseFloat((n / d * 100).toFixed(1)) : 0;
}

// ── Core learning function ────────────────────────────────────────────────────
function learnFromBacktest(trades, summary = {}) {
  if (!Array.isArray(trades) || trades.length === 0) {
    const empty = {
      schemaVersion:        SCHEMA_VERSION,
      generatedAt:          new Date().toISOString(),
      basedOnBacktestId:    summary.backtestId || 'bt-empty',
      error:                'No trades to learn from',
      learnedMinConfidence: 60,
      tradeCount:           0,
      winRate:              0,
      totalReturn:          summary.totalReturn ?? null,
      avgWinningConfidence: 0,
      avgLosingConfidence:  0,
      strategyBias:         'trend',
      confidenceAnalysis:   {},
      exitReasonAnalysis:   {},
      regimeMultiplierAdjustments: {
        trend:         { TRENDING: 1.5, WEAK_TREND: 0.8, RANGING: 0.4, UNKNOWN: 1.0 },
        meanReversion: { TRENDING: 0.4, WEAK_TREND: 1.2, RANGING: 1.6, UNKNOWN: 1.0 },
        breakout:      { TRENDING: 1.3, WEAK_TREND: 0.9, RANGING: 0.3, UNKNOWN: 0.8 },
      },
      recommendation: 'No trades generated — run a longer backtest for meaningful learning.',
    };
    try {
      fs.writeFileSync(LEARNED_CONFIG_PATH, JSON.stringify(empty, null, 2));
    } catch (_) {}
    return empty;
  }

  const winners = trades.filter(t => t.profit > 0);
  const losers  = trades.filter(t => t.profit <= 0);

  // ── 1. Confidence band analysis ─────────────────────────────────────────────
  const confidenceAnalysis = {};
  for (const band of CONF_BANDS) {
    const inBand = trades.filter(t => t.confidence >= band.min && t.confidence < band.max);
    const bWins  = inBand.filter(t => t.profit > 0);
    confidenceAnalysis[band.label] = {
      count:     inBand.length,
      wins:      bWins.length,
      losses:    inBand.length - bWins.length,
      winRate:   _pct(bWins.length, inBand.length),
      avgProfit: parseFloat(_mean(inBand.map(t => t.profit)).toFixed(2)),
    };
  }

  // Find lowest confidence band with enough data AND acceptable win rate
  let learnedMinConfidence = 60;
  for (const band of CONF_BANDS) {
    const s = confidenceAnalysis[band.label];
    if (s.count >= MIN_BUCKET_SAMPLE && s.winRate >= WIN_RATE_FLOOR) {
      learnedMinConfidence = band.min;
      break;
    }
  }

  // ── 2. Exit reason breakdown ─────────────────────────────────────────────────
  const exitGroups = {};
  for (const t of trades) {
    const r = t.reason || 'unknown';
    if (!exitGroups[r]) exitGroups[r] = [];
    exitGroups[r].push(t);
  }
  const exitReasonAnalysis = {};
  for (const [reason, group] of Object.entries(exitGroups)) {
    const gWins = group.filter(t => t.profit > 0);
    exitReasonAnalysis[reason] = {
      count:     group.length,
      winRate:   _pct(gWins.length, group.length),
      avgProfit: parseFloat(_mean(group.map(t => t.profit)).toFixed(2)),
      totalPnl:  parseFloat(group.reduce((s, t) => s + t.profit, 0).toFixed(2)),
    };
  }

  // ── 3. Winner vs loser profiles ──────────────────────────────────────────────
  const avgWinConf  = parseFloat(_mean(winners.map(t => t.confidence)).toFixed(1));
  const avgLoseConf = parseFloat(_mean(losers.map(t => t.confidence)).toFixed(1));
  const avgWinDur   = Math.round(_mean(winners.map(t => t.duration || 0)));
  const avgLoseDur  = Math.round(_mean(losers.map(t => t.duration || 0)));

  // ── 4. Strategy bias: high-conf (trend) vs low-conf (mean-reversion) ─────────
  const hiConfWinRate = confidenceAnalysis['70-80']?.winRate || 0;
  const loConfWinRate = confidenceAnalysis['50-60']?.winRate || 0;
  const strategyBias  = hiConfWinRate > loConfWinRate + 10 ? 'trend' : 'meanReversion';

  // ── 5. Regime multiplier adjustments ────────────────────────────────────────
  // Shift multipliers proportionally to observed performance delta.
  // Clamped so they never exceed safe bounds (0.2 … 2.0).
  const trendBoost = Math.min(0.3, Math.max(-0.2, (hiConfWinRate - 60) / 100));
  const mrBoost    = Math.min(0.3, Math.max(-0.2, (loConfWinRate  - 50) / 100));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const regimeMultiplierAdjustments = {
    trend: {
      TRENDING:   clamp(parseFloat((1.5 + trendBoost).toFixed(2)), 0.2, 2.0),
      WEAK_TREND: 0.8,
      RANGING:    clamp(parseFloat((0.4 - trendBoost * 0.5).toFixed(2)), 0.2, 1.0),
      UNKNOWN:    1.0,
    },
    meanReversion: {
      TRENDING:   clamp(parseFloat((0.4 - mrBoost * 0.5).toFixed(2)), 0.2, 1.0),
      WEAK_TREND: 1.2,
      RANGING:    clamp(parseFloat((1.6 + mrBoost).toFixed(2)), 0.5, 2.0),
      UNKNOWN:    1.0,
    },
    breakout: {
      TRENDING: 1.3, WEAK_TREND: 0.9, RANGING: 0.3, UNKNOWN: 0.8,
    },
  };

  // ── 6. Human-readable recommendation ────────────────────────────────────────
  const lines = [];

  if (trades.length < 10) {
    lines.push(`Only ${trades.length} trades — run a longer backtest for higher-confidence learning.`);
  } else {
    if (avgWinConf > avgLoseConf + 5) {
      lines.push(`Raise minConfidence to ${learnedMinConfidence}: winning trades averaged ${avgWinConf} vs ${avgLoseConf} for losers.`);
    } else {
      lines.push(`minConfidence stays at ${learnedMinConfidence} (win/loss confidence gap is small).`);
    }
  }

  if (strategyBias === 'trend') {
    lines.push('Trend signals outperformed — boosting trend weight in TRENDING regime.');
  } else {
    lines.push('Mean-reversion signals competitive — boosting MR weight in RANGING regime.');
  }

  const slInfo = exitReasonAnalysis.stop_loss;
  if (slInfo && slInfo.count > 2) {
    const slPct = _pct(slInfo.count, trades.length);
    if (slPct > 40) lines.push(`${slPct}% of exits hit stop-loss — consider tighter SL.`);
  }

  const tpInfo = exitReasonAnalysis.take_profit;
  if (tpInfo && tpInfo.count > 2 && tpInfo.avgProfit > 0) {
    const tpPct = _pct(tpInfo.count, trades.length);
    if (tpPct > 40) lines.push(`${tpPct}% of exits hit take-profit — TP level is well-calibrated.`);
  }

  // ── 7. Assemble config ───────────────────────────────────────────────────────
  const ts    = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const btId  = summary.backtestId || ('bt-' + ts);
  const config = {
    schemaVersion:               SCHEMA_VERSION,
    generatedAt:                 new Date().toISOString(),
    basedOnBacktestId:           btId,
    tradeCount:                  trades.length,
    winRate:                     _pct(winners.length, trades.length),
    totalReturn:                 summary.totalReturn ?? null,
    learnedMinConfidence,
    avgWinningConfidence:        avgWinConf,
    avgLosingConfidence:         avgLoseConf,
    avgWinningDurationMs:        avgWinDur,
    avgLosingDurationMs:         avgLoseDur,
    strategyBias,
    confidenceAnalysis,
    exitReasonAnalysis,
    regimeMultiplierAdjustments,
    recommendation:              lines.join(' '),
  };

  // ── 8. Persist ───────────────────────────────────────────────────────────────
  try {
    fs.writeFileSync(LEARNED_CONFIG_PATH, JSON.stringify(config, null, 2));
    console.log('[Learner] Saved learned-config.json — ' + trades.length + ' trades analysed');
  } catch (err) {
    console.error('[Learner] Failed to save learned-config.json:', err.message);
  }

  return config;
}

// ── Load previously saved config ─────────────────────────────────────────────
function loadLearnedConfig() {
  try {
    if (!fs.existsSync(LEARNED_CONFIG_PATH)) return null;
    const raw = fs.readFileSync(LEARNED_CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);
    if (cfg.schemaVersion !== SCHEMA_VERSION) return null;
    return cfg;
  } catch (_) { return null; }
}

module.exports = {
  learnFromBacktest,
  loadLearnedConfig,
  LEARNED_CONFIG_PATH,
  // exported for tests
  CONF_BANDS,
  MIN_BUCKET_SAMPLE,
  WIN_RATE_FLOOR,
};
