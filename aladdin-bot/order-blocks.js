'use strict';
// order-blocks.js — Item 46: Institutional Order Block Detection
// Order blocks are the last up/down candle before a significant move.
// They represent areas where institutional orders were placed.

class OrderBlockDetector {
  constructor(opts = {}) {
    this.minMoveATR   = opts.minMoveATR   || 3;   // min move to qualify (in ATR)
    this.maxBlockAge  = opts.maxBlockAge  || 50;  // max bars old
    this._blocks      = [];
  }

  // Analyse new bar; ohlcv = {o,h,l,c,v}
  update(ohlcvHistory) {
    if (!ohlcvHistory || ohlcvHistory.length < 10) return this._blocks;
    const bars = ohlcvHistory.slice(-100);
    const n    = bars.length;
    // ATR approximation
    const atr  = bars.slice(-14).reduce((s,b,i,a)=>i?s+Math.abs(b.c-(a[i-1]?.c||b.c)):s,0)/13 || 0.001;

    this._blocks = [];
    for (let i = 2; i < n - 5; i++) {
      const bar   = bars[i];
      const move  = Math.abs(bars[i+5]?.c - bar.c) || 0;
      if (move < atr * this.minMoveATR) continue;
      const isBull = bars[i+5]?.c > bar.c;
      // The order block is the last bearish (for bullish move) or bullish (for bearish move) candle
      const isOB = isBull ? bar.c < bar.o : bar.c > bar.o;
      if (isOB && (n - i) <= this.maxBlockAge) {
        this._blocks.push({
          type:    isBull ? 'DEMAND' : 'SUPPLY',
          high:    bar.h,
          low:     bar.l,
          mid:     (bar.h+bar.l)/2,
          strength:parseFloat((move/atr).toFixed(2)),
          barsAgo: n-i-1,
        });
      }
    }
    return this._blocks.sort((a,b)=>b.strength-a.strength).slice(0,10);
  }

  // Is current price near an order block?
  nearBlock(price, atr) {
    const _tol = atr * 0.5;
    return this._blocks.find(b => Math.abs(price - b.mid) < _tol) || null;
  }
}

module.exports = { OrderBlockDetector };
