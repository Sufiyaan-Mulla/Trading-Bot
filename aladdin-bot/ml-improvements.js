'use strict';
// ── ml-improvements.js ────────────────────────────────────────────────────────
// IMPROVEMENT #7-11: ML & AI Enhancements
//
//   #7  RegimeMLRouter       — separate GBM models per regime (TRENDING/RANGING)
//   #8  FeatureImportance    — permutation importance tracking across trades
//   #9  ConceptDriftDetector — Brier score monitoring + auto-retrain trigger
//   #10 EnsembleUncertainty  — disagreement between GBM & Transformer → sizing
//   #11 QLearningLayer       — simple Q-table RL layer on top of rule engine
// ─────────────────────────────────────────────────────────────────────────────

// ── #7: Regime-Conditioned ML Router ─────────────────────────────────────────
// Maintains separate model state per regime so features are weighted
// differently in trending vs ranging markets.
class RegimeMLRouter {
  constructor() {
    // Store last N predictions + outcomes per regime for calibration
    this._regimeData = {
      TRENDING:   { predictions: [], outcomes: [], accuracy: null },
      RANGING:    { predictions: [], outcomes: [], accuracy: null },
      WEAK_TREND: { predictions: [], outcomes: [], accuracy: null },
    };
    this._windowSize = 30;  // rolling window of last 30 trades per regime
  }

  // Record a prediction + eventual outcome
  record(regime, predictedProb, actualWin) {
    const key = this._normalizeRegime(regime);
    const d   = this._regimeData[key];
    d.predictions.push(predictedProb);
    d.outcomes.push(actualWin ? 1 : 0);
    if (d.predictions.length > this._windowSize) {
      d.predictions.shift(); d.outcomes.shift();
    }
    // Recompute accuracy
    if (d.outcomes.length >= 5) {
      const correct = d.predictions.reduce((s, p, i) =>
        s + ((p >= 0.5) === (d.outcomes[i] === 1) ? 1 : 0), 0);
      d.accuracy = correct / d.outcomes.length;
    }
  }

  // Get regime-specific confidence multiplier
  // If model is poor in this regime, reduce confidence
  getRegimeMultiplier(regime) {
    const key = this._normalizeRegime(regime);
    const acc = this._regimeData[key].accuracy;
    if (acc === null) return 1.0;  // no data yet
    if (acc >= 0.60) return 1.10;  // model reliable in this regime → boost slightly
    if (acc >= 0.50) return 1.00;  // ok
    if (acc >= 0.40) return 0.85;  // below-chance → reduce confidence
    return 0.70;                   // poor → significantly reduce
  }

  // Get regime stats summary
  summary() {
    return Object.entries(this._regimeData).map(([regime, d]) => ({
      regime,
      trades: d.outcomes.length,
      accuracy: d.accuracy != null ? (d.accuracy * 100).toFixed(1) + '%' : 'N/A',
      multiplier: this.getRegimeMultiplier(regime).toFixed(2),
    }));
  }

  _normalizeRegime(r) {
    if (r === 'TRENDING' || r === 'STRONG_TREND') return 'TRENDING';
    if (r === 'RANGING')  return 'RANGING';
    return 'WEAK_TREND';
  }
}

// ── #8: Feature Importance Tracker ────────────────────────────────────────────
// Permutation importance: for each closed trade, which features had extreme values?
// After 50+ trades, rank features by their correlation with winning trades.
class FeatureImportance {
  constructor() {
    this._tradeFeatures = [];  // { features: {rsi, macd, ...}, won: bool }
    this._maxHistory    = 100;
  }

  // Record features at trade entry and eventual outcome
  record(features, won) {
    this._tradeFeatures.push({ features: { ...features }, won });
    if (this._tradeFeatures.length > this._maxHistory) this._tradeFeatures.shift();
  }

  // Compute simple correlation between each feature and trade outcome
  // Returns sorted array of { feature, correlation, winAvg, lossAvg }
  compute() {
    if (this._tradeFeatures.length < 10) return [];

    const featureNames = Object.keys(this._tradeFeatures[0].features).filter(k => {
      const v = this._tradeFeatures[0].features[k];
      return typeof v === 'number' && isFinite(v);
    });

    const results = featureNames.map(name => {
      const wins   = this._tradeFeatures.filter(t => t.won  && isFinite(t.features[name]));
      const losses = this._tradeFeatures.filter(t => !t.won && isFinite(t.features[name]));
      const winAvg  = wins.length   ? wins.reduce((s, t)   => s + t.features[name], 0) / wins.length   : 0;
      const lossAvg = losses.length ? losses.reduce((s, t) => s + t.features[name], 0) / losses.length : 0;

      // Point-biserial correlation approximation
      const all    = this._tradeFeatures.filter(t => isFinite(t.features[name]));
      const mean   = all.reduce((s, t) => s + t.features[name], 0) / all.length;
      const std    = Math.sqrt(all.reduce((s, t) => s + (t.features[name] - mean) ** 2, 0) / all.length) || 1;
      const winRate = all.filter(t => t.won).length / all.length;
      const corr   = (winAvg - mean) / std * Math.sqrt(winRate * (1 - winRate));

      return { feature: name, correlation: parseFloat(corr.toFixed(4)), winAvg, lossAvg };
    });

    return results.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
  }

  topFeatures(n = 5) {
    return this.compute().slice(0, n);
  }
}

// ── #9: Concept Drift Detector ────────────────────────────────────────────────
// Tracks Brier Score (mean squared error of predicted prob vs actual outcome).
// Spikes in Brier score = model has drifted = trigger retraining.
class ConceptDriftDetector {
  constructor(windowSize = 20, threshold = 0.30) {
    this._window    = [];     // { predicted, actual } tuples
    this._windowSize = windowSize;
    this._threshold  = threshold;   // Brier score above this = drift detected
    this._brierHistory = [];
    this._driftCount   = 0;
    this._lastDriftAt  = null;
  }

  // Add a prediction (0-1 probability) and its actual outcome (true/false)
  add(predictedProb, actualWin) {
    this._window.push({ predicted: predictedProb, actual: actualWin ? 1 : 0 });
    if (this._window.length > this._windowSize) this._window.shift();
  }

  // Compute rolling Brier score (lower = better, 0.25 = random guessing)
  brierScore() {
    if (this._window.length < 5) return 0.25;
    const mse = this._window.reduce((s, e) =>
      s + (e.predicted - e.actual) ** 2, 0) / this._window.length;
    return parseFloat(mse.toFixed(4));
  }

  // Returns true if drift detected and retraining should be triggered
  isDrifting() {
    const bs = this.brierScore();
    this._brierHistory.push(bs);
    if (this._brierHistory.length > 50) this._brierHistory.shift();

    const drifting = bs > this._threshold && this._window.length >= this._windowSize;
    if (drifting) {
      this._driftCount++;
      this._lastDriftAt = new Date().toISOString();
    }
    return drifting;
  }

  status() {
    const bs  = this.brierScore();
    const avg = this._brierHistory.length
      ? this._brierHistory.reduce((s, v) => s + v, 0) / this._brierHistory.length
      : 0.25;
    return {
      currentBrier:  bs,
      avgBrier:      parseFloat(avg.toFixed(4)),
      drifting:      bs > this._threshold,
      driftCount:    this._driftCount,
      lastDriftAt:   this._lastDriftAt,
      sampleSize:    this._window.length,
      threshold:     this._threshold,
      quality:       bs < 0.15 ? 'EXCELLENT' : bs < 0.20 ? 'GOOD' : bs < 0.25 ? 'OK' : bs < 0.30 ? 'DEGRADED' : 'POOR',
    };
  }
}

// ── #10: Ensemble Uncertainty / Disagreement ──────────────────────────────────
// When GBM and Transformer disagree significantly, confidence is genuinely
// uncertain. This module measures disagreement and suggests position sizing.
class EnsembleUncertainty {
  constructor(disagreementThreshold = 20) {
    this._threshold   = disagreementThreshold;  // % points of disagreement
    this._history     = [];
    this._maxHistory  = 50;
  }

  // gbmConf and transformerConf are both 0-100
  // Returns: { disagreement, sizeMultiplier, shouldHold, reason }
  evaluate(gbmConf, transformerConf, gbmAction, transformerAction) {
    const disagreement = Math.abs(gbmConf - transformerConf);
    const actionConflict = gbmAction !== transformerAction &&
      gbmAction !== 'HOLD' && transformerAction !== 'HOLD';

    this._history.push({ disagreement, actionConflict });
    if (this._history.length > this._maxHistory) this._history.shift();

    // If actions conflict → very uncertain, don't trade
    if (actionConflict) {
      return {
        disagreement,
        sizeMultiplier: 0,
        shouldHold:     true,
        reason: `Ensemble conflict: GBM=${gbmAction}(${gbmConf}%) vs Transformer=${transformerAction}(${transformerConf}%)`,
      };
    }

    // Actions agree but confidence gap is large → reduce size
    if (disagreement > this._threshold * 2) {
      return {
        disagreement,
        sizeMultiplier: 0.50,
        shouldHold:     false,
        reason: `High disagreement (${disagreement.toFixed(0)}pts) — half position`,
      };
    }
    if (disagreement > this._threshold) {
      return {
        disagreement,
        sizeMultiplier: 0.75,
        shouldHold:     false,
        reason: `Moderate disagreement (${disagreement.toFixed(0)}pts) — reduced position`,
      };
    }

    // Models agree: boost slightly
    return {
      disagreement,
      sizeMultiplier: disagreement < 5 ? 1.10 : 1.0,
      shouldHold:     false,
      reason: `Models aligned (${disagreement.toFixed(0)}pts gap)`,
    };
  }

  avgDisagreement() {
    if (!this._history.length) return 0;
    return this._history.reduce((s, h) => s + h.disagreement, 0) / this._history.length;
  }
}

// ── #11: Q-Learning RL Layer ──────────────────────────────────────────────────
// Simple tabular Q-learning on top of the rule engine.
// State = (RSI bucket, MACD direction, ADX regime)
// Actions = BUY, SELL, HOLD
// Reward = trade P&L as fraction of capital
class QLearning {
  constructor(alpha = 0.1, gamma = 0.9, epsilon = 0.1) {
    this._alpha   = alpha;
    this._gamma   = gamma;
    this._epsilon = epsilon;
    this._Q       = { _version: QLearning.FORMAT_VERSION };  // Fix #69: stamp version on init
    this._lastState  = null;
    this._lastAction = null;
    this._totalUpdates = 0;
    this._epsilonDecay = 0.995;
    this._epsilonMin   = 0.01;
  }

  // Discretize continuous indicators into a state key
  _stateKey(indicators) {
    // Fix #20: Fixed-width 10-bucket RSI discretisation (was 3-5 inconsistent buckets).
    // RSI 49.99 and 50.01 now land in the same bucket, reducing state-space explosion.
    const rsi = indicators.rsi || 50;
    const rsiBucket = Math.min(9, Math.floor(rsi / 10));  // 0-9 (0=0-9, 9=90-99)
    const macd   = (indicators.macd || 0) > 0 ? 'P' : 'N';
    const regime = (indicators.adxRegime || indicators.marketRegime || 'UNK').slice(0, 3).toUpperCase();
    const session = (indicators.session || 'UK').slice(0, 2).toUpperCase();
    // 7.2: Add HMM regime state and vol-of-vol context to RL state
    const hmmState = (indicators.hmmRegime?.name || 'UNKNOWN').slice(0,4).toUpperCase();
    const volCtx   = indicators.atrPercent > 1.5 ? 'HV' : indicators.atrPercent < 0.5 ? 'LV' : 'NV';
    return `R${rsiBucket}_${macd}_${hmmState}_${session}_${volCtx}`;
  }

  // Fix #69: Q-table version check — discard stale Q-tables on scheme change
  static get FORMAT_VERSION() { return 2; }  // increment when _stateKey scheme changes

  _validateQTable() {
    if (this._Q._version && this._Q._version !== QLearning.FORMAT_VERSION) {
      console.warn(`[QL] Q-table version ${this._Q._version} !== expected ${QLearning.FORMAT_VERSION} — discarding stale Q-table`);
      this._Q = { _version: QLearning.FORMAT_VERSION };
    } else if (!this._Q._version) {
      this._Q._version = QLearning.FORMAT_VERSION;
    }
  }

  _initState(key) {
    if (!this._Q[key]) this._Q[key] = { BUY: 0, SELL: 0, HOLD: 0 };
  }

  // Choose action: epsilon-greedy exploration
  chooseAction(indicators) {
    const key = this._stateKey(indicators);
    this._initState(key);
    this._lastState = key;

    // Explore
    if (Math.random() < this._epsilon) {
      const actions = ['BUY', 'SELL', 'HOLD'];
      const action  = actions[Math.floor(Math.random() * actions.length)];
      this._lastAction = action;
      return { action, qBased: false, key, qValues: this._Q[key] };
    }

    // Exploit: choose max Q
    const q      = this._Q[key];
    const action = Object.keys(q).reduce((best, a) => q[a] > q[best] ? a : best, 'HOLD');
    this._lastAction = action;
    return { action, qBased: true, key, qValues: q };
  }

  // 7.1: Reward shaping — combine Sharpe, drawdown penalty, trade efficiency
  // Pure P&L reward leads to RL gambling; shaped reward produces stable behaviour
  static shapeReward(trade, portfolio) {
    if (!trade) return 0;
    const rawReturn   = trade.profitPercent || 0;
    // Sharpe contribution: normalise by recent volatility
    const vol         = portfolio?.recentVol || 1;
    const sharpeContrib = vol > 0 ? rawReturn / vol : rawReturn;
    // Drawdown penalty: punish if this trade increased drawdown
    const ddPenalty   = (portfolio?.drawdown || 0) > 0.10 ? -0.5 * Math.abs(rawReturn) : 0;
    // Trade efficiency: reward quick profitable exits, penalise long losers
    const barsHeld    = trade.barsHeld || 1;
    const efficiency  = rawReturn / Math.max(1, Math.log(barsHeld + 1));
    // Weighted combination
    return 0.50 * sharpeContrib + 0.30 * efficiency + 0.20 * ddPenalty;
  }

  // Update Q-table after trade closes with reward
  update(nextIndicators, reward) {
    if (!this._lastState || !this._lastAction) return;

    const nextKey = this._stateKey(nextIndicators);
    this._initState(nextKey);

    const oldQ = this._Q[this._lastState][this._lastAction];
    const maxNextQ = Math.max(...Object.values(this._Q[nextKey]));

    // Q-learning update: Q(s,a) = Q(s,a) + α * (r + γ * maxQ(s') - Q(s,a))
    const newQ = oldQ + this._alpha * (reward + this._gamma * maxNextQ - oldQ);
    this._Q[this._lastState][this._lastAction] = parseFloat(newQ.toFixed(6));

    this._totalUpdates++;
    // Decay epsilon
    this._epsilon = Math.max(this._epsilonMin, this._epsilon * this._epsilonDecay);
  }

  stats() {
    const states = Object.keys(this._Q).length;
    return {
      states,
      totalUpdates: this._totalUpdates,
      epsilon:      parseFloat(this._epsilon.toFixed(4)),
      topStates:    Object.entries(this._Q)
        .map(([k, v]) => ({ state: k, bestAction: Object.keys(v).reduce((b, a) => v[a] > v[b] ? a : b, 'HOLD'), value: Math.max(...Object.values(v)) }))
        .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
        .slice(0, 5),
    };
  }
}

// Item 40: Out-of-bag error estimate for ensemble uncertainty
function computeOOBError(predictions, trueLabels) {
  if (!predictions || !predictions.length || !trueLabels) return null;
  const n = trueLabels.length;
  let errors = 0;
  for (let i=0;i<n;i++) {
    const votes = predictions.map(p=>(p[i]||0)>=0.5?1:0);
    const majority = votes.filter(v=>v===1).length >= votes.length/2 ? 1 : 0;
    if (majority !== trueLabels[i]) errors++;
  }
  return { oobError: parseFloat((errors/n).toFixed(4)), oobAccuracy: parseFloat((1-errors/n).toFixed(4)), n };
}

// Item 14: Gated Recurrent Unit (GRU) — proper LSTM-style gating for sequence model
class GRUCell {
  constructor(inputSize, hiddenSize) {
    this.inputSize  = inputSize;
    this.hiddenSize = hiddenSize;
    // Xavier init
    const k = 1 / Math.sqrt(hiddenSize);
    const rand = () => (Math.random() * 2 - 1) * k;
    this.Wz = Array.from({length:hiddenSize},()=>Array.from({length:inputSize+hiddenSize},rand));
    this.Wr = Array.from({length:hiddenSize},()=>Array.from({length:inputSize+hiddenSize},rand));
    this.Wh = Array.from({length:hiddenSize},()=>Array.from({length:inputSize+hiddenSize},rand));
    this.bz = Array.from({length:hiddenSize},()=>0);
    this.br = Array.from({length:hiddenSize},()=>0);
    this.bh = Array.from({length:hiddenSize},()=>0);
    this.h  = Array.from({length:hiddenSize},()=>0);
  }
  _sig(x) { return 1/(1+Math.exp(-Math.max(-20,Math.min(20,x)))); }
  _tanh(x) { const e=Math.exp(Math.max(-20,Math.min(20,2*x))); return (e-1)/(e+1); }
  forward(x) {
    const xh = [...x, ...this.h];
    const z  = this.Wz.map((w,i)=>this._sig(w.reduce((s,v,j)=>s+v*xh[j],0)+this.bz[i]));
    const r  = this.Wr.map((w,i)=>this._sig(w.reduce((s,v,j)=>s+v*xh[j],0)+this.br[i]));
    const xrh= [...x, ...this.h.map((v,i)=>r[i]*v)];
    const hc = this.Wh.map((w,i)=>this._tanh(w.reduce((s,v,j)=>s+v*xrh[j],0)+this.bh[i]));
    this.h   = this.h.map((v,i)=>(1-z[i])*v+z[i]*hc[i]);
    return [...this.h];
  }
  reset() { this.h = Array.from({length:this.hiddenSize},()=>0); }
}

class GRUSequenceModel {
  constructor(seqLen=20, hiddenSize=16) {
    this.seqLen    = seqLen;
    this.cell      = new GRUCell(1, hiddenSize);
    this.Wo        = Array.from({length:hiddenSize},()=>(Math.random()-0.5)*0.1);
    this.bo        = 0;
    this.trained   = false;
    this._trainEpochs = 5;
    this._lr       = 0.01;
  }
  _forward(seq) {
    this.cell.reset();
    let h;
    for (const v of seq) h = this.cell.forward([v]);
    const logit = h.reduce((s,v,i)=>s+v*this.Wo[i],0)+this.bo;
    return 1/(1+Math.exp(-logit));
  }
  train(sequences, labels) {
    if (!sequences || sequences.length < 5) return;
    for (let e=0;e<this._trainEpochs;e++) {
      for (let i=0;i<sequences.length;i++) {
        const p   = this._forward(sequences[i]);
        const err = labels[i] - p;
        // Simple weight update (gradient approximation)
        this.bo += this._lr * err;
        this.cell.h.forEach((_,j)=>{ this.Wo[j] += this._lr*err*this.cell.h[j]; });
      }
    }
    this.trained = true;
  }
  predictProba(features) {
    if (!this.trained) return 0.5;
    const seq = features.slice(0, this.seqLen).map(v=>v||0);
    while (seq.length < this.seqLen) seq.unshift(0);
    return this._forward(seq);
  }
}

module.exports = { RegimeMLRouter, FeatureImportance, ConceptDriftDetector, EnsembleUncertainty, QLearning, computeOOBError, GRUCell, GRUSequenceModel };
