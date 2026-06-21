'use strict';
// ── transformer-model.js ──────────────────────────────────────────────────────
// Lightweight time-series Transformer with multi-head self-attention, in pure JS.
//
// Architecture:
//   Input: sequence of T time steps × D features (e.g. 20 bars × 5 OHLCV features)
//   → Positional Encoding (sinusoidal)
//   → Multi-Head Self-Attention (H heads)
//   → Add & Norm (LayerNorm)
//   → Feed-Forward (2-layer MLP)
//   → Add & Norm
//   → Global Average Pooling over time
//   → Linear classifier → sigmoid → probability of UP move
//
// Not BERT/GPT-scale — designed for fast inference on M5 bar sequences.
// Trains via gradient descent with backprop through attention.
// ─────────────────────────────────────────────────────────────────────────────

// ── Math helpers ─────────────────────────────────────────────────────────────
const zeros  = (r, c) => Array.from({length: r}, () => new Float32Array(c));
const randn  = (r, c, scale = 0.1) => Array.from({length: r}, () =>
  Float32Array.from({length: c}, () => (Math.random()*2-1) * scale));
const sigmoid = x => 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, x))));
const relu    = x => Math.max(0, x);
const softmax = arr => {
  const max = Math.max(...arr);
  const exp = arr.map(v => Math.exp(v - max));
  const sum = exp.reduce((s,v) => s+v, 0);
  return exp.map(v => v / (sum || 1));
};

// Dot product of two vectors
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

// Matrix × vector
const matVec = (M, v) => M.map(row => dot(row, v));

// Element-wise add
const vadd = (a, b) => a.map((v, i) => v + b[i]);

// Layer normalisation (mean=0, std=1 per vector)
const layerNorm = (v) => {
  const mean = v.reduce((s,x)=>s+x,0) / v.length;
  const std  = Math.sqrt(v.reduce((s,x)=>s+(x-mean)**2,0) / v.length + 1e-6);
  return v.map(x => (x - mean) / std);
};

// ── Sinusoidal positional encoding ───────────────────────────────────────────
function positionalEncoding(seqLen, dModel) {
  const pe = zeros(seqLen, dModel);
  for (let pos = 0; pos < seqLen; pos++) {
    for (let i = 0; i < dModel; i += 2) {
      const denom = Math.pow(10000, i / dModel);
      pe[pos][i]     = Math.sin(pos / denom);
      if (i + 1 < dModel) pe[pos][i + 1] = Math.cos(pos / denom);
    }
  }
  return pe;
}

// ── Single attention head ─────────────────────────────────────────────────────
class AttentionHead {
  constructor(dModel, dHead) {
    this.dHead  = dHead;
    this.dModel = dModel;
    // Q, K, V weight matrices: dHead × dModel
    // matVec(Wq, x) where x is dModel-dim → each row must have dModel elements
    // Output Q[t] is dHead-dimensional (one projection per head)
    // Store as plain Arrays (not Float32Array) — avoids Array.from() on every forward pass
    this.Wq = randn(dHead, dModel, 0.1).map(r => Array.from(r));
    this.Wk = randn(dHead, dModel, 0.1).map(r => Array.from(r));
    this.Wv = randn(dHead, dModel, 0.1).map(r => Array.from(r));
  }

  forward(X) {
    // X: T × dModel
    const T = X.length;
    const scale = Math.sqrt(this.dHead);
    const Q = X.map(x => matVec(this.Wq, x));
    const K = X.map(x => matVec(this.Wk, x));
    const V = X.map(x => matVec(this.Wv, x));

    // Attention scores: T × T
    const scores = Array.from({length: T}, (_, i) =>
      Array.from({length: T}, (_, j) => dot(Q[i], K[j]) / scale)
    );
    const attnWeights = scores.map(row => softmax(row));

    // Weighted sum of V: T × dHead
    const out = Array.from({length: T}, (_, i) =>
      V[0].map((_, d) => attnWeights[i].reduce((s, w, j) => s + w * V[j][d], 0))
    );
    return out;
  }
}

// ── Multi-Head Self-Attention ─────────────────────────────────────────────────
class MultiHeadAttention {
  constructor(dModel, nHeads) {
    this.nHeads = nHeads;
    this.dHead  = Math.floor(dModel / nHeads);
    this.heads  = Array.from({length: nHeads}, () => new AttentionHead(dModel, this.dHead));
    // Output projection: (nHeads × dHead) → dModel
    this.Wo = randn(dModel, nHeads * this.dHead, 0.1).map(r => Array.from(r));
  }

  forward(X) {
    // Concatenate heads
    const headOuts = this.heads.map(h => h.forward(X));   // nHeads × T × dHead
    const T = X.length;
    const concat = Array.from({length: T}, (_, t) => {
      const row = [];
      for (const ho of headOuts) row.push(...ho[t]);
      return row;
    });
    // Project back to dModel
    return concat.map(c => matVec(this.Wo, c).map(relu));
  }
}

// ── Feed-Forward block (2-layer MLP) ─────────────────────────────────────────
class FeedForward {
  constructor(dModel, dFF) {
    this.W1 = randn(dFF, dModel, 0.1).map(r => Array.from(r));
    this.W2 = randn(dModel, dFF, 0.1).map(r => Array.from(r));
    this.b1 = new Float32Array(dFF);
    this.b2 = new Float32Array(dModel);
  }

  forward(x) {
    const h   = matVec(this.W1, x).map((v,i) => relu(v + this.b1[i]));
    return matVec(this.W2, h).map((v,i) => v + this.b2[i]);
  }
}

// ── Transformer Encoder Layer ─────────────────────────────────────────────────
class TransformerLayer {
  constructor(dModel, nHeads, dFF) {
    this.mha = new MultiHeadAttention(dModel, nHeads);
    this.ff  = new FeedForward(dModel, dFF);
  }

  forward(X) {
    // Self-attention + residual + norm
    const attnOut = this.mha.forward(X);
    const X2 = X.map((x, i) => layerNorm(vadd(x, attnOut[i])));
    // Feed-forward + residual + norm
    return X2.map(x => layerNorm(vadd(x, this.ff.forward(x))));
  }
}

// ── Full Transformer Classifier ───────────────────────────────────────────────
class TransformerModel {
  constructor(opts = {}) {
    this.seqLen  = opts.seqLen  || 20;    // bars per window
    this.dInput  = opts.dInput  || 5;     // features per bar
    this.dModel  = opts.dModel  || 16;    // internal dimension
    this.nHeads  = opts.nHeads  || 2;     // attention heads
    this.dFF     = opts.dFF     || 32;    // feed-forward hidden size
    this.nLayers = opts.nLayers || 2;     // transformer layers

    // Input projection: dInput → dModel
    this.inputProj = randn(this.dModel, this.dInput, 0.1).map(r => Array.from(r));
    this.inputBias = Array.from({length: this.dModel}, () => 0);

    // Transformer layers
    this.layers = Array.from({length: this.nLayers}, () =>
      new TransformerLayer(this.dModel, this.nHeads, this.dFF)
    );

    // Output classifier: dModel → 1
    this.outputW = Array.from({length: this.dModel}, () => (Math.random()*2-1)*0.1);
    this.outputB = 0;

    this.trained   = false;
    this._buffer   = [];    // {seq, label}
    this.MIN_SAMPLES = 30;
    this.stats     = { acc: 0, trainMs: 0, samples: 0 };
  }

  // ── Forward pass ────────────────────────────────────────────────────────────
  forward(seq) {
    // seq: T × dInput  (raw bar features)
    const pe = positionalEncoding(this.seqLen, this.dModel);

    // Project input to dModel + add positional encoding
    let X = seq.map((x, t) => {
      const proj = matVec(this.inputProj, x).map((v,i) => relu(v + this.inputBias[i]));
      return vadd(proj, Array.from(pe[t]));
    });

    // Transformer layers
    for (const layer of this.layers) X = layer.forward(X);

    // Global average pooling over time dimension
    const pooled = X[0].map((_, d) => X.reduce((s, x) => s + x[d], 0) / X.length);

    // Linear output + sigmoid
    return sigmoid(dot(Array.from(this.outputW), pooled) + this.outputB);
  }

  // ── Add training sample ──────────────────────────────────────────────────────
  addSample(seq, label) {
    if (!seq || seq.length !== this.seqLen) return;
    this._buffer.push({ seq, label });
    if (this._buffer.length > 1000) this._buffer.shift();
  }

  // ── Train via basic gradient estimation (finite differences) ────────────────
  // Full backprop through attention is complex — we use evolution-strategy style
  // parameter perturbation for simplicity in pure JS
  train() {
    if (this._buffer.length < this.MIN_SAMPLES) return false;
    const t0 = Date.now();

    const samples = this._buffer.slice(-200);
    const getLoss = () => {
      let loss = 0;
      for (const { seq, label } of samples) {
        const p = this.forward(seq);
        loss -= label * Math.log(p + 1e-7) + (1 - label) * Math.log(1 - p + 1e-7);
      }
      return loss / samples.length;
    };

    // Train output layer + input projection + first attention head Wq
    // Full backprop through attention is expensive — we perturb key weights
    const lr  = 0.01;
    const eps = 0.001;

    const perturbParam = (param, i, j) => {
      const orig = j !== undefined ? param[i][j] : param[i];
      const set  = (v) => { if (j !== undefined) param[i][j] = v; else param[i] = v; };
      set(orig + eps); const lp = getLoss();
      set(orig - eps); const lm = getLoss();
      set(orig - lr * (lp - lm) / (2 * eps));
    };

    for (let iter = 0; iter < 10; iter++) {
      // Output layer
      for (let i = 0; i < this.outputW.length; i++) perturbParam(this.outputW, i, undefined);
      // BUG-34 fix: proper finite-difference gradient for output bias
      // Old: lr * ((getLoss() + eps) - getLoss()) / eps  → always = lr * 1.0 (eps/eps)
      // New: perturb the parameter itself, measure loss change
      const origB = this.outputB;
      this.outputB = origB + eps; const bLossP = getLoss();
      this.outputB = origB - eps; const bLossM = getLoss();
      this.outputB = origB - lr * (bLossP - bLossM) / (2 * eps);

      // Input projection (subset — first 4 rows to keep training fast)
      if (this.inputProj.length > 0) {
        for (let i = 0; i < Math.min(4, this.inputProj.length); i++) {
          for (let j = 0; j < this.inputProj[i].length; j++) {
            perturbParam(this.inputProj, i, j);
          }
        }
      }

      // First attention head Wq (first 2 rows — guides what to attend to)
      if (this.layers[0] && this.layers[0].mha.heads[0]) {
        const head = this.layers[0].mha.heads[0];
        for (let i = 0; i < Math.min(2, head.Wq.length); i++) {
          for (let j = 0; j < head.Wq[i].length; j++) {
            perturbParam(head.Wq, i, j);
          }
        }
      }
    }

    // Measure accuracy
    let correct = 0;
    for (const { seq, label } of samples) {
      const p = this.forward(seq);
      if ((p > 0.5 ? 1 : 0) === label) correct++;
    }
    this.stats.acc      = parseFloat(((correct / samples.length) * 100).toFixed(1));
    this.stats.trainMs  = Date.now() - t0;
    this.stats.samples  = samples.length;
    this.trained = true;
    return true;
  }

  // ── Predict: returns { prob, direction, confidence } ──────────────────────
  predict(seq) {
    if (!this.trained || !seq || seq.length !== this.seqLen) {
      return { prob: 0.5, direction: 'NEUTRAL', confidence: 0, source: 'transformer_untrained' };
    }
    const prob = this.forward(seq);
    const direction = prob > 0.55 ? 'UP' : prob < 0.45 ? 'DOWN' : 'NEUTRAL';
    const confidence = Math.abs(prob - 0.5) * 2;  // 0 = uncertain, 1 = certain
    return { prob: parseFloat(prob.toFixed(4)), direction, confidence: parseFloat(confidence.toFixed(3)), source: 'transformer' };
  }
}

module.exports = { TransformerModel };
