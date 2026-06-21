'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  exchange-risk.js
//  Exchange Risk Management — API failure handling, retry, fallback systems
//
//  Components
//  ──────────
//  withRetry(fn, opts)
//    Wraps any async function with exponential-backoff retry logic.
//    Uses the retry config from TRADING_CONFIG (maxAttempts, baseDelay,
//    maxDelay, multiplier). Retries on any thrown error or rejected promise.
//    Respects HTTP status codes — 429 adds extra back-off, 4xx non-retryable.
//
//  checkHttpStatus(statusCode, label)
//    Throws a typed error for HTTP 429 (rate limited), 5xx (server error),
//    and other non-2xx codes so withRetry can handle them correctly.
//
//  StaleDataMonitor
//    Tracks the timestamp of the last successful price update. If the feed
//    goes silent for longer than maxAgeMs, isStale() returns true and the
//    trading loop should halt new entries until data resumes.
//    Fires an onStale callback and auto-recovers when data resumes.
//
//  DeadMansSwitch
//    The main trading loop calls heartbeat() on every iteration.
//    A background timer checks every checkIntervalMs whether a heartbeat
//    was received within timeoutMs. If not, it fires onDead(). This detects
//    silent crashes where the loop stops iterating without throwing.
//
//  Usage in trading-engine.js
//  ──────────────────────────
//  const { withRetry, checkHttpStatus, StaleDataMonitor, DeadMansSwitch } = require('./exchange-risk');
//
//  // Wrap any API call:
//  const raw = await withRetry(() => this._httpsGet(host, path, headers), {
//    maxAttempts: 3, baseDelay: 1000, label: 'AV price fetch'
//  });
//
//  // Stale data:
//  const staleMonitor = new StaleDataMonitor({ maxAgeMs: 60_000,
//    onStale: () => log('Price feed stale — halting entries'),
//    onRecover: () => log('Price feed recovered') });
//  staleMonitor.ping();   // call after each successful price update
//  if (staleMonitor.isStale()) return; // in main loop
//
//  // Dead man's switch:
//  const dms = new DeadMansSwitch({ timeoutMs: 90_000,
//    onDead: () => log('Main loop silent — possible crash') });
//  dms.start();
//  // In main loop:  dms.heartbeat();
//  // On shutdown:   dms.stop();
// ═══════════════════════════════════════════════════════════════════════════════

// ── Typed HTTP errors ─────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor (statusCode, message) {
    super(message);
    this.name        = 'HttpError';
    this.statusCode  = statusCode;
    this.retryable   = statusCode === 429 || statusCode >= 500;
    this.rateLimited = statusCode === 429;
  }
}

// Throws a typed HttpError for non-2xx status codes.
// Call this inside _httpsGet after reading res.statusCode.
function checkHttpStatus (statusCode, label = 'API call') {
  if (statusCode >= 200 && statusCode < 300) return;   // OK
  if (statusCode === 429) {
    throw new HttpError(429, `${label}: HTTP 429 Rate Limited — too many requests`);
  }
  if (statusCode === 503) {
    throw new HttpError(503, `${label}: HTTP 503 Service Unavailable`);
  }
  if (statusCode >= 500) {
    throw new HttpError(statusCode, `${label}: HTTP ${statusCode} Server Error`);
  }
  if (statusCode >= 400) {
    // 4xx (except 429) are client errors — not retryable
    const err = new HttpError(statusCode, `${label}: HTTP ${statusCode} Client Error`);
    err.retryable = false;
    throw err;
  }
}

// ── withRetry ─────────────────────────────────────────────────────────────────

const RETRY_DEFAULTS = {
  maxAttempts: 3,
  baseDelay:   1000,    // ms — delay after first failure
  maxDelay:    10_000,  // ms — cap on delay
  multiplier:  2,       // exponential factor
  label:       'API call',
  onRetry:     null,    // optional callback(attempt, delay, err)
};

// Wraps an async function with exponential-backoff retry.
// Non-retryable HttpErrors (4xx except 429) are thrown immediately.
// 429 responses add an extra 5s penalty on top of the backoff.
async function withRetry (fn, opts = {}) {
  const cfg = { ...RETRY_DEFAULTS, ...opts };
  let lastErr;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      // Non-retryable: throw immediately
      if (err instanceof HttpError && !err.retryable) throw err;

      if (attempt === cfg.maxAttempts) break;

      // Compute delay with exponential backoff
      let delay = Math.min(
        cfg.baseDelay * Math.pow(cfg.multiplier, attempt - 1),
        cfg.maxDelay
      );

      // Extra back-off for rate limiting
      if (err instanceof HttpError && err.rateLimited) {
        delay = Math.max(delay, 5_000);
        console.warn(`[ExchangeRisk] ${cfg.label}: rate limited — waiting ${delay}ms before retry`);
      } else {
        console.warn(`[ExchangeRisk] ${cfg.label}: attempt ${attempt}/${cfg.maxAttempts} failed (${err.message}) — retrying in ${delay}ms`);
      }

      if (typeof cfg.onRetry === 'function') {
        cfg.onRetry(attempt, delay, err);
      }

      await new Promise(r => setTimeout(r, delay));
    }
  }

  console.error(`[ExchangeRisk] ${cfg.label}: all ${cfg.maxAttempts} attempts failed — ${lastErr.message}`);
  throw lastErr;
}

// ── StaleDataMonitor ──────────────────────────────────────────────────────────

const STALE_DEFAULTS = {
  maxAgeMs:        60_000,   // 60s — price feed considered stale after this
  onStale:         null,     // callback() fired once when stale detected
  onRecover:       null,     // callback() fired once when data resumes
  label:           'Price feed',
};

class StaleDataMonitor {
  constructor (opts = {}) {
    this.cfg         = { ...STALE_DEFAULTS, ...opts };
    this.lastPingMs  = Date.now();   // initialise to now so we don't fire immediately
    this._wasStale   = false;
    this.pingCount   = 0;
    this.staleCount  = 0;            // how many times stale was detected
    this.lastStaleAt = null;
    this.lastRecoverAt = null;
  }

  // Call after every successful price update / API response
  ping () {
    this.lastPingMs = Date.now();
    this.pingCount++;

    if (this._wasStale) {
      this._wasStale     = false;
      this.lastRecoverAt = new Date().toISOString();
      console.log(`[ExchangeRisk] ${this.cfg.label} recovered after ${this.staleCount} stale detections`);
      if (typeof this.cfg.onRecover === 'function') this.cfg.onRecover();
    }
  }

  // Returns true if data is considered stale (no ping within maxAgeMs)
  isStale () {
    const ageMs = Date.now() - this.lastPingMs;
    const stale = ageMs > this.cfg.maxAgeMs;

    if (stale && !this._wasStale) {
      this._wasStale   = true;
      this.staleCount++;
      this.lastStaleAt = new Date().toISOString();
      console.warn(`[ExchangeRisk] ⚠️  ${this.cfg.label} stale — no update for ${(ageMs / 1000).toFixed(0)}s (max ${this.cfg.maxAgeMs / 1000}s)`);
      if (typeof this.cfg.onStale === 'function') this.cfg.onStale(ageMs);
    }

    return stale;
  }

  // How long since last ping (ms)
  ageMs () { return Date.now() - this.lastPingMs; }

  status () {
    return {
      isStale:       this.isStale(),
      ageMs:         this.ageMs(),
      maxAgeMs:      this.cfg.maxAgeMs,
      pingCount:     this.pingCount,
      staleCount:    this.staleCount,
      lastStaleAt:   this.lastStaleAt,
      lastRecoverAt: this.lastRecoverAt,
    };
  }
}

// ── DeadMansSwitch ────────────────────────────────────────────────────────────

const DMS_DEFAULTS = {
  timeoutMs:       90_000,   // 90s — if no heartbeat in this window → fire onDead
  checkIntervalMs: 15_000,   // check every 15s
  onDead:          null,     // callback() fired when loop appears crashed
  onRecover:       null,     // callback() fired when heartbeats resume
  label:           'Main trading loop',
};

class DeadMansSwitch {
  constructor (opts = {}) {
    this.cfg           = { ...DMS_DEFAULTS, ...opts };
    this.lastHeartbeat = Date.now();
    this._timer        = null;
    this._isDead       = false;
    this.heartbeatCount = 0;
    this.deadCount      = 0;
  }

  // Call on every main loop iteration
  heartbeat () {
    this.lastHeartbeat = Date.now();
    this.heartbeatCount++;

    if (this._isDead) {
      this._isDead = false;
      console.log(`[ExchangeRisk] ${this.cfg.label} recovered — heartbeat resumed`);
      if (typeof this.cfg.onRecover === 'function') this.cfg.onRecover();
    }
  }

  // Start the background watchdog timer
  start () {
    if (this._timer) return;
    this._timer = setInterval(() => this._check(), this.cfg.checkIntervalMs);
    if (this._timer.unref) this._timer.unref();   // don't prevent process exit
    console.log(`[ExchangeRisk] Dead man's switch armed — timeout ${this.cfg.timeoutMs / 1000}s`);
  }

  // Stop the watchdog (call on clean shutdown)
  stop () {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    console.log(`[ExchangeRisk] Dead man's switch disarmed`);
  }

  _check () {
    const silenceMs = Date.now() - this.lastHeartbeat;
    if (silenceMs > this.cfg.timeoutMs && !this._isDead) {
      this._isDead = true;
      this.deadCount++;
      console.error(
        `[ExchangeRisk] 🚨 ${this.cfg.label} silent for ${(silenceMs / 1000).toFixed(0)}s ` +
        `(timeout ${this.cfg.timeoutMs / 1000}s) — possible crash`
      );
      if (typeof this.cfg.onDead === 'function') this.cfg.onDead(silenceMs);
    }
  }

  isDead ()  { return this._isDead; }
  isAlive () { return !this._isDead && (Date.now() - this.lastHeartbeat) <= this.cfg.timeoutMs; }

  silenceMs () { return Date.now() - this.lastHeartbeat; }

  status () {
    return {
      alive:          this.isAlive(),
      isDead:         this._isDead,
      silenceMs:      this.silenceMs(),
      timeoutMs:      this.cfg.timeoutMs,
      heartbeatCount: this.heartbeatCount,
      deadCount:      this.deadCount,
    };
  }
}

// ── FallbackChain ─────────────────────────────────────────────────────────────
// Tries a list of async data sources in order, returning the first that succeeds.
// Each source is { label, fn } where fn() returns data or throws on failure.
// On total failure (all sources exhausted), calls fallbackFn() if provided.

async function fallbackChain (sources, fallbackFn = null, label = 'data fetch') {
  const errors = [];

  for (const { label: srcLabel, fn } of sources) {
    try {
      const result = await fn();
      if (result !== null && result !== undefined) {
        return { result, source: srcLabel, errors };
      }
      errors.push({ source: srcLabel, error: 'returned null/undefined' });
    } catch (err) {
      errors.push({ source: srcLabel, error: err.message });
      console.warn(`[ExchangeRisk] ${label}: ${srcLabel} failed — ${err.message}`);
    }
  }

  // All sources failed — use fallback if provided
  if (typeof fallbackFn === 'function') {
    console.warn(`[ExchangeRisk] ${label}: all sources failed — using fallback`);
    const result = await fallbackFn();
    return { result, source: 'fallback', errors };
  }

  const errSummary = errors.map(e => `${e.source}: ${e.error}`).join(' | ');
  throw new Error(`${label}: all sources exhausted — ${errSummary}`);
}

module.exports = {
  withRetry,
  checkHttpStatus,
  StaleDataMonitor,
  DeadMansSwitch,
  fallbackChain,
  HttpError,
};
