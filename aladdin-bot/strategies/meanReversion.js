'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  strategies/meanReversion.js
//  Mean Reversion Strategy
//
//  Edge: Buys when price is statistically stretched below its mean (oversold,
//  below lower BB, below VWAP) and expects a snap-back. Optimised for RANGING
//  and WEAK_TREND regimes where trend-following fails.
//
//  Signal logic:
//    ENTRY conditions (all must be true):
//      • Regime is RANGING or WEAK_TREND (trend strategy handles TRENDING)
//      • RSI < oversoldThreshold (default 32)
//      • Price at or below lower Bollinger Band
//      • Price below VWAP (further confirming oversold)
//      • ATR moderate — not a spike, not dead
//      • Volume at least 0.6× average (not completely illiquid)
//    EXIT conditions:
//      • RSI > overboughtThreshold (default 65) — mean restored
//      • Price > BB middle (returned to mean)
//      • Either condition triggers exit
//
//  Confidence scoring:
//    Base: 65
//    RSI depth below threshold: +up to 10 (RSI=20 → +10, RSI=32 → 0)
//    BB penetration: +up to 8 (how far below lower band)
//    VWAP deviation: +up to 6 (how far below VWAP)
//    Volume confirmation: +5 if above average
// ═══════════════════════════════════════════════════════════════════════════════

const { BaseStrategy } = require('./baseStrategy');

class MeanReversionStrategy extends BaseStrategy {
  constructor (opts = {}) {
    super('MeanReversion', {
      minConfidence: opts.minConfidence || 60,
      atrLowPct:    opts.atrLowPct    || 0.03,  // BUG-10 fix: was 0.06
      atrHighPct:   opts.atrHighPct   || 1.80,   // tighter than trend — avoid news spikes
      ...opts,
    });

    this.oversoldThreshold   = opts.oversoldThreshold   || 35;  // raised: catches more MR setups
    this.overboughtThreshold = opts.overboughtThreshold || 68;  // raised from 65 — let winners run
    this.bbPenetrationMin    = opts.bbPenetrationMin    || 0.0;  // price must be at/below lower BB
    this.allowedRegimes      = opts.allowedRegimes      || ['RANGING'];  // WEAK_TREND removed: poor MR R/R
    this.minVolRatio         = opts.minVolRatio         || 0.60;
  }

  // ── Core decision logic ───────────────────────────────────────────────────
  _decide (indicators, context) {
    const hasPosition = context.hasPosition || false;
    const mlResult    = context.mlResult    || null;
    const { use: useML, conf: mlConf, tag: mlTag } = this._mlResult(mlResult);

    const rsi     = this._num(indicators.rsi);
    const price   = this._num(indicators.price);
    const vwap    = this._num(indicators.vwap, price);
    const atrPct  = this._num(indicators.atrPercent);
    const volRatio= this._num(indicators.volRatio, 1);
    const regime  = indicators.marketRegime || 'UNKNOWN';
    const golden  = indicators.goldenCross  ?? true;

    // ── Formal liquidity score ─────────────────────────────────────────────
    const liqBlocked = indicators.liquidityBlocked    ?? false;
    const liqMult    = indicators.liquidityMultiplier ?? 1.0;
    const liqRegime  = indicators.liquidityRegime     ?? 'NORMAL';
    const liqScore   = indicators.liquidityScore      ?? 50;

    const bbUpper  = this._num(indicators.bb?.upper  || indicators.bbUpper,  price);
    const bbLower  = this._num(indicators.bb?.lower  || indicators.bbLower,  price);
    const bbMiddle = this._num(indicators.bb?.middle || indicators.bbMiddle, price);
    const bbRange  = bbUpper - bbLower || 1;

    if (!hasPosition) {
      // ── Gate: only trade in non-trending regimes ───────────────────────
      // Use ADX regime as authoritative classifier (more accurate than ATR-based marketRegime)
      const effectiveRegime = indicators.adxRegime || regime;
      if (!this.allowedRegimes.includes(effectiveRegime) && !this.allowedRegimes.includes(regime)) {
        return this._hold(`[MR] Regime ${regime} not suitable for mean reversion`);
      }

      // ── Bear regime: SHORT mean reversion setups ──────────────────────
      // In a bear regime, mean reversion works the OTHER way:
      // price stretched ABOVE its mean (overbought) → fade the bounce, short.
      if (!golden) {
        const overbought    = rsi > this.overboughtThreshold;
        const aboveUpperBB  = price >= bbUpper;
        const aboveVWAP     = price > vwap;
        const notTooVolatile = atrPct < this.atrHighPct;

        if (overbought && aboveUpperBB && aboveVWAP && notTooVolatile && !liqBlocked) {  // aboveVWAP required
          const rsiHeight  = Math.min(10, Math.round((rsi - this.overboughtThreshold) / (100 - this.overboughtThreshold) * 10));
          const bbPct      = Math.max(0, (price - bbUpper) / bbRange);
          const bbBonus2   = Math.min(8, Math.round(bbPct * 40));
          const vwapBonus2 = aboveVWAP ? Math.min(6, Math.round((price - vwap) / vwap * 1000)) : 0;
          const liqBonus   = liqRegime === 'DEEP' ? 8 : liqRegime === 'NORMAL' ? 5 : 0;
          const base       = useML ? mlConf : 65;
          const sr2        = indicators.sr || {};
          const srShortMod = sr2.atResistance ? (sr2.entryQuality === 'STRONG' ? 10 : 5) : sr2.atSupport ? -6 : 0;
          const conf       = Math.round(this._clampConf(base + rsiHeight + bbBonus2 + vwapBonus2 + liqBonus + srShortMod) * liqMult);
          return { action: 'SELL', confidence: conf,
            reasoning: `[MR-SHORT] Overbought in bear regime: RSI=${rsi.toFixed(1)}>${this.overboughtThreshold} above BB upper + bear trend [${regime}]${mlTag}` };
        }
        return this._hold(`[MR] Bear regime — no SHORT setup (RSI=${rsi.toFixed(1)} aboveUpperBB=${aboveUpperBB})`);
      }

      // ── Gate: DRY liquidity blocks entry ──────────────────────────────
      if (liqBlocked) {
        return this._hold(`[MR] DRY liquidity (score ${liqScore}) — entry blocked`);
      }

      // ── Gate: THIN liquidity raises minimum volume bar ────────────────
      // In THIN market, require stronger vol confirmation (1.0× not 0.6×)
      const effectiveMinVolRatio = liqRegime === 'THIN' ? Math.max(this.minVolRatio, 1.0) : this.minVolRatio;
      if (volRatio < effectiveMinVolRatio) {
        return this._hold(`[MR] Volume too thin (${(volRatio * 100).toFixed(0)}% < ${(effectiveMinVolRatio * 100).toFixed(0)}% in ${liqRegime} market)`);
      }

      // ── Entry conditions ──────────────────────────────────────────────
      const oversold      = rsi < this.oversoldThreshold;
      const belowLowerBB  = price <= bbLower * (1 + this.bbPenetrationMin);
      const belowVWAP     = price < vwap;

      if (!oversold || !belowLowerBB) {
        return this._hold(`[MR] Entry conditions not met (RSI=${rsi.toFixed(1)} belowBB=${belowLowerBB})`);
      }

      // Fix #33: Trend filter — RSI=75 in a confirmed uptrend is NOT a reversion signal.
      // Require ADX < threshold (default 25) for mean reversion entries.
      // RSI overbought during a strong trend should be ignored; only spikes in ranging qualify.
      {
        const adxVal = this._num(indicators.adx, 0);
        const adxLimit = (require('../trading-config').TRADING_CONFIG.mrMaxADX) || 25;
        if (adxVal > adxLimit) {
          return this._hold(`[MR #33] ADX ${adxVal.toFixed(1)} > ${adxLimit} — trending, not a reversion setup`);
        }
      }
      // Item #7: RSI divergence as explicit entry trigger in mean reversion
      {
        const divSig = indicators.divergence || indicators.rsiDivergence;
        if (divSig && divSig.type === 'BULLISH') {
          const c7 = this._clampConf(72 + (divSig.strength === 'STRONG' ? 8 : 0));
          return { action:'BUY',  confidence:Math.round(c7), reasoning:`[MR-DIV] Bullish RSI divergence (${divSig.strength||'confirmed'})` };
        }
        if (divSig && divSig.type === 'BEARISH') {
          const c7b = this._clampConf(72 + (divSig.strength === 'STRONG' ? 8 : 0));
          return { action:'SELL', confidence:Math.round(c7b), reasoning:`[MR-DIV] Bearish RSI divergence (${divSig.strength||'confirmed'})` };
        }
      }
      // ── Feature #69: StochRSI confirmation filter ─────────────────────
      // Require StochRSI to also confirm oversold (<= 25) before entry.
      // Prevents entering when only RSI is oversold but momentum is still rolling over.
      try {
        const { IndicatorsNew } = require('./indicators-new');
        if (typeof IndicatorsNew.stochRSI === 'function') {
          const ph = this.priceHistory || indicators._priceHistory || [];
          if (ph.length >= 35) {
            const stoch = IndicatorsNew.stochRSI(ph);
            if (stoch.k > 30) {  // StochRSI not yet oversold — wait
              return this._hold(`[MR] StochRSI k=${stoch.k.toFixed(1)} not oversold (>30) — awaiting confirmation`);
            }
          }
        }
      } catch(_) { /* IndicatorsNew not available — proceed without filter */ }

      // ── Feature #33: Pivot / round-number proximity confirmation ─────────
      // Only enter when price is near a daily pivot or psychological round number.
      // "Near" = within 0.3× ATR of the level — prevents entries in empty air.
      {
        const atrVal = this._num(indicators.atr, price * 0.001);
        const proximity = atrVal * 0.3;   // within 0.3 ATR counts as "at level"

        // Daily pivot  P = (H + L + C) / 3  — use BB middle as close proxy when no OHLC
        const pivotP   = (bbLower + bbUpper + vwap) / 3;
        const atPivot  = Math.abs(price - pivotP) <= proximity;

        // Psychological round numbers: nearest 50 pip level (0.0050)
        const pipUnit   = price > 10 ? 0.50 : price > 1 ? 0.0050 : 0.00050;
        const nearestRound = Math.round(price / pipUnit) * pipUnit;
        const atRound   = Math.abs(price - nearestRound) <= proximity;

        if (!atPivot && !atRound) {
          // Soft gate: reduce confidence by 8pts rather than blocking outright
          // This preserves entries but penalises those not near structure
          indicators._mrPivotPenalty = 8;
        } else {
          indicators._mrPivotPenalty = 0;
        }
      }
      const rsiDepth     = Math.max(0, this.oversoldThreshold - rsi);
      const rsiBonus     = Math.min(10, Math.round(rsiDepth / this.oversoldThreshold * 10));
      const bbPenetration= Math.max(0, (bbLower - price) / bbRange);
      const bbBonus      = Math.min(8, Math.round(bbPenetration * 40));
      const vwapDev      = belowVWAP ? Math.min(6, Math.round((vwap - price) / vwap * 1000)) : 0;
      // Replace ad-hoc volBonus with unified liquidity regime bonus
      const liqBonus     = liqRegime === 'DEEP' ? 8 : liqRegime === 'NORMAL' ? 5 : 0;
      const sr           = indicators.sr || {};
      const srMRBonus    = sr.atSupport    ? (sr.entryQuality === 'STRONG' ? 10 : 5)
                         : sr.atResistance ? -6
                         : sr.confluenceScore >= 40 ? 2 : 0;

      const base = useML ? mlConf : 65;
      const rawConf = this._clampConf(base + rsiBonus + bbBonus + vwapDev + liqBonus + srMRBonus - (indicators._mrPivotPenalty || 0));
      // Apply liquidity multiplier to final confidence
      const conf = Math.round(rawConf * liqMult);

      const reasons = [
        `RSI=${rsi.toFixed(1)}<${this.oversoldThreshold}`,
        `below BB lower (${bbLower.toFixed(4)})`,
        belowVWAP ? `below VWAP (${vwap.toFixed(4)})` : null,
        `regime: ${regime}`,
      ].filter(Boolean).join(' + ');

      return { action: 'BUY', confidence: conf,
        reasoning: `[MR] Mean reversion entry: ${reasons} [+RSI:${rsiBonus} +BB:${bbBonus} +VWP:${vwapDev} +Liq:${liqBonus}×${liqMult.toFixed(2)}] [${liqRegime}(${liqScore})]${mlTag}` };

    } else {
      // ── Exit: mean restored ───────────────────────────────────────────
      const rsiRestored  = rsi > this.overboughtThreshold;
      const atBBMiddle   = price >= bbMiddle;

      const isShort = context.position && context.position.side === 'SHORT';

      if (!isShort) {
        // LONG exits — mean restored above oversold
        if (rsiRestored) {
          return { action: 'SELL', confidence: 80,
            reasoning: `[MR] Mean restored: RSI=${rsi.toFixed(1)}>${this.overboughtThreshold}` };
        }
        if (atBBMiddle) {
          return { action: 'SELL', confidence: 72,
            reasoning: `[MR] Price at BB middle (${bbMiddle.toFixed(4)}) — mean reversion complete` };
        }
      } else {
        // SHORT exits — cover when mean restored from above (RSI drops, price falls to BB middle)
        const rsiDropped  = rsi < this.oversoldThreshold + 5;   // RSI fell back to neutral
        const atBBMiddle2 = price <= bbMiddle;
        if (rsiDropped) {
          return { action: 'BUY', confidence: 80,
            reasoning: `[MR-SHORT cover] RSI fell to ${rsi.toFixed(1)} — overbought exhausted` };
        }
        if (atBBMiddle2) {
          return { action: 'BUY', confidence: 72,
            reasoning: `[MR-SHORT cover] Price at BB middle (${bbMiddle.toFixed(4)}) — bounce complete` };
        }
      }

      return this._hold('[MR] Holding — mean not yet restored');
    }
  }
}

module.exports = { MeanReversionStrategy };
