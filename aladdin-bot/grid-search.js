'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  grid-search.js
//  Parameter Grid Search with Validation Holdout & Overfitting Protection
//
//  Why the existing sensitivity sweep is not enough
//  ─────────────────────────────────────────────────
//  param-stability.js varies one parameter at a time on the full dataset.
//  This means the "best" parameter value is chosen on the same data that
//  it will be evaluated on — classic in-sample overfitting. A parameter
//  that looks great on the training period may simply be curve-fitted to
//  that specific market regime.
//
//  What this module provides
//  ──────────────────────────
//  Three-way data split (Train / Validation / Test)
//    Train      — used only to run each parameter combination
//    Validation — used only to SELECT which combination wins
//    Test       — used only to REPORT the final honest OOS score
//                 (never seen until the winning params are already locked in)
//
//  Overfitting diagnostics
//    • IS/Val efficiency ratio: how much train performance survived validation
//    • Val/Test efficiency ratio: detects if validation was accidentally overfitted
//    • WR delta: IS win rate minus OOS win rate (> 15 pp = suspicious)
//    • Double-dip flag: warns if val score >> test score
//
//  Search strategies
//    RANDOM    — sample N random combinations from the full parameter grid
//                fast, finds good regions without exhaustive enumeration
//    EXHAUSTIVE— test every combination (only practical for small grids)
//
//  Nested Walk-Forward
//    runNested() wraps the grid search in an outer walk-forward loop.
//    Each outer fold has its own inner search (Train→Val) and reports
//    Test performance on the next unseen window. This is the gold standard
//    for avoiding look-ahead bias in parameter selection.
//
//  Usage
//  ─────
//  const gs = new GridSearchValidator();
//  const r  = gs.run(prices, volumes, { strategy: 'random', nSamples: 100 });
//  gs.printReport(r);
// ═══════════════════════════════════════════════════════════════════════════════

const {
  runParamBacktest,
  calcMetrics,
  BASELINE,
  PARAM_RANGES,
} = require('./param-stability');

// ── Configuration ─────────────────────────────────────────────────────────────
const GS_CONFIG = {
  // Three-way split ratios (must sum to 1.0)
  trainRatio: 0.50,
  valRatio:   0.25,
  testRatio:  0.25,

  // Bars gap between each split (prevents feature leakage)
  embargoBars: 20,

  // Default random search: number of combinations to sample
  nSamples: 100,

  // Top-K: number of best train results to carry forward to validation
  topK: 10,

  // Primary scoring metric for ranking combinations
  // 'profitFactor' | 'sharpe' | 'composite'
  scoringMetric: 'composite',

  // Overfitting thresholds
  maxWRDelta:        15,    // IS win rate - OOS win rate > this → suspicious
  maxEfficiencyDrop: 0.30,  // if OOS/IS < 1 - this → significant degradation

  // Minimum trades in a period to consider it valid
  minTrades: 3,
};

// ── Composite scoring ─────────────────────────────────────────────────────────
function compositeScore (m) {
  if (!m || m.trades < 1) return -Infinity;
  const pfNorm  = Math.min(isFinite(m.profitFactor) ? m.profitFactor : 0, 5) / 5;
  const wrNorm  = m.winRate / 100;
  const shNorm  = Math.max(0, Math.min(isFinite(m.sharpe) ? m.sharpe : 0, 5)) / 5;
  return pfNorm * 0.40 + wrNorm * 0.30 + shNorm * 0.30;
}

function scoreResult (m, metric) {
  if (!m || m.trades < 1) return -Infinity;
  switch (metric) {
    case 'profitFactor': return isFinite(m.profitFactor) ? m.profitFactor : 0;
    case 'sharpe':       return isFinite(m.sharpe) ? m.sharpe : 0;
    case 'totalReturn':  return m.totalReturn;
    default:             return compositeScore(m);
  }
}

// ── Parameter grid helpers ─────────────────────────────────────────────────────

// Generate all combinations (Cartesian product) — use only for small grids
function allCombinations (paramRanges) {
  const keys  = paramRanges.map(p => p.param);
  const vals  = paramRanges.map(p => p.values);
  const combos = [{}];
  for (let i = 0; i < keys.length; i++) {
    const next = [];
    for (const combo of combos) {
      for (const v of vals[i]) {
        // checkpoint
      if (next.length>0 && next.length%10===0){try{const _p=require('path'),_f=require('fs');_f.mkdirSync(_p.join(__dirname,'trade_logs'),{recursive:true});_f.writeFileSync(_p.join(__dirname,'trade_logs','grid-checkpoint.json'),JSON.stringify({results:next,ts:Date.now()}));}catch(_e){}}
      next.push({ ...combo, [keys[i]]: v });
      }
    }
    combos.length = 0;
    combos.push(...next);
  }
  return combos;
}

// Sample N random combinations from the parameter space
function randomCombinations (paramRanges, n, seed = 42) {
  let s = seed;
  const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xFFFFFFFF; };
  const combos = [];
  for (let i = 0; i < n; i++) {
    const cfg = {};
    for (const { param, values } of paramRanges) {
      cfg[param] = values[Math.floor(rng() * values.length)];
    }
    combos.push(cfg);
  }
  // Deduplicate
  const seen = new Set();
  return combos.filter(c => {
    const key = JSON.stringify(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Overfitting diagnostics ───────────────────────────────────────────────────
function overfitDiagnostics (train, val, test, cfg) {
  const flags = [];

  if (train && val) {
    const wrDelta  = (train.winRate || 0) - (val.winRate || 0);
    const effRatio = train.totalReturn !== 0
      ? (val.totalReturn || 0) / Math.abs(train.totalReturn)
      : 0;
    if (wrDelta > cfg.maxWRDelta) {
      flags.push(`IS win rate ${train.winRate.toFixed(1)}% >> Val ${val.winRate.toFixed(1)}% (Δ${wrDelta.toFixed(1)}pp) — possible overfit`);
    }
    if (effRatio < 1 - cfg.maxEfficiencyDrop && train.totalReturn > 0) {
      flags.push(`Val/IS efficiency ${(effRatio * 100).toFixed(0)}% — significant IS→Val degradation`);
    }
  }

  if (val && test) {
    const valWRDelta = (val.winRate || 0) - (test.winRate || 0);
    if (valWRDelta > cfg.maxWRDelta) {
      flags.push(`Val WR ${val.winRate.toFixed(1)}% >> Test ${test.winRate.toFixed(1)}% (Δ${valWRDelta.toFixed(1)}pp) — double-dip risk`);
    }
  }

  return {
    flags,
    overfit:         flags.length > 0,
    trainValDelta:   train && val ? parseFloat(((train.winRate||0) - (val.winRate||0)).toFixed(2)) : null,
    valTestDelta:    val && test  ? parseFloat(((val.winRate||0)   - (test.winRate||0)).toFixed(2)) : null,
    trainEfficiency: train && val && train.totalReturn !== 0
      ? parseFloat(((val.totalReturn||0) / Math.abs(train.totalReturn)).toFixed(3))
      : null,
    valEfficiency:   val && test && val.totalReturn !== 0
      ? parseFloat(((test.totalReturn||0) / Math.abs(val.totalReturn)).toFixed(3))
      : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GridSearchValidator
// ═══════════════════════════════════════════════════════════════════════════════
class GridSearchValidator {
  constructor (cfg = {}) {
    this.cfg = { ...GS_CONFIG, ...cfg };
  }

  // ── Main entry point ──────────────────────────────────────────────────────
  run (prices, volumes, opts = {}) {
    const strategy    = opts.strategy || 'random';
    const paramRanges = opts.paramRanges || PARAM_RANGES;

    let combos;
    if (strategy === 'exhaustive') {
      combos = allCombinations(paramRanges);
      if (combos.length > 5000) {
        console.warn(`[GridSearch] Exhaustive grid has ${combos.length} combinations — switching to random (${this.cfg.nSamples})`);
        combos = randomCombinations(paramRanges, opts.nSamples || this.cfg.nSamples, opts.seed || 42);
      }
    } else {
      combos = randomCombinations(paramRanges, opts.nSamples || this.cfg.nSamples, opts.seed || 42);
    }

    return this._runSearch(prices, volumes, combos, opts);
  }

  // ── Core search logic ─────────────────────────────────────────────────────
  _runSearch (prices, volumes, combos, opts = {}) {
    const cfg       = { ...this.cfg, ...opts };
    const n         = prices.length;
    const embargo   = cfg.embargoBars;
    const metric    = cfg.scoringMetric || 'composite';
    const topK      = cfg.topK;

    // ── Three-way split ─────────────────────────────────────────────────────
    const trainEnd  = Math.floor(n * cfg.trainRatio);
    const valStart  = trainEnd  + embargo;
    const valEnd    = valStart  + Math.floor(n * cfg.valRatio);
    const testStart = valEnd    + embargo;
    const testEnd   = n;

    if (testStart >= testEnd || valStart >= valEnd || trainEnd < 50) {
      return {
        error: 'Insufficient data for three-way split',
        n, trainEnd, valStart, valEnd, testStart,
      };
    }

    const trainP = prices.slice(0,         trainEnd);
    const trainV = volumes.slice(0,         trainEnd);
    const valP   = prices.slice(valStart,   valEnd);
    const valV   = volumes.slice(valStart,  valEnd);
    const testP  = prices.slice(testStart,  testEnd);
    const testV  = volumes.slice(testStart, testEnd);

    // ── Phase 1: Train — score all combinations ─────────────────────────────
    const trainResults = [];
    for (const combo of combos) {
      const cfg_  = { ...BASELINE, ...combo };
      const r     = runParamBacktest(trainP, trainV, cfg_);
      const m     = calcMetrics(r);
      trainResults.push({ combo, trainMetrics: m, trainScore: scoreResult(m, metric) });
    }

    // Sort by train score descending, take top-K
    trainResults.sort((a, b) => b.trainScore - a.trainScore);
    const topCandidates = trainResults.slice(0, topK);

    // ── Phase 2: Validation — pick winner without touching test ────────────
    const valResults = [];
    for (const cand of topCandidates) {
      const cfg_  = { ...BASELINE, ...cand.combo };
      const r     = runParamBacktest(valP, valV, cfg_);
      const m     = calcMetrics(r);
      valResults.push({
        combo:        cand.combo,
        trainMetrics: cand.trainMetrics,
        trainScore:   cand.trainScore,
        valMetrics:   m,
        valScore:     scoreResult(m, metric),
      });
    }

    valResults.sort((a, b) => b.valScore - a.valScore);
    const winner = valResults[0];

    // ── Phase 3: Test — honest final OOS score (locked params) ─────────────
    const winnerCfg  = { ...BASELINE, ...winner.combo };
    const testResult = runParamBacktest(testP, testV, winnerCfg);
    const testMetrics = calcMetrics(testResult);

    // Also score baseline on all three splits for comparison
    const baselineTrain = calcMetrics(runParamBacktest(trainP, trainV, BASELINE));
    const baselineVal   = calcMetrics(runParamBacktest(valP,   valV,   BASELINE));
    const baselineTest  = calcMetrics(runParamBacktest(testP,  testV,  BASELINE));

    const diag = overfitDiagnostics(winner.trainMetrics, winner.valMetrics, testMetrics, cfg);

    return {
      strategy:       combos.length <= allCombinations(PARAM_RANGES.slice(0,1)).length * 2
        ? 'exhaustive' : 'random',
      totalCombos:    combos.length,
      topK,
      metric,
      split: {
        trainBars:  trainEnd,
        valBars:    valEnd - valStart,
        testBars:   testEnd - testStart,
        embargo,
      },
      winner: {
        params:       winner.combo,
        trainMetrics: winner.trainMetrics,
        valMetrics:   winner.valMetrics,
        testMetrics,
        trainScore:   parseFloat(winner.trainScore.toFixed(4)),
        valScore:     parseFloat(winner.valScore.toFixed(4)),
        testScore:    parseFloat(scoreResult(testMetrics, metric).toFixed(4)),
      },
      baseline: {
        trainMetrics: baselineTrain,
        valMetrics:   baselineVal,
        testMetrics:  baselineTest,
      },
      topCandidates:  valResults.slice(0, Math.min(5, valResults.length)),
      diagnostics:    diag,
    };
  }

  // ── Nested walk-forward grid search ───────────────────────────────────────
  // Outer walk-forward folds each get their own inner grid search.
  // Eliminates look-ahead bias: params are always selected on data
  // that precedes the test window.
  runNested (prices, volumes, opts = {}) {
    const cfg         = { ...this.cfg, ...opts };
    const n           = prices.length;
    const outerStep   = opts.outerStepPct    || 0.15;
    const outerWindow = opts.outerWindowPct  || 0.60;
    const innerTrain  = opts.innerTrainRatio || 0.60;   // of the IS window
    const innerVal    = opts.innerValRatio   || 0.20;   // of the IS window
    const embargo     = cfg.embargoBars;
    const paramRanges = opts.paramRanges || PARAM_RANGES;
    const nSamples    = opts.nSamples    || Math.min(this.cfg.nSamples, 30);  // fast for nested

    const windowBars  = Math.floor(n * outerWindow);
    const stepBars    = Math.floor(n * outerStep);
    const folds       = [];
    let   start       = 0;

    while (start + windowBars <= n) {
      const isEnd    = start + Math.floor(windowBars * (innerTrain + innerVal));
      const testStart = isEnd + embargo;
      const testEnd   = Math.min(start + windowBars, n);

      if (testEnd - testStart < 30) { start += stepBars; continue; }

      // IS split into Train + Val for inner search
      const trainEnd = start + Math.floor(windowBars * innerTrain);
      const valStart = trainEnd + embargo;
      const valEnd   = isEnd;

      const combos   = randomCombinations(paramRanges, nSamples, 42 + folds.length * 17);
      const trainP   = prices.slice(start,      trainEnd);
      const trainV   = volumes.slice(start,     trainEnd);
      const valP     = prices.slice(valStart,   valEnd);
      const valV     = volumes.slice(valStart,  valEnd);
      const testP    = prices.slice(testStart,  testEnd);
      const testV    = volumes.slice(testStart, testEnd);

      // Inner search: Train → Val → pick winner
      const trainRes = combos.map(combo => {
        const m = calcMetrics(runParamBacktest(trainP, trainV, { ...BASELINE, ...combo }));
        return { combo, score: scoreResult(m, cfg.scoringMetric || 'composite'), trainMetrics: m };
      }).sort((a, b) => b.score - a.score).slice(0, cfg.topK);

      const valRes = trainRes.map(cand => {
        const m = calcMetrics(runParamBacktest(valP, valV, { ...BASELINE, ...cand.combo }));
        return { ...cand, valScore: scoreResult(m, cfg.scoringMetric || 'composite'), valMetrics: m };
      }).sort((a, b) => b.valScore - a.valScore);

      const foldWinner = valRes[0];
      const testM = calcMetrics(runParamBacktest(testP, testV, { ...BASELINE, ...foldWinner.combo }));
      const diag  = overfitDiagnostics(foldWinner.trainMetrics, foldWinner.valMetrics, testM, cfg);

      folds.push({
        fold:         folds.length + 1,
        outerRange:   [start, start + windowBars],
        testRange:    [testStart, testEnd],
        bestParams:   foldWinner.combo,
        trainMetrics: foldWinner.trainMetrics,
        valMetrics:   foldWinner.valMetrics,
        testMetrics:  testM,
        diagnostics:  diag,
      });

      start += stepBars;
    }

    if (folds.length === 0) return { error: 'No folds generated', n };

    // Aggregate test metrics across folds
    const keys = ['totalReturn', 'winRate', 'profitFactor', 'sharpe', 'maxDrawdown'];
    const agg  = {};
    for (const k of keys) {
      const vals = folds.map(f => f.testMetrics[k]).filter(v => isFinite(v));
      agg[k] = vals.length ? parseFloat((vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(4)) : 0;
    }

    const positiveFolds  = folds.filter(f => f.testMetrics.totalReturn > 0).length;
    const stabilityScore = parseFloat((positiveFolds / folds.length * 100).toFixed(1));
    const overfitFolds   = folds.filter(f => f.diagnostics.overfit).length;

    return {
      mode: 'nested_walk_forward',
      totalFolds: folds.length,
      folds,
      agg,
      stabilityScore,
      positiveFolds,
      overfitFolds,
      overallOverfit: overfitFolds > folds.length * 0.5,
    };
  }

  // ── Report printer ────────────────────────────────────────────────────────
  printReport (result) {
    if (result.error) {
      console.log(`[GridSearch] Error: ${result.error}`);
      return;
    }

    const EQ  = '═'.repeat(72);
    const L   = '─'.repeat(72);
    const fmt = (v, d = 2) => isFinite(v) ? v.toFixed(d) : '∞';
    const rp  = (s, n) => String(s).padStart(n);
    const pad = (s, n) => String(s).padEnd(n);

    if (result.mode === 'nested_walk_forward') {
      this._printNestedReport(result);
      return;
    }

    const { winner, baseline, diagnostics, split } = result;

    console.log('\n' + EQ);
    console.log('  🔍 GRID SEARCH — THREE-WAY VALIDATION REPORT');
    console.log(EQ);
    console.log(`  Strategy: ${result.strategy} | Combinations tested: ${result.totalCombos} | Top-K: ${result.topK}`);
    console.log(`  Split: Train=${split.trainBars}bars / Val=${split.valBars}bars / Test=${split.testBars}bars | Embargo=${split.embargo}bars`);
    console.log(`  Scoring metric: ${result.metric}`);

    console.log('\n  WINNER PARAMETERS:');
    for (const [k, v] of Object.entries(winner.params)) {
      console.log(`  ${pad(k, 16)} = ${v}`);
    }

    console.log('\n  ' + pad('Metric', 20) + rp('Train', 12) + rp('Validation', 12) + rp('TEST (OOS)', 12) + rp('Baseline', 12));
    console.log('  ' + L);
    const rows = [
      ['Win Rate %',     winner.trainMetrics.winRate,      winner.valMetrics.winRate,      winner.testMetrics.winRate,     baseline.testMetrics.winRate],
      ['Profit Factor',  winner.trainMetrics.profitFactor,  winner.valMetrics.profitFactor,  winner.testMetrics.profitFactor, baseline.testMetrics.profitFactor],
      ['Total Return %', winner.trainMetrics.totalReturn,   winner.valMetrics.totalReturn,   winner.testMetrics.totalReturn,  baseline.testMetrics.totalReturn],
      ['Sharpe',         winner.trainMetrics.sharpe,        winner.valMetrics.sharpe,        winner.testMetrics.sharpe,       baseline.testMetrics.sharpe],
      ['Max Drawdown %', winner.trainMetrics.maxDrawdown,   winner.valMetrics.maxDrawdown,   winner.testMetrics.maxDrawdown,  baseline.testMetrics.maxDrawdown],
      ['Trades',         winner.trainMetrics.trades,        winner.valMetrics.trades,        winner.testMetrics.trades,       baseline.testMetrics.trades],
    ];
    for (const [label, ...vals] of rows) {
      console.log('  ' + pad(label, 20) + vals.map(v => rp(fmt(v), 12)).join(''));
    }

    console.log('\n  OVERFITTING DIAGNOSTICS:');
    console.log('  ' + L);
    console.log(`  Train→Val WR delta:  ${diagnostics.trainValDelta !== null ? diagnostics.trainValDelta.toFixed(1) + 'pp' : 'n/a'} ${diagnostics.trainValDelta > 15 ? '⚠️' : '✅'}`);
    console.log(`  Val→Test WR delta:   ${diagnostics.valTestDelta  !== null ? diagnostics.valTestDelta.toFixed(1)  + 'pp' : 'n/a'} ${diagnostics.valTestDelta  > 15 ? '⚠️' : '✅'}`);
    console.log(`  Train→Val efficiency: ${diagnostics.trainEfficiency !== null ? (diagnostics.trainEfficiency*100).toFixed(0)+'%' : 'n/a'}`);
    console.log(`  Val→Test efficiency:  ${diagnostics.valEfficiency   !== null ? (diagnostics.valEfficiency*100).toFixed(0)+'%'  : 'n/a'}`);
    if (diagnostics.flags.length > 0) {
      console.log('\n  ⚠️  WARNINGS:');
      for (const f of diagnostics.flags) console.log(`  • ${f}`);
    } else {
      console.log('\n  ✅ No overfitting signals detected');
    }
    console.log(EQ + '\n');
  }

  _printNestedReport (result) {
    const EQ = '═'.repeat(72);
    const L  = '─'.repeat(72);
    const fmt = v => isFinite(v) ? v.toFixed(2) : '∞';

    console.log('\n' + EQ);
    console.log('  🔍 NESTED WALK-FORWARD GRID SEARCH REPORT');
    console.log(EQ);
    console.log(`  Folds: ${result.totalFolds} | Stability: ${result.stabilityScore}% positive OOS folds`);
    console.log(`  Overall overfit: ${result.overallOverfit ? '⚠️ YES' : '✅ NO'} (${result.overfitFolds}/${result.totalFolds} folds flagged)`);

    console.log('\n  Per-fold OOS results:');
    console.log('  ' + L);
    console.log('  ' + 'Fold'.padStart(5) + 'WR%'.padStart(8) + 'PF'.padStart(8) +
      'Ret%'.padStart(8) + 'Sharpe'.padStart(8) + '  Overfit');
    console.log('  ' + L);
    for (const f of result.folds) {
      const m = f.testMetrics;
      console.log('  ' + String(f.fold).padStart(5) +
        fmt(m.winRate).padStart(8) + fmt(m.profitFactor).padStart(8) +
        fmt(m.totalReturn).padStart(8) + fmt(m.sharpe).padStart(8) +
        '  ' + (f.diagnostics.overfit ? '⚠️' : '✅'));
    }
    console.log('  ' + L);
    console.log('  ' + 'AVG'.padStart(5) +
      fmt(result.agg.winRate).padStart(8) + fmt(result.agg.profitFactor).padStart(8) +
      fmt(result.agg.totalReturn).padStart(8) + fmt(result.agg.sharpe).padStart(8));
    console.log(EQ + '\n');
  }
}

module.exports = {
  GridSearchValidator,
  GS_CONFIG,
  allCombinations,
  randomCombinations,
  compositeScore,
  scoreResult,
  overfitDiagnostics,
};
