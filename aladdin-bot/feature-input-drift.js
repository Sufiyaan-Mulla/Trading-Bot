'use strict';
// ── feature-input-drift.js — A13: Detect covariate shift in ML input features
// If recent input distributions diverge from training distribution,
// model predictions are unreliable even if concept drift hasn't fired yet.

class FeatureInputDriftDetector {
  /**
   * @param {object} opts
   * @param {number} opts.windowSize    recent bars to compare (default 50)
   * @param {number} opts.referenceSize training reference window (default 200)
   * @param {number} opts.zThreshold   z-score to flag drift (default 2.5)
   * @param {Function} opts.log
   * @param {Function} opts.notify
   */
  constructor(opts = {}) {
    this._window    = opts.windowSize    || 50;
    this._refSize   = opts.referenceSize || 200;
    this._zThresh   = opts.zThreshold    || 2.5;
    this._log       = opts.log    || (m => console.log('[InputDrift]', m));
    this._notify    = opts.notify || null;
    this._reference = [];  // Array<float[]> — training feature vectors
    this._recent    = [];  // Array<float[]> — recent feature vectors
    this._driftCount = 0;
  }

  // Record a feature vector from a closed trade (training period)
  recordReference(features) {
    if (!Array.isArray(features)) return;
    this._reference.push(features);
    if (this._reference.length > this._refSize) this._reference.shift();
  }

  // Record a feature vector from a live inference tick
  recordRecent(features) {
    if (!Array.isArray(features)) return;
    this._recent.push(features);
    if (this._recent.length > this._window) this._recent.shift();
  }

  // Compute per-feature mean and std over a set of vectors
  _stats(vectors) {
    if (!vectors.length) return { mean: [], std: [] };
    const n   = vectors.length;
    const dim = vectors[0].length;
    const mean = new Array(dim).fill(0);
    for (const v of vectors) for (let i = 0; i < dim; i++) mean[i] += v[i] / n;
    const std = new Array(dim).fill(0);
    for (const v of vectors) for (let i = 0; i < dim; i++) std[i] += (v[i] - mean[i]) ** 2 / n;
    for (let i = 0; i < dim; i++) std[i] = Math.sqrt(std[i]);
    return { mean, std };
  }

  /**
   * Check if recent features have drifted from reference.
   * Returns { drifted: bool, driftedFeatures: number[], maxZ: number }
   */
  check() {
    if (this._reference.length < 20 || this._recent.length < 10) return { drifted: false };
    const refStats  = this._stats(this._reference);
    const recStats  = this._stats(this._recent);
    const dim       = refStats.mean.length;
    const drifted   = [];
    let maxZ        = 0;

    for (let i = 0; i < dim; i++) {
      const refStd = refStats.std[i] || 0.0001;
      const z = Math.abs(recStats.mean[i] - refStats.mean[i]) / refStd;
      if (z > this._zThresh) drifted.push({ featureIdx: i, z: parseFloat(z.toFixed(2)) });
      if (z > maxZ) maxZ = z;
    }

    if (drifted.length > 0) {
      this._driftCount++;
      const msg = `[A13] Input feature drift: ${drifted.length} features shifted >z${this._zThresh} (max z=${maxZ.toFixed(2)})`;
      this._log(msg);
      if (this._driftCount % 5 === 1 && this._notify) {
        try { this._notify(msg, 'risk'); } catch(_) {}
      }
    }
    return { drifted: drifted.length > 0, driftedFeatures: drifted, maxZ: parseFloat(maxZ.toFixed(2)) };
  }

  get referenceSize() { return this._reference.length; }
  get recentSize()    { return this._recent.length; }
  get driftCount()    { return this._driftCount; }
}

module.exports = { FeatureInputDriftDetector };
