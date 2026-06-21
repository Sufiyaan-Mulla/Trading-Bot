'use strict';

const {
  withRetry, checkHttpStatus, StaleDataMonitor,
  DeadMansSwitch, fallbackChain, HttpError,
} = require('./exchange-risk');

let passed = 0, failed = 0, total = 0;

function test(label, fn) {
  total++;
  try { fn(); out('  OK  ' + label); passed++; }
  catch(e) { out('  FAIL ' + label + '\n       -> ' + e.message); failed++; }
}
async function testAsync(label, fn) {
  total++;
  try { await fn(); out('  OK  ' + label); passed++; }
  catch(e) { out('  FAIL ' + label + '\n       -> ' + e.message); failed++; }
}

function eq(a, b, msg)   { if (a !== b) throw new Error(msg || JSON.stringify(a) + ' !== ' + JSON.stringify(b)); }
function truthy(v, msg)  { if (!v) throw new Error(msg || 'expected truthy, got ' + v); }
function falsy(v, msg)   { if (v)  throw new Error(msg || 'expected falsy, got ' + v); }
function gt(a, b, msg)   { if (!(a > b))  throw new Error(msg || a + ' not > ' + b); }
function gte(a, b, msg)  { if (!(a >= b)) throw new Error(msg || a + ' not >= ' + b); }
function lte(a, b, msg)  { if (!(a <= b)) throw new Error(msg || a + ' not <= ' + b); }

// Items 20-53: Use explicit stdout writer for test output
const out = (...args) => process.stdout.write(args.join(' ') + '\n');

(async () => {

out('\n=====================================================');
out('  EXCHANGE RISK -- FULL TEST SUITE');
out('=====================================================');

// ── 1-4: HttpError ──────────────────────────────────────
out('\n-- 1-4. HttpError');

test('HttpError has statusCode, retryable, rateLimited', () => {
  const e = new HttpError(429, 'rate limited');
  eq(e.statusCode, 429);
  truthy('retryable'   in e);
  truthy('rateLimited' in e);
  truthy(e instanceof Error);
});

test('4xx non-429 errors are not retryable', () => {
  const e = new HttpError(400, 'bad request');
  falsy(e.retryable,   '400 should not be retryable');
  falsy(e.rateLimited, '400 should not be rateLimited');
});

test('5xx errors are retryable', () => {
  const e = new HttpError(503, 'service unavailable');
  truthy(e.retryable, '503 should be retryable');
});

test('429 is retryable and rateLimited', () => {
  const e = new HttpError(429, 'too many requests');
  truthy(e.retryable,   '429 should be retryable');
  truthy(e.rateLimited, '429 should be rateLimited');
});

// ── 5-9: checkHttpStatus ─────────────────────────────────
out('\n-- 5-9. checkHttpStatus');

test('2xx no throw', () => {
  checkHttpStatus(200, 'test');
  checkHttpStatus(201, 'test');
  checkHttpStatus(204, 'test');
});

test('429 throws HttpError with rateLimited=true', () => {
  try { checkHttpStatus(429, 'test'); throw new Error('should have thrown'); }
  catch(e) {
    truthy(e instanceof HttpError, 'should be HttpError');
    eq(e.statusCode, 429);
    truthy(e.rateLimited);
  }
});

test('503 throws HttpError with retryable=true', () => {
  try { checkHttpStatus(503, 'test'); throw new Error('should have thrown'); }
  catch(e) {
    truthy(e instanceof HttpError);
    eq(e.statusCode, 503);
    truthy(e.retryable);
  }
});

test('400 throws HttpError with retryable=false', () => {
  try { checkHttpStatus(400, 'test'); throw new Error('should have thrown'); }
  catch(e) {
    truthy(e instanceof HttpError);
    eq(e.statusCode, 400);
    falsy(e.retryable, '400 should not be retryable');
  }
});

test('500 throws HttpError with retryable=true', () => {
  try { checkHttpStatus(500, 'test'); throw new Error('should have thrown'); }
  catch(e) {
    truthy(e instanceof HttpError);
    truthy(e.retryable);
  }
});

// ── 10-17: withRetry ─────────────────────────────────────
out('\n-- 10-17. withRetry');

await testAsync('Succeeds on first attempt no retries', async () => {
  let calls = 0;
  const result = await withRetry(async () => { calls++; return 'ok'; }, { maxAttempts: 3, baseDelay: 1, label: 'test' });
  eq(result, 'ok');
  eq(calls, 1, 'should only call fn once');
});

await testAsync('Retries on failure and eventually succeeds', async () => {
  let calls = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error('transient');
    return 'success';
  }, { maxAttempts: 3, baseDelay: 1, label: 'test' });
  eq(result, 'success');
  eq(calls, 3, 'should call fn 3 times');
});

await testAsync('Throws after maxAttempts exhausted', async () => {
  let calls = 0;
  try {
    await withRetry(async () => { calls++; throw new Error('always fails'); }, { maxAttempts: 3, baseDelay: 1, label: 'test' });
    throw new Error('should have thrown');
  } catch(e) {
    eq(e.message, 'always fails');
    eq(calls, 3, 'should try exactly 3 times');
  }
});

await testAsync('Non-retryable HttpError thrown immediately', async () => {
  let calls = 0;
  try {
    await withRetry(async () => { calls++; throw new HttpError(400, 'bad request'); }, { maxAttempts: 3, baseDelay: 1, label: 'test' });
    throw new Error('should have thrown');
  } catch(e) {
    eq(calls, 1, 'should not retry non-retryable error');
    truthy(e instanceof HttpError);
    eq(e.statusCode, 400);
  }
});

await testAsync('Calls onRetry callback with attempt delay error', async () => {
  const retries = [];
  try {
    await withRetry(
      async () => { throw new Error('fail'); },
      { maxAttempts: 3, baseDelay: 1, label: 'test', onRetry: (attempt, delay, err) => retries.push({ attempt, err: err.message }) }
    );
  } catch(e) {}
  eq(retries.length, 2, 'should call onRetry twice');
  eq(retries[0].attempt, 1);
  eq(retries[1].attempt, 2);
});

await testAsync('Delays increase exponentially between attempts', async () => {
  const delays = [];
  try {
    await withRetry(
      async () => { throw new Error('fail'); },
      { maxAttempts: 3, baseDelay: 100, multiplier: 2, maxDelay: 10000, label: 'test', onRetry: (attempt, delay) => delays.push(delay) }
    );
  } catch(e) {}
  eq(delays.length, 2);
  eq(delays[0], 100, 'First retry delay should be 100ms, got ' + delays[0]);
  eq(delays[1], 200, 'Second retry delay should be 200ms, got ' + delays[1]);
});

await testAsync('Delay capped at maxDelay', async () => {
  const delays = [];
  try {
    await withRetry(
      async () => { throw new Error('fail'); },
      { maxAttempts: 3, baseDelay: 10000, multiplier: 10, maxDelay: 5000, label: 'test', onRetry: (a, delay) => delays.push(delay) }
    );
  } catch(e) {}
  for (const d of delays) lte(d, 5000, 'Delay ' + d + ' exceeds maxDelay 5000');
});

await testAsync('429 HttpError schedules delay >= 5000ms', async () => {
  const delays = [];
  try {
    await withRetry(
      async () => { throw new HttpError(429, 'rate limited'); },
      { maxAttempts: 2, baseDelay: 1, maxDelay: 60000, label: 'test', onRetry: (a, delay) => delays.push(delay) }
    );
  } catch(e) {}
  gte(delays[0], 5000, '429 should schedule at least 5000ms delay, got ' + delays[0]);
});

// ── 18-26: StaleDataMonitor ──────────────────────────────
out('\n-- 18-26. StaleDataMonitor');

test('isStale false immediately after construction', () => {
  const m = new StaleDataMonitor({ maxAgeMs: 1000 });
  falsy(m.isStale(), 'should not be stale immediately');
});

test('isStale false after ping', () => {
  const m = new StaleDataMonitor({ maxAgeMs: 50 });
  m.ping();
  falsy(m.isStale(), 'should not be stale right after ping');
});

await testAsync('isStale true when maxAgeMs exceeded', async () => {
  const m = new StaleDataMonitor({ maxAgeMs: 30 });
  await new Promise(r => setTimeout(r, 60));
  truthy(m.isStale(), 'should be stale after 60ms with maxAgeMs=30');
});

await testAsync('onStale callback fires once when stale detected', async () => {
  let staleCount = 0;
  const m = new StaleDataMonitor({ maxAgeMs: 20, onStale: () => staleCount++ });
  await new Promise(r => setTimeout(r, 40));
  m.isStale();
  m.isStale();
  eq(staleCount, 1, 'onStale should fire exactly once, got ' + staleCount);
});

await testAsync('onRecover fires when ping called after stale', async () => {
  let recovered = false;
  const m = new StaleDataMonitor({ maxAgeMs: 20, onRecover: () => { recovered = true; } });
  await new Promise(r => setTimeout(r, 40));
  m.isStale();
  m.ping();
  truthy(recovered, 'onRecover should have fired');
});

await testAsync('isStale false after recovery ping', async () => {
  const m = new StaleDataMonitor({ maxAgeMs: 20 });
  await new Promise(r => setTimeout(r, 40));
  m.isStale();
  m.ping();
  falsy(m.isStale(), 'should not be stale after recovery ping');
});

await testAsync('staleCount increments each time stale detected', async () => {
  const m = new StaleDataMonitor({ maxAgeMs: 20 });
  await new Promise(r => setTimeout(r, 40));
  m.isStale();
  m.ping();
  await new Promise(r => setTimeout(r, 40));
  m.isStale();
  eq(m.staleCount, 2, 'staleCount should be 2, got ' + m.staleCount);
});

test('pingCount increments on each ping', () => {
  const m = new StaleDataMonitor({ maxAgeMs: 1000 });
  m.ping(); m.ping(); m.ping();
  eq(m.pingCount, 3, 'pingCount should be 3, got ' + m.pingCount);
});

test('status returns all required fields', () => {
  const m = new StaleDataMonitor({ maxAgeMs: 1000 });
  const s = m.status();
  for (const k of ['isStale', 'ageMs', 'maxAgeMs', 'pingCount', 'staleCount', 'lastStaleAt', 'lastRecoverAt']) {
    truthy(k in s, 'Missing status field: ' + k);
  }
});

// ── 27-34: DeadMansSwitch ────────────────────────────────
out('\n-- 27-34. DeadMansSwitch');

test('isAlive true after heartbeat', () => {
  const dms = new DeadMansSwitch({ timeoutMs: 5000, checkIntervalMs: 60000 });
  dms.heartbeat();
  truthy(dms.isAlive(), 'should be alive after heartbeat');
});

test('isDead false before timeout', () => {
  const dms = new DeadMansSwitch({ timeoutMs: 5000, checkIntervalMs: 60000 });
  dms.heartbeat();
  falsy(dms.isDead(), 'should not be dead before timeout');
});

await testAsync('onDead fires after timeout exceeded', async () => {
  let fired = false;
  const dms = new DeadMansSwitch({ timeoutMs: 30, checkIntervalMs: 20, onDead: () => { fired = true; } });
  dms.start();
  await new Promise(r => setTimeout(r, 80));
  dms.stop();
  truthy(fired, 'onDead should have fired');
});

await testAsync('isDead true after timeout', async () => {
  const dms = new DeadMansSwitch({ timeoutMs: 20, checkIntervalMs: 10 });
  dms.start();
  await new Promise(r => setTimeout(r, 60));
  dms.stop();
  truthy(dms.isDead(), 'should be dead after timeout with no heartbeat');
});

await testAsync('onRecover fires when heartbeat resumes after death', async () => {
  let recovered = false;
  const dms = new DeadMansSwitch({ timeoutMs: 20, checkIntervalMs: 10, onRecover: () => { recovered = true; } });
  dms.start();
  await new Promise(r => setTimeout(r, 60));
  dms.heartbeat();
  dms.stop();
  truthy(recovered, 'onRecover should have fired');
});

await testAsync('deadCount increments each time dead detected', async () => {
  const dms = new DeadMansSwitch({ timeoutMs: 20, checkIntervalMs: 10 });
  dms.start();
  await new Promise(r => setTimeout(r, 60));
  dms.stop();
  gte(dms.deadCount, 1, 'deadCount should be >= 1, got ' + dms.deadCount);
});

await testAsync('stop prevents further dead checks', async () => {
  let fires = 0;
  const dms = new DeadMansSwitch({ timeoutMs: 10, checkIntervalMs: 10, onDead: () => fires++ });
  dms.start();
  await new Promise(r => setTimeout(r, 50));
  dms.stop();
  const before = fires;
  await new Promise(r => setTimeout(r, 50));
  eq(fires, before, 'should not fire after stop');
});

test('status returns all required fields', () => {
  const dms = new DeadMansSwitch({ timeoutMs: 5000, checkIntervalMs: 60000 });
  const s   = dms.status();
  for (const k of ['alive', 'isDead', 'silenceMs', 'timeoutMs', 'heartbeatCount', 'deadCount']) {
    truthy(k in s, 'Missing DMS status field: ' + k);
  }
});

// ── 35-40: fallbackChain ─────────────────────────────────
out('\n-- 35-40. fallbackChain');

await testAsync('Returns first successful source result', async () => {
  const r = await fallbackChain([
    { label: 'source1', fn: async () => 'first' },
    { label: 'source2', fn: async () => 'second' },
  ], null, 'test');
  eq(r.result, 'first');
  eq(r.source, 'source1');
});

await testAsync('Skips null results and tries next source', async () => {
  const r = await fallbackChain([
    { label: 'source1', fn: async () => null },
    { label: 'source2', fn: async () => 'second' },
  ], null, 'test');
  eq(r.result, 'second');
  eq(r.source, 'source2');
});

await testAsync('Falls through to fallback when all sources fail', async () => {
  const r = await fallbackChain([
    { label: 's1', fn: async () => { throw new Error('fail'); } },
    { label: 's2', fn: async () => null },
  ], async () => 'fallback-result', 'test');
  eq(r.result, 'fallback-result');
  eq(r.source, 'fallback');
});

await testAsync('Throws when all sources fail and no fallback', async () => {
  try {
    await fallbackChain([
      { label: 's1', fn: async () => { throw new Error('fail1'); } },
      { label: 's2', fn: async () => { throw new Error('fail2'); } },
    ], null, 'test');
    throw new Error('should have thrown');
  } catch(e) {
    truthy(e.message.includes('exhausted') || e.message.includes('fail'), 'Wrong error: ' + e.message);
  }
});

await testAsync('Records errors from all failed sources', async () => {
  const r = await fallbackChain([
    { label: 's1', fn: async () => { throw new Error('err1'); } },
    { label: 's2', fn: async () => 'ok' },
  ], null, 'test');
  truthy(r.errors.length >= 1, 'should record at least one error');
  eq(r.errors[0].source, 's1');
  eq(r.errors[0].error,  'err1');
});

await testAsync('Returns correct source label', async () => {
  const r = await fallbackChain([
    { label: 'primary',   fn: async () => null },
    { label: 'secondary', fn: async () => 'data' },
  ], null, 'test');
  eq(r.source, 'secondary');
});

// ── 41-45: trading-engine integration ───────────────────
out('\n-- 41-45. Trading Engine Integration');

test('Engine has staleDataMonitor property', () => {
  const { TradingEngine } = require('./trading-engine');
  const e = new TradingEngine();
  truthy(e.staleDataMonitor instanceof StaleDataMonitor, 'engine.staleDataMonitor should be StaleDataMonitor');
});

test('Engine has deadMansSwitch property', () => {
  const { TradingEngine } = require('./trading-engine');
  const e = new TradingEngine();
  truthy(e.deadMansSwitch instanceof DeadMansSwitch, 'engine.deadMansSwitch should be DeadMansSwitch');
});

test('exchangeRisk field present in getStatus', () => {
  const { TradingEngine } = require('./trading-engine');
  const e = new TradingEngine();
  const s = e.getStatus();
  truthy('exchangeRisk' in s, 'getStatus should include exchangeRisk');
});

test('staleDataMonitor status in getStatus exchangeRisk', () => {
  const { TradingEngine } = require('./trading-engine');
  const e = new TradingEngine();
  const s = e.getStatus();
  truthy('staleData' in s.exchangeRisk, 'exchangeRisk.staleData missing');
  truthy('isStale'   in s.exchangeRisk.staleData, 'staleData.isStale missing');
});

test('deadMansSwitch status in getStatus exchangeRisk', () => {
  const { TradingEngine } = require('./trading-engine');
  const e = new TradingEngine();
  const s = e.getStatus();
  truthy('deadMansSwitch' in s.exchangeRisk, 'exchangeRisk.deadMansSwitch missing');
  truthy('alive' in s.exchangeRisk.deadMansSwitch, 'deadMansSwitch.alive missing');
});

out('\n=====================================================');
console.log('  RESULTS: ' + passed + ' passed  |  ' + failed + ' failed  |  ' + total + ' total');
console.log('=====================================================\n');
// Item 53: process.exit is intentional in a test runner — signals CI pass/fail
process.exit(failed > 0 ? 1 : 0);

})();
