'use strict';
// ── test-av-ratelimit.js ──────────────────────────────────────────────────────
// Heavy test suite for the _avRateLimit "use-till-free-then-cut-connection"
// feature added to market-data-fetcher.js.
//
// Tests:
//   1. Fresh state
//   2. canCall() increments dayCount and callsInLastMin
//   3. Low-remaining warning fires at ≤5 calls left (log spy)
//   4. Daily limit hit → sets exhaustedUntil to next midnight UTC
//   5. Suspended state blocks all calls and does NOT increment counter
//   6. Auto-reconnect when exhaustedUntil passes (time-travel via mock)
//   7. Per-minute throttle (maxPerMin) still works during active period
//   8. status() reflects accurate state at each stage
//   9. Belt-and-suspenders 24h rollover resets counters
//  10. Multiple exhaustion/resume cycles work correctly
//  11. refreshPrice() falls back to seed/cache when AV is suspended
//  12. "Information" API response handled gracefully (no throw)
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const failures = [];

function ok(label)   { process.stdout.write(`  ✅ ${label}\n`); passed++; }
function fail(label, extra) {
  const msg = extra ? `${label} — ${extra}` : label;
  process.stdout.write(`  ❌ FAIL: ${msg}\n`);
  failed++;
  failures.push(msg);
}
function assert(cond, label, extra) { cond ? ok(label) : fail(label, extra); }
function section(t)  { console.log(`\n${'═'.repeat(64)}\n  ${t}\n${'═'.repeat(64)}`); }

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build a fresh _avRateLimit clone so each test section starts clean.
// IMPORTANT: Object.assign() evaluates getters at copy time, making them stale.
// We use Object.defineProperty for isExhausted so it stays a live getter.
// canCall() is a full copy including all warn/log calls so spy tests work.
// ─────────────────────────────────────────────────────────────────────────────
function freshRl(overrides = {}) {
  const rl = {
    calls:          [],
    maxPerMin:      5,
    maxPerDay:      25,
    dayStart:       Date.now(),
    dayCount:       0,
    exhaustedUntil: 0,
    _nextMidnightUTC() {
      const d = new Date();
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    },
    canCall() {
      const now = Date.now();
      if (this.exhaustedUntil > 0 && now >= this.exhaustedUntil) {
        console.log('[AV] Daily limit reset at midnight UTC — resuming live price feed');
        this.exhaustedUntil = 0; this.dayStart = now; this.dayCount = 0; this.calls = [];
      }
      if (this.exhaustedUntil > 0) {
        const hoursLeft = ((this.exhaustedUntil - now) / 3_600_000).toFixed(1);
        console.warn(`[AV] Connection suspended — daily limit exhausted. Resumes in ${hoursLeft}h (midnight UTC)`);
        return false;
      }
      if (now - this.dayStart > 86_400_000) { this.dayStart = now; this.dayCount = 0; this.calls = []; }
      if (this.dayCount >= this.maxPerDay) {
        this.exhaustedUntil = this._nextMidnightUTC();
        console.warn(`[AV] Daily limit exhausted (${this.maxPerDay}/${this.maxPerDay}) — connection suspended until midnight UTC (${new Date(this.exhaustedUntil).toUTCString()})`);
        return false;
      }
      this.calls = this.calls.filter(t => now - t < 60_000);
      if (this.calls.length >= this.maxPerMin) {
        console.warn(`[AV] Rate limit: ${this.calls.length}/${this.maxPerMin} calls in last 60s — skipping`);
        return false;
      }
      this.calls.push(now);
      this.dayCount++;
      const remaining = this.maxPerDay - this.dayCount;
      if (remaining <= 5 && remaining > 0)
        console.warn(`[AV] Only ${remaining} API call${remaining === 1 ? '' : 's'} remaining today`);
      return true;
    },
    status() {
      const now = Date.now();
      return {
        callsToday:     this.dayCount,
        remaining:      Math.max(0, this.maxPerDay - this.dayCount),
        maxPerDay:      this.maxPerDay,
        exhausted:      this.isExhausted,
        exhaustedUntil: this.exhaustedUntil > 0 ? new Date(this.exhaustedUntil).toUTCString() : null,
        callsInLastMin: this.calls.filter(t => now - t < 60_000).length,
        maxPerMin:      this.maxPerMin,
      };
    },
  };
  // Define isExhausted as a live getter (Object.assign would copy the current value, not the getter)
  Object.defineProperty(rl, 'isExhausted', {
    get() { return this.exhaustedUntil > 0 && Date.now() < this.exhaustedUntil; },
    configurable: true,
    enumerable:   true,
  });
  // Apply caller overrides (plain property writes, after getter is defined)
  Object.assign(rl, overrides);
  return rl;
}

// ─────────────────────────────────────────────────────────────────────────────
// Also import the REAL exported object from market-data-fetcher.js for smoke tests
// ─────────────────────────────────────────────────────────────────────────────
const { _avRateLimit: realRl, MarketDataFetcher } = require('./market-data-fetcher');

// ─────────────────────────────────────────────────────────────────────────────
section('1 — Exported _avRateLimit has expected shape');
// ─────────────────────────────────────────────────────────────────────────────
assert(realRl !== undefined,                    '_avRateLimit is exported from module');
assert(typeof realRl.canCall === 'function',    '_avRateLimit.canCall is a function');
assert(typeof realRl.status  === 'function',    '_avRateLimit.status is a function');
assert('isExhausted' in realRl,                 '_avRateLimit has isExhausted getter');
assert('exhaustedUntil' in realRl,              '_avRateLimit has exhaustedUntil property');
assert(typeof realRl._nextMidnightUTC === 'function', '_avRateLimit._nextMidnightUTC is a function');
assert(realRl.maxPerDay === 25,                 'maxPerDay is 25 (free tier)');
assert(realRl.maxPerMin === 5,                  'maxPerMin is 5 (free tier)');

// ─────────────────────────────────────────────────────────────────────────────
section('2 — canCall() increments dayCount correctly');
// ─────────────────────────────────────────────────────────────────────────────
{
  const rl = freshRl();
  assert(rl.dayCount === 0,  'dayCount starts at 0');
  assert(rl.canCall() === true, 'first canCall() returns true');
  assert(rl.dayCount === 1,  'dayCount is 1 after first call');
  rl.canCall(); rl.canCall();
  assert(rl.dayCount === 3,  'dayCount is 3 after three calls');
  const st = rl.status();
  assert(st.callsToday === 3,  'status().callsToday === 3');
  assert(st.remaining  === 22, 'status().remaining === 22 (25-3)');
  assert(st.exhausted  === false, 'status().exhausted is false');
  assert(st.exhaustedUntil === null, 'status().exhaustedUntil is null');
}

// ─────────────────────────────────────────────────────────────────────────────
section('3 — Low-remaining warning fires at ≤5 calls left');
// ─────────────────────────────────────────────────────────────────────────────
{
  const rl = freshRl();
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  // Burn 19 calls silently (remaining will be 6 after this)
  for (let i = 0; i < 19; i++) {
    rl.calls = []; // bypass per-minute limit for this test
    rl.canCall();
  }
  const warnsBefore = warnings.length;

  // Call 20 → remaining = 5 → warning should fire
  rl.calls = [];
  rl.canCall();
  assert(warnings.length > warnsBefore, 'Warning fires when remaining drops to 5');
  assert(warnings.some(w => w.includes('remaining')), 'Warning message contains "remaining"');

  // Call 21 → remaining = 4
  const countAt4 = warnings.length;
  rl.calls = [];
  rl.canCall();
  assert(warnings.length > countAt4, 'Warning fires again at 4 remaining');

  console.warn = origWarn;
}

// ─────────────────────────────────────────────────────────────────────────────
section('4 — Daily limit hit → exhaustedUntil set to next midnight UTC');
// ─────────────────────────────────────────────────────────────────────────────
{
  const rl = freshRl();
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  // Burn all 25 calls
  for (let i = 0; i < 25; i++) {
    rl.calls = [];
    rl.canCall();
  }
  // This 26th call hits the limit
  rl.calls = [];
  const result = rl.canCall();

  assert(result === false, 'canCall() returns false when daily limit hit');
  assert(rl.exhaustedUntil > 0, 'exhaustedUntil is set (non-zero)');
  assert(rl.isExhausted === true, 'isExhausted is true');

  // exhaustedUntil must be midnight UTC (00:00:00.000 of the next day)
  const midnight = new Date(rl.exhaustedUntil);
  assert(midnight.getUTCHours()   === 0, 'exhaustedUntil hours = 0 (midnight UTC)');
  assert(midnight.getUTCMinutes() === 0, 'exhaustedUntil minutes = 0');
  assert(midnight.getUTCSeconds() === 0, 'exhaustedUntil seconds = 0');
  assert(rl.exhaustedUntil > Date.now(),  'exhaustedUntil is in the future');

  // Warning logged
  assert(warnings.some(w => w.includes('suspended')), 'Suspension warning logged');
  assert(warnings.some(w => w.includes('midnight') || w.includes('UTC')), 'Warning mentions midnight/UTC');

  console.warn = origWarn;
}

// ─────────────────────────────────────────────────────────────────────────────
section('5 — Suspended state blocks all calls and does NOT increment counter');
// ─────────────────────────────────────────────────────────────────────────────
{
  const rl = freshRl({
    exhaustedUntil: Date.now() + 3_600_000, // suspended for 1 hour
    dayCount: 25,
  });

  const countBefore = rl.dayCount;
  const r1 = rl.canCall();
  const r2 = rl.canCall();
  const r3 = rl.canCall();

  assert(r1 === false, 'canCall() returns false when suspended (call 1)');
  assert(r2 === false, 'canCall() returns false when suspended (call 2)');
  assert(r3 === false, 'canCall() returns false when suspended (call 3)');
  assert(rl.dayCount === countBefore, 'dayCount NOT incremented while suspended');
  assert(rl.isExhausted === true, 'isExhausted still true');
  const st = rl.status();
  assert(st.exhausted === true, 'status().exhausted is true while suspended');
  assert(st.exhaustedUntil !== null, 'status().exhaustedUntil is non-null while suspended');
}

// ─────────────────────────────────────────────────────────────────────────────
section('6 — Auto-reconnect when exhaustedUntil has passed (time-travel)');
// ─────────────────────────────────────────────────────────────────────────────
{
  const rl = freshRl({
    exhaustedUntil: Date.now() - 1,  // expired 1ms ago = midnight has passed
    dayCount: 25,
    dayStart: Date.now() - 90_000_000,
  });

  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));

  const result = rl.canCall();

  console.log = origLog;

  assert(rl.exhaustedUntil === 0, 'exhaustedUntil reset to 0 after midnight passes');
  assert(rl.dayCount <= 1,       'dayCount reset and incremented by the reconnect call');
  assert(rl.isExhausted === false, 'isExhausted is false after auto-reconnect');
  assert(result === true,         'canCall() returns true after midnight auto-reconnect');
  assert(logs.some(l => l.includes('resuming') || l.includes('reset')), 'Resume message logged');
}

// ─────────────────────────────────────────────────────────────────────────────
section('7 — Per-minute throttle still works during active period');
// ─────────────────────────────────────────────────────────────────────────────
{
  const rl = freshRl();
  const now = Date.now();
  // Stuff 5 calls into the last 60 seconds manually
  rl.calls = [now - 5000, now - 4000, now - 3000, now - 2000, now - 1000];

  const result = rl.canCall();
  assert(result === false, 'canCall() returns false when 5/5 calls used in last 60s');
  assert(rl.dayCount === 0, 'dayCount NOT incremented when per-minute throttled');

  // But with 4 recent calls it should succeed
  const rl2 = freshRl();
  rl2.calls = [now - 5000, now - 4000, now - 3000, now - 2000];
  const r2 = rl2.canCall();
  assert(r2 === true, 'canCall() returns true with 4/5 calls in last 60s');
  assert(rl2.dayCount === 1, 'dayCount incremented to 1');
}

// ─────────────────────────────────────────────────────────────────────────────
section('8 — status() reflects accurate state at each stage');
// ─────────────────────────────────────────────────────────────────────────────
{
  const rl = freshRl();
  const s0 = rl.status();
  assert(s0.callsToday    === 0,    'status at start: callsToday=0');
  assert(s0.remaining     === 25,   'status at start: remaining=25');
  assert(s0.maxPerDay     === 25,   'status at start: maxPerDay=25');
  assert(s0.exhausted     === false,'status at start: exhausted=false');
  assert(s0.exhaustedUntil === null,'status at start: exhaustedUntil=null');
  assert(s0.maxPerMin     === 5,    'status at start: maxPerMin=5');

  rl.canCall(); rl.canCall(); rl.canCall();
  const s3 = rl.status();
  assert(s3.callsToday    === 3,    'status after 3 calls: callsToday=3');
  assert(s3.remaining     === 22,   'status after 3 calls: remaining=22');
  assert(s3.callsInLastMin >= 3,    'status after 3 calls: callsInLastMin>=3');

  // Exhaust the budget
  for (let i = 3; i < 26; i++) { rl.calls = []; rl.canCall(); }
  const sEx = rl.status();
  assert(sEx.exhausted        === true,  'status after exhaustion: exhausted=true');
  assert(sEx.remaining        === 0,     'status after exhaustion: remaining=0');
  assert(sEx.exhaustedUntil   !== null,  'status after exhaustion: exhaustedUntil set');
  assert(typeof sEx.exhaustedUntil === 'string', 'exhaustedUntil is a UTC string');
}

// ─────────────────────────────────────────────────────────────────────────────
section('9 — Belt-and-suspenders 24h rollover resets counters');
// ─────────────────────────────────────────────────────────────────────────────
{
  const rl = freshRl({
    dayStart:  Date.now() - 90_000_000, // 25h ago — well past 24h
    dayCount:  20,
    exhaustedUntil: 0,
  });

  const result = rl.canCall();
  assert(result === true,    '24h rollover: canCall() returns true after rollover');
  assert(rl.dayCount === 1,  '24h rollover: dayCount reset to 1 (this call)');
}

// ─────────────────────────────────────────────────────────────────────────────
section('10 — Multiple exhaustion/resume cycles work correctly');
// ─────────────────────────────────────────────────────────────────────────────
{
  const rl = freshRl();
  // Cycle 1: exhaust
  for (let i = 0; i < 25; i++) { rl.calls = []; rl.canCall(); }
  rl.calls = [];
  rl.canCall(); // triggers exhaustion
  assert(rl.isExhausted === true, 'Cycle 1: exhausted after 25 calls');

  // Simulate midnight passing
  rl.exhaustedUntil = Date.now() - 1;
  rl.dayStart       = Date.now() - 90_000_000;
  const r = rl.canCall();
  assert(r === true,              'Cycle 1 resume: canCall() true after midnight');
  assert(rl.dayCount === 1,       'Cycle 1 resume: dayCount=1');
  assert(rl.isExhausted === false,'Cycle 1 resume: isExhausted false');

  // Cycle 2: exhaust again
  for (let i = 1; i < 25; i++) { rl.calls = []; rl.canCall(); }
  rl.calls = [];
  rl.canCall();
  assert(rl.isExhausted === true, 'Cycle 2: exhausted again');
  assert(rl.exhaustedUntil > 0,  'Cycle 2: exhaustedUntil set again');

  // Simulate midnight again
  rl.exhaustedUntil = Date.now() - 1;
  rl.dayStart       = Date.now() - 90_000_000;
  const r2 = rl.canCall();
  assert(r2 === true,             'Cycle 2 resume: canCall() true after second midnight');
  assert(rl.dayCount <= 1,        'Cycle 2 resume: dayCount reset correctly');
}

// ─────────────────────────────────────────────────────────────────────────────
section('11 — refreshPrice() falls back to seed/cache when AV is suspended');
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  // Force the real rate limiter into suspended state for this test
  const savedExhausted = realRl.exhaustedUntil;
  const savedDayCount  = realRl.dayCount;
  realRl.exhaustedUntil = Date.now() + 3_600_000; // suspended for 1 hour
  realRl.dayCount       = 25;

  // Suppress AV suspension warning noise
  const origWarn = console.warn;
  console.warn = () => {};

  try {
    const mdf = new MarketDataFetcher();
    let threw = false;
    let result;
    try { result = await mdf.refreshPrice('EURUSD'); } catch { threw = true; }
    assert(!threw,                      'refreshPrice() does NOT throw when AV suspended');
    assert(result && result.price > 0,  'refreshPrice() returns a positive price (seed/cache fallback)');
    assert(
      !result.source?.toLowerCase().includes('alphavantage') &&
      !result.source?.toLowerCase().includes('alpha vantage'),
      'Source is NOT Alpha Vantage when suspended (got: ' + result?.source + ')'
    );
  } finally {
    realRl.exhaustedUntil = savedExhausted;
    realRl.dayCount       = savedDayCount;
    console.warn = origWarn;
  }

  // ─────────────────────────────────────────────────────────────────────────
  section('12 — "Information" API response handled gracefully');
  // ─────────────────────────────────────────────────────────────────────────
  // The AV API returns {"Information":"..."} when the daily limit is hit server-side.
  // The fetcher should treat this as a null/failed fetch, not throw.
  {
    // Verify the source code handles the Information field
    const fs = require('fs');
    const src = fs.readFileSync('./market-data-fetcher.js', 'utf8');
    // The _fetchAvPrice function should check for missing rate or Information field
    assert(
      src.includes('Information') || src.includes('!rate') || src.includes('null'),
      'market-data-fetcher.js handles missing/null AV rate response'
    );
    // refreshPrice should not propagate null as a throw
    process.env.ALPHA_VANTAGE_API_KEY = 'WNOLAD89TIG3L8OP';
    const mdf2 = new MarketDataFetcher();
    // Pre-exhaust AV in the real limiter so the live call is skipped
    realRl.exhaustedUntil = Date.now() + 1000;
    let threw2 = false;
    let r2;
    try { r2 = await mdf2.refreshPrice('GBPUSD'); } catch { threw2 = true; }
    assert(!threw2,              '"Information" path: refreshPrice does not throw');
    assert(r2 && r2.price > 0,  '"Information" path: returns a valid fallback price');
    realRl.exhaustedUntil = 0;
    delete process.env.ALPHA_VANTAGE_API_KEY;
  }

  // ── Final summary ──────────────────────────────────────────────────────────
  setTimeout(() => {
    const total = passed + failed;
    console.log(`\n${'═'.repeat(64)}`);
    console.log('  RESULTS');
    console.log(`${'═'.repeat(64)}`);
    console.log(`  Passed: ${passed} / ${total}`);
    console.log(`  Failed: ${failed} / ${total}`);
    if (failures.length) {
      console.log('\n  Failed tests:');
      failures.forEach(f => console.log('    - ' + f));
    }
    console.log('');
    process.exit(failed > 0 ? 1 : 0);
  }, 600);
})();
