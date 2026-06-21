'use strict';
const { OHLCVValidator } = require('./ohlcv-validator');
const _ohlcvValidator = new OHLCVValidator({ intervalMs: 5 * 60_000 });
// ── market-data-fetcher.js ────────────────────────────────────────────────────

const https = require('https');
const { TRADING_CONFIG }                       = require('./trading-config');
const { withRetry, checkHttpStatus, fallbackChain } = require('./exchange-risk');

// Fix #74: Track active data source; flush price history on switch to prevent mixed-format data
let _currentDataSource = null;
function _checkDataSourceSwitch(newSource, engine) {
  if (_currentDataSource && _currentDataSource !== newSource) {
    console.warn(`[DataSource #74] Switch ${_currentDataSource}→${newSource} — price history may mix formats. Consider engine restart for clean warm-up.`);
    if (engine && engine.priceHistory) {
      console.warn('[DataSource #74] Clearing price history for clean warm-up after source switch');
      engine.priceHistory = [];
    }
  }
  _currentDataSource = newSource;
}

// Feature #87: Alpha Vantage free-tier rate limiter (5 calls/min, 25/day as of 2024)
// Free tier was cut from 500/day → 25/day. With 4 pairs that's ~6 full refresh cycles/day.
// When the daily budget is exhausted the connection is fully suspended (exhaustedUntil is set
// to the next midnight UTC). All calls are blocked and the bot falls back to cached/seed prices.
// At midnight UTC the suspension is automatically lifted and live data resumes.
const _avRateLimit = {
  calls:          [],
  maxPerMin:      5,
  maxPerDay:      25,
  dayStart:       Date.now(),
  dayCount:       0,
  exhaustedUntil: 0,   // ms timestamp — non-zero means suspended until this time

  _nextMidnightUTC() {
    const d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  },

  get isExhausted() { return this.exhaustedUntil > 0 && Date.now() < this.exhaustedUntil; },

  canCall() {
    const now = Date.now();
    // Auto-reconnect when midnight UTC has passed
    if (this.exhaustedUntil > 0 && now >= this.exhaustedUntil) {
      console.log('[AV] Daily limit reset at midnight UTC — resuming live price feed');
      this.exhaustedUntil = 0;
      this.dayStart       = now;
      this.dayCount       = 0;
      this.calls          = [];
    }
    // Suspended — connection cut until midnight UTC
    if (this.exhaustedUntil > 0) {
      const hoursLeft = ((this.exhaustedUntil - now) / 3_600_000).toFixed(1);
      console.warn(`[AV] Connection suspended — daily limit exhausted. Resumes in ${hoursLeft}h (midnight UTC)`);
      return false;
    }
    // Belt-and-suspenders rollover (handles process restarts near midnight)
    if (now - this.dayStart > 86_400_000) { this.dayStart = now; this.dayCount = 0; this.calls = []; }
    // Daily limit hit — cut connection until midnight UTC
    if (this.dayCount >= this.maxPerDay) {
      this.exhaustedUntil = this._nextMidnightUTC();
      console.warn(`[AV] Daily limit exhausted (${this.maxPerDay}/${this.maxPerDay}) — connection suspended until midnight UTC (${new Date(this.exhaustedUntil).toUTCString()})`);
      return false;
    }
    // Rolling 60s per-minute throttle
    this.calls = this.calls.filter(t => now - t < 60_000);
    if (this.calls.length >= this.maxPerMin) {
      console.warn(`[AV] Rate limit: ${this.calls.length}/${this.maxPerMin} calls in last 60s — skipping`);
      return false;
    }
    this.calls.push(now);
    this.dayCount++;
    // Low-remaining warning: alert when 5 or fewer calls left today
    const remaining = this.maxPerDay - this.dayCount;
    if (remaining <= 5 && remaining > 0)
      console.warn(`[AV] Only ${remaining} API call${remaining === 1 ? '' : 's'} remaining today`);
    return true;
  },

  status() {
    const now = Date.now();
    return {
      callsToday:     this.dayCount,
      remaining:      Math.max(0, this.maxPerDay - this.dayCount),
      maxPerDay:      this.maxPerDay,
      exhausted:      this.isExhausted,
      exhaustedUntil: this.exhaustedUntil > 0 ? new Date(this.exhaustedUntil).toUTCString() : null,
      callsInLastMin: this.calls.filter(t => now - t < 60_000).length,
      maxPerMin:      this.maxPerMin,
    };
  },
};

// ── Realistic seed prices (mid-market approximations) ─────────────────────────
const SEED_PRICES = {
  'EURUSD': 1.0850,
  'GBPUSD': 1.2750,
  'USDJPY': 149.50,
  'AUDUSD': 0.6850,
};

// Stagger offsets so Alpha Vantage calls spread 15s apart (EURUSD@0s, GBPUSD@15s, USDJPY@30s, AUDUSD@45s)
const STAGGER_OFFSETS_MS = { EURUSD: 0, GBPUSD: 15_000, USDJPY: 30_000, AUDUSD: 45_000 };

// ── Session volume weights (UTC hour → relative volume multiplier) ────────────
// Source: typical institutional forex volume distribution
function sessionVolume(utcHour) {
  // London open 08-16, NY open 13-21, overlap 13-16 is peak
  if (utcHour >= 13 && utcHour < 16) return 1_800_000;   // London+NY overlap (peak)
  if (utcHour >= 8  && utcHour < 16) return 1_400_000;   // London session
  if (utcHour >= 13 && utcHour < 21) return 1_200_000;   // NY session
  if (utcHour >= 0  && utcHour < 8 ) return   700_000;   // Asian session
  return 500_000;                                          // off-hours
}

class MarketDataFetcher {
  constructor() {
    // Per-asset cache: last known real price + metadata
    this.prices = {};
    for (const [asset, price] of Object.entries(SEED_PRICES)) {
      this.prices[asset] = {
        price,
        bid:        price - 0.0001,
        ask:        price + 0.0001,
        volume:     1_000_000,
        lastUpdate: 0,           // 0 = never fetched from API
        source:     'seed',
      };
    }

    this.priceHistories  = {};
    this.volumeHistories = {};
    for (const asset of Object.keys(this.prices)) {
      this.priceHistories[asset]  = [this.prices[asset].price];
      this.volumeHistories[asset] = [this.prices[asset].volume];
    }

    // Alpha Vantage free tier: 5 calls/min, 25/day. Use 60s refresh interval
    // and stagger assets 15s apart so all 4 pairs fit within the per-minute budget.
    this._refreshIntervalMs = parseInt(process.env.PRICE_REFRESH_MS || '60000');
    this._lastRefresh       = {};   // asset → timestamp of last API call
    this._feedFailCount     = {};   // asset → consecutive all-retry failures
    this._feedBackoffUntil  = {};   // asset → timestamp: skip refresh until then

    // Stagger initial refresh eligibility so assets don't all fire at once
    const now = Date.now();
    for (const [asset, offsetMs] of Object.entries(STAGGER_OFFSETS_MS)) {
      // Asset becomes eligible for first refresh after its stagger offset has elapsed
      this._lastRefresh[asset] = now - this._refreshIntervalMs + offsetMs;
    }
  }

  // ── fetchPrice — sync, returns last refreshed price (NO random walk) ────────
  // NOTE: does NOT push to priceHistory anymore — refreshPrice() does that.
  // Previously this pushed on every sync call, causing double-counting when
  // both refreshPrice() and fetchPrice() were called in the same tick.
  fetchPrice(asset) {
    asset = asset.replace(/_/g, '');   // normalise EUR_USD → EURUSD (global regex)
    if (!this.prices[asset]) throw new Error(`Asset ${asset} not supported`);
    const cached   = this.prices[asset];
    const price    = cached.price;
    const volume   = cached.volume || sessionVolume(new Date().getUTCHours());
    const history    = this.priceHistories[asset];
    const volHistory = this.volumeHistories[asset];

    return {
      asset, price, volume,
      bid:    cached.bid   || price - 0.0001,
      ask:    cached.ask   || price + 0.0001,
      source: cached.source,
      timestamp: cached.lastUpdate || Date.now(),
      history:       history.slice(),      // shallow copy — prevents mutation of internal store
      volumeHistory: volHistory.slice(),   // shallow copy
    };
  }

  // ── refreshPrice — async, fetches real market price ──────────────────────────
  // Returns { price, bid, ask, volume, source }
  // Rate-limited to _refreshIntervalMs to avoid hammering APIs.
  async refreshPrice(asset) {
    asset = asset.replace(/_/g, '');   // normalise EUR_USD → EURUSD (global regex)
    if (!this.prices[asset]) throw new Error(`Asset ${asset} not supported`);

    const now       = Date.now();
    const lastFetch = this._lastRefresh[asset] || 0;
    if (now - lastFetch < this._refreshIntervalMs) {
      return this.prices[asset];  // still fresh — skip API call
    }

    // ── Feed-level exponential backoff ───────────────────────────────────
    // Per-request retry (withRetry) handles transient failures within one call.
    // This backoff handles sustained feed outages: after N consecutive all-retry
    // exhaustions, we progressively extend the gap before trying again.
    //   0-2 failures : normal interval (no extra wait)
    //   3-5 failures : 30s extra wait
    //   6-9 failures : 60s extra wait
    //   10+ failures : 120s extra wait
    const backoffUntil = this._feedBackoffUntil[asset] || 0;
    if (now < backoffUntil) {
      const secsLeft = ((backoffUntil - now) / 1000).toFixed(0);
      console.warn(`[FeedBackoff] ${asset}: feed backoff active — ${secsLeft}s remaining (${this._feedFailCount[asset]} consecutive failures)`);
      return this.prices[asset];  // return cached price during backoff
    }

    let result;
    try {
      result = await this._fetchLivePrice(asset);
      // Success — reset failure counter
      if (this._feedFailCount[asset]) {
        console.log(`[FeedBackoff] ${asset}: feed recovered after ${this._feedFailCount[asset]} failures`);
        this._feedFailCount[asset]  = 0;
        this._feedBackoffUntil[asset] = 0;
      }
    } catch (err) {
      // All retries exhausted — increment counter atomically before any conditional
      this._feedFailCount[asset] = (this._feedFailCount[asset] || 0) + 1;
      const fails = this._feedFailCount[asset];
      const extraMs = fails >= 10 ? 120_000 : fails >= 6 ? 60_000 : fails >= 3 ? 30_000 : 0;
      if (extraMs > 0) {
        this._feedBackoffUntil[asset] = now + extraMs;
        console.warn(`[FeedBackoff] ${asset}: ${fails} consecutive failures — backing off ${extraMs/1000}s`);
      }
      return this.prices[asset];  // return last known price
    }
    this.prices[asset].price      = result.price;
    this.prices[asset].bid        = result.bid;
    this.prices[asset].ask        = result.ask;
    this.prices[asset].volume     = result.volume;
    this.prices[asset].source     = result.source;
    this.prices[asset].lastUpdate = now;
    this._lastRefresh[asset]      = now;

    return this.prices[asset];
  }

  // ── _fetchLivePrice — Alpha Vantage primary, cached fallback ─────────────────
  async _fetchLivePrice(asset) {
    const result = await fallbackChain([

      // ── Source 1: Alpha Vantage FX real-time (primary and only live source) ─
      {
        label: 'Alpha Vantage',
        fn: async () => {
          const avKey = process.env.ALPHA_VANTAGE_API_KEY;
          if (!avKey || avKey.includes('your_')) return null;
          // Feature #87: Enforce free-tier rate limit (5/min, 25/day)
          if (!_avRateLimit.canCall()) return null;

          // CURRENCY_EXCHANGE_RATE gives the real-time bid/ask mid
          const [from, to] = asset.length === 6
            ? [asset.slice(0, 3), asset.slice(3)]
            : asset.split(/[/_]/);

          const path_ = `/query?function=CURRENCY_EXCHANGE_RATE` +
                        `&from_currency=${from}&to_currency=${to}&apikey=${avKey}`;

          const raw  = await withRetry(
            () => this._httpsGet('www.alphavantage.co', path_, {}),
            { maxAttempts: 2, baseDelay: 1000, maxDelay: 5000, label: `AlphaVantage live ${asset}` }
          );
          const json = JSON.parse(raw);
          const rate = json['Realtime Currency Exchange Rate'];
          if (!rate) return null;

          const price = parseFloat(rate['5. Exchange Rate']);
          const bid   = parseFloat(rate['8. Bid Price']  || price - 0.0001);
          const ask   = parseFloat(rate['9. Ask Price']  || price + 0.0001);

          if (!price || price <= 0) return null;
          return { price, bid, ask, volume: sessionVolume(new Date().getUTCHours()), source: 'AlphaVantage' };
        },
      },

    ],

    // ── Fallback: return last known price — FLAT, not random ──────────────
    () => {
      const cached = this.prices[asset];
      if (cached.lastUpdate > 0) {
        // We've had at least one real price — stay flat, don't fabricate movement
        console.warn(`[MarketData] ⚠️  ${asset}: no live data — holding last price ${cached.price.toFixed(5)} (${cached.source})`);
        return { ...cached, source: cached.source + '_cached' };
      }
      // First boot with no API keys — use seed price, log a clear warning
      console.warn(
        `[MarketData] ⚠️  ${asset}: no API keys configured.\n` +
        `  Set ALPHA_VANTAGE_API_KEY in your .env file.\n` +
        `  Price is FROZEN at seed value ${cached.price.toFixed(5)} — not a live feed.`
      );
      return { price: cached.price, bid: cached.price - 0.0001, ask: cached.price + 0.0001,
               volume: sessionVolume(new Date().getUTCHours()), source: 'seed_no_api' };
    },

    `Live price ${asset}`);

    return result.result;
  }

  // ── History accessors ─────────────────────────────────────────────────────
  getPriceHistory(asset)  { return this.priceHistories[asset]  || []; }
  getVolumeHistory(asset) { return this.volumeHistories[asset] || []; }

  // ── Warm-up: pre-seed histories from real historical candles ─────────────
  async warmUpHistory(asset, count) {
    asset = asset.replace(/_/g, '');   // normalise EUR_USD → EURUSD (global regex)
    if (!this.prices[asset]) return;
    console.log(`[WarmUp] Fetching ${count} real candles for ${asset}…`);

    let { prices, volumes, source } = (await fallbackChain([
      {
        label: 'Alpha Vantage',
        fn: async () => {
          const avKey = process.env.ALPHA_VANTAGE_API_KEY;
          if (!avKey || avKey.includes('your_')) return null;
          const [from, to] = asset.length === 6
            ? [asset.slice(0, 3), asset.slice(3)]
            : asset.split(/[/_]/);
          const path_ = `/query?function=FX_INTRADAY&from_symbol=${from}&to_symbol=${to}&interval=5min&outputsize=full&apikey=${avKey}`;
          const raw   = await withRetry(
            () => this._httpsGet('www.alphavantage.co', path_, {}),
            { maxAttempts: 3, baseDelay: 2000, maxDelay: 10000, label: `AlphaVantage warmup ${asset}` }
          );
          const series = JSON.parse(raw)['Time Series FX (5min)'];
          if (!series) return null;
          const entries = Object.values(series).reverse().slice(-count);
          return { prices: entries.map(c => parseFloat(c['4. close'])), volumes: entries.map(c => parseInt(c['5. volume'] || 1_000_000)) };
        },
      },
    ], () => {
      console.warn(`[WarmUp] ⚠️  No API keys — history is flat (seed price). Configure ALPHA_VANTAGE_API_KEY for real data.`);
      const p = this.prices[asset].price;
      const n = count;
      // BUG-16 fix: include source field so the success log shows 'simulation' not 'undefined'
      return { prices: Array(n).fill(p), volumes: Array(n).fill(sessionVolume(new Date().getUTCHours())), source: 'simulation' };
    }, `WarmUp ${asset}`)).result;

    // ── OHLCV validation on freshly fetched history ─────────────────────
    const rawCandles = prices.map((p, i) => ({ time: Date.now() - (prices.length - i) * 300_000, open: p, high: p, low: p, close: p, volume: volumes[i] || 0 }));
    const valReport  = _ohlcvValidator.validate(rawCandles);
    if (!valReport.valid && valReport.issues.length > 0) {
      console.warn(`[WarmUp] ⚠️  ${asset} OHLCV issues: ${valReport.gapCount} gaps, ${valReport.spikeCount} spikes — cleaning`);
      const cleaned  = _ohlcvValidator.clean(rawCandles);
      prices  = cleaned.map(c => c.close);
      volumes = cleaned.map(c => c.volume);
    }
    this.priceHistories[asset]  = prices.slice(-TRADING_CONFIG.maxHistoryLength);
    this.volumeHistories[asset] = volumes.slice(-TRADING_CONFIG.maxHistoryLength);
    // Seed the live price cache with the last real candle close
    this.prices[asset].price      = prices[prices.length - 1];
    this.prices[asset].lastUpdate = Date.now();
    this.prices[asset].source     = source;
    console.log(`[WarmUp] ✅ ${asset} seeded with ${prices.length} candles via ${source}`);
  }

  // Warms up all assets sequentially with 15s stagger to respect Alpha Vantage rate limits
  async warmUpAll(count) {
    const assets = Object.keys(this.prices);
    for (let i = 0; i < assets.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 15_000));
      await this.warmUpHistory(assets[i], count);
    }
  }

  // ── Internal HTTPS GET ────────────────────────────────────────────────────
  _httpsGet(hostname, path_, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = https.get({ hostname, path: path_, headers }, (res) => {
        try { checkHttpStatus(res.statusCode, `GET ${hostname}${path_}`); } catch (err) { reject(err); return; }
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => resolve(raw));
      });
      req.on('error', reject);
      req.setTimeout(10_000, () => { req.destroy(); reject(new Error('timeout')); });
    });
  }
}

// Item 59: Data vendor fallback chain — AlphaVantage → Polygon → cache
async function fetchPriceWithFallback(asset, engines) {
  // engines = [{ name, fetch: async ()=>price }]
  const { logError } = require('./error-codes');
  for (const { name, fetch } of (engines||[])) {
    try {
      const price = await fetch();
      if (price && isFinite(price) && price > 0) return { price, source: name };
    } catch(e) {
      logError('E4003', { vendor: name, asset, detail: e.message });
    }
  }
  logError('E4004', { asset });
  return null;
}

// Build default fallback chain for a given asset
function buildFallbackChain(asset, avKey, polygonKey) {
  const chain = [];
  if (avKey)   chain.push({ name:'AlphaVantage', fetch: async () => {
    const https = require('https');
    return new Promise((res,rej)=>{
      https.get(`https://www.alphavantage.co/query?function=FX_INTRADAY&from_symbol=${asset.slice(0,3)}&to_symbol=${asset.slice(3)}&interval=5min&apikey=${avKey}`,
        { timeout:5000 }, r=>{ let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try {
          const j=JSON.parse(d); const ts=Object.keys(j['Time Series FX (5min)']||{})[0];
          res(parseFloat(j['Time Series FX (5min)'][ts]['4. close'])); } catch{rej(new Error('AV parse')); } }); }
      ).on('error',rej).on('timeout',function(){this.destroy();rej(new Error('AV timeout'));});
    });
  }});
  if (polygonKey) chain.push({ name:'Polygon', fetch: async () => {
    const https = require('https');
    const inst  = `C:${asset.replace('/','').toUpperCase()}`;
    return new Promise((res,rej)=>{
      https.get(`https://api.polygon.io/v2/last/trade/${inst}?apiKey=${polygonKey}`,
        { timeout:5000 }, r=>{ let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try {
          res(parseFloat(JSON.parse(d).results?.p||0)); } catch{rej(new Error('Polygon parse')); } }); }
      ).on('error',rej).on('timeout',function(){this.destroy();rej(new Error('Polygon timeout'));});
    });
  }});
  return chain;
}

module.exports = { MarketDataFetcher, _avRateLimit };
