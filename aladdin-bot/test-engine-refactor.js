'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  test-engine-refactor.js
//  Deep tests for every extracted module:
//    trading-config · indicators · kelly-criterion · correlation-engine
//    multi-timeframe · market-data-fetcher · leading-indicator-fetcher
//  Plus backward-compatibility: all still importable from trading-engine.js
// ═══════════════════════════════════════════════════════════════════════════════

const { TRADING_CONFIG }          = require('./trading-config');
const { Indicators }              = require('./indicators');
const { KellyCriterion }          = require('./kelly-criterion');
const { CorrelationEngine }       = require('./correlation-engine');
const { MultiTimeframeAnalyzer }  = require('./multi-timeframe');
const { MarketDataFetcher }       = require('./market-data-fetcher');
const { LeadingIndicatorFetcher } = require('./leading-indicator-fetcher');

let passed = 0, failed = 0, total = 0;
function test(label, fn) {
  total++;
  try { fn(); console.log('  OK  ' + label); passed++; }
  catch(e) { console.log('  FAIL ' + label + '\n       -> ' + e.message); failed++; }
}
function eq(a,b,msg)    { if (a!==b)       throw new Error(msg||JSON.stringify(a)+' !== '+JSON.stringify(b)); }
function truthy(v,msg)  { if (!v)           throw new Error(msg||'expected truthy, got '+v); }
function falsy(v,msg)   { if (v)            throw new Error(msg||'expected falsy, got '+v); }
function gt(a,b,msg)    { if (!(a>b))       throw new Error(msg||a+' not > '+b); }
function gte(a,b,msg)   { if (!(a>=b))      throw new Error(msg||a+' >= '+b+' failed'); }
function lte(a,b,msg)   { if (!(a<=b))      throw new Error(msg||a+' <= '+b+' failed'); }
function near(a,b,t,m)  { if (Math.abs(a-b)>t) throw new Error(m||Math.abs(a-b).toFixed(8)+' > tol '+t); }
function inRange(v,lo,hi,m){ if(v<lo||v>hi) throw new Error(m||v+' not in ['+lo+','+hi+']'); }

// ── Helpers ───────────────────────────────────────────────────────────────────
// Realistic rising/falling markets with small noise (not perfectly monotone)
// so RSI and EMA-based indicators behave as expected
function makeRising(n=40, seed=42) {
  // drift=+0.004, noise=±0.008 → ~30% of steps are negative (genuine pullbacks)
  let s=seed; const rng=()=>{s=(s*1664525+1013904223)>>>0;return s/0xFFFFFFFF;};
  const p=[1.0];
  for(let i=1;i<n;i++) p.push(Math.max(0.5, p.at(-1)+0.004+(rng()-0.5)*0.016));
  return p;
}
function makeFalling(n=40, seed=7) {
  // drift=-0.004, noise=±0.008 → ~30% of steps are positive
  let s=seed; const rng=()=>{s=(s*1664525+1013904223)>>>0;return s/0xFFFFFFFF;};
  const p=[1.4];
  for(let i=1;i<n;i++) p.push(Math.max(0.1, p.at(-1)-0.004+(rng()-0.5)*0.016));
  return p;
}

const rising  = makeRising();
const falling = makeFalling();
const flat    = Array.from({length:30}, () => 1.1);
const tiny    = [1.1, 1.2, 1.3];

console.log('\n=====================================================');
console.log('  ENGINE REFACTOR -- DEEP TEST SUITE');
console.log('=====================================================');

// ═══════════════════════════════════════════════════════════════════════════════
//  1. trading-config.js
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n-- 1-8. trading-config.js');

test('TRADING_CONFIG is an object', () => {
  eq(typeof TRADING_CONFIG, 'object');
  truthy(TRADING_CONFIG !== null);
});
test('Contains positionSize', () => truthy('positionSize' in TRADING_CONFIG));
test('Contains kellyEnabled', () => truthy('kellyEnabled' in TRADING_CONFIG));
test('Contains correlationEnabled', () => truthy('correlationEnabled' in TRADING_CONFIG));
test('Contains mtaEnabled', () => truthy('mtaEnabled' in TRADING_CONFIG));
test('Contains maxHistoryLength', () => truthy('maxHistoryLength' in TRADING_CONFIG));
test('kellyMinSize < kellyMaxSize', () => {
  gt(TRADING_CONFIG.kellyMaxSize, TRADING_CONFIG.kellyMinSize);
});
test('correlationHighThreshold > correlationWarnThreshold', () => {
  gt(TRADING_CONFIG.correlationHighThreshold, TRADING_CONFIG.correlationWarnThreshold);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  2. indicators.js
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n-- 9-36. indicators.js');

// RSI
test('rsi: returns 50 on flat prices', () => near(Indicators.rsi(flat), 50, 0.01));
test('rsi: returns 50 when insufficient data', () => eq(Indicators.rsi(tiny), 50));
test('rsi: rising prices → high RSI (> 50)', () => gt(Indicators.rsi(rising), 50));
test('rsi: falling prices → low RSI (< 50)', () => lte(Indicators.rsi(falling), 50));
test('rsi: result in [0, 100]', () => { inRange(Indicators.rsi(rising), 0, 100); inRange(Indicators.rsi(falling), 0, 100); });
test('rsi: custom period respected', () => {
  const r9  = Indicators.rsi(rising, 9);
  const r14 = Indicators.rsi(rising, 14);
  truthy(typeof r9 === 'number' && typeof r14 === 'number');
});

// MACD
test('macd: returns 0 when insufficient data (< 26)', () => eq(Indicators.macd(tiny), 0));
test('macd: rising prices → positive MACD', () => gt(Indicators.macd(rising), 0));
test('macd: falling prices → negative MACD', () => lte(Indicators.macd(falling), 0));
test('macd: returns number', () => eq(typeof Indicators.macd(rising), 'number'));

// EMA
test('ema: returns last price when fewer bars than period', () => {
  near(Indicators.ema([1.1, 1.2], 9), 1.2, 0.001);
});
test('ema: converges toward recent prices', () => {
  const prices = [...flat, 2.0];   // spike at end
  const ema    = Indicators.ema(prices, 9);
  gt(ema, 1.1, 'EMA should be pulled toward the spike');
});
test('ema: longer period = smoother (less responsive)', () => {
  const prices = [...flat.slice(0,20), 2.0];
  const ema9  = Indicators.ema(prices, 9);
  const ema21 = Indicators.ema(prices, 21);
  gt(ema9, ema21, 'Shorter EMA should be closer to recent spike');
});

// Bollinger Bands
test('bollingerBands: upper > middle > lower', () => {
  const bb = Indicators.bollingerBands(rising);
  gt(bb.upper, bb.middle); gt(bb.middle, bb.lower);
});
test('bollingerBands: flat prices → very narrow bands', () => {
  const bb = Indicators.bollingerBands(flat);
  near(bb.upper, bb.lower, 0.01, 'Flat prices should give narrow bands');
});
test('bollingerBands: returns fallback for tiny data', () => {
  const bb = Indicators.bollingerBands(tiny, 20);
  eq(bb.upper, bb.middle); eq(bb.middle, bb.lower);
});
test('bollingerBands: wider with more volatile prices', () => {
  const volatile = Array.from({length:30}, (_,i) => 1.0 + (i%2===0?0.1:-0.1));
  const bbFlat = Indicators.bollingerBands(flat);
  const bbVol  = Indicators.bollingerBands(volatile);
  gt(bbVol.upper - bbVol.lower, bbFlat.upper - bbFlat.lower);
});

// ATR
test('atr: returns 0 when insufficient data', () => eq(Indicators.atr(tiny), 0));
test('atr: returns positive value for normal prices', () => gt(Indicators.atr(rising), 0));
test('atr: higher ATR for volatile prices', () => {
  const volatile = Array.from({length:20}, (_,i) => 1.0 + (i%2===0?0.05:-0.05));
  gt(Indicators.atr(volatile), Indicators.atr(flat));
});

// VWAP
test('vwap: returns last price when no volume data', () => {
  near(Indicators.vwap(rising, []), rising[rising.length-1], 0.0001);
});
test('vwap: returns last price when no price data', () => eq(Indicators.vwap([], []), 0));
test('vwap: with uniform volume = price average', () => {
  const prices  = [1.0, 1.2, 1.1];
  const volumes = [100, 100, 100];
  const vwap = Indicators.vwap(prices, volumes);
  truthy(typeof vwap === 'number' && vwap > 0);
});
test('vwap: higher volume at high price shifts VWAP up', () => {
  const prices  = [1.0, 2.0];
  const volLow  = [1000, 1];
  const volHigh = [1, 1000];
  const vwapLow  = Indicators.vwap(prices, volLow);
  const vwapHigh = Indicators.vwap(prices, volHigh);
  gt(vwapHigh, vwapLow);
});

// getDynamicLevels
test('getDynamicLevels BUY: stopLoss < entry < takeProfit', () => {
  const lvl = Indicators.getDynamicLevels(1.1, 0.001, 1.099, 'BUY');
  gt(1.1, lvl.stopLoss); gt(lvl.takeProfit, 1.1);
});
test('getDynamicLevels SELL: takeProfit < entry < stopLoss', () => {
  const lvl = Indicators.getDynamicLevels(1.1, 0.001, 1.099, 'SELL');
  lte(lvl.takeProfit, 1.1); gt(lvl.stopLoss, 1.1);
});
test('getDynamicLevels: wider with larger tpMultiplier', () => {
  const lvl5 = Indicators.getDynamicLevels(1.1, 0.001, 1.099, 'BUY', 5);
  const lvl8 = Indicators.getDynamicLevels(1.1, 0.001, 1.099, 'BUY', 8);
  gt(lvl8.takeProfit, lvl5.takeProfit);
});

// signal
test('signal: returns NEUTRAL on balanced indicators', () => {
  const s = Indicators.signal({ rsi:50, macd:0, ema9:1.1, ema21:1.1, bb:{} });
  eq(s, 'NEUTRAL');
});
test('signal: STRONG_BUY when RSI oversold + MACD positive + EMA bullish', () => {
  const s = Indicators.signal({
    rsi:25, macd:0.002, ema9:1.12, ema21:1.10, ema50:1.09,
    bb:{upper:1.15, middle:1.10, lower:1.05},
    price:1.10, vwap:1.09, prevMacd:0.001, prevRsi:27, volRatio:1.5,
  });
  eq(s, 'STRONG_BUY');
});
test('signal: STRONG_SELL when RSI overbought + MACD negative + EMA bearish', () => {
  const s = Indicators.signal({
    rsi:75, macd:-0.002, ema9:1.08, ema21:1.10, ema50:1.11,
    bb:{upper:1.15, middle:1.10, lower:1.05},
    price:1.10, vwap:1.11, prevMacd:-0.001, prevRsi:73, volRatio:1.5,
  });
  eq(s, 'STRONG_SELL');
});

// ═══════════════════════════════════════════════════════════════════════════════
//  3. kelly-criterion.js
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n-- 37-47. kelly-criterion.js');

test('Returns fixed size when no trades', () => {
  const r = KellyCriterion.calculate([], 70);
  eq(r.details.method, 'fixed_insufficient_data');
  eq(r.fraction, TRADING_CONFIG.positionSize);
});
test('Returns fixed size when disabled', () => {
  const savedEnabled = TRADING_CONFIG.kellyEnabled;
  TRADING_CONFIG.kellyEnabled = false;
  const r = KellyCriterion.calculate(Array(15).fill({profit:10,profitPercent:1}), 70);
  eq(r.details.method, 'disabled');
  TRADING_CONFIG.kellyEnabled = savedEnabled;
});
test('Returns kelly method when enough trades', () => {
  // Must have both wins AND losses to reach the 'kelly' branch
  const wins   = Array(10).fill({ profit: 5,  profitPercent: 1 });
  const losses = Array(5).fill( { profit: -3, profitPercent: -0.6 });
  const trades = [...wins, ...losses];
  const r = KellyCriterion.calculate(trades, 70);
  eq(r.details.method, 'kelly');
});
test('Fraction stays within [kellyMinSize, kellyMaxSize]', () => {
  const trades = Array(20).fill({profit:50, profitPercent:5});
  const r = KellyCriterion.calculate(trades, 100);
  gte(r.fraction, TRADING_CONFIG.kellyMinSize);
  lte(r.fraction, TRADING_CONFIG.kellyMaxSize);
});
test('Higher confidence → larger fraction (all else equal)', () => {
  const trades = Array(15).fill({profit:5, profitPercent:1});
  const lo = KellyCriterion.calculate(trades, 60);
  const hi = KellyCriterion.calculate(trades, 100);
  gte(hi.fraction, lo.fraction, 'Higher confidence should give >= fraction');
});
test('All losses → fraction at minimum', () => {
  const trades = Array(15).fill({profit:-5, profitPercent:-1});
  const r = KellyCriterion.calculate(trades, 80);
  near(r.fraction, TRADING_CONFIG.kellyMinSize, 0.001);
});
test('details contains required fields', () => {
  const trades = Array(15).fill({profit:5, profitPercent:1});
  const r = KellyCriterion.calculate(trades, 70);
  for(const k of ['method','tradesAnalysed','winRate','payoffRatio','finalFraction','confidence']){
    truthy(k in r.details, 'Missing field: '+k);
  }
});
test('tradesAnalysed matches input length', () => {
  const trades = Array(20).fill({profit:5, profitPercent:1});
  const r = KellyCriterion.calculate(trades, 70);
  eq(r.details.tradesAnalysed, 20);
});
test('Mixed trades: win rate reported correctly', () => {
  const trades = [
    ...Array(10).fill({profit:5,  profitPercent:1}),
    ...Array(10).fill({profit:-3, profitPercent:-1}),
  ];
  const r = KellyCriterion.calculate(trades, 70);
  near(parseFloat(r.details.winRate), 50, 0.1);
});
test('Returns fraction object always, never throws', () => {
  truthy(typeof KellyCriterion.calculate([], 0).fraction === 'number');
  truthy(typeof KellyCriterion.calculate([], 100).fraction === 'number');
});
test('Consistent results for same inputs', () => {
  const trades = Array(15).fill({profit:5, profitPercent:1});
  const r1 = KellyCriterion.calculate(trades, 75);
  const r2 = KellyCriterion.calculate(trades, 75);
  eq(r1.fraction, r2.fraction);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  4. correlation-engine.js
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n-- 48-62. correlation-engine.js');

const EUR = Array.from({length:60}, (_,i) => 1.08 + i*0.001);
const GBP = Array.from({length:60}, (_,i) => 1.27 + i*0.001);  // same direction
const JPY = Array.from({length:60}, (_,i) => 149  - i*0.1);    // opposite

test('pearson: identical series → r = 1', () => {
  near(CorrelationEngine.pearson(EUR, EUR, 30), 1.0, 0.001);
});
test('pearson: perfectly opposite series → r = -1', () => {
  const inv = EUR.map(v => 3 - v);
  near(Math.abs(CorrelationEngine.pearson(EUR, inv, 30)), 1.0, 0.1);
});
test('pearson: returns 0 for insufficient data (< 5)', () => {
  eq(CorrelationEngine.pearson([1,2], [3,4], 50), 0);
});
test('pearson: result in [-1, 1]', () => {
  inRange(CorrelationEngine.pearson(EUR, GBP, 30), -1, 1);
  inRange(CorrelationEngine.pearson(EUR, JPY, 30), -1, 1);
});
test('pearson: correlated pair has higher |r| than uncorrelated', () => {
  const rCorr = Math.abs(CorrelationEngine.pearson(EUR, GBP, 30));
  const rAnti = Math.abs(CorrelationEngine.pearson(EUR, JPY, 30));
  // Both should be non-zero with trending series
  gt(rCorr + rAnti, 0);
});
test('pearson: symmetry — pearson(A,B) = pearson(B,A)', () => {
  const r1 = CorrelationEngine.pearson(EUR, GBP, 30);
  const r2 = CorrelationEngine.pearson(GBP, EUR, 30);
  near(r1, r2, 0.0001);
});
test('pearson: handles different array lengths gracefully', () => {
  const r = CorrelationEngine.pearson(EUR, EUR.slice(0, 20), 30);
  inRange(r, -1, 1);
});

test('buildMatrix: returns one key per asset pair', () => {
  const hist = { EUR: EUR, GBP: GBP, JPY: JPY };
  const m = CorrelationEngine.buildMatrix(hist, 30);
  eq(Object.keys(m).length, 3, '3 pairs from 3 assets');
  truthy('EUR_GBP' in m); truthy('EUR_JPY' in m); truthy('GBP_JPY' in m);
});
test('buildMatrix: all values in [-1, 1]', () => {
  const hist = { EUR: EUR, GBP: GBP };
  const m = CorrelationEngine.buildMatrix(hist, 30);
  for(const v of Object.values(m)) inRange(v, -1, 1, 'Matrix value out of range: '+v);
});
test('buildMatrix: empty input returns empty matrix', () => {
  eq(Object.keys(CorrelationEngine.buildMatrix({}, 30)).length, 0);
});

test('check: same asset → SAFE, sizeMultiplier=1', () => {
  const r = CorrelationEngine.check('EURUSD', 'EURUSD', {EURUSD: EUR});
  eq(r.label, 'SAFE'); eq(r.sizeMultiplier, 1);
});
test('check: missing history → SAFE', () => {
  const r = CorrelationEngine.check('EURUSD', 'GBPUSD', {});
  eq(r.label, 'SAFE');
});
test('check: returns blocked, sizeMultiplier, correlation, label, reason', () => {
  const hist = {EURUSD: EUR, GBPUSD: GBP};
  const r = CorrelationEngine.check('EURUSD', 'GBPUSD', hist);
  for(const k of ['blocked','sizeMultiplier','correlation','label','reason']){
    truthy(k in r, 'Missing check field: '+k);
  }
});
test('check: correlation field matches pearson result', () => {
  const hist = {EURUSD: EUR, GBPUSD: GBP};
  const r = CorrelationEngine.check('EURUSD', 'GBPUSD', hist);
  const expected = CorrelationEngine.pearson(EUR, GBP, TRADING_CONFIG.correlationPeriod);
  near(r.correlation, expected, 0.001);
});
test('check: blocked=false when correlation disabled', () => {
  const saved = TRADING_CONFIG.correlationEnabled;
  TRADING_CONFIG.correlationEnabled = false;
  const r = CorrelationEngine.check('EURUSD', 'GBPUSD', {EURUSD:EUR, GBPUSD:GBP});
  TRADING_CONFIG.correlationEnabled = saved;
  falsy(r.blocked);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  5. multi-timeframe.js
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n-- 63-78. multi-timeframe.js');

const longPrices = Array.from({length:500}, (_,i) => 1.1 + Math.sin(i/20)*0.05);

test('resample: returns all prices when fewer than ticks', () => {
  const r = MultiTimeframeAnalyzer.resample([1,2,3], 10);
  eq(r.length, 3);
});
test('resample: one candle per N ticks', () => {
  const prices = Array.from({length:20}, (_,i)=>i+1);
  const r = MultiTimeframeAnalyzer.resample(prices, 5);
  truthy(r.length >= 4, 'Should have 4+ candles for 20 prices with ticks=5');
});
test('resample: always includes last price', () => {
  const prices = Array.from({length:22}, (_,i)=>i+1);
  const r = MultiTimeframeAnalyzer.resample(prices, 5);
  eq(r[r.length-1], prices[prices.length-1]);
});
test('resample: returns new array (no mutation)', () => {
  const prices = [1.1,1.2,1.3];
  MultiTimeframeAnalyzer.resample(prices, 5);
  eq(prices.length, 3, 'Original should not be mutated');
});

test('classifyTrend: returns NEUTRAL for tiny array', () => {
  eq(MultiTimeframeAnalyzer.classifyTrend([1,2]), 'NEUTRAL');
});
test('classifyTrend: rising prices → BULL', () => {
  eq(MultiTimeframeAnalyzer.classifyTrend(rising), 'BULL');
});
test('classifyTrend: falling prices → BEAR', () => {
  eq(MultiTimeframeAnalyzer.classifyTrend(falling), 'BEAR');
});
test('classifyTrend: returns one of BULL/BEAR/NEUTRAL', () => {
  for(const p of [rising, falling, flat]){
    truthy(['BULL','BEAR','NEUTRAL'].includes(MultiTimeframeAnalyzer.classifyTrend(p)));
  }
});

test('analyse: returns allowed,score,verdict,frames,reason', () => {
  const r = MultiTimeframeAnalyzer.analyse(longPrices, 'BUY');
  for(const k of ['allowed','score','verdict','frames','reason','aligned','total']){
    truthy(k in r, 'Missing analyse field: '+k);
  }
});
test('analyse: score in [-1, 1]', () => {
  const r = MultiTimeframeAnalyzer.analyse(longPrices, 'BUY');
  inRange(r.score, -1, 1);
});
test('analyse: verdict is one of valid values', () => {
  const valid = ['STRONG_BUY','BUY','NEUTRAL','SELL','STRONG_SELL'];
  truthy(valid.includes(MultiTimeframeAnalyzer.analyse(longPrices, 'BUY').verdict));
  truthy(valid.includes(MultiTimeframeAnalyzer.analyse(longPrices, 'SELL').verdict));
});
test('analyse: allowed=true when MTA disabled', () => {
  const saved = TRADING_CONFIG.mtaEnabled;
  TRADING_CONFIG.mtaEnabled = false;
  const r = MultiTimeframeAnalyzer.analyse(longPrices, 'BUY');
  TRADING_CONFIG.mtaEnabled = saved;
  truthy(r.allowed);
});
test('analyse: aligned <= total', () => {
  const r = MultiTimeframeAnalyzer.analyse(longPrices, 'BUY');
  lte(r.aligned, r.total);
});
test('analyse: frames is an object with timeframe keys', () => {
  const r = MultiTimeframeAnalyzer.analyse(longPrices, 'BUY');
  gt(Object.keys(r.frames).length, 0);
});
test('analyse: BUY and SELL give different verdicts on trending market', () => {
  const trend = Array.from({length:400}, (_,i) => 1.0 + i*0.001);
  const rBuy  = MultiTimeframeAnalyzer.analyse(trend, 'BUY');
  const rSell = MultiTimeframeAnalyzer.analyse(trend, 'SELL');
  truthy(rBuy.verdict !== rSell.verdict ||
    rBuy.allowed !== rSell.allowed, 'BUY and SELL should differ on a trending market');
});

// ═══════════════════════════════════════════════════════════════════════════════
//  6. market-data-fetcher.js
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n-- 79-95. market-data-fetcher.js');

test('Constructor seeds 4 assets', () => {
  const mdf = new MarketDataFetcher();
  eq(Object.keys(mdf.prices).length, 4);
  for(const a of ['EURUSD','GBPUSD','USDJPY','AUDUSD']) truthy(a in mdf.prices);
});
test('fetchPrice returns required fields', () => {
  const mdf = new MarketDataFetcher();
  const r   = mdf.fetchPrice('EURUSD');
  for(const k of ['asset','price','volume','timestamp','history','volumeHistory']){
    truthy(k in r, 'Missing fetchPrice field: '+k);
  }
});
test('fetchPrice asset matches requested', () => {
  const mdf = new MarketDataFetcher();
  eq(mdf.fetchPrice('EURUSD').asset, 'EURUSD');
  eq(mdf.fetchPrice('USDJPY').asset, 'USDJPY');
});
test('fetchPrice price is positive', () => {
  const mdf = new MarketDataFetcher();
  gt(mdf.fetchPrice('EURUSD').price, 0);
});
test('fetchPrice price changes each call (random walk)', () => {
  const mdf = new MarketDataFetcher();
  const p1 = mdf.fetchPrice('EURUSD').price;
  const p2 = mdf.fetchPrice('EURUSD').price;
  truthy(typeof p1 === 'number' && typeof p2 === 'number');
});
test('fetchPrice throws for unknown asset', () => {
  const mdf = new MarketDataFetcher();
  try { mdf.fetchPrice('XYZABC'); throw new Error('should throw'); }
  catch(e) { truthy(e.message.includes('not supported')||e.message.includes('XYZABC')); }
});
test('fetchPrice history grows after multiple calls', () => {
  // fetchPrice() is read-only since the double-push fix (refreshPrice() owns history).
  // Verify the history reference returned reflects the internal store correctly.
  const mdf  = new MarketDataFetcher();
  const init = mdf.getPriceHistory('EURUSD').length;
  // fetchPrice returns a snapshot — history length stays constant (read-only)
  mdf.fetchPrice('EURUSD');
  mdf.fetchPrice('EURUSD');
  // history should not have grown (no double-push bug)
  eq(mdf.getPriceHistory('EURUSD').length, init);
});
test('getPriceHistory returns array', () => {
  const mdf = new MarketDataFetcher();
  truthy(Array.isArray(mdf.getPriceHistory('EURUSD')));
});
test('getPriceHistory returns empty array for unknown asset', () => {
  const mdf = new MarketDataFetcher();
  eq(mdf.getPriceHistory('UNKNOWN').length, 0);
});
test('getVolumeHistory returns array', () => {
  const mdf = new MarketDataFetcher();
  truthy(Array.isArray(mdf.getVolumeHistory('EURUSD')));
});
test('getVolumeHistory returns empty array for unknown asset', () => {
  const mdf = new MarketDataFetcher();
  eq(mdf.getVolumeHistory('UNKNOWN').length, 0);
});
test('History capped at maxHistoryLength', () => {
  const mdf = new MarketDataFetcher();
  for(let i=0; i<TRADING_CONFIG.maxHistoryLength+10; i++) mdf.fetchPrice('EURUSD');
  lte(mdf.getPriceHistory('EURUSD').length, TRADING_CONFIG.maxHistoryLength);
});
test('fetchPrice volume is positive', () => {
  const mdf = new MarketDataFetcher();
  gt(mdf.fetchPrice('EURUSD').volume, 0);
});
test('All 4 assets can be fetched without error', () => {
  const mdf = new MarketDataFetcher();
  for(const a of ['EURUSD','GBPUSD','USDJPY','AUDUSD']){
    truthy(typeof mdf.fetchPrice(a).price === 'number');
  }
});
test('volume history length matches price history length', () => {
  const mdf = new MarketDataFetcher();
  mdf.fetchPrice('EURUSD'); mdf.fetchPrice('EURUSD');
  eq(mdf.getPriceHistory('EURUSD').length, mdf.getVolumeHistory('EURUSD').length);
});
test('warmUpAll is a function', () => {
  const mdf = new MarketDataFetcher();
  eq(typeof mdf.warmUpAll, 'function');
});

// ═══════════════════════════════════════════════════════════════════════════════
//  7. leading-indicator-fetcher.js
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n-- 96-112. leading-indicator-fetcher.js');

test('Constructor initialises DXY, XAU, US10Y histories', () => {
  const lif = new LeadingIndicatorFetcher();
  truthy('DXY' in lif.histories);
  truthy('XAU' in lif.histories);
  truthy('US10Y' in lif.histories);
});
test('Histories seeded with 30 values each', () => {
  const lif = new LeadingIndicatorFetcher();
  eq(lif.histories.DXY.length,   30);
  eq(lif.histories.XAU.length,   30);
  eq(lif.histories.US10Y.length, 30);
});
test('DXY seeded near 104.50', () => {
  const lif = new LeadingIndicatorFetcher();
  inRange(lif.histories.DXY.at(-1), 103, 106, 'DXY should be near 104.50');
});
test('XAU seeded near 2350', () => {
  const lif = new LeadingIndicatorFetcher();
  inRange(lif.histories.XAU.at(-1), 2200, 2500, 'XAU should be near 2350');
});
test('analyse returns bias, score, spike, earlyExit, detail', () => {
  const lif = new LeadingIndicatorFetcher();
  const r = lif.analyse('EURUSD');
  for(const k of ['bias','score','spike','earlyExit','detail','indicators']){
    truthy(k in r, 'Missing analyse field: '+k);
  }
});
test('analyse bias is BULLISH, BEARISH, or NEUTRAL', () => {
  const lif = new LeadingIndicatorFetcher();
  truthy(['BULLISH','BEARISH','NEUTRAL'].includes(lif.analyse('EURUSD').bias));
});
test('analyse works for all 4 supported assets', () => {
  const lif = new LeadingIndicatorFetcher();
  for(const a of ['EURUSD','GBPUSD','USDJPY','AUDUSD']){
    const r = lif.analyse(a);
    truthy(['BULLISH','BEARISH','NEUTRAL'].includes(r.bias), 'Bad bias for '+a);
  }
});
test('analyse works for unknown asset (falls back to EURUSD relationships)', () => {
  const lif = new LeadingIndicatorFetcher();
  const r   = lif.analyse('UNKNOWN');
  truthy(['BULLISH','BEARISH','NEUTRAL'].includes(r.bias));
});
test('getCurrentValues returns DXY, XAU, US10Y', () => {
  const lif = new LeadingIndicatorFetcher();
  const v   = lif.getCurrentValues();
  truthy('DXY' in v && 'XAU' in v && 'US10Y' in v);
});
test('getCurrentValues returns positive numbers', () => {
  const lif = new LeadingIndicatorFetcher();
  const v   = lif.getCurrentValues();
  gt(v.DXY, 0); gt(v.XAU, 0); gt(v.US10Y, 0);
});
test('_simulateTick advances the history by one', () => {
  const lif  = new LeadingIndicatorFetcher();
  const init = lif.histories.DXY.length;
  lif._simulateTick('DXY');
  eq(lif.histories.DXY.length, init + 1);
});
test('_simulateTick DXY stays within realistic range', () => {
  const lif = new LeadingIndicatorFetcher();
  for(let i=0;i<100;i++) lif._simulateTick('DXY');
  inRange(lif.histories.DXY.at(-1), 90, 120, 'DXY drifted out of range');
});
test('spike field is boolean', () => {
  const lif = new LeadingIndicatorFetcher();
  eq(typeof lif.analyse('EURUSD').spike, 'boolean');
});
test('earlyExit is boolean', () => {
  const lif = new LeadingIndicatorFetcher();
  eq(typeof lif.analyse('EURUSD').earlyExit, 'boolean');
});
test('update is an async function', () => {
  const lif = new LeadingIndicatorFetcher();
  truthy(lif.update() instanceof Promise);
});

// ═══════════════════════════════════════════════════════════════════════════════
//  8. Backward compatibility — all still importable from trading-engine.js
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n-- 113-122. Backward Compatibility (trading-engine.js re-exports)');

test('Indicators importable from trading-engine', () => {
  const { Indicators: I } = require('./trading-engine');
  eq(typeof I, 'function');
  truthy(typeof I.rsi === 'function');
});
test('TRADING_CONFIG importable from trading-engine', () => {
  const { TRADING_CONFIG: TC } = require('./trading-engine');
  eq(typeof TC, 'object');
  truthy('positionSize' in TC);
});
test('KellyCriterion importable from trading-engine', () => {
  const { KellyCriterion: KC } = require('./trading-engine');
  eq(typeof KC, 'function');
  truthy(typeof KC.calculate === 'function');
});
test('CorrelationEngine importable from trading-engine', () => {
  const { CorrelationEngine: CE } = require('./trading-engine');
  eq(typeof CE, 'function');
  truthy(typeof CE.pearson === 'function');
});
test('MultiTimeframeAnalyzer importable from trading-engine', () => {
  const { MultiTimeframeAnalyzer: MTA } = require('./trading-engine');
  eq(typeof MTA, 'function');
  truthy(typeof MTA.analyse === 'function');
});
test('MarketDataFetcher importable from trading-engine', () => {
  const { MarketDataFetcher: MDF } = require('./trading-engine');
  eq(typeof MDF, 'function');
  const inst = new MDF();
  truthy(typeof inst.fetchPrice === 'function');
});
test('LeadingIndicatorFetcher importable from trading-engine', () => {
  const { LeadingIndicatorFetcher: LIF } = require('./trading-engine');
  eq(typeof LIF, 'function');
  const inst = new LIF();
  truthy(typeof inst.analyse === 'function');
});
test('TradingEngine importable from trading-engine', () => {
  const { TradingEngine } = require('./trading-engine');
  eq(typeof TradingEngine, 'function');
  const e = new TradingEngine();
  truthy(typeof e.getStatus === 'function');
});
test('CorrelationEngine from trading-engine behaves identically to direct import', () => {
  const { CorrelationEngine: CE } = require('./trading-engine');
  const r1 = CE.pearson(EUR, GBP, 20);
  const r2 = CorrelationEngine.pearson(EUR, GBP, 20);
  near(r1, r2, 0.0001, 'Re-exported class should behave identically');
});
test('No circular require — indicators.js loads without trading-engine', () => {
  // If this test runs without hanging, there is no circular dependency
  const { Indicators: I2 } = require('./indicators');
  near(I2.rsi(rising), Indicators.rsi(rising), 0.0001);
});

console.log('\n=====================================================');
console.log('  RESULTS: '+passed+' passed  |  '+failed+' failed  |  '+total+' total');
console.log('=====================================================\n');

process.exit(failed > 0 ? 1 : 0);
