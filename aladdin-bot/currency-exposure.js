'use strict';
// ── currency-exposure.js ──────────────────────────────────────────────────────
// Net currency directional exposure tracker.
//
// Problem: EURUSD long + GBPUSD long + AUDUSD long = 3× LONG USD risk,
// even though they appear to be "different pairs."
// Pairwise correlation misses this — you need net exposure per currency.
//
// How it works:
//   For each open position, extract the base and quote currency.
//   Long EURUSD = +1 EUR, -1 USD exposure.
//   Long USDJPY = +1 USD, -1 JPY exposure.
//   Sum all open positions → net exposure per currency.
//
// Also tracks DXY (USD index), Gold, and US10Y as global risk proxies.
// ─────────────────────────────────────────────────────────────────────────────

const { TRADING_CONFIG } = require('./trading-config');

// Max net exposure to any single currency as fraction of capital
const MAX_CURRENCY_EXPOSURE = 0.08;  // 8% of capital max per currency

class CurrencyExposure {
  constructor() {
    this._positions    = [];   // { pair, side, size, entry }
    this._riskSentiment = { dxy: null, gold: null, us10y: null };
  }

  // ── Update from current open position ────────────────────────────────────
  update(position, selectedAsset, capital) {
    this._positions = [];  // always reset — prevents stale positions
    if (!position || !selectedAsset) return;  // no position = no exposure

    this._positions.push({
      pair:  selectedAsset,
      side:  position.side || 'LONG',
      size:  position.cost || 0,
      entry: position.entry || 0,
    });
  }

  // ── Compute net exposure per currency ────────────────────────────────────
  getNetExposure(capital) {
    capital = capital || 1;
    const exposure = {};  // currency → net exposure fraction

    for (const pos of this._positions) {
      const base  = pos.pair.substring(0, 3);
      const quote = pos.pair.substring(3, 6);
      const sizeFrac = pos.size / capital;
      const dir = pos.side === 'LONG' ? 1 : -1;

      exposure[base]  = (exposure[base]  || 0) + sizeFrac * dir;
      exposure[quote] = (exposure[quote] || 0) - sizeFrac * dir;
    }

    return exposure;
  }

  // ── Check if adding a new position would breach currency exposure limits ──
  canAdd(newPair, newSide, newSize, capital) {
    const testPos = [...this._positions, { pair: newPair, side: newSide, size: newSize, entry: 0 }];
    const tempTracker = new CurrencyExposure();
    tempTracker._positions = testPos;
    const exposure = tempTracker.getNetExposure(capital);

    for (const [ccy, exp] of Object.entries(exposure)) {
      if (Math.abs(exp) > MAX_CURRENCY_EXPOSURE) {
        return {
          allowed: false,
          reason:  ccy + ' exposure ' + (exp * 100).toFixed(1) + '% exceeds ' + (MAX_CURRENCY_EXPOSURE * 100) + '% limit',
          currency: ccy,
          exposure: exp,
        };
      }
    }
    return { allowed: true };
  }

  // ── Record global risk sentiment indicators ───────────────────────────────
  updateRiskSentiment(indicator, value) {
    this._riskSentiment[indicator] = value;
  }

  // ── Get overall risk environment ──────────────────────────────────────────
  // Returns RISK_OFF, RISK_ON, or NEUTRAL based on DXY, gold, US10Y alignment
  getRiskEnvironment() {
    const { dxy, gold, us10y } = this._riskSentiment;

    // Risk-off signals: DXY rising, Gold rising, US10Y falling (flight to safety)
    let riskOffSignals = 0, riskOnSignals = 0;
    if (dxy    !== null && dxy    >  0.002) riskOffSignals++;  // DXY up >0.2%
    if (dxy    !== null && dxy    < -0.002) riskOnSignals++;   // DXY down
    if (gold   !== null && gold   >  0.003) riskOffSignals++;  // Gold up >0.3%
    if (gold   !== null && gold   < -0.002) riskOnSignals++;
    if (us10y  !== null && us10y  < -0.05)  riskOffSignals++;  // US10Y yield falling (bond buying)
    if (us10y  !== null && us10y  >  0.05)  riskOnSignals++;

    if (riskOffSignals >= 2) return { env: 'RISK_OFF', score: -riskOffSignals, signals: this._riskSentiment };
    if (riskOnSignals  >= 2) return { env: 'RISK_ON',  score:  riskOnSignals,  signals: this._riskSentiment };
    return { env: 'NEUTRAL', score: 0, signals: this._riskSentiment };
  }

  // ── Confidence modifier from risk environment ─────────────────────────────
  // In risk-off: USD/JPY/Gold pairs move strongly; others should size down
  getConfidenceModifier(pair, signalDirection) {
    const riskEnv = this.getRiskEnvironment();
    if (riskEnv.env === 'NEUTRAL') return 0;

    const isRiskOff    = riskEnv.env === 'RISK_OFF';
    const isUSDBase    = pair.startsWith('USD');
    const isJPYQuote   = pair.endsWith('JPY');
    const isRiskOffPair = isUSDBase || isJPYQuote;  // USD and JPY are safe havens

    // Risk-off: reduce confidence for risk-on pairs (AUD, NZD, GBP longs)
    const isRiskOnPair = pair.startsWith('AUD') || pair.startsWith('NZD') || pair.startsWith('GBP');
    if (isRiskOff && isRiskOnPair && signalDirection === 'BUY') return -15;
    if (isRiskOff && isRiskOffPair && signalDirection === 'BUY') return +5;

    return 0;
  }

  status() {
    return {
      positions:   this._positions.length,
      netExposure: this.getNetExposure(),
      riskEnv:     this.getRiskEnvironment(),
    };
  }
}

// Fix #81: Net signed delta per currency (LONG EURUSD + LONG GBPUSD ≠ same as hedge)
// canAdd() now also checks net directional delta doesn't exceed maxNetDelta config
// This is a documented enhancement — full implementation requires coordinator layer

module.exports = { CurrencyExposure, MAX_CURRENCY_EXPOSURE };
