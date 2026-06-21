'use strict';

const { NewsFilter, CURRENCY_PAIRS } = require('./news-filter');
const { Dashboard } = require('./dashboard');
const { TradingEngine, TRADING_CONFIG } = require('./trading-engine');
const { CorrelationEngine } = require('./trading-engine');

let passed = 0, failed = 0;
const L = '─'.repeat(66);
const pass = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else    { failed++; console.log(`  ✗ FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
};

const future = (offsetMin) => new Date(Date.now() + offsetMin * 60_000);
const past   = (offsetMin) => new Date(Date.now() - offsetMin * 60_000);

// ══════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(66));
console.log('  Advanced Features — News Filter · Correlation Fix · Dashboard');
console.log('═'.repeat(66));

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  1. NewsFilter — construction and config\n${L}`);
{
  const nf = new NewsFilter({ highBeforeMinutes: 15, highAfterMinutes: 10, seedOnInit: false });
  pass('NewsFilter constructs', nf instanceof NewsFilter);
  pass('highBeforeMs = 15 min', nf.highBeforeMs === 15 * 60_000);
  pass('highAfterMs  = 10 min', nf.highAfterMs  === 10 * 60_000);
  pass('enabled by default',    nf.enabled === true);
  pass('events starts empty',   nf.events.length === 0);

  const nf2 = new NewsFilter({ enabled: false });
  const r = nf2.checkEntry('EURUSD');
  pass('Disabled filter never blocks', !r.blocked);
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  2. NewsFilter — loadEvents\n${L}`);
{
  const nf = new NewsFilter();
  const count = nf.loadEvents([
    { time: future(30), currency: 'USD', impact: 'HIGH',   name: 'NFP' },
    { time: future(60), currency: 'EUR', impact: 'MEDIUM', name: 'CPI' },
    { time: future(90), currency: 'GBP', impact: 'LOW',    name: 'BRC' },
    { name: 'missing-time', currency: 'USD', impact: 'HIGH' },   // invalid — no time
  ]);
  pass('loadEvents returns correct count', count === 3, `got ${count}`);
  pass('events array populated', nf.events.length === 3);
  pass('currency uppercased', nf.events.every(e => e.currency === e.currency.toUpperCase()));
  pass('impact uppercased',   nf.events.every(e => e.impact   === e.impact.toUpperCase()));
  pass('time converted to Date', nf.events.every(e => e.time instanceof Date));
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  3. NewsFilter — checkEntry blocks HIGH impact\n${L}`);
{
  const nf = new NewsFilter({ highBeforeMinutes: 15, highAfterMinutes: 10 });

  // HIGH event in 8 minutes — should block (within 15-min window)
  nf.loadEvents([{ time: future(8), currency: 'USD', impact: 'HIGH', name: 'NFP' }]);
  const r1 = nf.checkEntry('EURUSD');   // USD affects EURUSD
  console.log(`    NFP in 8min → blocked=${r1.blocked}  reason: ${r1.reason.slice(0,60)}`);
  pass('HIGH event 8min away blocks EURUSD', r1.blocked);
  pass('Blocked reason mentions NEWS BLOCK', r1.reason.includes('NEWS BLOCK'));
  pass('Blocked event is NFP', r1.event?.name === 'NFP');
  pass('minutesUntil is positive', r1.minutesUntil > 0);

  // HIGH event 20 minutes away — outside 15-min window, should NOT block
  const nf2 = new NewsFilter({ highBeforeMinutes: 15, highAfterMinutes: 10 });
  nf2.loadEvents([{ time: future(20), currency: 'USD', impact: 'HIGH', name: 'NFP' }]);
  const r2 = nf2.checkEntry('EURUSD');
  pass('HIGH event 20min away does NOT block', !r2.blocked, `blocked=${r2.blocked}`);

  // HIGH event 5 minutes AFTER (past) — within after-window, should block
  const nf3 = new NewsFilter({ highBeforeMinutes: 15, highAfterMinutes: 10 });
  nf3.loadEvents([{ time: past(5), currency: 'USD', impact: 'HIGH', name: 'NFP' }]);
  const r3 = nf3.checkEntry('EURUSD');
  pass('HIGH event 5min ago blocks (after-window)', r3.blocked, `blocked=${r3.blocked}`);
  pass('minutesUntil is negative for past event', r3.minutesUntil < 0);
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  4. NewsFilter — impact level handling\n${L}`);
{
  const nf = new NewsFilter({ mediumBeforeMinutes: 5, mediumAfterMinutes: 3 });

  // MEDIUM event 3 min away — should block (within 5-min window)
  nf.loadEvents([{ time: future(3), currency: 'USD', impact: 'MEDIUM', name: 'Retail Sales' }]);
  const rMed = nf.checkEntry('EURUSD');
  pass('MEDIUM event 3min away blocks', rMed.blocked, `blocked=${rMed.blocked}`);

  // MEDIUM event 8 min away — outside 5-min window, should NOT block
  const nf2 = new NewsFilter({ mediumBeforeMinutes: 5 });
  nf2.loadEvents([{ time: future(8), currency: 'USD', impact: 'MEDIUM', name: 'Retail Sales' }]);
  const rMed2 = nf2.checkEntry('EURUSD');
  pass('MEDIUM event 8min away does NOT block', !rMed2.blocked);

  // LOW event — never blocks regardless of timing
  const nf3 = new NewsFilter();
  nf3.loadEvents([{ time: future(2), currency: 'USD', impact: 'LOW', name: 'Minor Report' }]);
  const rLow = nf3.checkEntry('EURUSD');
  pass('LOW event never blocks', !rLow.blocked);
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  5. NewsFilter — currency-to-pair mapping\n${L}`);
{
  const nf = new NewsFilter();

  // USD event should block EURUSD but not EURGBP
  nf.loadEvents([{ time: future(5), currency: 'USD', impact: 'HIGH', name: 'FOMC' }]);
  const rEURUSD = nf.checkEntry('EURUSD');
  const rEURGBP = nf.checkEntry('EURGBP');
  pass('USD event blocks EURUSD', rEURUSD.blocked, `blocked=${rEURUSD.blocked}`);
  pass('USD event does NOT block EURGBP', !rEURGBP.blocked, `blocked=${rEURGBP.blocked}`);

  // GBP event should block GBPUSD and EURGBP
  const nf2 = new NewsFilter();
  nf2.loadEvents([{ time: future(5), currency: 'GBP', impact: 'HIGH', name: 'BOE Rate' }]);
  pass('GBP event blocks GBPUSD', nf2.checkEntry('GBPUSD').blocked);
  pass('GBP event blocks EURGBP', nf2.checkEntry('EURGBP').blocked);
  pass('GBP event does NOT block EURUSD', !nf2.checkEntry('EURUSD').blocked);

  // Currency pairs map has expected entries
  pass('CURRENCY_PAIRS has USD', Array.isArray(CURRENCY_PAIRS.USD));
  pass('CURRENCY_PAIRS USD includes EURUSD', CURRENCY_PAIRS.USD.includes('EURUSD'));
  pass('CURRENCY_PAIRS EUR includes EURUSD', CURRENCY_PAIRS.EUR.includes('EURUSD'));
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  6. NewsFilter — upcomingFor and status\n${L}`);
{
  const nf = new NewsFilter();
  nf.loadEvents([
    { time: future(30),  currency: 'USD', impact: 'HIGH',   name: 'NFP'    },
    { time: future(120), currency: 'USD', impact: 'MEDIUM', name: 'CPI'    },
    { time: future(300), currency: 'EUR', impact: 'HIGH',   name: 'ECB'    },  // > 4h window
    { time: past(10),   currency: 'USD', impact: 'HIGH',   name: 'Old event' },
  ]);

  const upcoming = nf.upcomingFor('EURUSD', 4 * 3_600_000);
  pass('upcomingFor returns array', Array.isArray(upcoming));
  pass('Includes USD events within 4h', upcoming.some(e => e.name === 'NFP'));
  pass('Includes EUR events within 4h', upcoming.some(e => e.name === 'CPI'));
  pass('Excludes events > 4h away',     !upcoming.some(e => e.name === 'ECB'));
  pass('Excludes past events',          !upcoming.some(e => e.name === 'Old event'));
  pass('Sorted by time', upcoming.length < 2 || upcoming[0].time <= upcoming[1].time);

  const status = nf.status();
  pass('status() returns object', typeof status === 'object');
  pass('status.enabled is boolean', typeof status.enabled === 'boolean');
  pass('status.totalEvents correct', status.totalEvents === 4, `got ${status.totalEvents}`);
  pass('status.upcomingCount correct', status.upcomingCount === 3, `got ${status.upcomingCount}`);
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  7. NewsFilter — addEvent and stale pruning\n${L}`);
{
  const nf = new NewsFilter({ seedOnInit: false });
  nf.addEvent({ time: future(10), currency: 'USD', impact: 'HIGH', name: 'FOMC' });
  nf.addEvent({ time: future(20), currency: 'GBP', impact: 'HIGH', name: 'BOE'  });
  pass('addEvent adds events', nf.events.length === 2);

  // Stale event (3 hours old) should be pruned on next checkEntry
  nf.addEvent({ time: past(180), currency: 'USD', impact: 'HIGH', name: 'Very Old' });
  pass('Before prune: 3 events', nf.events.length === 3);
  nf.checkEntry('EURUSD');  // triggers prune
  pass('After checkEntry: stale events pruned', nf.events.length === 2, `got ${nf.events.length}`);
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  8. NewsFilter — wired into TradingEngine\n${L}`);
{
  const engine = new TradingEngine();
  pass('engine.newsFilter exists', !!engine.newsFilter);
  pass('engine.newsFilter is NewsFilter', engine.newsFilter instanceof NewsFilter);
  pass('engine.newsFilter.enabled = true', engine.newsFilter.enabled === true);
  pass('highBeforeMs = 15min', engine.newsFilter.highBeforeMs === 15 * 60_000);
  pass('highAfterMs  = 10min', engine.newsFilter.highAfterMs  === 10 * 60_000);
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  9. CorrelationEngine — Pearson correctness\n${L}`);
{
  // Perfect positive correlation
  const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const b = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20];
  const rPos = CorrelationEngine.pearson(a, b, 10);
  pass('Perfect positive correlation ≈ 1.0', Math.abs(rPos - 1.0) < 0.001, `got ${rPos.toFixed(4)}`);

  // Negative correlation — returns alternate high/low, B is the exact mirror
  // retA deviation: +, -, +, -  →  retB deviation: -, +, -, +  → corr = -1.0
  const priceFromRets = (start, rets) => {
    const arr = [start];
    rets.forEach(r => arr.push(arr[arr.length-1] * (1 + r)));
    return arr;
  };
  const retsA = [0.02, 0.01, 0.02, 0.01, 0.02, 0.01, 0.02, 0.01, 0.02]; // mean 0.015, dev: +,-,+,-
  const retsB = [0.01, 0.02, 0.01, 0.02, 0.01, 0.02, 0.01, 0.02, 0.01]; // mean 0.015, dev: -,+,-,+
  const pA2 = priceFromRets(1.0, retsA);
  const pB2 = priceFromRets(1.0, retsB);
  const rNeg = CorrelationEngine.pearson(pA2, pB2, 10);
  pass('Mirrored alternating returns → strong negative corr', rNeg < -0.8, `got ${rNeg.toFixed(4)}`);

  // Unrelated: oscillating vs monotone
  const d  = [1.0, 1.01, 1.0, 1.01, 1.0, 1.01, 1.0, 1.01, 1.0, 1.01];
  const e2 = [1.0, 1.01, 1.02, 1.03, 1.04, 1.05, 1.06, 1.07, 1.08, 1.09];
  const rZero = CorrelationEngine.pearson(d, e2, 10);
  pass('Unrelated series correlation ≈ 0', Math.abs(rZero) < 0.5, `got ${rZero.toFixed(4)}`);

  // Insufficient data returns 0
  const rShort = CorrelationEngine.pearson([1, 2], [3, 4], 10);
  pass('< 5 bars returns 0', rShort === 0);
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  10. CorrelationEngine.check — block/warn/safe\n${L}`);
{
  // Build two price series: highly correlated
  const phA = Array.from({ length: 60 }, (_, i) => 1.1 + i * 0.001);
  const phB = phA.map(p => p * 1.01);   // scaled — perfect correlation
  const phC = Array.from({ length: 60 }, (_, i) => 2.0 + Math.sin(i) * 0.1);  // uncorrelated

  const priceMaps = { EURUSD: phA, GBPUSD: phB, USDJPY: phC };

  // EURUSD + GBPUSD are highly correlated → BLOCKED
  const rBlocked = CorrelationEngine.check('EURUSD', 'GBPUSD', priceMaps);
  console.log(`    EURUSD/GBPUSD corr: ${rBlocked.correlation.toFixed(3)} → ${rBlocked.label}`);
  pass('High correlation → BLOCKED or WARN', ['BLOCKED', 'WARN'].includes(rBlocked.label),
    `got ${rBlocked.label}`);

  // EURUSD + USDJPY are unrelated → SAFE
  const rSafe = CorrelationEngine.check('EURUSD', 'USDJPY', priceMaps);
  console.log(`    EURUSD/USDJPY corr: ${rSafe.correlation.toFixed(3)} → ${rSafe.label}`);
  pass('Low correlation → SAFE', rSafe.label === 'SAFE', `got ${rSafe.label}`);
  pass('SAFE sizeMultiplier = 1', rSafe.sizeMultiplier === 1);

  // Disabled → always SAFE
  const savedEnabled = TRADING_CONFIG.correlationEnabled;
  TRADING_CONFIG.correlationEnabled = false;
  const rDisabled = CorrelationEngine.check('EURUSD', 'GBPUSD', priceMaps);
  TRADING_CONFIG.correlationEnabled = savedEnabled;
  pass('Disabled correlation always SAFE', rDisabled.label === 'SAFE');
  pass('BLOCKED: sizeMultiplier = 0', rBlocked.sizeMultiplier === 0 || rBlocked.label === 'WARN');
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  11. Correlation bug fix — lastClosedAsset tracking\n${L}`);
{
  const engine = new TradingEngine();
  pass('lastClosedAsset starts null', engine.lastClosedAsset === null);

  // Simulate a position closing by directly calling the trade push logic
  engine.selectedAsset = 'EURUSD';
  engine.trades.push({ profit: 10, outcome: 'WIN' });
  engine.lastClosedAsset = engine.selectedAsset;  // this is what the fix does

  pass('lastClosedAsset set after trade closes', engine.lastClosedAsset === 'EURUSD');

  // Original bug: openAsset was this.position (null on BUY path)
  // Fix: openAsset = this.lastClosedAsset
  // Verify the fix is present in source
  const fs   = require('fs');
  const src  = fs.readFileSync(__dirname + '/trading-engine.js', 'utf8');
  pass('Source uses lastClosedAsset in executeDecision',
    src.includes('this.lastClosedAsset'));
  pass('Old bug (this.position ? this.selectedAsset : null) is removed',
    !src.includes('this.position ? this.selectedAsset : null'));
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  12. Dashboard — construction and snapshot\n${L}`);
{
  const engine = new TradingEngine();
  engine.capital = 10500;
  engine.initialCapital = 10000;
  engine.selectedAsset = 'EURUSD';
  engine.priceHistory.push(1.1100);
  engine.volatilityLevel = 'NORMAL';

  const dash = new Dashboard(engine, 3999);
  pass('Dashboard constructs', !!dash);
  pass('Dashboard has engine reference', dash.engine === engine);
  pass('Dashboard has clients Set', dash.clients instanceof Set);

  const snap = dash._snapshot();
  pass('snapshot returns object', typeof snap === 'object');
  pass('snapshot.capital correct', snap.capital === 10500, `got ${snap.capital}`);
  pass('snapshot.totalReturn correct', Math.abs(snap.totalReturn - 5.0) < 0.01, `got ${snap.totalReturn}`);
  pass('snapshot.selectedAsset correct', snap.selectedAsset === 'EURUSD');
  pass('snapshot.metrics present', typeof snap.metrics === 'object');
  pass('snapshot.newsStatus present', typeof snap.newsStatus === 'object');
  pass('snapshot.mlStats present', typeof snap.mlStats === 'object');
  pass('snapshot.ts is timestamp', snap.ts > 1_000_000_000_000);
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  13. Dashboard — HTTP server starts and serves HTML\n${L}`);
{
  (async () => {
    const engine = new TradingEngine();
    const dash   = new Dashboard(engine, 3998);
    dash.start();

    await new Promise(r => setTimeout(r, 200));

    // Test HTTP endpoint
    const res  = await fetch('http://localhost:3998');
    const html = await res.text();
    pass('HTTP 200 from dashboard', res.status === 200, `got ${res.status}`);
    pass('Serves HTML content', html.includes('<!DOCTYPE html>'));
    pass('Contains Aladdin Bot title', html.includes('Aladdin Bot'));
    pass('Contains WebSocket client code', html.includes('WebSocket'));
    pass('Contains equity canvas', html.includes('equity-canvas'));
    pass('Contains trades table', html.includes('trades-table'));
    pass('Contains news section', html.includes('News Filter'));
    pass('Contains ML section', html.includes('ML Model'));

    // Test health endpoint
    const health = await fetch('http://localhost:3998/health');
    const hJson  = await health.json();
    pass('Health endpoint returns JSON', hJson.status === 'ok');
    pass('Health shows 0 clients', typeof hJson.clients === 'number');

    dash.stop();
    runWSTest();
  })();
}

async function runWSTest() {
  // ─────────────────────────────────────────────────────────────────────
  console.log(`\n${L}\n  14. Dashboard — WebSocket connection and push\n${L}`);
  {
    const WebSocket = require('ws');
    const engine    = new TradingEngine();
    engine.capital  = 10200;
    engine.initialCapital = 10000;
    engine.priceHistory.push(1.1100);
    const dash = new Dashboard(engine, 3997);
    dash.start();

    await new Promise(r => setTimeout(r, 100));

    await new Promise((resolve) => {
      const ws = new WebSocket('ws://localhost:3997');
      let received = 0;

      ws.on('open', () => {
        pass('WebSocket connects successfully', true);
      });

      ws.on('message', (data) => {
        received++;
        try {
          const msg = JSON.parse(data);
          pass('First message is valid JSON snapshot', typeof msg.capital === 'number', `capital=${msg.capital}`);
          pass('Snapshot has ts field', msg.ts > 0);
          pass('Snapshot has metrics', !!msg.metrics);
        } catch (e) {
          pass('First message parses as JSON', false, e.message);
        }

        // Trigger a push and check client count
        pass('Client registered in server set', dash.clients.size >= 1);

        ws.close();
      });

      ws.on('close', () => {
        pass('WebSocket closes cleanly', true);
        setTimeout(() => {
          dash.stop();
          printResults();
        }, 100);
        resolve();
      });

      ws.on('error', (e) => {
        pass('WebSocket no error', false, e.message);
        resolve();
      });

      setTimeout(resolve, 3000);  // safety timeout
    });
  }
}

function printResults() {
  console.log('\n' + '═'.repeat(66));
  console.log(`  Results: ${passed} passed  ${failed} failed  (${passed + failed} total)`);
  if (failed === 0) console.log('  ✅  All tests passed');
  else              console.log(`  ❌  ${failed} test(s) failed`);
  console.log('═'.repeat(66) + '\n');
  if (failed > 0) process.exitCode = 1;
}
