'use strict';
const { PeriodSlicer, SurvivorshipFilter } = require('./period-slicer');
/**
 * NIGHTLY AUTO-BACKTEST SCRIPT — Aladdin Trading Agent
 * ─────────────────────────────────────────────────────
 * Runs automatically every night via PM2 cron (see ecosystem.config.js).
 * Fetches the last 24 hours of real M5 candles (288 bars) from OANDA or
 * Alpha Vantage, replays them through the live TradingEngine, and saves a
 * JSON + text report to trade_logs/nightly-YYYY-MM-DD.json
 *
 * Run manually at any time:
 *   node backtest-nightly.js
 *   node backtest-nightly.js --asset EUR_USD --capital 5000
 *
 * PM2 launches this automatically at midnight — see ecosystem.config.js.
 */


require('dotenv').config();

const fs      = require('fs');
const path    = require('path');
const https   = require('https');

const {
  TradingEngine,
  TRADING_CONFIG,
} = require('./trading-engine');
const { WalkForwardValidator } = require('./walk-forward');

// ── CLI args ────────────────────────────────────────────────────────────────
const args        = process.argv.slice(2);
const argMap      = {};
for (let i = 0; i < args.length; i += 2) {
  if (args[i].startsWith('--')) argMap[args[i].slice(2)] = args[i + 1];
}

const ASSET        = (argMap.asset   || 'EUR_USD').toUpperCase();   // OANDA format
const AV_SYMBOL    = ASSET.replace('_', '');                        // Alpha Vantage format
const START_CAPITAL = parseFloat(argMap.capital || 10000);
const LOG_DIR      = path.join(__dirname, 'trade_logs');

// ── Latency & Fill Simulation Config ─────────────────────────────────────────
// latencyBars / latencyEnabled are `let` — set by Claude AI before each run.
let latencyBars            = 1;
let latencyEnabled         = true;
const LATENCY_SLIP_PER_BAR = 0.0001;   // 1 pip adverse drift per latency bar
const SPREAD_HALF          = 0.0001;   // 1 pip base half-spread

// ── Additional Fill Realism ───────────────────────────────────────────────────
const VOLUME_IMPACT_FACTOR  = 0.15;    // market impact: 1bp per 0.67% of bar volume consumed
const VOL_SPREAD_MULT       = 100;     // spread doubles at ~1% bar ATR

// ── Claude AI Latency Brain ───────────────────────────────────────────────────

async function anthropicPostWithRetry(body, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await anthropicPost(body);
    } catch (e) {
      if (attempt === maxAttempts) throw e;
      const delay = 1000 * Math.pow(2, attempt - 1);
      console.warn('[NightlyBacktest] Anthropic API attempt ' + attempt + ' failed (' + e.message + '), retry in ' + delay + 'ms');
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function anthropicPost(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.anthropic.com',
      path:     '/v1/messages',
      method:   'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01',
        'Content-Length':    Buffer.byteLength(payload),
      },
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end',  ()    => resolve(raw));
    });
    req.on('error', reject);
    req.setTimeout(20_000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

function computeMarketStats(prices, volumes) {
  const n = prices.length;
  let sumAbsRet = 0, maxAbsRet = 0, trendingBars = 0;
  const window = 20;
  for (let i = 1; i < n; i++) {
    const absRet = Math.abs(prices[i] / prices[i - 1] - 1);
    sumAbsRet   += absRet;
    if (absRet > maxAbsRet) maxAbsRet = absRet;
    if (i >= window && Math.abs(prices[i] / prices[i - window] - 1) > 0.003) trendingBars++;
  }
  return {
    totalBars:        n,
    tradingDays:      Math.round(n / 288),
    avgVolatilityPct: parseFloat((sumAbsRet / n * 100).toFixed(4)),
    maxVolatilityPct: parseFloat((maxAbsRet * 100).toFixed(4)),
    trendingBarsPct:  parseFloat((trendingBars / Math.max(1, n - window) * 100).toFixed(1)),
    avgVolumeK:       Math.round(volumes.reduce((s, v) => s + v, 0) / n / 1000),
    overallDriftPct:  parseFloat(((prices[n - 1] / prices[0] - 1) * 100).toFixed(3)),
  };
}

async function askClaudeLatencyDecision(marketStats) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.log('  ℹ️  ANTHROPIC_API_KEY not set — using default latency (1 bar, enabled).');
    return { latencyEnabled: true, latencyBars: 1, reasoning: 'default (no API key)' };
  }
  const prompt = `You are a quantitative trading system assistant configuring backtest simulation realism.

Market statistics:
- Total bars: ${marketStats.totalBars} (~${marketStats.tradingDays} trading days of M5 candles)
- Average bar volatility: ${marketStats.avgVolatilityPct}%
- Peak bar volatility: ${marketStats.maxVolatilityPct}%
- Trending bars: ${marketStats.trendingBarsPct}%
- Avg volume: ${marketStats.avgVolumeK}K units
- Overall drift: ${marketStats.overallDriftPct}%

Apply these EXACT rules in order — do NOT use your own judgment:
RULE A: If avgVolatilityPct < 0.03 AND trendingBarsPct < 20  → latencyEnabled MUST be false, latencyBars = 1
RULE B: If avgVolatilityPct >= 0.03 AND avgVolatilityPct < 0.12 → latencyEnabled MUST be true, latencyBars = 1
RULE C: If avgVolatilityPct >= 0.12 AND avgVolatilityPct < 0.20 → latencyEnabled MUST be true, latencyBars = 2
RULE D: If avgVolatilityPct >= 0.20                              → latencyEnabled MUST be true, latencyBars = 3
RULE E: If trendingBarsPct > 35 and latencyBars would be 1       → upgrade latencyBars to 2

Respond ONLY with valid JSON, no other text:
{"latencyEnabled": true, "latencyBars": 1, "reasoning": "brief explanation"}`;

  try {
    const raw    = await anthropicPostWithRetry({ model: 'claude-sonnet-4-20250514', max_tokens: 128, messages: [{ role: 'user', content: prompt }] });
    const parsed = JSON.parse(raw);
    const clean  = (parsed.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);
    if (typeof result.latencyEnabled !== 'boolean') throw new Error('bad shape');
    return { latencyEnabled: result.latencyEnabled, latencyBars: Math.max(0, Math.min(3, Math.round(result.latencyBars))), reasoning: result.reasoning || '' };
  } catch (err) {
    console.warn(`  ⚠️  Claude latency decision failed (${err.message}) — using default.`);
    return { latencyEnabled: true, latencyBars: 1, reasoning: 'default (API error)' };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function httpsGet(hostname, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname, path: urlPath, headers }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end',  ()    => resolve(raw));
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

function dateTag() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function pad(s, n) { return String(s).padEnd(n); }
function fmt(v, d = 2) { return typeof v === 'number' ? v.toFixed(d) : String(v); }

// ── Data Fetchers ────────────────────────────────────────────────────────────

/**
 * Fetch last 24 h of M5 candles from OANDA.
 * Returns { prices: number[], volumes: number[] } or throws.
 */
async function fetchFromOanda(instrument) {
  const apiKey = process.env.OANDA_API_KEY;
  if (!apiKey || apiKey === 'your_oanda_api_key_here') throw new Error('OANDA_API_KEY not set');

  const host  = (process.env.OANDA_ENV || 'practice') === 'live'
              ? 'api-fxtrade.oanda.com'
              : 'api-fxpractice.oanda.com';

  // 24 h × 12 M5 bars/h = 288 bars.  Add 50 warm-up bars → 338 total.
  const urlPath = `/v3/instruments/${instrument}/candles`
                + `?granularity=M5&count=338&price=M`;

  console.log(`[NightlyBacktest] Fetching 338 M5 candles from OANDA (${host})…`);
  const raw  = await httpsGet(host, urlPath, { Authorization: `Bearer ${apiKey}` });
  const json = JSON.parse(raw);

  if (!json.candles || json.candles.length === 0) {
    throw new Error(`OANDA returned no candles: ${raw.slice(0, 200)}`);
  }

  const prices  = json.candles.map(c => parseFloat(c.mid.c));
  const volumes = json.candles.map(c => parseInt(c.volume)  || 1_000_000);

  console.log(`[NightlyBacktest] ✅ OANDA: ${prices.length} candles`
            + ` | ${json.candles[0].time.slice(0, 16)} → ${json.candles.at(-1).time.slice(0, 16)}`);
  return { prices, volumes, source: 'OANDA' };
}

/**
 * Fetch last 24 h of M5 candles from Alpha Vantage.
 * Returns { prices: number[], volumes: number[] } or throws.
 */
async function fetchFromAlphaVantage(symbol) {
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!apiKey || apiKey === 'your_alpha_vantage_key_here') {
    throw new Error('ALPHA_VANTAGE_API_KEY not set');
  }

  const from   = symbol.slice(0, 3);  // EUR
  const to     = symbol.slice(3);     // USD
  const urlPath = `/query?function=FX_INTRADAY`
                + `&from_symbol=${from}&to_symbol=${to}`
                + `&interval=5min&outputsize=compact`   // compact = last 100 bars
                + `&apikey=${apiKey}`;

  console.log(`[NightlyBacktest] Fetching M5 candles from Alpha Vantage for ${from}/${to}…`);
  const raw    = await httpsGet('www.alphavantage.co', urlPath);
  const json   = JSON.parse(raw);
  const series = json['Time Series FX (5min)'];

  if (!series) {
    const note = json['Note'] || json['Information'] || raw.slice(0, 200);
    throw new Error(`Alpha Vantage error: ${note}`);
  }

  // Returns newest-first — reverse for chronological order
  const entries = Object.entries(series).reverse();
  const prices  = entries.map(([, c]) => parseFloat(c['4. close']));
  const volumes = entries.map(([, c]) => parseInt(c['5. volume'] || 1_000_000));

  console.log(`[NightlyBacktest] ✅ Alpha Vantage: ${prices.length} candles`);
  return { prices, volumes, source: 'AlphaVantage' };
}

/**
 * Try OANDA first, fall back to Alpha Vantage.
 * If both fail, throw a clear error (no synthetic fallback for nightly — we
 * want real data or an explicit failure alert).
 */
async function fetchCandles() {
  const errors = [];

  try {
    return await fetchFromOanda(ASSET);
  } catch (e) {
    errors.push(`OANDA: ${e.message}`);
    console.warn(`[NightlyBacktest] ⚠️  OANDA failed — trying Alpha Vantage…`);
  }

  try {
    return await fetchFromAlphaVantage(AV_SYMBOL);
  } catch (e) {
    errors.push(`AlphaVantage: ${e.message}`);
  }

  throw new Error(
    `[NightlyBacktest] ❌ All data sources failed:\n  • ${errors.join('\n  • ')}\n` +
    `  Set OANDA_API_KEY or ALPHA_VANTAGE_API_KEY in your .env file.`
  );
}

// ── Backtest Runner ──────────────────────────────────────────────────────────
//
//  Latency model (matches backtest-compare.js for consistency):
//  ─────────────────────────────────────────────────────────────
//  Signal fires at bar i → order queued → fills at bar i + LATENCY_BARS.
//  Fill price = market price at fill bar ± (SLIPPAGE + LATENCY_SLIP_PER_BAR
//               × LATENCY_BARS + SPREAD_HALF).
//
//  SL / TP hits (managed by engine.checkRiskManagement) are treated as
//  resting stop orders already at the broker — they execute immediately
//  at bar price with no extra latency, only the half-spread crossing cost.

async function runBacktest({ prices, volumes }) {
  const engine = new TradingEngine();

  // Fresh state — ignore any persisted live trades
  engine.trades                = [];
  engine.wins                  = 0;
  engine.losses                = 0;
  engine.capital               = START_CAPITAL;
  engine.initialCapital        = START_CAPITAL;
  engine.dailyStartCapital     = START_CAPITAL;
  engine.priceHistory          = [];
  engine.volumeHistory         = [];
  engine.circuitBreakerTripped = false;
  engine.position              = null;

  // ── Reset all halt flags — backtest must never inherit live-run lockouts ──
  // The constructor calls _loadDailyLockout() which reads from disk.
  // If the live bot hit its daily loss limit, the nightly backtest would
  // inherit that stale timestamp and silently block all trades (#9 fix).
  engine.dailyLockoutUntil   = 0;
  engine.consecutiveHaltUntil = 0;
  engine.consecutiveLosses    = 0;
  engine.flashCrashHaltUntil  = 0;
  engine.globalHaltTripped    = false;
  engine._clearDailyLockout();   // remove lockout file so it cannot be re-read

  // The first 50 bars are warm-up — not traded, just to seed indicators
  const WARMUP_BARS = 50;

  const equity    = [];
  let   peak      = START_CAPITAL;
  let   maxDrawdown = 0;

  // ── Latency queue ──────────────────────────────────────────────────────────
  // Holds at most one pending order: { type, fillBar, signalBar, indicators }
  let pendingOrder             = null;
  let totalLatencySlipCost     = 0;
  let latencyFills             = 0;

  // Total extra slippage added per fill from latency + spread
  const fillSlipFraction = LATENCY_SLIP_PER_BAR * latencyBars + SPREAD_HALF;

  // Compute volatility-adaptive half-spread (widens during high-ATR bars)
  function adaptiveHalfSpread(atr, price) {
    const atrPct = (atr > 0 && price > 0) ? atr / price : 0;
    return SPREAD_HALF * (1 + atrPct * VOL_SPREAD_MULT);
  }

  // Volume market impact: large orders vs bar volume depth
  function volumeImpact(shares, barVol) {
    if (!barVol || barVol <= 0) return 0;
    return Math.min(0.002, (shares / barVol) * VOLUME_IMPACT_FACTOR);
  }

  for (let i = 0; i < prices.length; i++) {
    engine.priceHistory.push(prices[i]);
    engine.volumeHistory.push(volumes[i]);

    // Keep within memory limits
    if (engine.priceHistory.length > TRADING_CONFIG.maxHistoryLength * 2) {
      engine.priceHistory  = engine.priceHistory.slice(-TRADING_CONFIG.maxHistoryLength);
      engine.volumeHistory = engine.volumeHistory.slice(-TRADING_CONFIG.maxHistoryLength);
    }

    if (i < WARMUP_BARS) { equity.push(engine.capital); continue; }

    // ── 1. Execute pending latency-delayed order ───────────────────────────
    if (pendingOrder && i >= pendingOrder.fillBar) {
      const p = prices[i];
      const bv = volumes[i] || 1;

      if (pendingOrder.type === 'ENTRY' && !engine.position) {
        const atr      = pendingOrder.indicators?.atr || p * 0.001;
        const hs       = adaptiveHalfSpread(atr, p);
        const estShares = engine.capital * 0.08 / p;
        const volImp   = volumeImpact(estShares, bv);
        const origSlip = TRADING_CONFIG.slippage;
        const bars     = latencyEnabled ? latencyBars : 0;
        TRADING_CONFIG.slippage = origSlip + LATENCY_SLIP_PER_BAR * bars + hs + volImp;
        try {
          engine.enterPosition(p, pendingOrder.confidence || 70);
          if (engine.position) {
            const extraCost = p * (TRADING_CONFIG.slippage - origSlip) * engine.position.shares;
            totalLatencySlipCost += extraCost;
            engine.position.latencyBars     = i - pendingOrder.signalBar;
            engine.position.latencySlipCost = extraCost;
          }
        } finally {
          TRADING_CONFIG.slippage = origSlip;
        }
        latencyFills++;

      } else if (pendingOrder.type === 'EXIT' && engine.position) {
        const atr    = engine.position.entry * 0.001;
        const hs     = adaptiveHalfSpread(atr, p);
        const volImp = volumeImpact(engine.position.shares, bv);
        const origSlip = TRADING_CONFIG.slippage;
        const bars   = latencyEnabled ? latencyBars : 0;
        TRADING_CONFIG.slippage = origSlip + LATENCY_SLIP_PER_BAR * bars + hs + volImp;
        const extraCost = p * (TRADING_CONFIG.slippage - origSlip) * engine.position.shares;
        totalLatencySlipCost += extraCost;
        latencyFills++;
        try {
          engine.exitPosition(p, pendingOrder.reason || 'Signal Exit');
        } finally {
          TRADING_CONFIG.slippage = origSlip;
        }
      }

      pendingOrder = null;
    }

    // ── 2. Risk management — stops run at broker (no latency) ─────────────
    engine.checkRiskManagement();
    if (engine.circuitBreakerTripped) { equity.push(engine.capital); continue; }

    // ── 3. Generate signal for this bar ───────────────────────────────────
    const indicators = await engine.calculateIndicators();
    if (!indicators) { equity.push(engine.capital); continue; }

    const decision = engine.getRuleBasedDecision(indicators);

    // ── 4. Queue the decision — do NOT execute immediately ────────────────
    if (!pendingOrder) {
      if (decision.action === 'BUY' && !engine.position) {
        pendingOrder = {
          type:       'ENTRY',
          fillBar:    i + (latencyEnabled ? latencyBars : 1),
          signalBar:  i,
          indicators,
          confidence: decision.confidence,  // BUG-48 fix: store real confidence for enterPosition
        };
      } else if (decision.action === 'SELL' && engine.position) {
        pendingOrder = {
          type:   'EXIT',
          fillBar: i + (latencyEnabled ? latencyBars : 1), // OFF=1-bar natural delay
          signalBar: i,
          reason: 'Signal Exit',
        };
      }
      // HOLD → nothing queued
    }

    // ── 5. Equity curve & drawdown ────────────────────────────────────────
    const totalValue = engine.capital +
      (engine.position ? engine.position.shares * prices[i] : 0);
    if (totalValue > peak) peak = totalValue;
    const dd = (peak - totalValue) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
    equity.push(totalValue);
  }

  // Force-close any open position at last price (admin close — no latency)
  if (engine.position) {
    engine.exitPosition(prices[prices.length - 1], 'EndOfNightlyBacktest');
  }

  return {
    engine, equity, maxDrawdown,
    latencyStats: {
      latencyEnabled,
      latencyBars:          latencyEnabled ? latencyBars : 0,
      latencySlipPerBar:    LATENCY_SLIP_PER_BAR,
      spreadHalf:           SPREAD_HALF,
      volumeImpactFactor:   VOLUME_IMPACT_FACTOR,
      volSpreadMult:        VOL_SPREAD_MULT,
      latencyFills,
      totalLatencySlipCost: parseFloat(totalLatencySlipCost.toFixed(4)),
      avgLatencySlipPerFill: latencyFills > 0
        ? parseFloat((totalLatencySlipCost / latencyFills).toFixed(4))
        : 0,
    },
  };
}

// ── Metrics ──────────────────────────────────────────────────────────────────

let _cachedRM = null;
function calculateMetrics(engine, maxDrawdown, latencyStats) {
  const trades = engine.trades;
  const wins   = trades.filter(t => t.profit > 0);
  const losses = trades.filter(t => t.profit <= 0);

  const grossProfit  = wins.reduce((s, t)   => s + t.profit, 0);
  const grossLoss    = Math.abs(losses.reduce((s, t) => s + t.profit, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss
                     : grossProfit > 0 ? Infinity : 0;

  const winRate    = trades.length > 0 ? (wins.length   / trades.length) * 100 : 0;
  const avgWin     = wins.length   > 0 ? grossProfit / wins.length   : 0;
  const avgLoss    = losses.length > 0 ? grossLoss   / losses.length : 0;
  const expectancy = (avgWin * (winRate / 100)) - (avgLoss * (1 - winRate / 100));
  const totalReturn = ((engine.capital - START_CAPITAL) / START_CAPITAL) * 100;

  // Readiness verdict thresholds (relaxed for a 24 h window — fewer trades)
  const checks = [
    { name: 'Profitable (return > 0%)',         pass: totalReturn  >  0,   value: `${fmt(totalReturn)}%`       },
    { name: 'Profit Factor > 1.0',              pass: profitFactor >  1.0, value: fmt(profitFactor, 3)         },
    { name: 'Expectancy > $0 per trade',        pass: expectancy   >  0,   value: `$${fmt(expectancy)}`        },
    { name: 'Max Drawdown < 10%',               pass: maxDrawdown * 100 < 10, value: `${fmt(maxDrawdown * 100)}%` },
    { name: 'At least 1 trade executed',        pass: trades.length >= 1,  value: trades.length                },
    { name: 'Win Rate > 30%',                   pass: winRate      > 30,   value: `${fmt(winRate)}%`           },
    { name: 'Sharpe Ratio > 0',                 pass: (_cachedRM?.sharpe||0) > 0, value: fmt(_cachedRM?.sharpe||0,3) },
  ];

  const passed     = checks.filter(c => c.pass).length;
  const allPassed  = passed === checks.length;
  const mostPassed = passed >= Math.floor(checks.length * 0.67); // floor(6×0.67)=4 → 4/6 passes = MARGINAL

  const verdict = allPassed   ? 'READY'    :
                  mostPassed  ? 'MARGINAL' : 'NOT_READY';

  return {
    asset:        ASSET,
    date:         dateTag(),
    runAt:        new Date().toISOString(),
    source:       '',          // filled in by caller
    startCapital: START_CAPITAL,
    finalCapital: engine.capital,
    totalReturn,
    totalTrades:  trades.length,
    wins:         wins.length,
    losses:       losses.length,
    winRate,
    grossProfit,
    grossLoss,
    profitFactor,
    expectancy,
    avgWin,
    avgLoss,
    maxDrawdown:  maxDrawdown * 100,
    checks,
    passed,
    total:        checks.length,
    verdict,
    latencyStats,           // raw latency data
    latencyP50: latencyStats?.p50 || 0,   // store key percentiles in JSON for comparison
    latencyP99: latencyStats?.p99 || 0,

    // ── VaR / ES / Sharpe / Sortino ─────────────────────────────────────
    ...(() => {
      const rm = RiskMetrics.calculate(trades, { confidence: [0.95, 0.99], capitalBase: START_CAPITAL });
      _cachedRM = rm;  // cache for checks array below
      return rm;
    })(),
  };
}

// ── Report Printer ───────────────────────────────────────────────────────────

function printReport(m) {
  const LINE = '═'.repeat(62);
  const line = '─'.repeat(62);

  console.log(`\n${LINE}`);
  console.log(`  🌙 NIGHTLY BACKTEST REPORT — ${m.date}`);
  console.log(`  Asset: ${m.asset}  |  Data: ${m.source}  |  Capital: $${START_CAPITAL.toLocaleString()}`);
  console.log(`${LINE}\n`);

  console.log(`  📊 PERFORMANCE (last 24 h)`);
  console.log(`  ${line}`);
  console.log(`  ${pad('Final Capital',     26)}  $${fmt(m.finalCapital)}`);
  console.log(`  ${pad('Total Return',      26)}  ${fmt(m.totalReturn)}%`);
  console.log(`  ${pad('Gross Profit',      26)}  $${fmt(m.grossProfit)}`);
  console.log(`  ${pad('Gross Loss',        26)}  $${fmt(m.grossLoss)}`);
  console.log(`  ${pad('Profit Factor',     26)}  ${fmt(m.profitFactor, 3)}`);
  console.log(`  ${pad('Expectancy/trade',  26)}  $${fmt(m.expectancy)}`);

  console.log(`\n  📈 TRADE STATS`);
  console.log(`  ${line}`);
  console.log(`  ${pad('Total Trades',      26)}  ${m.totalTrades}`);
  console.log(`  ${pad('Wins',              26)}  ${m.wins}`);
  console.log(`  ${pad('Losses',            26)}  ${m.losses}`);
  console.log(`  ${pad('Win Rate',          26)}  ${fmt(m.winRate)}%`);
  console.log(`  ${pad('Avg Win',           26)}  $${fmt(m.avgWin)}`);
  console.log(`  ${pad('Avg Loss',          26)}  $${fmt(m.avgLoss)}`);

  console.log(`\n  ⚠️  RISK`);
  console.log(`  ${line}`);
  console.log(`  ${pad('Max Drawdown',      26)}  ${fmt(m.maxDrawdown)}%`);
  if (m.sharpe    != null) console.log(`  ${pad('Sharpe Ratio',    26)}  ${fmt(m.sharpe,3)} (annualised: ${fmt(m.sharpeAnnualised,3)})`);
  if (m.sortino   != null) console.log(`  ${pad('Sortino Ratio',   26)}  ${fmt(m.sortino,3)} [${m.sortinoLabel}]`);
  if (m.var95     != null) console.log(`  ${pad('VaR 95%',         26)}  ${fmt(m.var95)}% ($${fmt(m['var95$'])})`);
  if (m.es95      != null) console.log(`  ${pad('Expected Shortfall 95%', 26)}  ${fmt(m.es95)}% ($${fmt(m['es95$'])})`);
  if (m.riskProfile)       console.log(`  ${pad('Risk Profile',    26)}  ${m.riskProfile}`);

  // ── Latency & Fill Quality ──────────────────────────────────────────────
  if (m.latencyStats) {
    const ls = m.latencyStats;
    const latStatus = ls.latencyEnabled ? `ON — ${ls.latencyBars} bar(s) (~${ls.latencyBars * 5} min on M5)` : 'OFF (Claude AI: quiet market)';
    console.log(`\n  ⏱  LATENCY & FILL QUALITY`);
    console.log(`  ${line}`);
    console.log(`  ${pad('Latency simulation',  26)}  ${latStatus}`);
    console.log(`  ${pad('Latency slip/bar',    26)}  ${(ls.latencySlipPerBar * 10000).toFixed(1)} bps`);
    console.log(`  ${pad('Spread model',        26)}  ${(ls.spreadHalf * 10000).toFixed(1)} bps base × vol-adaptive`);
    console.log(`  ${pad('Volume market impact',26)}  enabled (${(ls.volumeImpactFactor * 100).toFixed(0)} bps per % bar vol)`);
    console.log(`  ${pad('Latency fills',       26)}  ${ls.latencyFills}`);
    console.log(`  ${pad('Total slip cost',     26)}  $${ls.totalLatencySlipCost.toFixed(4)}`);
    console.log(`  ${pad('Avg slip/fill',       26)}  $${ls.avgLatencySlipPerFill.toFixed(4)}`);
    console.log(`  ${pad('SL/TP fills',         26)}  instant (resting orders)`);
    console.log(`  ${pad('Decided by',          26)}  Claude AI (market volatility analysis)`);
  }

  console.log(`\n  ✅ READINESS CHECKS (${m.passed}/${m.total} passed)`);
  console.log(`  ${line}`);
  for (const c of m.checks) {
    const icon = c.pass ? '✅' : '❌';
    console.log(`  ${icon}  ${pad(c.name, 40)}  ${c.value}`);
  }

  const verdictLine =
    m.verdict === 'READY'     ? '  🎉 VERDICT: STRATEGY PERFORMING WELL — continue live trading' :
    m.verdict === 'MARGINAL'  ? '  ⚠️  VERDICT: MARGINAL — monitor closely today'                 :
                                '  🛑 VERDICT: UNDERPERFORMING — review strategy before next session';

  console.log(`\n${LINE}`);
  console.log(verdictLine);
  console.log(`${LINE}\n`);
}

// ── Report Saver ─────────────────────────────────────────────────────────────

function saveReport(metrics) {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

  // JSON report (machine-readable, for dashboards / trend analysis)
  const jsonFile = path.join(LOG_DIR, `nightly-${metrics.date}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify(metrics, null, 2));
  console.log(`[NightlyBacktest] 📁 JSON report saved → ${jsonFile}`);

  // Append one-line summary to a rolling CSV for easy trend tracking
  const csvFile  = path.join(LOG_DIR, 'nightly-summary.csv');
  const header   = 'date,asset,source,trades,winRate,profitFactor,totalReturn,maxDrawdown,verdict\n';
  const row      = [
    metrics.date, metrics.asset, metrics.source,
    metrics.totalTrades,
    metrics.winRate.toFixed(2),
    metrics.profitFactor.toFixed(3),
    metrics.totalReturn.toFixed(2),
    metrics.maxDrawdown.toFixed(2),
    metrics.verdict,
  ].join(',') + '\n';

  if (!fs.existsSync(csvFile)) fs.writeFileSync(csvFile, header);
  fs.appendFileSync(csvFile, row);
  console.log(`[NightlyBacktest] 📊 CSV summary updated → ${csvFile}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  🌙 ALADDIN NIGHTLY AUTO-BACKTEST');
  console.log(`  ${new Date().toUTCString()}`);
  console.log('════════════════════════════════════════════════════════════\n');

  // 1. Fetch real candles
  const { prices, volumes, source } = await fetchCandles();

  // 1b. Ask Claude AI to decide latency configuration based on today's market
  const mStats = computeMarketStats(prices, volumes);
  console.log(`[NightlyBacktest] Market: avgVol=${mStats.avgVolatilityPct}% | trending=${mStats.trendingBarsPct}% | bars=${mStats.totalBars}`);
  console.log('[NightlyBacktest] 🧠 Asking Claude AI to configure latency simulation …');
  const latencyDecision = await askClaudeLatencyDecision(mStats);
  latencyEnabled = latencyDecision.latencyEnabled;
  latencyBars    = latencyDecision.latencyBars;
  console.log(`[NightlyBacktest] 🧠 Claude AI: latency ${latencyEnabled ? `ON — ${latencyBars} bar(s) (~${latencyBars * 5} min)` : 'OFF — quiet market'}`);
  console.log(`[NightlyBacktest]    Reasoning: ${latencyDecision.reasoning}`);

  // 2. Run the backtest through the live engine
  console.log(`[NightlyBacktest] Running ${prices.length} candles through TradingEngine…`);
  console.time('[NightlyBacktest] Duration');
  const { engine, equity, maxDrawdown, latencyStats } = await runBacktest({ prices, volumes });
  console.timeEnd('[NightlyBacktest] Duration');

  // 3. Calculate metrics & attach data source
  const metrics  = calculateMetrics(engine, maxDrawdown, latencyStats);
  metrics.source = source;

  // 4. Run walk-forward validation on the same price data
  //    Nightly data is ~288 bars (24h M5). Use compact windows for small datasets.
  const wfRunner = new WalkForwardValidator();
  const backtestFn = async (p, v, cap) => {
    const { engine: wfEng, maxDrawdown: wfDD } = await runBacktest({ prices: p, volumes: v });
    return { trades: wfEng.trades, capital: wfEng.capital, equity: [], maxDD: wfDD };
  };

  let walkForwardResult = null;
  if (prices.length >= 150) {
    try {
      // Reset ML before walk-forward to prevent data leakage between folds
      if (engine?.mlConfidence) { engine.mlConfidence.trained = false; if (Array.isArray(engine.mlConfidence._buffer)) engine.mlConfidence._buffer = []; }
      walkForwardResult = wfRunner.runExpanding(prices, volumes, backtestFn, {
        initialISPct: 0.40,
        stepPct:      0.15,
        embargoBars:  10,   // smaller embargo for short nightly window
      });
      metrics.walkForward = {
        mode:           walkForwardResult.mode,
        totalFolds:     walkForwardResult.totalFolds,
        stabilityScore: walkForwardResult.stabilityScore,
        overfit:        walkForwardResult.overfit,
        avgEfficiency:  walkForwardResult.avgEfficiency,
        agg:            walkForwardResult.agg,
      };
    } catch (wfErr) {
      console.warn('[NightlyBacktest] Walk-forward skipped:', wfErr.message);
    }
  }

  // 5. Print to console (visible in PM2 logs)
  printReport(metrics);
  if (walkForwardResult && walkForwardResult.folds.length > 0) {
    wfRunner.printReport(walkForwardResult);
  }

  // 6. Save JSON + CSV to trade_logs/
  saveReport(metrics);

  // 7. Exit code: 0 = pass/marginal, 1 = not ready (lets PM2 flag it as error)
  process.exit(metrics.verdict === 'NOT_READY' ? 1 : 0);
}


// ── Period-sliced backtest (#18 fix: was defined but never called) ────────────
async function runPeriodSlicedBacktest(candles) {
  try {
    const { PeriodSlicer, SurvivorshipFilter } = require('./period-slicer');
    const slicer = new PeriodSlicer({ minSliceBars: 50 });
    const slices = slicer.slice(candles);
    return slices.map(s => ({ regime: s.regime, bars: s.bars, summary: s.summary }));
  } catch(e) { return []; }
}

async function runAndAppendPeriodSlices(report, candles) {
  try {
    const slices = await runPeriodSlicedBacktest(candles);
    report.periodSlices = slices;
    if (slices.length > 0) {
      console.log('[NightlyBacktest] Period-sliced results:');
      slices.forEach(s => console.log('  ' + s.regime.padEnd(10) + s.bars + ' bars'));
    }
  } catch(e) { console.warn('[NightlyBacktest] Period-slice failed:', e.message); }
  return report;
}

// Only auto-run when called directly, not when required by test suite (#18)
if (require.main === module) {
  main().catch(err => {
    console.error('\n[NightlyBacktest] ❌ Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
}

module.exports = { runPeriodSlicedBacktest, runAndAppendPeriodSlices };
