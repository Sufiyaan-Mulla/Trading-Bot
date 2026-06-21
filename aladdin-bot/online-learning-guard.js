'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  OnlineLearningGuard  —  Feature #21
//
//  Wraps the weight-update step of ml-confidence.js / ml-improvements.js.
//  Before applying any weight delta it checks:
//    1. Per-update cap: |Δw_i| ≤ maxWeightDelta  (default 0.05)
//    2. Magnitude cap:  ‖Δw‖₂ / ‖w‖₂ ≤ maxNormChange (default 0.10)
//
//  If either check fails, the update is clipped (not rejected entirely) so
//  learning continues but cannot blow up weight norms in a single step.
//
//  Usage:
//    const guard = new OnlineLearningGuard();
//    const safeDeltas = guard.clip(currentWeights, proposedDeltas);
//    applyWeights(currentWeights, safeDeltas);
// ─────────────────────────────────────────────────────────────────────────────

class OnlineLearningGuard {
  /**
   * @param {object} opts
   * @param {number} opts.maxWeightDelta   Per-element clip threshold (default 0.05)
   * @param {number} opts.maxNormChange    Max relative L2 norm change (default 0.10)
   * @param {Function} [opts.log]
   * @param {Function} [opts.notify]       fn(msg) → Telegram
   */
  constructor(opts = {}) {
    this.maxWeightDelta = opts.maxWeightDelta ?? 0.05;
    this.maxNormChange  = opts.maxNormChange  ?? 0.10;
    this._log           = opts.log    || ((m) => console.log('[OLGuard] ' + m));
    this._notify        = opts.notify || null;
    this._clipCount     = 0;
  }

  /**
   * Clip proposed weight deltas so neither per-element nor norm constraints
   * are violated.
   *
   * @param {number[]} weights  Current weight vector
   * @param {number[]} deltas   Proposed updates (same length)
   * @returns {number[]} Safe (clipped) deltas
   */
  clip(weights, deltas) {
    if (!Array.isArray(weights) || !Array.isArray(deltas)) return deltas;
    if (weights.length !== deltas.length) return deltas;

    // 1. Per-element clip
    let clipped = false;
    const clippedDeltas = deltas.map(d => {
      // Bug fix: NaN/Inf deltas (from NaN loss, bad gradients) were passed through
      // silently, corrupting weights irreversibly. Clamp them to 0 to skip the update.
      if (!isFinite(d)) { clipped = true; return 0; }
      if (Math.abs(d) > this.maxWeightDelta) {
        clipped = true;
        return Math.sign(d) * this.maxWeightDelta;
      }
      return d;
    });

    // 2. Norm-based clip
    const wNorm = Math.sqrt(weights.reduce((s, w) => s + w * w, 0)) || 1;
    const dNorm = Math.sqrt(clippedDeltas.reduce((s, d) => s + d * d, 0));
    const maxAllowed = this.maxNormChange * wNorm;

    let normClipped = false;
    let finalDeltas = clippedDeltas;
    if (dNorm > maxAllowed && dNorm > 0) {
      const scale = maxAllowed / dNorm;
      finalDeltas = clippedDeltas.map(d => d * scale);
      normClipped = true;
    }

    if (clipped || normClipped) {
      this._clipCount++;
      const msg = `[OLGuard] Update clipped (elem:${clipped}, norm:${normClipped}) — clip #${this._clipCount}`;
      this._log(msg);
      if (this._clipCount % 100 === 0 && this._notify) {
        try { this._notify(`⚠️ OL Guard: ${this._clipCount} updates clipped — check learning rate`, 'risk'); } catch(_) {}
      }
    }

    return finalDeltas;
  }

  /**
   * Apply clipped deltas to a weight array in-place.
   * Convenience wrapper: guard.applyUpdate(weights, deltas)
   */
  applyUpdate(weights, deltas) {
    const safe = this.clip(weights, deltas);
    for (let i = 0; i < weights.length; i++) weights[i] += safe[i];
    return weights;
  }

  stats() {
    return { clipCount: this._clipCount, maxWeightDelta: this.maxWeightDelta, maxNormChange: this.maxNormChange };
  }
}

module.exports = { OnlineLearningGuard };
