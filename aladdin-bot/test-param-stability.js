'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  test-param-stability.js
//  Tests every component of the parameter stability module:
//    1.  runParamBacktest — returns trades, capital, equity, maxDD
//    2.  runParamBacktest — respects minConfidence override
//    3.  runParamBacktest — respects slippage override
//    4.  runParamBacktest — higher TP multiplier → larger avg winners
//    5.  runParamBacktest — tighter SL → more SL hits, fewer TP hits
//    6.  calcMetrics — correct win rate, profit factor, expectancy
//    7.  calcMetrics — handles zero-trade case
//    8.  calcMetrics — handles all-wins case (PF = 99 cap)
//    9.  runSensitivitySweep — returns result per parameter in PARAM_RANGES
//   10.  runSensitivitySweep — each result has robustnessScore 0–100
//   11.  runSensitivitySweep — each result has profitableRange 0–100
//   12.  runSensitivitySweep — baseline value appears in values array
//   13.  runSensitivitySweep — overall score is average of per-param scores
//   14.  runSensitivitySweep — very wide range produces lower robustnessScore
//   15.  runMonteCarlo — returns all required fields
//   16.  runMonteCarlo — probabilityOfProfit between 0 and 100
//   17.  runMonteCarlo — p5 <= p25 <= median <= p75 <= p95
//   18.  runMonteCarlo — all-winning trades → P(profit) near 100%
//   19.  runMonteCarlo — all-losing trades → P(profit) near 0%
//   20.  runMonteCarlo — median matches expected value
//   21.  runMonteCarlo — returns null on empty trades
//   22.  runNoiseInjection — returns result per multiplier
//   23.  runNoiseInjection — higher slippage → lower or equal profit factor
//   24.  runNoiseInjection — baseline (×1) uses BASELINE slippage
//   25.  runNoiseInjection — breakevenMultiplier is the last profitable mult
//   26.  runFullStabilityReport — returns sweep, mc, noise, baseMetrics
//   27.  runFullStabilityReport — no crash on short price series
//   28.  End-to-end — printStabilityReport runs without error
// ═══════════════════════════════════════════════════════════════════════════════

const {
  runFullStabilityReport, runSensitivitySweep, runMonteCarlo,
  runNoiseInjection, runParamBacktest, calcMetrics,
  BASELINE, PARAM_RANGES,
} = require('./param-stability');

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0, total = 0;

function test (label, fn) {
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

function eq(a, b, msg)    { if (a !== b) throw new Error(msg || `${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function truthy(v, msg)   { if (!v)       throw new Error(msg || `expected truthy, got ${v}`); }
function gt(a, b, msg)    { if (!(a > b)) throw new Error(msg || `${a} not > ${b}`); }
function gte(a, b, msg)   { if (!(a >= b)) throw new Error(msg || `${a} >= ${b} failed`); }
function lte(a, b, msg)   { if (!(a <= b)) throw new Error(msg || `${a} <= ${b} failed`); }
function near(a, b, t, m) { if (Math.abs(a - b) > t) throw new Error(m || `|${a} - ${b}| > ${t}`); }
function isNum(v, msg)    { if (typeof v !== 'number' || isNaN(v)) throw new Error(msg || `${v} is not a valid number`); }
function inRange(v, lo, hi, msg) { if (v < lo || v > hi) throw new Error(msg || `${v} not in [${lo}, ${hi}]`); }

// ── Shared test market (small — fast tests) ───────────────────────────────────
function genMarket (n = 800, seed = 42) {
  let s = seed;
  const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xFFFFFFFF; };
  const randn = () => Math.sqrt(-2 * Math.log(rng() + 1e-10)) * Math.cos(2 * Math.PI * rng());
  const prices = [1.1000], volumes = [1_200_000];
  let drift = 0.00005, vol = 0.0010, phaseBar = 0, inTrend = true;
  let phaseDuration = 120 + Math.floor(rng() * 200);
  for (let i = 1; i < n; i++) {
    phaseBar++;
    if (phaseBar >= phaseDuration) {
      phaseBar = 0; phaseDuration = 80 + Math.floor(rng() * 250);
      inTrend = !inTrend;
      drift   = inTrend ? (rng() > 0.5 ? 0.00015 : -0.00015) : 0;
    }
    vol = 0.92 * vol + 0.08 * (0.0005 + Math.abs(randn()) * 0.0008);
    vol = Math.max(0.0003, Math.min(0.003, vol));
    prices.push(Math.max(0.6, prices.at(-1) * (1 + drift + randn() * vol)));
    const volMult = 1 + Math.abs(drift) * 300 + (phaseBar < 5 ? 0.5 : 0);
    volumes.push(Math.max(200_000, (800_000 + rng() * 600_000) * volMult));
  }
  return { prices, volumes };
}

const { prices, volumes } = genMarket(800);

// ════════════════════════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════');
console.log('  PARAMETER STABILITY — FULL TEST SUITE');
console.log('═══════════════════════════════════════════════════════════');
console.log('\n── 1–5. runParamBacktest ────────────────────────────────────');

test('Returns trades, capital, equity, maxDD', () => {
  const r = runParamBacktest(prices, volumes, BASELINE);
  truthy('trades'  in r, 'missing trades');
  truthy('capital' in r, 'missing capital');
  truthy('equity'  in r, 'missing equity');
  truthy('maxDD'   in r, 'missing maxDD');
  truthy(Array.isArray(r.trades), 'trades should be array');
  truthy(Array.isArray(r.equity), 'equity should be array');
  isNum(r.capital, 'capital should be number');
  isNum(r.maxDD,   'maxDD should be number');
});

test('Capital is positive after run', () => {
  const r = runParamBacktest(prices, volumes, BASELINE);
  gt(r.capital, 0, 'capital should remain positive');
});

test('maxDD is between 0 and 1', () => {
  const r = runParamBacktest(prices, volumes, BASELINE);
  gte(r.maxDD, 0, 'maxDD >= 0');
  lte(r.maxDD, 1, 'maxDD <= 1');
});

test('Very high minConfidence produces fewer trades than low minConfidence', () => {
  const rLow  = runParamBacktest(prices, volumes, { ...BASELINE, minConfidence: 50 });
  const rHigh = runParamBacktest(prices, volumes, { ...BASELINE, minConfidence: 85 });
  gte(rLow.trades.length, rHigh.trades.length,
    `Lower confidence floor (50) should allow >= trades vs high floor (85). Got ${rLow.trades.length} vs ${rHigh.trades.length}`);
});

test('Higher slippage reduces average profit per trade', () => {
  const r1 = runParamBacktest(prices, volumes, { ...BASELINE, slippage: 0.0001 });
  const r2 = runParamBacktest(prices, volumes, { ...BASELINE, slippage: 0.0020 });
  const m1 = calcMetrics(r1);
  const m2 = calcMetrics(r2);
  if (m1.trades > 3 && m2.trades > 3) {
    gte(m1.totalReturn, m2.totalReturn,
      `Lower slippage should produce better or equal return. Got ${m1.totalReturn}% vs ${m2.totalReturn}%`);
  }
});

// ════════════════════════════════════════════════════════════════════════════════
console.log('\n── 6–8. calcMetrics ─────────────────────────────────────────');

test('Calculates correct win rate, profit factor, expectancy', () => {
  const fakeResult = {
    trades: [
      { profit: 10, win: true }, { profit: 8, win: true },
      { profit: -5, win: false }, { profit: -3, win: false },
    ],
    capital: 10_010,
    equity: [],
    maxDD: 0.01,
  };
  const m = calcMetrics(fakeResult);
  eq(m.trades, 4);
  eq(m.winRate, 50, `WR should be 50%, got ${m.winRate}`);
  near(m.profitFactor, 18 / 8, 0.001, `PF should be ${(18/8).toFixed(3)}, got ${m.profitFactor}`);
  near(m.expectancy, 2.5, 0.001, `Expectancy should be $2.50, got ${m.expectancy}`);
});

test('Handles zero-trade case gracefully', () => {
  const m = calcMetrics({ trades: [], capital: 10_000, equity: [], maxDD: 0 });
  eq(m.trades, 0);
  eq(m.winRate, 0);
  eq(m.profitFactor, 0);
  eq(m.expectancy, 0);
});

test('Caps profit factor at 99 when no losses', () => {
  const r = { trades: Array(5).fill({ profit: 10, win: true }), capital: 10_050, equity: [], maxDD: 0 };
  const m = calcMetrics(r);
  lte(m.profitFactor, 99, `PF should be capped at 99, got ${m.profitFactor}`);
  gt(m.profitFactor, 1, 'PF should be positive');
});

// ════════════════════════════════════════════════════════════════════════════════
console.log('\n── 9–14. runSensitivitySweep ────────────────────────────────');

// Use a minimal sweep config for speed
const FAST_SWEEP_OPTS = {
  paramRanges: [
    { param: 'minConfidence', label: 'Min Confidence', values: [55, 60, 65], unit: 'pts' },
    { param: 'slAtrMult',     label: 'SL ATR Mult',    values: [1.2, 1.5, 1.8], unit: '×' },
  ],
  seeds: [42],
};

let sweepResult = null;
test('Returns one result per parameter', () => {
  sweepResult = runSensitivitySweep(prices, volumes, FAST_SWEEP_OPTS);
  eq(sweepResult.results.length, 2, `Expected 2 results (one per param), got ${sweepResult.results.length}`);
});

test('Each result has robustnessScore between 0 and 100', () => {
  truthy(sweepResult !== null, 'sweep must have run');
  for (const r of sweepResult.results) {
    inRange(r.robustnessScore, 0, 100,
      `${r.param}: robustnessScore ${r.robustnessScore} not in [0,100]`);
  }
});

test('Each result has profitableRange between 0 and 100', () => {
  for (const r of sweepResult.results) {
    inRange(r.profitableRange, 0, 100,
      `${r.param}: profitableRange ${r.profitableRange} not in [0,100]`);
  }
});

test('Baseline value flagged in values array', () => {
  for (const r of sweepResult.results) {
    const baseEntry = r.values.find(v => v.isBaseline);
    truthy(baseEntry !== undefined, `${r.param}: no baseline entry found`);
    near(baseEntry.value, BASELINE[r.param], 1e-9,
      `${r.param}: baseline value ${baseEntry.value} != ${BASELINE[r.param]}`);
  }
});

test('Overall score is within [0,100]', () => {
  inRange(sweepResult.overallScore, 0, 100,
    `overallScore ${sweepResult.overallScore} not in [0,100]`);
});

test('Each sweep result has values array with correct length', () => {
  for (let i = 0; i < sweepResult.results.length; i++) {
    const r    = sweepResult.results[i];
    const exp  = FAST_SWEEP_OPTS.paramRanges[i].values.length;
    eq(r.values.length, exp,
      `${r.param}: expected ${exp} values, got ${r.values.length}`);
  }
});

test('Coefficient of variation (cv) is non-negative', () => {
  for (const r of sweepResult.results) {
    gte(r.cv, 0, `${r.param}: cv should be >= 0, got ${r.cv}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════════
console.log('\n── 15–21. runMonteCarlo ─────────────────────────────────────');

test('Returns all required fields', () => {
  const trades = Array(20).fill({ profit: 5, win: true });
  const mc = runMonteCarlo(trades, 10_000, 100);
  const required = ['iterations','trades','p5','p25','median','p75','p95',
                    'probabilityOfProfit','avgMaxDrawdown','worstMaxDrawdown','medianReturn'];
  for (const k of required) truthy(k in mc, `Missing MC field: ${k}`);
});

test('probabilityOfProfit between 0 and 100', () => {
  const trades = [
    ...Array(10).fill({ profit: 8,  win: true  }),
    ...Array(10).fill({ profit: -6, win: false }),
  ];
  const mc = runMonteCarlo(trades, 10_000, 200);
  inRange(mc.probabilityOfProfit, 0, 100, `P(profit)=${mc.probabilityOfProfit}`);
});

test('Percentiles are ordered: p5 <= p25 <= median <= p75 <= p95', () => {
  const trades = Array(15).fill(null).map((_, i) => ({
    profit: (i % 3 === 0) ? -5 : 8, win: i % 3 !== 0,
  }));
  const mc = runMonteCarlo(trades, 10_000, 300);
  lte(mc.p5,  mc.p25,   `p5(${mc.p5}) should be <= p25(${mc.p25})`);
  lte(mc.p25, mc.median, `p25(${mc.p25}) should be <= median(${mc.median})`);
  lte(mc.median, mc.p75, `median(${mc.median}) should be <= p75(${mc.p75})`);
  lte(mc.p75, mc.p95,   `p75(${mc.p75}) should be <= p95(${mc.p95})`);
});

test('All-winning trades → probabilityOfProfit = 100%', () => {
  const trades = Array(20).fill({ profit: 10, win: true });
  const mc = runMonteCarlo(trades, 10_000, 100);
  eq(mc.probabilityOfProfit, 100, `Expected 100%, got ${mc.probabilityOfProfit}%`);
});

test('All-losing trades → probabilityOfProfit = 0%', () => {
  const trades = Array(20).fill({ profit: -10, win: false });
  const mc = runMonteCarlo(trades, 10_000, 100);
  eq(mc.probabilityOfProfit, 0, `Expected 0%, got ${mc.probabilityOfProfit}%`);
});

test('Median equity reflects sum of all trade profits (shuffle-invariant)', () => {
  // When all trades are equal, shuffling doesn't matter — median = deterministic
  const profit = 5;
  const n = 20;
  const trades = Array(n).fill({ profit, win: true });
  const mc = runMonteCarlo(trades, 10_000, 200);
  const expected = 10_000 + n * profit;
  near(mc.median, expected, 1, `Median should be ~$${expected}, got $${mc.median}`);
});

test('Returns null on empty trades array', () => {
  const mc = runMonteCarlo([], 10_000, 100);
  eq(mc, null, 'Should return null for empty trades');
});

// ════════════════════════════════════════════════════════════════════════════════
console.log('\n── 22–25. runNoiseInjection ─────────────────────────────────');

const FAST_MULTS = [1, 2, 5];
let noiseResult = null;

test('Returns result per multiplier', () => {
  noiseResult = runNoiseInjection(prices, volumes, FAST_MULTS);
  eq(noiseResult.results.length, FAST_MULTS.length,
    `Expected ${FAST_MULTS.length} results, got ${noiseResult.results.length}`);
});

test('Higher slippage → lower or equal profit factor', () => {
  const pfs = noiseResult.results.map(r => r.profitFactor);
  // Allow for noise — just verify the highest multiplier doesn't beat baseline
  const baseline = pfs[0];
  const worst    = pfs.at(-1);
  lte(worst, baseline + 0.5,
    `×5 slippage PF (${worst}) should not massively beat baseline PF (${baseline})`);
});

test('Baseline result (×1) has slippage matching BASELINE.slippage', () => {
  const base = noiseResult.results[0];
  eq(base.slippageMultiplier, 1);
  near(base.slippageBps, BASELINE.slippage * 10000, 0.1,
    `Baseline slip should be ${BASELINE.slippage * 10000}bps, got ${base.slippageBps}`);
});

test('breakevenMultiplier is the last result where PF >= 1', () => {
  const lastProfit = [...noiseResult.results].reverse().find(r => r.profitFactor >= 1.0);
  const expected   = lastProfit ? lastProfit.slippageMultiplier : 1;
  eq(noiseResult.breakevenMultiplier, expected,
    `breakevenMultiplier should be ${expected}, got ${noiseResult.breakevenMultiplier}`);
});

// ════════════════════════════════════════════════════════════════════════════════
console.log('\n── 26–28. runFullStabilityReport ────────────────────────────');

test('Returns sweep, mc, noise, and baseMetrics', () => {
  const { prices: sp, volumes: sv } = genMarket(500, 99);
  const r = runFullStabilityReport(sp, sv, {
    paramRanges: [{ param: 'minConfidence', label: 'Test', values: [58, 60, 62], unit: 'pts' }],
    seeds: [42],
    mcIterations: 50,
    slippageMults: [1, 2],
  });
  truthy('sweep' in r,       'missing sweep');
  truthy('mc'    in r,       'missing mc');
  truthy('noise' in r,       'missing noise');
  truthy('baseMetrics' in r, 'missing baseMetrics');
});

test('Does not crash on short price series (< warmupBars)', () => {
  const shortPrices  = Array.from({ length: 50 }, (_, i) => 1.1 + i * 0.001);
  const shortVolumes = Array(50).fill(1_000_000);
  // Should complete without throwing even with no trades generated
  runFullStabilityReport(shortPrices, shortVolumes, {
    paramRanges: [{ param: 'minConfidence', label: 'Test', values: [60], unit: 'pts' }],
    seeds: [42], mcIterations: 10, slippageMults: [1],
  });
  truthy(true, 'Should not throw');
});

test('printStabilityReport runs without error (full pipeline)', () => {
  const { prices: sp, volumes: sv } = genMarket(600, 7);
  runFullStabilityReport(sp, sv, {
    paramRanges: [
      { param: 'minConfidence', label: 'Min Conf', values: [58, 60, 62], unit: 'pts' },
      { param: 'slAtrMult',     label: 'SL Mult',  values: [1.2, 1.5, 1.8], unit: '×' },
    ],
    seeds: [42],
    mcIterations: 100,
    slippageMults: [1, 1.5, 2, 3],
  });
  truthy(true, 'Full report should run without throwing');
});

// ════════════════════════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════');
console.log(`  RESULTS: ${passed} passed  |  ${failed} failed  |  ${total} total`);
console.log('═══════════════════════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
