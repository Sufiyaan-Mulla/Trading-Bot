'use strict';
// ── grid-search-complete.js ───────────────────────────────────────────────────
// Unified grid search entry point — wraps grid-search.js with:
//   • CSV data loading (--csv flag)
//   • Full nested walk-forward (--full flag)
//   • Quick random search (default, --quick flag)
//   • Period-sliced validation (bull/bear/sideways per-regime scores)
//
// Usage:
//   node grid-search-complete.js                 (quick random, 200 combos)
//   node grid-search-complete.js --full          (nested walk-forward)
//   node grid-search-complete.js --csv data.csv  (load real OHLCV CSV)
//   node grid-search-complete.js --asset GBPUSD  (override asset)
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const args   = process.argv.slice(2);
const mode   = args.includes('--full') ? 'full' : args.includes('--quick') ? 'quick' : 'quick';
const csvIdx = args.indexOf('--csv');
const csvFile= csvIdx >= 0 ? args[csvIdx + 1] : null;
const asset  = args[args.indexOf('--asset') + 1] || 'EURUSD';
const combos = parseInt(args[args.indexOf('--combos') + 1]) || 200;

console.log(`[GridSearch] mode=${mode} asset=${asset} combos=${combos}${csvFile ? ' csv='+csvFile : ''}`);

// ── Load or generate price data ────────────────────────────────────────────────
function loadCSV(file) {
  const lines  = fs.readFileSync(file, 'utf8').trim().split('\n');
  const header = lines[0].toLowerCase().split(',');
  const closeIdx = header.findIndex(h => h.includes('close'));
  const volIdx   = header.findIndex(h => h.includes('vol'));
  const prices = [], volumes = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const c = parseFloat(cols[closeIdx]);
    const v = parseFloat(cols[volIdx] || '0');
    if (isFinite(c) && c > 0) { prices.push(c); volumes.push(v || 1000); }
  }
  return { prices, volumes };
}

function generatePrices(n = 5000) {
  let p = 1.1050, s = 42;
  const rng = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 - 0.5; };
  const prices = [p], volumes = [1000000];
  for (let i = 1; i < n; i++) {
    p = Math.max(0.1, p * (1 + 0.00001 + rng() * 0.0006));
    prices.push(p);
    volumes.push(800000 + Math.abs(rng()) * 400000);
  }
  return { prices, volumes };
}

const data = csvFile && fs.existsSync(csvFile) ? loadCSV(csvFile) : generatePrices(5000);
console.log(`[GridSearch] ${data.prices.length} price bars loaded`);

// ── Run the appropriate grid-search mode ───────────────────────────────────────
const { GridSearchValidator } = require('./grid-search');
const { PeriodSlicer }     = require('./period-slicer');

const gs = new GridSearch(data.prices, data.volumes, { maxCombos: combos });

let result;
if (mode === 'full') {
  console.log('[GridSearch] Running nested walk-forward (this may take a minute)...');
  result = gs.runNested();
} else {
  console.log('[GridSearch] Running quick random search...');
  result = gs.run();
}

console.log(`\n[GridSearch] Best params:`);
console.log(JSON.stringify(result.bestParams, null, 2));
console.log(`\n[GridSearch] Scores:`);
console.log(`  Train PF:    ${result.trainPF?.toFixed(3) || result.trainScore?.toFixed(3) || 'n/a'}`);
console.log(`  Val   PF:    ${result.valPF?.toFixed(3) || 'n/a'}`);
console.log(`  Test  PF:    ${result.testPF?.toFixed(3) || 'n/a'}`);
console.log(`  Overfit:     ${result.overfitFlag ? '⚠️  YES' : '✅ no'}`);

// ── Period-sliced validation ───────────────────────────────────────────────────
console.log('\n[GridSearch] Running period-sliced validation...');
const candles = data.prices.map((p, i) => ({
  time: Date.now() - (data.prices.length - i) * 300_000,
  open: p, high: p * 1.0003, low: p * 0.9997, close: p,
  volume: data.volumes[i] || 1000,
}));

const slicer = new PeriodSlicer({ minSliceBars: 50 });
const slices = slicer.slice(candles);

const { SharedSignalAdapter } = require('./shared-signal-adapter');
for (const slice of slices) {
  const a  = new SharedSignalAdapter('trend');
  const r  = a.backtest(slice.candles, { capital: 10000, ...result.bestParams });
  console.log(`  ${slice.regime.padEnd(10)} | ${slice.bars}bars | WR=${r.winRate}% return=${r.totalReturn}%`);
}

// ── Save report ────────────────────────────────────────────────────────────────
const report = { ...result, asset, mode, bars: data.prices.length, generatedAt: new Date().toISOString() };
const outFile = path.join(__dirname, 'trade_logs', `grid-search-${mode}.json`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(`\n[GridSearch] Report saved → ${outFile}`);
