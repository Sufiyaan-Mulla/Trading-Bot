'use strict';
// ── readonly-key-proxy.js ─────────────────────────────────────────────────────
// Wires OANDA_READONLY_KEY into analytics surfaces (dashboard, metrics server).
//
// Fixes: Security partial — "Use read-only keys for analytics and separate
// keys for trading."
//
// The trading engine uses OANDA_API_KEY (full permissions — place/cancel orders).
// The dashboard and metrics server only need read access (balances, positions,
// prices). They should use OANDA_READONLY_KEY so that if the dashboard is
// compromised, an attacker cannot place orders.
//
// This module:
//   1. Provides getAnalyticsKey() — returns READONLY key with trading key fallback
//   2. Provides getTradingKey()   — returns TRADING key only, never readonly
//   3. Enforces separation: logs a security warning if both keys are the same
//   4. Patches a minimal OANDA client factory so analytics code can call it
//      with the correct key without touching OANDA_API_KEY
//
// Usage:
//   const { getAnalyticsKey, OandaReadonlyClient } = require('./readonly-key-proxy');
//
//   // In dashboard.js / metrics-server.js:
//   const client = new OandaReadonlyClient();
//   const balance = await client.getAccountSummary(accountId);
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

// ── Key resolution ─────────────────────────────────────────────────────────────
function getAnalyticsKey() {
  const readOnly = process.env.OANDA_READONLY_KEY;
  const trading  = process.env.OANDA_API_KEY;

  if (readOnly && trading && readOnly === trading) {
    console.warn('[ReadonlyKeyProxy] ⚠ OANDA_READONLY_KEY equals OANDA_API_KEY — create a separate read-only key');
  }

  if (readOnly) return readOnly;
  if (trading) {
    console.warn('[ReadonlyKeyProxy] ⚠ OANDA_READONLY_KEY not set — falling back to trading key for analytics. Set a separate read-only key.');
    return trading;
  }
  return null;
}

function getTradingKey() {
  const key = process.env.OANDA_API_KEY;
  if (!key) console.warn('[ReadonlyKeyProxy] OANDA_API_KEY not set');
  return key || null;
}

function isKeySeparationConfigured() {
  const ro = process.env.OANDA_READONLY_KEY;
  const tr = process.env.OANDA_API_KEY;
  return !!(ro && tr && ro !== tr);
}

// ── Read-only OANDA client ─────────────────────────────────────────────────────
// Only exposes read endpoints — no order placement possible.
class OandaReadonlyClient {
  constructor(opts = {}) {
    this._key     = opts.apiKey || getAnalyticsKey();
    this._env     = opts.env    || process.env.OANDA_ENV || 'practice';
    this._account = opts.account || process.env.OANDA_ACCOUNT || '';
    this._base    = this._env === 'live'
      ? 'https://api-fxtrade.oanda.com'
      : 'https://api-fxpractice.oanda.com';
  }

  // Account balance and NAV
  async getAccountSummary() {
    const data = await this._get(`/v3/accounts/${this._account}/summary`);
    const acc  = data.account || {};
    return {
      balance:    parseFloat(acc.balance    || 0),
      nav:        parseFloat(acc.NAV        || 0),
      marginUsed: parseFloat(acc.marginUsed || 0),
      openTradeCount: parseInt(acc.openTradeCount || 0),
      currency:   acc.currency || 'USD',
    };
  }

  // Open positions (read-only)
  async getOpenPositions() {
    const data = await this._get(`/v3/accounts/${this._account}/openPositions`);
    return (data.positions || []).map(p => ({
      instrument: p.instrument,
      longUnits:  parseFloat(p.long?.units  || 0),
      shortUnits: parseFloat(p.short?.units || 0),
      unrealizedPL: parseFloat(p.unrealizedPL || 0),
    }));
  }

  // Current prices (read-only)
  async getPrices(instruments) {
    const inst = Array.isArray(instruments) ? instruments.join(',') : instruments;
    const data = await this._get(`/v3/accounts/${this._account}/pricing?instruments=${inst}`);
    return (data.prices || []).map(p => ({
      instrument: p.instrument,
      bid: parseFloat(p.bids?.[0]?.price || 0),
      ask: parseFloat(p.asks?.[0]?.price || 0),
    }));
  }

  // Closed trade history (read-only)
  async getRecentTrades(count = 20) {
    const data = await this._get(`/v3/accounts/${this._account}/trades?count=${count}&state=CLOSED`);
    return (data.trades || []).map(t => ({
      id:          t.id,
      instrument:  t.instrument,
      price:       parseFloat(t.price || 0),
      realizedPL:  parseFloat(t.realizedPL || 0),
      closeTime:   t.closeTime,
    }));
  }

  // ── Internal ────────────────────────────────────────────────────────────────
  _get(path) {
    return new Promise((resolve, reject) => {
      if (!this._key) return reject(new Error('No analytics API key configured'));
      const req = https.request({
        hostname: this._base.replace('https://', ''),
        path,
        method: 'GET',
        headers: { Authorization: 'Bearer ' + this._key, 'Content-Type': 'application/json' },
      }, (res) => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch (_) { reject(new Error('Invalid JSON from OANDA')); }
        });
      });
      req.on('error', reject);
      req.end();
    });
  }
}

module.exports = { getAnalyticsKey, getTradingKey, isKeySeparationConfigured, OandaReadonlyClient };
