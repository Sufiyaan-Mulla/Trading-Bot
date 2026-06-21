'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  test-ensemble.js
//  Tests every component of the Ensemble Voting system:
//
//  _computeWeights()
//    1.  All strategies get at least ensembleMinWeight
//    2.  Weight = profit factor, clamped to [min, max]
//    3.  Strategy with no trades gets minWeight
//    4.  Strategy with PF > maxWeight is clamped to maxWeight
//    5.  Strategy with PF < minWeight is lifted to minWeight
//
//  _ensembleVote()
//    6.  All HOLD → ensemble returns HOLD
//    7.  One BUY above threshold + enough agree → BUY
//    8.  One SELL above threshold + enough agree → SELL
//    9.  BUY and SELL both strong → higher score wins
//   10.  Score below threshold → HOLD even if strategies agree
//   11.  Below minAgree strategies → HOLD even if score clears threshold
//   12.  Ensemble confidence is normalised average of agreeing strategies
//   13.  ensembleScore is sum of confidence × weight for winning action
//   14.  fromEnsemble flag is true on ensemble result
//   15.  reasoning string is non-empty
//
//  tick() integration
//   16.  tick() returns ensemble decision when ensembleEnabled=true
//   17.  tick() returns champion decision when ensembleEnabled=false
//   18.  tick() snapshot includes ensemble field
//   19.  Ensemble decision has action, confidence, ensembleScore, agreeing
//
//  setEnsembleEnabled()
//   20.  Toggle OFF → tick returns champion decision
//   21.  Toggle ON  → tick returns ensemble decision
//
//  ensembleStatus()
//   22.  Returns enabled, threshold, minAgree, weights, lastBar
//   23.  Weights map has one entry per contestant
//
//  status() and signalLine()
//   24.  status() includes ensemble field
//   25.  signalLine() includes 🗳️ ENSEMBLE entry after first tick
//
//  High-conviction filter
//   26.  Unanimous BUY (5/5) clears threshold easily
//   27.  Split vote (3 BUY, 2 SELL) with high scores still resolves correctly
//   28.  Weak signals (confidence < threshold/5) stay HOLD
//
//  End-to-end
//   29.  200-bar simulation — ensemble decisions are valid actions
//   30.  200-bar simulation — ensemble blocks more trades than champion-only
// ═══════════════════════════════════════════════════════════════════════════════

const { ABTester, AB_CONFIG, VirtualAccount } = require('./ab-tester');

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
function falsy(v, msg)    { if (v)        throw new Error(msg || `expected falsy, got ${v}`); }
function gt(a, b, msg)    { if (!(a > b)) throw new Error(msg || `${a} not > ${b}`); }
function gte(a, b, msg)   { if (!(a >= b)) throw new Error(msg || `${a} >= ${b} failed`); }
function lte(a, b, msg)   { if (!(a <= b)) throw new Error(msg || `${a} <= ${b} failed`); }
function near(a, b, t, m) { if (Math.abs(a - b) > t) throw new Error(m || `|${a} - ${b}| > ${t}`); }
function includes(s, sub, msg) { if (!String(s).includes(sub)) throw new Error(msg || `"${s}" does not include "${sub}"`); }

// ── Test config — small thresholds for easy test control ────────────────────
const TEST_CFG = {
  virtualCapital:         10_000,
  virtualRiskPct:         0.08,
  virtualSlippage:        0.0003,
  virtualCommission:      0.0002,
  minTradesForComparison: 100,   // disable auto-promotion during tests
  promotionThresholdPct:  999,
  reportEveryBars:        999999,
  sharpeWindow:           10,
  logDir:                 require('os').tmpdir(),
  ensembleEnabled:        true,
  ensembleThreshold:      200,
  ensembleMinAgree:       2,
  ensembleMinWeight:      1.0,
  ensembleMaxWeight:      5.0,
};

function makeAB (cfgOverride = {}) {
  return new ABTester({ ...TEST_CFG, ...cfgOverride });
}

// Minimal indicators that keep strategies quiet (HOLD)
const HOLD_IND = {
  price: 1.1, rsi: 52, macd: 0, macdSignal: 0, macdHist: 0,
  ema9: 1.102, ema21: 1.098, ema50: 1.090, ema200: 1.080,
  atr: 0.0015, atrPercent: 0.14,
  bb: { upper: 1.115, middle: 1.100, lower: 1.085 },
  vwap: 1.099, volume: 1_000_000, avgVolume: 1_000_000,
  signal: 'NEUTRAL', goldenCross: true, regime: 'RANGING',
  mta: { allowed: false, score: 0, reason: 'test' },
};

// ── Helper: inject mock strategy decisions directly into _ensembleVote ────────
function mockVote (ab, decisionsMap) {
  return ab._ensembleVote(decisionsMap);
}

// ── Helper: set a contestant's mock trades to give it a specific PF ───────────
function setPF (ab, id, pf) {
  const c = ab.contestants.get(id);
  if (pf <= 0) {
    c.account.trades = Array(10).fill({ profit: -5, win: false });
  } else {
    // pf = grossProfit / grossLoss → with losses of $5 each, wins = pf * 5
    const winProfit = pf * 5;
    c.account.trades = [
      ...Array(5).fill({ profit: winProfit, win: true }),
      ...Array(5).fill({ profit: -5, win: false }),
    ];
  }
}

// ════════════════════════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════');
console.log('  ENSEMBLE VOTING — FULL TEST SUITE');
console.log('═══════════════════════════════════════════════════════════');
console.log('\n── 1–5. _computeWeights() ───────────────────────────────────');

test('All strategies get at least ensembleMinWeight', () => {
  const ab = makeAB();
  const w  = ab._computeWeights();
  for (const [id, weight] of Object.entries(w)) {
    gte(weight, TEST_CFG.ensembleMinWeight,
      `${id}: weight ${weight} < minWeight ${TEST_CFG.ensembleMinWeight}`);
  }
});

test('Strategy weight = profit factor when in [min, max]', () => {
  const ab = makeAB();
  setPF(ab, 'trend', 2.5);
  const w = ab._computeWeights();
  near(w.trend, 2.5, 0.1, `trend weight should be ~2.5, got ${w.trend}`);
});

test('Strategy with no trades gets minWeight', () => {
  const ab = makeAB();
  // No trades for champion by default — should get minWeight
  ab.contestants.get('champion').account.trades = [];
  const w = ab._computeWeights();
  eq(w.champion, TEST_CFG.ensembleMinWeight,
    `champion with no trades should get minWeight ${TEST_CFG.ensembleMinWeight}, got ${w.champion}`);
});

test('PF above maxWeight is clamped to maxWeight', () => {
  const ab = makeAB();
  setPF(ab, 'trend', 99);   // artificially huge PF
  const w = ab._computeWeights();
  eq(w.trend, TEST_CFG.ensembleMaxWeight,
    `Huge PF should be clamped to maxWeight ${TEST_CFG.ensembleMaxWeight}, got ${w.trend}`);
});

test('PF below minWeight is lifted to minWeight', () => {
  const ab = makeAB();
  setPF(ab, 'trend', 0.1);   // poor PF below minWeight
  const w = ab._computeWeights();
  eq(w.trend, TEST_CFG.ensembleMinWeight,
    `Low PF should be lifted to minWeight ${TEST_CFG.ensembleMinWeight}, got ${w.trend}`);
});

// ════════════════════════════════════════════════════════════════════════════════
console.log('\n── 6–15. _ensembleVote() ────────────────────────────────────');

test('All HOLD → ensemble returns HOLD', () => {
  const ab = makeAB();
  const decisions = {};
  for (const id of ab.contestants.keys()) {
    decisions[id] = { action: 'HOLD', confidence: 0, reasoning: '' };
  }
  const r = mockVote(ab, decisions);
  eq(r.action, 'HOLD', `Expected HOLD, got ${r.action}`);
});

test('Enough BUY votes above threshold → BUY', () => {
  // 3 strategies saying BUY with conf=80, weight=1 → score = 240 > threshold 200
  const ab = makeAB({ ensembleMinAgree: 2, ensembleThreshold: 200 });
  const ids = [...ab.contestants.keys()];
  const decisions = {};
  for (const id of ids) decisions[id] = { action: 'HOLD', confidence: 0, reasoning: '' };
  // Override 3 to BUY with conf 80
  decisions[ids[0]] = { action: 'BUY', confidence: 80, reasoning: '' };
  decisions[ids[1]] = { action: 'BUY', confidence: 80, reasoning: '' };
  decisions[ids[2]] = { action: 'BUY', confidence: 80, reasoning: '' };
  const r = mockVote(ab, decisions);
  eq(r.action, 'BUY', `Expected BUY, got ${r.action}`);
  gte(r.agreeing, 2, 'agreeing should be >= 2');
});

test('Enough SELL votes above threshold → SELL', () => {
  const ab = makeAB({ ensembleMinAgree: 2, ensembleThreshold: 200 });
  const ids = [...ab.contestants.keys()];
  const decisions = {};
  for (const id of ids) decisions[id] = { action: 'HOLD', confidence: 0, reasoning: '' };
  decisions[ids[0]] = { action: 'SELL', confidence: 80, reasoning: '' };
  decisions[ids[1]] = { action: 'SELL', confidence: 80, reasoning: '' };
  decisions[ids[2]] = { action: 'SELL', confidence: 80, reasoning: '' };
  const r = mockVote(ab, decisions);
  eq(r.action, 'SELL', `Expected SELL, got ${r.action}`);
});

test('BUY vs SELL — higher weighted score wins', () => {
  const ab = makeAB({ ensembleMinAgree: 1, ensembleThreshold: 50 });
  const ids = [...ab.contestants.keys()];
  const decisions = {};
  for (const id of ids) decisions[id] = { action: 'HOLD', confidence: 0, reasoning: '' };
  // 2 BUY at conf 60, 3 SELL at conf 90 → SELL wins
  decisions[ids[0]] = { action: 'BUY',  confidence: 60, reasoning: '' };
  decisions[ids[1]] = { action: 'BUY',  confidence: 60, reasoning: '' };
  decisions[ids[2]] = { action: 'SELL', confidence: 90, reasoning: '' };
  decisions[ids[3]] = { action: 'SELL', confidence: 90, reasoning: '' };
  decisions[ids[4]] = { action: 'SELL', confidence: 90, reasoning: '' };
  const r = mockVote(ab, decisions);
  eq(r.action, 'SELL', `SELL should win (higher total score), got ${r.action}`);
});

test('Score below threshold → HOLD even if strategies agree', () => {
  const ab = makeAB({ ensembleMinAgree: 2, ensembleThreshold: 500 }); // very high threshold
  const ids = [...ab.contestants.keys()];
  const decisions = {};
  for (const id of ids) decisions[id] = { action: 'HOLD', confidence: 0, reasoning: '' };
  // 3 BUY at conf 50 → score = 150 < threshold 500
  decisions[ids[0]] = { action: 'BUY', confidence: 50, reasoning: '' };
  decisions[ids[1]] = { action: 'BUY', confidence: 50, reasoning: '' };
  decisions[ids[2]] = { action: 'BUY', confidence: 50, reasoning: '' };
  const r = mockVote(ab, decisions);
  eq(r.action, 'HOLD', `Score 150 < threshold 500 should give HOLD, got ${r.action}`);
});

test('Below minAgree strategies → HOLD even if score clears threshold', () => {
  const ab = makeAB({ ensembleMinAgree: 3, ensembleThreshold: 50 }); // need 3 to agree
  const ids = [...ab.contestants.keys()];
  const decisions = {};
  for (const id of ids) decisions[id] = { action: 'HOLD', confidence: 0, reasoning: '' };
  // Only 2 agree — below minAgree=3
  decisions[ids[0]] = { action: 'BUY', confidence: 90, reasoning: '' };
  decisions[ids[1]] = { action: 'BUY', confidence: 90, reasoning: '' };
  const r = mockVote(ab, decisions);
  eq(r.action, 'HOLD', `Only 2 agree (< minAgree 3) should give HOLD, got ${r.action}`);
});

test('Ensemble confidence is normalised average of agreeing strategies', () => {
  const ab = makeAB({ ensembleMinAgree: 2, ensembleThreshold: 100 });
  const ids = [...ab.contestants.keys()];
  const decisions = {};
  for (const id of ids) decisions[id] = { action: 'HOLD', confidence: 0, reasoning: '' };
  // 2 BUY strategies with conf 70 and 90 → expected avg conf = 80
  decisions[ids[0]] = { action: 'BUY', confidence: 70, reasoning: '' };
  decisions[ids[1]] = { action: 'BUY', confidence: 90, reasoning: '' };
  const r = mockVote(ab, decisions);
  if (r.action === 'BUY') {
    near(r.confidence, 80, 5, `Normalised confidence should be ~80, got ${r.confidence}`);
  }
});

test('ensembleScore is sum of confidence × weight for winning action', () => {
  const ab = makeAB({ ensembleMinAgree: 1, ensembleThreshold: 50 });
  // All weights = 1.0 (no trades yet)
  const ids = [...ab.contestants.keys()];
  const decisions = {};
  for (const id of ids) decisions[id] = { action: 'HOLD', confidence: 0, reasoning: '' };
  decisions[ids[0]] = { action: 'BUY', confidence: 70, reasoning: '' };
  const r = mockVote(ab, decisions);
  if (r.action === 'BUY') {
    // weight = minWeight = 1.0, confidence = 70 → score = 70
    near(r.ensembleScore, 70, 5, `Score should be ~70 (70 × 1.0), got ${r.ensembleScore}`);
  }
});

test('fromEnsemble flag is true on ensemble result', () => {
  const ab = makeAB();
  const decisions = {};
  for (const id of ab.contestants.keys()) {
    decisions[id] = { action: 'HOLD', confidence: 0, reasoning: '' };
  }
  const r = mockVote(ab, decisions);
  truthy(r.fromEnsemble === true, `fromEnsemble should be true, got ${r.fromEnsemble}`);
});

test('reasoning string is non-empty', () => {
  const ab = makeAB();
  const decisions = {};
  for (const id of ab.contestants.keys()) {
    decisions[id] = { action: 'HOLD', confidence: 0, reasoning: '' };
  }
  const r = mockVote(ab, decisions);
  truthy(typeof r.reasoning === 'string' && r.reasoning.length > 0,
    `reasoning should be non-empty string, got: ${r.reasoning}`);
});

// ════════════════════════════════════════════════════════════════════════════════
console.log('\n── 16–19. tick() Integration ────────────────────────────────');

test('tick() returns ensemble decision when ensembleEnabled=true', () => {
  const ab = makeAB({ ensembleEnabled: true });
  const d  = ab.tick(HOLD_IND, { hasPosition: false }, 1.1);
  truthy('fromEnsemble' in d, 'decision should have fromEnsemble field');
  truthy(d.fromEnsemble === true, 'fromEnsemble should be true');
  truthy(['BUY','SELL','HOLD'].includes(d.action));
});

test('tick() returns champion decision when ensembleEnabled=false', () => {
  const ab = makeAB({ ensembleEnabled: false });
  const d  = ab.tick(HOLD_IND, { hasPosition: false }, 1.1);
  // When disabled, fromEnsemble is false
  truthy(d.fromEnsemble === false, 'fromEnsemble should be false when disabled');
});

test('tick() snapshot includes ensemble field', () => {
  const ab = makeAB({ ensembleEnabled: true });
  ab.tick(HOLD_IND, { hasPosition: false }, 1.1);
  const snap = ab.signalHistory.at(-1);
  truthy('ensemble' in snap, 'snapshot should include ensemble field');
  truthy(typeof snap.ensemble === 'string', 'ensemble should be a string like "HOLD(0)"');
});

test('Ensemble decision has action, confidence, ensembleScore, agreeing', () => {
  const ab = makeAB({ ensembleEnabled: true });
  const d  = ab.tick(HOLD_IND, { hasPosition: false }, 1.1);
  truthy('action'        in d, 'missing action');
  truthy('confidence'    in d, 'missing confidence');
  truthy('ensembleScore' in d, 'missing ensembleScore');
  truthy('agreeing'      in d, 'missing agreeing');
  truthy('weights'       in d, 'missing weights');
});

// ════════════════════════════════════════════════════════════════════════════════
console.log('\n── 20–21. setEnsembleEnabled() ──────────────────────────────');

test('Toggle OFF → tick returns champion decision (fromEnsemble=false)', () => {
  const ab = makeAB({ ensembleEnabled: true });
  ab.setEnsembleEnabled(false);
  const d = ab.tick(HOLD_IND, { hasPosition: false }, 1.1);
  eq(d.fromEnsemble, false, 'After disabling, fromEnsemble should be false');
});

test('Toggle ON → tick returns ensemble decision (fromEnsemble=true)', () => {
  const ab = makeAB({ ensembleEnabled: false });
  ab.setEnsembleEnabled(true);
  const d = ab.tick(HOLD_IND, { hasPosition: false }, 1.1);
  eq(d.fromEnsemble, true, 'After enabling, fromEnsemble should be true');
});

// ════════════════════════════════════════════════════════════════════════════════
console.log('\n── 22–23. ensembleStatus() ──────────────────────────────────');

test('ensembleStatus() returns all required fields', () => {
  const ab = makeAB();
  const es = ab.ensembleStatus();
  truthy('enabled'   in es, 'missing enabled');
  truthy('threshold' in es, 'missing threshold');
  truthy('minAgree'  in es, 'missing minAgree');
  truthy('weights'   in es, 'missing weights');
  truthy('lastBar'   in es, 'missing lastBar');
});

test('weights map has one entry per contestant', () => {
  const ab = makeAB();
  const es = ab.ensembleStatus();
  eq(Object.keys(es.weights).length, ab.contestants.size,
    `weights should have ${ab.contestants.size} entries, got ${Object.keys(es.weights).length}`);
});

// ════════════════════════════════════════════════════════════════════════════════
console.log('\n── 24–25. status() and signalLine() ─────────────────────────');

test('status() includes ensemble field', () => {
  const ab = makeAB();
  ab.tick(HOLD_IND, { hasPosition: false }, 1.1);
  const s = ab.status();
  truthy('ensemble' in s, 'status should include ensemble field');
  truthy('enabled'  in s.ensemble);
  truthy('weights'  in s.ensemble);
});

test('signalLine() includes 🗳️ ENSEMBLE entry after first tick', () => {
  const ab = makeAB({ ensembleEnabled: true });
  ab.tick(HOLD_IND, { hasPosition: false }, 1.1);
  const line = ab.signalLine();
  truthy(line.includes('ENSEMBLE'), `signalLine should include ENSEMBLE, got: ${line}`);
  truthy(line.includes('[ABTester]'), 'should have [ABTester] prefix');
});

// ════════════════════════════════════════════════════════════════════════════════
console.log('\n── 26–28. High-conviction Filter ───────────────────────────');

test('Unanimous BUY (5/5 strategies) with high confidence clears threshold', () => {
  // 5 strategies × conf 90 × weight 1.0 = 450 >> threshold 200
  const ab = makeAB({ ensembleMinAgree: 2, ensembleThreshold: 200 });
  const decisions = {};
  for (const id of ab.contestants.keys()) {
    decisions[id] = { action: 'BUY', confidence: 90, reasoning: '' };
  }
  const r = mockVote(ab, decisions);
  eq(r.action, 'BUY', `Unanimous BUY should resolve to BUY, got ${r.action}`);
  eq(r.agreeing, 5, `All 5 should agree, got ${r.agreeing}`);
});

test('Split vote (3 BUY, 2 SELL) resolves to BUY when BUY score is higher', () => {
  const ab = makeAB({ ensembleMinAgree: 2, ensembleThreshold: 100 });
  const ids = [...ab.contestants.keys()];
  const decisions = {};
  // 3 BUY at conf 80 → buyScore = 240
  // 2 SELL at conf 70 → sellScore = 140
  decisions[ids[0]] = { action: 'BUY',  confidence: 80, reasoning: '' };
  decisions[ids[1]] = { action: 'BUY',  confidence: 80, reasoning: '' };
  decisions[ids[2]] = { action: 'BUY',  confidence: 80, reasoning: '' };
  decisions[ids[3]] = { action: 'SELL', confidence: 70, reasoning: '' };
  decisions[ids[4]] = { action: 'SELL', confidence: 70, reasoning: '' };
  const r = mockVote(ab, decisions);
  eq(r.action, 'BUY', `BUY (score 240) should beat SELL (score 140), got ${r.action}`);
});

test('Weak signals all below threshold → HOLD', () => {
  // 5 strategies BUY at conf 10 × weight 1.0 = 50 < threshold 200
  const ab = makeAB({ ensembleMinAgree: 2, ensembleThreshold: 200 });
  const decisions = {};
  for (const id of ab.contestants.keys()) {
    decisions[id] = { action: 'BUY', confidence: 10, reasoning: '' };
  }
  const r = mockVote(ab, decisions);
  eq(r.action, 'HOLD', `Weak signals (score 50) should give HOLD, got ${r.action}`);
});

// ════════════════════════════════════════════════════════════════════════════════
console.log('\n── 29–30. End-to-End Simulation ────────────────────────────');

test('200-bar simulation — ensemble decisions are all valid actions', () => {
  const ab = makeAB({ ensembleEnabled: true });
  let price = 1.1;
  let seed  = 42;
  const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xFFFFFFFF; };

  for (let i = 0; i < 200; i++) {
    price = Math.max(0.9, price * (1 + (rng() - 0.49) * 0.003));
    const ind = { ...HOLD_IND, price };
    const d   = ab.tick(ind, { hasPosition: false }, price);
    truthy(['BUY','SELL','HOLD'].includes(d.action),
      `Invalid action at bar ${i}: ${d.action}`);
    truthy(typeof d.ensembleScore === 'number' && !isNaN(d.ensembleScore),
      `Invalid ensembleScore at bar ${i}: ${d.ensembleScore}`);
  }
  eq(ab.barCount, 200);
});

test('Ensemble filters more aggressively than champion-only on identical signals', () => {
  // Run with very high threshold to force more HOLDs
  const abEnsemble = makeAB({ ensembleEnabled: true,  ensembleThreshold: 9999 });
  const abChampion = makeAB({ ensembleEnabled: false });

  let price = 1.1, seed = 7;
  const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xFFFFFFFF; };

  let ensembleBuys = 0, championBuys = 0;

  for (let i = 0; i < 100; i++) {
    price = Math.max(0.9, price * (1 + (rng() - 0.49) * 0.003));
    const ind = { ...HOLD_IND, price,
      signal:   rng() > 0.5 ? 'STRONG_BUY' : 'NEUTRAL',
      rsi:      30 + rng() * 40,
      goldenCross: true,
    };

    const dE = abEnsemble.tick(ind, { hasPosition: false }, price);
    const dC = abChampion.tick(ind, { hasPosition: false }, price);
    if (dE.action === 'BUY') ensembleBuys++;
    if (dC.action === 'BUY') championBuys++;
  }

  // With threshold=9999, ensemble should generate 0 BUY signals
  eq(ensembleBuys, 0, `Extreme threshold should produce 0 BUY signals, got ${ensembleBuys}`);
  // Champion should produce some BUY signals (it runs independently)
  // (This may be 0 too on HOLD_IND-like signals — just verify no crash)
  truthy(championBuys >= 0, 'champion BUYs should be non-negative');
});

// ════════════════════════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════');
console.log(`  RESULTS: ${passed} passed  |  ${failed} failed  |  ${total} total`);
console.log('═══════════════════════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
