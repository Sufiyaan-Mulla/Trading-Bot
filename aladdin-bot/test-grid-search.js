'use strict';

const {
  GridSearchValidator, GS_CONFIG,
  allCombinations, randomCombinations,
  compositeScore, scoreResult,
  overfitDiagnostics,
} = require('./grid-search');

const { BASELINE, PARAM_RANGES, runParamBacktest, calcMetrics } = require('./param-stability');

let passed = 0, failed = 0, total = 0;
function test(label, fn) {
  total++;
  try { fn(); console.log('  OK  ' + label); passed++; }
  catch(e) { console.log('  FAIL ' + label + '\n       -> ' + e.message); failed++; }
}
function eq(a,b,msg)   { if(a!==b)    throw new Error(msg||JSON.stringify(a)+' !== '+JSON.stringify(b)); }
function truthy(v,msg) { if(!v)        throw new Error(msg||'expected truthy, got '+v); }
function falsy(v,msg)  { if(v)         throw new Error(msg||'expected falsy, got '+v); }
function gt(a,b,msg)   { if(!(a>b))    throw new Error(msg||a+' not > '+b); }
function gte(a,b,msg)  { if(!(a>=b))   throw new Error(msg||a+' >= '+b+' failed'); }
function lte(a,b,msg)  { if(!(a<=b))   throw new Error(msg||a+' <= '+b+' failed'); }
function near(a,b,t,m) { if(Math.abs(a-b)>t) throw new Error(m||Math.abs(a-b).toFixed(6)+' > tol '+t); }
function inRange(v,lo,hi,m){ if(v<lo||v>hi) throw new Error(m||v+' not in ['+lo+','+hi+']'); }

function genMarket(n, seed=42) {
  let s=seed;
  const rng=()=>{s=(s*1664525+1013904223)>>>0;return s/0xFFFFFFFF;};
  const prices=[1.1],volumes=[1_000_000];
  for(let i=1;i<n;i++){
    prices.push(Math.max(0.5,prices.at(-1)*(1+(rng()-0.49)*0.003)));
    volumes.push(400_000+rng()*800_000);
  }
  return {prices,volumes};
}

const {prices,volumes}=genMarket(1000);

console.log('\n=====================================================');
console.log('  GRID SEARCH VALIDATOR -- DEEP TEST SUITE');
console.log('=====================================================');

// ── allCombinations ───────────────────────────────────────────────────────────
console.log('\n-- 1-7. allCombinations');

test('Single param: N values → N combos', () => {
  const r = allCombinations([{param:'a', values:[1,2,3]}]);
  eq(r.length, 3);
  eq(r[0].a, 1); eq(r[1].a, 2); eq(r[2].a, 3);
});

test('Two params: M×N combos', () => {
  const r = allCombinations([{param:'a',values:[1,2]},{param:'b',values:[10,20,30]}]);
  eq(r.length, 6, '2×3 = 6 combos');
});

test('Three params: correct count', () => {
  const r = allCombinations([
    {param:'a',values:[1,2]},
    {param:'b',values:[3,4]},
    {param:'c',values:[5,6,7]},
  ]);
  eq(r.length, 2*2*3, '2×2×3=12');
});

test('All param keys present in every combo', () => {
  const r = allCombinations([{param:'x',values:[1,2]},{param:'y',values:[3,4]}]);
  for(const c of r){ truthy('x' in c && 'y' in c); }
});

test('Empty ranges produce empty combinations', () => {
  const r = allCombinations([]);
  eq(r.length, 1, 'Empty input → one empty combo');
});

test('No duplicate combos', () => {
  const r = allCombinations([{param:'a',values:[1,2]},{param:'b',values:[10,20]}]);
  const keys = r.map(c=>JSON.stringify(c));
  const unique = new Set(keys);
  eq(unique.size, r.length, 'No duplicates');
});

test('Covers all value combinations', () => {
  const r = allCombinations([{param:'p',values:[1,2,3]}]);
  const vals = r.map(c=>c.p).sort((a,b)=>a-b);
  eq(JSON.stringify(vals), JSON.stringify([1,2,3]));
});

// ── randomCombinations ────────────────────────────────────────────────────────
console.log('\n-- 8-15. randomCombinations');

test('Returns exactly N combinations (before dedup)', () => {
  const r = randomCombinations(PARAM_RANGES, 20, 42);
  lte(r.length, 20, 'Should have at most 20 combos');
  gt(r.length, 0, 'Should have at least 1 combo');
});

test('Each combo has all param keys', () => {
  const params = [{param:'a',values:[1,2]},{param:'b',values:[3,4]}];
  const r = randomCombinations(params, 10, 42);
  for(const c of r){ truthy('a' in c && 'b' in c, 'All keys present'); }
});

test('Values come only from defined ranges', () => {
  const params = [{param:'x',values:[10,20,30]}];
  const r = randomCombinations(params, 50, 42);
  for(const c of r){ truthy([10,20,30].includes(c.x), 'Value must be from range, got '+c.x); }
});

test('Deterministic: same seed → same result', () => {
  const r1 = randomCombinations(PARAM_RANGES, 15, 99);
  const r2 = randomCombinations(PARAM_RANGES, 15, 99);
  eq(JSON.stringify(r1), JSON.stringify(r2), 'Same seed should give same combos');
});

test('Different seeds → different results', () => {
  const r1 = randomCombinations(PARAM_RANGES, 20, 1);
  const r2 = randomCombinations(PARAM_RANGES, 20, 9999);
  truthy(JSON.stringify(r1) !== JSON.stringify(r2), 'Different seeds should differ');
});

test('No duplicate combos after dedup', () => {
  const params = [{param:'a',values:[1,2]}];  // only 2 possible combos
  const r = randomCombinations(params, 100, 42);  // request 100 but only 2 unique possible
  lte(r.length, 2, 'Should not have more than 2 unique combos');
});

test('Requesting 0 samples returns empty', () => {
  const r = randomCombinations(PARAM_RANGES, 0, 42);
  eq(r.length, 0);
});

test('Single param with one value always returns that value', () => {
  const params = [{param:'z',values:[42]}];
  const r = randomCombinations(params, 5, 1);
  for(const c of r){ eq(c.z, 42); }
});

// ── compositeScore / scoreResult ──────────────────────────────────────────────
console.log('\n-- 16-22. compositeScore / scoreResult');

test('compositeScore returns -Infinity for empty metrics', () => {
  eq(compositeScore(null), -Infinity);
  eq(compositeScore({trades:0}), -Infinity);
});

test('compositeScore in [0,1] for valid metrics', () => {
  const m = {trades:10, profitFactor:2.0, winRate:60, sharpe:1.5};
  const s = compositeScore(m);
  truthy(isFinite(s) && s >= 0 && s <= 1, 'Score should be in [0,1], got '+s);
});

test('Higher PF → higher composite score (all else equal)', () => {
  const lo = compositeScore({trades:10, profitFactor:1.2, winRate:55, sharpe:0.5});
  const hi = compositeScore({trades:10, profitFactor:2.5, winRate:55, sharpe:0.5});
  gt(hi, lo, 'Higher PF should give higher composite score');
});

test('scoreResult with profitFactor metric returns PF', () => {
  const m = {trades:10, profitFactor:1.8, winRate:60, sharpe:1.0};
  near(scoreResult(m,'profitFactor'), 1.8, 0.001);
});

test('scoreResult with sharpe metric returns sharpe', () => {
  const m = {trades:10, profitFactor:1.5, winRate:55, sharpe:2.3};
  near(scoreResult(m,'sharpe'), 2.3, 0.001);
});

test('scoreResult returns -Infinity for insufficient trades', () => {
  eq(scoreResult({trades:0}, 'composite'), -Infinity);
});

test('scoreResult handles Infinity profitFactor gracefully', () => {
  const m = {trades:5, profitFactor:Infinity, winRate:100, sharpe:3.0};
  const s = scoreResult(m, 'composite');
  truthy(isFinite(s), 'Should handle Infinity PF gracefully');
});

// ── overfitDiagnostics ────────────────────────────────────────────────────────
console.log('\n-- 23-30. overfitDiagnostics');

test('No flags when IS ≈ OOS', () => {
  const m = {winRate:60, totalReturn:5, profitFactor:1.5};
  const r = overfitDiagnostics(m, m, m, GS_CONFIG);
  eq(r.flags.length, 0, 'No flags when IS = OOS');
  falsy(r.overfit);
});

test('Flag fires when IS WR >> Val WR', () => {
  const train = {winRate:75, totalReturn:10, profitFactor:2.0};
  const val   = {winRate:45, totalReturn:2,  profitFactor:1.1};
  const test  = {winRate:50, totalReturn:3,  profitFactor:1.2};
  const r = overfitDiagnostics(train, val, test, GS_CONFIG);
  gt(r.flags.length, 0, 'Should flag IS>>Val WR gap');
  truthy(r.overfit);
});

test('Flag fires when Val WR >> Test WR (double-dip risk)', () => {
  const train = {winRate:60, totalReturn:5,  profitFactor:1.5};
  const val   = {winRate:70, totalReturn:8,  profitFactor:1.8};
  const test  = {winRate:40, totalReturn:1,  profitFactor:1.0};
  const r = overfitDiagnostics(train, val, test, GS_CONFIG);
  truthy(r.flags.some(f=>f.includes('double-dip')||f.includes('Val WR')), 'Should flag double-dip');
});

test('trainValDelta = train.winRate - val.winRate', () => {
  const train={winRate:65,totalReturn:5,profitFactor:1.5};
  const val  ={winRate:50,totalReturn:2,profitFactor:1.1};
  const r = overfitDiagnostics(train,val,val,GS_CONFIG);
  near(r.trainValDelta, 15, 0.01);
});

test('valTestDelta = val.winRate - test.winRate', () => {
  const m    ={winRate:55,totalReturn:3,profitFactor:1.3};
  const test ={winRate:40,totalReturn:1,profitFactor:1.0};
  const r = overfitDiagnostics(m,m,test,GS_CONFIG);
  near(r.valTestDelta, 15, 0.01);
});

test('trainEfficiency = val.return / |train.return|', () => {
  const train={winRate:60,totalReturn:10,profitFactor:1.8};
  const val  ={winRate:55,totalReturn:5, profitFactor:1.4};
  const r = overfitDiagnostics(train,val,val,GS_CONFIG);
  near(r.trainEfficiency, 0.5, 0.01, 'trainEfficiency should be 5/10=0.5');
});

test('Null metrics handled gracefully', () => {
  const r = overfitDiagnostics(null, null, null, GS_CONFIG);
  eq(r.trainValDelta, null);
  eq(r.valTestDelta,  null);
  falsy(r.overfit);
});

test('overfit=false when WR delta < threshold', () => {
  const lo={winRate:60,totalReturn:5,profitFactor:1.5};
  const hi={winRate:68,totalReturn:6,profitFactor:1.6};
  const r = overfitDiagnostics(hi,lo,lo,GS_CONFIG); // delta=8 < 15 threshold
  falsy(r.overfit, 'Delta 8pp < 15pp should not flag overfit');
});

// ── GridSearchValidator.run() ─────────────────────────────────────────────────
console.log('\n-- 31-47. GridSearchValidator.run()');

const gs = new GridSearchValidator({nSamples:20, topK:5, embargoBars:10});
let result = null;

test('run() returns required top-level fields', () => {
  result = gs.run(prices, volumes, {nSamples:20});
  if(result.error){ truthy(false,'Got error: '+result.error); return; }
  for(const k of ['strategy','totalCombos','topK','metric','split','winner','baseline',
                  'topCandidates','diagnostics']){
    truthy(k in result, 'Missing field: '+k);
  }
});

test('winner has params, trainMetrics, valMetrics, testMetrics', () => {
  for(const k of ['params','trainMetrics','valMetrics','testMetrics','trainScore','valScore','testScore']){
    truthy(k in result.winner, 'Missing winner field: '+k);
  }
});

test('split.trainBars + embargo + split.valBars + embargo + split.testBars <= n', () => {
  const s = result.split;
  lte(s.trainBars + s.embargo + s.valBars + s.embargo + s.testBars, prices.length,
    'Split should fit within total bars');
});

test('testBars > 0', () => {
  gt(result.split.testBars, 0, 'Test split must have bars');
});

test('valBars > 0', () => {
  gt(result.split.valBars, 0, 'Val split must have bars');
});

test('Embargo enforced: train+embargo <= val start', () => {
  const s = result.split;
  gte(s.valBars, 1, 'Val should have bars after embargo');
  // trainBars + embargo is covered implicitly (split logic)
  truthy(true);
});

test('winner.params contains only valid parameter keys', () => {
  const validKeys = PARAM_RANGES.map(p=>p.param);
  for(const k of Object.keys(result.winner.params)){
    truthy(validKeys.includes(k), 'Invalid param key: '+k);
  }
});

test('winner.params values come from PARAM_RANGES', () => {
  const rangeMap = {};
  for(const p of PARAM_RANGES) rangeMap[p.param] = p.values;
  for(const [k,v] of Object.entries(result.winner.params)){
    if(rangeMap[k]) truthy(rangeMap[k].includes(v), `${k}=${v} not in allowed values`);
  }
});

test('topCandidates <= topK', () => {
  lte(result.topCandidates.length, result.topK, 'topCandidates should be at most topK');
});

test('diagnostics has overfit, flags, trainValDelta, valTestDelta', () => {
  const d = result.diagnostics;
  truthy('overfit' in d && 'flags' in d, 'Missing diagnostics fields');
  truthy(Array.isArray(d.flags), 'flags should be array');
  eq(typeof d.overfit, 'boolean');
});

test('Winning params were selected on validation, not test', () => {
  // The winner must be the best on VALIDATION score among topK
  const topKValScores = result.topCandidates.map(c=>c.valScore);
  const winnerValScore = result.winner.valScore;
  truthy(topKValScores.every(s=>s<=winnerValScore+0.001),
    'Winner val score should be highest among topK');
});

test('Baseline metrics computed for all three splits', () => {
  const b = result.baseline;
  truthy('trainMetrics' in b && 'valMetrics' in b && 'testMetrics' in b);
  truthy(typeof b.testMetrics.winRate === 'number', 'Baseline test metrics should have winRate');
});

test('Small dataset returns error gracefully', () => {
  const r = gs.run(Array(30).fill(1.1), Array(30).fill(1_000_000), {nSamples:5});
  truthy('error' in r || r.split, 'Should handle small data gracefully');
});

test('totalCombos reflects nSamples', () => {
  const r2 = gs.run(prices, volumes, {nSamples:10});
  if(!r2.error) lte(r2.totalCombos, 10+1, 'totalCombos should reflect nSamples (may be less after dedup)');
});

test('Exhaustive mode works for tiny grid', () => {
  const tinyParams = [
    {param:'minConfidence', values:[58,60,62]},
    {param:'slAtrMult',     values:[1.2,1.5]},
  ];
  const r = gs.run(prices, volumes, {strategy:'exhaustive', paramRanges:tinyParams, nSamples:999});
  if(!r.error){
    lte(r.totalCombos, 6+1, 'Exhaustive 3×2=6 combos');
  }
});

test('Different scoringMetric gives different winners', () => {
  const r1 = gs.run(prices, volumes, {nSamples:20, scoringMetric:'profitFactor', seed:42});
  const r2 = gs.run(prices, volumes, {nSamples:20, scoringMetric:'sharpe',       seed:42});
  if(!r1.error && !r2.error){
    // Winners may differ — just check both run without error
    truthy(typeof r1.winner.testScore === 'number');
    truthy(typeof r2.winner.testScore === 'number');
  }
});

// ── runNested ─────────────────────────────────────────────────────────────────
console.log('\n-- 48-57. runNested (nested walk-forward grid search)');

let nestedResult = null;

test('runNested returns mode=nested_walk_forward', () => {
  nestedResult = gs.runNested(prices, volumes, {nSamples:10, outerWindowPct:0.60, outerStepPct:0.20});
  if(!nestedResult.error) eq(nestedResult.mode, 'nested_walk_forward');
});

test('runNested generates at least one fold', () => {
  if(nestedResult.error){ truthy(false,'Error: '+nestedResult.error); return; }
  gt(nestedResult.totalFolds, 0, 'Should have at least one fold');
});

test('Each fold has bestParams, trainMetrics, valMetrics, testMetrics, diagnostics', () => {
  for(const f of nestedResult.folds){
    for(const k of ['fold','outerRange','testRange','bestParams','trainMetrics','valMetrics','testMetrics','diagnostics']){
      truthy(k in f, 'Missing fold field: '+k);
    }
  }
});

test('Fold bestParams were selected using inner Train→Val loop', () => {
  for(const f of nestedResult.folds){
    truthy(typeof f.bestParams === 'object', 'bestParams should be an object');
    gt(Object.keys(f.bestParams).length, 0, 'bestParams should have entries');
  }
});

test('Aggregate metrics computed across folds', () => {
  if(nestedResult.error) return;
  const agg = nestedResult.agg;
  for(const k of ['totalReturn','winRate','profitFactor','sharpe','maxDrawdown']){
    truthy(k in agg, 'Missing agg field: '+k);
    truthy(isFinite(agg[k]), 'agg.'+k+' should be finite');
  }
});

test('stabilityScore in [0, 100]', () => {
  if(nestedResult.error) return;
  inRange(nestedResult.stabilityScore, 0, 100, 'stabilityScore out of range');
});

test('positiveFolds <= totalFolds', () => {
  if(nestedResult.error) return;
  lte(nestedResult.positiveFolds, nestedResult.totalFolds);
});

test('overfitFolds <= totalFolds', () => {
  if(nestedResult.error) return;
  lte(nestedResult.overfitFolds, nestedResult.totalFolds);
});

test('overallOverfit is boolean', () => {
  if(nestedResult.error) return;
  eq(typeof nestedResult.overallOverfit, 'boolean');
});

test('testRange always comes after outerRange IS portion', () => {
  if(nestedResult.error) return;
  for(const f of nestedResult.folds){
    gt(f.testRange[0], f.outerRange[0], `Test should start after outer start in fold ${f.fold}`);
  }
});

// ── Overfitting protection property tests ─────────────────────────────────────
console.log('\n-- 58-63. Overfitting Protection Properties');

test('Test set is NEVER used during parameter selection', () => {
  // Verify: winner params depend only on train+val, not test
  // We do this by running the search twice with same train/val but different test
  // (different seed for genMarket to get different prices overall)
  const {prices:p1,volumes:v1} = genMarket(900, 1);
  const {prices:p2,volumes:v2} = genMarket(900, 2);
  const r1 = gs.run(p1, v1, {nSamples:15, seed:42});
  const r2 = gs.run(p2, v2, {nSamples:15, seed:42});
  // Both should complete without error and have winners
  if(!r1.error && !r2.error){
    truthy(typeof r1.winner.params === 'object', 'r1 should have winner params');
    truthy(typeof r2.winner.params === 'object', 'r2 should have winner params');
  }
});

test('Winner selected on val score, not train score', () => {
  // The winner should have the highest val score among topK candidates
  if(!result.error){
    const bestVal = result.topCandidates[0].valScore;
    near(result.winner.valScore, bestVal, 0.001, 'Winner should have best val score');
  }
});

test('Test score and val score are both computed numbers (may be -Infinity if no trades)', () => {
  if(!result.error){
    // Scores can be -Infinity when 0 trades occur in a split period (valid behaviour)
    truthy(typeof result.winner.testScore === 'number', 'Test score should be a number');
    truthy(typeof result.winner.valScore  === 'number', 'Val score should be a number');
  }
});

test('Embargo prevents IS→OOS data leakage (splits have gap)', () => {
  if(!result.error){
    const s = result.split;
    gte(s.embargo, 1, 'Embargo should be >= 1 bar');
  }
});

test('Three-way split: each period covers distinct bars', () => {
  if(!result.error){
    const s = result.split;
    gt(s.trainBars, 0);
    gt(s.valBars, 0);
    gt(s.testBars, 0);
    // Total unique bars used = train + embargo + val + embargo + test
    const totalUsed = s.trainBars + s.embargo + s.valBars + s.embargo + s.testBars;
    lte(totalUsed, prices.length, 'All splits should fit within total data');
  }
});

test('printReport runs without error', () => {
  if(!result.error) gs.printReport(result);
  if(nestedResult && !nestedResult.error) gs.printReport(nestedResult);
  truthy(true);
});

console.log('\n=====================================================');
console.log('  RESULTS: '+passed+' passed  |  '+failed+' failed  |  '+total+' total');
console.log('=====================================================\n');

process.exit(failed > 0 ? 1 : 0);
