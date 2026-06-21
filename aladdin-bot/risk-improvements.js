'use strict';
// ── risk-improvements.js ──────────────────────────────────────────────────────
// IMPROVEMENT #12-15: Risk Management Enhancements
//
//   #12 DynamicTakeProfit     — TP multiplier based on current regime
//   #13 SessionTimeExits      — force-exit near session close if in loss
//   #14 MonteCarloSizer       — Monte Carlo position sizing (variance-aware Kelly)
//   #15 SessionRiskBudget     — per-session risk allocation (London/NY/Asia)
// ─────────────────────────────────────────────────────────────────────────────

const { TRADING_CONFIG } = require('./trading-config');

// ── #12: Dynamic Take-Profit Based on Regime ──────────────────────────────────
class DynamicTakeProfit {
  constructor(opts = {}) {
    // Regime → ATR multiplier for take profit
    this._regimeMult = {
      TRENDING:   opts.trendingMult   || 4.0,   // wide targets — let winners run
      WEAK_TREND: opts.weakTrendMult  || 2.5,
      RANGING:    opts.rangingMult    || 1.5,   // tight — price will reverse
      UNKNOWN:    opts.unknownMult    || 2.0,
    };
    // Session modifiers: London/NY more volatile → slightly wider
    this._sessionMult = {
      LONDON:   1.15,
      NEW_YORK: 1.10,
      TOKYO:    0.90,   // quieter session — tighter targets
      SYDNEY:   0.85,
      OVERLAP:  1.20,   // London-NY overlap = best conditions
    };
  }

  // Compute dynamic take-profit price from entry
  compute(entryPrice, atr, regime, session, side = 'BUY', volatilityLevel = 'NORMAL') {
    const regimeMult  = this._regimeMult[regime]  || this._regimeMult.UNKNOWN;
    const sessionMult = this._sessionMult[session] || 1.0;
    const volAdj      = volatilityLevel === 'HIGH' ? 1.20 : volatilityLevel === 'LOW' ? 0.80 : 1.0;

    const totalMult   = regimeMult * sessionMult * volAdj;
    const tpDistance  = atr * totalMult;

    const tp = side === 'BUY'
      ? entryPrice + tpDistance
      : entryPrice - tpDistance;

    return {
      tp:         parseFloat(tp.toFixed(5)),
      distance:   parseFloat(tpDistance.toFixed(5)),
      regimeMult, sessionMult, volAdj, totalMult,
      rrRatio:    (tpDistance / (atr * (TRADING_CONFIG.slAtrMult || 1.5))).toFixed(2),
    };
  }

  // Adjust an existing TP based on regime change (trail TP with market)
  adjust(currentTP, entryPrice, atr, newRegime, session, side) {
    const newResult = this.compute(entryPrice, atr, newRegime, session, side);
    // Only widen TP (never bring it closer to price — that's the trailing stop's job)
    if (side === 'BUY'  && newResult.tp > currentTP) return newResult;
    if (side === 'SELL' && newResult.tp < currentTP) return newResult;
    return { tp: currentTP, adjusted: false };
  }
}

// ── #13: Session-Based Time Exits ─────────────────────────────────────────────
class SessionTimeExits {
  constructor(opts = {}) {
    // Session close times (UTC)
    this._sessions = {
      LONDON:   { closeHour: 16, closeMin: 30 },  // 16:30 UTC
      NEW_YORK: { closeHour: 21, closeMin: 0  },  // 21:00 UTC
      TOKYO:    { closeHour:  9, closeMin: 0  },  //  9:00 UTC
      SYDNEY:   { closeHour:  7, closeMin: 0  },  //  7:00 UTC
    };
    this._minutesBefore = opts.minutesBefore || 30;   // exit 30 min before close if in loss
    this._lossThreshold = opts.lossThreshold || -0.001; // only exit if in loss > 0.1%
    this._weekendExitFriHour = opts.weekendExitFriHour || 20;  // Friday 20:00 UTC = pre-weekend
  }

  // Check if any session close exit should fire
  // position: { entry, side, ... }
  // currentPrice: number
  // Returns: { shouldExit, reason } or null
  check(position, currentPrice) {
    if (!position) return null;

    const now    = new Date();
    const utcH   = now.getUTCHours();
    const utcM   = now.getUTCMinutes();
    const utcDay = now.getUTCDay();   // 0=Sun, 5=Fri, 6=Sat

    // ── Weekend exit: close all positions by Friday 20:00 UTC ───────────
    if (utcDay === 5 && utcH >= this._weekendExitFriHour) {
      return { shouldExit: true, reason: `Weekend risk: Friday ${utcH}:${utcM} UTC — closing before weekend gap` };
    }

    // ── P&L check for session-close exits ───────────────────────────────
    const isShort = position.side === 'SHORT';
    const pnlPct  = isShort
      ? (position.entry - currentPrice) / position.entry
      : (currentPrice - position.entry) / position.entry;

    // Only force-exit near session close IF in loss (let winners ride)
    if (pnlPct >= this._lossThreshold) return null;  // not in significant loss

    const totalMin = utcH * 60 + utcM;

    for (const [session, { closeHour, closeMin }] of Object.entries(this._sessions)) {
      const closeTotal = closeHour * 60 + closeMin;
      const minsToClose = closeTotal - totalMin;

      if (minsToClose >= 0 && minsToClose <= this._minutesBefore) {
        return {
          shouldExit: true,
          reason: `${session} close in ${minsToClose}min — exiting loss position (${(pnlPct * 100).toFixed(2)}%)`,
          session, minsToClose, pnlPct,
        };
      }
    }
    return null;
  }
}

// ── #14: Monte Carlo Position Sizer ──────────────────────────────────────────
// Simulates thousands of random trade sequences based on historical win/loss/size.
// Returns the Kelly fraction that keeps 95th-percentile drawdown under target.
class MonteCarloSizer {
  constructor(opts = {}) {
    this._simCount      = opts.simCount      || 1000;  // simulation runs
    this._targetMaxDD   = opts.targetMaxDD   || 0.15;  // stay under 15% max drawdown
    this._ddPercentile  = opts.ddPercentile  || 0.95;  // 95th percentile
    this._kellyFractions = [0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50];
  }

  // trades: array of { pnlPct } from closed trade history
  // Returns: { recommendedKelly, p95Drawdown, simResult }
  compute(trades) {
    if (!trades || trades.length < 10) {
      return { recommendedKelly: TRADING_CONFIG.kellyFraction || 0.5, p95Drawdown: null, simCount: 0 };
    }

    const pnls = trades.map(t => typeof t.pnlPct === 'number' ? t.pnlPct : (t.profit || 0) / 100);

    let bestKelly = null;
    let bestDD    = null;

    for (const kelly of this._kellyFractions) {
      const drawdowns = this._simulate(pnls, kelly);
      drawdowns.sort((a, b) => a - b);
      const p95 = drawdowns[Math.floor(drawdowns.length * this._ddPercentile)];

      if (p95 <= this._targetMaxDD) {
        bestKelly = kelly;
        bestDD    = p95;
      }
    }

    // If no fraction stays under target, use most conservative
    if (bestKelly === null) {
      bestKelly = this._kellyFractions[0];
      const drawdowns = this._simulate(pnls, bestKelly);
      drawdowns.sort((a, b) => a - b);
      bestDD = drawdowns[Math.floor(drawdowns.length * this._ddPercentile)];
    }

    return {
      recommendedKelly: bestKelly,
      p95Drawdown:      parseFloat(bestDD.toFixed(4)),
      tradeHistory:     trades.length,
      simCount:         this._simCount,
    };
  }

  _simulate(pnls, kellyFraction) {
    const drawdowns = [];
    for (let sim = 0; sim < this._simCount; sim++) {
      let capital = 1.0, peak = 1.0, maxDD = 0;
      for (let t = 0; t < Math.min(pnls.length * 2, 100); t++) {
        // Bootstrap resample: random trade from history
        const trade = pnls[Math.floor(Math.random() * pnls.length)];
        capital    *= (1 + trade * kellyFraction);
        if (capital > peak) peak = capital;
        const dd = (peak - capital) / peak;
        if (dd > maxDD) maxDD = dd;
      }
      drawdowns.push(maxDD);
    }
    return drawdowns;
  }
}

// ── #15: Per-Session Risk Budget ──────────────────────────────────────────────
// Allocates daily risk across sessions to prevent one bad session
// from consuming the entire daily loss limit.
class SessionRiskBudget {
  constructor(opts = {}) {
    // Fraction of daily risk budget per session
    this._budgets = {
      LONDON:   opts.londonBudget   || 0.40,   // 40% of daily budget
      NEW_YORK: opts.nyBudget       || 0.40,   // 40%
      TOKYO:    opts.tokyoBudget    || 0.15,   // 15%
      SYDNEY:   opts.sydneyBudget   || 0.05,   // 5%
      OVERLAP:  opts.overlapBudget  || 0.10,   // extra for overlap
    };

    // Track usage per session (resets daily)
    this._usage      = {};
    this._lastDate   = null;
    this._resetUsage();
  }

  _resetUsage() {
    this._usage = { LONDON: 0, NEW_YORK: 0, TOKYO: 0, SYDNEY: 0, OVERLAP: 0 };
  }

  // Record a loss against the current session budget
  // loss: positive number (e.g. 0.01 = 1% loss)
  recordLoss(session, loss, date) {
    if (date && date !== this._lastDate) {
      this._resetUsage();
      this._lastDate = date;
    }
    const key = this._normalizeSession(session);
    this._usage[key] = (this._usage[key] || 0) + Math.abs(loss);
  }


  // Get max position size fraction for this session (#75 Kelly integration)
  getMaxRisk(sessionOrHour) {
    const session = typeof sessionOrHour === 'number'
      ? this._hourToSession(sessionOrHour) 
      : this._normalizeSession(sessionOrHour);
    // Map session budget fraction to max position size
    const sessionFractions = {
      TOKYO:    0.005,   // 0.5% max in thin Asian session (basis: historical spread 2-4× London)
      // Fix #17: Thresholds validated against kellyMaxSize at startup — see _validateSessionBudgets()
      SYDNEY:   0.003,   // 0.3% overnight
      LONDON:   0.015,   // 1.5% liquid London session
      NEW_YORK: 0.015,   // 1.5% liquid NY session
      OVERLAP:  0.020,   // 2.0% highest liquidity overlap
    };
    return sessionFractions[session] || 0.010;
  }

  _hourToSession(utcHour) {
    if (utcHour >= 23 || utcHour < 7)  return 'SYDNEY';
    if (utcHour >= 7  && utcHour < 8)  return 'LONDON';
    if (utcHour >= 8  && utcHour < 12) return 'LONDON';
    if (utcHour >= 12 && utcHour < 16) return 'OVERLAP';
    if (utcHour >= 16 && utcHour < 21) return 'NEW_YORK';
    if (utcHour >= 21 && utcHour < 23) return 'TOKYO';
    return 'TOKYO';
  }

  // Fix #17: Validate session budgets don't exceed kellyMaxSize silently
  _validateSessionBudgets(kellyMaxSize) {
    const maxSession = Math.max(...Object.values(this.budgets));
    if (kellyMaxSize && maxSession > kellyMaxSize) {
      console.warn(`[SessionBudget #17] Session cap ${maxSession} > kellyMaxSize ${kellyMaxSize} — session cap is binding constraint`);
      require('./telegram')?.send?.(`⚠️ Session budget ${maxSession} exceeds kellyMaxSize ${kellyMaxSize}`, 'risk');
    }
  }
  // Can we trade in this session? (budget not exceeded)
  canTrade(session, dailyLossLimit, date) {
    if (date && date !== this._lastDate) {
      this._resetUsage();
      this._lastDate = date;
    }
    const key    = this._normalizeSession(session);
    const budget = (this._budgets[key] || 0.20) * dailyLossLimit;
    const used   = this._usage[key] || 0;
    const remaining = budget - used;

    return {
      canTrade:       remaining > 0,
      budget:         parseFloat(budget.toFixed(4)),
      used:           parseFloat(used.toFixed(4)),
      remaining:      parseFloat(remaining.toFixed(4)),
      usedPct:        parseFloat((used / budget * 100).toFixed(1)),
      session:        key,
    };
  }

  // Get available position size fraction based on remaining budget
  getSizeMod(session, dailyLossLimit, date) {
    const status = this.canTrade(session, dailyLossLimit, date);
    if (!status.canTrade) return 0;
    // Scale down as budget gets used up
    return Math.min(1, status.remaining / (status.budget * 0.5));
  }

  status(dailyLossLimit) {
    return Object.keys(this._budgets).map(session => ({
      session,
      ...this.canTrade(session, dailyLossLimit, this._lastDate),
    }));
  }

  _normalizeSession(s) {
    if (!s) return 'NEW_YORK';
    const u = s.toUpperCase().replace(/[^A-Z]/g, '_');
    if (u.includes('LONDON')) return 'LONDON';
    if (u.includes('NEW') || u.includes('YORK') || u.includes('NY')) return 'NEW_YORK';
    if (u.includes('TOKYO') || u.includes('ASIA')) return 'TOKYO';
    if (u.includes('SYDNEY') || u.includes('AUS')) return 'SYDNEY';
    if (u.includes('OVERLAP')) return 'OVERLAP';
    return 'NEW_YORK';
  }
}

module.exports = { DynamicTakeProfit, SessionTimeExits, MonteCarloSizer, SessionRiskBudget };
