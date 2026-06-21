'use strict';
// ── feature-store.js — 1.3: Feature Store with Importance Tracking + Decay ──
// Tracks per-feature predictive contribution over time.
// Automatically retires features whose rolling importance decays below threshold.
//
// FIXED: constructor now accepts both (featureNames, opts) and ({featureNames, ...opts})
// FIXED: added getActiveFeatures(), recordImportance(), applyDecay(), retireWeak(),
//        getRetiredFeatures(), status() to match the expected public API.

class FeatureStore {
  /**
   * @param {string[]|object} featureNamesOrOpts  Array of feature names OR config object
   * @param {object}          opts (only used when first arg is an array)
   * @param {number}   opts.decayRate        Exponential decay per update (default 0.95)
   * @param {number}   opts.retireThresh     Retire if importance < this fraction of max (default 0.05)
   * @param {number}   opts.minSamples       Min samples before retirement eligible (default 100)
   * @param {string}   opts.persistPath      Ignored (legacy compat)
   */
  constructor(featureNamesOrOpts, opts = {}) {
    // Support both call signatures:
    //   new FeatureStore(['a','b'], { decayRate: 0.9 })
    //   new FeatureStore({ featureNames: ['a','b'], decayRate: 0.9 })
    let names;
    if (Array.isArray(featureNamesOrOpts)) {
      names = featureNamesOrOpts;
    } else if (featureNamesOrOpts && typeof featureNamesOrOpts === 'object') {
      // Config-object form
      opts  = featureNamesOrOpts;
      names = Array.isArray(opts.featureNames) ? opts.featureNames : [];
    } else {
      names = [];
    }

    this.features     = [...names];
    this.decayRate    = opts.decayRate    ?? 0.95;
    this.retireThresh = opts.retireThresh ?? (opts.retireThreshold ?? 0.05);
    this.minSamples   = opts.minSamples   ?? 100;
    this._importance  = Object.fromEntries(names.map(f => [f, 1.0]));
    this._samples     = Object.fromEntries(names.map(f => [f, 0]));
    this._retired     = new Set();
    this._updateCount = 0;
  }

  // ── Single-feature importance record ───────────────────────────────────────
  // recordImportance(name, value): record one importance observation for one feature.
  recordImportance(name, value) {
    if (!this._importance.hasOwnProperty(name)) {
      this._importance[name] = value;
      this._samples[name]    = 1;
      this.features.push(name);
    } else {
      this._importance[name] = this.decayRate * this._importance[name] + (1 - this.decayRate) * Math.abs(value);
      this._samples[name]    = (this._samples[name] || 0) + 1;
    }
  }

  // ── Bulk importance update (existing API) ──────────────────────────────────
  update(importanceMap) {
    this._updateCount++;
    for (const [name, imp] of Object.entries(importanceMap)) {
      this.recordImportance(name, imp);
    }
    if (this._updateCount % 10 === 0) this._checkRetirements();
  }

  // ── Apply exponential decay to all importances ────────────────────────────
  applyDecay() {
    for (const f of this.features) {
      this._importance[f] = (this._importance[f] || 0) * this.decayRate;
    }
  }

  // ── Manual retirement trigger — returns list of newly retired features ─────
  retireWeak() {
    const before  = new Set(this._retired);
    this._checkRetirements();
    const newlyRetired = [];
    for (const f of this._retired) {
      if (!before.has(f)) newlyRetired.push(f);
    }
    return newlyRetired;
  }

  _checkRetirements() {
    const active = this.features.filter(f => !this._retired.has(f));
    if (active.length < 2) return;  // always keep at least 1 active feature
    const maxImp = Math.max(...active.map(f => this._importance[f] || 0));
    const thresh = maxImp * this.retireThresh;
    for (const f of active) {
      if ((this._samples[f] || 0) >= this.minSamples && (this._importance[f] || 0) < thresh) {
        this._retired.add(f);
      }
    }
  }

  // Reinstate a retired feature (e.g. after regime change)
  reinstate(featureName) { this._retired.delete(featureName); }

  // ── getActiveFeatures: returns [{name, importance, samples}] ──────────────
  getActiveFeatures() {
    return this.features
      .filter(f => !this._retired.has(f))
      .map(f => ({
        name:       f,
        importance: parseFloat((this._importance[f] || 0).toFixed(4)),
        samples:    this._samples[f] || 0,
      }));
  }

  // ── getRetiredFeatures: returns array of retired feature names ─────────────
  getRetiredFeatures() {
    return [...this._retired];
  }

  // ── Legacy: returns just names of active features ─────────────────────────
  activeFeatures() { return this.features.filter(f => !this._retired.has(f)); }

  // ── status(): summary object ───────────────────────────────────────────────
  status() {
    const active = this.getActiveFeatures();
    const top5   = [...active].sort((a, b) => b.importance - a.importance).slice(0, 5);
    return {
      activeCount:   active.length,
      retiredCount:  this._retired.size,
      totalFeatures: this.features.length,
      top5,
    };
  }

  // ── Sorted importance ranking (legacy) ────────────────────────────────────
  ranking() {
    return Object.entries(this._importance)
      .filter(([f]) => !this._retired.has(f))
      .sort(([,a],[,b]) => b - a)
      .map(([name, imp]) => ({
        name, importance: parseFloat(imp.toFixed(4)),
        samples: this._samples[name] || 0,
        retired: this._retired.has(name),
      }));
  }

  getImportance(featureName) { return this._importance[featureName] ?? 0; }
  isActive(featureName)      { return !this._retired.has(featureName); }
  retiredCount()             { return this._retired.size; }
}

module.exports = { FeatureStore };
