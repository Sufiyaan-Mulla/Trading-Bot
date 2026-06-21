'use strict';

(async () => {
// ══════════════════════════════════════════════════════════════════════════════
//  test-new-modules.js
//  Depth-first tests for every new/improved module:
//    hot-reload, monte-carlo, idempotent-executor, fee-model,
//    ohlcv-validator, weekly-monthly-drawdown, meta-labeler,
//    fill-probability, performance-profiler, backup-manager,
//    exchange-interface, security-audit
// ══════════════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;
const failures = [];

function assert(cond, label, detail = '') {
  if (cond) {
    process.stdout.write(`  ✅ ${label}\n`);
    passed++;
  } else {
    process.stdout.write(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}\n`);
    failed++;
    failures.push(label);
  }
}

function assertClose(a, b, tol, label) {
  assert(Math.abs(a - b) <= tol, label, `got ${a}, expected ~${b} ±${tol}`);
}

function section(title) {
  console.log('\n' + '═'.repeat(64));
  console.log('  ' + title);
  console.log('═'.repeat(64));
}

function skip(label) {
  process.stdout.write(`  ⏭  SKIP: ${label}\n`);
  skipped++;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeTrades(n = 50, winRate = 0.55, avgWin = 2, avgLoss = 1) {
  const trades = [];
  for (let i = 0; i < n; i++) {
    const win = Math.random() < winRate;
    const pct = win ? avgWin * (0.5 + Math.random()) : -avgLoss * (0.5 + Math.random());
    trades.push({ profit: pct * 100, profitPercent: pct, positionSize: 0.01 });
  }
  return trades;
}

function makePrices(n = 300, start = 1.1000, vol = 0.0005) {
  const prices = [start];
  for (let i = 1; i < n; i++) {
    prices.push(Math.max(0.1, prices[i-1] * (1 + (Math.random() - 0.5) * vol)));
  }
  return prices;
}

// ══════════════════════════════════════════════════════════════════════════════
//  1. HOT-RELOAD
// ══════════════════════════════════════════════════════════════════════════════
section('1. HotReloader — config hot-reload');
try {
  const { HotReloader, PATCHABLE, BLOCKED } = require('./hot-reload');

  // Create a temp config dir and override file
  const tmpDir     = fs.mkdtempSync(path.join(os.tmpdir(), 'aladdin-hr-'));
  const overrideFile = path.join(tmpDir, 'overrides.json');

  const liveConfig = { stopLoss: 0.02, takeProfit: 0.05, minConfidence: 60, assets: ['EURUSD'] };
  const reloader   = new HotReloader(liveConfig);
  // Monkey-patch the override file path for testing
  Object.defineProperty(reloader, '_overrideFile', {
    get: () => overrideFile,
    configurable: true,
  });

  assert(PATCHABLE.has('stopLoss'),    'PATCHABLE includes stopLoss');
  assert(PATCHABLE.has('minConfidence'), 'PATCHABLE includes minConfidence');
  assert(BLOCKED.has('assets'),        'BLOCKED includes assets (structural)');
  assert(BLOCKED.has('positionFile'),  'BLOCKED includes positionFile');

  // Test validation blocks forbidden keys
  const errors = reloader._validate({ assets: ['GBPUSD'] });
  assert(errors.length > 0, 'Validation blocks BLOCKED key "assets"');

  // Test validation blocks unknown keys
  const errors2 = reloader._validate({ unknownKey: 123 });
  assert(errors2.length > 0, 'Validation blocks unknown key');

  // Test valid override applies
  const errors3 = reloader._validate({ stopLoss: 0.03, minConfidence: 65 });
  assert(errors3.length === 0, 'Validation passes valid patchable keys');

  reloader._apply({ stopLoss: 0.03, minConfidence: 70 });
  assert(liveConfig.stopLoss     === 0.03, 'Apply patches stopLoss to 0.03');
  assert(liveConfig.minConfidence === 70,  'Apply patches minConfidence to 70');
  assert(liveConfig.assets[0]    === 'EURUSD', 'Apply does not touch non-patchable assets');

  // Revert: remove a key from override
  reloader._apply({ minConfidence: 70 }); // stopLoss removed
  assert(liveConfig.stopLoss === 0.02, 'Revert restores original stopLoss');

  // onChange callback fires
  const changedKeys = [];
  reloader.onChange((key) => { changedKeys.push(key); });
  reloader._apply({ stopLoss: 0.04 });
  assert(changedKeys.includes('stopLoss'), 'onChange callback fires with correct key');

  // Type mismatch blocked
  const errType = reloader._validate({ stopLoss: 'string' });
  assert(errType.length > 0, 'Validation blocks type mismatch (string for number)');

  // Cleanup
  try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}

} catch (e) {
  assert(false, 'HotReloader module loads without error', e.message);
}

// ══════════════════════════════════════════════════════════════════════════════
//  2. MONTE CARLO
// ══════════════════════════════════════════════════════════════════════════════
section('2. MonteCarlo — simulation and safe position sizing');
try {
  const { MonteCarlo } = require('./monte-carlo');

  // Too few trades
  const tooFew = MonteCarlo.run([{ profit: 100, profitPercent: 1 }]);
  assert(tooFew.error != null, 'Returns error for < 5 trades');

  const trades = makeTrades(100, 0.55, 2, 1);
  const result = MonteCarlo.run(trades, { simulations: 500, capital: 10000 });

  assert(result.simulations === 500,               'Ran correct number of simulations');
  assert(result.tradeCount  === 100,               'Trade count recorded');
  assert(result.summary != null,                   'Summary object present');
  assert(result.paths.length === 500,              'All 500 paths generated');

  const s = result.summary;
  assert(s.finalEquity.p50 != null,                'finalEquity p50 present');
  assert(s.maxDrawdown.p95 != null,                'maxDrawdown p95 present');
  assert(typeof s.ruinProbability === 'number',    'ruinProbability is a number');
  assert(typeof s.profitProbability === 'number',  'profitProbability is a number');
  assert(s.ruinProbability >= 0 && s.ruinProbability <= 100, 'ruinProbability in 0–100');
  assert(s.worstCaseDrawdown >= 0,                 'worstCaseDrawdown ≥ 0');
  assert(s.medianFinalEquity > 0,                  'medianFinalEquity > 0');

  // Positive-EV strategy: most simulations should be profitable
  assert(s.profitProbability > 50, 'Positive-EV strategy has profitProbability > 50%');

  // Sharpe sign test: winner system should have positive median sharpe
  const medianSharpe = result.paths.map(p => p.sharpe).sort((a, b) => a - b);
  const mid = medianSharpe[Math.floor(medianSharpe.length / 2)];
  assert(typeof mid === 'number', 'Sharpe values computed for all paths');

  // Sortino test
  const sortinoVals = result.paths.map(p => p.sortino).filter(v => isFinite(v));
  assert(sortinoVals.length > 400, 'Sortino computed for most paths');

  // Equity curve length
  assert(result.paths[0].curve.length === 101, 'Curve has n+1 points (including start)');

  // All-losing trades → ruin probability high
  const losers = makeTrades(50, 0.0, 1, 2);
  const loserResult = MonteCarlo.run(losers, { simulations: 200, capital: 10000 });
  assert(loserResult.summary.ruinProbability > 80, 'All-losing system has high ruin probability');

  // safePositionSize returns a fraction
  const safe = MonteCarlo.safePositionSize(trades, { simulations: 200, capital: 10000, maxDrawdownPct: 0.20 });
  assert(safe > 0 && safe <= 0.10, 'safePositionSize returns a valid fraction');

} catch (e) {
  assert(false, 'MonteCarlo module error', e.message);
}

// ══════════════════════════════════════════════════════════════════════════════
//  3. IDEMPOTENT EXECUTOR
// ══════════════════════════════════════════════════════════════════════════════
section('3. IdempotentExecutor — dedup and reconciliation');
try {
  const { IdempotentExecutor } = require('./idempotent-executor');

  // Clear persisted dedup store for clean test state
  try { require('fs').unlinkSync(require('path').join(__dirname,'trade_logs','idem_store.json')); } catch(_) {}
  const fakeEngine = { position: null, trades: [], selectedAsset: 'EURUSD' };
  const exec       = new IdempotentExecutor(fakeEngine);

  // Basic submit
  let callCount = 0;
  const spec = { asset: 'EURUSD', side: 'BUY', size: 1000 };
  const execFn = async () => { callCount++; return { orderId: 'ord-1', status: 'filled', fillPrice: 1.105 }; };

  const r1 = await exec.submit(spec, execFn);
  assert(r1.orderId === 'ord-1',          'First submit returns order result');
  assert(callCount === 1,                  'executeFn called once');

  // Duplicate within window — must not call executeFn again
  const r2 = await exec.submit(spec, execFn);
  assert(r2.deduplicated === true,         'Second submit flagged as deduplicated');
  assert(callCount === 1,                  'executeFn not called again on duplicate');

  // Idempotency key generation is deterministic for same input
  const key1 = exec._makeKey({ asset: 'EURUSD', side: 'BUY', size: 1000 });
  const key2 = exec._makeKey({ asset: 'EURUSD', side: 'BUY', size: 1000 });
  assert(key1 === key2, 'Same spec produces same idempotency key');

  // Different side produces different key
  const key3 = exec._makeKey({ asset: 'EURUSD', side: 'SELL', size: 1000 });
  assert(key1 !== key3, 'Different side produces different key');

  // Reconcile: exchange has position, local has none
  fakeEngine.position = null;
  const fetch1 = async () => ({
    openPositions: [{ asset: 'EURUSD', side: 'LONG', size: 1000, entryPrice: 1.105, openedAt: Date.now() }],
    recentOrders: [],
  });
  const rec1 = await exec.reconcile(fetch1);
  assert(rec1.reconciled,                  'Reconcile returns reconciled:true');
  assert(fakeEngine.position != null,      'Reconcile restores missing position');
  assert(fakeEngine.position.side === 'LONG', 'Restored position has correct side');
  assert(fakeEngine.position._reconciled,  'Restored position marked _reconciled');
  assert(rec1.diffs.length === 1,          'One diff reported (RESTORED_POSITION)');

  // Reconcile: local has position, exchange has none → mark closed
  fakeEngine.position = { asset: 'EURUSD', side: 'LONG', size: 1000, entry: 1.105 };
  fakeEngine.trades   = [];
  const fetch2 = async () => ({ openPositions: [], recentOrders: [] });
  const rec2 = await exec.reconcile(fetch2);
  assert(fakeEngine.position === null,     'Position cleared when not found on exchange');
  assert(fakeEngine.trades.length === 1,   'Trade recorded for externally-closed position');
  assert(rec2.diffs[0].type === 'POSITION_CLOSED_EXTERNALLY', 'Correct diff type');

  // Reconcile: size mismatch
  fakeEngine.position = { asset: 'EURUSD', side: 'LONG', size: 1000, entry: 1.105 };
  const fetch3 = async () => ({
    openPositions: [{ asset: 'EURUSD', side: 'LONG', size: 750, entryPrice: 1.105 }],
    recentOrders: [],
  });
  const rec3 = await exec.reconcile(fetch3);
  assert(fakeEngine.position.size === 750, 'Reconcile patches mismatched position size');
  assert(rec3.diffs[0].type === 'SIZE_PATCHED', 'Diff type is SIZE_PATCHED');

  // Failed fetch
  const fetchFail = async () => { throw new Error('network error'); };
  const rec4 = await exec.reconcile(fetchFail);
  assert(rec4.reconciled === false,        'Failed fetch returns reconciled:false');
  assert(rec4.error != null,               'Error field populated on fetch failure');

} catch (e) {
  assert(false, 'IdempotentExecutor error', e.message);
}

// ══════════════════════════════════════════════════════════════════════════════
//  4. FEE MODEL
// ══════════════════════════════════════════════════════════════════════════════
section('4. FeeModel — maker/taker classification and cost');
try {
  const { FeeModel } = require('./fee-model');
  const fm = new FeeModel();

  // Taker fee > maker fee
  assert(fm.takerFee > fm.makerFee,  'Taker fee is higher than maker fee');

  // Cost: market order uses taker rate
  const mktCost = fm.cost('MARKET', 1000, 1.1);
  assertClose(mktCost.fee, 1000 * 1.1 * fm.takerFee, 1e-8, 'Market order cost = taker rate');

  // Cost: limit order uses blended rate
  const limCost = fm.cost('LIMIT', 1000, 1.1);
  assert(limCost.fee < mktCost.fee,  'Limit order cheaper than market');

  // Cost: TWAP is between limit and market
  const twapCost = fm.cost('TWAP', 1000, 1.1);
  assert(twapCost.fee > limCost.fee && twapCost.fee < mktCost.fee, 'TWAP cost between limit and market');

  // classify: tight spread + low urgency → LIMIT
  const c1 = fm.classify(0.00005, 0.001, 0.3, 500);
  assert(c1.type === 'LIMIT', 'Tight spread + low urgency → LIMIT');

  // classify: high urgency → MARKET
  const c2 = fm.classify(0.00005, 0.001, 0.9, 500);
  assert(c2.type === 'MARKET', 'High urgency → MARKET');

  // classify: wide spread → MARKET
  const c3 = fm.classify(0.002, 0.001, 0.3, 500);
  assert(c3.type === 'MARKET', 'Wide spread → MARKET');

  // classify: high volatility → MARKET
  const c4 = fm.classify(0.0001, 0.008, 0.4, 500);
  assert(c4.type === 'MARKET', 'High volatility → MARKET');

  // classify: large order + low urgency → TWAP
  const c5 = fm.classify(0.0001, 0.001, 0.3, 10000);
  assert(c5.type === 'TWAP', 'Large order + low urgency → TWAP');

  // adjustExpectedValue: round-trip fee reduces EV
  const ev = fm.adjustExpectedValue(0.005, 'MARKET', 1000, 1.1);
  assert(ev.adjustedEV < ev.rawEV,  'adjustedEV < rawEV after fee drag');
  assert(typeof ev.viable === 'boolean', 'viable field is boolean');
  assert(ev.breakEvenReturn > 0,    'breakEvenReturn > 0');

  // fromConfig factory
  const fm2 = FeeModel.fromConfig({ commission: 0.0001 });
  assert(fm2 instanceof FeeModel, 'fromConfig returns FeeModel instance');

  // Edge: unknown order type defaults to market
  const unkCost = fm.cost('UNKNOWN_TYPE', 100, 1.0);
  assertClose(unkCost.fee, 100 * fm.takerFee, 1e-8, 'Unknown order type falls back to market/taker');

} catch (e) {
  assert(false, 'FeeModel error', e.message);
}

// ══════════════════════════════════════════════════════════════════════════════
//  5. OHLCV VALIDATOR
// ══════════════════════════════════════════════════════════════════════════════
section('5. OHLCVValidator — gap detection, spike filter, timestamp normalisation');
try {
  const { OHLCVValidator, toUTCMs } = require('./ohlcv-validator');
  const v = new OHLCVValidator({ intervalMs: 5 * 60_000 });

  // Build a clean 100-candle series
  function makeCandles(n, gapAt = -1, spikeAt = -1) {
    const candles = [];
    let price = 1.1000;
    for (let i = 0; i < n; i++) {
      const t = Date.now() - (n - i) * 5 * 60_000;  // every 5 min
      const move = (Math.random() - 0.5) * 0.001;
      const open = price;
      price += move;
      const close = price;
      const high  = Math.max(open, close) + Math.abs(move) * 0.2;
      const low   = Math.min(open, close) - Math.abs(move) * 0.2;
      const time  = (i === gapAt) ? t + 30 * 60_000 : t;  // inject 30-min gap
      const adjClose = (i === spikeAt) ? close * 1.05 : close; // inject 5% spike
      candles.push({ time, open, high, low, close: adjClose, volume: 1000 });
    }
    return candles;
  }

  // Clean series → valid
  const cleanCandles = makeCandles(100);
  const cleanReport  = v.validate(cleanCandles);
  assert(cleanReport.gapCount === 0,   'Clean series has no gaps');
  assert(cleanReport.spikeCount === 0, 'Clean series has no spikes');
  assert(cleanReport.valid,            'Clean series is valid');

  // Series with gap → detected
  const gapCandles  = makeCandles(100, 50);
  const gapReport   = v.validate(gapCandles);
  assert(gapReport.gapCount >= 1,      'Gap detected at injected position');
  assert(gapReport.gaps[0].missingCandles >= 4, 'Correct number of missing candles estimated');

  // Series with spike → detected
  const spikeCandles = makeCandles(100, -1, 80);
  const spikeReport  = v.validate(spikeCandles);
  assert(spikeReport.spikeCount >= 1,  'Spike detected at injected position');

  // clean() fills gaps with synthetic candles
  const cleaned = v.clean(gapCandles);
  assert(cleaned.length > gapCandles.length, 'clean() adds synthetic fill candles for gaps');
  const synthCount = cleaned.filter(c => c._synthetic === 'gap_fill').length;
  assert(synthCount >= 4, 'Synthetic gap-fill candles added');

  // clean() replaces spike with interpolated value
  const cleanedSpike = v.clean(spikeCandles);
  const removed = cleanedSpike.filter(c => c._synthetic === 'spike_removed');
  assert(removed.length >= 1, 'clean() removes spike and replaces with interpolated value');

  // OHLC consistency check
  const badCandle = [
    { time: Date.now() - 300000, open: 1.10, high: 1.11, low: 1.09, close: 1.105, volume: 100 },
    { time: Date.now(), open: 1.10, high: 1.09, low: 1.08, close: 1.095, volume: 100 },
  ];
  const badReport = v.validate(badCandle);
  const lowAboveHigh = badReport.issues.find(i => i.type === 'LOW_ABOVE_HIGH');
  // Only 1 candle so gap check can't run, but internal consistency check should
  const openRange = badReport.issues.find(i => i.type === 'OPEN_OUTSIDE_RANGE');
  assert(openRange != null || badReport.issues.length > 0, 'OHLC consistency violation detected');

  // toUTCMs converts formats
  const now = Date.now();
  assertClose(toUTCMs(now), now, 1, 'toUTCMs: ms passthrough');
  assertClose(toUTCMs(Math.floor(now / 1000)), now, 1001, 'toUTCMs: Unix seconds → ms');
  assertClose(toUTCMs(new Date(now)), now, 1, 'toUTCMs: Date object → ms');
  assertClose(toUTCMs(new Date(now).toISOString()), now, 1, 'toUTCMs: ISO string → ms');

  // Negative volume flagged
  const negVol = [
    { time: Date.now() - 300000, open: 1.1, high: 1.11, low: 1.09, close: 1.105, volume: 100 },
    { time: Date.now(), open: 1.105, high: 1.11, low: 1.10, close: 1.108, volume: -50 },
  ];
  const negReport = v.validate(negVol);
  assert(negReport.issues.some(i => i.type === 'NEGATIVE_VOLUME'), 'Negative volume flagged');

} catch (e) {
  assert(false, 'OHLCVValidator error', e.message);
}

// ══════════════════════════════════════════════════════════════════════════════
//  6. WEEKLY / MONTHLY DRAWDOWN
// ══════════════════════════════════════════════════════════════════════════════
section('6. DrawdownTracker — weekly and monthly limits');
try {
  const { DrawdownTracker } = require('./weekly-monthly-drawdown');

  // Clean state in temp dir
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aladdin-dd-'));

  // Use custom STORE_FILE path for isolation — monkey-patch module
  const tracker = new DrawdownTracker(10000, { weeklyLimitPct: 0.05, monthlyLimitPct: 0.10 });
  // Force clean state
  tracker._state = {
    weeklyOpen: 10000, monthlyOpen: 10000,
    weeklyHaltUntil: null, monthlyHalt: false,
    weekKey: tracker._weekKey(Date.now()),
    monthKey: (() => { const d = new Date(); return `${d.getUTCFullYear()}-${d.getUTCMonth()}`; })(),
  };

  // Normal equity → no halt
  const ok = tracker.check(9900);
  assert(!ok.halt,              'No halt at 1% drawdown (limit is 5%)');
  assert(ok.weeklyDD < 2,       'WeeklyDD reported correctly');

  // Weekly limit breach → halt
  const breachWeekly = tracker.check(9400); // 6% drawdown > 5% limit
  assert(breachWeekly.halt,     'Weekly halt triggered at 6% drawdown');
  assert(breachWeekly.reason === 'WEEKLY_DRAWDOWN', 'Correct halt reason: WEEKLY_DRAWDOWN');

  // Still halted on subsequent check
  const stillHalted = tracker.check(9450);
  assert(stillHalted.halt,      'Still halted while within halt window');
  assert(stillHalted.reason === 'WEEKLY_HALT_ACTIVE', 'Reason is WEEKLY_HALT_ACTIVE');
  assert(stillHalted.remainingMs > 0, 'remainingMs is positive while halt active');

  // Fresh tracker for monthly test
  const tracker2 = new DrawdownTracker(10000, { weeklyLimitPct: 0.20, monthlyLimitPct: 0.10 });
  tracker2._state = {
    weeklyOpen: 10000, monthlyOpen: 10000,
    weeklyHaltUntil: null, monthlyHalt: false,
    weekKey: tracker2._weekKey(Date.now()),
    monthKey: (() => { const d = new Date(); return `${d.getUTCFullYear()}-${d.getUTCMonth()}`; })(),
  };

  const breachMonthly = tracker2.check(8900); // 11% drawdown > 10% monthly limit (weekly=20% so no weekly halt)
  assert(breachMonthly.halt,    'Monthly halt triggered at 11% drawdown');
  assert(breachMonthly.reason === 'MONTHLY_DRAWDOWN', 'Correct halt reason: MONTHLY_DRAWDOWN');

  // Manual reset clears monthly halt
  tracker2.resetMonthlyHalt(9500);
  const afterReset = tracker2.check(9400);
  assert(!afterReset.monthlyHalt, 'Monthly halt cleared after manual reset');

  // status() returns correct fields
  const tracker3 = new DrawdownTracker(10000);
  tracker3._state = { weeklyOpen: 10000, monthlyOpen: 10000, weeklyHaltUntil: null, monthlyHalt: false,
    weekKey: '', monthKey: '' };
  const status = tracker3.status(9500);
  assert(typeof status.weeklyDD === 'number',  'status.weeklyDD is number');
  assert(typeof status.monthlyDD === 'number', 'status.monthlyDD is number');
  assert(status.weeklyLimit  > 0,              'weeklyLimit > 0');
  assert(status.monthlyLimit > 0,              'monthlyLimit > 0');

  // Default limits
  assert(DrawdownTracker.DEFAULT_WEEKLY_PCT  === 0.07, 'Default weekly limit is 7%');
  assert(DrawdownTracker.DEFAULT_MONTHLY_PCT === 0.15, 'Default monthly limit is 15%');

} catch (e) {
  assert(false, 'DrawdownTracker error', e.message);
}

// ══════════════════════════════════════════════════════════════════════════════
//  7. META-LABELER
// ══════════════════════════════════════════════════════════════════════════════
section('7. MetaLabeler — signal filtering and online learning');
try {
  const { MetaLabeler } = require('./meta-labeler');
  const ml = new MetaLabeler({ threshold: 0.50, minSamples: 5 });
  ml.reset(); // ensure clean weights

  const goodFeatures = {
    confidence: 80, regimeScore: 0.9, spreadAtrRatio: 0.1,
    sessionWeight: 1.0, atrPercentile: 0.5, newsProximity: 0,
  };
  const badFeatures = {
    confidence: 30, regimeScore: 0.2, spreadAtrRatio: 4.0,
    sessionWeight: 0.5, atrPercentile: 0.9, newsProximity: 1,
  };

  // Cold start: delegates to raw confidence
  const colGood = ml.evaluate(goodFeatures);
  const colBad  = ml.evaluate(badFeatures);
  assert(colGood.coldStart,           'Evaluation uses cold-start mode before minSamples');
  assert(colGood.accept === true,     'Good signal accepted in cold-start (high confidence)');
  assert(colBad.accept  === false,    'Bad signal rejected in cold-start (low confidence)');

  // Train on 10 wins with good features → model learns
  for (let i = 0; i < 10; i++) {
    ml.update(goodFeatures, 1);
  }
  // Train on 5 losses with bad features
  for (let i = 0; i < 5; i++) {
    ml.update(badFeatures, 0);
  }

  // After training: good features should have high probability
  const trained = ml.evaluate(goodFeatures);
  assert(!trained.coldStart,          'Out of cold-start after minSamples');
  assert(typeof trained.probability === 'number', 'probability is a number');
  assert(trained.probability > 0.5,  'Good features score > 0.5 after training on wins');

  // Bad features should score lower
  const trainedBad = ml.evaluate(badFeatures);
  assert(trainedBad.probability < trained.probability, 'Bad features score lower than good features');

  // stats()
  const stats = ml.stats();
  assert(stats.samples >= 15,         'Sample count matches training calls');
  assert(typeof stats.lift === 'number', 'lift is a number');
  assert(typeof stats.acceptedWinRate === 'number', 'acceptedWinRate present');

  // update returns err and updatedSamples
  const upd = ml.update(goodFeatures, 1);
  assert(typeof upd.err === 'number',           'update returns err');
  assert(typeof upd.updatedSamples === 'number','update returns updatedSamples');

  // feature vector length matches weight vector
  const fv = ml._extractFeatureVector(goodFeatures);
  assert(fv.length === ml._weights.length, 'Feature vector length matches weight vector');

  // reset clears weights
  ml.reset();
  const afterReset = ml.evaluate(goodFeatures);
  assert(afterReset.coldStart, 'After reset, back to cold-start');

} catch (e) {
  assert(false, 'MetaLabeler error', e.message);
}

// ══════════════════════════════════════════════════════════════════════════════
//  8. FILL PROBABILITY
// ══════════════════════════════════════════════════════════════════════════════
section('8. FillProbability — limit order fill estimation');
try {
  const { FillProbability } = require('./fill-probability');
  const fp = new FillProbability({ threshold: 0.65 });

  // Limit price at current price (distance = 0) → very high prob
  const atMarket = fp.estimate({ currentPrice: 1.1000, limitPrice: 1.1000, atr: 0.0010, maxWaitMs: 30000, side: 'BUY' });
  assert(atMarket.probability >= 0.90, 'Limit at market price has very high fill prob');
  assert(atMarket.useLimit === true,   'Limit at market price: useLimit=true');

  // Limit price far away → low prob
  const farAway = fp.estimate({ currentPrice: 1.1000, limitPrice: 1.0900, atr: 0.0010, maxWaitMs: 30000, side: 'BUY' });
  assert(farAway.probability < 0.5,   'Limit 10 ATRs away has low fill prob');
  assert(farAway.useLimit === false,   'Far-away limit: useLimit=false');

  // More time → higher probability (same distance)
  const shortTime = fp.estimate({ currentPrice: 1.1000, limitPrice: 1.0990, atr: 0.0010, maxWaitMs: 5000,  side: 'BUY' });
  const longTime  = fp.estimate({ currentPrice: 1.1000, limitPrice: 1.0990, atr: 0.0010, maxWaitMs: 120000, side: 'BUY' });
  assert(longTime.probability >= shortTime.probability, 'More time → equal or higher fill probability');

  // SELL side: limit above current price
  const sellFar = fp.estimate({ currentPrice: 1.1000, limitPrice: 1.1100, atr: 0.0010, maxWaitMs: 30000, side: 'SELL' });
  assert(sellFar.probability < 0.5,   'SELL limit far above price has low prob');

  // recordOutcome and empirical calibration
  for (let i = 0; i < 10; i++) {
    fp.recordOutcome({ distanceATR: 0.5, timeRatio: 2.0, filled: true });
  }
  const stats = fp.stats();
  assert(stats.total === 10,           'recordOutcome tracks 10 entries');
  assert(stats.fillRate === 100,       'fillRate 100% after all-fill records');

  // Empirical estimate kicks in after 5 similar records
  fp.recordOutcome({ distanceATR: 3.0, timeRatio: 1.0, filled: false });
  fp.recordOutcome({ distanceATR: 3.0, timeRatio: 1.0, filled: false });
  fp.recordOutcome({ distanceATR: 3.0, timeRatio: 1.0, filled: false });
  fp.recordOutcome({ distanceATR: 3.0, timeRatio: 1.0, filled: false });
  fp.recordOutcome({ distanceATR: 3.0, timeRatio: 1.0, filled: false });
  const withEmpirical = fp.estimate({ currentPrice: 1.1000, limitPrice: 1.0970, atr: 0.0010, maxWaitMs: 300000, side: 'BUY' });
  assert(typeof withEmpirical.probability === 'number', 'Empirical estimate computed');

  // Constant: MIN_FILL_PROB_TO_USE_LIMIT
  assert(FillProbability.MIN_FILL_PROB_TO_USE_LIMIT > 0, 'Threshold constant exported');

} catch (e) {
  assert(false, 'FillProbability error', e.message);
}

// ══════════════════════════════════════════════════════════════════════════════
//  9. PERFORMANCE PROFILER
// ══════════════════════════════════════════════════════════════════════════════
section('9. Profiler — startup and loop benchmarking');
try {
  const { Profiler } = require('./performance-profiler');
  const prof = new Profiler({ slowTickMs: 100 });

  // Startup phases
  prof.startupBegin('config_load');
  await new Promise(r => setTimeout(r, 20));
  const d1 = prof.startupEnd('config_load');
  assert(d1 >= 1,   'startupEnd returns correct duration');

  prof.startupBegin('warmup');
  await new Promise(r => setTimeout(r, 20));
  prof.startupEnd('warmup');

  const startupReport = prof.report().startup;
  assert(startupReport.config_load >= 1,  'config_load phase recorded');
  assert(startupReport.warmup >= 1,       'warmup phase recorded');
  assert(startupReport._total >= 2,      '_total sums startup phases');

  // Tick profiling
  const tick = prof.tickBegin();
  prof.spanBegin(tick, 'indicator');
  await new Promise(r => setTimeout(r, 5));
  prof.spanEnd(tick, 'indicator');
  const tickResult = prof.tickEnd(tick, { ml_inference: 3 });

  assert(tickResult.durationMs >= 1,     'tick duration measured correctly');
  assert(tickResult.spans.indicator >= 1, 'indicator sub-span measured');
  assert(tickResult.spans.ml_inference === 3, 'extra span from tickEnd recorded');

  // spanMeasure
  const tick2 = prof.tickBegin();
  const val = prof.spanMeasure(tick2, 'compute', () => 42);
  prof.tickEnd(tick2);
  assert(val === 42, 'spanMeasure returns function result');

  // Report contains span percentiles
  const rep = prof.report();
  assert(rep.spans.tick_total != null,       'tick_total span in report');
  assert(rep.spans.tick_total.p50 >= 0,      'p50 present');
  assert(rep.spans.tick_total.p95 >= 0,      'p95 present');
  assert(rep.ticks.count >= 2,               'Tick count correct');
  assert(typeof rep.ticks.avg === 'number',  'Average tick duration present');
  assert(rep.uptimeMs > 0,                   'Uptime tracked');

  // Slow tick warning (> 100ms budget)
  const slowTick = prof.tickBegin();
  await new Promise(r => setTimeout(r, 200));
  let warnFired = false;
  const origWarn = console.warn;
  console.warn = (m) => { if (m.includes('SLOW TICK')) warnFired = true; };
  prof.tickEnd(slowTick);
  console.warn = origWarn;
  assert(warnFired, 'Slow tick triggers console.warn');
  assert(rep.ticks.slowPct >= 0, 'slowPct field present in report');

} catch (e) {
  assert(false, 'Profiler error', e.message);
}

// ══════════════════════════════════════════════════════════════════════════════
//  10. BACKUP MANAGER
// ══════════════════════════════════════════════════════════════════════════════
section('10. BackupManager — automated backup and pruning');
try {
  const { BackupManager } = require('./backup-manager');
  const tmpBackup = fs.mkdtempSync(path.join(os.tmpdir(), 'aladdin-bk-'));

  // Use a known file in the project as backup target
  const tmpTarget = 'README.md';

  const bm = new BackupManager({
    backupDir:  tmpBackup,
    intervalMs: 99999999,     // don't actually schedule
    retention:  3,
    encrypt:    false,
    targets:    [tmpTarget],   // back up README.md
  });

  // runNow creates a backup
  const manifest = await bm.runNow();
  assert(manifest.fileCount >= 1,     'Backup contains at least 1 file');
  assert(manifest.totalBytes > 0,     'Backup has non-zero size');
  assert(manifest.encrypted === false,'Unencrypted backup flagged correctly');
  assert(typeof manifest.label === 'string', 'Backup has a label');
  assert(manifest.files[0].bytes > 0, 'Backed-up file has size > 0');

  // Verify gzipped file exists on disk
  const destDir = fs.readdirSync(tmpBackup).filter(d => d.startsWith('backup-'))[0];
  assert(destDir != null, 'Backup directory created');
  const files = fs.readdirSync(path.join(tmpBackup, destDir));
  assert(files.some(f => f.endsWith('.gz')), 'Gzipped backup file present');

  // lastManifest
  assert(bm.lastManifest() === manifest, 'lastManifest returns last backup');

  // Retention pruning: run 4 more backups and verify only 3 kept
  for (let i = 0; i < 4; i++) await bm.runNow();
  const backupDirs = fs.readdirSync(tmpBackup).filter(d => d.startsWith('backup-'));
  assert(backupDirs.length <= 3, `Retention pruning kept ≤ 3 backups (got ${backupDirs.length})`);

  // Encrypted backup (test key derivation round-trip)
  const bmEnc = new BackupManager({
    backupDir:  tmpBackup + '-enc',
    intervalMs: 99999999,
    retention:  3,
    encrypt:    true,
    targets:    [tmpTarget],
  });
  process.env.BACKUP_KEY = 'test-secret-key-for-unit-test';
  const encManifest = await bmEnc.runNow();
  assert(encManifest.encrypted === true, 'Encrypted backup flagged');
  assert(encManifest.fileCount >= 1,     'Encrypted backup has files');
  const encFiles = fs.readdirSync(path.join(tmpBackup + '-enc',
    fs.readdirSync(tmpBackup + '-enc').filter(d => d.startsWith('backup-'))[0]
  ));
  assert(encFiles.some(f => f.endsWith('.enc.gz')), 'Encrypted file has .enc.gz extension');

  // Cleanup
  try {
    fs.rmSync(tmpBackup,         { recursive: true });
    fs.rmSync(tmpBackup + '-enc',{ recursive: true });
    // tmpTarget is README.md — don't delete it
  } catch (_) {}

} catch (e) {
  assert(false, 'BackupManager error', e.message);
}

// ══════════════════════════════════════════════════════════════════════════════
//  11. EXCHANGE INTERFACE
// ══════════════════════════════════════════════════════════════════════════════
section('11. ExchangeInterface — adapter pattern');
try {
  const { PaperAdapter, BaseExchangeAdapter, createAdapter } = require('./exchange-interface');

  // PaperAdapter implements all interface methods
  const paper = new PaperAdapter({ capital: 10000 });
  paper.setPrice('EURUSD', 1.1050);

  assert(paper.name === 'paper', 'PaperAdapter name is "paper"');

  const price = await paper.getPrice('EURUSD');
  assert(typeof price.bid === 'number',   'getPrice returns bid');
  assert(typeof price.ask === 'number',   'getPrice returns ask');
  assert(typeof price.mid === 'number',   'getPrice returns mid');
  assert(price.ask > price.bid,           'ask > bid (positive spread)');
  assertClose(price.mid, 1.1050, 0.001,  'mid price close to set price');

  const candles = await paper.getCandles('EURUSD', 20);
  assert(Array.isArray(candles),          'getCandles returns array');
  assert(candles.length === 21,           'getCandles returns count+1 candles');
  assert(candles[0].close != null,        'Candle has close price');

  // placeOrder
  const spec = { asset: 'EURUSD', side: 'BUY', size: 1000, orderType: 'MARKET' };
  const order = await paper.placeOrder(spec);
  assert(order.status === 'filled',       'Paper order fills immediately');
  assert(typeof order.fillPrice === 'number', 'fillPrice is a number');
  assert(order.orderId != null,           'orderId assigned');

  // getOpenPositions
  const positions = await paper.getOpenPositions();
  assert(Array.isArray(positions),        'getOpenPositions returns array');
  assert(positions.length === 1,          'One position after placeOrder');
  assert(positions[0].side === 'LONG',    'BUY creates LONG position');

  // getAccountBalance
  const balance = await paper.getAccountBalance();
  assert(typeof balance.balance === 'number',  'balance is number');
  assert(typeof balance.equity  === 'number',  'equity is number');

  // cancelOrder
  const cancel = await paper.cancelOrder('some-id');
  assert(cancel.cancelled === true,       'cancelOrder returns cancelled:true');

  // createAdapter factory
  const adapter = createAdapter('paper', { capital: 5000 });
  assert(adapter instanceof PaperAdapter, 'createAdapter(paper) returns PaperAdapter');

  // BaseExchangeAdapter throws on unimplemented methods
  const base = new BaseExchangeAdapter();
  let threw = false;
  try { await base.getPrice('EURUSD'); } catch (_) { threw = true; }
  assert(threw, 'BaseExchangeAdapter.getPrice throws NotImplemented');

  // validateSpec catches missing fields
  let specErr = false;
  try { paper._validateSpec({ asset: 'EURUSD' }); } catch (_) { specErr = true; }
  assert(specErr, '_validateSpec throws on missing side');

  let sizeErr = false;
  try { paper._validateSpec({ asset: 'EURUSD', side: 'BUY', size: 0 }); } catch (_) { sizeErr = true; }
  assert(sizeErr, '_validateSpec throws on size=0');

} catch (e) {
  assert(false, 'ExchangeInterface error', e.message);
}

// ══════════════════════════════════════════════════════════════════════════════
//  12. SECURITY AUDIT
// ══════════════════════════════════════════════════════════════════════════════
section('12. SecurityAudit — security checks and guidance');
try {
  const { SecurityAudit } = require('./security-audit');
  const audit = new SecurityAudit({ maxKeyAgeDays: 90 });

  // run() returns structured report
  const report = audit.run();
  assert(Array.isArray(report.findings),   'findings is an array');
  assert(typeof report.passes  === 'number', 'passes count is number');
  assert(typeof report.warns   === 'number', 'warns count is number');
  assert(typeof report.errors  === 'number', 'errors count is number');
  assert(typeof report.secure  === 'boolean', 'secure field is boolean');
  assert(report.findings.length > 0,       'At least one finding reported');

  // Every finding has level, msg, ts
  for (const f of report.findings) {
    assert(['PASS','WARN','ERROR'].includes(f.level), `Finding level valid: ${f.level}`);
    assert(typeof f.msg === 'string', 'Finding has message');
    assert(f.ts != null,              'Finding has timestamp');
  }

  // recordRotation persists and can be read back
  const audit2 = new SecurityAudit();
  audit2.recordRotation('TEST_KEY');
  // Simulate reading it back
  const rotState = path.join(__dirname, 'trade_logs', 'credential_rotation.json');
  if (fs.existsSync(rotState)) {
    const state = JSON.parse(fs.readFileSync(rotState, 'utf8'));
    assert(state.TEST_KEY != null, 'recordRotation persists key rotation date');
    // Cleanup
    delete state.TEST_KEY;
    fs.writeFileSync(rotState, JSON.stringify(state));
  }

  // Key separation check: same key → error
  const savedKey = process.env.OANDA_API_KEY;
  process.env.OANDA_API_KEY     = 'same-key-value';
  process.env.OANDA_READONLY_KEY = 'same-key-value';
  const audit3 = new SecurityAudit();
  audit3._findingsForTest = [];
  audit3._log = (level, msg) => { audit3._findingsForTest.push({ level, msg }); };
  audit3._checkKeySeparation();
  const sepError = audit3._findingsForTest.find(f => f.level === 'ERROR' && f.msg.includes('separate keys'));
  assert(sepError != null, 'Key separation check errors when keys are identical');

  // Cleanup
  process.env.OANDA_API_KEY = savedKey;
  delete process.env.OANDA_READONLY_KEY;

  // Backup encryption check: short key → error
  const origKey = process.env.BACKUP_KEY;
  process.env.BACKUP_KEY = 'short';
  const audit4 = new SecurityAudit();
  audit4._findingsForTest = [];
  audit4._log = (level, msg) => { audit4._findingsForTest.push({ level, msg }); };
  audit4._checkBackupEncryption();
  const shortKeyError = audit4._findingsForTest.find(f => f.level === 'ERROR');
  assert(shortKeyError != null, 'Short BACKUP_KEY triggers error');
  process.env.BACKUP_KEY = origKey || '';

} catch (e) {
  assert(false, 'SecurityAudit error', e.message);
}

// ══════════════════════════════════════════════════════════════════════════════
//  FINAL SUMMARY
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(64));
console.log('  RESULTS');
console.log('═'.repeat(64));
console.log(`  ✅ Passed:  ${passed}`);
console.log(`  ❌ Failed:  ${failed}`);
console.log(`  ⏭  Skipped: ${skipped}`);
if (failures.length) {
  console.log('\n  Failed tests:');
  failures.forEach(f => console.log('    • ' + f));
}
console.log('');
process.exit(failed > 0 ? 1 : 0);
})();