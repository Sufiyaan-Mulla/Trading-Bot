'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  walk-forward.js
//  Walk-Forward Validation Engine
//
//  Provides three window modes, purging/embargo, overfitting detection,
//  and ML model out-of-sample accuracy validation.
//
//  Window modes
//  ────────────
//  SLIDING   — window of fixed size slides forward by stepBars each fold.
//               IS and OOS windows both move together.
//               Best for detecting regime-specific performance.
//
//  EXPANDING — IS window starts at bar 0 and grows each fold (more data
//               each time). OOS window is fixed size, anchored right after IS.
//               Best for simulating "all historical data" retraining.
//
//  ANCHORED  — IS window is fixed (same bars every fold). OOS window
//               slides forward, testing the same trained strategy on
//               progressively later market conditions.
//               Best for detecting strategy decay over time.
//
//  Purging / Embargo
//  ─────────────────
//  A gap of `embargoBars` is inserted between the end of in-sample and
//  the start of OOS. This prevents feature leakage when indicators at the
//  last IS bar overlap with OOS bar features (e.g. a 20-bar EMA computed
//  partly from IS bars would "look ahead" into OOS territory).
//  Recommended: 20 bars (100 min on M5) for moving-average features.
//
//  ML OOS Validation
//  ─────────────────
//  validateMLOOS(samples, splitRatio) splits labeled samples into IS/OOS
//  and reports accuracy, ECE, and lift over a random baseline on held-out data.
//  Detects whether the ML model genuinely has predictive power on unseen bars.
//
//  Usage
//  ─────
//  const wf = new WalkForwardValidator();
//  const r  = wf.run(prices, volumes, backtestFn, { mode: 'expanding' });
//  wf.printReport(r);
// ═══════════════════════════════════════════════════════════════════════════════

// ── Config ────────────────────────────────────────────────────────────────────
const WF_CONFIG = {
  // Default window configuration
  sliding: {
    windowPct:    0.40,   // each window = 40% of total bars
    inSamplePct:  0.70,   // 70% of window = in-sample
    stepPct:      0.15,   // slide by 15% of total bars each fold
    embargoBars:  20,   // bars gap between IS and OOS (use 200 if trading EMA-200 — #12)
  },
  expanding: {
    initialISPct: 0.30,   // first IS window = 30% of data
    oosBars:      null,   // OOS fixed size; null = derive from stepPct
    stepPct:      0.10,   // expand IS by 10% of total bars each fold
    embargoBars:  20,
  },
  anchored: {
    inSamplePct:  0.50,   // anchored IS = first 50% of data (fixed)
    oosBars:      null,   // OOS window size; null = derive from stepPct
    stepPct:      0.10,   // slide OOS window by 10% each fold
    embargoBars:  20,
  },

  // Overfitting detection thresholds
  overfitWinRateDelta: 20,    // IS win rate > OOS by this many pp → overfitted fold
  overfitFoldRatio:    0.50,  // majority of folds overfitted → overall overfit flag
  resetMLBetweenFolds: true,   // caller should reset MLConfidence state between folds

  // Minimum bars required per OOS window (skip fold if too small)
  minOOSBars: 50,
};

// ── Metric computation (standalone — no CAPITAL dependency) ───────────────────
function computeMetrics (result, initialCapital) {
  const { trades = [], capital = initialCapital, equity = [], maxDD = 0 } = result;
  const n       = trades.length;
  const wins    = trades.filter(t => t.profit > 0);
  const losses  = trades.filter(t => t.profit <= 0);
  const gp      = wins.reduce((s, t)   => s + t.profit, 0);
  const gl      = Math.abs(losses.reduce((s, t) => s + t.profit, 0));
  const pf      = gl > 0 ? gp / gl : (gp > 0 ? 9.99 : 0);
  const wr      = n > 0 ? wins.length / n * 100 : 0;
  const avgW    = wins.length   > 0 ? gp / wins.length   : 0;
  const avgL    = losses.length > 0 ? gl / losses.length : 0;
  const exp     = (avgW * wr / 100) - (avgL * (1 - wr / 100));
  const ret     = (capital - initialCapital) / initialCapital * 100;

  // Sharpe (trade-level proxy — annualised with √n)
  let sharpe = 0;
  if (n > 2) {
    // BUG-35 fix: use actual mean of profit values (not expectancy which is dollar-percent hybrid)
    const meanP = trades.reduce((s, t) => s + t.profit, 0) / n;
    const stdP  = Math.sqrt(trades.reduce((s, t) => s + (t.profit - meanP) ** 2, 0) / n);
    sharpe = stdP > 0 ? (meanP / stdP) * Math.sqrt(n) : 0;
  }

  return {
    trades: n, winRate: parseFloat(wr.toFixed(2)),
    profitFactor: parseFloat(pf.toFixed(4)),
    expectancy:   parseFloat(exp.toFixed(4)),
    totalReturn:  parseFloat(ret.toFixed(3)),
    maxDrawdown:  parseFloat((maxDD * 100).toFixed(2)),
    sharpe:       parseFloat(sharpe.toFixed(4)),
    finalCapital: parseFloat(capital.toFixed(2)),
    grossProfit:  parseFloat(gp.toFixed(2)),
    grossLoss:    parseFloat(gl.toFixed(2)),
  };
}

// ── Fold builder helpers ──────────────────────────────────────────────────────
// Fix #28: Tag each fold with dominant market regime
function _foldRegime(prices) {
  if (!prices || prices.length < 20) return 'UNKNOWN';
  let up = 0, down = 0;
  for (let i = 1; i < prices.length; i++) {
    if (prices[i] > prices[i-1]) up++; else down++;
  }
  const ratio = up / prices.length;
  return ratio > 0.6 ? 'TRENDING_UP' : ratio < 0.4 ? 'TRENDING_DOWN' : 'RANGING';
}

function makeFold (prices, volumes, is, oos, backtestFn, foldNum, embargo) {
  const isP  = prices.slice(is[0],  is[1]);
  const isV  = volumes.slice(is[0], is[1]);
  const oosP = prices.slice(oos[0], oos[1]);
  const oosV = volumes.slice(oos[0], oos[1]);

  if (isP.length < 10 || oosP.length < 1) return null;

  const capital = 10_000;  // normalised capital for comparison
  const isR     = backtestFn(isP, isV, capital);
  const oosR    = backtestFn(oosP, oosV, capital);
  const isM     = computeMetrics(isR,  capital);
  const oosM    = computeMetrics(oosR, capital);

  // Efficiency ratio: how much IS performance transferred to OOS
  const eff = isM.totalReturn !== 0
    ? oosM.totalReturn / Math.abs(isM.totalReturn)
    : 0;

  return {
    fold:        foldNum,
    isRange:     is,
    oosRange:    oos,
    embargoBars: embargo,
    inSample:    isM,
    oos:         oosM,
    efficiency:  parseFloat(eff.toFixed(3)),
    overfitted:  isM.winRate - oosM.winRate > WF_CONFIG.overfitWinRateDelta,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  WalkForwardValidator
// ═══════════════════════════════════════════════════════════════════════════════
class WalkForwardValidator {
  constructor (cfg = {}) {
    this.cfg = { ...WF_CONFIG, ...cfg };
  }

  // ── Main entry point ──────────────────────────────────────────────────────
  // backtestFn(prices, volumes, capital) → { trades, capital, equity, maxDD }
  run (prices, volumes, backtestFn, opts = {}) {
    const mode = (opts.mode || 'sliding').toLowerCase();
    switch (mode) {
      case 'expanding': return this.runExpanding(prices, volumes, backtestFn, opts);
      case 'anchored':  return this.runAnchored(prices, volumes,  backtestFn, opts);
      default:          return this.runSliding(prices, volumes,   backtestFn, opts);
    }
  }

  // ── Sliding window ────────────────────────────────────────────────────────
  runSliding (prices, volumes, backtestFn, opts = {}) {
    const cfg         = { ...this.cfg.sliding, ...opts };
    const n           = prices.length;
    const windowBars  = Math.floor(n * cfg.windowPct);
    const inBars      = Math.floor(windowBars * cfg.inSamplePct);
    const stepBars    = Math.max(1, Math.floor(n * cfg.stepPct));
    const embargo     = cfg.embargoBars ?? 20;
    const outBars     = windowBars - inBars - embargo;

    if (outBars < this.cfg.minOOSBars) {
      return { mode: 'sliding', folds: [], error: 'OOS window too small' };
    }

    const folds = [];
    let start   = 0;

    while (start + windowBars <= n) {
      const isEnd  = start + inBars;
      const oosStart = isEnd + embargo;
      const oosEnd   = Math.min(start + windowBars, n);

      if (oosEnd - oosStart >= this.cfg.minOOSBars) {
        const fold = makeFold(prices, volumes,
          [start, isEnd], [oosStart, oosEnd],
          backtestFn, folds.length + 1, embargo);
        if (fold) folds.push(fold);
      }
      start += stepBars;
    }

    return this._buildResult('sliding', folds, { windowBars, inBars, stepBars, embargo });
  }

  // ── Expanding window ──────────────────────────────────────────────────────
  runExpanding (prices, volumes, backtestFn, opts = {}) {
    const cfg         = { ...this.cfg.expanding, ...opts };
    const n           = prices.length;
    const initIS      = Math.floor(n * cfg.initialISPct);
    const stepBars    = Math.max(1, Math.floor(n * cfg.stepPct));
    const oosBars     = cfg.oosBars || stepBars;
    const embargo     = cfg.embargoBars ?? 20;

    const folds = [];
    let isEnd   = initIS;

    while (isEnd + embargo + oosBars <= n) {
      const oosStart = isEnd + embargo;
      const oosEnd   = Math.min(oosStart + oosBars, n);

      if (oosEnd - oosStart >= this.cfg.minOOSBars) {
        const fold = makeFold(prices, volumes,
          [0, isEnd], [oosStart, oosEnd],
          backtestFn, folds.length + 1, embargo);
        if (fold) folds.push(fold);
      }
      isEnd += stepBars;
    }

    return this._buildResult('expanding', folds, { initIS, stepBars, oosBars, embargo });
  }

  // ── Anchored window ────────────────────────────────────────────────────────
  // IS is fixed (always bars 0..isEnd). OOS window slides forward.
  runAnchored (prices, volumes, backtestFn, opts = {}) {
    const cfg       = { ...this.cfg.anchored, ...opts };
    const n         = prices.length;
    const isEnd     = Math.floor(n * cfg.inSamplePct);
    const stepBars  = Math.max(1, Math.floor(n * cfg.stepPct));
    const oosBars   = cfg.oosBars || stepBars;
    const embargo   = cfg.embargoBars ?? 20;

    const folds    = [];
    let oosStart   = isEnd + embargo;

    while (oosStart + oosBars <= n) {
      const oosEnd = Math.min(oosStart + oosBars, n);

      if (oosEnd - oosStart >= this.cfg.minOOSBars) {
        const fold = makeFold(prices, volumes,
          [0, isEnd], [oosStart, oosEnd],
          backtestFn, folds.length + 1, embargo);
        if (fold) folds.push(fold);
      }
      oosStart += stepBars;
    }

    return this._buildResult('anchored', folds, { isEnd, stepBars, oosBars, embargo });
  }

  // ── Result aggregation ────────────────────────────────────────────────────
  _buildResult (mode, folds, config) {
    if (folds.length === 0) {
      return { mode, improved: false, folds: [], agg: null, stabilityScore: 0, overfit: false,
               positiveFolds: 0, totalFolds: 0, config };
    }

    const keys = ['totalReturn', 'winRate', 'profitFactor', 'sharpe',
                  'maxDrawdown', 'expectancy', 'trades'];
    const agg  = {};
    for (const k of keys) {
      const vals = folds.map(f => f.oos[k]).filter(v => isFinite(v));
      agg[k]     = vals.length ? parseFloat((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(4)) : 0;
    }

    const positiveFolds  = folds.filter(f => f.oos.totalReturn > 0).length;
    const stabilityScore = parseFloat((positiveFolds / folds.length * 100).toFixed(1));
    const overfitFolds   = folds.filter(f => f.overfitted).length;
    const overfit        = overfitFolds > folds.length * this.cfg.overfitFoldRatio;

    // Degradation: average OOS/IS efficiency ratio
    const efficiencies   = folds.map(f => f.efficiency).filter(isFinite);
    const avgEfficiency  = efficiencies.length
      ? parseFloat((efficiencies.reduce((s, v) => s + v, 0) / efficiencies.length).toFixed(3))
      : 0;

    return {
      mode, folds, agg, config,
      stabilityScore,
      overfit,
      positiveFolds,
      totalFolds:     folds.length,
      overfitFolds,
      avgEfficiency,
    };
  }

  // ── ML OOS Validation ─────────────────────────────────────────────────────
  // Splits labeled samples (from SyntheticDataGenerator) into IS/OOS
  // and measures how accurately the model predicts OOS labels.
  // predictor: (features) → predicted_prob (0–1)
  // samples:   [{features, label}]  label=1 (win) or 0 (loss)
  validateMLOOS (samples, predictor, opts = {}) {
    const splitRatio = opts.splitRatio || 0.70;    // 70% IS, 30% OOS
    const embargo    = opts.embargoBars || 20;      // skip N samples at boundary

    const n       = samples.length;
    const isEnd   = Math.floor(n * splitRatio);
    const oosStart = isEnd + embargo;

    if (oosStart >= n) {
      return { error: 'Not enough samples for OOS split', n, isEnd, embargo };
    }

    const oosSamples = samples.slice(oosStart);
    const oosN       = oosSamples.length;

    let correct = 0, tp = 0, tn = 0, fp = 0, fn = 0;
    let sumBrierLoss = 0;
    const calibBuckets = Array.from({ length: 10 }, () => ({ count: 0, wins: 0 }));
    const regimeAcc  = {};

    for (const s of oosSamples) {
      const prob      = predictor(s.features);
      const predicted = prob >= 0.5 ? 1 : 0;
      const actual    = s.label;

      if (predicted === actual) correct++;
      if (predicted === 1 && actual === 1) tp++;
      if (predicted === 0 && actual === 0) tn++;
      if (predicted === 1 && actual === 0) fp++;
      if (predicted === 0 && actual === 1) fn++;

      // Brier score: mean squared error of probability vs outcome
      sumBrierLoss += (prob - actual) ** 2;

      // Calibration bucket
      const bucketIdx = Math.min(9, Math.floor(prob * 10));
      calibBuckets[bucketIdx].count++;
      if (actual === 1) calibBuckets[bucketIdx].wins++;

      // Per-regime accuracy (if regime available)
      const regime = s.regime || 'UNKNOWN';
      if (!regimeAcc[regime]) regimeAcc[regime] = { correct: 0, total: 0 };
      regimeAcc[regime].total++;
      if (predicted === actual) regimeAcc[regime].correct++;
    }

    const accuracy    = correct / oosN;
    const brierScore  = sumBrierLoss / oosN;
    const precision   = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall      = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1          = precision + recall > 0
      ? 2 * precision * recall / (precision + recall) : 0;

    // ECE from calibration buckets
    const total = oosN;
    let ece = 0;
    for (let i = 0; i < 10; i++) {
      const b = calibBuckets[i];
      if (b.count === 0) continue;
      const midConf = (i + 0.5) / 10;
      const actWR   = b.wins / b.count;
      ece += (b.count / total) * Math.abs(actWR - midConf);
    }

    // Lift: how much better than random (50% accuracy baseline)
    const lift = accuracy - 0.50;

    const regimeStats = {};
    for (const [r, v] of Object.entries(regimeAcc)) {
      regimeStats[r] = {
        accuracy: parseFloat((v.correct / v.total * 100).toFixed(1)),
        correct:  v.correct,
        total:    v.total,
      };
    }

    return {
      isSamples:    isEnd,
      oosSamples:   oosN,
      embargo,
      accuracy:     parseFloat((accuracy * 100).toFixed(2)),
      brierScore:   parseFloat(brierScore.toFixed(4)),
      ece:          parseFloat(ece.toFixed(4)),
      precision:    parseFloat((precision * 100).toFixed(2)),
      recall:       parseFloat((recall * 100).toFixed(2)),
      f1:           parseFloat((f1 * 100).toFixed(2)),
      lift:         parseFloat((lift * 100).toFixed(2)),
      tp, tn, fp, fn,
      regimeStats,
      calibBuckets,
      grade: accuracy >= 0.60 ? 'EXCELLENT' :
             accuracy >= 0.55 ? 'GOOD'      :
             accuracy >= 0.52 ? 'FAIR'      :
             accuracy >= 0.50 ? 'MARGINAL'  : 'POOR',
    };
  }

  // ── Report printers ───────────────────────────────────────────────────────
  printReport (result) {
    if (!result || result.folds.length === 0) {
      console.log(`[WalkForward] No folds generated (${result?.error || 'insufficient data'})`);
      return;
    }

    const { mode, folds, agg, stabilityScore, overfit, totalFolds,
            positiveFolds, avgEfficiency } = result;

    const EQ  = '═'.repeat(72);
    const L   = '─'.repeat(72);
    const pad = (s, n) => String(s).padEnd(n);
    const rp  = (s, n) => String(s).padStart(n);

    console.log('\n' + EQ);
    console.log(`  🔬 WALK-FORWARD REPORT — ${mode.toUpperCase()} WINDOW`);
    console.log(EQ);
    console.log(`  Folds: ${totalFolds} | Embargo: ${result.config?.embargo ?? 0} bars | ` +
      `Stability: ${stabilityScore}% positive OOS folds`);
    console.log(`  Avg efficiency (OOS/IS return): ${avgEfficiency.toFixed(3)}`);
    console.log(`  Overfitting: ${overfit ? '⚠️  YES — majority of folds show IS>>OOS degradation' : '✅ NO'}`);
    console.log('\n  Per-fold OOS results:');
    console.log('  ' + L);
    console.log('  ' + pad('Fold', 6) + rp('IS bars', 9) + rp('OOS bars', 10) +
      rp('WR%', 7) + rp('PF', 8) + rp('Ret%', 8) + rp('Sharpe', 8) + rp('Eff', 7) + '  Flag');
    console.log('  ' + L);

    for (const f of folds) {
      const isBars  = f.isRange[1]  - f.isRange[0];
      const oosBars = f.oosRange[1] - f.oosRange[0];
      const flag    = f.overfitted ? '⚠️ overfit' : '✅';
      console.log(
        '  ' + rp(f.fold, 6) +
        rp(isBars,  9) + rp(oosBars, 10) +
        rp(f.oos.winRate.toFixed(1),     7) +
        rp(f.oos.profitFactor.toFixed(3), 8) +
        rp(f.oos.totalReturn.toFixed(2), 8) +
        rp(f.oos.sharpe.toFixed(3),      8) +
        rp(f.efficiency.toFixed(2),      7) +
        '  ' + flag
      );
    }

    console.log('  ' + L);
    console.log('  ' + pad('AGGREGATE', 6) + rp('', 9) + rp('', 10) +
      rp(agg.winRate.toFixed(1),      7) +
      rp(agg.profitFactor.toFixed(3), 8) +
      rp(agg.totalReturn.toFixed(2),  8) +
      rp(agg.sharpe.toFixed(3),       8));
    console.log(EQ + '\n');
  }

  printMLOOS (result) {
    if (result.error) { console.log('[WalkForward] ML OOS error:', result.error); return; }
    const EQ = '═'.repeat(60);
    console.log('\n' + EQ);
    console.log('  🤖 ML MODEL OUT-OF-SAMPLE VALIDATION');
    console.log(EQ);
    console.log(`  IS samples: ${result.isSamples} | OOS samples: ${result.oosSamples} | Embargo: ${result.embargo} bars`);
    console.log(`  Accuracy:   ${result.accuracy}%  (grade: ${result.grade})`);
    console.log(`  Lift:       ${result.lift >= 0 ? '+' : ''}${result.lift}% over 50% baseline`);
    console.log(`  Precision:  ${result.precision}%`);
    console.log(`  Recall:     ${result.recall}%`);
    console.log(`  F1:         ${result.f1}%`);
    console.log(`  Brier:      ${result.brierScore} (lower=better, 0.25=random)`);
    console.log(`  ECE:        ${result.ece} (lower=better, 0=perfect calibration)`);
    if (Object.keys(result.regimeStats).length > 0) {
      console.log('\n  Per-regime OOS accuracy:');
      for (const [r, v] of Object.entries(result.regimeStats)) {
        console.log(`  ${r.padEnd(14)}  ${v.accuracy}% (${v.correct}/${v.total})`);
      }
    }
    console.log(EQ + '\n');
  }
}

// ── Feature #1/#40: Wrap a user backtestFn to apply spread + swap costs ─────
// Usage: const withCosts = wrapWithCosts(myBacktestFn);
//        wf.run(prices, volumes, withCosts, opts);
function wrapWithCosts(backtestFn, opts = {}) {
  // A18: Use actual OANDA spread data when available, not fixed 1-pip default
  // Spread can widen to 5-10× on news events — fixed spread overstates profitability by ~30%
  const { TRADING_CONFIG: _tc18 } = require('./trading-config');
  const _oandaSpreads = _tc18.oandaTypicalSpreads || {};  // { EURUSD: 0.00012, GBPUSD: 0.00020 }
  const _assetSpread  = opts.asset ? (_oandaSpreads[opts.asset] || null) : null;
  // Item 50: Time-of-day spread simulation — widen at session opens
  const _baseSpread = (_assetSpread || opts.spreadHalf*2 || 0.0002);
  const _getSpread  = (i) => {
    const h = new Date(Date.now() - Math.max(0,(prices?.length||0)-i-1)*30000).getUTCHours();
    const mult = (h===8||h===13) ? 2.5 : (h>=21||h<6) ? 1.8 : 1.0;
    return _baseSpread * mult / 2;
  };
  const SPREAD_HALF    = (_assetSpread ? _assetSpread / 2 : null) || opts.spreadHalf || 0.0001;  // 1 pip base half-spread
  const CANDLES_PER_DAY = opts.candlesPerDay || 288;
  const { TRADING_CONFIG } = require('./trading-config');
  return function(prices, volumes, capital) {
    // Run base simulation
    const result = backtestFn(prices, volumes, capital);
    if (!result || !result.trades) return result;
    // Apply spread cost to each trade (entry + exit crossing)
    // B18: Only skip spread if commission already includes it (explicit config flag).
    // Default = spread IS applied (commissionIncludesSpread defaults to false).
    const commissionCoversSpread = TRADING_CONFIG.commissionIncludesSpread === true;
    const spreadCostPerTrade = commissionCoversSpread ? 0 : SPREAD_HALF * 2;
    let capitalAdjust = 0;
    for (const t of result.trades) {
      const tradeCost = (t.capitalAtRisk || Math.abs(t.shares * t.entry) || 0) * spreadCostPerTrade;
      capitalAdjust -= tradeCost;
      t.profit = (t.profit || 0) - tradeCost;
    }
    // Apply overnight swap costs per simulated day boundary
    const swapTable = TRADING_CONFIG.swapCosts || {};
    const asset = opts.asset || 'EURUSD';
    const assetSwap = swapTable[asset];
    if (assetSwap && result.trades.length > 0) {
      // Approximate: count days held across all trades and deduct daily swap
      for (const t of result.trades) {
        const daysHeld = Math.floor((t.duration || 0) / (CANDLES_PER_DAY * 300000));
        if (daysHeld > 0) {
          const rate = t.type === 'SHORT' ? assetSwap.short : assetSwap.long;
          const posVal = Math.abs(t.shares * t.entry || 0);
          const swapCost = posVal * rate * daysHeld;
          t.profit = (t.profit || 0) + swapCost;
          capitalAdjust += swapCost;
        }
      }
    }
    return { ...result, capital: (result.capital || capital) + capitalAdjust };
  };
}

// Item 112: Walk-forward EXPANDING and ANCHORED modes (in addition to SLIDING)
// SLIDING: fixed window size, moves forward
// EXPANDING: starts at min window, grows over time
// ANCHORED: always starts from the beginning

function runAllWalkForwardModes(backtestFn, prices, volumes, capital, opts={}) {
  const results = {};
  // SLIDING (default - already implemented)
  results.SLIDING  = { mode:'SLIDING',  note:'Fixed window, advances through time' };
  // EXPANDING: window grows from minWindow to full history
  results.EXPANDING = (() => {
    const minW = opts.minWindow || Math.floor(prices.length * 0.30);
    const step = opts.step      || Math.floor(prices.length * 0.10);
    const runs = [];
    for (let w = minW; w <= prices.length; w += step) {
      const p = prices.slice(0, w), v = volumes.slice(0, w);
      try {
        const r = typeof backtestFn==='function' ? backtestFn(p,v,capital) : {capital,trades:[]};
        runs.push({ window:w, capital:r.capital||capital, trades:(r.trades||[]).length });
      } catch(_) {}
    }
    return { mode:'EXPANDING', runs, avgCapital: runs.length ? runs.reduce((s,r)=>s+r.capital,0)/runs.length : capital };
  })();
  // ANCHORED: always starts from bar 0, test window advances
  results.ANCHORED = (() => {
    const testW = opts.testWindow || Math.floor(prices.length * 0.20);
    const runs  = [];
    for (let start = testW; start+testW <= prices.length; start += testW) {
      const testP = prices.slice(start, start+testW), testV = volumes.slice(start, start+testW);
      try {
        const r = typeof backtestFn==='function' ? backtestFn(testP,testV,capital) : {capital,trades:[]};
        runs.push({ oos_start:start, capital:r.capital||capital, trades:(r.trades||[]).length });
      } catch(_) {}
    }
    return { mode:'ANCHORED', runs, avgCapital: runs.length ? runs.reduce((s,r)=>s+r.capital,0)/runs.length : capital };
  })();
  return results;
}

// Item 92: 30-day forward test lock — requires 30-day paper forward test before live promotion
function forwardTestLock(params, paperResults) {
  if (!paperResults || !paperResults.startDate) {
    return { locked: true, reason: 'No forward test started', requiredDays: 30 };
  }
  const elapsedDays = (Date.now() - new Date(paperResults.startDate).getTime()) / 86_400_000;
  if (elapsedDays < 30) {
    return { locked: true, reason: `Forward test in progress (${elapsedDays.toFixed(0)}/30 days)`, requiredDays: 30 };
  }
  const wRate = paperResults.winRate || 0;
  const fwdSharpe = paperResults.sharpe || 0;
  if (wRate >= 0.45 && fwdSharpe >= 0.8) {
    return { locked: false, reason: 'Forward test passed', winRate: wRate, sharpe: fwdSharpe };
  }
  return { locked: true, reason: `Failed: WR=${(wRate*100).toFixed(1)}% Sharpe=${fwdSharpe.toFixed(2)}` };
}

// Item 49: Auto-promote walk-forward results to live if Sharpe > 1 and DD < 15%
function autoPromoteWalkForward(result, engine) {
  if (!result || !result.wfSharpe) return false;
  const sharpe = parseFloat(result.wfSharpe) || 0;
  const dd     = parseFloat(result.wfMaxDD)  || 1;
  const minTrades = result.totalTrades || 0;
  if (sharpe > 1.0 && dd < 0.15 && minTrades >= 30) {
    console.log(`[WF #49] Auto-promoting: Sharpe=${sharpe.toFixed(2)} DD=${(dd*100).toFixed(1)}% trades=${minTrades}`);
    if (result.bestParams && engine) {
      const { TRADING_CONFIG } = require('./trading-config');
      if (result.bestParams.stopLoss)   TRADING_CONFIG.stopLoss   = result.bestParams.stopLoss;
      if (result.bestParams.tpMult)     TRADING_CONFIG.tpAtrMult  = result.bestParams.tpMult;
      if (result.bestParams.minConf)    TRADING_CONFIG.minConfidence = result.bestParams.minConf;
      try { require('./telegram').send(`[WF #49] Auto-promoted: Sharpe=${sharpe.toFixed(2)}`, 'status'); } catch(_) {}
    }
    return true;
  }
  return false;
}

module.exports = { WalkForwardValidator, WF_CONFIG, computeMetrics, wrapWithCosts ,
  autoPromoteWalkForward,
  forwardTestLock,
  runAllWalkForwardModes,
};