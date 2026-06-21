'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  param-stability.js
//  Parameter Stability & Robustness Testing
//
//  Three tests, each targeting a different dimension of overfitting risk:
//
//  1. SENSITIVITY SWEEP
//     Vary each strategy parameter across a defined range, one at a time.
//     Measures how much profit factor, win rate, and return change as each
//     parameter moves away from its baseline value.
//     → Low variance = robust parameter. High variance = overfitted to that value.
//     → Produces a robustness score (0–100) per parameter and overall.
//
//  2. MONTE CARLO SIMULATION
//     Takes the actual closed trades from a baseline run and re-orders them
//     randomly 1 000 times. Each shuffle produces a different equity curve.
//     → If the strategy only works with this specific trade sequence, it's luck.
//     → Reports: median final equity, 5th/95th percentile, P(profit), max scenario DD.
//
//  3. NOISE INJECTION
//     Re-runs the backtest with progressively worsening fills:
//     1×, 1.5×, 2×, 3×, 5× baseline slippage.
//     → Tells you how much fill quality degrades before the strategy breaks even.
//     → A robust strategy should survive 2× slippage and still be profitable.
//
//  Run standalone:  node param-stability.js
//  Or import:       const { runFullStabilityReport } = require('./param-stability');
// ═══════════════════════════════════════════════════════════════════════════════

const { Indicators } = require('./indicators');

// ── Baseline Config (mirrors backtest-compare.js defaults) ────────────────────
const BASELINE = {
  capital:        10_000,
  minConfidence:  60,      // minimum signal confidence to enter
  slAtrMult:      1.5,     // stop loss = entry − ATR × this
  tpAtrMult:      4.0,     // take profit = entry + ATR × this
  riskPct:        0.08,    // position size as fraction of capital
  slippage:       0.0003,  // base fill slippage fraction
  commission:     0.0002,  // commission per side
  warmupBars:     210,     // indicator warm-up period
  spreadHalf:     0.0001,  // half-spread (bid/ask cross)
  volSpreadMult:  100,     // spread widening multiplier with ATR
};

// ── Parameter ranges for the sensitivity sweep ────────────────────────────────
// Each entry: { param, label, values, unit }
const PARAM_RANGES = [
  {
    param: 'minConfidence', label: 'Min Confidence Floor',
    values: [50, 54, 57, 60, 63, 66, 70], unit: 'pts',
  },
  {
    param: 'slAtrMult', label: 'Stop Loss ATR Multiplier',
    values: [0.8, 1.0, 1.2, 1.5, 1.8, 2.1, 2.5], unit: '×ATR',
  },
  {
    param: 'tpAtrMult', label: 'Take Profit ATR Multiplier',
    values: [2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 6.0], unit: '×ATR',
  },
  {
    param: 'riskPct', label: 'Position Risk %',
    values: [0.04, 0.05, 0.06, 0.08, 0.10, 0.12], unit: '%cap',
  },
  {
    param: 'slippage', label: 'Base Slippage',
    values: [0.0001, 0.0002, 0.0003, 0.0005, 0.0008, 0.0012], unit: 'frac',
  },
  {
    param: 'mtaMinAlignment', label: 'MTA Minimum Alignment Score',
    values: [0.45, 0.50, 0.55, 0.60, 0.65, 0.70], unit: 'score',
  },
];

// ── Indicator computation ─────────────────────────────────────────────────────
function computeIndicators (ph, vh, warmupBars) {
  const n = ph.length;
  if (n < warmupBars) return null;

  const rsi    = Indicators.rsi(ph);
  const macd   = Indicators.macd(ph);
  const ema9   = Indicators.ema(ph, 9);
  const ema21  = Indicators.ema(ph, 21);
  const ema50  = Indicators.ema(ph, 50);
  const ema200 = Indicators.ema(ph, 200);
  const bb     = Indicators.bollingerBands(ph);
  const atr    = Indicators.atr(ph, 14);
  const vwap   = Indicators.vwap(ph, vh);
  const price  = ph[n - 1];
  const atrPct = atr > 0 ? (atr / price) * 100 : 0;

  const emaDivergence = Math.abs(ema50 - ema200) / price * 100;
  const regime =
    emaDivergence > 0.50 ? 'TRENDING' :
    emaDivergence > 0.20 ? 'WEAK_TREND' : 'RANGING';

  const goldenCross = ema50 > ema200;
  const deathCross  = ema50 < ema200;
  const ema50Slope  = n > 55
    ? (ema50 - Indicators.ema(ph.slice(0, n - 5), 50)) / price * 1000
    : 0;

  const volWindow = vh.slice(-20);
  const avgVolume = volWindow.reduce((s, v) => s + v, 0) / volWindow.length;
  const volRatio  = vh[n - 1] / (avgVolume || 1);
  const liquidMarket = volRatio >= 0.75;

  const oldSignal = Indicators.signal({ rsi, macd, ema9, ema21, bb });

  return {
    price, rsi, macd, ema9, ema21, ema50, ema200,
    bb, atr, vwap, atrPct, regime, goldenCross, deathCross,
    ema50Slope, volRatio, liquidMarket, avgVolume, oldSignal,
  };
}

// ── Decision function (parameterised version of newDecision) ──────────────────
function makeDecision (ind, cfg) {
  if (!ind) return { action: 'HOLD', confidence: 0 };

  const {
    rsi, ema9, ema21, ema50, ema200,
    atrPct, regime, goldenCross, deathCross, ema50Slope,
    volRatio, liquidMarket, oldSignal: signal, price, vwap,
  } = ind;

  let action = 'HOLD', confidence = 50;

  if (atrPct < 0.08 || atrPct > 2.20) return { action: 'HOLD', confidence: 0 };

  const trendUp     = ema9 > ema21;
  const strongTrend = trendUp && ((ema9 - ema21) / ema21) > 0.0005;

  const rangingPenalty = regime === 'RANGING' ? -15 : regime === 'WEAK_TREND' ? -7 : 0;
  const trendBonus     = regime === 'TRENDING' ? 8 : 0;
  const atrBonus       = atrPct > 0.8 && atrPct < 1.8 ? 5 : 0;
  const volBonus       = volRatio > 1.4 ? 8 : volRatio > 1.1 ? 4 : 0;
  const slopeBonus     = ema50Slope > 0.5 ? 5 : ema50Slope < -0.5 ? -8 : 0;
  const vwapBonus      = price > vwap ? 4 : -4;

  if (!goldenCross) {
    if (ema9 < ema21 && signal === 'STRONG_SELL') return { action: 'SELL', confidence: 78 };
    return { action: 'HOLD', confidence: 0 };
  }

  if (signal === 'STRONG_BUY' && rsi < 45 && strongTrend) {
    confidence = 82 + rangingPenalty + trendBonus + atrBonus + volBonus + slopeBonus + vwapBonus;
    action = 'BUY';
  } else if (signal === 'BUY' && rsi < 50 && strongTrend) {
    confidence = 70 + rangingPenalty + trendBonus + atrBonus + volBonus + slopeBonus + vwapBonus;
    action = 'BUY';
  } else if (signal === 'STRONG_BUY' && rsi < 50 && trendUp) {
    confidence = 68 + rangingPenalty + trendBonus + atrBonus + volBonus + slopeBonus + vwapBonus;
    action = 'BUY';
  } else if (ema9 < ema21 && signal === 'STRONG_SELL') {
    action = 'SELL'; confidence = 80 + slopeBonus;
  }

  confidence = Math.max(30, Math.min(95, confidence));
  if (action === 'BUY' && !liquidMarket) confidence = Math.max(30, confidence - 12);

  return { action, confidence };
}

// ── Parameterised backtest runner ─────────────────────────────────────────────
// Accepts a full config object — every tunable parameter is in cfg.
function runParamBacktest (prices, volumes, cfg) {
  const {
    capital, minConfidence, slAtrMult, tpAtrMult,
    riskPct, slippage, commission, warmupBars, spreadHalf, volSpreadMult,
  } = { ...BASELINE, ...cfg };

  let cap      = capital;
  let position = null;
  const trades = [];
  const equity = [capital];
  let peak = capital, maxDD = 0;
  let pendingOrder = null;

  function aHS (atr, price) {
    return spreadHalf * (1 + (atr > 0 ? atr / price : 0) * volSpreadMult);
  }

  for (let i = 1; i < prices.length; i++) {
    const ph  = prices.slice(0, i + 1);
    const vh  = volumes.slice(0, i + 1);
    const p   = prices[i];
    const bv  = volumes[i] || 1;

    // Execute pending order
    if (pendingOrder && i >= pendingOrder.fillBar) {
      if (pendingOrder.type === 'ENTRY' && !position) {
        const hs      = aHS(pendingOrder.atr || p * 0.001, p);
        const entry   = p * (1 + slippage + hs);
        const atr     = pendingOrder.atr || p * 0.001;
        const sl      = entry - atr * slAtrMult;
        const tp      = entry + atr * tpAtrMult;
        const size    = Math.min(cap * riskPct, cap);
        const shares  = size / entry;
        const comm    = size * commission;
        cap -= size + comm;
        position = { entry, shares, cost: size + comm, stopLoss: sl, takeProfit: tp, barOpen: i };
      } else if (pendingOrder.type === 'EXIT' && position) {
        const hs      = aHS(position.entry * 0.001, p);
        const exit    = p * (1 - slippage - hs);
        const exitVal = position.shares * exit;
        const comm    = exitVal * commission;
        const profit  = exitVal - position.cost - comm;
        cap += exitVal - comm;
        trades.push({ profit, bars: i - position.barOpen, win: profit > 0 });
        position = null;
      }
      pendingOrder = null;
    }

    // Check SL/TP
    if (position) {
      if (p <= position.stopLoss || p >= position.takeProfit) {
        const isSL    = p <= position.stopLoss;
        const stop    = isSL ? position.stopLoss : position.takeProfit;
        const hs      = aHS(stop * 0.001, stop);
        const exitVal = position.shares * (stop * (1 - slippage - hs));
        const comm    = exitVal * commission;
        const profit  = exitVal - position.cost - comm;
        cap += exitVal - comm;
        trades.push({ profit, bars: i - position.barOpen, win: profit > 0, reason: isSL ? 'SL' : 'TP' });
        position     = null;
        pendingOrder = null;
      }
    }

    if (i < warmupBars) { equity.push(cap); continue; }

    const ind = computeIndicators(ph, vh, warmupBars);
    if (!ind) { equity.push(cap); continue; }

    const d = makeDecision(ind, cfg);

    if (position && !pendingOrder && d.action === 'SELL') {
      pendingOrder = { type: 'EXIT', fillBar: i + 1, signalBar: i };
    }
    if (!position && !pendingOrder && d.action === 'BUY' && d.confidence >= minConfidence) {
      pendingOrder = { type: 'ENTRY', fillBar: i + 1, signalBar: i, atr: ind.atr };
    }

    const val = cap + (position ? position.shares * p : 0);
    equity.push(val);
    if (val > peak) peak = val;
    const dd = (peak - val) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // Force-close
  if (position) {
    const lastP   = prices.at(-1);
    const hs      = aHS(lastP * 0.001, lastP);
    const exitV   = position.shares * (lastP * (1 - slippage - hs));
    const comm    = exitV * commission;
    const profit  = exitV - position.cost - comm;
    cap += exitV - comm;
    trades.push({ profit, bars: prices.length - 1 - position.barOpen, win: profit > 0 });
  }

  return { trades, capital: cap, equity, maxDD };
}

// ── Metric computation ────────────────────────────────────────────────────────
function calcMetrics (result) {
  const { trades, capital, equity, maxDD } = result;
  const n      = trades.length;
  const wins   = trades.filter(t => t.win);
  const losses = trades.filter(t => !t.win);
  const gp     = wins.reduce((s, t)   => s + t.profit, 0);
  const gl     = Math.abs(losses.reduce((s, t) => s + t.profit, 0));
  const pf     = gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0);
  const wr     = n > 0 ? wins.length / n * 100 : 0;
  const ret    = (capital - BASELINE.capital) / BASELINE.capital * 100;
  const exp    = n > 0 ? trades.reduce((s, t) => s + t.profit, 0) / n : 0;

  // Sharpe (trade-level, annualised with sqrt(n))
  let sharpe = 0;
  if (n > 2) {
    const mean = exp;
    const std  = Math.sqrt(trades.reduce((s, t) => s + (t.profit - mean) ** 2, 0) / n);
    sharpe = std > 0 ? (mean / std) * Math.sqrt(n) : 0;
  }

  return {
    trades: n, winRate: parseFloat(wr.toFixed(2)),
    profitFactor: parseFloat((isFinite(pf) ? pf : 99).toFixed(4)),
    totalReturn:  parseFloat(ret.toFixed(3)),
    expectancy:   parseFloat(exp.toFixed(4)),
    maxDrawdown:  parseFloat((maxDD * 100).toFixed(2)),
    sharpe:       parseFloat(sharpe.toFixed(4)),
  };
}

// ── 1. SENSITIVITY SWEEP ──────────────────────────────────────────────────────
function runSensitivitySweep (prices, volumes, opts = {}) {
  const paramRanges = opts.paramRanges || PARAM_RANGES;
  const seeds       = opts.seeds       || [42, 7919, 31337];  // multiple seeds for reliability
  const results     = [];

  for (const param of paramRanges) {
    const paramResults = [];

    for (const val of param.values) {
      const cfg = { ...BASELINE, [param.param]: val };
      let totalPF = 0, totalWR = 0, totalRet = 0, totalTrades = 0;

      for (const seed of seeds) {
        const { prices: sp, volumes: sv } = _genMarket(prices.length, seed);
        const r = runParamBacktest(sp, sv, cfg);
        const m = calcMetrics(r);
        totalPF     += isFinite(m.profitFactor) ? m.profitFactor : 0;
        totalWR     += m.winRate;
        totalRet    += m.totalReturn;
        totalTrades += m.trades;
      }

      paramResults.push({
        value:        val,
        isBaseline:   Math.abs(val - BASELINE[param.param]) < 1e-9,
        profitFactor: parseFloat((totalPF / seeds.length).toFixed(4)),
        winRate:      parseFloat((totalWR / seeds.length).toFixed(2)),
        totalReturn:  parseFloat((totalRet / seeds.length).toFixed(3)),
        avgTrades:    Math.round(totalTrades / seeds.length),
      });
    }

    // Robustness score for this parameter:
    // CV (coefficient of variation) of profit factor across all tested values.
    // Low CV = stable = robust. High CV = sensitive = potential overfitting.
    const pfs  = paramResults.map(r => r.profitFactor).filter(v => v > 0);
    const mean = pfs.reduce((s, v) => s + v, 0) / (pfs.length || 1);
    const std  = pfs.length > 1
      ? Math.sqrt(pfs.reduce((s, v) => s + (v - mean) ** 2, 0) / pfs.length)
      : 0;
    const cv   = mean > 0 ? std / mean : 1;

    // Robustness score: 100 = perfectly stable, 0 = completely unstable
    const robustnessScore = Math.max(0, Math.round((1 - Math.min(cv, 1)) * 100));

    // Positive range: fraction of parameter values where PF > 1 (profitable)
    const profitableCount = paramResults.filter(r => r.profitFactor > 1.0).length;
    const profitableRange = parseFloat((profitableCount / paramResults.length * 100).toFixed(0));

    results.push({
      param:          param.param,
      label:          param.label,
      unit:           param.unit,
      baseline:       BASELINE[param.param],
      values:         paramResults,
      robustnessScore,
      profitableRange,
      cv:             parseFloat(cv.toFixed(4)),
    });
  }

  // Overall robustness: weighted average of per-parameter scores
  const overallScore = Math.round(results.reduce((s, r) => s + r.robustnessScore, 0) / results.length);

  return { results, overallScore };
}

// ── 2. MONTE CARLO SIMULATION ─────────────────────────────────────────────────
function runMonteCarlo (trades, initialCapital = BASELINE.capital, iterations = 1000) {
  if (trades.length === 0) return null;

  const finalEquities = [];
  let seed = 1;
  const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 0xFFFFFFFF; };

  for (let iter = 0; iter < iterations; iter++) {
    // Fisher-Yates shuffle of trade order
    const shuffled = [...trades];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    // Replay shuffled trades
    let cap = initialCapital;
    let peak = cap, maxDD = 0;
    for (const t of shuffled) {
      cap += t.profit;
      if (cap > peak) peak = cap;
      const dd = (peak - cap) / peak;
      if (dd > maxDD) maxDD = dd;
    }
    finalEquities.push({ equity: cap, maxDD });
  }

  // Sort for percentile calculation
  const sorted = [...finalEquities].sort((a, b) => a.equity - b.equity);
  const n      = sorted.length;

  const pctile = (pct) => sorted[Math.floor(n * pct / 100)].equity;

  const profitable  = finalEquities.filter(r => r.equity > initialCapital).length;
  const maxDDs      = finalEquities.map(r => r.maxDD);
  const avgMaxDD    = maxDDs.reduce((s, v) => s + v, 0) / n;
  const worstMaxDD  = Math.max(...maxDDs);

  return {
    iterations,
    trades: trades.length,
    initialCapital,
    p5:               parseFloat(pctile(5).toFixed(2)),
    p25:              parseFloat(pctile(25).toFixed(2)),
    median:           parseFloat(pctile(50).toFixed(2)),
    p75:              parseFloat(pctile(75).toFixed(2)),
    p95:              parseFloat(pctile(95).toFixed(2)),
    probabilityOfProfit: parseFloat((profitable / n * 100).toFixed(1)),
    avgMaxDrawdown:   parseFloat((avgMaxDD * 100).toFixed(2)),
    worstMaxDrawdown: parseFloat((worstMaxDD * 100).toFixed(2)),
    medianReturn:     parseFloat(((pctile(50) - initialCapital) / initialCapital * 100).toFixed(2)),
  };
}

// ── 3. NOISE INJECTION ────────────────────────────────────────────────────────
function runNoiseInjection (prices, volumes, slippageMultipliers = [1, 1.5, 2, 3, 5]) {
  const results = [];

  for (const mult of slippageMultipliers) {
    const cfg = { ...BASELINE, slippage: BASELINE.slippage * mult };
    const r   = runParamBacktest(prices, volumes, cfg);
    const m   = calcMetrics(r);
    results.push({
      slippageMultiplier: mult,
      slippageBps:        parseFloat((cfg.slippage * 10000).toFixed(1)),
      ...m,
      profitable:         m.totalReturn > 0,
    });
  }

  // Find the breakeven multiplier (last point where PF >= 1)
  const profitable = results.filter(r => r.profitFactor >= 1.0);
  const breakevenAt = profitable.length > 0
    ? profitable.at(-1).slippageMultiplier
    : 1;

  return { results, breakevenMultiplier: breakevenAt };
}

// ── Shared market generator ────────────────────────────────────────────────────
function _genMarket (n = 2000, seed = 42) {
  let s = seed;
  const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0xFFFFFFFF; };
  const randn = () => Math.sqrt(-2 * Math.log(rng() + 1e-10)) * Math.cos(2 * Math.PI * rng());
  const prices = [1.1000], volumes = [1_200_000];
  let drift = 0.00005, vol = 0.0010, phaseBar = 0, inTrend = true;
  let phaseDuration = 120 + Math.floor(rng() * 200);
  for (let i = 1; i < n; i++) {
    phaseBar++;
    if (phaseBar >= phaseDuration) {
      phaseBar = 0;
      phaseDuration = 80 + Math.floor(rng() * 250);
      inTrend = !inTrend;
      drift   = inTrend ? (rng() > 0.5 ? 0.00015 : -0.00015) : 0;
    }
    vol = 0.92 * vol + 0.08 * (0.0005 + Math.abs(randn()) * 0.0008);
    vol = Math.max(0.0003, Math.min(0.003, vol));
    prices.push(Math.max(0.6, prices.at(-1) * (1 + drift + randn() * vol)));
    const volMult = 1 + Math.abs(drift) * 300 + (phaseBar < 5 ? 0.5 : 0);
    volumes.push(Math.max(200_000, (800_000 + rng() * 600_000) * volMult));
  }
  return { prices, volumes };
}

// ── Report printer ─────────────────────────────────────────────────────────────
function printStabilityReport (sweep, mc, noise) {
  const EQ  = '═'.repeat(72);
  const L   = '─'.repeat(72);
  const pad = (s, n) => String(s).padEnd(n);
  const rpad = (s, n) => String(s).padStart(n);

  console.log('\n' + EQ);
  console.log('  🔬 PARAMETER STABILITY REPORT');
  console.log(EQ);

  // ── Sensitivity sweep ────────────────────────────────────────────────────
  console.log('\n  1. SENSITIVITY SWEEP');
  console.log('  ' + L);
  console.log(`  Overall Robustness Score: ${sweep.overallScore}/100 ` +
    `${sweep.overallScore >= 70 ? '✅ Robust' : sweep.overallScore >= 50 ? '⚠️  Moderate' : '❌ Fragile'}`);
  console.log('  ' + L);
  console.log(`  ${pad('Parameter', 30)} ${rpad('Score', 6)} ${rpad('ProfRange', 10)} ${rpad('CV', 7)}  Verdict`);
  console.log('  ' + L);

  for (const r of sweep.results) {
    const verdict =
      r.robustnessScore >= 75 ? '✅ Robust' :
      r.robustnessScore >= 55 ? '⚠️  Moderate' : '❌ Fragile';
    console.log(
      `  ${pad(r.label, 30)} ` +
      `${rpad(r.robustnessScore, 6)} ` +
      `${rpad(r.profitableRange + '%', 10)} ` +
      `${rpad(r.cv.toFixed(3), 7)}  ${verdict}`
    );
  }

  // Detailed value tables
  console.log('\n  Parameter value detail:');
  for (const r of sweep.results) {
    console.log(`\n  ${r.label} (baseline=${r.baseline}${r.unit})`);
    console.log(`  ${'Value'.padEnd(10)} ${'PF'.padStart(8)} ${'WR%'.padStart(7)} ${'Ret%'.padStart(8)} ${'Trades'.padStart(7)}`);
    for (const v of r.values) {
      const base = v.isBaseline ? ' ← baseline' : '';
      console.log(
        `  ${String(v.value).padEnd(10)} ` +
        `${rpad(v.profitFactor.toFixed(3), 8)} ` +
        `${rpad(v.winRate.toFixed(1), 7)} ` +
        `${rpad(v.totalReturn.toFixed(2), 8)} ` +
        `${rpad(v.avgTrades, 7)}${base}`
      );
    }
  }

  // ── Monte Carlo ──────────────────────────────────────────────────────────
  if (mc) {
    console.log('\n\n  2. MONTE CARLO SIMULATION');
    console.log('  ' + L);
    console.log(`  Iterations: ${mc.iterations.toLocaleString()} | Trades shuffled: ${mc.trades}`);
    console.log(`  Initial capital: $${mc.initialCapital.toLocaleString()}`);
    console.log('  ' + L);
    console.log(`  Probability of profit:     ${mc.probabilityOfProfit}% ` +
      `${mc.probabilityOfProfit >= 70 ? '✅' : mc.probabilityOfProfit >= 50 ? '⚠️' : '❌'}`);
    console.log(`  Median final equity:       $${mc.median.toFixed(2)} (${mc.medianReturn >= 0 ? '+' : ''}${mc.medianReturn}%)`);
    console.log(`  5th  percentile (worst):   $${mc.p5.toFixed(2)}`);
    console.log(`  25th percentile:           $${mc.p25.toFixed(2)}`);
    console.log(`  75th percentile:           $${mc.p75.toFixed(2)}`);
    console.log(`  95th percentile (best):    $${mc.p95.toFixed(2)}`);
    console.log(`  Avg max drawdown:          ${mc.avgMaxDrawdown}%`);
    console.log(`  Worst max drawdown:        ${mc.worstMaxDrawdown}%`);
    const luck = mc.probabilityOfProfit < 55 ? '⚠️  High luck component — too few profitable scenarios' : '';
    if (luck) console.log(`\n  ${luck}`);
  }

  // ── Noise injection ──────────────────────────────────────────────────────
  if (noise) {
    console.log('\n\n  3. NOISE INJECTION (fill quality degradation)');
    console.log('  ' + L);
    console.log(`  ${'Slippage Mult'.padEnd(16)} ${'Slip(bps)'.padStart(10)} ${'PF'.padStart(8)} ${'WR%'.padStart(7)} ${'Ret%'.padStart(8)}  Status`);
    console.log('  ' + L);
    for (const r of noise.results) {
      const status = r.profitable ? '✅ Profitable' : '❌ Unprofitable';
      const base   = r.slippageMultiplier === 1 ? ' ← baseline' : '';
      console.log(
        `  ${'×' + r.slippageMultiplier.toFixed(1) + ' slippage'.padEnd(12)} ` +
        `${rpad(r.slippageBps.toFixed(1) + 'bps', 10)} ` +
        `${rpad(r.profitFactor.toFixed(3), 8)} ` +
        `${rpad(r.winRate.toFixed(1), 7)} ` +
        `${rpad(r.totalReturn.toFixed(2), 8)}  ${status}${base}`
      );
    }
    console.log(`\n  Breakeven at: ×${noise.breakevenMultiplier} slippage ` +
      `${noise.breakevenMultiplier >= 2 ? '✅ Good fill tolerance' : noise.breakevenMultiplier >= 1.5 ? '⚠️  Moderate' : '❌ Fragile to bad fills'}`);
  }

  console.log('\n' + EQ + '\n');
}

// ── Full report runner ─────────────────────────────────────────────────────────
function runFullStabilityReport (prices, volumes, opts = {}) {
  console.log('\n[ParamStability] Running sensitivity sweep …');
  const sweep = runSensitivitySweep(prices, volumes, opts);

  console.log('[ParamStability] Running baseline backtest for Monte Carlo …');
  const baseResult = runParamBacktest(prices, volumes, BASELINE);
  const mc = baseResult.trades.length >= 5
    ? runMonteCarlo(baseResult.trades, BASELINE.capital, opts.mcIterations || 1000)
    : null;

  console.log('[ParamStability] Running noise injection …');
  const noise = runNoiseInjection(prices, volumes, opts.slippageMults);

  printStabilityReport(sweep, mc, noise);
  return { sweep, mc, noise, baseMetrics: calcMetrics(baseResult) };
}

module.exports = {
  runFullStabilityReport,
  runSensitivitySweep,
  runMonteCarlo,
  runNoiseInjection,
  runParamBacktest,
  calcMetrics,
  BASELINE,
  PARAM_RANGES,
};

// ── Standalone runner ─────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const BARS = parseInt(process.argv[2] || 1500);
    console.log(`\n${'═'.repeat(72)}`);
    console.log(`  ALADDIN BOT — Parameter Stability Analysis (${BARS} bars)`);
    console.log('═'.repeat(72));
    const { prices, volumes } = _genMarket(BARS, 42);
    runFullStabilityReport(prices, volumes, { seeds: [42, 7919, 31337], mcIterations: 500 });
  })();
}
