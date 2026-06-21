'use strict';
// ── Ensemble Disagreement Halt ────────────────────────────────────────────────
// When individual ensemble members strongly disagree on trade direction,
// the trade is low-conviction and should be skipped.
// A split vote (e.g. 3 BUY, 2 SELL) carries far more uncertainty than 5 BUY.

const { TRADING_CONFIG } = require('./trading-config');

class EnsembleDisagreementHalt {
  constructor({ log = console.log } = {}) {
    this.log     = log;
    this._history = [];  // { agreement, action, skipped } per signal
  }

  /**
   * Evaluate ensemble votes and decide whether to skip the trade.
   * @param {string[]} votes  array of actions from each member: 'BUY'|'SELL'|'HOLD'
   * @param {string}   action final ensemble action
   * @returns {{ allowed: boolean, agreement: number, reason?: string }}
   */
  evaluate(votes, action) {
    if (!TRADING_CONFIG.ensembleDisagreementHaltEnabled) return { allowed: true, agreement: 1 };
    if (!votes || votes.length === 0) return { allowed: true, agreement: 1 };

    const threshold = TRADING_CONFIG.ensembleAgreementThreshold || 0.60;

    // Count votes for the final action direction
    const totalVotes   = votes.length;
    const actionVotes  = votes.filter(v => v === action).length;
    const agreement    = actionVotes / totalVotes;

    const skipped = action !== 'HOLD' && agreement < threshold;

    const record = { agreement: parseFloat(agreement.toFixed(3)), action, skipped, ts: Date.now() };
    this._history.push(record);
    if (this._history.length > 200) this._history.shift();

    if (skipped) {
      const reason = `EnsembleDisagreement: only ${actionVotes}/${totalVotes} members agree on ${action} (${(agreement*100).toFixed(0)}% < ${(threshold*100).toFixed(0)}% threshold)`;
      this.log(`🤝 [EnsembleHalt] ${reason}`);
      return { allowed: false, agreement, reason };
    }

    return { allowed: true, agreement };
  }

  /** Fraction of recent signals that were halted due to disagreement */
  haltRate(n = 50) {
    const recent = this._history.slice(-n);
    if (!recent.length) return 0;
    return recent.filter(r => r.skipped).length / recent.length;
  }

  summary() {
    return {
      totalSignals: this._history.length,
      haltRate50:   parseFloat(this.haltRate(50).toFixed(3)),
      recentHalts:  this._history.slice(-10).filter(r => r.skipped).length,
    };
  }
}

module.exports = { EnsembleDisagreementHalt };
