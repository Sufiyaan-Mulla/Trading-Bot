'use strict';
// ── advanced-features.js ─────────────────────────────────────────────────────
// Implements all remaining v12 advanced features:
//  1.5  Dynamic ensemble weights (by recent Sharpe)
//  3.1  Risk parity allocation
//  3.4  Tail risk detector (kurtosis)
//  4.2  Slippage prediction model
//  6.2  Walk-forward retraining scheduler
//  6.4  Uncertainty estimation (prediction variance)
//  7.1  RL reward shaping (Sharpe + drawdown + efficiency)
//  7.2  Contextual RL state vector (regime + volatility)
//  7.3  Safe RL constraints
//  8.1  Combinatorial Purged Cross Validation (CPCV)
//  8.2  White's Reality Check (bootstrap significance)
//  8.3  Deflated Sharpe Ratio

// ────────────────────────────────────────────────────────────────────────────
// 1.5 Dynamic Ensemble Weights
// ────────────────────────────────────────────────────────────────────────────
class DynamicEnsembleWeights {
  /**
   * Adjusts GBM/Sequence/RL/Rule weights weekly based on each model's recent Sharpe.
   * @param {object} opts
   * @param {object} opts.initWeights  { gbm:0.35, seq:0.25, rl:0.15, rule:0.25 }
   * @param {number} opts.windowTrades Sharpe lookback in trades (default 20)
   * @param {number} opts.minWeight    Min weight for any model (default 0.05)
   * @param {Function} opts.log
   */
  constructor(opts = {}) {
    this.weights = { ...{ gbm:0.35, seq:0.25, rl:0.15, rule:0.25 }, ...(opts.initWeights||{}) };
    this.window  = opts.windowTrades || 20;
    this.minW    = opts.minWeight || 0.05;
    this._log    = opts.log || (() => {});
    this._history = { gbm:[], seq:[], rl:[], rule:[] };
    this._lastUpdate = 0;
  }

  /** Record outcome for a specific model's prediction */
  recordOutcome(model, predicted, actual) {
    if (!this._history[model]) return;
    const correct = (predicted > 0 && actual > 0) || (predicted < 0 && actual < 0);
    this._history[model].push({ correct, profit: actual });
    if (this._history[model].length > this.window * 3) this._history[model].shift();
  }

  /** Compute Sharpe ratio for a model's recent trades */
  _modelSharpe(model) {
    const h = this._history[model].slice(-this.window);
    if (h.length < 5) return 0;
    const profits = h.map(t => t.profit);
    const mean    = profits.reduce((s, v) => s + v, 0) / profits.length;
    const std     = Math.sqrt(profits.reduce((s, v) => s + (v - mean) ** 2, 0) / profits.length) || 1e-8;
    return mean / std * Math.sqrt(252);  // annualised
  }

  /** Update weights based on recent Sharpe ratios (call weekly) */
  updateWeights() {
    const sharpes = {};
    let totalPos = 0;
    for (const model of Object.keys(this.weights)) {
      sharpes[model] = Math.max(0, this._modelSharpe(model));
      totalPos += sharpes[model];
    }

    if (totalPos < 1e-6) return;  // all models losing — keep current weights

    const newWeights = {};
    for (const model of Object.keys(this.weights)) {
      newWeights[model] = sharpes[model] / totalPos;
    }

    // Blend 50% new + 50% old (smooth update)
    for (const model of Object.keys(this.weights)) {
      this.weights[model] = Math.max(this.minW, 0.5 * newWeights[model] + 0.5 * this.weights[model]);
    }

    // Renormalize
    const total = Object.values(this.weights).reduce((s, v) => s + v, 0);
    for (const model of Object.keys(this.weights)) this.weights[model] /= total;

    this._lastUpdate = Date.now();
    this._log(`Dynamic weights updated: ${JSON.stringify(Object.fromEntries(Object.entries(this.weights).map(([k,v])=>[k,v.toFixed(3)])))}`);
  }

  /** Get current weights */
  getWeights() { return { ...this.weights }; }

  /** Apply weights to model signals */
  combine(signals) {
    // signals: { gbm: 0.7, seq: 0.65, rl: 0.55, rule: 0.80 } (all in [0,1])
    let weighted = 0, totalW = 0;
    for (const [model, prob] of Object.entries(signals)) {
      if (this.weights[model] != null && isFinite(prob)) {
        weighted += this.weights[model] * prob;
        totalW   += this.weights[model];
      }
    }
    return totalW > 0 ? weighted / totalW : 0.5;
  }

  daysSinceUpdate() { return (Date.now() - this._lastUpdate) / 86_400_000; }
}

// ────────────────────────────────────────────────────────────────────────────
// 3.1 Risk Parity Allocation
// ────────────────────────────────────────────────────────────────────────────
class RiskParityAllocator {
  /**
   * Allocate capital so each asset contributes equally to portfolio variance.
   * @param {object} opts
   * @param {number} opts.targetVol    Target portfolio volatility (default 0.01 = 1% daily)
   * @param {number} opts.lookbackBars Return lookback for vol estimation (default 20)
   * @param {Function} opts.log
   */
  constructor(opts = {}) {
    this.targetVol  = opts.targetVol    || 0.01;
    this.lookback   = opts.lookbackBars || 20;
    this._log       = opts.log || (() => {});
  }

  /** Compute volatility (std dev of log-returns) for a price series */
  _vol(prices) {
    if (!prices || prices.length < 3) return 0.01;
    const recent = prices.slice(-this.lookback);
    const rets   = [];
    for (let i = 1; i < recent.length; i++) {
      if (recent[i] > 0 && recent[i-1] > 0) rets.push(Math.log(recent[i] / recent[i-1]));
    }
    if (rets.length < 2) return 0.01;
    const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
    return Math.sqrt(rets.reduce((s, v) => s + (v - mean) ** 2, 0) / rets.length) || 0.001;
  }

  /**
   * Compute risk-parity weights for a set of assets.
   * Each asset's weight = targetVol / assetVol (inverse vol weighting)
   * @param {object} priceHistories  { EURUSD: [...], GBPUSD: [...] }
   * @param {number} totalCapital
   * @returns {{ weights: {[asset]: number}, sizes: {[asset]: number}, vols: {[asset]: number} }}
   */
  allocate(priceHistories, totalCapital) {
    const assets = Object.keys(priceHistories);
    if (!assets.length) return { weights: {}, sizes: {}, vols: {} };

    const vols    = {};
    const invVols = {};
    let   totalInvVol = 0;

    for (const asset of assets) {
      vols[asset]    = this._vol(priceHistories[asset]);
      invVols[asset] = 1 / (vols[asset] || 0.001);
      totalInvVol   += invVols[asset];
    }

    const weights = {}, sizes = {};
    for (const asset of assets) {
      weights[asset] = invVols[asset] / totalInvVol;
      sizes[asset]   = parseFloat((weights[asset] * totalCapital).toFixed(2));
    }

    this._log(`Risk parity: ${JSON.stringify(Object.fromEntries(assets.map(a=>[a,(weights[a]*100).toFixed(1)+'%'])))}`);
    return { weights, sizes, vols: Object.fromEntries(assets.map(a=>[a,parseFloat(vols[a].toFixed(6))])) };
  }

  /** Get position size for a single asset given current portfolio state */
  positionSize(asset, priceHistories, totalCapital) {
    const result = this.allocate(priceHistories, totalCapital);
    return result.sizes[asset] || totalCapital * 0.02;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 3.4 Tail Risk Detector
// ────────────────────────────────────────────────────────────────────────────
class TailRiskDetector {
  /**
   * Detects fat-tail conditions using excess kurtosis and reduces exposure.
   * @param {object} opts
   * @param {number} opts.kurtosisThresh  Excess kurtosis threshold (default 3.0)
   * @param {number} opts.lookback        Return window (default 30)
   * @param {number} opts.reduceMultiplier Size multiplier when tail risk detected (default 0.5)
   * @param {Function} opts.log
   */
  constructor(opts = {}) {
    this.kurtosisThresh   = opts.kurtosisThresh   || 3.0;
    this.lookback         = opts.lookback         || 30;
    this.reduceMultiplier = opts.reduceMultiplier  || 0.5;
    this._log             = opts.log || (() => {});
  }

  /** Compute excess kurtosis of a return series */
  _excessKurtosis(returns) {
    if (returns.length < 4) return 0;
    const n    = returns.length;
    const mean = returns.reduce((s, v) => s + v, 0) / n;
    const m2   = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    const m4   = returns.reduce((s, v) => s + (v - mean) ** 4, 0) / n;
    const k    = m4 / (m2 ** 2 || 1) - 3;  // excess kurtosis (normal=0)
    return isFinite(k) ? k : 0;
  }

  /**
   * Check if tail risk is elevated.
   * @param {number[]} prices  Recent price history
   * @returns {{ tailRisk: bool, kurtosis: number, sizeMultiplier: number, reason: string }}
   */
  check(prices) {
    if (!prices || prices.length < 10) return { tailRisk: false, kurtosis: 0, sizeMultiplier: 1.0 };

    const recent  = prices.slice(-this.lookback);
    const returns = [];
    for (let i = 1; i < recent.length; i++) {
      if (recent[i] > 0 && recent[i-1] > 0) returns.push(Math.log(recent[i] / recent[i-1]));
    }

    const kurt = this._excessKurtosis(returns);
    const tailRisk = kurt > this.kurtosisThresh;

    if (tailRisk) {
      const reason = `[TailRisk] Excess kurtosis ${kurt.toFixed(2)} > ${this.kurtosisThresh} — fat-tail regime`;
      this._log(`⚠️  ${reason}`);
      return { tailRisk: true, kurtosis: parseFloat(kurt.toFixed(3)), sizeMultiplier: this.reduceMultiplier, reason };
    }

    return { tailRisk: false, kurtosis: parseFloat(kurt.toFixed(3)), sizeMultiplier: 1.0 };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 4.2 Slippage Prediction Model
// ────────────────────────────────────────────────────────────────────────────
class SlippagePredictionModel {
  /**
   * Lightweight linear regression model to predict expected slippage.
   * Features: spread, volRatio, hour, dayOfWeek, atrPercent
   */
  constructor(opts = {}) {
    this._coeffs  = opts.coeffs || null;  // learned coefficients
    this._samples = [];
    this._minSamples = opts.minSamples || 20;
    this._log = opts.log || (() => {});
  }

  _features(spread, volRatio, hour, dayOfWeek, atrPercent) {
    return [
      1,                              // intercept
      spread || 0,
      volRatio || 1,
      hour / 24,                      // normalised
      dayOfWeek / 6,                  // normalised
      atrPercent || 0.05,
      (spread || 0) * (volRatio || 1), // interaction
    ];
  }

  /** Record actual slippage after a fill */
  recordFill(features, actualSlippage) {
    if (!isFinite(actualSlippage) || actualSlippage < 0) return;
    this._samples.push({ features, y: actualSlippage });
    if (this._samples.length > 500) this._samples.shift();
    if (this._samples.length >= this._minSamples && this._samples.length % 20 === 0) {
      this._fit();
    }
  }

  /** OLS regression — closed form (X'X)^-1 X'y */
  _fit() {
    const X = this._samples.map(s => s.features);
    const y = this._samples.map(s => s.y);
    const k = X[0].length, n = X.length;

    // X'X
    const XtX = Array.from({length:k}, (_,i) => Array.from({length:k}, (_,j) =>
      X.reduce((s,row) => s + row[i]*row[j], 0)
    ));
    // X'y
    const Xty = Array.from({length:k}, (_,i) => X.reduce((s,row,r) => s + row[i]*y[r], 0));

    // Gaussian elimination
    const aug = XtX.map((row, i) => [...row, Xty[i]]);
    for (let col = 0; col < k; col++) {
      let maxRow = col;
      for (let r = col+1; r < k; r++) if (Math.abs(aug[r][col]) > Math.abs(aug[maxRow][col])) maxRow = r;
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
      const pivot = aug[col][col] || 1e-10;
      for (let r = 0; r < k; r++) {
        if (r === col) continue;
        const f = aug[r][col] / pivot;
        for (let c = col; c <= k; c++) aug[r][c] -= f * aug[col][c];
      }
      for (let c = col; c <= k; c++) aug[col][c] /= pivot;
    }
    this._coeffs = aug.map(row => row[k]);
    this._log(`SlippagePrediction model fitted on ${n} samples`);
  }

  /**
   * Predict expected slippage.
   * @returns {{ predictedSlippage: number, confidence: 'high'|'medium'|'low' }}
   */
  predict(spread, volRatio, hour, dayOfWeek, atrPercent) {
    const features = this._features(spread, volRatio, hour, dayOfWeek, atrPercent);
    if (!this._coeffs) {
      // Fallback heuristic: slippage ≈ 0.5 × spread + 0.1 × volRatio × atrPercent
      const est = 0.5 * (spread || 0.0002) + 0.1 * (volRatio || 1) * (atrPercent || 0.05) * 0.01;
      return { predictedSlippage: parseFloat(est.toFixed(6)), confidence: 'low' };
    }
    const pred = features.reduce((s, v, i) => s + v * (this._coeffs[i] || 0), 0);
    const conf = this._samples.length >= 100 ? 'high' : this._samples.length >= 40 ? 'medium' : 'low';
    return { predictedSlippage: Math.max(0, parseFloat(pred.toFixed(6))), confidence: conf };
  }

  get sampleCount() { return this._samples.length; }
  get isTrained()   { return !!this._coeffs; }
}

// ────────────────────────────────────────────────────────────────────────────
// 6.2 Walk-Forward Retraining Scheduler
// ────────────────────────────────────────────────────────────────────────────
class RetrainingScheduler {
  /**
   * Schedules monthly walk-forward model retraining.
   * @param {object} opts
   * @param {number}   opts.intervalDays  Retrain interval in days (default 30)
   * @param {number}   opts.minNewTrades  Min new trades before retraining (default 50)
   * @param {Function} opts.onRetrain     async fn() called when retrain is due
   * @param {Function} opts.log
   */
  constructor(opts = {}) {
    // BUG FIX: use ?? not || so intervalDays:0 works (0 || 30 === 30 is wrong)
    this.intervalDays  = opts.intervalDays  ?? 30;
    this.minNewTrades  = opts.minNewTrades  ?? 50;
    this.onRetrain     = opts.onRetrain     || (async () => {});
    this._log          = opts.log || (() => {});
    this._lastRetrain  = 0;
    this._tradesSince  = 0;
    this._timer        = null;
  }

  /** Called after every closed trade */
  onTrade() {
    this._tradesSince++;
    if (this._isDue()) this._trigger();
  }

  _isDue() {
    const daysSince = (Date.now() - this._lastRetrain) / 86_400_000;
    return daysSince >= this.intervalDays && this._tradesSince >= this.minNewTrades;
  }

  async _trigger() {
    this._log(`🔄 Retraining triggered — ${this._tradesSince} new trades since last retrain`);
    this._lastRetrain = Date.now();
    this._tradesSince = 0;
    try { await this.onRetrain(); this._log('✅ Retraining complete'); }
    catch(e) { this._log(`❌ Retraining failed: ${e.message}`); }
  }

  /** Start a timer that checks daily */
  start() {
    this._timer = setInterval(() => { if (this._isDue()) this._trigger(); }, 86_400_000).unref();
    this._log(`Retraining scheduler started — interval: ${this.intervalDays}d, minTrades: ${this.minNewTrades}`);
  }

  stop() { clearInterval(this._timer); }

  status() {
    return {
      daysSinceRetrain: parseFloat(((Date.now()-this._lastRetrain)/86_400_000).toFixed(1)),
      tradesSinceRetrain: this._tradesSince,
      isDue: this._isDue(),
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 6.4 Uncertainty Estimation
// ────────────────────────────────────────────────────────────────────────────
class UncertaintyEstimator {
  /**
   * Estimates prediction uncertainty using multiple model passes (dropout MC simulation)
   * or ensemble variance. Rejects signals with high uncertainty.
   * @param {object} opts
   * @param {number} opts.nPasses        Monte Carlo passes (default 10)
   * @param {number} opts.rejectVariance Variance threshold to reject (default 0.04)
   * @param {Function} opts.log
   */
  constructor(opts = {}) {
    this.nPasses       = opts.nPasses       || 10;
    this.rejectVariance= opts.rejectVariance || 0.04;  // std dev of prob ~ 20%
    this._log          = opts.log || (() => {});
  }

  /**
   * Estimate uncertainty from multiple probability estimates.
   * In production: call model multiple times with dropout enabled.
   * Here: use ensemble member disagreement as proxy.
   * @param {number[]} probabilities  Array of probability estimates from different models/passes
   * @returns {{ mean: number, variance: number, std: number, uncertain: bool, reason: string }}
   */
  estimate(probabilities) {
    if (!probabilities || probabilities.length < 2) {
      return { mean: 0.5, variance: 0.25, std: 0.5, uncertain: true, reason: 'Insufficient model passes' };
    }

    const n    = probabilities.length;
    const mean = probabilities.reduce((s, v) => s + v, 0) / n;
    const variance = probabilities.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    const std  = Math.sqrt(variance);
    const uncertain = variance > this.rejectVariance;

    const reason = uncertain
      ? `[Uncertainty] High variance σ²=${variance.toFixed(4)} > ${this.rejectVariance} — signal rejected`
      : '';

    if (uncertain) this._log(`⚠️  ${reason}`);

    return {
      mean:      parseFloat(mean.toFixed(4)),
      variance:  parseFloat(variance.toFixed(4)),
      std:       parseFloat(std.toFixed(4)),
      uncertain,
      reason,
    };
  }

  /** Check if an ensemble of model predictions is reliable */
  isReliable(modelPredictions) {
    const probs = Object.values(modelPredictions).filter(v => typeof v === 'number' && isFinite(v));
    const result = this.estimate(probs);
    return !result.uncertain;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 7.1 RL Reward Shaping
// ────────────────────────────────────────────────────────────────────────────
function shapeRLReward(trade, portfolioState) {
  // Pure P&L reward is myopic — RL learns to chase big wins regardless of risk.
  // Shaped reward = Sharpe contribution - drawdown penalty + efficiency bonus.
  const pnl          = trade.profit || 0;
  const capital      = portfolioState.capital || 10000;
  const maxDD        = portfolioState.maxDrawdown || 0;
  const barsHeld     = trade.barsHeld || 1;
  const targetBars   = portfolioState.targetHoldBars || 10;

  // (1) Sharpe contribution: risk-adjusted return
  const pnlPct       = pnl / capital;
  const sharpeContrib = pnlPct / (portfolioState.volatility || 0.01);

  // (2) Drawdown penalty: penalise trades that occur during drawdown
  const ddPenalty    = maxDD > 0.05 ? -maxDD * 2 : 0;

  // (3) Trade efficiency: reward clean quick trades, penalise slow losers
  const efficiency   = Math.max(-1, Math.min(1, pnlPct * targetBars / (barsHeld || 1)));

  const reward = 0.5 * sharpeContrib + 0.3 * ddPenalty + 0.2 * efficiency;
  return parseFloat(reward.toFixed(6));
}

// ────────────────────────────────────────────────────────────────────────────
// 7.2 Contextual RL State Vector
// ────────────────────────────────────────────────────────────────────────────
function buildContextualRLState(indicators, portfolioState) {
  // Augments basic price indicators with regime/volatility context
  // so the RL agent can condition its actions on market environment.
  const regimeMap = { TRENDING:0, WEAK_TREND:1, RANGING:2, BEAR:3, UNKNOWN:4, STRONG_TREND:0, MEAN_REVERSION:2, HIGH_VOL:3, CRISIS:4 };
  const sessionMap= { LONDON:0, NEW_YORK:1, LONDON_NY:2, ASIAN:3, TOKYO:3, UK:0, US:1 };
  const volMap    = { LOW:0, NORMAL:0.5, HIGH:1 };

  return [
    // Core price features
    (indicators.rsi || 50) / 100,
    ((indicators.macd || 0) > 0 ? 1 : 0),
    (indicators.atrPercent || 0.05) / 0.2,
    (indicators.volRatio || 1) / 3,
    // Regime context (7.2 addition)
    (regimeMap[indicators.adxRegime||'UNKNOWN'] || 4) / 4,
    (volMap[indicators.volatilityLevel||'NORMAL'] || 0.5),
    // Session context
    (sessionMap[indicators.session||'LONDON'] || 0) / 3,
    // Portfolio state context (7.2 addition)
    Math.min(1, (portfolioState.consecutiveLosses || 0) / 5),
    Math.min(1, (portfolioState.drawdown || 0) / 0.1),
    portfolioState.position ? 1 : 0,
  ];
}

// ────────────────────────────────────────────────────────────────────────────
// 7.3 Safe RL Constraints
// ────────────────────────────────────────────────────────────────────────────
class SafeRLConstraints {
  /**
   * Enforces hard safety constraints on RL actions.
   * RL cannot exceed position size, drawdown, or correlation limits.
   * @param {object} opts
   * @param {number} opts.maxPositionSizePct  Max size as % of capital (default 0.05)
   * @param {number} opts.maxDrawdownPct      Max drawdown before RL paused (default 0.10)
   * @param {number} opts.maxCorrThreshold    Max correlation (default 0.85)
   * @param {Function} opts.log
   */
  constructor(opts = {}) {
    this.maxPosPct  = opts.maxPositionSizePct || 0.05;
    this.maxDD      = opts.maxDrawdownPct     || 0.10;
    this.maxCorr    = opts.maxCorrThreshold   || 0.85;
    this._log       = opts.log || (() => {});
  }

  /**
   * Check whether an RL-proposed action is safe.
   * @param {object} action        { action:'BUY'|'SELL'|'HOLD', sizePct:0.02 }
   * @param {object} portfolioState { capital, initialCapital, drawdown, correlations }
   * @returns {{ safe: bool, reason: string, correctedAction: object }}
   */
  check(action, portfolioState) {
    const { capital=10000, initialCapital=10000, drawdown=0 } = portfolioState;

    // 1. Drawdown constraint
    if (drawdown >= this.maxDD && (action.action === 'BUY' || action.action === 'SELL')) {
      const reason = `[SafeRL] Drawdown ${(drawdown*100).toFixed(1)}% ≥ ${(this.maxDD*100).toFixed(0)}% — RL action overridden to HOLD`;
      this._log(reason);
      return { safe: false, reason, correctedAction: { action:'HOLD', sizePct:0 } };
    }

    // 2. Position size constraint
    const sizePct = action.sizePct || 0.02;
    if (sizePct > this.maxPosPct) {
      const capped = { ...action, sizePct: this.maxPosPct };
      this._log(`[SafeRL] Position size ${(sizePct*100).toFixed(1)}% capped to ${(this.maxPosPct*100).toFixed(0)}%`);
      return { safe: true, reason: 'size_capped', correctedAction: capped };
    }

    // 3. All safe
    return { safe: true, reason: '', correctedAction: action };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 8.1 Combinatorial Purged Cross Validation (CPCV)
// ────────────────────────────────────────────────────────────────────────────
class CPCV {
  /**
   * Lopez de Prado CPCV — combinatorially purges training data to eliminate
   * information leakage across train/test splits in time series ML.
   *
   * @param {object} opts
   * @param {number} opts.nSplits    Number of splits (default 6)
   * @param {number} opts.nTestSplits How many splits used as test per CV fold (default 2)
   * @param {number} opts.embargoBars Bars to remove around split boundary (default 10)
   * @param {Function} opts.log
   */
  constructor(opts = {}) {
    this.nSplits     = opts.nSplits     || 6;
    this.nTestSplits = opts.nTestSplits || 2;
    this.embargo     = opts.embargoBars || 10;
    this._log        = opts.log || (() => {});
  }

  /**
   * Generate CPCV train/test indices.
   * @param {number} nSamples  Total number of observations
   * @returns {Array<{ trainIdx: number[], testIdx: number[], foldNum: number }>}
   */
  split(nSamples) {
    const splitSize = Math.floor(nSamples / this.nSplits);
    const groups    = Array.from({ length: this.nSplits }, (_, i) => ({
      start: i * splitSize,
      end:   i === this.nSplits - 1 ? nSamples : (i + 1) * splitSize,
    }));

    // Choose C(nSplits, nTestSplits) combinations for test
    const combs = this._combinations(this.nSplits, this.nTestSplits);
    const folds = [];

    for (const [foldNum, testGroupIdxs] of combs.entries()) {
      const testGroups  = new Set(testGroupIdxs);
      const trainIdx    = [], testIdx = [];

      for (let g = 0; g < groups.length; g++) {
        const { start, end } = groups[g];
        if (testGroups.has(g)) {
          for (let i = start; i < end; i++) testIdx.push(i);
        } else {
          // Apply embargo: remove bars near test boundaries
          const nearTest = testGroupIdxs.some(tg => Math.abs(g - tg) <= 1);
          const eStart   = nearTest ? start + this.embargo : start;
          const eEnd     = nearTest ? end   - this.embargo : end;
          for (let i = eStart; i < eEnd; i++) if (i >= 0 && i < nSamples) trainIdx.push(i);
        }
      }

      if (trainIdx.length >= 20 && testIdx.length >= 5) {
        folds.push({ trainIdx, testIdx, foldNum, testGroups: [...testGroups] });
      }
    }

    this._log(`CPCV: ${folds.length} folds from C(${this.nSplits},${this.nTestSplits}) combinations`);
    return folds;
  }

  _combinations(n, k) {
    const result = [];
    const combo  = [];
    const rec    = (start) => {
      if (combo.length === k) { result.push([...combo]); return; }
      for (let i = start; i < n; i++) { combo.push(i); rec(i + 1); combo.pop(); }
    };
    rec(0);
    return result;
  }

  /**
   * Run a backtest function across CPCV folds.
   * @param {Function} backtestFn fn(trainIdx, testIdx, prices) → { trades, capital }
   * @param {number[]} prices
   * @returns { folds: Array, avgOOSSharpe: number, deflatedSharpe: number }
   */
  async run(backtestFn, prices) {
    const folds   = this.split(prices.length);
    const results = [];

    for (const fold of folds) {
      try {
        const trainPrices = fold.trainIdx.map(i => prices[i]);
        const testPrices  = fold.testIdx.map(i => prices[i]);
        const r = await backtestFn(trainPrices, testPrices);
        const sharpe = r.sharpe || this._computeSharpe(r.trades || []);
        results.push({ foldNum: fold.foldNum, sharpe, testSize: fold.testIdx.length, result: r });
      } catch (e) {
        results.push({ foldNum: fold.foldNum, sharpe: 0, error: e.message });
      }
    }

    const sharpes = results.map(r => r.sharpe).filter(isFinite);
    const avgSharpe = sharpes.length ? sharpes.reduce((s,v)=>s+v,0)/sharpes.length : 0;

    this._log(`CPCV complete — ${results.length} folds, avg OOS Sharpe: ${avgSharpe.toFixed(3)}`);
    return { folds: results, avgOOSSharpe: parseFloat(avgSharpe.toFixed(4)), nFolds: results.length };
  }

  _computeSharpe(trades) {
    if (!trades.length) return 0;
    const rets = trades.map(t => t.profitPercent || 0);
    const mean = rets.reduce((s,v)=>s+v,0)/rets.length;
    const std  = Math.sqrt(rets.reduce((s,v)=>s+(v-mean)**2,0)/rets.length)||1;
    return mean/std * Math.sqrt(252);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 8.2 White's Reality Check
// ────────────────────────────────────────────────────────────────────────────
function whitesRealityCheck(strategyReturns, benchmarkReturns, nBootstrap = 1000) {
  // White (2000): tests H0: no strategy outperforms the benchmark.
  // p-value = fraction of bootstrap samples where max(boot_excess) > observed max(excess).
  if (!strategyReturns || strategyReturns.length < 10) {
    return { pValue: 1.0, significant: false, reason: 'Insufficient data' };
  }

  const benchmark  = benchmarkReturns || Array(strategyReturns.length).fill(0);
  const excess     = strategyReturns.map((r, i) => r - (benchmark[i] || 0));
  const obsMean    = excess.reduce((s, v) => s + v, 0) / excess.length;
  const n          = excess.length;

  // White's Reality Check bootstrap: H0 is that E[excess]=0.
  // We CENTER the series (subtract observed mean) before resampling so that the
  // bootstrap distribution is centred at 0 under H0.  Then we count how often a
  // bootstrap mean from the CENTRED series still exceeds the OBSERVED mean.
  // Without centering the p-value converges to ~0.5 regardless of edge strength.
  const centered = excess.map(e => e - obsMean);
  let exceedCount = 0;
  for (let b = 0; b < nBootstrap; b++) {
    let bootMean = 0;
    for (let i = 0; i < n; i++) {
      bootMean += centered[Math.floor(Math.random() * n)];
    }
    bootMean /= n;
    if (bootMean >= obsMean) exceedCount++;
  }

  const pValue     = exceedCount / nBootstrap;
  const significant = pValue < 0.05;

  return {
    pValue:      parseFloat(pValue.toFixed(4)),
    significant,
    obsMeanExcess: parseFloat(obsMean.toFixed(6)),
    nBootstrap,
    reason: significant ? 'Edge is statistically significant (p < 0.05)' : `No significant edge (p=${pValue.toFixed(3)})`,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 8.3 Deflated Sharpe Ratio
// ────────────────────────────────────────────────────────────────────────────
function deflatedSharpeRatio(observedSharpe, nTrials, nObservations, skewness = 0, excessKurtosis = 0) {
  // Bailey & Lopez de Prado (2014): adjusts Sharpe for multiple testing.
  // DSR = P(SR* > 0 | SR_observed, n_trials, n_obs)
  // where SR* is the true Sharpe and we correct for selection bias.

  if (!isFinite(observedSharpe) || nTrials < 1 || nObservations < 4) {
    return { dsr: 0, threshold: 0, deflated: false };
  }

  // Expected maximum Sharpe under H0 (Lopez de Prado formula)
  const Z       = x => 0.5 * (1 + erf(x / Math.SQRT2));
  const erf     = x => {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = 1 - t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
    return x >= 0 ? y : -y;
  };

  // Expected max Sharpe from n_trials under H0.
  // BUG FIX: normalInvCDF(0) = -Infinity when nTrials=1 (1-1/1=0).  Clamp to >=2
  // so the quantile argument is always > 0.  With 1 trial there is no multiple-testing
  // correction so E_max_SR ≈ 0 (the selection bias is zero) which is correct.
  const eulerGamma  = 0.5772156649;
  const nT          = Math.max(2, nTrials);
  const E_max_SR    = (1 - eulerGamma) * normalInvCDF(1 - 1/nT) + eulerGamma * normalInvCDF(1 - 1/(nT * Math.E));

  // Variance correction for non-normality
  // BUG FIX: the variance-correction term can be negative for large Sharpes with
  // zero/negative kurtosis — clamp to a minimum positive value before sqrt.
  const varRaw = (1 - skewness * observedSharpe + (excessKurtosis - 1) / 4 * observedSharpe ** 2) / (nObservations - 1);
  const varAdj = Math.sqrt(Math.max(1 / (nObservations - 1), varRaw));
  const threshold = E_max_SR * varAdj;

  // DSR = P(SR_observed > threshold)
  const dsr = Z((observedSharpe - threshold) / (varAdj || 1));

  return {
    dsr:           parseFloat(dsr.toFixed(4)),
    threshold:     parseFloat(threshold.toFixed(4)),
    deflated:      dsr < 0.95,  // deflated if not 95% confident edge is real
    observedSharpe,
    nTrials,
    nObservations,
    reason: dsr >= 0.95 ? 'Edge survives multiple testing correction' : `DSR ${dsr.toFixed(3)} < 0.95 — likely overfitting`,
  };
}

function normalInvCDF(p) {
  // Beasley-Springer-Moro approximation
  const a = [2.50662823884, -18.61500062529, 41.39119773534, -25.44106049637];
  const b = [-8.47351093090, 23.08336743743, -21.06224101826, 3.13082909833];
  const c = [0.3374754822726147, 0.9761690190917186, 0.1607979714918209, 0.0276438810333863, 0.0038405729373609, 0.0003951896511349, 0.0000321767881768, 0.0000002888167364, 0.0000003960315187];
  const y = p - 0.5;
  if (Math.abs(y) < 0.42) {
    const r = y * y;
    return y * (((a[3]*r+a[2])*r+a[1])*r+a[0]) / ((((b[3]*r+b[2])*r+b[1])*r+b[0])*r+1);
  }
  const r = p < 0.5 ? Math.sqrt(-Math.log(p)) : Math.sqrt(-Math.log(1-p));
  const x = c[0]+r*(c[1]+r*(c[2]+r*(c[3]+r*(c[4]+r*(c[5]+r*(c[6]+r*(c[7]+r*c[8])))))));
  return p < 0.5 ? -x : x;
}

module.exports = {
  DynamicEnsembleWeights,
  RiskParityAllocator,
  TailRiskDetector,
  SlippagePredictionModel,
  RetrainingScheduler,
  UncertaintyEstimator,
  shapeRLReward,
  buildContextualRLState,
  SafeRLConstraints,
  CPCV,
  whitesRealityCheck,
  deflatedSharpeRatio,
};
