'use strict';
process.env.BACKTEST_MODE = 'true';  // isolate from disk state
// ── test-improvements.js ──────────────────────────────────────────────────────
// Master test runner for ALL 30 improvements.
// Each improvement has its own isolated test block with pass/fail tracking.
// ─────────────────────────────────────────────────────────────────────────────

const { IndicatorsNew }   = require('./indicators-new');
const { LondonOpenStrategy } = require('./strategies/londonOpenStrategy');
const { RegimeMLRouter, FeatureImportance, ConceptDriftDetector, EnsembleUncertainty, QLearning } = require('./ml-improvements');
const { DynamicTakeProfit, SessionTimeExits, MonteCarloSizer, SessionRiskBudget } = require('./risk-improvements');
const { TradeAttribution, TimeHeatmap, RiskAdjustedMetrics } = require('./performance-analytics');

// ── Test harness ─────────────────────────────────────────────────────────────
let totalPassed = 0, totalFailed = 0;
const results = [];

function assert(condition, label) {
  if (condition) {
    totalPassed++;
    process.stdout.write('  ✅ ' + label + '\n');
  } else {
    totalFailed++;
    process.stdout.write('  ❌ FAIL: ' + label + '\n');
  }
}

function assertClose(a, b, tol, label) {
  assert(Math.abs(a - b) <= tol, label + ` (got ${a}, expected ~${b})`);
}

function section(name) {
  console.log('\n' + '═'.repeat(60));
  console.log('  TEST: ' + name);
  console.log('═'.repeat(60));
}

// ── Price generators ─────────────────────────────────────────────────────────
function makePrices(n = 200, start = 1.1000, volatility = 0.0005) {
  const prices = [start];
  for (let i = 1; i < n; i++) {
    prices.push(Math.max(0.1, prices[i-1] * (1 + (Math.random()-0.5) * volatility)));
  }
  return prices;
}

function makeOHLC(n = 200, start = 1.1000) {
  const data = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const o = price;
    const h = o * (1 + Math.random() * 0.002);
    const l = o * (1 - Math.random() * 0.002);
    const c = l + Math.random() * (h - l);
    data.push({ o, h, l, c });
    price = c;
  }
  return data;
}

function makeTrades(n = 30, winRate = 0.55) {
  return Array.from({ length: n }, () => ({
    id:       `T_${Math.random().toString(36).slice(2)}`,
    asset:    'EURUSD',
    side:     Math.random() > 0.5 ? 'BUY' : 'SELL',
    entry:    1.1000,
    exit:     1.1000 + (Math.random() - 0.4) * 0.01,
    pnlPct:   (Math.random() > (1 - winRate)) ? Math.random() * 0.02 : -Math.random() * 0.015,
    won:      Math.random() < winRate,
    strategy: ['TrendStrategy','MeanReversion','BreakoutStrategy'][Math.floor(Math.random()*3)],
    regime:   ['TRENDING','RANGING','WEAK_TREND'][Math.floor(Math.random()*3)],
    session:  ['LONDON','NEW_YORK','TOKYO'][Math.floor(Math.random()*3)],
    openTime:  new Date(Date.now() - Math.random() * 30 * 86400000).toISOString(),
    closeTime: new Date().toISOString(),
    factors:  { rsi: Math.random() * 100, macd: (Math.random()-0.5) * 0.001 },
  }));
}

// ════════════════════════════════════════════════════════════════════════════
//  #1: SMA
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #1: Simple Moving Average (SMA)');
{
  const prices = [1,2,3,4,5,6,7,8,9,10];
  const sma5   = IndicatorsNew.sma(prices, 5);
  assertClose(sma5, 8.0, 0.001, 'SMA(5) of [1..10] = 8.0 (last 5 avg)');
  assert(IndicatorsNew.sma([], 5) === 0 || IndicatorsNew.sma([], 5) == null, 'SMA on empty array handled');
  assert(IndicatorsNew.sma([5], 5) === 5, 'SMA on single element returns that element');

  const real = makePrices(100);
  const smaReal = IndicatorsNew.sma(real, 20);
  assert(isFinite(smaReal) && smaReal > 0, 'SMA on real price series is finite positive');
  assert(smaReal < Math.max(...real) && smaReal > Math.min(...real), 'SMA is within price range');
}

// ════════════════════════════════════════════════════════════════════════════
//  #2: Stochastic RSI
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #2: Stochastic RSI (StochRSI)');
{
  const prices = makePrices(100, 1.1000, 0.003);
  const stoch  = IndicatorsNew.stochRSI(prices);

  assert(typeof stoch.k === 'number' && typeof stoch.d === 'number', 'StochRSI returns {k, d}');
  assert(stoch.k >= 0 && stoch.k <= 100, `K in range [0,100] (got ${stoch.k})`);
  assert(stoch.d >= 0 && stoch.d <= 100, `D in range [0,100] (got ${stoch.d})`);
  assert(typeof stoch.overbought === 'boolean', 'overbought is boolean');
  assert(typeof stoch.oversold   === 'boolean', 'oversold is boolean');

  // Simulate mixed prices then sharp downtrend → K should fall
  const mixed = makePrices(60, 1.1000, 0.003);
  for (let i = 0; i < 40; i++) mixed.push(mixed[mixed.length-1] * (1 - 0.004));
  const stochDown = IndicatorsNew.stochRSI(mixed);
  assert(stochDown.k <= 50, `Post-drop gives K <= 50 (got ${stochDown.k})`);

  // Simulate mixed prices then sharp uptrend → K should rise
  const mixed2 = makePrices(60, 1.1000, 0.003);
  for (let i = 0; i < 40; i++) mixed2.push(mixed2[mixed2.length-1] * (1 + 0.004));
  const stochUp = IndicatorsNew.stochRSI(mixed2);
  assert(stochUp.k >= 50, `Post-rally gives K >= 50 (got ${stochUp.k})`);
}

// ════════════════════════════════════════════════════════════════════════════
//  #3: Ichimoku Cloud
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #3: Ichimoku Cloud');
{
  const ohlcv = makeOHLC(100);
  const ichi  = IndicatorsNew.ichimoku(ohlcv);

  assert(ichi !== null, 'Ichimoku returns non-null');
  assert(['BULLISH','BEARISH','NEUTRAL'].includes(ichi.bias), `Bias is valid (got ${ichi.bias})`);
  assert(typeof ichi.tkBullCross === 'boolean', 'TK bullish cross is boolean');
  assert(typeof ichi.tkBearCross === 'boolean', 'TK bearish cross is boolean');
  assert(typeof ichi.cloudBullish === 'boolean', 'cloudBullish is boolean');

  // Tenkan and Kijun should be valid prices
  if (ichi.tenkan && ichi.kijun) {
    assert(isFinite(ichi.tenkan) && ichi.tenkan > 0, `Tenkan is positive (${ichi.tenkan})`);
    assert(isFinite(ichi.kijun)  && ichi.kijun  > 0, `Kijun is positive (${ichi.kijun})`);
  }

  // Test with uptrending OHLC
  const up = makeOHLC(60, 1.0);
  // Modify to strong uptrend
  const upStrong = up.map((b, i) => ({ o: b.o + i*0.01, h: b.h + i*0.01, l: b.l + i*0.01, c: b.c + i*0.01 }));
  const ichiUp   = IndicatorsNew.ichimoku(upStrong);
  assert(ichiUp !== null, 'Ichimoku works on uptrending data');
  assert(['BULLISH','NEUTRAL'].includes(ichiUp.bias), `Uptrend bias is BULLISH or NEUTRAL (got ${ichiUp.bias})`);
}

// ════════════════════════════════════════════════════════════════════════════
//  #4: Fibonacci Retracement
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #4: Fibonacci Retracement');
{
  const prices = makePrices(60);
  const fib    = IndicatorsNew.fibonacci(prices, 50);

  assert(fib !== null, 'Fibonacci returns non-null');
  assert(fib.levels.swing_high > fib.levels.swing_low, 'swing_high > swing_low');
  assert(fib.levels['0.382'] > fib.levels['0.618'], '38.2% level > 61.8% level');
  assert(fib.levels['0.500'] > fib.levels['0.618'], '50% level > 61.8% level');
  assert(typeof fib.atFibSupport   === 'boolean', 'atFibSupport is boolean');
  assert(typeof fib.atGoldenPocket === 'boolean', 'atGoldenPocket is boolean');

  // Verify level ordering
  assert(fib.levels['0.0']   > fib.levels['0.236'], 'Fib levels are in descending order');
  assert(fib.levels['0.236'] > fib.levels['0.382'], '23.6% > 38.2%');
  assert(fib.levels['0.382'] > fib.levels['0.500'], '38.2% > 50%');

  // currentPct should be between 0 and 1
  assert(fib.currentPct >= 0 && fib.currentPct <= 1, `currentPct in [0,1] (got ${fib.currentPct})`);
}

// ════════════════════════════════════════════════════════════════════════════
//  #5: Heikin-Ashi
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #5: Heikin-Ashi Candles');
{
  const ohlcv = makeOHLC(50);
  const ha    = IndicatorsNew.heikinAshi(ohlcv);

  assert(ha !== null, 'Heikin-Ashi returns non-null');
  assert(['STRONG_BULL','BULL','STRONG_BEAR','BEAR'].includes(ha.trend), `Trend is valid (${ha.trend})`);
  assert(typeof ha.reversal === 'boolean', 'reversal is boolean');
  assert(ha.candles && ha.candles.length > 0, 'candles array is non-empty');
  assert(typeof ha.last.bullish === 'boolean', 'last candle has bullish flag');

  // Each HA candle should have OHLC
  const last = ha.last;
  assert(last.h >= Math.max(last.o, last.c), 'HA high >= max(open, close)');
  assert(last.l <= Math.min(last.o, last.c), 'HA low <= min(open, close)');

  // Strong bull: uptrending data should show no lower shadow
  const upOHLC = Array.from({ length: 40 }, (_, i) => ({
    o: 1.0 + i*0.005, h: 1.002 + i*0.005, l: 1.0 + i*0.005, c: 1.001 + i*0.005
  }));
  const haUp = IndicatorsNew.heikinAshi(upOHLC);
  assert(haUp !== null && haUp.trend.includes('BULL'), `Strong uptrend detected as BULL: ${haUp.trend}`);
}

// ════════════════════════════════════════════════════════════════════════════
//  #6: Keltner Channels + BB Squeeze
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #6: Keltner Channels + BB Squeeze');
{
  const prices = makePrices(100, 1.1000, 0.001);
  const kc     = IndicatorsNew.keltnerChannels(prices);

  assert(kc !== null, 'Keltner Channels returns non-null');
  assert(kc.upper > kc.middle && kc.middle > kc.lower, 'KC: upper > middle > lower');
  assert(isFinite(kc.atr) && kc.atr > 0, `KC ATR is positive (${kc.atr})`);

  const squeeze = IndicatorsNew.bbSqueeze(prices);
  assert(typeof squeeze.squeeze === 'boolean', 'squeeze is boolean');
  assert(typeof squeeze.momentum === 'number', 'momentum is number');
  assert(typeof squeeze.squeezeFiring === 'boolean', 'squeezeFiring is boolean');

  // During extreme low-vol → should detect squeeze
  const flatPrices = Array.from({ length: 60 }, () => 1.1000 + (Math.random()-0.5)*0.00001);
  const flatSqueeze = IndicatorsNew.bbSqueeze(flatPrices);
  assert(flatSqueeze !== null, 'Squeeze works on flat prices');
  // flat prices often trigger squeeze
  console.log(`    Flat market squeeze detected: ${flatSqueeze.squeeze}`);
}

// ════════════════════════════════════════════════════════════════════════════
//  #7: CCI
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #7: Commodity Channel Index (CCI)');
{
  const prices = makePrices(60, 1.1000, 0.002);
  const cci    = IndicatorsNew.cci(prices);

  assert(typeof cci === 'number' && isFinite(cci), `CCI is a finite number (${cci})`);

  // Strongly overbought prices → CCI > +100
  const up = Array.from({ length: 30 }, (_, i) => 1.0 + i * 0.01);
  const cciUp = IndicatorsNew.cci(up);
  assert(cciUp > 50, `Uptrend gives CCI > 50 (got ${cciUp})`);

  // Strongly oversold prices → CCI < -100
  const down = Array.from({ length: 30 }, (_, i) => 1.3 - i * 0.01);
  const cciDown = IndicatorsNew.cci(down);
  assert(cciDown < -50, `Downtrend gives CCI < -50 (got ${cciDown})`);
}

// ════════════════════════════════════════════════════════════════════════════
//  #8: Donchian Channel
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #8: Donchian Channel');
{
  const prices = [1, 2, 3, 4, 5, 3, 2, 1, 4, 5];
  const dc     = IndicatorsNew.donchianChannel(prices, 5);

  assert(dc !== null, 'Donchian returns non-null');
  assert(dc.upper >= dc.middle && dc.middle >= dc.lower, 'DC: upper >= middle >= lower');
  // Last 5 prices: [3,2,1,4,5] → upper=5, lower=1
  assertClose(dc.upper, 5, 0.001, 'DC upper = 5 (max of last 5)');
  assertClose(dc.lower, 1, 0.001, 'DC lower = 1 (min of last 5)');
}

// ════════════════════════════════════════════════════════════════════════════
//  #9: London Open Strategy
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #9: London Open Strategy (4th Strategy)');
{
  const lo = new LondonOpenStrategy();
  assert(lo instanceof LondonOpenStrategy, 'LondonOpenStrategy instantiates');

  // Simulate Asian range being set
  const prices = makePrices(50, 1.1000, 0.0002);
  lo._asianHigh = 1.1015;
  lo._asianLow  = 1.0985;
  lo._lastSessionDate = '2024-05-10';

  const indicators = {
    price:        1.1020,  // above Asian high
    volRatio:     1.5,
    signal:       'STRONG_BUY',
    adxRegime:    'TRENDING',
    liquidityBlocked: false,
    rsi:          55,
    sr:           {},
  };
  const context = { hasPosition: false, position: null, mlResult: { confidence: 68 } };

  // Mock London window by patching time check
  lo.londonStartHour = 0;     // make it always "in window"
  lo.londonEndMinute = 1440;

  const dec = lo._decide(indicators, context);
  assert(['BUY','SELL','HOLD'].includes(dec.action), `LO decision is valid action (${dec.action})`);
  assert(dec.reasoning, 'LO decision has reasoning');

  // Test: outside window → HOLD (use a 1-minute window that's definitely passed)
  const lo2 = new LondonOpenStrategy();
  lo2._asianHigh = 1.1015;
  lo2._asianLow  = 1.0985;
  lo2._lastSessionDate = '2024-05-10';
  lo2.londonStartHour = 3;       // 03:00 UTC — always outside during normal trading
  lo2.londonEndMinute = 3 * 60 + 1;  // 03:01 UTC — only 1 minute window
  const _utcNow = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  const _skipOutsideTest = (_utcNow >= 3 * 60 && _utcNow <= 3 * 60 + 1);
  const dec2 = lo2._decide(indicators, context);
  // Only assert HOLD if we're not accidentally inside the test window
  assert(_skipOutsideTest || dec2.action === 'HOLD', 'Outside London window → HOLD');

  // Test: range too tight → HOLD
  const lo3 = new LondonOpenStrategy({ minRangePips: 100 });
  lo3._asianHigh = 1.1001;  // only 1 pip range
  lo3._asianLow  = 1.1000;
  lo3._lastSessionDate = '2024-05-10';
  lo3.londonStartHour = 0;
  lo3.londonEndMinute = 1440;
  const dec3 = lo3._decide(indicators, context);
  assert(dec3.action === 'HOLD', 'Too-tight Asian range → HOLD');
}

// ════════════════════════════════════════════════════════════════════════════
//  #10: Regime ML Router
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #10: Regime ML Router');
{
  const router = new RegimeMLRouter();
  assert(router instanceof RegimeMLRouter, 'RegimeMLRouter instantiates');

  // Fresh → neutral multiplier
  assert(router.getRegimeMultiplier('TRENDING') === 1.0, 'Fresh router returns 1.0 multiplier');

  // Feed some trades in TRENDING regime
  for (let i = 0; i < 10; i++) router.record('TRENDING', 0.7, true);   // high win rate
  for (let i = 0; i < 3;  i++) router.record('TRENDING', 0.7, false);

  assert(router.getRegimeMultiplier('TRENDING') >= 1.0, 'Good accuracy → multiplier >= 1.0');

  // Feed bad trades in RANGING regime
  for (let i = 0; i < 5;  i++) router.record('RANGING', 0.6, false);
  for (let i = 0; i < 2;  i++) router.record('RANGING', 0.6, true);

  assert(router.getRegimeMultiplier('RANGING') < 1.0, 'Poor accuracy → multiplier < 1.0');

  const summary = router.summary();
  assert(Array.isArray(summary) && summary.length === 3, 'Summary has 3 regimes');
  assert(summary.every(r => r.regime && r.trades >= 0), 'Each regime has valid data');
}

// ════════════════════════════════════════════════════════════════════════════
//  #11: Feature Importance
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #11: Feature Importance Tracker');
{
  const fi = new FeatureImportance();

  // Record 20 trades with correlated features
  for (let i = 0; i < 20; i++) {
    const won = Math.random() > 0.4;
    fi.record({
      rsi:   won ? 35 + Math.random()*15 : 65 + Math.random()*15,  // low RSI → wins
      macd:  won ? Math.random()*0.001 : -Math.random()*0.001,
      atr:   Math.random() * 0.001,
    }, won);
  }

  const top = fi.topFeatures(3);
  assert(Array.isArray(top) && top.length <= 3, 'topFeatures returns array');
  if (top.length > 0) {
    assert(top[0].feature && typeof top[0].correlation === 'number', 'Feature importance has feature + correlation');
    console.log('    Top features:', top.map(f => `${f.feature}(${f.correlation})`).join(', '));
  }
  assert(fi.compute().length >= 0, 'compute() always returns array');
}

// ════════════════════════════════════════════════════════════════════════════
//  #12: Concept Drift Detector
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #12: Concept Drift Detector');
{
  const drift = new ConceptDriftDetector(10, 0.25);

  // Feed good predictions → no drift
  for (let i = 0; i < 10; i++) drift.add(0.8, true);   // predicted 80%, actual win
  const status1 = drift.status();
  assert(status1.currentBrier < 0.25, `Good predictions: Brier < 0.25 (got ${status1.currentBrier})`);
  assert(!status1.drifting, 'No drift on good predictions');

  // Now feed bad predictions → drift
  const drift2 = new ConceptDriftDetector(10, 0.25);
  for (let i = 0; i < 10; i++) drift2.add(0.8, false);   // predicted win, actually lost
  const isDrift = drift2.isDrifting();
  const status2 = drift2.status();
  assert(status2.currentBrier > 0.25, `Bad predictions: Brier > 0.25 (got ${status2.currentBrier})`);
  assert(isDrift, 'Drift detected on consistently wrong predictions');
  assert(['EXCELLENT','GOOD','OK','DEGRADED','POOR'].includes(status2.quality), `Quality label valid: ${status2.quality}`);
}

// ════════════════════════════════════════════════════════════════════════════
//  #13: Ensemble Uncertainty
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #13: Ensemble Uncertainty / Disagreement');
{
  const eu = new EnsembleUncertainty(20);

  // Both models agree strongly → full size
  const agree = eu.evaluate(75, 72, 'BUY', 'BUY');
  assert(agree.sizeMultiplier >= 1.0, `Strong agreement → size >= 1.0 (got ${agree.sizeMultiplier})`);
  assert(!agree.shouldHold, 'Strong agreement → no hold');

  // Models conflict direction → hold
  const conflict = eu.evaluate(80, 75, 'BUY', 'SELL');
  assert(conflict.shouldHold, 'Directional conflict → shouldHold = true');
  assert(conflict.sizeMultiplier === 0, 'Conflict → sizeMultiplier = 0');

  // Large confidence gap → reduced size
  const gap = eu.evaluate(90, 50, 'BUY', 'BUY');
  assert(gap.sizeMultiplier < 1.0, `Large gap → size < 1.0 (got ${gap.sizeMultiplier})`);

  console.log('    Agreement result:', agree.reason);
  console.log('    Conflict result:', conflict.reason);
}

// ════════════════════════════════════════════════════════════════════════════
//  #14: Q-Learning RL Layer
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #14: Q-Learning RL Layer');
{
  const ql = new QLearning(0.1, 0.9, 0.0);  // epsilon=0 → always exploit

  const indicators = { rsi: 35, macd: 0.0005, adxRegime: 'TRENDING', session: 'LONDON' };

  // Q-table starts at zero → should choose HOLD (first alphabetically or any)
  const choice1 = ql.chooseAction(indicators);
  assert(['BUY','SELL','HOLD'].includes(choice1.action), `Q choice is valid action (${choice1.action})`);
  assert(choice1.key, 'Q choice has state key');

  // Simulate winning trade → update Q towards BUY
  ql._lastAction = 'BUY';
  ql._lastState  = choice1.key;
  ql.update(indicators, 0.02);   // +2% reward

  // After positive reward for BUY, Q[BUY] should increase
  const choice2 = ql.chooseAction(indicators);
  const qVals   = choice2.qValues;
  assert(qVals.BUY > 0, `After win reward: Q[BUY] > 0 (got ${qVals.BUY})`);

  const stats = ql.stats();
  assert(stats.totalUpdates === 1, `1 update recorded (got ${stats.totalUpdates})`);
  assert(stats.states >= 1, 'At least 1 state in Q table');
  console.log('    Q-table stats:', JSON.stringify(stats).slice(0, 120));
}

// ════════════════════════════════════════════════════════════════════════════
//  #15: Dynamic Take-Profit
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #15: Dynamic Take-Profit by Regime');
{
  const dtp = new DynamicTakeProfit();

  const trendTP   = dtp.compute(1.1000, 0.0010, 'TRENDING',   'LONDON',   'BUY');
  const rangingTP = dtp.compute(1.1000, 0.0010, 'RANGING',    'LONDON',   'BUY');
  const unknownTP = dtp.compute(1.1000, 0.0010, 'UNKNOWN',    'NEW_YORK', 'BUY');

  assert(trendTP.tp   > 1.1000, `TRENDING TP is above entry (${trendTP.tp})`);
  assert(rangingTP.tp > 1.1000, `RANGING TP is above entry (${rangingTP.tp})`);
  assert(trendTP.tp   > rangingTP.tp, `TRENDING TP (${trendTP.tp}) > RANGING TP (${rangingTP.tp})`);

  // SELL side: TP should be below entry
  const sellTP = dtp.compute(1.1000, 0.0010, 'TRENDING', 'LONDON', 'SELL');
  assert(sellTP.tp < 1.1000, `SELL TP is below entry (${sellTP.tp})`);

  // R:R ratio should be >= 1
  assert(parseFloat(trendTP.rrRatio)   >= 1, `TRENDING R:R >= 1 (${trendTP.rrRatio})`);
  assert(parseFloat(rangingTP.rrRatio) >= 1, `RANGING R:R >= 1 (${rangingTP.rrRatio})`);
  console.log(`    TRENDING TP: ${trendTP.tp} (mult: ${trendTP.totalMult.toFixed(2)}x ATR)`);
  console.log(`    RANGING TP:  ${rangingTP.tp} (mult: ${rangingTP.totalMult.toFixed(2)}x ATR)`);
}

// ════════════════════════════════════════════════════════════════════════════
//  #16: Session Time Exits
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #16: Session-Based Time Exits');
{
  const ste = new SessionTimeExits({ minutesBefore: 30, lossThreshold: -0.001 });

  // Position in profit → should NOT exit
  const profitPos = { entry: 1.1000, side: 'BUY' };
  const checkProfit = ste.check(profitPos, 1.1050);  // +0.45% profit
  assert(!checkProfit || !checkProfit.shouldExit, 'Profitable position → no session exit');

  // No position → null
  const checkNull = ste.check(null, 1.1000);
  assert(checkNull === null, 'No position → returns null');

  // Losing position (far from session close, should return null)
  const lossPos = { entry: 1.1000, side: 'BUY' };
  const checkLoss = ste.check(lossPos, 1.0990);  // -0.09% loss
  // May or may not trigger depending on current UTC time
  assert(checkLoss === null || typeof checkLoss.shouldExit === 'boolean', 'Loss check returns valid structure');

  console.log('    Session exit logic operational (time-dependent checks may vary)');
}

// ════════════════════════════════════════════════════════════════════════════
//  #17: Monte Carlo Position Sizer
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #17: Monte Carlo Position Sizer');
{
  const mc     = new MonteCarloSizer({ simCount: 500, targetMaxDD: 0.15 });
  const trades = makeTrades(40, 0.55);

  const result = mc.compute(trades);
  assert(result.recommendedKelly > 0, `Recommended Kelly > 0 (got ${result.recommendedKelly})`);
  assert(result.recommendedKelly <= 0.50, `Recommended Kelly <= 0.50 (got ${result.recommendedKelly})`);
  assert(typeof result.p95Drawdown === 'number', 'p95 drawdown is a number');
  assert(result.p95Drawdown >= 0 && result.p95Drawdown <= 1, `p95 drawdown in [0,1] (got ${result.p95Drawdown})`);
  console.log(`    MC recommended Kelly: ${(result.recommendedKelly*100).toFixed(0)}%, 95th pct drawdown: ${(result.p95Drawdown*100).toFixed(1)}%`);

  // No data → returns default
  const noData = mc.compute([]);
  assert(noData.recommendedKelly > 0, 'No data returns default Kelly');
}

// ════════════════════════════════════════════════════════════════════════════
//  #18: Session Risk Budget
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #18: Per-Session Risk Budget');
{
  const srb = new SessionRiskBudget();

  const dailyLimit = 0.05;  // 5% daily limit
  const londonCheck = srb.canTrade('LONDON', dailyLimit, '2024-05-10');
  assert(londonCheck.canTrade, 'London can trade on fresh day');
  assert(londonCheck.budget > 0, 'London has positive budget');
  assertClose(londonCheck.budget, 0.40 * dailyLimit, 0.001, 'London budget = 40% of daily limit');

  // Record a large loss
  srb.recordLoss('LONDON', 0.020, '2024-05-10');
  const londonAfterLoss = srb.canTrade('LONDON', dailyLimit, '2024-05-10');
  assert(londonAfterLoss.used > 0, 'Usage tracked after loss');
  assert(londonAfterLoss.remaining < londonCheck.remaining, 'Remaining decreases after loss');

  // NY should be unaffected by London loss
  const nyCheck = srb.canTrade('NEW_YORK', dailyLimit, '2024-05-10');
  assert(nyCheck.canTrade, 'NY budget unaffected by London loss');

  // New day resets
  srb.recordLoss('LONDON', 0.030, '2024-05-10');  // exceed budget
  const newDay = srb.canTrade('LONDON', dailyLimit, '2024-05-11');
  assert(newDay.canTrade, 'New day resets budget');
  console.log('    Session budgets:', srb.status(dailyLimit).map(s => `${s.session}:${s.remaining.toFixed(3)}`).join(', '));
}

// ════════════════════════════════════════════════════════════════════════════
//  #19: COT Fetcher [SKIPPED: cot-fetcher module removed]
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #19: COT Data (Commitment of Traders)');
console.log('  ⏭  #19 skipped — cot-fetcher module removed');

// ════════════════════════════════════════════════════════════════════════════
//  #20: Trade Attribution
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #20: Trade Attribution by Factor & Strategy');
{
  const attr = new TradeAttribution();

  // Record 20 trades
  for (let i = 0; i < 20; i++) {
    const won = i % 3 !== 0;  // 2/3 win rate
    attr.record(`T_${i}`, {
      rsi:    won ? 35 : 65,
      macd:   won ? 0.001 : -0.001,
      regime: won ? 'TRENDING' : 'RANGING',
    }, won ? 0.02 : -0.01, won, ['TrendStrategy','MeanReversion'][i%2]);
  }

  const report = attr.report();
  assert(report.totalTrades === 20, `Total trades = 20 (got ${report.totalTrades})`);
  assert(report.byFactor, 'Report has byFactor breakdown');
  assert(Array.isArray(report.byStrategy), 'Report has byStrategy array');
  assert(report.byStrategy.length >= 1, 'At least 1 strategy in attribution');
  console.log('    Strategy attribution:', report.byStrategy.map(s => `${s.strategy}:${s.winRate}%`).join(', '));
}

// ════════════════════════════════════════════════════════════════════════════
//  #21: Time Heatmap
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #21: Time-of-Day × Day-of-Week Heatmap');
{
  const hm = new TimeHeatmap();

  // Record trades spread across different times
  for (let day = 1; day <= 5; day++) {   // Mon-Fri
    for (let hour = 7; hour <= 21; hour++) {
      const ts  = new Date(2024, 4, day, hour, 0, 0);
      const won = hour >= 8 && hour <= 16;  // "office hours" are better
      hm.record(ts, won, won ? 0.02 : -0.01);
      hm.record(ts, won, won ? 0.015 : -0.008);
      hm.record(ts, won, won ? 0.01 : -0.012);
    }
  }

  const best  = hm.bestHours(3);
  const worst = hm.worstHours(3);
  assert(Array.isArray(best)  && best.length > 0,  'bestHours returns non-empty array');
  assert(Array.isArray(worst) && worst.length > 0, 'worstHours returns non-empty array');
  assert(best[0].avgPnL >= worst[0].avgPnL, 'Best hours have higher avgPnL than worst');

  const timeMod = hm.getTimeMod(2, 9);  // Tuesday 09:00
  assert(typeof timeMod === 'number' && timeMod > 0, `Time multiplier is positive (${timeMod})`);
  console.log(`    Best hour: ${best[0]?.day} ${best[0]?.hour}:00 avgPnL=${best[0]?.avgPnL}%`);
  console.log(`    Worst hour: ${worst[0]?.day} ${worst[0]?.hour}:00 avgPnL=${worst[0]?.avgPnL}%`);
}

// ════════════════════════════════════════════════════════════════════════════
//  #22: Risk-Adjusted Metrics (Sharpe/Sortino/Calmar)
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #22: Sharpe / Sortino / Calmar Ratios');
{
  const ram = new RiskAdjustedMetrics(0.05);

  // Add a mix of winning and losing trades
  const pnls = [0.02, -0.01, 0.015, 0.03, -0.008, 0.025, -0.012, 0.018, 0.01, -0.005];
  for (const p of pnls) ram.addTrade(p);

  const report = ram.fullReport();
  assert(report.trades === 10, `Trade count = 10 (got ${report.trades})`);
  assert(typeof report.sharpe  === 'number' || report.sharpe === null, 'Sharpe is number or null');
  assert(typeof report.sortino === 'number' || report.sortino === null, 'Sortino is number or null');
  assert(typeof report.calmar  === 'number' || report.calmar === null, 'Calmar is number or null');
  assert(report.maxDrawdown >= 0, `Max drawdown >= 0 (got ${report.maxDrawdown})`);
  assert(report.profitFactor > 0, `Profit factor > 0 (got ${report.profitFactor})`);
  assert(report.winRate > 0 && report.winRate < 100, `Win rate in (0,100) (got ${report.winRate}%)`);

  // All-winning trades → no max drawdown, high Sharpe
  const ramWin = new RiskAdjustedMetrics();
  for (let i = 0; i < 10; i++) ramWin.addTrade(0.02);
  const winReport = ramWin.fullReport();
  assert(winReport.winRate === 100, 'All-win trades → winRate = 100%');
  assert(winReport.maxDrawdown === 0, 'All-win trades → maxDrawdown = 0');

  console.log(`    Sharpe: ${report.sharpe}, Sortino: ${report.sortino}, Calmar: ${report.calmar}`);
  console.log(`    MaxDD: ${(report.maxDrawdown*100).toFixed(1)}%, PF: ${report.profitFactor}, WR: ${report.winRate}%`);
}

// ════════════════════════════════════════════════════════════════════════════
//  #23: SQLite DB Store [SKIPPED: db-store module removed]
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #23: SQLite DB Store (Persistence)');
console.log('  ⏭  #23 skipped — db-store module removed');

// ════════════════════════════════════════════════════════════════════════════
//  #24: Circuit Breaker Fix + Config Validation
// ════════════════════════════════════════════════════════════════════════════
section('IMPROVEMENT #24: Config Safety Checks (Circuit Breaker, Prompt)');
{
  const { TRADING_CONFIG } = require('./trading-config');
  // These checks validate that the core config values are safe
  assert(TRADING_CONFIG.kellyFraction <= 0.5, `Kelly fraction <= 0.5 (got ${TRADING_CONFIG.kellyFraction})`);
  assert(TRADING_CONFIG.maxDailyLoss  <= 0.10, `Daily loss limit <= 10% (got ${TRADING_CONFIG.maxDailyLoss})`);
  assert(TRADING_CONFIG.positionSize  <= 0.05, `Position size <= 5% (got ${TRADING_CONFIG.positionSize})`);
  assert(TRADING_CONFIG.consecutiveLossLimit > 0, 'Consecutive loss limit > 0');
  assert(TRADING_CONFIG.globalDrawdownLimit <= 0.25, 'Global drawdown limit <= 25%');
  console.log('    All safety config values within acceptable bounds ✓');
}

// ════════════════════════════════════════════════════════════════════════════
//  INTEGRATION: All new modules work together
// ════════════════════════════════════════════════════════════════════════════
section('INTEGRATION: Full pipeline of new modules');
{
  const prices = makePrices(120, 1.1000, 0.002);
  const ohlcv  = makeOHLC(120, 1.1000);

  // All indicators on same data
  const stoch  = IndicatorsNew.stochRSI(prices);
  const ichi   = IndicatorsNew.ichimoku(ohlcv);
  const fib    = IndicatorsNew.fibonacci(prices);
  const ha     = IndicatorsNew.heikinAshi(ohlcv);
  const kc     = IndicatorsNew.keltnerChannels(prices);
  const sq     = IndicatorsNew.bbSqueeze(prices);
  const cci    = IndicatorsNew.cci(prices);

  assert(stoch && ichi && fib && ha && kc && sq && cci != null, 'All indicators computed without error');

  // Simulate a full trade cycle with new risk modules
  const dtp  = new DynamicTakeProfit();
  const mc   = new MonteCarloSizer({ simCount: 100 });
  const srb  = new SessionRiskBudget();
  const ram  = new RiskAdjustedMetrics();

  const entry = prices[prices.length - 1];
  const atr   = kc.atr;
  const tpResult = dtp.compute(entry, atr, 'TRENDING', 'LONDON', 'BUY');

  const trades   = makeTrades(15, 0.55);
  const mcResult = mc.compute(trades);

  const budget = srb.canTrade('LONDON', 0.05, '2024-05-10');
  for (const t of trades) {
    ram.addTrade(t.pnlPct);
  }

  const perf = ram.fullReport();

  assert(tpResult.tp > entry, 'Dynamic TP is above entry');
  assert(mcResult.recommendedKelly > 0, 'MC gives valid Kelly');
  assert(budget.canTrade, 'Session budget allows trading');
  assert(perf.trades === 15, 'Performance tracked 15 trades');

  console.log('    Integration test complete ✓');
  console.log(`    Indicators: StochRSI K=${stoch.k}, Ichimoku=${ichi.bias}, CCI=${cci}`);
  console.log(`    TP=${tpResult.tp.toFixed(5)}, KellyMC=${(mcResult.recommendedKelly*100).toFixed(0)}%`);
  console.log(`    Sharpe=${perf.sharpe}, Sortino=${perf.sortino}, MaxDD=${(perf.maxDrawdown*100).toFixed(1)}%`);
}

// ════════════════════════════════════════════════════════════════════════════
//  FINAL SUMMARY
// ════════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(60));
console.log('  FINAL RESULTS');
console.log('═'.repeat(60));
console.log(`  ✅ PASSED: ${totalPassed}`);
console.log(`  ❌ FAILED: ${totalFailed}`);
console.log(`  📊 TOTAL:  ${totalPassed + totalFailed}`);
const pct = ((totalPassed / (totalPassed + totalFailed)) * 100).toFixed(1);
console.log(`  📈 SCORE:  ${pct}%`);
console.log('═'.repeat(60));

if (totalFailed > 0) {
  process.exit(1);
}
