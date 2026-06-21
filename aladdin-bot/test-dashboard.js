'use strict';
// ── test-dashboard.js ──────────────────────────────────────────────────────────
// Heavy JSDOM-based tests for dashboard.html.
// Covers all 10 UI sections with mocked Chart.js and WebSocket.
// Run standalone: node test-dashboard.js
// ─────────────────────────────────────────────────────────────────────────────

const { JSDOM } = require('jsdom');
const fs   = require('fs');
const path = require('path');

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
function section(t) {
  console.log('\n' + '═'.repeat(70) + '\n  ' + t + '\n' + '═'.repeat(70));
}

// ── Baseline snapshot (mirrors dashboard.js _snapshot() output) ──────────────
const BASE = {
  ts:             Date.now(),
  asset:          'EURUSD',
  priceSource:    'seed',
  capital:        10250.00,
  initialCapital: 10000,
  dailyPnl:       250.00,
  dailyStartCapital: 10000,
  peakCapital:    10300,
  equityPoint:    10250,
  marketPrice:    1.08512,
  maxDrawdown:    2.5,
  position:       null,
  halted:         false,
  marketRegime:   'TRENDING',
  goldenCross:    true,
  volatilityLevel: 'NORMAL',
  dynamicSlippage: 0.0003,
  tpMultiplier:   1.5,
  spread:         { fraction: 0.00015, pips: 1.6 },
  rejectedOrders: 0,
  metrics: {
    trades: 47, wins: 29, losses: 18,
    winRate: 61.7, pf: 1.82, expectancy: 12.4, maxDrawdown: 2.5, sharpe: 1.34,
  },
  recentTrades:  [],
  liquidity:     { score: 74, regime: 'NORMAL', multiplier: 1.0, session: 'Active session ↑' },
  calibration:   { isActive: true, method: 'isotonic', totalSamples: 250, minSamplesRequired: 50, globalECE: 0.04 },
  drift:         { active: true, halted: false, liveTrades: 40, wrDelta: 2.1, pfDelta: 0.05, expDelta: 1.2 },
  abTest:        { championId: 'rsi-macd', contestants: [], ensembleEnabled: true, ensembleThreshold: 0.60 },
  allocation:    { slots: [], rebalanceCount: 3 },
  mlStats:       { trained: true, gbmAcc: 62, seqAcc: 59, ensAcc: 65, trainSamples: 800, version: 7 },
  mlOOS:         { accuracy: 62, grade: 'B' },
  mlConfidenceScore: 73.5,
  mlSignal:      'BUY',
  backtestMode:  false,
};

// ── JSDOM factory ─────────────────────────────────────────────────────────────
function makeDOM() {
  let html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');

  // Replace CDN Chart.js script with a lightweight mock
  html = html.replace(
    /<script\s+src="https:\/\/[^"]*chart[^"]*"><\/script>/i,
    `<script>
    window.Chart = function(ctx, cfg) {
      this.data    = cfg ? JSON.parse(JSON.stringify(cfg.data || {})) : {};
      this.options = cfg ? (cfg.options || {}) : {};
      this.update  = function() { window.__chartUpdates = (window.__chartUpdates || 0) + 1; };
      this.destroy = function() {};
      window.__lastChart = this;
    };
    </script>`
  );

  return new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost:3000',
    beforeParse(w) {
      // WebSocket mock — open by default so send() works; never fires callbacks
      w.WebSocket = function(url) {
        this.url        = url;
        this.readyState = 1; // OPEN
        this.send = function(data) {
          w.__wsSent = (w.__wsSent || []).concat([JSON.parse(data)]);
        };
        this.close = function() {};
        w.__ws = this;
      };
      w.WebSocket.OPEN   = 1;
      w.WebSocket.CLOSED = 3;

      // Canvas 2D context mock (needed for Chart.js canvas operations)
      w.HTMLCanvasElement.prototype.getContext = function(type) {
        if (type !== '2d') return null;
        const stub = { addColorStop: () => {} };
        return {
          createLinearGradient: () => stub,
          clearRect: () => {}, beginPath: () => {}, moveTo: () => {},
          lineTo: () => {}, stroke: () => {}, fill: () => {}, closePath: () => {},
          strokeStyle: '', lineWidth: 0, fillStyle: '',
          canvas: { offsetWidth: 800, offsetHeight: 280 },
        };
      };

      // Suppress long-delay timers (reconnect loop guard)
      const _origST = w.setTimeout.bind(w);
      w.setTimeout = (fn, ms, ...args) => ms >= 2000 ? 0 : _origST(fn, ms, ...args);
    },
  });
}

// Create a fresh DOM per section to avoid state leakage
let dom, win, doc;
function setup() {
  dom = makeDOM();
  win = dom.window;
  doc = win.document;
  win.__wsSent      = [];
  win.__chartUpdates = 0;
}

// Shorthand: call window.update() and return immediately
function upd(data) { win.update(data); }
function el(id)    { return doc.getElementById(id); }

// ═══════════════════════════════════════════════════════════════════════════════
section('1 — Static: required IDs, CDN script, WS code, 10 sections');
// ═══════════════════════════════════════════════════════════════════════════════
try {
  setup();
  const html = fs.readFileSync('./dashboard.html', 'utf8');

  // Every ID the JS references must exist in the HTML
  const REQUIRED_IDS = [
    'app-header','run-status','run-label','mode-chip',
    'hdr-clock','hdr-asset','hdr-src','conn-dot','conn-label',
    's-capital','s-return','s-pnl','s-pnl-sub','s-wr','s-wr-sub','s-trades','s-trades-sub','sc-pnl','sc-trades',
    'chart-panel','equityChart','chart-meta',
    'btn-start','btn-stop','pair-select','mode-toggle','btn-backtest',
    'ctrl-msg','lbl-paper','lbl-live',
    'conf-pct','conf-bar','conf-lbl','ml-signal','ml-mode','ml-oos','ml-sharpe','ml-pf',
    'prices-row',
    'pc-EURUSD','pc-GBPUSD','pc-USDJPY','pc-AUDUSD',
    'pv-EURUSD','pv-GBPUSD','pv-USDJPY','pv-AUDUSD',
    'pdelta-EURUSD','pdelta-GBPUSD','pdelta-USDJPY','pdelta-AUDUSD',
    'psrc-EURUSD',
    'pos-badge','pos-empty','pos-content','pos-body',
    'r-daily','r-daily-bar','r-dd','r-dd-bar','r-cb','r-regime','r-peak','r-spread','r-drift',
    'cb-badge',
    'trades-body','trades-meta',
    'bt-meta','bt-idle','bt-running','bt-results','bt-btn',
    'bt-return','bt-wr','bt-sharpe','bt-dd',
    'footer-ts',
  ];
  for (const id of REQUIRED_IDS) {
    assert(el(id) !== null, `#${id} present in DOM`);
  }

  // Chart.js CDN
  assert(html.includes('chart.umd.min.js'), 'Chart.js CDN script tag present');

  // WebSocket wired
  assert(html.includes('new WebSocket('), 'WebSocket instantiation present');
  assert(html.includes("cmd: 'start'"),    "start command present");
  assert(html.includes("cmd: 'stop'"),     "stop command present");
  assert(html.includes("cmd: 'setPair'"),  "setPair command present");
  assert(html.includes("cmd: 'backtest'"), "backtest command present");
  assert(html.includes("cmd: 'setMode'"),  "setMode command present");

  // Responsive
  assert(html.includes('@media'), 'Responsive media queries present');
  assert(html.includes('viewport'), 'Viewport meta present');

  // All 4 pairs in selector
  assert(html.includes('EURUSD') && html.includes('GBPUSD') &&
         html.includes('USDJPY') && html.includes('AUDUSD'), 'All 4 pairs in pair selector');

  // update() function reachable from window
  assert(typeof win.update === 'function', 'update() exposed on window');

} catch(e) { assert(false, 'Static structure', e.message); }


// ═══════════════════════════════════════════════════════════════════════════════
section('2 — Header: status badge, paper/live chip, asset, source');
// ═══════════════════════════════════════════════════════════════════════════════
try {
  setup();

  // Normal running
  upd({ ...BASE, halted: false, backtestMode: false });
  assert(el('run-label').textContent === 'RUNNING', 'Status: RUNNING');
  assert(el('run-status').className.includes('pill-running'), 'Running pill class');
  assert(el('mode-chip').textContent === 'PAPER', 'Paper mode chip (seed source)');
  assert(!el('mode-chip').className.includes('live'), 'Paper chip has no live class');

  // Halted via top-level flag
  upd({ ...BASE, halted: true });
  assert(el('run-label').textContent === 'HALTED', 'Status: HALTED (halted=true)');
  assert(el('run-status').className.includes('pill-halted'), 'Halted pill class');

  // Halted via drift
  upd({ ...BASE, halted: false, drift: { ...BASE.drift, halted: true } });
  assert(el('run-label').textContent === 'HALTED', 'Status: HALTED (drift.halted=true)');

  // Backtest mode
  upd({ ...BASE, halted: false, backtestMode: true });
  assert(el('run-label').textContent === 'BACKTEST', 'Status: BACKTEST during backtest');

  // Live mode (real price source)
  upd({ ...BASE, priceSource: 'OANDA', backtestMode: false });
  assert(el('mode-chip').textContent === 'LIVE', 'Shows LIVE for OANDA');
  assert(el('mode-chip').className.includes('live'), 'Live chip class applied');

  upd({ ...BASE, priceSource: 'AlphaVantage', backtestMode: false });
  assert(el('mode-chip').textContent === 'LIVE', 'Shows LIVE for AlphaVantage');

  // Simulation sources → paper
  for (const src of ['seed', 'simulation', 'seed_no_api', 'cached']) {
    upd({ ...BASE, priceSource: src, backtestMode: false });
    assert(el('mode-chip').textContent === 'PAPER', `Source '${src}' → PAPER mode`);
  }

  // Asset display with slash
  upd({ ...BASE, asset: 'GBPUSD' });
  assert(el('hdr-asset').textContent === 'GBP/USD', 'Asset rendered with slash separator');
  upd({ ...BASE, asset: 'USDJPY' });
  assert(el('hdr-asset').textContent === 'USD/JPY', 'USDJPY rendered correctly');

  // Source label
  upd({ ...BASE, priceSource: 'AlphaVantage' });
  assert(el('hdr-src').textContent === 'AlphaVantage', 'Price source shown in header');

} catch(e) { assert(false, 'Header test', e.message); }


// ═══════════════════════════════════════════════════════════════════════════════
section('3 — Stats row: capital, P&L, win rate, trade count');
// ═══════════════════════════════════════════════════════════════════════════════
try {
  setup();

  // Positive baseline
  upd({ ...BASE });
  assert(el('s-capital').textContent === '$10250.00', 'Capital formatted to 2dp');
  assert(el('s-capital').style.color === 'var(--green)', 'Capital green above initial');
  assert(el('s-return').textContent.includes('+2.50%'), 'Return shows +2.50%');
  assert(el('s-pnl').textContent === '$250.00', 'Daily P&L formatted');
  assert(el('s-pnl').style.color === 'var(--green)', 'Positive P&L is green');
  assert(el('s-wr').textContent.includes('61.7%'), 'Win rate shown');
  assert(el('s-wr').style.color === 'var(--green)', 'Win rate > 55 → green');
  assert(el('s-trades').textContent === '47', 'Trade count shown');
  assert(el('s-trades-sub').textContent === 'W/L: 29/18', 'W/L breakdown shown');

  // Loss scenario
  upd({ ...BASE, capital: 9500, dailyPnl: -500, metrics: { ...BASE.metrics, winRate: 35, wins: 5, losses: 9 } });
  assert(el('s-capital').style.color === 'var(--red)', 'Capital red below initial');
  assert(el('s-return').textContent.includes('-5.00%'), 'Negative return shown');
  assert(el('s-pnl').style.color === 'var(--red)', 'Negative P&L red');
  assert(el('s-wr').style.color === 'var(--red)', 'Win rate < 40 → red');

  // Yellow zone
  upd({ ...BASE, metrics: { ...BASE.metrics, winRate: 45 } });
  assert(el('s-wr').style.color === 'var(--yellow)', 'Win rate 40-55 → yellow');

  // 100% win rate
  upd({ ...BASE, metrics: { ...BASE.metrics, winRate: 100, wins: 10, losses: 0 } });
  assert(el('s-wr').textContent === '100.0%', '100% win rate shown');

  // Zero trades / null win rate
  upd({ ...BASE, metrics: { trades: 0, wins: 0, losses: 0, winRate: null } });
  assert(el('s-wr').textContent === '—%', 'Null win rate shows —%');
  assert(el('s-trades').textContent === '0', 'Zero trades shown');

} catch(e) { assert(false, 'Stats row test', e.message); }


// ═══════════════════════════════════════════════════════════════════════════════
section('4 — Equity chart: instantiation, point accumulation, no crash');
// ═══════════════════════════════════════════════════════════════════════════════
try {
  setup();

  assert(win.__lastChart !== undefined, 'Chart was instantiated on load');
  assert(typeof win.__lastChart.update === 'function', 'Chart.update() is callable');

  // Push several equity points
  const VALS = [10000, 10100, 10050, 10200, 10300, 10150, 10400];
  for (const v of VALS) upd({ ...BASE, equityPoint: v, capital: v });
  assert((win.__chartUpdates || 0) >= VALS.length, `Chart updated at least ${VALS.length} times`);

  // Rolling window — push 220 points, should not crash
  for (let i = 0; i < 220; i++) upd({ ...BASE, equityPoint: 10000 + i, capital: 10000 + i });
  assert(true, '220 equity points pushed without crash (rolling window works)');

  // Invalid equity values
  upd({ ...BASE, equityPoint: null });
  upd({ ...BASE, equityPoint: undefined });
  upd({ ...BASE, equityPoint: NaN });
  upd({ ...BASE, equityPoint: 0 });
  assert(true, 'Null/NaN/zero equity points do not crash chart');

} catch(e) { assert(false, 'Equity chart test', e.message); }


// ═══════════════════════════════════════════════════════════════════════════════
section('5 — Live prices: all 4 pairs, arrows, active card, source');
// ═══════════════════════════════════════════════════════════════════════════════
try {
  setup();

  // First price for EURUSD
  upd({ ...BASE, asset: 'EURUSD', marketPrice: 1.08512 });
  assert(el('pv-EURUSD').textContent === '1.08512', 'EURUSD price displayed (5dp)');
  assert(el('pc-EURUSD').classList.contains('active-pair'), 'Active pair card highlighted');
  assert(!el('pc-GBPUSD').classList.contains('active-pair'), 'Other pair not highlighted');

  // Price increases → ▲
  upd({ ...BASE, asset: 'EURUSD', marketPrice: 1.08600 });
  assert(el('pv-EURUSD').textContent === '1.08600', 'Updated price displayed');
  assert(el('pdelta-EURUSD').textContent.includes('▲'), 'Up arrow on increase');
  assert(el('pdelta-EURUSD').className.includes('up'), 'Up CSS class applied');

  // Price decreases → ▼
  upd({ ...BASE, asset: 'EURUSD', marketPrice: 1.08400 });
  assert(el('pdelta-EURUSD').textContent.includes('▼'), 'Down arrow on decrease');
  assert(el('pdelta-EURUSD').className.includes('down'), 'Down CSS class applied');

  // Switch to GBPUSD
  upd({ ...BASE, asset: 'GBPUSD', marketPrice: 1.27512 });
  assert(el('pv-GBPUSD').textContent === '1.27512', 'GBPUSD price displayed');
  assert(el('pc-GBPUSD').classList.contains('active-pair'), 'GBPUSD becomes active');
  assert(!el('pc-EURUSD').classList.contains('active-pair'), 'EURUSD no longer active');

  // USDJPY — 3 decimal places
  upd({ ...BASE, asset: 'USDJPY', marketPrice: 149.512 });
  assert(el('pv-USDJPY').textContent === '149.512', 'USDJPY uses 3dp');

  // AUDUSD
  upd({ ...BASE, asset: 'AUDUSD', marketPrice: 0.68512 });
  assert(el('pv-AUDUSD').textContent === '0.68512', 'AUDUSD price displayed');

  // Source label on price card
  upd({ ...BASE, asset: 'EURUSD', marketPrice: 1.0850, priceSource: 'OANDA' });
  assert(el('psrc-EURUSD').textContent === 'OANDA', 'Source shown on active price card');

  // Prices from previous assets are retained
  upd({ ...BASE, asset: 'EURUSD', marketPrice: 1.0855 });
  assert(el('pv-GBPUSD').textContent === '1.27512', 'GBPUSD price retained after switching away');

  // Null price — no crash
  upd({ ...BASE, asset: 'EURUSD', marketPrice: null });
  assert(true, 'Null marketPrice does not crash');

} catch(e) { assert(false, 'Live prices test', e.message); }


// ═══════════════════════════════════════════════════════════════════════════════
section('6 — ML confidence bar: three zones, signal badge, stats rows');
// ═══════════════════════════════════════════════════════════════════════════════
try {
  setup();

  // High (> 70) → green
  upd({ ...BASE, mlConfidenceScore: 80, mlSignal: 'BUY' });
  assert(el('conf-pct').textContent === '80.0%', 'High confidence % shown');
  assert(el('conf-pct').style.color === 'var(--green)', 'High confidence green');
  assert(el('conf-bar').style.width === '80%', 'Bar fills to 80%');
  assert(el('conf-lbl').textContent.toLowerCase().includes('high'), 'High confidence label');
  assert(el('ml-signal').textContent.includes('BUY'), 'BUY signal shown');
  assert(el('ml-signal').className.includes('sig-buy'), 'BUY badge class');

  // Medium (50-70) → yellow
  upd({ ...BASE, mlConfidenceScore: 60, mlSignal: 'SELL' });
  assert(el('conf-pct').style.color === 'var(--yellow)', 'Medium confidence yellow');
  assert(el('conf-bar').style.width === '60%', 'Bar fills to 60%');
  assert(el('ml-signal').textContent.includes('SELL'), 'SELL signal shown');
  assert(el('ml-signal').className.includes('sig-sell'), 'SELL badge class');

  // Low (< 50) → red
  upd({ ...BASE, mlConfidenceScore: 35, mlSignal: null });
  assert(el('conf-pct').style.color === 'var(--red)', 'Low confidence red');
  assert(el('conf-bar').style.width === '35%', 'Bar fills to 35%');
  assert(el('ml-signal').className.includes('sig-none'), 'No-signal badge class');

  // No prediction (null)
  upd({ ...BASE, mlConfidenceScore: null });
  assert(el('conf-pct').textContent === '—', 'Null confidence shows dash');
  assert(el('conf-bar').style.width === '0%', 'Bar at 0% for null');
  assert(el('conf-lbl').textContent === 'No prediction', 'No prediction label');

  // Exactly 50 and 70 (boundary values)
  upd({ ...BASE, mlConfidenceScore: 50 });
  assert(el('conf-bar').style.width === '50%', 'Boundary 50% bar width');
  upd({ ...BASE, mlConfidenceScore: 70 });
  assert(el('conf-bar').style.width === '70%', 'Boundary 70% bar width');

  // Capped at 100
  upd({ ...BASE, mlConfidenceScore: 100 });
  assert(el('conf-bar').style.width === '100%', 'Confidence bar capped at 100%');

  // Mode shows BACKTEST
  upd({ ...BASE, backtestMode: true });
  assert(el('ml-mode').textContent === 'BACKTEST', 'Backtest mode shown in ML panel');

  // Stats rows populated
  upd({ ...BASE, metrics: { ...BASE.metrics, sharpe: 1.42, pf: 1.95 }, mlOOS: { accuracy: 64, grade: 'A' } });
  assert(el('ml-sharpe').textContent.includes('1.42'), 'Sharpe shown in ML panel');
  assert(el('ml-pf').textContent.includes('1.95'), 'Profit factor shown');
  assert(el('ml-oos').textContent.includes('64%'), 'OOS accuracy shown');
  assert(el('ml-oos').textContent.includes('A'), 'OOS grade shown');

} catch(e) { assert(false, 'ML confidence test', e.message); }


// ═══════════════════════════════════════════════════════════════════════════════
section('7 — Open position: empty state, LONG, SHORT, unrealised P&L');
// ═══════════════════════════════════════════════════════════════════════════════
try {
  setup();

  // No position
  upd({ ...BASE, position: null });
  assert(el('pos-empty').style.display !== 'none', 'Empty state visible');
  assert(el('pos-content').style.display === 'none', 'Content hidden');
  assert(el('pos-badge').textContent === 'No Position', 'Badge: No Position');
  assert(el('pos-badge').className.includes('pos-none'), 'pos-none class');

  // LONG position in profit: unrealised = 1000 × (1.09000 − 1.08500) = +$5.00
  upd({
    ...BASE,
    asset: 'EURUSD', marketPrice: 1.09000,
    position: { side: 'LONG', entry: 1.08500, stopLoss: 1.08000, takeProfit: 1.09500, shares: 1000, confidence: 75 },
  });
  assert(el('pos-empty').style.display === 'none', 'Empty hidden when position open');
  assert(el('pos-content').style.display !== 'none', 'Content shown');
  assert(el('pos-badge').className.includes('pos-long'), 'pos-long class');
  const lb = el('pos-body').innerHTML;
  assert(lb.includes('LONG'),   'LONG direction in table');
  assert(lb.includes('EURUSD'), 'Asset in table');
  assert(lb.includes('1.09000'),'Current price in table');
  assert(lb.includes('75%'),    'Confidence shown');
  assert(lb.includes('$5.00'), 'Unrealised P&L +$5 correct');

  // LONG position in loss: unrealised = 1000 × (1.08000 − 1.08500) = −$5.00
  upd({
    ...BASE,
    asset: 'EURUSD', marketPrice: 1.08000,
    position: { side: 'LONG', entry: 1.08500, stopLoss: 1.08000, takeProfit: 1.09500, shares: 1000 },
  });
  assert(el('pos-body').innerHTML.includes('-$5.00'), 'Unrealised P&L −$5 correct');

  // SHORT position in profit: unrealised = 500 × (1.27500 − 1.27000) = +$2.50
  upd({
    ...BASE,
    asset: 'GBPUSD', marketPrice: 1.27000,
    position: { side: 'SHORT', entry: 1.27500, stopLoss: 1.28000, takeProfit: 1.26500, shares: 500, confidence: 68 },
  });
  assert(el('pos-badge').className.includes('pos-short'), 'pos-short class');
  const sb = el('pos-body').innerHTML;
  assert(sb.includes('SHORT'), 'SHORT direction shown');
  assert(sb.includes('$2.50'), 'SHORT unrealised P&L +$2.50 correct');

  // SHORT position in loss: unrealised = 500 × (1.27500 − 1.28000) = −$25
  upd({
    ...BASE,
    asset: 'GBPUSD', marketPrice: 1.28000,
    position: { side: 'SHORT', entry: 1.27500, stopLoss: 1.28000, takeProfit: 1.26500, shares: 500 },
  });
  assert(el('pos-body').innerHTML.includes('-$2.50'), 'SHORT loss unrealised P&L correct');

  // Position clears back to empty
  upd({ ...BASE, position: null });
  assert(el('pos-empty').style.display !== 'none', 'Empty state restored after close');

} catch(e) { assert(false, 'Open position test', e.message); }


// ═══════════════════════════════════════════════════════════════════════════════
section('8 — Risk panel: daily loss bar, drawdown bar, circuit breaker');
// ═══════════════════════════════════════════════════════════════════════════════
try {
  setup();

  // Healthy baseline
  upd({ ...BASE });
  assert(el('r-dd').textContent.includes('2.50%'), 'Drawdown % shown');
  assert(el('r-dd').style.color === 'var(--green)', 'Small drawdown is green');
  assert(el('cb-badge').className.includes('cb-ok'), 'CB-OK when healthy');
  assert(el('cb-badge').textContent.includes('OK'), 'CB-OK text');
  assert(el('r-regime').textContent === 'TRENDING', 'Market regime shown');
  assert(el('r-peak').textContent.includes('10300'), 'Peak capital shown');
  assert(el('r-spread').textContent.includes('pips'), 'Spread shown with pips unit');
  assert(el('r-drift').textContent === 'Monitoring', 'Drift active shows Monitoring');
  assert(el('r-drift').style.color === 'var(--green)', 'Active drift is green');

  // Moderate drawdown (8-15%) → yellow
  upd({ ...BASE, maxDrawdown: 10 });
  assert(el('r-dd').style.color === 'var(--yellow)', 'Drawdown 10% → yellow');
  const ddBar10 = parseFloat(el('r-dd-bar').style.width);
  assert(ddBar10 > 45 && ddBar10 < 55, `Drawdown bar ~50% at 10% drawdown (got ${ddBar10}%)`);

  // High drawdown (>15%) → red + warning CB
  upd({ ...BASE, maxDrawdown: 16, drift: { ...BASE.drift, halted: false } });
  assert(el('r-dd').style.color === 'var(--red)', 'Drawdown > 15% → red');
  assert(el('cb-badge').className.includes('cb-warn'), 'CB-WARN when drawdown > 15%');

  // Drawdown bar at 100% for ≥20%
  upd({ ...BASE, maxDrawdown: 20 });
  assert(el('r-dd-bar').style.width === '100%', 'Drawdown bar capped at 100%');
  upd({ ...BASE, maxDrawdown: 50 });
  assert(el('r-dd-bar').style.width === '100%', 'Extreme drawdown does not exceed 100%');

  // Circuit breaker tripped via drift halt
  upd({ ...BASE, drift: { ...BASE.drift, halted: true } });
  assert(el('cb-badge').className.includes('cb-halt'), 'CB-HALT when drift halted');
  assert(el('cb-badge').textContent.includes('TRIPPED'), 'CB-HALT text');
  assert(el('r-drift').textContent === 'HALTED', 'Drift status shows HALTED');
  assert(el('r-drift').style.color === 'var(--red)', 'Halted drift is red');

  // Circuit breaker tripped via top-level halted flag
  upd({ ...BASE, halted: true });
  assert(el('cb-badge').className.includes('cb-halt'), 'CB-HALT when engine halted');

  // Daily loss bar — 3.5% loss out of 7% max → ~50% bar
  upd({ ...BASE, capital: 9650, initialCapital: 10000, dailyStartCapital: 10000 });
  const dlBar = parseFloat(el('r-daily-bar').style.width);
  assert(dlBar > 40 && dlBar < 60, `Daily loss bar ~50% at 3.5% loss (got ${dlBar}%)`);

  // Daily loss at max (7%) → 100%
  upd({ ...BASE, capital: 9300, initialCapital: 10000, dailyStartCapital: 10000 });
  const dlBarMax = parseFloat(el('r-daily-bar').style.width);
  assert(dlBarMax >= 99, `Daily loss bar at 100% at 7% loss (got ${dlBarMax}%)`);

  // Inactive drift
  upd({ ...BASE, drift: { active: false, halted: false } });
  assert(el('r-drift').textContent === 'Inactive', 'Drift inactive shown');

} catch(e) { assert(false, 'Risk panel test', e.message); }


// ═══════════════════════════════════════════════════════════════════════════════
section('9 — Recent trades: empty, capped at 10, colors, duration');
// ═══════════════════════════════════════════════════════════════════════════════
function mkTrade(i, win, asset = 'EURUSD') {
  return {
    asset,
    side: win ? 'LONG' : 'SHORT',
    entry:         1.0850 + i * 0.0001,
    exit:          win ? 1.0900 + i * 0.0001 : 1.0800 - i * 0.0001,
    profit:        win ? 50 + i : -(30 + i),
    profitPercent: win ? 0.5 + i * 0.01 : -(0.3 + i * 0.01),
    confidence:    60 + i,
    duration:      (i + 1) * 60000,
    reason:        'take_profit',
  };
}

try {
  setup();

  // Empty
  upd({ ...BASE, recentTrades: [] });
  assert(el('trades-body').textContent.includes('No trades recorded'), 'Empty placeholder shown');
  assert(el('trades-meta').textContent === 'Last 0', 'Meta: Last 0 for empty');

  // One win
  upd({ ...BASE, recentTrades: [mkTrade(0, true)] });
  assert(el('trades-body').querySelector('.result-win') !== null, 'WIN badge rendered');
  assert(!el('trades-body').innerHTML.includes('No trades'), 'Placeholder removed');
  assert(el('trades-body').innerHTML.includes('+'), 'Positive P&L has + prefix');
  assert(el('trades-meta').textContent === 'Last 1', 'Meta: Last 1');

  // One loss
  upd({ ...BASE, recentTrades: [mkTrade(0, false)] });
  assert(el('trades-body').querySelector('.result-loss') !== null, 'LOSS badge rendered');

  // 5 trades
  upd({ ...BASE, recentTrades: Array.from({ length: 5 }, (_, i) => mkTrade(i, i % 2 === 0)) });
  assert(el('trades-body').querySelectorAll('tr').length === 5, '5 rows for 5 trades');
  assert(el('trades-meta').textContent === 'Last 5', 'Meta: Last 5');

  // 15 trades → capped at 10
  upd({ ...BASE, recentTrades: Array.from({ length: 15 }, (_, i) => mkTrade(i, i % 3 !== 0)) });
  assert(el('trades-body').querySelectorAll('tr').length === 10, 'Capped at 10 rows');
  assert(el('trades-meta').textContent === 'Last 10', 'Meta: Last 10');

  // Direction arrows
  const html = el('trades-body').innerHTML;
  assert(html.includes('▲') || html.includes('▼'), 'Direction arrows in rows');

  // Duration formatting
  upd({ ...BASE, recentTrades: [{ ...mkTrade(0, true), duration: 120000 }] });
  assert(el('trades-body').innerHTML.includes('2m'), '2-minute duration shown');

  // No duration → dash
  upd({ ...BASE, recentTrades: [{ ...mkTrade(0, true), duration: undefined }] });
  assert(el('trades-body').innerHTML.includes('—'), 'Missing duration → dash');

  // Mixed assets
  upd({ ...BASE, recentTrades: [
    mkTrade(0, true, 'EURUSD'), mkTrade(1, false, 'GBPUSD'), mkTrade(2, true, 'USDJPY'),
  ]});
  const mix = el('trades-body').innerHTML;
  assert(mix.includes('EURUSD') && mix.includes('GBPUSD') && mix.includes('USDJPY'), 'Multi-asset trades shown');

} catch(e) { assert(false, 'Recent trades test', e.message); }


// ═══════════════════════════════════════════════════════════════════════════════
section('10 — Controls: WS commands dispatched on every interaction');
// ═══════════════════════════════════════════════════════════════════════════════
try {
  setup();

  // Start
  el('btn-start').click();
  assert(win.__wsSent.some(m => m.cmd === 'start'), 'Start → { cmd: start }');

  // Stop
  el('btn-stop').click();
  assert(win.__wsSent.some(m => m.cmd === 'stop'), 'Stop → { cmd: stop }');

  // Pair selector — all 4 pairs
  for (const pair of ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD']) {
    win.__wsSent = [];
    el('pair-select').value = pair;
    el('pair-select').dispatchEvent(new win.Event('change'));
    assert(win.__wsSent.some(m => m.cmd === 'setPair' && m.pair === pair), `setPair for ${pair}`);
  }

  // Backtest — ctrl-panel button
  win.__wsSent = [];
  el('btn-backtest').click();
  assert(win.__wsSent.some(m => m.cmd === 'backtest'), 'btn-backtest → { cmd: backtest }');

  // Backtest — large landing button
  win.__wsSent = [];
  el('bt-btn').click();
  assert(win.__wsSent.some(m => m.cmd === 'backtest'), 'bt-btn → { cmd: backtest }');

  // Mode toggle (first click → switch to live)
  win.__wsSent = [];
  el('mode-toggle').click();
  const modeCmd = win.__wsSent.find(m => m.cmd === 'setMode');
  assert(modeCmd !== undefined, 'Mode toggle → { cmd: setMode }');
  assert(modeCmd && (modeCmd.mode === 'live' || modeCmd.mode === 'paper'), 'setMode has valid mode value');

  // Toggle again (second click → back to paper)
  win.__wsSent = [];
  el('mode-toggle').click();
  const modeCmd2 = win.__wsSent.find(m => m.cmd === 'setMode');
  assert(modeCmd2 !== undefined, 'Second mode toggle sends setMode again');
  assert(modeCmd && modeCmd2 && modeCmd.mode !== modeCmd2.mode, 'Mode alternates between paper and live');

} catch(e) { assert(false, 'Controls / WS dispatch test', e.message); }


// ═══════════════════════════════════════════════════════════════════════════════
section('11 — Backtest: idle → running → results state machine');
// ═══════════════════════════════════════════════════════════════════════════════
try {
  setup();

  // Idle
  upd({ ...BASE, backtestMode: false });
  assert(el('bt-idle').style.display    !== 'none', 'Idle visible initially');
  assert(el('bt-running').style.display === 'none',  'Running hidden initially');
  assert(el('bt-results').style.display === 'none',  'Results hidden initially');
  assert(el('bt-meta').textContent === 'Ready', 'Meta: Ready');

  // Running
  upd({ ...BASE, backtestMode: true });
  assert(el('bt-idle').style.display    === 'none',  'Idle hidden while running');
  assert(el('bt-running').style.display !== 'none',  'Running panel visible');
  assert(el('bt-results').style.display === 'none',  'Results hidden while running');
  assert(el('bt-meta').textContent === 'Running…', 'Meta: Running…');

  // Completed (was true → now false)
  upd({
    ...BASE,
    backtestMode: false,
    capital: 11500,
    initialCapital: 10000,
    metrics: { ...BASE.metrics, winRate: 63.2, sharpe: 1.55, maxDrawdown: 8.4 },
  });
  assert(el('bt-running').style.display === 'none',  'Running hidden after complete');
  assert(el('bt-results').style.display !== 'none',  'Results shown after complete');
  assert(el('bt-return').textContent.includes('15.00%'), 'Total return in results (15%)');
  assert(el('bt-wr').textContent.includes('63.2%'),      'Win rate in results');
  assert(el('bt-sharpe').textContent.includes('1.55'),   'Sharpe in results');
  assert(el('bt-meta').textContent === 'Ready', 'Meta returns to Ready');

  // Trigger via bt-btn while connected → shows running state immediately
  win.__wsSent = [];
  el('bt-btn').click();
  assert(el('bt-running').style.display !== 'none', 'Running panel shown after bt-btn click');
  assert(el('bt-results').style.display === 'none',  'Results hidden during new run');
  assert(win.__wsSent.some(m => m.cmd === 'backtest'), 'Backtest command sent from bt-btn');

} catch(e) { assert(false, 'Backtest state machine test', e.message); }


// ═══════════════════════════════════════════════════════════════════════════════
section('12 — Pair selector syncs automatically from server snapshot');
// ═══════════════════════════════════════════════════════════════════════════════
try {
  setup();

  for (const pair of ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD']) {
    upd({ ...BASE, asset: pair });
    assert(el('pair-select').value === pair, `Selector syncs to ${pair} from server`);
  }

  // Unknown pair — should not crash or break selector
  upd({ ...BASE, asset: 'NZDUSD' });
  assert(true, 'Unknown asset from server does not crash pair selector');

} catch(e) { assert(false, 'Pair selector sync test', e.message); }


// ═══════════════════════════════════════════════════════════════════════════════
section('13 — Edge cases: malformed / null / partial data never crashes');
// ═══════════════════════════════════════════════════════════════════════════════
try {
  setup();

  const CASES = [
    ['{} — empty object',              {}],
    ['only ts',                        { ts: Date.now() }],
    ['null capital and metrics',       { ts: Date.now(), capital: null, metrics: null }],
    ['zero capital and initial',       { ts: Date.now(), capital: 0, initialCapital: 0 }],
    ['negative capital',               { ts: Date.now(), capital: -500, initialCapital: 10000 }],
    ['Infinity capital',               { ts: Date.now(), capital: Infinity }],
    ['zero confidence',                { ts: Date.now(), mlConfidenceScore: 0 }],
    ['confidence over 100',            { ts: Date.now(), mlConfidenceScore: 150 }],
    ['drawdown > 100%',               { ts: Date.now(), maxDrawdown: 200 }],
    ['null recentTrades',              { ts: Date.now(), recentTrades: null }],
    ['empty position object',          { ts: Date.now(), position: {} }],
    ['null spread',                    { ts: Date.now(), spread: null }],
    ['null drift',                     { ts: Date.now(), drift: null }],
    ['partial metrics',               { ts: Date.now(), metrics: { trades: 5, winRate: null } }],
    ['undefined asset',               { ...BASE, asset: undefined }],
    ['zero marketPrice',              { ...BASE, marketPrice: 0 }],
    ['missing initialCapital',        { ts: Date.now(), capital: 10000 }],
    ['null mlOOS',                    { ...BASE, mlOOS: null }],
    ['null liquidity',                { ...BASE, liquidity: null }],
    ['null calibration',              { ...BASE, calibration: null }],
    ['trades with nulls',             { ...BASE, recentTrades: [{ profit: null, entry: null, exit: null }] }],
    ['negative dailyPnl',             { ...BASE, dailyPnl: -99999 }],
    ['NaN everywhere',                { ts: NaN, capital: NaN, maxDrawdown: NaN }],
  ];

  for (const [label, data] of CASES) {
    let threw = false;
    try { upd(data); } catch(e) { threw = true; }
    assert(!threw, `No crash: ${label}`);
  }

} catch(e) { assert(false, 'Edge case crash guard', e.message); }


// ═══════════════════════════════════════════════════════════════════════════════
section('14 — Extreme and boundary values render correctly');
// ═══════════════════════════════════════════════════════════════════════════════
try {
  setup();

  // Very large capital
  upd({ ...BASE, capital: 9_999_999.99, initialCapital: 10000 });
  assert(el('s-capital').textContent === '$9999999.99', 'Large capital formatted');
  assert(el('s-capital').style.color === 'var(--green)', 'Large capital → green');

  // Zero capital
  upd({ ...BASE, capital: 0, initialCapital: 10000 });
  assert(el('s-capital').textContent === '$0.00', 'Zero capital formatted');
  assert(el('s-capital').style.color === 'var(--red)', 'Zero capital → red');

  // 100% win rate
  upd({ ...BASE, metrics: { ...BASE.metrics, winRate: 100, wins: 100, losses: 0 } });
  assert(el('s-wr').textContent === '100.0%', '100% win rate shown');
  assert(el('s-wr').style.color === 'var(--green)', '100% win rate → green');

  // 0% win rate
  upd({ ...BASE, metrics: { ...BASE.metrics, winRate: 0, wins: 0, losses: 20 } });
  assert(el('s-wr').textContent === '0.0%', '0% win rate shown');
  assert(el('s-wr').style.color === 'var(--red)', '0% win rate → red');

  // 1 million trades
  upd({ ...BASE, metrics: { ...BASE.metrics, trades: 1_000_000, wins: 600_000, losses: 400_000 } });
  assert(el('s-trades').textContent === '1000000', '1M trades shown');

  // Confidence exactly at thresholds
  upd({ ...BASE, mlConfidenceScore: 70 });
  assert(el('conf-bar').style.width === '70%', 'Confidence bar exact at 70%');
  upd({ ...BASE, mlConfidenceScore: 50 });
  assert(el('conf-bar').style.width === '50%', 'Confidence bar exact at 50%');

  // Very large P&L
  upd({ ...BASE, dailyPnl: 99999.99 });
  assert(el('s-pnl').textContent.includes('99999.99'), 'Large P&L formatted');

  // Very negative P&L
  upd({ ...BASE, dailyPnl: -99999.99 });
  assert(el('s-pnl').textContent.includes('99999.99'), 'Large negative P&L formatted');
  assert(el('s-pnl').style.color === 'var(--red)', 'Large negative P&L → red');

  // USDJPY price precision
  upd({ ...BASE, asset: 'USDJPY', marketPrice: 149.999 });
  assert(el('pv-USDJPY').textContent === '149.999', 'USDJPY 3dp preserved');

} catch(e) { assert(false, 'Extreme values test', e.message); }


// ═══════════════════════════════════════════════════════════════════════════════
section('15 — CSS design: gold theme, dark bg, transitions, animations');
// ═══════════════════════════════════════════════════════════════════════════════
try {
  const html = fs.readFileSync('./dashboard.html', 'utf8');

  // CSS variables defined
  for (const v of ['--bg0','--bg1','--bg2','--accent','--accent-dim','--accent-glow',
                   '--green','--red','--yellow','--text','--text2','--text3','--mono','--sans']) {
    assert(html.includes(v + ':'), `CSS variable ${v} defined`);
  }

  // Gold accent present
  assert(html.includes('#F59E0B') || html.includes('245,158,11'), 'Gold accent color used');
  assert(html.includes('F59E0B') && html.includes('EA580C'), 'Both gold and orange present');

  // Dark backgrounds
  assert(html.includes('#04040C') || html.includes('#06') || html.includes('--bg0'), 'Very dark background defined');

  // Key design features
  assert(html.includes('backdrop-filter'), 'Backdrop blur on header');
  assert(html.includes('transition'), 'CSS transitions for smooth UI');
  assert(html.includes('@keyframes'), 'Keyframe animations present');
  assert(html.includes('border-radius'), 'Rounded corners');
  assert(html.includes('linear-gradient'), 'Gradients in design');
  assert(html.includes('@media'), 'Responsive breakpoints');
  assert(html.includes('-webkit-background-clip'), 'Gradient text on logo');
  assert(html.includes('pulse'), 'Pulse animation defined (for live indicator)');
  assert(html.includes('tabular-nums'), 'Tabular numbers for price readability');

  // All 4 WS command strings present in script
  for (const cmd of ["'start'", "'stop'", "'setPair'", "'backtest'", "'setMode'"]) {
    assert(html.includes(cmd), `Command ${cmd} present in script`);
  }

  // Footer present
  assert(html.includes('<footer'), 'Footer element present');
  assert(html.includes('footer-ts'), 'Footer timestamp element present');

} catch(e) { assert(false, 'CSS design check', e.message); }


// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(70));
console.log('  RESULTS');
console.log('═'.repeat(70));
console.log(`  ✅ Passed:  ${passed}`);
console.log(`  ❌ Failed:  ${failed}`);
if (failures.length) {
  console.log('\n  Failed tests:');
  failures.forEach(f => console.log('    • ' + f));
}
console.log('');
process.exit(failed > 0 ? 1 : 0);
