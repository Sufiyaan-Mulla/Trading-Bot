'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  liquidity-scorer.js
//  Formal Liquidity Scoring + Volume-Weighted Signal Filter
//
//  Problem it solves
//  ─────────────────
//  The existing bot has ad-hoc volume checks: each strategy applies different
//  volume thresholds inconsistently. A weak bar that passes TrendStrategy's
//  75%-of-avg check might fail MeanReversion's 60% check, or vice versa.
//  There is no unified view of market liquidity.
//
//  What this module does
//  ─────────────────────
//  Produces a single authoritative LiquidityScore (0–100) every bar from five
//  components, classifies the market into a LiquidityRegime (DEEP/NORMAL/THIN/DRY),
//  and emits a confidence multiplier that all strategies apply uniformly.
//
//  Score components (100 pts total)
//  ─────────────────────────────────
//  1. Relative volume — short (20-bar):  0–35 pts
//     Current bar volume vs 20-bar average. Captures intraday rhythm.
//
//  2. Relative volume — long (200-bar):  0–20 pts
//     Current bar volume vs 200-bar average. Captures structural liquidity.
//     Falls back to 20-bar avg when fewer than 200 bars available.
//
//  3. Volume trend (5-bar):              0–15 pts
//     Is volume rising or falling recently? Rising = more interest, more pts.
//
//  4. Volume consistency (20-bar CV):    0–15 pts
//     Low coefficient of variation = stable, predictable liquidity = more pts.
//     High CV = erratic volume = less reliable market depth.
//
//  5. Session bonus/penalty:             −20 to +15 pts
//     Forex liquidity varies strongly by time of day (UTC):
//       London + NY overlap (13:00–16:00) → +15 pts  (highest liquidity)
//       London session     (08:00–16:00)  → +10 pts
//       New York session   (13:00–21:00)  → +10 pts
//       Asian session      (00:00–08:00)  → − 5 pts  (lower FX liquidity)
//       Off-hours          (21:00–00:00)  → −15 pts  (very thin)
//
//  Liquidity Regimes
//  ─────────────────
//  DEEP   score ≥ 75  → confidenceMultiplier = 1.00  (full signal strength)
//  NORMAL score ≥ 50  → confidenceMultiplier = 0.92  (slight reduction)
//  THIN   score ≥ 25  → confidenceMultiplier = 0.75  (significant reduction)
//  DRY    score <  25  → confidenceMultiplier = 0.00  (block all entries)
//
//  Usage
//  ─────
//  const scorer = new LiquidityScorer();
//  const result = scorer.score(volumeHistory, prices, nowUtcHour);
//  // result: { score, regime, multiplier, components, blocked, reason }
//
//  Strategies apply: effectiveConf = Math.round(rawConf * result.multiplier)
//  Entry gate:       if (result.blocked) return HOLD;
// ═══════════════════════════════════════════════════════════════════════════════

// ── Regime thresholds ─────────────────────────────────────────────────────────
const REGIMES = [
  { name: 'DEEP',   minScore: 75, multiplier: 1.00, blocked: false },
  { name: 'NORMAL', minScore: 50, multiplier: 0.92, blocked: false },
  { name: 'THIN',   minScore: 25, multiplier: 0.75, blocked: false },
  { name: 'DRY',    minScore:  0, multiplier: 0.00, blocked: true  },
];

// ── Session windows (UTC hours, inclusive start exclusive end) ────────────────
// Overlap of London + NY is the peak liquidity window for forex
const SESSIONS = [
  { name: 'LONDON_NY_OVERLAP', startH: 13, endH: 16, bonus: +15 },
  { name: 'LONDON',            startH:  8, endH: 16, bonus: +10 },
  { name: 'NEW_YORK',          startH: 13, endH: 21, bonus: +10 },
  { name: 'ASIAN',             startH:  0, endH:  8, bonus:  -5 },
  { name: 'OFF_HOURS',         startH: 21, endH: 24, bonus: -15 },
];

// ── Config ────────────────────────────────────────────────────────────────────
const SCORER_CONFIG = {
  shortWindow:    20,    // bars for short relative volume
  longWindow:    200,    // bars for long relative volume
  trendWindow:     5,    // bars for volume trend direction
  cvWindow:       20,    // bars for consistency (coefficient of variation)

  // Component max points
  shortRelVolMax:  35,
  longRelVolMax:   20,
  trendMax:        15,
  consistencyMax:  15,
  sessionMax:      15,
  sessionMin:     -20,

  // Relative volume breakpoints → points
  // e.g. volRatio >= 2.0 → full shortRelVolMax pts
  shortVolBreakpoints: [
    { ratio: 2.0, pts: 35 },
    { ratio: 1.5, pts: 28 },
    { ratio: 1.2, pts: 22 },
    { ratio: 1.0, pts: 17 },
    { ratio: 0.75, pts: 10 },
    { ratio: 0.5, pts:  4 },
    { ratio: 0.0, pts:  0 },
  ],
  longVolBreakpoints: [
    { ratio: 1.5, pts: 20 },
    { ratio: 1.2, pts: 15 },
    { ratio: 1.0, pts: 10 },
    { ratio: 0.75, pts:  5 },
    { ratio: 0.0, pts:  0 },
  ],

  // Enable/disable session adjustment (set false for non-forex assets)
  sessionAdjustEnabled: true,
};

// ── LiquidityScorer ───────────────────────────────────────────────────────────
class LiquidityScorer {
  constructor (cfg = {}) {
    this.cfg      = { ...SCORER_CONFIG, ...cfg };
    this.history  = [];   // rolling score history (last 50)
    this.lastResult = null;
  }

  // ── Main scoring method ───────────────────────────────────────────────────
  // volumeHistory: array of bar volumes (most recent last)
  // prices:        array of close prices (most recent last, same length)
  // utcHour:       current UTC hour 0–23 (optional, for session bonus)
  score (volumeHistory, prices = [], utcHour = null) {
    if (!volumeHistory || volumeHistory.length === 0) {
      // BUG-5 fix: return 'no_volume_data' regime (not 'NORMAL') so callers can
      // distinguish "no data" from "data looks normal". The old return said NORMAL
      // which hid missing-volume errors silently.
      return this._makeResult(50, {
        shortRelVol: 17, longRelVol: 10, trend: 7, consistency: 7, session: 0,
      }, 'no_volume_data');
    }
    const vols = Array.isArray(volumeHistory) ? volumeHistory : [];
    const n    = vols.length;

    if (n === 0) {
      return this._makeResult(50, {
        shortRelVol: 17, longRelVol: 10, trend: 7, consistency: 7, session: 0,
      }, 'no_volume_data');
    }

    const currentVol = vols[n - 1] ?? 0;

    // ── Component 1: Short relative volume (20-bar) ───────────────────────
    const shortWin  = Math.min(n, this.cfg.shortWindow);
    const shortAvg  = shortWin > 0
      ? vols.slice(-shortWin).reduce((s, v) => s + v, 0) / shortWin
      : currentVol;
    const shortRatio = shortAvg > 0 ? currentVol / shortAvg : 1;
    const shortPts   = this._breakpointScore(shortRatio, this.cfg.shortVolBreakpoints);

    // ── Component 2: Long relative volume (200-bar) ───────────────────────
    const longWin   = Math.min(n, this.cfg.longWindow);
    const longAvg   = longWin > 0
      ? vols.slice(-longWin).reduce((s, v) => s + v, 0) / longWin
      : shortAvg;
    const longRatio  = longAvg > 0 ? currentVol / longAvg : 1;
    const longPts    = this._breakpointScore(longRatio, this.cfg.longVolBreakpoints);

    // ── Component 3: Volume trend (5-bar slope) ───────────────────────────
    const trendWin  = Math.min(n, this.cfg.trendWindow + 1);
    const trendPts  = this._volumeTrend(vols.slice(-trendWin));

    // ── Component 4: Volume consistency (CV over 20 bars) ─────────────────
    const cvWin     = Math.min(n, this.cfg.cvWindow);
    const cvPts     = this._volumeConsistency(vols.slice(-cvWin));

    // ── Component 5: Session bonus/penalty ────────────────────────────────
    const sessionPts = (this.cfg.sessionAdjustEnabled && utcHour !== null)
      ? this._sessionBonus(utcHour)
      : 0;

    // ── Total score ────────────────────────────────────────────────────────
    const rawScore = shortPts + longPts + trendPts + cvPts + sessionPts;
    const score    = Math.max(0, Math.min(100, Math.round(rawScore)));

    const components = {
      shortRelVol:  shortPts,
      longRelVol:   longPts,
      trend:        trendPts,
      consistency:  cvPts,
      session:      sessionPts,
      shortRatio:   parseFloat(shortRatio.toFixed(3)),
      longRatio:    parseFloat(longRatio.toFixed(3)),
      shortAvg:     Math.round(shortAvg),
      longAvg:      Math.round(longAvg),
      currentVol:   Math.round(currentVol),
    };

    const result = this._makeResult(score, components);
    this.history.push({ score, regime: result.regime, ts: Date.now() });
    if (this.history.length > 50) this.history.shift();
    this.lastResult = result;

    return result;
  }

  // ── Component helpers ─────────────────────────────────────────────────────

  // Piecewise linear score from a breakpoint table
  _breakpointScore (ratio, breakpoints) {
    for (const bp of breakpoints) {
      if (ratio >= bp.ratio) return bp.pts;
    }
    return 0;
  }

  // Volume trend: compare average of last half vs first half of window
  // Rising volume = positive score, falling = zero
  _volumeTrend (window) {
    if (window.length < 2) return Math.round(this.cfg.trendMax / 2);
    const half     = Math.max(1, Math.floor(window.length / 2));
    const firstHalf = window.slice(0, half);
    const lastHalf  = window.slice(-half);
    const firstAvg  = firstHalf.reduce((s, v) => s + v, 0) / firstHalf.length;
    const lastAvg   = lastHalf.reduce((s, v)  => s + v, 0) / lastHalf.length;

    if (firstAvg <= 0) return Math.round(this.cfg.trendMax / 2);

    const changePct = (lastAvg - firstAvg) / firstAvg;  // positive = rising

    if (changePct >= 0.30) return this.cfg.trendMax;       // very strong surge
    if (changePct >= 0.15) return Math.round(this.cfg.trendMax * 0.80);
    if (changePct >= 0.05) return Math.round(this.cfg.trendMax * 0.60);
    if (changePct >= -0.05) return Math.round(this.cfg.trendMax * 0.40); // flat
    if (changePct >= -0.20) return Math.round(this.cfg.trendMax * 0.20); // declining
    return 0;                                              // sharp decline
  }

  // Volume consistency: lower CV = more predictable liquidity = more pts
  _volumeConsistency (window) {
    if (window.length < 2) return Math.round(this.cfg.consistencyMax / 2);
    const mean = window.reduce((s, v) => s + v, 0) / window.length;
    if (mean <= 0) return 0;
    const std  = Math.sqrt(window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length);
    const cv   = std / mean;   // coefficient of variation

    // Low CV = consistent = high score
    if (cv <= 0.15) return this.cfg.consistencyMax;
    if (cv <= 0.30) return Math.round(this.cfg.consistencyMax * 0.80);
    if (cv <= 0.50) return Math.round(this.cfg.consistencyMax * 0.55);
    if (cv <= 0.80) return Math.round(this.cfg.consistencyMax * 0.30);
    if (cv <= 1.20) return Math.round(this.cfg.consistencyMax * 0.10);
    return 0;
  }

  // Session bonus/penalty based on UTC hour
  _sessionBonus (utcHour) {
    const h = utcHour % 24;

    // Check overlap first (highest priority)
    if (h >= 13 && h < 16) return 15;   // London + NY overlap

    // Then individual sessions
    if (h >= 8  && h < 16) return 10;   // London only
    if (h >= 13 && h < 21) return 10;   // NY session (16–20 UTC pure NY; 13–15 caught by overlap above)
    if (h >= 0  && h < 8 ) return -5;   // Asian session
    if (h >= 21 && h < 24) return -15;  // Off-hours (21:00–00:00)

    return 0;
  }

  // Build the full result object
  _makeResult (score, components, note = '') {
    const regime = REGIMES.find(r => score >= r.minScore) || REGIMES.at(-1);
    return {
      score,
      regime:      regime.name,
      multiplier:  regime.multiplier,
      blocked:     regime.blocked,
      components,
      note,
      // Human-readable reason for blocking or reducing confidence
      reason: regime.blocked
        ? `DRY market (score ${score}/100) — volume insufficient for reliable fills`
        : regime.multiplier < 1.0
        ? `${regime.name} liquidity (score ${score}/100) — confidence reduced to ${Math.round(regime.multiplier * 100)}%`
        : `DEEP liquidity (score ${score}/100) — full signal strength`,
    };
  }

  // ── Apply to signal confidence ────────────────────────────────────────────
  // Accepts a raw confidence value (0–100) and applies the liquidity multiplier.
  // Returns { effectiveConf, blocked, adjustment, regime }
  applyToConfidence (rawConf, liquidityResult) {
    if (!liquidityResult) return { effectiveConf: rawConf, blocked: false, adjustment: 0, regime: 'UNKNOWN' };
    if (liquidityResult.blocked) {
      return {
        effectiveConf: 0,
        blocked: true,
        adjustment:   -rawConf,
        regime:       liquidityResult.regime,
        reason:       liquidityResult.reason,
      };
    }
    const effectiveConf = Math.round(rawConf * liquidityResult.multiplier);
    return {
      effectiveConf,
      blocked:    false,
      adjustment: effectiveConf - rawConf,
      regime:     liquidityResult.regime,
      reason:     liquidityResult.reason,
    };
  }

  // ── Status ────────────────────────────────────────────────────────────────
  status () {
    const recent = this.history.slice(-10);
    const avgScore = recent.length > 0
      ? Math.round(recent.reduce((s, r) => s + r.score, 0) / recent.length)
      : null;

    const regimeCounts = {};
    for (const r of this.history) {
      regimeCounts[r.regime] = (regimeCounts[r.regime] || 0) + 1;
    }

    return {
      lastScore:    this.lastResult?.score ?? null,
      lastRegime:   this.lastResult?.regime ?? null,
      lastMultiplier: this.lastResult?.multiplier ?? null,
      avgScore10Bar: avgScore,
      regimeCounts,
      historyLength: this.history.length,
    };
  }
}

module.exports = { LiquidityScorer, REGIMES, SESSIONS, SCORER_CONFIG };
