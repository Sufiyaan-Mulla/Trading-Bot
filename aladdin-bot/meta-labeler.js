'use strict';

// Bug fix: atomic state write — prevents corrupt files on crash mid-write
function _atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp';
  require('fs').writeFileSync(tmp, content, 'utf8');
  require('fs').renameSync(tmp, filePath);
}

// ── meta-labeler.js ───────────────────────────────────────────────────────────
// Meta-labeling filter for low-quality trading signals.
//
// Concept (Lopez de Prado, "Advances in Financial ML"):
//   The primary model generates BUY/SELL/HOLD signals.
//   The meta-model learns WHEN the primary model's signals actually lead to
//   profitable outcomes vs when they fail.  It adds a binary label:
//     1 = primary signal is likely profitable (TAKE IT)
//     0 = primary signal is likely to fail    (SKIP IT)
//
// Implementation:
//   Uses logistic regression on these features extracted from context:
//     - Primary signal confidence
//     - Regime alignment (M5/H1/D1)
//     - Spread relative to ATR
//     - Time-of-day session weight
//     - Recent win rate (rolling 20 trades)
//     - ATR percentile (volatility rank)
//     - News proximity flag
//
//   Weights are trained online via stochastic gradient descent after each
//   closed trade.  Cold start: uniform weights (pass all signals above threshold).
//
// Usage:
//   const { MetaLabeler } = require('./meta-labeler');
//   const meta = new MetaLabeler();
//   // On signal:
//   const { accept, probability } = meta.evaluate(features);
//   if (!accept) return HOLD;
//   // After trade closes:
//   meta.update(features, outcome); // outcome: 1 = win, 0 = loss
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

const WEIGHTS_FILE   = path.join(__dirname, 'trade_logs', 'meta_weights.json');
const LEARNING_RATE  = 0.05;
const ACCEPT_THRESH  = 0.50;   // meta-probability ≥ this → accept signal
const MIN_SAMPLES    = 20;     // below this, defer to raw confidence only

class MetaLabeler {
  constructor(opts = {}) {
    this.threshold    = opts.threshold    || ACCEPT_THRESH;
    this.lr           = opts.learningRate || LEARNING_RATE;
    this.minSamples   = opts.minSamples   || MIN_SAMPLES;
    this._samples     = 0;
    this._weights     = this._load();
    this._recentWins  = [];   // rolling window for win-rate feature
    this._history     = [];   // [{ features, outcome }]
  }


  _validateFeatures(f) {
    const required = ['confidence','regimeScore','spreadAtrRatio','sessionWeight','atrPercentile','newsProximity'];
    const issues   = [];
    for (const k of required) {
      if (f[k] === undefined || f[k] === null) { issues.push(k + ' missing'); f[k] = 0.5; }
      if (!isFinite(f[k])) { issues.push(k + ' is NaN/Inf'); f[k] = 0.5; }
    }
    if (issues.length) console.warn('[MetaLabeler] Feature issues (defaulted to 0.5):', issues.join(', '));
    return f;
  }

  // ── Evaluate a signal — should we take it? ────────────────────────────────
  // features: {
  //   confidence:      0–100  (primary model confidence)
  //   regimeScore:     0–1    (fraction of timeframes aligned)
  //   spreadAtrRatio:  0–5    (spread / ATR — lower is better)
  //   sessionWeight:   0–1.2  (from SESSION_STRATEGY_WEIGHTS)
  //   atrPercentile:  0–1    (current ATR vs 100-bar history)
  //   newsProximity:  0 or 1  (1 = within 30 min of high-impact event)
  // }
  // Returns { accept: bool, probability: 0–1, features, reason }
  evaluate(features) {
    this._validateFeatures(features);
    const f   = this._extractFeatureVector(features);
    const p   = this._sigmoid(this._dot(this._weights, f));
    const accept = this._samples < this.minSamples
      ? features.confidence >= 55            // cold start: use raw confidence
      : p >= this.threshold;

    return {
      accept,
      probability: parseFloat(p.toFixed(4)),
      coldStart:   this._samples < this.minSamples,
      reason: accept
        ? (this._samples < this.minSamples ? 'cold-start pass' : `meta-prob ${(p*100).toFixed(1)}% ≥ threshold`)
        : (this._samples < this.minSamples ? 'cold-start block (low conf)' : `meta-prob ${(p*100).toFixed(1)}% < threshold`),
    };
  }

  // ── Update weights after a trade closes ───────────────────────────────────
  // features: same object passed to evaluate()
  // outcome: 1 = trade was profitable, 0 = trade was a loss
  update(features, outcome) {
    this._validateFeatures(features);
    const f   = this._extractFeatureVector(features);
    const p   = this._sigmoid(this._dot(this._weights, f));
    const err = outcome - p;

    // Stochastic gradient descent on cross-entropy loss + L2 regularization
    const lambda = 0.001;   // L2 penalty prevents weight explosion with few samples
    for (let i = 0; i < this._weights.length; i++) {
      this._weights[i] = this._weights[i] * (1 - lambda) + this.lr * err * f[i];
    }

    this._samples++;
    this._recentWins.push(outcome);
    if (this._recentWins.length > 20) this._recentWins.shift();
    this._history.push({ outcome, probability: parseFloat(p.toFixed(4)) });
    if (this._history.length > 200) this._history.shift();

    this._save();
    return { err: parseFloat(err.toFixed(4)), updatedSamples: this._samples };
  }

  // ── Performance stats ─────────────────────────────────────────────────────
  stats() {
    if (this._history.length < 5) return { insufficient: true, samples: this._samples };
    const accepted   = this._history.filter(h => h.probability >= this.threshold);
    const rejected   = this._history.filter(h => h.probability <  this.threshold);
    const accWinRate = accepted.length ? accepted.filter(h => h.outcome === 1).length / accepted.length : 0;
    const rejWinRate = rejected.length ? rejected.filter(h => h.outcome === 1).length / rejected.length : 0;
    return {
      samples:       this._samples,
      accepted:      accepted.length,
      rejected:      rejected.length,
      acceptedWinRate: parseFloat((accWinRate * 100).toFixed(1)),
      rejectedWinRate: parseFloat((rejWinRate * 100).toFixed(1)),
      lift:          parseFloat(((accWinRate - rejWinRate) * 100).toFixed(1)),
      weights:       this._weights.map(w => parseFloat(w.toFixed(4))),
    };
  }

  // ── Reset weights (e.g. after major regime change) ────────────────────────
  reset() {
    this._weights  = this._initWeights();
    this._samples  = 0;
    this._history  = [];
    this._recentWins = [];
    this._save();
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  // Feature vector: [bias, confidence_norm, regime, spread_atr_inv, session, atr_pct, !news, recent_wr]
  _extractFeatureVector(f) {
    const recentWR = this._recentWins.length
      ? this._recentWins.reduce((s, v) => s + v, 0) / this._recentWins.length
      : 0.5;
    return [
      1.0,                                          // bias
      Math.min(f.confidence || 0, 100) / 100,       // normalised confidence
      Math.min(Math.max(f.regimeScore  || 0, 0), 1),// regime alignment
      Math.max(0, 1 - (f.spreadAtrRatio || 0) / 3), // inverted spread/ATR (higher = better)
      Math.min(f.sessionWeight || 1, 1.2) / 1.2,    // session weight
      Math.min(Math.max(f.atrPercentile || 0.5, 0), 1), // ATR percentile
      (f.newsProximity ? 0 : 1),                    // 1 = no news nearby (good)
      recentWR,                                     // rolling win rate
    ];
  }

  _sigmoid(x) { return 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, x)))); }

  _dot(w, f) { return w.reduce((s, wi, i) => s + wi * f[i], 0); }

  // Initial weights: slight positive bias, everything else neutral
  _initWeights() { return [0.1, 0.3, 0.2, 0.1, 0.1, 0.05, 0.2, 0.2]; }

  _load() {
    try {
      if (fs.existsSync(WEIGHTS_FILE)) {
        const data = JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8'));
        if (Array.isArray(data.weights) && data.weights.length === 8) {
          this._samples = data.samples || 0;
          return data.weights;
        }
      }
    } catch (_) {}
    return this._initWeights();
  }

  _save() {
    try {
      const dir = path.dirname(WEIGHTS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      _atomicWrite(WEIGHTS_FILE, JSON.stringify({ weights: this._weights, samples: this._samples }));
    } catch (_) {}
  }
}

module.exports = { MetaLabeler };
