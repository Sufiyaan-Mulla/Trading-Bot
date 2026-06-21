'use strict';
// ── test-dashboard-controls.js ───────────────────────────────────────────────
// Heavy tests for dashboard Start/Stop commands, pair selector, ML confidence
// bar, and backtest mode — server-side (snapshot + WS handler) and client DOM.
// ─────────────────────────────────────────────────────────────────────────────
const { JSDOM }    = require('jsdom');
const WebSocket    = require('ws');
const fs           = require('fs');

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
  console.log('  Dashboard Controls — Heavy Test Suite');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const { Dashboard } = require('./dashboard');

  // Minimal mock engine matching the shape _snapshot() reads
  function makeEngine(overrides = {}) {
    return {
      capital: 10000, initialCapital: 10000, dailyStartCapital: 10000,
      trades: [], position: null, priceHistory: [1.1, 1.2],
      selectedAsset: 'EUR_USD', marketData: null,
      lastMlConfidence: null, lastSignalConfidence: null,
      lastSignal: null, lastMlSignal: null,
      backtestMode: false, maxDrawdown: 0, halted: false,
      avgSpread: 0, dynamicSlippage: null, dynamicTpMultiplier: null,
      driftMonitor: null, abTester: null, capitalAllocator: null,
      liquidityScorer: null, mlConfidence: null,
      lastRejectedOrder: null, lastMarketRegime: null,
      lastGoldenCross: null, volatilityLevel: null,
      on: () => {}, emit: () => {},
      ...overrides,
    };
  }

  // ── Section 1: _snapshot() new fields ─────────────────────────────────────
  console.log('── Section 1: _snapshot() new fields ──────────────────────────');

  // mlConfidenceScore priority chain: lastMlConfidence → lastSignalConfidence → position.confidence → null
  {
    const s = new Dashboard(makeEngine({ lastMlConfidence: 82.5 }))._snapshot();
    assert(s.mlConfidenceScore === 82.5, 'mlConfidenceScore: reads lastMlConfidence (priority 1)');
  }
  {
    const s = new Dashboard(makeEngine({ lastMlConfidence: null, lastSignalConfidence: 67.3 }))._snapshot();
    assert(s.mlConfidenceScore === 67.3, 'mlConfidenceScore: falls back to lastSignalConfidence (priority 2)');
  }
  {
    const s = new Dashboard(makeEngine({
      lastMlConfidence: null, lastSignalConfidence: null,
      position: { confidence: 55, entry: 1.1, shares: 100, stopLoss: 1.09, takeProfit: 1.12 },
    }))._snapshot();
    assert(s.mlConfidenceScore === 55, 'mlConfidenceScore: falls back to position.confidence (priority 3)');
  }
  {
    const s = new Dashboard(makeEngine())._snapshot();
    assert(s.mlConfidenceScore === null, 'mlConfidenceScore: null when nothing available');
  }
  // Edge: 0 is a valid score (not null), nullish coalescing must not skip it
  {
    const s = new Dashboard(makeEngine({ lastMlConfidence: 0, lastSignalConfidence: 70 }))._snapshot();
    assert(s.mlConfidenceScore === 0, 'mlConfidenceScore: 0 not null-coalesced away (falsy ≠ null)');
  }
  {
    const s = new Dashboard(makeEngine({ lastMlConfidence: 100 }))._snapshot();
    assert(s.mlConfidenceScore === 100, 'mlConfidenceScore: upper bound 100 preserved');
  }
  {
    const s = new Dashboard(makeEngine({ lastMlConfidence: undefined }))._snapshot();
    assert(s.mlConfidenceScore === null, 'mlConfidenceScore: undefined falls through to null');
  }

  // mlSignal
  {
    const s = new Dashboard(makeEngine({ lastSignal: 'BUY' }))._snapshot();
    assert(s.mlSignal === 'BUY', 'mlSignal: reads lastSignal');
  }
  {
    const s = new Dashboard(makeEngine({ lastSignal: null, lastMlSignal: 'SELL' }))._snapshot();
    assert(s.mlSignal === 'SELL', 'mlSignal: falls back to lastMlSignal');
  }
  {
    const s = new Dashboard(makeEngine())._snapshot();
    assert(s.mlSignal === null, 'mlSignal: null when nothing available');
  }

  // backtestMode
  {
    const s = new Dashboard(makeEngine({ backtestMode: true }))._snapshot();
    assert(s.backtestMode === true, 'backtestMode: true when engine.backtestMode is true');
  }
  {
    const s = new Dashboard(makeEngine({ backtestMode: false }))._snapshot();
    assert(s.backtestMode === false, 'backtestMode: false when engine not in backtest');
  }

  // Demo snapshot (no engine) must not throw
  {
    let threw = false;
    let s;
    try { s = new Dashboard(null)._snapshot(); } catch(e) { threw = true; }
    assert(!threw, 'Demo snapshot (no engine) does not throw');
    assert(s && s._demo === true, 'Demo snapshot has _demo: true');
  }

  // All required snapshot fields still present
  {
    const s = new Dashboard(makeEngine())._snapshot();
    const required = [
      'ts', 'asset', 'capital', 'initialCapital', 'metrics', 'recentTrades',
      'position', 'mlStats', 'mlOOS', 'liquidity', 'calibration', 'drift',
      'abTest', 'allocation', 'spread', 'mlConfidenceScore', 'mlSignal', 'backtestMode',
    ];
    for (const f of required) assert(f in s, `Snapshot has required field: ${f}`);
  }

  // ── Section 2: WebSocket command handling (live server) ───────────────────
  console.log('\n── Section 2: WebSocket command handling (live server) ─────────');

  let portSeed = 19870;
  const nextPort = () => portSeed++;

  function connectWS(port) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}`);
      const t = setTimeout(() => reject(new Error('WS connect timeout')), 3000);
      ws.on('open', () => { clearTimeout(t); resolve(ws); });
      ws.on('error', reject);
    });
  }

  function firstMsg(ws) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WS message timeout')), 2000);
      ws.once('message', data => {
        clearTimeout(t);
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    });
  }

  // Helper: start dashboard, connect, send one command, verify state, tear down
  async function runCmd(engine, cmd, port) {
    const d = new Dashboard(engine, port);
    d.start();
    await sleep(100);
    let ws;
    try {
      ws = await connectWS(port);
      await firstMsg(ws);                     // consume initial snapshot
      ws.send(JSON.stringify(cmd));
      await sleep(150);
    } finally {
      ws?.close();
      await sleep(30);
      d.stop();
      await sleep(100);
    }
  }

  // cmd: start — fallback: sets engine.halted = false
  {
    const port = nextPort();
    const engine = makeEngine({ halted: true });
    await runCmd(engine, { cmd: 'start' }, port);
    assert(engine.halted === false, 'cmd:start sets engine.halted = false (fallback)');
  }

  // cmd: start — calls engine.start() when available
  {
    const port = nextPort();
    let called = false;
    const engine = makeEngine({ start: () => { called = true; } });
    await runCmd(engine, { cmd: 'start' }, port);
    assert(called, 'cmd:start calls engine.start() when method exists');
  }

  // cmd: stop — fallback: sets engine.halted = true
  {
    const port = nextPort();
    const engine = makeEngine({ halted: false });
    await runCmd(engine, { cmd: 'stop' }, port);
    assert(engine.halted === true, 'cmd:stop sets engine.halted = true (fallback)');
  }

  // cmd: stop — calls engine.stop() when available
  {
    const port = nextPort();
    let called = false;
    const engine = makeEngine({ stop: () => { called = true; } });
    await runCmd(engine, { cmd: 'stop' }, port);
    assert(called, 'cmd:stop calls engine.stop() when method exists');
  }

  // cmd: setPair — calls engine.selectAsset()
  {
    const port = nextPort();
    let selected = null;
    const engine = makeEngine({ selectAsset: p => { selected = p; } });
    await runCmd(engine, { cmd: 'setPair', pair: 'GBP_USD' }, port);
    assert(selected === 'GBP_USD', 'cmd:setPair calls engine.selectAsset("GBP_USD")');
  }

  // cmd: setPair — fallback: sets engine.selectedAsset directly
  {
    const port = nextPort();
    const engine = makeEngine({ selectedAsset: 'EUR_USD' });
    await runCmd(engine, { cmd: 'setPair', pair: 'USD_JPY' }, port);
    assert(engine.selectedAsset === 'USD_JPY', 'cmd:setPair sets engine.selectedAsset directly (fallback)');
  }

  // cmd: setPair — all supported pairs round-trip
  {
    const pairs = ['EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD', 'USD_CAD', 'NZD_USD', 'AAPL', 'TSLA', 'SPY'];
    for (const pair of pairs) {
      const port = nextPort();
      const engine = makeEngine({ selectedAsset: 'EUR_USD' });
      await runCmd(engine, { cmd: 'setPair', pair }, port);
      assert(engine.selectedAsset === pair, `cmd:setPair accepts pair ${pair}`);
    }
  }

  // cmd: setPair — empty string is ignored
  {
    const port = nextPort();
    const engine = makeEngine({ selectedAsset: 'EUR_USD' });
    await runCmd(engine, { cmd: 'setPair', pair: '' }, port);
    assert(engine.selectedAsset === 'EUR_USD', 'cmd:setPair with empty string is ignored');
  }

  // cmd: setPair — missing pair key is ignored
  {
    const port = nextPort();
    const engine = makeEngine({ selectedAsset: 'EUR_USD' });
    await runCmd(engine, { cmd: 'setPair' }, port);  // no pair key
    assert(engine.selectedAsset === 'EUR_USD', 'cmd:setPair without pair key is ignored');
  }

  // cmd: backtest — calls engine.runBacktest()
  {
    const port = nextPort();
    let called = false;
    const engine = makeEngine({ runBacktest: () => { called = true; } });
    await runCmd(engine, { cmd: 'backtest' }, port);
    assert(called, 'cmd:backtest calls engine.runBacktest()');
  }

  // cmd: backtest — no crash when runBacktest() absent
  {
    const port = nextPort();
    const engine = makeEngine();
    let threw = false;
    try { await runCmd(engine, { cmd: 'backtest' }, port); } catch { threw = true; }
    assert(!threw, 'cmd:backtest does not crash when runBacktest() absent');
  }

  // Unknown command — silently ignored with no state changes
  {
    const port = nextPort();
    const engine = makeEngine({ halted: false, selectedAsset: 'EUR_USD' });
    await runCmd(engine, { cmd: 'nuke' }, port);
    assert(engine.halted === false && engine.selectedAsset === 'EUR_USD',
      'Unknown command is ignored with no side effects');
  }

  // Invalid JSON — server survives and accepts next valid command
  {
    const port = nextPort();
    const engine = makeEngine({ halted: false });
    const d = new Dashboard(engine, port);
    d.start();
    await sleep(100);
    let ws, survived = false;
    try {
      ws = await connectWS(port);
      await firstMsg(ws);
      ws.send('{bad json!!!');
      await sleep(80);
      ws.send(JSON.stringify({ cmd: 'stop' }));  // valid command follows
      await sleep(150);
      survived = engine.halted === true;  // stop was processed
    } catch { survived = false; }
    finally { ws?.close(); await sleep(30); d.stop(); await sleep(100); }
    assert(survived, 'Server survives invalid JSON and processes next valid command');
  }

  // Post-command push broadcasts refreshed snapshot immediately
  {
    const port = nextPort();
    const engine = makeEngine({ lastSignal: 'HOLD', lastMlConfidence: 50 });
    const d = new Dashboard(engine, port);
    d.start();
    await sleep(100);
    let ws, pushed = null;
    try {
      ws = await connectWS(port);
      await firstMsg(ws);                 // consume initial snapshot
      engine.lastSignal = 'BUY';
      engine.lastMlConfidence = 88;
      ws.send(JSON.stringify({ cmd: 'stop' }));
      pushed = await firstMsg(ws);        // pushed by this.push() inside message handler
    } finally { ws?.close(); await sleep(30); d.stop(); await sleep(100); }
    assert(pushed?.mlSignal === 'BUY', 'Post-command push reflects updated mlSignal');
    assert(pushed?.mlConfidenceScore === 88, 'Post-command push reflects updated mlConfidenceScore');
    assert(pushed?.backtestMode === false, 'Post-command push includes backtestMode');
  }

  // No engine attached — all commands handled gracefully
  {
    const port = nextPort();
    const d = new Dashboard(null, port);
    d.start();
    await sleep(100);
    let ws, threw = false;
    try {
      ws = await connectWS(port);
      await firstMsg(ws);
      for (const cmd of [
        { cmd: 'start' }, { cmd: 'stop' },
        { cmd: 'setPair', pair: 'EUR_USD' }, { cmd: 'backtest' },
      ]) {
        ws.send(JSON.stringify(cmd));
        await sleep(30);
      }
    } catch(e) { threw = true; }
    finally { ws?.close(); await sleep(30); d.stop(); await sleep(100); }
    assert(!threw, 'All commands gracefully handled when no engine attached');
  }

  // Multiple clients: start command propagates halt state to all
  {
    const port = nextPort();
    const engine = makeEngine({ halted: true });
    const d = new Dashboard(engine, port);
    d.start();
    await sleep(100);
    let ws1, ws2;
    try {
      ws1 = await connectWS(port);
      ws2 = await connectWS(port);
      await firstMsg(ws1);
      await firstMsg(ws2);
      // ws1 sends start; both should get the pushed snapshot
      const [snap1, snap2] = await Promise.all([firstMsg(ws1), firstMsg(ws2).catch(() => null), (async () => {
        ws1.send(JSON.stringify({ cmd: 'start' }));
      })()]).then(r => [r[0], r[1]]);
      assert(engine.halted === false, 'Multi-client: cmd:start updates engine.halted');
    } finally {
      ws1?.close(); ws2?.close();
      await sleep(30); d.stop(); await sleep(100);
    }
  }

  // ── Section 3: HTML structure validation ──────────────────────────────────
  console.log('\n── Section 3: HTML structure validation ───────────────────────');

  const src = fs.readFileSync('./dashboard.js', 'utf8');
  const htmlMatch = src.match(/const HTML = `([\s\S]*?)`;/);
  assert(htmlMatch !== null, 'HTML template string extracted from dashboard.js');
  const html = htmlMatch ? htmlMatch[1] : '';

  // Control strip element IDs
  for (const id of ['btn-start', 'btn-stop', 'pair-select', 'btn-backtest', 'ctrl-status']) {
    assert(html.includes(`id="${id}"`), `HTML: id="${id}" present`);
  }

  // Confidence card element IDs
  for (const id of ['conf-score', 'conf-bar', 'conf-label', 'conf-signal', 'conf-mode']) {
    assert(html.includes(`id="${id}"`), `HTML: id="${id}" present`);
  }

  // Pair selector options
  for (const pair of ['EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD', 'USD_CAD', 'NZD_USD', 'AAPL', 'TSLA', 'SPY']) {
    assert(html.includes(pair), `HTML: pair option ${pair} present in select`);
  }

  // CSS classes
  for (const cls of ['ctrl-strip', 'ctrl-btn-start', 'ctrl-btn-stop', 'ctrl-btn-bt',
                      'ctrl-select', 'conf-gauge', 'conf-fill']) {
    assert(html.includes(cls), `HTML: CSS class "${cls}" defined`);
  }

  // sendCmd() and all four command types
  assert(html.includes('function sendCmd'), 'HTML: sendCmd() defined in client JS');
  for (const cmd of ["cmd: 'start'", "cmd: 'stop'", "cmd: 'setPair'", "cmd: 'backtest'"]) {
    assert(html.includes(cmd), `HTML: ${cmd} used in sendCmd call`);
  }

  // update() references all new data fields
  for (const ref of ['mlConfidenceScore', 'mlSignal', 'backtestMode', 'pair-select', 'conf-bar', 'conf-score']) {
    assert(html.includes(ref), `HTML: update() references "${ref}"`);
  }

  // ctrl-strip appears before the main grid (not nested inside a card)
  const ctrlPos  = html.indexOf('class="ctrl-strip"');
  const gridPos  = html.indexOf('class="grid"');
  assert(ctrlPos !== -1 && ctrlPos < gridPos, 'ctrl-strip is before the grid (outside cards)');

  // Buttons have correct CSS classes
  assert(html.includes('ctrl-btn-start'), 'btn-start has ctrl-btn-start class');
  assert(html.includes('ctrl-btn-stop'),  'btn-stop has ctrl-btn-stop class');
  assert(html.includes('ctrl-btn-bt'),    'btn-backtest has ctrl-btn-bt class');

  // ── Section 4: DOM rendering via jsdom ───────────────────────────────────
  console.log('\n── Section 4: DOM rendering via jsdom ─────────────────────────');

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost:19877',
    beforeParse(w) {
      // Mock canvas (jsdom has no canvas support)
      const fakeCtx = {
        clearRect: () => {}, beginPath: () => {}, moveTo: () => {},
        lineTo: () => {}, stroke: () => {}, fill: () => {}, closePath: () => {},
        strokeStyle: '', lineWidth: 0, fillStyle: '',
      };
      w.HTMLCanvasElement.prototype.getContext = () => fakeCtx;
      // Mock WebSocket (no server running in jsdom context)
      w.WebSocket = class {
        constructor() {
          this.readyState = 3;  // CLOSED
          setTimeout(() => { if (this.onerror) this.onerror({}); }, 5);
        }
        close() { if (this.onclose) this.onclose({}); }
        send() {}
      };
    },
  });

  const { window: win } = dom;
  await sleep(80);  // allow DOMContentLoaded + setTimeout handlers to fire

  function domGet(id) { return win.document.getElementById(id); }

  // All control/confidence elements exist
  for (const id of ['btn-start', 'btn-stop', 'pair-select', 'btn-backtest', 'ctrl-status',
                     'conf-score', 'conf-bar', 'conf-label', 'conf-signal', 'conf-mode']) {
    assert(domGet(id) !== null, `DOM: #${id} exists`);
  }

  // pair-select has all expected options
  const pairSel = domGet('pair-select');
  const optVals = pairSel ? Array.from(pairSel.options).map(o => o.value) : [];
  for (const p of ['EUR_USD', 'GBP_USD', 'USD_JPY', 'AUD_USD', 'NZD_USD', 'AAPL', 'TSLA', 'SPY']) {
    assert(optVals.includes(p), `DOM: pair-select has option ${p}`);
  }

  // update() is accessible in window scope
  const updateFn = win.update;
  if (typeof updateFn !== 'function') {
    assert(false, 'DOM: update() accessible as window.update');
  } else {
    assert(true, 'DOM: update() accessible as window.update');

    // Sparse base payload — update() must handle missing fields gracefully
    const base = {
      ts: Date.now(), capital: 10000, initialCapital: 10000,
      asset: 'EUR_USD', position: null, metrics: {}, recentTrades: [],
      mlStats: {}, mlOOS: {},
    };

    // ── High confidence (>70) → green class, green bar ──
    updateFn({ ...base, mlConfidenceScore: 82.4, mlSignal: 'BUY', backtestMode: false });
    assert(domGet('conf-score').textContent === '82.4%', 'DOM: conf-score shows 82.4%');
    assert(domGet('conf-score').className.includes('g'), 'DOM: high confidence → green class on score');
    assert(domGet('conf-bar').style.width === '82.4%', 'DOM: conf-bar width = 82.4%');
    assert(domGet('conf-label').textContent === 'confidence', 'DOM: conf-label = "confidence"');
    assert(domGet('conf-signal').textContent === 'BUY', 'DOM: conf-signal = BUY');
    assert(domGet('conf-signal').className.includes('g'), 'DOM: BUY signal → green class');
    assert(domGet('conf-mode').innerHTML.includes('LIVE'), 'DOM: live mode → LIVE badge');

    // ── Medium confidence (55-70) → yellow class, yellow bar ──
    updateFn({ ...base, mlConfidenceScore: 60.0, mlSignal: 'SELL', backtestMode: false });
    assert(domGet('conf-score').textContent === '60.0%', 'DOM: conf-score shows 60.0%');
    assert(domGet('conf-score').className.includes('y'), 'DOM: medium confidence → yellow class');
    assert(domGet('conf-bar').style.width === '60%', 'DOM: conf-bar width = 60%');
    assert(domGet('conf-signal').textContent === 'SELL', 'DOM: conf-signal = SELL');
    assert(domGet('conf-signal').className.includes('r'), 'DOM: SELL signal → red class');

    // ── Low confidence (<55) → red class, red bar ──
    updateFn({ ...base, mlConfidenceScore: 42.1, mlSignal: null, backtestMode: true });
    assert(domGet('conf-score').textContent === '42.1%', 'DOM: conf-score shows 42.1%');
    assert(domGet('conf-score').className.includes('r'), 'DOM: low confidence → red class');
    const barBg = domGet('conf-bar').style.background;
    assert(barBg.includes('red') || barBg.includes('3d57') || barBg.includes('ff3'),
      'DOM: low confidence → red background on bar');
    assert(domGet('conf-signal').textContent === '—', 'DOM: null mlSignal → em-dash');
    assert(!domGet('conf-signal').className.includes('g') && !domGet('conf-signal').className.includes('r'),
      'DOM: null mlSignal → no colour class');
    assert(domGet('conf-mode').innerHTML.includes('BACKTEST'), 'DOM: backtestMode true → BACKTEST badge');

    // ── Exact boundary: score = 70 (inclusive of yellow, not green) ──
    updateFn({ ...base, mlConfidenceScore: 70, mlSignal: null, backtestMode: false });
    // 70 is NOT > 70, so yellow class
    assert(!domGet('conf-score').className.includes('g') || domGet('conf-score').className.includes('y'),
      'DOM: score = 70 is yellow/not-green (boundary)');

    // ── Exact boundary: score = 55 → red (threshold is strictly > 55) ──
    updateFn({ ...base, mlConfidenceScore: 55, mlSignal: null, backtestMode: false });
    assert(domGet('conf-score').className.includes('r'),
      'DOM: score = 55 is red (threshold is > 55, not >=)');

    // ── score = 56 → yellow (just above 55) ──
    updateFn({ ...base, mlConfidenceScore: 56, mlSignal: null, backtestMode: false });
    assert(domGet('conf-score').className.includes('y'),
      'DOM: score = 56 is yellow (just above red threshold)');

    // ── null confidence → reset bar ──
    updateFn({ ...base, mlConfidenceScore: null, mlSignal: null, backtestMode: false });
    assert(domGet('conf-score').textContent === '—', 'DOM: null confidence → em-dash on score');
    assert(domGet('conf-bar').style.width === '0%', 'DOM: null confidence resets bar to 0%');
    assert(domGet('conf-label').textContent === 'no prediction', 'DOM: null confidence → "no prediction"');

    // ── Score > 100 is capped at 100% bar width ──
    updateFn({ ...base, mlConfidenceScore: 150, mlSignal: null, backtestMode: false });
    const cappedWidth = parseFloat(domGet('conf-bar').style.width);
    assert(cappedWidth <= 100, 'DOM: conf-bar width capped at 100% for score > 100');

    // ── Score = 0 ──
    updateFn({ ...base, mlConfidenceScore: 0, mlSignal: null, backtestMode: false });
    assert(domGet('conf-score').textContent === '0.0%', 'DOM: score 0 → "0.0%"');
    assert(domGet('conf-bar').style.width === '0%', 'DOM: score 0 → bar width 0%');

    // ── Pair selector syncs to active asset ──
    for (const pair of ['GBP_USD', 'USD_JPY', 'AAPL', 'EUR_USD']) {
      updateFn({ ...base, asset: pair, mlConfidenceScore: null, mlSignal: null, backtestMode: false });
      assert(domGet('pair-select').value === pair, `DOM: pair-select syncs to asset ${pair}`);
    }

    // ── Backtest badge toggles correctly ──
    updateFn({ ...base, mlConfidenceScore: null, mlSignal: null, backtestMode: true });
    assert(domGet('conf-mode').innerHTML.includes('BACKTEST'), 'DOM: backtestMode true → BACKTEST badge (second check)');
    updateFn({ ...base, mlConfidenceScore: null, mlSignal: null, backtestMode: false });
    assert(domGet('conf-mode').innerHTML.includes('LIVE'), 'DOM: backtestMode false → LIVE badge (toggle)');

    // ── update() does not throw with minimal / empty payload ──
    let updateThrew = false;
    try {
      updateFn({ ts: Date.now(), capital: 0, initialCapital: 10000 });
    } catch(e) { updateThrew = true; }
    assert(!updateThrew, 'DOM: update() does not throw on minimal payload');
  }

  // ── Section 5: sendCmd + setCtrlStatus accessible in window scope ─────────
  console.log('\n── Section 5: Client JS function accessibility ─────────────────');

  assert(typeof win.sendCmd      === 'function', 'DOM: sendCmd() accessible in window scope');
  assert(typeof win.setCtrlStatus === 'function', 'DOM: setCtrlStatus() accessible in window scope');

  // setCtrlStatus updates ctrl-status element text and color
  win.setCtrlStatus('Test message', 'var(--green)');
  assert(domGet('ctrl-status').textContent === 'Test message', 'DOM: setCtrlStatus sets text');
  assert(domGet('ctrl-status').style.color === 'var(--green)', 'DOM: setCtrlStatus sets color');

  // sendCmd when ws is in CLOSED state (readyState 3) calls setCtrlStatus
  win.sendCmd({ cmd: 'start' });  // ws is mocked CLOSED — should call setCtrlStatus('Not connected')
  assert(domGet('ctrl-status').textContent === 'Not connected',
    'DOM: sendCmd with closed WS shows "Not connected"');

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
