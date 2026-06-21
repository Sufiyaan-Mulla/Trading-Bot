'use strict';

const os   = require('os');
const path = require('path');
const { CapitalAllocator, StrategySlot, ALLOC_CONFIG } = require('./capital-allocator');

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
function near(a, b, t, m){ if (Math.abs(a - b) > t) throw new Error(m || Math.abs(a-b) + ' > tol ' + t); }

const TMP_DIR = os.tmpdir();

function makeAlloc(opts) {
  return new CapitalAllocator({ totalCapital: 10_000, logDir: TMP_DIR, ...opts });
}

console.log('\n=====================================================');
console.log('  CAPITAL ALLOCATOR -- FULL TEST SUITE');
console.log('=====================================================');

// ── StrategySlot ─────────────────────────────────────────────────────────────
console.log('\n-- 1-6. StrategySlot');

test('Initialises with correct capital fraction', () => {
  const sl = new StrategySlot('trend', 0.4, 10_000);
  near(sl.capital, 4_000, 0.01, 'capital should be 4000');
  eq(sl.currentWeight, 0.4);
  eq(sl.id, 'trend');
});

test('hasPosition false when no position open', () => {
  const sl = new StrategySlot('trend', 0.33, 10_000);
  falsy(sl.hasPosition, 'should not have position initially');
});

test('hasPosition true when position set', () => {
  const sl = new StrategySlot('trend', 0.33, 10_000);
  sl.position = { entry: 1.1, shares: 10, cost: 1000 };
  truthy(sl.hasPosition);
});

test('metrics returns zeros with no trades', () => {
  const sl = new StrategySlot('trend', 0.33, 10_000);
  const m  = sl.metrics();
  eq(m.trades, 0);
  eq(m.winRate, 0);
  eq(m.profitFactor, 0);
});

test('metrics calculates correctly after trades', () => {
  const sl = new StrategySlot('trend', 0.33, 10_000);
  sl.trades = [
    { profit: 10, win: true }, { profit: 8, win: true },
    { profit: -5, win: false }, { profit: -3, win: false },
  ];
  const m = sl.metrics();
  eq(m.trades, 4);
  eq(m.winRate, 50, 'WR should be 50%');
  near(m.profitFactor, 18 / 8, 0.001, 'PF should be 2.25');
});

test('compositeScore returns 0 with no trades', () => {
  const sl = new StrategySlot('trend', 0.33, 10_000);
  eq(sl.compositeScore(), 0);
});

// ── CapitalAllocator init ─────────────────────────────────────────────────────
console.log('\n-- 7-11. CapitalAllocator init');

test('Creates 3 default slots (trend, meanReversion, ensemble)', () => {
  const a = makeAlloc();
  eq(a.slots.size, 3);
  truthy(a.slots.has('trend'));
  truthy(a.slots.has('meanReversion'));
  truthy(a.slots.has('ensemble'));
});

test('Default weights sum to 1.0', () => {
  const a = makeAlloc();
  const sum = [...a.slots.values()].reduce((s, sl) => s + sl.currentWeight, 0);
  near(sum, 1.0, 0.0001, 'Weights should sum to 1.0, got ' + sum);
});

test('Total slot capitals sum to totalCapital', () => {
  const a = makeAlloc({ totalCapital: 9_000 });
  const sum = [...a.slots.values()].reduce((s, sl) => s + sl.capital, 0);
  near(sum, 9_000, 1, 'Slot capitals should sum to totalCapital');
});

test('Custom initialWeights respected', () => {
  const a = makeAlloc({
    initialWeights: { trend: 0.5, meanReversion: 0.3, ensemble: 0.2 },
  });
  near(a.slots.get('trend').currentWeight, 0.5, 0.001);
  near(a.slots.get('meanReversion').currentWeight, 0.3, 0.001);
  near(a.slots.get('ensemble').currentWeight, 0.2, 0.001);
});

test('totalCapital stored correctly', () => {
  const a = makeAlloc({ totalCapital: 12_345 });
  eq(a.totalCapital, 12_345);
});

// ── canEnter ──────────────────────────────────────────────────────────────────
console.log('\n-- 12-20. canEnter');

test('Returns allowed=true for empty slot with capital', () => {
  const a = makeAlloc();
  const r = a.canEnter('trend', 70);
  truthy(r.allowed, 'Should allow entry: ' + r.reason);
});

test('Returns allowed=false for unknown strategy', () => {
  const a = makeAlloc();
  const r = a.canEnter('nonexistent', 70);
  falsy(r.allowed);
  truthy(r.reason.includes('Unknown'), 'Reason should mention Unknown');
});

test('Returns allowed=false when slot already has a position', () => {
  const a = makeAlloc();
  a.openPosition('trend', { cost: 500, entry: 1.1, shares: 10 });
  const r = a.canEnter('trend', 70);
  falsy(r.allowed);
  truthy(r.reason.includes('already open'));
});

test('Returns allowed=false when slot has no capital', () => {
  const a = makeAlloc();
  a.slots.get('trend').capital = 0;
  const r = a.canEnter('trend', 70);
  falsy(r.allowed);
  truthy(r.reason.includes('No capital'));
});

test('maxSize respects confidence scaling', () => {
  const a = makeAlloc({ totalCapital: 9_000 });
  const rLow  = a.canEnter('trend', 60);
  const rHigh = a.canEnter('trend', 100);
  truthy(rLow.allowed && rHigh.allowed, 'Both should be allowed');
  lte(rLow.maxSize, rHigh.maxSize, 'Low confidence should give smaller maxSize');
});

test('maxSize does not exceed slot capital', () => {
  const a = makeAlloc();
  const r = a.canEnter('trend', 100);
  const slot = a.slots.get('trend');
  lte(r.maxSize, slot.capital + 0.01, 'maxSize should not exceed slot capital');
});

test('Portfolio exposure cap blocks entry when fully exposed', () => {
  const a = makeAlloc({ maxExposurePct: 0.5, totalCapital: 10_000 });
  // Fill exposure using meanReversion and ensemble (not trend)
  // so trend has no open position but cap is still hit
  a.openPosition('meanReversion', { cost: 2_600, entry: 1.1, shares: 1 });
  a.openPosition('ensemble',      { cost: 2_600, entry: 1.1, shares: 1 });
  // Total exposure = 5200 >= 10000 * 0.5 = 5000 → cap reached
  const r = a.canEnter('trend', 70);
  falsy(r.allowed, 'Should block when exposure cap reached. Got: ' + r.reason);
  truthy(r.reason.includes('cap') || r.reason.includes('Cap') || r.reason.includes('exposure'), 'Reason should mention cap, got: ' + r.reason);
});

test('Returns slotCapital and slotWeight in allowed result', () => {
  const a = makeAlloc();
  const r = a.canEnter('trend', 70);
  truthy('slotCapital' in r, 'Missing slotCapital');
  truthy('slotWeight'  in r, 'Missing slotWeight');
});

test('Returns reason=OK when entry is allowed', () => {
  const a = makeAlloc();
  const r = a.canEnter('trend', 70);
  eq(r.reason, 'OK');
});

// ── openPosition / closePosition ──────────────────────────────────────────────
console.log('\n-- 21-29. openPosition / closePosition');

test('openPosition sets slot.position', () => {
  const a = makeAlloc();
  a.openPosition('trend', { cost: 500, entry: 1.1, shares: 10 });
  truthy(a.slots.get('trend').hasPosition, 'position should be set');
});

test('openPosition throws for unknown strategy', () => {
  const a = makeAlloc();
  try {
    a.openPosition('nonexistent', { cost: 100 });
    throw new Error('should have thrown');
  } catch(e) {
    truthy(e.message.includes('Unknown'));
  }
});

test('closePosition clears slot.position', () => {
  const a = makeAlloc();
  a.openPosition('trend', { cost: 500, entry: 1.1, shares: 10 });
  a.closePosition('trend', 50);
  falsy(a.slots.get('trend').hasPosition, 'position should be cleared');
});

test('closePosition updates slot capital with profit', () => {
  const a = makeAlloc();
  const initialCapital = a.slots.get('trend').capital;
  a.openPosition('trend', { cost: 500, entry: 1.1, shares: 10 });
  a.closePosition('trend', 100);
  near(a.slots.get('trend').capital, initialCapital + 100, 1, 'capital should increase by profit');
});

test('closePosition updates slot capital with loss', () => {
  const a = makeAlloc();
  const initialCapital = a.slots.get('trend').capital;
  a.openPosition('trend', { cost: 500, entry: 1.1, shares: 10 });
  a.closePosition('trend', -50);
  near(a.slots.get('trend').capital, initialCapital - 50, 1, 'capital should decrease by loss');
});

test('closePosition records trade in slot.trades', () => {
  const a = makeAlloc();
  a.openPosition('trend', { cost: 500, entry: 1.1, shares: 10 });
  a.closePosition('trend', 75);
  eq(a.slots.get('trend').trades.length, 1);
  eq(a.slots.get('trend').trades[0].profit, 75);
});

test('closePosition increments tradesSinceRebalance', () => {
  const a = makeAlloc({ rebalanceEveryNTrades: 999 });
  a.openPosition('trend', { cost: 200, entry: 1.1, shares: 1 });
  a.closePosition('trend', 10);
  eq(a.tradesSinceRebalance, 1);
});

test('closePosition is no-op when no position open', () => {
  const a = makeAlloc();
  const before = a.slots.get('trend').capital;
  a.closePosition('trend', 999);
  eq(a.slots.get('trend').capital, before, 'capital should not change when no position');
});

test('totalPnL accumulates correctly across multiple trades', () => {
  const a = makeAlloc();
  a.openPosition('trend', { cost: 200, entry: 1.1, shares: 1 });
  a.closePosition('trend', 20);
  a.openPosition('trend', { cost: 200, entry: 1.1, shares: 1 });
  a.closePosition('trend', -10);
  near(a.slots.get('trend').totalPnL, 10, 0.01, 'totalPnL should be 10');
});

// ── Rebalancing ───────────────────────────────────────────────────────────────
console.log('\n-- 30-38. Rebalancing');

test('No rebalance before minTradesForRebalancing', () => {
  const a = makeAlloc({ minTradesForRebalancing: 10, rebalanceEveryNTrades: 5 });
  for (let i = 0; i < 5; i++) {
    a.openPosition('trend', { cost: 100, entry: 1.1, shares: 1 });
    a.closePosition('trend', 5);
  }
  eq(a.rebalanceLog.length, 0, 'Should not rebalance before minTrades');
});

test('Rebalance fires after rebalanceEveryNTrades when eligible', () => {
  const a = makeAlloc({ minTradesForRebalancing: 3, rebalanceEveryNTrades: 3 });
  for (let i = 0; i < 3; i++) {
    a.openPosition('trend', { cost: 100, entry: 1.1, shares: 1 });
    a.closePosition('trend', 5);
  }
  gt(a.rebalanceLog.length, 0, 'Should have rebalanced after 3 trades');
});

test('After rebalance, tradesSinceRebalance resets to 0', () => {
  const a = makeAlloc({ minTradesForRebalancing: 3, rebalanceEveryNTrades: 3 });
  for (let i = 0; i < 3; i++) {
    a.openPosition('trend', { cost: 100, entry: 1.1, shares: 1 });
    a.closePosition('trend', 5);
  }
  eq(a.tradesSinceRebalance, 0, 'tradesSinceRebalance should reset after rebalance');
});

test('Weights remain between minWeight and maxWeight after rebalance', () => {
  const a = makeAlloc({ minTradesForRebalancing: 3, rebalanceEveryNTrades: 3, minWeight: 0.1, maxWeight: 0.6 });
  // Give trend excellent performance to drive weight up
  const trend = a.slots.get('trend');
  trend.trades = Array(10).fill({ profit: 20, win: true });
  // Give others poor performance
  for (const id of ['meanReversion', 'ensemble']) {
    a.slots.get(id).trades = Array(10).fill({ profit: -5, win: false });
  }
  a._rebalance('test');
  for (const sl of a.slots.values()) {
    gte(sl.currentWeight, 0.1 - 0.001, 'Weight below minWeight for ' + sl.id);
    lte(sl.currentWeight, 0.6 + 0.001, 'Weight above maxWeight for ' + sl.id);
  }
});

test('Weights still sum to 1.0 after rebalance', () => {
  const a = makeAlloc({ minTradesForRebalancing: 3, rebalanceEveryNTrades: 3 });
  const trend = a.slots.get('trend');
  trend.trades = Array(5).fill({ profit: 15, win: true });
  a.slots.get('meanReversion').trades = Array(5).fill({ profit: -3, win: false });
  a.slots.get('ensemble').trades = Array(5).fill({ profit: 5, win: true });
  a._rebalance('test');
  const sum = [...a.slots.values()].reduce((s, sl) => s + sl.currentWeight, 0);
  near(sum, 1.0, 0.001, 'Weights should sum to 1.0 after rebalance, got ' + sum);
});

test('Outperforming strategy gets higher weight after rebalance', () => {
  const a = makeAlloc({ minTradesForRebalancing: 3, rebalanceEveryNTrades: 3, rebalanceBlend: 1.0 });
  const wBefore = a.slots.get('trend').currentWeight;
  a.slots.get('trend').trades   = Array(10).fill({ profit: 20, win: true });
  a.slots.get('meanReversion').trades = Array(10).fill({ profit: -5, win: false });
  a.slots.get('ensemble').trades = Array(10).fill({ profit: 1, win: true });
  a._rebalance('test');
  const wAfter = a.slots.get('trend').currentWeight;
  gt(wAfter, wBefore, 'trend weight should increase after outperforming');
});

test('Rebalance log records trigger type', () => {
  const a = makeAlloc({ minTradesForRebalancing: 3, rebalanceEveryNTrades: 3 });
  for (const sl of a.slots.values()) sl.trades = Array(5).fill({ profit: 5, win: true });
  a._rebalance('trade_count');
  eq(a.rebalanceLog.at(-1).trigger, 'trade_count');
});

test('Early rebalance fires when performance gap exceeds threshold', () => {
  const a = makeAlloc({ minTradesForRebalancing: 3, rebalanceEveryNTrades: 999, earlyRebalanceGap: 0.1, rebalanceBlend: 1.0 });
  a.slots.get('trend').trades = Array(10).fill({ profit: 30, win: true });
  a.slots.get('meanReversion').trades = Array(10).fill({ profit: -10, win: false });
  a.slots.get('ensemble').trades = Array(10).fill({ profit: 5, win: true });
  a.rebalanceIfDue();
  gt(a.rebalanceLog.length, 0, 'Should have rebalanced due to performance gap');
});

test('Momentum smoothing: blend=0.3 gives partial weight shift', () => {
  const a = makeAlloc({ minTradesForRebalancing: 3, rebalanceEveryNTrades: 3, rebalanceBlend: 0.3 });
  const wBefore = a.slots.get('trend').currentWeight;
  a.slots.get('trend').trades   = Array(10).fill({ profit: 50, win: true });
  a.slots.get('meanReversion').trades = Array(10).fill({ profit: -5, win: false });
  a.slots.get('ensemble').trades = Array(10).fill({ profit: 2, win: true });
  a._rebalance('test');
  const wAfter = a.slots.get('trend').currentWeight;
  // With blend=0.3, weight should move toward target but not all the way
  gt(wAfter, wBefore, 'weight should increase');
  lte(wAfter, 0.6, 'weight should not jump to maxWeight in one step with blend=0.3');
});

// ── addSlot ───────────────────────────────────────────────────────────────────
console.log('\n-- 39-41. addSlot');

test('addSlot adds a new strategy slot', () => {
  const a = makeAlloc();
  a.addSlot('custom', 0.1);
  truthy(a.slots.has('custom'), 'custom slot should exist');
  eq(a.slots.size, 4);
});

test('addSlot throws on duplicate id', () => {
  const a = makeAlloc();
  try {
    a.addSlot('trend', 0.1);
    throw new Error('should have thrown');
  } catch(e) {
    truthy(e.message.includes('already exists'));
  }
});

test('Weights re-normalise after addSlot', () => {
  const a = makeAlloc();
  a.addSlot('custom', 0.2);
  const sum = [...a.slots.values()].reduce((s, sl) => s + sl.currentWeight, 0);
  near(sum, 1.0, 0.001, 'Weights should sum to 1.0 after addSlot');
});

// ── status ────────────────────────────────────────────────────────────────────
console.log('\n-- 42-47. status');

test('status returns all required top-level fields', () => {
  const a = makeAlloc();
  const s = a.status();
  for (const k of ['totalCapital', 'totalExposure', 'exposurePct', 'maxExposurePct', 'slots', 'rebalanceLog', 'tradesSinceRebalance', 'barCount']) {
    truthy(k in s, 'Missing status field: ' + k);
  }
});

test('status slots array has 3 entries by default', () => {
  const a = makeAlloc();
  eq(a.status().slots.length, 3);
});

test('status slot entries have required fields', () => {
  const a = makeAlloc();
  const s = a.status();
  for (const sl of s.slots) {
    for (const k of ['id', 'currentWeight', 'capital', 'hasPosition', 'tradeCount', 'totalPnL', 'metrics']) {
      truthy(k in sl, 'Missing slot field: ' + k);
    }
  }
});

test('totalExposure = 0 when no positions open', () => {
  const a = makeAlloc();
  eq(a.status().totalExposure, 0);
});

test('totalExposure reflects open position cost', () => {
  const a = makeAlloc();
  a.openPosition('trend', { cost: 1500, entry: 1.1, shares: 10 });
  near(a.status().totalExposure, 1500, 1);
});

test('exposurePct is correct ratio', () => {
  const a = makeAlloc({ totalCapital: 10_000 });
  a.openPosition('trend', { cost: 2_000, entry: 1.1, shares: 10 });
  near(a.status().exposurePct, 20, 0.1, 'exposurePct should be 20%');
});

// ── trading-engine integration ────────────────────────────────────────────────
console.log('\n-- 48-51. Trading Engine Integration');

test('Engine has capitalAllocator property', () => {
  const { TradingEngine } = require('./trading-engine');
  const e = new TradingEngine();
  truthy(e.capitalAllocator instanceof CapitalAllocator, 'engine.capitalAllocator should be CapitalAllocator');
});

test('capitalAllocator has 3 default slots', () => {
  const { TradingEngine } = require('./trading-engine');
  const e = new TradingEngine();
  eq(e.capitalAllocator.slots.size, 3);
});

test('capitalAllocation exposed in getStatus', () => {
  const { TradingEngine } = require('./trading-engine');
  const e = new TradingEngine();
  const s = e.getStatus();
  truthy('capitalAllocation' in s, 'getStatus should include capitalAllocation');
  truthy('slots' in s.capitalAllocation, 'capitalAllocation.slots missing');
  truthy('totalCapital' in s.capitalAllocation, 'capitalAllocation.totalCapital missing');
});

test('printStatus runs without error', () => {
  const a = makeAlloc();
  a.slots.get('trend').trades = Array(5).fill({ profit: 10, win: true });
  a.printStatus();
  truthy(true);
});

console.log('\n=====================================================');
console.log('  RESULTS: ' + passed + ' passed  |  ' + failed + ' failed  |  ' + total + ' total');
console.log('=====================================================\n');

process.exit(failed > 0 ? 1 : 0);
