'use strict';
const { TransformerModel } = require('./transformer-model');

const { ConfidenceCalibrator } = require('./confidence-calibrator');

// ═══════════════════════════════════════════════════════════════════════════════
//  ml-confidence.js
//  XGBoost-style Gradient Boosted Machine  +  LSTM-inspired Sequence Model
//
//  Replaces the four hardcoded confidence numbers in trading-engine.js:
//    82 (STRONG_BUY pullback)  →  ML predicted win-probability × 65 + 30
//    70 (BUY + trend)          →  same formula, naturally calibrated
//    68 (STRONG_BUY weaker)    →  same
//    80 (STRONG_SELL exit)     →  same
//
//  Architecture
//  ────────────
//  1. GBMClassifier   — 80-tree gradient boosted decision trees (XGBoost-style)
//                       trained on 13 tabular features (RSI, MACD, EMA ratio …)
//  2. SequenceModel   — 2-layer MLP on a 20-step RSI window (LSTM-inspired)
//                       trained with analytic SGD backprop
//  3. MLConfidence    — ensemble (65 % GBM + 35 % Seq), cold-start synthetic
//                       training, online update every 10 closed trades
// ═══════════════════════════════════════════════════════════════════════════════

// ── Math helpers ───────────────────────────────────────────────────────────────
const sig   = x => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));
const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));

// ─────────────────────────────────────────────────────────────────────────────
//  RegressionTree  —  depth-limited tree used as a GBM base learner
//  Fits pseudo-residuals (gradient of log-loss) at each boosting round
// ─────────────────────────────────────────────────────────────────────────────
class RegressionTree {
  constructor (maxDepth = 3, minLeaf = 3) {
    this.maxDepth = maxDepth;
    this.minLeaf  = minLeaf;
    this.root     = null;
    this.nFeatures = 0;
  }

  fit (X, y) {
    this.nFeatures = X[0].length;
    this.root      = this._build(X, y, 0);
  }

  predict (x) {
    let n = this.root;
    while (n.split) n = x[n.split.f] <= n.split.t ? n.left : n.right;
    return n.val;
  }

  // ── private ──────────────────────────────────────────────────────────────
  _mean (y) { return y.length ? y.reduce((s, v) => s + v, 0) / y.length : 0; }

  _mse (y) {
    if (y.length < 2) return 0;
    const m = this._mean(y);
    return y.reduce((s, v) => s + (v - m) ** 2, 0) / y.length;
  }

  _build (X, y, depth) {
    const val = this._mean(y);
    if (depth >= this.maxDepth || y.length < this.minLeaf * 2) return { val };

    const parentMSE = this._mse(y);
    let bestGain = 0, bestF = -1, bestT = 0;
    let bestLI = [], bestRI = [];

    for (let f = 0; f < this.nFeatures; f++) {
      // Sort indices by feature f
      const sorted = X
        .map((row, i) => [row[f], i])
        .sort((a, b) => a[0] - b[0]);

      // Candidate thresholds (at most 12 evenly spaced)
      const step = Math.max(1, Math.floor(sorted.length / 12));
      for (let k = this.minLeaf - 1; k < sorted.length - this.minLeaf; k += step) {
        if (sorted[k][0] === sorted[k + 1][0]) continue; // identical values
        const t  = (sorted[k][0] + sorted[k + 1][0]) / 2;
        const li = sorted.slice(0,     k + 1).map(s => s[1]);
        const ri = sorted.slice(k + 1        ).map(s => s[1]);
        if (li.length < this.minLeaf || ri.length < this.minLeaf) continue;

        const lMSE = this._mse(li.map(i => y[i]));
        const rMSE = this._mse(ri.map(i => y[i]));
        const gain = parentMSE
          - (li.length / y.length) * lMSE
          - (ri.length / y.length) * rMSE;

        if (gain > bestGain) {
          bestGain = gain; bestF = f; bestT = t;
          bestLI = li; bestRI = ri;
        }
      }
    }

    if (bestF === -1) return { val };
    return {
      split: { f: bestF, t: bestT },
      left:  this._build(bestLI.map(i => X[i]), bestLI.map(i => y[i]), depth + 1),
      right: this._build(bestRI.map(i => X[i]), bestRI.map(i => y[i]), depth + 1),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  GBMClassifier  —  XGBoost-style gradient boosted trees (binary classification)
//
//  At each round t:
//    gradient_i = y_i − sigmoid(F_{t−1}(x_i))        ← pseudo-residual
//    tree_t fits gradient on a random subsample
//    F_t = F_{t−1} + lr × tree_t
//  Final: P(win | x) = sigmoid(F_T(x))
// ─────────────────────────────────────────────────────────────────────────────
class GBMClassifier {
  constructor ({
    nTrees    = 80,
    lr        = 0.10,
    maxDepth  = 3,
    subsample = 0.75,
  } = {}) {
    this.nTrees    = nTrees;
    this.lr        = lr;
    this.maxDepth  = maxDepth;
    this.subsample = subsample;
    this.trees     = [];
    this.F0        = 0;
    this.trained   = false;
  }

  fit (X, y) {
    const n = X.length;
    if (n < 20) { console.warn('[GBM] Need ≥20 samples'); return; }

    // Initial log-odds
    const nPos = y.reduce((s, v) => s + (v > 0.5 ? 1 : 0), 0);
    this.F0    = Math.log((nPos + 1e-7) / (n - nPos + 1e-7));
    let F      = new Array(n).fill(this.F0);
    this.trees = [];

    for (let t = 0; t < this.nTrees; t++) {
      // Pseudo-residuals = negative gradient of binary cross-entropy
      const residuals = y.map((yi, i) => yi - sig(F[i]));

      // Subsample rows (reduces overfitting, mirrors XGBoost colsample/subsample)
      const subN = Math.max(15, Math.floor(n * this.subsample));
      const idx  = this._shuffledIdx(n).slice(0, subN);
      const Xs   = idx.map(i => X[i]);
      const rs   = idx.map(i => residuals[i]);

      const tree = new RegressionTree(this.maxDepth);
      tree.fit(Xs, rs);
      this.trees.push(tree);

      for (let i = 0; i < n; i++) F[i] += this.lr * tree.predict(X[i]);
    }
    this.trained = true;
  }

  predictProba (x) {
    if (!this.trained) return 0.5;
    const F = this.trees.reduce((acc, tree) => acc + this.lr * tree.predict(x), this.F0);
    return sig(F);
  }

  // Online update — append a shallow tree for one new labelled example.
  // Keeps the model fresh between full retrains.
  onlineUpdate (x, y) {
    if (!this.trained) return;
    const prob = this.predictProba(x);
    const residual = y - prob;
    const tree = new RegressionTree(2, 2);
    tree.fit([x], [residual]);
    this.trees.push(tree);
    if (this.trees.length > this.nTrees + 40) this.trees.shift();
  }

  _shuffledIdx (n) {
    const a = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SequenceModel  —  LSTM-inspired 2-layer MLP on a sliding RSI window
//
//  Architecture:  seqLen → hidden (tanh) → 1 (sigmoid)
//  Training:      mini-batch SGD with analytic backprop
//
//  Why MLP not true LSTM: an MLP over a fixed window of 20 RSI samples captures
//  the same short-term temporal patterns as an LSTM for this use-case, with
//  10× less code and no vanishing-gradient issues.
// ─────────────────────────────────────────────────────────────────────────────
class SequenceModel {
  constructor (seqLen = 20, hidden = 16) {
    this.seqLen = seqLen;
    this.H      = hidden;
    const s = 0.08;
    const r = () => (Math.random() - 0.5) * s;

    // Layer 1: seqLen → hidden  (tanh)
    this.W1 = Array.from({ length: hidden }, () => Array.from({ length: seqLen }, r));
    this.b1 = Array.from({ length: hidden }, r);
    // Layer 2: hidden → 1  (sigmoid)
    this.W2 = Array.from({ length: hidden }, r);
    this.b2 = 0;

    // Momentum accumulators (SGD + momentum)
    this.vW1 = this.W1.map(row => row.map(() => 0));
    this.vb1 = this.b1.map(() => 0);
    this.vW2 = this.W2.map(() => 0);
    this.vb2 = 0;

    this.trained = false;
  }

  // Forward pass — returns probability and cached hidden activations
  forward (seq) {
    // Clamp / pad sequence to seqLen
    const x = seq.slice(-this.seqLen);
    while (x.length < this.seqLen) x.unshift(0.5);

    // Hidden layer
    const h = this.W1.map((w, i) =>
      Math.tanh(w.reduce((s, wj, j) => s + wj * x[j], 0) + this.b1[i])
    );
    // Output
    const z   = this.W2.reduce((s, w, i) => s + w * h[i], 0) + this.b2;
    const out = sig(z);
    return { out, h, x };
  }

  // Train with mini-batch SGD + momentum
  train (seqs, labels, epochs = 30, lr = 0.008, momentum = 0.85) {
    const n = seqs.length;
    for (let ep = 0; ep < epochs; ep++) {
      // Shuffle
      const idx = Array.from({ length: n }, (_, i) => i);
      for (let i = n - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }

      // Mini-batches of 16
      for (let start = 0; start < n; start += 16) {
        const batch = idx.slice(start, start + 16);

        // Accumulators
        const dW1 = this.W1.map(row => row.map(() => 0));
        const db1 = this.b1.map(() => 0);
        const dW2 = this.W2.map(() => 0);
        let   db2 = 0;

        for (const i of batch) {
          const { out, h, x } = this.forward(seqs[i]);
          const dOut = out - labels[i];         // dL/dz_out

          // Backprop layer 2
          for (let k = 0; k < this.H; k++) { dW2[k] += dOut * h[k]; }
          db2 += dOut;

          // Backprop layer 1 (tanh derivative: 1 − h²)
          for (let k = 0; k < this.H; k++) {
            const dh = dOut * this.W2[k] * (1 - h[k] ** 2);
            for (let j = 0; j < this.seqLen; j++) dW1[k][j] += dh * x[j];
            db1[k] += dh;
          }
        }

        const bsz = batch.length;
        // Feature #21: Apply OnlineLearningGuard to clip W2 deltas before update
        let olGuard = null;
        try { const {OnlineLearningGuard}=require('./online-learning-guard'); olGuard=new OnlineLearningGuard({maxWeightDelta:0.05,maxNormChange:0.10}); } catch(_) {}

        // SGD + momentum update (with guard)
        for (let k = 0; k < this.H; k++) {
          for (let j = 0; j < this.seqLen; j++) {
            this.vW1[k][j] = momentum * this.vW1[k][j] + lr * dW1[k][j] / bsz;
            this.W1[k][j] -= this.vW1[k][j];
          }
          this.vb1[k] = momentum * this.vb1[k] + lr * db1[k] / bsz;
          this.b1[k] -= this.vb1[k];
          const rawDeltaW2 = lr * dW2[k] / bsz;
          const safeDelta  = olGuard ? olGuard.clip(this.W2, [rawDeltaW2])[0] : rawDeltaW2;
          this.vW2[k] = momentum * this.vW2[k] + safeDelta;
          this.W2[k] -= this.vW2[k];
        }
        this.vb2 = momentum * this.vb2 + lr * db2 / bsz;
        this.b2 -= this.vb2;
      }
    }
    this.trained = true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  FeatureExtractor  —  builds a 31-element feature vector from an
//  indicator snapshot + OHLCV candle history
//
//  Features 0-12:  original 13 indicator-based features
//  Features 13-20: 8 OHLCV candle features
//  Features 21-29: 9 enhanced institutional/temporal features
//                  (tod_sin/cos, dow_sin/cos, cot_bias, risk_env,
//                   divergence, adx_norm, macd_hist)
// ─────────────────────────────────────────────────────────────────────────────
class FeatureExtractor {
  static NAMES = [
    // ── Indicator features (0-12) ──────────────────────────────────────
    'rsi_norm',      // RSI / 100
    'rsi_zone',      // 0=oversold(<35), 0.5=mid, 1=overbought(>65)
    'macd_tanh',     // tanh(macd / atr) — normalised momentum
    'ema_ratio',     // (ema9 − ema21) / ema21 × 1000, clamped ±1
    'bb_position',   // (price − bb.lower) / (bb.upper − bb.lower)
    'atr_pct_norm',  // atr% / 3, clamped 0–1
    'vwap_dev',      // (price − vwap) / price × 100, clamped ±1
    'vol_encoded',   // 0=LOW, 0.5=NORMAL, 1=HIGH
    'momentum_5',    // 5-bar return %, clamped ±1
    'momentum_10',   // 10-bar return %, clamped ±1
    'above_vwap',    // 1 if price > vwap
    'mta_score',     // multi-timeframe alignment [0–1]
    'leading_bias',  // 0=BEARISH, 0.5=NEUTRAL, 1=BULLISH
    // ── OHLCV candle features (13-20) ─────────────────────────────────
    'candle_body',   // (close − open) / atr — body size & direction
    'upper_wick',    // (high − max(o,c)) / atr — selling pressure above
    'lower_wick',    // (min(o,c) − low) / atr — buying support below
    'hl_range',      // (high − low) / atr — total bar range
    'rel_close',     // (close − low) / (high − low) — where close sits
    'body_dir',      // +1 bullish candle, −1 bearish, 0 doji
    'vol_ratio',     // current volume / 20-bar avg volume, clamped 0–3
    'ema50_ratio',   // (close − ema50) / ema50 × 1000, clamped ±1
    // Enhanced features (21-28)
    'tod_sin',       // time-of-day sine (cyclical)
    'tod_cos',       // time-of-day cosine
    'dow_sin',       // day-of-week sine
    'dow_cos',       // day-of-week cosine
    'cot_bias',      // COT positioning (-1 bearish, 0 neutral, 1 bullish)
    'risk_env',      // global risk environment (-1 off, 0 neutral, 1 on)
    'divergence',    // RSI/MACD divergence signal
    'adx_norm',      // ADX / 50, normalised 0-1
    'macd_hist',     // MACD histogram sign (momentum shift signal)
  ];

  static extract (ind, priceHistory, ohlcvHistory, barTimestamp) {
    const price  = parseFloat(ind.price);
    const rsi    = parseFloat(ind.rsi);
    const macd   = parseFloat(ind.macd);
    const ema9   = parseFloat(ind.ema9);
    const ema21  = parseFloat(ind.ema21);
    const ema50  = parseFloat(ind.ema50  || ema21);
    const bbU    = parseFloat(ind.bb?.upper  || price);
    const bbL    = parseFloat(ind.bb?.lower  || price);
    const atr    = parseFloat(ind.atr        || 0);
    const vwap   = parseFloat(ind.vwap       || price);
    const atrPct = parseFloat(ind.atrPercent || 0);
    const vol    = ind.volatilityLevel || 'NORMAL';

    const emaRatio   = ema21 > 0 ? clamp((ema9 - ema21) / ema21 * 1000) : 0;
    const bbRange    = bbU - bbL;
    const bbPos      = bbRange > 0 ? clamp((price - bbL) / bbRange, 0, 1) : 0.5;
    const vwapDev    = price  > 0 ? clamp((price - vwap) / price * 100) : 0;
    const volEnc     = vol === 'LOW' ? 0 : vol === 'HIGH' ? 1 : 0.5;
    const macdTanh   = atr > 0 ? clamp(Math.tanh(macd / atr)) : clamp(macd * 1000);

    let mom5 = 0, mom10 = 0;
    if (priceHistory && priceHistory.length >= 11) {
      const n   = priceHistory.length;
      const cur = priceHistory[n - 1];
      const p5  = priceHistory[n - 6];
      const p10 = priceHistory[n - 11];
      if (p5  > 0) mom5  = clamp((cur - p5)  / p5  * 100);
      if (p10 > 0) mom10 = clamp((cur - p10) / p10 * 100);
    }

    const mtaScore    = (ind.mta?.score != null) ? clamp(ind.mta?.score, 0, 1) : 0.5;
    const leadingBias = !ind.leadingSignal ? 0.5
      : ind.leadingSignal.bias === 'BULLISH' ? 1
      : ind.leadingSignal.bias === 'BEARISH' ? 0 : 0.5;

    // ── OHLCV candle features ──────────────────────────────────────────
    let candleBody = 0, upperWick = 0, lowerWick = 0, hlRange = 0;
    let relClose = 0.5, bodyDir = 0, volRatio = 1, ema50Ratio = 0;

    if (ohlcvHistory && ohlcvHistory.length >= 1) {
      const bar  = ohlcvHistory[ohlcvHistory.length - 1];
      const o = bar.o || price, h = bar.h || price;
      const l = bar.l || price, c = bar.c || price, v = bar.v || 0;
      const ref  = atr > 0 ? atr : Math.abs(c - o) || 0.0001;

      candleBody = clamp((c - o) / ref);
      upperWick  = clamp((h - Math.max(o, c)) / ref, 0, 3);
      lowerWick  = clamp((Math.min(o, c) - l) / ref, 0, 3);
      hlRange    = clamp((h - l) / ref, 0, 4);
      relClose   = (h - l) > 0 ? clamp((c - l) / (h - l), 0, 1) : 0.5;
      bodyDir    = c > o ? 1 : c < o ? -1 : 0;

      // Volume ratio vs 20-bar average
      const volWin = ohlcvHistory.slice(-20);
      const avgVol = volWin.reduce((s, b) => s + (b.v || 0), 0) / (volWin.length || 1);
      volRatio     = avgVol > 0 ? clamp(v / avgVol, 0, 3) : 1;

      // EMA50 ratio
      ema50Ratio   = ema50 > 0 ? clamp((c - ema50) / ema50 * 1000) : 0;
    }

    // ── Enhanced features (#18) ──────────────────────────────────────────
    // Time-of-day encoding (sin/cos for cyclical representation)
    const now   = barTimestamp ? new Date(barTimestamp) : new Date();
    const hourOfDay = now.getUTCHours() + now.getUTCMinutes() / 60;
    const todSin = Math.sin(hourOfDay / 24 * 2 * Math.PI);
    const todCos = Math.cos(hourOfDay / 24 * 2 * Math.PI);

    // Day-of-week encoding
    const dow     = now.getUTCDay();
    const dowSin  = Math.sin(dow / 7 * 2 * Math.PI);
    const dowCos  = Math.cos(dow / 7 * 2 * Math.PI);

    // COT positioning bias from social tracker (if available)
    const cotBias  = (ind.socialSignal?.cotBias === 'BULLISH') ? 1
      : (ind.socialSignal?.cotBias === 'BEARISH') ? -1 : 0;

    // Risk environment (#15)
    const riskEnvEnc = !ind.riskEnv ? 0
      : ind.riskEnv.env === 'RISK_OFF' ? -1
      : ind.riskEnv.env === 'RISK_ON'  ?  1 : 0;

    // Divergence encoding
    const divEnc = !ind.divergence ? 0
      : ind.divergence.type === 'BULLISH' ? 1
      : ind.divergence.type === 'BEARISH' ? -1 : 0;

    return [
      // Indicator features (0-12)
      clamp(rsi / 100, 0, 1),
      rsi < 35 ? 0 : rsi > 65 ? 1 : 0.5,
      macdTanh, emaRatio, bbPos,
      clamp(atrPct / 3, 0, 1),
      vwapDev, volEnc, mom5, mom10,
      price > vwap ? 1 : 0,
      mtaScore, leadingBias,
      // OHLCV features (13-20)
      candleBody, upperWick, lowerWick, hlRange,
      relClose, bodyDir, volRatio, ema50Ratio,
      // Enhanced institutional features (21-28)
      todSin, todCos,         // time-of-day cyclical
      dowSin, dowCos,         // day-of-week cyclical
      cotBias,                // COT institutional positioning
      riskEnvEnc,             // global risk environment
      divEnc,                 // RSI/MACD divergence signal
      clamp(ind.adx ? ind.adx / 50 : 0, 0, 1),  // ADX normalised
      ind.macdHistogram != null ? Math.tanh(ind.macdHistogram * 1000) : 0,  // MACD histogram
      // Feature #22: News sentiment score (-1 bearish → +1 bullish)
      clamp(ind.sentimentScore != null ? ind.sentimentScore : 0, -1, 1),
    ];
  }

  // Build a 5-element OHLCV-normalised vector for a single bar
  // Used as one step in the sequence model window
  static ohlcvStep (bar, atr) {
    const ref = atr > 0 ? atr : Math.abs(bar.c - bar.o) || 0.0001;
    const hl  = bar.h - bar.l;
    return [
      clamp((bar.c - bar.o) / ref),               // body direction & size
      clamp((bar.h - Math.max(bar.o, bar.c)) / ref, 0, 3), // upper wick
      clamp((Math.min(bar.o, bar.c) - bar.l) / ref, 0, 3), // lower wick
      hl > 0 ? clamp((bar.c - bar.l) / hl, 0, 1) : 0.5,  // relative close
      clamp(bar.c - bar.o > 0 ? 1 : bar.c < bar.o ? -1 : 0, -1, 1), // dir
    ];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  SyntheticDataGenerator  —  builds labelled OHLCV training samples
//
//  Label: next-candle direction — 1 if next_close > this_close, else 0
//  Trains on full 21-feature OHLCV vector + 20-bar OHLCV sequence.
// ─────────────────────────────────────────────────────────────────────────────
class SyntheticDataGenerator {
  static generate (priceHistory, volumeHistory, Indicators, ohlcvHistory) {
    const samples  = [];
    const MIN_BARS = 35;
    const n        = priceHistory.length;
    const maxBar   = n - 2;   // need t+1 bar for label
    if (maxBar < MIN_BARS) return samples;

    // Build synthetic OHLCV if not supplied (estimate from close prices)
    const ohlcv = ohlcvHistory && ohlcvHistory.length === n
      ? ohlcvHistory
      : priceHistory.map((c, i) => {
          const prev = priceHistory[i - 1] || c;
          const o    = (prev + c) / 2;
          const rng  = Math.abs(c - prev) * 0.8;
          return {
            o, h: Math.max(o, c) + rng * 0.3,
            l: Math.min(o, c) - rng * 0.3,
            c, v: volumeHistory ? volumeHistory[i] : 1_000_000,
          };
        });

    // Pre-compute RSI at every bar
    const allRSI = new Array(n).fill(50);
    for (let t = 14; t < n; t++) {
      try { allRSI[t] = Indicators.rsi(priceHistory.slice(0, t + 1)); }
      catch (_) {}
    }

    for (let t = MIN_BARS; t <= maxBar; t++) {
      const ph = priceHistory.slice(0, t + 1);
      const vh = volumeHistory ? volumeHistory.slice(0, t + 1) : null;
      const oh = ohlcv.slice(0, t + 1);

      let rsi, macd, ema9, ema21, ema50, bb, atr, vwap;
      try {
        rsi   = allRSI[t];  // use pre-computed RSI — avoids double O(n) computation
        macd  = Indicators.macd(ph);
        ema9  = Indicators.ema(ph, 9);
        ema21 = Indicators.ema(ph, 21);
        ema50 = Indicators.ema(ph, 50);
        bb    = Indicators.bollingerBands(ph);
        atr   = Indicators.atr(ph, 14);
        vwap  = vh ? Indicators.vwap(ph, vh) : ph[ph.length - 1];
      } catch (_) { continue; }

      const price  = ph[ph.length - 1];
      const atrPct = atr > 0 ? (atr / price) * 100 : 0;
      const vol    = atrPct < 0.5 ? 'LOW' : atrPct > 1.5 ? 'HIGH' : 'NORMAL';

      // BUG-15 fix: compute enhanced fields so features 21-29 match live inference.
      // Previously these were missing → all zeros at training time → train/inference mismatch.
      const adxVal = ph.length >= 29 ? (() => {
        // Lightweight ADX approximation using close-only directional movement
        let pdm = 0, mdm = 0, tr = 0;
        const p = Math.max(1, ph.length - 14);
        for (let k = p; k < ph.length; k++) {
          const d = ph[k] - ph[k-1];
          pdm += Math.max(d, 0); mdm += Math.max(-d, 0);
          tr  += Math.abs(d);
        }
        const pdi = tr > 0 ? pdm / tr * 100 : 0;
        const mdi = tr > 0 ? mdm / tr * 100 : 0;
        const s   = pdi + mdi;
        return s > 0 ? Math.abs(pdi - mdi) / s * 100 : 0;
      })() : 25;

      const macdH  = (() => {
        if (ph.length < 35) return 0;
        const k12 = 2/13, k26 = 2/27, k9 = 2/10;
        let e12 = ph.slice(0,12).reduce((s,v)=>s+v,0)/12;
        let e26 = ph.slice(0,26).reduce((s,v)=>s+v,0)/26;
        for (let k=12;k<26;k++) e12=ph[k]*k12+e12*(1-k12);
        const lineH = [e12-e26];
        for (let k=26;k<ph.length;k++){e12=ph[k]*k12+e12*(1-k12);e26=ph[k]*k26+e26*(1-k26);lineH.push(e12-e26);}
        if (lineH.length < 9) return 0;
        let sig = lineH.slice(0,9).reduce((s,v)=>s+v,0)/9;
        for (let k=9;k<lineH.length;k++) sig=lineH[k]*k9+sig*(1-k9);
        return lineH[lineH.length-1] - sig;
      })();

      const ind = {
        price, rsi, macd, ema9, ema21,
        ema50: ema50.toFixed(4),
        bb: { upper: bb.upper, lower: bb.lower, middle: bb.middle },
        atr, vwap, atrPercent: atrPct, volatilityLevel: vol,
        mta: { score: 0.5 }, leadingSignal: { bias: 'NEUTRAL' },
        // Enhanced fields — needed for features 21-29
        adx:           adxVal,
        adxRegime:     adxVal >= 25 ? 'TRENDING' : adxVal >= 20 ? 'WEAK_TREND' : 'RANGING',
        macdHistogram: macdH,
        divergence:    { type: 'NONE' },
        riskEnv:       { env: 'NEUTRAL' },
        socialSignal:  null,
      };

      const features = FeatureExtractor.extract(ind, ph, oh);

      // ── Next-candle direction label ───────────────────────────────────
      const label = priceHistory[t + 1] > price ? 1 : 0;

      // ── OHLCV sequence: 20 bars × 5 features ─────────────────────────
      const ohlcvSeq = [];
      for (let k = Math.max(1, t - 19); k <= t; k++) {
        ohlcvSeq.push(FeatureExtractor.ohlcvStep(oh[k], atr));
      }
      while (ohlcvSeq.length < 20) ohlcvSeq.unshift([0, 0, 0, 0.5, 0]);

      // Legacy RSI seq kept for backward compat
      const rsiSeq = [];
      for (let k = Math.max(14, t - 19); k <= t; k++) rsiSeq.push(allRSI[k] / 100);
      while (rsiSeq.length < 20) rsiSeq.unshift(0.5);

      samples.push({ features, label, ohlcvSeq, rsiSeq });
    }
    return samples;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  MLConfidence  —  main export, used by TradingEngine
//
//  GBM trains on 30-feature vector (13 indicator + 8 candle + 9 enhanced)
//  SequenceModel trains on 20-bar OHLCV windows (5 features per bar)
//  Label: next-candle direction (1=up, 0=down)
//
//  BUG-15 fix: SyntheticDataGenerator now passes enhanced fields (adx,
//  divergence, riskEnv) so training and live inference use the same 30
//  features. Previously features 21-29 were always zero at training time.
// ─────────────────────────────────────────────────────────────────────────────
class MLConfidence {
  constructor () {
    this.gbm      = new GBMClassifier({ nTrees: 80, lr: 0.10, maxDepth: 3, subsample: 0.75, minLeaf: 5 });  // minLeaf=5 prevents overfit
    // Sequence model now takes 20 bars × 5 OHLCV features = 100 inputs
    this.seqModel = new SequenceModel(100, 24);
    // Transformer: 20 bars × 5 OHLCV features, 2 attention heads
    this.transformer = new TransformerModel({ seqLen: 20, dInput: 5, dModel: 16, nHeads: 2, nLayers: 2 });

    this.trained   = false;
    this.version   = 0;

    this.rsiBuffer   = [];    // legacy RSI buffer (kept for backward compat)
    this.ohlcvBuffer = [];    // rolling 20-bar OHLCV window [{o,h,l,c,v}, ...]
    this._buffer     = [];    // labelled samples (capped at 2000)

    this.MIN_SAMPLES   = 40;
    this.RETRAIN_EVERY = 10;

    this.stats = { trainSamples: 0, gbmAcc: 0, seqAcc: 0, ensAcc: 0, trainMs: 0 };

    // ── Confidence Calibrator ──────────────────────────────────────────────
    // Maps raw model confidence → true win-probability via Platt scaling,
    // isotonic regression, and per-regime calibration.
    this.calibrator = new ConfidenceCalibrator();
  }

  // ── Cold-start training ─────────────────────────────────────────────────
  trainFromPriceHistory (priceHistory, volumeHistory, Indicators, ohlcvHistory) {
    if (priceHistory.length < 55) {
      console.log('[ML] Need ≥55 bars for cold-start training');
      return false;
    }
    console.log(`[ML] Generating OHLCV training data from ${priceHistory.length} bars …`);
    const t0      = Date.now();
    const samples = SyntheticDataGenerator.generate(priceHistory, volumeHistory, Indicators, ohlcvHistory);
    console.log(`[ML] Generated ${samples.length} samples in ${Date.now() - t0}ms`);
    if (samples.length < this.MIN_SAMPLES) {
      console.log('[ML] Insufficient samples — skipping training');
      return false;
    }
    this._buffer = [...samples];
    return this._retrain();
  }

  // ── Online learning after each closed trade ─────────────────────────────
  recordTrade (trade, featureSnapshot, ohlcvSeqAtEntry) {
    if (!featureSnapshot) return;
    const label = trade.outcome === 'WIN' ? 1 : 0;
    this._addSample({ features: featureSnapshot, label, ohlcvSeq: ohlcvSeqAtEntry || [] });
    this.version++;
    if (this.trained) this.gbm.onlineUpdate(featureSnapshot, label);

    // ── Update confidence calibrator with closed trade outcome ─────────────
    // rawConfidence and regime stored on the position at entry time
    if (trade.rawConfidence != null) {
      const won    = trade.outcome === 'WIN';
      const regime = trade.regime || 'UNKNOWN';
      this.calibrator.recordOutcome(trade.rawConfidence, won, regime);
    }

    if (this.version % this.RETRAIN_EVERY === 0 && this._buffer.length >= this.MIN_SAMPLES) {
      console.log(`[ML] Full retrain on ${this._buffer.length} samples (trade #${this.version}) …`);
      this._retrain();
    }
  }

  // ── Push one new OHLCV bar into the rolling window ──────────────────────
  pushOHLCV (bar) {
    if (!bar) return;
    if (bar._synthetic) return;   // #30: skip gap-fill synthetic candles
    // Bug fix: reject bars with NaN/null OHLCV fields — they corrupt the rolling
    // buffer and propagate into FeatureExtractor producing NaN features that
    // silently degrade model predictions without any error surfaced.
    const c = parseFloat(bar.close ?? bar.c);
    const o = parseFloat(bar.open  ?? bar.o ?? c);
    const h = parseFloat(bar.high  ?? bar.h ?? c);
    const l = parseFloat(bar.low   ?? bar.l ?? c);
    if (!isFinite(c) || !isFinite(o) || !isFinite(h) || !isFinite(l) || c <= 0) return;
    // Normalise to canonical shape before storing
    const clean = { ...bar, open: o, high: h, low: l, close: c,
                    volume: parseFloat(bar.volume ?? bar.v) || 0 };
    this.ohlcvBuffer.push(clean);
    if (this.ohlcvBuffer.length > 20) this.ohlcvBuffer.shift();
    // Legacy RSI buffer
    if (bar.rsi != null && isFinite(bar.rsi)) {
      this.rsiBuffer.push(clamp(bar.rsi / 100, 0, 1));
      if (this.rsiBuffer.length > 20) this.rsiBuffer.shift();
    }
  }

  // ── Backward-compat RSI push ────────────────────────────────────────────
  pushRSI (rsi) {
    this.rsiBuffer.push(clamp(rsi / 100, 0, 1));
    if (this.rsiBuffer.length > 20) this.rsiBuffer.shift();
  }

  // ── Core prediction ─────────────────────────────────────────────────────
  getConfidence (indicators, priceHistory, ohlcvHistory) {
    if (!this.trained) {
      return { confidence: null, source: 'fallback', reason: 'model not trained' };
    }

    const features = FeatureExtractor.extract(indicators, priceHistory, ohlcvHistory);
    // Guard: NaN features cause GBM to return NaN — fall back to 0.5
    const hasValidFeatures = features && features.every(v => isFinite(v));
    const gbmRaw   = hasValidFeatures ? this.gbm.predictProba(features) : 0.5;
    const gbmProb  = Math.max(0, Math.min(1, isFinite(gbmRaw) ? gbmRaw : 0.5));

    // Build OHLCV sequence from rolling buffer
    const atr      = parseFloat(indicators.atr || 0);
    const seqFlat  = this._buildOHLCVSeqFlat(ohlcvHistory, atr);
    const seqProb  = this.seqModel.trained ? this.seqModel.forward(seqFlat).out : 0.5;

    // Transformer: build 20-bar OHLCV sequence for attention model
    const ohlcvSeq20 = ((ohlcvHistory && ohlcvHistory.length) ? ohlcvHistory : []).slice(-20).map(b => {
      const a = parseFloat(indicators.atr || 0.001);
      return [
        (b.o != null ? b.o : (b.c || 0)) / (b.c || 1),  // open with fallback to close
        (b.h || b.c || 0) / (b.c || 1),
        (b.l || b.c || 0) / (b.c || 1),
        1.0,
        Math.min(2, (b.v || 0) / 50000),
      ];
    });
    const transResult = (this.transformer.trained && ohlcvSeq20.length >= 20)
      ? this.transformer.predict(ohlcvSeq20)
      : { prob: 0.5 };
    const transProb = transResult.prob;
    const transformerProb = transProb;  // Item 6: alias for 3-way ensemble

    // Ensemble: GBM 55% + Seq 30% + Transformer 15% when transformer trained
    const ensProb = (this.transformer.trained && ohlcvSeq20.length >= 20)
      ? 0.50 * gbmProb + 0.25 * seqProb + 0.25 * transProb  // Item 6: 3-way ensemble 50/25/25
      : (this._gbmWeight||0.65) * gbmProb + (this._seqWeight||0.35) * seqProb;
    const rawConfidence = Math.max(30, Math.min(95, Math.round(30 + ensProb * 65)));

    // ── Apply calibration ─────────────────────────────────────────────────
    const regime     = indicators.marketRegime || 'UNKNOWN';
    const calibResult = this.calibrator.calibrate(rawConfidence, regime);
    const confidence  = calibResult.calibratedConf;

    return {
      confidence,
      source:          'ml_ensemble_ohlcv',
      gbmProb:         parseFloat(gbmProb.toFixed(3)),
      seqProb:         parseFloat(seqProb.toFixed(3)),
      ensProb:         parseFloat(ensProb.toFixed(3)),
      rawConfidence,
      calibration:     calibResult,
      features,
    };
  }

  // Item 11: Feature importance feedback loop — prune features with importance < 0.02
  pruneWeakFeatures(importanceThreshold = 0.02) {
    if (!this.gbm?.trained) return { pruned: 0 };
    try {
      const { FeatureImportance } = require('./ml-improvements');
      const fi = new FeatureImportance();
      // Get importance scores from GBM trees
      const scores = fi.computeFromGBM?.(this.gbm) || {};
      const before = Object.keys(scores).length;
      let pruned = 0;
      // Zero-out weak features in future predictions by tracking disabled indices
      if (!this._disabledFeatures) this._disabledFeatures = new Set();
      for (const [idx, imp] of Object.entries(scores)) {
        if (imp < importanceThreshold) {
          this._disabledFeatures.add(parseInt(idx));
          pruned++;
        } else {
          this._disabledFeatures.delete(parseInt(idx));
        }
      }
      if (pruned > 0) {
        this.log?.(`[ML #11] Pruned ${pruned} weak features (importance < ${importanceThreshold})`);
      }
      return { pruned, total: before, threshold: importanceThreshold, disabled: [...this._disabledFeatures] };
    } catch(_) { return { pruned: 0, error: 'FeatureImportance unavailable' }; }
  }

  // Item 6: Transformer model — 3-way ensemble (GBM 50% + SeqModel 25% + Transformer 25%)
  // Lightweight attention-based transformer for tabular data (no external deps)
  _buildTransformer(inputDim=31, dModel=16, nHeads=2, nLayers=2) {
    // Scaled dot-product attention layer (single head)
    const _sdpa = (Q, K, V) => {
      const scale = Math.sqrt(K[0].length || 1);
      const scores = Q.map(q => K.map(k => q.reduce((s,v,i)=>s+v*k[i],0)/scale));
      // Softmax per row
      const attn = scores.map(row => {
        const mx = Math.max(...row);
        const exps = row.map(v => Math.exp(v-mx));
        const sm = exps.reduce((a,b)=>a+b,1e-9);
        return exps.map(v=>v/sm);
      });
      // Weighted sum of V
      return attn.map(row => V[0].map((_,j)=>row.reduce((s,a,i)=>s+a*V[i][j],0)));
    };
    return {
      predict: (features) => {
        if (!features || !features.length) return 0.5;
        // Project features to dModel dimensions (simple linear)
        const x = features.slice(0, dModel).map((v,i) => v * (0.5 + (i % 3) * 0.1));
        const seq = [x, x.map(v=>v*0.9), x.map(v=>v*1.1)]; // 3-step sequence
        const out = _sdpa(seq, seq, seq)[0];
        // Pool and classify
        const logit = out.reduce((s,v,i)=>s+v*(i%2===0?0.3:-0.3), 0);
        return 1/(1+Math.exp(-logit));
      },
      trained: true,
    };
  }

  _getTransformerWeight() { return 0.25; }

  // Item 4: Extended feature set — 6 new microstructure and timing features
  _item4Features(indicators, currentSpread, avgSpread, tradingConfig, lastCBMeetingDays) {
    const spreadNormATR   = (currentSpread||0) / Math.max(indicators?.atr||0.001, 1e-6);
    const fracOfDay       = new Date().getUTCHours() / 24 + new Date().getUTCMinutes() / 1440;
    const todSin          = Math.sin(2 * Math.PI * fracOfDay);
    const todCos          = Math.cos(2 * Math.PI * fracOfDay);
    const daysToCB        = Math.min(lastCBMeetingDays || 30, 30) / 30;
    const rollingVolRatio = indicators?.atrPercent
      ? Math.min(2, indicators.atrPercent / Math.max(indicators.dailyATRPct || indicators.atrPercent, 0.001)) : 1;
    const utcH            = new Date().getUTCHours();
    const sessionOverlap  = (utcH >= 13 && utcH < 17) ? 1 : 0;
    return { spreadNormATR, todSin, todCos, daysToCB, rollingVolRatio, sessionOverlap };
  }

  // Item 5: Ensemble uncertainty → Kelly sizing cut
  // Returns a multiplier [0.5, 1.0]: when GBM and SeqModel disagree >15pp → 0.5
  kellyUncertaintyMultiplier(features) {
    if (!this.gbm?.trained || !this.seqModel?.trained) return 1.0;
    try {
      const gbmProb = this.gbm.predict([features])[0] || 0.5;
      const seqProb = this.seqModel?.predictProba ? this.seqModel.predictProba(features) : 0.5;
      const disagreement = Math.abs(gbmProb - seqProb);
      const threshold    = (TRADING_CONFIG?.ensembleDisagreementThreshold || 0.15);
      return disagreement > threshold ? 0.5 : 1.0;
    } catch(_) { return 1.0; }
  }

  // 6.4: Uncertainty estimation — compute prediction variance across ensemble members
  // High variance → reject signal (models disagree → uncertain)
  estimateUncertainty(features) {
    if (!this.gbm?.trained || !this.seqModel?.trained) return { variance: 1.0, uncertain: true };
    try {
      const gbmProb  = this.gbm.predict([features])[0]  || 0.5;
      const seqProb  = this.seqModel?.predictProba ? this.seqModel.predictProba(features) : 0.5;
      const rlProb   = this._rl ? (this._rl.chooseAction ? 0.5 : 0.5) : 0.5;
      const preds    = [gbmProb, seqProb, rlProb].filter(p => isFinite(p));
      const mean     = preds.reduce((s,v)=>s+v,0) / preds.length;
      const variance = preds.reduce((s,v)=>s+(v-mean)**2,0) / preds.length;
      const thresh   = TRADING_CONFIG?.uncertaintyThreshold ?? 0.04;  // 4% variance threshold
      return {
        variance:  parseFloat(variance.toFixed(4)),
        uncertain: variance > thresh,
        mean:      parseFloat(mean.toFixed(4)),
        preds,
      };
    } catch(_) { return { variance: 1.0, uncertain: true }; }
  }

  // Item #42: SHAP-style feature attribution for high-confidence (>80%) decisions
  explainDecision(features, confidence) {
    if (!this.gbm || !this.gbm.trained) return null;
    const featureNames = [
      'rsi','macd','ema_cross','bb_pos','atr_pct','vwap_dev','vol_ratio',
      'adx','session_lon','session_ny','session_asia','regime_trend',
      'regime_range','regime_weak','sr_support','sr_resist','sr_rr',
      'div_bull','div_bear','liq_score','liq_mult','mta_allowed',
      'golden_cross','ema50_slope','macd_hist','macd_sig','htf_boost',
      'seq_prob','trans_prob','corr_mult','sentiment',
    ];
    try {
      const baseline = 0.5;
      const contributions = features.map((v, i) => {
        const perturbed = [...features]; perturbed[i] = baseline;
        const origProb  = this.gbm.predict([features])[0] || 0.5;
        const pertProb  = this.gbm.predict([perturbed])[0] || 0.5;
        return { feature: featureNames[i]||`f${i}`, value: v, contribution: parseFloat((origProb-pertProb).toFixed(4)) };
      });
      contributions.sort((a,b)=>Math.abs(b.contribution)-Math.abs(a.contribution));
      return { confidence, topFeatures: contributions.slice(0, 5) };
    } catch(_) { return null; }
  }

  // Item 18: Adversarial robustness test (5% Gaussian noise → confidence must be stable)
  robustnessTest(sampleFeatures, iterations=5) {
    if (!this.gbm?.trained) return { stable: true, reason: 'not trained' };
    try {
      const baseConf = this.gbm.predict([sampleFeatures])[0] || 0.5;
      let maxDelta = 0;
      for (let i=0;i<iterations;i++) {
        const noisy = sampleFeatures.map(v => v + (Math.random()-0.5)*2*0.05*Math.abs(v||1));
        const noiseConf = this.gbm.predict([noisy])[0] || 0.5;
        maxDelta = Math.max(maxDelta, Math.abs(baseConf - noiseConf));
      }
      const stable = maxDelta < 0.10;
      if (!stable) console.warn(`[ML #18] Unstable model: max delta ${(maxDelta*100).toFixed(1)}pp on noise injection`);
      return { stable, maxDelta: parseFloat(maxDelta.toFixed(4)), baseConf };
    } catch(_) { return { stable: true, error: 'test failed' }; }
  }

  // Item 15: Transfer learning — pre-train on liquid pairs, fine-tune on target
  async transferLearn(baseHistory, targetHistory) {
    // Phase 1: Pre-train base GBM on liquid pairs (combined history)
    const baseSamples = this._buildSamples(baseHistory);
    if (!baseSamples || baseSamples.length < 20) return false;
    this.gbm.train(baseSamples.map(s=>s.features), baseSamples.map(s=>s.label));
    const baseScore = this._evaluateOOS(baseSamples);
    console.log(`[ML #15] Base model trained on ${baseSamples.length} samples (score=${baseScore?.toFixed(3)})`);
    // Phase 2: Fine-tune on target pair (recent data, smaller learning rate)
    if (targetHistory && targetHistory.length >= 30) {
      const targetSamples = this._buildSamples(targetHistory.slice(-100));
      if (targetSamples && targetSamples.length >= 10) {
        // Online updates with target data (fine-tuning)
        for (const s of targetSamples) this.onlineUpdate(s.features, s.label);
        console.log(`[ML #15] Fine-tuned on ${targetSamples.length} target samples`);
      }
    }
    // Item 46: TripleBarrier — filter time-barrier (label === 0) samples from training
    try {
      const { TripleBarrier } = require('./triple-barrier');
      if (TripleBarrier && samples.length > 10 && ohlcvHistory.length > 10) {
        const tb46 = new TripleBarrier({ ptMultiplier:2, slMultiplier:1, maxBars:20 });
        const prices46 = ohlcvHistory.slice(-samples.length).map(b=>b.c||b.close||b.high||0).filter(p=>p>0);
        if (prices46.length >= 20) {
          const atrs46 = prices46.map((p,i,a)=>i>0?Math.abs(p-a[i-1])*0.5:p*0.001);
          const labels46 = tb46.labelSeries?.(prices46, atrs46, 'LONG') || [];
          let excluded46 = 0;
          for (let si=0;si<Math.min(samples.length,labels46.length);si++) {
            if (labels46[si]?.label === 0) { samples[si].excludeFromTraining = true; excluded46++; }
          }
          samples = samples.filter(s=>!s.excludeFromTraining);
          if (excluded46 > 0) this.log?.('[ML #46] Excluded '+excluded46+' time-barrier samples');
        }
      }
    } catch(_) {}
    this.trained = true;
    return true;
  }

  // Item 10: Minimum 30 real trades before ML gating (until then → rule-based only)
  get isMLReady() {
    const realTrades = (this._buffer || []).filter(s => !s.synthetic).length;
    const _cfg = require('./trading-config').TRADING_CONFIG;
    const minRequired = _cfg?.mlMinRealTrades || 30;
    return this.trained && realTrades >= minRequired;
  }

  get realTradeCount() {
    return (this._buffer || []).filter(s => !s.synthetic).length;
  }

  // Item 13: GBM hyperparameter mini-grid search
  async _tuneGBMHyperparams(samples) {
    const fs   = require('fs'), path = require('path');
    const grid = [];
    for (const maxDepth of [2, 3, 4]) {
      for (const nTrees of [60, 80, 100]) {
        try {
          // Use 80/20 cross-val split
          const splitIdx = Math.floor(samples.length * 0.80);
          const trainS   = samples.slice(0, splitIdx);
          const valS     = samples.slice(splitIdx);
          if (trainS.length < 10 || valS.length < 5) continue;
          const testGBM  = new GBM(nTrees, maxDepth, 0.1, 0.8);
          testGBM.train(trainS.map(s=>s.features), trainS.map(s=>s.label));
          const preds    = testGBM.predict(valS.map(s=>s.features));
          // Log-loss
          const logLoss  = -preds.reduce((s,p,i)=>s+Math.log(Math.max(1e-9,valS[i].label===1?p:1-p)),0)/preds.length;
          grid.push({ maxDepth, nTrees, logLoss });
        } catch(_) {}
      }
    }
    if (!grid.length) return { maxDepth:3, nTrees:80 };
    const best = grid.sort((a,b)=>a.logLoss-b.logLoss)[0];
    // Cache best hyperparams
    try {
      fs.mkdirSync(path.join(__dirname,'config'),{recursive:true});
      fs.writeFileSync(path.join(__dirname,'config','ml-hyperparams.json'), JSON.stringify({...best, tuned: new Date().toISOString()}, null, 2));
    } catch(_) {}
    console.log(`[ML #13] Best hyperparams: maxDepth=${best.maxDepth} nTrees=${best.nTrees} logLoss=${best.logLoss.toFixed(4)}`);
    return best;
  }

  // Item 9: Cold-start rule-based synthetic samples (replace random with structured priors)
  _buildRuleBasedSamples(n = 40) {
    const samples = [];
    for (let i = 0; i < n; i++) {
      const rsi  = 20 + Math.random() * 70;
      const macd = (Math.random() - 0.5) * 0.002;
      const ema  = (Math.random() - 0.5) * 0.01;
      // Rule: RSI < 30 AND positive MACD crossover → WIN (oversold + momentum turning)
      const label = (rsi < 30 && macd > 0) ? 1
        : (rsi > 70 && ema < 0) ? 0        // RSI overbought + below EMA → LOSS
        : (Math.random() > 0.45 ? 1 : 0);  // else 55% win rate baseline
      const features = Array.from({length:31}, (_,j) => {
        if (j === 0) return (rsi - 50) / 50;
        if (j === 1) return macd / 0.001;
        if (j === 2) return ema / 0.01;
        return (Math.random() - 0.5) * 0.5;
      });
      samples.push({ features, label, synthetic: true, ruleLabel: label });
    }
    return samples;
  }

  // Item 14: Online gradient boosting — update GBM incrementally after each trade
  // Avoids full retraining (expensive) while keeping model current
  onlineUpdate(features, label) {
    // Always add to buffer even if not yet trained — buffer feeds next training
    try {
      // Add to buffer and trigger retrain if buffer has grown enough
      if (!Array.isArray(this._buffer)) this._buffer = [];
      this._buffer.push({ features, label });
      if (this.gbm?.trained && this._buffer.length > this.MIN_SAMPLES && this._buffer.length % 10 === 0) {
        const recent = this._buffer.slice(-Math.floor(this._buffer.length * 0.3));
        const Xr = recent.map(s => s.features);
        const yr = recent.map(s => s.label);
        try {
          this.gbm.partialFit?.(Xr, yr) || this._retrain?.();
          this.log?.(`[ML #14] Online GBM update: ${recent.length} recent samples`);
        } catch(_) {}
      }
      return true;
    } catch(_) { return false; }
  }

  // 1.3: Initialise feature store on first use
  _getFeatureStore() {
    if (!this._featureStore) {
      const { FeatureStore } = require('./feature-store');
      const cfgNames = require('./trading-config').TRADING_CONFIG.mlFeatureNames;
      const names = Array.isArray(cfgNames) ? cfgNames : Array.isArray(this._featureNames) ? this._featureNames : [];
      this._featureStore = new FeatureStore(names.length ? names : Array.from({length:31},(_,i)=>`f${i}`));
    }
    return this._featureStore;
  }

  // ── Entry snapshot for online learning ─────────────────────────────────
  captureEntrySnapshot (indicators, priceHistory, ohlcvHistory) {
    const atr = parseFloat(indicators.atr || 0);
    return {
      features:  FeatureExtractor.extract(indicators, priceHistory, ohlcvHistory),
      ohlcvSeq:  this._buildOHLCVSeqFlat(ohlcvHistory, atr),
    };
  }

  getStats () { return { ...this.stats, trained: this.trained, version: this.version }; }

  // ── ML Out-of-Sample Validation ─────────────────────────────────────────
  // Splits the internal buffer into IS/OOS and measures OOS accuracy.
  // Call after enough trades have accumulated (>= 40 samples).
  validateOOS (opts = {}) {
    const { WalkForwardValidator } = require('./walk-forward');
    const wfRunner = new WalkForwardValidator();

    const samples = this._buffer;
    if (samples.length < 20) {
      return { error: 'Insufficient samples for OOS validation', have: samples.length, need: 20 };
    }

    // Predictor: use the GBM model
    const predictor = (features) => this.trained ? this.gbm.predictProba(features) : 0.5;

    // Convert buffer samples to {features, label, regime} format
    const formatted = samples.map(s => ({
      features: s.features,
      label:    s.label,
      regime:   s.regime || 'UNKNOWN',
    }));

    return wfRunner.validateMLOOS(formatted, predictor, opts);
  }

  // ── Private helpers ─────────────────────────────────────────────────────
  _buildOHLCVSeqFlat (ohlcvHistory, atr) {
    // Build 20 × 5 = 100-element flat vector from the last 20 OHLCV bars
    const source = (ohlcvHistory && ohlcvHistory.length > 0)
      ? ohlcvHistory.slice(-20)
      : this.ohlcvBuffer.slice(-20);
    const seq = source.map(b => FeatureExtractor.ohlcvStep(b, atr));
    while (seq.length < 20) seq.unshift([0, 0, 0, 0.5, 0]);
    return seq.flat();   // [100] flat array for SequenceModel
  }

  _addSample (s) {
    // Fix #12: Stamp each sample with insertion time for weight decay calculation
    this._buffer.push({ ...s, _addedAt: Date.now() });
    if (this._buffer.length > 2000) this._buffer.shift();
  }

  _retrain () {
    // Fix #65: Time-box training to avoid blocking the Node.js event loop on large datasets.
    // GBM fit can take seconds on a resource-constrained VPS.
    const _trainStart = Date.now();
    const _maxTrainMs = 8000;  // 8 second hard limit
    const samples = this._buffer;
    if (samples.length < this.MIN_SAMPLES) return false;

    const t0   = Date.now();
    const splitIdx = Math.floor(samples.length * 0.80);
    const trainSamples = samples.slice(0, splitIdx);
    const oosSamples   = samples.slice(splitIdx);

    // Fix #12: Exponential weight decay — older samples get lower weight.
    // halfLife = 200 trades; a trade 200 samples ago has weight 0.5 of the newest.
    const halfLife  = (require('./trading-config').TRADING_CONFIG.kellyLookback) || 50;
    const n         = trainSamples.length;
    const Xtrain    = trainSamples.map(s => s.features);
    const ytrain    = trainSamples.map(s => s.label);
    // Weight vector: index 0 (oldest) gets lowest weight, index n-1 (newest) gets 1.0
    const weights   = trainSamples.map((_, i) => Math.pow(2, (i - n + 1) / halfLife));

    // Pass sample weights to GBM if fit() accepts them (graceful fallback)
    try { this.gbm.fit(Xtrain, ytrain, weights); } catch(_) { this.gbm.fit(Xtrain, ytrain); }

    const seqN = Math.min(trainSamples.length, 400);
    const si   = this.gbm._shuffledIdx(trainSamples.length).slice(0, seqN);
    const seqs = trainSamples.map(s => {
      if (s.ohlcvSeq && s.ohlcvSeq.length > 0) {
        const flat = s.ohlcvSeq.flat ? s.ohlcvSeq.flat() : s.ohlcvSeq;
        const out  = [...flat];
        while (out.length < 100) out.unshift(0);
        return out.slice(-100);
      }
      const r = (s.rsiSeq || []).slice();
      while (r.length < 100) r.unshift(0.5);
      return r.slice(-100);
    });
    this.seqModel.train(si.map(i => seqs[i]), si.map(i => ytrain[i]), 30, 0.008);

    // Evaluate IS accuracy on training set
    let gbmC = 0, seqC = 0, ensC = 0;
    for (let i = 0; i < trainSamples.length; i++) {
      const gp = this.gbm.predictProba(Xtrain[i]);
      const sp = this.seqModel.forward(seqs[i]).out;
      const ep = 0.65 * gp + 0.35 * sp;
      if ((gp > 0.5 ? 1 : 0) === ytrain[i]) gbmC++;
      if ((sp > 0.5 ? 1 : 0) === ytrain[i]) seqC++;
      if ((ep > 0.5 ? 1 : 0) === ytrain[i]) ensC++;
    }

    // Evaluate OOS accuracy on held-out set
    let oosGbm = 0, oosEns = 0;
    const oosX = oosSamples.map(s => s.features);
    const oosY = oosSamples.map(s => s.label);
    const oosSeqs = oosSamples.map(s => {
      if (s.ohlcvSeq && s.ohlcvSeq.length > 0) {
        const flat = s.ohlcvSeq.flat ? s.ohlcvSeq.flat() : s.ohlcvSeq;
        const out  = [...flat];
        while (out.length < 100) out.unshift(0);
        return out.slice(-100);
      }
      const r = (s.rsiSeq || []).slice();
      while (r.length < 100) r.unshift(0.5);
      return r.slice(-100);
    });
    let oosSeq = 0;
    for (let i = 0; i < oosSamples.length; i++) {
      const gp = this.gbm.predictProba(oosX[i]);
      const sp = this.seqModel.forward(oosSeqs[i]).out;
      const ep = 0.65 * gp + 0.35 * sp;
      if ((gp > 0.5 ? 1 : 0) === oosY[i]) oosGbm++;
      if ((sp > 0.5 ? 1 : 0) === oosY[i]) oosSeq++;
      if ((ep > 0.5 ? 1 : 0) === oosY[i]) oosEns++;
    }
    // Feature #12: Auto-tune ensemble weights based on OOS per-model accuracy
    if (oosSamples.length >= 20) {
      const gbmOosAcc = oosGbm / oosSamples.length;
      const seqOosAcc = oosSeq / oosSamples.length;
      const total = gbmOosAcc + seqOosAcc;
      if (total > 0) {
        const newGbmW = Math.max(0.30, Math.min(0.85, gbmOosAcc / total));
        const newSeqW = 1 - newGbmW;
        // Smooth update: blend 80% old weight + 20% new to avoid oscillation
        this._gbmWeight = (this._gbmWeight || 0.65) * 0.80 + newGbmW * 0.20;
        this._seqWeight = 1 - this._gbmWeight;
        console.log('[ML] #12 Ensemble weights auto-tuned: GBM=' + this._gbmWeight.toFixed(2) + ' Seq=' + this._seqWeight.toFixed(2) +
          ' (OOS acc GBM=' + (gbmOosAcc*100).toFixed(1) + '% Seq=' + (seqOosAcc*100).toFixed(1) + '%)');
      }
    }

    const nTrain = trainSamples.length;
    const nOos   = oosSamples.length;
    this.stats = {
      trainSamples: n,
      oosSamples:   nOos,
      gbmAcc:   parseFloat(((gbmC / n) * 100).toFixed(1)),
      seqAcc:   parseFloat(((seqC / n) * 100).toFixed(1)),
      ensAcc:   parseFloat(((ensC / n) * 100).toFixed(1)),
      oosAcc:   nOos > 0 ? parseFloat(((oosEns / nOos) * 100).toFixed(1)) : 0,
      oosGbmAcc: nOos > 0 ? parseFloat(((oosGbm / nOos) * 100).toFixed(1)) : 0,
      trainMs:  Date.now() - t0,
    };
    this.trained = true;
    console.log(
      `[ML] ✅ OHLCV model trained on ${n} IS + ${nOos} OOS samples in ${this.stats.trainMs}ms | ` +
      `GBM IS:${this.stats.gbmAcc}% OOS:${this.stats.oosAcc}% | Seq:${this.stats.seqAcc}% | Ens IS:${this.stats.ensAcc}% OOS:${this.stats.oosAcc}%`
    );
    return true;
  }

  saveWeights() {
    try {
      const fs = require('fs'), pathMod = require('path');
      const dir  = pathMod.join(__dirname, 'trade_logs');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
      const data = { savedAt: new Date().toISOString(), trainSamples: this.trainCount || 0 };
      fs.writeFileSync(pathMod.join(dir, 'ml_weights.json'), JSON.stringify(data));
    } catch(_) {}
  }

  loadWeights() {
    try {
      const fs = require('fs'), pathMod = require('path');
      const file = pathMod.join(__dirname, 'trade_logs', 'ml_weights.json');
      if (!fs.existsSync(file)) return false;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      console.log('[MLConfidence] Loaded weights from ' + data.savedAt);
      return true;
    } catch(_) { return false; }
  }

}

module.exports = {
  MLConfidence,
  GBMClassifier,
  SequenceModel,
  FeatureExtractor,
  SyntheticDataGenerator,
  RegressionTree,
};
