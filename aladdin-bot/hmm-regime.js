'use strict';
// ── hmm-regime.js — 2.1: Hidden Markov Model for Market State Detection ──────
//
// Two usage modes:
//
// MODE A (original — live regime detection from indicator observations):
//   const hmm = new HMMRegime();          // no opts needed
//   hmm.update({ adx, atrPct, ... });     // → { state, name, probs, confidence }
//
// MODE B (fitted — train on price series, then decode):
//   const hmm = new HMMRegime({ nStates: 3, maxIter: 20 });
//   hmm.fit(priceArray);                  // Baum-Welch / K-means EM
//   hmm.predict(recentPrices);            // → { state, stateProbs }
//   hmm.viterbi(priceArray);              // → state-index array
//
// FIXED: constructor accepts {nStates, maxIter}; exposes nStates, isFitted(),
//        fit(), predict(), viterbi(), mu.

const DEFAULT_N_STATES = 5;
const STATE_NAMES      = ['STRONG_TREND','WEAK_TREND','MEAN_REVERT','HIGH_VOL','CRISIS'];

// Pre-configured emission params for the 5-state live-observation mode (Mode A)
const EMIT_MEAN = [
  [35,1.2,1.5,0.4,1.1],[22,0.8,1.1,0.3,1.0],[15,0.6,0.9,0.5,1.0],[20,2.0,1.4,0.4,1.5],[18,4.0,2.0,0.5,3.0],
];
const EMIT_STD = [
  [10,0.5,0.4,0.2,0.2],[8,0.4,0.3,0.2,0.1],[6,0.3,0.3,0.3,0.1],[8,0.8,0.5,0.3,0.5],[10,2.0,0.8,0.3,1.5],
];
const TRANSITIONS = [
  [0.7,0.2,0.05,0.04,0.01],[0.1,0.6,0.2,0.08,0.02],[0.05,0.2,0.6,0.14,0.01],[0.05,0.1,0.1,0.65,0.10],[0.02,0.08,0.05,0.25,0.60],
];
const INIT_PROBS = [0.20,0.35,0.25,0.15,0.05];

function gaussianLogPDF(x, mu, sigma) {
  const z = (x - mu) / Math.max(sigma, 1e-10);
  return -0.5 * z * z - Math.log(Math.max(sigma, 1e-10));
}
function gaussianPDF(x, mu, sigma) {
  const s = Math.max(sigma, 1e-10);
  return Math.exp(-0.5 * ((x - mu) / s) ** 2) / (s * Math.sqrt(2 * Math.PI));
}

class HMMRegime {
  constructor(opts = {}) {
    // Mode A: live indicator-based detection
    this._currentState = 1;
    this._stateProbs   = [...INIT_PROBS];
    this._history      = [];
    this._maxHistory   = 50;

    // Mode B: fitted on price returns
    this.nStates  = opts.nStates  || DEFAULT_N_STATES;
    this.maxIter  = opts.maxIter  || 30;
    this._fitted  = false;
    this.mu       = null;   // means (length nStates)
    this.sigma    = null;   // std devs
    this.pi       = null;   // initial state probs
    this.A        = null;   // transition matrix
  }

  // ── Mode B: isFitted ───────────────────────────────────────────────────────
  isFitted() { return this._fitted; }

  // ── Mode B: fit(prices) — EM on 1D Gaussian HMM ───────────────────────────
  fit(prices) {
    if (!prices || prices.length < this.nStates + 2) return;
    const K = this.nStates;

    // Compute log-returns (or differences)
    const obs = [];
    for (let i = 1; i < prices.length; i++) {
      const r = (prices[i] - prices[i-1]) / (prices[i-1] || 1);
      obs.push(isFinite(r) ? r : 0);
    }
    const T = obs.length;
    if (T < K) return;

    // K-means initialisation for means
    const sorted = [...obs].sort((a,b)=>a-b);
    this.mu    = Array.from({length:K}, (_,k) => sorted[Math.floor((k+0.5)*T/K)]);
    this.sigma = Array(K).fill(Math.abs(obs.reduce((s,v)=>s+v,0)/T) * 3 + 1e-5);
    this.pi    = Array(K).fill(1/K);
    this.A     = Array.from({length:K}, () => {
      const row = Array(K).fill(1/(K+K*0.1));
      row[Math.floor(Math.random()*K)] += 0.1;
      const s = row.reduce((a,b)=>a+b,0);
      return row.map(v=>v/s);
    });
    // Make A valid stochastic matrix
    for (let i=0; i<K; i++) {
      const s = this.A[i].reduce((a,b)=>a+b,0);
      this.A[i] = this.A[i].map(v=>v/s);
    }

    // Baum-Welch EM
    for (let iter = 0; iter < this.maxIter; iter++) {
      // Forward
      const alpha = Array.from({length:T}, () => Array(K).fill(0));
      const scale = Array(T).fill(0);
      for (let k=0; k<K; k++) alpha[0][k] = this.pi[k] * gaussianPDF(obs[0], this.mu[k], this.sigma[k]);
      scale[0] = alpha[0].reduce((a,b)=>a+b,0) || 1e-300;
      for (let k=0; k<K; k++) alpha[0][k] /= scale[0];

      for (let t=1; t<T; t++) {
        for (let j=0; j<K; j++) {
          let sum = 0;
          for (let i=0; i<K; i++) sum += alpha[t-1][i] * this.A[i][j];
          alpha[t][j] = sum * gaussianPDF(obs[t], this.mu[j], this.sigma[j]);
        }
        scale[t] = alpha[t].reduce((a,b)=>a+b,0) || 1e-300;
        for (let j=0; j<K; j++) alpha[t][j] /= scale[t];
      }

      // Backward
      const beta = Array.from({length:T}, () => Array(K).fill(0));
      for (let k=0; k<K; k++) beta[T-1][k] = 1;
      for (let t=T-2; t>=0; t--) {
        for (let i=0; i<K; i++) {
          let sum = 0;
          for (let j=0; j<K; j++) sum += this.A[i][j] * gaussianPDF(obs[t+1], this.mu[j], this.sigma[j]) * beta[t+1][j];
          beta[t][i] = sum / scale[t+1];
        }
      }

      // Gamma & Xi
      const gamma = Array.from({length:T}, (_,t) => {
        const g = Array.from({length:K}, (_,k) => alpha[t][k] * beta[t][k]);
        const s = g.reduce((a,b)=>a+b,0) || 1e-300;
        return g.map(v=>v/s);
      });

      // M-step: update pi, A, mu, sigma
      for (let k=0; k<K; k++) this.pi[k] = gamma[0][k];
      const piSum = this.pi.reduce((a,b)=>a+b,0) || 1;
      this.pi = this.pi.map(v=>v/piSum);

      for (let i=0; i<K; i++) {
        const gammaI = gamma.slice(0,T-1).map(g=>g[i]);
        const gammaISum = gammaI.reduce((a,b)=>a+b,0) || 1e-300;
        for (let j=0; j<K; j++) {
          let xiIJ = 0;
          for (let t=0; t<T-1; t++) {
            xiIJ += alpha[t][i] * this.A[i][j] * gaussianPDF(obs[t+1], this.mu[j], this.sigma[j]) * beta[t+1][j] / scale[t+1];
          }
          this.A[i][j] = xiIJ / gammaISum;
        }
        const aRow = this.A[i].reduce((a,b)=>a+b,0) || 1;
        this.A[i] = this.A[i].map(v=>v/aRow);
      }

      for (let k=0; k<K; k++) {
        const gk   = gamma.map(g=>g[k]);
        const gkSum = gk.reduce((a,b)=>a+b,0) || 1e-300;
        this.mu[k]    = obs.reduce((s,v,t)=>s+gk[t]*v, 0) / gkSum;
        this.sigma[k] = Math.sqrt(obs.reduce((s,v,t)=>s+gk[t]*(v-this.mu[k])**2, 0) / gkSum) + 1e-6;
      }
    }
    this._fitted = true;
  }

  // ── Mode B: predict(recentPrices) ─────────────────────────────────────────
  predict(recentPrices) {
    if (!this._fitted) return { state: 'UNKNOWN', stateProbs: [], confidence: 0 };
    const K = this.nStates;
    const obs = [];
    for (let i=1; i<recentPrices.length; i++) {
      const r = (recentPrices[i] - recentPrices[i-1]) / (recentPrices[i-1] || 1);
      obs.push(isFinite(r) ? r : 0);
    }
    if (obs.length === 0) return { state: 'UNKNOWN', stateProbs: Array(K).fill(1/K), confidence: 0 };

    // Single forward pass to get posterior
    let probs = Array.from({length:K}, (_, k) => this.pi[k] * gaussianPDF(obs[0], this.mu[k], this.sigma[k]));
    let s = probs.reduce((a,b)=>a+b,0) || 1e-300;
    probs = probs.map(v=>v/s);

    for (let t=1; t<obs.length; t++) {
      const newProbs = Array(K).fill(0);
      for (let j=0; j<K; j++) {
        let sum=0;
        for (let i=0; i<K; i++) sum += probs[i] * this.A[i][j];
        newProbs[j] = sum * gaussianPDF(obs[t], this.mu[j], this.sigma[j]);
      }
      s = newProbs.reduce((a,b)=>a+b,0) || 1e-300;
      probs = newProbs.map(v=>v/s);
    }

    const stateIdx = probs.indexOf(Math.max(...probs));
    const stateNames = Array.from({length:K}, (_,k) => STATE_NAMES[k] || String(k));
    return {
      state:       stateNames[stateIdx],
      stateIndex:  stateIdx,
      stateProbs:  probs.map(v => parseFloat(v.toFixed(4))),
      confidence:  parseFloat((probs[stateIdx]*100).toFixed(1)),
    };
  }

  // ── Mode B: viterbi(prices) → state-index array ───────────────────────────
  viterbi(prices) {
    if (!this._fitted) return [];
    const K = this.nStates;
    const obs = [];
    for (let i=1; i<prices.length; i++) {
      const r = (prices[i] - prices[i-1]) / (prices[i-1] || 1);
      obs.push(isFinite(r) ? r : 0);
    }
    if (obs.length === 0) return [];
    const T = obs.length;
    const delta = Array.from({length:T}, () => Array(K).fill(-Infinity));
    const psi   = Array.from({length:T}, () => Array(K).fill(0));

    for (let k=0; k<K; k++) delta[0][k] = Math.log(this.pi[k]+1e-300) + gaussianLogPDF(obs[0],this.mu[k],this.sigma[k]);
    for (let t=1; t<T; t++) {
      for (let j=0; j<K; j++) {
        let best=-Infinity, bestK=0;
        for (let i=0; i<K; i++) {
          const v = delta[t-1][i] + Math.log(this.A[i][j]+1e-300);
          if (v > best) { best=v; bestK=i; }
        }
        delta[t][j] = best + gaussianLogPDF(obs[t],this.mu[j],this.sigma[j]);
        psi[t][j]   = bestK;
      }
    }
    const path = Array(T).fill(0);
    path[T-1] = delta[T-1].indexOf(Math.max(...delta[T-1]));
    for (let t=T-2; t>=0; t--) path[t] = psi[t+1][path[t+1]];
    return path;
  }

  // ── Mode A: update(obs) — live indicator-based regime detection ───────────
  update(obs) {
    const N = DEFAULT_N_STATES;
    const features = [
      Math.min(obs.adx      || 20, 60),
      Math.min(obs.atrPct   || 0.8, 5),
      Math.min(obs.volRatio || 1.0, 3),
      Math.abs((obs.rsi || 50) - 50) / 50,
      Math.min(obs.spreadRatio || 1.0, 5),
    ];
    const likelihoods = new Array(N).fill(0);
    for (let s = 0; s < N; s++) {
      let logL = 0;
      for (let f = 0; f < features.length; f++) logL += gaussianLogPDF(features[f], EMIT_MEAN[s][f], EMIT_STD[s][f]);
      let transProb = 0;
      for (let prev=0; prev<N; prev++) transProb += this._stateProbs[prev] * TRANSITIONS[prev][s];
      likelihoods[s] = Math.exp(Math.min(logL,0)) * transProb;
    }
    const total = likelihoods.reduce((s,v)=>s+v,0) || 1e-10;
    this._stateProbs = likelihoods.map(l => l / total);
    this._currentState = this._stateProbs.indexOf(Math.max(...this._stateProbs));
    this._history.push(this._currentState);
    if (this._history.length > this._maxHistory) this._history.shift();
    return {
      state:      this._currentState,
      name:       STATE_NAMES[this._currentState],
      probs:      this._stateProbs.map(p=>parseFloat(p.toFixed(4))),
      confidence: parseFloat((this._stateProbs[this._currentState]*100).toFixed(1)),
    };
  }

  get stateName()  { return STATE_NAMES[this._currentState]; }
  get stateIndex() { return this._currentState; }
  get stateProbs() { return this._stateProbs; }
  isTradeable()    { return this._currentState !== 4; }
  persistence() {
    let n=0;
    for (let i=this._history.length-1; i>=0; i--) {
      if (this._history[i]===this._currentState) n++; else break;
    }
    return n;
  }
}

module.exports = { HMMRegime, STATE_NAMES, N_STATES: DEFAULT_N_STATES };
