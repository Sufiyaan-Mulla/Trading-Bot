'use strict';
// #28: Replaced inline signal logic with SharedSignalAdapter to prevent divergence from live code
const { SharedSignalAdapter } = require('./shared-signal-adapter');

// #28: Use SharedSignalAdapter for signal generation (prevents divergence from trendStrategy.js)
const _sharedAdapter = new SharedSignalAdapter('trend');
// ═══════════════════════════════════════════════════════════════════════════════
//  backtest-compare.js
//  Head-to-head backtest: OLD strategy vs NEW strategy
//
//  OLD  — EMA9/21 crossover + RSI + MACD vote count (current bot)
//  NEW  — EMA50/200 trend gate + ATR volatility filter +
//          market regime detection (ADX-proxy) + volume/liquidity filter
//
//  Run: node backtest-compare.js
// #28: Use SharedSignalAdapter for signal generation (prevents divergence from trendStrategy.js)

// ═══════════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const https = require('https');

const { Indicators } = require('./indicators');
const { WalkForwardValidator } = require('./walk-forward');

// ── Config ────────────────────────────────────────────────────────────────────
const CAPITAL         = 10_000;
const COMMISSION      = 0.0002;   // 0.02% per side (tight forex spread)
const SLIPPAGE        = 0.0003;
const MIN_CONFIDENCE  = 60;
const SL_ATR_MULT     = 1.5;
const TP_ATR_MULT     = 4.0;
const WARMUP_BARS     = 210;      // need 200+ bars for EMA200

// ── Latency & Realistic Fill Config ──────────────────────────────────────────
// latencyBars is a `let` — Claude AI sets it before each backtest run.
// LATENCY_SLIP_PER_BAR and SPREAD_HALF remain fixed baselines.
let latencyBars            = 1;       // set dynamically by askClaudeLatencyDecision()
let latencyEnabled         = true;    // set dynamically by askClaudeLatencyDecision()
const LATENCY_SLIP_PER_BAR = 0.0001;  // 1 pip adverse drift while order is in-flight
const SPREAD_HALF          = 0.0001;  // 1 pip half-spread (tight forex, bid/ask cross)

// ── Additional Fill Realism ───────────────────────────────────────────────────
// VOLUME_IMPACT_FACTOR — scales how much a large order relative to bar volume
//   worsens the fill price (market impact / order-book depth simulation).
//   Formula: extraSlip = min(20bps, shares/barVolume × VOLUME_IMPACT_FACTOR)
const VOLUME_IMPACT_FACTOR  = 0.15;   // 0.15 = 1bp per 0.67% of bar volume consumed

// VOL_SPREAD_MULT — multiplier that widens SPREAD_HALF during high-ATR bars.
//   adaptiveHalfSpread = SPREAD_HALF × (1 + atrPct × VOL_SPREAD_MULT)
//   E.g. atrPct=0.15% → spread widens 1.5× when VOL_SPREAD_MULT=100
const VOL_SPREAD_MULT       = 100;    // spread doubles at ~1% bar ATR

// ── Claude AI Latency Brain ───────────────────────────────────────────────────

// Low-level HTTPS POST to Anthropic API using Node's built-in https module.
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
    req.setTimeout(20_000, () => { req.destroy(); reject(new Error('Anthropic API timeout')); });
    req.write(payload);
    req.end();
  });
}

// Derives a concise summary of market conditions from raw price/volume arrays.
function computeMarketStats(prices, volumes) {
  const n = prices.length;
  let sumAbsRet = 0, maxAbsRet = 0, trendingBars = 0;
  const window = 20;

  for (let i = 1; i < n; i++) {
    const absRet = Math.abs(prices[i] / prices[i - 1] - 1);
    sumAbsRet   += absRet;
    if (absRet > maxAbsRet) maxAbsRet = absRet;
    if (i >= window) {
      const momentum = Math.abs(prices[i] / prices[i - window] - 1);
      if (momentum > 0.003) trendingBars++;  // >0.3% over 20 bars = trending
    }
  }

  const avgVol    = sumAbsRet / n;
  const trendPct  = trendingBars / Math.max(1, n - window) * 100;
  const avgVolume = volumes.reduce((s, v) => s + v, 0) / n;

  return {
    totalBars:     n,
    tradingDays:   Math.round(n / 288),   // M5: 288 bars per day
    avgVolatilityPct: parseFloat((avgVol   * 100).toFixed(4)),
    maxVolatilityPct: parseFloat((maxAbsRet * 100).toFixed(4)),
    trendingBarsPct:  parseFloat(trendPct.toFixed(1)),
    avgVolumeK:       Math.round(avgVolume / 1000),
    priceStart:       parseFloat(prices[0].toFixed(5)),
    priceEnd:         parseFloat(prices[n - 1].toFixed(5)),
    overallDriftPct:  parseFloat(((prices[n - 1] / prices[0] - 1) * 100).toFixed(3)),
  };
}

// Asks Claude to decide whether latency simulation should be ON and how many bars.
// Falls back to defaults silently if ANTHROPIC_API_KEY is missing or call fails.
async function askClaudeLatencyDecision(marketStats) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    console.log('  ℹ️  ANTHROPIC_API_KEY not set — using default latency config (1 bar, enabled).');
    return { latencyEnabled: true, latencyBars: 1, reasoning: 'default (no API key)' };
  }

  const prompt = `You are a quantitative trading system assistant. Your job is to configure backtest simulation realism based on market conditions.

Market statistics from the price series being backtested:
- Total bars: ${marketStats.totalBars} (~${marketStats.tradingDays} trading days of M5 candles)
- Average bar volatility: ${marketStats.avgVolatilityPct}% per bar
- Peak bar volatility: ${marketStats.maxVolatilityPct}% per bar
- Trending bars (>0.3% momentum over 20 bars): ${marketStats.trendingBarsPct}%
- Average bar volume: ${marketStats.avgVolumeK}K units
- Overall price drift: ${marketStats.overallDriftPct}%

Decision rules — apply these EXACTLY, in order. Do NOT override them with your own judgment:
RULE A: If avgVolatilityPct < 0.03 AND trendingBarsPct < 20  → latencyEnabled MUST be false, latencyBars = 1
RULE B: If avgVolatilityPct >= 0.03 AND avgVolatilityPct < 0.12 → latencyEnabled MUST be true, latencyBars = 1
RULE C: If avgVolatilityPct >= 0.12 AND avgVolatilityPct < 0.20 → latencyEnabled MUST be true, latencyBars = 2
RULE D: If avgVolatilityPct >= 0.20                              → latencyEnabled MUST be true, latencyBars = 3
RULE E: If trendingBarsPct > 35 and latencyBars would be 1       → upgrade latencyBars to 2

Apply the first matching rule. These rules are mandatory — do not deviate from them.

Respond ONLY with a valid JSON object. No explanation text outside the JSON. No markdown fences.
{"latencyEnabled": true, "latencyBars": 1, "reasoning": "one sentence explanation"}`;

  try {
    const raw = await anthropicPost({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 128,
      messages:   [{ role: 'user', content: prompt }],
    });

    const parsed = JSON.parse(raw);
    const text   = parsed.content?.[0]?.text?.trim() || '';
    // Strip any accidental markdown fences
    const clean  = text.replace(/```json|```/g, '').trim();
    const result = JSON.parse(clean);

    if (typeof result.latencyEnabled !== 'boolean' || typeof result.latencyBars !== 'number') {
      throw new Error('Unexpected response shape');
    }
    return {
      latencyEnabled: result.latencyEnabled,
      latencyBars:    Math.max(0, Math.min(3, Math.round(result.latencyBars))),
      reasoning:      result.reasoning || '',
    };
  } catch (err) {
    console.warn(`  ⚠️  Claude latency decision failed (${err.message}) — using default.`);
    return { latencyEnabled: true, latencyBars: 1, reasoning: 'default (API error)' };
  }
}

// ── Synthetic price generator ─────────────────────────────────────────────────
// Produces a realistic mixed market: trending phases + ranging phases
// with volatility clustering and volume correlated with moves
function generateMarket (n = 2500, seed = 12345) {
  let s = seed;
  const rng = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xFFFFFFFF;
  };
  const randn = () => {
    // Box-Muller
    return Math.sqrt(-2 * Math.log(rng() + 1e-10)) * Math.cos(2 * Math.PI * rng());
  };

  const prices  = [1.1000];
  const volumes = [1_200_000];

  let drift     = 0.00005;   // current bar drift
  let vol       = 0.0010;    // current bar volatility (GARCH-like)
  let phaseBar  = 0;
  let phaseDuration = 120 + Math.floor(rng() * 200);
  let inTrend   = true;

  for (let i = 1; i < n; i++) {
    phaseBar++;

    // Switch market regime
    if (phaseBar >= phaseDuration) {
      phaseBar = 0;
      phaseDuration = 80 + Math.floor(rng() * 250);
      inTrend = !inTrend;
      drift   = inTrend ? (rng() > 0.5 ? 0.00015 : -0.00015) : 0;
    }

    // GARCH-style volatility clustering
    vol = 0.92 * vol + 0.08 * (0.0005 + Math.abs(randn()) * 0.0008);
    vol = Math.max(0.0003, Math.min(0.003, vol));

    const ret   = drift + randn() * vol;
    const price = Math.max(0.6, prices[i - 1] * (1 + ret));
    prices.push(price);

    // Volume: higher during big moves and trend starts
    const volMult = 1 + Math.abs(ret) * 300 + (phaseBar < 5 ? 0.5 : 0);
    volumes.push(Math.max(200_000, (800_000 + rng() * 600_000) * volMult));
  }

  return { prices, volumes };
}

// ── Indicator calculations ────────────────────────────────────────────────────
function computeIndicators (ph, vh) {
  const n = ph.length;
  if (n < WARMUP_BARS) return null;

  const rsi   = Indicators.rsi(ph);
  const macd  = Indicators.macd(ph);
  const ema9  = Indicators.ema(ph, 9);
  const ema21 = Indicators.ema(ph, 21);
  const ema50 = Indicators.ema(ph, 50);
  const ema200= Indicators.ema(ph, 200);
  const bb    = Indicators.bollingerBands(ph);
  const atr   = Indicators.atr(ph, 14);
  const vwap  = Indicators.vwap(ph, vh);

  const price   = ph[n - 1];
  const atrPct  = atr > 0 ? (atr / price) * 100 : 0;

  // ── Market regime (ADX-proxy via EMA50/200 divergence) ──────────────────
  // Spread as % of price: > 0.5% = strongly trending, < 0.15% = ranging
  const emaDivergence = Math.abs(ema50 - ema200) / price * 100;
  const regime =
    emaDivergence > 0.50 ? 'TRENDING' :
    emaDivergence > 0.20 ? 'WEAK_TREND' : 'RANGING';

  // ── Trend direction from EMA50/200 ──────────────────────────────────────
  const goldenCross = ema50 > ema200;   // bull regime
  const deathCross  = ema50 < ema200;   // bear regime
  const ema50Slope  = n > 55
    ? (ema50 - Indicators.ema(ph.slice(0, n - 5), 50)) / price * 1000
    : 0;

  // ── Volume filter ────────────────────────────────────────────────────────
  const volWindow    = vh.slice(-20);
  const avgVolume    = volWindow.reduce((s, v) => s + v, 0) / volWindow.length;
  const volRatio     = vh[n - 1] / (avgVolume || 1);
  const liquidMarket = volRatio >= 0.75;  // at least 75% of average volume

  // ── Old signal (vote count) ──────────────────────────────────────────────
  // Bug fix #17: use SharedSignalAdapter (live code) not inline signal logic
  const _adapterDecision = _sharedAdapter.decide(ph.slice(0, n), { close: price, high: price, low: price, volume: vh.at(-1) || 1000 }, {});
  const oldSignal = _adapterDecision.action === 'BUY' ? 'STRONG_BUY' : _adapterDecision.action === 'SELL' ? 'STRONG_SELL' : Indicators.signal({ rsi, macd, ema9, ema21, bb });

  return {
    price, rsi, macd, ema9, ema21, ema50, ema200,
    bb, atr, vwap,
    atrPct, regime, goldenCross, deathCross, ema50Slope,
    volRatio, liquidMarket, avgVolume,
    oldSignal,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  OLD STRATEGY  — current bot logic (EMA9/21 + RSI + MACD vote count)
// ─────────────────────────────────────────────────────────────────────────────
function oldDecision (ind) {
  if (!ind) return { action: 'HOLD', confidence: 0, reason: 'insufficient data' };

  const { rsi, ema9, ema21, oldSignal: signal, atrPct } = ind;
  const e9  = ema9;
  const e21 = ema21;

  let action = 'HOLD', confidence = 50, reason = 'neutral';

  const trendUp    = e9 > e21;
  const strongTrend= trendUp && ((e9 - e21) / e21) > 0.0005;

  if (signal === 'STRONG_BUY' && rsi < 45 && strongTrend) {
    action = 'BUY'; confidence = 82;
    reason = 'Setup A: STRONG_BUY + RSI<45 + strong EMA9/21 trend';
  } else if (signal === 'BUY' && rsi < 50 && strongTrend) {
    action = 'BUY'; confidence = 70;
    reason = 'Setup B: BUY + RSI<50 + EMA9/21 trend';
  } else if (signal === 'STRONG_BUY' && rsi < 50 && trendUp) {
    action = 'BUY'; confidence = 68;
    reason = 'Setup C: STRONG_BUY + RSI<50';
  } else if (e9 < e21 && signal === 'STRONG_SELL') {
    action = 'SELL'; confidence = 80;
    reason = 'EMA9 cross below EMA21 + STRONG_SELL';
  }

  return { action, confidence, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
//  NEW STRATEGY  — EMA50/200 + ATR gate + regime detection + volume filter
// ─────────────────────────────────────────────────────────────────────────────
function newDecision (ind) {
  if (!ind) return { action: 'HOLD', confidence: 0, reason: 'insufficient data' };

  const {
    rsi, macd, ema9, ema21, ema50, ema200,
    atr, atrPct, regime, goldenCross, deathCross, ema50Slope,
    volRatio, liquidMarket, oldSignal: signal, price, vwap,
  } = ind;

  let action = 'HOLD', confidence = 50, reason = 'neutral';
  const blocks = [];

  // ── Layer 1: ATR Volatility gate ─────────────────────────────────────────
  // Skip when market is dead (<0.08%) or explosively volatile (>2.2%)
  if (atrPct < 0.08) {
    return { action: 'HOLD', confidence: 0, reason: `ATR gate: market too quiet (${atrPct.toFixed(3)}%)` };
  }
  if (atrPct > 2.20) {
    return { action: 'HOLD', confidence: 0, reason: `ATR gate: extreme volatility (${atrPct.toFixed(3)}%) — avoiding` };
  }

  // ── Layer 2: Volume / liquidity filter ──────────────────────────────────
  if (!liquidMarket) blocks.push(`low volume (${volRatio.toFixed(2)}× avg)`);

  // ── Layer 3: EMA50/200 — primary trend direction ─────────────────────────
  // Only trade in the direction the major trend allows
  const bullRegime = goldenCross;   // EMA50 > EMA200 → bias LONG
  const bearRegime = deathCross;    // EMA50 < EMA200 → bias SHORT (future) or HOLD

  if (!bullRegime) {
    // In a bear regime: only exit signals allowed, no new BUY entries
    const e9 = ema9, e21 = ema21;
    if (e9 < e21 && signal === 'STRONG_SELL') {
      return { action: 'SELL', confidence: 78, reason: `Bear regime exit: EMA cross + STRONG_SELL` };
    }
    return { action: 'HOLD', confidence: 0, reason: `Bear regime: EMA200 (${ema200.toFixed(5)}) > EMA50 (${ema50.toFixed(5)}) — no new longs` };
  }

  // ── Layer 4: Regime-aware entry thresholds ───────────────────────────────
  const e9 = ema9, e21 = ema21;
  const trendUp     = e9 > e21;
  const strongTrend = trendUp && ((e9 - e21) / e21) > 0.0005;

  // In a ranging market: require stronger signal (higher base confidence needed)
  const rangingPenalty = regime === 'RANGING' ? -15 : regime === 'WEAK_TREND' ? -7 : 0;

  // Regime bonus when EMA50/200 spread is widening (strong trend)
  const trendBonus = regime === 'TRENDING' ? 8 : 0;

  // ATR bonus: moderate volatility expansion = momentum  
  const atrBonus = atrPct > 0.8 && atrPct < 1.8 ? 5 : 0;

  // Volume bonus: above-average volume confirms institutional interest
  const volBonus = volRatio > 1.4 ? 8 : volRatio > 1.1 ? 4 : 0;

  // EMA50 slope bonus: still climbing → momentum
  const slopeBonus = ema50Slope > 0.5 ? 5 : ema50Slope < -0.5 ? -8 : 0;

  // Price above VWAP confirms intraday bias
  const vwapBonus = price > vwap ? 4 : -4;

  if (signal === 'STRONG_BUY' && rsi < 45 && strongTrend) {
    confidence = 82 + rangingPenalty + trendBonus + atrBonus + volBonus + slopeBonus + vwapBonus;
    action = 'BUY';
    reason = `NEW Setup A: STRONG_BUY + RSI<45 + EMA9/21 + EMA50>EMA200 [${regime}]`;
  } else if (signal === 'BUY' && rsi < 50 && strongTrend) {
    confidence = 70 + rangingPenalty + trendBonus + atrBonus + volBonus + slopeBonus + vwapBonus;
    action = 'BUY';
    reason = `NEW Setup B: BUY + RSI<50 + EMA9/21 + trend confirmed [${regime}]`;
  } else if (signal === 'STRONG_BUY' && rsi < 50 && trendUp) {
    confidence = 68 + rangingPenalty + trendBonus + atrBonus + volBonus + slopeBonus + vwapBonus;
    action = 'BUY';
    reason = `NEW Setup C: STRONG_BUY + EMA50>EMA200 [${regime}]`;
  } else if (e9 < e21 && signal === 'STRONG_SELL') {
    action = 'SELL'; confidence = 80 + slopeBonus;
    reason = `NEW exit: EMA cross + STRONG_SELL [regime: ${regime}]`;
  }

  // Clamp confidence
  confidence = Math.max(30, Math.min(95, confidence));

  // Volume block — can still set action but flag it
  if (action === 'BUY' && !liquidMarket) {
    confidence = Math.max(30, confidence - 12);
    reason += ` [low liquidity, conf penalised]`;
  }

  return { action, confidence, reason };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Generic backtest runner  (with latency + spread simulation)
//
//  Latency model
//  ─────────────
//  When a signal fires at bar i, the order is NOT filled immediately.
//  Instead it is queued as a "pending order" and filled at bar i + latencyBars.
//  The fill price is the market price at the fill bar plus:
//    • base SLIPPAGE (direction-aware)
//    • LATENCY_SLIP_PER_BAR × latencyBars  (adverse move while in-flight)
//    • adaptiveHalfSpread  (SPREAD_HALF widened by bar volatility)
//    • volume market impact (position size vs bar volume depth)
//
//  SL/TP hits (resting stop orders already at the broker) execute immediately
//  at the stop price — only signal-driven fills are delayed.
//
//  latencyBars and latencyEnabled are module-level lets set by Claude AI
//  before each run via askClaudeLatencyDecision().
// ─────────────────────────────────────────────────────────────────────────────
function runBacktest (prices, volumes, decisionFn, label) {
  let capital   = CAPITAL;
  let position  = null;
  const trades  = [];
  const equity  = [CAPITAL];

  let peak      = CAPITAL;
  let maxDD     = 0;

  const regimeCounts = { TRENDING: 0, WEAK_TREND: 0, RANGING: 0, BEAR: 0 };

  // ── Latency queue ──────────────────────────────────────────────────────────
  // Each pending order: { type: 'ENTRY'|'EXIT', fillBar, signalPrice,
  //                       signalBar, atr, regime, confidence, exitReason? }
  let pendingOrder = null;

  // Tracks total latency-induced slippage cost for reporting
  let totalLatencySlipCost = 0;
  let latencyFills         = 0;

  // ── Helpers ────────────────────────────────────────────────────────────────

  // Compute adaptive half-spread: widens during high-ATR bars
  function adaptiveHalfSpread(atr, price) {
    const atrPct = atr > 0 ? atr / price : 0;
    return SPREAD_HALF * (1 + atrPct * VOL_SPREAD_MULT);
  }

  // Compute volume market impact: larger orders relative to bar volume
  // result in a worse fill (order-book depth simulation).
  // Returns extra slippage fraction capped at 20bps.
  function volumeImpact(shares, barVol) {
    if (!barVol || barVol <= 0) return 0;
    return Math.min(0.002, (shares / barVol) * VOLUME_IMPACT_FACTOR);
  }

  for (let i = 1; i < prices.length; i++) {
    const ph = prices.slice(0, i + 1);
    const vh = volumes.slice(0, i + 1);
    const p  = prices[i];
    const bv = volumes[i] || 1;  // bar volume for market impact

    // ── 1. Execute any pending order whose fill bar has arrived ────────────
    if (pendingOrder && i >= pendingOrder.fillBar) {
      const bars = latencyEnabled ? latencyBars : 0;
      const latencySlip = LATENCY_SLIP_PER_BAR * bars;

      if (pendingOrder.type === 'ENTRY' && !position) {
        const atr     = pendingOrder.atr || p * 0.001;
        const hs      = adaptiveHalfSpread(atr, p);
        // Estimate shares for market impact (use 8% of capital heuristic)
        const estSize = Math.min(capital * 0.08, capital);
        const estShares = estSize / p;
        const volImp  = volumeImpact(estShares, bv);

        // Fill price: current bar + base slippage + latency drift + adaptive spread + market impact
        const entry  = p * (1 + SLIPPAGE + latencySlip + hs + volImp);
        const sl     = entry - atr * SL_ATR_MULT;
        const tp     = entry + atr * TP_ATR_MULT;
        const size   = Math.min(capital * 0.08, capital);
        const shares = size / entry;
        const comm   = size * COMMISSION;
        capital -= size + comm;

        const slipCost = p * (latencySlip + hs + volImp) * shares;
        totalLatencySlipCost += slipCost;
        latencyFills++;

        position = {
          entry, shares,
          cost:             size + comm,
          stopLoss:         sl,
          takeProfit:       tp,
          barOpen:          i,
          barSignal:        pendingOrder.signalBar,
          confidence:       pendingOrder.confidence,
          regime:           pendingOrder.regime,
          latencyBars:      i - pendingOrder.signalBar,
          latencySlipCost:  slipCost,
        };

      } else if (pendingOrder.type === 'EXIT' && position) {
        const atr    = pendingOrder.atr || p * 0.001;
        const hs     = adaptiveHalfSpread(atr, p);
        const volImp = volumeImpact(position.shares, bv);
        const exit   = p * (1 - SLIPPAGE - latencySlip - hs - volImp);
        const exitVal = position.shares * exit;
        const comm   = exitVal * COMMISSION;
        const profit = exitVal - position.cost - comm;

        const slipCost = p * (latencySlip + hs + volImp) * position.shares;
        totalLatencySlipCost += slipCost;
        latencyFills++;

        capital += exitVal - comm;
        trades.push({
          profit,
          bars:            i - position.barOpen,
          latencyBars:     i - pendingOrder.signalBar,
          latencySlipCost: slipCost,
          reason:          pendingOrder.exitReason || 'Signal Exit',
          regime:          position.regime,
          confidence:      position.confidence,
        });
        position = null;
      }

      pendingOrder = null;
    }

    // ── 2. Check resting SL / TP stops (broker-side — no latency) ─────────
    if (position) {
      if (p <= position.stopLoss || p >= position.takeProfit) {
        const isSL  = p <= position.stopLoss;
        const stop  = isSL ? position.stopLoss : position.takeProfit;
        // Stops still cross the spread, but no latency drift or market impact
        const hs     = adaptiveHalfSpread(stop * 0.001, stop);
        const exitVal = position.shares * (stop - stop * (SLIPPAGE + hs));
        const comm   = exitVal * COMMISSION;
        const profit = exitVal - position.cost - comm;
        capital += exitVal - comm;
        trades.push({
          profit,
          bars:        i - position.barOpen,
          latencyBars: 0,
          reason:      isSL ? 'Stop Loss' : 'Take Profit',
          regime:      position.regime,
          confidence:  position.confidence,
        });
        position     = null;
        pendingOrder = null;
      }
    }

    if (i < WARMUP_BARS) { equity.push(capital); continue; }

    const ind = computeIndicators(ph, vh);
    if (!ind) { equity.push(capital); continue; }

    // Track regime distribution
    if (ind.regime) regimeCounts[ind.regime] = (regimeCounts[ind.regime] || 0) + 1;
    if (!ind.goldenCross) regimeCounts.BEAR++;

    // ── 3. Generate signal ─────────────────────────────────────────────────
    const d = decisionFn(ind);

    // Queue exit (only when no pending order already in flight)
    if (position && !pendingOrder && d.action === 'SELL') {
      pendingOrder = {
        type:       'EXIT',
        fillBar:    i + (latencyEnabled ? latencyBars : 1), // OFF=1 bar natural delay, ON=latencyBars
        signalBar:  i,
        signalPrice: p,
        atr:        ind.atr || p * 0.001,
        exitReason: 'Signal Exit',
      };
    }

    // Queue entry (only when no position and no pending order)
    if (!position && !pendingOrder && d.action === 'BUY' && d.confidence >= MIN_CONFIDENCE) {
      pendingOrder = {
        type:       'ENTRY',
        fillBar:    i + (latencyEnabled ? latencyBars : 1), // OFF=1 bar natural delay, ON=latencyBars
        signalBar:  i,
        signalPrice: p,
        atr:        ind.atr || p * 0.001,
        regime:     ind.regime || 'UNKNOWN',
        confidence: d.confidence,
      };
    }

    // Equity
    const val = capital + (position ? position.shares * p : 0);
    equity.push(val);
    if (val > peak) peak = val;
    const dd = (peak - val) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // Force-close at end (instant admin close — no latency, half-spread only)
  if (position) {
    const lastP   = prices[prices.length - 1];
    const hs      = adaptiveHalfSpread(lastP * 0.001, lastP);
    const exit    = lastP * (1 - SLIPPAGE - hs);
    const exitV   = position.shares * exit;
    const comm    = exitV * COMMISSION;
    const profit  = exitV - position.cost - comm;
    capital += exitV - comm;
    trades.push({
      profit,
      bars:        prices.length - 1 - position.barOpen,
      latencyBars: 0,
      reason:      'EndOfTest',
      regime:      position.regime,
      confidence:  position.confidence,
    });
  }

  return {
    trades, capital, equity, maxDD, regimeCounts, label,
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

// ─────────────────────────────────────────────────────────────────────────────
//  Metrics calculator
// ─────────────────────────────────────────────────────────────────────────────
function metrics (result) {
  const { trades, capital, equity, maxDD } = result;
  const wins   = trades.filter(t => t.profit > 0);
  const losses = trades.filter(t => t.profit <= 0);

  const gp  = wins.reduce((s, t)   => s + t.profit, 0);
  const gl  = Math.abs(losses.reduce((s, t) => s + t.profit, 0));
  const pf  = gl > 0 ? gp / gl : gp > 0 ? Infinity : 0;
  const wr  = trades.length ? wins.length / trades.length * 100 : 0;
  const avgW = wins.length   ? gp / wins.length   : 0;
  const avgL = losses.length ? gl / losses.length : 0;
  const exp  = (avgW * (wr / 100)) - (avgL * (1 - wr / 100));
  const ret  = (capital - CAPITAL) / CAPITAL * 100;

  // Sharpe (annualised, assuming M5 bars → 288 bars/day → 72,576/year)
  const BARS_PER_YEAR = 72_576;
  const dailyRets = [];
  const BARS_PER_DAY = 288;
  for (let i = BARS_PER_DAY; i < equity.length; i += BARS_PER_DAY) {
    dailyRets.push((equity[i] - equity[i - BARS_PER_DAY]) / equity[i - BARS_PER_DAY]);
  }
  let sharpe = 0;
  if (dailyRets.length > 1) {
    const meanR = dailyRets.reduce((s, v) => s + v, 0) / dailyRets.length;
    const stdR  = Math.sqrt(dailyRets.reduce((s, v) => s + (v - meanR) ** 2, 0) / dailyRets.length);
    sharpe = stdR > 0 ? (meanR / stdR) * Math.sqrt(252) : 0;
  }

  const avgBars = trades.length ? trades.reduce((s, t) => s + t.bars, 0) / trades.length : 0;

  return {
    trades: trades.length,
    winRate: wr,
    profitFactor: pf,
    expectancy: exp,
    totalReturn: ret,
    maxDrawdown: maxDD * 100,
    sharpe,
    grossProfit: gp,
    grossLoss: gl,
    avgWin: avgW,
    avgLoss: avgL,
    avgBars,
    finalCapital: capital,
    bestTrade:  trades.length ? Math.max(...trades.map(t => t.profit)) : 0,
    worstTrade: trades.length ? Math.min(...trades.map(t => t.profit)) : 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Report printer
// ─────────────────────────────────────────────────────────────────────────────
const L   = '─'.repeat(72);
const EQ  = '═'.repeat(72);
const col = (s, w = 14) => String(s).padStart(w);
const row = (label, oldV, newV, better, fmt = v => v) => {
  const oBetter = better === 'old';
  const nBetter = better === 'new';
  return `  ${String(label).padEnd(26)} ${col(fmt(oldV))}${oBetter ? ' ◀' : '  '} ${col(fmt(newV))}${nBetter ? ' ◀' : '  '}`;
};

function printReport (oldRes, newRes) {
  const o = metrics(oldRes);
  const n = metrics(newRes);

  console.log('\n' + EQ);
  console.log('  STRATEGY COMPARISON REPORT');
  console.log(EQ);
  console.log(`  ${'Metric'.padEnd(26)} ${'OLD (EMA9/21)'.padStart(14)}   ${'NEW (EMA50/200)'.padStart(14)}`);
  console.log('  ' + L);

  const f2  = v => (typeof v === 'number' ? v.toFixed(2) : v);
  const f3  = v => (typeof v === 'number' ? v.toFixed(3) : v);
  const pct = v => (typeof v === 'number' ? v.toFixed(2) + '%' : v);
  const $   = v => (typeof v === 'number' ? '$' + v.toFixed(2) : v);

  console.log(row('Total return',      o.totalReturn,    n.totalReturn,    o.totalReturn < n.totalReturn ? 'new' : 'old', pct));
  console.log(row('Final capital',     o.finalCapital,   n.finalCapital,   o.finalCapital < n.finalCapital ? 'new' : 'old', $));
  console.log(row('Total trades',      o.trades,         n.trades,         null, v => v));
  console.log(row('Win rate',          o.winRate,        n.winRate,        o.winRate < n.winRate ? 'new' : 'old', pct));
  console.log(row('Profit factor',     o.profitFactor,   n.profitFactor,   o.profitFactor < n.profitFactor ? 'new' : 'old', f3));
  console.log(row('Expectancy/trade',  o.expectancy,     n.expectancy,     o.expectancy < n.expectancy ? 'new' : 'old', $));
  console.log(row('Sharpe ratio',      o.sharpe,         n.sharpe,         o.sharpe < n.sharpe ? 'new' : 'old', f3));
  console.log(row('Max drawdown',      o.maxDrawdown,    n.maxDrawdown,    o.maxDrawdown > n.maxDrawdown ? 'new' : 'old', pct));
  console.log(row('Gross profit',      o.grossProfit,    n.grossProfit,    o.grossProfit < n.grossProfit ? 'new' : 'old', $));
  console.log(row('Gross loss',        o.grossLoss,      n.grossLoss,      o.grossLoss > n.grossLoss ? 'new' : 'old', $));
  console.log(row('Avg win',           o.avgWin,         n.avgWin,         o.avgWin < n.avgWin ? 'new' : 'old', $));
  console.log(row('Avg loss',          o.avgLoss,        n.avgLoss,        o.avgLoss > n.avgLoss ? 'new' : 'old', $));
  console.log(row('Best trade',        o.bestTrade,      n.bestTrade,      null, $));
  console.log(row('Worst trade',       o.worstTrade,     n.worstTrade,     null, $));
  console.log(row('Avg trade (bars)',  o.avgBars,        n.avgBars,        null, f2));
  console.log('  ' + L);

  // ── Regime breakdown (NEW only) ──────────────────────────────────────────
  const rc = newRes.regimeCounts;
  const total = Object.values(rc).reduce((s, v) => s + v, 0) || 1;
  console.log('\n  Market regime distribution (NEW strategy):');
  for (const [k, v] of Object.entries(rc)) {
    const bar = '█'.repeat(Math.round(v / total * 30));
    console.log(`    ${k.padEnd(12)} ${String(v).padStart(5)} bars  ${bar} ${(v / total * 100).toFixed(1)}%`);
  }

  // ── Trades by regime (NEW only) ──────────────────────────────────────────
  if (newRes.trades.length > 0) {
    console.log('\n  NEW strategy trades by regime:');
    for (const regime of ['TRENDING', 'WEAK_TREND', 'RANGING']) {
      const rt  = newRes.trades.filter(t => t.regime === regime);
      if (rt.length === 0) continue;
      const rw  = rt.filter(t => t.profit > 0).length;
      const rwr = (rw / rt.length * 100).toFixed(0);
      const rp  = rt.reduce((s, t) => s + t.profit, 0).toFixed(2);
      console.log(`    ${regime.padEnd(12)}  ${rt.length} trades  WR: ${rwr}%  P&L: $${rp}`);
    }
  }

  // ── Latency & Fill Quality Report ────────────────────────────────────────
  console.log('\n  ⏱  LATENCY & FILL QUALITY (applied to both strategies)');
  console.log('  ' + L);
  const ls = newRes.latencyStats;
  const latStatus = ls.latencyEnabled ? `✅ ON (${ls.latencyBars} bar${ls.latencyBars !== 1 ? 's' : ''} ~${ls.latencyBars * 5} min on M5)` : '⏸  OFF (Claude AI: quiet market)';
  console.log(`    Latency simulation      ${latStatus}`);
  console.log(`    Latency slip/bar        ${(ls.latencySlipPerBar * 10000).toFixed(1)} bps adverse drift while in-flight`);
  console.log(`    Spread model            SPREAD_HALF=${(ls.spreadHalf * 10000).toFixed(1)}bps × vol-adaptive (widens at high ATR)`);
  console.log(`    Vol spread multiplier   ${ls.volSpreadMult}× (doubles spread at ~1% bar ATR)`);
  console.log(`    Volume market impact    ${(ls.volumeImpactFactor * 100).toFixed(0)}bps per % of bar volume consumed`);
  console.log(`    Total latency fills     ${ls.latencyFills}`);
  console.log(`    Total fill slip cost    $${ls.totalLatencySlipCost.toFixed(4)}`);
  console.log(`    Avg slip cost/fill      $${ls.avgLatencySlipPerFill.toFixed(4)}`);
  console.log(`    SL/TP fills             instant (resting stop orders — 0 latency)`);
  console.log('  ' + L);
  console.log('  🧠 Latency decision made by Claude AI based on market volatility stats');

  // ── Verdict ──────────────────────────────────────────────────────────────
  console.log('\n' + EQ);
  console.log('  VERDICT');
  console.log(EQ);

  let oldScore = 0, newScore = 0;
  const criteria = [
    ['Higher total return',   o.totalReturn,  n.totalReturn,  (a, b) => b > a],
    ['Higher win rate',       o.winRate,       n.winRate,       (a, b) => b > a],
    ['Higher profit factor',  o.profitFactor,  n.profitFactor,  (a, b) => b > a],
    ['Higher Sharpe ratio',   o.sharpe,        n.sharpe,        (a, b) => b > a],
    ['Lower max drawdown',    o.maxDrawdown,   n.maxDrawdown,   (a, b) => b < a],
    ['Higher expectancy',     o.expectancy,    n.expectancy,    (a, b) => b > a],
  ];
  for (const [label, ov, nv, prefer] of criteria) {
    const newWins = prefer(ov, nv);
    if (newWins) newScore++; else oldScore++;
    const winner = newWins ? 'NEW ◀' : 'OLD ◀';
    console.log(`    ${label.padEnd(28)} OLD: ${String(typeof ov === 'number' ? ov.toFixed(2) : ov).padStart(8)}   NEW: ${String(typeof nv === 'number' ? nv.toFixed(2) : nv).padStart(8)}   ${winner}`);
  }
  console.log('');
  console.log(`  Score  →  OLD: ${oldScore}/6   NEW: ${newScore}/6`);
  console.log('');

  const winner = newScore > oldScore ? 'NEW' : oldScore > newScore ? 'OLD' : 'TIE';
  if (winner === 'NEW') {
    console.log('  ✅  RECOMMENDATION: Use the NEW strategy');
    console.log('');
    console.log('  Why the NEW strategy is better:');
    if (n.winRate > o.winRate + 3)
      console.log(`    • EMA50/200 trend gate filters out counter-trend trades → +${(n.winRate - o.winRate).toFixed(1)}% win rate`);
    if (n.maxDrawdown < o.maxDrawdown - 1)
      console.log(`    • Bear regime block prevents buying into downtrends → -${(o.maxDrawdown - n.maxDrawdown).toFixed(1)}% max drawdown`);
    if (n.expectancy > o.expectancy + 0.5)
      console.log(`    • Volume filter avoids illiquid moves → better fill quality & higher expectancy`);
    if (n.trades < o.trades)
      console.log(`    • Fewer but higher-quality trades: ${o.trades} → ${n.trades} (regime filter removes noise)`);
    if (n.profitFactor > o.profitFactor + 0.1)
      console.log(`    • Higher profit factor: ${o.profitFactor.toFixed(2)} → ${n.profitFactor.toFixed(2)}`);
    console.log('');
    console.log('  ⚠️  Note: If NEW score is lower, run on more seeds to confirm — results vary');
    console.log('     by market regime distribution. Run: node backtest-compare.js --seeds 5');
  } else if (winner === 'OLD') {
    console.log('  ⚠️  RESULT: OLD strategy won this seed — run more seeds to confirm');
    console.log('     The new filters may be too restrictive on this particular price path.');
    console.log('     Try lowering MIN_CONFIDENCE from 60 to 55 in the NEW strategy,');
    console.log('     or reduce the ranging penalty from -15 to -8.');
  } else {
    console.log('  ⚖️  TIE — run with --seeds 5 to get a statistically meaningful result.');
  }

  console.log(EQ + '\n');
  return { oldScore, newScore, winner, o, n };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Walk-Forward Testing
//
//  Splits the full price history into overlapping windows:
//    IN-SAMPLE  (train): first inSamplePct% of each window  → optimise params
//    OUT-OF-SAMPLE (test): last outSamplePct% of each window → measure real edge
//
//  The window slides forward by stepPct% each fold.
//  This prevents overfitting: parameters tuned on historical data are
//  validated on unseen future data before being trusted.
//
//  Reports per-fold OOS metrics + aggregate stability score.
// ─────────────────────────────────────────────────────────────────────────────
function runWalkForward (prices, volumes, decisionFn, label, opts = {}) {
  const {
    windowPct   = 0.40,   // each window = 40% of total bars
    inSamplePct = 0.70,   // 70% of window = in-sample (train)
    stepPct     = 0.15,   // slide window by 15% each fold
    minConfidence = MIN_CONFIDENCE,
  } = opts;

  const n          = prices.length;
  const windowBars = Math.floor(n * windowPct);
  const inBars     = Math.floor(windowBars * inSamplePct);
  const outBars    = windowBars - inBars;
  const stepBars   = Math.floor(n * stepPct);

  const folds = [];
  let   start = 0;

  while (start + windowBars <= n) {
    const inStart  = start;
    const inEnd    = start + inBars;
    const outStart = inEnd;
    const outEnd   = Math.min(start + windowBars, n);

    // ── In-sample: measure strategy fitness ──────────────────────────────
    const isP = prices.slice(inStart, inEnd);
    const isV = volumes.slice(inStart, inEnd);
    const isR = runBacktest(isP, isV, decisionFn, label);
    const isM = metrics(isR);

    // ── Out-of-sample: measure real edge on unseen data ──────────────────
    const oosP = prices.slice(outStart, outEnd);
    const oosV = volumes.slice(outStart, outEnd);
    const oosR = runBacktest(oosP, oosV, decisionFn, label);
    const oosM = metrics(oosR);

    // Efficiency ratio: how much of IS performance survived OOS
    // 1.0 = perfect transfer  |  0.0 = no edge  |  <0 = overfitted
    const efficiencyRatio = isM.totalReturn !== 0
      ? oosM.totalReturn / Math.abs(isM.totalReturn)
      : 0;

    folds.push({
      fold:       folds.length + 1,
      inRange:    [inStart, inEnd],
      oosRange:   [outStart, outEnd],
      inSample:   isM,
      oos:        oosM,
      efficiency: parseFloat(efficiencyRatio.toFixed(3)),
    });

    start += stepBars;
  }

  if (folds.length === 0) return null;

  // Aggregate OOS metrics across all folds
  const keys    = ['totalReturn', 'winRate', 'profitFactor', 'sharpe', 'maxDrawdown', 'expectancy'];
  const agg     = {};
  for (const k of keys) {
    const vals  = folds.map(f => f.oos[k]).filter(v => isFinite(v));
    agg[k]      = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  }

  // Stability score: % of folds where OOS return > 0  (strategy has edge across time)
  const positiveFolds   = folds.filter(f => f.oos.totalReturn > 0).length;
  const stabilityScore  = (positiveFolds / folds.length * 100).toFixed(0);

  // Overfitting flag: IS win rate >> OOS win rate by >20pts in majority of folds
  const overfitFolds    = folds.filter(f => f.inSample.winRate - f.oos.winRate > 20).length;
  const overfit         = overfitFolds > folds.length * 0.5;

  return { folds, agg, stabilityScore, overfit, positiveFolds, totalFolds: folds.length };
}

function printWalkForward (wfOld, wfNew) {
  const EQ = '═'.repeat(72);
  const L  = '─'.repeat(72);
  console.log('\n' + EQ);
  console.log('  WALK-FORWARD ANALYSIS  (out-of-sample only — real edge)');
  console.log(EQ);
  console.log('  Window: 40% of bars  |  In-sample: 70%  |  OOS: 30%  |  Step: 15%\n');

  for (const [label, wf] of [['OLD (EMA9/21)', wfOld], ['NEW (EMA50/200)', wfNew]]) {
    if (!wf) { console.log(`  ${label}: insufficient data for walk-forward`); continue; }

    console.log(`  ${label}  —  ${wf.totalFolds} folds  |  Stability: ${wf.stabilityScore}% positive OOS  |  Overfit: ${wf.overfit ? '⚠️ YES' : '✅ NO'}`);
    console.log(`  ${'Fold'.padEnd(6)} ${'IS return'.padStart(10)} ${'OOS return'.padStart(11)} ${'OOS WR'.padStart(8)} ${'OOS PF'.padStart(8)} ${'Efficiency'.padStart(11)}`);
    console.log('  ' + '─'.repeat(56));
    for (const f of wf.folds) {
      const eff   = f.efficiency >= 0.5 ? '✓' : f.efficiency >= 0 ? '~' : '✗';
      console.log(
        `  ${String(f.fold).padEnd(6)}` +
        `${(f.inSample.totalReturn.toFixed(2) + '%').padStart(10)}` +
        `${(f.oos.totalReturn.toFixed(2) + '%').padStart(11)}` +
        `${(f.oos.winRate.toFixed(1) + '%').padStart(8)}` +
        `${f.oos.profitFactor.toFixed(2).padStart(8)}` +
        `${(f.efficiency.toFixed(2) + ' ' + eff).padStart(11)}`
      );
    }
    console.log(`  ${'AVG OOS'.padEnd(6)}` +
      `${''.padStart(10)}` +
      `${(wf.agg.totalReturn.toFixed(2) + '%').padStart(11)}` +
      `${(wf.agg.winRate.toFixed(1) + '%').padStart(8)}` +
      `${wf.agg.profitFactor.toFixed(2).padStart(8)}`);
    console.log('');
  }

  // Head-to-head OOS comparison
  if (wfOld && wfNew) {
    console.log(EQ);
    console.log('  WALK-FORWARD VERDICT  (out-of-sample performance)');
    console.log(EQ);

    const criteria = [
      ['OOS avg return',      wfOld.agg.totalReturn,    wfNew.agg.totalReturn,    (a,b) => b > a],
      ['OOS avg win rate',    wfOld.agg.winRate,         wfNew.agg.winRate,         (a,b) => b > a],
      ['OOS profit factor',   wfOld.agg.profitFactor,    wfNew.agg.profitFactor,    (a,b) => b > a],
      ['OOS Sharpe',          wfOld.agg.sharpe,          wfNew.agg.sharpe,          (a,b) => b > a],
      ['OOS max drawdown',    wfOld.agg.maxDrawdown,     wfNew.agg.maxDrawdown,     (a,b) => b < a],
      ['Stability score',     +wfOld.stabilityScore,     +wfNew.stabilityScore,     (a,b) => b > a],
      ['No overfitting',      wfOld.overfit ? 0 : 1,    wfNew.overfit ? 0 : 1,     (a,b) => b > a],
    ];

    let oldWF = 0, newWF = 0;
    for (const [lbl, ov, nv, prefer] of criteria) {
      const newWins = prefer(ov, nv);
      if (newWins) newWF++; else oldWF++;
      const fmtV = v => typeof v === 'number' ? (Math.abs(v) < 2 ? v.toFixed(3) : v.toFixed(2) + '%') : v;
      console.log(`  ${lbl.padEnd(24)} OLD: ${String(fmtV(ov)).padStart(9)}   NEW: ${String(fmtV(nv)).padStart(9)}   ${newWins ? 'NEW ◀' : 'OLD ◀'}`);
    }

    console.log('');
    console.log(`  Walk-forward score  →  OLD: ${oldWF}/7   NEW: ${newWF}/7`);
    console.log('');

    if (newWF > oldWF) {
      console.log('  ✅  NEW strategy has a genuine out-of-sample edge — safe to deploy');
      if (wfNew.overfit) console.log('  ⚠️  But NEW shows overfitting in some folds — monitor live performance');
    } else if (oldWF > newWF) {
      console.log('  ⚠️  OLD strategy outperforms NEW in OOS — tune NEW filters before deploying');
    } else {
      console.log('  ⚖️  TIE — run with --bars 5000 for a longer, more decisive test');
    }
    console.log(EQ + '\n');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Multi-seed runner
// ─────────────────────────────────────────────────────────────────────────────
function runMultiSeed (nSeeds = 3) {
  console.log(`\nRunning ${nSeeds} seeds × 2500 bars each …\n`);
  const seeds = Array.from({ length: nSeeds }, (_, i) => 1000 + i * 7919);

  const agg = { old: {}, new: {} };
  const keys = ['totalReturn','winRate','profitFactor','sharpe','maxDrawdown','expectancy','trades'];
  for (const k of keys) { agg.old[k] = 0; agg.new[k] = 0; }

  for (const seed of seeds) {
    process.stdout.write(`  Seed ${seed} … `);
    const { prices, volumes } = generateMarket(2500, seed);
    const oldR = runBacktest(prices, volumes, oldDecision, 'OLD');
    const newR = runBacktest(prices, volumes, newDecision, 'NEW');
    const o = metrics(oldR), n = metrics(newR);
    for (const k of keys) { agg.old[k] += o[k]; agg.new[k] += n[k]; }
    console.log(`OLD return: ${o.totalReturn.toFixed(2)}%  NEW return: ${n.totalReturn.toFixed(2)}%`);
  }

  for (const k of keys) { agg.old[k] /= nSeeds; agg.new[k] /= nSeeds; }

  console.log('\n' + '═'.repeat(72));
  console.log(`  MULTI-SEED AVERAGES (${nSeeds} seeds)`);
  console.log('═'.repeat(72));
  const f = (v, k) => k === 'trades' ? Math.round(v) : k.includes('Rate') || k.includes('Return') || k.includes('Drawdown') ? v.toFixed(2) + '%' : v.toFixed(3);
  for (const k of keys) {
    const better = agg.new[k] > agg.old[k] && k !== 'maxDrawdown' ? 'NEW ◀'
                 : agg.new[k] < agg.old[k] && k === 'maxDrawdown' ? 'NEW ◀' : 'OLD ◀';
    console.log(`  ${k.padEnd(20)} OLD: ${String(f(agg.old[k], k)).padStart(10)}   NEW: ${String(f(agg.new[k], k)).padStart(10)}   ${better}`);
  }
  console.log('═'.repeat(72));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const argMap  = {};
for (let i = 0; i < args.length; i += 2) {
  if (args[i].startsWith('--')) argMap[args[i].slice(2)] = args[i + 1];
}

const SEED       = parseInt(argMap.seed    || 42);
const SEEDS      = parseInt(argMap.seeds   || 1);
const BARS       = parseInt(argMap.bars    || 2500);
const WALK_FWD   = argMap.wf !== 'false';   // walk-forward on by default

console.log('\n' + '═'.repeat(72));
console.log('  ALADDIN BOT — Strategy Comparison + Walk-Forward Analysis');
console.log('  OLD: EMA9/21 + RSI + MACD vote count');
console.log('  NEW: EMA50/200 + ATR gate + Regime detection + Volume filter');
console.log('═'.repeat(72));

if (SEEDS > 1) {
  (async () => {
    // For multi-seed runs, ask Claude once using seed=42 to set latency config
    const { prices: samplePrices, volumes: sampleVolumes } = generateMarket(BARS, 42);
    const stats = computeMarketStats(samplePrices, sampleVolumes);
    console.log('\n  🧠 Asking Claude AI to decide latency configuration …');
    const decision = await askClaudeLatencyDecision(stats);
    latencyEnabled = decision.latencyEnabled;
    latencyBars    = decision.latencyBars;
    console.log(`  🧠 Claude AI latency decision: ${decision.latencyEnabled ? 'ON' : 'OFF'}, bars=${decision.latencyBars}`);
    console.log(`     Reasoning: ${decision.reasoning}\n`);
    runMultiSeed(SEEDS);
  })().catch(err => { console.error(err); process.exit(1); });
} else {
  (async () => {
    console.log(`\n  Generating ${BARS} bars (seed=${SEED}) …`);
    const { prices, volumes } = generateMarket(BARS, SEED);

    // ── Claude AI decides latency config based on this market's characteristics
    const stats = computeMarketStats(prices, volumes);
    console.log(`\n  📊 Market stats: avgVol=${stats.avgVolatilityPct}% | trending=${stats.trendingBarsPct}% | days=${stats.tradingDays}`);
    console.log('  🧠 Asking Claude AI to decide latency configuration …');
    const decision = await askClaudeLatencyDecision(stats);
    latencyEnabled = decision.latencyEnabled;
    latencyBars    = decision.latencyBars;
    console.log(`  🧠 Claude AI: latency ${decision.latencyEnabled ? `ON — ${decision.latencyBars} bar(s) (~${decision.latencyBars * 5} min)` : 'OFF — quiet market, signal quality mode'}`);
    console.log(`     Reasoning: ${decision.reasoning}\n`);

    console.log(`  Running full-period backtest …`);
    const oldResult = runBacktest(prices, volumes, oldDecision, 'OLD');
    const newResult = runBacktest(prices, volumes, newDecision, 'NEW');
    printReport(oldResult, newResult);

    if (WALK_FWD) {
      const wfRunner = new WalkForwardValidator();

      // Build a backtestFn adapter so WalkForwardValidator can call runBacktest
      const makeBacktestFn = (decisionFn) => (p, v, cap) => runBacktest(p, v, decisionFn, 'wf');

      console.log('\n  ── Walk-Forward: SLIDING window ─────────────────────────────');
      console.log(`  (${BARS} bars | 40% window | 15% step | 20-bar embargo)`);
      const wfSlideOld = wfRunner.runSliding(prices, volumes, makeBacktestFn(oldDecision));
      const wfSlideNew = wfRunner.runSliding(prices, volumes, makeBacktestFn(newDecision));
      console.log('  OLD:'); wfRunner.printReport(wfSlideOld);
      console.log('  NEW:'); wfRunner.printReport(wfSlideNew);

      console.log('  ── Walk-Forward: EXPANDING window ───────────────────────────');
      console.log('  (starts at 30% IS, grows by 10% each fold, fixed OOS size)');
      const wfExpandOld = wfRunner.runExpanding(prices, volumes, makeBacktestFn(oldDecision));
      const wfExpandNew = wfRunner.runExpanding(prices, volumes, makeBacktestFn(newDecision));
      console.log('  OLD:'); wfRunner.printReport(wfExpandOld);
      console.log('  NEW:'); wfRunner.printReport(wfExpandNew);

      console.log('  ── Walk-Forward: ANCHORED window ────────────────────────────');
      console.log('  (fixed IS = first 50%, OOS slides forward to test decay)');
      const wfAnchorOld = wfRunner.runAnchored(prices, volumes, makeBacktestFn(oldDecision));
      const wfAnchorNew = wfRunner.runAnchored(prices, volumes, makeBacktestFn(newDecision));
      console.log('  OLD:'); wfRunner.printReport(wfAnchorOld);
      console.log('  NEW:'); wfRunner.printReport(wfAnchorNew);
    }
  })().catch(err => { console.error(err); process.exit(1); });
}


// v12 8.1-8.3: Import advanced backtest validators
const { CPCV, whitesRealityCheck, deflatedSharpeRatio } = require('./advanced-features');
module.exports = Object.assign(module.exports || {}, { CPCV, whitesRealityCheck, deflatedSharpeRatio });

// Item #29: Transaction cost sensitivity analysis
async function costSensitivityAnalysis(backtestFn, prices, volumes, capital = 10000) {
  const { TRADING_CONFIG } = require('./trading-config');
  const origComm = TRADING_CONFIG.commission || 0;
  const origSlip = TRADING_CONFIG.slippage  || 0.0005;
  const results  = [];
  for (const mult of [1.0, 1.5, 2.0, 3.0]) {
    TRADING_CONFIG.commission = origComm * mult;
    TRADING_CONFIG.slippage   = origSlip * mult;
    try {
      const r      = typeof backtestFn === 'function' ? await backtestFn(prices, volumes, capital) : { trades:[], capital };
      const trades = r.trades || [];
      const wins   = trades.filter(t => (t.profit||0) > 0).length;
      results.push({
        costMult: mult,
        finalCapital: parseFloat((r.capital||capital).toFixed(2)),
        trades:        trades.length,
        winRate:       trades.length ? (wins/trades.length*100).toFixed(1)+'%' : '0%',
        totalReturn:   (((r.capital||capital)-capital)/capital*100).toFixed(2)+'%',
      });
    } catch (_) { results.push({ costMult: mult, error: 'failed' }); }
  }
  TRADING_CONFIG.commission = origComm;
  TRADING_CONFIG.slippage   = origSlip;
  return results;
}

// Item #30: Benchmark comparison — simple 20/50 EMA crossover baseline
function runBenchmark(prices, initialCapital = 10000) {
  if (!prices || prices.length < 55) return { capital: initialCapital, trades: 0, totalReturn:'0%' };
  let capital = initialCapital, position = null;
  const trades = [], ema = (n, data, i) => {
    if (i < n) return data.slice(0, i+1).reduce((s,v)=>s+v,0)/(i+1);
    const k = 2/(n+1); let e = data[0];
    for (let j=1;j<=i;j++) e = data[j]*k + e*(1-k);
    return e;
  };
  for (let i = 55; i < prices.length; i++) {
    const fast=ema(20,prices,i), slow=ema(50,prices,i);
    const pf=ema(20,prices,i-1), ps=ema(50,prices,i-1);
    if (pf<=ps && fast>slow && !position) { position={entry:prices[i],shares:capital/prices[i]}; }
    else if (pf>=ps && fast<slow && position) {
      const p=(prices[i]-position.entry)*position.shares; capital+=p; trades.push(p); position=null;
    }
  }
  if (position) capital+=(prices.at(-1)-position.entry)*position.shares;
  const wins=trades.filter(p=>p>0).length;
  return { capital:parseFloat(capital.toFixed(2)), trades:trades.length,
    totalReturn:((capital-initialCapital)/initialCapital*100).toFixed(2)+'%',
    winRate:trades.length?(wins/trades.length*100).toFixed(1)+'%':'0%' };
}

// Item #29/#30: Export utility functions for programmatic use
if (typeof module !== "undefined") {
  module.exports = { costSensitivityAnalysis, runBenchmark };
}
