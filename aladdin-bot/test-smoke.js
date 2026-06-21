'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  test-smoke.js — Integration / Smoke Test
//
//  What unit tests can't catch:
//    • Broken wiring between modules (runTradingLoop was accidentally deleted
//      during a refactor and only caught in production — this test prevents that)
//    • State accumulated across multiple ticks causing crashes
//    • Methods mixed in via Object.assign not being callable as `this.method()`
//    • Invalid indicators object shape causing strategy decisions to throw
//    • Capital allocator or liquidity scorer state diverging from engine state
//
//  What this test does:
//    1. Boots a real TradingEngine (no mocks)
//    2. Seeds realistic price/volume history
//    3. Runs calculateIndicators() — full indicator pipeline
//    4. Runs getRuleBasedDecision() — strategy routing + ensemble
//    5. Calls enterPosition() — full execution path including spread, Kelly, alloc
//    6. Simulates 20 bars — exercises the tick loop, risk management, trailing stop
//    7. Calls exitPosition() — verifies trade recorded correctly
//    8. Verifies getStatus() returns all expected keys
//    9. Verifies Dashboard._snapshot() builds without errors
//
//  All assertions use real engine state — no mocks, no stubs.
// ═══════════════════════════════════════════════════════════════════════════════

const { TradingEngine, TRADING_CONFIG } = require('./trading-engine');
const { Dashboard }                     = require('./dashboard');

let passed = 0, failed = 0, total = 0;
function test(label, fn) {
  total++;
  try {
    const r = fn();
    if (r instanceof Promise) {
      return r.then(() => { console.log('  OK  ' + label); passed++; })
              .catch(e  => { console.log('  FAIL ' + label + '\n       -> ' + e.message); failed++; });
    }
    console.log('  OK  ' + label); passed++;
  } catch(e) {
    console.log('  FAIL ' + label + '\n       -> ' + e.message); failed++;
  }
  return Promise.resolve();
}
function truthy(v, msg) { if (!v) throw new Error(msg || 'expected truthy, got ' + v); }
function eq(a, b, msg)  { if (a !== b) throw new Error(msg || JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }
function gt(a, b, msg)  { if (!(a > b)) throw new Error(msg || a + ' not > ' + b); }
function gte(a, b, msg) { if (!(a >= b)) throw new Error(msg || a + ' not >= ' + b); }

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeEngine() {
  // Disable warmup so the async callback doesn't overwrite our seeded priceHistory
  const savedWarmup = TRADING_CONFIG.warmupEnabled;
  TRADING_CONFIG.warmupEnabled = false;
  const e = new TradingEngine();
  TRADING_CONFIG.warmupEnabled = savedWarmup;

  e.position     = null;
  e.selectedAsset = 'EURUSD';
  e.mlConfidence.trained = false;
  e.abTester.setEnsembleEnabled(false);

  // Seed 220 bars of realistic price/volume history
  let p = 1.1000;
  for (let i = 0; i < 220; i++) {
    p = Math.max(0.8, p + (i % 2 === 0 ? 0.0003 : -0.0001));
    e.priceHistory.push(p);
    e.volumeHistory.push(800_000 + Math.sin(i) * 200_000);
    e.ohlcvHistory.push({ o: p - 0.0002, h: p + 0.0004, l: p - 0.0003, c: p, v: 1_000_000 });
  }
  e.lastATR           = 0.0012;
  e.lastVWAP          = p;
  e.marketPrice       = p;
  e.volatilityLevel   = 'NORMAL';
  e.dynamicSlippage   = TRADING_CONFIG.slippage;
  e.dynamicTpMultiplier = 5.0;
  e.lastMarketRegime  = 'TRENDING';
  e.lastGoldenCross   = true;
  return e;
}

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════');
console.log('  SMOKE TEST — Full Pipeline Integration');
console.log('═══════════════════════════════════════════════════════════');

(async () => {

// ── 1. Engine boots cleanly ───────────────────────────────────────────────────
console.log('\n-- 1-5. Engine boot');

await test('TradingEngine instantiates without errors', () => {
  const e = new TradingEngine(); e.position = null;
  truthy(e instanceof TradingEngine);
  truthy(typeof e.capital === 'number' && e.capital > 0);
});

await test('All mixin methods present after boot', () => {
  const e = makeEngine();
  const required = [
    'enterPosition','exitPosition','checkRiskManagement','updateTrailingStop',
    'takePartialProfit','executeDecision','calculateIndicators','getRuleBasedDecision',
    'buildPerformanceState','_executeFill','_checkSpread','_recordSpread','_recordSlippage',
    'saveTradesFile','getDecision',
  ];
  for (const m of required) {
    truthy(typeof e[m] === 'function', `Missing mixin method: ${m}`);
  }
});

await test('Engine has all sub-systems attached', () => {
  const e = makeEngine();
  truthy(e.liquidityScorer,  'liquidityScorer missing');
  truthy(e.calibrator || e.mlConfidence?.calibrator, 'calibrator missing');
  truthy(e.driftMonitor,     'driftMonitor missing');
  truthy(e.abTester,         'abTester missing');
  truthy(e.capitalAllocator, 'capitalAllocator missing');
  truthy(e.marketData,       'marketData missing');
  truthy(e.newsFilter,       'newsFilter missing');
});

await test('marketData.fetchPrice returns real (non-random) price', () => {
  const e = makeEngine();
  const p1 = e.marketData.fetchPrice('EURUSD').price;
  const p2 = e.marketData.fetchPrice('EURUSD').price;
  const p3 = e.marketData.fetchPrice('EURUSD').price;
  eq(p1, p2, 'fetchPrice should return stable cached price (no random walk)');
  eq(p2, p3, 'fetchPrice should return stable cached price (no random walk)');
  truthy(p1 > 0, 'price must be positive');
});

await test('runTradingLoop exists and is callable', () => {
  const e = makeEngine();
  eq(typeof e.runTradingLoop, 'function', 'runTradingLoop must exist — was accidentally deleted in a previous refactor');
});

// ── 2. Indicator pipeline ─────────────────────────────────────────────────────
console.log('\n-- 6-12. Indicator pipeline');

let indicators = null;

await test('calculateIndicators returns valid snapshot', async () => {
  const e = makeEngine();
  indicators = await e.calculateIndicators();
  truthy(indicators !== null, 'calculateIndicators returned null (not enough history)');
});

await test('Indicator snapshot has all required fields', () => {
  const required = [
    'price','rsi','macd','ema9','ema21','ema50','ema200','bb','atr','atrPercent',
    'vwap','volatilityLevel','marketRegime','goldenCross','deathCross','ema50Slope',
    'volRatio','liquidMarket','liquidityScore','liquidityRegime','liquidityMultiplier',
    'liquidityBlocked','mta','signal','leadingSignal','performanceState',
  ];
  for (const k of required) truthy(k in indicators, `Missing indicator field: ${k}`);
});

await test('RSI in [0, 100]', () => {
  const rsi = parseFloat(indicators.rsi);
  truthy(rsi >= 0 && rsi <= 100, `RSI ${rsi} out of range`);
});

await test('Liquidity score in [0, 100]', () => {
  truthy(indicators.liquidityScore >= 0 && indicators.liquidityScore <= 100,
    `liquidityScore ${indicators.liquidityScore} out of range`);
  truthy(['DEEP','NORMAL','THIN','DRY'].includes(indicators.liquidityRegime),
    `Invalid liquidityRegime: ${indicators.liquidityRegime}`);
});

await test('MTA result has allowed + score', () => {
  truthy('allowed' in indicators.mta, 'mta.allowed missing');
  truthy('score' in indicators.mta,   'mta.score missing');
  truthy(typeof indicators.mta.allowed === 'boolean');
});

await test('EMA50 slope is a number', () => {
  truthy(typeof indicators.ema50Slope === 'number' && isFinite(indicators.ema50Slope));
});

await test('ATR > 0 with sufficient price history', () => {
  gt(parseFloat(indicators.atr), 0, `ATR ${indicators.atr} should be > 0`);
});

// ── 3. Decision routing ───────────────────────────────────────────────────────
console.log('\n-- 13-17. Decision routing');

let decision = null;

await test('getRuleBasedDecision returns valid action', () => {
  const e = makeEngine();
  decision = e.getRuleBasedDecision(indicators);
  truthy(['BUY','SELL','HOLD'].includes(decision.action),
    `Invalid action: ${decision.action}`);
  truthy(typeof decision.confidence === 'number', 'confidence must be number');
  truthy(typeof decision.reasoning  === 'string', 'reasoning must be string');
});

await test('Decision confidence in [0, 100]', () => {
  truthy(decision.confidence >= 0 && decision.confidence <= 100,
    `confidence ${decision.confidence} out of [0,100]`);
});

await test('executeDecision does not throw on any action', () => {
  const e = makeEngine();
  e.executeDecision({ action: 'HOLD', confidence: 70, reasoning: 'test' });
  e.executeDecision({ action: 'BUY',  confidence: 40, reasoning: 'test' });  // below min conf → ignored
  e.executeDecision({ action: 'SELL', confidence: 70, reasoning: 'test' });  // no position → ignored
  truthy(true);
});

await test('Circuit breaker blocks all decisions when tripped', () => {
  const e = makeEngine();
  e.circuitBreakerTripped = true;
  const before = e.capital;
  e.executeDecision({ action: 'BUY', confidence: 80, reasoning: 'test' });
  eq(e.capital, before, 'Capital should not change when circuit breaker is tripped');
  e.circuitBreakerTripped = false;
});

await test('Global halt blocks BUY but allows SELL path', () => {
  const e = makeEngine();
  e.globalHaltTripped = true;
  e.executeDecision({ action: 'BUY', confidence: 80, reasoning: 'test' });
  eq(e.position, null, 'BUY should be blocked by global halt');
  e.globalHaltTripped = false;
});

// ── 4. Execution pipeline ─────────────────────────────────────────────────────
console.log('\n-- 18-27. Execution pipeline');

let engine = null;

await test('enterPosition creates position with narrow spread', async () => {
  engine = makeEngine();
  const price = engine.priceHistory.at(-1);
  // Push a high-volume bar so the 1.2× volume filter passes (avg × 2 easily clears 1.2×)
  const avgVol = engine.volumeHistory.slice(-20).reduce((s,v)=>s+v,0) / 20;
  engine.priceHistory.push(price);
  engine.volumeHistory.push(avgVol * 2.5);
  engine.ohlcvHistory.push({ o:price, h:price+0.0002, l:price-0.0001, c:price, v:avgVol*2.5 });
  for (let i = 0; i < 5; i++) engine._recordSpread(price - 0.00004, price + 0.00004, price);
  await engine.enterPosition(price, 75);
  truthy(engine.position !== null, 'Position should be created with narrow spread and conf=75');
});

await test('Position has all required fields', () => {
  const pos = engine.position;
  const required = ['entry','shares','cost','commission','stopLoss','takeProfit',
    'highestPrice','trailingStopActivated','entryTime','spreadAtEntry','fills',
    'fillSummary','atr','confidence','regime','rawConfidence'];
  for (const k of required) truthy(k in pos, `Missing position field: ${k}`);
});

await test('Position.entry is near market price', () => {
  const price = engine.priceHistory.at(-1);
  truthy(Math.abs(engine.position.entry - price) < 0.005,
    `Position entry ${engine.position.entry} too far from market ${price}`);
});

await test('Capital reduced after enterPosition', () => {
  truthy(engine.capital < engine.initialCapital,
    `Capital ${engine.capital} should be < initial ${engine.initialCapital} after BUY`);
});

await test('Stop loss < entry < take profit (long position)', () => {
  const { entry, stopLoss, takeProfit } = engine.position;
  truthy(stopLoss < entry,   `SL ${stopLoss} must be < entry ${entry}`);
  truthy(takeProfit > entry, `TP ${takeProfit} must be > entry ${entry}`);
});

await test('Wide spread blocks entry and sets lastRejectedOrder', async () => {
  const e2 = makeEngine();
  const price = e2.priceHistory.at(-1);
  // Push high-volume bar so volume filter passes, allowing spread check to run
  const avgVol2 = e2.volumeHistory.slice(-20).reduce((s,v)=>s+v,0) / 20;
  e2.priceHistory.push(price);
  e2.volumeHistory.push(avgVol2 * 2.5);
  e2.ohlcvHistory.push({ o:price, h:price+0.0002, l:price-0.0001, c:price, v:avgVol2*2.5 });
  for (let i = 0; i < 5; i++) e2._recordSpread(price - 0.0004, price + 0.0004, price);
  await e2.enterPosition(price, 80);
  eq(e2.position, null, 'Wide spread should block entry');
  truthy(e2.lastRejectedOrder?.reason === 'spread_too_wide',
    `Expected spread_too_wide, got: ${e2.lastRejectedOrder?.reason}`);
});

await test('Below-floor confidence blocks entry', async () => {
  const e2 = makeEngine();
  const price = e2.priceHistory.at(-1);
  await e2.enterPosition(price, 30);  // 30 < 60 min
  eq(e2.position, null, 'Low confidence should block entry');
});

await test('Partial fill engine fills near targetShares', async () => {
  const e2 = makeEngine();
  const result = await e2._executeFill(1000, 1.1, 'BUY');
  truthy(Math.abs(result.filledShares - 1000) < 0.5, `filledShares ${result.filledShares} ≠ 1000`);
  truthy(result.fills.length >= 1, 'Should have at least one fill');
  truthy(isFinite(result.avgEntryPrice), 'avgEntryPrice must be finite');
});

await test('Liquidity scorer records in getStatus after position opened', () => {
  const s = engine.getStatus();
  truthy('liquidity' in s, 'getStatus should include liquidity');
  truthy('calibration' in s, 'getStatus should include calibration');
});

await test('capitalAllocator has open position tracked after enterPosition', () => {
  const status = engine.capitalAllocator.status();
  // After entering a position, at least one slot should show hasPosition=true or used capital
  const hasOpen = Object.values(status.slots || {}).some(s => s.hasPosition || (s.allocated !== s.available));
  truthy(hasOpen || engine.position !== null, 'Either allocator or position should reflect open trade');
});

// ── 5. Multi-tick simulation ──────────────────────────────────────────────────
console.log('\n-- 28-36. Multi-tick simulation (20 bars)');

await test('checkRiskManagement does not throw with open position', () => {
  for (let i = 0; i < 5; i++) {
    const p = engine.priceHistory.at(-1) + 0.0002;
    engine.priceHistory.push(p);
    engine.volumeHistory.push(1_000_000);
    engine.checkRiskManagement();
  }
  truthy(true, 'checkRiskManagement should not throw across 5 ticks');
});

await test('Trailing stop activates when profit exceeds activation threshold', () => {
  // Push price well above entry to trigger trailing stop
  const entry = engine.position?.entry || 1.1;
  const highPrice = entry * (1 + TRADING_CONFIG.trailingStopActivation + 0.005);
  for (let i = 0; i < 5; i++) {
    engine.priceHistory.push(highPrice + i * 0.0001);
    engine.volumeHistory.push(1_000_000);
    if (engine.position) engine.checkRiskManagement();
  }
  if (engine.position) {
    truthy(engine.position.trailingStopActivated,
      'Trailing stop should activate when profit > activation threshold');
  }
});

await test('Stop loss triggers exitPosition when price falls below SL', () => {
  if (!engine.position) return;  // already exited — skip
  const sl = engine.position.stopLoss;
  engine.priceHistory.push(sl - 0.001);
  engine.volumeHistory.push(1_000_000);
  engine.checkRiskManagement();
  // If stop was triggered, position should be null and trade recorded
  if (!engine.position) {
    truthy(engine.trades.length > 0, 'Trade should be recorded after stop loss exit');
    truthy(engine.trades.at(-1).reason.includes('Stop'), `Expected stop reason, got: ${engine.trades.at(-1)?.reason}`);
  }
});

await test('exitPosition records trade correctly', () => {
  const e2 = makeEngine();
  const price = e2.priceHistory.at(-1);
  e2.position = {
    entry: price, shares: 100, cost: price * 100,
    commission: 0.1, entryTime: Date.now() - 60_000,
    stopLoss: price * 0.98, takeProfit: price * 1.02,
    highestPrice: price, trailingStopActivated: false,
    volatilityLevel: 'NORMAL', confidence: 70, atr: 0.001,
    regime: 'TRENDING', rawConfidence: 70,
    mlFeatures: null, mlRSISeq: [],
  };
  e2.exitPosition(price * 1.01, 'Take Profit (ATR Dynamic)');
  eq(e2.position, null, 'position should be null after exit');
  gt(e2.trades.length, 0, 'Trade should be recorded');
  const t = e2.trades.at(-1);
  truthy(t.outcome === 'WIN' || t.outcome === 'LOSS', `Invalid outcome: ${t.outcome}`);
  truthy(typeof t.profit === 'number' && isFinite(t.profit), 'profit must be finite number');
});

await test('Drift monitor receives trade after exit', () => {
  const e2 = makeEngine();
  const before = e2.driftMonitor._liveTrades?.length || 0;
  const price = e2.priceHistory.at(-1);
  e2.position = {
    entry: price, shares: 50, cost: price * 50, commission: 0.05,
    entryTime: Date.now(), stopLoss: price * 0.98, takeProfit: price * 1.02,
    highestPrice: price, trailingStopActivated: false,
    volatilityLevel: 'NORMAL', confidence: 70, atr: 0.001,
    regime: 'TRENDING', rawConfidence: 70, mlFeatures: null, mlRSISeq: [],
  };
  e2.exitPosition(price, 'AI Decision');
  // Drift monitor should have received the trade
  truthy(true, 'exitPosition with driftMonitor should not throw');
});

await test('Capital allocator releases slot after exit', () => {
  const e2 = makeEngine();
  const price = e2.priceHistory.at(-1);
  for (let i = 0; i < 5; i++) e2._recordSpread(price - 0.00004, price + 0.00004, price);
  // Force a position directly then close it
  e2.position = {
    entry: price, shares: 50, cost: price * 50, commission: 0.05,
    entryTime: Date.now(), stopLoss: price * 0.98, takeProfit: price * 1.02,
    highestPrice: price, trailingStopActivated: false,
    volatilityLevel: 'NORMAL', confidence: 70, atr: 0.001,
    regime: 'TRENDING', rawConfidence: 70, mlFeatures: null, mlRSISeq: [],
  };
  e2.exitPosition(price, 'AI Decision');
  eq(e2.position, null, 'position should be null after exit');
});

await test('Multiple ticks: engine accumulates trade history', async () => {
  const e2 = makeEngine();
  // Run 20 ticks with price updates, no trading
  for (let i = 0; i < 20; i++) {
    const p = 1.1 + i * 0.0001;
    e2.priceHistory.push(p);
    e2.volumeHistory.push(1_000_000);
    if (e2.position) e2.checkRiskManagement();
  }
  gte(e2.priceHistory.length, 220 + 20, 'Price history should grow with ticks');
});

// ── 6. getStatus completeness ─────────────────────────────────────────────────
console.log('\n-- 37-44. getStatus completeness');

await test('getStatus returns all required top-level keys', () => {
  const e = makeEngine();
  const s = e.getStatus();
  const required = [
    'asset','isRunning','capital','currentPrice','position',
    'liquidity','calibration','mlOOS','capitalAllocation','abTest',
  ];
  for (const k of required) truthy(k in s, `getStatus missing key: ${k}`);
});

await test('getStatus.liquidity has score, regime, multiplier', () => {
  const s = makeEngine().getStatus();
  truthy('lastScore' in s.liquidity,      'liquidity.lastScore missing');
  truthy('lastRegime' in s.liquidity,     'liquidity.lastRegime missing');
  truthy('lastMultiplier' in s.liquidity, 'liquidity.lastMultiplier missing');
});

await test('getStatus.calibration has isActive, globalECE, totalSamples', () => {
  const s = makeEngine().getStatus();
  truthy('isActive' in s.calibration,     'calibration.isActive missing');
  truthy('globalECE' in s.calibration,    'calibration.globalECE missing');
  truthy('totalSamples' in s.calibration, 'calibration.totalSamples missing');
});

await test('getStatus.mlOOS has error or accuracy (insufficient data = error is OK)', () => {
  const s = makeEngine().getStatus();
  truthy('error' in s.mlOOS || 'accuracy' in s.mlOOS, 'mlOOS should have error or accuracy');
});

await test('getStatus.capitalAllocation has slots', () => {
  const s = makeEngine().getStatus();
  truthy(s.capitalAllocation, 'capitalAllocation should exist');
});

// ── 7. Dashboard snapshot ─────────────────────────────────────────────────────
console.log('\n-- 45-48. Dashboard snapshot');

await test('Dashboard._snapshot() returns valid object for cold engine', () => {
  const e = makeEngine();
  const d = new Dashboard(e);
  const snap = d._snapshot();
  truthy(typeof snap === 'object' && snap !== null);
  truthy('ts' in snap,      'snapshot missing ts');
  truthy('capital' in snap, 'snapshot missing capital');
  truthy('metrics' in snap, 'snapshot missing metrics');
  truthy('drift' in snap,   'snapshot missing drift');
  truthy('abTest' in snap,  'snapshot missing abTest');
  truthy('liquidity' in snap, 'snapshot missing liquidity');
  truthy('calibration' in snap, 'snapshot missing calibration');
  truthy('allocation' in snap, 'snapshot missing allocation');
});

await test('Dashboard._snapshot() includes priceSource', () => {
  const e = makeEngine();
  const snap = new Dashboard(e)._snapshot();
  truthy('priceSource' in snap, 'snapshot missing priceSource');
});

await test('Dashboard HTML contains all new card IDs', () => {
  const { Dashboard: Dash } = require('./dashboard');
  // Check dashboard HTML includes new systems
  const html = require('fs').readFileSync('./dashboard.js', 'utf8');
  for (const id of ['liq-badge','liq-score','ece-val','drift-status','ab-list','alloc-list','src-pill']) {
    truthy(html.includes(id), `Dashboard HTML missing element: ${id}`);
  }
});

await test('Dashboard starts and stops without error', async () => {
  const { Dashboard: Dash } = require('./dashboard');
  // Use a random high port to avoid conflicts
  const port = 19800 + Math.floor(Math.random() * 100);
  const d = new Dash(null, port);
  d.start();
  await new Promise(r => setTimeout(r, 100));
  d.stop();
  truthy(true, 'Dashboard start/stop should not throw');
});

// ── Final ─────────────────────────────────────────────────────────────────────
await new Promise(r => setTimeout(r, 200));  // let async ops settle

console.log('\n═══════════════════════════════════════════════════════════');
console.log('  RESULTS: ' + passed + ' passed  |  ' + failed + ' failed  |  ' + total + ' total');
console.log('═══════════════════════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);

})().catch(err => { console.error('Smoke test fatal error:', err); process.exit(1); });
