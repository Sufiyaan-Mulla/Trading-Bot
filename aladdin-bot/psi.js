'use strict';
// psi.js — Population Stability Index (PSI) for Feature Drift Detection
// PSI measures how much a feature distribution has shifted.
// PSI < 0.10 → stable   (no action)
// 0.10–0.25  → moderate (monitor)
// PSI > 0.25 → unstable (halt / retrain)
// Based on the insurance industry standard for model stability monitoring.

class PSIMonitor {
  constructor(opts = {}) {
    this.nBins       = opts.nBins    ?? 10;
    this.warnThresh  = opts.warnThresh  ?? 0.10;
    this.haltThresh  = opts.haltThresh  ?? 0.25;
    this._baselines  = {};  // { featureName: baselineHistogram }
  }

  // Build histogram from a feature value array
  _histogram(values, fixedEdges) {
    if (!values || !values.length) return null;
    const sorted = [...values].sort((a,b)=>a-b);
    const n = sorted.length;
    // Use fixed edges if provided (for comparing against baseline), else build from data
    const lo = fixedEdges ? fixedEdges[0] : sorted[0];
    const hi = fixedEdges ? fixedEdges[this.nBins] : sorted[n-1];
    const range = hi-lo || 1e-6;
    const edges = fixedEdges || Array.from({length:this.nBins+1},(_,i) => lo + i*range/this.nBins);
    edges[0]  -= 1e-9; edges[this.nBins] += 1e-9;
    const counts = new Array(this.nBins).fill(0);
    values.forEach(v => {
      let b = 0;
      while (b < this.nBins-1 && v > edges[b+1]) b++;
      counts[b]++;
    });
    return { edges, probs: counts.map(c=>Math.max(0.0001,c/values.length)) };
  }

  // Set baseline distribution for a feature
  setBaseline(featureName, values) {
    this._baselines[featureName] = this._histogram(values, null);
  }

  // Compute PSI against baseline
  compute(featureName, currentValues) {
    const baseline = this._baselines[featureName];
    if (!baseline) return { psi: 0, status: 'NO_BASELINE' };
    const current = this._histogram(currentValues, baseline.edges);
    if (!current) return { psi: 0, status: 'NO_DATA' };
    let psi = 0;
    for (let b = 0; b < this.nBins; b++) {
      const base = baseline.probs[b] || 0.0001;
      const cur  = current.probs[b]  || 0.0001;
      psi += (cur - base) * Math.log(cur / base);
    }
    const status = psi > this.haltThresh ? 'HALT' : psi > this.warnThresh ? 'WARN' : 'OK';
    return {
      psi:     parseFloat(psi.toFixed(4)),
      status,
      feature: featureName,
      shouldHalt:  status === 'HALT',
      shouldWarn:  status === 'WARN' || status === 'HALT',
    };
  }

  // Compute PSI for all features in a feature matrix
  computeAll(featureNames, currentMatrix) {
    return featureNames.map((name, i) => {
      const values = currentMatrix.map(row => row[i]).filter(v => isFinite(v));
      return this.compute(name, values);
    });
  }
}

module.exports = { PSIMonitor };
