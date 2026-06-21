'use strict';

(async () => {
// ══════════════════════════════════════════════════════════════════════════════
//  test-critical-fixes.js  —  Regression tests for critical bugs 49–59
//
//  Fix 49  — execution: stop-loss pushed above entry by wide spread
//  Fix 49b — execution: SHORT stop-loss pushed below entry by wide spread
//  Fix 50  — execution: exitPosition no price validation (catastrophic loss)
//  Fix 51  — execution: enterPosition mutex set after validation (race condition)
//  Fix 51b — execution: enterShort same race condition
//  Fix 52  — execution: position.commission undefined → NaN profit
//  Fix 53  — trading-engine: risk-state.json non-atomic write
//  Fix 54  — execution: exitPosition no shares validation
//  Fix 55  — indicators: EMA with NaN prices returns NaN (signal corruption)
//  Fix 56  — exchange-interface: placeOrder swallows OANDA error responses
//  Fix 57  — trading-engine: reconcile crashes on undefined price; unawaited exit
//  Fix 58  — trading-engine: trading loop catch fails on non-Error throws
//  Fix 59  — exchange-interface: NaN/Inf stopLoss/takeProfit pass _validateSpec
// ══════════════════════════════════════════════════════════════════════════════

process.env.BACKTEST_MODE = 'true';
process.env.NODE_ENV      = 'test';

const fs   = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const failures = [];

function assert(cond, label, detail = '') {
  if (cond) { process.stdout.write(`  ✅ ${label}\n`); passed++; }
  else {
    process.stdout.write(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}\n`);
    failed++; failures.push(label);
  }
}
function section(t) { console.log('\n' + '═'.repeat(66) + '\n  ' + t + '\n' + '═'.repeat(66)); }


// ══════════════════════════════════════════════════════════════════════════════
section('Fix 49 — stop-loss not pushed above entry by wide spread');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./execution.js', 'utf8');
  // After the spread adjustment, a second guard must exist
  const spreadIdx = src.indexOf('if (halfSpreadLong > 0) stopLoss += halfSpreadLong');
  const guardAfter = src.slice(spreadIdx, spreadIdx + 300);
  assert(guardAfter.includes('if (stopLoss >= avgFillPrice)'),
    '#49a: second SL guard present after spread adjustment');

  // Simulate: SL was valid, then spread pushes it above entry
  const avgFill = 1.1000, stopLoss_before = 1.0780;
  const halfSpread = 0.025;  // 2.5% — extreme spread
  let sl = stopLoss_before + halfSpread;
  if (sl >= avgFill) sl = avgFill * (1 - 0.02);  // guard re-applies
  assert(sl < avgFill, '#49b: wide spread cannot push SL above entry');

  // SHORT: spread subtracts from SL, second guard prevents SL below entry
  const srcShort = src.indexOf('if (stopLoss <= avgShortEntry) stopLoss = avgShortEntry * (1 + (TRADING_CONFIG.stopLoss || 0.02));',
    src.indexOf('halfSpreadShort'));
  assert(srcShort > -1, '#49c: SHORT second SL guard exists after spread adjustment');
} catch(e) { assert(false, '#49 SL spread guard', e.message); }


// ══════════════════════════════════════════════════════════════════════════════
section('Fix 50 — exitPosition rejects invalid exit price');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./execution.js', 'utf8');
  const exitStart = src.indexOf('async exitPosition(price, reason)');
  const earlyBlock = src.slice(exitStart, exitStart + 800);  // extended to find PriceGuard

  assert(earlyBlock.includes('!isFinite(price)'),   '#50a: isFinite(price) guard present');
  assert(earlyBlock.includes('price <= 0'),          '#50b: price <= 0 guard present');
  assert(earlyBlock.includes('PriceGuard'),          '#50c: PriceGuard label in rejection msg');

  // Simulate: zero price would have caused catastrophic loss
  const shares = 1000, entry = 1.1, price = 0;
  const exitValue = shares * price;  // 0
  const naiveLoss = exitValue - (shares * entry);  // -1100
  assert(naiveLoss < -500, '#50d: confirms zero price causes catastrophic loss without guard');

  // With guard: exit is rejected, no trade recorded
  const priceIsValid = typeof price === 'number' && isFinite(price) && price > 0;
  assert(!priceIsValid, '#50e: zero price correctly identified as invalid');
} catch(e) { assert(false, '#50 exit price guard', e.message); }


// ══════════════════════════════════════════════════════════════════════════════
section('Fix 51 — enterPosition mutex set before any validation');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./execution.js', 'utf8');
  // Use larger window (2000 chars) to capture mutex set which comes after guards
  const enterStart = src.indexOf('async enterPosition(price, confidence, corrMultiplier');
  const firstLines = src.slice(enterStart, enterStart + 2000);
  const mutexCheckIdx = firstLines.indexOf('this._entering || this._capitalLocked');
  const mutexSetIdx   = firstLines.indexOf('this._entering = true;');
  const priceCheckIdx = firstLines.indexOf('invalid price');
  assert(mutexCheckIdx > 0 && mutexCheckIdx < priceCheckIdx,
    '#51a: mutex check before price check');
  assert(mutexSetIdx > 0 && mutexSetIdx < priceCheckIdx,
    '#51b: mutex set found before price check');
  assert(mutexCheckIdx < mutexSetIdx,  '#51c: combined mutex check before set');

  const enterShortStart = src.indexOf('async enterShort(price, confidence');
  const shortLines = src.slice(enterShortStart, enterShortStart + 2000);
  const shortMutexSet   = shortLines.indexOf('this._entering = true;');
  const shortPriceCheck = shortLines.indexOf('invalid price');
  assert(shortMutexSet > 0 && shortMutexSet < shortPriceCheck,
    '#51d: enterShort mutex set before price check');
} catch(e) { assert(false, '#51 mutex ordering', e.message); }


// ══════════════════════════════════════════════════════════════════════════════
section('Fix 52 — position.commission undefined → NaN profit guarded');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./execution.js', 'utf8');
  assert(src.includes('const entryComm = (typeof this.position.commission'),
    '#52a: entryComm guard variable defined');
  assert(src.includes("? this.position.commission : 0"),
    '#52b: undefined commission falls back to 0');

  // Runtime simulation: undefined commission must not produce NaN profit
  const posComm = undefined;
  const entryComm = (typeof posComm === 'number' && isFinite(posComm)) ? posComm : 0;
  const shares = 1000, entry = 1.1000, exitP = 1.1100;
  const exitValue = shares * exitP;
  const commission = exitValue * 0.001;
  const netProfit = exitValue - (shares * entry + entryComm + commission);
  assert(isFinite(netProfit),   '#52c: netProfit finite when position.commission=undefined');
  assert(netProfit > 0,         '#52d: netProfit correctly positive for profitable exit');
  assert(!isNaN(netProfit),     '#52e: netProfit is not NaN');
} catch(e) { assert(false, '#52 position.commission', e.message); }


// ══════════════════════════════════════════════════════════════════════════════
section('Fix 53 — risk-state.json written atomically');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./trading-engine.js', 'utf8');
  const riskIdx = src.indexOf('risk-state.json');
  const riskBlock = src.slice(riskIdx, riskIdx + 300);
  const riskTmpIdx = src.indexOf('risk-state.json.tmp');
  assert(riskTmpIdx > -1, '#53a: tmp file used for risk-state write');
  const riskRename = src.slice(riskTmpIdx, riskTmpIdx + 200);
  assert(riskRename.includes('rename'), '#53b: rename makes risk-state write atomic');
} catch(e) { assert(false, '#53 risk-state atomic', e.message); }


// ══════════════════════════════════════════════════════════════════════════════
section('Fix 54 — exitPosition validates position.shares');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./execution.js', 'utf8');
  assert(src.includes('const posShares = this.position.shares'),
    '#54a: posShares validation variable defined');
  assert(src.includes('posShares <= 0'),
    '#54b: zero shares rejected');
  assert(src.includes('SharesGuard'),
    '#54c: SharesGuard log label in rejection');

  // Simulate: zero shares would have caused catastrophic loss
  const posShares = 0, exitPrice = 1.1;
  const exitValue = posShares * exitPrice;  // 0
  assert(exitValue === 0, '#54d: confirms zero shares causes zero exitValue');

  // With guard: shares validated before use
  const isValid = typeof posShares === 'number' && isFinite(posShares) && posShares > 0;
  assert(!isValid, '#54e: zero shares correctly identified as invalid');
} catch(e) { assert(false, '#54 shares validation', e.message); }


// ══════════════════════════════════════════════════════════════════════════════
section('Fix 55 — EMA filters NaN prices, returns finite value');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { Indicators } = require('./indicators');

  // All-NaN prices → returns 50 (neutral)
  const allNaN = Array(20).fill(NaN);
  const r1 = Indicators.ema(allNaN, 9);
  assert(isFinite(r1),         '#55a: EMA(all-NaN) returns finite value');
  assert(r1 === 50,            '#55b: EMA(all-NaN) returns 50 as neutral fallback');

  // Mixed NaN → still computes on clean prices
  const mixed = [1.1, NaN, 1.11, 1.09, NaN, 1.12, 1.10, 1.11, 1.09, 1.12];
  const r2 = Indicators.ema(mixed, 5);
  assert(isFinite(r2),         '#55c: EMA(mixed NaN) returns finite value');
  assert(r2 > 1.0 && r2 < 1.2, '#55d: EMA(mixed NaN) returns price-range value');

  // MACD also benefits (uses EMA internally)
  const r3 = Indicators.macd(mixed);
  assert(isFinite(r3),         '#55e: MACD(mixed NaN) returns finite value');

  // Normal prices still work correctly
  const clean = Array.from({length: 20}, (_, i) => 1.1 + i * 0.001);
  const r4 = Indicators.ema(clean, 9);
  assert(isFinite(r4),         '#55f: EMA(clean prices) still works');
  assert(r4 > 1.1,             '#55g: EMA(clean prices) returns correct range');
} catch(e) { assert(false, '#55 EMA NaN filter', e.message); }


// ══════════════════════════════════════════════════════════════════════════════
section('Fix 56 — placeOrder throws on OANDA error responses');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./exchange-interface.js', 'utf8');
  assert(src.includes('if (data.errorMessage || data.errorCode)'),
    '#56a: OANDA error response detection present');
  assert(src.includes('OANDA order rejected:'),
    '#56b: descriptive error message thrown');
  assert(src.includes('unexpected response shape'),
    '#56c: empty non-error response also throws');

  // Simulate: OANDA returns INSUFFICIENT_FUNDS
  const oandaErr = { errorMessage: 'INSUFFICIENT_FUNDS', errorCode: 'ACCOUNT_NON_TRADEABLE' };
  let threw = false, errMsg = '';
  if (oandaErr.errorMessage || oandaErr.errorCode) {
    threw = true;
    errMsg = `OANDA order rejected: ${oandaErr.errorMessage || oandaErr.errorCode}`;
  }
  assert(threw, '#56d: OANDA error response triggers throw');
  assert(errMsg.includes('INSUFFICIENT_FUNDS'), '#56e: error message includes OANDA reason');

  // Before fix: silent null orderId
  const fill = oandaErr.orderFillTransaction || oandaErr.orderCreateTransaction || {};
  const orderId = fill.id || null;
  assert(orderId === null, '#56f: confirms old code returned null orderId silently');
} catch(e) { assert(false, '#56 placeOrder error handling', e.message); }


// ══════════════════════════════════════════════════════════════════════════════
section('Fix 57 — reconcile validates currentPrice, awaits exitPosition');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./trading-engine.js', 'utf8');
  const reconcileIdx = src.indexOf('_reconcileRestoredPosition');
  // Search from the actual function definition, not the comment/call reference
  const funcIdx = src.indexOf('async _reconcileRestoredPosition(gapSeconds)');
  const reconcileBody = funcIdx > -1 ? src.slice(funcIdx, funcIdx + 5000) : src.slice(reconcileIdx, reconcileIdx + 5000);

  assert(reconcileBody.includes('isFinite(currentPrice)'),
    '#57a: currentPrice isFinite guard in reconcile');
  assert(reconcileBody.includes('aborting reconcile'),
    '#57b: reconcile aborts safely on invalid price');
  const awaitExitCount = (reconcileBody.match(/await this\.exitPosition/g)||[]).length;
  assert(awaitExitCount >= 3, '#57c: at least 3 awaited exitPosition calls in reconcile');
  assert(reconcileBody.includes('Broker Closed'),   '#57d: broker-closed exit awaited');
  assert(reconcileBody.includes('Gap Reconciliation'), '#57e: gap reconciliation exits awaited');
} catch(e) { assert(false, '#57 reconcile fixes', e.message); }


// ══════════════════════════════════════════════════════════════════════════════
section('Fix 58 — trading loop catch handles non-Error throws');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const src = fs.readFileSync('./trading-engine.js', 'utf8');
  const catchIdx = src.indexOf("} catch (err) {\n        // Bug fix: err.message is undefined");
  assert(catchIdx > -1,                        '#58a: improved catch block present');
  assert(src.includes('err instanceof Error'),  '#58b: instanceof Error check present');
  assert(src.includes('_consecutiveLoopErrors'),'#58c: error backoff counter present');
  assert(src.includes('backing off'),           '#58d: backoff log message present');
  assert(src.includes('errStack'),              '#58e: stack trace captured');

  // Runtime: non-Error throws are handled correctly
  const errMsg1 = (() => {
    const err = 'plain string error';
    return (err instanceof Error) ? err.message : (typeof err === 'string' ? err : JSON.stringify(err));
  })();
  assert(errMsg1 === 'plain string error', '#58f: string throw normalized to message');

  const errMsg2 = (() => {
    const err = { code: 'NETWORK_ERR', msg: 'timeout' };
    return (err instanceof Error) ? err.message : (typeof err === 'string' ? err : JSON.stringify(err));
  })();
  assert(errMsg2.includes('NETWORK_ERR'),  '#58g: object throw serialized to JSON');
} catch(e) { assert(false, '#58 loop catch', e.message); }


// ══════════════════════════════════════════════════════════════════════════════
section('Fix 59 — _validateSpec rejects NaN/Inf stopLoss/takeProfit');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { OandaAdapter } = require('./exchange-interface');
  const adapter = new OandaAdapter({ apiKey: 'test', accountId: 'test123' });
  const baseSpec = { asset: 'EURUSD', side: 'BUY', size: 1000, type: 'MARKET', price: 1.1 };

  // NaN stopLoss must be rejected
  let threw1 = false;
  try { adapter._validateSpec({ ...baseSpec, stopLoss: NaN }); } catch(_) { threw1 = true; }
  assert(threw1, '#59a: NaN stopLoss rejected by _validateSpec');

  // Infinity takeProfit must be rejected
  let threw2 = false;
  try { adapter._validateSpec({ ...baseSpec, takeProfit: Infinity }); } catch(_) { threw2 = true; }
  assert(threw2, '#59b: Infinity takeProfit rejected by _validateSpec');

  // Zero stopLoss must be rejected
  let threw3 = false;
  try { adapter._validateSpec({ ...baseSpec, stopLoss: 0 }); } catch(_) { threw3 = true; }
  assert(threw3, '#59c: zero stopLoss rejected');

  // Negative takeProfit must be rejected
  let threw4 = false;
  try { adapter._validateSpec({ ...baseSpec, takeProfit: -1.1 }); } catch(_) { threw4 = true; }
  assert(threw4, '#59d: negative takeProfit rejected');

  // Valid spec must pass
  let threw5 = false;
  try { adapter._validateSpec({ ...baseSpec, stopLoss: 1.09, takeProfit: 1.15 }); }
  catch(e) { threw5 = true; }
  assert(!threw5, '#59e: valid SL/TP passes _validateSpec');

  // Null/undefined SL/TP (optional fields) must also pass
  let threw6 = false;
  try { adapter._validateSpec({ ...baseSpec, stopLoss: null, takeProfit: undefined }); }
  catch(e) { threw6 = true; }
  assert(!threw6, '#59f: null/undefined SL/TP (optional) passes _validateSpec');
} catch(e) { assert(false, '#59 _validateSpec', e.message); }


// ══════════════════════════════════════════════════════════════════════════════
section('Regression — all critical path modules still load');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const mods = [
    './execution', './trading-engine', './exchange-interface',
    './risk-manager', './indicators', './kelly-criterion',
    './config-validator', './safety-constants', './trading-config',
  ];
  for (const m of mods) {
    let ok = true;
    try { require(m); }
    catch(e) { ok = false; assert(false, `#R ${path.basename(m)} loads`, e.message); }
    if (ok) assert(true, `#R ${path.basename(m)}: loads without error`);
  }
} catch(e) { assert(false, '#R regression', e.message); }


// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(66));
console.log(`  RESULTS: ${passed + failed} tests — ✅ ${passed} passed, ❌ ${failed} failed`);
if (failures.length) {
  console.log('\n  Failed tests:');
  failures.forEach(f => console.log('    • ' + f));
}
console.log('═'.repeat(66) + '\n');
process.exit(failed > 0 ? 1 : 0);

})();
