'use strict';
// ── sector-cap.js ─────────────────────────────────────────────────────────────
// Per-sector (currency-group) exposure cap for multi-position trading.
//
// Fixes: Risk partial — "Add max open positions and sector-level exposure caps."
//
// Currency sectors (forex):
//   USD_MAJOR  : EURUSD, GBPUSD, USDJPY, AUDUSD, USDCAD, USDCHF, NZDUSD
//   EUR_CROSS  : EURGBP, EURJPY, EURAUD, EURCHF
//   GBP_CROSS  : GBPJPY, GBPAUD, GBPCHF
//   COMM_BLOC  : AUDUSD, NZDUSD, USDCAD (commodity currencies)
//
// Rules enforced:
//   1. maxOpenPositions    — absolute cap on concurrent open trades
//   2. maxSectorPositions  — cap per currency sector
//   3. maxSectorExposure   — max % of capital exposed in one sector
//   4. maxCurrencyExposure — max net exposure to a single currency (e.g. USD)
//
// Usage:
//   const { SectorCap } = require('./sector-cap');
//   const cap = new SectorCap({ maxOpenPositions: 3, maxSectorPositions: 2 });
//   const check = cap.canEnter('EURUSD', openPositions, capital);
//   if (!check.allowed) return HOLD;
//   cap.open('EURUSD', size, entryPrice, capital);
//   cap.close('EURUSD');
// ─────────────────────────────────────────────────────────────────────────────

// Asset → constituent currencies
const ASSET_CURRENCIES = {
  EURUSD: ['EUR', 'USD'], GBPUSD: ['GBP', 'USD'], USDJPY: ['USD', 'JPY'],
  AUDUSD: ['AUD', 'USD'], USDCAD: ['USD', 'CAD'], USDCHF: ['USD', 'CHF'],
  NZDUSD: ['NZD', 'USD'], EURGBP: ['EUR', 'GBP'], EURJPY: ['EUR', 'JPY'],
  EURAUD: ['EUR', 'AUD'], EURCHF: ['EUR', 'CHF'], GBPJPY: ['GBP', 'JPY'],
  GBPAUD: ['GBP', 'AUD'], GBPCHF: ['GBP', 'CHF'],
};

// Asset → sector membership — meaningful sub-groups (#31 fix)
const ASSET_SECTORS = {
  // European majors (EUR/GBP correlated)
  EURUSD: ['EUROPEAN', 'USD_EXPOSURE', 'USD_MAJOR'], GBPUSD: ['EUROPEAN', 'USD_EXPOSURE', 'USD_MAJOR'],
  // Asia-Pacific
  USDJPY: ['ASIA_PACIFIC', 'USD_EXPOSURE', 'USD_MAJOR'], AUDUSD: ['ASIA_PACIFIC', 'COMM_BLOC', 'USD_EXPOSURE', 'USD_MAJOR'],
  NZDUSD: ['ASIA_PACIFIC', 'COMM_BLOC', 'USD_EXPOSURE', 'USD_MAJOR'],
  // Commodity-linked
  USDCAD: ['COMM_BLOC', 'USD_EXPOSURE', 'USD_MAJOR'], USDCHF: ['SAFE_HAVEN', 'USD_EXPOSURE', 'USD_MAJOR'],
  // Crosses
  EURGBP: ['EUROPEAN'], EURJPY: ['EUROPEAN', 'ASIA_PACIFIC'],
  EURAUD: ['EUROPEAN', 'ASIA_PACIFIC'], EURCHF: ['EUROPEAN', 'SAFE_HAVEN'],
  GBPJPY: ['EUROPEAN', 'ASIA_PACIFIC'], GBPAUD: ['EUROPEAN', 'ASIA_PACIFIC'], GBPCHF: ['EUROPEAN', 'SAFE_HAVEN'],
};

class SectorCap {
  constructor(opts = {}) {
    this.maxOpenPositions    = opts.maxOpenPositions    || 5;
    this.maxSectorPositions  = opts.maxSectorPositions  || 2;
    this.maxSectorExposurePct= opts.maxSectorExposurePct|| 0.30;  // 30% of capital per sector
    this.maxCurrencyExposure = opts.maxCurrencyExposurePct || 0.40; // 40% net in one currency
    this._open = new Map();   // asset → { size, notional, sector }
  }

  // ── Pre-entry check ───────────────────────────────────────────────────────
  // Returns { allowed, reason, details }
  canEnter(asset, capital) {
    const sectors    = ASSET_SECTORS[asset] || ['OTHER'];
    const currencies = ASSET_CURRENCIES[asset] || [];
    const openCount  = this._open.size;

    // 1. Global position count
    if (openCount >= this.maxOpenPositions) {
      return this._block(`Max open positions reached (${openCount}/${this.maxOpenPositions})`);
    }

    // 2. Already in this exact asset
    if (this._open.has(asset)) {
      return this._block(`Already holding ${asset}`);
    }

    // 3. Sector position count
    for (const sector of sectors) {
      const sectorCount = this._countSector(sector);
      if (sectorCount >= this.maxSectorPositions) {
        return this._block(`Sector ${sector} full (${sectorCount}/${this.maxSectorPositions} positions)`);
      }
    }

    // 4. Sector exposure % of capital
    // Bug fix: NaN capital made (capital > 0) false, silently skipping the exposure check
    // and allowing unlimited sector concentration when capital reporting failed.
    const safeCapital = (typeof capital === 'number' && isFinite(capital) && capital > 0) ? capital : 0;
    for (const sector of sectors) {
      const sectorNotional = this._notionalSector(sector);
      if (safeCapital > 0 && (sectorNotional / safeCapital) >= this.maxSectorExposurePct) {
        return this._block(`Sector ${sector} exposure ${(sectorNotional/capital*100).toFixed(1)}% ≥ limit ${(this.maxSectorExposurePct*100).toFixed(0)}%`);
      }
    }

    // 5. Net currency exposure
    for (const ccy of currencies) {
      const ccyNotional = this._notionalCurrency(ccy);
      if (capital > 0 && (ccyNotional / capital) >= this.maxCurrencyExposure) {
        return this._block(`${ccy} exposure ${(ccyNotional/capital*100).toFixed(1)}% ≥ limit ${(this.maxCurrencyExposure*100).toFixed(0)}%`);
      }
    }

    return {
      allowed: true,
      reason:  `Entry allowed (${openCount + 1}/${this.maxOpenPositions} positions)`,
      details: { openCount: openCount + 1, sectors, currencies },
    };
  }

  // ── Record an opened position ─────────────────────────────────────────────
  open(asset, size, entryPrice, capital) {
    const notional = size * entryPrice;
    const sectors  = ASSET_SECTORS[asset] || ['OTHER'];
    const currencies = ASSET_CURRENCIES[asset] || [];
    this._open.set(asset, { size, notional, entryPrice, sectors, currencies, capital, openedAt: Date.now() });
  }

  // ── Record a closed position ───────────────────────────────────────────────
  close(asset) {
    this._open.delete(asset);
  }

  // ── Status ────────────────────────────────────────────────────────────────
  status(capital) {
    const positions = [...this._open.entries()].map(([asset, p]) => ({
      asset,
      notional:  p.notional,
      sectors:   p.sectors,
      pctCapital:capital > 0 ? parseFloat((p.notional / capital * 100).toFixed(2)) : 0,
    }));

    const sectorSummary = {};
    for (const [, p] of this._open.entries()) {
      for (const s of p.sectors) {
        sectorSummary[s] = (sectorSummary[s] || 0) + p.notional;
      }
    }

    return {
      openCount: this._open.size,
      maxOpen:   this.maxOpenPositions,
      positions,
      sectorExposure: Object.fromEntries(
        Object.entries(sectorSummary).map(([k, v]) => [k, capital > 0 ? parseFloat((v/capital*100).toFixed(2)) : 0])
      ),
    };
  }

  // ── Internal ───────────────────────────────────────────────────────────────
  _countSector(sector) {
    let count = 0;
    for (const [, p] of this._open.entries()) {
      if ((p.sectors || []).includes(sector)) count++;
    }
    return count;
  }

  _notionalSector(sector) {
    let total = 0;
    for (const [, p] of this._open.entries()) {
      if ((p.sectors || []).includes(sector)) total += p.notional;
    }
    return total;
  }

  _notionalCurrency(currency) {
    let total = 0;
    for (const [, p] of this._open.entries()) {
      if ((p.currencies || []).includes(currency)) total += p.notional;
    }
    return total;
  }

  _block(reason) { return { allowed: false, reason, details: {} }; }
}

// ── Param count limiter (overfitting guard) ───────────────────────────────────
// Raises if a strategy registers more than maxParams optimised parameters.
class ParamLimiter {
  constructor(maxParams = 8) {
    this.maxParams  = maxParams;
    this._registry  = new Map();   // strategyName → Set of param names
  }

  register(strategyName, params) {
    const names = Object.keys(params);
    if (names.length > this.maxParams) {
      throw new Error(
        `[ParamLimiter] ${strategyName} has ${names.length} optimised params ` +
        `(max ${this.maxParams}). Reduce to avoid overfitting: ${names.join(', ')}`
      );
    }
    this._registry.set(strategyName, new Set(names));
    return { strategyName, count: names.length, allowed: true };
  }

  count(strategyName) {
    return this._registry.get(strategyName)?.size ?? 0;
  }

  report() {
    return [...this._registry.entries()].map(([name, params]) => ({
      strategy: name,
      paramCount: params.size,
      params: [...params],
      overLimit: params.size > this.maxParams,
    }));
  }
}

module.exports = { SectorCap, ParamLimiter, ASSET_SECTORS, ASSET_CURRENCIES };
