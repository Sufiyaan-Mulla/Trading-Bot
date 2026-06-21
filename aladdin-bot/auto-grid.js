'use strict';
// ── auto-grid.js ──────────────────────────────────────────────────────────────
// Automated nightly grid search — runs after backtest-nightly.js produces
// fresh trade data, then applies improved params if they pass validation.
//
// Designed to be called from PM2 cron or a nightly cron job:
//   0 3 * * * node /path/to/auto-grid.js >> trade_logs/auto-grid.log 2>&1
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'trade_logs', 'auto-grid.json');

console.log(`[AutoGrid] Starting at ${new Date().toISOString()}`);

async function run() {
  // ── Load trade log for price reconstruction ──────────────────────────────
  const { GridSearchValidator } = require('./grid-search');
  const { MonteCarlo }    = require('./monte-carlo');
  const { TRADING_CONFIG }= require('./trading-config');

  // Generate synthetic prices (replace with real price feed when available)
  let s = Date.now() % 100000;
  const rng = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 - 0.5; };
  let p = TRADING_CONFIG.assets?.[0] === 'USDJPY' ? 150 : 1.1050;
  const prices = [], volumes = [];
  for (let i = 0; i < 3000; i++) {
    p = Math.max(0.1, p * (1 + 0.00001 + rng() * 0.0006));
    prices.push(p);
    volumes.push(500000 + Math.abs(rng()) * 300000);
  }

  // ── Run grid search ────────────────────────────────────────────────────────
  console.log('[AutoGrid] Running grid search on 3000 bars...');
  const gs     = new GridSearchValidator();
  const result = gs.run(prices, volumes, { strategy: 'random', nSamples: 150 });

  console.log(`[AutoGrid] Best params: ${JSON.stringify(result.bestParams)}`);
  console.log(`[AutoGrid] Test PF: ${result.testPF?.toFixed(3)} | Overfit: ${result.overfitFlag}`);

  // ── Monte Carlo validation ─────────────────────────────────────────────────
  let mcSummary = null;
  const tradesFile = path.join(__dirname, 'trade_logs', 'trades.json');
  if (fs.existsSync(tradesFile)) {
    try {
      const trades = JSON.parse(fs.readFileSync(tradesFile, 'utf8'));
      if (Array.isArray(trades) && trades.length >= 10) {
        const mc = MonteCarlo.run(trades, { simulations: 500, capital: TRADING_CONFIG.initialCapital || 10000 });
        mcSummary = mc.summary;
        console.log(`[AutoGrid] MC ruin prob: ${mc.summary.ruinProbability}% | median equity: $${mc.summary.medianFinalEquity}`);
      }
    } catch (_) {}
  }

  // ── Apply params only if safe ──────────────────────────────────────────────
  const safe = !result.overfitFlag
    && (result.testPF || 0) > 1.0
    && (!mcSummary || mcSummary.ruinProbability < 20);

  const report = {
    ...result,
    mcSummary,
    applied: safe,
    reason:  safe ? 'passed all checks' : `blocked — overfit=${result.overfitFlag} testPF=${result.testPF?.toFixed(2)} ruin=${mcSummary?.ruinProbability}%`,
    runAt:   new Date().toISOString(),
  };

  if (safe) {
    console.log('[AutoGrid] ✅ Params passed — applying to TRADING_CONFIG');
    // Item #5: Paper-trading gate — require 30 days paper validation before live promotion
    // Set AUTOGRID_SKIP_PAPER_GATE=true to bypass (e.g. in CI or explicit override)
    const paperGateEnabled = process.env.AUTOGRID_SKIP_PAPER_GATE !== 'true';
    if (paperGateEnabled) {
      console.log('[AutoGrid] #5 PAPER GATE: Params staged for 30-day paper trading before live promotion');
      console.log('[AutoGrid]   To promote immediately (not recommended): set AUTOGRID_SKIP_PAPER_GATE=true');
      // Write staged params to paper-stage.json for the paper trader to pick up
      try {
        const fs = require('fs'), path = require('path');
        fs.writeFileSync(
          path.join(__dirname, 'config', 'paper-stage.json'),
          JSON.stringify({ params: result.bestParams, stagedAt: new Date().toISOString(), requireDays: 30 }, null, 2)
        );
        console.log('[AutoGrid]   Staged params written to config/paper-stage.json');
      } catch(e) { console.warn('[AutoGrid] Could not write paper-stage.json:', e.message); }
      return result;  // don't apply to live config yet
    }
    if (result.bestParams.minConfidence) TRADING_CONFIG.minConfidence = result.bestParams.minConfidence;
    if (result.bestParams.riskPct)       TRADING_CONFIG.positionSize  = result.bestParams.riskPct;
  } else {
    console.log('[AutoGrid] ⚠️  Params NOT applied —', report.reason);
  }

  fs.writeFileSync(LOG_FILE, JSON.stringify(report, null, 2));
  console.log(`[AutoGrid] Report saved → ${LOG_FILE}`);
  console.log(`[AutoGrid] Done at ${new Date().toISOString()}`);
}

run().catch(e => { console.error('[AutoGrid] Fatal:', e.message); process.exit(1); });
