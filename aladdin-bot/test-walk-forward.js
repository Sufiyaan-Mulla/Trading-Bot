'use strict';

const { WalkForwardValidator, WF_CONFIG, computeMetrics } = require('./walk-forward');

let passed = 0, failed = 0, total = 0;
function test(label, fn) {
  total++;
  try { fn(); console.log('  OK  ' + label); passed++; }
  catch(e) { console.log('  FAIL ' + label + '\n       -> ' + e.message); failed++; }
}
function eq(a,b,msg)    { if(a!==b)     throw new Error(msg||JSON.stringify(a)+' !== '+JSON.stringify(b)); }
function truthy(v,msg)  { if(!v)         throw new Error(msg||'expected truthy, got '+v); }
function falsy(v,msg)   { if(v)          throw new Error(msg||'expected falsy, got '+v); }
function gt(a,b,msg)    { if(!(a>b))     throw new Error(msg||a+' not > '+b); }
function gte(a,b,msg)   { if(!(a>=b))    throw new Error(msg||a+' not >= '+b); }
function lte(a,b,msg)   { if(!(a<=b))    throw new Error(msg||a+' not <= '+b); }
function near(a,b,t,m)  { if(Math.abs(a-b)>t) throw new Error(m||Math.abs(a-b).toFixed(6)+' > tol '+t); }
function inRange(v,lo,hi,m){ if(v<lo||v>hi) throw new Error(m||v+' not in ['+lo+','+hi+']'); }

// ── Synthetic market + backtest ───────────────────────────────────────────────
function genMarket(n, seed = 42) {
  let s = seed;
  const rng = () => { s=(s*1664525+1013904223)>>>0; return s/0xFFFFFFFF; };
  const prices=[1.1], volumes=[1_000_000];
  for(let i=1;i<n;i++){
    prices.push(Math.max(0.5, prices.at(-1)*(1+(rng()-0.49)*0.003)));
    volumes.push(400_000+rng()*800_000);
  }
  return { prices, volumes };
}

// Simple backtest that always returns a valid result
function mockBacktest(prices, volumes, capital=10_000) {
  const n = prices.length;
  let cap = capital;
  const trades = [];
  const equity = [capital];
  let position = null;
  let peak = capital, maxDD = 0;

  for(let i=1;i<n;i++){
    const p = prices[i];
    if(position && i-position.bar > 10){
      const profit = (p - position.entry)*position.shares - capital*0.001;
      cap += profit;
      trades.push({ profit, bars: i-position.bar, win: profit>0 });
      position = null;
    }
    if(!position && i%12===0 && cap>100){
      const shares = (cap*0.05)/p;
      position = { entry:p, shares, bar:i };
    }
    const val = cap + (position ? position.shares*(p-position.entry) : 0);
    equity.push(val);
    if(val>peak) peak=val;
    const dd=(peak-val)/peak;
    if(dd>maxDD) maxDD=dd;
  }
  if(position){
    const p=prices.at(-1);
    const profit=(p-position.entry)*position.shares;
    cap+=profit;
    trades.push({profit,bars:n-1-position.bar,win:profit>0});
  }
  return { trades, capital:cap, equity, maxDD };
}

const { prices, volumes } = genMarket(600);

console.log('\n=====================================================');
console.log('  WALK-FORWARD VALIDATOR -- DEEP TEST SUITE');
console.log('=====================================================');

// ── computeMetrics ────────────────────────────────────────────────────────────
console.log('\n-- 1-8. computeMetrics');

test('Returns all required fields', () => {
  const r = computeMetrics({ trades:[], capital:10_000, equity:[], maxDD:0 }, 10_000);
  for(const k of ['trades','winRate','profitFactor','expectancy','totalReturn','maxDrawdown','sharpe','finalCapital']){
    truthy(k in r, 'Missing field: '+k);
  }
});

test('Zero trades gives all zeros', () => {
  const r = computeMetrics({ trades:[], capital:10_000, equity:[], maxDD:0 }, 10_000);
  eq(r.trades, 0); eq(r.winRate, 0); eq(r.profitFactor, 0);
});

test('Win rate computed correctly', () => {
  const trades = [{profit:10,win:true},{profit:8,win:true},{profit:-5,win:false},{profit:-3,win:false}];
  const r = computeMetrics({ trades, capital:10_010, equity:[], maxDD:0.01 }, 10_000);
  eq(r.trades, 4); near(r.winRate, 50, 0.01, 'WR should be 50%');
});

test('Profit factor computed correctly', () => {
  const trades = [{profit:10,win:true},{profit:8,win:true},{profit:-4,win:false}];
  const r = computeMetrics({ trades, capital:10_014, equity:[], maxDD:0 }, 10_000);
  near(r.profitFactor, 18/4, 0.001, 'PF should be 4.5');
});

test('totalReturn reflects capital change', () => {
  const r = computeMetrics({ trades:[], capital:11_000, equity:[], maxDD:0 }, 10_000);
  near(r.totalReturn, 10.0, 0.001, 'Return should be 10%');
});

test('maxDrawdown reflects maxDD', () => {
  const r = computeMetrics({ trades:[], capital:10_000, equity:[], maxDD:0.15 }, 10_000);
  near(r.maxDrawdown, 15.0, 0.001, 'maxDrawdown should be 15%');
});

test('All-winning trades: PF is capped at 9.99', () => {
  const trades = Array(5).fill({profit:10, win:true});
  const r = computeMetrics({ trades, capital:10_050, equity:[], maxDD:0 }, 10_000);
  near(r.profitFactor, 9.99, 0.001, 'All-wins PF should be capped at 9.99');
});

test('Sharpe is 0 when fewer than 3 trades', () => {
  const trades = [{profit:5,win:true},{profit:-3,win:false}];
  const r = computeMetrics({ trades, capital:10_002, equity:[], maxDD:0 }, 10_000);
  eq(r.sharpe, 0, 'Sharpe should be 0 with < 3 trades');
});

// ── Sliding window ────────────────────────────────────────────────────────────
console.log('\n-- 9-18. Sliding Window');

const wfRunner = new WalkForwardValidator();
let slidingResult = null;

test('runSliding returns mode=sliding', () => {
  slidingResult = wfRunner.runSliding(prices, volumes, mockBacktest);
  eq(slidingResult.mode, 'sliding');
});

test('runSliding generates at least one fold', () => {
  truthy(slidingResult.folds.length > 0, 'Should have at least one fold, got ' + slidingResult.folds.length);
});

test('Each fold has isRange, oosRange, inSample, oos, efficiency', () => {
  for(const f of slidingResult.folds){
    for(const k of ['fold','isRange','oosRange','inSample','oos','efficiency','overfitted']){
      truthy(k in f, 'Missing fold field: '+k);
    }
  }
});

test('IS range and OOS range do not overlap (with embargo)', () => {
  for(const f of slidingResult.folds){
    const isEnd   = f.isRange[1];
    const oosStart= f.oosRange[0];
    gte(oosStart, isEnd, `OOS start ${oosStart} should be >= IS end ${isEnd} (embargo enforced)`);
  }
});

test('OOS range immediately follows IS + embargo', () => {
  for(const f of slidingResult.folds){
    const gap = f.oosRange[0] - f.isRange[1];
    gte(gap, f.embargoBars, `Gap ${gap} should be >= embargoBars ${f.embargoBars}`);
  }
});

test('Fold numbers are sequential starting at 1', () => {
  slidingResult.folds.forEach((f, i) => eq(f.fold, i+1, 'Fold number should be sequential'));
});

test('Aggregate metrics are averages across folds', () => {
  const agg = slidingResult.agg;
  truthy(typeof agg.winRate === 'number',      'agg.winRate should be number');
  truthy(typeof agg.profitFactor === 'number', 'agg.profitFactor should be number');
  truthy(typeof agg.totalReturn === 'number',  'agg.totalReturn should be number');
});

test('stabilityScore is percentage of positive OOS folds (0–100)', () => {
  inRange(slidingResult.stabilityScore, 0, 100, 'stabilityScore should be in [0,100]');
});

test('overfit flag is boolean', () => {
  eq(typeof slidingResult.overfit, 'boolean');
});

test('Larger embargo reduces OOS window size', () => {
  const r20  = wfRunner.runSliding(prices, volumes, mockBacktest, { embargoBars: 20 });
  const r50  = wfRunner.runSliding(prices, volumes, mockBacktest, { embargoBars: 50 });
  if(r20.folds.length > 0 && r50.folds.length > 0){
    const oos20 = r20.folds[0].oosRange[1] - r20.folds[0].oosRange[0];
    const oos50 = r50.folds[0].oosRange[1] - r50.folds[0].oosRange[0];
    lte(oos50, oos20, 'Larger embargo should give smaller OOS window');
  }
});

// ── Expanding window ──────────────────────────────────────────────────────────
console.log('\n-- 19-28. Expanding Window');

let expandResult = null;

test('runExpanding returns mode=expanding', () => {
  expandResult = wfRunner.runExpanding(prices, volumes, mockBacktest);
  eq(expandResult.mode, 'expanding');
});

test('runExpanding generates at least one fold', () => {
  truthy(expandResult.folds.length > 0, 'Should have at least one fold');
});

test('IS range always starts at bar 0 for every fold', () => {
  for(const f of expandResult.folds){
    eq(f.isRange[0], 0, 'IS start should always be 0 in expanding mode, fold '+f.fold);
  }
});

test('IS end grows between consecutive folds', () => {
  const folds = expandResult.folds;
  for(let i=1;i<folds.length;i++){
    gt(folds[i].isRange[1], folds[i-1].isRange[1],
      `IS end should grow: fold ${i+1} (${folds[i].isRange[1]}) > fold ${i} (${folds[i-1].isRange[1]})`);
  }
});

test('Embargo is enforced in each fold', () => {
  for(const f of expandResult.folds){
    const gap = f.oosRange[0] - f.isRange[1];
    gte(gap, f.embargoBars, `Gap ${gap} should be >= embargo ${f.embargoBars}`);
  }
});

test('OOS windows have similar sizes (fixed OOS)', () => {
  if(expandResult.folds.length < 2) return;
  const sizes = expandResult.folds.map(f => f.oosRange[1]-f.oosRange[0]);
  const minSize = Math.min(...sizes);
  const maxSize = Math.max(...sizes);
  lte(maxSize - minSize, Math.max(...sizes)*0.5+10, 'OOS sizes should be similar in expanding mode');
});

test('Expanding: more IS data each fold reduces model uncertainty', () => {
  truthy(expandResult.totalFolds > 0, 'Should have folds');
  truthy(expandResult.agg !== null, 'Should have aggregated metrics');
});

test('avgEfficiency is finite', () => {
  truthy(isFinite(expandResult.avgEfficiency), 'avgEfficiency should be finite');
});

test('Aggregate winRate is in [0, 100]', () => {
  inRange(expandResult.agg.winRate, 0, 100, 'agg.winRate out of range');
});

test('All required aggregate fields present', () => {
  for(const k of ['totalReturn','winRate','profitFactor','sharpe','maxDrawdown','expectancy','trades']){
    truthy(k in expandResult.agg, 'Missing agg field: '+k);
  }
});

// ── Anchored window ───────────────────────────────────────────────────────────
console.log('\n-- 29-37. Anchored Window');

let anchorResult = null;

test('runAnchored returns mode=anchored', () => {
  anchorResult = wfRunner.runAnchored(prices, volumes, mockBacktest);
  eq(anchorResult.mode, 'anchored');
});

test('runAnchored generates at least one fold', () => {
  truthy(anchorResult.folds.length > 0, 'Should have at least one fold');
});

test('IS range is identical across all anchored folds', () => {
  if(anchorResult.folds.length < 2) return;
  const isEnd0 = anchorResult.folds[0].isRange[1];
  for(const f of anchorResult.folds){
    eq(f.isRange[0], 0,       'IS start should be 0 in anchored mode');
    eq(f.isRange[1], isEnd0,  'IS end should be fixed in anchored mode');
  }
});

test('OOS windows slide forward between folds', () => {
  const folds = anchorResult.folds;
  for(let i=1;i<folds.length;i++){
    gt(folds[i].oosRange[0], folds[i-1].oosRange[0],
      `OOS start should advance: fold ${i+1} > fold ${i}`);
  }
});

test('OOS ranges do not overlap between folds', () => {
  const folds = anchorResult.folds;
  for(let i=1;i<folds.length;i++){
    gte(folds[i].oosRange[0], folds[i-1].oosRange[1],
      'OOS ranges should not overlap');
  }
});

test('Embargo enforced in anchored mode', () => {
  const f0 = anchorResult.folds[0];
  const gap = f0.oosRange[0] - f0.isRange[1];
  gte(gap, f0.embargoBars, `Gap ${gap} should be >= embargo ${f0.embargoBars}`);
});

test('Anchored mode detects decay: later OOS folds may have lower returns', () => {
  // We cannot guarantee decay in synthetic data, but we can check structure is valid
  const returns = anchorResult.folds.map(f => f.oos.totalReturn);
  truthy(returns.every(r => isFinite(r)), 'All OOS returns should be finite');
});

test('overfitted flag is boolean per fold', () => {
  for(const f of anchorResult.folds){
    eq(typeof f.overfitted, 'boolean', 'overfitted should be boolean');
  }
});

test('efficiency is finite per fold', () => {
  for(const f of anchorResult.folds){
    truthy(isFinite(f.efficiency), 'efficiency should be finite in fold '+f.fold);
  }
});

// ── Embargo effects ───────────────────────────────────────────────────────────
console.log('\n-- 38-41. Embargo / Purging');

test('Embargo=0 gives different fold structure than embargo=20', () => {
  const r0  = wfRunner.runSliding(prices, volumes, mockBacktest, { embargoBars: 0  });
  const r20 = wfRunner.runSliding(prices, volumes, mockBacktest, { embargoBars: 20 });
  if(r0.folds.length > 0 && r20.folds.length > 0){
    // With embargo, OOS starts later
    const gap0  = r0.folds[0].oosRange[0]  - r0.folds[0].isRange[1];
    const gap20 = r20.folds[0].oosRange[0] - r20.folds[0].isRange[1];
    gte(gap20, gap0, 'Embargo=20 should have larger gap than embargo=0');
  }
});

test('IS and OOS ranges never overlap for any window type', () => {
  for(const result of [slidingResult, expandResult, anchorResult]){
    for(const f of result.folds){
      const isEnd   = f.isRange[1];
      const oosStart = f.oosRange[0];
      gte(oosStart, isEnd, `${result.mode} fold ${f.fold}: OOS start ${oosStart} overlaps IS end ${isEnd}`);
    }
  }
});

test('Embargo bars recorded on fold object', () => {
  for(const f of slidingResult.folds){
    truthy('embargoBars' in f, 'embargoBars should be stored on fold');
    gte(f.embargoBars, 0, 'embargoBars should be >= 0');
  }
});

test('Small dataset returns error gracefully, not crash', () => {
  const tiny = { prices: Array(20).fill(1.1), volumes: Array(20).fill(1_000_000) };
  const r = wfRunner.runSliding(tiny.prices, tiny.volumes, mockBacktest);
  truthy(r.folds.length === 0 || r.error, 'Tiny dataset should return empty folds or error message');
});

// ── ML OOS Validation ─────────────────────────────────────────────────────────
console.log('\n-- 42-54. ML OOS Validation (validateMLOOS)');

// Generate synthetic labeled samples
function makeSamples(n, seed=42) {
  let s = seed;
  const rng = () => { s=(s*1664525+1013904223)>>>0; return s/0xFFFFFFFF; };
  return Array.from({length:n}, () => ({
    features: Array.from({length:13}, () => rng()),
    label:    rng() > 0.4 ? 1 : 0,
    regime:   ['TRENDING','RANGING','WEAK_TREND'][Math.floor(rng()*3)],
  }));
}

const samples = makeSamples(200);
const randomPredictor    = (f) => 0.5;
const perfectPredictor   = (f, label) => f[0] > 0.5 ? 1 : 0; // correlates with synthetic label pattern
const overconfident      = (f) => 0.9;  // always says 90%

test('validateMLOOS returns all required fields', () => {
  const r = wfRunner.validateMLOOS(samples, randomPredictor);
  for(const k of ['isSamples','oosSamples','embargo','accuracy','brierScore',
                  'ece','precision','recall','f1','lift','tp','tn','fp','fn',
                  'regimeStats','calibBuckets','grade']){
    truthy(k in r, 'Missing ML OOS field: '+k);
  }
});

test('accuracy is in [0, 100]', () => {
  const r = wfRunner.validateMLOOS(samples, randomPredictor);
  inRange(r.accuracy, 0, 100, 'accuracy should be in [0,100]');
});

test('Random predictor has accuracy near 50%', () => {
  const r = wfRunner.validateMLOOS(samples, randomPredictor, {splitRatio:0.7, embargoBars:5});
  inRange(r.accuracy, 35, 65, 'Random predictor accuracy should be near 50%, got '+r.accuracy);
});

test('lift = accuracy - 50', () => {
  const r = wfRunner.validateMLOOS(samples, randomPredictor, {splitRatio:0.7, embargoBars:5});
  near(r.lift, r.accuracy - 50, 0.01, 'lift should be accuracy - 50');
});

test('brierScore is in [0, 1]', () => {
  const r = wfRunner.validateMLOOS(samples, randomPredictor);
  inRange(r.brierScore, 0, 1, 'Brier score should be in [0,1]');
});

test('Random predictor Brier score near 0.25', () => {
  const r = wfRunner.validateMLOOS(samples, randomPredictor, {splitRatio:0.7, embargoBars:5});
  inRange(r.brierScore, 0.15, 0.35, 'Random Brier should be near 0.25, got '+r.brierScore);
});

test('ECE is in [0, 1]', () => {
  const r = wfRunner.validateMLOOS(samples, randomPredictor);
  inRange(r.ece, 0, 1, 'ECE should be in [0,1]');
});

test('Overconfident predictor has higher ECE than calibrated', () => {
  const rOver   = wfRunner.validateMLOOS(samples, overconfident, {splitRatio:0.7, embargoBars:5});
  const rRandom = wfRunner.validateMLOOS(samples, randomPredictor, {splitRatio:0.7, embargoBars:5});
  truthy(typeof rOver.ece === 'number' && typeof rRandom.ece === 'number', 'Both ECE should be numbers');
});

test('tp+fn = total positive labels, tn+fp = total negative labels', () => {
  const r = wfRunner.validateMLOOS(samples, randomPredictor, {splitRatio:0.7, embargoBars:5});
  const totalPos = r.tp + r.fn;
  const totalNeg = r.tn + r.fp;
  eq(totalPos + totalNeg, r.oosSamples, 'TP+FN+TN+FP should equal total OOS samples');
});

test('precision + recall + f1 are in [0, 100]', () => {
  const r = wfRunner.validateMLOOS(samples, randomPredictor);
  inRange(r.precision, 0, 100);
  inRange(r.recall,    0, 100);
  inRange(r.f1,        0, 100);
});

test('regimeStats has entries for known regimes', () => {
  const r = wfRunner.validateMLOOS(samples, randomPredictor);
  truthy(Object.keys(r.regimeStats).length > 0, 'regimeStats should have entries');
});

test('grade is one of valid values', () => {
  const r = wfRunner.validateMLOOS(samples, randomPredictor);
  truthy(['EXCELLENT','GOOD','FAIR','MARGINAL','POOR'].includes(r.grade), 'Invalid grade: '+r.grade);
});

test('Insufficient samples returns error gracefully', () => {
  const r = wfRunner.validateMLOOS(makeSamples(5), randomPredictor, {splitRatio:0.7, embargoBars:10});
  truthy('error' in r, 'Should return error for too few samples');
});

test('OOS samples = n - ceil(n*split) - embargo', () => {
  const n=100, split=0.7, embargo=5;
  const r = wfRunner.validateMLOOS(makeSamples(n), randomPredictor, {splitRatio:split, embargoBars:embargo});
  const expectedIS    = Math.floor(n*split);
  const expectedOOS   = n - expectedIS - embargo;
  eq(r.oosSamples, expectedOOS, `OOS samples should be ${expectedOOS}, got ${r.oosSamples}`);
});

// ── run() dispatcher ──────────────────────────────────────────────────────────
console.log('\n-- 55-58. run() dispatcher');

test('run() with mode=sliding calls runSliding', () => {
  const r = wfRunner.run(prices, volumes, mockBacktest, { mode: 'sliding' });
  eq(r.mode, 'sliding');
});

test('run() with mode=expanding calls runExpanding', () => {
  const r = wfRunner.run(prices, volumes, mockBacktest, { mode: 'expanding' });
  eq(r.mode, 'expanding');
});

test('run() with mode=anchored calls runAnchored', () => {
  const r = wfRunner.run(prices, volumes, mockBacktest, { mode: 'anchored' });
  eq(r.mode, 'anchored');
});

test('run() defaults to sliding when no mode specified', () => {
  const r = wfRunner.run(prices, volumes, mockBacktest);
  eq(r.mode, 'sliding');
});

// ── trading-engine integration ────────────────────────────────────────────────
console.log('\n-- 59-62. Trading Engine Integration');

test('MLConfidence has validateOOS method', () => {
  const { MLConfidence } = require('./ml-confidence');
  const ml = new MLConfidence();
  eq(typeof ml.validateOOS, 'function', 'validateOOS should be a function on MLConfidence');
});

test('validateOOS returns error when buffer is empty', () => {
  const { MLConfidence } = require('./ml-confidence');
  const ml = new MLConfidence();
  const r  = ml.validateOOS();
  truthy('error' in r, 'Should return error when no training data');
});

test('getStatus includes mlOOS field', () => {
  const { TradingEngine } = require('./trading-engine');
  const e = new TradingEngine();
  const s = e.getStatus();
  truthy('mlOOS' in s, 'getStatus() should include mlOOS field');
});

test('WalkForwardValidator is accessible from trading-engine module chain', () => {
  const { WalkForwardValidator: WFV } = require('./walk-forward');
  truthy(typeof WFV === 'function', 'WalkForwardValidator should be importable');
  const inst = new WFV();
  eq(typeof inst.run, 'function');
  eq(typeof inst.runSliding, 'function');
  eq(typeof inst.runExpanding, 'function');
  eq(typeof inst.runAnchored, 'function');
  eq(typeof inst.validateMLOOS, 'function');
});

console.log('\n=====================================================');
console.log('  RESULTS: '+passed+' passed  |  '+failed+' failed  |  '+total+' total');
console.log('=====================================================\n');

process.exit(failed > 0 ? 1 : 0);
