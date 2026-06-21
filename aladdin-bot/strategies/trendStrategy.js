'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  strategies/trendStrategy.js
//  EMA50/200 Trend-Following Strategy
//
//  Edge: Trades with the primary trend identified by the EMA50/200 golden/death
//  cross. Filters out counter-trend trades, ranging markets, and thin-volume bars.
//
//  Signal logic:
//    ENTRY  — 3 setups ranked by probability (A > B > C):
//      A: STRONG_BUY + RSI<45 + strong EMA9/21 + bull regime  → highest conf
//      B: BUY       + RSI<50 + strong EMA9/21 + bull regime  → moderate conf
//      C: STRONG_BUY + RSI<50 + EMA9>EMA21   + bull regime  → lower conf
//    EXIT   — EMA50/200 death cross + STRONG_SELL  (immediate)
//           — EMA9/21 cross + STRONG_SELL           (normal)
//    GATE   — Bear regime (EMA50 < EMA200) blocks all new longs
//
//  Confidence modifiers (on top of ML base):
//    TRENDING regime:  +8   RANGING: -15   WEAK_TREND: -7
//    ATR in sweet spot: +5   Volume surge: +8   EMA50 slope: ±5–8
//    Above VWAP: +4         Illiquid: -12
// ═══════════════════════════════════════════════════════════════════════════════

const { BaseStrategy } = require('./baseStrategy');

class TrendStrategy extends BaseStrategy {
  constructor (opts = {}) {
    super('TrendStrategy', {
      minConfidence: opts.minConfidence || 60,
      atrLowPct:    opts.atrLowPct    || 0.03,  // BUG-10 fix: was 0.08, sim data produces 0.04%
      atrHighPct:   opts.atrHighPct   || 2.20,
      ...opts,
    });
  }

  // ── Core decision logic ───────────────────────────────────────────────────
  _decide (indicators, context) {
    // Item 111: Bear mode — SHORT signals on death cross / bearish conditions
    if (require('../trading-config').TRADING_CONFIG.bearModeEnabled !== false) {
      const { ema9, ema21, ema50, rsi, macd, adx, hmmState } = indicators;
      const deathCross  = ema9 < ema21 && ema21 < ema50;
      const bearMomentum= (rsi||50) < 45 && (macd||0) < 0;
      const bearRegime  = (hmmState||'').includes('BEAR');
      if ((deathCross && bearMomentum || bearRegime) && !context.hasPosition) {
        const conf = Math.min(80, 55 + ((adx||0) > 25 ? 10 : 0));
        return { action:'SELL', confidence:conf,
          reasoning: '[TREND-BEAR] Death cross + bearish momentum — SHORT signal', bearMode:true };
      }
    }
    const { signal } = indicators;
    const hasPosition = context.hasPosition || false;
    const mlResult    = context.mlResult    || null;

    // Normalise all indicator values
    const rsiNum  = this._num(indicators.rsi);
    const e9      = this._num(indicators.ema9);
    const e21     = this._num(indicators.ema21);
    const e50     = this._num(indicators.ema50,  e21);
    const e200    = this._num(indicators.ema200, e21);
    const atrPct  = this._num(indicators.atrPercent);
    const price   = this._num(indicators.price);
    const vwap    = this._num(indicators.vwap, price);
    const e50Slp  = this._num(indicators.ema50Slope);
    const volRatio= this._num(indicators.volRatio, 1);
    const liquid  = indicators.liquidMarket ?? true;
    const regime  = indicators.marketRegime || 'UNKNOWN';
    const golden  = indicators.goldenCross  ?? (e50 > e200);
    // M5-appropriate trend filters (EMA9/21 cross is faster than EMA50/200)
    const fastBull = e9 > e21;  // short-term uptrend on M5
    const fastBear = e9 < e21;  // short-term downtrend on M5

    const { use: useML, conf: mlConf, tag: mlTag } = this._mlResult(mlResult);

    // ── Liquidity gate — block DRY market entries ─────────────────────────
    const liqBlocked = indicators.liquidityBlocked ?? false;
    const liqMult    = indicators.liquidityMultiplier ?? 1.0;
    const liqRegime  = indicators.liquidityRegime ?? 'NORMAL';
    const liqScore   = indicators.liquidityScore  ?? 50;

    // Fix #92: Minimum ADX strength gate — only enter when trend is strong enough
    if (!hasPosition && !context.position && (indicators.adx ?? 0) > 0) {
      const adxVal   = this._num(indicators.adx, 0);
      const _tc92 = require('../trading-config').TRADING_CONFIG;
      const minADX   = _tc92.trendMinADX || 25;
      const halfADX  = _tc92.trendHalfSizeADX || 20;
      if (adxVal < halfADX) {
        return this._hold(`[Trend #92] ADX ${adxVal.toFixed(1)} < ${halfADX} — trend too weak`);
      }
      if (adxVal < minADX) {
        // Weak trend — half size (applied via corrMultiplier in executeDecision)
        this._adxSizeMultiplier = 0.5;
      } else {
        this._adxSizeMultiplier = 1.0;
      }
    }
    if (!hasPosition && liqBlocked) {
      return this._hold(`[Trend] DRY liquidity (score ${liqScore}) — entry blocked`);
    }

    // sr declared here — used in gate below AND in mods further down
    const sr = indicators.sr || {};

    // ── S/R gate: block new LONG entry directly at resistance ─────────────
    if (!hasPosition && sr.atResistance && !context.position) {
      return this._hold(`[Trend] Price at resistance ${sr.nearestResistance && sr.nearestResistance.price} — poor long entry`);
    }

    // ── Regime-aware confidence modifiers ─────────────────────────────────
    const rangingPenalty = regime === 'RANGING'   ? -15 : regime === 'WEAK_TREND' ? -7 : 0;
    const trendBonus     = regime === 'TRENDING'  ?  8  : 0;
    const atrBonus       = (atrPct > 0.8 && atrPct < 1.8) ? 5 : 0;
    const liqBonus       = liqRegime === 'DEEP'   ?  8  :
                           liqRegime === 'NORMAL'  ?  4  :
                           liqRegime === 'THIN'    ? -8  : -15;
    const slopeBonus     = e50Slp > 0.5 ? 5 : e50Slp < -0.5 ? -8 : 0;
    const vwapBonus      = price > vwap ? 4 : -4;

    // Fix #29: Weighted EMA(60%) + MACD(40%) signal scoring — configurable via config
    const _tc2 = require('../trading-config').TRADING_CONFIG;
    const emaWeight  = _tc2.trendEMAWeight  ?? 0.60;
    const macdWeight = _tc2.trendMACDWeight ?? 0.40;
    const emaScore   = fastBull ? 10 : fastBear ? -10 : 0;
    const macdScore  = (indicators.macd || 0) > 0 ? 8 : (indicators.macd || 0) < 0 ? -8 : 0;
    const weightedSignalMod = Math.round(emaScore * emaWeight + macdScore * macdWeight);

    const srLongMod  = sr.atSupport    ? (sr.entryQuality === 'STRONG' ? 8 : 4)
                     : sr.atResistance ? -8 : 0;
    const srRRBonus  = (sr.rrRatio && sr.rrRatio >= 2.0) ? 4 : 0;

    const div = indicators.divergence || {};
    const divMod = div.type === 'BULLISH' ? 8 : div.type === 'BEARISH' ? -10 : 0;

    const mods = rangingPenalty + trendBonus + atrBonus + liqBonus + slopeBonus + vwapBonus + srLongMod + srRRBonus + divMod + weightedSignalMod;

    if (!hasPosition) {
      // ── Bear regime: SHORT entries ────────────────────────────────────
      // EMA50 < EMA200 = primary downtrend confirmed. Instead of sitting idle,
      // the bot can now open short positions with the bear trend.
      if (!golden) {
        // BUG-4 fix: counter-trend longs in bear regime now require RSI < 30 (extreme
        // oversold) AND adxRegime must be RANGING (not trending — we only fade extreme
        // oversold in sideways bear markets, never in a strong downtrend).
        const adxReg = indicators.adxRegime || 'UNKNOWN';
        if (fastBull && signal === 'STRONG_BUY' && rsiNum < 30 && adxReg === 'RANGING') {
          const conf = Math.round(this._clampConf((useML ? mlConf : 68) + mods - 15) * liqMult);  // -15 vs-trend penalty
          return { action: 'BUY', confidence: conf,
            reasoning: `[VS-TREND-LONG] extreme oversold bounce in ranging bear (RSI=${rsiNum.toFixed(0)})${mlTag}` };
        }
        const trendDown   = e9 < e21;
        const strongBear  = trendDown && e21 > 0 && ((e21 - e9) / e21) > 0.0005;

        // ── SHORT-specific modifiers (invert LONG-centric mods) ─────────────
        // For shorts: above VWAP = bearish (good), at resistance = ideal entry
        const shortVwapMod = price > vwap ? 4 : -4;   // inverted: above VWAP good for short
        const shortSRMod   = sr.atResistance ? (sr.entryQuality === 'STRONG' ? 8 : 4)
                           : sr.atSupport    ? -8 : 0; // inverted: at resistance good for short
        const shortDivMod  = div.type === 'BEARISH' ? 8 : div.type === 'BULLISH' ? -10 : 0;
        const shortMods = rangingPenalty + trendBonus + atrBonus + liqBonus + slopeBonus
                        + shortVwapMod + shortSRMod + shortDivMod;

        // Short Setup A — highest probability: overbought pullback in strong downtrend
        // BUG-37: strongBearFast was declared but never used — wire it into the condition
        const strongBearFast = fastBear && (signal === 'STRONG_SELL' || signal === 'SELL');
        // BUG-36: was !goldenCross (undefined) — use correct variable !golden
        if (signal === 'STRONG_SELL' && rsiNum > 55 && (strongBearFast || !golden)) {
          const conf = Math.round(this._clampConf((useML ? mlConf : 82) + shortMods) * liqMult);
          return { action: 'SELL', confidence: conf,
            reasoning: `[A-SHORT] STRONG_SELL + RSI>55 + EMA9/21 bear + EMA50<EMA200 [${regime}]${mlTag}` };
        }
        // Short Setup B — moderate probability: sell rally in confirmed downtrend
        if (signal === 'SELL' && rsiNum > 50 && strongBear) {
          const conf = Math.round(this._clampConf((useML ? mlConf : 70) + shortMods) * liqMult);
          return { action: 'SELL', confidence: conf,
            reasoning: `[B-SHORT] SELL + RSI>50 + EMA9/21 bear + EMA50<EMA200 [${regime}]${mlTag}` };
        }
        // Short Setup C — lower probability: strong signal in weaker downtrend
        if (signal === 'STRONG_SELL' && rsiNum > 50 && trendDown) {
          const conf = Math.round(this._clampConf((useML ? mlConf : 65) + shortMods) * liqMult);
          return { action: 'SELL', confidence: conf,
            reasoning: `[C-SHORT] STRONG_SELL + EMA50<EMA200 [${regime}]${mlTag}` };
        }

        return this._hold(`Bear regime: no short setup [RSI=${rsiNum.toFixed(1)} signal=${signal}]`);
      }

      // ── Bull regime entries ────────────────────────────────────────────
      const trendUp    = e9 > e21;
      const strongTrend = trendUp && e21 > 0 && ((e9 - e21) / e21) > 0.0005;

      // Setup A — highest probability: oversold pullback in strong uptrend
      if (signal === 'STRONG_BUY' && rsiNum < 45 && strongTrend) {
        const conf = Math.round(this._clampConf((useML ? mlConf : 82) + mods) * liqMult);
        return { action: 'BUY', confidence: conf,
          reasoning: `[A] STRONG_BUY + RSI<45 + EMA9/21 + EMA50>EMA200 [${regime}] [liq:${liqRegime}(${liqScore})]${mlTag}` };
      }
      // Setup B — moderate probability: buy dip in confirmed uptrend
      if (signal === 'BUY' && rsiNum < 50 && strongTrend) {
        const conf = Math.round(this._clampConf((useML ? mlConf : 70) + mods) * liqMult);
        return { action: 'BUY', confidence: conf,
          reasoning: `[B] BUY + RSI<50 + EMA9/21 + EMA50>EMA200 [${regime}] [liq:${liqRegime}(${liqScore})]${mlTag}` };
      }
      // Setup C — lower probability: strong signal in weaker uptrend
      if (signal === 'STRONG_BUY' && rsiNum < 50 && trendUp) {
        const conf = Math.round(this._clampConf((useML ? mlConf : 68) + mods) * liqMult);
        return { action: 'BUY', confidence: conf,
          reasoning: `[C] STRONG_BUY + EMA50>EMA200 [${regime}] [liq:${liqRegime}(${liqScore})]${mlTag}` };
      }

      return this._hold(`No trend entry signal [${regime}]`);
    } else {
      // ── Exits ─────────────────────────────────────────────────────────
      const trendReversal = e9 < e21;
      const deathCross    = !golden;

      const isShort = context.position && context.position.side === 'SHORT';

      if (!isShort) {
        // LONG exits
        if (deathCross && signal === 'STRONG_SELL') {
          // BUG-17 fix: death cross is a hard technical event — use max of ML confidence
          // and the rule-based floor (80) so ML can't drag this below exit threshold.
          const exitConf = Math.max(useML ? mlConf : 85, 80);
          return { action: 'SELL', confidence: exitConf,
            reasoning: `Death cross exit: EMA50 crossed below EMA200 + STRONG_SELL${mlTag}` };
        }
        if (trendReversal && signal === 'STRONG_SELL') {
          const exitConf = Math.max(useML ? mlConf : 80, 78);
          return { action: 'SELL', confidence: exitConf,
            reasoning: `Trend reversal: EMA9/21 cross + STRONG_SELL [${regime}]${mlTag}` };
        }
        // Additional exit: RSI extremely overbought even without STRONG_SELL
        if (rsiNum > 72 && (signal === 'SELL' || signal === 'STRONG_SELL')) {
          return { action: 'SELL', confidence: useML ? mlConf : 75,
            reasoning: `RSI overbought exit: RSI=${rsiNum.toFixed(1)}>72 + SELL signal [${regime}]${mlTag}` };
        }
      } else {
        // SHORT exits — cover when bear trend ends
        const goldenRecovery = e50 > e200;
        const trendReversalUp = e9 > e21;
        if (goldenRecovery && signal === 'STRONG_BUY') {
          return { action: 'BUY', confidence: useML ? mlConf : 85,
            reasoning: `Cover SHORT: EMA50 crossed above EMA200 + STRONG_BUY${mlTag}` };
        }
        if (trendReversalUp && signal === 'STRONG_BUY') {
          return { action: 'BUY', confidence: useML ? mlConf : 80,
            reasoning: `Cover SHORT: EMA9/21 cross up + STRONG_BUY [${regime}]${mlTag}` };
        }
        // RSI oversold reversal — cover short even without EMA crossover
        if ((signal === 'STRONG_BUY' || (signal === 'BUY' && rsiNum < 35))) {
          return { action: 'BUY', confidence: useML ? mlConf : 75,
            reasoning: `[SHORT-EXIT] Oversold reversal: ${signal} RSI=${rsiNum.toFixed(0)}${mlTag}` };
        }
      }

      return this._hold('No exit signal — stops and take-profit active');
    }
  }
}

module.exports = { TrendStrategy };
