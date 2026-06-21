'use strict';
// ── parallel-scanner.js ───────────────────────────────────────────────────────
// Promise.all concurrent multi-asset scorer with per-asset rate limiting.
//
// Fixes: Performance partial — "Parallelise independent symbol analysis safely."
//
// The engine currently scores assets sequentially in a for-loop.
// ParallelScanner fans them all out concurrently (bounded by concurrencyLimit)
// so that N assets take roughly max(scoreTime) instead of sum(scoreTime).
//
// Usage:
//   const { ParallelScanner } = require('./parallel-scanner');
//   const scanner = new ParallelScanner({ concurrencyLimit: 4 });
//   const scores  = await scanner.scan(assets, async (asset) => {
//     return { asset, score: await computeScore(asset) };
//   });
//   scores.sort((a, b) => b.score - a.score);
// ─────────────────────────────────────────────────────────────────────────────

class ParallelScanner {
  constructor(opts = {}) {
    this.concurrencyLimit = opts.concurrencyLimit || 4;
    this.timeoutMs        = opts.timeoutMs        || 5_000;
    this._lastScanMs      = 0;
    this._scanHistory     = [];
  }

  // ── Scan all assets concurrently ──────────────────────────────────────────
  // assets:  string[]
  // scoreFn: async (asset: string) → any
  // Returns: array of results (same order as assets), nulls for failures/timeouts
  async scan(assets, scoreFn) {
    if (!assets || !assets.length) return [];

    // Feature #82: Backpressure — if a scan is already running, skip this call
    // rather than queuing unboundedly. This prevents accumulation during slow ticks.
    if (this._scanning) {
      this._droppedScans = (this._droppedScans || 0) + 1;
      if (this._droppedScans % 10 === 1)
        console.warn(`[ParallelScanner] Backpressure: ${this._droppedScans} scans dropped (previous still running)`);
      return [];
    }
    this._scanning = true;

    const t0 = Date.now();
    try {
      // Split into batches of concurrencyLimit
      const results = new Array(assets.length);
      const batches  = this._chunk(assets, this.concurrencyLimit);

      let runningOffset = 0;
      for (const batch of batches) {
        const batchResults = await Promise.allSettled(
          batch.map(asset => this._timed(asset, scoreFn))
        );
        batchResults.forEach((r, i) => {
          results[runningOffset + i] = r.status === 'fulfilled' ? r.value : { asset: batch[i], error: r.reason?.message, score: -Infinity };
        });
        runningOffset += batch.length;
      }

      const elapsed = Date.now() - t0;
      this._lastScanMs = elapsed;
      this._scanHistory.push(elapsed);
      if (this._scanHistory.length > 50) this._scanHistory.shift();
      return results;
    } finally {
      this._scanning = false;
    }
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  stats() {
    if (!this._scanHistory.length) return { count: 0 };
    const avg = this._scanHistory.reduce((s, v) => s + v, 0) / this._scanHistory.length;
    return {
      count:    this._scanHistory.length,
      lastMs:   this._lastScanMs,
      avgMs:    parseFloat(avg.toFixed(1)),
      maxMs:    Math.max(...this._scanHistory),
      concurrencyLimit: this.concurrencyLimit,
    };
  }

  // ── Internal ───────────────────────────────────────────────────────────────
  async _timed(asset, fn) {
    // Item 94: Store timer handle and clear it when the work promise settles so
    // the timeout handle doesn't keep the event loop alive after success, and
    // so it can be .unref()'d in environments that support it.
    let _timer;
    const timeoutPromise = new Promise((_, rej) => {
      _timer = setTimeout(() => rej(new Error(`Timeout scoring ${asset}`)), this.timeoutMs);
      if (_timer.unref) _timer.unref();
    });
    try {
      const result = await Promise.race([fn(asset), timeoutPromise]);
      clearTimeout(_timer);
      return result;
    } catch (err) {
      clearTimeout(_timer);
      throw err;
    }
  }

  _chunk(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
  }
}

module.exports = { ParallelScanner };
