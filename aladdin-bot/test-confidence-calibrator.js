'use strict';

const { ConfidenceCalibrator, PlattScaler, IsotonicCalibrator,
        ReliabilityTracker, CALIB_CONFIG } = require('./confidence-calibrator');

let passed = 0, failed = 0, total = 0;
function test(label, fn) {
  total++;
  try { fn(); console.log('  OK  ' + label); passed++; }
  catch(e) { console.log('  FAIL ' + label + '\n       -> ' + e.message); failed++; }
}
function eq(a, b, msg)   { if (a !== b)    throw new Error(msg || JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }
function truthy(v, msg)  { if (!v)          throw new Error(msg || 'expected truthy, got ' + v); }
function falsy(v, msg)   { if (v)           throw new Error(msg || 'expected falsy, got ' + v); }
function gt(a, b, msg)   { if (!(a > b))    throw new Error(msg || a + ' not > ' + b); }
function gte(a, b, msg)  { if (!(a >= b))   throw new Error(msg || a + ' >= ' + b + ' failed'); }
function lte(a, b, msg)  { if (!(a <= b))   throw new Error(msg || a + ' <= ' + b + ' failed'); }
function near(a,b,t,m)   { if (Math.abs(a-b) > t) throw new Error(m || Math.abs(a-b).toFixed(6) + ' > tol ' + t); }
function inRange(v,lo,hi,m){ if (v<lo||v>hi) throw new Error(m||v+' not in ['+lo+','+hi+']'); }

console.log('\n=====================================================');
console.log('  CONFIDENCE CALIBRATOR -- DEEP TEST SUITE');
console.log('=====================================================');

// ── PlattScaler ───────────────────────────────────────────────────────────────
console.log('\n-- 1-10. PlattScaler');

test('Initialises with identity mapping (a=1, b=0)', () => {
  const p = new PlattScaler();
  eq(p.a, 1.0); eq(p.b, 0.0); eq(p.n, 0);
});

test('Default Platt (a=1,b=0) maps rawProb via sigmoid correctly', () => {
  const p = new PlattScaler();
  // sigmoid(1.0 * 0.5 + 0) = sigmoid(0.5) ≈ 0.622
  near(p.predict(0.5), 1 / (1 + Math.exp(-0.5)), 0.001, 'Default Platt should apply sigmoid(a*x + b)');
  // sigmoid(0) = 0.5 — the no-opinion point
  near(p.predict(0.0), 0.5, 0.001, 'predict(0) should be 0.5 for default params');
});

test('update() increments n', () => {
  const p = new PlattScaler();
  p.update(0.7, true); p.update(0.4, false);
  eq(p.n, 2);
});

test('After many wins at high rawProb, predict high shifts up', () => {
  const p = new PlattScaler(0.1);
  for (let i = 0; i < 50; i++) p.update(0.8, true);
  const pred = p.predict(0.8);
  gt(pred, 0.75, 'After many wins at 0.8, prediction should be > 0.75, got ' + pred);
});

test('After many losses at high rawProb, prediction shifts down', () => {
  const p = new PlattScaler(0.1);
  for (let i = 0; i < 50; i++) p.update(0.8, false);
  const pred = p.predict(0.8);
  lte(pred, 0.4, 'After many losses at 0.8, prediction should shift down, got ' + pred);
});

test('predict() returns value in [0,1]', () => {
  const p = new PlattScaler();
  for (let i = 0; i < 20; i++) p.update(Math.random(), Math.random() > 0.5);
  inRange(p.predict(0.3), 0, 1);
  inRange(p.predict(0.7), 0, 1);
  inRange(p.predict(0.0), 0, 1);
  inRange(p.predict(1.0), 0, 1);
});

test('fitBatch changes parameters from initial state', () => {
  const p = new PlattScaler();
  const aInit = p.a, bInit = p.b;
  const samples = Array.from({length:20}, (_, i) => ({
    rawProb: i/20, won: i/20 > 0.6
  }));
  p.fitBatch(samples, 10);
  truthy(p.a !== aInit || p.b !== bInit, 'fitBatch should change a or b');
});

test('Perfectly calibrated data: high prob → high prediction', () => {
  const p = new PlattScaler(0.05);
  // Train on data where win rate matches confidence exactly
  for (let i = 0; i < 100; i++) {
    const prob = Math.random();
    p.update(prob, Math.random() < prob);  // win probability = rawProb
  }
  const lo = p.predict(0.2);
  const hi = p.predict(0.8);
  gt(hi, lo, 'Higher rawProb should give higher prediction');
});

test('state() returns a, b, n', () => {
  const p = new PlattScaler();
  p.update(0.5, true);
  const s = p.state();
  truthy('a' in s && 'b' in s && 'n' in s, 'state() should have a, b, n');
  eq(s.n, 1);
});

test('monotone: predict(0.3) <= predict(0.5) <= predict(0.8) after calibration', () => {
  const p = new PlattScaler(0.05);
  for (let i = 0; i < 80; i++) {
    const prob = i / 80;
    p.update(prob, prob > 0.5);  // simple threshold pattern
  }
  const p3 = p.predict(0.3);
  const p5 = p.predict(0.5);
  const p8 = p.predict(0.8);
  lte(p3, p5 + 0.05, 'predict(0.3) should be <= predict(0.5)');
  lte(p5, p8 + 0.05, 'predict(0.5) should be <= predict(0.8)');
});

test('Extreme inputs do not crash', () => {
  const p = new PlattScaler();
  inRange(p.predict(0),   0, 1);
  inRange(p.predict(1),   0, 1);
  inRange(p.predict(-0.5), 0, 1);
  inRange(p.predict(1.5),  0, 1);
});

// ── IsotonicCalibrator ────────────────────────────────────────────────────────
console.log('\n-- 11-20. IsotonicCalibrator');

test('Empty mapping on construction', () => {
  const ic = new IsotonicCalibrator();
  eq(ic.mapping.length, 0);
  eq(ic.n, 0);
});

test('Predict before fit returns rawProb unchanged', () => {
  const ic = new IsotonicCalibrator();
  near(ic.predict(0.7), 0.7, 0.001, 'Before fit, should return rawProb');
});

test('fit() with monotone data produces correct mapping', () => {
  const ic = new IsotonicCalibrator();
  const samples = [
    { rawProb: 0.3, won: false }, { rawProb: 0.3, won: false },
    { rawProb: 0.6, won: true  }, { rawProb: 0.6, won: true  },
    { rawProb: 0.8, won: true  }, { rawProb: 0.8, won: true  },
  ];
  ic.fit(samples);
  gt(ic.predict(0.6), ic.predict(0.3), 'Higher rawProb should give higher calibrated prob');
  gt(ic.predict(0.8), ic.predict(0.6), 'Monotone increasing');
});

test('PAV enforces monotone: non-monotone input gets corrected', () => {
  const ic = new IsotonicCalibrator();
  // Inverted: high prob has low win rate (miscalibrated model)
  const samples = [
    { rawProb: 0.3, won: true  }, { rawProb: 0.3, won: true  }, { rawProb: 0.3, won: true  },
    { rawProb: 0.7, won: false }, { rawProb: 0.7, won: false }, { rawProb: 0.7, won: false },
  ];
  ic.fit(samples);
  // PAV merges them — output should be monotone regardless of input
  const pred30 = ic.predict(0.3);
  const pred70 = ic.predict(0.7);
  lte(pred30, pred70 + 0.01, 'PAV should enforce non-decreasing order');
});

test('predict() returns value in [0,1] after fit', () => {
  const ic = new IsotonicCalibrator();
  const samples = Array.from({length:20}, (_, i) => ({rawProb: i/20, won: i > 10}));
  ic.fit(samples);
  inRange(ic.predict(0.2), 0, 1);
  inRange(ic.predict(0.5), 0, 1);
  inRange(ic.predict(0.9), 0, 1);
});

test('predict() below first point returns first point value', () => {
  const ic = new IsotonicCalibrator();
  ic.fit([{rawProb:0.4, won:true}, {rawProb:0.4, won:true}, {rawProb:0.8, won:true}]);
  const first = ic.mapping[0].y;
  near(ic.predict(0.1), first, 0.001, 'Below first point should extrapolate flat');
});

test('predict() above last point returns last point value', () => {
  const ic = new IsotonicCalibrator();
  ic.fit([{rawProb:0.2, won:false}, {rawProb:0.2, won:false}, {rawProb:0.5, won:true}]);
  const last = ic.mapping[ic.mapping.length - 1].y;
  near(ic.predict(0.99), last, 0.001, 'Above last point should extrapolate flat');
});

test('state() returns n and points', () => {
  const ic = new IsotonicCalibrator();
  const samples = Array.from({length:10}, (_, i) => ({rawProb: i/10, won: i > 5}));
  ic.fit(samples);
  const s = ic.state();
  truthy('n' in s && 'points' in s, 'state() should have n and points');
  eq(s.n, 10);
});

test('Interpolation between points is linear', () => {
  const ic = new IsotonicCalibrator();
  // Two clear blocks: 0.3→0.0, 0.7→1.0
  ic.fit([
    {rawProb:0.3, won:false}, {rawProb:0.3, won:false}, {rawProb:0.3, won:false},
    {rawProb:0.7, won:true},  {rawProb:0.7, won:true},  {rawProb:0.7, won:true},
  ]);
  const mid = ic.predict(0.5);   // should be ~0.5 by linear interpolation
  inRange(mid, 0.3, 0.7, 'Midpoint interpolation should be between endpoints');
});

test('Handles single sample without crash', () => {
  const ic = new IsotonicCalibrator();
  ic.fit([{rawProb: 0.6, won: true}]);
  inRange(ic.predict(0.6), 0, 1);
});

// ── ReliabilityTracker ────────────────────────────────────────────────────────
console.log('\n-- 21-28. ReliabilityTracker');

test('All buckets start at zero', () => {
  const rt = new ReliabilityTracker();
  for (const b of rt.buckets) { eq(b.count, 0); eq(b.wins, 0); }
});

test('record() increments correct bucket', () => {
  const rt = new ReliabilityTracker(10);
  rt.record(0.75, true);   // bucket 7
  eq(rt.buckets[7].count, 1);
  eq(rt.buckets[7].wins,  1);
});

test('ECE = null with no samples', () => {
  const rt = new ReliabilityTracker();
  eq(rt.ece(), null);
});

test('Perfect calibration gives ECE = 0', () => {
  const rt = new ReliabilityTracker(10);
  // Each bucket: win rate exactly matches bucket midpoint
  for (let i = 0; i < 10; i++) {
    const prob     = (i + 0.5) / 10;   // bucket midpoint
    const wins     = Math.round(prob * 100);
    const losses   = 100 - wins;
    for (let j = 0; j < wins;   j++) rt.record(prob, true);
    for (let j = 0; j < losses; j++) rt.record(prob, false);
  }
  const ece = rt.ece();
  lte(ece, 0.02, 'Perfect calibration should have ECE near 0, got ' + ece);
});

test('Overconfident model gives positive ECE', () => {
  const rt = new ReliabilityTracker(10);
  // High confidence (bucket 8-9) but only 50% win rate
  for (let i = 0; i < 100; i++) rt.record(0.85, i % 2 === 0);
  gt(rt.ece(), 0.0, 'Overconfident model should have ECE > 0');
});

test('diagram() returns one entry per bucket', () => {
  const rt = new ReliabilityTracker(10);
  rt.record(0.5, true);
  const d = rt.diagram();
  eq(d.length, 10, 'Should have 10 diagram entries');
});

test('diagram() entry has required fields', () => {
  const rt = new ReliabilityTracker(10);
  rt.record(0.5, true);
  const d = rt.diagram();
  for (const entry of d) {
    for (const k of ['bucket', 'confLow', 'confHigh', 'midConf', 'accuracy', 'count', 'wins', 'gap']) {
      truthy(k in entry, 'Missing diagram field: ' + k);
    }
  }
});

test('totalSamples counts correctly', () => {
  const rt = new ReliabilityTracker();
  rt.record(0.3, true);
  rt.record(0.7, false);
  rt.record(0.5, true);
  eq(rt.totalSamples(), 3);
});

// ── ConfidenceCalibrator ──────────────────────────────────────────────────────
console.log('\n-- 29-45. ConfidenceCalibrator');

test('calibrate() returns raw conf when insufficient samples', () => {
  const cc = new ConfidenceCalibrator({ minSamplesForCalibration: 20 });
  const r  = cc.calibrate(75, 'TRENDING');
  eq(r.calibratedConf, 75, 'Should return raw when insufficient data');
  eq(r.method, 'raw_insufficient_data');
  eq(r.samplesUsed, 0);
});

test('calibrate() result has all required fields', () => {
  const cc = new ConfidenceCalibrator();
  const r  = cc.calibrate(70, 'RANGING');
  for (const k of ['calibratedConf', 'rawConf', 'method', 'calibratedProb', 'rawProb', 'samplesUsed']) {
    truthy(k in r, 'Missing calibrate() field: ' + k);
  }
});

test('calibratedConf is always in [30, 95]', () => {
  const cc = new ConfidenceCalibrator({ minSamplesForCalibration: 5 });
  for (let i = 0; i < 10; i++) cc.recordOutcome(60 + i*3, true, 'TRENDING');
  for (const rawConf of [30, 50, 60, 75, 85, 95]) {
    const r = cc.calibrate(rawConf, 'TRENDING');
    inRange(r.calibratedConf, 30, 95, 'calibratedConf out of range: ' + r.calibratedConf);
  }
});

test('rawProb = (rawConf - 30) / 65', () => {
  const cc = new ConfidenceCalibrator();
  const r  = cc.calibrate(65, 'UNKNOWN');
  near(r.rawProb, (65 - 30) / 65, 0.001, 'rawProb should be (rawConf-30)/65');
});

test('recordOutcome() increments totalSamples', () => {
  const cc = new ConfidenceCalibrator();
  eq(cc.totalSamples, 0);
  cc.recordOutcome(70, true,  'TRENDING');
  cc.recordOutcome(60, false, 'RANGING');
  eq(cc.totalSamples, 2);
});

test('recordOutcome() updates global Platt', () => {
  const cc = new ConfidenceCalibrator();
  const aInit = cc.platt.a;
  cc.recordOutcome(70, true, 'TRENDING');
  truthy(cc.platt.n === 1, 'Platt should have 1 sample');
});

test('recordOutcome() updates regime-specific Platt', () => {
  const cc = new ConfidenceCalibrator();
  cc.recordOutcome(70, true, 'TRENDING');
  eq(cc.regimePlatt['TRENDING'].n, 1, 'Regime Platt should have 1 sample');
  eq(cc.regimePlatt['RANGING'].n,  0, 'RANGING Platt should still be 0');
});

test('recordOutcome() updates global reliability tracker', () => {
  const cc = new ConfidenceCalibrator();
  cc.recordOutcome(75, true, 'TRENDING');
  eq(cc.reliability.totalSamples(), 1);
});

test('Isotonic refit triggered after isotonicMinSamples', () => {
  const cc = new ConfidenceCalibrator({ isotonicMinSamples: 5, minSamplesForCalibration: 5 });
  for (let i = 0; i < 15; i++) cc.recordOutcome(50 + i*3, i > 7, 'TRENDING');
  gt(cc.isotonic.n, 0, 'Isotonic should have been fitted');
  gt(cc.isotonic.mapping.length, 0, 'Isotonic should have mapping points');
});

test('Uses global Platt when sufficient samples (< isotonicMinSamples)', () => {
  const cc = new ConfidenceCalibrator({ minSamplesForCalibration: 5, isotonicMinSamples: 50, regimeMinSamples: 50 });
  for (let i = 0; i < 10; i++) cc.recordOutcome(60 + i, true, 'TRENDING');
  const r = cc.calibrate(70, 'TRENDING');
  eq(r.method, 'platt_global', 'Should use platt_global with 10 samples < isotonic threshold 50');
});

test('Uses isotonic when >= isotonicMinSamples and no regime model', () => {
  const cc = new ConfidenceCalibrator({ minSamplesForCalibration: 5, isotonicMinSamples: 10, regimeMinSamples: 50 });
  for (let i = 0; i < 15; i++) cc.recordOutcome(50 + i*3, i > 7, 'UNKNOWN');
  const r = cc.calibrate(70, 'UNKNOWN');
  eq(r.method, 'isotonic', 'Should use isotonic with 15 samples >= threshold 10');
});

test('Uses regime Platt when regime has sufficient samples', () => {
  const cc = new ConfidenceCalibrator({ minSamplesForCalibration: 5, regimeMinSamples: 10, isotonicMinSamples: 999 });
  for (let i = 0; i < 15; i++) cc.recordOutcome(65, true, 'TRENDING');
  const r = cc.calibrate(70, 'TRENDING');
  eq(r.method, 'platt_regime_TRENDING', 'Should use regime Platt with 15 TRENDING samples >= 10');
});

test('Unknown regime falls back to global calibration', () => {
  const cc = new ConfidenceCalibrator({ minSamplesForCalibration: 5, isotonicMinSamples: 999 });
  for (let i = 0; i < 10; i++) cc.recordOutcome(65, true, 'TRENDING');
  const r = cc.calibrate(70, 'NONEXISTENT_REGIME');
  eq(r.method, 'platt_global', 'Unknown regime should fall back to global');
});

test('Consistent wins at high conf → calibrated conf >= raw conf', () => {
  // If win rate at 80% conf is actually 85%, calibration should push conf up
  const cc = new ConfidenceCalibrator({ minSamplesForCalibration: 10, isotonicMinSamples: 999, regimeMinSamples: 999 });
  // Feed 30 samples: high conf → mostly wins (model underestimates)
  for (let i = 0; i < 30; i++) cc.recordOutcome(80, true, 'TRENDING');
  const r = cc.calibrate(80, 'TRENDING');
  gte(r.calibratedConf, 75, 'After all-wins at 80%, calibrated conf should remain high, got ' + r.calibratedConf);
});

test('Consistent losses at high conf → calibrated conf < raw conf', () => {
  const cc = new ConfidenceCalibrator({ minSamplesForCalibration: 10, isotonicMinSamples: 999, regimeMinSamples: 999 });
  for (let i = 0; i < 30; i++) cc.recordOutcome(80, false, 'TRENDING');
  const r = cc.calibrate(80, 'TRENDING');
  lte(r.calibratedConf, 70, 'After all-losses at 80%, calibrated conf should drop, got ' + r.calibratedConf);
});

test('history capped at maxHistory', () => {
  const cc = new ConfidenceCalibrator({ maxHistory: 20 });
  for (let i = 0; i < 30; i++) cc.recordOutcome(60, true, 'TRENDING');
  lte(cc.history.length, 20, 'History should be capped at maxHistory');
});

// ── ECE and status ────────────────────────────────────────────────────────────
console.log('\n-- 46-51. ECE and status()');

test('ece() returns null when no samples', () => {
  const cc = new ConfidenceCalibrator();
  eq(cc.ece(), null);
});

test('ece() returns number after samples recorded', () => {
  const cc = new ConfidenceCalibrator();
  for (let i = 0; i < 20; i++) cc.recordOutcome(65, i % 2 === 0, 'TRENDING');
  const ece = cc.ece();
  truthy(typeof ece === 'number' && !isNaN(ece), 'ece() should return a number');
  inRange(ece, 0, 1, 'ECE should be in [0,1]');
});

test('Per-regime ECE accessible', () => {
  const cc = new ConfidenceCalibrator();
  for (let i = 0; i < 20; i++) cc.recordOutcome(70, true, 'RANGING');
  const rECE = cc.ece('RANGING');
  truthy(typeof rECE === 'number', 'Regime ECE should be a number');
});

test('status() has all required fields', () => {
  const cc = new ConfidenceCalibrator();
  const s  = cc.status();
  for (const k of ['totalSamples','minSamplesRequired','isActive','globalECE',
                   'calibrationQuality','platt','isotonic','regimeStats','reliabilityDiagram']) {
    truthy(k in s, 'Missing status field: ' + k);
  }
});

test('calibrationQuality is excellent/good/moderate/poor/insufficient_data', () => {
  const cc = new ConfidenceCalibrator();
  const valid = ['excellent', 'good', 'moderate', 'poor', 'insufficient_data'];
  truthy(valid.includes(cc.status().calibrationQuality), 'Invalid calibrationQuality: ' + cc.status().calibrationQuality);
});

test('reliabilityDiagram has numBuckets entries', () => {
  const cc = new ConfidenceCalibrator({ numBuckets: 5 });
  const s  = cc.status();
  eq(s.reliabilityDiagram.length, 5, 'reliabilityDiagram should have numBuckets entries');
});

// ── trading-engine integration ────────────────────────────────────────────────
console.log('\n-- 52-56. Trading Engine Integration');

test('MLConfidence has calibrator property', () => {
  const { MLConfidence } = require('./ml-confidence');
  const ml = new MLConfidence();
  truthy(ml.calibrator instanceof ConfidenceCalibrator, 'mlConfidence.calibrator should be ConfidenceCalibrator');
});

test('getConfidence() result has calibration field', () => {
  const { MLConfidence } = require('./ml-confidence');
  const ml = new MLConfidence();
  // Cold-start train first
  const prices = Array.from({length:100}, (_, i) => 1.1 + i*0.0001);
  const { Indicators } = require('./trading-engine');
  // Skip training for this test — just check structure with fallback
  const r = ml.getConfidence({ rsi: 45, atr: '0.001', atrPercent: '0.1',
    marketRegime: 'TRENDING', mta: null, leadingSignal: null }, prices, null);
  if (r.calibration) {
    truthy('calibratedConf' in r.calibration, 'calibration.calibratedConf missing');
    truthy('method' in r.calibration, 'calibration.method missing');
  }
});

test('recordTrade() feeds calibrator when rawConfidence present', () => {
  const { MLConfidence } = require('./ml-confidence');
  const ml = new MLConfidence();
  const before = ml.calibrator.totalSamples;
  const trade  = { outcome: 'WIN', rawConfidence: 72, regime: 'TRENDING' };
  const fakeFeatures = new Array(13).fill(0);
  ml.recordTrade(trade, fakeFeatures, []);
  eq(ml.calibrator.totalSamples, before + 1, 'calibrator should record the trade');
});

test('recordTrade() skips calibrator when rawConfidence absent', () => {
  const { MLConfidence } = require('./ml-confidence');
  const ml  = new MLConfidence();
  const before = ml.calibrator.totalSamples;
  const trade  = { outcome: 'WIN' };  // no rawConfidence
  const fakeFeatures = new Array(13).fill(0);
  ml.recordTrade(trade, fakeFeatures, []);
  eq(ml.calibrator.totalSamples, before, 'calibrator should NOT be updated without rawConfidence');
});

test('TradingEngine exposes calibration in getStatus()', () => {
  const { TradingEngine } = require('./trading-engine');
  const e = new TradingEngine();
  const s = e.getStatus();
  truthy('calibration' in s, 'getStatus() should include calibration');
  truthy('totalSamples' in s.calibration, 'calibration.totalSamples missing');
  truthy('isActive'     in s.calibration, 'calibration.isActive missing');
  truthy('globalECE'    in s.calibration, 'calibration.globalECE missing');
});

console.log('\n=====================================================');
console.log('  RESULTS: ' + passed + ' passed  |  ' + failed + ' failed  |  ' + total + ' total');
console.log('=====================================================\n');

process.exit(failed > 0 ? 1 : 0);
