'use strict';
// ── market-structure.js ───────────────────────────────────────────────────────
// Institutional market structure analysis:
//   1. Fair Value Gaps (FVG) — 3-candle imbalance zones price fills later
//   2. Order Blocks — last bearish/bullish candle before a strong move
//   3. Entry timing — optimal entry within a signal (pullback to level)
// ─────────────────────────────────────────────────────────────────────────────

class MarketStructure {

  // ── Fair Value Gap detection ──────────────────────────────────────────────
  // A bullish FVG: high of candle[i-2] < low of candle[i] (gap left unfilled)
  // A bearish FVG: low of candle[i-2] > high of candle[i]
  // Price tends to return to these zones to fill the imbalance.
  static findFVGs(ohlcv, lookback) {
    lookback = lookback || 20;
    const fvgs = [];
    if (!ohlcv || ohlcv.length < 3) return fvgs;
    const start = Math.max(2, ohlcv.length - lookback);

    for (let i = start; i < ohlcv.length; i++) {
      const c0 = ohlcv[i - 2];  // two bars ago
      const c2 = ohlcv[i];      // current bar

      if (!c0 || !c2) continue;
      const h0 = c0.h || c0.high  || c0.c || 0;
      const l0 = c0.l || c0.low   || c0.c || 0;
      const h2 = c2.h || c2.high  || c2.c || 0;
      const l2 = c2.l || c2.low   || c2.c || 0;

      // Bullish FVG: gap between top of candle[i-2] and bottom of candle[i]
      if (h0 < l2) {
        fvgs.push({
          type:     'BULLISH_FVG',
          top:      l2,     // bottom of the new candle (fill zone top)
          bottom:   h0,     // top of the old candle (fill zone bottom)
          midpoint: (h0 + l2) / 2,
          barIndex: i,
          filled:   false,
          strength: (l2 - h0) / ((h0 + l2) / 2) * 100,  // gap % of price
        });
      }

      // Bearish FVG: gap between bottom of candle[i-2] and top of candle[i]
      if (l0 > h2) {
        fvgs.push({
          type:     'BEARISH_FVG',
          top:      l0,
          bottom:   h2,
          midpoint: (l0 + h2) / 2,
          barIndex: i,
          filled:   false,
          strength: (l0 - h2) / ((l0 + h2) / 2) * 100,
        });
      }
    }

    // Mark which FVGs have been filled by subsequent price action
    for (const fvg of fvgs) {
      for (let j = fvg.barIndex + 1; j < ohlcv.length; j++) {
        const bar = ohlcv[j];
        if (!bar) continue;
        const bh = bar.h || bar.high || bar.c || 0;
        const bl = bar.l || bar.low  || bar.c || 0;
        if (fvg.type === 'BULLISH_FVG' && bl <= fvg.midpoint) { fvg.filled = true; break; }
        if (fvg.type === 'BEARISH_FVG' && bh >= fvg.midpoint) { fvg.filled = true; break; }
      }
    }

    return fvgs.filter(f => !f.filled); // only unfilled gaps
  }

  // ── Order block detection ─────────────────────────────────────────────────
  // An order block is the last bearish candle before a bullish impulse move
  // (or last bullish candle before a bearish impulse). Price often retraces to
  // these zones where institutional orders were placed.
  static findOrderBlocks(ohlcv, lookback) {
    lookback = lookback || 30;
    const obs = [];
    if (!ohlcv || ohlcv.length < 5) return obs;
    const start = Math.max(4, ohlcv.length - lookback);

    for (let i = start; i < ohlcv.length - 2; i++) {
      const bar  = ohlcv[i];
      const next = ohlcv[i + 1];
      const next2= ohlcv[i + 2];
      if (!bar || !next || !next2) continue;

      const bc  = bar.c  || 0, bo  = bar.o  || 0;
      const nc  = next.c || 0, nc2 = next2.c || 0;
      const nh  = next.h || next.c || 0;
      const nl  = next.l || next.c || 0;

      // Bullish OB: last bearish candle before 2+ strong bullish candles
      const isBearBar    = bc < bo;
      const strongBullish = (nc > nc2 * 0.999) && ((nc - nl) / Math.max(nl, 1) > 0.001);
      if (isBearBar && strongBullish) {
        obs.push({
          type:    'BULLISH_OB',
          high:    bo,
          low:     bc,
          midpoint: (bo + bc) / 2,
          barIndex: i,
          strength: Math.abs(nc - bc) / Math.max(bc, 1) * 100,
        });
      }

      // Bearish OB: last bullish candle before strong bearish move
      const isBullBar    = bc > bo;
      const strongBearish = (nc < nc2 * 1.001) && ((nh - nc) / Math.max(nc, 1) > 0.001);
      if (isBullBar && strongBearish) {
        obs.push({
          type:    'BEARISH_OB',
          high:    bc,
          low:     bo,
          midpoint: (bc + bo) / 2,
          barIndex: i,
          strength: Math.abs(nc - bc) / Math.max(bc, 1) * 100,
        });
      }
    }
    return obs.slice(-5); // keep last 5 order blocks
  }

  // ── Entry timing: optimal entry within signal ─────────────────────────────
  // Instead of entering immediately at signal bar, wait for:
  //   - Pullback to nearest support (for LONG) or resistance (for SHORT)
  //   - Or entry at 50% retracement of the signal candle body
  // Returns { shouldWait, targetEntry, maxWaitBars, reason }
  static getOptimalEntry(price, signal, sr, atr) {
    if (!sr || (!sr.nearestSupport && !sr.nearestResistance)) {
      return { shouldWait: false, targetEntry: price, maxWaitBars: 0 };
    }

    const halfATR = (atr || price * 0.001) * 0.5;

    if (signal === 'BUY' || signal === 'STRONG_BUY') {
      const support = sr.nearestSupport?.price;
      if (support && price - support < atr * 2 && price - support > halfATR) {
        // Price is within 2 ATR of support — wait for pullback to support
        return {
          shouldWait:   true,
          targetEntry:  support + halfATR * 0.5,  // entry just above support
          maxWaitBars:  3,                          // wait max 3 bars
          reason:       'Waiting for pullback to support @ ' + support.toFixed(5),
        };
      }
    }

    if (signal === 'SELL' || signal === 'STRONG_SELL') {
      const resist = sr.nearestResistance?.price;
      if (resist && resist - price < atr * 2 && resist - price > halfATR) {
        return {
          shouldWait:   true,
          targetEntry:  resist - halfATR * 0.5,
          maxWaitBars:  3,
          reason:       'Waiting for pullback to resistance @ ' + resist.toFixed(5),
        };
      }
    }

    return { shouldWait: false, targetEntry: price, maxWaitBars: 0 };
  }
}

module.exports = { MarketStructure };
