'use strict';
// ── Model Confidence Decay ────────────────────────────────────────────────────
// ML confidence scores degrade over time when the model hasn't been retrained.
// A model trained 48h ago in a regime that has since changed should not carry
// the same weight as a freshly-trained one.
//
// Decay formula: decayFactor = 2^(-ageHours / halfLifeHours)
// Applied: adjustedConf = min(rawConf, rawConf * decayFactor) clamped to minScore

const { TRADING_CONFIG } = require('./trading-config');

class ModelConfidenceDecay {
  constructor({ log = console.log } = {}) {
    this.log   = log;
    this._lastTrainedAt = Date.now();  // reset on construction / retrain signal
    this._decayLogged   = false;
  }

  /** Call this whenever the ML model is successfully retrained */
  onRetrain() {
    this._lastTrainedAt = Date.now();
    this._decayLogged   = false;
    this.log('🔄 [ModelDecay] Model retrained — confidence decay reset');
  }

  /**
   * Apply time-based decay to a raw ML confidence score.
   * @param {number} rawConf  0–1
   * @returns {number}        adjusted confidence (0–1)
   */
  adjust(rawConf) {
    if (!TRADING_CONFIG.modelDecayEnabled) return rawConf;

    const halfLifeHours = TRADING_CONFIG.modelDecayHalfLifeHours || 24;
    const minScore      = TRADING_CONFIG.modelDecayMinScore      || 0.40;

    const ageMs    = Date.now() - this._lastTrainedAt;
    const ageHours = ageMs / (1000 * 60 * 60);
    const decay    = Math.pow(2, -ageHours / halfLifeHours);   // exponential half-life
    const adjusted = Math.max(minScore, rawConf * decay);

    if (ageHours > halfLifeHours && !this._decayLogged) {
      this.log(`⏳ [ModelDecay] Model age ${ageHours.toFixed(1)}h > half-life ${halfLifeHours}h — confidence decayed by ${((1 - decay) * 100).toFixed(0)}%`);
      this._decayLogged = true;
    }

    return adjusted;
  }

  /** Age in hours since last retrain */
  get ageHours() {
    return (Date.now() - this._lastTrainedAt) / (1000 * 60 * 60);
  }

  /** 0–1 current decay factor */
  get currentDecayFactor() {
    const halfLife = TRADING_CONFIG.modelDecayHalfLifeHours || 24;
    return Math.pow(2, -this.ageHours / halfLife);
  }

  status() {
    return {
      ageHours:       parseFloat(this.ageHours.toFixed(2)),
      decayFactor:    parseFloat(this.currentDecayFactor.toFixed(4)),
      lastTrainedAt:  new Date(this._lastTrainedAt).toISOString(),
      halfLifeHours:  TRADING_CONFIG.modelDecayHalfLifeHours || 24,
    };
  }
}

module.exports = { ModelConfidenceDecay };
