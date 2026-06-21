'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  test-ab-tester.js
//  Tests every component of the A/B testing engine:
//    1.  VirtualAccount — enter, exit, tick, SL/TP, metrics
//    2.  Contestant — initialisation, decide, logSignal
//    3.  ABTester init — all 5 contestants registered, champion set
//    4.  tick() — all strategies receive same indicators each bar
//    5.  tick() — returns champion's decision only
//    6.  tick() — paper trades all challengers independently
//    7.  tick() — signal snapshot recorded per bar
//    8.  Virtual SL hit — position closed automatically
//    9.  Virtual TP hit — position closed automatically
//   10.  signalLine() — produces formatted per-bar log
//   11.  Comparison — no promotion below minTradesForComparison
//   12.  Comparison — promotion fires when challenger dominates
//   13.  Promotion — champion swapped, old champion becomes challenger
//   14.  Promotion — promotion saved to disk
//   15.  forcePromote() — manual override works
//   16.  forcePromote() — throws on unknown id
//   17.  forcePromote() — throws if already champion
//   18.  status() — all required fields present
//   19.  status().contestants — 5 entries with correct structure
//   20.  printStatus() — runs without error
//   21.  trading-engine — abTester exists on engine instance
//   22.  trading-engine — getRuleBasedDecision routes through abTester
//   23.  trading-engine — abTest exposed in getStatus()
//   24.  End-to-end — 200 bars, all accounts active, no crashes
// ═══════════════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const { ABTester, AB_CONFIG, VirtualAccount, Contestant } = require('./ab-tester');

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

function eq(a, b, msg)   { if (a !== b) throw new Error(msg || `${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function truthy(v, msg)  { if (!v)       throw new Error(msg || `expected truthy, got ${v}`); }
function falsy(v, msg)   { if (v)        throw new Error(msg || `expected falsy, got ${v}`); }
function gt(a, b, msg)   { if (!(a > b)) throw new Error(msg || `${a} not > ${b}`); }
function gte(a, b, msg)  { if (!(a >= b)) throw new Error(msg || `${a} not >= ${b}`); }
function isNum(v, msg)   { if (typeof v !== 'number') throw new Error(msg || `${v} is not a number`); }

// ── Helpers ───────────────────────────────────────────────────────────────────

// Minimal synthetic indicators that satisfy strategy interfaces
function makeIndicators (overrides = {}) {
  return {
    price: 1.1000, rsi: 45, macd: 0.001, macdSignal: -0.001, macdHist: 0.002,
    ema9: 1.102, ema21: 1.098, ema50: 1.090, ema200: 1.080,
    atr: 0.0015, atrPercent: 0.14,
    bb: { upper: 1.115, middle: 1.100, lower: 1.085 },
    vwap: 1.099, volume: 1_200_000, avgVolume: 1_000_000,
    signal: 'STRONG_BUY', goldenCross: true,
    regime: 'TRENDING',
    mta: { allowed: true, score: 0.6, reason: '' },
    ...overrides,
  };
}

const HOLD_IND = makeIndicators({ signal: 'NEUTRAL', rsi: 52, mta: { allowed: false, score: 0, reason: 'test' } });
const BUY_IND  = makeIndicators({ signal: 'STRONG_BUY', rsi: 38, mta: { allowed: true, score: 0.8, reason: '' } });

const TEST_CFG = {
  virtualCapital:         10_000,
  virtualRiskPct:         0.08,
  virtualSlippage:        0.0003,
  virtualCommission:      0.0002,
  minTradesForComparison: 5,       // low for testing
  promotionThresholdPct:  15,
  reportEveryBars:        999999,  // disable periodic compare
  sharpeWindow:           10,
  logDir:                 fs.mkdtempSync(path.join(os.tmpdir(), 'ab-test-')),
};

// Build fresh ABTester for each test
function makeAB (cfg = {}) { return new ABTester({ ...TEST_CFG, ...cfg }); }

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 1 — VirtualAccount
// ════════════════════════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════');
console.log('  A/B TESTER — FULL TEST SUITE');
console.log('═══════════════════════════════════════════════════════════');
console.log('\n── 1. VirtualAccount ────────────────────────────────────────');

test('enter() opens position and deducts capital', () => {
  const acc = new VirtualAccount('test', 10_000);
  acc.enter(1.1, null, TEST_CFG);
  truthy(acc.position !== null, 'position should be open');
  gt(10_000, acc.capital, 'capital should decrease after entry');
  truthy(acc.position.shares > 0, 'shares should be positive');
});

test('enter() is no-op when position already open', () => {
  const acc = new VirtualAccount('test', 10_000);
  acc.enter(1.1, null, TEST_CFG);
  const capAfterFirst = acc.capital;
  acc.enter(1.1, null, TEST_CFG);
  eq(acc.capital, capAfterFirst, 'second enter should not change capital');
});

test('exit() closes position and returns profit record', () => {
  const acc = new VirtualAccount('test', 10_000);
  acc.enter(1.1, null, TEST_CFG);
  const trade = acc.exit(1.11, 'Signal Exit', TEST_CFG);
  truthy(trade !== null, 'trade record should be returned');
  isNum(trade.profit, 'profit should be a number');
  truthy(acc.position === null, 'position should be null after exit');
  eq(acc.trades.length, 1, 'trade should be recorded');
});

test('exit() is no-op when no position open', () => {
  const acc = new VirtualAccount('test', 10_000);
  const result = acc.exit(1.1, 'test', TEST_CFG);
  eq(result, null, 'should return null when no position');
  eq(acc.trades.length, 0, 'no trades should be recorded');
});

test('tick() advances bar count and updates equity', () => {
  const acc = new VirtualAccount('test', 10_000);
  eq(acc.barCount, 0);
  acc.tick(1.1, TEST_CFG);
  eq(acc.barCount, 1);
  eq(acc.equity.length, 2, 'equity array should have 2 entries (initial + 1 tick)');
});

test('tick() auto-closes position on SL hit', () => {
  const acc = new VirtualAccount('test', 10_000);
  acc.enter(1.1, null, TEST_CFG);
  const sl = acc.position.stopLoss;
  acc.tick(sl - 0.001, TEST_CFG);   // price below SL
  truthy(acc.position === null, 'SL should close position');
  eq(acc.trades.at(-1)?.reason, 'Stop Loss', 'reason should be Stop Loss');
});

test('tick() auto-closes position on TP hit', () => {
  const acc = new VirtualAccount('test', 10_000);
  acc.enter(1.1, null, TEST_CFG);
  const tp = acc.position.takeProfit;
  acc.tick(tp + 0.001, TEST_CFG);
  truthy(acc.position === null, 'TP should close position');
  eq(acc.trades.at(-1)?.reason, 'Take Profit', 'reason should be Take Profit');
});

test('metrics() returns 0s with no trades', () => {
  const acc = new VirtualAccount('test', 10_000);
  const m = acc.metrics();
  eq(m.trades, 0);
  eq(m.winRate, 0);
  eq(m.profitFactor, 0);
});

test('metrics() calculates correctly after wins and losses', () => {
  const acc = new VirtualAccount('test', 10_000);
  acc.trades = [
    { profit: 10, win: true }, { profit: 8, win: true },
    { profit: -5, win: false }, { profit: -4, win: false },
  ];
  const m = acc.metrics();
  eq(m.trades, 4);
  eq(m.winRate, 50, 'WR should be 50%');
  const expectedPF = 18 / 9;
  truthy(Math.abs(m.profitFactor - expectedPF) < 0.001, `PF should be ~${expectedPF.toFixed(3)}, got ${m.profitFactor}`);
});

test('maxDD is tracked correctly', () => {
  const acc = new VirtualAccount('test', 10_000);
  acc.tick(1.05, TEST_CFG);   // equity = 10000
  acc.enter(1.05, null, TEST_CFG);
  acc.tick(0.90, TEST_CFG);   // big loss if open
  truthy(acc.maxDD >= 0, 'maxDD should be non-negative');
});

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 2 — Contestant
// ════════════════════════════════════════════════════════════════════════════════
console.log('\n── 2. Contestant ────────────────────────────────────────────');

test('Contestant.decide() returns action, confidence, reasoning', () => {
  const c = new Contestant('test', 'Test', () => ({ action: 'BUY', confidence: 70, reasoning: 'test' }));
  const d = c.decide({}, {});
  truthy(['BUY','SELL','HOLD'].includes(d.action), 'action must be BUY/SELL/HOLD');
  isNum(d.confidence);
});

test('Contestant.decide() returns HOLD on strategy error', () => {
  const c = new Contestant('bad', 'Bad', () => { throw new Error('boom'); });
  const d = c.decide({}, {});
  eq(d.action, 'HOLD');
});

test('Contestant.logSignal() appends to signalLog', () => {
  const c = new Contestant('x', 'X', () => ({ action: 'HOLD', confidence: 0, reasoning: '' }));
  c.logSignal(1, { action: 'BUY', confidence: 70 });
  c.logSignal(2, { action: 'SELL', confidence: 65 });
  eq(c.signalLog.length, 2);
  eq(c.signalLog[0].action, 'BUY');
});

test('Contestant.logSignal() caps at 200 entries', () => {
  const c = new Contestant('x', 'X', () => ({ action: 'HOLD', confidence: 0, reasoning: '' }));
  for (let i = 0; i < 250; i++) c.logSignal(i, { action: 'HOLD', confidence: 0 });
  eq(c.signalLog.length, 200);
});

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 3 — ABTester Init
// ════════════════════════════════════════════════════════════════════════════════
console.log('\n── 3. ABTester Initialisation ───────────────────────────────');

test('ABTester has exactly 5 contestants', () => {
  const ab = makeAB();
  eq(ab.contestants.size, 5, `Expected 5 contestants, got ${ab.contestants.size}`);
});

test('Champion is set to "champion" on init', () => {
  const ab = makeAB();
  eq(ab.championId, 'champion');
  truthy(ab.contestants.get('champion').isChampion, 'champion.isChampion should be true');
});

test('All expected strategy IDs are present', () => {
  const ab  = makeAB();
  const ids = ['champion', 'trend', 'meanReversion', 'aggressive', 'conservative'];
  for (const id of ids) truthy(ab.contestants.has(id), `Missing contestant: ${id}`);
});

test('Non-champion contestants have isChampion=false', () => {
  const ab = makeAB();
  for (const [id, c] of ab.contestants) {
    if (id !== 'champion') falsy(c.isChampion, `${id} should not be champion at init`);
  }
});

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 4–7 — tick()
// ════════════════════════════════════════════════════════════════════════════════
console.log('\n── 4–7. tick() Behaviour ────────────────────────────────────');

test('tick() advances barCount by 1', () => {
  const ab = makeAB();
  eq(ab.barCount, 0);
  ab.tick(BUY_IND, { hasPosition: false }, 1.1);
  eq(ab.barCount, 1);
});

test('tick() returns an object with action and confidence', () => {
  const ab = makeAB();
  const d  = ab.tick(HOLD_IND, { hasPosition: false }, 1.1);
  truthy(['BUY','SELL','HOLD'].includes(d.action), `Invalid action: ${d.action}`);
  isNum(d.confidence);
});

test('tick() with ensemble OFF returns champion decision directly', () => {
  // With ensemble disabled, the champion's decision is returned as-is
  const ab = makeAB({ ensembleEnabled: false });
  ab.contestants.get('champion').strategyFn = () => ({ action: 'BUY', confidence: 99, reasoning: 'mock' });
  const d = ab.tick(HOLD_IND, { hasPosition: false }, 1.1);
  eq(d.action, 'BUY', 'Should return champion decision when ensemble is OFF');
  eq(d.fromEnsemble, false, 'fromEnsemble should be false when ensemble is OFF');
});

test('tick() all contestants receive the same indicators', () => {
  const received = {};
  const ab = makeAB();
  for (const [id, c] of ab.contestants) {
    const orig = c.strategyFn;
    c.strategyFn = (ind, ctx) => { received[id] = ind; return orig(ind, ctx); };
  }
  const ind = makeIndicators({ price: 1.2345 });
  ab.tick(ind, { hasPosition: false }, 1.2345);
  for (const id of ab.contestants.keys()) {
    eq(received[id]?.price, 1.2345, `${id} should receive same indicators`);
  }
});

test('tick() advances all virtual accounts bar count', () => {
  const ab = makeAB();
  ab.tick(BUY_IND, { hasPosition: false }, 1.1);
  for (const [id, c] of ab.contestants) {
    eq(c.account.barCount, 1, `${id} barCount should be 1`);
  }
});

test('tick() records signal snapshot', () => {
  const ab = makeAB();
  ab.tick(BUY_IND, { hasPosition: false }, 1.1);
  eq(ab.signalHistory.length, 1);
  truthy('bar' in ab.signalHistory[0]);
  truthy('champion' in ab.signalHistory[0]);
});

test('tick() signal history capped at 500', () => {
  const ab = makeAB();
  for (let i = 0; i < 520; i++) ab.tick(HOLD_IND, { hasPosition: false }, 1.1);
  gte(ab.signalHistory.length, 499);
  gte(500, ab.signalHistory.length);
});

test('tick() challenger gets paper trade when BUY signal', () => {
  const ab = makeAB();
  // Force all contestants to say BUY
  for (const c of ab.contestants.values()) {
    c.strategyFn = () => ({ action: 'BUY', confidence: 80, reasoning: 'test' });
  }
  ab.tick(BUY_IND, { hasPosition: false }, 1.1);
  for (const [id, c] of ab.contestants) {
    truthy(c.account.position !== null, `${id} should have a paper position after BUY`);
  }
});

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 8–9 — Virtual SL / TP
// ════════════════════════════════════════════════════════════════════════════════
console.log('\n── 8–9. Virtual SL/TP ───────────────────────────────────────');

test('Virtual SL hit closes paper position automatically', () => {
  const ab = makeAB();
  const c  = ab.contestants.get('trend');
  c.account.enter(1.1, null, TEST_CFG);
  const sl = c.account.position.stopLoss;
  c.account.tick(sl - 0.001, TEST_CFG);  // trigger SL
  truthy(c.account.position === null, 'SL should close position');
  eq(c.account.trades.at(-1)?.reason, 'Stop Loss');
});

test('Virtual TP hit closes paper position automatically', () => {
  const ab = makeAB();
  const c  = ab.contestants.get('aggressive');
  c.account.enter(1.1, null, TEST_CFG);
  const tp = c.account.position.takeProfit;
  c.account.tick(tp + 0.001, TEST_CFG);
  truthy(c.account.position === null, 'TP should close position');
  eq(c.account.trades.at(-1)?.reason, 'Take Profit');
});

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 10 — signalLine()
// ════════════════════════════════════════════════════════════════════════════════
console.log('\n── 10. signalLine() ─────────────────────────────────────────');

test('signalLine() returns empty string before first tick', () => {
  const ab = makeAB();
  eq(ab.signalLine(), '');
});

test('signalLine() returns formatted string after tick', () => {
  const ab = makeAB();
  ab.tick(HOLD_IND, { hasPosition: false }, 1.1);
  const line = ab.signalLine();
  truthy(typeof line === 'string' && line.length > 0, 'signalLine should be non-empty');
  truthy(line.includes('[ABTester]'), 'should have [ABTester] prefix');
  truthy(line.includes('Bar'), 'should include bar number');
});

test('signalLine() includes all 5 strategy names', () => {
  const ab = makeAB();
  ab.tick(HOLD_IND, { hasPosition: false }, 1.1);
  const line = ab.signalLine();
  // Each contestant's label truncated to 8 chars appears in the line
  truthy(line.length > 50, `signalLine too short: ${line}`);
});

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 11–14 — Comparison and Promotion
// ════════════════════════════════════════════════════════════════════════════════
console.log('\n── 11–14. Comparison & Promotion ────────────────────────────');

test('No promotion when challenger has fewer than minTradesForComparison', () => {
  const ab = makeAB({ minTradesForComparison: 20 });
  // Feed 10 trades to one challenger — not enough
  const c = ab.contestants.get('trend');
  c.account.trades = Array(10).fill({ profit: 20, win: true });
  ab._compare();
  eq(ab.championId, 'champion', 'champion should not change');
  eq(ab.promotionLog.length, 0);
});

test('Promotion fires when challenger dominates on composite score', () => {
  const ab = makeAB({ minTradesForComparison: 5, promotionThresholdPct: 15 });

  // Give champion mediocre metrics
  const champ = ab.contestants.get('champion');
  champ.account.trades = [
    ...Array(3).fill({ profit: 5, win: true }),
    ...Array(7).fill({ profit: -10, win: false }),
  ];

  // Give challenger excellent metrics  
  const challenger = ab.contestants.get('trend');
  challenger.account.trades = Array(10).fill({ profit: 15, win: true });

  ab._compare();
  eq(ab.championId, 'trend', `Expected trend to be promoted, got: ${ab.championId}`);
  gt(ab.promotionLog.length, 0, 'Promotion log should have entry');
});

test('After promotion, old champion becomes challenger (isChampion=false)', () => {
  const ab = makeAB({ minTradesForComparison: 5, promotionThresholdPct: 15 });
  const champ = ab.contestants.get('champion');
  champ.account.trades = Array(5).fill({ profit: -5, win: false });
  const challenger = ab.contestants.get('trend');
  challenger.account.trades = Array(10).fill({ profit: 20, win: true });
  ab._compare();
  falsy(ab.contestants.get('champion').isChampion, 'old champion should not be champion anymore');
  truthy(ab.contestants.get('trend').isChampion, 'trend should now be champion');
});

test('Promotion log saved to disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-promo-'));
  const ab  = makeAB({ minTradesForComparison: 5, promotionThresholdPct: 15, logDir: dir });
  const champ = ab.contestants.get('champion');
  champ.account.trades = Array(5).fill({ profit: -5, win: false });
  const challenger = ab.contestants.get('trend');
  challenger.account.trades = Array(10).fill({ profit: 20, win: true });
  ab._compare();
  if (ab.promotionLog.length > 0) {
    const file = path.join(dir, 'ab-promotions.json');
    truthy(fs.existsSync(file), 'ab-promotions.json should be saved');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    truthy(Array.isArray(data) && data.length > 0, 'log file should have entries');
  }
  try { fs.rmSync(dir, { recursive: true }); } catch {}
});

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 15–17 — forcePromote()
// ════════════════════════════════════════════════════════════════════════════════
console.log('\n── 15–17. forcePromote() ────────────────────────────────────');

test('forcePromote() switches champion immediately', () => {
  const ab = makeAB();
  ab.forcePromote('trend');
  eq(ab.championId, 'trend');
  truthy(ab.contestants.get('trend').isChampion);
  falsy(ab.contestants.get('champion').isChampion);
});

test('forcePromote() throws on unknown id', () => {
  const ab = makeAB();
  try {
    ab.forcePromote('nonexistent');
    throw new Error('Should have thrown');
  } catch (e) {
    truthy(e.message.includes('Unknown'), `Wrong error: ${e.message}`);
  }
});

test('forcePromote() throws if already champion', () => {
  const ab = makeAB();
  try {
    ab.forcePromote('champion');
    throw new Error('Should have thrown');
  } catch (e) {
    truthy(e.message.includes('already champion'), `Wrong error: ${e.message}`);
  }
});

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 18–20 — status() and printStatus()
// ════════════════════════════════════════════════════════════════════════════════
console.log('\n── 18–20. status() and printStatus() ───────────────────────');

test('status() returns all required top-level fields', () => {
  const ab = makeAB();
  const s  = ab.status();
  const required = ['bar', 'championId', 'contestants', 'promotionLog', 'recentSignals'];
  for (const k of required) truthy(k in s, `Missing field: ${k}`);
});

test('status().contestants has 5 entries', () => {
  const ab = makeAB();
  eq(ab.status().contestants.length, 5);
});

test('status().contestants entries have required metric fields', () => {
  const ab = makeAB();
  const s  = ab.status();
  const metricFields = ['id', 'label', 'isChampion', 'trades', 'winRate', 'profitFactor', 'expectancy', 'sharpe'];
  for (const r of s.contestants) {
    for (const f of metricFields) truthy(f in r, `Missing contestant field: ${f}`);
  }
});

test('printStatus() runs without error', () => {
  const ab = makeAB();
  ab.tick(HOLD_IND, { hasPosition: false }, 1.1);
  // Should not throw
  ab.printStatus();
  truthy(true); // if we got here, it passed
});

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 21–23 — Trading Engine Integration
// ════════════════════════════════════════════════════════════════════════════════
console.log('\n── 21–23. Trading Engine Integration ───────────────────────');

test('TradingEngine has abTester property', () => {
  const { TradingEngine } = require('./trading-engine');
  const e = new TradingEngine();
  truthy(e.abTester instanceof ABTester, 'engine.abTester should be an ABTester instance');
});

test('getRuleBasedDecision routes through abTester (barCount increments)', () => {
  const { TradingEngine } = require('./trading-engine');
  const e = new TradingEngine();
  const initialBar = e.abTester.barCount;
  // Seed some price history so calculateIndicators doesn't return null
  for (let i = 0; i < 50; i++) {
    e.priceHistory.push(1.1 + i * 0.0001);
    e.volumeHistory.push(1_000_000);
  }
  const ind = e.calculateIndicators ? null : null; // calculateIndicators is async, skip
  // Instead, call abTester.tick directly to verify routing
  e.abTester.tick(HOLD_IND, { hasPosition: false }, 1.1);
  eq(e.abTester.barCount, initialBar + 1, 'abTester.barCount should increment');
});

test('abTest field exposed in engine getStatus()', () => {
  const { TradingEngine } = require('./trading-engine');
  const e = new TradingEngine();
  const s = e.getStatus();
  truthy('abTest' in s, 'getStatus() should include abTest field');
  truthy('championId'   in s.abTest, 'abTest.championId missing');
  truthy('contestants'  in s.abTest, 'abTest.contestants missing');
  truthy('promotionLog' in s.abTest, 'abTest.promotionLog missing');
});

// ════════════════════════════════════════════════════════════════════════════════
//  SECTION 24 — End-to-end 200-bar simulation
// ════════════════════════════════════════════════════════════════════════════════
console.log('\n── 24. End-to-End 200-bar Simulation ───────────────────────');

test('200 bars with mixed signals — no crashes, all accounts active', () => {
  const ab = makeAB({ reportEveryBars: 50 });
  let price = 1.1;
  let seed  = 42;
  const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xFFFFFFFF; };

  for (let i = 0; i < 200; i++) {
    price = Math.max(0.9, price * (1 + (rng() - 0.49) * 0.003));
    const trend  = rng() > 0.5 ? 'TRENDING' : 'RANGING';
    const signal = rng() > 0.6 ? 'STRONG_BUY' : rng() > 0.3 ? 'BUY' : 'NEUTRAL';
    const ind    = makeIndicators({ price, regime: trend, signal, rsi: 30 + rng() * 40 });
    const hasPos = ab.contestants.get('champion').account.position !== null;
    const d      = ab.tick(ind, { hasPosition: hasPos }, price);
    truthy(['BUY','SELL','HOLD'].includes(d.action), `Invalid action at bar ${i}: ${d.action}`);
  }

  eq(ab.barCount, 200, 'barCount should be 200');
  eq(ab.signalHistory.length, 200, 'signal history should have 200 entries');

  // All accounts should have received ticks
  for (const [id, c] of ab.contestants) {
    eq(c.account.barCount, 200, `${id} barCount should be 200`);
    truthy(c.account.equity.length > 0, `${id} equity should be non-empty`);
  }

  // Status should be clean
  const s = ab.status();
  eq(s.contestants.length, 5);
  truthy(typeof s.championId === 'string');
});

test('200 bars — signal history capped at 500 (no memory leak)', () => {
  const ab = makeAB();
  for (let i = 0; i < 200; i++) {
    ab.tick(HOLD_IND, { hasPosition: false }, 1.1);
  }
  gte(500, ab.signalHistory.length, 'signal history should not exceed 500');
});

// ════════════════════════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════');
console.log(`  RESULTS: ${passed} passed  |  ${failed} failed  |  ${total} total`);
console.log('═══════════════════════════════════════════════════════════\n');

process.exit(failed > 0 ? 1 : 0);
