'use strict';
// ── Equity Curve Anomaly Detector ─────────────────────────────────────────────
// Monitors live equity vs its own rolling z-score to detect abnormal drawdowns
// or unexpected spikes that deviate from the bot's historical equity curve shape.
//
// A z-score > threshold means equity has moved more than N standard deviations
// from its rolling mean — a signal that something unusual is happening.

const { TRADING_CONFIG } = require('./trading-config');

class EquityAnomalyDetector {
  constructor({ log = console.log, send = null } = {}) {
    this.log  = log;
    this.send = send;
    this._window   = [];         // rolling equity samples
    this._windowSz = 30;         // 30-bar rolling window
    this._zThresh  = TRADING_CONFIG.equityAnomalyZScoreThresh || 2.5;
    this._enabled  = TRADING_CONFIG.equityAnomalyEnabled !== false;
    this._alertCooldownMs = 5 * 60 * 1000;  // max 1 alert per 5 min
    this._lastAlertAt = 0;
  }

  /**
   * Record current equity and check for anomaly.
   * @param {number} equity  current account equity / capital
   * @returns {{ anomaly: boolean, zScore: number }}
   */
  record(equity) {
    if (!this._enabled) return { anomaly: false, zScore: 0 };

    this._window.push(equity);
    if (this._window.length > this._windowSz) this._window.shift();

    if (this._window.length < 5) return { anomaly: false, zScore: 0 };  // not enough data

    const mean = this._window.reduce((a, b) => a + b, 0) / this._window.length;
    const variance = this._window.reduce((s, v) => s + (v - mean) ** 2, 0) / this._window.length;
    const std  = Math.sqrt(variance) || 1e-9;
    const zScore = Math.abs(equity - mean) / std;

    const anomaly = zScore > this._zThresh;

    if (anomaly) {
      const now = Date.now();
      if (now - this._lastAlertAt > this._alertCooldownMs) {
        this._lastAlertAt = now;
        const direction = equity < mean ? '📉 DROP' : '📈 SPIKE';
        const msg = `🚨 [EquityAnomaly] ${direction} detected — equity=${equity.toFixed(2)} z=${zScore.toFixed(2)} (thresh=${this._zThresh})`;
        this.log(msg);
        try { this.send?.(msg, 'halt'); } catch (_) {}
      }
    }

    return { anomaly, zScore: parseFloat(zScore.toFixed(3)) };
  }

  status() {
    if (this._window.length < 2) return { ready: false };
    const mean = this._window.reduce((a, b) => a + b, 0) / this._window.length;
    const variance = this._window.reduce((s, v) => s + (v - mean) ** 2, 0) / this._window.length;
    return {
      ready:    true,
      samples:  this._window.length,
      mean:     parseFloat(mean.toFixed(2)),
      std:      parseFloat(Math.sqrt(variance).toFixed(2)),
      zThresh:  this._zThresh,
      lastEquity: this._window[this._window.length - 1],
    };
  }
}

module.exports = { EquityAnomalyDetector };
