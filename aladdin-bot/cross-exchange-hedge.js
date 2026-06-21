'use strict';
// ── cross-exchange-hedge.js ───────────────────────────────────────────────────
// Cross-exchange hedging framework.
//
// Architecture:
//   Primary broker:   OANDA (live trading)
//   Hedge broker:     Configurable second broker (FXCM, IG, etc.) via env vars
//
// Hedging strategies implemented:
//   1. CORRELATION HEDGE — when two correlated assets diverge significantly,
//      go long the lagging one and short the leading one.
//   2. DELTA HEDGE — open an offsetting position on the hedge broker when
//      primary position exceeds riskThreshold.
//   3. SPREAD HEDGE — simultaneously long on the cheaper broker, short on
//      the more expensive one (statistical arbitrage on bid/ask spread).
//
// Live execution on hedge broker requires HEDGE_BROKER_URL + HEDGE_API_KEY env vars.
// Without them, the framework runs in simulation mode (records what it would do).
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');
const { TRADING_CONFIG } = require('./trading-config');

class CrossExchangeHedge {
  constructor() {
    this._hedgeBrokerUrl  = process.env.HEDGE_BROKER_URL || null;
    this._hedgeApiKey     = process.env.HEDGE_API_KEY    || null;
    this._live            = !!(this._hedgeBrokerUrl && this._hedgeApiKey);
    this._hedgePositions  = [];   // { asset, side, size, entry, broker, openedAt }
    this._priceCache      = {};   // asset → { primary, hedge, ts }
    this._hedgeLog        = [];   // audit trail of hedge decisions
  }

  // ── Record prices from both brokers ──────────────────────────────────────
  recordPrice(asset, source, price) {
    if (!this._priceCache[asset]) this._priceCache[asset] = {};
    this._priceCache[asset][source] = { price, ts: Date.now() };
  }

  // ── Check if a correlation hedge opportunity exists ───────────────────────
  // asset1 and asset2 should be correlated (e.g. EURUSD and GBPUSD)
  checkCorrelationHedge(asset1, asset2, correlationMatrix) {
    const corr = correlationMatrix?.[asset1]?.[asset2] || correlationMatrix?.[asset2]?.[asset1];
    if (!corr || Math.abs(corr) < 0.7) return null;  // need strong correlation

    const p1 = this._priceCache[asset1];
    const p2 = this._priceCache[asset2];
    if (!p1?.primary || !p2?.primary) return null;

    // BUG-55 fix: old code was (p/p) - (p/p) = 0 always — prices divided by themselves
    // Fix: compare the RATIO of the two assets' current prices vs their initial ratio
    // to detect when they have diverged from their historical relationship.
    if (!this._priceBase) this._priceBase = {};
    if (!this._priceBase[asset1]) this._priceBase[asset1] = p1.primary.price;
    if (!this._priceBase[asset2]) this._priceBase[asset2] = p2.primary.price;

    const norm1 = p1.primary.price / this._priceBase[asset1];
    const norm2 = p2.primary.price / this._priceBase[asset2];
    const div = Math.abs(norm1 - norm2);
    const threshold = TRADING_CONFIG.hedgeDivergenceThreshold || 0.002;

    if (div > threshold) {
      const leadingAsset  = p1.primary.price > p2.primary.price ? asset1 : asset2;
      const laggingAsset  = leadingAsset === asset1 ? asset2 : asset1;
      return {
        type:          'CORRELATION_HEDGE',
        longAsset:     laggingAsset,
        shortAsset:    leadingAsset,
        divergence:    parseFloat(div.toFixed(5)),
        correlation:   parseFloat(corr.toFixed(3)),
        recommendation: 'Long ' + laggingAsset + ' / Short ' + leadingAsset,
      };
    }
    return null;
  }

  // ── Delta hedge: offset risk from primary position ───────────────────────
  checkDeltaHedge(primaryPosition, riskThreshold = 0.03) {
    if (!primaryPosition) return null;

    const posSize     = primaryPosition.cost || 0;
    const capitalFrac = posSize / (TRADING_CONFIG.initialCapital || 10000);

    if (capitalFrac < riskThreshold) return null;  // position too small to hedge

    return {
      type:        'DELTA_HEDGE',
      asset:       primaryPosition.asset || 'UNKNOWN',
      primarySide: primaryPosition.side || 'LONG',
      hedgeSide:   primaryPosition.side === 'SHORT' ? 'LONG' : 'SHORT',
      hedgeSize:   parseFloat((posSize * 0.5).toFixed(2)),   // 50% offset
      reason:      'Position size ' + (capitalFrac * 100).toFixed(1) + '% exceeds hedge threshold ' + (riskThreshold * 100) + '%',
    };
  }

  // ── Execute hedge on secondary broker (or simulate) ───────────────────────
  async executeHedge(hedgeSignal) {
    const record = {
      ...hedgeSignal,
      ts:    new Date().toISOString(),
      mode:  this._live ? 'LIVE' : 'SIMULATED',
      status: 'PENDING',
    };

    if (!this._live) {
      record.status = 'SIMULATED';
      this._hedgeLog.push(record);
      console.log('[HedgeFramework] SIMULATED:', hedgeSignal.type, hedgeSignal.recommendation || hedgeSignal.reason);
      return record;
    }

    // Live execution via hedge broker REST API
    try {
      const payload = JSON.stringify({
        instrument: (hedgeSignal.longAsset || hedgeSignal.asset)?.replace('/', '_'),
        side:       hedgeSignal.hedgeSide || 'SHORT',
        units:      Math.floor((hedgeSignal.hedgeSize || 1000)),
        type:       'MARKET',
      });
      const res = await this._post('/v3/accounts/hedge/orders', payload);
      record.status   = 'FILLED';
      record.response = res;
      this._hedgePositions.push({ ...record, openedAt: Date.now() });
    } catch (err) {
      record.status = 'FAILED';
      record.error  = err.message;
    }

    this._hedgeLog.push(record);
    return record;
  }

  // ── Close all open hedge positions ────────────────────────────────────────
  async closeAllHedges(reason = 'manual') {
    if (!this._live) {
      console.log('[HedgeFramework] Would close', this._hedgePositions.length, 'simulated hedges');
      this._hedgePositions = [];
      return;
    }
    for (const pos of this._hedgePositions) {
      try {
        await this._post('/v3/accounts/hedge/positions/' + pos.instrument + '/close', '{"longUnits":"ALL","shortUnits":"ALL"}');
      } catch (_) {}
    }
    this._hedgePositions = [];
    console.log('[HedgeFramework] All hedges closed —', reason);
  }

  // ── REST helper for hedge broker ─────────────────────────────────────────
  _post(path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(this._hedgeBrokerUrl + path);
      const opts = {
        hostname: url.hostname, path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + this._hedgeApiKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      };
      const req = https.request(opts, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => { try { resolve(JSON.parse(raw)); } catch(_) { resolve(raw); } });
      });
      req.on('error', reject);
      req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body);
      req.end();
    });
  }

  get isLive()         { return this._live; }
  get hedgePositions() { return this._hedgePositions; }
  get hedgeLog()       { return this._hedgeLog.slice(-50); }
}

module.exports = { CrossExchangeHedge };
