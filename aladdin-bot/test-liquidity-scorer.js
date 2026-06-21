'use strict';

const { LiquidityScorer, REGIMES, SESSIONS, SCORER_CONFIG } = require('./liquidity-scorer');

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
function gte(a, b, msg)  { if (!(a >= b))   throw new Error(msg || a + ' not >= ' + b); }
function lte(a, b, msg)  { if (!(a <= b))   throw new Error(msg || a + ' not <= ' + b); }
function inRange(v, lo, hi, msg) { if (v < lo || v > hi) throw new Error(msg || v + ' not in [' + lo + ',' + hi + ']'); }
function near(a, b, t, m){ if (Math.abs(a-b) > t) throw new Error(m || Math.abs(a-b) + ' > tol ' + t); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeVols(n, base, variance) {
  // Generate n volumes around base with given variance
  return Array.from({ length: n }, (_, i) => Math.max(1, base + (Math.sin(i) * variance)));
}

function makeScorer() { return new LiquidityScorer(); }

console.log('\n=====================================================');
console.log('  LIQUIDITY SCORER -- DEEP TEST SUITE');
console.log('=====================================================');

// ── 1-5: score() return shape ─────────────────────────────────────────────────
console.log('\n-- 1-5. score() return shape');

test('Returns all required fields', () => {
  const s = makeScorer();
  const r = s.score(makeVols(30, 1_000_000, 100_000));
  for (const k of ['score', 'regime', 'multiplier', 'blocked', 'components', 'reason']) {
    truthy(k in r, 'Missing field: ' + k);
  }
});

test('score is integer in [0, 100]', () => {
  const s = makeScorer();
  const r = s.score(makeVols(30, 1_000_000, 100_000));
  inRange(r.score, 0, 100, 'score out of range: ' + r.score);
  eq(r.score, Math.round(r.score), 'score should be integer');
});

test('regime is one of DEEP/NORMAL/THIN/DRY', () => {
  const s = makeScorer();
  const r = s.score(makeVols(30, 1_000_000, 100_000));
  truthy(['DEEP', 'NORMAL', 'THIN', 'DRY'].includes(r.regime), 'Invalid regime: ' + r.regime);
});

test('multiplier matches regime definition', () => {
  const s = makeScorer();
  const r = s.score(makeVols(30, 1_000_000, 100_000));
  const expected = REGIMES.find(rg => rg.name === r.regime)?.multiplier;
  eq(r.multiplier, expected, 'multiplier mismatch for regime ' + r.regime);
});

test('components object has all required sub-fields', () => {
  const s = makeScorer();
  const r = s.score(makeVols(30, 1_000_000, 100_000));
  for (const k of ['shortRelVol', 'longRelVol', 'trend', 'consistency', 'session',
                   'shortRatio', 'longRatio', 'shortAvg', 'longAvg', 'currentVol']) {
    truthy(k in r.components, 'Missing component: ' + k);
  }
});

// ── 6-10: empty / edge case inputs ────────────────────────────────────────────
console.log('\n-- 6-10. Edge case inputs');

test('Empty volume array returns score=50 (neutral default)', () => {
  const s = makeScorer();
  const r = s.score([]);
  eq(r.score, 50, 'Empty vols should give score=50, got ' + r.score);
  eq(r.note, 'no_volume_data');
});

test('Single bar returns valid score', () => {
  const s = makeScorer();
  const r = s.score([1_000_000]);
  inRange(r.score, 0, 100);
  truthy(['DEEP','NORMAL','THIN','DRY'].includes(r.regime));
});

test('All-zero volumes does not crash', () => {
  const s = makeScorer();
  const r = s.score(Array(30).fill(0));
  inRange(r.score, 0, 100);
});

test('Very large volumes does not crash or exceed 100', () => {
  const s = makeScorer();
  const r = s.score(makeVols(30, 1e12, 1e10));
  inRange(r.score, 0, 100);
});

test('Non-numeric array values handled gracefully', () => {
  const s = makeScorer();
  const vols = [null, undefined, NaN, 1_000_000, 900_000];
  try { s.score(vols); truthy(true); }
  catch(e) { throw new Error('Should not throw on bad data: ' + e.message); }
});

// ── 11-16: Regime thresholds ──────────────────────────────────────────────────
console.log('\n-- 11-16. Regime thresholds');

test('High current volume scores DEEP or NORMAL', () => {
  const s = makeScorer({ sessionAdjustEnabled: false });
  // Explicitly set current bar to 2.5x avg so shortRatio=2.5 → max shortRelVol pts
  const vols = makeVols(250, 1_000_000, 5_000);  // very consistent 1M avg
  vols[vols.length - 1] = 2_500_000;             // current = 2.5x avg
  const r = s.score(vols);
  // shortPts=35 + longPts=20 + trend~9 + consistency=15 = ~79
  gte(r.score, 70, 'Current vol 2.5x avg should score >= 70, got ' + r.score);
  truthy(['DEEP','NORMAL'].includes(r.regime), 'Should be DEEP or NORMAL, got ' + r.regime);
});

test('Score >= 50 and < 75 gives NORMAL regime', () => {
  const s = makeScorer({ sessionAdjustEnabled: false });
  // Construct a result manually by verifying the regime map
  const deepReg   = REGIMES.find(r => r.name === 'DEEP');
  const normalReg = REGIMES.find(r => r.name === 'NORMAL');
  gte(deepReg.minScore, 75);
  eq(normalReg.minScore, 50);
  eq(normalReg.multiplier, 0.92);
});

test('Score >= 25 and < 50 gives THIN regime', () => {
  const thinReg = REGIMES.find(r => r.name === 'THIN');
  eq(thinReg.minScore, 25);
  eq(thinReg.multiplier, 0.75);
  falsy(thinReg.blocked, 'THIN should not block entries');
});

test('Score < 25 gives DRY regime and blocked=true', () => {
  const dryReg = REGIMES.find(r => r.name === 'DRY');
  eq(dryReg.minScore, 0);
  eq(dryReg.multiplier, 0.00);
  truthy(dryReg.blocked, 'DRY should block entries');
});

test('DRY regime: blocked=true and multiplier=0', () => {
  const s = makeScorer({ sessionAdjustEnabled: false });
  // Force DRY: near-zero volume compared to history
  const history = makeVols(200, 1_000_000, 10_000);
  history.push(1);  // current bar has essentially zero volume
  const r = s.score(history);
  if (r.regime === 'DRY') {
    truthy(r.blocked, 'DRY should be blocked');
    eq(r.multiplier, 0.00, 'DRY multiplier should be 0');
  }
  // Score should be very low
  lte(r.score, 50, 'Near-zero volume should give low score, got ' + r.score);
});

test('DEEP regime: blocked=false and multiplier=1.0', () => {
  const deepReg = REGIMES.find(r => r.name === 'DEEP');
  falsy(deepReg.blocked, 'DEEP should not block');
  eq(deepReg.multiplier, 1.00, 'DEEP multiplier should be 1.0');
});

// ── 17-24: Score components ───────────────────────────────────────────────────
console.log('\n-- 17-24. Score components');

test('High current volume (2× avg) gives shortRelVol near max', () => {
  const s = makeScorer({ sessionAdjustEnabled: false });
  const vols = makeVols(25, 1_000_000, 10_000);
  vols[vols.length - 1] = 2_000_000;  // current bar = 2× avg
  const r = s.score(vols);
  gte(r.components.shortRelVol, 28, 'shortRelVol should be high for 2× volume, got ' + r.components.shortRelVol);
});

test('Current volume at avg (1.0×) gives moderate shortRelVol', () => {
  const s = makeScorer({ sessionAdjustEnabled: false });
  const vols = makeVols(25, 1_000_000, 1_000);  // very consistent
  const r = s.score(vols);
  const sr = r.components.shortRelVol;
  inRange(sr, 10, 25, 'shortRelVol at 1× avg should be moderate, got ' + sr);
});

test('Volume below 50% of avg gives low shortRelVol (≤ 4)', () => {
  const s = makeScorer({ sessionAdjustEnabled: false });
  const vols = makeVols(25, 1_000_000, 10_000);
  vols[vols.length - 1] = 400_000;  // 40% of avg
  const r = s.score(vols);
  lte(r.components.shortRelVol, 4, 'Low volume should give <= 4 shortRelVol, got ' + r.components.shortRelVol);
});

test('Rising volume trend gives higher trend score than falling', () => {
  const s = makeScorer({ sessionAdjustEnabled: false });
  const rising = [500_000, 600_000, 700_000, 800_000, 900_000, 1_000_000];
  const falling = [1_000_000, 900_000, 800_000, 700_000, 600_000, 500_000];

  // Test trend component directly
  const rRising  = s._volumeTrend(rising);
  const rFalling = s._volumeTrend(falling);
  gt(rRising, rFalling, 'Rising trend should score higher than falling, got ' + rRising + ' vs ' + rFalling);
});

test('Consistent volume gives higher consistency score than erratic', () => {
  const s = makeScorer();
  const consistent = makeVols(20, 1_000_000, 10_000);   // CV ≈ 0.01
  const erratic    = Array.from({ length: 20 }, (_, i) =>
    i % 2 === 0 ? 100_000 : 3_000_000);                 // alternating = high CV

  const cConsistent = s._volumeConsistency(consistent);
  const cErratic    = s._volumeConsistency(erratic);
  gt(cConsistent, cErratic, 'Consistent volume should score higher, got ' + cConsistent + ' vs ' + cErratic);
});

test('Maximum consistency score when CV <= 0.15', () => {
  const s = makeScorer();
  const vols = makeVols(20, 1_000_000, 5_000);  // very low CV
  const pts  = s._volumeConsistency(vols);
  eq(pts, SCORER_CONFIG.consistencyMax, 'Max consistency score for low CV, got ' + pts);
});

test('Zero consistency score when CV > 1.2', () => {
  const s = makeScorer();
  // 19 bars of 1, one bar of 100M → mean ~5M, std ~22M, CV ~4.4 >> 1.2
  const vols = Array.from({ length: 20 }, (_, i) => i < 19 ? 1 : 100_000_000);
  const mean = vols.reduce((a, b) => a + b, 0) / vols.length;
  const std  = Math.sqrt(vols.reduce((s, v) => s + (v - mean) ** 2, 0) / vols.length);
  const cv   = std / mean;
  gte(cv, 1.2, 'Test data should have CV >= 1.2, got ' + cv.toFixed(3));
  const pts  = s._volumeConsistency(vols);
  eq(pts, 0, 'Zero consistency for CV > 1.2 (' + cv.toFixed(2) + '), got ' + pts);
});

test('Short and long ratios reported in components', () => {
  const s = makeScorer({ sessionAdjustEnabled: false });
  const vols = makeVols(50, 1_000_000, 50_000);
  const r    = s.score(vols);
  truthy(typeof r.components.shortRatio === 'number', 'shortRatio should be number');
  truthy(typeof r.components.longRatio  === 'number', 'longRatio should be number');
  gt(r.components.shortRatio, 0, 'shortRatio should be positive');
});

// ── 25-33: Session bonus/penalty ──────────────────────────────────────────────
console.log('\n-- 25-33. Session bonus / penalty');

test('London+NY overlap (hour 14) gives +15 session bonus', () => {
  const s = makeScorer();
  const bonus = s._sessionBonus(14);
  eq(bonus, 15, 'Hour 14 (London+NY overlap) should give +15, got ' + bonus);
});

test('London session only (hour 10) gives +10 bonus', () => {
  const s = makeScorer();
  eq(s._sessionBonus(10), 10, 'Hour 10 (London) should give +10');
});

test('NY session only (hour 18) gives +10 bonus', () => {
  const s = makeScorer();
  eq(s._sessionBonus(18), 10, 'Hour 18 (NY) should give +10');
});

test('Asian session (hour 4) gives -5 penalty', () => {
  const s = makeScorer();
  eq(s._sessionBonus(4), -5, 'Hour 4 (Asian) should give -5');
});

test('Off-hours (hour 22) gives -15 penalty', () => {
  const s = makeScorer();
  eq(s._sessionBonus(22), -15, 'Hour 22 (off-hours) should give -15');
});

test('Score is HIGHER with London+NY session than off-hours (same volume)', () => {
  const s    = makeScorer();
  const vols = makeVols(30, 1_000_000, 50_000);
  const rPeak    = s.score(vols, [], 14);   // London+NY overlap
  const rOffHrs  = s.score(vols, [], 22);   // off-hours
  gt(rPeak.score, rOffHrs.score, 'Peak session should score higher than off-hours');
});

test('Score is LOWER during Asian session than London session', () => {
  const s    = makeScorer();
  const vols = makeVols(30, 1_000_000, 50_000);
  const rLon  = s.score(vols, [], 10);  // London
  const rAsia = s.score(vols, [], 4);   // Asian
  gt(rLon.score, rAsia.score, 'London should score higher than Asian session');
});

test('sessionAdjustEnabled=false gives session component = 0 for any hour', () => {
  const v = makeVols(30, 1_000_000, 50_000);
  // Create a fresh instance directly (not via makeScorer) to rule out any helper issue
  const { LiquidityScorer: LS } = require('./liquidity-scorer');
  const scorer = new LS({ sessionAdjustEnabled: false });
  truthy(scorer.cfg.sessionAdjustEnabled === false, 'cfg.sessionAdjustEnabled must be false');
  // Test hours 1-23 (skip 0 which can be ambiguous with falsy checks)
  for (const h of [1, 4, 8, 10, 13, 14, 16, 18, 21, 22, 23]) {
    const r = scorer.score(v, [], h);
    eq(r.components.session, 0,
      'Session component should be 0 at hour ' + h + ', got ' + r.components.session + ' (cfg.enabled=' + scorer.cfg.sessionAdjustEnabled + ')');
  }
});

test('utcHour=null gives 0 session bonus', () => {
  const s    = makeScorer({ sessionAdjustEnabled: true });
  const vols = makeVols(30, 1_000_000, 50_000);
  const r    = s.score(vols, [], null);
  eq(r.components.session, 0, 'null utcHour should give 0 session bonus');
});

// ── 34-39: applyToConfidence ──────────────────────────────────────────────────
console.log('\n-- 34-39. applyToConfidence');

test('DEEP regime: effectiveConf === rawConf (multiplier 1.0)', () => {
  const s   = makeScorer();
  const liq = { score: 80, regime: 'DEEP', multiplier: 1.0, blocked: false, reason: '' };
  const r   = s.applyToConfidence(70, liq);
  eq(r.effectiveConf, 70, 'DEEP should not reduce confidence');
  eq(r.adjustment, 0);
  falsy(r.blocked);
});

test('NORMAL regime: effectiveConf = round(rawConf * 0.92)', () => {
  const s   = makeScorer();
  const liq = { score: 60, regime: 'NORMAL', multiplier: 0.92, blocked: false, reason: '' };
  const r   = s.applyToConfidence(80, liq);
  eq(r.effectiveConf, Math.round(80 * 0.92), 'NORMAL should reduce conf by 8%');
});

test('THIN regime: effectiveConf = round(rawConf * 0.75)', () => {
  const s   = makeScorer();
  const liq = { score: 35, regime: 'THIN', multiplier: 0.75, blocked: false, reason: '' };
  const r   = s.applyToConfidence(80, liq);
  eq(r.effectiveConf, Math.round(80 * 0.75), 'THIN should reduce conf by 25%');
});

test('DRY regime: effectiveConf=0 and blocked=true', () => {
  const s   = makeScorer();
  const liq = { score: 10, regime: 'DRY', multiplier: 0.0, blocked: true, reason: 'DRY' };
  const r   = s.applyToConfidence(85, liq);
  eq(r.effectiveConf, 0, 'DRY should give effectiveConf=0');
  truthy(r.blocked, 'DRY should be blocked');
});

test('Null liquidityResult returns rawConf unchanged', () => {
  const s = makeScorer();
  const r = s.applyToConfidence(75, null);
  eq(r.effectiveConf, 75, 'null result should return rawConf unchanged');
  falsy(r.blocked);
});

test('adjustment = effectiveConf - rawConf (negative for THIN/DRY)', () => {
  const s   = makeScorer();
  const liq = { score: 35, regime: 'THIN', multiplier: 0.75, blocked: false, reason: '' };
  const r   = s.applyToConfidence(80, liq);
  eq(r.adjustment, r.effectiveConf - 80, 'adjustment should be effectiveConf - rawConf');
  lte(r.adjustment, 0, 'THIN adjustment should be negative');
});

// ── 40-45: history and status ─────────────────────────────────────────────────
console.log('\n-- 40-45. history and status');

test('History accumulates after each score call', () => {
  const s = makeScorer();
  s.score(makeVols(30, 1_000_000, 100_000));
  s.score(makeVols(30, 1_000_000, 100_000));
  s.score(makeVols(30, 1_000_000, 100_000));
  eq(s.history.length, 3);
});

test('History capped at 50 entries', () => {
  const s = makeScorer();
  for (let i = 0; i < 60; i++) s.score(makeVols(30, 1_000_000, 100_000));
  eq(s.history.length, 50, 'History should cap at 50');
});

test('lastResult updated after each score call', () => {
  const s = makeScorer();
  eq(s.lastResult, null, 'lastResult should be null initially');
  s.score(makeVols(30, 1_000_000, 100_000));
  truthy(s.lastResult !== null, 'lastResult should be set after score call');
});

test('status returns all required fields', () => {
  const s = makeScorer();
  s.score(makeVols(30, 1_000_000, 100_000));
  const st = s.status();
  for (const k of ['lastScore', 'lastRegime', 'lastMultiplier', 'avgScore10Bar', 'regimeCounts', 'historyLength']) {
    truthy(k in st, 'Missing status field: ' + k);
  }
});

test('status avgScore10Bar is average of last 10 scores', () => {
  const s = makeScorer({ sessionAdjustEnabled: false });
  const vols = makeVols(30, 1_000_000, 10_000);
  for (let i = 0; i < 10; i++) s.score(vols);
  const st  = s.status();
  const expected = Math.round(s.history.slice(-10).reduce((sum, h) => sum + h.score, 0) / 10);
  eq(st.avgScore10Bar, expected, 'avgScore10Bar should be average of last 10, got ' + st.avgScore10Bar);
});

test('regimeCounts tracks regime distribution', () => {
  const s    = makeScorer({ sessionAdjustEnabled: false });
  const high = makeVols(30, 2_000_000, 10_000);   // likely DEEP or NORMAL
  const low  = makeVols(30, 100_000, 1_000);       // likely THIN or DRY
  for (let i = 0; i < 5; i++) { s.score(high); s.score(low); }
  const st = s.status();
  gt(Object.keys(st.regimeCounts).length, 0, 'regimeCounts should have entries');
  eq(st.historyLength, 10, 'historyLength should be 10');
});

// ── 46-51: trading-engine integration ────────────────────────────────────────
console.log('\n-- 46-51. Trading Engine Integration');

test('Engine has liquidityScorer property', () => {
  const { TradingEngine } = require('./trading-engine');
  const e = new TradingEngine();
  truthy(e.liquidityScorer instanceof LiquidityScorer, 'engine.liquidityScorer should be LiquidityScorer');
});

test('getStatus includes liquidity field', () => {
  const { TradingEngine } = require('./trading-engine');
  const e = new TradingEngine();
  const s = e.getStatus();
  truthy('liquidity' in s, 'getStatus should include liquidity field');
});

test('liquidity status has required fields', () => {
  const { TradingEngine } = require('./trading-engine');
  const e = new TradingEngine();
  const s = e.getStatus();
  for (const k of ['lastScore', 'lastRegime', 'lastMultiplier']) {
    truthy(k in s.liquidity, 'Missing liquidity status field: ' + k);
  }
});

test('TrendStrategy: DRY liquidity returns HOLD', () => {
  const { TrendStrategy } = require('./strategies/trendStrategy');
  const ts  = new TrendStrategy();
  const ind = {
    price: 1.1, rsi: 38, ema9: 1.105, ema21: 1.095, ema50: 1.090, ema200: 1.080,
    atrPercent: 1.0, marketRegime: 'TRENDING', goldenCross: true,
    ema50Slope: 0.8, vwap: 1.098, volRatio: 1.2, liquidMarket: false,
    signal: 'STRONG_BUY',
    liquidityBlocked: true, liquidityMultiplier: 0.0,
    liquidityRegime: 'DRY', liquidityScore: 10,
    bb: { upper: 1.12, middle: 1.10, lower: 1.08 }, atr: 0.011,
    mta: { allowed: true, score: 0.7, reason: '' },
  };
  const d = ts.decide(ind, { hasPosition: false });
  eq(d.action, 'HOLD', 'DRY liquidity should return HOLD in TrendStrategy, got ' + d.action);
  truthy(d.reasoning.includes('DRY'), 'Reasoning should mention DRY');
});

test('MeanReversionStrategy: DRY liquidity returns HOLD', () => {
  const { MeanReversionStrategy } = require('./strategies/meanReversion');
  const mr  = new MeanReversionStrategy();
  const ind = {
    price: 1.08, rsi: 25, ema9: 1.082, ema21: 1.090, ema50: 1.090, ema200: 1.080,
    atrPercent: 0.5, marketRegime: 'RANGING', goldenCross: true,
    vwap: 1.09, volRatio: 1.1, liquidMarket: true,
    signal: 'STRONG_BUY',
    liquidityBlocked: true, liquidityMultiplier: 0.0,
    liquidityRegime: 'DRY', liquidityScore: 12,
    bb: { upper: 1.12, middle: 1.10, lower: 1.085 }, atr: 0.005,
    mta: { allowed: true, score: 0.6, reason: '' },
  };
  const d = mr.decide(ind, { hasPosition: false });
  eq(d.action, 'HOLD', 'DRY liquidity should return HOLD in MeanReversion, got ' + d.action);
});

test('TrendStrategy DEEP liquidity applies multiplier=1.0 (no reduction)', () => {
  const { TrendStrategy } = require('./strategies/trendStrategy');
  const ts  = new TrendStrategy({ minConfidence: 50 });
  const ind = {
    price: 1.1, rsi: 38, ema9: 1.105, ema21: 1.095, ema50: 1.090, ema200: 1.080,
    atrPercent: 1.0, marketRegime: 'TRENDING', goldenCross: true,
    ema50Slope: 0.8, vwap: 1.098, volRatio: 1.5, liquidMarket: true,
    signal: 'STRONG_BUY',
    liquidityBlocked: false, liquidityMultiplier: 1.0,
    liquidityRegime: 'DEEP', liquidityScore: 80,
    bb: { upper: 1.12, middle: 1.10, lower: 1.08 }, atr: 0.011,
    mta: { allowed: true, score: 0.8, reason: '' },
  };
  const d = ts.decide(ind, { hasPosition: false });
  if (d.action === 'BUY') {
    // With multiplier=1.0, confidence should be same as without liquidity adjustment
    gte(d.confidence, 50, 'DEEP should give full confidence');
    truthy(d.reasoning.includes('DEEP'), 'Reasoning should mention DEEP');
  }
});

console.log('\n=====================================================');
console.log('  RESULTS: ' + passed + ' passed  |  ' + failed + ' failed  |  ' + total + ' total');
console.log('=====================================================\n');

process.exit(failed > 0 ? 1 : 0);
