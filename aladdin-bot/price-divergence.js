'use strict';
// ── price-divergence.js ───────────────────────────────────────────────────────
// Cross-source price divergence detector.
// Compares OANDA vs Alpha Vantage prices for the same asset.
// Significant divergence signals data quality issues or genuine arbitrage.
//
// Also detects funding rate divergence (carry trade opportunities) from
// interest rate differentials in TRADING_CONFIG.swapCosts.
// ─────────────────────────────────────────────────────────────────────────────

const { TRADING_CONFIG } = require('./trading-config');

class PriceDivergence {
  constructor() {
    this._prices = {};   // asset → { oanda, alphavantage, ts }
  }

  // Record a price quote from a specific source
  record(asset, source, price) {
    if (!this._prices[asset]) this._prices[asset] = {};
    this._prices[asset][source.toLowerCase()] = { price, ts: Date.now() };
  }

  // Analyse divergence for an asset
  analyse(asset) {
    const data = this._prices[asset] || {};
    const oanda = data.oanda;
    const av    = data.alphavantage;

    if (!oanda || !av) {
      return { divergencePct: 0, diverged: false, blocked: false, reason: 'insufficient_sources' };
    }

    // #29: Directional stale check — primary stale = block, secondary stale = warn only
    const now = Date.now();
    const oandaStale = oanda.ts && (now - oanda.ts > 60_000);
    const avStale    = av.ts    && (now - av.ts    > 60_000);
    if (oandaStale) {
      return { divergencePct: 0, diverged: false, blocked: true, reason: 'PRIMARY_STALE',
        detail: 'Primary OANDA feed stale — blocking trading' };
    }
    if (avStale) {
      return { divergencePct: 0, diverged: false, blocked: false, reason: 'SECONDARY_STALE',
        detail: 'Secondary Alpha Vantage stale — continuing with OANDA only' };
    }

    const mid = (oanda.price + av.price) / 2;
    const divergencePct = Math.abs(oanda.price - av.price) / mid * 100;
    const threshold = TRADING_CONFIG.priceDivergenceThreshold || 0.05; // 0.05%

    const diverged = divergencePct > threshold;
    // Block new entries if divergence is severe (data quality issue)
    const blocked  = divergencePct > threshold * 3;

    return {
      divergencePct: parseFloat(divergencePct.toFixed(4)),
      oandaPrice:    oanda.price,
      avPrice:       av.price,
      diverged,
      blocked,
      reason: blocked ? 'severe_divergence' : diverged ? 'minor_divergence' : 'ok',
    };
  }

  // Funding/carry divergence from swap rate table
  getFundingDivergence(pair) {
    const swaps = TRADING_CONFIG.swapCosts || {};
    const swap  = swaps[pair];
    if (!swap) return { carryBias: 0, recommendation: 'NEUTRAL' };

    // Positive long swap = USD rates > base rates (carry favours short base/long USD)
    // Negative long swap = base rates > USD rates (carry favours long base)
    const longSwap  = swap.long  || 0;
    const shortSwap = swap.short || 0;
    const netCarry  = longSwap - shortSwap;  // positive = long favoured by carry

    return {
      longSwapRate:  longSwap,
      shortSwapRate: shortSwap,
      netCarry:      parseFloat(netCarry.toFixed(6)),
      carryBias:     netCarry > 0 ? 'LONG_FAVOURED' : netCarry < 0 ? 'SHORT_FAVOURED' : 'NEUTRAL',
      recommendation: Math.abs(netCarry) > 0.00001 ? (netCarry > 0 ? 'LONG' : 'SHORT') : 'NEUTRAL',
    };
  }
}

module.exports = { PriceDivergence };
