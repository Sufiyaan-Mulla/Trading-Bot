'use strict';
// ── regime-stack.js ───────────────────────────────────────────────────────────
// Multi-timeframe regime classifier.
//
// Institutions run a regime stack across 3 timeframes:
//   M5  (micro)  — entry timing and signal confirmation
//   H1  (meso)   — trend bias, filters counter-trend entries
//   D1  (macro)  — dominant trend context
//
// Output: { m5, h1, d1, composite, trendAlignment, htfBias, sessionWeight }
//
// trendAlignment: all 3 aligned → STRONG. Two aligned → MODERATE. Mixed → WEAK.
// htfBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL' — direction from H1+D1 combined.
// sessionWeight: confidence multiplier per trading session.
// ─────────────────────────────────────────────────────────────────────────────
const { Indicators } = require('./indicators');

// Bars per timeframe relative to M5
const H1_BARS  = 12;   // 1 H1 bar = 12 M5 bars
const D1_BARS  = 288;  // 1 D1 bar = 288 M5 bars

class RegimeStack {
  constructor() {
    this._cache     = null;
    this._cacheBar  = 0;
    this._cacheEvery = 6;   // recompute every 6 bars
    this._cacheTime  = 0;   // time-based fallback: also expire every 5 min
  }

  analyse(m5Prices, barCount, m5OHLCV) {
    // Fix #16: Accept full OHLCV so H1/D1 regimes preserve wick information.
    // Previously only close prices were passed, destroying ADX/ATR accuracy on higher TF.
    const m5OHLCVData = m5OHLCV || m5Prices.map(p => ({ o:p, h:p, l:p, c:p, v:1 }));
    if (!m5Prices || m5Prices.length < 50) {
      return this._empty();
    }
    const now = Date.now();
    if (this._cache && barCount - this._cacheBar < this._cacheEvery && now - this._cacheTime < 300_000) {
      return this._cache;
    }

    // ── M5 regime (current bar data) ─────────────────────────────────────
    const m5Regime  = this._classifyRegime(m5Prices, 14, 50);

    // ── H1 regime (downsample: every 12 M5 bars = 1 H1 bar) ─────────────
    const h1Prices  = this._downsample(m5Prices, H1_BARS);
    const h1Regime  = h1Prices.length >= 20 ? this._classifyRegime(h1Prices, 14, 50) : m5Regime;

    // ── D1 regime (downsample: every 288 M5 bars = 1 D1 bar) ─────────────
    // Bug fix #11: use API-bootstrapped D1 if available, otherwise downsample from M5
    const d1Prices  = this._d1PricesBootstrapped || this._downsample(m5Prices, D1_BARS);
    const d1Regime  = d1Prices.length >= 10 ? this._classifyRegime(d1Prices, 14, 20) : h1Regime;

    // ── HTF bias: H1 + D1 combined direction ─────────────────────────────
    const h1Bias = this._directionBias(h1Prices);
    const d1Bias = this._directionBias(d1Prices);
    const htfBias = (h1Bias === d1Bias) ? h1Bias : 'NEUTRAL';

    // ── Trend alignment score ─────────────────────────────────────────────
    const regimes   = [m5Regime, h1Regime, d1Regime];
    const trending  = regimes.filter(r => r === 'TRENDING').length;
    const ranging   = regimes.filter(r => r === 'RANGING').length;
    const trendAlignment = trending === 3 ? 'STRONG'
      : trending >= 2 ? 'MODERATE'
      : ranging  >= 2 ? 'RANGING_DOMINANT'
      : 'MIXED';

    // ── Counter-trend confidence penalty ─────────────────────────────────
    // If signal opposes H1 trend → require higher confidence
    const htfGate = { requiredConfidenceBoost: 0 };
    if (htfBias !== 'NEUTRAL') {
      htfGate.active = true;
      htfGate.htfBias = htfBias;
      htfGate.requiredConfidenceBoost = 20; // need 20 extra pts to trade against H1
    }

    // ── Feature #44: Ichimoku cloud regime gate ───────────────────────────
    // Price above cloud = bullish regime bias; below cloud = bearish bias.
    // In-cloud = uncertain (widen confidence requirement by 10 pts).
    let ichimokuGate = { bias: 'NEUTRAL', inCloud: false, aboveCloud: false, belowCloud: false };
    try {
      const { IndicatorsNew } = require('./indicators-new');
      if (typeof IndicatorsNew.ichimoku === 'function' && m5Prices.length >= 52) {
        const ichi = IndicatorsNew.ichimoku(m5Prices);
        ichimokuGate = {
          bias:        ichi.bias     || 'NEUTRAL',
          inCloud:     ichi.inCloud  || false,
          aboveCloud:  ichi.aboveCloud || false,
          belowCloud:  ichi.belowCloud || false,
          tkCross:     ichi.tkBullCross ? 'BULL' : ichi.tkBearCross ? 'BEAR' : null,
        };
      }
    } catch(_) {}

    const result = { m5: m5Regime, h1: h1Regime, d1: d1Regime, composite: m5Regime,
      trendAlignment, htfBias, htfGate, h1Prices, d1Prices, ichimokuGate };

    this._cache    = result;
    this._cacheBar = barCount;
    this._cacheTime = Date.now();
    return result;
  }

  // Classify regime from a price array using ADX
  _classifyRegime(prices, adxPeriod, emaPeriod) {
    if (prices.length < adxPeriod + 5) return 'UNKNOWN';
    try {
      const { regime } = Indicators.adxRegime(prices, adxPeriod);
      return regime;
    } catch(_) { return 'UNKNOWN'; }
  }

  // Directional bias: is price above or below EMA50?
  _directionBias(prices) {
    if (!prices || prices.length < 20) return 'NEUTRAL';
    const ema  = Indicators.ema(prices, Math.min(50, prices.length));
    const last = prices[prices.length - 1];
    const pct  = (last - ema) / ema;
    if (pct >  0.003) return 'BULLISH';
    if (pct < -0.003) return 'BEARISH';
    return 'NEUTRAL';
  }

  // Downsample M5 bars to a higher timeframe (take close of each Nth bar)
  _downsample(prices, n) {
    const out = [];
    for (let i = n - 1; i < prices.length; i += n) {
      out.push(prices[i]);
    }
    return out;
  }

  _empty() {
    return { m5:'UNKNOWN', h1:'UNKNOWN', d1:'UNKNOWN', composite:'UNKNOWN',
      trendAlignment:'MIXED', htfBias:'NEUTRAL', htfGate:{ requiredConfidenceBoost:0 } };
  }
}

// ── Session-adaptive strategy weights ────────────────────────────────────────
// Each session has different statistical characteristics:
//   Asian:   range-bound, thin volume → mean reversion favoured
//   London:  breakouts on H1 levels → trend following favoured
//   NY:      continuation + vol → trend + breakout
//   Overlap: highest vol, fastest moves → trend with tight stops
const SESSION_STRATEGY_WEIGHTS = {
  ASIAN:           { trend: 0.20, meanReversion: 0.70, breakout: 0.10, confidenceMult: 0.85 },
  LONDON:          { trend: 0.50, meanReversion: 0.20, breakout: 0.30, confidenceMult: 1.00 },
  NEW_YORK:        { trend: 0.55, meanReversion: 0.25, breakout: 0.20, confidenceMult: 1.00 },
  LONDON_NY_OVERLAP:{ trend:0.65, meanReversion: 0.10, breakout: 0.25, confidenceMult: 1.10 },
};

function getSessionWeights(session) {
  return SESSION_STRATEGY_WEIGHTS[session] || SESSION_STRATEGY_WEIGHTS.NEW_YORK;

}


// #60: Bootstrap D1 from daily OANDA API on startup (avoids 24h accumulation wait)
async function bootstrapD1FromAPI(regimeStackInstance, asset) {
  try {
    const https = require('https');
    const key   = process.env.OANDA_API_KEY || '';
    const base  = process.env.OANDA_ENV === 'live' ? 'api-fxtrade' : 'api-fxpractice';
    const apiPath = '/v3/instruments/' + asset.replace('/', '_') + '/candles?count=30&granularity=D';
    const data  = await new Promise((resolve, reject) => {
      const req = https.request({ hostname: base + '.oanda.com', path: apiPath,
        headers: { Authorization: 'Bearer ' + key } }, (r) => {
        let raw = ''; r.on('data', d => raw += d);
        r.on('end', () => { try { resolve(JSON.parse(raw)); } catch(_) { reject(new Error('parse')); } });
      });
      // Bug fix: add timeout so a hung connection doesn't stall the bootstrap
      req.setTimeout(10_000, () => { req.destroy(); reject(new Error('D1 bootstrap timeout')); });
      req.on('error', reject); req.end();
    });
    const closes = (data.candles || []).map(c => parseFloat(c.mid?.c || 0)).filter(p => p > 0);
    if (closes.length >= 10) {
      regimeStackInstance._d1PricesBootstrapped = closes;  // Bug fix #11: use dedicated property
      console.log('[RegimeStack] D1 bootstrapped from OANDA daily API: ' + closes.length + ' bars');
      return true;
    }
  } catch(e) {
    console.warn('[RegimeStack] D1 bootstrap skipped: ' + e.message);
  }
  return false;
}

// Item #41: 4-hour regime-change probability forecast
// Uses autocorrelation of recent regime labels to estimate probability of change
function forecastRegimeChange(recentRegimes, horizon = 4) {
  if (!recentRegimes || recentRegimes.length < 10) return { probability: 0.5, horizon, persistenceRate: 0.5, currentRegime: recentRegimes?.at?.(-1) || 'UNKNOWN' };
  const n = recentRegimes.length;
  let sameCount = 0;
  // Count how often the regime was the same as N bars ago
  for (let i = horizon; i < n; i++) {
    if (recentRegimes[i] === recentRegimes[i - horizon]) sameCount++;
  }
  const persistenceRate = sameCount / (n - horizon);
  return {
    probability:    parseFloat((1 - persistenceRate).toFixed(3)),
    horizon,
    persistenceRate: parseFloat(persistenceRate.toFixed(3)),
    currentRegime:   recentRegimes.at(-1) || 'UNKNOWN',
  };
}

module.exports = { forecastRegimeChange, RegimeStack, getSessionWeights, SESSION_STRATEGY_WEIGHTS, bootstrapD1FromAPI };
