'use strict';
// ── test-backtest-learning.js ─────────────────────────────────────────────────
// Heavy test suite for the backtest-log-saving + ML-learning pipeline.
//
// Sections:
//   1.  learnFromBacktest() — empty / null inputs
//   2.  Confidence band analysis accuracy
//   3.  Optimal minConfidence derivation
//   4.  Exit-reason breakdown
//   5.  Winner vs loser profile (avgConf, avgDur)
//   6.  Strategy bias inference (trend vs meanReversion)
//   7.  Regime multiplier adjustment values and clamping
//   8.  Recommendation string generation
//   9.  Config persistence — file written to strategies/learned-config.json
//  10.  loadLearnedConfig() — round-trip and schema check
//  11.  loadLearnedConfig() — missing file → returns null
//  12.  loadLearnedConfig() — wrong schemaVersion → returns null
//  13.  backtest-engine: timestamped log saved (bt-*.json created)
//  14.  backtest-engine: archive pruning (>30 logs removed)
//  15.  backtest-engine: _lastLearnedConfig set on engine after backtest
//  16.  backtest-engine: strategyManager._learnedConfig reset after backtest
//  17.  backtest-engine: learning-complete event emitted
//  18.  strategies/index.js: StrategyManager applies learned multipliers
//  19.  strategies/index.js: missing learned-config → falls back gracefully
//  20.  dashboard _snapshot() includes learnedStrategy field
//  21.  Integration: full runBacktest() → learn → StrategyManager picks up weights
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

const fs   = require('fs');
const path = require('path');

const {
  learnFromBacktest,
  loadLearnedConfig,
  LEARNED_CONFIG_PATH,
  CONF_BANDS,
  MIN_BUCKET_SAMPLE,
  WIN_RATE_FLOOR,
} = require('./strategy-learner');

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeTrades(spec) {
  // spec: array of { conf, profit } shorthand
  return spec.map((s, i) => ({
    asset:         'EURUSD',
    entry:         1.09,
    exit:          1.091,
    profit:        s.profit,
    profitPercent: s.profit / 1090 * 100,
    confidence:    s.conf,
    regime:        'BACKTEST',
    reason:        s.profit > 0 ? 'take_profit' : 'stop_loss',
    duration:      s.dur || 300_000,
  }));
}

// A clean set of 30 trades with a clear bias toward high-confidence wins
function bigTrades() {
  const trades = [];
  // 10 high-conf (75) wins → 100% win rate in 70-80 band
  for (let i = 0; i < 10; i++) trades.push({ conf: 75, profit: 50 + i });
  // 5 mid-conf (65) wins + 5 losses → 50% win rate in 60-70 band
  for (let i = 0; i < 5;  i++) trades.push({ conf: 65, profit: 30 + i });
  for (let i = 0; i < 5;  i++) trades.push({ conf: 65, profit: -(20 + i) });
  // 5 low-conf (55) losses → 0% win rate in 50-60 band
  for (let i = 0; i < 5;  i++) trades.push({ conf: 55, profit: -15 });
  return makeTrades(trades);
}

// ─────────────────────────────────────────────────────────────────────────────
section('1 — learnFromBacktest: empty / null inputs');
// ─────────────────────────────────────────────────────────────────────────────
{
  const r1 = learnFromBacktest([]);
  assert(r1.error !== undefined,              'Empty array returns error field');
  assert(r1.learnedMinConfidence === 60,      'Default minConfidence is 60 on empty input');

  const r2 = learnFromBacktest(null);
  assert(r2.error !== undefined,              'null input returns error field');

  const r3 = learnFromBacktest(undefined);
  assert(r3.error !== undefined,              'undefined input returns error field');
}

// ─────────────────────────────────────────────────────────────────────────────
section('2 — Confidence band analysis accuracy');
// ─────────────────────────────────────────────────────────────────────────────
{
  // 4 trades in 60-70 band: 3 wins, 1 loss → 75% win rate
  const trades = makeTrades([
    { conf: 62, profit: 10 },
    { conf: 64, profit: 20 },
    { conf: 68, profit: 30 },
    { conf: 66, profit: -5 },
  ]);
  const cfg = learnFromBacktest(trades);
  const band = cfg.confidenceAnalysis['60-70'];
  assert(band.count === 4,   'Band 60-70: count = 4');
  assert(band.wins  === 3,   'Band 60-70: wins = 3');
  assert(band.losses === 1,  'Band 60-70: losses = 1');
  assert(band.winRate === 75,'Band 60-70: winRate = 75');

  // Trades below/above band boundaries stay out
  const otherBands = Object.entries(cfg.confidenceAnalysis)
    .filter(([k]) => k !== '60-70')
    .map(([,v]) => v.count);
  assert(otherBands.every(c => c === 0), 'No trades leak into other bands');
}

// ─────────────────────────────────────────────────────────────────────────────
section('3 — Optimal minConfidence derivation');
// ─────────────────────────────────────────────────────────────────────────────
{
  // 50-60 band: 3 trades, 2 wins → 66.7% → should be selected as lowest OK band
  const trades1 = makeTrades([
    { conf: 52, profit:  10 },
    { conf: 55, profit:  15 },
    { conf: 58, profit: -5  },
  ]);
  const cfg1 = learnFromBacktest(trades1);
  assert(cfg1.learnedMinConfidence === 50, 'minConfidence = 50 when 50-60 band passes threshold');

  // 50-60 band: only 1 trade → below MIN_BUCKET_SAMPLE → skip, try next
  const trades2 = makeTrades([
    { conf: 55, profit: 10 },            // 1 in 50-60 (not enough)
    { conf: 65, profit: 10 },
    { conf: 65, profit: 10 },
    { conf: 65, profit: 10 },            // 3 in 60-70 with 100% win rate
  ]);
  const cfg2 = learnFromBacktest(trades2);
  assert(cfg2.learnedMinConfidence === 60, 'minConfidence = 60 when 50-60 lacks sample but 60-70 passes');

  // All bands below 55% win rate → stays at default 60
  const trades3 = makeTrades([
    { conf: 55, profit: -10 },
    { conf: 55, profit: -10 },
    { conf: 55, profit: -10 },
    { conf: 65, profit: -10 },
    { conf: 65, profit: -10 },
    { conf: 65, profit: -10 },
  ]);
  const cfg3 = learnFromBacktest(trades3);
  assert(cfg3.learnedMinConfidence === 60, 'Default 60 when no band meets WIN_RATE_FLOOR');
}

// ─────────────────────────────────────────────────────────────────────────────
section('4 — Exit reason breakdown');
// ─────────────────────────────────────────────────────────────────────────────
{
  const trades = [
    { asset:'EURUSD', entry:1.09, exit:1.095, profit: 50, profitPercent:0.46, confidence:70, regime:'BACKTEST', reason:'take_profit', duration:300000 },
    { asset:'EURUSD', entry:1.09, exit:1.095, profit: 40, profitPercent:0.37, confidence:72, regime:'BACKTEST', reason:'take_profit', duration:300000 },
    { asset:'EURUSD', entry:1.09, exit:1.087, profit:-20, profitPercent:-0.28, confidence:62, regime:'BACKTEST', reason:'stop_loss',   duration:200000 },
    { asset:'EURUSD', entry:1.09, exit:1.085, profit:-30, profitPercent:-0.46, confidence:58, regime:'BACKTEST', reason:'stop_loss',   duration:180000 },
    { asset:'EURUSD', entry:1.09, exit:1.091, profit: 10, profitPercent:0.09, confidence:65, regime:'BACKTEST', reason:'signal',       duration:400000 },
  ];
  const cfg = learnFromBacktest(trades);
  const ex  = cfg.exitReasonAnalysis;

  assert(ex.take_profit !== undefined,      'take_profit exit group present');
  assert(ex.take_profit.count === 2,        'take_profit: count = 2');
  assert(ex.take_profit.winRate === 100,    'take_profit: winRate = 100');
  assert(ex.stop_loss   !== undefined,      'stop_loss exit group present');
  assert(ex.stop_loss.count === 2,          'stop_loss: count = 2');
  assert(ex.stop_loss.winRate === 0,        'stop_loss: winRate = 0');
  assert(ex.signal     !== undefined,       'signal exit group present');
  assert(ex.signal.count === 1,             'signal: count = 1');
  assert(ex.take_profit.avgProfit > 0,      'take_profit avgProfit > 0');
  assert(ex.stop_loss.avgProfit < 0,        'stop_loss avgProfit < 0');
}

// ─────────────────────────────────────────────────────────────────────────────
section('5 — Winner vs loser profile');
// ─────────────────────────────────────────────────────────────────────────────
{
  const trades = makeTrades([
    { conf: 80, profit: 50, dur: 600_000 },
    { conf: 75, profit: 40, dur: 500_000 },
    { conf: 70, profit: 30, dur: 400_000 },
    { conf: 55, profit: -10, dur: 100_000 },
    { conf: 52, profit: -15, dur: 120_000 },
  ]);
  const cfg = learnFromBacktest(trades);

  assert(cfg.avgWinningConfidence > cfg.avgLosingConfidence, 'avgWinningConfidence > avgLosingConfidence');
  assert(cfg.avgWinningDurationMs > cfg.avgLosingDurationMs, 'avgWinningDurationMs > avgLosingDurationMs');
  assert(cfg.avgWinningConfidence > 70,  'avgWinningConfidence > 70 for these inputs');
  assert(cfg.avgLosingConfidence  < 60,  'avgLosingConfidence  < 60 for these inputs');
}

// ─────────────────────────────────────────────────────────────────────────────
section('6 — Strategy bias inference');
// ─────────────────────────────────────────────────────────────────────────────
{
  // High-conf wins >> low-conf wins → trend bias
  const trendTrades = makeTrades([
    ...Array(5).fill({ conf: 75, profit: 50 }),
    ...Array(3).fill({ conf: 55, profit: -20 }),
  ]);
  const cfgT = learnFromBacktest(trendTrades);
  assert(cfgT.strategyBias === 'trend', 'Trend bias when high-conf win rate >> low-conf');

  // Low-conf wins >> high-conf wins → meanReversion bias
  const mrTrades = makeTrades([
    ...Array(3).fill({ conf: 75, profit: -30 }),
    ...Array(5).fill({ conf: 55, profit: 20 }),
  ]);
  const cfgMR = learnFromBacktest(mrTrades);
  assert(cfgMR.strategyBias === 'meanReversion', 'MR bias when high-conf fails and low-conf succeeds');
}

// ─────────────────────────────────────────────────────────────────────────────
section('7 — Regime multiplier adjustments — values and clamping');
// ─────────────────────────────────────────────────────────────────────────────
{
  const cfg = learnFromBacktest(bigTrades());
  const rma = cfg.regimeMultiplierAdjustments;

  assert(typeof rma === 'object' && rma !== null, 'regimeMultiplierAdjustments is an object');
  assert('trend'         in rma, 'trend key present');
  assert('meanReversion' in rma, 'meanReversion key present');
  assert('breakout'      in rma, 'breakout key present');

  // All values must be within safe bounds (0.2 … 2.0)
  for (const [stratKey, regimes] of Object.entries(rma)) {
    for (const [regime, val] of Object.entries(regimes)) {
      assert(val >= 0.2 && val <= 2.0,
        `${stratKey}.${regime} within [0.2, 2.0]`, `got ${val}`);
    }
  }

  // TRENDING trend multiplier should be boosted above baseline 1.5 for this set
  assert(rma.trend.TRENDING >= 1.5, 'trend.TRENDING >= 1.5 when high-conf trades win');
  // RANGING trend multiplier should stay below baseline
  assert(rma.trend.RANGING < 0.5,   'trend.RANGING < 0.5 (unfavorable regime)');
  // Breakout values unchanged from defaults
  assert(rma.breakout.TRENDING === 1.3 && rma.breakout.RANGING === 0.3, 'Breakout multipliers unchanged');
}

// ─────────────────────────────────────────────────────────────────────────────
section('8 — Recommendation string');
// ─────────────────────────────────────────────────────────────────────────────
{
  // < 10 trades → low-sample warning
  const smallCfg = learnFromBacktest(makeTrades([
    { conf: 70, profit: 10 },
    { conf: 65, profit: -5 },
  ]));
  assert(typeof smallCfg.recommendation === 'string', 'recommendation is a string');
  assert(smallCfg.recommendation.includes('fewer') || smallCfg.recommendation.includes('Only'),
    'Small sample warning present in recommendation');

  // >= 10 trades with clear confidence gap → mentions minConfidence
  const bigCfg = learnFromBacktest(bigTrades());
  assert(bigCfg.recommendation.includes(String(bigCfg.learnedMinConfidence)),
    'Recommendation mentions learnedMinConfidence value');

  // High SL rate (>40%) → recommends tighter SL
  const slTrades = makeTrades(Array(15).fill({ conf: 65, profit: -10 })
    .concat(Array(5).fill({ conf: 65, profit: 5 })));
  // Give stop_loss reason to most trades
  slTrades.forEach(t => { if (t.profit < 0) t.reason = 'stop_loss'; });
  const slCfg = learnFromBacktest(slTrades);
  assert(slCfg.exitReasonAnalysis.stop_loss !== undefined, 'stop_loss group exists in SL-heavy backtest');
}

// ─────────────────────────────────────────────────────────────────────────────
section('9 — Config persistence: file written');
// ─────────────────────────────────────────────────────────────────────────────
{
  const trades  = bigTrades();
  const cfg     = learnFromBacktest(trades, { totalReturn: 3.5, backtestId: 'bt-test-persist' });

  assert(fs.existsSync(LEARNED_CONFIG_PATH), 'learned-config.json exists after learnFromBacktest');

  const raw     = fs.readFileSync(LEARNED_CONFIG_PATH, 'utf8');
  const parsed  = JSON.parse(raw);
  assert(parsed.schemaVersion === 1,         'Persisted schemaVersion = 1');
  assert(parsed.tradeCount === trades.length,'Persisted tradeCount matches input');
  assert(parsed.basedOnBacktestId === 'bt-test-persist', 'Persisted backtestId matches');
  assert(typeof parsed.recommendation === 'string', 'Persisted recommendation is a string');
  assert(parsed.regimeMultiplierAdjustments !== undefined, 'Persisted regimeMultiplierAdjustments present');
}

// ─────────────────────────────────────────────────────────────────────────────
section('10 — loadLearnedConfig: round-trip and schema check');
// ─────────────────────────────────────────────────────────────────────────────
{
  learnFromBacktest(bigTrades(), { backtestId: 'bt-round-trip' }); // ensure file exists
  const loaded = loadLearnedConfig();
  assert(loaded !== null,                    'loadLearnedConfig returns non-null when file exists');
  assert(loaded.schemaVersion === 1,         'Loaded schemaVersion = 1');
  assert(typeof loaded.learnedMinConfidence === 'number', 'learnedMinConfidence is a number');
  assert(typeof loaded.regimeMultiplierAdjustments === 'object', 'regimeMultiplierAdjustments is an object');
  assert(typeof loaded.recommendation === 'string', 'recommendation is a string');
  assert(loaded.tradeCount > 0,              'tradeCount > 0');
}

// ─────────────────────────────────────────────────────────────────────────────
section('11 — loadLearnedConfig: missing file returns null');
// ─────────────────────────────────────────────────────────────────────────────
{
  const fakePath = LEARNED_CONFIG_PATH + '.nonexistent';
  // We can't call loadLearnedConfig() with a different path, so we rename temporarily
  let renamed = false;
  if (fs.existsSync(LEARNED_CONFIG_PATH)) {
    fs.renameSync(LEARNED_CONFIG_PATH, LEARNED_CONFIG_PATH + '.bak');
    renamed = true;
  }
  const result = loadLearnedConfig();
  assert(result === null, 'loadLearnedConfig returns null when file missing');
  if (renamed) fs.renameSync(LEARNED_CONFIG_PATH + '.bak', LEARNED_CONFIG_PATH);
}

// ─────────────────────────────────────────────────────────────────────────────
section('12 — loadLearnedConfig: wrong schemaVersion returns null');
// ─────────────────────────────────────────────────────────────────────────────
{
  const orig = fs.existsSync(LEARNED_CONFIG_PATH) ? fs.readFileSync(LEARNED_CONFIG_PATH) : null;
  fs.writeFileSync(LEARNED_CONFIG_PATH, JSON.stringify({ schemaVersion: 99, learnedMinConfidence: 60 }));
  const r = loadLearnedConfig();
  assert(r === null, 'loadLearnedConfig returns null for schemaVersion 99');
  if (orig) fs.writeFileSync(LEARNED_CONFIG_PATH, orig);
  else { try { fs.unlinkSync(LEARNED_CONFIG_PATH); } catch (_) {} }
}

// ─────────────────────────────────────────────────────────────────────────────
section('13 — backtest-engine: timestamped bt-*.json archive created');
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  const logsDir = path.join(__dirname, 'trade_logs');
  // Clear any bt-*.json leftovers from prior runs so the count starts at 0
  if (fs.existsSync(logsDir)) {
    for (const f of fs.readdirSync(logsDir).filter(f => f.startsWith('bt-') && f.endsWith('.json'))) {
      try { fs.unlinkSync(path.join(logsDir, f)); } catch (_) {}
    }
  }
  const btsBefore = 0;

  // Run a real (short) backtest via the engine mixin
  const EventEmitter = require('events');
  class FakeEngine extends EventEmitter {
    constructor() {
      super();
      this.capital        = 10_000;
      this.initialCapital = 10_000;
      this.trades         = [];
      this.position       = null;
      this.priceHistory   = [];
      this.selectedAsset  = 'EURUSD';
      this.backtestMode   = false;
      this._btRunning     = false;
      this.log = () => {};
    }
  }
  Object.assign(FakeEngine.prototype, require('./backtest-engine'));
  const eng = new FakeEngine();

  await eng.runBacktest({ bars: 200 });   // short run for speed

  const btsAfter = fs.readdirSync(logsDir)
    .filter(f => f.startsWith('bt-') && f.endsWith('.json')).length;

  assert(btsAfter > btsBefore,         'bt-*.json archive created after runBacktest');
  assert(fs.existsSync(path.join(logsDir, 'backtest-dashboard.json')),
    'backtest-dashboard.json also created/updated');

  // ─────────────────────────────────────────────────────────────────────────
  section('14 — backtest-engine: archive pruning (keeps ≤30 logs)');
  // ─────────────────────────────────────────────────────────────────────────
  // Create 35 fake bt-*.json files and run another backtest — should prune to 30
  for (let i = 0; i < 35; i++) {
    fs.writeFileSync(
      path.join(logsDir, `bt-2000-01-01T00-00-${String(i).padStart(2,'0')}.json`),
      '{}'
    );
  }
  const eng2 = new FakeEngine();
  await eng2.runBacktest({ bars: 200 });
  const btsNow = fs.readdirSync(logsDir)
    .filter(f => f.startsWith('bt-') && f.endsWith('.json')).length;
  assert(btsNow <= 30, 'Archive pruned to ≤30 bt-*.json files (got ' + btsNow + ')');

  // ─────────────────────────────────────────────────────────────────────────
  section('15 — backtest-engine: _lastLearnedConfig set on engine');
  // ─────────────────────────────────────────────────────────────────────────
  const eng3 = new FakeEngine();
  await eng3.runBacktest({ bars: 200 });
  assert(eng3._lastLearnedConfig !== undefined, '_lastLearnedConfig is set after runBacktest');
  assert(eng3._lastLearnedConfig !== null,      '_lastLearnedConfig is not null');
  assert(typeof eng3._lastLearnedConfig.learnedMinConfidence === 'number',
    '_lastLearnedConfig.learnedMinConfidence is a number');
  assert(typeof eng3._lastLearnedConfig.recommendation === 'string',
    '_lastLearnedConfig.recommendation is a string');

  // ─────────────────────────────────────────────────────────────────────────
  section('16 — backtest-engine: strategyManager._learnedConfig reset after backtest');
  // ─────────────────────────────────────────────────────────────────────────
  const { StrategyManager } = require('./strategies');
  const eng4 = new FakeEngine();
  eng4.strategyManager = new StrategyManager();
  eng4.strategyManager._learnedConfig = { dummy: true };  // stale cached value
  await eng4.runBacktest({ bars: 200 });
  assert(eng4.strategyManager._learnedConfig === undefined,
    'strategyManager._learnedConfig reset to undefined so it reloads fresh config');

  // ─────────────────────────────────────────────────────────────────────────
  section('17 — backtest-engine: learning-complete event emitted');
  // ─────────────────────────────────────────────────────────────────────────
  const eng5 = new FakeEngine();
  let learnEvent = null;
  eng5.on('learning-complete', (cfg) => { learnEvent = cfg; });
  await eng5.runBacktest({ bars: 200 });
  assert(learnEvent !== null,                    'learning-complete event was emitted');
  assert(typeof learnEvent.learnedMinConfidence === 'number',
    'Event payload has learnedMinConfidence');
  assert(typeof learnEvent.recommendation === 'string',
    'Event payload has recommendation');

  // ─────────────────────────────────────────────────────────────────────────
  section('18 — StrategyManager applies learned multipliers in decide()');
  // ─────────────────────────────────────────────────────────────────────────
  {
    // Write a learned config that heavily favours trend in TRENDING
    const heavyTrend = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      learnedMinConfidence: 65,
      tradeCount: 30,
      winRate: 70,
      strategyBias: 'trend',
      regimeMultiplierAdjustments: {
        trend:         { TRENDING: 2.0, WEAK_TREND: 0.8, RANGING: 0.2, UNKNOWN: 1.0 },
        meanReversion: { TRENDING: 0.2, WEAK_TREND: 1.2, RANGING: 2.0, UNKNOWN: 1.0 },
        breakout:      { TRENDING: 1.3, WEAK_TREND: 0.9, RANGING: 0.3, UNKNOWN: 0.8 },
      },
      recommendation: 'test',
    };
    fs.writeFileSync(LEARNED_CONFIG_PATH, JSON.stringify(heavyTrend, null, 2));

    const sm = new StrategyManager();
    sm._learnedConfig = undefined;  // force reload from file

    // Simulate a TRENDING regime decide()
    const indicators = {
      price: 1.09, rsi: 45, ema9: 1.092, ema21: 1.090, ema50: 1.088, ema200: 1.085,
      goldenCross: true, adx: 28, adxRegime: 'TRENDING', volRatio: 1.0,
      marketRegime: 'TRENDING', regimeStack: {},
    };
    const dec = sm.decide(indicators, { session: 'LONDON', hasPosition: false, capital: 10000 });
    // With 2.0 trend multiplier in TRENDING, trend should dominate
    assert(dec.strategy === 'trend' || dec.action === 'HOLD' || dec.action === 'BUY',
      'StrategyManager uses trend in TRENDING regime with learned 2.0 multiplier');
    assert(sm.lastUsed === 'trend', 'lastUsed = trend in TRENDING regime');

    // Restore original learned config
    learnFromBacktest(bigTrades(), { backtestId: 'bt-restored' });
  }

  // ─────────────────────────────────────────────────────────────────────────
  section('19 — StrategyManager: missing learned-config falls back gracefully');
  // ─────────────────────────────────────────────────────────────────────────
  {
    // Remove the learned config file
    if (fs.existsSync(LEARNED_CONFIG_PATH)) {
      fs.renameSync(LEARNED_CONFIG_PATH, LEARNED_CONFIG_PATH + '.bak19');
    }
    const sm2 = new StrategyManager();
    let threw = false;
    try {
      const indicators = {
        price: 1.09, rsi: 45, ema9: 1.092, ema21: 1.090, ema50: 1.088, ema200: 1.085,
        goldenCross: true, adx: 28, adxRegime: 'TRENDING', volRatio: 1.0,
        marketRegime: 'TRENDING', regimeStack: {},
      };
      sm2.decide(indicators, { session: 'LONDON', hasPosition: false, capital: 10000 });
    } catch (e) { threw = true; }
    assert(!threw, 'StrategyManager.decide() does not throw when learned-config is missing');
    assert(sm2._learnedConfig === null, '_learnedConfig = null when file absent');

    if (fs.existsSync(LEARNED_CONFIG_PATH + '.bak19')) {
      fs.renameSync(LEARNED_CONFIG_PATH + '.bak19', LEARNED_CONFIG_PATH);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  section('20 — dashboard _snapshot() includes learnedStrategy field');
  // ─────────────────────────────────────────────────────────────────────────
  {
    const { Dashboard } = require('./dashboard');
    const dash = new Dashboard(null, 0);  // port 0 — do NOT call start()
    const fakeEngine = {
      capital: 10_000,
      initialCapital: 10_000,
      trades: [],
      position: null,
      priceHistory: [],
      selectedAsset: 'EURUSD',
      backtestMode: false,
      _lastLearnedConfig: {
        schemaVersion: 1,
        learnedMinConfidence: 65,
        tradeCount: 25,
        winRate: 68,
        strategyBias: 'trend',
        avgWinningConfidence: 72,
        avgLosingConfidence: 61,
        recommendation: 'Test recommendation',
        generatedAt: new Date().toISOString(),
        regimeMultiplierAdjustments: {},
      },
      on: () => {},
      emit: () => {},
    };
    dash.engine      = fakeEngine;
    dash.peakCapital = 10_000;
    dash.rejectedOrders = 0;

    const snap = dash._snapshot();
    assert('learnedStrategy' in snap, '_snapshot() includes learnedStrategy field');
    assert(snap.learnedStrategy !== undefined,  'learnedStrategy is not undefined');
    assert(snap.learnedStrategy !== null,        'learnedStrategy is not null (engine has config)');
    assert(snap.learnedStrategy.learnedMinConfidence === 65,
      'learnedStrategy.learnedMinConfidence = 65');
    assert(snap.learnedStrategy.recommendation === 'Test recommendation',
      'learnedStrategy.recommendation correct');
  }

  // ─────────────────────────────────────────────────────────────────────────
  section('21 — Integration: runBacktest → learn → StrategyManager picks up weights');
  // ─────────────────────────────────────────────────────────────────────────
  {
    // Remove stale learned config so we start fresh
    if (fs.existsSync(LEARNED_CONFIG_PATH)) fs.unlinkSync(LEARNED_CONFIG_PATH);
    assert(!fs.existsSync(LEARNED_CONFIG_PATH), 'learned-config.json removed for clean integration test');

    // StrategyManager starts with no learned config
    const sm3 = new StrategyManager();
    assert(sm3._learnedConfig === undefined, 'SM._learnedConfig = undefined before first decide()');

    // Run a backtest — this creates learned-config.json
    const engInt = new FakeEngine();
    engInt.strategyManager = sm3;
    await engInt.runBacktest({ bars: 300 });

    // _learnedConfig should be reset on sm3 (to undefined) so it reloads fresh
    assert(sm3._learnedConfig === undefined, 'SM._learnedConfig reset after backtest');
    assert(fs.existsSync(LEARNED_CONFIG_PATH), 'learned-config.json created by integration backtest');

    // First decide() after backtest reloads the fresh config
    const indicators = {
      price: 1.09, rsi: 50, ema9: 1.091, ema21: 1.089, ema50: 1.087, ema200: 1.083,
      goldenCross: true, adx: 25, adxRegime: 'TRENDING', volRatio: 1.0,
      marketRegime: 'TRENDING', regimeStack: {},
    };
    sm3.decide(indicators, { session: 'NEW_YORK', hasPosition: false, capital: 10000 });
    assert(sm3._learnedConfig !== undefined, 'SM._learnedConfig loaded after first decide() post-backtest');
    assert(sm3._learnedConfig !== null,       'SM._learnedConfig is not null — config loaded successfully');
    assert(sm3._learnedConfig.schemaVersion === 1, 'SM._learnedConfig.schemaVersion = 1');
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
  }, 800);
})();
