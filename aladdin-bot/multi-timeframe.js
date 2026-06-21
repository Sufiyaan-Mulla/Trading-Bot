'use strict';
// ── multi-timeframe.js ────────────────────────────────────────────────────────
const { TRADING_CONFIG } = require('./trading-config');
const { Indicators }     = require('./indicators');

class MultiTimeframeAnalyzer {
  static resample(prices, ticks) {
    if (prices.length < ticks) return prices.slice();
    // Bug fix: NaN prices pass through into classifyTrend, corrupting EMA/RSI/MACD
    // and producing wrong trend signals silently. Filter them at the source.
    const clean = prices.filter(p => typeof p === 'number' && isFinite(p) && p > 0);
    if (clean.length < ticks) return clean;
    const candles = [];
    for (let i = ticks-1; i < clean.length; i += ticks) candles.push(clean[i]);
    if (clean.length % ticks !== 0) candles.push(clean[clean.length-1]);
    return candles;
  }

  static classifyTrend(candles) {
    if (candles.length < 5) return 'NEUTRAL';
    const ema9  = Indicators.ema(candles, Math.min(9,  candles.length));
    const ema21 = Indicators.ema(candles, Math.min(21, candles.length));
    const rsi   = Indicators.rsi(candles, Math.min(14, candles.length-1));
    const macd  = Indicators.macd(candles);
    const last  = candles[candles.length-1];
    let score = 0;
    if (ema9  > ema21) score++; else score--;
    if (macd  > 0)     score++; else score--;
    if (last  > ema21) score++; else score--;
    score += rsi > 50 ? 2 : -2;
    if (score >= 2)  return 'BULL';
    if (score <= -2) return 'BEAR';
    return 'NEUTRAL';
  }

  static analyse(prices, direction) {
    if (!TRADING_CONFIG.mtaEnabled)
      return { allowed: true, score: 1, verdict: 'NEUTRAL', reason: 'MTA disabled', frames: {} };
    const cfg = TRADING_CONFIG.mtaTimeframes;
    const isLong = direction === 'BUY';
    const frames = {};
    let weightedSum = 0, totalWeight = 0;
    for (const [label, { ticks, weight }] of Object.entries(cfg)) {
      const candles = MultiTimeframeAnalyzer.resample(prices, ticks);
      if (candles.length < 3) { frames[label] = { trend: 'INSUFFICIENT', candles: candles.length, weight, aligned: null }; continue; }
      const trend   = MultiTimeframeAnalyzer.classifyTrend(candles);
      const aligned = (isLong && trend === 'BULL') ? 1 : (!isLong && trend === 'BEAR') ? 1 : (trend === 'NEUTRAL') ? 0 : -1;
      frames[label] = { trend, candles: candles.length, weight, aligned };
      weightedSum  += aligned * weight; totalWeight += weight;
    }
    const score    = totalWeight > 0 ? weightedSum / totalWeight : 0;
    const agreeing = Object.values(frames).filter(f => f.aligned === 1).length;
    const total    = Object.values(frames).filter(f => f.aligned !== null).length;
    const allowed  = score >= TRADING_CONFIG.mtaMinAlignment;
    let verdict;
    if      (score >= 0.75)  verdict = isLong ? 'STRONG_BUY'  : 'STRONG_SELL';
    else if (score >= 0.40)  verdict = isLong ? 'BUY'         : 'SELL';
    else if (score >= 0.10)  verdict = 'NEUTRAL';
    else if (score >= -0.30) verdict = isLong ? 'SELL'        : 'BUY';
    else                     verdict = isLong ? 'STRONG_SELL' : 'STRONG_BUY';
    const reason = allowed
      ? `MTA aligned: ${agreeing}/${total} timeframes agree (score ${(score*100).toFixed(0)}%)`
      : `MTA blocked: ${agreeing}/${total} agree (score ${(score*100).toFixed(0)}%, need ${(TRADING_CONFIG.mtaMinAlignment*100).toFixed(0)}%)`;
    return { frames, score: parseFloat(score.toFixed(4)), aligned: agreeing, total, verdict, allowed, reason };
  }
}

module.exports = { MultiTimeframeAnalyzer };
