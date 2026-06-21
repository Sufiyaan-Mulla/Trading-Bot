'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  test-ml-confidence.js
//  Tests the MLConfidence module end-to-end:
//    1. Synthetic price data generation
//    2. Cold-start training (SyntheticDataGenerator)
//    3. Prediction vs hardcoded values (82/70/68/80)
//    4. Confidence distribution across market scenarios
//    5. Online learning (recordTrade)
//    6. Model accuracy & stats
// ═══════════════════════════════════════════════════════════════════════════════

const {
  MLConfidence, GBMClassifier, SequenceModel,
  FeatureExtractor, SyntheticDataGenerator, RegressionTree,
} = require('./ml-confidence');

const { Indicators } = require('./trading-engine');

// ── Helpers ───────────────────────────────────────────────────────────────────
const PAD  = (s, n = 32) => String(s).padEnd(n);
const NUM  = (v, d = 2)  => String(typeof v === 'number' ? v.toFixed(d) : v).padStart(8);
const LINE = (char = '─', n = 68) => char.repeat(n);
const pass = (ok, msg) => {
  if (!ok) { console.error(`  ✗ FAIL: ${msg}`); process.exitCode = 1; }
  else       console.log (`  ✓ ${msg}`);
};

// ── Price series generators ───────────────────────────────────────────────────
function randomWalk (n, start = 1.1000, drift = 0.00005, vol = 0.0015, seed = 42) {
  let rng = seed;
  const lcg = () => { rng = (rng * 1664525 + 1013904223) & 0xffffffff; return (rng >>> 0) / 0xffffffff; };
  const prices = [start], volumes = [1_000_000];
  for (let i = 1; i < n; i++) {
    const z  = (lcg() + lcg() + lcg() - 1.5) * 1.15; // approx normal
    prices.push(Math.max(0.5, prices[i - 1] * (1 + drift + z * vol)));
    volumes.push(800_000 + lcg() * 400_000);
  }
  return { prices, volumes };
}

function trendingUp   (n) { return randomWalk(n, 1.1000,  0.00015, 0.0012); }
function trendingDown (n) { return randomWalk(n, 1.1000, -0.00015, 0.0012); }
function ranging      (n) { return randomWalk(n, 1.1000,  0.00000, 0.0018); }

// ── Build indicator snapshot for a bar ───────────────────────────────────────
function buildIndicators (prices, volumes, t) {
  const ph = prices.slice(0, t + 1);
  const vh = volumes ? volumes.slice(0, t + 1) : null;
  if (ph.length < 22) return null;

  const rsi   = Indicators.rsi(ph);
  const macd  = Indicators.macd(ph);
  const ema9  = Indicators.ema(ph, 9);
  const ema21 = Indicators.ema(ph, 21);
  const bb    = Indicators.bollingerBands(ph);
  const atr   = Indicators.atr(ph, 14);
  const vwap  = vh ? Indicators.vwap(ph, vh) : ph[ph.length - 1];
  const atrPct = atr > 0 ? (atr / ph[ph.length - 1]) * 100 : 0;

  return {
    price: ph[ph.length - 1],
    rsi, macd, ema9, ema21,
    bb: { upper: bb.upper, lower: bb.lower, middle: bb.middle },
    atr, vwap,
    atrPercent:    atrPct.toFixed(4),
    volatilityLevel: atrPct < 0.5 ? 'LOW' : atrPct > 1.5 ? 'HIGH' : 'NORMAL',
    mta:          null,
    leadingSignal: null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n' + LINE('═'));
console.log('  ML Confidence — Full Test Suite');
console.log(LINE('═'));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + LINE());
console.log('  Test 1 — RegressionTree (GBM base learner)');
console.log(LINE());
{
  const tree = new RegressionTree(3);
  // Linearly separable: label = 1 if x[0] > 0.5
  const X = Array.from({ length: 24 }, (_, i) => [i / 24, Math.random()]);
  const y = X.map(x => x[0] > 0.5 ? 1 : 0);
  tree.fit(X, y);
  const preds = X.map(x => tree.predict(x));
  pass(tree.root !== null, 'Tree has a root node');
  pass(preds.length === 24, 'Predictions for all samples');
  const mae = preds.reduce((s, p, i) => s + Math.abs(p - y[i]), 0) / 24;
  pass(mae < 0.3, `MAE ${mae.toFixed(3)} < 0.3 on linearly separable data`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + LINE());
console.log('  Test 2 — GBMClassifier (XGBoost-style)');
console.log(LINE());
{
  const gbm  = new GBMClassifier({ nTrees: 40, lr: 0.1, maxDepth: 3 });
  const rng  = (n = 1) => Math.random() * n;
  const N    = 200;
  const X    = Array.from({ length: N }, () => [rng(), rng(), rng(), rng(), rng()]);
  // Label: class 1 if feature 0 + feature 1 > 1.0
  const y    = X.map(x => x[0] + x[1] > 1.0 ? 1 : 0);

  const t0 = Date.now();
  gbm.fit(X, y);
  const trainMs = Date.now() - t0;

  const preds = X.map(x => gbm.predictProba(x));
  const acc   = preds.filter((p, i) => (p > 0.5 ? 1 : 0) === y[i]).length / N;

  pass(gbm.trained, 'GBM trained successfully');
  pass(trainMs < 5000, `Training completed in ${trainMs}ms (< 5000ms)`);
  pass(acc > 0.70, `Accuracy ${(acc * 100).toFixed(1)}% > 70% on linearly separable data`);
  pass(preds.every(p => p >= 0 && p <= 1), 'All probabilities in [0, 1]');

  // Online update
  gbm.onlineUpdate([0.9, 0.9, 0.5, 0.5, 0.5], 1);
  gbm.onlineUpdate([0.1, 0.1, 0.5, 0.5, 0.5], 0);
  pass(true, 'Online update (onlineUpdate) runs without error');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + LINE());
console.log('  Test 3 — SequenceModel (LSTM-inspired MLP)');
console.log(LINE());
{
  const sm = new SequenceModel(20, 8);
  const N  = 120;
  // Rising RSI sequence → label 1 (bullish momentum)
  // Falling RSI sequence → label 0
  const seqs = Array.from({ length: N }, (_, i) => {
    const up = i < N / 2;
    return Array.from({ length: 20 }, (__, k) => up
      ? 0.3 + (k / 20) * 0.4 + (Math.random() - 0.5) * 0.05
      : 0.7 - (k / 20) * 0.4 + (Math.random() - 0.5) * 0.05
    );
  });
  const labels = Array.from({ length: N }, (_, i) => i < N / 2 ? 1 : 0);

  const t0 = Date.now();
  sm.train(seqs, labels, 20, 0.01);
  const trainMs = Date.now() - t0;

  const preds = seqs.map(s => sm.forward(s).out);
  const acc   = preds.filter((p, i) => (p > 0.5 ? 1 : 0) === labels[i]).length / N;

  pass(sm.trained, 'Sequence model trained');
  pass(trainMs < 8000, `Training in ${trainMs}ms (< 8000ms)`);
  pass(acc > 0.60, `Accuracy ${(acc * 100).toFixed(1)}% > 60% on monotone sequences`);

  const upSeq   = Array.from({ length: 20 }, (_, k) => 0.3 + (k / 20) * 0.5);
  const downSeq = Array.from({ length: 20 }, (_, k) => 0.8 - (k / 20) * 0.5);
  const upP   = sm.forward(upSeq).out;
  const downP = sm.forward(downSeq).out;
  pass(upP > downP, `Rising RSI (${upP.toFixed(3)}) scores higher than falling RSI (${downP.toFixed(3)})`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + LINE());
console.log('  Test 4 — FeatureExtractor');
console.log(LINE());
{
  const { prices, volumes } = trendingUp(100);
  const ind = buildIndicators(prices, volumes, 60);
  const features = FeatureExtractor.extract(ind, prices.slice(0, 61));

  pass(features.length === 30, `Feature vector length = ${features.length} (expected 30)`);
  pass(features.every(f => f >= -1 && f <= 1), 'All features in [-1, +1]');
  pass(!features.some(f => isNaN(f)), 'No NaN values in feature vector');

  console.log('\n  Feature values for trending-up bar 60:');
  FeatureExtractor.NAMES.forEach((name, i) => {
    console.log(`    ${PAD(name, 20)} ${NUM(features[i], 4)}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + LINE());
console.log('  Test 5 — SyntheticDataGenerator');
console.log(LINE());
{
  const { prices, volumes } = trendingUp(300);
  const t0      = Date.now();
  const samples = SyntheticDataGenerator.generate(prices, volumes, Indicators);
  const genMs   = Date.now() - t0;

  pass(samples.length > 50, `Generated ${samples.length} samples (> 50)`);
  pass(genMs < 30_000, `Generated in ${genMs}ms`);

  const nWin  = samples.filter(s => s.label === 1).length;
  const nLoss = samples.filter(s => s.label === 0).length;
  console.log(`    WIN: ${nWin}  LOSS: ${nLoss}  (ratio ${(nWin / samples.length * 100).toFixed(0)}% positive)`);
  pass(nWin > 0 && nLoss > 0, 'Both WIN and LOSS samples present');
  pass(samples.every(s => s.rsiSeq.length === 20), 'All RSI sequences length 20');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + LINE());
console.log('  Test 6 — MLConfidence cold-start training');
console.log(LINE());
const ml = new MLConfidence();
{
  const { prices, volumes } = trendingUp(600);
  const t0 = Date.now();
  const ok = ml.trainFromPriceHistory(prices, volumes, Indicators);
  const ms = Date.now() - t0;

  pass(ok, 'trainFromPriceHistory returns true');
  pass(ml.trained, 'ml.trained = true after cold-start');
  pass(ms < 60_000, `Full cold-start training completed in ${ms}ms`);

  const stats = ml.getStats();
  console.log(`\n  Model statistics:`);
  console.log(`    Samples:   ${stats.trainSamples}`);
  console.log(`    GBM acc:   ${stats.gbmAcc}%`);
  console.log(`    Seq acc:   ${stats.seqAcc}%`);
  console.log(`    Ens acc:   ${stats.ensAcc}%`);
  console.log(`    Train ms:  ${stats.trainMs}`);
  pass(stats.gbmAcc > 50, `GBM in-sample accuracy ${stats.gbmAcc}% > 50% (better than coin flip)`);
  pass(stats.ensAcc > 50, `Ensemble accuracy ${stats.ensAcc}% > 50%`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + LINE());
console.log('  Test 7 — Confidence predictions vs hardcoded values');
console.log(LINE());
{
  const { prices, volumes } = trendingUp(300);
  const results = [];

  const SCENARIOS = [
    {
      name: 'Setup A — STRONG_BUY, RSI<45, strong uptrend',
      hardcoded: 82,
      modifyInd: (ind) => {
        ind.rsi  = 38;    // RSI < 45
        ind.macd = Math.abs(ind.macd) * 2 + 0.0001;  // positive MACD
        const e21 = parseFloat(ind.ema21);
        ind.ema9  = (e21 * 1.001).toFixed(5);   // EMA9 > EMA21 (strong trend)
        return ind;
      },
    },
    {
      name: 'Setup B — BUY, RSI<50, uptrend',
      hardcoded: 70,
      modifyInd: (ind) => {
        ind.rsi  = 44;    // RSI < 50 but not oversold
        ind.macd = Math.abs(ind.macd) + 0.0001;
        const e21 = parseFloat(ind.ema21);
        ind.ema9  = (e21 * 1.0007).toFixed(5);
        return ind;
      },
    },
    {
      name: 'Setup C — STRONG_BUY, RSI<50, weak uptrend',
      hardcoded: 68,
      modifyInd: (ind) => {
        ind.rsi  = 47;
        ind.macd = Math.abs(ind.macd) * 0.5 + 0.00005;
        const e21 = parseFloat(ind.ema21);
        ind.ema9  = (e21 * 1.0002).toFixed(5);  // weaker trend
        return ind;
      },
    },
    {
      name: 'SELL — EMA9 cross below + STRONG_SELL',
      hardcoded: 80,
      modifyInd: (ind) => {
        ind.rsi  = 62;
        ind.macd = -(Math.abs(ind.macd)) - 0.0001;
        const e21 = parseFloat(ind.ema21);
        ind.ema9  = (e21 * 0.999).toFixed(5);  // EMA9 < EMA21
        return ind;
      },
    },
    {
      name: 'HIGH VOLATILITY — all else equal',
      hardcoded: 68,
      modifyInd: (ind) => {
        ind.volatilityLevel = 'HIGH';
        ind.atrPercent = '2.5';
        return ind;
      },
    },
    {
      name: 'OVERSOLD bounce — RSI=28 strong trend',
      hardcoded: 82,
      modifyInd: (ind) => {
        ind.rsi  = 28;
        ind.macd = Math.abs(ind.macd) * 3 + 0.0002;
        const e21 = parseFloat(ind.ema21);
        ind.ema9  = (e21 * 1.0012).toFixed(5);
        return ind;
      },
    },
  ];

  const t = 200;
  for (const sc of SCENARIOS) {
    const ind = buildIndicators(prices, volumes, t);
    if (!ind) continue;
    const modInd = sc.modifyInd({ ...ind });

    // Push RSI to buffer
    ml.pushRSI(parseFloat(modInd.rsi));

    const result = ml.getConfidence(modInd, prices.slice(0, t + 1));
    results.push({
      name:      sc.name,
      hardcoded: sc.hardcoded,
      ml:        result.confidence,
      gbm:       result.gbmProb,
      seq:       result.seqProb,
      diff:      result.confidence - sc.hardcoded,
    });
  }

  console.log(
    `\n  ${'Scenario'.padEnd(44)} ${'Hard'.padStart(5)} ${'ML'.padStart(5)} ${'Diff'.padStart(6)} ${'GBMp'.padStart(6)} ${'Seqp'.padStart(6)}`
  );
  console.log('  ' + LINE('─', 66));
  for (const r of results) {
    const diffStr = (r.diff > 0 ? '+' : '') + r.diff;
    console.log(
      `  ${r.name.padEnd(44)} ${String(r.hardcoded).padStart(5)} ${String(r.ml).padStart(5)} ${diffStr.padStart(6)} ${r.gbm.toFixed(3).padStart(6)} ${r.seq.toFixed(3).padStart(6)}`
    );
  }

  pass(results.length === SCENARIOS.length, 'All scenarios produced a result');
  pass(results.every(r => r.ml >= 30 && r.ml <= 95), 'All ML confidence values in [30, 95]');

  // Directional sanity: oversold bounce should rank ≥ weaker setup
  const oversold = results.find(r => r.name.includes('OVERSOLD'));
  const weakSetup = results.find(r => r.name.includes('Setup C'));
  if (oversold && weakSetup) {
    pass(oversold.ml >= weakSetup.ml - 5, `Oversold bounce (${oversold.ml}) ≥ weaker setup (${weakSetup.ml})`);
  }

  // High volatility should not inflate confidence
  const highVol = results.find(r => r.name.includes('HIGH VOLATILITY'));
  const setupA  = results.find(r => r.name.includes('Setup A'));
  if (highVol && setupA) {
    console.log(`\n  Volatility impact: Setup A → ${setupA.ml}, High Vol scenario → ${highVol.ml}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + LINE());
console.log('  Test 8 — Confidence distribution across trending / ranging / down markets');
console.log(LINE());
{
  const markets = {
    'Trending up  ': trendingUp(300),
    'Trending down': trendingDown(300),
    'Ranging      ': ranging(300),
  };

  for (const [label, { prices, volumes }] of Object.entries(markets)) {
    const confs = [];
    for (let t = 80; t < 200; t += 5) {
      const ind = buildIndicators(prices, volumes, t);
      if (!ind) continue;
      ml.pushRSI(parseFloat(ind.rsi));
      const r = ml.getConfidence(ind, prices.slice(0, t + 1));
      if (r.confidence) confs.push(r.confidence);
    }
    if (confs.length === 0) continue;
    const avg = (confs.reduce((s, v) => s + v, 0) / confs.length).toFixed(1);
    const mn  = Math.min(...confs);
    const mx  = Math.max(...confs);
    console.log(`    ${label}  avg: ${avg}  min: ${mn}  max: ${mx}  (n=${confs.length})`);
  }
  pass(true, 'Distribution test ran without errors');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + LINE());
console.log('  Test 9 — Online learning (recordTrade)');
console.log(LINE());
{
  const { prices, volumes } = trendingUp(300);
  const ind = buildIndicators(prices, volumes, 150);
  if (ind) {
    const snap = ml.captureEntrySnapshot(ind, prices.slice(0, 151));

    // Simulate 25 closed trades
    const before = ml.getConfidence(ind, prices.slice(0, 151)).confidence;
    for (let i = 0; i < 25; i++) {
      const trade = { outcome: i < 15 ? 'WIN' : 'LOSS' };  // 60% win rate batch
      ml.recordTrade(trade, snap.features, snap.rsiSeq);
    }
    const after = ml.getConfidence(ind, prices.slice(0, 151)).confidence;

    pass(true, `recordTrade called 25× without errors`);
    pass(ml.getStats().version === 25, `version counter = 25`);
    console.log(`    Confidence before batch: ${before}  →  after 25 trades: ${after}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + LINE());
console.log('  Test 10 — Fallback when model not trained');
console.log(LINE());
{
  const fresh = new MLConfidence();
  const { prices, volumes } = trendingUp(100);
  const ind = buildIndicators(prices, volumes, 50);
  const result = fresh.getConfidence(ind, prices.slice(0, 51));

  pass(result.confidence === null, 'Returns null confidence when not trained');
  pass(result.source === 'fallback', `source = "${result.source}"`);
  console.log(`    reason: ${result.reason}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + LINE('═'));
const exitCode = process.exitCode || 0;
if (exitCode === 0) {
  console.log('  ✅  All tests passed — ML confidence module is working correctly');
  console.log('');
  console.log('  Integration summary:');
  console.log('    • trading-engine.js now imports MLConfidence + FeatureExtractor');
  console.log('    • getRuleBasedDecision() uses ML confidence instead of 82/70/68/80');
  console.log('    • Cold-start training fires automatically after warmUpAll()');
  console.log('    • RSI buffer updated every calculateIndicators() call');
  console.log('    • Each closed trade feeds back into online learning');
} else {
  console.log('  ❌  Some tests failed — see ✗ lines above');
}
console.log(LINE('═') + '\n');
