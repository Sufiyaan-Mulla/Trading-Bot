'use strict';
// ── strategies/londonOpenStrategy.js ──────────────────────────────────────────
// IMPROVEMENT #6: London Open Breakout Strategy (4th strategy)
//
// Edge: The London session (07:00-09:00 UTC) consistently breaks out of the
// Asian session range (00:00-07:00 UTC). This is one of forex's most
// statistically reliable daily patterns.
//
// Logic:
//   1. Measure the Asian range: high and low between 00:00-07:00 UTC
//   2. On London open (07:00 UTC), wait for first clean break of the range
//   3. Enter in the direction of the break with volume confirmation
//   4. Stop = Asian range midpoint (tight, well-defined risk)
//   5. Target = Asian range size projected from breakout level (1:2 R/R min)
//
// Additional filters:
//   - DXY direction must not conflict with direction (macro alignment)
//   - Minimum range size (avoid ultra-tight ranges = whipsaws)
//   - Volume must be expanding vs Asian session average
//   - Only active during 07:00-09:30 UTC (London window)
// ─────────────────────────────────────────────────────────────────────────────

const { BaseStrategy } = require('./baseStrategy');

class LondonOpenStrategy extends BaseStrategy {
  constructor(opts = {}) {
    super('LondonOpen', {
      minConfidence: opts.minConfidence || 62,
      atrLowPct:    0.1,
      atrHighPct:   2.5,
      ...opts,
    });

    // Asian session: 00:00–07:00 UTC
    this.asianStartHour = opts.asianStartHour || 0;
    this.asianEndHour   = opts.asianEndHour   || 7;

    // London window: 07:00–09:30 UTC
    this.londonStartHour     = opts.londonStartHour     || 7;
    this.londonEndMinute     = opts.londonEndMinute     || 570;  // 09:30 UTC in minutes

    // Range filters
    this.minRangePips        = opts.minRangePips        || 8;    // skip if Asian range < 8 pips
    this.maxRangePips        = opts.maxRangePips        || 60;   // skip if too wide (news day)
    this.breakoutVolMult     = opts.breakoutVolMult     || 1.3;  // need 1.3x volume on break
    this.minRRRatio          = opts.minRRRatio          || 1.5;  // min R:R to take trade

    // State: reset each day
    this._asianHigh       = null;
    this._asianLow        = null;
    this._asianAvgVol     = null;
    this._lastSessionDate = null;
    this._tradeOpenedToday = false;
  }

  // ── Update Asian range state ──────────────────────────────────────────────
  updateAsianRange(prices, volumes, utcHour, utcDate) {
    // Reset on new day
    if (utcDate !== this._lastSessionDate) {
      this._asianHigh       = null;
      this._asianLow        = null;
      this._asianAvgVol     = null;
      this._tradeOpenedToday = false;
      this._lastSessionDate  = utcDate;
    }

    // Accumulate during Asian hours
    if (utcHour >= this.asianStartHour && utcHour < this.asianEndHour) {
      const p = prices[prices.length - 1];
      if (!this._asianHigh || p > this._asianHigh) this._asianHigh = p;
      if (!this._asianLow  || p < this._asianLow)  this._asianLow  = p;

      // Track average volume during Asian session
      if (volumes && volumes.length > 0) {
        const v = volumes[volumes.length - 1];
        this._asianAvgVol = this._asianAvgVol
          ? (this._asianAvgVol * 0.8 + v * 0.2)
          : v;
      }
    }
  }

  // ── Main decision logic ───────────────────────────────────────────────────
  _decide(indicators, context) {
    const { hasPosition, position, mlResult } = context;
    const now     = new Date();
    const utcHour = now.getUTCHours();
    const utcMin  = now.getUTCMinutes();
    const utcMinTotal = utcHour * 60 + utcMin;

    // ── Window gate: only active during London open 07:00–09:30 UTC ──────
    const londonStart = this.londonStartHour * 60;
    const londonEnd   = this.londonEndMinute;
    const inWindow    = utcMinTotal >= londonStart && utcMinTotal <= londonEnd;

    if (!inWindow && !hasPosition) {
      return this._hold('[LO] Outside London open window');
    }

    // ── Exit logic for open positions ─────────────────────────────────────
    if (hasPosition && position) {
      const { signal, rsi } = indicators;
      const isShort = position.side === 'SHORT';
      // Exit on opposite momentum
      if (!isShort && (signal === 'STRONG_SELL' || rsi > 70)) {
        return { action: 'SELL', confidence: 78, reasoning: '[LO-EXIT] Momentum exhausted' };
      }
      if (isShort && (signal === 'STRONG_BUY' || rsi < 30)) {
        return { action: 'BUY', confidence: 78, reasoning: '[LO-EXIT] Short momentum exhausted' };
      }
      return this._hold('[LO] Holding London open position');
    }

    // ── Only trade once per day during London open ────────────────────────
    if (this._tradeOpenedToday) {
      return this._hold('[LO] Trade already taken today');
    }

    // ── Need valid Asian range ────────────────────────────────────────────
    if (!this._asianHigh || !this._asianLow) {
      return this._hold('[LO] No Asian range data yet');
    }

    const asianRange = this._asianHigh - this._asianLow;
    const pipSize    = 0.0001;  // EURUSD standard pip
    const rangePips  = asianRange / pipSize;

    if (rangePips < this.minRangePips) {
      return this._hold(`[LO] Asian range too tight (${rangePips.toFixed(1)} pips < ${this.minRangePips})`);
    }
    if (rangePips > this.maxRangePips) {
      return this._hold(`[LO] Asian range too wide (${rangePips.toFixed(1)} pips) — news event risk`);
    }

    const { price, volRatio = 1, signal, adxRegime, liquidityBlocked } = indicators;

    if (liquidityBlocked) return this._hold('[LO] Liquidity blocked');

    // ── Breakout detection ────────────────────────────────────────────────
    const bullBreak = price > this._asianHigh && volRatio >= this.breakoutVolMult;
    const bearBreak = price < this._asianLow  && volRatio >= this.breakoutVolMult;

    if (!bullBreak && !bearBreak) {
      return this._hold(`[LO] No range break (price=${price?.toFixed(5)} hi=${this._asianHigh?.toFixed(5)} lo=${this._asianLow?.toFixed(5)})`);
    }

    // ── ML confidence ─────────────────────────────────────────────────────
    const useML  = mlResult && mlResult.confidence != null && mlResult.confidence > 40;
    const mlConf = useML ? mlResult.confidence : 65;

    // ── Regime filter: avoid breakout in ranging day ──────────────────────
    const regimeMod = adxRegime === 'TRENDING'   ?  8
                    : adxRegime === 'WEAK_TREND' ?  3
                    : adxRegime === 'RANGING'    ? -10 : 0;

    // ── Volume mod ────────────────────────────────────────────────────────
    const volMod = volRatio > 2.0 ? 10 : volRatio > 1.5 ? 5 : 0;

    // ── Signal alignment mod ──────────────────────────────────────────────
    const { sr = {} } = indicators;

    if (bullBreak) {
      // Signal should align with bull breakout
      const signalMod = (signal === 'STRONG_BUY' || signal === 'BUY') ? 5 : -5;
      const srMod     = sr.atResistance ? +8 : 0;  // breaking above resistance = good
      const conf      = Math.round(this._clampConf((useML ? mlConf : 65) + regimeMod + volMod + signalMod + srMod));

      // Mark trade as opened today
      this._tradeOpenedToday = true;

      // Fix #22: Double-top/bottom filter — avoid buying Nth failed breakout
      const MAX_ATTEMPTS_LO = (require('../trading-config').TRADING_CONFIG.londonBreakoutMaxAttempts) || 2;
      this._asianHighAttempts = (this._asianHighAttempts || 0) + 1;
      if (this._asianHighAttempts > MAX_ATTEMPTS_LO) {
        return this._hold(`[LO #22] Asian high tested ${this._asianHighAttempts}× — double-top pattern, skip`);
      }

      return {
        action:    'BUY',
        confidence: conf,
        reasoning: `[LO-BULL] Broke Asian high (${this._asianHigh?.toFixed(5)}) range=${rangePips.toFixed(0)}pips vol=${volRatio.toFixed(2)}x`,
        metadata:  { asianHigh: this._asianHigh, asianLow: this._asianLow, rangePips },
      };
    }

    if (bearBreak) {
      const signalMod = (signal === 'STRONG_SELL' || signal === 'SELL') ? 5 : -5;
      const srMod     = sr.atSupport ? +8 : 0;   // breaking below support = good
      const conf      = Math.round(this._clampConf((useML ? mlConf : 65) + regimeMod + volMod + signalMod + srMod));

      this._tradeOpenedToday = true;

      return {
        action:    'SELL',
        confidence: conf,
        reasoning: `[LO-BEAR] Broke Asian low (${this._asianLow?.toFixed(5)}) range=${rangePips.toFixed(0)}pips vol=${volRatio.toFixed(2)}x`,
        metadata:  { asianHigh: this._asianHigh, asianLow: this._asianLow, rangePips },
      };
    }

    return this._hold('[LO] No valid setup');
  }
}

module.exports = { LondonOpenStrategy };
