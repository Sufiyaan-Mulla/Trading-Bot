'use strict';
// ── fee-model.js ──────────────────────────────────────────────────────────────
// Maker/taker fee-aware order type selection and realistic cost modelling.
//
// Problem: the original code treats commission as a flat 0.1% regardless of
// whether the order adds liquidity (maker, cheaper) or takes it (taker, pricier).
// On tight-margin forex strategies this 2–3× fee difference materially affects
// expected value.
//
// Solution:
//   FeeModel.classify(spread, volatility, urgency) → 'MARKET'|'LIMIT'|'TWAP'
//   FeeModel.cost(orderType, size, price)           → { fee, makerFee, takerFee, net }
//   FeeModel.adjustExpectedValue(ev, orderType, size, price) → adjustedEV
//
// Fee tiers (OANDA-equivalent, configurable):
//   Market order  → always taker rate
//   Limit order   → maker rate IF fill is passive (added liquidity)
//                 → taker rate IF fill is aggressive (crossed spread)
//   TWAP slices   → blend: first slice taker, remaining maker (typical)
// ─────────────────────────────────────────────────────────────────────────────

// Default fee schedule (fraction of trade value)
// Override via process.env.MAKER_FEE_PCT / TAKER_FEE_PCT
const DEFAULT_FEES = {
  maker: parseFloat(process.env.MAKER_FEE_PCT || '0.00002'),   // 0.002% (0.2 pips)
  taker: parseFloat(process.env.TAKER_FEE_PCT || '0.00010'),   // 0.010% (1 pip)
};

// Spread thresholds that influence order type choice
const SPREAD_LIMIT_THRESHOLD = 0.0002;   // < 2 pips → limit order preferred
const SPREAD_MARKET_THRESHOLD = 0.0008;  // > 8 pips → market order (don't queue)
const VOLATILITY_MARKET_THRESHOLD = 0.005; // > 0.5% → market order for speed

class FeeModel {

  constructor(fees = {}) {
    this.makerFee = fees.maker ?? DEFAULT_FEES.maker;
    this.takerFee = fees.taker ?? DEFAULT_FEES.taker;
  }

  // ── Select the optimal order type based on market conditions ──────────────
  // spread:     bid/ask spread as fraction of price (e.g. 0.0001 = 1 pip on EURUSD)
  // volatility: recent price volatility fraction (e.g. ATR/price)
  // urgency:    0–1. 0 = patient, 1 = must fill immediately
  // Returns: { type: 'LIMIT'|'MARKET'|'TWAP', reason, estimatedFee }
  classify(spread, volatility, urgency = 0.5, tradeValue = 1000) {
    const spreadPips = spread * 10000;

    // High urgency or extreme volatility → market (fill certainty > cost)
    if (urgency >= 0.8 || volatility > VOLATILITY_MARKET_THRESHOLD) {
      return {
        type: 'MARKET',
        reason: urgency >= 0.8 ? 'high urgency' : 'high volatility',
        estimatedFee: this._cost('MARKET', tradeValue).fee,
      };
    }

    // Wide spread → market is cheaper than waiting (limit may never fill)
    if (spread > SPREAD_MARKET_THRESHOLD) {
      return {
        type: 'MARKET',
        reason: 'wide spread (' + spreadPips.toFixed(1) + ' pips) — limit unlikely to fill',
        estimatedFee: this._cost('MARKET', tradeValue).fee,
      };
    }

    // Large order → TWAP to reduce market impact
    if (tradeValue > 5000 && urgency < 0.6) {
      return {
        type: 'TWAP',
        reason: 'large order — TWAP reduces market impact',
        estimatedFee: this._cost('TWAP', tradeValue).fee,
      };
    }

    // Tight spread + low urgency → limit (earn maker rebate / lower fee)
    if (spread < SPREAD_LIMIT_THRESHOLD && urgency < 0.6) {
      return {
        type: 'LIMIT',
        reason: 'tight spread (' + spreadPips.toFixed(1) + ' pips) — limit saves fee',
        estimatedFee: this._cost('LIMIT', tradeValue).fee,
      };
    }

    // Default: market
    return {
      type: 'MARKET',
      reason: 'default — moderate conditions',
      estimatedFee: this._cost('MARKET', tradeValue).fee,
    };
  }

  // ── Calculate fee for a given order type and trade value ──────────────────
  // Returns { fee, breakdown, netTradeValue }
  cost(orderType, size, price) {
    // Bug fix: null/zero/non-finite size or price produced NaN tradeValue which
    // silently propagated into feePct, adjustedEV and the viable flag — causing
    // perfectly good trades to be rejected for the wrong reason.
    const s = (typeof size  === 'number' && isFinite(size)  && size  > 0) ? size  : 0;
    const p = (typeof price === 'number' && isFinite(price) && price > 0) ? price : 0;
    const tradeValue = s * p;
    const result = this._cost(orderType, tradeValue);
    return { ...result, size: s, price: p, tradeValue: parseFloat(tradeValue.toFixed(6)) };
  }

  _cost(orderType, tradeValue) {
    let fee, breakdown;
    switch ((orderType || 'MARKET').toUpperCase()) {
      case 'LIMIT':
        // Limit orders are typically passive (maker) — 80% maker, 20% taker
        fee = tradeValue * (this.makerFee * 0.80 + this.takerFee * 0.20);
        breakdown = { makerPct: 80, takerPct: 20 };
        break;
      case 'TWAP':
        // TWAP: first slice is taker (aggressive), rest are maker (passive)
        fee = tradeValue * (this.takerFee * 0.33 + this.makerFee * 0.67);
        breakdown = { makerPct: 67, takerPct: 33 };
        break;
      case 'MARKET':
      default:
        fee = tradeValue * this.takerFee;
        breakdown = { makerPct: 0, takerPct: 100 };
        break;
    }
    return {
      fee:          parseFloat(fee.toFixed(8)),
      makerFee:     parseFloat((tradeValue * this.makerFee).toFixed(8)),
      takerFee:     parseFloat((tradeValue * this.takerFee).toFixed(8)),
      feePct:       tradeValue > 0 ? parseFloat((fee / tradeValue * 100).toFixed(6)) : 0,
      breakdown,
    };
  }

  // ── Adjust a signal's expected value for fee drag ─────────────────────────
  // ev:        raw expected value (profit fraction, e.g. 0.005 = 0.5%)
  // Returns adjusted EV — negative means fee drag wipes out edge
  adjustExpectedValue(ev, orderType, size, price) {
    // Bug fix: guard NaN/non-finite ev input so downstream never gets NaN
    const safeEV = (typeof ev === 'number' && isFinite(ev)) ? ev : 0;
    const { feePct } = this.cost(orderType, size, price);
    // Round-trip cost = entry fee + exit fee
    const roundTripFeeFrac = (feePct / 100) * 2;
    const adjusted = safeEV - roundTripFeeFrac;
    return {
      rawEV:           parseFloat(safeEV.toFixed(6)),
      adjustedEV:      parseFloat(adjusted.toFixed(6)),
      roundTripFee:    parseFloat(roundTripFeeFrac.toFixed(6)),
      viable:          adjusted > 0,
      breakEvenReturn: parseFloat(roundTripFeeFrac.toFixed(6)),
    };
  }

  // ── Convenience: build a FeeModel from TRADING_CONFIG ─────────────────────
  static fromConfig(cfg) {
    return new FeeModel({
      maker: cfg.makerFee ?? DEFAULT_FEES.maker,
      taker: cfg.takerFee ?? cfg.commission ?? DEFAULT_FEES.taker,
    });
  }

  // Expose defaults for tests/config
  static get DEFAULT_FEES() { return { ...DEFAULT_FEES }; }
}

module.exports = { FeeModel };
