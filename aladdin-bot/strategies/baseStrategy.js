'use strict';
const { SAFETY } = require('../safety-constants');

// ═══════════════════════════════════════════════════════════════════════════════
//  strategies/baseStrategy.js
//  Abstract base class for all trading strategies.
//
//  Every strategy:
//    1. Implements decide(indicators, context) → { action, confidence, reasoning }
//    2. Inherits shared filters: ATR gate, MTA confirmation, leading indicator
//       check, performance state adjustment, confidence floor.
//    3. Is stateless — it never touches the engine directly. The engine passes
//       indicators + context in, and gets a decision back.
//
//  To add a new strategy:
//    const { BaseStrategy } = require('./baseStrategy');
//    class MyStrategy extends BaseStrategy {
//      _decide(indicators, context) { ... return { action, confidence, reasoning }; }
//    }
// ═══════════════════════════════════════════════════════════════════════════════

class BaseStrategy {
  constructor (name, opts = {}) {
    this.name        = name;
    this.minConf     = opts.minConfidence  || 60;
    // BUG-10 fix: previous default of 0.08% blocked all simulation entries because
    // the random-walk simulator generates ATR% ≈ 0.03-0.05%. Real EURUSD ATR is
    // typically 0.04-0.12% on M5. Lowered to 0.03% — blocks only truly dead markets.
    this.atrLowPct   = opts.atrLowPct     || 0.03;   // quiet market gate (was 0.08)
    this.atrHighPct  = opts.atrHighPct    || 2.20;   // extreme volatility gate
    this.enabled     = opts.enabled !== false;
  }

  // ── Public entry point — called by TradingEngine ─────────────────────────
  // Returns { action: 'BUY'|'SELL'|'HOLD', confidence: 0-95, reasoning: string }
  decide (indicators, context = {}) {
    if (!this.enabled) {
      return this._hold('Strategy disabled');
    }

    // ── Shared Layer 1: ATR volatility gate ──────────────────────────────
    const atrPct = this._num(indicators.atrPercent);
    if (atrPct > 0 && atrPct < this.atrLowPct) {
      return this._hold(`[${this.name}] ATR gate: market too quiet (${atrPct.toFixed(3)}%)`);
    }
    if (atrPct > this.atrHighPct) {
      return this._hold(`[${this.name}] ATR gate: extreme volatility (${atrPct.toFixed(2)}%) — standing aside`);
    }

    // ── Core strategy logic (implemented by subclass) ────────────────────
    let result = this._decide(indicators, context);
    if (!result) result = this._hold('No signal');

    // ── Shared Layer 2: MTA confirmation ─────────────────────────────────
    const mta = indicators.mta;
    if (mta && result.action !== 'HOLD') {
      if (!mta.allowed) {
        return this._hold(`[MTA BLOCK] ${mta.reason}`);
      }
      const boost   = Math.round((mta.score || 0) * 20);
      result.confidence  = Math.min(95, result.confidence + boost);
      result.reasoning  += ` | MTA +${boost}pts`;
    }

    // ── Shared Layer 3: Leading indicator bias ────────────────────────────
    const ls = indicators.leadingSignal;
    if (ls && result.action !== 'HOLD') {
      // Early exit takes priority over all other leading signal logic
      if (ls.earlyExit && context.hasPosition) {
        // BUG-27 fix: SHORT positions exit by buying back, LONG positions exit by selling
        const exitAction = context.position?.side === 'SHORT' ? 'BUY' : 'SELL';
        return { action: exitAction, confidence: 85, reasoning: `[LEADING EARLY EXIT] ${ls.detail}` };
      }
      if (result.action === 'BUY' && ls.bias === 'BEARISH') {
        return { action: 'HOLD', confidence: 35, reasoning: `[LEADING BLOCK] ${ls.detail}` };
      }
      if (ls.bias === 'BULLISH' && result.action === 'BUY') {
        const boost = Math.min(10, Math.abs(ls.score || 0) * 3);
        result.confidence = Math.min(95, result.confidence + boost);
        result.reasoning += ` | LEADING +${boost}pts`;
      }
    }

    // ── Shared Layer 4: Performance state adjustment ──────────────────────
    const perf = indicators.performanceState;
    if (perf && result.action === 'BUY') {
      const volRegime  = indicators.volatilityLevel;
      const regimeStat = perf.patterns?.[`winRate_${volRegime}`];
      if (regimeStat && regimeStat.trades >= 3) {
        if (regimeStat.winRate < 35) {
          const penalty     = Math.round((35 - regimeStat.winRate) * 0.8);
          result.confidence -= penalty;
          result.reasoning  += ` | PERF -${penalty}pts`;
        } else if (regimeStat.winRate >= 65) {
          const bonus       = Math.min(10, Math.round((regimeStat.winRate - 65) * 0.4));
          result.confidence += bonus;
          result.reasoning  += ` | PERF +${bonus}pts`;
        }
      }
      const _totalTrades = this._engine?.trades?.length || 0;
      if (perf.confidence === 'POOR' && _totalTrades >= 20) {
        return this._hold(`[PERF BLOCK] Win rate critically low (${perf.overallWinRate}%) after ${_totalTrades} trades`);
      }
      result.confidence = Math.min(95, Math.max(0, result.confidence));
    }

    // ── Shared Layer 5: Confidence floor (BUY only) ───────────────────────
    if (result.action === 'BUY' && result.confidence < this.minConf) {
      return this._hold(`[${this.name}] Confidence ${result.confidence}% below floor ${this.minConf}%`);
    }

    return result;
  }

  // ── Must be implemented by subclass ──────────────────────────────────────
  _decide (indicators, context) {
    throw new Error(`${this.name}._decide() not implemented`);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  _hold (reason = 'No signal') {
    return { action: 'HOLD', confidence: 0, reasoning: reason };
  }

  _num (v, fallback = 0) {
    if (v == null) return fallback;
    const n = typeof v === 'string' ? parseFloat(v) : v;
    return isNaN(n) ? fallback : n;
  }

  // Parse ML result into usable confidence + tag
  _mlResult (mlResult) {
    const use = mlResult?.confidence != null;
    return {
      use,
      conf: mlResult?.confidence ?? null,
      tag:  use
        ? ` [ML:${mlResult.confidence}% g=${mlResult.gbmProb} s=${mlResult.seqProb}]`
        : ' [rule]',
    };
  }

  // Clamp confidence to [30, 95]
  _clampConf (v) {
    return Math.max(SAFETY.MIN_AI_CONFIDENCE || 50, Math.min(95, Math.round(v)));
  }

  toJSON () {
    return { strategy: this.name, enabled: this.enabled, minConf: this.minConf };
  }
}

module.exports = { BaseStrategy };
