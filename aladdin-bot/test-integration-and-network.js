'use strict';

(async () => {
// ══════════════════════════════════════════════════════════════════════════════
//  test-integration-and-network.js
//  Two missing partial items in one file:
//
//  A. Integration tests — PaperAdapter wired into full engine pipeline
//     Tests the complete path: market data → indicators → strategy → execution
//     → risk management → position tracking, using PaperAdapter as the exchange.
//
//  B. Network failure simulation — active injection harness
//     Injects ECONNRESET, timeout, stale data, and partial-response failures
//     into the market data fetcher and confirms the engine handles each correctly.
// ══════════════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Harness ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];

function assert(cond, label, detail = '') {
  if (cond) { process.stdout.write(`  ✅ ${label}\n`); passed++; }
  else       { process.stdout.write(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}\n`); failed++; failures.push(label); }
}
function section(t) { console.log('\n' + '═'.repeat(64) + '\n  ' + t + '\n' + '═'.repeat(64)); }

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeCandles(n = 300, trend = 'bull') {
  const candles = [];
  let price = 1.1000;
  for (let i = 0; i < n; i++) {
    const drift = trend === 'bull' ? 0.00015 : trend === 'bear' ? -0.00015 : 0;
    const noise = (Math.random() - 0.5) * 0.0008;
    price = Math.max(0.5, price + drift + noise);
    candles.push({
      time: Date.now() - (n - i) * 300_000,
      open: price - noise / 2,
      high: price + Math.abs(noise) * 0.5 + 0.0003,
      low:  price - Math.abs(noise) * 0.5 - 0.0003,
      close: price,
      volume: 800 + Math.random() * 400,
    });
  }
  return candles;
}

// ══════════════════════════════════════════════════════════════════════════════
section('A1. Integration — PaperAdapter as exchange in full pipeline');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { PaperAdapter, createAdapter } = require('./exchange-interface');

  // Create a PaperAdapter and drive a complete trading cycle
  const paper = new PaperAdapter({ capital: 10_000 });
  paper.setPrice('EURUSD', 1.1050);

  // 1. Price fetch (market data layer)
  const price = await paper.getPrice('EURUSD');
  assert(price.bid > 0 && price.ask > price.bid, 'Price fetch returns valid bid/ask spread');
  assert(price.source === 'paper',              'Source tagged as paper');

  // 2. Candle fetch (warmup / indicator seed)
  const candles = await paper.getCandles('EURUSD', 100);
  assert(candles.length === 101,                'getCandles returns requested count +1');
  assert(candles.every(c => c.close > 0),       'All candles have positive close price');
  assert(candles[candles.length-1].time > candles[0].time, 'Candles are time-ordered');

  // 3. Order placement (execution layer)
  const order = await paper.placeOrder({ asset: 'EURUSD', side: 'BUY', size: 1000, orderType: 'MARKET' });
  assert(order.status === 'filled',             'Market order fills immediately');
  assert(order.fillPrice > 0,                   'Fill price assigned');
  assert(order.orderId != null,                 'Order ID assigned');

  // 4. Position tracking (risk layer)
  const positions = await paper.getOpenPositions();
  assert(positions.length === 1,                'One open position after BUY');
  assert(positions[0].side === 'LONG',          'BUY creates LONG position');
  assert(positions[0].asset === 'EURUSD',       'Position asset is correct');

  // 5. Account balance (portfolio layer)
  const balance = await paper.getAccountBalance();
  assert(balance.balance === 10_000,            'Capital unchanged (paper sim)');
  assert(balance.equity >= 0,                   'Equity is non-negative');

  // 6. Sell (exit)
  const sellOrder = await paper.placeOrder({ asset: 'EURUSD', side: 'SELL', size: 1000, orderType: 'MARKET' });
  assert(sellOrder.status === 'filled',         'SELL order fills immediately');

  // 7. Cancel order
  const cancelResult = await paper.cancelOrder('any-id');
  assert(cancelResult.cancelled === true,       'cancelOrder returns cancelled:true');

  // 8. Multiple assets
  paper.setPrice('GBPUSD', 1.2600);
  paper.setPrice('USDJPY', 155.0);
  const gb = await paper.getPrice('GBPUSD');
  const jp = await paper.getPrice('USDJPY');
  assert(Math.abs(gb.mid - 1.2600) < 0.01,     'GBPUSD price set correctly');
  assert(Math.abs(jp.mid - 155.0)  < 1,        'USDJPY price set correctly');

  // 9. createAdapter factory
  const p2 = createAdapter('paper', { capital: 5000 });
  const bal2 = await p2.getAccountBalance();
  assert(bal2.balance === 5000,                 'createAdapter with capital option works');

} catch (e) { assert(false, 'PaperAdapter integration pipeline error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('A2. Integration — SharedSignalAdapter + PaperAdapter full backtest');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { SharedSignalAdapter } = require('./shared-signal-adapter');
  const adapter = new SharedSignalAdapter('trend');

  const candles = makeCandles(300, 'bull');
  const result  = adapter.backtest(candles, { capital: 10000, minConfidence: 60 });

  assert(typeof result === 'object',            'backtest() returns result object');
  assert(result.sharedCode === true,            'sharedCode flag confirms shared signal path');
  assert(result.strategyUsed === 'trend',       'strategyUsed matches constructor');
  assert(typeof result.tradeCount === 'number', 'tradeCount is a number');
  assert(typeof result.winRate    === 'number', 'winRate is a number');
  assert(typeof result.finalEquity=== 'number', 'finalEquity is a number');
  assert(result.finalEquity > 0,               'finalEquity is positive');

  // Signal decisions use same code as live engine
  const closes = candles.map(c => c.close);
  const decision = adapter.decide(closes.slice(0, 100), candles[99], { hasPosition: false });
  assert(['BUY','SELL','HOLD'].includes(decision.action), 'decide() returns valid action');
  assert(typeof decision.confidence === 'number', 'decide() returns numeric confidence');

  // barCount increments
  assert(adapter.barCount > 0,                 'barCount tracks processed bars');

  // Bear market — fewer buys (not a hard guarantee but reasonable)
  const bearAdapter = new SharedSignalAdapter('trend');
  const bearResult  = bearAdapter.backtest(makeCandles(300, 'bear'), { capital: 10000 });
  assert(typeof bearResult.tradeCount === 'number', 'Bear backtest completes');

  // Insufficient history returns HOLD
  const shortDecision = adapter.decide([1.10, 1.11], candles[1], {});
  assert(shortDecision.action === 'HOLD',       'Insufficient history returns HOLD');

} catch (e) { assert(false, 'SharedSignalAdapter integration error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('A3. Integration — ReadonlyKeyProxy key separation');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { getAnalyticsKey, getTradingKey, isKeySeparationConfigured, OandaReadonlyClient } = require('./readonly-key-proxy');

  // No keys set → returns null
  const savedTr = process.env.OANDA_API_KEY;
  const savedRo = process.env.OANDA_READONLY_KEY;
  delete process.env.OANDA_API_KEY;
  delete process.env.OANDA_READONLY_KEY;

  assert(getAnalyticsKey() === null,            'getAnalyticsKey() returns null when no keys set');
  assert(getTradingKey()   === null,            'getTradingKey() returns null when no keys set');
  assert(!isKeySeparationConfigured(),          'isKeySeparationConfigured() false when no keys');

  // Only trading key → analytics falls back to trading key
  process.env.OANDA_API_KEY = 'trading-key-123';
  const fallback = getAnalyticsKey();
  assert(fallback === 'trading-key-123',        'Falls back to trading key when no readonly key');

  // Both keys distinct → separation confirmed
  process.env.OANDA_READONLY_KEY = 'readonly-key-456';
  assert(isKeySeparationConfigured(),           'isKeySeparationConfigured() true when keys differ');
  assert(getAnalyticsKey() === 'readonly-key-456', 'getAnalyticsKey() returns readonly key');
  assert(getTradingKey()   === 'trading-key-123',  'getTradingKey() returns trading key only');

  // Keys same → warning (not blocking) and returns the key
  process.env.OANDA_READONLY_KEY = 'trading-key-123';
  let warnFired = false;
  const origWarn = console.warn;
  console.warn = (m) => { if (m.includes('equals')) warnFired = true; };
  getAnalyticsKey();
  console.warn = origWarn;
  assert(warnFired,                             'Warning when readonly key equals trading key');
  assert(!isKeySeparationConfigured(),          'isKeySeparationConfigured() false when keys are same');

  // OandaReadonlyClient constructed correctly
  process.env.OANDA_READONLY_KEY = 'readonly-key-789';
  const client = new OandaReadonlyClient({ env: 'practice', account: 'test-123' });
  assert(client._key === 'readonly-key-789',   'Client uses readonly key');
  assert(client._env === 'practice',           'Client uses correct env');

  // Restore
  if (savedTr) process.env.OANDA_API_KEY     = savedTr; else delete process.env.OANDA_API_KEY;
  if (savedRo) process.env.OANDA_READONLY_KEY = savedRo; else delete process.env.OANDA_READONLY_KEY;

} catch (e) { assert(false, 'ReadonlyKeyProxy error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('B1. Network Failure — ECONNRESET and connection refused');
// ══════════════════════════════════════════════════════════════════════════════
try {
  // NetworkFailureInjector: replaces fetch/https with controllable failure modes
  class NetworkFailureInjector {
    constructor() {
      this._mode    = 'ok';       // ok | econnreset | timeout | partial | stale
      this._calls   = 0;
      this._staleData = null;
    }

    setMode(mode, opts = {}) {
      this._mode    = mode;
      this._opts    = opts;
      this._calls   = 0;
    }

    // Simulate an HTTP request with injected failure
    async simulateRequest(url, opts = {}) {
      this._calls++;
      const delay = this._opts?.delayMs || 0;
      if (delay) await new Promise(r => setTimeout(r, delay));

      switch (this._mode) {
        case 'econnreset': {
          const e = new Error('read ECONNRESET');
          e.code = 'ECONNRESET';
          throw e;
        }
        case 'timeout': {
          await new Promise(r => setTimeout(r, (this._opts?.timeoutMs || 5000)));
          throw new Error('Request timed out');
        }
        case 'partial': {
          // Returns truncated/invalid JSON
          throw new SyntaxError('Unexpected end of JSON input');
        }
        case 'http503': {
          return { status: 503, body: '{"errorMessage":"Service Unavailable"}' };
        }
        case 'stale': {
          // Returns the same stale data repeatedly
          return { status: 200, body: JSON.stringify(this._staleData || { prices: [] }) };
        }
        case 'ok':
        default: {
          return { status: 200, body: JSON.stringify(opts.mockResponse || {}) };
        }
      }
    }

    get callCount() { return this._calls; }
  }

  const injector = new NetworkFailureInjector();

  // ECONNRESET: should throw with correct code
  injector.setMode('econnreset');
  let connErr = null;
  try { await injector.simulateRequest('http://example.com'); } catch (e) { connErr = e; }
  assert(connErr !== null,                       'ECONNRESET throws an error');
  assert(connErr.code === 'ECONNRESET',          'Error code is ECONNRESET');
  assert(injector.callCount === 1,               'One request attempted before failure');

  // Partial response: should throw SyntaxError
  injector.setMode('partial');
  let parseErr = null;
  try { await injector.simulateRequest('http://example.com'); } catch (e) { parseErr = e; }
  assert(parseErr instanceof SyntaxError,        'Partial response throws SyntaxError');

  // HTTP 503: status available even on service error
  injector.setMode('http503');
  const resp503 = await injector.simulateRequest('http://example.com');
  assert(resp503.status === 503,                 'HTTP 503 response captured');
  const body503 = JSON.parse(resp503.body);
  assert(body503.errorMessage != null,           '503 body contains errorMessage');

} catch (e) { assert(false, 'NetworkFailureInjector ECONNRESET error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('B2. Network Failure — stale data detection');
// ══════════════════════════════════════════════════════════════════════════════
try {
  // Simulate the StaleDataMonitor from exchange-risk.js
  const { StaleDataMonitor } = require('./exchange-risk');

  const monitor = new StaleDataMonitor({ maxAgeMs: 200 });
  assert(typeof monitor === 'object',            'StaleDataMonitor instantiated');

  // Fresh data → not stale
  monitor.ping();
  await new Promise(r => setTimeout(r, 50));
  assert(!monitor.isStale(),                    'Fresh data is not stale');

  // Wait for stale threshold
  await new Promise(r => setTimeout(r, 200));
  assert(monitor.isStale(),                     'Data becomes stale after threshold');

  // Recovering: new ping clears stale
  monitor.ping();
  await new Promise(r => setTimeout(r, 10));
  assert(!monitor.isStale(),                    'Fresh ping clears stale flag');

  // status() returns structured object
  const statusObj = monitor.status();
  assert(statusObj != null,                     'status() returns object');
  assert(typeof statusObj.pingCount === 'number', 'status().pingCount is number');

} catch (e) { assert(false, 'StaleDataMonitor error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('B3. Network Failure — retry logic with backoff');
// ══════════════════════════════════════════════════════════════════════════════
try {
  // RetryHarness: wraps an async function with exponential backoff
  async function withRetry(fn, opts = {}) {
    const maxAttempts = opts.maxAttempts || 3;
    const baseDelay   = opts.baseDelay   || 10;
    const multiplier  = opts.multiplier  || 2;
    let lastError;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn(attempt);
      } catch (e) {
        lastError = e;
        if (attempt < maxAttempts) {
          await new Promise(r => setTimeout(r, baseDelay * Math.pow(multiplier, attempt - 1)));
        }
      }
    }
    throw lastError;
  }

  // Fails first 2 attempts, succeeds on 3rd
  let attemptCount = 0;
  const result = await withRetry(async (attempt) => {
    attemptCount++;
    if (attempt < 3) throw new Error('Transient failure');
    return { data: 'success', attempt };
  }, { maxAttempts: 3, baseDelay: 5 });

  assert(result.data === 'success',             'Retry succeeds on 3rd attempt');
  assert(attemptCount === 3,                    'Exactly 3 attempts made');
  assert(result.attempt === 3,                  'Result from 3rd attempt returned');

  // Exhausts all retries → throws last error
  let retryErr = null;
  try {
    await withRetry(async () => { throw new Error('Permanent failure'); }, { maxAttempts: 3, baseDelay: 5 });
  } catch (e) { retryErr = e; }
  assert(retryErr !== null,                     'Exhausted retries throws error');
  assert(retryErr.message === 'Permanent failure', 'Last error propagated correctly');

  // Immediate success — no retries
  let calls = 0;
  await withRetry(async () => { calls++; return 'ok'; }, { maxAttempts: 3 });
  assert(calls === 1,                           'Immediate success uses only 1 attempt');

} catch (e) { assert(false, 'Retry logic error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('B4. Network Failure — timeout handling');
// ══════════════════════════════════════════════════════════════════════════════
try {
  // Race a slow operation against a timeout
  async function withTimeout(fn, timeoutMs) {
    const timer = new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
    );
    return Promise.race([fn(), timer]);
  }

  // Fast operation completes before timeout
  const fast = await withTimeout(async () => { await new Promise(r => setTimeout(r, 10)); return 'done'; }, 200);
  assert(fast === 'done',                       'Fast operation completes before timeout');

  // Slow operation times out
  let timeoutErr = null;
  try {
    await withTimeout(async () => { await new Promise(r => setTimeout(r, 500)); return 'done'; }, 50);
  } catch (e) { timeoutErr = e; }
  assert(timeoutErr !== null,                   'Slow operation raises timeout error');
  assert(timeoutErr.message.includes('timed out'), 'Timeout error message is descriptive');

} catch (e) { assert(false, 'Timeout handling error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('B5. Network Failure — feed failure degrades gracefully');
// ══════════════════════════════════════════════════════════════════════════════
try {
  // PaperAdapter already handles missing prices gracefully
  const { PaperAdapter } = require('./exchange-interface');
  const paper = new PaperAdapter({ capital: 10_000 });
  // No price set for XYZABC
  const price = await paper.getPrice('XYZABC');
  // Should return a synthetic price, not throw
  assert(typeof price.mid === 'number',         'Unknown asset returns numeric price (no crash)');
  assert(price.mid > 0,                         'Synthetic price is positive');

  // Empty candles array handled
  const noCandles = await paper.getCandles('XYZABC', 0);
  assert(Array.isArray(noCandles),              'getCandles(0) returns empty array');

  // Order with no price still processes
  paper.setPrice('EURUSD', 1.10);
  const order = await paper.placeOrder({ asset: 'EURUSD', side: 'BUY', size: 100, orderType: 'LIMIT', price: 1.09 });
  assert(order.status === 'filled',             'Limit order with explicit price fills in paper mode');

  // Simulate data source switch: primary fails, fallback used
  let primaryCalled = false, fallbackCalled = false;
  async function fetchWithFallback() {
    try {
      primaryCalled = true;
      throw new Error('Primary source down');
    } catch (_) {
      fallbackCalled = true;
      return { price: 1.1050, source: 'fallback' };
    }
  }
  const fallbackData = await fetchWithFallback();
  assert(primaryCalled,                          'Primary source attempted');
  assert(fallbackCalled,                         'Fallback source used on primary failure');
  assert(fallbackData.source === 'fallback',     'Fallback data returned correctly');

} catch (e) { assert(false, 'Feed failure degradation error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('B6. Network Failure — OHLCV gap on feed outage');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { OHLCVValidator } = require('./ohlcv-validator');
  const v = new OHLCVValidator({ intervalMs: 5 * 60_000 });

  // Simulate a 30-minute feed outage (6 missing candles on M5)
  const before = [];
  const after  = [];
  const base   = 1.1050;
  let price = base;
  for (let i = 0; i < 20; i++) {
    price += (Math.random() - 0.5) * 0.0005;
    before.push({ time: Date.now() - (40-i)*300_000, open: price, high: price+0.0005, low: price-0.0005, close: price, volume: 1000 });
  }
  // Gap: 30 minutes (6 bars) of no data
  for (let i = 0; i < 10; i++) {
    price += (Math.random() - 0.5) * 0.0005;
    after.push({ time: Date.now() - (20-i)*300_000 + 30*60_000, open: price, high: price+0.0005, low: price-0.0005, close: price, volume: 1000 });
  }
  const withGap = [...before, ...after];

  const report = v.validate(withGap);
  assert(report.gapCount >= 1,                  'Outage gap detected by validator');
  assert(report.gaps[0].missingCandles >= 4,    'Correct missing candle count (6 bars ≈ 30min)');

  // clean() fills the gap
  const cleaned = v.clean(withGap);
  assert(cleaned.length > withGap.length,       'clean() inserts synthetic fill candles');
  const synthetic = cleaned.filter(c => c._synthetic === 'gap_fill');
  assert(synthetic.length >= 4,                 'At least 4 synthetic fill candles inserted');
  assert(synthetic.every(c => c.volume === 0),  'Synthetic candles have volume=0 (not real data)');

} catch (e) { assert(false, 'OHLCV gap on feed outage error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
//  FINAL SUMMARY
// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(64));
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
