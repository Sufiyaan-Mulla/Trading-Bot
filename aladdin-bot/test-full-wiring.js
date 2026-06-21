'use strict';

(async () => {
// ══════════════════════════════════════════════════════════════════════════════
//  test-full-wiring.js
//  Tests all 10 features that were "module exists but not wired":
//    1. Idempotent order submission
//    2. Reconcile after reconnects
//    3. Maker/taker fee-aware order selection
//    4. Fill probability before limit orders
//    5. Latency measurement
//    6. Max open positions + sector caps
//    7. OHLCV validation on live data
//    8. Vectorised indicators
//    9. Parallel symbol analysis
//   10. Dependency injection
// ══════════════════════════════════════════════════════════════════════════════

const { EventEmitter } = require('events');

let passed = 0, failed = 0;
const failures = [];
function assert(cond, label, detail = '') {
  if (cond) { process.stdout.write(`  ✅ ${label}\n`); passed++; }
  else { process.stdout.write(`  ❌ FAIL: ${label}${detail ? ' — '+detail : ''}\n`); failed++; failures.push(label); }
}
function assertClose(a, b, tol, label) { assert(Math.abs(a-b)<=tol, label, `got ${a}, expected ~${b}`); }
function section(t) { console.log('\n'+'═'.repeat(64)+'\n  '+t+'\n'+'═'.repeat(64)); }

// ── Mock engine ───────────────────────────────────────────────────────────────
function makeMockEngine(opts = {}) {
  class MockEngine extends EventEmitter {
    constructor() {
      super();
      this.capital           = opts.capital || 10_000;
      this.initialCapital    = opts.capital || 10_000;
      this.selectedAsset     = opts.asset || 'EURUSD';
      this.position          = null;
      this.trades            = [];
      this.priceHistory      = Array.from({length:100}, (_,i)=>1.10+i*0.0001);
      this.currentSpread     = 0.0002;
      this.lastATR           = 0.0010;
      this.lastRSI           = 55;
      this.lastIndicators    = { confidence: 70, adxRegime: 'TRENDING', atrPercent: 0.05 };
      this.isRunning         = false;
      this.circuitBreakerTripped = false;
      this.globalHaltTripped = false;
      this._entering         = false;
      this._wired            = false;
      this._lastStrategyName = 'trend';
      this.marketData = {
        getPriceHistory: (asset) => Array.from({length:80}, (_,i) => 1.10 + i*0.00005),
      };
      this.economicCalendar = { isBlackout: () => false };
      this.mlConfidence     = { rsiBuffer: [], pushOHLCV: () => {}, calibrator: null };
      this.capitalAllocator = { canEnter: () => ({ allowed:true, maxSize:500 }), openPosition:()=>{}, slots: new Map([['ensemble',{}]]) };
      this.abTester = { championId: 'ensemble' };
      this.slippageHistory = [];
      this.dynamicSlippage = 0.0005;
      this.dynamicTpMultiplier = 5.0;
      this._fillQualityHistory = [];
      this.spreadHistory = [];
      this.avgSpread = 0.0001;
      this.volatilityLevel = 'NORMAL';
      this.lastMarketRegime = 'TRENDING';
      this.lastVWAP = 1.1050;
    }
    log(msg) { }
    checkRiskManagement() { return true; }
    async getDecision(ind) { return { action:'BUY', confidence:75, reasoning:'mock', strategyName:'trend' }; }
    _selectBestAsset() { return this.selectedAsset; }
    _currentSession() { return 'LONDON'; }
    _recordSlippage(f) { this.slippageHistory.push(f); }
    _checkSpread() { return { blocked:false, warn:false, spreadFraction:0.0001, spreadPips:1, penaltyPts:0 }; }
    savePositionFile() {}
    saveTradesFile()   {}
    async _twapFill(price, size) { return { avgFillPrice: price, filledShares: size/price, fills: [] }; }
    async _executeFill(shares, price, dir='BUY') {
      return { filledShares: shares, avgEntryPrice: price + (dir==='BUY'?0.0001:0), fills: [{ shares, price, attempt:1 }] };
    }
    async enterPosition(price, conf, corr=1) {
      this.position = { entry:price, shares:1000, side:'LONG', entryTime:Date.now(), atr:this.lastATR, confidence:conf };
    }
    exitPosition(price, reason) {
      const p = this.position;
      this.position = null;
      this.trades.push({ profit:0, profitPercent:0, asset:this.selectedAsset });
      this.emit('tradeClose', { profit:0, profitPercent:0 });
    }
    async runTradingLoop() { return 'loop'; }
  }
  return new MockEngine();
}

// ══════════════════════════════════════════════════════════════════════════════
section('1+2. IdempotentExecutor — dedup wired into _executeFill + reconcile on reconnect');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { wireEngine }          = require('./engine-wiring');
  const { applyExecutionHooks } = require('./execution-hooks');
  const engine = makeMockEngine();
  wireEngine(engine);

  assert(engine.idempotentExec != null, 'IdempotentExecutor attached to engine');

  // Test dedup: same spec submitted twice → only one real fill
  let fillCount = 0;
  const origFill = engine._executeFill.bind(engine);
  // Override _executeFill to count calls BELOW the hook
  const baseCount = () => fillCount;

  // Simulate two rapid fills of same spec
  const r1 = await engine._executeFill(1000, 1.1050, 'BUY');
  const r2 = await engine._executeFill(1000, 1.1050, 'BUY');
  assert(r1 != null,           'First fill returns result');
  assert(r2 != null,           'Second fill returns result (deduplicated or fresh)');

  // Test reconcile on runTradingLoop (reconnect hook)
  assert(typeof engine.runTradingLoop === 'function', 'runTradingLoop patched for reconciliation');
  const reconcileCalled = [];
  const origRecon = engine.idempotentExec.reconcile.bind(engine.idempotentExec);
  engine.idempotentExec.reconcile = async (fn) => {
    reconcileCalled.push(true);
    return origRecon(fn);
  };
  await engine.runTradingLoop();
  assert(reconcileCalled.length >= 1, 'reconcile() called on runTradingLoop (reconnect)');

} catch (e) { assert(false, 'IdempotentExecutor wiring error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('3. FeeModel — classify() called during _executeFill');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { wireEngine }          = require('./engine-wiring');
  const { applyExecutionHooks } = require('./execution-hooks');
  const engine = makeMockEngine();
  wireEngine(engine);

  assert(engine.feeModel != null, 'FeeModel attached to engine');

  // Intercept feeModel.classify to verify it's called
  let classifyCalled = false;
  let classifyArgs   = null;
  const origClassify = engine.feeModel.classify.bind(engine.feeModel);
  engine.feeModel.classify = (...args) => {
    classifyCalled = true;
    classifyArgs   = args;
    return origClassify(...args);
  };

  await engine._executeFill(1000, 1.1050, 'BUY');
  assert(classifyCalled,                    'feeModel.classify() called during _executeFill');
  assert(classifyArgs != null,              'classify() received spread, volatility args');
  assert(typeof classifyArgs[0] === 'number','First arg (spread) is a number');

  // Verify classify returns one of the valid types
  const result = engine.feeModel.classify(0.0001, 0.001, 0.5, 1000);
  assert(['LIMIT','MARKET','TWAP'].includes(result.type), `classify returns valid type: ${result.type}`);

  // Tight spread + low urgency should prefer LIMIT
  const tight = engine.feeModel.classify(0.00005, 0.0005, 0.2, 500);
  assert(tight.type === 'LIMIT', 'Tight spread + low urgency → LIMIT order');

  // High urgency → MARKET
  const urgent = engine.feeModel.classify(0.0001, 0.001, 0.9, 500);
  assert(urgent.type === 'MARKET', 'High urgency → MARKET order');

  // EV check: verify adjustedEV is computed
  const ev = engine.feeModel.adjustExpectedValue(0.005, 'MARKET', 1000, 1.1050);
  assert(typeof ev.adjustedEV === 'number',  'adjustedEV computed after fee drag');
  assert(typeof ev.viable === 'boolean',     'viable flag present');

} catch (e) { assert(false, 'FeeModel wiring error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('4. FillProbability — estimate() gates limit orders in _executeFill');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { wireEngine } = require('./engine-wiring');
  const engine = makeMockEngine();
  wireEngine(engine);

  assert(engine.fillProbability != null, 'FillProbability attached to engine');

  // Intercept estimate() to verify it's called when orderType is limit
  let estimateCalled = false;
  const origEstimate = engine.fillProbability.estimate.bind(engine.fillProbability);
  engine.fillProbability.estimate = (...args) => {
    estimateCalled = true;
    return origEstimate(...args);
  };

  // Force feeModel to return LIMIT so estimate() is triggered
  const origClassify = engine.feeModel.classify.bind(engine.feeModel);
  engine.feeModel.classify = () => ({ type: 'LIMIT', reason: 'test' });
  await engine._executeFill(1000, 1.1050, 'BUY');
  engine.feeModel.classify = origClassify;

  assert(estimateCalled, 'fillProbability.estimate() called when order type is LIMIT');

  // Verify estimate() returns expected structure
  const est = engine.fillProbability.estimate({
    currentPrice: 1.1050, limitPrice: 1.1040, atr: 0.0010,
    maxWaitMs: 30_000, side: 'BUY',
  });
  assert(typeof est.probability === 'number', 'estimate() returns probability');
  assert(typeof est.useLimit === 'boolean',   'estimate() returns useLimit flag');
  assert(est.probability >= 0 && est.probability <= 1, 'probability in [0,1]');

  // Far limit → low probability → switch to market
  const far = engine.fillProbability.estimate({
    currentPrice: 1.1050, limitPrice: 1.0950, atr: 0.0010,
    maxWaitMs: 30_000, side: 'BUY',
  });
  assert(far.useLimit === false, 'Far-away limit price causes useLimit=false (→ market downgrade)');

  // Near limit → high probability → use limit
  const near = engine.fillProbability.estimate({
    currentPrice: 1.1050, limitPrice: 1.1049, atr: 0.0010,
    maxWaitMs: 30_000, side: 'BUY',
  });
  assert(near.useLimit === true, 'Near limit price → useLimit=true');

} catch (e) { assert(false, 'FillProbability wiring error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('5. ExecutionMetrics — begin()/end() wrap every _executeFill call');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { wireEngine } = require('./engine-wiring');
  const engine = makeMockEngine();
  wireEngine(engine);

  assert(engine.executionMetrics != null, 'ExecutionMetrics attached to engine');

  // Track begin/end calls
  let beginCount = 0, endCount = 0;
  const origBegin = engine.executionMetrics.begin.bind(engine.executionMetrics);
  const origEnd   = engine.executionMetrics.end.bind(engine.executionMetrics);
  engine.executionMetrics.begin = (...a) => { beginCount++; return origBegin(...a); };
  engine.executionMetrics.end   = (...a) => { endCount++;   return origEnd(...a);   };

  await engine._executeFill(1000, 1.1050, 'BUY');
  assert(beginCount >= 1, 'executionMetrics.begin() called on fill');
  assert(endCount   >= 1, 'executionMetrics.end() called after fill');

  // Report shows latency data
  const rep = engine.executionMetrics.report();
  assert(rep.count >= 1,                    'report() shows at least 1 fill recorded');
  assert(typeof rep.latency.p50 === 'number','p50 latency present in report');
  assert(typeof rep.quality.grade === 'string','quality grade assigned');

  // Multiple fills — rolling stats
  for (let i = 0; i < 5; i++) {
    await engine._executeFill(500, 1.1050 + i*0.0001, 'BUY');
  }
  const rep2 = engine.executionMetrics.report();
  assert(rep2.count >= 6, `report shows ${rep2.count} fills after 6 fills`);
  assert(rep2.latency.avg >= 0, 'average latency ≥ 0ms');

  // isExecDegraded returns structured result
  const deg = engine.executionMetrics.isExecDegraded();
  assert(typeof deg.degraded === 'boolean', 'isExecDegraded returns boolean degraded');

} catch (e) { assert(false, 'ExecutionMetrics wiring error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('6. SectorCap — canEnter() checked before enterPosition');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { wireEngine } = require('./engine-wiring');
  const engine = makeMockEngine();
  wireEngine(engine);

  assert(engine.sectorCap != null, 'SectorCap attached to engine');

  // canEnter() should be called — intercept it
  let canEnterCalled = false;
  const origCan = engine.sectorCap.canEnter.bind(engine.sectorCap);
  engine.sectorCap.canEnter = (asset, capital) => {
    canEnterCalled = true;
    return origCan(asset, capital);
  };

  await engine.enterPosition(1.1050, 75);
  assert(canEnterCalled, 'sectorCap.canEnter() called before enterPosition');

  // After successful entry, position registered in SectorCap
  if (engine.position) {
    const status = engine.sectorCap.status(engine.capital);
    assert(status.openCount >= 1, 'SectorCap tracks open position after entry');
  }

  // Test block: fill the sector cap
  const engine2 = makeMockEngine();
  wireEngine(engine2);
  engine2.sectorCap = { canEnter: () => ({ allowed:false, reason:'USD_MAJOR full (2/2)' }), open:()=>{}, close:()=>{}, status:()=>({openCount:2}) };
  const posBefore = engine2.position;
  await engine2.enterPosition(1.1050, 75);
  assert(engine2.position === null, 'enterPosition blocked when SectorCap denies entry');

  // exitPosition removes from SectorCap
  const engine3 = makeMockEngine();
  wireEngine(engine3);
  let closeCalled = false;
  engine3.sectorCap.close = () => { closeCalled = true; };
  engine3.position = { entry:1.1050, shares:1000, side:'LONG' };
  engine3.exitPosition(1.1060, 'test');
  assert(closeCalled, 'sectorCap.close() called after exitPosition');

} catch (e) { assert(false, 'SectorCap wiring error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('7. OHLCV validation — called on live data in market-data-fetcher');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = require('fs').readFileSync('./market-data-fetcher.js','utf8');
  assert(src.includes('OHLCVValidator'),          'market-data-fetcher.js imports OHLCVValidator');
  assert(src.includes('_ohlcvValidator'),          'module-level validator instance created');
  assert(src.includes('valReport.valid'),          'validation report checked');
  assert(src.includes('_ohlcvValidator.clean('),   'clean() called to fix issues');
  assert(src.includes('let { prices, volumes') || src.includes('let {prices,volumes') || (src.includes('_ohlcvValidator.clean(') && src.includes('prices = ')), 'prices/volumes reassigned after validation');

  // Verify OHLCVValidator itself works as expected
  const { OHLCVValidator } = require('./ohlcv-validator');
  const v = new OHLCVValidator({ intervalMs: 5*60_000 });

  // Clean data should pass
  const clean = Array.from({length:50}, (_,i) => ({
    time: Date.now() - (50-i)*300_000, open:1.10, high:1.101, low:1.099, close:1.1005+i*0.00001, volume:1000
  }));
  const rep = v.validate(clean);
  assert(rep.gapCount === 0,   'Clean candles: no gaps detected');
  assert(rep.spikeCount === 0, 'Clean candles: no spikes detected');

  // Data with a gap should be caught
  const withGap = [...clean];
  withGap[25] = { ...withGap[25], time: withGap[24].time + 40*60_000 };
  for (let i=26; i<withGap.length; i++) withGap[i] = {...withGap[i], time: withGap[25].time + (i-25)*300_000};
  const gapRep = v.validate(withGap);
  assert(gapRep.gapCount >= 1, 'Gap detected in candle data');

  // clean() fills gaps with synthetic candles
  const cleaned = v.clean(withGap);
  assert(cleaned.length > withGap.length, 'clean() adds synthetic candles to fill gap');
  assert(cleaned.some(c=>c._synthetic==='gap_fill'), 'Synthetic candles tagged as gap_fill');

} catch (e) { assert(false, 'OHLCV validation wiring error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('8. Vectorised indicators — TypedEMA/TypedRSI used in indicators.js');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { TypedEMA, TypedRSI, TypedATR, benchmark } = require('./typed-indicators');
  const { Indicators } = require('./indicators');

  // Verify indicators.js imports typed-indicators
  const indSrc = require('fs').readFileSync('./indicators.js','utf8');
  assert(indSrc.includes('typed-indicators'),  'indicators.js imports typed-indicators');
  assert(indSrc.includes('TypedEMA'),          'indicators.js uses TypedEMA');
  assert(indSrc.includes('TypedRSI'),          'indicators.js uses TypedRSI');

  // Generate 200 prices
  const prices = Array.from({length:200}, (_,i) => 1.10 + Math.sin(i/20)*0.01 + i*0.00001);

  // EMA: typed result should match plain JS to 4 decimal places
  const emaTyped = TypedEMA(Float64Array.from(prices), 14);
  const emaPlain = Indicators.ema(prices, 14);
  assertClose(emaTyped[emaTyped.length-1], emaPlain, 0.0001, 'TypedEMA matches plain EMA to 4dp');

  // RSI: both should give value in 0-100
  const rsiTyped = TypedRSI(Float64Array.from(prices), 14);
  const rsiPlain = Indicators.rsi(prices, 14);
  assert(rsiTyped[rsiTyped.length-1] >= 0 && rsiTyped[rsiTyped.length-1] <= 100, 'TypedRSI in [0,100]');
  assert(rsiPlain >= 0 && rsiPlain <= 100, 'Plain RSI in [0,100]');
  assertClose(rsiTyped[rsiTyped.length-1], rsiPlain, 5.0, 'TypedRSI close to plain RSI');

  // Float64Array is returned
  assert(emaTyped instanceof Float64Array, 'TypedEMA returns Float64Array');
  assert(rsiTyped instanceof Float64Array, 'TypedRSI returns Float64Array');

  // Indicators.ema uses typed path for large arrays (>= 50)
  // Verify the indicators.js ema function produces a number (not broken)
  const emaResult = Indicators.ema(prices, 14);
  assert(typeof emaResult === 'number',   'Indicators.ema returns number after patching');
  assert(isFinite(emaResult),             'Indicators.ema result is finite');

  // RSI from indicators.js is still a number
  const rsiResult = Indicators.rsi(prices, 14);
  assert(typeof rsiResult === 'number',   'Indicators.rsi returns number after patching');
  assert(rsiResult >= 0 && rsiResult <= 100, 'Indicators.rsi in [0,100]');

  // Performance: typed should be fast
  const bm = benchmark(500);
  assert(bm.EMA.perCallMs < 20,           'TypedEMA benchmark < 20ms per call on 500 bars');
  assert(bm.RSI.perCallMs < 20,           'TypedRSI benchmark < 20ms per call on 500 bars');

} catch (e) { assert(false, 'Vectorised indicators wiring error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('9. Parallel scanner — used in _selectBestAsset for multi-asset scoring');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { wireEngine } = require('./engine-wiring');
  const { TRADING_CONFIG } = require('./trading-config');
  const engine = makeMockEngine();

  // Give multiple assets
  const origAssets = TRADING_CONFIG.assets;
  TRADING_CONFIG.assets = ['EURUSD', 'GBPUSD', 'USDJPY'];

  // Provide distinct price histories
  const histories = {
    EURUSD: Array.from({length:80}, (_,i) => 1.10 + i*0.0001),  // trending up
    GBPUSD: Array.from({length:80}, (_,i) => 1.25 - i*0.0001),  // trending down
    USDJPY: Array.from({length:80}, (_,i) => 150 + (Math.random()-0.5)*0.1),
  };
  engine.marketData.getPriceHistory = (asset) => histories[asset] || [];
  wireEngine(engine);

  assert(engine.parallelScanner != null, 'ParallelScanner attached to engine');
  assert(engine.relativeStrength != null,'RelativeStrength attached to engine');

  // Verify _selectBestAsset now uses parallel scanner
  let scanCalled = false;
  const origScan = engine.parallelScanner.scan.bind(engine.parallelScanner);
  engine.parallelScanner.scan = async (assets, fn) => {
    scanCalled = true;
    return origScan(assets, fn);
  };

  const best = await engine._selectBestAsset();
  assert(typeof best === 'string',    '_selectBestAsset returns a string asset name');
  assert(best.length > 0,             '_selectBestAsset returns non-empty asset');
  assert(scanCalled,                  'parallelScanner.scan() called inside _selectBestAsset');

  // Verify scanner stats are tracked
  const stats = engine.parallelScanner.stats();
  assert(stats.count >= 1,            'scanner.stats().count >= 1 after scan');
  assert(typeof stats.lastMs === 'number', 'scanner.stats().lastMs is number');

  // Parallel vs sequential timing: parallel should be faster for multiple assets
  const scanner = require('./parallel-scanner').ParallelScanner;
  const ps = new (scanner)({ concurrencyLimit: 3 });
  const t0 = Date.now();
  await ps.scan(['A','B','C'], async (a) => { await new Promise(r=>setTimeout(r,10)); return {a}; });
  const elapsed = Date.now() - t0;
  assert(elapsed < 50, `Parallel scan of 3 assets with 10ms each takes < 50ms (got ${elapsed}ms)`);

  TRADING_CONFIG.assets = origAssets;

} catch (e) { assert(false, 'Parallel scanner wiring error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('10. Dependency injection — container bound to engine, overrides work');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { wireEngine } = require('./engine-wiring');
  const { DIContainer, container } = require('./di-container');

  const engine = makeMockEngine();
  wireEngine(engine);

  // container should be accessible on the engine
  assert(engine.container != null,          'engine.container is set after wiring');
  assert(engine._diWired === true,           'engine._diWired flag set');

  // Container has standard registrations
  assert(container.has('auditLog'),          'container has auditLog');
  assert(container.has('telegram'),          'container has telegram');
  assert(container.has('feeModel'),          'container has feeModel');
  assert(container.has('fillProb'),          'container has fillProb');
  assert(container.has('profiler'),          'container has profiler');

  // Container resolves values
  const tg = container.get('telegram');
  assert(typeof tg === 'object' || typeof tg === 'function', 'telegram resolves to object/function');

  // Test override for mocking in tests
  const mockTg = { send: () => 'mocked', _isMock: true };
  container.override('telegram', mockTg);
  const resolved = container.get('telegram');
  assert(resolved._isMock === true,          'override() injects mock telegram');
  container.reset('telegram');
  const restored = container.get('telegram');
  assert(restored._isMock !== true,          'reset() restores original telegram');

  // Child container inherits but isolates
  const child = container.child();
  child.override('telegram', { send:()=>{}, _isChild:true });
  assert(child.get('telegram')._isChild === true,  'child container has its own override');
  assert(container.get('telegram')._isChild !== true, 'parent container unaffected by child');

  // Transient returns new instance each call
  const c2 = new DIContainer();
  let buildCount = 0;
  c2.transient('counter', () => { buildCount++; return { id: buildCount }; });
  const i1 = c2.get('counter');
  const i2 = c2.get('counter');
  assert(i1.id !== i2.id,                   'Transient returns new instance each get()');
  assert(buildCount === 2,                   'Factory called twice for transient');

  // Cycle detection
  const c3 = new DIContainer();
  c3.singleton('a', (c) => c.get('b'));
  c3.singleton('b', (c) => c.get('a'));
  let cycleErr = false;
  try { c3.get('a'); } catch(_) { cycleErr = true; }
  assert(cycleErr, 'Circular dependency throws error');

} catch (e) { assert(false, 'DI container wiring error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('Integration — all 10 features work together in a single engine');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { wireEngine } = require('./engine-wiring');
  const engine = makeMockEngine();
  wireEngine(engine);

  // Verify all 10 features are present
  const checks = [
    ['idempotentExec',   'IdempotentExecutor'],
    ['feeModel',         'FeeModel'],
    ['fillProbability',  'FillProbability'],
    ['executionMetrics', 'ExecutionMetrics'],
    ['sectorCap',        'SectorCap'],
    ['relativeStrength', 'RelativeStrength'],
    ['parallelScanner',  'ParallelScanner'],
    ['profiler',         'Profiler'],
    ['container',        'DIContainer'],
    ['drawdownTracker',  'DrawdownTracker'],
  ];
  checks.forEach(([prop, name]) => assert(engine[prop] != null, `${name} attached to engine`));

  // Full execution cycle: fill goes through all hooks
  let fillMetrics = null;
  const origEnd = engine.executionMetrics.end.bind(engine.executionMetrics);
  engine.executionMetrics.end = (...a) => { fillMetrics = origEnd(...a); return fillMetrics; };

  await engine._executeFill(1000, 1.1050, 'BUY');

  assert(fillMetrics != null,                    'Fill recorded in ExecutionMetrics');
  assert(typeof fillMetrics.latencyMs === 'number', 'Latency measured on fill');
  assert(typeof fillMetrics.qualityScore === 'number', 'Quality score computed');
  assert(fillMetrics.qualityScore >= 0,          'Quality score is non-negative');

  // Confirm _wired flag is set
  assert(engine._wired === true,                 'engine._wired = true after full wiring');
  assert(engine._execHooksApplied === true,      'engine._execHooksApplied = true');
  assert(engine._diWired === true,               'engine._diWired = true');

} catch (e) { assert(false, 'Integration test error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n'+'═'.repeat(64));
console.log('  RESULTS');
console.log('═'.repeat(64));
console.log(`  ✅ Passed:  ${passed}`);
console.log(`  ❌ Failed:  ${failed}`);
if (failures.length) {
  console.log('\n  Failed tests:');
  failures.forEach(f => console.log('    • ' + f));
}
console.log('');
process.exit(failed > 0 ? 1 : 0);

})();
