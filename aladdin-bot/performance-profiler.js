'use strict';
// ── performance-profiler.js ───────────────────────────────────────────────────
// Benchmarks startup time and per-tick loop execution.
//
// Tracks:
//   - Startup phase timings (config load, indicator warm-up, exchange connect)
//   - Per-tick execution time (indicator calc, ML inference, order submission)
//   - Rolling p50/p95/p99 latency for each labelled span
//   - Slow-tick alerts when a tick exceeds a budget (default 5 s)
//
// Usage:
//   const { Profiler } = require('./performance-profiler');
//   const profiler = new Profiler();
//
//   // Startup:
//   profiler.startupBegin('config_load');
//   ... load config ...
//   profiler.startupEnd('config_load');
//
//   // Per-tick:
//   const tick = profiler.tickBegin();
//   ... run strategy ...
//   profiler.tickEnd(tick, { indicator: 12, ml: 45, order: 8 });
//
//   // Query:
//   console.log(profiler.report());
// ─────────────────────────────────────────────────────────────────────────────

const SLOW_TICK_MS = parseInt(process.env.SLOW_TICK_MS || '5000');
const MAX_SAMPLES  = 500;   // max count-based rolling window per span
const WINDOW_MS    = 60 * 60 * 1000;  // 1-hour time-based rolling window

class Profiler {
  constructor(opts = {}) {
    this.slowTickMs  = opts.slowTickMs || SLOW_TICK_MS;
    this._startup    = {};   // phase → { start, durationMs }
    this._spans      = {};   // spanName → [durationMs, ...]
    this._ticks      = [];   // [{ durationMs, spans, ts }]
    this._pendingStartup = {};
    this._processStart   = Date.now();
  }

  // ── Startup phase timing ──────────────────────────────────────────────────
  startupBegin(phase) {
    this._pendingStartup[phase] = Number(process.hrtime.bigint()) / 1e6;  // ms with sub-ms precision
  }

  startupEnd(phase) {
    const start = this._pendingStartup[phase];
    if (!start) return;
    const durationMs = Number(process.hrtime.bigint()) / 1e6 - start;
    this._startup[phase] = { durationMs };
    delete this._pendingStartup[phase];
    return durationMs;
  }

  // Measure a synchronous startup block
  startupMeasure(phase, fn) {
    this.startupBegin(phase);
    try { const r = fn(); return r; }
    finally { this.startupEnd(phase); }
  }

  // Measure an async startup block
  async startupMeasureAsync(phase, fn) {
    this.startupBegin(phase);
    try { return await fn(); }
    finally { this.startupEnd(phase); }
  }

  // ── Per-tick profiling ────────────────────────────────────────────────────
  tickBegin() {
    return { _start: Number(process.hrtime.bigint()) / 1e6, _spans: {} };
  }

  // Begin a named sub-span within a tick
  spanBegin(tick, name) {
    tick._spans[name] = { _start: Number(process.hrtime.bigint()) / 1e6 };
  }

  spanEnd(tick, name) {
    const s = tick._spans[name];
    if (!s) return;
    s.durationMs = Number(process.hrtime.bigint()) / 1e6 - s._start;
    return s.durationMs;
  }

  // Convenience: measure a sync span in a tick
  spanMeasure(tick, name, fn) {
    this.spanBegin(tick, name);
    try { return fn(); } finally { this.spanEnd(tick, name); }
  }

  tickEnd(tick, extraSpans = {}) {
    const total = Number(process.hrtime.bigint()) / 1e6 - tick._start;
    const spans = {};

    // Merge explicit sub-spans from tickEnd call
    for (const [name, ms] of Object.entries(extraSpans)) {
      spans[name] = ms;
      this._recordSpan(name, ms);
    }
    // Merge spans opened via spanBegin/spanEnd
    for (const [name, s] of Object.entries(tick._spans)) {
      if (s.durationMs != null) {
        spans[name] = s.durationMs;
        this._recordSpan(name, s.durationMs);
      }
    }

    this._recordSpan('tick_total', total);
    const entry = { durationMs: total, spans, ts: Date.now(), windowMs: Date.now() };
    this._ticks.push(entry);
    if (this._ticks.length > MAX_SAMPLES) this._ticks.shift();

    if (total > this.slowTickMs) {
      const top = Object.entries(spans).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([k, v]) => `${k}=${v}ms`).join(', ');
      console.warn(`[Profiler] ⚠ SLOW TICK ${total}ms (budget=${this.slowTickMs}ms) — ${top}`);
    }

    return entry;
  }

  // ── Report ────────────────────────────────────────────────────────────────
  report() {
    const uptime = Date.now() - this._processStart;
    return {
      uptimeMs: uptime,
      startup: this._startupReport(),
      spans:   this._spansReport(),
      ticks:   this._ticksReport(),
    };
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _recordSpan(name, ms) {
    if (!this._spans[name]) this._spans[name] = [];
    this._spans[name].push(ms);
    if (this._spans[name].length > MAX_SAMPLES) this._spans[name].shift();
  }

  _percentile(arr, p) {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx    = Math.floor((p / 100) * (sorted.length - 1));
    return sorted[idx];
  }

  _startupReport() {
    const report = {};
    let totalMs = 0;
    for (const [phase, data] of Object.entries(this._startup)) {
      report[phase] = data.durationMs;
      totalMs += data.durationMs;
    }
    report._total = totalMs;
    return report;
  }

  _spansReport() {
    const report = {};
    for (const [name, samples] of Object.entries(this._spans)) {
      report[name] = {
        count:  samples.length,
        p50:    this._percentile(samples, 50),
        p95:    this._percentile(samples, 95),
        p99:    this._percentile(samples, 99),
        max:    Math.max(...samples),
        avg:    parseFloat((samples.reduce((s, v) => s + v, 0) / samples.length).toFixed(1)),
      };
    }
    return report;
  }

  _pruneOldTicks() {
    const cutoff = Date.now() - WINDOW_MS;
    this._ticks = this._ticks.filter(t => t.ts >= cutoff);
  }

  _ticksReport() {
    this._pruneOldTicks();
    if (!this._ticks.length) return { count: 0 };
    const durations = this._ticks.map(t => t.durationMs);
    const slowTicks = durations.filter(d => d > this.slowTickMs).length;
    return {
      count:     this._ticks.length,
      p50:       this._percentile(durations, 50),
      p95:       this._percentile(durations, 95),
      p99:       this._percentile(durations, 99),
      max:       Math.max(...durations),
      avg:       parseFloat((durations.reduce((s, v) => s + v, 0) / durations.length).toFixed(1)),
      slowTicks,
      slowPct:   parseFloat((slowTicks / durations.length * 100).toFixed(1)),
    };
  }
}

// Singleton for easy global access
let _instance = null;
function getProfiler() {
  if (!_instance) _instance = new Profiler();
  return _instance;
}

module.exports = { Profiler, getProfiler };
