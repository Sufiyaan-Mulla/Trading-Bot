'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  OOSGuard  —  Feature #58
//
//  Enforces out-of-sample holdout at the DATA ACCESS level (not just the runner).
//  Wraps a price array so any attempt to read beyond the IS boundary throws,
//  making it physically impossible for a developer to accidentally pass the
//  full dataset as both IS and OOS.
//
//  Usage:
//    const { OOSGuard } = require('./oos-guard');
//    const guard = new OOSGuard(prices, volumes, 0.80);  // 80% IS
//    guard.IS.prices     // first 80% — safe to use for training
//    guard.OOS.prices    // last 20% — for evaluation only
//    guard.IS.prices[guard.IS.length]  // throws RangeError: OOS boundary violated
// ─────────────────────────────────────────────────────────────────────────────

class OOSGuard {
  /**
   * @param {number[]} prices
   * @param {number[]} [volumes]
   * @param {number}   [isFraction=0.80]  fraction for in-sample
   * @param {number}   [embargoFrac=0.01] fraction held out as embargo (neither IS nor OOS)
   */
  constructor(prices, volumes = [], isFraction = 0.80, embargoFrac = 0.01) {
    if (!Array.isArray(prices) || prices.length < 10)
      throw new Error('OOSGuard: prices must be an array of at least 10 elements');

    const n          = prices.length;
    const isEnd      = Math.floor(n * isFraction);
    const embargoEnd = Math.min(n, Math.floor(isEnd + n * embargoFrac));

    this._isEnd      = isEnd;
    this._embargoEnd = embargoEnd;
    this._n          = n;

    this.IS  = this._makeGuarded(prices, volumes, 0,          isEnd,      'IS');
    this.OOS = this._makeGuarded(prices, volumes, embargoEnd,  n,          'OOS');
    this.EMBARGO = { prices: prices.slice(isEnd, embargoEnd), length: embargoEnd - isEnd };

    Object.freeze(this);
  }

  _makeGuarded(prices, volumes, start, end, label) {
    const pSlice = prices.slice(start, end);
    const vSlice = volumes.slice(start, end);
    const len    = pSlice.length;

    // Proxy to intercept index access beyond boundary
    const handler = {
      get(target, prop) {
        if (prop === 'length') return len;
        const idx = typeof prop === 'string' ? Number(prop) : prop;
        if (Number.isInteger(idx)) {
          if (idx < 0 || idx >= len) {
            throw new RangeError(`OOSGuard: ${label} boundary violated — index ${idx} out of range [0, ${len})`);
          }
          return target[idx];
        }
        return target[prop];
      },
    };

    return {
      prices:  new Proxy(pSlice, handler),
      volumes: new Proxy(vSlice, handler),
      length:  len,
      label,
      start,
      end,
      // Safe slice that stays within boundary
      slice(a, b) {
        const sa = Math.max(0, a ?? 0);
        const sb = Math.min(len, b ?? len);
        return { prices: pSlice.slice(sa, sb), volumes: vSlice.slice(sa, sb), length: sb - sa };
      },
    };
  }

  summary() {
    return {
      total:      this._n,
      isLength:   this.IS.length,
      embargo:    this.EMBARGO.length,
      oosLength:  this.OOS.length,
      isFraction: parseFloat((this.IS.length / this._n).toFixed(3)),
    };
  }
}

module.exports = { OOSGuard };
