'use strict';
// ── Feature Importance Tracker ────────────────────────────────────────────────
// Tracks which features most influenced ML confidence predictions.
// Uses a permutation-approximation: for each feature, measures how much
// confidence changes when that feature is zeroed (ablation proxy).
// Logs top-N features every N calls so you can see what the model relies on.

const { TRADING_CONFIG } = require('./trading-config');

class FeatureImportanceTracker {
  constructor({ log = console.log } = {}) {
    this.log = log;
    this._callCount = 0;
    // Running sum of |contribution| per feature name
    this._featureSums  = {};
    this._featureCounts = {};
    this._lastTopFeatures = [];
    this._logEvery = TRADING_CONFIG.featureImportanceEnabled
      ? (TRADING_CONFIG.featureImportanceLogEvery || 50)
      : Infinity;
  }

  /**
   * Record one ML prediction.
   * @param {object} features  – key/value feature map passed to ML
   * @param {number} confidence – resulting confidence score (0–1)
   * @param {Function} scorer  – (features) => confidence, for ablation
   */
  record(features, confidence, scorer = null) {
    if (!TRADING_CONFIG.featureImportanceEnabled) return;
    this._callCount++;

    if (typeof features !== 'object' || features === null) return;

    // Ablation-based importance: zero each feature, measure delta
    if (typeof scorer === 'function') {
      for (const [key, val] of Object.entries(features)) {
        if (typeof val !== 'number') continue;
        const ablated = { ...features, [key]: 0 };
        let delta = 0;
        try {
          const ablConf = scorer(ablated);
          delta = Math.abs(confidence - ablConf);
        } catch (_) { delta = 0; }
        this._featureSums[key]   = (this._featureSums[key]   || 0) + delta;
        this._featureCounts[key] = (this._featureCounts[key] || 0) + 1;
      }
    } else {
      // No scorer: use |feature value * confidence| as proxy weight
      for (const [key, val] of Object.entries(features)) {
        if (typeof val !== 'number') continue;
        const proxy = Math.abs(val * confidence);
        this._featureSums[key]   = (this._featureSums[key]   || 0) + proxy;
        this._featureCounts[key] = (this._featureCounts[key] || 0) + 1;
      }
    }

    if (this._callCount % this._logEvery === 0) {
      this._logTopFeatures();
    }
  }

  /** Returns sorted array of { feature, avgImportance } */
  getTopFeatures(n = 10) {
    const ranked = Object.entries(this._featureSums)
      .map(([feature, sum]) => ({
        feature,
        avgImportance: sum / (this._featureCounts[feature] || 1),
      }))
      .sort((a, b) => b.avgImportance - a.avgImportance)
      .slice(0, n);
    this._lastTopFeatures = ranked;
    return ranked;
  }

  _logTopFeatures() {
    const top = this.getTopFeatures(8);
    if (!top.length) return;
    const lines = top.map((f, i) =>
      `  ${i + 1}. ${f.feature.padEnd(20)} ${f.avgImportance.toFixed(4)}`
    ).join('\n');
    this.log(`📊 [FeatureImportance] Top features after ${this._callCount} calls:\n${lines}`);
  }

  /** Reset accumulators (e.g. after model retrain) */
  reset() {
    this._featureSums   = {};
    this._featureCounts = {};
    this._callCount     = 0;
    this._lastTopFeatures = [];
  }

  summary() {
    return {
      callCount: this._callCount,
      topFeatures: this.getTopFeatures(10),
    };
  }
}

module.exports = { FeatureImportanceTracker };
