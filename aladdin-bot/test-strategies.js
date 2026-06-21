'use strict';

const { BaseStrategy, TrendStrategy, MeanReversionStrategy, StrategyManager, REGIME_STRATEGY_MAP } = require('./strategies');
const { TradingEngine } = require('./trading-engine');

let passed = 0, failed = 0;
const L = '─'.repeat(66);
const pass = (name, ok, detail = '') => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else    { failed++; console.log(`  ✗ FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
};

// ── Indicator factories ───────────────────────────────────────────────────────
function baseInd(overrides = {}) {
  return {
    price: 1.1100, rsi: '45.0', macd: '0.0005',
    ema9: '1.1090', ema21: '1.1070', ema50: '1.1000', ema200: '1.0800',
    atr: '0.0012', atrPercent: '0.11', vwap: '1.1080',
    bb: { upper: '1.1200', lower: '1.1000', middle: '1.1100' },
    volatilityLevel: 'NORMAL', marketRegime: 'TRENDING',
    goldenCross: true, deathCross: false,
    ema50Slope: 0.3, volRatio: 1.1, liquidMarket: true,
    signal: 'BUY', mta: null, leadingSignal: null, performanceState: null,
    ...overrides,
  };
}
const ctx = (hasPos = false) => ({ hasPosition: hasPos, mlResult: { confidence: null } });

// ══════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(66));
console.log('  Strategy Modules — Test Suite');
console.log('  BaseStrategy · TrendStrategy · MeanReversion · StrategyManager');
console.log('═'.repeat(66));

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  1. BaseStrategy — construction and interface\n${L}`);
{
  class TestStrat extends BaseStrategy {
    _decide() { return { action: 'BUY', confidence: 70, reasoning: 'test' }; }
  }
  const s = new TestStrat('Test', { minConfidence: 60 });
  pass('Constructs with name',      s.name === 'Test');
  pass('minConf default 60',        s.minConf === 60);
  pass('enabled by default',        s.enabled === true);
  pass('decide() returns object',   typeof s.decide(baseInd(), ctx()) === 'object');
  pass('_hold returns HOLD action', s._hold('reason').action === 'HOLD');
  pass('_num handles string',       s._num('1.23') === 1.23);
  pass('_num handles null',         s._num(null, 99) === 99);
  pass('_clampConf clamps to 95',   s._clampConf(200) === 95);
  pass('_clampConf clamps to MIN_AI_CONFIDENCE', s._clampConf(-10) >= 50);  // #69: lower bound is now SAFETY.MIN_AI_CONFIDENCE
  pass('toJSON returns object',     typeof s.toJSON() === 'object');

  // BaseStrategy._decide must be implemented
  const bare = new BaseStrategy('Bare');
  try { bare._decide(baseInd(), ctx()); pass('_decide throws if not implemented', false); }
  catch (e) { pass('_decide throws if not implemented', true); }
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  2. BaseStrategy — shared ATR gate\n${L}`);
{
  class PassThru extends BaseStrategy {
    _decide() { return { action: 'BUY', confidence: 75, reasoning: 'test' }; }
  }
  const s = new PassThru('P');
  pass('Dead market (ATR<0.03%) → HOLD', s.decide(baseInd({ atrPercent: '0.02' }), ctx()).action === 'HOLD');
  pass('Extreme vol (ATR>2.2%) → HOLD',  s.decide(baseInd({ atrPercent: '2.5' }),  ctx()).action === 'HOLD');
  pass('Normal ATR passes through',       s.decide(baseInd({ atrPercent: '0.12' }), ctx()).action === 'BUY');
  pass('Disabled strategy → HOLD',       (() => { const d = new PassThru('D', { enabled: false }); return d.decide(baseInd(), ctx()).action === 'HOLD'; })());
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  3. BaseStrategy — shared MTA filter\n${L}`);
{
  class PassThru extends BaseStrategy {
    _decide() { return { action: 'BUY', confidence: 70, reasoning: 'ok' }; }
  }
  const s = new PassThru('P');

  const mtaBlock  = baseInd({ mta: { allowed: false, reason: 'MTA disagrees', score: 0.3 } });
  const mtaAllow  = baseInd({ mta: { allowed: true,  reason: 'MTA confirms',  score: 0.8 } });

  const blocked = s.decide(mtaBlock, ctx());
  pass('MTA block → HOLD', blocked.action === 'HOLD', `got ${blocked.action}`);
  pass('MTA block reason included', blocked.reasoning.includes('MTA'));

  const boosted = s.decide(mtaAllow, ctx());
  pass('MTA allowed → BUY', boosted.action === 'BUY');
  pass('MTA boosts confidence', boosted.confidence > 70, `got ${boosted.confidence}`);
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  4. BaseStrategy — leading indicator filter\n${L}`);
{
  class PassThru extends BaseStrategy {
    _decide() { return { action: 'BUY', confidence: 70, reasoning: 'ok' }; }
  }
  const s = new PassThru('P');

  const bearishLead = baseInd({ leadingSignal: { bias: 'BEARISH', detail: 'DXY rising', score: -2, spike: false, earlyExit: false } });
  const bullishLead = baseInd({ leadingSignal: { bias: 'BULLISH', detail: 'DXY falling', score: 2, spike: false, earlyExit: false } });
  const earlyExit   = baseInd({ atrPercent: '0.15', leadingSignal: { bias: 'BEARISH', detail: 'spike!', score: -5, spike: true, earlyExit: true } });

  pass('Bearish leading → HOLD on BUY',  s.decide(bearishLead, ctx()).action === 'HOLD');
  pass('Bullish leading boosts conf',     s.decide(bullishLead, ctx()).confidence > 70);
  pass('Early exit signal → SELL',        s.decide(earlyExit, { hasPosition: true, mlResult: {} }).action === 'SELL');
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  5. TrendStrategy — bull regime entries\n${L}`);
{
  const ts = new TrendStrategy();

  // Setup A: STRONG_BUY + RSI<45 + strong trend
  const setupA = baseInd({ signal: 'STRONG_BUY', rsi: '38', ema9: '1.1090', ema21: '1.1070', marketRegime: 'TRENDING' });
  const dA = ts.decide(setupA, ctx());
  console.log(`    Setup A: action=${dA.action} conf=${dA.confidence} reason=${dA.reasoning.slice(0,50)}`);
  pass('Setup A fires BUY', dA.action === 'BUY', `got ${dA.action}`);
  pass('Setup A reasoning contains [A]', dA.reasoning.includes('[A]'));
  pass('Setup A confidence > 60', dA.confidence > 60, `got ${dA.confidence}`);

  // Setup B: BUY + RSI<50 + strong trend
  const setupB = baseInd({ signal: 'BUY', rsi: '46', ema9: '1.1090', ema21: '1.1070', marketRegime: 'TRENDING' });
  const dB = ts.decide(setupB, ctx());
  pass('Setup B fires BUY', dB.action === 'BUY');
  pass('Setup B reasoning contains [B]', dB.reasoning.includes('[B]'));

  // Setup C: STRONG_BUY + RSI<50 + weak trend
  const setupC = baseInd({ signal: 'STRONG_BUY', rsi: '47', ema9: '1.1072', ema21: '1.1070' });
  const dC = ts.decide(setupC, ctx());
  pass('Setup C fires BUY', dC.action === 'BUY');
  pass('Setup C confidence ≤ A confidence', dC.confidence <= dA.confidence);
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  6. TrendStrategy — bear regime blocks entries\n${L}`);
{
  const ts = new TrendStrategy();
  const bearInd = baseInd({ marketRegime: 'BEAR', goldenCross: false, deathCross: true, signal: 'STRONG_BUY', rsi: '35' });
  const d = ts.decide(bearInd, ctx());
  pass('Bear regime blocks BUY', d.action !== 'BUY', `got ${d.action}`);

  // Bear regime with STRONG_SELL + EMA cross — should SELL (exit if in position)
  const bearExit = baseInd({ marketRegime: 'BEAR', goldenCross: false, signal: 'STRONG_SELL', ema9: '1.1060', ema21: '1.1070' });
  const dExit = ts.decide(bearExit, ctx(false));
  pass('Bear regime allows SELL exit signal', dExit.action === 'SELL' || dExit.action === 'HOLD');
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  7. TrendStrategy — exits\n${L}`);
{
  const ts = new TrendStrategy();

  // Death cross exit
  const deathCross = baseInd({ goldenCross: false, deathCross: true, signal: 'STRONG_SELL', ema9: '1.1060', ema21: '1.1070', atrPercent: '0.15' });
  const dDeath = ts.decide(deathCross, ctx(true));
  pass('Death cross → SELL when in position', dDeath.action === 'SELL', `got ${dDeath.action}`);
  pass('Death cross confidence ≥ 78', dDeath.confidence >= 78, `got ${dDeath.confidence}`);

  // EMA9/21 reversal exit
  const reversal = baseInd({ signal: 'STRONG_SELL', ema9: '1.1060', ema21: '1.1070', atrPercent: '0.15' });
  const dRev = ts.decide(reversal, ctx(true));
  pass('EMA reversal → SELL when in position', dRev.action === 'SELL', `got ${dRev.action}`);

  // No signal while in position
  const noSignal = baseInd({ signal: 'BUY' });
  const dHold = ts.decide(noSignal, ctx(true));
  pass('No exit signal → HOLD when in position', dHold.action === 'HOLD');
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  8. TrendStrategy — confidence modifiers\n${L}`);
{
  const ts = new TrendStrategy();
  const base = { signal: 'STRONG_BUY', rsi: '38', ema9: '1.1090', ema21: '1.1070' };

  const trending = ts.decide(baseInd({ ...base, marketRegime: 'TRENDING', volRatio: 1.5 }), ctx());
  const ranging  = ts.decide(baseInd({ ...base, marketRegime: 'RANGING',  volRatio: 0.8 }), ctx());
  console.log(`    TRENDING conf: ${trending.confidence}  RANGING conf: ${ranging.confidence}`);
  pass('TRENDING > RANGING confidence', trending.confidence > ranging.confidence,
    `trend=${trending.confidence} ranging=${ranging.confidence}`);

  const illiquid = ts.decide(baseInd({
    ...base,
    liquidMarket: false, volRatio: 0.4,
    liquidityRegime: 'THIN', liquidityMultiplier: 0.75, liquidityScore: 30, liquidityBlocked: false,
  }), ctx());
  pass('Illiquid market reduces confidence', illiquid.confidence < trending.confidence,
    `illiquid=${illiquid.confidence} trending=${trending.confidence}`);
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  9. MeanReversionStrategy — entry conditions\n${L}`);
{
  const mr = new MeanReversionStrategy({ oversoldThreshold: 32 });

  // Valid entry: RANGING + RSI oversold + below lower BB + below VWAP
  const validEntry = baseInd({
    rsi: '25', marketRegime: 'RANGING', goldenCross: true,
    price: 1.0980, vwap: 1.1000,
    bb: { upper: '1.1200', lower: '1.1000', middle: '1.1100' },
    volRatio: 1.1, signal: 'STRONG_BUY',
  });
  const dValid = mr.decide(validEntry, ctx());
  console.log(`    Valid MR entry: action=${dValid.action} conf=${dValid.confidence}`);
  pass('Valid MR entry fires BUY', dValid.action === 'BUY', `got ${dValid.action}`);
  pass('MR reasoning contains [MR]', dValid.reasoning.includes('[MR]'));
  pass('MR confidence ≥ 60', dValid.confidence >= 60, `got ${dValid.confidence}`);

  // TRENDING regime — should be blocked
  const trending = baseInd({ rsi: '25', marketRegime: 'TRENDING' });
  pass('TRENDING regime blocks MR entry', mr.decide(trending, ctx()).action !== 'BUY');

  // RSI not oversold
  const notOversold = baseInd({ rsi: '50', marketRegime: 'RANGING',
    price: 1.0980, bb: { lower: '1.1000', upper: '1.1200', middle: '1.1100' } });
  pass('RSI not oversold → HOLD', mr.decide(notOversold, ctx()).action === 'HOLD');

  // Price above lower BB
  const aboveBB = baseInd({ rsi: '25', marketRegime: 'RANGING',
    price: 1.1050, bb: { lower: '1.1000', upper: '1.1200', middle: '1.1100' } });
  pass('Price above lower BB → HOLD', mr.decide(aboveBB, ctx()).action === 'HOLD');

  // Bear regime — blocks even in RANGING
  const bearRanging = baseInd({ rsi: '25', marketRegime: 'RANGING', goldenCross: false,
    price: 1.0980, bb: { lower: '1.1000', upper: '1.1200', middle: '1.1100' } });
  pass('Bear regime blocks MR entry', mr.decide(bearRanging, ctx()).action !== 'BUY');
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  10. MeanReversionStrategy — exit conditions\n${L}`);
{
  const mr = new MeanReversionStrategy({ overboughtThreshold: 65 });

  // RSI restored
  const rsiExit = baseInd({ rsi: '70', price: 1.1100, bb: { upper: '1.1200', lower: '1.1000', middle: '1.1050' } });
  const dRSI = mr.decide(rsiExit, ctx(true));
  pass('RSI > 65 → SELL exit', dRSI.action === 'SELL', `got ${dRSI.action}`);

  // Price at BB middle
  const bbMidExit = baseInd({ rsi: '55', price: 1.1100, bb: { upper: '1.1200', lower: '1.1000', middle: '1.1100' } });
  const dBB = mr.decide(bbMidExit, ctx(true));
  pass('Price at BB middle → SELL exit', dBB.action === 'SELL', `got ${dBB.action}`);

  // Still below mean — hold
  const stillHolding = baseInd({ rsi: '40', price: 1.1020, bb: { upper: '1.1200', lower: '1.1000', middle: '1.1100' } });
  pass('Below BB middle → HOLD', mr.decide(stillHolding, ctx(true)).action === 'HOLD');
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  11. StrategyManager — regime routing\n${L}`);
{
  const sm = new StrategyManager();

  // TRENDING → TrendStrategy
  const trendD = sm.decide(baseInd({ marketRegime: 'TRENDING', signal: 'STRONG_BUY', rsi: '38', ema9: '1.1090', ema21: '1.1070' }), ctx());
  pass('TRENDING routes to trend strategy', sm.lastUsed === 'trend', `lastUsed=${sm.lastUsed}`);
  pass('TRENDING strategy fires', trendD.strategy === 'trend');

  // RANGING → MeanReversionStrategy
  const rangingD = sm.decide(baseInd({
    marketRegime: 'RANGING', rsi: '25', signal: 'STRONG_BUY',
    price: 1.0980, vwap: 1.1000,
    bb: { upper: '1.1200', lower: '1.1000', middle: '1.1100' },
  }), ctx());
  pass('RANGING routes to meanReversion', sm.lastUsed === 'meanReversion', `lastUsed=${sm.lastUsed}`);
  pass('RANGING strategy result has strategy field', rangingD.strategy === 'meanReversion');

  // REGIME_STRATEGY_MAP has all expected keys
  pass('TRENDING in map', !!REGIME_STRATEGY_MAP.TRENDING);
  pass('RANGING in map',  !!REGIME_STRATEGY_MAP.RANGING);
  pass('BEAR in map',     !!REGIME_STRATEGY_MAP.BEAR);
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  12. StrategyManager — override and register\n${L}`);
{
  const sm = new StrategyManager();

  // Force trend strategy regardless of regime
  sm.setOverride('trend');
  const forced = sm.decide(baseInd({ marketRegime: 'RANGING' }), ctx());
  pass('Override forces trend in RANGING', sm.lastUsed === 'trend', `lastUsed=${sm.lastUsed}`);

  // Clear override
  sm.setOverride(null);
  sm.decide(baseInd({ marketRegime: 'RANGING', rsi: '25', price: 1.0980,
    bb: { upper: '1.1200', lower: '1.1000', middle: '1.1100' } }), ctx());
  pass('Clear override restores regime routing', sm.lastUsed === 'meanReversion', `lastUsed=${sm.lastUsed}`);

  // Register custom strategy
  const { BaseStrategy: BS } = require('./strategies');
  class CustomStrat extends BS {
    constructor() { super('Custom'); }
    _decide() { return { action: 'BUY', confidence: 99, reasoning: 'custom' }; }
  }
  sm.register('custom', new CustomStrat());
  sm.setOverride('custom');
  const custom = sm.decide(baseInd({ atrPercent: '0.15' }), ctx());
  pass('Custom strategy registered and fires', custom.action === 'BUY' && custom.strategy === 'custom');

  // Invalid strategy name throws
  try { sm.setOverride('nonexistent'); pass('Invalid strategy throws', false); }
  catch (e) { pass('Invalid strategy throws', true); }
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  13. StrategyManager — getStats\n${L}`);
{
  const sm = new StrategyManager();
  sm.decide(baseInd({ marketRegime: 'TRENDING' }), ctx());
  const stats = sm.getStats();
  pass('getStats returns object', typeof stats === 'object');
  pass('stats.lastUsed set', typeof stats.lastUsed === 'string');
  pass('stats.strategies present', typeof stats.strategies === 'object');
  pass('stats.strategies.trend present', !!stats.strategies.trend);
  pass('stats.strategies.meanReversion present', !!stats.strategies.meanReversion);
}

// ─────────────────────────────────────────────────────────────────────
console.log(`\n${L}\n  14. TradingEngine — strategyManager wired in\n${L}`);
{
  const engine = new TradingEngine();
  pass('engine.strategyManager exists', !!engine.strategyManager);
  pass('engine.strategyManager is StrategyManager', engine.strategyManager instanceof StrategyManager);

  // Seed price history and test getRuleBasedDecision
  for (let i = 0; i < 220; i++) {
    const p = 1.1 + i * 0.0001 + (Math.random() - 0.5) * 0.0003;
    engine.priceHistory.push(p);
    engine.volumeHistory.push(1_000_000);
    engine.ohlcvHistory.push({ o: p, h: p + 0.0003, l: p - 0.0003, c: p, v: 1_000_000 });
  }
  engine.lastATR = 0.0012;

  const ind = {
    price: 1.1220, rsi: '42.0', macd: '0.0003',
    ema9: '1.1210', ema21: '1.1180', ema50: '1.1100', ema200: '1.0900',
    atr: '0.0012', atrPercent: '0.11', vwap: '1.1200',
    bb: { upper: '1.1300', lower: '1.1100', middle: '1.1200' },
    marketRegime: 'TRENDING', goldenCross: true, deathCross: false,
    ema50Slope: 0.4, volRatio: 1.2, liquidMarket: true,
    volatilityLevel: 'NORMAL', signal: 'STRONG_BUY',
    mta: null, leadingSignal: null, performanceState: null,
  };

  const decision = engine.getRuleBasedDecision(ind);
  pass('getRuleBasedDecision returns action', ['BUY','SELL','HOLD'].includes(decision.action));
  pass('getRuleBasedDecision returns confidence', typeof decision.confidence === 'number');
  pass('getRuleBasedDecision returns reasoning', typeof decision.reasoning === 'string');
  console.log(`    Decision: ${decision.action} conf=${decision.confidence} strategy=${decision.strategy}`);
}

// ══════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(66));
console.log(`  Results: ${passed} passed  ${failed} failed  (${passed + failed} total)`);
if (failed === 0) console.log('  ✅  All tests passed');
else              console.log(`  ❌  ${failed} test(s) failed`);
console.log('═'.repeat(66) + '\n');
if (failed > 0) process.exitCode = 1;
