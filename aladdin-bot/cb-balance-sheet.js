'use strict';
// cb-balance-sheet.js — Item 62: Central Bank Balance Sheet as Macro Indicator
// CB balance sheet expansion (QE) → bearish USD, bullish risk assets
// CB balance sheet contraction (QT) → bullish USD, bearish risk assets

class CBBalanceSheet {
  constructor() {
    this._data = {};  // { 'FED': [{date, assets}], 'ECB': [...] }
    this._trend = {};
  }

  // Add a balance sheet observation (in trillions USD equivalent)
  addObservation(bank, date, totalAssets) {
    if (!this._data[bank]) this._data[bank] = [];
    this._data[bank].push({ date, assets: totalAssets, ts: new Date(date).getTime() });
    this._data[bank].sort((a,b)=>a.ts-b.ts);
    if (this._data[bank].length > 52) this._data[bank].shift();  // keep 1 year of weekly
    this._computeTrend(bank);
  }

  _computeTrend(bank) {
    const obs = this._data[bank];
    if (obs.length < 4) return;
    const recent = obs.slice(-4);
    const change = recent.at(-1).assets - recent[0].assets;
    const pctChange = change / recent[0].assets * 100;
    this._trend[bank] = {
      direction:  pctChange > 0.5 ? 'EXPANDING' : pctChange < -0.5 ? 'CONTRACTING' : 'STABLE',
      pctChange4w: parseFloat(pctChange.toFixed(2)),
      assets:      obs.at(-1).assets,
      lastDate:    obs.at(-1).date,
    };
  }

  // Get macro signal for a given FX pair
  // Returns { signal, reasoning, confidence }
  getMacroSignal(pair) {
    const base  = pair.slice(0,3).toUpperCase();
    const quote = pair.slice(3).toUpperCase();

    const CB_MAP = { USD:'FED', EUR:'ECB', GBP:'BOE', JPY:'BOJ', AUD:'RBA', CAD:'BOC', CHF:'SNB' };
    const baseCB  = CB_MAP[base];
    const quoteCB = CB_MAP[quote];

    const baseTrend  = this._trend[baseCB]  || null;
    const quoteTrend = this._trend[quoteCB] || null;

    if (!baseTrend && !quoteTrend) return { signal:'NEUTRAL', confidence:0, reason:'No CB data' };

    // QE base currency → bearish base → SHORT base / BUY quote
    const baseExpanding  = baseTrend?.direction  === 'EXPANDING';
    const quoteExpanding = quoteTrend?.direction === 'EXPANDING';

    let signal = 'NEUTRAL', confidence = 40;
    if (baseExpanding && !quoteExpanding)  { signal = 'SELL'; confidence = 60; }
    if (!baseExpanding && quoteExpanding)  { signal = 'BUY';  confidence = 60; }
    if (baseTrend?.direction === 'CONTRACTING' && !quoteExpanding) { signal = 'BUY'; confidence = 65; }

    return {
      signal, confidence,
      baseCB:    baseTrend,
      quoteCB:   quoteTrend,
      reasoning: `${baseCB}: ${baseTrend?.direction||'?'} | ${quoteCB}: ${quoteTrend?.direction||'?'}`,
    };
  }

  getTrend(bank) { return this._trend[bank] || null; }
  hasData(bank)  { return (this._data[bank]?.length || 0) >= 2; }
}

module.exports = { CBBalanceSheet };
