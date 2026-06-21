'use strict';
// ── execution-metrics.js ──────────────────────────────────────────────────────
// Per-order latency timer and fill-quality scoring.
//
// Fixes: Execution partial — "Add latency measurement and execution quality analytics."
//
// Tracks for every order:
//   - Submission-to-fill latency (ms)
//   - Fill price vs expected price (slippage in pips and % of ATR)
//   - Fill ratio (partial fill detection)
//   - Rolling p50/p95/p99 latency
//   - Execution quality score 0–100 (100 = zero slippage, instant fill)
//
// Usage:
//   const { ExecutionMetrics } = require('./execution-metrics');
//   const em = new ExecutionMetrics();
//   const id = em.begin('EURUSD', 'BUY', expectedPrice, atr);
//   // ... place order ...
//   em.end(id, fillPrice, fillRatio);  // fillRatio 0–1 (1.0 = fully filled)
//   console.log(em.report());
// ─────────────────────────────────────────────────────────────────────────────

const HISTORY_SIZE = 200;
const PIP_SIZE     = 0.0001;   // 1 pip for most forex pairs

class ExecutionMetrics {
  constructor(opts = {}) {
    this.pipSize     = opts.pipSize  || PIP_SIZE;
    this._pending    = new Map();    // id → { asset, side, expectedPrice, atr, startMs }
    this._history    = [];           // completed order records
    this._nextId     = 1;
  }

  // ── Start timing an order submission ─────────────────────────────────────
  // Returns an id to pass to end()
  begin(asset, side, expectedPrice, atr) {
    const id = this._nextId++;
    this._pending.set(id, {
      id, asset, side,
      expectedPrice: expectedPrice || 0,
      atr:           atr           || expectedPrice * 0.001,
      startMs:       Date.now(),
    });
    return id;
  }

  // ── Record fill and compute metrics ───────────────────────────────────────
  // fillPrice:  actual fill price (0 if not filled)
  // fillRatio:  0–1, fraction of order filled (1.0 = complete fill)
  end(id, fillPrice, fillRatio = 1.0) {
    const pending = this._pending.get(id);
    if (!pending) return null;
    this._pending.delete(id);

    const latencyMs     = Date.now() - pending.startMs;
    // Bug fix: NaN/null fillPrice (e.g. exchange returned no fill price) produced
    // NaN slippagePips that corrupted all averages in report() permanently.
    const safeFill  = (typeof fillPrice === 'number' && isFinite(fillPrice) && fillPrice > 0)
      ? fillPrice : pending.expectedPrice;
    const slippagePx    = Math.abs(safeFill - pending.expectedPrice);
    const slippagePips  = slippagePx / this.pipSize;
    const slippageAtrPct= pending.atr > 0 ? slippagePx / pending.atr : 0;

    // Quality score: 100 = perfect (zero slippage, instant fill, full fill)
    // Deductions:
    //   latency  > 500ms  → -10 pts per 500ms extra
    //   slippage > 0.5pip → -15 pts per pip
    //   partial fill      → -20 * (1 - fillRatio)
    const latencyPenalty  = Math.max(0, (latencyMs - 500) / 500) * 10;
    const slippagePenalty = Math.max(0, slippagePips - 0.5) * 15;
    const fillPenalty     = (1 - Math.min(fillRatio, 1)) * 20;
    const score           = Math.max(0, Math.min(100, 100 - latencyPenalty - slippagePenalty - fillPenalty));

    const record = {
      id,
      asset:           pending.asset,
      side:            pending.side,
      expectedPrice:   pending.expectedPrice,
      fillPrice:       safeFill,
      fillRatio:       parseFloat(fillRatio.toFixed(4)),
      latencyMs,
      slippagePips:    parseFloat(slippagePips.toFixed(2)),
      slippageAtrPct:  parseFloat((slippageAtrPct * 100).toFixed(3)),
      qualityScore:    parseFloat(score.toFixed(1)),
      ts:              new Date().toISOString(),
    };

    this._history.push(record);
    if (this._history.length > HISTORY_SIZE) this._history.shift();

    return record;
  }

  // ── Report ────────────────────────────────────────────────────────────────
  report() {
    if (!this._history.length) return { count: 0 };

    const latencies = this._history.map(r => r.latencyMs).sort((a, b) => a - b);
    const scores    = this._history.map(r => r.qualityScore);
    const slippages = this._history.map(r => r.slippagePips);
    const fills     = this._history.map(r => r.fillRatio);

    const pct = (arr, p) => arr[Math.floor((p / 100) * (arr.length - 1))];
    const avg = arr => arr.reduce((s, v) => s + v, 0) / arr.length;

    return {
      count:          this._history.length,
      latency: {
        p50:  pct(latencies, 50),
        p95:  pct(latencies, 95),
        p99:  pct(latencies, 99),
        max:  Math.max(...latencies),
        avg:  parseFloat(avg(latencies).toFixed(1)),
      },
      slippage: {
        avgPips:  parseFloat(avg(slippages).toFixed(3)),
        maxPips:  parseFloat(Math.max(...slippages).toFixed(3)),
        p95Pips:  parseFloat(pct([...slippages].sort((a,b)=>a-b), 95).toFixed(3)),
      },
      fillRate: {
        avgRatio:    parseFloat(avg(fills).toFixed(3)),
        fullFillPct: parseFloat((fills.filter(f => f >= 0.999).length / fills.length * 100).toFixed(1)),
      },
      quality: {
        avgScore:    parseFloat(avg(scores).toFixed(1)),
        p50Score:    parseFloat(pct([...scores].sort((a,b)=>a-b), 50).toFixed(1)),
        grade: avg(scores) >= 90 ? 'A' : avg(scores) >= 75 ? 'B' : avg(scores) >= 60 ? 'C' : 'D',
      },
      recent: this._history.slice(-5),
    };
  }

  // ── Detect degraded execution (alert threshold) ───────────────────────────
  isExecDegraded(opts = {}) {
    const maxLatencyP95 = opts.maxLatencyP95 || 2000;  // ms
    const maxSlipPips   = opts.maxSlippagePips || 3;
    const minQuality    = opts.minQualityScore || 60;
    const rep = this.report();
    if (rep.count < 5) return { degraded: false, reason: 'insufficient data' };
    if (rep.latency.p95   > maxLatencyP95) return { degraded: true, reason: `p95 latency ${rep.latency.p95}ms > ${maxLatencyP95}ms` };
    if (rep.slippage.p95Pips > maxSlipPips) return { degraded: true, reason: `p95 slippage ${rep.slippage.p95Pips} pips > ${maxSlipPips}` };
    if (rep.quality.avgScore < minQuality)  return { degraded: true, reason: `avg quality ${rep.quality.avgScore} < ${minQuality}` };
    return { degraded: false };
  }
}

module.exports = { ExecutionMetrics };
