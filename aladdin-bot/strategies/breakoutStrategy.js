'use strict';
const { TRADING_CONFIG } = require('../trading-config');
// ── strategies/breakoutStrategy.js ───────────────────────────────────────────
// Pure breakout strategy — the third strategy module.
//
// Setup:
//   Price consolidates in a tight ATR range for N bars (compression).
//   Then breaks out with expanding volume on one side.
//   Enter in the direction of the breakout.
//
// This captures the London open break and NY session continuation moves.
// High win-rate in TRENDING regimes, useless in RANGING.
//
// Entry conditions:
//   1. Range compression: last N bars' high-low range < ATR * compressionRatio
//   2. Breakout bar: close beyond the compression range with volume > 1.5x avg
//   3. ADX regime: TRENDING or WEAK_TREND (not RANGING)
//   4. Not against H1 bias (HTF alignment check)
// ─────────────────────────────────────────────────────────────────────────────
const { BaseStrategy } = require('./baseStrategy');

class BreakoutStrategy extends BaseStrategy {
  constructor(opts = {}) {
    super('BreakoutStrategy', {
      minConfidence: opts.minConfidence || 60,
      atrLowPct:    opts.atrLowPct    || 0.3,  // breakouts need some vol — override base 0.08
      atrHighPct:   opts.atrHighPct   || 2.20,
      ...opts,
    });
    this.compressionBars  = opts.compressionBars  || 8;    // bars of consolidation
    this.compressionRatio = opts.compressionRatio || 0.8;  // tight if range < 0.8 × ATR
    this.breakoutVolMult  = opts.breakoutVolMult  || 1.5;  // need 1.5x vol on breakout
    this.name = 'BreakoutStrategy';
  }

  // BaseStrategy calls _decide() after running all shared safety layers
  _decide(indicators, context) {
    const { hasPosition, position, mlResult } = context;
    const {
      signal, rsi, price, vwap, atr = 0, atrPercent = 0, volRatio = 1,
      marketRegime, adxRegime, liquidityBlocked, liquidityMultiplier = 1,
      liquidityScore = 50, liquidityRegime = 'NORMAL',
      sr = {}, divergence = {}, regimeStack,
    } = indicators;

    const regime = adxRegime || marketRegime || 'UNKNOWN';

    // ── Exit: existing position ───────────────────────────────────────────
    if (hasPosition && position) {
      const isShort = position.side === 'SHORT';
      // Exit on opposite signal or momentum exhaustion
      if (!isShort && (signal === 'STRONG_SELL' || signal === 'SELL' || rsi > 68)) {
        return { action:'SELL', confidence:80, reasoning:'[BO-EXIT] Breakout momentum exhausted — SELL signal' };
      }
      if (isShort && (signal === 'STRONG_BUY' || signal === 'BUY' || rsi < 32)) {
        return { action:'BUY', confidence:80, reasoning:'[BO-EXIT] SHORT breakout momentum exhausted' };
      }
      return { action:'HOLD', confidence:0, reasoning:'[BO] Holding breakout position' };
    }

    // ── Entry guards ──────────────────────────────────────────────────────
    if (liquidityBlocked)         return { action:'HOLD', confidence:0, reasoning:'[BO] Liquidity blocked' };
    if (regime === 'RANGING')     return { action:'HOLD', confidence:0, reasoning:'[BO] RANGING — breakouts unreliable' };
    if (atrPercent < 0.3)         return { action:'HOLD', confidence:0, reasoning:'[BO] ATR too low' };

    // ── ML confidence ─────────────────────────────────────────────────────
    const useML  = mlResult && mlResult.confidence != null && mlResult.confidence > 40;
    const mlConf = useML ? mlResult.confidence : 60;
    const mlTag  = useML ? ` [ML:${mlConf}%]` : '';

    // ── Breakout setup detection ──────────────────────────────────────────
    // Signal must be BUY/STRONG_BUY for bullish breakout, SELL for bearish
    const isBullBreak = (signal === 'STRONG_BUY' || signal === 'BUY') && volRatio > this.breakoutVolMult;
    const isBearBreak = (signal === 'STRONG_SELL' || signal === 'SELL') && volRatio > this.breakoutVolMult;

    if (!isBullBreak && !isBearBreak) {
      return { action:'HOLD', confidence:0, reasoning:'[BO] No volume-confirmed breakout' };
    }

    // Item 5: Momentum ignition detection — fake breakout filter
    // A real breakout has increasing volume; ignition (spoofing) has spike then reversal
    if (TRADING_CONFIG.momentumIgnitionFilter !== false && indicators.atr) {
      const _recent  = this._prevBarClose || 0;
      const _barMove = Math.abs(price - _recent);
      const _barMoveR = indicators.atr > 0 ? _barMove / indicators.atr : 0;
      // High velocity move (>1.5 ATR single bar) with LOW volume = likely ignition/spoof
      if (_barMoveR > 1.5 && volRatio < 0.8) {
        return this._hold(`[Item 5] Momentum ignition suspected: ${_barMoveR.toFixed(1)}R move with ${volRatio.toFixed(2)}× volume — fake breakout`);
      }
    }
    this._prevBarClose = price;
    // Fix #98: Skip entry when most recent bar moved > 2 ATR (chasing extended move)
    if (indicators.atr && indicators.atrPercent) {
      const barMoveAbs = Math.abs(price - (this._prevClose || price));
      this._prevClose  = price;
      if (barMoveAbs > indicators.atr * (TRADING_CONFIG.maxBarMoveATR || 2)) {
        return { action:'HOLD', confidence:0, reasoning:`[BO #98] Bar moved ${(barMoveAbs/indicators.atr).toFixed(1)}× ATR — over-extended, skip` };
      }
    }
    // Fix #25: 2-bar retest confirmation — require price to close above resistance
    // for 2 consecutive bars to avoid false breakouts from single large orders.
    // Track consecutive closes above/below level using this._boConfirmCount.
    const srLevel = isBullBreak ? sr.nearestResistance?.price : sr.nearestSupport?.price;
    if (TRADING_CONFIG.breakoutRequireRetest !== false && srLevel) {
      const confirmed = isBullBreak ? price > srLevel : price < srLevel;
      if (!confirmed) {
        this._boConfirmCount = 0;
        return { action:'HOLD', confidence:0, reasoning:`[BO] Price not yet through S/R level ${srLevel?.toFixed(5)}` };
      }
      this._boConfirmCount = (this._boConfirmCount || 0) + 1;
      const minBars = TRADING_CONFIG.breakoutRetestBars || 2;
      if (this._boConfirmCount < minBars) {
        return { action:'HOLD', confidence:0, reasoning:`[BO #25] Awaiting ${minBars}-bar retest confirmation (${this._boConfirmCount}/${minBars})` };
      }
      this._boConfirmCount = 0;  // reset after confirmed entry
    }

    // HTF alignment check — don't break against H1 bias
    const htfBias = regimeStack?.htfBias || 'NEUTRAL';
    const htfBoost = regimeStack?.htfGate?.requiredConfidenceBoost || 0;

    // ── S/R modifiers ─────────────────────────────────────────────────────
    // BUG-33 fix: breaking ABOVE resistance (bullish) or BELOW support (bearish) is a BONUS
    // The old code penalised the best setups by using -10 instead of +10
    // Item 36: Gamma scalping mode — scalp realized vol vs implied vol spread
    // When realized vol (ATR%) >> implied vol (avgSpread/price), sell the spread
    if (TRADING_CONFIG.gammaScalpEnabled) {
      const _impVol36  = (indicators.avgSpread||0) / (price||1) * Math.sqrt(252) * 100;
      const _realVol36 = (indicators.atrPercent||0) * Math.sqrt(252);
      const _volSpread = _realVol36 - _impVol36;
      if (_volSpread > (TRADING_CONFIG.gammaScalpThreshold || 5)) {
        // Realized > implied → go with momentum (buy gamma)
        if (indicators.rsi > 55) return { action:'BUY',  confidence:65, reasoning:`[GAMMA] R-vol ${_realVol36.toFixed(1)}% > I-vol ${_impVol36.toFixed(1)}%` };
        if (indicators.rsi < 45) return { action:'SELL', confidence:65, reasoning:`[GAMMA] R-vol ${_realVol36.toFixed(1)}% > I-vol ${_impVol36.toFixed(1)}%` };
      }
    }
    // Item #8: Breakout-fade mode — when breakout occurs WITHOUT volume confirmation,
    // fade the move (take the opposite side expecting a snap-back to range)
    if (TRADING_CONFIG.breakoutFadeEnabled && (isBullBreak || isBearBreak)) {
      const fadeVolThresh = TRADING_CONFIG.breakoutFadeVolThreshold || 0.8;
      if (volRatio < fadeVolThresh) {
        const fadeConf = this._clampConf(62 + (volRatio < 0.5 ? 8 : 0));
        if (isBullBreak) {
          return { action:'SELL', confidence:Math.round(fadeConf), reasoning:`[BO-FADE] Low-volume bull break faded (vol=${volRatio.toFixed(2)}×)` };
        } else {
          return { action:'BUY',  confidence:Math.round(fadeConf), reasoning:`[BO-FADE] Low-volume bear break faded (vol=${volRatio.toFixed(2)}×)` };
        }
      }
    }
    // Fix #97: Volatility-adaptive lookback for S/R level identification
    // In high-vol periods, significant levels form in 3-5 bars; in low-vol, 20-50 bars.
    const atrPctStr = indicators.atrPercent || 0.05;
    this.lookback = Math.round(Math.min(50, Math.max(5, 10 / Math.max(0.01, atrPctStr))));

    const srBreakMod = sr.atResistance && isBullBreak ? +10  // confirmed bull breakout above resistance
      : sr.atSupport && isBearBreak    ? +10 : 0;            // confirmed bear breakout below support

    // ── Volume expansion mod ──────────────────────────────────────────────
    const volMod = volRatio > 2.0 ? 10 : volRatio > 1.5 ? 5 : 0;

    // ── Regime mod ────────────────────────────────────────────────────────
    const regimeMod = regime === 'TRENDING' ? 8 : regime === 'WEAK_TREND' ? 2 : -5;

    const mods = srBreakMod + volMod + regimeMod;

    // ── Bullish breakout ──────────────────────────────────────────────────
    if (isBullBreak) {
      if (htfBias === 'BEARISH') {
        const conf = Math.round(this._clampConf((useML ? mlConf : 65) + mods - htfBoost) * liquidityMultiplier);
        if (conf < 60) return { action:'HOLD', confidence:0, reasoning:'[BO] Bull break against H1 bearish — low conf' };
        return { action:'BUY', confidence:conf, reasoning:`[BO-BULL-COUNTER] vol=${volRatio.toFixed(1)}x` };
      }
      const conf = Math.round(this._clampConf((useML ? mlConf : 72) + mods) * liquidityMultiplier);
      return { action:'BUY', confidence:conf, reasoning:`[BO-BULL] vol=${volRatio.toFixed(1)}x ${regime}` };
    }

    // ── Bearish breakout ──────────────────────────────────────────────────
    if (isBearBreak) {
      if (htfBias === 'BULLISH') {
        const conf = Math.round(this._clampConf((useML ? mlConf : 65) + mods - htfBoost) * liquidityMultiplier);
        if (conf < 60) return { action:'HOLD', confidence:0, reasoning:'[BO] Bear break vs H1 bullish — low conf' };
        return { action:'SELL', confidence:conf, reasoning:`[BO-BEAR-COUNTER] vol=${volRatio.toFixed(1)}x` };
      }
      const conf = Math.round(this._clampConf((useML ? mlConf : 72) + mods) * liquidityMultiplier);
      return { action:'SELL', confidence:conf, reasoning:`[BO-BEAR] vol=${volRatio.toFixed(1)}x ${regime}` };
    }

    return { action:'HOLD', confidence:0, reasoning:'[BO] No valid breakout setup' };
  }
}

module.exports = BreakoutStrategy;
