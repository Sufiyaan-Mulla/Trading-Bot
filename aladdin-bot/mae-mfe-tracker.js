'use strict';
// ── MAE / MFE Tracker ─────────────────────────────────────────────────────────
// MAE = Maximum Adverse Excursion: how far price moved against you before exit
// MFE = Maximum Favorable Excursion: how far price moved in your favor before exit
//
// These metrics reveal:
//   - If MAE > SL distance → your SL is too wide (you're giving back too much)
//   - If MFE >> actual exit → you're exiting too early (leaving profit on table)
//   - MAE distribution shows optimal SL placement
//   - MFE distribution shows optimal TP placement
//
// Usage: call update(price) on every tick while position is open.
//        call close(exitPrice) when position closes to record final metrics.

class MAEMFETracker {
  constructor({ log = console.log } = {}) {
    this.log    = log;
    this._active = null;    // current open trade tracking
    this._history = [];     // completed trade MAE/MFE records
  }

  /**
   * Open tracking for a new position.
   * @param {string} asset
   * @param {'long'|'short'} side
   * @param {number} entryPrice
   * @param {number} stopLoss
   * @param {number} takeProfit
   */
  open(asset, side, entryPrice, stopLoss, takeProfit) {
    // FIX 16: warn and auto-close stale tracking if open() called while already active
    if (this._active) {
      this.log(`⚠️ [MAE/MFE] open() called while already tracking ${this._active.asset} — auto-closing stale record`);
      this.close(this._active.entryPrice, 'stale_overwrite');
    }
    this._active = {
      asset, side, entryPrice, stopLoss, takeProfit,
      openedAt: Date.now(),
      mae: 0,       // max adverse excursion in price units
      mfe: 0,       // max favorable excursion in price units
      maePct: 0,    // as % of entry price
      mfePct: 0,
      ticks: 0,
    };
  }

  /**
   * Update MAE/MFE with latest price tick.
   * @param {number} price current market price
   */
  update(price) {
    if (!this._active) return;
    const t = this._active;
    t.ticks++;

    const excursion = t.side === 'long'
      ? price - t.entryPrice    // positive = favorable, negative = adverse
      : t.entryPrice - price;   // invert for short

    if (excursion < -t.mae) t.mae = -excursion;  // store as positive number
    if (excursion > t.mfe)  t.mfe = excursion;

    t.maePct = t.entryPrice > 0 ? (t.mae / t.entryPrice) * 100 : 0;
    t.mfePct = t.entryPrice > 0 ? (t.mfe / t.entryPrice) * 100 : 0;
  }

  /**
   * Close tracking and record the completed trade.
   * @param {number} exitPrice
   * @param {string} [reason]
   * @returns {object} MAE/MFE record for this trade
   */
  close(exitPrice, reason = '') {
    if (!this._active) return null;
    const t = this._active;
    this._active = null;

    const pnlPct = t.side === 'long'
      ? (exitPrice - t.entryPrice) / t.entryPrice * 100
      : (t.entryPrice - exitPrice) / t.entryPrice * 100;

    const slDistancePct = t.entryPrice > 0 && t.stopLoss
      ? Math.abs(t.entryPrice - t.stopLoss) / t.entryPrice * 100 : null;
    const tpDistancePct = t.entryPrice > 0 && t.takeProfit
      ? Math.abs(t.takeProfit - t.entryPrice) / t.entryPrice * 100 : null;

    // Efficiency: how much of MFE was captured
    const captureRatio = t.mfe > 0 ? Math.max(0, pnlPct) / t.mfePct : null;

    const record = {
      asset:          t.asset,
      side:           t.side,
      entryPrice:     t.entryPrice,
      exitPrice,
      reason,
      durationMs:     Date.now() - t.openedAt,
      ticks:          t.ticks,
      mae:            parseFloat(t.mae.toFixed(6)),
      mfe:            parseFloat(t.mfe.toFixed(6)),
      maePct:         parseFloat(t.maePct.toFixed(4)),
      mfePct:         parseFloat(t.mfePct.toFixed(4)),
      pnlPct:         parseFloat(pnlPct.toFixed(4)),
      slDistancePct,
      tpDistancePct,
      captureRatio:   captureRatio !== null ? parseFloat(captureRatio.toFixed(3)) : null,
      maeExceededSL:  slDistancePct !== null ? t.maePct > slDistancePct : null,
      ts:             Date.now(),
    };

    this._history.push(record);
    if (this._history.length > 500) this._history.shift();

    // Log insight if MAE is extremely large or capture is poor
    if (record.maeExceededSL) {
      this.log(`📊 [MAE/MFE] ${t.asset} ${t.side}: MAE ${t.maePct.toFixed(3)}% EXCEEDED SL distance ${slDistancePct?.toFixed(3)}% — SL may be too wide`);
    }
    if (record.captureRatio !== null && record.captureRatio < 0.3 && t.mfe > 0) {
      this.log(`📊 [MAE/MFE] ${t.asset} ${t.side}: captured only ${(record.captureRatio * 100).toFixed(0)}% of MFE — consider wider TP`);
    }

    return record;
  }

  /** Aggregate stats across all completed trades */
  summary(n = null) {
    const h = n ? this._history.slice(-n) : this._history;
    if (!h.length) return { trades: 0 };

    const avg = key => h.reduce((s, t) => s + (t[key] || 0), 0) / h.length;
    const wins  = h.filter(t => t.pnlPct > 0);
    const losses = h.filter(t => t.pnlPct <= 0);

    return {
      trades:             h.length,
      avgMAEPct:          parseFloat(avg('maePct').toFixed(4)),
      avgMFEPct:          parseFloat(avg('mfePct').toFixed(4)),
      avgPnlPct:          parseFloat(avg('pnlPct').toFixed(4)),
      // FIX: captureRatio is null when mfe=0 — exclude nulls from average
      avgCaptureRatio:    (() => { const v = h.filter(t => t.captureRatio !== null); return v.length ? parseFloat((v.reduce((s,t)=>s+t.captureRatio,0)/v.length).toFixed(3)) : null; })(),
      avgWinMAEPct:       wins.length  ? parseFloat((wins.reduce((s,t)=>s+t.maePct,0)/wins.length).toFixed(4))  : null,
      avgLossMAEPct:      losses.length? parseFloat((losses.reduce((s,t)=>s+t.maePct,0)/losses.length).toFixed(4)): null,
      avgWinMFEPct:       wins.length  ? parseFloat((wins.reduce((s,t)=>s+t.mfePct,0)/wins.length).toFixed(4))  : null,
      maeExceededSLCount: h.filter(t => t.maeExceededSL).length,
      optimalSLPct:       this._optimalSL(h),
      optimalTPPct:       this._optimalTP(h),
    };
  }

  /** Suggests SL distance: 95th percentile of winning-trade MAE */
  _optimalSL(h) {
    const wins = h.filter(t => t.pnlPct > 0 && t.maePct > 0);
    if (wins.length < 5) return null;
    const sorted = wins.map(t => t.maePct).sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return parseFloat(sorted[Math.min(idx, sorted.length - 1)].toFixed(4));
  }

  /** Suggests TP distance: median MFE of winning trades */
  _optimalTP(h) {
    const wins = h.filter(t => t.pnlPct > 0 && t.mfePct > 0);
    if (wins.length < 5) return null;
    const sorted = wins.map(t => t.mfePct).sort((a, b) => a - b);
    return parseFloat(sorted[Math.floor(sorted.length / 2)].toFixed(4));
  }

  get active() { return this._active; }
  get history() { return this._history; }
}

module.exports = { MAEMFETracker };
