'use strict';
// ── indicators-new.js ─────────────────────────────────────────────────────────
// IMPROVEMENT #1-5: New indicators added to extend indicators.js
//   1. StochRSI      — Stochastic RSI (faster oscillator)
//   2. Ichimoku      — Full Ichimoku Cloud (Tenkan/Kijun/Senkou A&B/Chikou)
//   3. Fibonacci     — Fibonacci retracement levels from swing high/low
//   4. HeikinAshi    — Heikin-Ashi candle transformation
//   5. KeltnerChannel— Keltner Channels + BB Squeeze detection
//   6. SMA           — Simple Moving Average (missing utility)
//   7. CCI           — Commodity Channel Index
// All functions are pure (no state/side effects) and plug into Indicators class.
// ─────────────────────────────────────────────────────────────────────────────

class IndicatorsNew {

  // ── #1: Simple Moving Average ─────────────────────────────────────────────
  static sma(prices, period) {
    if (!prices || prices.length < period) return prices ? prices[prices.length - 1] : 0;
    const slice = prices.slice(-period);
    return slice.reduce((s, v) => s + v, 0) / period;
  }

  // ── #2: Stochastic RSI ────────────────────────────────────────────────────
  // StochRSI = (RSI - RSI_min) / (RSI_max - RSI_min) over stochPeriod bars
  // Returns { k, d } where d = 3-bar SMA of k.
  // Range: 0–100. Below 20 = oversold, above 80 = overbought.
  static stochRSI(prices, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
    if (!prices || prices.length < rsiPeriod + stochPeriod + kSmooth + 2) {
      return { k: 50, d: 50, overbought: false, oversold: false };
    }

    // Build RSI history — one value per bar (need enough bars)
    const rsiHistory = [];
    const minLen = rsiPeriod + 1;
    for (let i = minLen; i <= prices.length; i++) {
      rsiHistory.push(IndicatorsNew._rsi(prices.slice(0, i), rsiPeriod));
    }

    if (rsiHistory.length < stochPeriod + kSmooth) {
      return { k: 50, d: 50, overbought: false, oversold: false };
    }

    // Build raw K values (stochastic applied to RSI)
    const rawK = [];
    for (let i = stochPeriod - 1; i < rsiHistory.length; i++) {
      const window = rsiHistory.slice(i - stochPeriod + 1, i + 1);
      const lo = Math.min(...window);
      const hi = Math.max(...window);
      rawK.push(hi === lo ? 50 : ((rsiHistory[i] - lo) / (hi - lo)) * 100);
    }

    // Smooth K (kSmooth-bar SMA)
    const smoothedK = [];
    for (let i = kSmooth - 1; i < rawK.length; i++) {
      smoothedK.push(rawK.slice(i - kSmooth + 1, i + 1).reduce((s, v) => s + v, 0) / kSmooth);
    }

    if (smoothedK.length === 0) return { k: 50, d: 50, overbought: false, oversold: false };

    // D = dSmooth-bar SMA of smoothed K
    const k = smoothedK[smoothedK.length - 1];
    const dSlice = smoothedK.slice(-dSmooth);
    const d = dSlice.reduce((s, v) => s + v, 0) / dSlice.length;

    // K crossing D (momentum shift signal)
    const prevK = smoothedK.length >= 2 ? smoothedK[smoothedK.length - 2] : k;
    const prevD = smoothedK.length >= dSmooth + 1
      ? smoothedK.slice(-dSmooth - 1, -1).reduce((s, v) => s + v, 0) / dSmooth
      : d;

    const bullCross = prevK < prevD && k >= d;   // K crossed above D from below
    const bearCross = prevK > prevD && k <= d;   // K crossed below D from above

    return {
      k: parseFloat(k.toFixed(2)),
      d: parseFloat(d.toFixed(2)),
      overbought: k > 80,
      oversold:   k < 20,
      bullCross,
      bearCross,
    };
  }

  // ── Internal RSI helper (avoids circular dep with main indicators.js) ─────
  static _rsi(prices, period = 14) {
    if (prices.length < period + 1) return 50;
    let avgGain = 0, avgLoss = 0;
    for (let i = 1; i <= period; i++) {
      const d = prices[i] - prices[i - 1];
      if (d > 0) avgGain += d; else avgLoss -= d;
    }
    avgGain /= period; avgLoss /= period;
    for (let i = period + 1; i < prices.length; i++) {
      const d = prices[i] - prices[i - 1];
      avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    }
    const rs = avgGain / (avgLoss || 1e-10);
    return 100 - (100 / (1 + rs));
  }

  // ── #3: Ichimoku Cloud ────────────────────────────────────────────────────
  // Standard periods: Tenkan=9, Kijun=26, Senkou B=52
  // Returns all 5 Ichimoku lines + cloud interpretation.
  // Requires OHLC prices array: each element is { h, l, c } or [c, h, l]
  static ichimoku(prices, tenkanPeriod = 9, kijunPeriod = 26, senkouBPeriod = 52) {
    // Support both close-only arrays and OHLC arrays
    const getHL = (p) => {
      if (Array.isArray(p)) return { h: p[1] || p[0], l: p[2] || p[0], c: p[0] };
      if (typeof p === 'object' && p.h != null) return p;
      return { h: p, l: p, c: p };
    };

    const midpoint = (arr, period) => {
      if (arr.length < period) return null;
      const slice = arr.slice(-period).map(getHL);
      const hi = Math.max(...slice.map(b => b.h));
      const lo = Math.min(...slice.map(b => b.l));
      return (hi + lo) / 2;
    };

    const tenkan = midpoint(prices, tenkanPeriod);
    const kijun  = midpoint(prices, kijunPeriod);

    // Senkou Span A = (Tenkan + Kijun) / 2
    const senkouA = (tenkan != null && kijun != null) ? (tenkan + kijun) / 2 : null;

    // Senkou Span B = midpoint of last 52 bars
    const senkouB = midpoint(prices, senkouBPeriod);

    // Current close
    const last = getHL(prices[prices.length - 1]);
    const close = last.c;

    // Chikou Span = current close plotted 26 bars back (we return the close value)
    const chikou = close;

    // Cloud interpretation
    let cloudBullish = null, aboveCloud = null, belowCloud = null;
    if (senkouA != null && senkouB != null) {
      cloudBullish = senkouA > senkouB;    // bullish cloud = A above B
      aboveCloud   = close > Math.max(senkouA, senkouB);
      belowCloud   = close < Math.min(senkouA, senkouB);
    }

    // TK cross (Tenkan crossing Kijun = momentum signal)
    let tkBullCross = false, tkBearCross = false;
    if (prices.length >= Math.max(tenkanPeriod, kijunPeriod) + 2) {
      const prevPrices = prices.slice(0, -1);
      const prevTenkan = midpoint(prevPrices, tenkanPeriod);
      const prevKijun  = midpoint(prevPrices, kijunPeriod);
      if (prevTenkan != null && prevKijun != null && tenkan != null && kijun != null) {
        tkBullCross = prevTenkan <= prevKijun && tenkan > kijun;
        tkBearCross = prevTenkan >= prevKijun && tenkan < kijun;
      }
    }

    // Overall bias
    let bias = 'NEUTRAL';
    if (aboveCloud && tenkan > kijun)  bias = 'BULLISH';
    if (belowCloud && tenkan < kijun)  bias = 'BEARISH';

    return {
      tenkan:   tenkan   != null ? parseFloat(tenkan.toFixed(5))   : null,
      kijun:    kijun    != null ? parseFloat(kijun.toFixed(5))    : null,
      senkouA:  senkouA  != null ? parseFloat(senkouA.toFixed(5))  : null,
      senkouB:  senkouB  != null ? parseFloat(senkouB.toFixed(5))  : null,
      chikou:   parseFloat(chikou.toFixed(5)),
      cloudBullish, aboveCloud, belowCloud,
      tkBullCross, tkBearCross,
      bias,
    };
  }

  // ── #4: Fibonacci Retracement Levels ─────────────────────────────────────
  // Finds the most recent significant swing high and low, then computes Fib levels.
  // lookback: number of bars to search for the swing
  static fibonacci(prices, lookback = 50) {
    if (!prices || prices.length < 10) return null;
    const slice = prices.slice(-Math.min(lookback, prices.length));
    const hi    = Math.max(...slice);
    const lo    = Math.min(...slice);
    const range = hi - lo;
    if (range < 1e-8) return null;

    const levels = {
      swing_high: hi,
      swing_low:  lo,
      '0.0':   hi,
      '0.236': hi - 0.236 * range,
      '0.382': hi - 0.382 * range,
      '0.500': hi - 0.500 * range,
      '0.618': hi - 0.618 * range,
      '0.786': hi - 0.786 * range,
      '1.0':   lo,
      // Extensions (beyond swing low)
      '1.272': lo - 0.272 * range,
      '1.618': lo - 0.618 * range,
    };

    // Identify which zone the current price is in
    const current = prices[prices.length - 1];
    const pct     = (hi - current) / range;   // 0 = at high, 1 = at low

    let nearestLevel = null, nearestDist = Infinity;
    for (const [key, val] of Object.entries(levels)) {
      if (key === 'swing_high' || key === 'swing_low') continue;
      const dist = Math.abs(current - val);
      if (dist < nearestDist) { nearestDist = dist; nearestLevel = key; }
    }

    const atFibSupport    = pct >= 0.35 && pct <= 0.65;  // 38.2%–61.8% zone = golden pocket
    const atGoldenPocket  = pct >= 0.50 && pct <= 0.65;  // 50%–61.8% = strongest zone

    return {
      levels,
      currentPct: parseFloat(pct.toFixed(3)),
      nearestLevel,
      nearestDist: parseFloat(nearestDist.toFixed(5)),
      atFibSupport,
      atGoldenPocket,
    };
  }

  // ── #5: Heikin-Ashi Candles ───────────────────────────────────────────────
  // Converts OHLCV data to Heikin-Ashi smoothed candles.
  // Input: array of { o, h, l, c } or use close-only (approximation).
  // Returns last N HA candles with trend classification.
  static heikinAshi(ohlcv, count = 10) {
    if (!ohlcv || ohlcv.length < 3) return null;

    const getOHLC = (b) => {
      if (typeof b === 'object' && b.o != null) return b;
      // Close-only: approximate OHLC
      return { o: b, h: b, l: b, c: b };
    };

    const bars = ohlcv.map(getOHLC);
    const ha   = [];
    let prevHAOpen = (bars[0].o + bars[0].c) / 2;
    let prevHAClose = (bars[0].o + bars[0].h + bars[0].l + bars[0].c) / 4;

    for (let i = 0; i < bars.length; i++) {
      const b     = bars[i];
      const haClose = (b.o + b.h + b.l + b.c) / 4;
      const haOpen  = (prevHAOpen + prevHAClose) / 2;
      const haHigh  = Math.max(b.h, haOpen, haClose);
      const haLow   = Math.min(b.l, haOpen, haClose);

      ha.push({ o: haOpen, h: haHigh, l: haLow, c: haClose,
        bullish: haClose > haOpen,
        noLowerShadow: haLow === Math.min(haOpen, haClose),   // strong bull candle
        noUpperShadow: haHigh === Math.max(haOpen, haClose),  // strong bear candle
      });

      prevHAOpen  = haOpen;
      prevHAClose = haClose;
    }

    const recent = ha.slice(-count);
    const last   = recent[recent.length - 1];
    const prev   = recent[recent.length - 2] || last;

    // Trend: count consecutive bull/bear candles
    let bullStreak = 0, bearStreak = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      if (recent[i].bullish)  { bullStreak++; if (!recent[i].bullish) break; }
      else break;
    }
    for (let i = recent.length - 1; i >= 0; i--) {
      if (!recent[i].bullish) { bearStreak++; if (recent[i].bullish) break; }
      else break;
    }

    const trend = last.bullish
      ? (last.noLowerShadow ? 'STRONG_BULL' : 'BULL')
      : (last.noUpperShadow ? 'STRONG_BEAR' : 'BEAR');

    const reversal = (last.bullish !== prev.bullish);  // candle color changed = possible reversal

    return { candles: recent, last, trend, bullStreak, bearStreak, reversal };
  }

  // ── #6: Keltner Channels + BB Squeeze ────────────────────────────────────
  // Squeeze = BB contracting inside Keltner = low volatility → breakout pending
  static keltnerChannels(prices, emaPeriod = 20, atrMult = 1.5, atrPeriod = 14) {
    if (!prices || prices.length < emaPeriod + atrPeriod) return null;

    const k  = 2 / (emaPeriod + 1);
    let ema  = prices.slice(0, emaPeriod).reduce((s, v) => s + v, 0) / emaPeriod;
    for (let i = emaPeriod; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);

    // ATR (close-only approximation)
    const trs = [];
    for (let i = 1; i < prices.length; i++) trs.push(Math.abs(prices[i] - prices[i - 1]));
    const atr = trs.slice(-atrPeriod).reduce((s, v) => s + v, 0) / atrPeriod;

    const upper  = ema + atrMult * atr;
    const lower  = ema - atrMult * atr;
    const middle = ema;

    return {
      upper:  parseFloat(upper.toFixed(5)),
      middle: parseFloat(middle.toFixed(5)),
      lower:  parseFloat(lower.toFixed(5)),
      atr:    parseFloat(atr.toFixed(5)),
    };
  }

  // BB Squeeze: True when BB bands are inside Keltner bands
  static bbSqueeze(prices, bbPeriod = 20, bbStd = 2, kcPeriod = 20, kcMult = 1.5, atrPeriod = 14) {
    if (!prices || prices.length < Math.max(bbPeriod, kcPeriod) + atrPeriod + 5) {
      return { squeeze: false, momentum: 0, squeezeFiring: false };
    }

    // Bollinger Bands
    const bbSlice = prices.slice(-bbPeriod);
    const bbMid   = bbSlice.reduce((s, v) => s + v, 0) / bbPeriod;
    const bbVar   = bbSlice.reduce((s, v) => s + (v - bbMid) ** 2, 0) / (bbPeriod - 1);
    const bbStdVal = Math.sqrt(bbVar);
    const bbUpper  = bbMid + bbStd * bbStdVal;
    const bbLower  = bbMid - bbStd * bbStdVal;

    // Keltner Channels
    const kc = IndicatorsNew.keltnerChannels(prices, kcPeriod, kcMult, atrPeriod);
    if (!kc) return { squeeze: false, momentum: 0, squeezeFiring: false };

    // Squeeze = BB inside KC
    const squeeze = bbUpper < kc.upper && bbLower > kc.lower;

    // Momentum oscillator (close - midpoint of high/low/close over period)
    const current  = prices[prices.length - 1];
    const momentum = current - bbMid;   // distance from mean (positive = above, upward momentum)

    // Was squeezing last bar but not now = squeeze firing (breakout imminent)
    let squeezeFiring = false;
    if (prices.length > bbPeriod + 2) {
      const prevPrices = prices.slice(0, -1);
      const prevBBSlice = prevPrices.slice(-bbPeriod);
      const prevMid  = prevBBSlice.reduce((s, v) => s + v, 0) / bbPeriod;
      const prevVar  = prevBBSlice.reduce((s, v) => s + (v - prevMid) ** 2, 0) / (bbPeriod - 1);
      const prevStd  = Math.sqrt(prevVar);
      const prevKC   = IndicatorsNew.keltnerChannels(prevPrices, kcPeriod, kcMult, atrPeriod);
      if (prevKC) {
        const prevSqueeze = (prevMid + bbStd * prevStd) < prevKC.upper &&
                            (prevMid - bbStd * prevStd) > prevKC.lower;
        squeezeFiring = prevSqueeze && !squeeze;
      }
    }

    return {
      squeeze,
      momentum: parseFloat(momentum.toFixed(5)),
      squeezeFiring,
      bbUpper:  parseFloat(bbUpper.toFixed(5)),
      bbLower:  parseFloat(bbLower.toFixed(5)),
      kcUpper:  kc.upper,
      kcLower:  kc.lower,
    };
  }

  // ── #7: Commodity Channel Index (CCI) ────────────────────────────────────
  // CCI > +100 = overbought, < -100 = oversold
  // Particularly useful in trending markets for pullback entries
  static cci(prices, period = 20) {
    if (!prices || prices.length < period) return 0;
    const slice  = prices.slice(-period);
    const sma    = slice.reduce((s, v) => s + v, 0) / period;
    // Mean absolute deviation
    const mad    = slice.reduce((s, v) => s + Math.abs(v - sma), 0) / period;
    if (mad < 1e-10) return 0;
    const current = prices[prices.length - 1];
    return parseFloat(((current - sma) / (0.015 * mad)).toFixed(2));
  }

  // ── #8: Donchian Channel ─────────────────────────────────────────────────
  // Highest high and lowest low over period. Classic breakout reference.
  static donchianChannel(prices, period = 20) {
    if (!prices || prices.length < period) return null;
    const slice = prices.slice(-period);
    const upper = Math.max(...slice);
    const lower = Math.min(...slice);
    return {
      upper: parseFloat(upper.toFixed(5)),
      lower: parseFloat(lower.toFixed(5)),
      middle: parseFloat(((upper + lower) / 2).toFixed(5)),
    };
  }
}

module.exports = { IndicatorsNew };
