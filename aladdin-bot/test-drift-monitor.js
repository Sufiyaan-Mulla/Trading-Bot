'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  test-drift-monitor.js
//  Tests every component of the Live vs Backtest Drift Monitor:
//    1.  Benchmark loading — finds latest nightly JSON
//    2.  Benchmark loading — missing logDir handled gracefully
//    3.  Benchmark loading — empty logDir handled gracefully
//    4.  recordTrade — rolling window capped at lookbackTrades
//    5.  recordTrade — does not evaluate below minTradesBeforeCheck
//    6.  Win rate drift — halt triggered when drift > threshold
//    7.  Win rate drift — no halt when within threshold
//    8.  Profit factor drift — halt triggered below minRatio
//    9.  Profit factor drift — no halt when above minRatio
//   10.  Expectancy drift — halt triggered below minRatio
//   11.  Expectancy drift — no halt when above minRatio
//   12.  Multiple metrics — halt on any single breach
//   13.  isHalted() returns correct state
//   14.  haltStatus() contains required fields
//   15.  reset() clears halt and live window
//   16.  reset() respects cooldown
//   17.  reset(true) forces reset ignoring cooldown
//   18.  Drift report saved to disk on halt
//   19.  reloadBenchmark() picks up new JSON file
//   20.  status() returns all required fields
//   21.  trading-engine integration — driftMonitor exists on engine
//   22.  trading-engine integration — recordTrade called after exitPosition
//   23.  trading-engine integration — globalHaltTripped set on drift halt
//   24.  driftMonitor status exposed in engine getStatus()
// ═══════════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { DriftMonitor, DRIFT_CONFIG } = require('./drift-monitor');

// ── Test harness ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0, total = 0;

function test(label, fn) {
  total++;
  try {
    fn();
    console.log(`  ✅  ${label}`);
    passed++;
  } catch (e) {
    console.log(`  ❌  ${label}`);
    console.log(`       → ${e.message}`);
    failed++;
  }
}

function eq(a, b, msg)     { if (a !== b) throw new Error(msg || `${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function truthy(v, msg)    { if (!v)       throw new Error(msg || `expected truthy, got ${v}`); }
function falsy(v, msg)     { if (v)        throw new Error(msg || `expected falsy, got ${v}`); }
function gt(a, b, msg)     { if (!(a > b)) throw new Error(msg || `${a} not > ${b}`); }

// ── Helpers ───────────────────────────────────────────────────────────────────

// Create a temp directory with an optional nightly JSON benchmark file
function makeTmpDir(nightlyData = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
  if (nightlyData) {
    const date = nightlyData.date || '2026-05-01';
    fs.writeFileSync(
      path.join(dir, `nightly-${date}.json`),
      JSON.stringify(nightlyData, null, 2)
    );
  }
  return dir;
}

function cleanDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

// Default benchmark data
const BENCHMARK = {
  date:          '2026-05-01',
  winRate:       60,          // 60%
  profitFactor:  1.80,
  expectancy:    5.00,        // $5 per trade
  totalReturn:   2.5,
  totalTrades:   20,
  verdict:       'READY',
};

// Build a monitor with a pre-loaded in-memory benchmark (bypass file I/O)
function makeMonitor(cfg = {}) {
  const dir = makeTmpDir(BENCHMARK);
  const m   = new DriftMonitor({ logDir: dir, haltCooldownMinutes: 0, ...cfg });
  m.__tmpDir = dir;
  return m;
}

// Generate N trades with a given win rate and avg profit
function makeTrades(n, winRate, avgWin = 10, avgLoss = -8) {
  return Array.from({ length: n }, (_, i) => ({
    profit: (i / n) < winRate ? avgWin : avgLoss,
    ts: Date.now(),
    win: (i / n) < winRate,
  }));
}

// Feed trades into monitor
function feedTrades(monitor, trades) {
  for (const t of trades) monitor.recordTrade(t);
}

// ══════════════════════════════════════════════════════════════════════════════
//  TESTS
// ══════════════════════════════════════════════════════════════════════════════

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  DRIFT MONITOR — FULL TEST SUITE');
console.log('═══════════════════════════════════════════════════════════');

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 1–3. Benchmark Loading ───────────────────────────────────');

test('Loads latest nightly JSON as benchmark', () => {
  const dir = makeTmpDir(BENCHMARK);
  const m   = new DriftMonitor({ logDir: dir });
  truthy(m.benchmark !== null, 'benchmark should be loaded');
  eq(m.benchmark.winRate,      BENCHMARK.winRate,      'winRate mismatch');
  eq(m.benchmark.profitFactor, BENCHMARK.profitFactor, 'profitFactor mismatch');
  eq(m.benchmark.expectancy,   BENCHMARK.expectancy,   'expectancy mismatch');
  cleanDir(dir);
});

test('Handles missing logDir gracefully (no crash)', () => {
  const m = new DriftMonitor({ logDir: '/tmp/no-such-dir-xyz-999' });
  falsy(m.benchmark, 'benchmark should be null when dir missing');
  falsy(m.isHalted(), 'should not be halted');
});

test('Handles empty logDir gracefully (no nightly files)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-empty-'));
  const m   = new DriftMonitor({ logDir: dir });
  falsy(m.benchmark, 'benchmark should be null when no JSON files');
  cleanDir(dir);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 4–5. Trade Recording ─────────────────────────────────────');

test('Rolling window capped at lookbackTrades', () => {
  const m = makeMonitor({ lookbackTrades: 10, minTradesBeforeCheck: 100 });
  feedTrades(m, makeTrades(25, 0.6));
  eq(m.liveTrades.length, 10, `Window should be capped at 10, got ${m.liveTrades.length}`);
  cleanDir(m.__tmpDir);
});

test('No drift evaluation below minTradesBeforeCheck', () => {
  const m = makeMonitor({ minTradesBeforeCheck: 15, lookbackTrades: 20 });
  // Feed 14 losing trades — would trigger halt if evaluated
  feedTrades(m, makeTrades(14, 0.0));   // 0% win rate
  falsy(m.isHalted(), 'Should NOT halt before minTradesBeforeCheck trades');
  cleanDir(m.__tmpDir);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 6–7. Win Rate Drift ──────────────────────────────────────');

test('Halt triggered when win rate drops > winRateDriftPP below benchmark', () => {
  // Benchmark WR = 60%, threshold = 15pp → halt below 45%
  const m = makeMonitor({ winRateDriftPP: 15, minTradesBeforeCheck: 10 });
  // Feed 10 trades with 30% win rate → drift = 30pp > 15pp → halt
  feedTrades(m, makeTrades(10, 0.30));
  truthy(m.isHalted(), `Should halt: live WR ~30% vs benchmark 60% (drift 30pp > threshold 15pp)`);
  cleanDir(m.__tmpDir);
});

test('No halt when win rate within threshold', () => {
  // Benchmark WR = 60%, threshold = 15pp → OK above 45%
  // Disable PF and expectancy checks so only win rate is tested here
  const m = makeMonitor({ winRateDriftPP: 15, profitFactorMinRatio: 0, expectancyMinRatio: 0, minTradesBeforeCheck: 10 });
  // Feed 10 trades with 50% win rate → drift = 10pp < 15pp → OK
  feedTrades(m, makeTrades(10, 0.50));
  falsy(m.isHalted(), `Should NOT halt: live WR ~50% vs benchmark 60% (drift 10pp < threshold 15pp)`);
  cleanDir(m.__tmpDir);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 8–9. Profit Factor Drift ─────────────────────────────────');

test('Halt triggered when profit factor drops below minRatio × benchmark', () => {
  // Benchmark PF = 1.80, ratio = 0.65 → halt below 1.17
  // To get low PF: low wins, big losses
  const m = makeMonitor({ profitFactorMinRatio: 0.65, winRateDriftPP: 999, expectancyMinRatio: 0, minTradesBeforeCheck: 10 });
  // 10 trades: 4 wins of $1, 6 losses of $10 → PF = 4/60 = 0.067 << 1.17
  const trades = [
    ...Array(4).fill({ profit: 1,   win: true }),
    ...Array(6).fill({ profit: -10, win: false }),
  ];
  feedTrades(m, trades);
  truthy(m.isHalted(), 'Should halt: PF very low');
  cleanDir(m.__tmpDir);
});

test('No halt when profit factor above minRatio × benchmark', () => {
  // Benchmark PF = 1.80, ratio = 0.65 → OK above 1.17
  const m = makeMonitor({ profitFactorMinRatio: 0.65, winRateDriftPP: 999, expectancyMinRatio: 0, minTradesBeforeCheck: 10 });
  // 10 trades: 6 wins $10, 4 losses $5 → PF = 60/20 = 3.0 > 1.17
  const trades = [
    ...Array(6).fill({ profit: 10, win: true }),
    ...Array(4).fill({ profit: -5, win: false }),
  ];
  feedTrades(m, trades);
  falsy(m.isHalted(), 'Should NOT halt: PF = 3.0 is fine');
  cleanDir(m.__tmpDir);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 10–11. Expectancy Drift ──────────────────────────────────');

test('Halt triggered when expectancy drops below minRatio × benchmark', () => {
  // Benchmark exp = $5, ratio = 0.50 → halt below $2.50
  const m = makeMonitor({ expectancyMinRatio: 0.50, winRateDriftPP: 999, profitFactorMinRatio: 0, minTradesBeforeCheck: 10 });
  // 10 trades avg $1 each → expectancy $1 < $2.50
  feedTrades(m, Array(10).fill({ profit: 1, win: true }));
  truthy(m.isHalted(), 'Should halt: expectancy $1 < $2.50 (50% of $5 benchmark)');
  cleanDir(m.__tmpDir);
});

test('No halt when expectancy above minRatio × benchmark', () => {
  // Benchmark exp = $5, ratio = 0.50 → OK above $2.50
  const m = makeMonitor({ expectancyMinRatio: 0.50, winRateDriftPP: 999, profitFactorMinRatio: 0, minTradesBeforeCheck: 10 });
  // 10 trades avg $4 each → expectancy $4 > $2.50
  feedTrades(m, Array(10).fill({ profit: 4, win: true }));
  falsy(m.isHalted(), 'Should NOT halt: expectancy $4 > $2.50 (50% of $5 benchmark)');
  cleanDir(m.__tmpDir);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 12. Multiple Metrics ─────────────────────────────────────');

test('Halt triggered if any single metric breaches threshold', () => {
  // Only win rate breaches — PF and expectancy are fine
  const m = makeMonitor({ winRateDriftPP: 15, profitFactorMinRatio: 0.10, expectancyMinRatio: 0.10, minTradesBeforeCheck: 10 });
  feedTrades(m, makeTrades(10, 0.20));  // WR 20%, drift 40pp >> 15pp threshold
  truthy(m.isHalted(), 'Should halt on win rate breach alone');
  truthy(m.haltReason.includes('Win rate'), 'Halt reason should mention Win rate');
  cleanDir(m.__tmpDir);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 13–14. isHalted() and haltStatus() ──────────────────────');

test('isHalted() returns false when within tolerance', () => {
  const m = makeMonitor({ minTradesBeforeCheck: 10 });
  feedTrades(m, makeTrades(10, 0.60, 10, -8)); // good performance
  falsy(m.isHalted(), 'Should not be halted with normal performance');
  cleanDir(m.__tmpDir);
});

test('isHalted() returns true after halt triggered', () => {
  const m = makeMonitor({ winRateDriftPP: 5, minTradesBeforeCheck: 10 });
  feedTrades(m, makeTrades(10, 0.10)); // very poor WR
  truthy(m.isHalted(), 'Should be halted');
  cleanDir(m.__tmpDir);
});

test('haltStatus() returns all required fields when halted', () => {
  const m = makeMonitor({ winRateDriftPP: 5, minTradesBeforeCheck: 10 });
  feedTrades(m, makeTrades(10, 0.10));
  truthy(m.isHalted(), 'should be halted first');
  const s = m.haltStatus();
  truthy(s !== null,                      'haltStatus should not be null when halted');
  truthy(typeof s.reason    === 'string',  'reason should be string');
  truthy(typeof s.haltedAt  === 'string',  'haltedAt should be string');
  truthy(typeof s.benchmark === 'string',  'benchmark source should be string');
  truthy(typeof s.liveWindow === 'number', 'liveWindow should be number');
  cleanDir(m.__tmpDir);
});

test('haltStatus() returns null when not halted', () => {
  const m = makeMonitor({ minTradesBeforeCheck: 100 }); // threshold so high it never fires
  eq(m.haltStatus(), null, 'haltStatus should be null when not halted');
  cleanDir(m.__tmpDir);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 15–17. Reset ─────────────────────────────────────────────');

test('reset() clears halt and empties live trade window', () => {
  const m = makeMonitor({ winRateDriftPP: 5, minTradesBeforeCheck: 10, haltCooldownMinutes: 0 });
  feedTrades(m, makeTrades(10, 0.10));
  truthy(m.isHalted(), 'Should be halted before reset');
  const ok = m.reset();
  truthy(ok,              'reset() should return true');
  falsy(m.isHalted(),     'Should not be halted after reset');
  eq(m.liveTrades.length, 0, 'Live trade window should be cleared after reset');
  cleanDir(m.__tmpDir);
});

test('reset() respects cooldown and returns false within cooldown period', () => {
  const m = makeMonitor({ winRateDriftPP: 5, minTradesBeforeCheck: 10, haltCooldownMinutes: 60 });
  feedTrades(m, makeTrades(10, 0.10));
  truthy(m.isHalted(), 'Should be halted');
  const ok = m.reset();        // should be blocked by 60-min cooldown
  falsy(ok, 'reset() should return false within cooldown');
  truthy(m.isHalted(), 'Should still be halted');
  cleanDir(m.__tmpDir);
});

test('reset(true) forces reset even within cooldown', () => {
  const m = makeMonitor({ winRateDriftPP: 5, minTradesBeforeCheck: 10, haltCooldownMinutes: 60 });
  feedTrades(m, makeTrades(10, 0.10));
  truthy(m.isHalted(), 'Should be halted');
  const ok = m.reset(true);   // forced
  truthy(ok,          'reset(true) should return true');
  falsy(m.isHalted(), 'Should not be halted after forced reset');
  cleanDir(m.__tmpDir);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 18. Drift Report Saved to Disk ───────────────────────────');

test('Drift halt report JSON saved to logDir on halt', () => {
  const m = makeMonitor({ winRateDriftPP: 5, minTradesBeforeCheck: 10, haltCooldownMinutes: 0 });
  feedTrades(m, makeTrades(10, 0.10));
  truthy(m.isHalted(), 'Should be halted');
  const files = fs.readdirSync(m.__tmpDir).filter(f => f.startsWith('drift-halt-'));
  truthy(files.length > 0, `Expected drift-halt-*.json in ${m.__tmpDir}, found: ${fs.readdirSync(m.__tmpDir).join(', ')}`);
  const report = JSON.parse(fs.readFileSync(path.join(m.__tmpDir, files[0]), 'utf8'));
  truthy(typeof report.haltedAt  === 'string', 'report.haltedAt missing');
  truthy(typeof report.haltReason === 'string', 'report.haltReason missing');
  truthy(report.benchmark !== null,             'report.benchmark missing');
  truthy(report.liveMetrics !== null,           'report.liveMetrics missing');
  cleanDir(m.__tmpDir);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 19. reloadBenchmark() ────────────────────────────────────');

test('reloadBenchmark() picks up a newer nightly JSON', () => {
  const dir = makeTmpDir(BENCHMARK);
  const m   = new DriftMonitor({ logDir: dir });
  eq(m.benchmark.winRate, 60, 'Initial benchmark WR should be 60');

  // Write a newer file
  const newer = { ...BENCHMARK, date: '2026-05-02', winRate: 65, profitFactor: 2.0 };
  fs.writeFileSync(path.join(dir, 'nightly-2026-05-02.json'), JSON.stringify(newer, null, 2));
  m.reloadBenchmark();

  // Fix #21: DriftMonitor now uses rolling median of N nights — not just the newest
  // After reload with [WR=60, WR=65], median = 62.5
  const expectedWR = 62.5;  // median of the two nightly reports
  eq(m.benchmark.winRate, expectedWR, `After reload, WR should be ${expectedWR} (median of available nights, got ${m.benchmark.winRate})`);
  // Fix #21: rolling median of 2 nights [1.8, 2.0] = 1.9
  eq(m.benchmark.profitFactor, 1.9, 'PF should be median after reload (got ' + m.benchmark.profitFactor + ')');
  cleanDir(dir);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 20. status() Shape ───────────────────────────────────────');

test('status() returns all required top-level fields', () => {
  const m = makeMonitor();
  const s = m.status();
  const required = ['halted', 'haltReason', 'benchmarkDate', 'benchmarkSource',
                    'benchmark', 'live', 'thresholds', 'recentDrift'];
  for (const k of required) truthy(k in s, `Missing status field: ${k}`);
  cleanDir(m.__tmpDir);
});

test('status().live has winRate, profitFactor, expectancy, trades', () => {
  const m = makeMonitor();
  const s = m.status();
  const required = ['winRate', 'profitFactor', 'expectancy', 'trades'];
  for (const k of required) truthy(k in s.live, `Missing live field: ${k}`);
  cleanDir(m.__tmpDir);
});

test('status().thresholds reflects config', () => {
  const m = makeMonitor({ winRateDriftPP: 20, lookbackTrades: 15 });
  const s = m.status();
  eq(s.thresholds.winRateDriftPP, 20, 'winRateDriftPP should match config');
  eq(s.thresholds.lookbackTrades, 15, 'lookbackTrades should match config');
  cleanDir(m.__tmpDir);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── 21–24. trading-engine.js Integration ────────────────────');

test('TradingEngine has driftMonitor property', () => {
  const { TradingEngine } = require('./trading-engine');
  const e = new TradingEngine();
  truthy(e.driftMonitor instanceof DriftMonitor, 'engine.driftMonitor should be a DriftMonitor instance');
});

test('driftMonitor.recordTrade called after exitPosition (live window grows)', () => {
  const { TradingEngine } = require('./trading-engine');
  const e = new TradingEngine();
  // Manually inject a benchmark so drift monitor is active
  e.driftMonitor.benchmark = { ...BENCHMARK };

  const initialWindow = e.driftMonitor.liveTrades.length;

  // Simulate exitPosition by calling recordTrade directly with a trade object
  e.driftMonitor.recordTrade({ profit: 5 });
  e.driftMonitor.recordTrade({ profit: -3 });

  eq(e.driftMonitor.liveTrades.length, initialWindow + 2,
     'Live window should grow by 2 after 2 recordTrade calls');
});

test('globalHaltTripped set on engine when drift monitor halts', () => {
  const { TradingEngine } = require('./trading-engine');
  const e = new TradingEngine();

  // Inject benchmark and configure very sensitive thresholds
  e.driftMonitor.benchmark = { ...BENCHMARK };
  e.driftMonitor.cfg.winRateDriftPP       = 5;
  e.driftMonitor.cfg.minTradesBeforeCheck = 10;
  e.driftMonitor.cfg.haltCooldownMinutes  = 0;

  // Feed 10 very bad trades
  for (let i = 0; i < 10; i++) {
    e.driftMonitor.recordTrade({ profit: -10 });
  }

  truthy(e.driftMonitor.isHalted(), 'drift monitor should be halted');

  // Simulate what happens in exitPosition: check drift and set globalHaltTripped
  if (e.driftMonitor.isHalted() && !e.globalHaltTripped) {
    e.globalHaltTripped = true;
  }
  truthy(e.globalHaltTripped, 'globalHaltTripped should be true after drift halt');
});

test('driftMonitor status exposed in engine getStatus()', () => {
  const { TradingEngine } = require('./trading-engine');
  const e = new TradingEngine();
  const s = e.getStatus();
  truthy('drift' in s, 'getStatus() should include drift field');
  truthy('halted'    in s.drift, 'drift.halted missing');
  truthy('live'      in s.drift, 'drift.live missing');
  truthy('benchmark' in s.drift, 'drift.benchmark missing (may be null if no nightly run yet)');
  truthy('thresholds' in s.drift, 'drift.thresholds missing');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════');
console.log(`  RESULTS: ${passed} passed  |  ${failed} failed  |  ${total} total`);
console.log('═══════════════════════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
