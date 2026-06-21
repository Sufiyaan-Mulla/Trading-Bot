'use strict';
// ── Rate Limit Backoff ────────────────────────────────────────────────────────
// Wraps any async API call with exponential backoff on 429 / rate-limit errors.
// Integrates into exchange-interface.js and any other API caller.

const { TRADING_CONFIG } = require('./trading-config');

const isRateLimitError = (err, response) => {
  if (err) {
    const msg = (err.message || '').toLowerCase();
    return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests');
  }
  if (response) {
    // FIX: _rawFetch returns parsed JSON body, not HTTP Response. response.status
    // is always undefined on JSON body — check errorCode fields instead.
    // Also handle case where response is an HTTP Response object (fetch API).
    if (typeof response.status === 'number' && response.status === 429) return true;
    const code = (response.errorCode || response.code || '').toUpperCase();
    const msg  = (response.errorMessage || response.message || '').toLowerCase();
    return code.includes('RATE') || code.includes('TOO_MANY') ||
           msg.includes('rate limit') || msg.includes('too many');
  }
  return false;
};

class RateLimitBackoff {
  constructor({ log = console.log } = {}) {
    this.log        = log;
    this._enabled   = TRADING_CONFIG.rateLimitBackoffEnabled !== false;
    this._baseDelay = TRADING_CONFIG.rateLimitBaseDelayMs  || 1000;
    this._maxDelay  = TRADING_CONFIG.rateLimitMaxDelayMs   || 60000;
    this._maxRetry  = TRADING_CONFIG.rateLimitMaxRetries   || 5;
    this._hitCount  = 0;
  }

  /**
   * Execute fn with exponential backoff on rate-limit errors.
   * @param {string}   label  – for logging
   * @param {Function} fn     – async function to call
   * @returns result of fn()
   */
  async execute(label, fn) {
    if (!this._enabled) return fn();

    let delay = this._baseDelay;
    for (let attempt = 0; attempt <= this._maxRetry; attempt++) {
      try {
        const result = await fn();

        // Some APIs return 429 as a JSON body rather than throwing
        if (isRateLimitError(null, result)) {
          throw Object.assign(new Error('Rate limited'), { isRateLimit: true, response: result });
        }
        return result;

      } catch (err) {
        if (!isRateLimitError(err) || attempt >= this._maxRetry) throw err;

        this._hitCount++;
        const jitter  = Math.random() * delay * 0.2;
        const wait    = Math.min(delay + jitter, this._maxDelay);
        this.log(`⏳ [RateLimit] ${label} rate-limited — waiting ${Math.round(wait)}ms (attempt ${attempt + 1}/${this._maxRetry})`);
        await new Promise(r => setTimeout(r, wait));
        delay = Math.min(delay * 2, this._maxDelay);   // exponential backoff
      }
    }
  }

  get totalHits() { return this._hitCount; }
}

module.exports = { RateLimitBackoff };
