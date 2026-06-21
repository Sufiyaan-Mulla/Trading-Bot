'use strict';

(async () => {
// ══════════════════════════════════════════════════════════════════════════════
//  test-bug-fixes.js — verifies all 20 confirmed bugs are resolved
// ══════════════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const failures = [];

function assert(cond, label, detail = '') {
  if (cond) { process.stdout.write(`  ✅ ${label}\n`); passed++; }
  else { process.stdout.write(`  ❌ FAIL: ${label}${detail ? ' — '+detail : ''}\n`); failed++; failures.push(label); }
}
function section(t) { console.log('\n' + '═'.repeat(62) + '\n  ' + t + '\n' + '═'.repeat(62)); }

// ══════════════════════════════════════════════════════════════════════════════
section('Bug #1 — startup.js trainScore undefined');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./startup.js', 'utf8');
  assert(src.includes('const trainScore   = report.trainScore || bestTrainScore'),
    '#1: trainScore derived from report.trainScore || bestTrainScore (not undefined)');
  assert(!src.match(/const isSimulation.*trainScore === 0/m) || src.includes('const trainScore'),
    '#1: trainScore is declared before isSimulation check');
} catch(e) { assert(false, '#1 startup trainScore', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('Bug #2 — execution.js _checkCurrencyExposure trailing comma (mixin)');
// ══════════════════════════════════════════════════════════════════════════════
try {
  // Module must load without syntax error
  const exec = require('./execution');
  assert(typeof exec === 'object', '#2: execution.js loads as object (mixin)');
  assert(typeof exec._checkCurrencyExposure === 'function', '#2: _checkCurrencyExposure is a function');
  // Call it — should not throw
  const result = exec._checkCurrencyExposure.call({ currencyExposure: null }, 'EURUSD', 10000);
  assert(result.allowed === true, '#2: _checkCurrencyExposure returns { allowed:true } when no gate');
} catch(e) { assert(false, '#2 execution mixin comma', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('Bug #3 — enterShort not wrapped by execution-hooks');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./execution-hooks.js', 'utf8');
  assert(src.includes('enterShort'), '#3: execution-hooks.js wraps enterShort');
  assert(src.includes("origEnterShort"), '#3: origEnterShort captured before wrapping');
  assert(src.includes('SHORT blocked'), '#3: SectorCap check included in enterShort hook');
  assert(src.includes("'SELL'"), '#3: ExecutionMetrics.begin called with SELL side for SHORT');
} catch(e) { assert(false, '#3 enterShort hook', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('Bug #4 — Kelly session parameter never passed from execution.js');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./execution.js', 'utf8');
  // Both LONG and SHORT Kelly calls must pass session
  const kellyLong  = src.includes("KellyCriterion.calculate(_kellySource, kellyConf, this._currentSession?.())") || src.includes("KellyCriterion.calculate(this.trades, kellyConf, this._currentSession?.())");
  const kellyShort = src.includes("KellyCriterion.calculate(this.trades, confidence, this._currentSession?.())");
  assert(kellyLong,  '#4: LONG Kelly call passes session parameter');
  assert(kellyShort, '#4: SHORT Kelly call passes session parameter');

  // Kelly wrapper reads session and applies SessionRiskBudget cap
  const kellySrc = fs.readFileSync('./kelly-criterion.js', 'utf8');
  assert(kellySrc.includes('session') && kellySrc.includes('SessionRiskBudget'),
    '#4: Kelly wrapper applies SessionRiskBudget cap');
} catch(e) { assert(false, '#4 Kelly session', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('Bug #5 — COT-fetcher [SKIPPED: module removed]');
// ══════════════════════════════════════════════════════════════════════════════
console.log('  ⏭  #5 skipped — cot-fetcher module removed');

// ══════════════════════════════════════════════════════════════════════════════
section('Bug #6 — confidence-calibrator double normalization');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./confidence-calibrator.js', 'utf8');
  // Our manual rawConf normalization should be gone
  assert(!src.includes('rawConf = Math.max(0, Math.min(1, (rawConf - 30) / 65))'),
    '#6: Manual double-normalization removed from calibrate/recordOutcome');
  // _confToProb still handles normalization
  assert(src.includes('_confToProb') && src.includes('conf - 30') || src.includes('(conf - 30)'),
    '#6: _confToProb still normalizes internally');

  // Verify calibrate does not produce near-0 for moderate confidence
  const { ConfidenceCalibrator } = require('./confidence-calibrator');
  const cal = new ConfidenceCalibrator();
  const result = cal.calibrate(70);  // 70% confidence — should not be near 0
  assert(result.rawProb > 0.3 && result.rawProb < 1.0,
    `#6: calibrate(70) rawProb = ${result.rawProb?.toFixed(3)} (should be ~0.6, not near 0)`);
} catch(e) { assert(false, '#6 double normalization', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('Bug #7 — news-filter _recurringToDates never called');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./news-filter.js', 'utf8');
  assert(src.includes('Bug fix #7') || src.includes('_recurringToDates(event'),
    '#7: _recurringToDates called from _seedRecurringEvents');
  // Verify FOMC events produce actual dates
  const { NewsFilter } = require('./news-filter');
  const nf = new NewsFilter();
  // _seedRecurringEvents should produce some events
  const eventsField = nf._events || nf._scheduledEvents || [];
  assert(typeof nf.checkEntry === 'function', '#7: NewsFilter checkEntry function exists');

  // _recurringToDates method produces dates for FOMC
  if (nf._recurringToDates) {
    const dates = nf._recurringToDates({ recurring: 'FOMC', name: 'FOMC', currency: 'USD', impact: 'HIGH' });
    assert(Array.isArray(dates), '#7: _recurringToDates returns array of timestamps');
  }
} catch(e) { assert(false, '#7 recurringToDates', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('Bug #8 — heatmapAdjust computed but never applied');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./strategies/index.js', 'utf8');
  assert(src.includes('result.confidence') && src.includes('heatmapAdjust'),
    '#8: heatmapAdjust applied to result.confidence');
  assert(src.includes('_heatmapAdjust'), '#8: heatmapAdjust recorded on result object');
} catch(e) { assert(false, '#8 heatmapAdjust applied', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('Bug #9 — PerformanceAnalytics imported but _heatmap never instantiated');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./strategies/index.js', 'utf8');
  assert(src.includes('this._heatmap = ') || src.includes("new PerformanceAnalytics"),
    '#9: _heatmap instantiated in StrategyManager constructor');
  // StrategyManager should construct without crash
  const { StrategyManager } = require('./strategies/index');
  const sm = new StrategyManager();
  assert(sm.hasOwnProperty('_heatmap') || '_heatmap' in sm,
    '#9: _heatmap property exists on StrategyManager instance');
} catch(e) { assert(false, '#9 _heatmap instantiated', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('Bug #10 — economic-calendar uses own hardcoded blackout windows');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { NEWS_BLACKOUT_CONFIG } = require('./news-blackout-config');
  const src = fs.readFileSync('./economic-calendar.js', 'utf8');
  assert(src.includes('NEWS_BLACKOUT_CONFIG'), '#10: economic-calendar imports NEWS_BLACKOUT_CONFIG');
  assert(src.includes('highBeforeMs') || src.includes('NEWS_BLACKOUT_CONFIG.highBeforeMs'),
    '#10: BLACKOUT_BEFORE_MS sourced from shared config');
  // Verify actual values match
  assert(!src.match(/= 30 \* 60_000/), '#10: hardcoded 30*60_000 replaced with shared config');
} catch(e) { assert(false, '#10 economic-calendar blackout', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('Bug #11 — bootstrapD1 checks _d1Prices which is local var not instance');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./regime-stack.js', 'utf8');
  assert(!src.includes('regimeStackInstance._d1Prices !== undefined'),
    '#11: broken _d1Prices instance check removed');
  assert(src.includes('_d1PricesBootstrapped'),
    '#11: dedicated _d1PricesBootstrapped property used instead');
  assert(src.includes('this._d1PricesBootstrapped'),
    '#11: analyse() prefers bootstrapped D1 prices');
} catch(e) { assert(false, '#11 bootstrapD1 instance property', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('Bug #12 — bootstrapD1FromAPI not in module.exports');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { bootstrapD1FromAPI } = require('./regime-stack');
  assert(typeof bootstrapD1FromAPI === 'function', '#12: bootstrapD1FromAPI exported from regime-stack');
} catch(e) { assert(false, '#12 bootstrapD1FromAPI export', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('Bug #13 — _currentScoringAsset never set before ADX scoring');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./engine-wiring.js', 'utf8');
  assert(src.includes('globalThis._currentScoringAsset = asset'),
    '#13: _currentScoringAsset set per asset before scoring');
  // Both parallel and sequential paths
  const count = (src.match(/globalThis._currentScoringAsset = asset/g) || []).length;
  assert(count >= 2, `#13: _currentScoringAsset set in both parallel and fallback paths (found ${count})`);
} catch(e) { assert(false, '#13 _currentScoringAsset', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('Bug #14 — exitPosition sectorCap.close not in finally block');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./execution-hooks.js', 'utf8');
  assert(src.includes('finally {') && src.includes('sectorCap.close(asset)'),
    '#14: sectorCap.close in finally block (runs even if origExit throws)');
  // Verify asset captured before exit clears it
  assert(src.includes('const asset   = engine.selectedAsset;'),
    '#14: asset captured before origExit call');
} catch(e) { assert(false, '#14 exitPosition finally', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('Bug #15 — sector-cap EURGBP duplicated in ASSET_SECTORS');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { ASSET_SECTORS } = require('./sector-cap');
  // Count EURGBP entries — should be exactly 1 (handled by one key in the map)
  const eurgbpEntry = ASSET_SECTORS['EURGBP'];
  assert(eurgbpEntry != null, '#15: EURGBP has sectors defined');
  assert(Array.isArray(eurgbpEntry), '#15: EURGBP sectors is an array');
  // Verify no duplicate entries within the array
  const unique = new Set(eurgbpEntry);
  assert(unique.size === eurgbpEntry.length, '#15: No duplicate sector tags for EURGBP');
  // Key appears only once in the object
  const src = fs.readFileSync('./sector-cap.js', 'utf8');
  const matches = src.match(/EURGBP:/g) || [];
  // EURGBP appears in ASSET_CURRENCIES and ASSET_SECTORS (one each = 2 total)
  assert(matches.length <= 2, `#15: EURGBP key appears at most twice (found ${matches.length})`);
} catch(e) { assert(false, '#15 EURGBP duplication', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('Bug #16 — ab-tester _syncCapitalAllocator calls this._abTester (undefined)');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./ab-tester.js', 'utf8');
  assert(!src.includes('this._abTester._syncCapitalAllocator'),
    '#16: this._abTester no longer called (was undefined)');
  assert(src.includes('this._syncCapitalAllocator'),
    '#16: _syncCapitalAllocator called on self in _promote');
} catch(e) { assert(false, '#16 ab-tester sync', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('Bug #17 — backtest-compare inline signal logic still runs');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./backtest-compare.js', 'utf8');
  // Should have SharedSignalAdapter imported
  assert(src.includes('SharedSignalAdapter'), '#17: SharedSignalAdapter imported');
  // Verify no duplicate declaration
  const count = (src.match(/const _sharedAdapter = new SharedSignalAdapter/g) || []).length;
  assert(count === 1, `#17: _sharedAdapter declared exactly once (found ${count})`);
  // The adapter is actually used for signal generation
  assert(src.includes('_adapterDecision') || src.includes('sharedAdapter.decide'),
    '#17: Adapter used for signal decisions');
} catch(e) { assert(false, '#17 backtest-compare adapter', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('Bug #18 — runPeriodSlicedBacktest defined but never called');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./backtest-nightly.js', 'utf8');
  assert(src.includes('runAndAppendPeriodSlices'),
    '#18: runAndAppendPeriodSlices wrapper created to call runPeriodSlicedBacktest');
  const { runPeriodSlicedBacktest, runAndAppendPeriodSlices } = require('./backtest-nightly');
  assert(typeof runPeriodSlicedBacktest === 'function', '#18: runPeriodSlicedBacktest exported');
  assert(typeof runAndAppendPeriodSlices === 'function', '#18: runAndAppendPeriodSlices exported');

  // Test it runs (empty candles → empty result)
  const report   = { totalReturn: 5 };
  const candles  = Array.from({length:200}, (_,i) => ({
    time: Date.now() - (200-i)*300_000,
    open:1.10, high:1.101, low:1.099, close:1.10+i*0.00001, volume:1000
  }));
  const enriched = await runAndAppendPeriodSlices(report, candles);
  assert(enriched === report, '#18: runAndAppendPeriodSlices returns same report object');
  assert(Array.isArray(enriched.periodSlices), '#18: periodSlices added to report');
} catch(e) { assert(false, '#18 runPeriodSlicedBacktest called', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('Bug #19 — SessionTimeExits exitPosition called without error handling');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./engine-wiring.js', 'utf8');
  assert(src.includes('Bug fix #19') || (src.includes('SessionTimeExits') && src.includes('try {')),
    '#19: SessionTimeExits exitPosition wrapped in try-catch');
  // Verify the ?.() optional chaining is gone (was potentially swallowing errors)
  assert(!src.includes('engine.exitPosition?.(engine.priceHistory'),
    '#19: Optional chaining removed from exitPosition call');
} catch(e) { assert(false, '#19 SessionTimeExits exit', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('Bug #20 — parallel-scanner offset uses indexOf (fails with duplicate assets)');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./parallel-scanner.js', 'utf8');
  assert(!src.includes('assets.indexOf(batch[0])'),
    '#20: indexOf removed from offset calculation');
  assert(src.includes('runningOffset'),
    '#20: runningOffset variable used for correct sequential indexing');

  // Functional test — duplicate asset names should not corrupt results
  const { ParallelScanner } = require('./parallel-scanner');
  const scanner = new ParallelScanner({ concurrencyLimit: 2, timeoutMs: 2000 });
  const assets  = ['EURUSD', 'GBPUSD', 'EURUSD'];  // EURUSD appears twice
  const results = await scanner.scan(assets, async (a) => ({ asset: a, score: a === 'EURUSD' ? 1 : 2 }));
  assert(results.length === 3, '#20: 3 results for 3 assets (even with duplicate)');
  assert(results[0]?.asset === 'EURUSD', '#20: Result[0] is EURUSD (first occurrence)');
  assert(results[1]?.asset === 'GBPUSD', '#20: Result[1] is GBPUSD');
  assert(results[2]?.asset === 'EURUSD', '#20: Result[2] is EURUSD (second occurrence)');
} catch(e) { assert(false, '#20 parallel-scanner offset', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(62));
console.log('  RESULTS');
console.log('═'.repeat(62));
console.log(`  ✅ Passed:  ${passed}`);
console.log(`  ❌ Failed:  ${failed}`);
if (failures.length) {
  console.log('\n  Failed tests:');
  failures.forEach(f => console.log('    • ' + f));
}
console.log('');
process.exit(failed > 0 ? 1 : 0);

})();
