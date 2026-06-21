'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  strategies/index.js
//  Exports all strategies + StrategyManager
//
//  StrategyManager selects and runs the appropriate strategy based on
//  current market regime. In TRENDING markets it uses TrendStrategy;
//  in RANGING/WEAK_TREND it uses MeanReversionStrategy.
//  Regime-based auto-selection can be overridden by setting a fixed strategy.
// ═══════════════════════════════════════════════════════════════════════════════

const { BaseStrategy }          = require('./baseStrategy');
const { TrendStrategy }         = require('./trendStrategy');
const { MeanReversionStrategy } = require('./meanReversion');
const BreakoutStrategy          = require('./breakoutStrategy');
const { getSessionWeights }     = require('../regime-stack');
const { LondonOpenStrategy }        = require('./londonOpenStrategy');
const { TokyoOpenStrategy }         = require('./tokyoOpenStrategy');  // Item #6
const { loadLearnedConfig }         = require('../strategy-learner');

// ── Strategy selection map ────────────────────────────────────────────────────
// #21: LondonOpenStrategy registered — active 07:00-09:30 UTC regardless of regime
const REGIME_STRATEGY_MAP = {
  ASIAN_OPEN: 'tokyoOpen',  // Item #6: route Asian-session ticks to Tokyo strategy
  TRENDING:   'trend',
  WEAK_TREND: 'meanReversion',   // trend filters too aggressive in weak trends
  RANGING:    'meanReversion',
  BEAR:       'trend',           // trend strategy handles bear (exit-only mode)
  UNKNOWN:    'trend',
};

class StrategyManager {
  constructor (opts = {}) {
    // Fix #95: Per-strategy minBars warm-up tracking
    const _cfg95 = require('../trading-config').TRADING_CONFIG;
    this._strategyMinBars = {
      trend:         _cfg95.trendMinBars         || 50,
      meanReversion: _cfg95.mrMinBars            || 35,
      breakout:      _cfg95.breakoutMinBars      || 50,
      londonOpen:    _cfg95.londonOpenMinBars    || 50,
      tokyoOpen:     _cfg95.tokyoOpenMinBars     || 50,
    };
    this.strategies = {
      trend:         new TrendStrategy(opts.trend         || {}),
      meanReversion: new MeanReversionStrategy(opts.meanReversion || {}),
      breakout:      new BreakoutStrategy(opts.breakout    || {}),
      londonOpen:    new LondonOpenStrategy(opts.londonOpen || {}),
      tokyoOpen:     new TokyoOpenStrategy(opts.tokyoOpen  || {}),  // Item #6
    };
    this.override       = opts.override || null;   // force a specific strategy by name
    this.lastUsed       = null;
    this._learnedConfig = undefined;  // undefined = not loaded yet; null = loaded but absent
    // Bug fix #9: instantiate _heatmap for TimeHeatmap session scoring
    try {
      const { PerformanceAnalytics } = require('../performance-analytics');
      const pa = new PerformanceAnalytics();
      this._heatmap = pa.timeHeatmap || null;
    } catch(_) { this._heatmap = null; }
  }

  // ── Select and run strategy for current indicators ────────────────────────
  decide (indicators, context = {}) {
    // Feature #77: Cache decide() result for same regime+session — skip full recompute
    // Cache is keyed on regime+session+override; invalidated every 3 bars.
    const cacheKey = `${indicators.adxRegime}|${context.session}|${this.override}`;
    this._decideCacheTick = (this._decideCacheTick || 0) + 1;
    if (this._decideCache && this._decideCacheKey === cacheKey &&
        this._decideCacheTick - this._decideCacheBar < 3 &&
        this._decideCache.action === 'HOLD') {
      // Only cache HOLD results — action decisions must always be fresh
      return { ...this._decideCache, _cached: true };
    }

    const regime   = indicators.adxRegime || indicators.marketRegime || 'UNKNOWN';
    const session  = context.session || 'NEW_YORK';

    // ── Session-adaptive routing (#3) ────────────────────────────────────
    // Each session has different statistical characteristics — use session weights
    // to score each strategy and pick the best fit.
    if (!this.override) {
      const weights = getSessionWeights(session);
      const volRatio = indicators.volRatio || 1;

      // BUG-74 fix: session weights alone must NOT override regime — RANGING must always
      // prefer MeanReversion over Trend. Apply regime as a hard multiplier, not an additive bonus.
      // Use regime to scale each strategy's base weight, then add session context on top.
      const regimeMultipliers = {
        trend:         { TRENDING: 1.5, WEAK_TREND: 0.8, RANGING: 0.4, UNKNOWN: 1.0 },
        meanReversion: { TRENDING: 0.4, WEAK_TREND: 1.2, RANGING: 1.6, UNKNOWN: 1.0 },
        breakout:      { TRENDING: 1.3, WEAK_TREND: 0.9, RANGING: 0.3, UNKNOWN: 0.8 },
      };
      const rm = regime in { TRENDING:1, WEAK_TREND:1, RANGING:1 } ? regime : 'UNKNOWN';

      // Apply learned regime multipliers from last backtest analysis (if available).
      // _learnedConfig is lazily loaded once, then reset to undefined by backtest-engine
      // when a new backtest completes so it is reloaded with fresh values.
      if (this._learnedConfig === undefined) this._learnedConfig = loadLearnedConfig();
      if (this._learnedConfig?.regimeMultiplierAdjustments) {
        const lrm = this._learnedConfig.regimeMultiplierAdjustments;
        for (const key of Object.keys(regimeMultipliers)) {
          if (lrm[key]) Object.assign(regimeMultipliers[key], lrm[key]);
        }
      }

      const breakoutScore = weights.breakout * (regimeMultipliers.breakout[rm] || 1)
        + (volRatio > 1.5 ? 0.15 : 0);
      const trendScore    = weights.trend * (regimeMultipliers.trend[rm] || 1)
        + ((indicators.regimeStack?.trendAlignment === 'STRONG') ? 0.10 : 0);
      const mrScore       = weights.meanReversion * (regimeMultipliers.meanReversion[rm] || 1)
        + (volRatio > 1.5 ? -0.10 : 0);

      const scores = { trend: trendScore, meanReversion: mrScore, breakout: breakoutScore };
      const best = Object.entries(scores).reduce((a,b) => b[1]>a[1]?b:a)[0];
      this.lastUsed = best;

      const result = this.strategies[best].decide(indicators, context);
      result.strategy = best;
      result.regime   = regime;
      result.sessionWeights = weights;
      // BUG-26 fix: apply session confidence multiplier (e.g. Asian=0.85, Overlap=1.10)
      // BUG-17 fix: SKIP the multiplier for exit signals (SELL/BUY from an open position).
      // Exits are hard safety actions — they must not be weakened by session timing.
      const isExit = context.hasPosition && result.action !== 'HOLD';
      const applyMult = !isExit && weights.confidenceMult && weights.confidenceMult !== 1.0;
      if (applyMult) {
        result.confidence = Math.round(Math.min(95, result.confidence * weights.confidenceMult));
        result.reasoning  = (result.reasoning || '') + ` | session×${weights.confidenceMult}`;
      }
      return result;
    }

    // Manual override
    // #61: Adjust confidence based on TimeHeatmap historical session performance
    let heatmapAdjust = 0;
    try {
      if (this._heatmap) {
        const utcH = new Date().getUTCHours();
        const sessionScore = this._heatmap.getHourScore?.(utcH);
        if (sessionScore != null && sessionScore < 0.5) heatmapAdjust = -10;  // penalise poor session
        if (sessionScore != null && sessionScore > 0.8) heatmapAdjust = +5;   // boost strong session
      }
    } catch(_) {}
    const stratKey = this.override || REGIME_STRATEGY_MAP[regime] || 'trend';
    const strategy = this.strategies[stratKey];
    if (!strategy) return { action: 'HOLD', confidence: 0, reasoning: 'Unknown strategy: ' + stratKey };
    this.lastUsed = stratKey;
    const result  = strategy.decide(indicators, context);
    result.strategy = stratKey;
    result.regime   = regime;
    // #61 Bug fix: apply heatmapAdjust to confidence (was computed but never used)
    if (heatmapAdjust !== 0 && result.action !== 'HOLD') {
      result.confidence = Math.max(0, Math.min(95, (result.confidence || 0) + heatmapAdjust));
      result._heatmapAdjust = heatmapAdjust;
    }
    // Feature #77: Store HOLD results in cache
    if (result.action === 'HOLD') {
      this._decideCache    = result;
      this._decideCacheKey = cacheKey;
      this._decideCacheBar = this._decideCacheTick;
    }
    return result;
  }

  // ── Register a custom strategy ────────────────────────────────────────────
  register (name, strategyInstance) {
    if (!(strategyInstance instanceof BaseStrategy)) {
      throw new Error('Strategy must extend BaseStrategy');
    }
    this.strategies[name] = strategyInstance;
    return this;
  }

  // ── Force a specific strategy regardless of regime ────────────────────────
  setOverride (name) {
    if (name && !this.strategies[name]) throw new Error(`Unknown strategy: ${name}`);
    this.override = name || null;
    return this;
  }

  // ── Feature #48: Graceful strategy hot-swap (no restart required) ─────────
  // Sets a pending override that activates when no position is open,
  // preventing mid-trade strategy switches that could produce conflicting exits.
  hotSwap(name, engine = null) {
    if (name && !this.strategies[name]) throw new Error(`Unknown strategy for hot-swap: ${name}`);
    if (engine && engine.position) {
      // Defer: apply once the current position closes
      this._pendingSwap = name || null;
      const logFn = engine.log ? engine.log.bind(engine) : console.log;
      logFn(`[HotSwap] Strategy swap to "${name}" deferred until current position closes`);
      // Listen for position close
      const checkAndApply = () => {
        if (!engine.position && this._pendingSwap !== undefined) {
          this.override = this._pendingSwap;
          this._pendingSwap = undefined;
          logFn(`[HotSwap] Strategy switched to "${this.override || 'auto'}" (position closed)`);
          try { require('../telegram').send(`[HotSwap] Active strategy → ${this.override || 'auto (regime-based)'}`, 'status'); } catch(_) {}
          clearInterval(this._swapPoller);
        }
      };
      this._swapPoller = setInterval(checkAndApply, 5000).unref();
      return this;
    }
    // No open position — apply immediately
    this.override = name || null;
    if (engine?.log) engine.log(`[HotSwap] Strategy switched immediately to "${name || 'auto'}"`);
    return this;
  }

  getStats () {
    return {
      lastUsed:   this.lastUsed,
      override:   this.override,
      strategies: Object.fromEntries(
        Object.entries(this.strategies).map(([k, v]) => [k, v.toJSON()])
      ),
    };
  }
}

module.exports = {
  BaseStrategy,
  TrendStrategy,
  MeanReversionStrategy,
  StrategyManager,
  REGIME_STRATEGY_MAP,
};
