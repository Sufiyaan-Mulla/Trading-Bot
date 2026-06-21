'use strict';
// ── corporate-actions.js — 11.3: Corporate Actions Handler ─────────────────
// For FX trading, "corporate actions" means major monetary policy changes,
// central bank fixing rates, and emergency interventions that distort price data.
// This module flags and adjusts for such events in price history.

class CorporateActions {
  constructor() {
    // Known FX interventions and fixing events that distort price continuity
    this._events = [
      { date: '2015-01-15', pair: 'EURCHF', type: 'SNB_PEG_REMOVAL', note: 'CHF cap removed — 20% move' },
      { date: '2011-09-06', pair: 'EURCHF', type: 'SNB_CAP_SET',    note: 'CHF cap introduced at 1.20' },
      { date: '2016-06-23', pair: 'GBPUSD', type: 'BREXIT_VOTE',    note: 'GBP flash crash -10%' },
      { date: '2019-01-03', pair: 'USDJPY', type: 'JPY_FLASH_CRASH', note: 'Yen flash crash -4%' },
    ];
    this._customEvents = [];
  }

  // Add a custom event
  addEvent(date, pair, type, note = '') {
    this._customEvents.push({ date, pair, type, note });
  }

  // Check if a given date/pair has a known distortion event
  hasEvent(dateStr, pair) {
    const all = [...this._events, ...this._customEvents];
    return all.some(e => e.date === dateStr && (!pair || e.pair === (pair||'')));
  }

  // Get all events for a pair within a date range
  getEvents(pair, startDate, endDate) {
    const start = new Date(startDate || 0);
    const end   = new Date(endDate || Date.now());
    return [...this._events, ...this._customEvents].filter(e => {
      const d = new Date(e.date);
      return (!pair || e.pair === pair) && d >= start && d <= end;
    });
  }

  // Filter a price series to remove or flag distorted bars
  // Returns { cleanPrices, removedIdx, flaggedIdx }
  filterPrices(prices, dates, pair) {
    const eventDates = new Set(this.getEvents(pair).map(e => e.date));
    const cleanPrices = [], removedIdx = [], flaggedIdx = [];
    for (let i = 0; i < prices.length; i++) {
      const d = dates?.[i] || new Date(Date.now() - (prices.length-i)*86400000).toISOString().slice(0,10);
      if (eventDates.has(d)) {
        removedIdx.push(i);
        flaggedIdx.push({ idx:i, date:d, price:prices[i] });
      } else {
        cleanPrices.push(prices[i]);
      }
    }
    return { cleanPrices, removedIdx, flaggedIdx, eventsFound: flaggedIdx.length };
  }

  // Detect extreme moves in price history (potential unlogged events)
  detectExtremes(prices, thresholdPct = 5.0) {
    const extremes = [];
    for (let i = 1; i < prices.length; i++) {
      const movePct = Math.abs(prices[i] - prices[i-1]) / prices[i-1] * 100;
      if (movePct > thresholdPct) {
        extremes.push({ idx: i, movePct: parseFloat(movePct.toFixed(2)), price: prices[i], prevPrice: prices[i-1] });
      }
    }
    return extremes;
  }
}

module.exports = { CorporateActions };
