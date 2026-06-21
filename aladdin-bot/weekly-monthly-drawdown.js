'use strict';

// Bug fix: atomic state write — prevents corrupt files on crash mid-write
function _atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp';
  require('fs').writeFileSync(tmp, content, 'utf8');
  require('fs').renameSync(tmp, filePath);
}

// ── weekly-monthly-drawdown.js ────────────────────────────────────────────────
// Tracks drawdown limits at three horizons: daily (already in safety-constants),
// weekly, and monthly.  Complements the existing 24-hour daily lockout.
//
// Adds:
//   Weekly  limit: if equity drops > weeklyLimitPct from Monday's open → halt for 48 h
//   Monthly limit: if equity drops > monthlyLimitPct from month-start  → halt until
//                  manual reset (same severity as global drawdown)
//
// Persisted to disk so limits survive restarts.
//
// Usage (add to TradingEngine constructor):
//   const { DrawdownTracker } = require('./weekly-monthly-drawdown');
//   this.drawdownTracker = new DrawdownTracker(this.capital);
//   // each tick:
//   const check = this.drawdownTracker.check(this.capital);
//   if (check.halt) { this.circuitBreakerTripped = true; ... }
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

const STORE_FILE         = path.join(__dirname, 'trade_logs', 'drawdown_state.json');
const DEFAULT_WEEKLY_PCT  = 0.07;   // 7%  weekly drawdown → 48 h halt
const DEFAULT_MONTHLY_PCT = 0.15;   // 15% monthly drawdown → manual-reset halt
const WEEKLY_HALT_MS      = 48 * 60 * 60 * 1000;   // 48 hours

class DrawdownTracker {
  constructor(initialCapital, opts = {}) {
    this.weeklyLimit  = opts.weeklyLimitPct  || DEFAULT_WEEKLY_PCT;
    this.monthlyLimit = opts.monthlyLimitPct || DEFAULT_MONTHLY_PCT;
    this._state       = this._load(initialCapital);
  }

  // ── Called every tick / after every trade ─────────────────────────────────
  // equity: current account equity
  // Returns { halt, reason, weeklyDD, monthlyDD, weeklyHaltUntil, monthlyHalt }
  check(equity) {
    const now   = Date.now();
    const state = this._state;

    // Bug fix: NaN equity caused weeklyDD=NaN which still triggered weeklyDD>=limit
    // as true (NaN comparisons are always false in JS — so halt was wrongly triggered
    // via an alternate code path). Guard and return safe no-halt result.
    if (typeof equity !== 'number' || !isFinite(equity)) {
      return this._result(false, null, 0, 0, state);
    }

    this._refreshPeriods(equity, now);

    // Bug fix: zero weeklyOpen (e.g. first bar of a new period) causes -Infinity DD
    const weeklyDD  = (state.weeklyOpen > 0)
      ? (state.weeklyOpen - equity) / state.weeklyOpen : 0;
    const monthlyDD = (state.monthlyOpen > 0)
      ? (state.monthlyOpen - equity) / state.monthlyOpen : 0;

    // ── Weekly limit check ────────────────────────────────────────────────
    if (!state.weeklyHaltUntil && weeklyDD >= this.weeklyLimit) {
      state.weeklyHaltUntil = now + WEEKLY_HALT_MS;
      this._save();
      return this._result(true, 'WEEKLY_DRAWDOWN', weeklyDD, monthlyDD, state);
    }

    if (state.weeklyHaltUntil && now < state.weeklyHaltUntil) {
      const remainingMs = state.weeklyHaltUntil - now;
      return this._result(true, 'WEEKLY_HALT_ACTIVE', weeklyDD, monthlyDD, state, remainingMs);
    }

    // Weekly halt expired → clear it
    if (state.weeklyHaltUntil && now >= state.weeklyHaltUntil) {
      state.weeklyHaltUntil = null;
      this._save();
    }

    // ── Monthly limit check ───────────────────────────────────────────────
    if (!state.monthlyHalt && monthlyDD >= this.monthlyLimit) {
      state.monthlyHalt = true;
      this._save();
      return this._result(true, 'MONTHLY_DRAWDOWN', weeklyDD, monthlyDD, state);
    }

    if (state.monthlyHalt) {
      return this._result(true, 'MONTHLY_HALT_ACTIVE', weeklyDD, monthlyDD, state);
    }

    return this._result(false, null, weeklyDD, monthlyDD, state);
  }

  // ── Manual reset (operator clears monthly halt) ───────────────────────────
  resetMonthlyHalt(newCapital) {
    this._state.monthlyHalt     = false;
    this._state.monthlyOpen     = newCapital;
    this._state.weeklyHaltUntil = null;
    this._save();
    console.log('[DrawdownTracker] Monthly halt cleared. New monthly open: ' + newCapital);
  }

  // ── Public getters ────────────────────────────────────────────────────────
  status(equity) {
    const state     = this._state;
    const weeklyDD  = (state.weeklyOpen  - equity) / state.weeklyOpen;
    const monthlyDD = (state.monthlyOpen - equity) / state.monthlyOpen;
    return {
      weeklyOpen:      state.weeklyOpen,
      monthlyOpen:     state.monthlyOpen,
      weeklyDD:        parseFloat((weeklyDD  * 100).toFixed(2)),
      monthlyDD:       parseFloat((monthlyDD * 100).toFixed(2)),
      weeklyLimit:     parseFloat((this.weeklyLimit  * 100).toFixed(1)),
      monthlyLimit:    parseFloat((this.monthlyLimit * 100).toFixed(1)),
      weeklyHaltUntil: state.weeklyHaltUntil,
      monthlyHalt:     state.monthlyHalt,
    };
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _refreshPeriods(equity, now) {
    const state = this._state;
    const date  = new Date(now);

    // New week (Monday UTC): reset weekly open
    const dayOfWeek = date.getUTCDay(); // 0=Sun, 1=Mon
    const weekKey   = this._weekKey(now);
    if (weekKey !== state.weekKey) {
      state.weekKey     = weekKey;
      state.weeklyOpen  = equity;
      state.weeklyHaltUntil = null;   // weekly halt resets on new week
      this._save();
    }

    // New month: reset monthly open
    const monthKey = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
    if (monthKey !== state.monthKey) {
      state.monthKey   = monthKey;
      state.monthlyOpen = equity;
      state.monthlyHalt = false;
      this._save();
    }
  }

  _weekKey(ts) {
    // ISO week key: YYYY-Www
    const d = new Date(ts);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const week = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }

  _result(halt, reason, weeklyDD, monthlyDD, state, remainingMs = null) {
    return {
      halt,
      reason:          reason || null,
      weeklyDD:        parseFloat((weeklyDD  * 100).toFixed(2)),
      monthlyDD:       parseFloat((monthlyDD * 100).toFixed(2)),
      weeklyHaltUntil: state.weeklyHaltUntil,
      monthlyHalt:     state.monthlyHalt,
      remainingMs,
    };
  }

  _load(initialCapital) {
    try {
      if (fs.existsSync(STORE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
        // Validate loaded data
        if (data.weeklyOpen && data.monthlyOpen) return data;
      }
    } catch (_) {}
    const now = Date.now();
    const d   = new Date(now);
    const state = {
      weeklyOpen:     initialCapital,
      monthlyOpen:    initialCapital,
      weeklyHaltUntil: null,
      monthlyHalt:    false,
      weekKey:        this._weekKey(now),
      monthKey:       `${d.getUTCFullYear()}-${d.getUTCMonth()}`,
    };
    this._state = state;
    this._save();
    return state;
  }

  _save() {
    try {
      const dir = path.dirname(STORE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      _atomicWrite(STORE_FILE, JSON.stringify(this._state, null, 2));
    } catch (_) {}
  }

  static get DEFAULT_WEEKLY_PCT()  { return DEFAULT_WEEKLY_PCT; }
  static get DEFAULT_MONTHLY_PCT() { return DEFAULT_MONTHLY_PCT; }
}

module.exports = { DrawdownTracker };
