'use strict';
// ── test-asset-normalisation.js ───────────────────────────────────────────────
// Heavy tests for the /_/g global-regex normaliser added to:
//   • MarketDataFetcher.fetchPrice()
//   • MarketDataFetcher.refreshPrice()
//   • MarketDataFetcher.warmUpHistory()
//   • TradingEngine.loadPositionFromFile() (line 558)
// And for the dashboard pair-selector option values (EURUSD, not EUR_USD).
// ─────────────────────────────────────────────────────────────────────────────
const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

(async () => {
  let passed = 0, failed = 0;
  const failures = [];

  function assert(cond, label, detail = '') {
    if (cond) { process.stdout.write(`  ✅ ${label}\n`); passed++; }
    else {
      process.stdout.write(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}\n`);
      failed++;
      failures.push(label);
    }
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  Asset-Name Normalisation — Heavy Test Suite');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const { MarketDataFetcher } = require('./market-data-fetcher');

  const UNDERSCORE_PAIRS = ['EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD'];
  const CANONICAL_PAIRS  = ['EURUSD',  'GBPUSD',  'USDJPY',  'AUDUSD'];

  // ── Section 1: fetchPrice /_/g normalisation ──────────────────────────────
  console.log('── Section 1: fetchPrice /_/g normalisation ────────────────────');

  const f = new MarketDataFetcher();

  // Every underscore pair must work without throwing
  for (const p of UNDERSCORE_PAIRS) {
    let r;
    try { r = f.fetchPrice(p); }
    catch(e) { assert(false, `fetchPrice(${p}) must not throw`, e.message); continue; }
    const expected = p.replace(/_/g, '');
    assert(r.price > 0,              `fetchPrice(${p}): price > 0`);
    assert(r.asset === expected,     `fetchPrice(${p}): returned asset is normalised "${expected}" (got "${r.asset}")`);
    assert(!r.asset.includes('_'),   `fetchPrice(${p}): returned asset contains no underscore`);
    assert(Array.isArray(r.history), `fetchPrice(${p}): history is array`);
    assert(Array.isArray(r.volumeHistory), `fetchPrice(${p}): volumeHistory is array`);
    assert(r.ask > r.bid,            `fetchPrice(${p}): ask > bid`);
    assert(typeof r.source === 'string', `fetchPrice(${p}): source is string`);
    assert(r.timestamp > 0,          `fetchPrice(${p}): timestamp > 0`);
  }

  // Canonical EURUSD format must still work unchanged
  for (const p of CANONICAL_PAIRS) {
    let r;
    try { r = f.fetchPrice(p); }
    catch(e) { assert(false, `fetchPrice(${p}) canonical must not throw`, e.message); continue; }
    assert(r.price > 0,          `fetchPrice(${p}) canonical: price > 0`);
    assert(r.asset === p,        `fetchPrice(${p}) canonical: asset unchanged`);
  }

  // Global regex: double-underscore is fully stripped → EURUSD (unsupported, throws clean message)
  {
    try { f.fetchPrice('EUR__USD'); assert(false, 'fetchPrice(EUR__USD) should throw'); }
    catch(e) {
      assert(e.message.includes('not supported'), 'fetchPrice(EUR__USD): throws "not supported"');
      assert(e.message.includes('EURUSD'),        'fetchPrice(EUR__USD): error names normalised form EURUSD');
      assert(!e.message.includes('EUR__USD'),     'fetchPrice(EUR__USD): error does not leak original form');
    }
  }

  // Non-forex symbols with no underscores pass through unchanged
  for (const sym of ['AAPL', 'TSLA', 'SPY']) {
    try { f.fetchPrice(sym); assert(false, `fetchPrice(${sym}) should throw (not seeded)`); }
    catch(e) {
      assert(e.message.includes(sym), `fetchPrice(${sym}): error contains original symbol (no mutation)`);
    }
  }

  // Unsupported underscore pair: error names normalised form, not original
  {
    try { f.fetchPrice('BTC_USD'); assert(false, 'fetchPrice(BTC_USD) should throw'); }
    catch(e) {
      assert(e.message.includes('BTCUSD') && !e.message.includes('BTC_USD'),
        'fetchPrice(BTC_USD): error says "BTCUSD not supported"');
    }
  }

  // Idempotent: calling twice returns identical values
  {
    const r1 = f.fetchPrice('EUR_USD');
    const r2 = f.fetchPrice('EUR_USD');
    assert(r1.asset === r2.asset && r1.price === r2.price, 'fetchPrice idempotent across two calls');
  }

  // Cross-format equivalence: EUR_USD and EURUSD return same price
  {
    const rUnderscore = f.fetchPrice('EUR_USD');
    const rCanonical  = f.fetchPrice('EURUSD');
    assert(rUnderscore.price === rCanonical.price, 'fetchPrice: EUR_USD and EURUSD return same price');
    assert(rUnderscore.asset === rCanonical.asset, 'fetchPrice: EUR_USD and EURUSD return same asset string');
  }

  // history array is a copy (mutation-safe)
  {
    const r = f.fetchPrice('EURUSD');
    const before = r.history.length;
    r.history.push(9999);
    const r2 = f.fetchPrice('EURUSD');
    assert(r2.history.length === before, 'fetchPrice: history is a defensive copy (push does not leak in)');
  }

  // ── Section 2: refreshPrice /_/g normalisation (async) ───────────────────
  console.log('\n── Section 2: refreshPrice /_/g normalisation ──────────────────');

  // Every underscore pair — must not throw, must return price
  for (const p of UNDERSCORE_PAIRS) {
    try {
      const r = await f.refreshPrice(p);
      assert(r && typeof r.price === 'number' && r.price > 0, `refreshPrice(${p}): price > 0`);
    } catch(e) { assert(false, `refreshPrice(${p}) must not throw`, e.message); }
  }

  // Canonical format still works
  for (const p of CANONICAL_PAIRS) {
    try {
      const r = await f.refreshPrice(p);
      assert(r && r.price > 0, `refreshPrice(${p}) canonical: still works`);
    } catch(e) { assert(false, `refreshPrice(${p}) canonical must not throw`, e.message); }
  }

  // Underscore call stores result under canonical key, NOT underscore key
  {
    const f2 = new MarketDataFetcher();
    await f2.refreshPrice('GBP_USD');
    assert(f2.prices['GBPUSD']  !== undefined, 'refreshPrice(GBP_USD): stores under GBPUSD key');
    assert(f2.prices['GBP_USD'] === undefined, 'refreshPrice(GBP_USD): does NOT create GBP_USD key');
  }

  // All 4 underscore pairs write canonical keys
  {
    const f3 = new MarketDataFetcher();
    for (const p of UNDERSCORE_PAIRS) await f3.refreshPrice(p);
    for (const c of CANONICAL_PAIRS) {
      assert(f3.prices[c] !== undefined, `refreshPrice: ${c} key exists after underscore call`);
    }
    for (const u of UNDERSCORE_PAIRS) {
      assert(f3.prices[u] === undefined, `refreshPrice: ${u} key does NOT exist after underscore call`);
    }
  }

  // Rate-limit: second call within refresh interval returns same object reference
  {
    const f4 = new MarketDataFetcher();
    const r1 = await f4.refreshPrice('EUR_USD');
    const r2 = await f4.refreshPrice('EUR_USD');
    assert(r1 === r2, 'refreshPrice: second call within interval returns same cached object');
  }

  // Unsupported pair rejects
  {
    try { await f.refreshPrice('XRP_USD'); assert(false, 'refreshPrice(XRP_USD) should throw'); }
    catch(e) { assert(e.message.includes('not supported'), 'refreshPrice unsupported: throws clearly'); }
  }

  // Return structure complete
  {
    const r = await f.refreshPrice('USD_JPY');
    assert(typeof r.price  === 'number', 'refreshPrice return: price is number');
    assert(typeof r.source === 'string', 'refreshPrice return: source is string');
    assert(r.price > 0,                 'refreshPrice return: price > 0');
  }

  // ── Section 3: warmUpHistory /_/g normalisation ───────────────────────────
  console.log('\n── Section 3: warmUpHistory /_/g normalisation ─────────────────');

  // All 4 underscore pairs: history stored under canonical key
  for (const p of UNDERSCORE_PAIRS) {
    const f5 = new MarketDataFetcher();
    await f5.warmUpHistory(p, 20);
    const canonical = p.replace(/_/g, '');
    const h = f5.getPriceHistory(canonical);
    assert(h.length >= 20,
      `warmUpHistory(${p}): history stored under "${canonical}" (got ${h.length})`);
    assert(f5.getPriceHistory(p).length === 0,
      `warmUpHistory(${p}): no history under underscore key "${p}"`);
  }

  // Canonical format still works
  for (const p of CANONICAL_PAIRS) {
    const f6 = new MarketDataFetcher();
    await f6.warmUpHistory(p, 10);
    assert(f6.getPriceHistory(p).length >= 10, `warmUpHistory(${p}) canonical: still works`);
  }

  // Seed price is updated under canonical key after warmUp with underscore input
  {
    const f7 = new MarketDataFetcher();
    await f7.warmUpHistory('AUD_USD', 15);
    assert(f7.prices['AUDUSD'] !== undefined,
      'warmUpHistory(AUD_USD): prices entry exists under AUDUSD key');
    assert(f7.prices['AUD_USD'] === undefined,
      'warmUpHistory(AUD_USD): no prices entry under AUD_USD key');
  }

  // History length is capped at min(count, maxHistoryLength) — not unbounded
  {
    const f8 = new MarketDataFetcher();
    await f8.warmUpHistory('EUR_USD', 30);
    const h = f8.getPriceHistory('EURUSD');
    assert(h.length <= 500, 'warmUpHistory: history capped at maxHistoryLength');
    assert(h.length >= 30,  'warmUpHistory: history has at least requested count');
  }

  // Unknown/unsupported asset silently returns (no throw)
  for (const bad of ['BTC_USD', 'ETH_USD', 'UNKNOWN']) {
    const f9 = new MarketDataFetcher();
    let threw = false;
    try { await f9.warmUpHistory(bad, 5); } catch { threw = true; }
    assert(!threw, `warmUpHistory(${bad}) silently returns for unsupported asset`);
  }

  // Prices in history are all finite positive numbers
  {
    const f10 = new MarketDataFetcher();
    await f10.warmUpHistory('EUR_USD', 10);
    const h = f10.getPriceHistory('EURUSD');
    assert(h.every(p => isFinite(p) && p > 0), 'warmUpHistory(EUR_USD): all history prices are finite > 0');
  }

  // ── Section 4: Engine loadPositionFromFile normalisation ──────────────────
  console.log('\n── Section 4: loadPositionFromFile asset normalisation ──────────');

  // Test the exact normalisation expression from line 558:
  //   this.selectedAsset = (data.selectedAsset ?? this.selectedAsset).replace(/_/g, '');
  function simulateLoad(dataSA, engineSA = 'EURUSD') {
    return (dataSA ?? engineSA).replace(/_/g, '');
  }

  // Underscore inputs → canonical
  assert(simulateLoad('EUR_USD') === 'EURUSD', 'loadPosition: EUR_USD → EURUSD');
  assert(simulateLoad('GBP_USD') === 'GBPUSD', 'loadPosition: GBP_USD → GBPUSD');
  assert(simulateLoad('USD_JPY') === 'USDJPY', 'loadPosition: USD_JPY → USDJPY');
  assert(simulateLoad('AUD_USD') === 'AUDUSD', 'loadPosition: AUD_USD → AUDUSD');
  assert(simulateLoad('USD_CAD') === 'USDCAD', 'loadPosition: USD_CAD → USDCAD');
  assert(simulateLoad('NZD_USD') === 'NZDUSD', 'loadPosition: NZD_USD → NZDUSD');

  // Already-canonical inputs are unchanged
  for (const p of CANONICAL_PAIRS) {
    assert(simulateLoad(p) === p, `loadPosition: already-clean ${p} unchanged`);
  }

  // Null/undefined data → falls back to engine's current selectedAsset
  assert(simulateLoad(null,      'EURUSD') === 'EURUSD', 'loadPosition: null data → engine default EURUSD');
  assert(simulateLoad(undefined, 'GBPUSD') === 'GBPUSD', 'loadPosition: undefined data → engine default GBPUSD');
  assert(simulateLoad(null,      'EUR_USD') === 'EURUSD', 'loadPosition: null data + underscore fallback → normalised');

  // Global regex: double-underscore
  assert(simulateLoad('EUR__USD') === 'EURUSD', 'loadPosition: EUR__USD → EURUSD (global strips all)');
  assert(simulateLoad('_EURUSD')  === 'EURUSD', 'loadPosition: leading underscore stripped');

  // Source code verification: line 558 contains the global regex
  {
    const engSrc   = fs.readFileSync('./trading-engine.js', 'utf8');
    const line558  = engSrc.split('\n')[557];
    assert(line558.includes('replace(/_/g,'),  'trading-engine.js line 558: uses global /_/g regex');
    assert(line558.includes('selectedAsset'),   'trading-engine.js line 558: assigns to selectedAsset');
    assert(!line558.includes("replace('_',"),   'trading-engine.js line 558: old non-global replace is gone');
  }

  // Verify loadPositionFromFile is a real method on TradingEngine
  {
    const engSrc = fs.readFileSync('./trading-engine.js', 'utf8');
    assert(engSrc.includes('loadPositionFromFile()'), 'trading-engine.js: loadPositionFromFile method defined');
  }

  // Functional test via temp position file
  {
    const TEMP = path.join(__dirname, 'trade_logs', '_norm_test_pos.json');
    fs.mkdirSync(path.join(__dirname, 'trade_logs'), { recursive: true });
    const testCases = [
      { input: 'EUR_USD', expected: 'EURUSD' },
      { input: 'GBP_USD', expected: 'GBPUSD' },
      { input: 'EURUSD',  expected: 'EURUSD' },
      { input: 'USD_JPY', expected: 'USDJPY' },
    ];
    for (const { input, expected } of testCases) {
      const data = {
        position:      { entry: 1.1, shares: 100, side: 'LONG', stopLoss: 1.09, takeProfit: 1.12 },
        capital:       10000,
        selectedAsset: input,
        savedAt:       new Date().toISOString(),
      };
      fs.writeFileSync(TEMP, JSON.stringify(data));

      // Patch TRADING_CONFIG.positionFile to point at our temp file, call the method
      const { TRADING_CONFIG } = require('./trading-config');
      const origFile = TRADING_CONFIG.positionFile;
      TRADING_CONFIG.positionFile = path.relative(__dirname, TEMP);

      // Create a minimal object that has loadPositionFromFile's prerequisites
      const mini = {
        position: null,
        capital: 10000,
        selectedAsset: 'AUDUSD',   // deliberately different default
        _reconcileRestoredPosition: async () => {},
      };
      // Borrow the method from TradingEngine prototype
      const TradingEngine = require('./trading-engine').TradingEngine;
      TradingEngine.prototype.loadPositionFromFile.call(mini);

      assert(mini.selectedAsset === expected,
        `loadPositionFromFile: "${input}" in file → "${expected}" in engine (got "${mini.selectedAsset}")`);

      TRADING_CONFIG.positionFile = origFile;
    }
    try { fs.unlinkSync(TEMP); } catch {}
  }

  // ── Section 5: Dashboard HTML — option VALUES are EURUSD format ───────────
  console.log('\n── Section 5: Dashboard pair selector values ───────────────────');

  const dashSrc   = fs.readFileSync('./dashboard.js', 'utf8');
  const htmlMatch = dashSrc.match(/const HTML = `([\s\S]*?)`;/);
  const html      = htmlMatch ? htmlMatch[1] : '';
  assert(html.length > 100, 'dashboard.js HTML template extracted');

  const EXPECTED_VALUES = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'NZDUSD'];
  const REMOVED_VALUES  = ['EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD', 'USD_CAD', 'NZD_USD'];

  for (const v of EXPECTED_VALUES) {
    assert(html.includes(`value="${v}"`), `HTML: option value="${v}" present (EURUSD format)`);
  }
  for (const v of REMOVED_VALUES) {
    assert(!html.includes(`value="${v}"`), `HTML: old option value="${v}" absent (no underscore format)`);
  }

  // Display labels still readable (EUR/USD etc.)
  for (const label of ['EUR/USD', 'GBP/USD', 'USD/JPY', 'AUD/USD']) {
    assert(html.includes(label), `HTML: display label "${label}" present`);
  }

  // No underscore-format value appears anywhere in the pair-select block
  {
    const selectBlock = html.match(/<select id="pair-select"[\s\S]*?<\/select>/)?.[0] || '';
    assert(selectBlock.length > 0, 'HTML: pair-select block found');
    const underscoreValues = selectBlock.match(/value="[A-Z]{3}_[A-Z]{3}"/g) || [];
    assert(underscoreValues.length === 0,
      `HTML: zero underscore-format values in pair-select (found: ${underscoreValues.join(', ') || 'none'})`);
  }

  // ── Section 6: DOM — pair-select sync with EURUSD assets ─────────────────
  console.log('\n── Section 6: DOM — pair-select EURUSD sync ────────────────────');

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost:19877',
    beforeParse(w) {
      const fakeCtx = {
        clearRect: () => {}, beginPath: () => {}, moveTo: () => {},
        lineTo: () => {}, stroke: () => {}, fill: () => {}, closePath: () => {},
      };
      w.HTMLCanvasElement.prototype.getContext = () => fakeCtx;
      w.WebSocket = class {
        constructor() { this.readyState = 3; setTimeout(() => { if (this.onerror) this.onerror({}); }, 5); }
        close() { if (this.onclose) this.onclose({}); }
        send() {}
      };
    },
  });

  const { window: win } = dom;
  await sleep(80);

  const domGet  = id  => win.document.getElementById(id);
  const pairSel = domGet('pair-select');

  // Option values are all EURUSD format
  const optVals = pairSel ? Array.from(pairSel.options).map(o => o.value) : [];
  for (const v of EXPECTED_VALUES) {
    assert(optVals.includes(v), `DOM: option "${v}" present in pair-select`);
  }
  for (const v of REMOVED_VALUES) {
    assert(!optVals.includes(v), `DOM: old option "${v}" absent from pair-select`);
  }

  // update() syncs pair-select when d.asset is EURUSD format
  const updateFn = win.update;
  if (typeof updateFn !== 'function') {
    assert(false, 'DOM: update() accessible as window.update');
  } else {
    assert(true, 'DOM: update() accessible as window.update');

    const base = {
      ts: Date.now(), capital: 10000, initialCapital: 10000,
      position: null, metrics: {}, recentTrades: [], mlStats: {}, mlOOS: {},
    };

    // Each EURUSD-format asset syncs the selector correctly
    for (const p of EXPECTED_VALUES) {
      updateFn({ ...base, asset: p, mlConfidenceScore: null, mlSignal: null, backtestMode: false });
      assert(pairSel.value === p, `DOM: pair-select syncs to EURUSD asset "${p}"`);
    }

    // Cycling through all options leaves the last selected
    for (const p of ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'EURUSD']) {
      updateFn({ ...base, asset: p, mlConfidenceScore: null, mlSignal: null, backtestMode: false });
    }
    assert(pairSel.value === 'EURUSD', 'DOM: pair-select settles on last asset after cycling');

    // Underscore-format asset does NOT match any option (no spurious sync)
    const valueBefore = pairSel.value;
    for (const p of REMOVED_VALUES) {
      updateFn({ ...base, asset: p, mlConfidenceScore: null, mlSignal: null, backtestMode: false });
      assert(pairSel.value !== p,
        `DOM: pair-select does not corrupt to underscore value "${p}" (no matching option)`);
    }

    // Non-forex tickers still work (no crash)
    for (const sym of ['AAPL', 'TSLA', 'SPY']) {
      let threw = false;
      try { updateFn({ ...base, asset: sym, mlConfidenceScore: null, mlSignal: null, backtestMode: false }); }
      catch { threw = true; }
      assert(!threw, `DOM: update() does not crash for stock ticker "${sym}"`);
    }
  }

  // ── Section 7: Source-code hygiene ───────────────────────────────────────
  console.log('\n── Section 7: Source-code hygiene ──────────────────────────────');

  // All three normaliser lines use global regex
  const mdfSrc = fs.readFileSync('./market-data-fetcher.js', 'utf8');
  const globalReplaces = (mdfSrc.match(/asset = asset\.replace\(\/_\/g,/g) || []).length;
  assert(globalReplaces === 3, `market-data-fetcher.js: exactly 3 global-regex normalisers (found ${globalReplaces})`);

  // No old non-global replace('_','') normaliser lines remain
  const oldReplaces = (mdfSrc.match(/asset = asset\.replace\('_',/g) || []).length;
  assert(oldReplaces === 0, `market-data-fetcher.js: no old replace('_','') lines remain (found ${oldReplaces})`);

  // SEED_PRICES keys are all canonical (no underscores)
  const seedMatch = mdfSrc.match(/const SEED_PRICES = \{([\s\S]*?)\}/);
  if (seedMatch) {
    const underscoreKeys = (seedMatch[1].match(/[A-Z]{3}_[A-Z]{3}/g) || []);
    assert(underscoreKeys.length === 0, `SEED_PRICES: no underscore keys (found: ${underscoreKeys.join(', ') || 'none'})`);
  }

  // TRADING_CONFIG.assets contains no underscored pairs
  const { TRADING_CONFIG } = require('./trading-config');
  const underscoreAssets = (TRADING_CONFIG.assets || []).filter(a => a.includes('_'));
  assert(underscoreAssets.length === 0,
    `TRADING_CONFIG.assets: no underscore pairs (found: ${underscoreAssets.join(', ') || 'none'})`);

  // config/trading-config.json assets contain no underscores
  const jsonConfig = JSON.parse(fs.readFileSync('./config/trading-config.json', 'utf8'));
  const jsonUnderscore = (jsonConfig.assets || []).filter(a => a.includes('_'));
  assert(jsonUnderscore.length === 0,
    `config/trading-config.json: no underscore pairs (found: ${jsonUnderscore.join(', ') || 'none'})`);

  // swapCosts keys are canonical
  const swapKeys = Object.keys(TRADING_CONFIG.swapCosts || {}).filter(k => k.includes('_'));
  assert(swapKeys.length === 0,
    `TRADING_CONFIG.swapCosts: no underscore keys (found: ${swapKeys.join(', ') || 'none'})`);

  // correlationLockPairs arrays contain no underscores
  const lockPairs = Object.values(TRADING_CONFIG.correlationLockPairs || {}).flat();
  const lockUnderscore = lockPairs.filter(p => p.includes('_'));
  assert(lockUnderscore.length === 0,
    `TRADING_CONFIG.correlationLockPairs: no underscore pairs (found: ${lockUnderscore.join(', ') || 'none'})`);

  // ── Final results ─────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  ✅ Passed:  ${passed} / ${total}`);
  console.log(`  ❌ Failed:  ${failed} / ${total}`);
  if (failures.length) {
    console.log('\n  Failed tests:');
    failures.forEach(f => console.log('    · ' + f));
  }
  console.log('');
  process.exit(failed > 0 ? 1 : 0);
})();
