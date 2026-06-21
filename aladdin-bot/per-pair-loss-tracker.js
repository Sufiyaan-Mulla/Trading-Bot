'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  PerPairLossTracker  —  Feature #17
//
//  Tracks realised P&L per instrument per calendar day (UTC).
//  Blocks new entries when a pair's loss exceeds maxPairDailyLossPct of capital.
//  Resets at UTC midnight automatically.
// ─────────────────────────────────────────────────────────────────────────────

class PerPairLossTracker {
  /**
   * @param {object} opts
   * @param {number} opts.maxPairDailyLossPct  - fraction of capital (e.g. 0.02 = 2%)
   * @param {Function} [opts.log]
   * @param {Function} [opts.notify]           - fn(msg) to send Telegram alert
   */
  constructor(opts = {}) {
    this.maxPct  = opts.maxPairDailyLossPct ?? 0.02;  // default 2% per pair per day
    this._log    = opts.log    || ((m) => console.log('[PairLoss] ' + m));
    this._notify = opts.notify || null;

    // Map<string, { date: 'YYYY-MM-DD', loss: number }>
    this._data = new Map();
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  _utcDate() {
    return new Date().toISOString().slice(0, 10);   // 'YYYY-MM-DD'
  }

  _entry(pair) {
    const today = this._utcDate();
    if (!this._data.has(pair) || this._data.get(pair).date !== today) {
      this._data.set(pair, { date: today, loss: 0, blocked: false });
    }
    return this._data.get(pair);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Record a closed trade's P&L for a pair.
   * Call this from exitPosition.
   * @param {string} pair     - e.g. 'EUR_USD'
   * @param {number} pnl      - signed P&L in account currency (negative = loss)
   * @param {number} capital  - current account capital (used to compute loss %)
   */
  record(pair, pnl, capital) {
    const rec = this._entry(pair);
    // Bug fix: -Infinity pnl (e.g. from a failed exit calculation) set rec.loss
    // to Infinity, permanently blocking the pair even after a session reset.
    if (typeof pnl !== 'number' || !isFinite(pnl)) return;
    if (pnl < 0) {
      rec.loss += Math.abs(pnl);
      const lossPct = capital > 0 ? rec.loss / capital : 0;
      if (lossPct >= this.maxPct && !rec.blocked) {
        rec.blocked = true;
        const msg = `[PairLoss] ${pair} daily loss $${rec.loss.toFixed(2)} (${(lossPct*100).toFixed(2)}%) ≥ limit ${(this.maxPct*100).toFixed(1)}% — pair halted for today`;
        this._log(msg);
        if (this._notify) { try { this._notify(msg); } catch(_) {} }
      }
    }
  }

  /**
   * Returns { allowed: bool, reason: string }
   * Call this before entering any position.
   * @param {string} pair
   * @param {number} capital
   */
  canEnter(pair, capital) {
    const rec     = this._entry(pair);
    const lossPct = capital > 0 ? rec.loss / capital : 0;
    if (lossPct >= this.maxPct) {
      return {
        allowed: false,
        reason: `Per-pair daily loss limit: ${pair} down $${rec.loss.toFixed(2)} (${(lossPct*100).toFixed(2)}%) today — max ${(this.maxPct*100).toFixed(1)}%`,
      };
    }
    return { allowed: true, loss: rec.loss, lossPct };
  }

  /**
   * Returns summary for metrics/dashboard.
   */
  summary() {
    const out = {};
    for (const [pair, rec] of this._data) {
      out[pair] = { date: rec.date, loss: rec.loss, blocked: rec.blocked };
    }
    return out;
  }

  /**
   * Manually reset a single pair (e.g. after manual override).
   */
  reset(pair) {
    this._data.delete(pair);
  }
}

module.exports = { PerPairLossTracker };
