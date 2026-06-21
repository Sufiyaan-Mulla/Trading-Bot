'use strict';
// ── market-data.js ────────────────────────────────────────────────────────────
// Single import point for all market data concerns:
//   MarketDataFetcher  — simulated/live price feed with warm-up
//   LeadingIndicatorFetcher — DXY, XAU, US10Y external signals

const { MarketDataFetcher }      = require('./market-data-fetcher');
const { LeadingIndicatorFetcher } = require('./leading-indicator-fetcher');

module.exports = { MarketDataFetcher, LeadingIndicatorFetcher };
