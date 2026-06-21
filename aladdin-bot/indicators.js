'use strict';
const { TypedEMA, TypedSMA, TypedRSI, TypedATR } = require('./typed-indicators');
// ── indicators.js ─────────────────────────────────────────────────────────────
// Pure static technical indicator functions. No state, no side effects.
// Import this directly instead of trading-engine.js when only indicators needed.

// BUG-28 fix: hoist requires out of getDynamicLevels hot path
let _tradingConfig = null;
let _safety = null;
function _getConfig() {
  if (!_tradingConfig) { try { _tradingConfig = require('./trading-config').TRADING_CONFIG; } catch(_) {} }
  return _tradingConfig;
}
function _getSafety() {
  if (!_safety) { try { _safety = require('./safety-constants').SAFETY; } catch(_) {} }
  return _safety;
}

class Indicators {
  // Relative Strength Index
  static rsi(prices, period = 14) {
    if (prices.length < period + 1) return 50;
    // Float64Array vectorised path for large arrays
    if (prices.length >= 50) {
      const fa  = prices instanceof Float64Array ? prices : Float64Array.from(prices);
      const arr = TypedRSI(fa, period);
      const val = arr[arr.length - 1];
      if (isFinite(val) && val > 0) return val;
    }
    // Wilder's smoothed RSI: seed with simple average of first period, then EMA-smooth
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const diff = prices[i] - prices[i - 1];
      if (diff > 0) avgGain += diff; else avgLoss -= diff;
    }
    avgGain /= period;
    avgLoss /= period;
    // Wilder's smoothing for all subsequent bars
    for (let i = period + 1; i < prices.length; i++) {
      const diff = prices[i] - prices[i - 1];
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? -diff : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    if (avgGain === 0 && avgLoss === 0) return 50;
    const rs = avgGain / (avgLoss || 1e-10);
    return 100 - (100 / (1 + rs));
  }

  // MACD (Moving Average Convergence Divergence)
  static macd(prices) {
    if (prices.length < 26) return 0;
    return Indicators.ema(prices, 12) - Indicators.ema(prices, 26);
  }

  // Full MACD: returns { line, signal, histogram }
  // signal = 9-bar EMA of the MACD line; histogram = line - signal
  static macdFull(prices) {
    if (prices.length < 35) return { line: 0, signal: 0, histogram: 0 };
    // O(n) incremental EMA — seed ema12/ema26 from SMA of first period, then update each bar
    const k12 = 2 / 13, k26 = 2 / 27, k9 = 2 / 10;
    let ema12 = prices.slice(0, 12).reduce((s, v) => s + v, 0) / 12;
    let ema26 = prices.slice(0, 26).reduce((s, v) => s + v, 0) / 26;
    // Warm up ema12 and ema26 to bar 26
    for (let i = 12; i < 26; i++) ema12 = prices[i] * k12 + ema12 * (1 - k12);
    // Build MACD line history using incremental updates (no slice/recompute)
    const lineHistory = [ema12 - ema26];
    for (let i = 26; i < prices.length; i++) {
      ema12 = prices[i] * k12 + ema12 * (1 - k12);
      ema26 = prices[i] * k26 + ema26 * (1 - k26);
      lineHistory.push(ema12 - ema26);
    }
    if (lineHistory.length < 9) return { line: lineHistory[lineHistory.length-1]||0, signal: 0, histogram: 0 };
    const line   = lineHistory[lineHistory.length - 1];
    // Signal: 9-bar EMA of MACD line, seeded from SMA of first 9 values
    let signal = lineHistory.slice(0, 9).reduce((s, v) => s + v, 0) / 9;
    for (let i = 9; i < lineHistory.length; i++) signal = lineHistory[i] * k9 + signal * (1 - k9);
    return { line, signal, histogram: line - signal };
  }

  // Exponential Moving Average
  static ema(prices, period) {
    period = Math.max(1, Math.floor(period || 1));  // guard: period=0 causes k=2, explosive oscillation
    // Bug fix: NaN prices in the array propagate through EMA into MACD/signal generation.
    // Filter them before computation; if too few valid prices, return the last valid one.
    const clean = prices.filter(p => typeof p === 'number' && isFinite(p));
    if (clean.length === 0) return 50;  // safe neutral fallback
    if (clean.length < period) return clean[clean.length - 1];
    prices = clean;  // use filtered array for rest of computation
    // Use Float64Array vectorised path for large arrays (3× faster)
    if (prices.length >= 50) {
      const fa  = prices instanceof Float64Array ? prices : Float64Array.from(prices);
      const arr = TypedEMA(fa, period);
      return arr[arr.length - 1] || prices[prices.length - 1];
    }
    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
    return ema;
  }

  // Bollinger Bands
  static bollingerBands(prices, period = 20, stdDev = 2) {
    period = Math.max(2, Math.floor(period));  // sample variance needs period >= 2
    if (prices.length < period) {
      const last = prices[prices.length - 1];
      return { upper: last, middle: last, lower: last };
    }
    const slice = prices.slice(-period);
    const sma = slice.reduce((a, b) => a + b) / period;
    const variance = slice.reduce((sq, n) => sq + Math.pow(n - sma, 2), 0) / (period - 1);  // sample variance
    const std = Math.sqrt(variance);
    return { upper: sma + stdDev * std, middle: sma, lower: sma - stdDev * std };
  }

  // Average True Range (ATR)
  static atr(priceData, period = 14) {
    if (priceData.length < period + 1) return 0;
    const trueRanges = [];
    for (let i = 1; i < priceData.length; i++) {
      let tr;
      if (Array.isArray(priceData[i])) {
        const [close, high, low] = priceData[i];
        const prevClose = priceData[i - 1][0];
        tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      } else {
        tr = Math.abs(priceData[i] - priceData[i - 1]); // close-only approx: |Δclose|
      }
      trueRanges.push(tr);
    }
    const recentTR = trueRanges.slice(-period);
    return recentTR.reduce((a, b) => a + b) / period;
  }


  // ── ADX — Average Directional Index ──────────────────────────────────────
  // Measures trend STRENGTH (not direction). ADX > 25 = trending, < 20 = ranging.
  // With close-only data we approximate:
  //   TR  = |close_i - close_{i-1}|
  //   +DM = max(close_i - close_{i-1}, 0)   (up movement)
  //   -DM = max(close_{i-1} - close_i, 0)   (down movement)
  // Then smooth over `period` bars using Wilder's method (EMA with alpha=1/period).
  static adx(prices, period = 14) {
    if (prices.length < period * 2 + 1) return 0;

    const trs = [], plusDMs = [], minusDMs = [];

    for (let i = 1; i < prices.length; i++) {
      const diff = prices[i] - prices[i - 1];
      trs.push(Math.abs(diff));
      plusDMs.push(Math.max(diff, 0));
      minusDMs.push(Math.max(-diff, 0));
    }

    // DX for each bar using rolling Wilder smoothing, then smooth DX → ADX
    const dxValues = [];
    let smoothedTR  = trs.slice(0, period).reduce((s,v) => s+v, 0) / period;
    let smoothedPDM = plusDMs.slice(0, period).reduce((s,v) => s+v, 0) / period;
    let smoothedMDM = minusDMs.slice(0, period).reduce((s,v) => s+v, 0) / period;

    for (let i = period; i < trs.length; i++) {
      smoothedTR  = (smoothedTR  * (period - 1) + trs[i])      / period;
      smoothedPDM = (smoothedPDM * (period - 1) + plusDMs[i])  / period;
      smoothedMDM = (smoothedMDM * (period - 1) + minusDMs[i]) / period;

      const pDI = smoothedTR > 0 ? (smoothedPDM / smoothedTR) * 100 : 0;
      const mDI = smoothedTR > 0 ? (smoothedMDM / smoothedTR) * 100 : 0;
      const sum  = pDI + mDI;
      dxValues.push(sum > 0 ? (Math.abs(pDI - mDI) / sum) * 100 : 0);
    }

    if (dxValues.length < period) return parseFloat((dxValues.reduce((s,v)=>s+v,0)/dxValues.length||0).toFixed(2));

    // Wilder-smooth DX values → ADX
    let adxVal = dxValues.slice(0, period).reduce((s,v) => s+v, 0) / period;
    for (let i = period; i < dxValues.length; i++) {
      adxVal = (adxVal * (period - 1) + dxValues[i]) / period;
    }

    return parseFloat(adxVal.toFixed(2));
  }

  // ADX regime label: TRENDING (>25) | WEAK_TREND (20-25) | RANGING (<20)
  // Cached: only recomputes when price array has grown or last price changed
  static adxRegime(prices, period = 14) {
    const last = prices[prices.length - 1];
    const len  = prices.length;
    const key  = len + '_' + (last ? last.toFixed(5) : '0');
    // Include a per-call salt so different assets with same bar count get separate cache entries
    const assetSalt = typeof globalThis._currentScoringAsset === 'string' ? globalThis._currentScoringAsset : '';
    const cacheKey  = key + '|' + assetSalt;
    if (Indicators._adxCache && Indicators._adxCache.key === cacheKey) {
      return Indicators._adxCache.result;
    }
    const adx = Indicators.adx(prices, period);
    const regime = adx >= 25 ? 'TRENDING' : adx >= 20 ? 'WEAK_TREND' : 'RANGING';
    const result = { adx, regime };
    Indicators._adxCache = { key: cacheKey, result };
    return result;
  }
  static _adxCache = null;

  // Volume Weighted Average Price (VWAP)
  static vwap(priceData, volumeData) {
    if (!priceData || priceData.length === 0) return 0;
    const lastPrice = Array.isArray(priceData[priceData.length - 1])
      ? priceData[priceData.length - 1][0] : priceData[priceData.length - 1];
    if (!volumeData || volumeData.length === 0) return lastPrice;
    const dataSize = Math.min(priceData.length, 100);
    const startIdx = Math.max(0, priceData.length - dataSize);
    let cumulativePV = 0, cumulativeV = 0;
    for (let i = startIdx; i < priceData.length; i++) {
      const price  = Array.isArray(priceData[i]) ? priceData[i][0] : priceData[i];
      const volume = volumeData[i] != null ? volumeData[i] : 0;
      cumulativePV += price * volume;
      cumulativeV  += volume;
    }
    return cumulativeV > 0 ? cumulativePV / cumulativeV : lastPrice;
  }

  // Dynamic stop loss / take profit levels based on ATR
  static getDynamicLevels(currentPrice, atr, vwap, direction = 'BUY', tpMultiplier = 5.0) {
    // BUG-28 fix: use cached module references instead of inline require() each call
    let slMult = 1.5;
    const cfg = _getConfig();
    if (cfg) slMult = cfg.slAtrMult || 1.5;
    const atrStop   = atr * slMult;
    const atrProfit = atr * tpMultiplier;
    let stopLoss   = direction === 'BUY' ? currentPrice - atrStop  : currentPrice + atrStop;
    const takeProfit = direction === 'BUY' ? currentPrice + atrProfit : currentPrice - atrProfit;

    // ── SAFETY bounds enforcement ─────────────────────────────────────────
    const safety = _getSafety();
    if (safety) {
      const slDist = Math.abs(currentPrice - stopLoss) / currentPrice;
      if (slDist > safety.MAX_STOP_LOSS_PCT) {
        stopLoss = direction === 'BUY'
          ? currentPrice * (1 - safety.MAX_STOP_LOSS_PCT)
          : currentPrice * (1 + safety.MAX_STOP_LOSS_PCT);
      } else if (slDist < safety.MIN_STOP_LOSS_PCT) {
        stopLoss = direction === 'BUY'
          ? currentPrice * (1 - safety.MIN_STOP_LOSS_PCT)
          : currentPrice * (1 + safety.MIN_STOP_LOSS_PCT);
      }
    }

    return { stopLoss, takeProfit, vwapLevel: vwap, atrStop, atrProfit };
  }


  // ── Divergence detection ─────────────────────────────────────────────────
  // Detects bullish/bearish divergence between price and RSI (or MACD).
  //
  // BULLISH divergence: price makes a lower low but RSI makes a higher low
  //   → momentum is strengthening despite price falling = reversal signal
  // BEARISH divergence: price makes a higher high but RSI makes a lower high
  //   → momentum is weakening despite price rising = reversal signal
  //
  // lookback: number of bars to look back for prior swing
  // Returns: { bullish, bearish, type, priceSwing, rsiSwing }
  static divergence(prices, rsiValues, lookback) {
    lookback = lookback || 20;
    if (prices.length < lookback + 1 || rsiValues.length < lookback + 1) {
      return { bullish: false, bearish: false, type: 'NONE' };
    }

    const n        = prices.length;
    const curPrice = prices[n - 1];
    const curRsi   = rsiValues[n - 1];

    // Find the most significant swing high/low in lookback window (excluding last bar)
    const window = prices.slice(n - lookback - 1, n - 1);
    const rsiWin = rsiValues.slice(n - lookback - 1, n - 1);

    const priorLow  = Math.min(...window);
    const priorHigh = Math.max(...window);
    const priorLowIdx  = window.indexOf(priorLow);
    const priorHighIdx = window.indexOf(priorHigh);

    const priorRsiAtLow  = rsiWin[priorLowIdx]  ?? 50;
    const priorRsiAtHigh = rsiWin[priorHighIdx] ?? 50;

    // Bullish divergence: price lower low, RSI higher low
    const priceLowerLow  = curPrice < priorLow;
    const rsiHigherLow   = curRsi   > priorRsiAtLow + 2;   // +2 buffer avoids noise
    const bullish        = priceLowerLow && rsiHigherLow && curRsi < 50; // only meaningful in oversold

    // Bearish divergence: price higher high, RSI lower high
    const priceHigherHigh = curPrice > priorHigh;
    const rsiLowerHigh    = curRsi   < priorRsiAtHigh - 2;
    const bearish         = priceHigherHigh && rsiLowerHigh && curRsi > 50; // only meaningful in overbought

    let type = 'NONE';
    if (bullish && bearish) type = 'CONFLICT'; // rare — treat as none
    else if (bullish)       type = 'BULLISH';
    else if (bearish)       type = 'BEARISH';

    return {
      bullish, bearish, type,
      priceSwing:  bullish ? priorLow  : bearish ? priorHigh  : null,
      rsiSwing:    bullish ? priorRsiAtLow : bearish ? priorRsiAtHigh : null,
      curPrice, curRsi,
    };
  }

  // ── Market microstructure signal classifier ──────────────────────────────
  // Replaces the old vote-count with a 5-factor quality score that understands:
  //   1. MACD momentum direction (slope) — is momentum accelerating or fading?
  //   2. RSI momentum zone — not just extremes, but velocity across 50 midline
  //   3. BB position — where is price in the volatility envelope?
  //   4. EMA alignment — short/mid trend stack confirms direction
  //   5. Volume confirmation — signal without volume is noise
  //
  // Each factor contributes a directional score (-2 to +2).
  // Total score → signal strength. Contradicting factors cancel each other out,
  // requiring genuine confluence for a STRONG signal.

  // #70: Extended signal including OVERSOLD/OVERBOUGHT for mean-reversion strategies
  static signalExtended(indicators) {
    const rsi = indicators.rsi;
    if (rsi != null && rsi <= 30) return 'OVERSOLD';
    if (rsi != null && rsi >= 70) return 'OVERBOUGHT';
    return Indicators.signal(indicators);
  }

  static signal(indicators) {
    const {
      rsi, macd, ema9, ema21, ema50,
      bb, vwap, price,
      prevMacd,          // MACD from previous bar — enables slope calc
      prevRsi,           // RSI from previous bar  — enables momentum calc
      volRatio = 1,      // current volume / 20-bar avg volume
    } = indicators;

    const p   = price  || ema9 || 0;
    const e9  = ema9   || p;
    const e21 = ema21  || p;
    const e50 = ema50  || e21;

    let bullScore = 0;   // positive = bullish evidence
    let bearScore = 0;   // positive = bearish evidence

    // ── Factor 1: MACD momentum direction (slope > level) ─────────────────
    // A rising MACD is bullish even if still negative (momentum turning).
    // A falling MACD is bearish even if still positive (momentum fading).
    const macdSlope = (prevMacd != null) ? macd - prevMacd : 0;
    if      (macd > 0 && macdSlope > 0)  bullScore += 2;  // accelerating bull
    else if (macd > 0 && macdSlope < 0)  bullScore += 1;  // bull but fading
    else if (macd < 0 && macdSlope < 0)  bearScore += 2;  // accelerating bear
    else if (macd < 0 && macdSlope > 0)  bearScore += 1;  // bear but turning

    // ── Factor 2: RSI zone + velocity ─────────────────────────────────────
    // Oversold/overbought extremes + crossing the 50 midline (momentum shift)
    const rsiSlope = (prevRsi != null) ? rsi - prevRsi : 0;
    if      (rsi < 30)              bullScore += 2;         // extreme oversold (weighted 2×)
    else if (rsi < 45 && rsiSlope > 1) bullScore += 1;     // rising from low base
    else if (rsi > 70)              bearScore += 2;         // extreme overbought (weighted 2×)
    else if (rsi > 55 && rsiSlope < -1) bearScore += 1;    // falling from high base
    // Midline cross — momentum regime change
    if      (prevRsi != null && prevRsi < 50 && rsi >= 50) bullScore += 1;
    else if (prevRsi != null && prevRsi > 50 && rsi <= 50) bearScore += 1;

    // ── Factor 3: Bollinger Band position (regime-aware) ──────────────────
    // In a bull trend: below lower BB = oversold (bullish). Above upper BB = breakout (mild bull).
    // In a bear trend: above upper BB = overbought (bearish). Below lower BB = breakdown (mild bear).
    // Treating both contexts the same was the classic mean-reversion-vs-trend error.
    if (bb && bb.upper && bb.lower && bb.middle) {
      const bbRange   = (bb.upper - bb.lower) || 1e-8;  // guard against flat prices
      const bbPos     = (p - bb.lower) / bbRange;   // 0=at lower, 1=at upper
      const bullTrend = e9 >= e21;                   // short-term trend direction proxy

      if (p <= bb.lower) {
        // Below lower BB: oversold bounce in bull trend, breakdown continuation in bear
        if (bullTrend) bullScore += 2;
        else           bearScore += 1;   // confirm breakdown — less extreme than oversold
      } else if (bbPos < 0.25 && bullTrend) {
        bullScore += 1;                  // in lower quarter of range, trend still up
      } else if (p >= bb.upper) {
        // Above upper BB: overbought fade in bear trend, breakout in bull trend
        if (!bullTrend) bearScore += 2;
        else            bullScore += 1;  // breakout continuation
      } else if (bbPos > 0.75 && !bullTrend) {
        bearScore += 1;                  // in upper quarter, trend still down
      } else if (bbPos > 0.5 && e9 > e21)  { bullScore += 1; }  // holding above mid
      else if (bbPos < 0.5 && e9 < e21)    { bearScore += 1; }   // holding below mid
    }

    // ── Factor 4: EMA alignment (trend stack) ─────────────────────────────
    // Full alignment (9 > 21 > 50) = trend in good order.
    // Partial alignment (9 > 21 but 21 < 50) = transition, lower conviction.
    if      (e9 > e21 && e21 > e50)  bullScore += 2;  // full bull stack
    else if (e9 > e21)               bullScore += 1;  // partial bull
    else if (e9 < e21 && e21 < e50)  bearScore += 2;  // full bear stack
    else if (e9 < e21)               bearScore += 1;  // partial bear

    // ── Factor 5: Volume confirmation ─────────────────────────────────────
    // A directional move on above-average volume is real.
    // A move on thin volume is suspicious — reduce both scores.
    if (volRatio >= 1.5) {
      // Surge — amplify the dominant side
      if (bullScore > bearScore)  bullScore += 1;
      else if (bearScore > bullScore) bearScore += 1;
    } else if (volRatio < 0.5) {
      // Thin — reduce conviction on both sides
      bullScore = Math.max(0, bullScore - 1);
      bearScore = Math.max(0, bearScore - 1);
    }

    // ── Score → signal ────────────────────────────────────────────────────
    const net = bullScore - bearScore;
    if      (net >= 4) return 'STRONG_BUY';
    else if (net >= 2) return 'BUY';
    else if (net <= -4) return 'STRONG_SELL';
    else if (net <= -2) return 'SELL';
    return 'NEUTRAL';
  }

  // ── Feature #56: Volume-Weighted ATR ─────────────────────────────────────
  // Weights each bar's true range by its relative volume.
  // High-volume bars contribute more to the ATR estimate, making it
  // more responsive to volatility that actually moved meaningful size.
  // Falls back to standard ATR when volumes not provided or all zero.
  static volumeWeightedATR(prices, volumes, period = 14) {
    if (!prices || !volumes || prices.length < period + 1 || volumes.length < period) {
      return Indicators.atr(prices, period);
    }
    const trueRanges = [];
    const vols       = [];
    for (let i = Math.max(1, prices.length - period * 2); i < prices.length; i++) {
      const tr  = Math.abs(prices[i] - prices[i - 1]);
      const vol = volumes[i] || 0;
      trueRanges.push(tr);
      vols.push(vol);
    }
    const recentTR  = trueRanges.slice(-period);
    const recentVol = vols.slice(-period);
    const totalVol  = recentVol.reduce((s, v) => s + v, 0);
    if (totalVol <= 0) return Indicators.atr(prices, period);
    const vwATR = recentTR.reduce((s, tr, i) => s + tr * (recentVol[i] / totalVol), 0);
    return vwATR;
  }
}

// Fix #64: Each indicator self-reports its minimum required bar count
Indicators.minBars = {
  ema9:   9,
  ema21:  21,
  ema50:  50,
  ema200: 200,
  rsi:    14,
  macd:   26,
  atr:    14,
  bb:     20,
  adx:    28,  // 14 period × 2
};
// Minimum bars needed to compute ALL indicators safely
Indicators.globalMinBars = Math.max(...Object.values(Indicators.minBars));  // 200

module.exports = { Indicators };
