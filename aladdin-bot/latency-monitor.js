'use strict';
// ── API Latency Monitor ───────────────────────────────────────────────────────
// Wraps async functions and records call durations.
// Maintains a rolling window and alerts when p95 or any single call exceeds thresholds.

const { TRADING_CONFIG } = require('./trading-config');

class LatencyMonitor {
  constructor({ log = console.log, send = null } = {}) {
    this.log    = log;
    this.send   = send;  // optional telegram/alert sender
    this._samples = {};  // label → number[]
    this._windowSize = TRADING_CONFIG.latencyWindowSize || 20;
    this._alertMs    = TRADING_CONFIG.latencyAlertMs    || 3000;
    this._enabled    = TRADING_CONFIG.latencyMonitorEnabled !== false;
  }

  /**
   * Wrap an async function call and record its duration.
   * @param {string} label      – name shown in logs (e.g. 'OANDA:price')
   * @param {Function} fn       – async function to call
   * @param  {...any} args      – arguments passed to fn
   * @returns result of fn(args)
   */
  async track(label, fn, ...args) {
    if (!this._enabled) return fn(...args);

    const t0 = Date.now();
    let result;
    try {
      result = await fn(...args);
    } finally {
      const durationMs = Date.now() - t0;
      this._record(label, durationMs);
    }
    return result;
  }

  _record(label, ms) {
    if (!this._samples[label]) this._samples[label] = [];
    this._samples[label].push(ms);
    if (this._samples[label].length > this._windowSize) {
      this._samples[label].shift();
    }

    if (ms > this._alertMs) {
      const msg = `⏱️ [LatencyMonitor] ${label} took ${ms}ms — exceeds ${this._alertMs}ms threshold`;
      this.log(msg);
      try { this.send?.(msg, 'warn'); } catch (_) {}
    }
  }

  /** p95 latency for a label in ms, or null if no data */
  p95(label) {
    const s = this._samples[label];
    if (!s || !s.length) return null;
    const sorted = [...s].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return sorted[Math.min(idx, sorted.length - 1)];
  }

  /** Average latency for a label */
  avg(label) {
    const s = this._samples[label];
    if (!s || !s.length) return null;
    return s.reduce((a, b) => a + b, 0) / s.length;
  }

  /** All labels tracked */
  get labels() { return Object.keys(this._samples); }

  /** Full summary for health endpoint / logging */
  summary() {
    const result = {};
    for (const label of this.labels) {
      result[label] = {
        avg:    Math.round(this.avg(label)),
        p95:    Math.round(this.p95(label)),
        samples: this._samples[label].length,
      };
    }
    return result;
  }
}

module.exports = { LatencyMonitor };
