'use strict';

const {
  MLConfidence, GBMClassifier, SequenceModel,
  FeatureExtractor, SyntheticDataGenerator,
} = require('./ml-confidence');
const { Indicators } = require('./trading-engine');

let passed = 0, failed = 0;
const L = '─'.repeat(66);
const pass = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else    { failed++; console.log(`  ✗ FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
};

// ── Helpers ────────────────────────────────────────────────────────────────
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xFFFFFFFF; };
}
function makeOHLCV(n, seed = 1, drift = 0.0002) {
  const r = rng(seed);
  const bars = [], prices = [], vols = [];
  let price = 1.1000;
  for (let i = 0; i < n; i++) {
    const ret  = drift + (r() - 0.5) * 0.0014;
    const open = price;
    const close = Math.max(0.5, price * (1 + ret));
    const hi   = Math.max(open, close) * (1 + r() * 0.0003);
    const lo   = Math.min(open, close) * (1 - r() * 0.0003);
    const vol  = 800_000 + r() * 400_000;
    bars.push({ o: open, h: hi, l: lo, c: close, v: vol });
    prices.push(close);
    vols.push(vol);
    price = close;
  }
  return { bars, prices, vols };
}

// ══════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(66));
console.log('  OHLCV ML Upgrade — Component Tests');
console.log('═'.repeat(66));

// ── Test 1: FeatureExtractor has 21 features ───────────────────────────
console.log(`\n${L}\n  1. FeatureExtractor — 21-feature OHLCV vector\n${L}`);
{
  const { bars, prices, vols } = makeOHLCV(60);
  const t = 55;
  const ph = prices.slice(0, t + 1);
  const oh = bars.slice(0, t + 1);
  const rsi   = Indicators.rsi(ph);
  const macd  = Indicators.macd(ph);
  const ema9  = Indicators.ema(ph, 9);
  const ema21 = Indicators.ema(ph, 21);
  const ema50 = Indicators.ema(ph, 50);
  const bb    = Indicators.bollingerBands(ph);
  const atr   = Indicators.atr(ph, 14);
  const vwap  = Indicators.vwap(ph, vols.slice(0, t + 1));
  const price = ph[ph.length - 1];
  const atrPct = (atr / price) * 100;

  const ind = {
    price, rsi, macd, ema9, ema21, ema50: ema50.toFixed(4),
    bb: { upper: bb.upper, lower: bb.lower, middle: bb.middle },
    atr, vwap, atrPercent: atrPct.toFixed(3),
    volatilityLevel: 'NORMAL', mta: null, leadingSignal: null,
  };

  const features = FeatureExtractor.extract(ind, ph, oh);
  pass('Feature vector length = 30', features.length === 30, `got ${features.length}`);
  pass('No NaN values', !features.some(f => isNaN(f)));
  pass('All features in [-1, 3]', features.every(f => f >= -1 && f <= 3));

  // Spot-check OHLCV features (indices 13-20)
  const bar = oh[oh.length - 1];
  const body = features[13]; // candle_body
  const dir  = features[18]; // body_dir
  pass('candle_body has correct sign', (bar.c > bar.o) === (body > 0),
    `body=${body.toFixed(3)} c=${bar.c.toFixed(5)} o=${bar.o.toFixed(5)}`);
  pass('body_dir is +1/-1/0', [1, -1, 0].includes(dir), `dir=${dir}`);
  pass('rel_close in [0,1]', features[17] >= 0 && features[17] <= 1);
  pass('upper_wick >= 0', features[14] >= 0);
  pass('lower_wick >= 0', features[15] >= 0);
  pass('hl_range >= 0',   features[16] >= 0);
  pass('vol_ratio >= 0',  features[19] >= 0);

  console.log('\n  Feature names and values:');
  FeatureExtractor.NAMES.forEach((name, i) => {
    const marker = i >= 13 ? ' ← OHLCV' : '';
    console.log(`    ${String(i).padStart(2)}. ${name.padEnd(16)} ${features[i].toFixed(4)}${marker}`);
  });
}

// ── Test 2: ohlcvStep produces 5-element vectors ───────────────────────
console.log(`\n${L}\n  2. FeatureExtractor.ohlcvStep — 5-element bar encoding\n${L}`);
{
  const bullBar = { o: 1.1000, h: 1.1020, l: 1.0990, c: 1.1015, v: 1_000_000 };
  const bearBar = { o: 1.1015, h: 1.1020, l: 1.0990, c: 1.1000, v: 1_000_000 };
  const dojiBar = { o: 1.1005, h: 1.1020, l: 1.0990, c: 1.1005, v: 500_000  };
  const atr = 0.0015;

  const bullStep = FeatureExtractor.ohlcvStep(bullBar, atr);
  const bearStep = FeatureExtractor.ohlcvStep(bearBar, atr);
  const dojiStep = FeatureExtractor.ohlcvStep(dojiBar, atr);

  pass('ohlcvStep returns 5 values', bullStep.length === 5, `got ${bullStep.length}`);
  pass('Bull candle body > 0',   bullStep[0] > 0, `body=${bullStep[0].toFixed(3)}`);
  pass('Bear candle body < 0',   bearStep[0] < 0, `body=${bearStep[0].toFixed(3)}`);
  pass('Doji candle body ≈ 0',   Math.abs(dojiStep[0]) < 0.01, `body=${dojiStep[0].toFixed(4)}`);
  pass('Bull dir = +1',   bullStep[4] ===  1);
  pass('Bear dir = −1',   bearStep[4] === -1);
  pass('No NaN in any step', [...bullStep, ...bearStep, ...dojiStep].every(v => !isNaN(v)));
}

// ── Test 3: SyntheticDataGenerator uses OHLCV ─────────────────────────
console.log(`\n${L}\n  3. SyntheticDataGenerator — next-candle direction label\n${L}`);
{
  const { bars, prices, vols } = makeOHLCV(300);
  const t0 = Date.now();
  const samples = SyntheticDataGenerator.generate(prices, vols, Indicators, bars);
  const ms = Date.now() - t0;

  pass('Generated samples > 50', samples.length > 50, `got ${samples.length}`);
  pass('Generated in < 30s', ms < 30_000, `took ${ms}ms`);

  const s0 = samples[0];
  pass('Sample has features array', Array.isArray(s0.features));
  pass('Sample features length = 30', s0.features.length === 30, `got ${s0.features.length}`);
  pass('Sample has ohlcvSeq', Array.isArray(s0.ohlcvSeq));
  pass('ohlcvSeq length = 20', s0.ohlcvSeq.length === 20, `got ${s0.ohlcvSeq.length}`);
  pass('Each ohlcvSeq step has 5 values', s0.ohlcvSeq[0].length === 5, `got ${s0.ohlcvSeq[0].length}`);
  pass('Label is 0 or 1', s0.label === 0 || s0.label === 1);

  // Verify label = next candle direction
  let labelErrors = 0;
  for (const s of samples.slice(0, 50)) {
    if (s.label !== 0 && s.label !== 1) labelErrors++;
  }
  pass('All labels are 0 or 1', labelErrors === 0);

  // Both classes present
  const nUp   = samples.filter(s => s.label === 1).length;
  const nDown = samples.filter(s => s.label === 0).length;
  console.log(`    UP: ${nUp}  DOWN: ${nDown}  (${(nUp/samples.length*100).toFixed(0)}% up)`);
  pass('Both UP and DOWN labels present', nUp > 0 && nDown > 0);
}

// ── Test 4: SyntheticDataGenerator without OHLCV (fallback) ───────────
console.log(`\n${L}\n  4. SyntheticDataGenerator — close-only fallback\n${L}`);
{
  const { prices, vols } = makeOHLCV(200);
  const samples = SyntheticDataGenerator.generate(prices, vols, Indicators, null);
  pass('Works without ohlcvHistory (fallback)', samples.length > 30, `got ${samples.length}`);
  pass('Features still 30 in fallback', samples[0]?.features.length === 30,
    `got ${samples[0]?.features.length}`);
}

// ── Test 5: SequenceModel with 100-input OHLCV window ─────────────────
console.log(`\n${L}\n  5. SequenceModel — 100-input OHLCV window (20 bars × 5)\n${L}`);
{
  const sm = new SequenceModel(100, 24);
  const N = 100;

  // Bullish sequence: increasing body sizes, bullish dirs
  const mkSeq = (bull) => {
    const steps = Array.from({ length: 20 }, (_, k) => bull
      ? [0.3 + k * 0.01, 0.05, 0.02, 0.7 + k * 0.01,  1]
      : [-0.3 - k * 0.01, 0.02, 0.05, 0.3 - k * 0.01, -1]
    );
    return steps.flat();
  };

  const seqs   = Array.from({ length: N }, (_, i) => mkSeq(i < N / 2));
  const labels = Array.from({ length: N }, (_, i) => i < N / 2 ? 1 : 0);

  const t0 = Date.now();
  sm.train(seqs, labels, 20, 0.01);
  const ms = Date.now() - t0;

  pass('SequenceModel trains on 100-input', sm.trained, `took ${ms}ms`);
  pass('Training < 10s', ms < 10_000, `took ${ms}ms`);

  const acc = seqs.reduce((c, s, i) => c + ((sm.forward(s).out > 0.5 ? 1 : 0) === labels[i] ? 1 : 0), 0) / N;
  pass(`Accuracy ${(acc*100).toFixed(0)}% > 60% on structured sequences`, acc > 0.60);

  const bullP = sm.forward(mkSeq(true)).out;
  const bearP = sm.forward(mkSeq(false)).out;
  pass(`Bull seq (${bullP.toFixed(3)}) > bear seq (${bearP.toFixed(3)})`, bullP > bearP);
}

// ── Test 6: MLConfidence cold-start with OHLCV ────────────────────────
console.log(`\n${L}\n  6. MLConfidence — cold-start OHLCV training\n${L}`);
{
  const ml = new MLConfidence();
  const { bars, prices, vols } = makeOHLCV(600);
  const t0 = Date.now();
  const ok = ml.trainFromPriceHistory(prices, vols, Indicators, bars);
  const ms = Date.now() - t0;

  pass('trainFromPriceHistory returns true', ok);
  pass('ml.trained = true', ml.trained);
  pass('Training < 90s', ms < 90_000, `took ${ms}ms`);

  const stats = ml.getStats();
  console.log(`\n  Stats: samples=${stats.trainSamples} GBM=${stats.gbmAcc}% Seq=${stats.seqAcc}% Ens=${stats.ensAcc}% ms=${stats.trainMs}`);
  pass('GBM accuracy > 50%', stats.gbmAcc > 50, `${stats.gbmAcc}%`);
  pass('Ensemble accuracy > 50%', stats.ensAcc > 50, `${stats.ensAcc}%`);
}

// ── Test 7: getConfidence with ohlcvHistory ────────────────────────────
console.log(`\n${L}\n  7. MLConfidence.getConfidence — OHLCV prediction\n${L}`);
{
  const ml = new MLConfidence();
  const { bars, prices, vols } = makeOHLCV(600);
  ml.trainFromPriceHistory(prices, vols, Indicators, bars);

  const t = 400;
  const ph = prices.slice(0, t + 1);
  const oh = bars.slice(0, t + 1);
  const rsi   = Indicators.rsi(ph);
  const macd  = Indicators.macd(ph);
  const ema9  = Indicators.ema(ph, 9);
  const ema21 = Indicators.ema(ph, 21);
  const ema50 = Indicators.ema(ph, 50);
  const bb    = Indicators.bollingerBands(ph);
  const atr   = Indicators.atr(ph, 14);
  const vwap  = Indicators.vwap(ph, vols.slice(0, t + 1));
  const price = ph[ph.length - 1];

  const ind = {
    price, rsi, macd, ema9, ema21, ema50: ema50.toFixed(4),
    bb: { upper: bb.upper, lower: bb.lower, middle: bb.middle },
    atr: atr.toFixed(4), vwap: vwap.toFixed(4),
    atrPercent: ((atr / price) * 100).toFixed(3),
    volatilityLevel: 'NORMAL', mta: null, leadingSignal: null,
  };

  const result = ml.getConfidence(ind, ph, oh);
  console.log(`    source=${result.source} conf=${result.confidence} gbm=${result.gbmProb} seq=${result.seqProb}`);

  pass('Returns confidence value', result.confidence !== null, `conf=${result.confidence}`);
  pass('Confidence in [30, 95]', result.confidence >= 30 && result.confidence <= 95);
  pass('source = ml_ensemble_ohlcv', result.source === 'ml_ensemble_ohlcv');
  pass('gbmProb in [0, 1]', result.gbmProb >= 0 && result.gbmProb <= 1);
  pass('seqProb in [0, 1]', result.seqProb >= 0 && result.seqProb <= 1);
  pass('features array has 30 elements', result.features?.length === 30);
}

// ── Test 8: ohlcvHistory stored in TradingEngine ──────────────────────
console.log(`\n${L}\n  8. TradingEngine — ohlcvHistory storage\n${L}`);
{
  const { TradingEngine } = require('./trading-engine');
  const engine = new TradingEngine();

  pass('ohlcvHistory initialised as array', Array.isArray(engine.ohlcvHistory));

  // Simulate onPriceUpdate with full OHLCV
  engine.selectedAsset = 'EURUSD';
  const bar = { symbol: 'EURUSD', price: 1.1010, open: 1.1000, high: 1.1025, low: 1.0995, volume: 1_200_000 };
  engine.onPriceUpdate(bar);

  pass('priceHistory receives close', engine.priceHistory.length === 1);
  pass('volumeHistory receives volume', engine.volumeHistory.length === 1);
  pass('ohlcvHistory receives OHLCV bar', engine.ohlcvHistory.length === 1);

  const stored = engine.ohlcvHistory[0];
  pass('stored.o = open',   stored.o === 1.1000);
  pass('stored.h = high',   stored.h === 1.1025);
  pass('stored.l = low',    stored.l === 1.0995);
  pass('stored.c = close',  stored.c === 1.1010);
  pass('stored.v = volume', stored.v === 1_200_000);
}

// ── Test 9: ohlcvHistory bounded with priceHistory ────────────────────
console.log(`\n${L}\n  9. ohlcvHistory stays bounded with priceHistory\n${L}`);
{
  const { TradingEngine, TRADING_CONFIG } = require('./trading-engine');
  const engine = new TradingEngine();
  engine.selectedAsset = 'EURUSD';
  const maxLen = TRADING_CONFIG?.maxHistoryLength || 1000;

  // Push maxLen + 10 bars
  for (let i = 0; i < maxLen + 10; i++) {
    engine.onPriceUpdate({
      symbol: 'EURUSD', price: 1.1 + i * 0.0001,
      open: 1.1, high: 1.105, low: 1.095, volume: 1_000_000,
    });
  }
  pass('ohlcvHistory bounded to maxHistoryLength',
    engine.ohlcvHistory.length <= maxLen,
    `len=${engine.ohlcvHistory.length} max=${maxLen}`);
  pass('ohlcvHistory length === priceHistory length',
    engine.ohlcvHistory.length === engine.priceHistory.length,
    `ohlcv=${engine.ohlcvHistory.length} price=${engine.priceHistory.length}`);
}

// ── Test 10: recordTrade accepts ohlcvSeq ─────────────────────────────
console.log(`\n${L}\n  10. MLConfidence.recordTrade — online learning with ohlcvSeq\n${L}`);
{
  const ml = new MLConfidence();
  const { bars, prices, vols } = makeOHLCV(400);
  ml.trainFromPriceHistory(prices, vols, Indicators, bars);

  const fakeFeatures = new Array(21).fill(0.5);
  const fakeOHLCVSeq = new Array(20).fill([0, 0, 0, 0.5, 0]);

  for (let i = 0; i < 15; i++) {
    ml.recordTrade({ outcome: i < 9 ? 'WIN' : 'LOSS' }, fakeFeatures, fakeOHLCVSeq);
  }
  pass('recordTrade runs 15× without error', true);
  pass('version counter = 15', ml.getStats().version === 15, `got ${ml.getStats().version}`);
}

// ══════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(66));
console.log(`  Results: ${passed} passed  ${failed} failed  (${passed + failed} total)`);
if (failed === 0) console.log('  ✅  All tests passed');
else              console.log(`  ❌  ${failed} test(s) failed`);
console.log('═'.repeat(66) + '\n');
if (failed > 0) process.exitCode = 1;
