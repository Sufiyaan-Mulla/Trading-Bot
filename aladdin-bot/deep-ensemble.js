'use strict';
// deep-ensemble.js — Deep Ensemble Uncertainty via Bootstrap Bagging
// Trains N GBMs on different random 80% subsets of the data.
// Prediction uncertainty = variance across ensemble members.
// A wide prediction spread → low confidence → reduce position size.
// Based on Lakshminarayanan et al. (2017) "Simple and Scalable Predictive Uncertainty".

class DeepEnsemble {
  constructor(opts = {}) {
    this.nModels    = opts.nModels    ?? 5;
    this.sampleRate = opts.sampleRate ?? 0.80;  // 80% bootstrap per model
    this._models    = [];
    this.trained    = false;
  }

  // Train N GBMs on bootstrap subsets
  train(X, y, GBMClass) {
    if (!X || X.length < 20 || !GBMClass) return false;
    this._models = [];
    for (let i = 0; i < this.nModels; i++) {
      const n       = Math.floor(X.length * this.sampleRate);
      const indices = Array.from({length:n}, () => Math.floor(Math.random()*X.length));
      const Xb      = indices.map(j=>X[j]);
      const yb      = indices.map(j=>y[j]);
      const gbm     = new GBMClass(80, 3, 0.1, 0.8);
      try { gbm.train(Xb, yb); this._models.push(gbm); } catch(_) {}
    }
    this.trained = this._models.length >= Math.ceil(this.nModels/2);
    return this.trained;
  }

  // Predict: returns mean probability + variance across ensemble
  predict(features) {
    if (!this.trained || !this._models.length) return { prob:0.5, variance:0.25, uncertainty:'HIGH' };
    const preds = this._models.map(m => {
      try { return m.predict([features])[0] || 0.5; } catch(_) { return 0.5; }
    });
    const mean     = preds.reduce((s,v)=>s+v,0)/preds.length;
    const variance = preds.reduce((s,v)=>s+(v-mean)**2,0)/preds.length;
    const stdDev   = Math.sqrt(variance);
    return {
      prob:        parseFloat(mean.toFixed(4)),
      variance:    parseFloat(variance.toFixed(4)),
      stdDev:      parseFloat(stdDev.toFixed(4)),
      uncertainty: stdDev > 0.15 ? 'HIGH' : stdDev > 0.08 ? 'MEDIUM' : 'LOW',
      // Size multiplier: reduce when ensemble disagrees
      sizeMult:    Math.max(0.3, 1 - stdDev * 3),
    };
  }

  get memberCount() { return this._models.length; }
}

module.exports = { DeepEnsemble };
