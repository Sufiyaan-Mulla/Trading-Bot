'use strict';
// ── strategies/tokyoOpenStrategy.js — Item #6 ────────────────────────────────
// Trades the Tokyo/Asian session open (00:00-03:00 UTC).
// Edge: JPY pairs have highest liquidity during this session; fresh momentum
// off the Asia open often extends into the first 90 minutes before mean-reversion.
//
// Logic mirrors londonOpenStrategy.js:
//  1. Track the pre-open range (22:00-00:00 UTC — late US / early Asia)
//  2. Trade the break of that range on the Tokyo open with volume confirmation
//  3. Filter: ADX < 30 (avoid strong counter-trends), spread < 2× normal

const { BaseStrategy } = require('./baseStrategy');
const { TRADING_CONFIG } = require('../trading-config');

const TOKYO_OPEN_UTC   = 0;   // 00:00 UTC
const TOKYO_CLOSE_UTC  = 3;   // 03:00 UTC
const PREOPEN_START    = 22;  // 22:00 UTC — pre-open range begins

class TokyoOpenStrategy extends BaseStrategy {
  constructor() {
    super();
    this._preOpenHigh = null;
    this._preOpenLow  = null;
    this._sessionBar  = 0;
    this._lastDate    = null;
  }

  get minBars() { return 50; }
  get stratName() { return 'tokyoOpen'; }

  _decide(indicators, context = {}) {
    const price    = indicators.price || 0;
    const utcH     = new Date().getUTCHours();
    const utcDate  = new Date().toISOString().slice(0, 10);
    const atr      = this._num(indicators.atr, price * 0.001);
    const volRatio = indicators.volRatio || 1;
    const adx      = this._num(indicators.adx, 0);
    const spread   = indicators.spread || 0;
    const avgSpread= indicators.avgSpread || spread;

    // Reset pre-open range on new day
    if (utcDate !== this._lastDate) {
      this._lastDate    = utcDate;
      this._preOpenHigh = null;
      this._preOpenLow  = null;
      this._sessionBar  = 0;
    }

    // Track pre-open range (22:00-00:00 UTC)
    if (utcH >= PREOPEN_START || utcH < TOKYO_OPEN_UTC) {
      this._preOpenHigh = this._preOpenHigh === null ? price : Math.max(this._preOpenHigh, price);
      this._preOpenLow  = this._preOpenLow  === null ? price : Math.min(this._preOpenLow,  price);
      return this._hold('[TK] Tracking pre-open range');
    }

    // Outside Tokyo session
    if (utcH >= TOKYO_CLOSE_UTC) return this._hold('[TK] Outside Tokyo session hours');

    // Need valid pre-open range
    if (!this._preOpenHigh || !this._preOpenLow) return this._hold('[TK] No pre-open range');

    const rangePips = (this._preOpenHigh - this._preOpenLow) / (price > 10 ? 0.01 : 0.0001);

    // Range too narrow or too wide — not a reliable setup
    const minRange = TRADING_CONFIG.tokyoMinRangePips || 8;
    const maxRange = TRADING_CONFIG.tokyoMaxRangePips || 60;
    if (rangePips < minRange || rangePips > maxRange) {
      return this._hold(`[TK] Range ${rangePips.toFixed(0)} pips outside valid window [${minRange}-${maxRange}]`);
    }

    // Spread check — Asian session spreads can widen 2-3× at open
    if (avgSpread > 0 && spread > avgSpread * (TRADING_CONFIG.tokyoMaxSpreadMult || 2.5)) {
      return this._hold('[TK] Spread too wide at session open');
    }

    // ADX filter — only trade when market not strongly trending against us
    if (adx > (TRADING_CONFIG.tokyoMaxADX || 30)) {
      return this._hold(`[TK] ADX ${adx.toFixed(1)} too high — trending market`);
    }

    this._sessionBar++;
    const maxBars = TRADING_CONFIG.tokyoMaxEntryBars || 18;  // 90 minutes at M5
    if (this._sessionBar > maxBars) return this._hold('[TK] Entry window closed');

    const signal = indicators.leadingSignal?.direction || 'NEUTRAL';
    const ml     = indicators.mta?.allowed !== false;

    // Upside breakout of pre-open high
    if (price > this._preOpenHigh && volRatio >= 1.2) {
      const conf = this._clampConf(62 + (volRatio > 1.5 ? 8 : 0) + (adx > 15 ? 5 : 0));
      return {
        action: 'BUY', confidence: Math.round(conf),
        reasoning: `[TK-BULL] Tokyo breakout above ${this._preOpenHigh.toFixed(5)} | range=${rangePips.toFixed(0)}pips vol=${volRatio.toFixed(2)}×`,
        metadata: { preOpenHigh: this._preOpenHigh, preOpenLow: this._preOpenLow, rangePips },
      };
    }

    // Downside breakout of pre-open low
    if (price < this._preOpenLow && volRatio >= 1.2) {
      const conf = this._clampConf(62 + (volRatio > 1.5 ? 8 : 0) + (adx > 15 ? 5 : 0));
      return {
        action: 'SELL', confidence: Math.round(conf),
        reasoning: `[TK-BEAR] Tokyo breakout below ${this._preOpenLow.toFixed(5)} | range=${rangePips.toFixed(0)}pips vol=${volRatio.toFixed(2)}×`,
        metadata: { preOpenHigh: this._preOpenHigh, preOpenLow: this._preOpenLow, rangePips },
      };
    }

    return this._hold(`[TK] Price ${price.toFixed(5)} inside range [${this._preOpenLow.toFixed(5)}-${this._preOpenHigh.toFixed(5)}]`);
  }

  toJSON() {
    return { name: this.name, preOpenHigh: this._preOpenHigh, preOpenLow: this._preOpenLow, sessionBar: this._sessionBar };
  }
}

// Item 44: Asian range fade — fade extensions beyond overnight range
// When price extends >N pips beyond Asian session range, expect snap-back
class AsianRangeFade {
  get stratName() { return 'asianFade'; }
  get minBars()   { return 30; }

  analyse(indicators, context = {}) {
    const { TokyoOpenStrategy } = require('./tokyoOpenStrategy');
    const price = indicators.price || 0;
    const atr   = indicators.atr   || price * 0.001;
    const { TRADING_CONFIG } = require('../trading-config');
    const rangeMult = TRADING_CONFIG.asianFadeExtMult || 1.5;

    // Need Asian range (populated by TokyoOpenStrategy sibling)
    const asianHigh = context.asianHigh || indicators.asianHigh;
    const asianLow  = context.asianLow  || indicators.asianLow;
    if (!asianHigh || !asianLow) return { action:'HOLD', confidence:0, reasoning:'[AF] No Asian range' };

    const range = asianHigh - asianLow;
    if (range <= 0) return { action:'HOLD', confidence:0, reasoning:'[AF] Zero range' };

    // Extension beyond range = fade opportunity
    if (price > asianHigh + range * rangeMult) {
      return { action:'SELL', confidence:68, reasoning:`[AF-FADE] ${((price-asianHigh)/atr).toFixed(1)}R above Asian high — fade` };
    }
    if (price < asianLow - range * rangeMult) {
      return { action:'BUY',  confidence:68, reasoning:`[AF-FADE] ${((asianLow-price)/atr).toFixed(1)}R below Asian low — fade` };
    }
    return { action:'HOLD', confidence:0, reasoning:'[AF] Price within Asian range extension' };
  }
}

module.exports = { TokyoOpenStrategy, AsianRangeFade };
