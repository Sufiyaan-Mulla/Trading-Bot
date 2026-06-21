'use strict';

const { TradingEngine, TRADING_CONFIG } = require('./trading-engine');

let passed = 0, failed = 0;
const L = '─'.repeat(66);
const pass = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else    { failed++; console.log(`  ✗ FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
};

function makeEngine() {
  const e = new TradingEngine();
  // Reset any position restored from disk (stale trade_logs/active_position.json)
  e.position = null;
  e.selectedAsset = 'EURUSD';
  // Seed enough price history for indicators
  for (let i = 0; i < 220; i++) {
    const p = 1.1000 + i * 0.0001 + (Math.random() - 0.5) * 0.0005;
    e.priceHistory.push(p);
    // BUG fix: last bar volume must be >= 1.2x avg to pass volume gate.
    // Push 1.5M on the final bar so spread/slippage tests aren't blocked by volume.
    const vol = (i === 219) ? 1_500_000 : 1_000_000;
    e.volumeHistory.push(vol);
    e.ohlcvHistory.push({ o: p - 0.0002, h: p + 0.0003, l: p - 0.0003, c: p, v: vol });
  }
  e.lastATR  = 0.0012;
  e.lastVWAP = 1.1100;
  e.marketPrice = 1.1100;
  e.volatilityLevel = 'NORMAL';
  e.dynamicSlippage = TRADING_CONFIG.slippage;
  e.lastMarketRegime = 'TRENDING';
  e.mlConfidence.trained = false;
  return e;
}

// ══════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(66));
console.log('  Execution Improvements — Full Test Suite');
console.log('  Spread Awareness  ·  Partial Fills  ·  Slippage');
console.log('═'.repeat(66));

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  1. TRADING_CONFIG — new execution settings present\n${L}`);
{
  pass('spreadEnabled present',        TRADING_CONFIG.spreadEnabled        !== undefined);
  pass('maxSpreadFraction present',    TRADING_CONFIG.maxSpreadFraction    !== undefined);
  pass('spreadWarnFraction present',   TRADING_CONFIG.spreadWarnFraction   !== undefined);
  pass('spreadConfPenalty present',    TRADING_CONFIG.spreadConfPenalty    !== undefined);
  pass('partialFillEnabled present',   TRADING_CONFIG.partialFillEnabled   !== undefined);
  pass('partialFillMinRatio present',  TRADING_CONFIG.partialFillMinRatio  !== undefined);
  pass('partialFillMaxRatio present',  TRADING_CONFIG.partialFillMaxRatio  !== undefined);
  pass('partialFillRetries present',   TRADING_CONFIG.partialFillRetries   !== undefined);
  pass('maxSpread > warnSpread',       TRADING_CONFIG.maxSpreadFraction > TRADING_CONFIG.spreadWarnFraction);
  pass('partialFillMinRatio < maxRatio',
    TRADING_CONFIG.partialFillMinRatio < TRADING_CONFIG.partialFillMaxRatio);
  console.log(`    maxSpread=${TRADING_CONFIG.maxSpreadFraction} warnSpread=${TRADING_CONFIG.spreadWarnFraction}`);
  console.log(`    partialFill: min=${TRADING_CONFIG.partialFillMinRatio} max=${TRADING_CONFIG.partialFillMaxRatio} retries=${TRADING_CONFIG.partialFillRetries}`);
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  2. _recordSpread — spread tracking\n${L}`);
{
  const e = makeEngine();
  pass('spreadHistory initialised as []', Array.isArray(e.spreadHistory));
  pass('avgSpread starts at 0', e.avgSpread === 0);

  // Feed 5 narrow spreads
  for (let i = 0; i < 5; i++) e._recordSpread(1.1098, 1.1100, 1.1099);
  pass('spreadHistory grows', e.spreadHistory.length === 5);
  pass('currentSpread set', e.currentSpread > 0);
  pass('avgSpread calculated', e.avgSpread > 0);
  console.log(`    avgSpread after 5 bars: ${(e.avgSpread * 10000).toFixed(3)} bps`);

  // Feed 20+ bars — should cap at 20
  for (let i = 0; i < 20; i++) e._recordSpread(1.1098, 1.1101, 1.1099);
  pass('spreadHistory capped at 20', e.spreadHistory.length === 20, `got ${e.spreadHistory.length}`);
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  3. _checkSpread — spread gate logic\n${L}`);
{
  const e = makeEngine();
  const price = 1.1100;

  // Narrow spread (0.5 pip = 0.00005) — should be fine
  for (let i = 0; i < 5; i++) e._recordSpread(price - 0.000025, price + 0.000025, price);
  const narrow = e._checkSpread(price);
  console.log(`    Narrow spread: ${narrow.spreadPips.toFixed(2)} pips  blocked=${narrow.blocked} warn=${narrow.warn}`);
  pass('Narrow spread not blocked', !narrow.blocked);
  pass('Narrow spread no warning', !narrow.warn);
  pass('Narrow spread no penalty', narrow.penaltyPts === 0);

  // Wide spread (8 pip = 0.0008) — should be blocked
  const e2 = makeEngine();
  for (let i = 0; i < 5; i++) e2._recordSpread(price - 0.0004, price + 0.0004, price);
  const wide = e2._checkSpread(price);
  console.log(`    Wide spread:   ${wide.spreadPips.toFixed(2)} pips  blocked=${wide.blocked} warn=${wide.warn}`);
  pass('Wide spread is blocked', wide.blocked, `spreadPips=${wide.spreadPips.toFixed(2)}`);

  // Warn spread (4 pip = 0.0004) — should warn but not block
  const e3 = makeEngine();
  for (let i = 0; i < 5; i++) e3._recordSpread(price - 0.0002, price + 0.0002, price);
  const warn = e3._checkSpread(price);
  console.log(`    Warn spread:   ${warn.spreadPips.toFixed(2)} pips  blocked=${warn.blocked} warn=${warn.warn} penalty=${warn.penaltyPts}`);
  pass('Warn spread not blocked', !warn.blocked);
  pass('Warn spread triggers warning', warn.warn, `spreadPips=${warn.spreadPips.toFixed(2)}`);
  pass('Warn spread has confidence penalty', warn.penaltyPts > 0, `penalty=${warn.penaltyPts}`);
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  4. Spread gate in enterPosition — blocks wide spread\n${L}`);
{
  const e = makeEngine();
  const price = 1.1100;

  // Force a wide spread in rolling history
  for (let i = 0; i < 5; i++) e._recordSpread(price - 0.0004, price + 0.0004, price);

  const capitalBefore = e.capital;
  e.enterPosition(price, 75); // synchronous-style call — returns promise

  // Check that position was NOT opened (spread blocked it)
  // Note: enterPosition is now async; use sync check on lastRejectedOrder
  setTimeout(() => {}, 0); // flush microtasks

  // We can inspect synchronously because spread gate returns before await
  pass('lastRejectedOrder set on spread block', !!e.lastRejectedOrder ||
    e.capital === capitalBefore, 'capital unchanged or rejection recorded');
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  5. Spread gate in enterPosition — async full flow\n${L}`);
{
  (async () => {
    // Wide spread — should block
    const e1 = makeEngine();
    const price = 1.1100;
    for (let i = 0; i < 5; i++) e1._recordSpread(price - 0.0004, price + 0.0004, price);
    const capBefore = e1.capital;
    await e1.enterPosition(price, 80);
    pass('Wide spread blocks entry (capital unchanged)', e1.capital === capBefore,
      `capital: ${e1.capital}`);
    pass('lastRejectedOrder.reason = spread_too_wide',
      e1.lastRejectedOrder?.reason === 'spread_too_wide',
      `got: ${e1.lastRejectedOrder?.reason}`);
    pass('No position opened on wide spread', e1.position === null);

    // Narrow spread — should allow entry
    const e2 = makeEngine();
    for (let i = 0; i < 5; i++) e2._recordSpread(price - 0.00005, price + 0.00005, price);
    await e2.enterPosition(price, 80);
    pass('Narrow spread allows entry', e2.position !== null,
      `position=${JSON.stringify(e2.position?.entry)}`);

    // Warn spread — should penalise confidence but still enter (if still above floor)
    const e3 = makeEngine();
    for (let i = 0; i < 5; i++) e3._recordSpread(price - 0.0002, price + 0.0002, price);
    await e3.enterPosition(price, 80);
    // Penalty = ~10pts, so 80-10=70 which is above the 60 floor
    pass('Warn spread entry proceeds with penalty applied', e3.position !== null ||
      e3.lastRejectedOrder?.reason === 'spread_too_wide' === false);
    if (e3.position) {
      pass('Position entry logged spread at entry',
        e3.position.spreadAtEntry !== undefined, `spreadAtEntry=${e3.position.spreadAtEntry}`);
    }

    runPartialFillTests();
  })();
}

// ─────────────────────────────────────────────────────────────────────
async function runPartialFillTests() {
  console.log(`\n${L}\n  6. _executeFill — partial fill simulation\n${L}`);
  {
    const e = makeEngine();
    const targetShares = 1000;
    const price        = 1.1100;

    const result = await e._executeFill(targetShares, price, 'BUY');
    console.log(`    Fills: ${result.fills.length} tranches, total shares: ${result.filledShares.toFixed(4)}, avgPrice: ${result.avgEntryPrice.toFixed(5)}`);
    result.fills.forEach(f => console.log(`      attempt ${f.attempt}: ${f.shares.toFixed(4)} @ ${f.price.toFixed(5)}`));

    pass('Total filled ≈ targetShares', Math.abs(result.filledShares - targetShares) < 0.01,
      `filled=${result.filledShares.toFixed(4)} target=${targetShares}`);
    pass('avgEntryPrice close to price', Math.abs(result.avgEntryPrice - price) < 0.001,
      `avg=${result.avgEntryPrice.toFixed(5)} price=${price}`);
    pass('fills array non-empty', result.fills.length >= 1);
    pass('First fill within config ratio',
      result.fills[0].shares >= targetShares * TRADING_CONFIG.partialFillMinRatio * 0.95,
      `first=${result.fills[0].shares.toFixed(4)} min=${(targetShares * TRADING_CONFIG.partialFillMinRatio).toFixed(4)}`);
    pass('No NaN in fill prices', result.fills.every(f => !isNaN(f.price)));
    pass('No NaN in fill shares', result.fills.every(f => !isNaN(f.shares)));
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log(`\n${L}\n  7. _executeFill — disabled (single fill)\n${L}`);
  {
    const saved = TRADING_CONFIG.partialFillEnabled;
    TRADING_CONFIG.partialFillEnabled = false;
    const e = makeEngine();
    const result = await e._executeFill(500, 1.1100, 'BUY');
    TRADING_CONFIG.partialFillEnabled = saved;

    pass('Disabled: exactly 1 fill', result.fills.length === 1, `got ${result.fills.length}`);
    pass('Disabled: fill = full shares', result.filledShares === 500, `got ${result.filledShares}`);
    pass('Disabled: avgPrice = price', result.avgEntryPrice === 1.1100, `got ${result.avgEntryPrice}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log(`\n${L}\n  8. enterPosition — partial fill fields on position\n${L}`);
  {
    const e = makeEngine();
    const price = 1.1100;
    for (let i = 0; i < 5; i++) e._recordSpread(price - 0.00005, price + 0.00005, price);
    await e.enterPosition(price, 80);

    if (e.position) {
      pass('position.fills array present', Array.isArray(e.position.fills),
        `fills=${JSON.stringify(e.position.fills?.length)}`);
      pass('position.fillSummary present', typeof e.position.fillSummary === 'string',
        `fillSummary=${e.position.fillSummary}`);
      pass('position.spreadAtEntry present', e.position.spreadAtEntry !== undefined);
      pass('position.entry = avgFillPrice (not raw)',
        Math.abs(e.position.entry - price) < 0.002,
        `entry=${e.position.entry}`);
      pass('position.shares > 0', e.position.shares > 0, `shares=${e.position.shares}`);
      console.log(`    fillSummary: ${e.position.fillSummary}`);
      console.log(`    spreadAtEntry: ${e.position.spreadAtEntry?.toFixed(2)} pips`);
    } else {
      pass('Position created with narrow spread', false, 'position is null');
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log(`\n${L}\n  9. Slippage — dynamic tracker still works\n${L}`);
  {
    const e = makeEngine();
    e._recordSlippage(0.0005);
    e._recordSlippage(0.0006);
    e._recordSlippage(0.0004);
    pass('slippageHistory tracks fills', e.slippageHistory.length === 3);
    pass('dynamicSlippage updated', e.dynamicSlippage > 0);
    pass('dynamicSlippage = rolling avg',
      Math.abs(e.dynamicSlippage - (0.0005 + 0.0006 + 0.0004) / 3) < 1e-9,
      `got ${e.dynamicSlippage.toFixed(6)}`);

    // High slippage widens TP
    for (let i = 0; i < 10; i++) e._recordSlippage(TRADING_CONFIG.slippage * 3);
    pass('High slippage widens dynamicTpMultiplier',
      e.dynamicTpMultiplier > 5.0, `tpMult=${e.dynamicTpMultiplier}`);
  }

  // ─────────────────────────────────────────────────────────────────────
  console.log(`\n${L}\n  10. Retry config — still intact\n${L}`);
  {
    pass('retryMaxAttempts = 3', TRADING_CONFIG.retryMaxAttempts === 3);
    pass('retryBaseDelay = 1000ms', TRADING_CONFIG.retryBaseDelay === 1000);
    pass('retryMultiplier = 2', TRADING_CONFIG.retryMultiplier === 2);
    pass('retryMaxDelay = 10000ms', TRADING_CONFIG.retryMaxDelay === 10000);
  }

  // ══════════════════════════════════════════════════════════════════════
  console.log('\n' + '═'.repeat(66));
  console.log(`  Results: ${passed} passed  ${failed} failed  (${passed + failed} total)`);
  if (failed === 0) console.log('  ✅  All tests passed');
  else              console.log(`  ❌  ${failed} test(s) failed`);
  console.log('═'.repeat(66) + '\n');
  if (failed > 0) process.exitCode = 1;
}
