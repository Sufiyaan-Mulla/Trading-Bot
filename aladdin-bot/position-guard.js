'use strict';
// ── Position Guard ────────────────────────────────────────────────────────────
// Two complementary entry guards:
//
// 1. MaxOpenPositions — hard cap on simultaneous open trades.
//    Prevents over-leveraging when multiple signals fire at once.
//
// 2. CorrelationLock — blocks entry in the same direction when a highly
//    correlated pair is already open. Stops doubling USD/EUR/GBP exposure
//    by accident.

const { TRADING_CONFIG } = require('./trading-config');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract currencies from a pair string, e.g. 'EURUSD' → ['EUR','USD'] */
function parsePairCurrencies(pair) {
  if (!pair || pair.length < 6) return [];
  return [pair.slice(0, 3).toUpperCase(), pair.slice(3, 6).toUpperCase()];
}

/** Returns shared currencies between two pairs */
function sharedCurrencies(pairA, pairB) {
  const a = parsePairCurrencies(pairA);
  const b = parsePairCurrencies(pairB);
  return a.filter(c => b.includes(c));
}

/** 
 * Returns whether two trades share a currency AND are in the same effective
 * USD-denominated direction (would amplify each other's exposure).
 */
function sameDirectionRisk(pairA, sideA, pairB, sideB) {
  const shared = sharedCurrencies(pairA, pairB);
  if (!shared.length) return false;

  const [baseA, quoteA] = parsePairCurrencies(pairA);
  const [baseB, quoteB] = parsePairCurrencies(pairB);

  for (const ccy of shared) {
    // Determine effective direction toward the shared currency for each pair
    // Going LONG a pair = buying base, selling quote
    // Going SHORT a pair = selling base, buying quote
    // We compute "position on shared currency":
    //   if ccy is BASE of pair: LONG pair = LONG ccy, SHORT pair = SHORT ccy
    //   if ccy is QUOTE of pair: LONG pair = SHORT ccy, SHORT pair = LONG ccy
    const dirA = (ccy === baseA)
      ? (sideA === 'long' ? 'long' : 'short')
      : (sideA === 'long' ? 'short' : 'long');   // ccy is quoteA

    const dirB = (ccy === baseB)
      ? (sideB === 'long' ? 'long' : 'short')
      : (sideB === 'long' ? 'short' : 'long');   // ccy is quoteB

    // Same net direction on shared currency = amplifying (correlated risk)
    if (dirA === dirB) return true;
  }
  return false;
}

// ── MaxOpenPositions ──────────────────────────────────────────────────────────

class MaxOpenPositionsGuard {
  constructor({ log = console.log } = {}) {
    this.log  = log;
    this._max = TRADING_CONFIG.maxOpenPositions || 3;
  }

  /**
   * @param {object} openPositions  map of { pair: positionObject }
   * @param {string} incomingPair   pair being evaluated for entry
   * @returns {{ allowed: boolean, reason?: string }}
   */
  check(openPositions, incomingPair) {
    const count = Object.keys(openPositions || {}).length;
    const _max  = TRADING_CONFIG.maxOpenPositions || this._max;  // FIX: live config read
    if (count >= _max) {
      const reason = `MaxOpenPositions: ${count}/${_max} trades already open — entry on ${incomingPair} blocked`;
      this.log(`🛑 [PositionGuard] ${reason}`);
      return { allowed: false, reason };
    }
    return { allowed: true };
  }
}

// ── CorrelationLock ───────────────────────────────────────────────────────────

class CorrelationLock {
  constructor({ log = console.log } = {}) {
    this.log      = log;
    this._enabled = TRADING_CONFIG.correlationLockEnabled !== false;
  }

  /**
   * @param {object} openPositions  map of { pair: { side: 'long'|'short', ... } }
   * @param {string} incomingPair   pair being evaluated
   * @param {string} incomingSide   'long' or 'short'
   * @returns {{ allowed: boolean, reason?: string, conflictingPair?: string }}
   */
  check(openPositions, incomingPair, incomingSide) {
    if (!this._enabled) return { allowed: true };

    for (const [existingPair, position] of Object.entries(openPositions || {})) {
      if (existingPair === incomingPair) continue;  // same pair handled elsewhere

      const existingSide = position?.side || position?.type || 'long';

      if (sameDirectionRisk(incomingPair, incomingSide, existingPair, existingSide)) {
        const reason = `CorrelationLock: ${incomingPair} ${incomingSide} conflicts with open ${existingPair} ${existingSide} — same currency exposure`;
        this.log(`🛑 [CorrelationLock] ${reason}`);
        return { allowed: false, reason, conflictingPair: existingPair };
      }
    }
    return { allowed: true };
  }
}

// ── Anti-Martingale Enforcement ────────────────────────────────────────────────

class AntiMartingaleGuard {
  constructor({ log = console.log } = {}) {
    this.log      = log;
    this._enabled = TRADING_CONFIG.antiMartingaleEnabled !== false;
    this._maxMult = TRADING_CONFIG.antiMartingaleMaxMultiplier || 1.0;
  }

  /**
   * Ensure position size doesn't increase after losses.
   * @param {number} proposedSize  position size being considered
   * @param {number} baselineSize  standard / initial position size
   * @param {number} consecutiveLosses  number of losses in a row
   * @returns {{ size: number, capped: boolean }}
   */
  enforce(proposedSize, baselineSize, consecutiveLosses) {
    const _enabled  = TRADING_CONFIG.antiMartingaleEnabled !== false;  // FIX: live config
    const _maxMult  = TRADING_CONFIG.antiMartingaleMaxMultiplier || this._maxMult;
    if (!_enabled || consecutiveLosses === 0) {
      return { size: proposedSize, capped: false };
    }

    const maxAllowed = baselineSize * _maxMult;
    if (proposedSize > maxAllowed) {
      this.log(
        `🛡️ [AntiMartingale] Proposed size ${proposedSize.toFixed(2)} > max ${maxAllowed.toFixed(2)} ` +
        `after ${consecutiveLosses} consecutive losses — capped to ${maxAllowed.toFixed(2)}`
      );
      return { size: maxAllowed, capped: true };
    }
    return { size: proposedSize, capped: false };
  }
}

// ── Slippage Budget Guard ─────────────────────────────────────────────────────

class SlippageBudgetGuard {
  constructor({ log = console.log } = {}) {
    this.log      = log;
    this._enabled = TRADING_CONFIG.slippageBudgetEnabled !== false;
    this._maxPips = TRADING_CONFIG.maxSlippagePips || 3.0;
  }

  /**
   * Check if fill price is within acceptable slippage of intended price.
   * @param {string} pair        – 'EURUSD', used to determine pip size
   * @param {number} intended    – price at which we wanted to enter
   * @param {number} filled      – price at which broker filled us
   * @param {string} side        – 'long' or 'short'
   * @returns {{ withinBudget: boolean, slippagePips: number }}
   */
  check(pair, intended, filled, side) {
    const _enabled = TRADING_CONFIG.slippageBudgetEnabled !== false;  // FIX: live config
    const _maxPips = TRADING_CONFIG.maxSlippagePips || this._maxPips;
    if (!_enabled) return { withinBudget: true, slippagePips: 0 };

    // Pip size: JPY pairs = 0.01, everything else = 0.0001
    const pipSize = (pair && pair.includes('JPY')) ? 0.01 : 0.0001;
    const priceDiff = side === 'long'
      ? filled - intended   // long: bad slippage = filled higher than intended
      : intended - filled;  // short: bad slippage = filled lower than intended

    const slippagePips = priceDiff / pipSize;
    const withinBudget = slippagePips <= _maxPips;

    if (!withinBudget) {
      this.log(
        `⚠️ [SlippageBudget] ${pair} ${side}: intended=${intended} filled=${filled} ` +
        `slippage=${slippagePips.toFixed(1)} pips > max=${this._maxPips} pips`
      );
    }
    return { withinBudget, slippagePips: parseFloat(slippagePips.toFixed(2)) };
  }
}

// ── Requote Detector ──────────────────────────────────────────────────────────

class RequoteDetector {
  constructor({ log = console.log } = {}) {
    this.log       = log;
    this._enabled  = TRADING_CONFIG.requoteRetryEnabled !== false;
    this._maxRetry = TRADING_CONFIG.requoteMaxRetries  || 3;
    this._delay    = TRADING_CONFIG.requoteRetryDelayMs || 500;
    this._requoteCount = 0;
  }

  /**
   * Check if OANDA response indicates a requote / price rejection.
   * @param {object} response  raw broker API response
   * @returns {boolean}
   */
  isRequote(response) {
    if (!response) return false;
    const code = response.errorCode || response.code || '';
    const msg  = (response.errorMessage || response.message || '').toLowerCase();
    return (
      code === 'PRICE_INVALID'       ||
      code === 'REQUOTE'             ||
      code === 'MARKET_PRICE_HALTED' ||
      msg.includes('requote')        ||
      msg.includes('price has moved') ||
      msg.includes('market closed')
    );
  }

  /**
   * Execute fn with automatic requote retry.
   * @param {Function} fn  async function returning broker response
   * @returns broker response
   */
  async withRetry(fn) {
    if (!this._enabled) return fn();

    let lastError;
    for (let attempt = 0; attempt <= this._maxRetry; attempt++) {
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, this._delay * attempt));
        this.log(`🔄 [Requote] Retry attempt ${attempt}/${this._maxRetry}`);
      }
      try {
        const result = await fn();
        if (this.isRequote(result)) {
          this._requoteCount++;
          this.log(`↩️ [Requote] Detected on attempt ${attempt + 1} — ${result.errorCode || result.code}`);
          lastError = result;
          continue;
        }
        return result;
      } catch (err) {
        lastError = err;
        if (attempt < this._maxRetry) continue;
        throw err;
      }
    }
    this.log(`🛑 [Requote] Max retries (${this._maxRetry}) exhausted`);
    return lastError;
  }

  get totalRequotes() { return this._requoteCount; }
}

module.exports = {
  MaxOpenPositionsGuard,
  CorrelationLock,
  AntiMartingaleGuard,
  SlippageBudgetGuard,
  RequoteDetector,
  // expose helpers for testing
  sharedCurrencies,
  sameDirectionRisk,
};
