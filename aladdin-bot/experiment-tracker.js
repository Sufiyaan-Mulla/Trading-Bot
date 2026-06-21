'use strict';
// ── experiment-tracker.js ─────────────────────────────────────────────────────
// Lightweight MLflow-compatible experiment tracker.
// Logs strategy runs, ML training sessions, and parameter changes to
// trade_logs/experiments.jsonl — same append-only JSONL format as audit-log.
//
// Compatible with MLflow UI if you point it at the same directory.
//
// Usage:
//   const tracker = require('./experiment-tracker');
//   const run = tracker.startRun('shadow-strategy', { rsiBuy: 42 });
//   run.logMetric('winRate', 0.63);
//   run.logMetric('profitFactor', 1.8);
//   run.end('PROMOTED');   // or 'REJECTED'
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const LOG  = path.join(__dirname, 'trade_logs', 'experiments.jsonl');

function _append(record) {
  setImmediate(() => {
    try {
      const dir = path.dirname(LOG);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Fix #47: Rotate experiment log at 100MB
    try {
      if (fs.existsSync(_path) && fs.statSync(_path).size > 100*1024*1024) {
        fs.renameSync(_path, _path+'.'+Date.now()); }
    } catch(_) {}
    fs.appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
    } catch (_) {}
  });
}

class Run {
  constructor(experimentName, params) {
    this.id         = experimentName + '_' + Date.now();
    this.experiment = experimentName;
    this.params     = params || {};
    this.metrics    = {};
    this.startedAt  = Date.now();
    this.status     = 'RUNNING';
    _append({ type: 'RUN_START', runId: this.id, experiment: this.experiment, params: this.params });
  }

  logMetric(name, value, step = null) {
    if (!this.metrics[name]) this.metrics[name] = [];
    const entry = { value, step, ts: Date.now() };
    this.metrics[name].push(entry);
    _append({ type: 'METRIC', runId: this.id, name, value, step });
    return this;
  }

  logParam(name, value) {
    this.params[name] = value;
    _append({ type: 'PARAM', runId: this.id, name, value });
    return this;
  }

  logArtifact(name, data) {
    _append({ type: 'ARTIFACT', runId: this.id, name, preview: JSON.stringify(data).slice(0, 200) });
    return this;
  }

  end(status = 'COMPLETED') {
    // Bug fix: end() returned undefined — callers doing 'const r = run.end()' then
    // accessing r.id or r.status would crash with TypeError.
    this.status = typeof status === 'string' ? status : 'COMPLETED';
    const duration = Date.now() - this.startedAt;
    const finalMetrics = Object.fromEntries(
      Object.entries(this.metrics).map(([k, v]) => {
        const val = v[v.length-1]?.value;
        // Guard NaN/Inf metrics — JSON.stringify converts them to null silently
        return [k, (typeof val === 'number' && isFinite(val)) ? val : null];
      })
    );
    _append({
      type: 'RUN_END', runId: this.id, experiment: this.experiment,
      status: this.status, duration, params: this.params, finalMetrics,
    });
    return { id: this.id, status: this.status, duration, finalMetrics };
  }
}

class ExperimentTracker {
  startRun(experimentName, params) {
    return new Run(experimentName, params);
  }

  // Read last N runs from log
  getHistory(experimentName, n = 20) {
    try {
      const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean);
      return lines
        .map(l => { try { return JSON.parse(l); } catch(_) { return null; } })
        .filter(r => r && r.type === 'RUN_END' && (!experimentName || r.experiment === experimentName))
        .slice(-n);
    } catch (_) { return []; }
  }

  // Get best run by metric
  getBest(experimentName, metric, higher = true) {
    const history = this.getHistory(experimentName, 100);
    if (!history.length) return null;
    return history.reduce((best, run) => {
      const v = run.finalMetrics?.[metric];
      if (v == null) return best;
      if (!best || (higher ? v > best.finalMetrics?.[metric] : v < best.finalMetrics?.[metric])) return run;
      return best;
    }, null);
  }
}

module.exports = new ExperimentTracker();
