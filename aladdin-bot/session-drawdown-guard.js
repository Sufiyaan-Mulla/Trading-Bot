'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  SessionDrawdownGuard  —  Feature #6
//
//  Tracks the session-high of equity (capital) and fires an alert + optional
//  halt when equity drops more than `sessionDrawdownLimit` (e.g. 3%) from the
//  intraday peak.
//
//  A "session" is defined as the continuous period between engine start and
//  either a manual reset or a configurable UTC hour boundary (default: 00:00).
// ─────────────────────────────────────────────────────────────────────────────

class SessionDrawdownGuard {
  /**
   * @param {object} opts
   * @param {number}   opts.sessionDrawdownLimit  fraction e.g. 0.03 (3%)
   * @param {boolean}  [opts.haltOnBreach]        if true, sets haltTripped flag
   * @param {Function} [opts.log]
   * @param {Function} [opts.notify]              fn(msg) → Telegram
   * @param {Function} [opts.onHalt]              fn() called when breach & haltOnBreach
   */
  constructor(opts = {}) {
    this.limit        = opts.sessionDrawdownLimit ?? 0.03;
    this.haltOnBreach = opts.haltOnBreach         ?? false;
    this._log         = opts.log    || ((m) => console.log('[SessionDD] ' + m));
    this._notify      = opts.notify || null;
    this._onHalt      = opts.onHalt || null;

    this._sessionHigh  = null;   // peak capital this session
    this._alerted      = false;  // prevent alert spam
    this.haltTripped   = false;
    this._sessionDate  = this._utcDate();
  }

  _utcDate() { return new Date().toISOString().slice(0, 10); }

  // Reset session high at UTC midnight
  _maybeDayReset() {
    const today = this._utcDate();
    if (today !== this._sessionDate) {
      this._sessionDate = today;
      this._sessionHigh = null;
      this._alerted     = false;
      this.haltTripped  = false;
    }
  }

  /**
   * Call this every tick with current capital.
   * Returns { breached: bool, sessionHigh, drawdownPct }
   */
  update(capital) {
    this._maybeDayReset();

    // Bug fix: NaN capital permanently corrupted sessionHigh — all subsequent
    // drawdown checks returned NaN, making breached always false regardless of actual loss.
    if (typeof capital !== 'number' || !isFinite(capital) || capital < 0) return {
      breached: false, sessionHigh: this._sessionHigh, drawdownPct: 0,
    };

    if (this._sessionHigh === null || capital > this._sessionHigh) {
      this._sessionHigh = capital;
      this._alerted     = false;   // new high → re-arm alert
    }

    const dd = this._sessionHigh > 0
      ? (this._sessionHigh - capital) / this._sessionHigh
      : 0;

    if (dd >= this.limit && !this._alerted) {
      this._alerted = true;
      const msg = `[SessionDD] Intraday drawdown ${(dd*100).toFixed(2)}% from session high $${this._sessionHigh.toFixed(2)} — limit ${(this.limit*100).toFixed(1)}%`;
      this._log(msg);
      if (this._notify) { try { this._notify(msg, 'risk'); } catch(_) {} }

      if (this.haltOnBreach && !this.haltTripped) {
        this.haltTripped = true;
        this._log('[SessionDD] HALT triggered — engine will block new entries until session reset');
        if (this._onHalt) { try { this._onHalt(); } catch(_) {} }
      }
    }

    return { breached: dd >= this.limit, sessionHigh: this._sessionHigh, drawdownPct: dd };
  }

  /**
   * Returns { allowed, reason } — call before entering a position.
   */
  canEnter() {
    if (this.haltOnBreach && this.haltTripped) {
      return {
        allowed: false,
        reason: `Session drawdown halt: down ${(this.limit*100).toFixed(1)}% from intraday high $${(this._sessionHigh||0).toFixed(2)}`,
      };
    }
    return { allowed: true };
  }

  /** Manual reset (e.g. new session, manual override). */
  resetSession() {
    this._sessionHigh = null;
    this._alerted     = false;
    this.haltTripped  = false;
  }

  status() {
    return {
      sessionHigh:  this._sessionHigh,
      haltTripped:  this.haltTripped,
      limit:        this.limit,
    };
  }
}

module.exports = { SessionDrawdownGuard };
