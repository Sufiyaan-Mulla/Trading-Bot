'use strict';
// ── Position Alerts ───────────────────────────────────────────────────────────
// Two complementary real-time alerts for open positions:
//
// 1. UnrealizedPnLAlert — fires when floating loss hits a fraction of TP distance.
//    Warns you the position is deteriorating before SL fires.
//
// 2. PositionAgeAlert — fires when a position is approaching maxOpenTimeMs.
//    Gives you time to review before the force-close kicks in.

const { TRADING_CONFIG } = require('./trading-config');

// ── Unrealized P&L Alert ──────────────────────────────────────────────────────
class UnrealizedPnLAlert {
  constructor({ log = console.log, send = null } = {}) {
    this.log   = log;
    this.send  = send;
    this._lastAlertPct = {};   // asset → last alerted threshold (avoid spam)
    this._cooldownMs   = 10 * 60 * 1000;  // min 10 min between same alert
    this._lastAlertAt  = {};
  }

  /**
   * Check unrealized P&L and fire alert if threshold exceeded.
   * @param {object} position  engine.position
   * @param {number} currentPrice  latest market price
   * @param {string} asset
   */
  check(position, currentPrice, asset) {
    if (!position || !currentPrice) return;
    const threshold = TRADING_CONFIG.unrealizedPnlAlertPct || 0.50;

    const entry = position.entry;
    const sl    = position.stopLoss;
    const tp    = position.takeProfit;
    const side  = position.side === 'SHORT' ? 'short' : 'long';

    if (!entry || !sl || !tp) return;

    const tpDist = Math.abs(tp - entry);
    const slDist = Math.abs(entry - sl);
    if (tpDist <= 0 || slDist <= 0) return;

    // Unrealized P&L as fraction of TP distance
    const excursion = side === 'long'
      ? currentPrice - entry
      : entry - currentPrice;

    if (excursion >= 0) return;  // in profit, no alert

    const lossAsFractionOfSL = Math.abs(excursion) / slDist;
    const key = asset || 'pos';

    // Alert at 50% of SL distance (configurable)
    const now = Date.now();
    if (lossAsFractionOfSL >= threshold) {
      if (!this._lastAlertAt[key] || now - this._lastAlertAt[key] > this._cooldownMs) {
        this._lastAlertAt[key] = now;
        const msg = `⚠️ [PnL Alert] ${asset} ${side.toUpperCase()}: floating loss is ${(lossAsFractionOfSL*100).toFixed(0)}% of SL distance — entry=${entry.toFixed(5)} current=${currentPrice.toFixed(5)} SL=${sl.toFixed(5)}`;
        this.log(msg);
        try { this.send?.(msg, 'warn'); } catch (_) {}
      }
    } else {
      // Reset cooldown when position recovers
      delete this._lastAlertAt[key];
    }
  }

  reset(asset) {
    delete this._lastAlertAt[asset];
    delete this._lastAlertPct[asset];
  }
}

// ── Position Age Alert ────────────────────────────────────────────────────────
class PositionAgeAlert {
  constructor({ log = console.log, send = null } = {}) {
    this.log  = log;
    this.send = send;
    this._alertedAt = {};   // asset → timestamp of last alert
    this._warnFraction = TRADING_CONFIG.positionAgeWarnFraction || 0.75;  // warn at 75% of maxOpenTime
    this._cooldownMs   = 60 * 60 * 1000;   // max 1 alert per hour
  }

  /**
   * Check position age and warn if approaching forced close.
   * @param {object} position  engine.position
   * @param {string} asset
   */
  check(position, asset) {
    if (!position) return;

    const maxMs = TRADING_CONFIG.maxOpenTimeMs || (48 * 60 * 60 * 1000);
    const warnMs = maxMs * this._warnFraction;
    const ageMs  = Date.now() - (position.entryTime || Date.now());
    const key    = asset || 'pos';
    const now    = Date.now();

    if (ageMs >= warnMs) {
      if (!this._alertedAt[key] || now - this._alertedAt[key] > this._cooldownMs) {
        this._alertedAt[key] = now;
        const remainingH = ((maxMs - ageMs) / (1000 * 60 * 60)).toFixed(1);
        const msg = `🕐 [Age Alert] ${asset} position has been open ${(ageMs/3600000).toFixed(1)}h — force-close in ~${remainingH}h`;
        this.log(msg);
        try { this.send?.(msg, 'warn'); } catch (_) {}
      }
    } else {
      delete this._alertedAt[key];
    }
  }

  reset(asset) { delete this._alertedAt[asset]; }
}

// ── Swap Cost Alert ───────────────────────────────────────────────────────────
class SwapCostAlert {
  constructor({ log = console.log, send = null } = {}) {
    this.log  = log;
    this.send = send;
    this._alertedAt = {};
    this._cooldownMs = 4 * 60 * 60 * 1000;  // max once per 4h
    this._threshold  = TRADING_CONFIG.swapCostAlertFraction || 0.20;
  }

  /**
   * Alert when accumulated swap cost has eroded a significant fraction of TP profit.
   * @param {number} swapAccumulated  total swap fees paid so far (negative = cost)
   * @param {number} tpProfit        expected profit at TP
   * @param {string} asset
   */
  check(swapAccumulated, tpProfit, asset) {
    if (!swapAccumulated || !tpProfit || tpProfit <= 0) return;

    const erosion = Math.abs(swapAccumulated) / tpProfit;
    const key     = asset || 'pos';
    const now     = Date.now();

    if (erosion >= this._threshold) {
      if (!this._alertedAt[key] || now - this._alertedAt[key] > this._cooldownMs) {
        this._alertedAt[key] = now;
        const msg = `💸 [Swap Alert] ${asset}: swap costs have eroded ${(erosion*100).toFixed(0)}% of expected TP profit (swap=$${Math.abs(swapAccumulated).toFixed(2)}, TP=$${tpProfit.toFixed(2)})`;
        this.log(msg);
        try { this.send?.(msg, 'warn'); } catch (_) {}
      }
    } else {
      delete this._alertedAt[key];
    }
  }

  reset(asset) { delete this._alertedAt[asset]; }
}

module.exports = { UnrealizedPnLAlert, PositionAgeAlert, SwapCostAlert };
