
// #80: CSV import for real broker OANDA history data
function loadCsvHistory(csvPath) {
  const fs   = require('fs');
  const path = require('path');
  if (!fs.existsSync(csvPath)) {
    console.warn('[Backtest] CSV file not found: ' + csvPath);
    return null;
  }
  const lines  = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
  const header = lines[0].toLowerCase().split(',');
  const closeIdx  = header.findIndex(h => h.includes('close'));
  const highIdx   = header.findIndex(h => h.includes('high'));
  const lowIdx    = header.findIndex(h => h.includes('low'));
  const volIdx    = header.findIndex(h => h.includes('vol'));
  if (closeIdx < 0) { console.warn('[Backtest] CSV has no close column'); return null; }
  const prices = [], volumes = [];
  for (let i = 1; i < lines.length; i++) {
    const cols  = lines[i].split(',');
    const close = parseFloat(cols[closeIdx]);
    const vol   = volIdx >= 0 ? parseInt(cols[volIdx]) : 1_000_000;
    if (isFinite(close) && close > 0) { prices.push(close); volumes.push(vol); }
  }
  console.log('[Backtest] Loaded ' + prices.length + ' bars from ' + path.basename(csvPath));
  return { prices, volumes, source: 'csv:' + path.basename(csvPath) };
}

/**
 * HISTORICAL M5 BACKTESTING ENGINE
 *
 * Runs AladdinTradingAgent logic against 1 year of M5 (5-minute) data.
 * Calculates Profit Factor, Expectancy, Sharpe Ratio, and other
 * professional metrics to determine live-trade readiness.
 *
 * 1 year M5 = ~75,000 candles (252 days × ~288 candles/day excl. weekends)
 */

const {
  TradingEngine, Indicators, KellyCriterion,
  CorrelationEngine, MultiTimeframeAnalyzer,
  TRADING_CONFIG
} = require('./trading-engine');

// ══════════════════════════════════════════════════════════════════════════
// 1-YEAR M5 DATA GENERATOR
// Synthetic but statistically realistic: real FX pairs typically have
// daily σ ~0.5-1.0%, 252 trading days/year, 288 M5 candles/day.
// We model Geometric Brownian Motion + occasional regime shifts + news spikes.
// ══════════════════════════════════════════════════════════════════════════
function generate1YearM5(startPrice = 1.0850, seed = 42) {
  const CANDLES_PER_DAY = 288;     // 24h × 12 candles/hr
  const TRADING_DAYS    = 252;
  const TOTAL           = CANDLES_PER_DAY * TRADING_DAYS; // ~72,576

  // Deterministic RNG — xorshift128 with period 2^128-1 (replaces LCG with period 233,280)
  let [a, b, c, d] = [seed | 1, seed ^ 0xDEAD, seed * 7 | 3, seed + 0xCAFE];
  const rng = () => {
    let t = b << 9;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t;
    d = (d << 11) | (d >>> 21);  // rotate left 11
    return ((a >>> 0) / 4294967296);
  };
  const randN = () => {
    // Box-Muller transform for normal distribution
    const u1 = rng() || 0.0001;
    const u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  const prices  = [startPrice];
  const volumes = [1000000];
  const dailySigma = 0.007;                            // ~0.7% daily vol
  const sigmaPerBar = dailySigma / Math.sqrt(CANDLES_PER_DAY);
  const muPerBar    = 0.00001;                         // tiny positive drift (realistic long-term)

  let regime = 'normal'; // normal | trend_up | trend_down | high_vol
  let regimeDuration = 0;

  for (let i = 1; i < TOTAL; i++) {
    // Change regime every ~5-20 days
    if (regimeDuration <= 0) {
      const r = rng();
      regime = r < 0.50 ? 'normal' : r < 0.70 ? 'trend_up' : r < 0.85 ? 'trend_down' : 'high_vol';
      regimeDuration = Math.floor(5 + rng() * 15) * CANDLES_PER_DAY;
    }
    regimeDuration--;

    let drift = muPerBar;
    let vol   = sigmaPerBar;
    if (regime === 'trend_up')   drift += 0.00003;
    if (regime === 'trend_down') drift -= 0.00003;
    if (regime === 'high_vol')   vol   *= 2;

    // Occasional news spike (~0.1% chance)
    const spike = rng() < 0.001 ? (rng() - 0.5) * 0.005 : 0;

    const ret   = drift + vol * randN() + spike;
    const price = Math.max(0.5, prices[i-1] * (1 + ret));
    prices.push(price);

    // Volume: higher in high_vol regime, spikes on news
    const baseVol = regime === 'high_vol' ? 2000000 : 1000000;
    const noise   = 1 + (rng() - 0.5) * 0.5;
    volumes.push(Math.floor(baseVol * noise * (spike !== 0 ? 5 : 1)));
  }

  return { prices, volumes };
}

// ══════════════════════════════════════════════════════════════════════════
// BACKTEST HARNESS
// Feeds prices bar-by-bar into the real TradingEngine and records every trade
// ══════════════════════════════════════════════════════════════════════════
async function runHistoricalBacktest({ prices, volumes }) {
  const engine = new TradingEngine();
  // Item #27: Size-scaled slippage model — larger positions have higher market impact
  // slippage = base_slippage * (1 + size_factor) where size_factor = posSize / avgVolume
  function sizeScaledSlippage(positionValue, avgVolume) {
    const baseSlip  = TRADING_CONFIG.slippage || 0.0005;
    const volDollars = avgVolume * 1.08;  // approximate volume in price units
    const sizeFactor = volDollars > 0 ? Math.min(2.0, positionValue / volDollars) : 0;
    return baseSlip * (1 + sizeFactor * 0.5);  // max 1.5× base slippage
  }

  // 11.3: Filter known FX intervention events from backtest data
  {
    try {
      const { CorporateActions } = require('./corporate-actions');
      const ca = new CorporateActions();
      const extremes = ca.detectExtremes(prices, 5.0);
      if (extremes.length > 0) {
        console.log(`[Backtest #11.3] Found ${extremes.length} extreme bars (>5% move) in price series — verify data quality`);
      }
    } catch(_) {}
  }
  // Item 51: Event-driven mode flag — when enabled, reconstructs ticks for finer simulation
  const _tickByTick = TRADING_CONFIG.backtestTickByTick || false;
  if (_tickByTick) {
    try {
      const { reconstructSeries } = require('./tick-reconstruction');
      const _ohlcvBars = prices.map((p,i)=>({ o:p, h:p*(1+0.0002), l:p*(1-0.0002), c:p, v:volumes[i]||1e6 }));
      const _ticks = reconstructSeries(_ohlcvBars, 4);
      console.log(`[Backtest #51] Tick mode: ${_ticks.length} synthetic ticks from ${prices.length} bars`);
    } catch(_) {}
  }
  // B11: Reset ALL engine state — consecutive losses/wins from prior fold
  // corrupt Kelly sizing in subsequent folds if not cleared
  engine.trades             = [];
  engine.wins               = 0;
  engine.losses             = 0;
  engine.consecutiveLosses  = 0;
  engine.consecutiveWins    = 0;
  engine.capital            = 10000;
  engine.initialCapital     = 10000;
  engine.dailyStartCapital  = 10000;
  engine.priceHistory       = [];
  engine.volumeHistory      = [];
  engine.ohlcvHistory       = [];
  engine.circuitBreakerTripped = false;
  engine.globalHaltTripped  = false;
  engine.position           = null;
  engine._tpCooldownUntil   = 0;
  engine._lastOandaDay      = null;
  // Apply spread cost to fills (mirrors backtest-nightly.js SPREAD_HALF model)
  const SPREAD_HALF = TRADING_CONFIG.backtestSpreadHalf || 0.0001;  // 1 pip default
  engine.dynamicSlippage = SPREAD_HALF * 2;  // entry + exit crossing cost

  const equity = [];
  let peak = 10000;
  let maxDrawdown = 0;
  let maxDrawdownBar = 0;
  const dailyReturns = [];
  let lastDayCapital = 10000;

  const CANDLES_PER_DAY = 288;
  const WARMUP_BARS     = 100; // need history for indicators + MTA

  // Progress tracking
  const PROGRESS_INTERVAL = Math.floor(prices.length / 10);

  for (let i = 0; i < prices.length; i++) {
    engine.priceHistory.push(prices[i]);
    engine.volumeHistory.push(volumes[i]);

    // Bounded history (memory safe)
    if (engine.priceHistory.length > TRADING_CONFIG.maxHistoryLength * 2) {
      engine.priceHistory = engine.priceHistory.slice(-TRADING_CONFIG.maxHistoryLength);
      engine.volumeHistory = engine.volumeHistory.slice(-TRADING_CONFIG.maxHistoryLength);
    }

    if (i < WARMUP_BARS) {
      equity.push(engine.capital);
      continue;
    }

    // Reset daily capital every 288 bars (new trading day)
    if (i > 0 && i % CANDLES_PER_DAY === 0) {
      const todayReturn = (engine.capital - lastDayCapital) / lastDayCapital;
      dailyReturns.push(todayReturn);
      lastDayCapital = engine.capital;
      engine.dailyStartCapital = engine.capital;
      // Reset circuit breaker for new day
      engine.circuitBreakerTripped = false;
    }

    // ── Feature #1: Apply overnight swap cost in backtest ────────────────
    // Each new day boundary simulates the 22:00 UTC rollover.
    // Wednesday (every 3rd day-boundary in a 5-day week) applies 3× rate.
    if (engine.position && i > 0 && i % CANDLES_PER_DAY === 0) {
      const swapTable = TRADING_CONFIG.swapCosts || {};
      const assetSwap = swapTable[engine.selectedAsset];
      if (assetSwap) {
        const isShortSwap = engine.position.side === 'SHORT';
        const swapRate    = isShortSwap ? assetSwap.short : assetSwap.long;
        // Bar index modulo 5-day week → day 2 (0-based) = Wednesday
        const dayInWeek   = Math.floor(i / CANDLES_PER_DAY) % 5;
        const multiplier  = dayInWeek === 2 ? 3 : 1;
        const positionVal = engine.position.shares * prices[i];
        const swapCost    = positionVal * swapRate * multiplier;
        engine.capital   += swapCost;   // negative = deducted
        if (engine.capital < 1) engine.capital = 1;
      }
    }

    // Risk management (stops, trailing, CB)
    engine.checkRiskManagement();

    if (engine.circuitBreakerTripped) {
      equity.push(engine.capital);
      continue;
    }

    // Decision
    const indicators = await engine.calculateIndicators();
    // Item 91: Regime-conditional backtesting — route to correct strategy per regime
    // Trend strategy tested only on TRENDING bars, MeanReversion on RANGING, etc.
    const _strategyRegimeMap91 = {
      trend:       ['TRENDING','STRONG_TREND'],
      meanReversion:['RANGING','MEAN_REVERT'],
      breakout:    ['STRONG_TREND','TRENDING'],
    };
    const _activeStrategy91 = TRADING_CONFIG.backtestStrategyFilter;
    const _requiredRegimes91 = _activeStrategy91 ? (_strategyRegimeMap91[_activeStrategy91]||[]) : [];
    // Item 11: Regime-aware walk-forward — filter training data to current regime only
    // When backtestRegimeAware=true, only bars matching the dominant recent regime are used
    let _regimeFilteredPrices = prices, _regimeFilteredVols = volumes;
    if (TRADING_CONFIG.backtestRegimeAware && prices.length >= 50) {
      try {
        const { HMMRegime } = require('./hmm-regime');
        const _hmm11 = new HMMRegime();
        // Detect dominant regime in last 50 bars
        const _states = prices.slice(-50).map((p,i,a) => {
          if (i===0) return null;
          const _ret = (p-a[i-1])/a[i-1];
          return _hmm11.update({ adx:20, atrPct:Math.abs(_ret)*100, volRatio:1, rsi:50, spreadRatio:1 }).state;
        }).filter(Boolean);
        const _dominant = _states.reduce((acc,s) => { acc[s]=(acc[s]||0)+1; return acc; }, {});
        const _target   = parseInt(Object.entries(_dominant).sort((a,b)=>b[1]-a[1])[0][0]);
        // Replay and keep only bars matching dominant regime
        const _hmm2 = new HMMRegime();
        const _mask = prices.map((p,i,a) => {
          if (i===0) return true;
          const s = _hmm2.update({ adx:20, atrPct:Math.abs((p-a[i-1])/a[i-1])*100, volRatio:1, rsi:50, spreadRatio:1 }).state;
          return s === _target;
        });
        const _fp = prices.filter((_,i)=>_mask[i]);
        const _fv = volumes.filter((_,i)=>_mask[i]);
        if (_fp.length >= 50) { _regimeFilteredPrices=_fp; _regimeFilteredVols=_fv; }
      } catch(_) {}
    }
    // Item 49: Overnight financing/swap cost applied when position held past rollover (17:00 NY / 22:00 UTC)
    if (engine.position && TRADING_CONFIG.backtestSwapEnabled) {
      const _barH = new Date(Date.now() - (prices.length - i - 1) * (TRADING_CONFIG.tradingInterval||30000)).getUTCHours();
      if (_barH === 22) {  // OANDA rollover at 22:00 UTC
        const _swaps = TRADING_CONFIG.swapCosts || {};
        const _swap  = _swaps[engine.selectedAsset];
        if (_swap) {
          const _isLong   = engine.position.side !== 'SHORT';
          const _swapRate = _isLong ? (_swap.long||0) : (_swap.short||0);
          const _swapCost = engine.position.shares * (prices[i]||1) * Math.abs(_swapRate) / 365;
          engine.capital -= _swapCost;
          if (_swapCost !== 0) engine.log?.(`[Backtest #49] Swap: $${_swapCost.toFixed(4)}`);
        }
      }
    }
    // Item 34: Margin call simulation — liquidate if margin level drops below 50%
    if (TRADING_CONFIG.backtestMarginSimulation && engine.position) {
      const _leverage34 = TRADING_CONFIG.oandaLeverage || 50;
      const _notional34 = engine.position.shares * (prices[i]||1);
      const _margin34   = _notional34 / _leverage34;
      const _marginLvl  = engine.capital / Math.max(_margin34, 1);
      const _stopout    = TRADING_CONFIG.oandaMarginStopout || 0.5;
      if (_marginLvl < _stopout) {
        console.log(`[Backtest #34] Margin call at bar ${i}: level=${_marginLvl.toFixed(2)}`);
        await engine.exitPosition(prices[i], 'MarginCall');
      }
    }
    // Item #28: Regime-conditional backtest — optionally skip bars not matching target regime
    if (TRADING_CONFIG.backtestRegimeFilter) {
      const regime = indicators?.adxRegime || indicators?.marketRegime || 'UNKNOWN';
      if (regime !== TRADING_CONFIG.backtestRegimeFilter) {
        equity.push(engine.capital); continue;
      }
    }
    if (!indicators) { equity.push(engine.capital); continue; }
    const decision = engine.getRuleBasedDecision(indicators);

    // Fix #13: 1-bar look-ahead bias fix.
    // Signal fires at bar CLOSE; real fill happens at next bar OPEN.
    // If there is a next bar, use its price as fill price to eliminate look-ahead.
    if (TRADING_CONFIG.backtestUseNextBarFill !== false && i + 1 < prices.length) {
      const nextBarPrice = prices[i + 1];
      if (decision.action === 'BUY' && nextBarPrice > 0) {
        const origFetch = engine.marketData?.fetchPrice?.bind(engine.marketData);
        if (engine.marketData) engine.marketData.fetchPrice = () => ({ price: nextBarPrice, bid: nextBarPrice - 0.0001, ask: nextBarPrice + 0.0001, volume: volumes[i+1]||1 });
        engine.executeDecision(decision);
        if (engine.marketData && origFetch) engine.marketData.fetchPrice = origFetch;
      } else {
        engine.executeDecision(decision);
      }
    } else {
      engine.executeDecision(decision);
    }

    // Equity tracking
    const totalValue = engine.capital +
      (engine.position ? engine.position.shares * prices[i] : 0);
    if (totalValue > peak) peak = totalValue;
    const dd = (peak - totalValue) / peak;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownBar = i;
    }
    equity.push(totalValue);

    // Progress
    if (i % PROGRESS_INTERVAL === 0) {
      const pct = Math.floor((i / prices.length) * 100);
      process.stdout.write(`\r  Progress: ${pct}%  |  Capital: $${engine.capital.toFixed(2)}  |  Trades: ${engine.trades.length}  `);
    }
  }

  process.stdout.write('\r  Progress: 100% — complete                                    \n');

  // Force close any open position
  if (engine.position) {
    engine.exitPosition(prices[prices.length - 1], 'EndOfBacktest');
  }

  return { engine, equity, maxDrawdown, maxDrawdownBar, dailyReturns };
}

// ══════════════════════════════════════════════════════════════════════════
// PROFESSIONAL METRICS CALCULATION
// ══════════════════════════════════════════════════════════════════════════
function calculateMetrics(engine, equity, maxDrawdown, dailyReturns) {
  const trades = engine.trades;
  const wins   = trades.filter(t => t.profit > 0);
  const losses = trades.filter(t => t.profit <= 0);

  // Profit Factor = gross profit / gross loss
  const grossProfit = wins.reduce((s, t) => s + t.profit, 0);
  const grossLoss   = Math.abs(losses.reduce((s, t) => s + t.profit, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);

  // Expectancy = (avgWin × winRate) − (avgLoss × lossRate)
  const winRate  = trades.length > 0 ? wins.length   / trades.length : 0;
  const lossRate = trades.length > 0 ? losses.length / trades.length : 0;
  const avgWin   = wins.length   > 0 ? grossProfit / wins.length   : 0;
  const avgLoss  = losses.length > 0 ? grossLoss   / losses.length : 0;
  const expectancy = (avgWin * winRate) - (avgLoss * lossRate);

  // R-Multiple expectancy (per-dollar-risked)
  const avgRisk = trades.reduce((s, t) => {
    // Risk = entry × stopLoss distance × shares, approximated as |avgLoss|
    return s + (t.profit < 0 ? Math.abs(t.profit) : avgLoss || 1);
  }, 0) / (trades.length || 1);
  const rExpectancy = avgRisk > 0 ? expectancy / avgRisk : 0;

  // Sharpe Ratio (annualised, risk-free rate assumed 0)
  const avgDailyReturn = dailyReturns.reduce((s, r) => s + r, 0) / (dailyReturns.length || 1);
  const stdDev = Math.sqrt(dailyReturns.reduce((s, r) => s + Math.pow(r - avgDailyReturn, 2), 0) / (dailyReturns.length || 1));
  const sharpe = stdDev > 0 ? (avgDailyReturn / stdDev) * Math.sqrt(252) : 0;

  // Total return
  const totalReturn = ((engine.capital - 10000) / 10000) * 100;

  // Max consecutive wins/losses
  let maxConsecWin = 0, maxConsecLoss = 0, curWin = 0, curLoss = 0;
  for (const t of trades) {
    if (t.profit > 0) { curWin++; curLoss = 0; maxConsecWin = Math.max(maxConsecWin, curWin); }
    else              { curLoss++; curWin = 0; maxConsecLoss = Math.max(maxConsecLoss, curLoss); }
  }

  // Recovery Factor (profit / max drawdown in dollars)
  const ddDollars = 10000 * maxDrawdown;
  const recoveryFactor = ddDollars > 0 ? (engine.capital - 10000) / ddDollars : 0;

  // Trades by exit reason
  const tradesByReason = {};
  for (const t of trades) {
    const r = t.reason || 'Unknown';
    tradesByReason[r] = (tradesByReason[r] || 0) + 1;
  }

  return {
    totalTrades:   trades.length,
    wins:          wins.length,
    losses:        losses.length,
    winRate:       winRate * 100,
    avgWin, avgLoss,
    grossProfit, grossLoss,
    profitFactor,
    expectancy,
    rExpectancy,
    sharpe,
    totalReturn,
    maxDrawdown:   maxDrawdown * 100,
    maxConsecWin,
    maxConsecLoss,
    recoveryFactor,
    finalCapital:  engine.capital,
    tradesByReason,
    tradingDays:   dailyReturns.length,
    avgTradesPerDay: dailyReturns.length > 0 ? trades.length / dailyReturns.length : 0,
  };
}

// ══════════════════════════════════════════════════════════════════════════
// REPORT FORMATTING
// ══════════════════════════════════════════════════════════════════════════
function printReport(metrics) {
  const fmt = (v, d = 2) => typeof v === 'number' ? v.toFixed(d) : v;
  const pad = (s, n) => String(s).padEnd(n);

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  BACKTEST RESULTS — 1 YEAR M5 DATA');
  console.log('════════════════════════════════════════════════════════════\n');

  console.log('  📊 PROFITABILITY');
  console.log('  ' + '─'.repeat(58));
  console.log(`  ${pad('Final Capital', 24)}  $${fmt(metrics.finalCapital)}`);
  console.log(`  ${pad('Total Return', 24)}  ${fmt(metrics.totalReturn)}%`);
  console.log(`  ${pad('Gross Profit', 24)}  $${fmt(metrics.grossProfit)}`);
  console.log(`  ${pad('Gross Loss', 24)}  $${fmt(metrics.grossLoss)}`);

  console.log('\n  🎯 CORE METRICS');
  console.log('  ' + '─'.repeat(58));
  console.log(`  ${pad('Profit Factor', 24)}  ${fmt(metrics.profitFactor, 3)}`);
  console.log(`  ${pad('Expectancy per trade', 24)}  $${fmt(metrics.expectancy)}`);
  console.log(`  ${pad('R-Expectancy (per $R)', 24)}  ${fmt(metrics.rExpectancy, 3)}R`);
  console.log(`  ${pad('Sharpe Ratio (ann.)', 24)}  ${fmt(metrics.sharpe, 3)}`);
  console.log(`  ${pad('Recovery Factor', 24)}  ${fmt(metrics.recoveryFactor, 3)}`);

  console.log('\n  📈 TRADE STATISTICS');
  console.log('  ' + '─'.repeat(58));
  console.log(`  ${pad('Total Trades', 24)}  ${metrics.totalTrades}`);
  console.log(`  ${pad('Wins', 24)}  ${metrics.wins}`);
  console.log(`  ${pad('Losses', 24)}  ${metrics.losses}`);
  console.log(`  ${pad('Win Rate', 24)}  ${fmt(metrics.winRate)}%`);
  console.log(`  ${pad('Avg Win', 24)}  $${fmt(metrics.avgWin)}`);
  console.log(`  ${pad('Avg Loss', 24)}  $${fmt(metrics.avgLoss)}`);
  console.log(`  ${pad('Max Consecutive Wins', 24)}  ${metrics.maxConsecWin}`);
  console.log(`  ${pad('Max Consecutive Losses', 24)}  ${metrics.maxConsecLoss}`);
  console.log(`  ${pad('Avg Trades/Day', 24)}  ${fmt(metrics.avgTradesPerDay)}`);

  console.log('\n  ⚠️  RISK METRICS');
  console.log('  ' + '─'.repeat(58));
  console.log(`  ${pad('Max Drawdown', 24)}  ${fmt(metrics.maxDrawdown)}%`);
  console.log(`  ${pad('Trading Days Tested', 24)}  ${metrics.tradingDays}`);

  console.log('\n  📋 TRADES BY EXIT REASON');
  console.log('  ' + '─'.repeat(58));
  const sortedReasons = Object.entries(metrics.tradesByReason).sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of sortedReasons) {
    const pct = (count / metrics.totalTrades) * 100;
    console.log(`  ${pad(reason, 24)}  ${String(count).padStart(4)}  (${fmt(pct)}%)`);
  }
}

// ══════════════════════════════════════════════════════════════════════════
// LIVE TRADING READINESS VERDICT
// ══════════════════════════════════════════════════════════════════════════
function verdict(metrics) {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  🏆 LIVE TRADING READINESS VERDICT');
  console.log('════════════════════════════════════════════════════════════\n');

  const checks = [
    {
      name: 'Profit Factor > 1.0 (more profit than loss)',
      pass: metrics.profitFactor > 1.0,
      value: metrics.profitFactor.toFixed(3),
      critical: true,
    },
    {
      name: 'Profit Factor > 1.5 (professional threshold)',
      pass: metrics.profitFactor > 1.5,
      value: metrics.profitFactor.toFixed(3),
      critical: false,
    },
    {
      name: 'Expectancy > $0 per trade',
      pass: metrics.expectancy > 0,
      value: `$${metrics.expectancy.toFixed(2)}`,
      critical: true,
    },
    {
      name: 'Max Drawdown < 20%',
      pass: metrics.maxDrawdown < 20,
      value: `${metrics.maxDrawdown.toFixed(2)}%`,
      critical: true,
    },
    {
      name: 'Sharpe Ratio > 0.5 (decent risk-adjusted return)',
      pass: metrics.sharpe > 0.5,
      value: metrics.sharpe.toFixed(3),
      critical: false,
    },
    {
      name: 'Win Rate > 35%',
      pass: metrics.winRate > 35,
      value: `${metrics.winRate.toFixed(1)}%`,
      critical: false,
    },
    {
      name: 'Sufficient trade sample (>100 trades)',
      pass: metrics.totalTrades > 100,
      value: metrics.totalTrades,
      critical: true,
    },
    {
      name: 'Max Consecutive Losses < 10',
      pass: metrics.maxConsecLoss < 10,
      value: metrics.maxConsecLoss,
      critical: false,
    },
  ];

  const critical = checks.filter(c => c.critical);
  const passed   = checks.filter(c => c.pass).length;
  const critPassed = critical.filter(c => c.pass).length;

  for (const c of checks) {
    const icon = c.pass ? '✅' : '❌';
    const tag  = c.critical ? '[CRITICAL]' : '[OPTIONAL]';
    console.log(`  ${icon} ${tag} ${c.name.padEnd(48)} ${c.value}`);
  }

  console.log('\n  ' + '─'.repeat(58));
  console.log(`  Total: ${passed}/${checks.length} checks passed`);
  console.log(`  Critical: ${critPassed}/${critical.length} critical checks passed`);

  console.log('\n  ' + '═'.repeat(58));
  if (critPassed === critical.length && metrics.profitFactor >= 1.5) {
    console.log('  🎉 VERDICT: READY FOR LIVE TRADING');
    console.log('     All critical metrics pass. Consider paper-trading first.');
  } else if (critPassed === critical.length) {
    console.log('  ⚠️  VERDICT: MARGINAL — NEEDS MORE OPTIMISATION');
    console.log('     Critical checks pass but Profit Factor below 1.5.');
    console.log('     Consider tuning strategy before live deployment.');
  } else {
    console.log('  🛑 VERDICT: NOT READY FOR LIVE TRADING');
    console.log(`     ${critical.length - critPassed} critical check(s) failed.`);
    console.log('     The strategy needs refinement before risking real capital.');
  }
  console.log('  ' + '═'.repeat(58));
}

// ══════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════
(async () => {
console.log('\n════════════════════════════════════════════════════════════');
console.log('  HISTORICAL BACKTESTING ENGINE');
console.log('  AladdinTradingAgent × 1 Year M5 Data');
console.log('════════════════════════════════════════════════════════════\n');

// ── Feature #5: Try real CSV first, fall back to synthetic ───────────────
let prices, volumes;
const csvArg = process.argv.find(a => a.endsWith('.csv')) ||
               process.argv.find(a => a.startsWith('--csv='))?.split('=')[1];
const csvPath = csvArg || process.env.BACKTEST_CSV;

if (csvPath) {
  const csvData = loadCsvHistory(csvPath);
  if (csvData && csvData.prices.length > 200) {
    prices  = csvData.prices;
    volumes = csvData.volumes;
    console.log(`  ✓ Loaded ${prices.length.toLocaleString()} candles from ${require('path').basename(csvPath)}`);
  } else {
    console.warn('  ⚠️  CSV load failed or too short — falling back to synthetic data');
  }
}

if (!prices) {
  console.log('  Generating 1 year M5 data (252 days × 288 candles)...');
  ({ prices, volumes } = generate1YearM5(1.0850, 42));
  console.log(`  ✓ Generated ${prices.length.toLocaleString()} candles (synthetic)`);
}

console.log(`  ✓ Price range: ${Math.min(...prices).toFixed(4)} → ${Math.max(...prices).toFixed(4)}`);
console.log(`  ✓ Starting price: ${prices[0].toFixed(4)}`);
console.log(`  ✓ Ending price: ${prices[prices.length-1].toFixed(4)}\n`);

console.log('  Running AladdinTradingAgent through all candles...');
console.time('  Backtest duration');
const result = await runHistoricalBacktest({ prices, volumes });
console.timeEnd('  Backtest duration');

const metrics = calculateMetrics(result.engine, result.equity, result.maxDrawdown, result.dailyReturns);

printReport(metrics);
verdict(metrics);

console.log();
})().catch(err => { console.error('Backtest failed:', err); process.exit(1); });
