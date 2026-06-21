'use strict';
// ── Overfitting Guard ─────────────────────────────────────────────────────────
// Monitors train vs validation accuracy after each ML training run.
// If the gap exceeds the configured threshold, logs a warning and optionally
// halts live trading until the model is reviewed / retrained with regularisation.

const { TRADING_CONFIG } = require('./trading-config');

class OverfitGuard {
  constructor({ log = console.log } = {}) {
    this.log = log;
    this._history  = [];   // { trainAcc, valAcc, gap, ts }
    this._halted   = false;
    this._maxGap   = TRADING_CONFIG.overfitMaxGap || 0.15;
  }

  /**
   * Evaluate a training run.
   * @param {number} trainAcc  0–1 (e.g. 0.82)
   * @param {number} valAcc    0–1 (e.g. 0.64)
   * @returns {{ overfit: boolean, gap: number }}
   */
  evaluate(trainAcc, valAcc) {
    if (!TRADING_CONFIG.overfitGuardEnabled) return { overfit: false, gap: 0 };
    // FIX: read maxGap from config every call to respect hot-reload changes
    const maxGap  = TRADING_CONFIG.overfitMaxGap || this._maxGap;
    const gap     = trainAcc - valAcc;
    const overfit = gap > maxGap;
    const entry   = { trainAcc, valAcc, gap: parseFloat(gap.toFixed(4)), ts: Date.now() };
    this._history.push(entry);
    if (this._history.length > 100) this._history.shift();

    if (overfit) {
      this._halted = true;
      this.log(
        `🚨 [OverfitGuard] Overfitting detected — trainAcc=${(trainAcc*100).toFixed(1)}% ` +
        `valAcc=${(valAcc*100).toFixed(1)}% gap=${(gap*100).toFixed(1)}% (max=${(maxGap*100).toFixed(0)}%). ` +
        `ML signals SUSPENDED until model is retrained with regularisation.`
      );
    } else {
      if (this._halted) {
        this._halted = false;
        this.log(`✅ [OverfitGuard] Overfitting resolved — gap=${(gap*100).toFixed(1)}%. ML signals restored.`);
      } else {
        this.log(`✅ [OverfitGuard] Train=${(trainAcc*100).toFixed(1)}% Val=${(valAcc*100).toFixed(1)}% gap=${(gap*100).toFixed(1)}% — OK`);
      }
    }

    return { overfit, gap };
  }

  /** Returns true when ML signals should be suppressed due to overfitting */
  get isHalted() {
    return this._halted;
  }

  /** Manually clear the halt (e.g. after retraining with dropout / L2) */
  clear() {
    this._halted = false;
    this.log('✅ [OverfitGuard] Halt manually cleared');
  }

  summary() {
    return {
      halted:  this._halted,
      maxGap:  this._maxGap,
      history: this._history.slice(-10),
    };
  }
}

module.exports = { OverfitGuard };
