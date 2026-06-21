'use strict';
// ── monte-carlo.js ────────────────────────────────────────────────────────────
// Monte Carlo simulation on historical trade sequences.
//
// Method: Bootstrap resampling with replacement.
//   1. Take the list of closed trade returns (profit%).
//   2. Randomly shuffle them N times to simulate N alternate "paths" the equity
//      curve could have taken if trades arrived in a different order.
//   3. For each path compute: final equity, max drawdown, Sharpe, Sortino.
//   4. Report percentile distributions so operators know worst-case risks.
//
// Why it matters:
//   A strategy that makes $500 with a lucky run order might lose $800 in a
//   different order. Monte Carlo exposes this fragility before real capital is at
//   risk, unlike backtesting which only shows one historical path.
//
// Usage:
//   const { MonteCarlo } = require('./monte-carlo');
//   const result = MonteCarlo.run(trades, { simulations: 2000, capital: 10000 });
//   console.log(result.summary);
// ─────────────────────────────────────────────────────────────────────────────

class MonteCarlo {

  // ── Main entry point ───────────────────────────────────────────────────────
  // trades:  array of { profit, profitPercent } (closed trades)
  // opts:
  //   simulations  number of random paths  (default 2000)
  //   capital      starting equity          (default 10 000)
  //   confidence   percentile levels        (default [5, 25, 50, 75, 95])
  //   riskFreeRate daily risk-free rate     (default 0)
  static run(trades, opts = {}) {
    if (!trades || trades.length < 5) {
      return { error: 'Need at least 5 trades for Monte Carlo', simulations: 0, paths: [] };
    }

    const sims      = opts.simulations  || 2000;
    const capital   = opts.capital      || 10_000;
    const levels    = opts.confidence   || [5, 25, 50, 75, 95];
    const rfRate    = opts.riskFreeRate || 0;

    // Extract % returns — use profitPercent if present, otherwise derive from profit/capital
    // Bug fix: NaN profit/profitPercent produced NaN returns that propagated through
    // bootstrap sampling into all path statistics, making finalEquity/sharpe all NaN.
    const returns = trades
      .map(t => {
        if (t.profitPercent != null && isFinite(t.profitPercent)) return t.profitPercent / 100;
        if (t.profit != null && isFinite(t.profit)) return t.profit / capital;
        return null;  // will be filtered
      })
      .filter(r => r !== null && isFinite(r));  // remove NaN/Inf returns

    if (returns.length < 3) {
      return { error: 'Insufficient finite returns after filtering NaN/Infinity', simulations: 0, paths: [] };
    }

    const paths = [];
    for (let s = 0; s < sims; s++) {
      paths.push(MonteCarlo._simulatePath(returns, capital, rfRate));
    }

    return {
      simulations: sims,
      tradeCount:  trades.length,
      capital,
      paths,
      ...MonteCarlo._summarise(paths, levels),
    };
  }


  // ── Block bootstrap (preserves autocorrelation in consecutive trade returns) ──
  // #55: IID bootstrap ignores serial correlation (consecutive losses cluster).
  // Block bootstrap resamples blocks of consecutive trades to preserve structure.
  static runBlockBootstrap(trades, opts = {}) {
    if (!trades || trades.length < 10) return { error: 'Need at least 10 trades', simulations: 0 };
    const sims      = opts.simulations || 2000;
    const capital   = opts.capital     || 10_000;
    const blockSize = opts.blockSize   || 3;  // resample 3-trade blocks
    const levels    = opts.confidence  || [5, 25, 50, 75, 95];

    const returns = trades.map(t =>
      t.profitPercent != null ? t.profitPercent / 100 : (t.profit || 0) / capital
    );

    const paths = [];
    for (let s = 0; s < sims; s++) {
      // Resample in blocks of `blockSize` with replacement
      const resampled = [];
      while (resampled.length < returns.length) {
        const start = Math.floor(Math.random() * (returns.length - blockSize + 1));
        for (let b = 0; b < blockSize && resampled.length < returns.length; b++) {
          resampled.push(returns[start + b]);
        }
      }
      paths.push(MonteCarlo._simulatePath(resampled, capital, opts.riskFreeRate || 0));
    }
    return { simulations: sims, blockSize, tradeCount: trades.length, capital, paths, ...MonteCarlo._summarise(paths, levels) };
  }

  // ── Run a single shuffled path ─────────────────────────────────────────────
  static _simulatePath(returns, startCapital, rfRate) {
    const shuffled = MonteCarlo._shuffle([...returns]);
    let equity     = startCapital;
    let peak       = startCapital;
    let maxDD      = 0;
    const curve    = [startCapital];
    const dailyRet = [];

    for (const r of shuffled) {
      const prev = equity;
      equity     = equity * (1 + r);
      if (equity > peak) peak = equity;
      const dd = (peak - equity) / peak;
      if (dd > maxDD) maxDD = dd;
      curve.push(equity);
      dailyRet.push((equity - prev) / prev);
    }

    const totalReturn = (equity - startCapital) / startCapital;
    const sharpe      = MonteCarlo._sharpe(dailyRet, rfRate);
    const sortino     = MonteCarlo._sortino(dailyRet, rfRate);

    return { finalEquity: equity, totalReturn, maxDrawdown: maxDD, sharpe, sortino, curve };
  }

  // ── Summarise across all paths ─────────────────────────────────────────────
  static _summarise(paths, levels) {
    const finalEquities = paths.map(p => p.finalEquity).sort((a, b) => a - b);
    const maxDrawdowns  = paths.map(p => p.maxDrawdown).sort((a, b) => a - b);
    const sharpes       = paths.map(p => p.sharpe).sort((a, b) => a - b);
    const sortinos      = paths.map(p => p.sortino).sort((a, b) => a - b);
    const totalReturns  = paths.map(p => p.totalReturn).sort((a, b) => a - b);

    const pct = (arr, p) => arr[Math.floor((p / 100) * (arr.length - 1))];

    const pctile = (arr) => {
      const out = {};
      for (const l of levels) out['p' + l] = parseFloat(pct(arr, l).toFixed(6));
      return out;
    };

    const ruinPaths  = paths.filter(p => p.maxDrawdown >= 0.20).length;
    const profitPaths = paths.filter(p => p.totalReturn > 0).length;

    return {
      summary: {
        finalEquity:  pctile(finalEquities),
        maxDrawdown:  pctile(maxDrawdowns),
        sharpe:       pctile(sharpes),
        sortino:      pctile(sortinos),
        totalReturn:  pctile(totalReturns),
        ruinProbability:   parseFloat((ruinPaths  / paths.length * 100).toFixed(2)),
        profitProbability: parseFloat((profitPaths / paths.length * 100).toFixed(2)),
        medianFinalEquity: parseFloat(pct(finalEquities, 50).toFixed(2)),
        worstCaseDrawdown: parseFloat(pct(maxDrawdowns,  95).toFixed(4)),
        bestCaseReturn:    parseFloat(pct(totalReturns,  95).toFixed(4)),
        worstCaseReturn:   parseFloat(pct(totalReturns,   5).toFixed(4)),
      },
    };
  }

  // ── Sharpe ratio on a return series ───────────────────────────────────────
  static _sharpe(returns, rfRate = 0) {
    if (returns.length < 2) return 0;
    const excess = returns.map(r => r - rfRate);
    const mean   = excess.reduce((s, v) => s + v, 0) / excess.length;
    const std    = Math.sqrt(excess.reduce((s, v) => s + (v - mean) ** 2, 0) / excess.length);
    if (std === 0) return 0;
    return parseFloat((mean / std * Math.sqrt(252)).toFixed(4));
  }

  // ── Sortino ratio (downside deviation only) ───────────────────────────────
  static _sortino(returns, rfRate = 0) {
    if (returns.length < 2) return 0;
    const excess   = returns.map(r => r - rfRate);
    const mean     = excess.reduce((s, v) => s + v, 0) / excess.length;
    const downside = excess.filter(r => r < 0);
    if (downside.length === 0) return mean > 0 ? 99 : 0;
    const downsideStd = Math.sqrt(downside.reduce((s, v) => s + v ** 2, 0) / downside.length);
    if (downsideStd === 0) return 0;
    return parseFloat((mean / downsideStd * Math.sqrt(252)).toFixed(4));
  }

  // ── Fisher-Yates shuffle (in-place) ───────────────────────────────────────
  static _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // ── Position sizing: Monte Carlo max position size ─────────────────────────
  // Given a trade history, determine the max safe position size such that the
  // 95th-percentile drawdown stays below maxDrawdownPct (e.g. 0.20 = 20%).
  //
  // Binary-searches position size from 0.001 to 0.10 in 20 iterations.
  static safePositionSize(trades, opts = {}) {
    const maxDD     = opts.maxDrawdownPct || 0.20;
    const sims      = opts.simulations   || 1000;
    const capital   = opts.capital       || 10_000;
    const percentile = opts.percentile   || 95;

    let lo = 0.001, hi = 0.10;
    for (let iter = 0; iter < 20; iter++) {
      const mid     = (lo + hi) / 2;
      const scaled  = trades.map(t => ({
        profitPercent: (t.profitPercent || 0) * mid / (t.positionSize || mid),
      }));
      const result  = MonteCarlo.run(scaled, { simulations: sims, capital });
      const worstDD = result.summary.maxDrawdown['p' + percentile] || 0;
      if (worstDD < maxDD) lo = mid; else hi = mid;
    }
    return parseFloat(((lo + hi) / 2).toFixed(4));
  }
}


// Item #31: Historical crisis scenario loader
class CrisisScenarios {
  static scenarios() {
    return {
      'CHF_UNPEG_2015': { maxDailyMove: 0.20, durationDays: 3, description: '2015 CHF removal of EUR peg — 20% single-day move' },
      'COVID_CRASH_2020': { maxDailyMove: 0.08, durationDays: 20, description: '2020 COVID volatility — sustained 8% daily swings' },
      'GFC_2008': { maxDailyMove: 0.05, durationDays: 90, description: '2008 GFC — 5% daily moves over 90 days' },
      'FLASH_CRASH_2019': { maxDailyMove: 0.04, durationDays: 1, description: '2019 JPY flash crash — 4% in minutes' },
    };
  }

  static stressTest(engine, scenario, prices) {
    const s = this.scenarios()[scenario];
    if (!s) throw new Error('Unknown scenario: ' + scenario);
    const results = [];
    let capital = engine.capital;
    for (let d = 0; d < Math.min(s.durationDays, 20); d++) {
      const move = (Math.random() < 0.5 ? 1 : -1) * s.maxDailyMove * (0.5 + Math.random() * 0.5);
      capital *= (1 + move);
      if (engine.position) capital += engine.position.shares * prices.at(-1) * move;
      results.push({ day: d, capital: parseFloat(capital.toFixed(2)), move: (move*100).toFixed(2)+'%' });
    }
    return { scenario, description: s.description, results, minCapital: Math.min(...results.map(r=>r.capital)) };
  }
}

// Item 12: Expected Shortfall stress test under elevated crisis volatility
function stressTestES(trades, capital, crisisVolMultiplier = 3.0) {
  if (!trades || trades.length < 10) return null;
  const returns = trades.map(t => (t.profitPercent||0) / 100);
  // Scale returns by crisis vol multiplier (simulate 3× normal volatility)
  const stressed = returns.map(r => r * crisisVolMultiplier);
  stressed.sort((a,b) => a-b);
  const confLevel = 0.95;
  const cutoff    = Math.floor(stressed.length * (1 - confLevel));
  const tailLosses = stressed.slice(0, cutoff);
  const ES        = tailLosses.length > 0
    ? -tailLosses.reduce((s,v)=>s+v,0) / tailLosses.length
    : 0;
  const dollarES  = ES * capital;
  return {
    ES_pct:        parseFloat((ES*100).toFixed(2)),
    ES_dollar:     parseFloat(dollarES.toFixed(2)),
    crisisVolMult: crisisVolMultiplier,
    confLevel:     confLevel,
    tailObs:       tailLosses.length,
    interpretation: dollarES > capital * 0.20
      ? `CRITICAL: Stressed ES $${dollarES.toFixed(0)} = ${(ES*100).toFixed(1)}% of capital — reduce size`
      : `OK: Stressed ES $${dollarES.toFixed(0)} = ${(ES*100).toFixed(1)}% of capital`,
  };
}

// Item 100: Bootstrap confidence intervals for Sharpe ratio
// Uses block bootstrap to account for autocorrelation in returns
function bootstrapSharpeCI(returns, nBootstrap=1000, blockSize=10, confidenceLevel=0.95) {
  if (!returns || returns.length < 20) return null;
  const n = returns.length;
  const sharpe = (rets) => {
    const mean = rets.reduce((s,v)=>s+v,0)/rets.length;
    const std  = Math.sqrt(rets.reduce((s,v)=>s+(v-mean)**2,0)/rets.length) || 1e-9;
    return mean / std * Math.sqrt(252);
  };
  const observed = sharpe(returns);
  // Block bootstrap: sample blocks of consecutive returns
  const bootstrapSharpes = [];
  for (let b = 0; b < nBootstrap; b++) {
    const sample = [];
    while (sample.length < n) {
      const start = Math.floor(Math.random() * (n - blockSize + 1));
      sample.push(...returns.slice(start, start + blockSize));
    }
    bootstrapSharpes.push(sharpe(sample.slice(0, n)));
  }
  bootstrapSharpes.sort((a,b)=>a-b);
  const alpha  = 1 - confidenceLevel;
  const lower  = bootstrapSharpes[Math.floor(alpha/2 * nBootstrap)];
  const upper  = bootstrapSharpes[Math.floor((1-alpha/2) * nBootstrap)];
  return {
    observed:   parseFloat(observed.toFixed(4)),
    lower:      parseFloat(lower.toFixed(4)),
    upper:      parseFloat(upper.toFixed(4)),
    ci:         `[${lower.toFixed(2)}, ${upper.toFixed(2)}]`,
    confidence: confidenceLevel,
    n:          n,
    significant: lower > 0,  // CI entirely above 0 → statistically significant positive Sharpe
  };
}

module.exports = { MonteCarlo, CrisisScenarios, stressTestES, bootstrapSharpeCI };
