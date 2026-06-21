'use strict';
// ── bayesian-optimizer.js ─────────────────────────────────────────────────────
// Bayesian hyperparameter optimisation (Optuna-style) in pure JS.
//
// Uses Tree-structured Parzen Estimator (TPE) approximation:
//   1. Sample initial points randomly (warmup)
//   2. Fit two KDE models: l(x) on good trials, g(x) on bad trials
//   3. Sample next point where l(x)/g(x) is maximised (EI criterion)
//
// Replaces the random grid search in startup.js with smarter exploration.
//
// Usage:
//   const { BayesianOptimizer } = require('./bayesian-optimizer');
//   const opt = new BayesianOptimizer(paramSpace, objectiveFn, { trials: 50 });
//   const best = await opt.optimize();
// ─────────────────────────────────────────────────────────────────────────────

class BayesianOptimizer {
  constructor(paramSpace, objectiveFn, opts = {}) {
    this.paramSpace   = paramSpace;   // [{ name, min, max, values? }]
    this.objective    = objectiveFn;  // async fn(params) → number (higher = better)
    this.trials       = opts.trials     || 30;
    this.warmup       = opts.warmup     || 5;
    this.gamma        = opts.gamma      || 0.25;  // top γ% = "good" trials
    this.history      = [];   // { params, score }
    this._rng         = this._makeRng(opts.seed || 42);
  }

  // ── Main optimisation loop ────────────────────────────────────────────────
  async optimize() {
    for (let t = 0; t < this.trials; t++) {
      const params = t < this.warmup
        ? this._randomSample()
        : this._tpeSample();

      const score = await this.objective(params);
      if (typeof score !== 'number' || isNaN(score)) continue;
      this.history.push({ params, score, trial: t });
    }

    // Bug fix: if all trials returned NaN, history is empty and best.params is
    // undefined — callers that do bestParams.lr would crash with TypeError.
    // Return a random sample as safe fallback so the engine can continue.
    if (this.history.length === 0) {
      return {
        bestParams:  this._randomSample(),
        bestScore:   null,
        trials:      0,
        warning:     'All trials returned NaN or invalid scores — returning random params',
      };
    }
    const best = this.history.reduce((a, b) => b.score > a.score ? b : a, { score: -Infinity });
    return {
      bestParams:  best.params,
      bestScore:   best.score,
      trials:      this.history.length,
      history:     this.history,
    };
  }

  // ── Random sample from param space ───────────────────────────────────────
  _randomSample() {
    const params = {};
    for (const p of this.paramSpace) {
      if (p.values) {
        params[p.name] = p.values[Math.floor(this._rng() * p.values.length)];
      } else {
        params[p.name] = p.min + this._rng() * (p.max - p.min);
      }
    }
    return params;
  }

  // ── TPE sample: EI-guided ─────────────────────────────────────────────────
  _tpeSample() {
    if (this.history.length < this.warmup) return this._randomSample();

    const sorted = [...this.history].sort((a, b) => b.score - a.score);
    const nGood  = Math.max(1, Math.floor(sorted.length * this.gamma));
    const good   = sorted.slice(0, nGood);
    const bad    = sorted.slice(nGood);

    const params = {};
    for (const p of this.paramSpace) {
      if (p.values) {
        // Discrete: pick value with best EI
        const scores = p.values.map(v => {
          const lScore = this._kde(v, good.map(t => t.params[p.name]));
          const gScore = this._kde(v, bad.map(t => t.params[p.name])) + 1e-10;
          return { v, ei: lScore / gScore };
        });
        params[p.name] = scores.reduce((a, b) => b.ei > a.ei ? b : a).v;
      } else {
        // Continuous: sample candidates and pick best EI
        const candidates = Array.from({ length: 24 }, () =>
          p.min + this._rng() * (p.max - p.min)
        );
        const best = candidates.reduce((bestC, c) => {
          const l = this._kde(c, good.map(t => t.params[p.name]));
          const g = this._kde(c, bad.map(t => t.params[p.name])) + 1e-10;
          const ei = l / g;
          return ei > bestC.ei ? { c, ei } : bestC;
        }, { c: candidates[0], ei: -Infinity });
        params[p.name] = best.c;
      }
    }
    return params;
  }

  // ── Gaussian KDE density estimate ────────────────────────────────────────
  _kde(x, observations) {
    if (observations.length === 0) return 1e-10;
    const range = Math.max(...observations) - Math.min(...observations) || 1;
    const bwRaw = 1.06 * (range / observations.length) * Math.pow(observations.length, -0.2);
    const bw = Math.max(1e-8, bwRaw);  // floor: prevents NaN when all observations identical
    return observations.reduce((s, xi) => {
      const z = (x - xi) / (bw || 1);
      const gz = Math.exp(-0.5 * z * z);
      return s + (isFinite(gz) ? gz : 0) / (Math.sqrt(2 * Math.PI) * bw);
    }, 0) / observations.length;
  }

  // ── Seedable LCG RNG ─────────────────────────────────────────────────────
  _makeRng(seed) {
    let s = seed % 2147483647;
    if (s <= 0) s += 2147483646;
    return () => { s = s * 16807 % 2147483647; return (s - 1) / 2147483646; };
  }
}

// Item #2: Online update method — call after each closed trade
BayesianOptimizer.prototype.addObservation = function(params, score) {
  if (typeof score !== 'number' || !isFinite(score)) return;
  this.history.push({ params, score, trial: this.history.length, ts: Date.now() });
  // Keep only last 200 observations to prevent memory growth
  if (this.history.length > 200) this.history.shift();
};

// Get best params seen so far (useful for querying after online updates)
BayesianOptimizer.prototype.getBestParams = function() {
  if (!this.history.length) return null;
  return this.history.reduce((a, b) => b.score > a.score ? b : a).params;
};

module.exports = { BayesianOptimizer };
