'use strict';
// ── strategy.js ───────────────────────────────────────────────────────────────
// Strategy mixin methods + re-exports of MultiTimeframeAnalyzer.
//
// Mixin methods (added to TradingEngine.prototype):
//   calculateIndicators  — computes full indicator snapshot each bar
//   getRuleBasedDecision — routes through A/B tester → returns decision
//   getDecision          — ML or rule-based routing
//   buildPerformanceState — 20-trade rolling analysis for AI context
//
// Re-exports:
//   MultiTimeframeAnalyzer

const { TRADING_CONFIG }         = require('./trading-config');
const { SupportResistance }      = require('./support-resistance');
const { safeNormaliseIndicators } = require('./indicator-schema');
const { Indicators }             = require('./indicators');
const { CorrelationEngine }      = require('./correlation-engine');
const { MultiTimeframeAnalyzer } = require('./multi-timeframe');

const engineMethods = {

  async calculateIndicators() {
    this._tickCount = (this._tickCount || 0) + 1;  // drives MACD/ADX/SR cache expiry
    if (!this.priceHistory || this.priceHistory.length < 2) return null;

    // A16: Memoize per bar — calculateIndicators called 3× per tick; cache by bar index
    const _cacheKey16 = (this.priceHistory.length) + '|' + (this.selectedAsset || '');
    if (this._indCache && this._indCacheKey === _cacheKey16) return this._indCache;
    // ── Input validation — reject NaN/Infinity/0 prices before computing ──
    const last5 = this.priceHistory.slice(-5);
    for (const p of last5) {
      if (!isFinite(p) || p <= 0) {
        this.log('[INDICATOR SKIP] Invalid price in history: ' + p + ' — skipping tick');
        return null;
      }
    }

    const rsi   = Indicators.rsi(this.priceHistory);
    const macd  = Indicators.macd(this.priceHistory);
    // MACD cached every 3 ticks — tick-counter never freezes
    if (!this._macdCache || !this._macdCacheTick || this._tickCount - this._macdCacheTick >= 3) {
      this._macdCache     = Indicators.macdFull(this.priceHistory);
      this._macdCacheTick = this._tickCount;
    }
    const macdFull = this._macdCache;
    const ema9  = Indicators.ema(this.priceHistory, 9);
    const ema21 = Indicators.ema(this.priceHistory, 21);
    const ema50 = Indicators.ema(this.priceHistory, 50);
    const ema200= Indicators.ema(this.priceHistory, 200);
    // ADX cached every 5 ticks — tick counter never freezes unlike priceHistory.length
    if (!this._adxCache || !this._adxCacheTick || this._tickCount - this._adxCacheTick >= 5) {
      this._adxCache     = Indicators.adxRegime(this.priceHistory, 14);
      this._adxCacheTick = this._tickCount;
    }
    const { adx, regime: adxRegime } = this._adxCache;

    // Divergence: track RSI history to detect price/momentum divergence
    if (!this._rsiHistory) this._rsiHistory = [];
    this._rsiHistory.push(rsi);
    if (this._rsiHistory.length > 100) this._rsiHistory.shift();
    const divergence = this._rsiHistory.length >= 25
      ? Indicators.divergence(this.priceHistory, this._rsiHistory, 20)
      : { bullish: false, bearish: false, type: 'NONE' };
    const bb    = Indicators.bollingerBands(this.priceHistory);

    // Previous-bar values for slope/velocity calculations in signal()
    const prevSlice = this.priceHistory.slice(0, -1);
    // Bug #28 fix: compute actual previous bar's MACD value from prevSlice
    const prevMacdFull = prevSlice.length >= 26 ? Indicators.macdFull(prevSlice) : null;
    const prevMacd  = prevMacdFull?.macd ?? (macd - (macdFull.histogram || 0));  // fallback to signal line if not enough history
    const prevRsi   = prevSlice.length >= 15 ? Indicators.rsi(prevSlice)  : null;

    const currentPrice0 = this.priceHistory[this.priceHistory.length - 1];
    const volWindow0    = this.volumeHistory.slice(-20);
    const avgVol0       = volWindow0.length ? volWindow0.reduce((s,v)=>s+v,0)/volWindow0.length : 1_000_000;
    const curVol0       = this.volumeHistory[this.volumeHistory.length-1] || avgVol0;
    const volRatio0     = curVol0 / (avgVol0 || 1);

    const signal= Indicators.signal({ rsi, macd, ema9, ema21, ema50, bb,
      price: currentPrice0, vwap: Indicators.vwap(this.priceHistory, this.volumeHistory),
      prevMacd, prevRsi, volRatio: volRatio0 });

    this.lastRSI    = rsi;
    this.lastSignal = signal;
    this.mlConfidence.pushRSI(rsi);

    const atr  = Indicators.atr(this.priceHistory, 14);
    const vwap = Indicators.vwap(this.priceHistory, this.volumeHistory);
    this.lastATR  = atr;
    this.lastVWAP = vwap;

    const currentPrice = this.priceHistory[this.priceHistory.length - 1];
    const atrPercent   = (atr / currentPrice) * 100;
    this.volatilityLevel = atrPercent < 0.5 ? 'LOW' : atrPercent > 1.5 ? 'HIGH' : 'NORMAL';

    const emaDivergence = Math.abs(ema50 - ema200) / currentPrice * 100;
    const marketRegime  = emaDivergence > 0.50 ? 'TRENDING' : emaDivergence > 0.20 ? 'WEAK_TREND' : 'RANGING';
    this.lastMarketRegime = marketRegime;

    const ph = this.priceHistory;
    const ema50Prev  = ph.length > 55 ? Indicators.ema(ph.slice(0, ph.length - 5), 50) : ema50;
    // Bug #63 fix: ema50Steps must be > 0 AND history must be > 55 for a meaningful prev
    const ema50Steps = ph.length > 55 ? Math.min(5, ph.length - 51) : 0;
    const ema50Slope = ema50Steps > 0
      ? (ema50 - ema50Prev) / (currentPrice || 1) * 1000 / ema50Steps
      : 0;
    const goldenCross = ema50 > ema200;
    const deathCross  = ema50 < ema200;

    const volWindow    = this.volumeHistory.slice(-20);
    const avgVolume    = volWindow.length ? volWindow.reduce((s,v) => s+v, 0) / volWindow.length : 1_000_000;
    const currentVol   = this.volumeHistory[this.volumeHistory.length - 1] || avgVolume;
    const volRatio     = currentVol / (avgVolume || 1);
    const liquidMarket = volRatio >= 0.75;

    const utcHour       = new Date().getUTCHours();
    const liquidityResult = this.liquidityScorer.score(this.volumeHistory, this.priceHistory, utcHour);

    const direction     = signal === 'BUY' || signal === 'STRONG_BUY' ? 'BUY' : 'SELL';
    const dynamicLevels = Indicators.getDynamicLevels(currentPrice, atr, vwap, direction);
    const mta           = MultiTimeframeAnalyzer.analyse(this.priceHistory, direction);

    // ── Multi-timeframe regime stack (#1) ─────────────────────────────────
    const regimeStack = this.regimeStack
      ? this.regimeStack.analyse(this.priceHistory, this.priceHistory.length)
      : null;

    // ── Economic calendar (#2) ────────────────────────────────────────────
    const calendarCheck = this.economicCalendar
      ? this.economicCalendar.check(this.selectedAsset)
      : { blocked: false, volatilityExpansion: 1 };

    // ── Currency exposure & global risk (#12, #15) ────────────────────────
    const riskEnv = this.currencyExposure
      ? this.currencyExposure.getRiskEnvironment()
      : { env: 'NEUTRAL', score: 0 };
    this.lastMTA = mta;

    await this.leadingIndicators.update();
    const leadingSignal = this.leadingIndicators.analyse(this.selectedAsset);
    this.lastLeadingSignal = leadingSignal;

    const raw = {
      price: currentPrice,
      rsi: rsi.toFixed(2), macd: macd.toFixed(4),
      ema9: ema9.toFixed(4), ema21: ema21.toFixed(4),
      ema50: ema50.toFixed(4), ema200: ema200.toFixed(4),
      bb: { upper: bb.upper.toFixed(4), middle: bb.middle.toFixed(4), lower: bb.lower.toFixed(4) },
      atr: atr.toFixed(4), atrPercent: atrPercent.toFixed(2),
      vwap: vwap.toFixed(4), volatilityLevel: this.volatilityLevel,
      marketRegime, goldenCross, deathCross,
      ema50Slope: parseFloat(ema50Slope.toFixed(4)),
      volRatio: parseFloat(volRatio.toFixed(3)), liquidMarket, avgVolume: Math.round(avgVolume),
      liquidityScore: liquidityResult.score, liquidityRegime: liquidityResult.regime,
      liquidityMultiplier: liquidityResult.multiplier, liquidityBlocked: liquidityResult.blocked,
      liquidityComponents: liquidityResult.components,
      dynamicLevels: { stopLoss: dynamicLevels.stopLoss.toFixed(4), takeProfit: dynamicLevels.takeProfit.toFixed(4), vwapLevel: dynamicLevels.vwapLevel.toFixed(4) },
      mta, signal, leadingSignal, performanceState: (() => {
        // Cache performance state — expensive, recompute every 5 closed trades
        const tradeCount = (this.trades || []).length;
        if (!this._perfCache || this._perfCacheTrades !== tradeCount) {
          this._perfCache       = this.buildPerformanceState();
          this._perfCacheTrades = tradeCount;
        }
        return this._perfCache;
      })(),
      adx: parseFloat(adx.toFixed(2)), adxRegime, divergence,
      regimeStack, calendarCheck, riskEnv,
      macdSignal: macdFull.signal, macdHistogram: macdFull.histogram,
      // BUG-59 fix: orderFlow.analyse() was never called — add to snapshot
      orderFlow: this.orderFlow ? this.orderFlow.analyse() : null,
      sr: (() => {
        // S/R cached every 10 ticks using monotonic counter — never freezes
        if (!this._srCache || !this._srCacheTick || this._tickCount - this._srCacheTick >= 10) {
          this._srCache     = SupportResistance.analyse(this.priceHistory, atr, { swingLookback: 5 });
          this._srCacheTick = this._tickCount;
        }
        return this._srCache;
      })(),
      computedAt: Date.now(),
      // ── Feature #22: Sentiment score in indicators for ML feature vector ─
      // Item #1: MarketStructure and LiquidityHeatmap analysis
      // Item 41: Causal inference check (is RSI actually causing the move or spurious?)
      causalCheck: (() => {
        try {
          // Use rolling RSI vs price returns to check Granger causality
          // this.causalInference is the instance set in the constructor
          if (this.priceHistory.length >= 30) {
            const rets = this.priceHistory.slice(-30).map((v,i,a)=>i?v/a[i-1]-1:0).slice(1);
            const rsiHist = this._rsiHistory ? this._rsiHistory.slice(-29) : rets.map((_,i)=>50+i);
            const te = this.causalInference?.grangerTest?.(rets, rsiHist, 2);
            return te ? { causal: te.grangerCauses, fStat: te.fStat } : null;
          }
        } catch(_) {}
        return null;
      })(),
      // Item 40: RSI period adaptation by regime (21 trending, 9 ranging, 14 default)
      rsiPeriodUsed: (() => {
        const regime = this.lastMarketRegime || 'UNKNOWN';
        if (require('./trading-config').TRADING_CONFIG.rsiPeriodAdaptive === false) return 14;
        if (regime.includes('TREND') || regime === 'TRENDING') return 21;
        if (regime === 'RANGING' || regime.includes('REVERT')) return 9;
        return 14;
      })(),
      // 2.1: HMM hidden regime state
      hmmRegime: (() => {
        if (!this.hmmRegime) return null;
        try {
          return this.hmmRegime.update({
            adx: raw?.adx || 20, atrPct: raw?.atrPercent || 0.8,
            volRatio: raw?.volRatio || 1, rsi: raw?.rsi || 50,
            spreadRatio: this.avgSpread > 0 ? (this.currentSpread/this.avgSpread) : 1,
          });
        } catch(_) { return null; }
      })(),
      marketStructure: (() => {
        if (!this.marketStructure || !this.priceHistory || this.priceHistory.length < 20) return null;
        try { return this.marketStructure.analyse(this.priceHistory, this.volumeHistory || []); } catch(_) { return null; }
      })(),
      liquidityHeatmap: (() => {
        if (!this.liquidityHeatmap || !this.priceHistory || this.priceHistory.length < 20) return null;
        try { return this.liquidityHeatmap.analyse(this.priceHistory, this.volumeHistory || []); } catch(_) { return null; }
      })(),
      sentimentScore: (() => {
        if (!this.sentiment) return 0;
        try {
          const s = this.sentiment.getScore(this.selectedAsset || 'EURUSD');
          return (s && s.confidence > 0.1) ? s.score : 0;
        } catch(_) { return 0; }
      })(),
    };
    const _result16 = safeNormaliseIndicators(raw) || raw;
    // A16: Store in memo cache
    this._indCache    = _result16;
    this._indCacheKey = _cacheKey16;
    return _result16;
  },

  getRuleBasedDecision(indicators) {
    // Store HTF boost on engine for executeDecision gate (#16)
    this._lastHTFBoost = indicators.regimeStack?.htfGate?.requiredConfidenceBoost || 0;
    // ── Feature #44: Ichimoku cloud regime gate ───────────────────────────
    // If price is in the cloud, add 10-pt confidence penalty (uncertain zone).
    const ichGate = indicators.regimeStack?.ichimokuGate;
    this._ichimokuCloudPenalty = (ichGate?.inCloud) ? 10 : 0;
    // ── Sentiment integration (#20) ─────────────────────────────────────
    // Sentiment aligns with signal → boost confidence; opposes → reduce
    let sentimentMod = 0;
    if (this.sentiment) {
      const sent = this.sentiment.getScore(this.selectedAsset || 'EURUSD');
      if (sent.confidence > 0.3) {  // only if sentiment has enough data
        sentimentMod = Math.round(sent.score * 8);  // max ±8 pts
      }
    }

    // Update currency exposure (#12) and store HTF boost (#16)
    // Update currency exposure every tick — null position clears stale data
    if (this.currencyExposure) {
      this.currencyExposure.update(this.position || null, this.selectedAsset, this.capital);
    }

    const mlResult = this.mlConfidence.getConfidence(indicators, this.priceHistory, this.ohlcvHistory);
    this._sentimentMod = sentimentMod;
    const context  = { hasPosition: !!this.position, position: this.position, mlResult,
                         session: this._currentSession() };
    const price    = this.priceHistory.at(-1) || 0;
    const decision = this.abTester.tick(indicators, context, price);

    // BUG-49 fix: actually apply sentimentMod to decision confidence (was computed but silently discarded)
    if (sentimentMod !== 0 && decision.action !== 'HOLD') {
      decision.confidence = Math.min(95, Math.max(0, decision.confidence + sentimentMod));
      decision.reasoning  = (decision.reasoning || '') + ` | sentiment${sentimentMod >= 0 ? '+' : ''}${sentimentMod}pts`;
    }
    // Feature #44: Apply Ichimoku cloud penalty (in-cloud = uncertain)
    if (this._ichimokuCloudPenalty && decision.action !== 'HOLD') {
      decision.confidence = Math.max(0, decision.confidence - this._ichimokuCloudPenalty);
      decision.reasoning  = (decision.reasoning || '') + ` | ichimoku_in_cloud-${this._ichimokuCloudPenalty}pts`;
    }

    // ── ADX mean-reversion gate ─────────────────────────────────────────────
    // Strong trends invalidate mean-reversion edge — block those entries
    if (TRADING_CONFIG.adxMeanRevGateEnabled && decision.action !== 'HOLD') {
      const adxVal  = indicators.adx || 0;
      const isRevSig = (decision.reasoning || decision.reason || '').toLowerCase().includes('mean_rev') ||
                       (indicators.signal || '').includes('MEAN_REV') ||
                       (indicators.adxRegime || '') === 'MEAN_REVERTING';
      const thresh  = TRADING_CONFIG.adxMeanRevGateThreshold || 30;
      if (isRevSig && adxVal > thresh) {
        this.log(`🛑 [ADX Gate] Mean-rev signal blocked — ADX=${adxVal.toFixed(1)} > ${thresh} (strong trend)`);
        return { action: 'HOLD', confidence: 0, reason: `adx_mean_rev_gate:${adxVal.toFixed(1)}`, strategyName: decision.strategyName };
      }
    }

    // ── Model confidence decay ───────────────────────────────────────────────
    if (this.modelDecay && decision.action !== 'HOLD') {
      decision.confidence = Math.round(this.modelDecay.adjust(decision.confidence / 100) * 100);
    }

    // ── Session overlap boost ─────────────────────────────────────────────
    if (TRADING_CONFIG.sessionOverlapBoostEnabled && decision.action !== 'HOLD') {
      const _sess = this._currentSession?.() || '';
      if (_sess === 'LONDON_NY_OVERLAP') {
        decision.confidence = Math.min(95, Math.round(decision.confidence + (TRADING_CONFIG.sessionOverlapConfBoost || 0.05) * 100));
        decision.reasoning  = (decision.reasoning || '') + ' | overlap_boost';
      }
    }

    // ── Feature importance tracking (rule-based path only) ──────────────────
    // Bug #89 fix: skip if this came from AI path (it records there separately)
    if (this.featureImportance && decision.action !== 'HOLD' && !decision._fromAI) {
      const _feats = { rsi: indicators.rsi||0, macd: indicators.macd||0, atr: indicators.atr||0,
        ema9: indicators.ema9||0, adx: indicators.adx||0, vwap: indicators.vwap||0 };
      this.featureImportance.record(_feats, decision.confidence / 100);
    }

    // ── Overfit guard — suppress ML signals if model is overfit ─────────────
    if (this.overfitGuard?.isHalted && decision.action !== 'HOLD') {
      this.log('🚨 [OverfitGuard] ML signals suppressed — model overfit detected');
      return { action: 'HOLD', confidence: 0, reason: 'overfit_guard_halt', strategyName: decision.strategyName };
    }

    const sigLine  = this.abTester.signalLine();
    if (sigLine) this.log(sigLine);
    return decision;
  },

  async getDecision(indicators) {
    const proxyUrl = TRADING_CONFIG.proxyUrl;
    if (!proxyUrl || !process.env.ANTHROPIC_API_KEY) {
      return this.getRuleBasedDecision(indicators);
    }
    try {
      const ruleDecision  = this.getRuleBasedDecision(indicators);
      const perfState     = this._perfCache || this.buildPerformanceState();
      const leadingSignal = this.lastLeadingSignal || {};
      const price         = this.priceHistory.at(-1) || 0;

      const prompt = [
        'You are an expert forex trading AI. Decide: BUY, SELL, or HOLD.',
        '',
        '## Market',
        'Asset: ' + this.selectedAsset + ' | Price: ' + price.toFixed(5) + ' | Regime: ' + (this.lastMarketRegime||'UNKNOWN'),
        'Session: ' + this._currentSession() + ' | Volatility: ' + this.volatilityLevel,
        '',
        '## Indicators',
        'RSI: ' + (indicators.rsi||0).toFixed(2) + ' | MACD: ' + (indicators.macd||0).toFixed(5) + ' | Signal: ' + indicators.signal,
        'EMA9/21: ' + (indicators.ema9||0).toFixed(5) + ' / ' + (indicators.ema21||0).toFixed(5) + ' | ATR: ' + (indicators.atr||0).toFixed(5),
        'BB: ' + (indicators.bb&&indicators.bb.upper||0).toFixed(5) + ' / ' + (indicators.bb&&indicators.bb.lower||0).toFixed(5) + ' | VWAP: ' + (indicators.vwap||0).toFixed(5),
        '',
        '## Macro',
        'DXY: ' + (leadingSignal.indicators&&leadingSignal.indicators.DXY&&leadingSignal.indicators.DXY.direction||'?') +
        ' | XAU: ' + (leadingSignal.indicators&&leadingSignal.indicators.XAU&&leadingSignal.indicators.XAU.direction||'?') +
        ' | US10Y: ' + (leadingSignal.indicators&&leadingSignal.indicators.US10Y&&leadingSignal.indicators.US10Y.direction||'?'),
        'Leading Bias: ' + (leadingSignal.bias||'NEUTRAL'),
        '',
        '## Rule Engine',
        'Rule: ' + ruleDecision.action + ' | Conf: ' + ruleDecision.confidence + '%',
        '',
        '## Performance',
        perfState.summary,
        '',
        '## Response format',
        'JSON only, no markdown: {"action":"BUY","confidence":75,"reason":"RSI oversold with bullish DXY"}',
        'action: BUY=open long, SELL=open short or exit long, HOLD=no action',
        'confidence: integer 50-95',
      ].join('\n');

      // Bug fix: single transient failures (429, 503, network blip) fell through
      // to rule-based fallback immediately with no retry attempt.
      // Fix: retry up to 2 times with exponential backoff before giving up.
      let res;
      for (let _attempt = 0; _attempt < 3; _attempt++) {
        if (_attempt > 0) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, _attempt - 1)));
        res = await fetch(proxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 120,
            messages: [{ role: 'user', content: prompt }],
          }),
          signal: AbortSignal.timeout(8000),
        });
        // 429 and 5xx are retryable; 4xx client errors are not
        if (res.ok || (res.status >= 400 && res.status < 429) || res.status === 422) break;
        if (_attempt === 2) break;  // last attempt — let !res.ok handle it below
      }

      if (!res.ok) throw new Error('API ' + res.status);
      const data   = await res.json();
      const raw    = (data.content && data.content[0] && data.content[0].text || '').trim();
      const clean  = raw.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();
      const parsed = JSON.parse(clean);

      if (!['BUY','SELL','HOLD'].includes(parsed.action)) throw new Error('invalid action');
      let confidence = Math.max(50, Math.min(95, parseInt(parsed.confidence) || 50));  // Bug #10 fix: let not const

      // Apply model confidence decay
      let finalConfidence = confidence;
      if (this.modelDecay) finalConfidence = Math.round(this.modelDecay.adjust(finalConfidence / 100) * 100);
      // Apply session overlap boost (London/NY overlap = highest liquidity)
      const _session = this._currentSession?.() || '';
      if (TRADING_CONFIG.sessionOverlapBoostEnabled && _session === 'LONDON_NY_OVERLAP') {
        finalConfidence = Math.min(95, Math.round(finalConfidence + (TRADING_CONFIG.sessionOverlapConfBoost || 0.05) * 100));
      }
      // Feature importance tracking
      if (this.featureImportance && this.lastIndicators) {
        const _feats = { rsi: this.lastIndicators.rsi||0, macd: this.lastIndicators.macd||0,
          atr: this.lastIndicators.atr||0, ema9: this.lastIndicators.ema9||0,
          adx: this.lastIndicators.adx||0, vwap: this.lastIndicators.vwap||0 };
        this.featureImportance.record(_feats, finalConfidence / 100);
      }
      this.log('AI ' + parsed.action + ' conf=' + finalConfidence + '% (raw=' + confidence + '%) — ' + parsed.reason);
      confidence = finalConfidence;

      if (parsed.action === 'HOLD' || confidence < TRADING_CONFIG.minConfidence) {
        return Object.assign({}, ruleDecision, { action: 'HOLD', aiOverride: false });
      }
      // _fromAI flag lets getRuleBasedDecision skip duplicate featureImportance recording
      return { action: parsed.action, confidence, reason: parsed.reason, aiOverride: true, ruleAction: ruleDecision.action, _fromAI: true };

    } catch (err) {
      this.log('Claude API err (' + err.message + ') — rule fallback');
      return this.getRuleBasedDecision(indicators);
    }
  },


  buildPerformanceState() {
    const recent = this.trades.slice(-20);
    if (recent.length === 0) return { summary: 'No trade history yet.', warnings: [], patterns: {}, confidence: 'NEUTRAL' };

    const warnings = [], patterns = {};

    for (const regime of ['HIGH', 'NORMAL', 'LOW']) {
      const inRegime = recent.filter(t => t.volatilityLevel === regime);
      if (inRegime.length < 2) continue;
      const wins = inRegime.filter(t => t.outcome === 'WIN').length;
      const wr   = (wins / inRegime.length) * 100;
      patterns[`winRate_${regime}`] = { trades: inRegime.length, winRate: parseFloat(wr.toFixed(1)) };
      if (wr < 35 && inRegime.length >= 3)
        warnings.push(`⚠️ Win rate in ${regime} volatility is ${wr.toFixed(0)}% (${wins}/${inRegime.length})`);
    }

    const last5  = recent.slice(-5);
    const last3  = recent.slice(-3);
    patterns.recentForm = {
      last5: `${last5.filter(t=>t.outcome==='WIN').length}W/${last5.filter(t=>t.outcome!=='WIN').length}L`,
      streak: this.consecutiveLosses > 0 ? `${this.consecutiveLosses} consecutive losses` : 'no loss streak',
    };
    if (last3.length === 3 && last3.every(t => t.outcome === 'LOSS'))
      warnings.push(`🔴 Last 3 trades ALL failed (${last3.map(t=>t.reason).join(', ')})`);
    if (last3.length === 3 && last3.every(t => t.outcome === 'WIN'))
      warnings.push(`🟢 Last 3 trades ALL won`);

    const reasons = {};
    for (const t of recent) {
      const r = t.reason || 'Unknown';
      if (!reasons[r]) reasons[r] = { count: 0, wins: 0 };
      reasons[r].count++;
      if (t.outcome === 'WIN') reasons[r].wins++;
    }
    patterns.exitReasons = Object.entries(reasons).sort((a,b)=>b[1].count-a[1].count).slice(0,4)
      .reduce((obj,[k,v]) => { obj[k] = { count: v.count, winRate: parseFloat(((v.wins/v.count)*100).toFixed(0)) }; return obj; }, {});

    const slCount = (reasons['Stop Loss']||{}).count || 0;
    if (slCount >= 3 && slCount / recent.length > 0.4)
      warnings.push(`⚠️ ${slCount}/${recent.length} trades exited via SL — entries may be too early`);

    const overallWR = recent.length > 0 ? (recent.filter(t=>t.outcome==='WIN').length / recent.length) * 100 : 50;
    const confidence = overallWR>=60&&warnings.length===0?'STRONG':overallWR>=45&&warnings.length<=1?'MODERATE':overallWR>=35?'WEAK':'POOR';
    const regimeStat = patterns[`winRate_${this.volatilityLevel}`];
    const summary = [
      `Last ${recent.length} trades: ${overallWR.toFixed(0)}% win rate.`,
      regimeStat ? `${this.volatilityLevel} vol: ${regimeStat.winRate}% win rate (${regimeStat.trades} trades).` : '',
      patterns.recentForm ? `Recent: ${patterns.recentForm.last5}. ${patterns.recentForm.streak}.` : '',
      warnings.length > 0 ? `${warnings.length} active warning(s).` : 'No active warnings.',
    ].filter(Boolean).join(' ');

    return { summary, warnings, patterns, confidence, overallWinRate: parseFloat(overallWR.toFixed(0)) };
  },
};

module.exports = {
  ...engineMethods,
  engineMethods,
  MultiTimeframeAnalyzer,
};
