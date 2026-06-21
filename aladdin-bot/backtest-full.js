'use strict';
// ── backtest-full.js (patched: items 54-65 — console.log → structured logger)
// ── backtest-full.js ──────────────────────────────────────────────────────────
// Full backtest suite: runs historical backtest + period slicer + Monte Carlo
// in one pass and writes a combined report to trade_logs/backtest-full.json.
//
// Usage:
//   node backtest-full.js [--asset EURUSD] [--bars 72000] [--sims 2000]
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const logger = require('./structured-logger');

const fs   = require('fs');
const path = require('path');

const args     = process.argv.slice(2);
const asset    = args[args.indexOf('--asset') + 1]  || 'EURUSD';
const bars     = parseInt(args[args.indexOf('--bars') + 1]) || 5000;
const sims     = parseInt(args[args.indexOf('--sims') + 1]) || 1000;

logger.info('backtest-full', { msg: `${asset} | ${bars} bars | ${sims} Monte Carlo sims` });

// ── Run historical backtest ────────────────────────────────────────────────────
const { SharedSignalAdapter } = require('./shared-signal-adapter');
const { PeriodSlicer }        = require('./period-slicer');
const { MonteCarlo }          = require('./monte-carlo');

// Generate synthetic candles (or load from CSV if available)
function generateCandles(n, asset) {
  let price = asset === 'USDJPY' ? 150.0 : asset.startsWith('GBP') ? 1.25 : 1.1050;
  const candles = [];
  let s = 42; // deterministic seed
  const rng = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 - 0.5; };
  for (let i = 0; i < n; i++) {
    const drift = 0.00001, vol = 0.0006;
    price = Math.max(0.1, price * (1 + drift + rng() * vol));
    candles.push({
      time:   Date.now() - (n - i) * 300_000,
      open:   price, high: price * 1.0003,
      low:    price * 0.9997, close: price,
      volume: 800 + Math.abs(rng()) * 500,
    });
  }
  return candles;
}

const candles = generateCandles(bars, asset);

// ── 1. Full historical backtest ────────────────────────────────────────────────
logger.info('backtest-full', { msg: 'Running historical backtest...' });
const adapter   = new SharedSignalAdapter('trend');
const btResult  = adapter.backtest(candles, { capital: 10000, asset });

logger.info('backtest-full', { msg: `  Trades: ${btResult.tradeCount}  WinRate: ${btResult.winRate}%  Return: ${btResult.totalReturn}%` });

// ── 2. Period-sliced backtest ──────────────────────────────────────────────────
logger.info('backtest-full', { msg: 'Running period-sliced backtest...' });
const slicer = new PeriodSlicer({ minSliceBars: 50 });
const slices = slicer.slice(candles);
const sliceResults = [];

for (const slice of slices) {
  const sliceAdapter = new SharedSignalAdapter('trend');
  const sliceResult  = sliceAdapter.backtest(slice.candles, { capital: 10000, asset });
  sliceResults.push({
    regime:      slice.regime,
    bars:        slice.bars,
    summary:     slice.summary,
    backtest:    sliceResult,
  });
  logger.info('backtest-full', { msg: `  ${slice.regime.padEnd(10)} | ${slice.bars} bars | trades=${sliceResult.tradeCount} winRate=${sliceResult.winRate}% return=${sliceResult.totalReturn}%` });
}

// ── 3. Monte Carlo on trade sequence ──────────────────────────────────────────
if (btResult.trades.length >= 5) {
  logger.info('backtest-full', { msg: 'Running Monte Carlo simulation...' });
  const mcResult  = MonteCarlo.run(btResult.trades, { simulations: sims, capital: 10000 });
  const mc        = mcResult.summary;
  logger.info('backtest-full', { msg: `  Ruin prob: ${mc.ruinProbability}%  Profit prob: ${mc.profitProbability}%` });
  logger.info('backtest-full', { msg: `  Worst-case drawdown (p95): ${(mc.worstCaseDrawdown * 100).toFixed(1)}%` });
  logger.info('backtest-full', { msg: `  Median final equity: $${mc.medianFinalEquity}` });

  const report = {
    asset, bars, sims,
    historical: btResult,
    sliced:     sliceResults,
    monteCarlo: mc,
    generatedAt: new Date().toISOString(),
  };

  const outFile = path.join(__dirname, 'trade_logs', 'backtest-full.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  logger.info('backtest-full', { msg: `Report saved to ${outFile}` });
} else {
  logger.info('backtest-full', { msg: 'Too few trades for Monte Carlo — skipping' });
}

logger.info('backtest-full', { msg: 'Done' });
