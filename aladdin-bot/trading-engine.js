// ===== ALADDIN TRADING ENGINE — Thin Orchestrator =====
// Imports, constructor, main loop, status. All execution/strategy/risk
// logic lives in dedicated modules and is mixed in below.

const fs   = require('fs');
const path = require('path');
const { SAFETY }        = require('./safety-constants');
const { EventEmitter }  = require('events');
const { MLConfidence, FeatureExtractor } = require('./ml-confidence');
const { NewsFilter }    = require('./news-filter');
const { StrategyManager } = require('./strategies');
const { DriftMonitor }  = require('./drift-monitor');
const { ABTester }      = require('./ab-tester');
const { StaleDataMonitor, DeadMansSwitch } = require('./exchange-risk');
const { CapitalAllocator }  = require('./capital-allocator');
const { LiquidityScorer }   = require('./liquidity-scorer');
const telegram              = require('./telegram');
const { validateConfig }    = require('./config-validator');
const auditLog              = require('./audit-tagger');
const { runStartupGrid }    = require('./startup');
const { RiskMetrics }       = require('./var-calculator');
const { RegimeStack, getSessionWeights } = require('./regime-stack');
const { EconomicCalendar }  = require('./economic-calendar');
// v12 Advanced Features
const { TripleBarrier }          = require('./triple-barrier');
const { FeatureStore }           = require('./feature-store');
const { HMMRegime }              = require('./hmm-regime');
const { DynamicEnsembleWeights, RiskParityAllocator, TailRiskDetector,
        SlippagePredictionModel, RetrainingScheduler, UncertaintyEstimator,
        shapeRLReward, buildContextualRLState, SafeRLConstraints } = require('./advanced-features');
const { ModelRegistry, HumanApprovalGate, AutoRollback,
        CorporateActionsHandler, BayesianDecisionEngine,
        KnowledgeGraph, CausalInference }  = require('./governance');

// Item #1: MarketStructure and LiquidityHeatmap wired into live engine
const { MarketStructure }  = require('./market-structure');
const { LiquidityHeatmap } = require('./liquidity-heatmap');
const { CurrencyExposure }  = require('./currency-exposure');
const { SocialTracker }     = require('./social-tracker');
const { CrossExchangeHedge }= require('./cross-exchange-hedge');
const { OrderFlow }         = require('./orderflow');
const { SentimentAnalyser } = require('./sentiment');
const { PriceDivergence }   = require('./price-divergence');
const expTracker            = require('./experiment-tracker');
const timeseriesStore       = require('./timeseries-store');
const { SessionDrawdownGuard } = require('./session-drawdown-guard');
const { PerPairLossTracker }   = require('./per-pair-loss-tracker');
const { sendFallback }         = require('./alert-fallback');
const { OnlineLearningGuard }  = require('./online-learning-guard');
const { HolidayCalendar }      = require('./holiday-calendar');
const { TradeJournal }         = require('./trade-journal');
const { FeatureImportanceTracker } = require('./feature-importance');
const { ModelConfidenceDecay }     = require('./model-confidence-decay');
const { OverfitGuard }             = require('./overfit-guard');
const { LatencyMonitor }           = require('./latency-monitor');
const { EquityAnomalyDetector }    = require('./equity-anomaly');
const { MaxOpenPositionsGuard, CorrelationLock, AntiMartingaleGuard,
        SlippageBudgetGuard, RequoteDetector } = require('./position-guard');
const { RateLimitBackoff }         = require('./rate-limit-backoff');
const { WeeklyReportGenerator }    = require('./weekly-report');
const { TradeReplayer }            = require('./trade-replayer');
const { GracefulShutdown }         = require('./graceful-shutdown');
const { MAEMFETracker }            = require('./mae-mfe-tracker');
const { TODHeatmap }               = require('./tod-heatmap');
const { LogPruner }                = require('./log-pruner');
const { UnrealizedPnLAlert, PositionAgeAlert, SwapCostAlert } = require('./position-alerts');
const { RiskAdjustedTracker }      = require('./risk-adjusted-tracker');
const { EnsembleDisagreementHalt } = require('./ensemble-disagreement');

// ── Module re-exports (backward compat + internal use) ────────────────────────
const { TRADING_CONFIG }          = require('./trading-config');
const { Indicators }              = require('./indicators');
const { KellyCriterion }          = require('./kelly-criterion');
const { CorrelationEngine }       = require('./correlation-engine');
const { MultiTimeframeAnalyzer }  = require('./multi-timeframe');
const { MarketDataFetcher, LeadingIndicatorFetcher } = require('./market-data');

// ===== TRADING ENGINE =====
class TradingEngine extends EventEmitter {
  constructor(clientCallback = null, startingCapital = null) {
    super();
    this.marketData = new MarketDataFetcher();
    this.leadingIndicators = new LeadingIndicatorFetcher();   // ← NEW
    this.lastLeadingSignal = null;                             // ← NEW
    this.selectedAsset = 'EURUSD';
    const cap = startingCapital || TRADING_CONFIG.initialCapital || 10000;
    this.capital = cap;
    this.initialCapital = cap;
    this.position = null;
    this.trades = [];
    this.trainingData  = [];   // raw snapshots fed to walkforward optimizer
    this.priceHistory  = [];
    this.volumeHistory = [];
    this.ohlcvHistory  = [];   // {o, h, l, c, v} per bar — used by ML OHLCV features

    // ── Spread tracking ─────────────────────────────────────────────────
    this.currentBid    = null;   // latest bid price from broker feed
    this.currentAsk    = null;   // latest ask price from broker feed
    this.currentSpread = 0;      // ask − bid in price units
    this.spreadHistory = [];     // rolling 20-bar spread fractions
    this.avgSpread     = 0;      // rolling average spread fraction
    this.wins = 0;
    this.losses = 0;
    this.modelEpochs = 0;
    this.lastTrainCount = 0;
    this.isRunning = false;
    this.apiCallInProgress = false;
    this.circuitBreakerTripped = false;
    // Async order queue — prevents race conditions on rapid signals
    try { const { AsyncOrderQueue } = require('./async-order-queue'); this.orderQueue = new AsyncOrderQueue(); } catch(_) { this.orderQueue = null; }
    // Items 37/38 methods defined in class body

  // Item 7: Per-subsystem circuit breakers (independent from global)
    this._subsystemBreakers = {
      exchange: { failures:0, open:false, lastFailure:0, threshold:3, resetMs:300_000, state:'CLOSED' },
      ml:       { failures:0, open:false, lastFailure:0, threshold:5, resetMs:600_000, state:'CLOSED' },
      news:     { failures:0, open:false, lastFailure:0, threshold:3, resetMs:120_000, state:'CLOSED' },
      telegram: { failures:0, open:false, lastFailure:0, threshold:5, resetMs:60_000,  state:'CLOSED' },
    };
    this.dailyStartCapital = this.initialCapital;

    // ── Nuclear Safety State ─────────────────────────────────────────────
    this.consecutiveLosses    = 0;
    this.consecutiveHaltUntil = 0;  // set default BEFORE restore so file value wins
    // Restore persisted risk state if available
    try {
      const rs = JSON.parse(fs.readFileSync(path.join(__dirname,'trade_logs','risk-state.json'),'utf8'));
      if (rs.consecutiveLosses > 0)      this.consecutiveLosses    = rs.consecutiveLosses;
      if (rs.consecutiveHaltUntil > Date.now()) this.consecutiveHaltUntil = rs.consecutiveHaltUntil;
    } catch(_) {}
    this._slCooldownUntil     = {};
    this._entering            = false;  // mutex: prevents concurrent enterPosition calls
    this._gcInterval          = null;   // GC timer for stale cooldown entries
    this._isTicking           = false;  // mutex: prevents concurrent tick execution
    this._tickCount           = 0;      // incremented every calculateIndicators call — drives cache expiry

    // Validate config on boot — log all issues, throw in live mode
    try { validateConfig(); }
    catch (e) {
      console.error('[CONFIG ERROR]', e.message);
      if (process.env.PAPER_MODE !== 'true' && process.env.BACKTEST_MODE !== 'true') {
        throw e;   // hard abort when LIVE_TRADING=true
      }
    }   // asset → timestamp: blocks re-entry after SL
    this._assetPeakCapital    = {};
    this.orderFlow            = new OrderFlow({ window: 20 });
    this.socialTracker        = new SocialTracker();
    this.regimeStack          = new RegimeStack();
    this.economicCalendar     = new EconomicCalendar();
    this.currencyExposure     = new CurrencyExposure();
    this._entryWaitState      = null;  // { targetEntry, maxWaitBars, barsWaited }
    this._stratPeakCapital    = {};   // strategy name → peak capital for drawdown tracking
    this._fillQualityHistory  = [];   // adverse selection tracking
    this.hedgeFramework       = new CrossExchangeHedge();
    this.sentiment            = new SentimentAnalyser();
    this._sentimentFetchedAt  = 0;   // Fix #73: Track staleness of leading indicators
    // Item #1: MarketStructure and LiquidityHeatmap instances
    this.marketStructure      = new MarketStructure();
    this.liquidityHeatmap     = new LiquidityHeatmap();
    // v12 Advanced Features — instantiate all new components
    this.tripleBarrier     = new TripleBarrier({ ptMult:2.0, slMult:1.0, maxBars:20 });
    this.featureStore      = new FeatureStore(['rsi','macd','atr','volRatio','adx','vwap','bb','ema50','ema200','spread','session','regime']);
    this.hmmRegime         = new HMMRegime({ nStates:5, maxIter:30, log: m=>this.log(m) });
    this.dynEnsemble       = new DynamicEnsembleWeights({ log: m=>this.log(m) });
    this.riskParity        = new RiskParityAllocator({ targetVol:0.01 });
    this.tailRisk          = new TailRiskDetector({ kurtosisThresh:3.0, log: m=>this.log(m) });
    this.slippagePredModel = new SlippagePredictionModel({ log: m=>this.log(m) });
    this.retrainScheduler  = new RetrainingScheduler({
      intervalDays: 30, minNewTrades: 50,
      onRetrain: async () => { try { if (this.mlConfidence) await this.mlConfidence.retrain?.(this.trades, this.priceHistory); } catch(_) {} },
      log: m=>this.log(m),
    });
    this.uncertaintyEst    = new UncertaintyEstimator({ rejectVariance:0.04 });
    this.safeRL            = new SafeRLConstraints({ maxPositionSizePct:0.05, maxDrawdownPct:0.10, log: m=>this.log(m) });
    this.modelRegistry     = new ModelRegistry({ log: m=>this.log(m) });
    this.humanApproval     = new HumanApprovalGate({ thresholdPct:0.03, log: m=>this.log(m) });
    this.autoRollback      = new AutoRollback({ sharpeDeclineThresh:0.5, winRateDeclineThresh:0.10, log: m=>this.log(m) });
    this.corpActions       = new CorporateActionsHandler({ log: m=>this.log(m) });
    this.bayesianEngine    = new BayesianDecisionEngine({ priorWinRate:0.50 });
    this.knowledgeGraph    = new KnowledgeGraph({ log: m=>this.log(m) });
    this.causalInference   = new CausalInference({ maxLag:5 });
    if (process.env.BACKTEST_MODE !== 'true') this.retrainScheduler.start();
    // Item #2: Bayesian optimizer for continuous parameter refinement
    try {
      const { BayesianOptimizer } = require('./bayesian-optimizer');
      const _boSpace = [
        { name: 'minConfidence', min: 55, max: 85 },
        { name: 'positionSize',  min: 0.01, max: 0.05 },
        { name: 'stopLoss',      min: 0.01, max: 0.03 },
        { name: 'tpAtrMult',     min: 2, max: 8 },
      ];
      this.bayesianOptimizer = new BayesianOptimizer(_boSpace, async () => 0, { trials: 50, warmup: 10 });
    } catch(_) { this.bayesianOptimizer = null; }
    this.priceDivergence      = new PriceDivergence();   // asset → highest capital since last reset
    this._assetDrawdown       = {};   // asset → current drawdown fraction
    this._assetHaltedUntil    = {};   // asset → timestamp: per-asset halt after excess drawdown
    // Bug #1 fix: removed duplicate _assetPeakCapital init (was line 197)
    this.globalHaltTripped    = false;  // set default before disk restore
    // Fix #42: Typed error classes for post-mortem analysis
    this.lastErrorType        = null;   // 'CONNECTIVITY' | 'REJECTION' | 'INTERNAL_LOGIC' | 'CONFIG'
    // Fix #30: Stamp log session with config schema version for regime isolation
    this._logSessionId        = `v${require('./config/trading-config.json').schemaVersion||1}-${Date.now()}`;
    // ── Feature #6: Intraday session drawdown guard ──────────────────────
    this.sessionDrawdown = new SessionDrawdownGuard({
      sessionDrawdownLimit: TRADING_CONFIG.sessionDrawdownLimit || 0.03,
      haltOnBreach: !!(TRADING_CONFIG.sessionDrawdownHalt),
      log: (m) => this.log(m),
      notify: (m, cat) => { try { telegram.send(m, cat || 'risk'); } catch(_) {} sendFallback(m, cat || 'risk'); },
      onHalt: () => { this.log('🛑 Session drawdown halt activated'); },
    });
    // ── Feature #17: Per-pair daily loss tracker ─────────────────────────
    this.perPairLoss = new PerPairLossTracker({
      maxPairDailyLossPct: TRADING_CONFIG.maxPairDailyLossPct || 0.02,
      log: (m) => this.log(m),
      notify: (m) => { try { telegram.send(m, 'risk'); } catch(_) {} sendFallback(m, 'risk'); },
    });
    // ── Feature #89: Market holiday calendar ─────────────────────────────
    this.holidayCalendar = new HolidayCalendar({
      blockOnHoliday: true,
      log: (m) => this.log(m),
    });
    // ── Feature #36: Consecutive win counter ─────────────────────────────
    this.consecutiveWins = 0;
    // Feature #14/#74: Post-trade analytics journal
    this.tradeJournal = new TradeJournal({ log: (m) => this.log(m) });
    // ── New quality modules ──────────────────────────────────────────────────
    const _alerter = (m, lvl) => { try { require('./telegram').send(m, lvl); } catch(_) {} };
    this.featureImportance  = new FeatureImportanceTracker({ log: (m) => this.log(m) });
    this.modelDecay         = new ModelConfidenceDecay({ log: (m) => this.log(m) });
    this.overfitGuard       = new OverfitGuard({ log: (m) => this.log(m) });
    this.latencyMonitor     = new LatencyMonitor({ log: (m) => this.log(m), send: _alerter });
    this.equityAnomaly      = new EquityAnomalyDetector({ log: (m) => this.log(m), send: _alerter });
    this.maxOpenGuard       = new MaxOpenPositionsGuard({ log: (m) => this.log(m) });
    this.correlationLock    = new CorrelationLock({ log: (m) => this.log(m) });
    this.antiMartingale     = new AntiMartingaleGuard({ log: (m) => this.log(m) });
    this.slippageBudget     = new SlippageBudgetGuard({ log: (m) => this.log(m) });
    this.requoteDetector    = new RequoteDetector({ log: (m) => this.log(m) });
    this.rateLimitBackoff   = new RateLimitBackoff({ log: (m) => this.log(m) });
    this.weeklyReport       = new WeeklyReportGenerator({ log: (m) => this.log(m), send: _alerter });
    this.tradeReplayer      = new TradeReplayer({ log: (m) => this.log(m) });
    // Track open positions map: pair → { side, entryTime, size }
    this.openPositions      = this.openPositions || {};
    // New modules
    this.gracefulShutdown   = new GracefulShutdown({ log: (m) => this.log(m), send: _alerter });
    this.maeMfe             = new MAEMFETracker({ log: (m) => this.log(m) });
    this.todHeatmap         = new TODHeatmap({ log: (m) => this.log(m) });
    this.logPruner          = new LogPruner({ log: (m) => this.log(m) });
    this.unrealizedAlert    = new UnrealizedPnLAlert({ log: (m) => this.log(m), send: _alerter });
    this.positionAgeAlert   = new PositionAgeAlert({ log: (m) => this.log(m), send: _alerter });
    this.swapCostAlert      = new SwapCostAlert({ log: (m) => this.log(m), send: _alerter });
    this.riskAdjusted       = new RiskAdjustedTracker({ log: (m) => this.log(m) });
    this.ensembleDisagree   = new EnsembleDisagreementHalt({ log: (m) => this.log(m) });
    // Restore global halt state from disk (survives restarts)
    try {
      const _haltFile = require('path').join(__dirname, 'trade_logs', 'global_halt.json');
      const _haltData = JSON.parse(require('fs').readFileSync(_haltFile, 'utf8'));
      if (_haltData.halted) {
        this.globalHaltTripped = true;
      try { require('./telegram').send('🚨 GLOBAL HALT: global drawdown limit breached — trading stopped', 'risk'); } catch(_) {}
        console.warn('[ENGINE] Global drawdown halt restored from disk — engine halted. Delete trade_logs/global_halt.json to resume.');
      }
    } catch(_) {}
    this.flashCrashHaltUntil  = 0;
    this.dailyLockoutUntil    = 0;
    this.priceTimestamps      = [];

    // ── Live vs Backtest Drift Monitor ──────────────────────────────────
    // Compares rolling live trade metrics against the latest nightly
    // backtest benchmark. Auto-disables trading on significant deviation.
    this.driftMonitor = new DriftMonitor();

    // ── A/B Strategy Tester ──────────────────────────────────────────────
    // Runs all strategies simultaneously on every tick. Champion decision
    // is used for real trades; challengers paper-trade in parallel.
    this.abTester = new ABTester();

    // ── Exchange Risk Management ─────────────────────────────────────────
    // Stale data monitor: halts new entries if price feed goes silent.
    this.staleDataMonitor = new StaleDataMonitor({
      maxAgeMs:  60_000,
      label:     'Price feed',
      onStale:   () => this.log('⚠️  Price feed stale — halting new entries until data resumes'),
      onRecover: () => this.log('✅ Price feed recovered — resuming normal operation'),
    });

    // Dead man's switch: detects if the main trading loop silently stops.
    this.deadMansSwitch = new DeadMansSwitch({
      timeoutMs:       90_000,
      checkIntervalMs: 15_000,
      label:           'Main trading loop',
      onDead:   (ms) => this.log(`🚨 Trading loop silent for ${(ms/1000).toFixed(0)}s — possible crash`),
      onRecover:       () => this.log('✅ Trading loop heartbeat resumed'),
    });

    // ── Capital Allocator ────────────────────────────────────────────────
    // Splits capital across strategy slots and rebalances based on performance.
    this.capitalAllocator = new CapitalAllocator({ totalCapital: this.capital });

    // ── Liquidity Scorer ─────────────────────────────────────────────────
    // Produces a unified LiquidityScore (0-100) every bar and classifies
    // the market into DEEP/NORMAL/THIN/DRY. All strategies use this score
    // to adjust confidence uniformly instead of ad-hoc volume checks.
    this.liquidityScorer = new LiquidityScorer();

    // ── Dynamic Slippage Tracker ─────────────────────────────────────────
    // Stores actual slippage (as fraction) of last 10 fills.
    // Updated on every enterPosition / exitPosition call.
    this.slippageHistory      = [];   // last 10 actual slippage fractions
    this.dynamicSlippage      = TRADING_CONFIG.slippage; // starts at config value
    this.dynamicTpMultiplier  = 5.0;  // take-profit ATR multiplier, adjusts with slippage

    // ── Walk-Forward Optimization / Shadow Strategy ───────────────────────
    // Every SHADOW_EVAL_TRADES trades, a shadow strategy with tweaked RSI
    // thresholds replays recent trade history. If it beats live by 20%,
    // the live settings are swapped to the shadow settings.
    this.SHADOW_EVAL_TRADES   = 50;   // evaluate every 50 trades (~weekly at moderate freq)
    this.lastShadowEval       = 0;    // trade count at last evaluation
    this.shadowSettings       = null; // currently tested shadow config
    this.shadowLog            = [];   // recent shadow evaluation results

    // Load persisted daily lockout (survives restarts)
    this._loadDailyLockout();
    this.clientCallback = clientCallback; // For sending updates to connected clients
    this.tradeId = 0;
    // A6: Session prefix makes trade IDs globally unique across restarts
    // Format: <6-char hex session>-<incrementing counter>
    this._tradeIdPrefix = require('crypto').randomBytes(3).toString('hex');
    // Bug fix: initialise in constructor (not lazily) so the set survives reconnects
    // and duplicate bars sent by the broker on reconnect are correctly filtered.
    this._seenBarTimestamps = new Set();
    // A14: Schedule startup position reconcile to detect manual broker/portal changes
    if (process.env.BACKTEST_MODE !== 'true') {
      setTimeout(() => {
        this._reconcileRestoredPosition(0).catch(e =>
          console.warn('[A14] Startup reconcile failed:', e.message)
        );
      }, 15_000).unref();  // 15s after boot — give price feed time to warm up
    }

    // Volatility tracking for dynamic levels
    this.lastATR = 0;
    this.lastVWAP = 0;
    this.volatilityLevel = 'NORMAL';

    // Correlation engine state
    this.correlationMatrix     = {};
    this.lastCorrelationCheck  = null;
    this.lastClosedAsset       = null;   // asset of last closed trade (for corr check on next entry)

    // Multi-Timeframe Analysis state
    this.lastMTA = null;

    // ── ML Confidence Engine ──────────────────────────────────────────────
    this.mlConfidence = new MLConfidence();

    // ── News Filter ───────────────────────────────────────────────────────
    this.newsFilter = new NewsFilter({
      highBeforeMinutes:   15,
      highAfterMinutes:    10,
      mediumBeforeMinutes: 5,
      mediumAfterMinutes:  3,
      enabled: true,
    });

    // ── Strategy Manager ──────────────────────────────────────────────────
    this.strategyManager = new StrategyManager({
      trend:         { minConfidence: TRADING_CONFIG.minConfidence },
      meanReversion: { minConfidence: TRADING_CONFIG.minConfidence },
    });

    // Load trades from file (skip in BACKTEST_MODE — stale history contaminates capital/stats)
    if (process.env.BACKTEST_MODE !== 'true') {
      this.loadTradesFromFile();
    }

    // ── Feature 2: Restore any open position that survived a crash ────────
    // (Skipped during batch backtesting via BACKTEST_MODE env var)
    if (process.env.BACKTEST_MODE !== 'true') {
      this.loadPositionFromFile();
    }

    // ── Feature 1: Historical warm-up — seed indicators before first tick ─
    // (Skipped during batch backtesting — harness pre-seeds manually)
    // warmUpAll is async: tries Alpha Vantage → synthetic fallback
    if (TRADING_CONFIG.warmupEnabled && process.env.BACKTEST_MODE !== 'true') {
      this.marketData.warmUpAll(TRADING_CONFIG.warmupCandles).then(() => {
        // Sync engine's own priceHistory to the pre-seeded data
        this.priceHistory  = [...this.marketData.getPriceHistory(this.selectedAsset)];
        this.volumeHistory = [...this.marketData.getVolumeHistory(this.selectedAsset)];
        console.log('[WarmUp] 🚀 Engine fully primed — trade-ready on first tick');

        // ── Train ML confidence model on warm-up data ─────────────────
        const { Indicators: Ind } = require('./indicators');
        this.mlConfidence.trainFromPriceHistory(
          this.priceHistory, this.volumeHistory, Ind, this.ohlcvHistory
        );
        // Reset model confidence decay timer on successful retrain
        if (this.modelDecay) this.modelDecay.onRetrain();
        // Reset overfit guard after retrain (let next eval check decide)
        if (this.overfitGuard) this.overfitGuard.clear();
        // Bug #91 fix: compute and store backtest Sharpe so deviation alert has a reference
        try {
          const _oos = this.mlConfidence.validateOOS?.({ splitRatio: 0.70, embargoBars: 10 });
          if (_oos?.sharpe != null) this._lastBacktestSharpe = _oos.sharpe;
        } catch(_) {}

        // ── Walk-forward grid search on boot (#15) ──────────────────────
        runStartupGrid(this, this.priceHistory, this.volumeHistory)
          .then(r => { if (r && r.applied) this.log('[StartupGrid] Params updated from walk-forward grid'); })
          .catch(e => this.log('[StartupGrid] Error: ' + e.message));
      }).catch(err => {
        console.error('[WarmUp] ❌ Warm-up failed:', err.message);
      });
    }
  }

  // ── Daily Lockout Helpers (SAFETY: persisted to disk, survives restart) ──

  _lockoutFilePath() {
    return path.join(__dirname, SAFETY.LOCKOUT_FILE);
  }

  _loadDailyLockout() {
    try {
      const file = this._lockoutFilePath();
      if (!fs.existsSync(file)) return;
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.lockedUntil && Date.now() < data.lockedUntil) {
        this.dailyLockoutUntil = data.lockedUntil;
        const hoursLeft = ((data.lockedUntil - Date.now()) / 3600000).toFixed(1);
        console.warn(`[SAFETY] ⏳ Daily loss lockout active — ${hoursLeft}h remaining (loaded from disk)`);
      } else {
        // Lock has expired — clean up file
        fs.unlinkSync(file);
      }
    } catch (e) { /* first boot — no lock file yet */ }
  }

  _saveDailyLockout(until) {
    try {
      const dir = path.join(__dirname, 'trade_logs');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._lockoutFilePath(), JSON.stringify({
        lockedUntil: until,
        lockedAt:    new Date().toISOString(),
        reason:      'Daily loss limit hit',
        unlocksAt:   new Date(until).toISOString(),
      }, null, 2));
    } catch (e) { console.error('[SAFETY] Failed to write lockout file:', e.message); }
  }

  _clearDailyLockout() {
    try {
      const file = this._lockoutFilePath();
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (e) { /* ignore */ }
    this.dailyLockoutUntil = 0;
  }

  loadTradesFromFile() {
    try {
      const tradesFile = path.join(__dirname, 'trade_logs', 'trades.json');
      if (fs.existsSync(tradesFile)) {
        const trades = JSON.parse(fs.readFileSync(tradesFile, 'utf8'));
        this.trades = trades;

        // Recalculate capital and stats
        let capital = this.initialCapital;
        this.wins = 0;
        this.losses = 0;
        let maxId = 0;
        for (const trade of trades) {
          capital += trade.profit;
          if (trade.profit > 0) this.wins++;
          else this.losses++;
          // Bug #71 fix: trade.id may be string like 'abc-42'; extract numeric suffix
          if (trade.id) {
            const _idStr = String(trade.id);
            const _idNum = parseInt(_idStr.includes('-') ? _idStr.split('-').pop() : _idStr, 10);
            if (isFinite(_idNum) && _idNum > maxId) maxId = _idNum;
          }
        }
        this.capital = capital;
        this.tradeId = maxId;  // next ++tradeId will be maxId+1, no duplicates
      }
    } catch (err) {
      console.error('Error loading trades:', err.message);
    }
  }

  // ── Feature 2: Active Position Persistence ────────────────────────────

  /**
   * Write the current open position to disk so it survives a crash.
   * Called every time the position changes (open, partial close, stop move).
   * Writing is synchronous and atomic via a temp-file rename so a mid-write
   * crash never leaves a corrupt file.
   */
  savePositionFile() {
    // Coalesce rapid calls — only write if not already pending
    if (this._savePending) return;
    this._savePending = true;
    // Async — never blocks the event loop (fix: was sync writeFileSync)
    const posFile = path.join(__dirname, TRADING_CONFIG.positionFile);
    const tmpFile = posFile + '.tmp';
    const snapshot = this.position ? JSON.stringify({
      position: this.position, capital: this.capital,
      selectedAsset: this.selectedAsset, savedAt: new Date().toISOString(),
    }, null, 2) : null;

    setImmediate(async () => {
      // Bug #72 fix: release _savePending AFTER write, not before, to prevent concurrent writes
      try {
        const dir = path.dirname(posFile);
        await fs.promises.mkdir(dir, { recursive: true });
        // Include risk state so it survives restarts
      const riskSnapshot = JSON.stringify({
        consecutiveLosses: this.consecutiveLosses,
        consecutiveHaltUntil: this.consecutiveHaltUntil,
        wins: this.wins, losses: this.losses,
      });
      // Bug fix: write risk-state.json atomically — a crash mid-write
      // corrupted consecutiveLosses/wins counters that gate halt logic.
      const riskTmp  = path.join(dir, 'risk-state.json.tmp');
      const riskDest = path.join(dir, 'risk-state.json');
      await fs.promises.writeFile(riskTmp, riskSnapshot);
      // rename is atomic on POSIX; on Windows fall back to copy+unlink
      try { await fs.promises.rename(riskTmp, riskDest); }
      catch (_) { await fs.promises.copyFile(riskTmp, riskDest); await fs.promises.unlink(riskTmp).catch(()=>{}); }
      if (snapshot) {
          await fs.promises.writeFile(tmpFile, snapshot);
          try { await fs.promises.rename(tmpFile, posFile); }
          catch (_) { await fs.promises.copyFile(tmpFile, posFile); await fs.promises.unlink(tmpFile).catch(()=>{}); }
        } else {
          await fs.promises.unlink(posFile).catch(() => {});
          await fs.promises.unlink(tmpFile).catch(() => {});
        }
      } catch (err) { console.error('[PositionPersist]', err.message); }
      finally { this._savePending = false; }  // Bug #72 fix: always release after write
    });
  }

  /**
   * Reload an open position that was saved before a crash/restart.
   * If the file exists and is valid the engine picks up exactly where it
   * left off — monitoring stops, trailing stops, breakeven, etc.
   */
  loadPositionFromFile() {
    try {
      const posFile = path.join(__dirname, TRADING_CONFIG.positionFile);
      if (!fs.existsSync(posFile)) return;

      const data = JSON.parse(fs.readFileSync(posFile, 'utf8'));

      if (data && data.position) {
        this.position      = data.position;
        this.capital       = data.capital       ?? this.capital;
        this.selectedAsset = (data.selectedAsset ?? this.selectedAsset).replace(/_/g, '');  // normalise EUR_USD → EURUSD

        const savedAt = new Date(data.savedAt).getTime();
        const age    = Math.round((Date.now() - savedAt) / 1000);
        console.log(
          `[PositionPersist] ✅ Restored open position from disk ` +
          `(saved ${age}s ago) | Entry: ${this.position.entry} | ` +
          `Asset: ${this.selectedAsset}`
        );

        // ── Reconcile stale stops if gap > 60 seconds ─────────────────────
        // The position was saved with stops relative to the price at save time.
        // After a crash/restart, price may have moved significantly.
        // Fetch current price and check if stops are still valid.
        if (age > 60) {
          this._reconcileRestoredPosition(age).catch(e =>
            console.warn('[PositionPersist] Reconcile warning:', e.message)
          );
        }
      }
    } catch (err) {
      console.error('[PositionPersist] Error loading position (starting fresh):', err.message);
      this.position = null;
    }
  }

  /**
   * Handle real-time WebSocket price updates
   * Called when new price data arrives from market data provider
   */
  onPriceUpdate(priceData) {
    if (priceData.symbol !== this.selectedAsset) return;

    // Fix #71: Deduplicate candles by timestamp — broker sometimes sends the same bar twice on reconnect
    if (priceData.time) {
      if (this._seenBarTimestamps.has(priceData.time)) {
        return; // duplicate — skip
      }
      // Keep only last 200 timestamps to bound memory
      if (this._seenBarTimestamps.size > 200) {
        const first = this._seenBarTimestamps.values().next().value;
        this._seenBarTimestamps.delete(first);
      }
      this._seenBarTimestamps.add(priceData.time);
    }

    // Fix #75: Exclude the most-recent (incomplete, open) M5 bar from indicator computation.
    // Using the partial bar's close as a signal introduces a look-ahead bias.
    // The current live price comes from bid/ask, not from the incomplete bar close.
    if (priceData.complete === false) {
      // Still record the live bid/ask for spread tracking but don't push to indicator history
      const bid2 = priceData.bid || (priceData.price - priceData.price * TRADING_CONFIG.slippage);
      const ask2 = priceData.ask || (priceData.price + priceData.price * TRADING_CONFIG.slippage);
      this._recordSpread(bid2, ask2, priceData.price || 0);
      return;
    }

    const price  = priceData.price || priceData.mid || 0;
    const open   = priceData.open  || price;
    const high   = priceData.high  || price;
    const low    = priceData.low   || price;
    const volume = priceData.volume || 100000;

    // ── Spread capture ──────────────────────────────────────────────────
    const bid = priceData.bid || (price - price * TRADING_CONFIG.slippage);
    const ask = priceData.ask || (price + price * TRADING_CONFIG.slippage);
    this._recordSpread(bid, ask, price);

    // Input validation — reject NaN/zero prices before they corrupt indicators
    if (!isFinite(price) || price <= 0) {
      console.warn('[PRICE INVALID] Rejected price:', price, 'for', this.selectedAsset);
      return;
    }
    this.priceHistory.push(price);
    this.volumeHistory.push(volume > 0 ? volume : 100000);

    // Fix #10: Flash crash detection measured in BARS not wall-clock ms.
    // Wall-clock detection is fooled by API outages that buffer many ticks at once.
    // Use FLASH_CRASH_WINDOW_BARS (default = 6 M5 bars = 30 minutes of bar time).
    const flashBars = TRADING_CONFIG.flashCrashWindowBars || 6;
    if (this.priceHistory.length >= flashBars + 1) {
      const windowLow  = Math.min(...this.priceHistory.slice(-(flashBars + 1), -1));
      const barDropPct = windowLow > 0 ? (price - windowLow) / windowLow : 0;
      const flashThreshold = TRADING_CONFIG.flashCrashThreshold || 0.008;
      if (barDropPct < -flashThreshold && !this.flashCrashHaltUntil) {
        this.flashCrashHaltUntil = Date.now() + (TRADING_CONFIG.flashCrashCooldown || 300_000);
        this.log(`⚡ [Fix #10] Flash crash detected: ${(barDropPct*100).toFixed(2)}% drop over ${flashBars} bars — halting ${(TRADING_CONFIG.flashCrashCooldown||300000)/60000}min`);
        try { require('./telegram').send(`⚡ Flash crash: ${(barDropPct*100).toFixed(2)}% over ${flashBars} M5 bars`, 'risk'); } catch(_) {}
      }
    }

    // ── OHLCV candle store ──────────────────────────────────────────────
    this.ohlcvHistory.push({ o: open, h: high, l: low, c: price, v: volume });

    // Keep history bounded
    // B13: Batch splice instead of O(n) shift() on every bar
    // shift() is O(n) because it reindexes the entire array every call
    // Splice in chunks of 100 once the buffer overflows by 100 bars
    const _maxLen = TRADING_CONFIG.maxHistoryLength || 1000;
    if (this.priceHistory.length > _maxLen + 100) {
      const _removeN = this.priceHistory.length - _maxLen;
      this.priceHistory.splice(0, _removeN);
      this.volumeHistory.splice(0, _removeN);
      this.ohlcvHistory.splice(0, _removeN);
    }

    // Bug fix: other growing collections have no bounds — memory leak over long sessions
    // Cap each to a reasonable window to prevent OOM on extended runs.
    const _spreadMax = 500;
    if (this.spreadHistory?.length > _spreadMax) this.spreadHistory.splice(0, this.spreadHistory.length - _spreadMax);
    const _tsMax = 2000;
    if (this.priceTimestamps?.length > _tsMax) this.priceTimestamps.splice(0, this.priceTimestamps.length - _tsMax);
    const _fillMax = 200;
    if (this._fillQualityHistory?.length > _fillMax) this._fillQualityHistory.splice(0, this._fillQualityHistory.length - _fillMax);
    const _trainMax = 2000;
    if (this.trainingData?.length > _trainMax) this.trainingData.splice(0, this.trainingData.length - _trainMax);

    // Update market price
    this.marketPrice = price;

    // Emit price update event for real-time processing
    this.emit('priceUpdate', {
      price,
      volume,
      symbol: this.selectedAsset,
      timestamp: priceData.timestamp || Date.now(),
      historyLength: this.priceHistory.length
    });
  }

  // Calculate technical indicators for current price
  // ── Walk-Forward Optimization / Shadow Strategy ─────────────────────────
  // Called every SHADOW_EVAL_TRADES trades. Generates a shadow config with
  // tweaked RSI thresholds, replays the last N closed trades through both
  // the live and shadow settings, and promotes shadow if it's 20%+ better.

  // ── Forex session awareness (#21) ────────────────────────────────────────
  // ── Feature #4: DST-aware session detection ──────────────────────────────
  // Returns UTC offset adjustments for US and EU DST periods.
  // US DST: 2nd Sun March → 1st Sun November  (UTC-4 instead of UTC-5 = NY opens 1h earlier UTC)
  // EU DST: Last Sun March → Last Sun October  (BST: London 1h earlier UTC)
  _getDSTOffset() {
    const now = new Date();
    const year = now.getUTCFullYear();

    // US DST start: 2nd Sunday in March
    const usDSTStart = new Date(Date.UTC(year, 2, 1));
    usDSTStart.setUTCDate(1 + (7 - usDSTStart.getUTCDay() + 0) % 7 + 7); // 2nd Sunday
    // US DST end: 1st Sunday in November
    const usDSTEnd = new Date(Date.UTC(year, 10, 1));
    usDSTEnd.setUTCDate(1 + (7 - usDSTEnd.getUTCDay() + 0) % 7);

    // EU DST start: Last Sunday in March
    const euDSTStart = new Date(Date.UTC(year, 2, 31));
    while (euDSTStart.getUTCDay() !== 0) euDSTStart.setUTCDate(euDSTStart.getUTCDate() - 1);
    // EU DST end: Last Sunday in October
    const euDSTEnd = new Date(Date.UTC(year, 9, 31));
    while (euDSTEnd.getUTCDay() !== 0) euDSTEnd.setUTCDate(euDSTEnd.getUTCDate() - 1);

    const usInDST = now >= usDSTStart && now < usDSTEnd;
    const euInDST = now >= euDSTStart && now < euDSTEnd;
    return { usInDST, euInDST };
  }

  // Returns the dominant trading session based on UTC hour, DST-corrected.
  _currentSession() {
    const now = new Date();
    const h = now.getUTCHours();
    const { usInDST, euInDST } = this._getDSTOffset();

    // London session: normally 08:00–16:00 UTC; during BST shifts to 07:00–15:00 UTC
    const londonOpen  = euInDST ? 7 : 8;
    const londonClose = euInDST ? 15 : 16;

    // New York session: normally 13:00–21:00 UTC; during US DST shifts to 12:00–20:00 UTC
    const nyOpen  = usInDST ? 12 : 13;
    const nyClose = usInDST ? 20 : 21;

    const overlapOpen  = Math.max(londonOpen, nyOpen);
    const overlapClose = Math.min(londonClose, nyClose);  // Bug #9 fix: use actual nyClose not nyOpen+3

    if (h >= overlapOpen && h < overlapClose)  return 'LONDON_NY_OVERLAP';
    if (h >= nyOpen      && h < nyClose)        return 'NEW_YORK';
    if (h >= londonOpen  && h < londonClose)    return 'LONDON';
    return 'ASIAN';
  }

  _isGoodSession() {
    const s = this._currentSession();
    // Block new trades during Asian session (thin liquidity, wide spreads)
    if (s === 'ASIAN') return false;

    // ── Feature #89: Market holiday block ────────────────────────────────
    if (this.holidayCalendar) {
      const hol = this.holidayCalendar.check();
      if (hol.blocked) { this.log('🏖️ ' + hol.reason); return false; }
    }

    // ── Feature #75: Session transition entry filter ──────────────────────
    // Block new entries N minutes before a session boundary to avoid
    // the spread spikes and volatility that occur at transitions.
    const blockMins = TRADING_CONFIG.sessionTransitionBlockMins ?? 10;
    if (blockMins > 0) {
      const now  = new Date();
      const h    = now.getUTCHours();
      const m    = now.getUTCMinutes();
      const minOfDay = h * 60 + m;
      // Session close boundaries (UTC): London 13:00, NY_OVERLAP 16:00, NewYork 21:00, Asia 8:00
      const boundaries = [8 * 60, 13 * 60, 16 * 60, 21 * 60];
      for (const boundary of boundaries) {
        const minsToClose = boundary - minOfDay;
        if (minsToClose > 0 && minsToClose <= blockMins) {
          this.log(`[SessionFilter] ${minsToClose} min to session boundary (${boundary/60}:00 UTC) — entry blocked`);
          return false;
        }
      }
    }
    return true;
  }

  // ── Multi-asset opportunity scorer ───────────────────────────────────────
  // Called each tick when no position is open. Scores every configured asset
  // using leading-indicator bias and recent price momentum, returns the symbol
  // with the highest score. Falls back to current selectedAsset on a tie.
  _selectBestAsset() {
    const assets = TRADING_CONFIG.assets || ['EURUSD'];
    if (assets.length === 1) return assets[0];

    let best = this.selectedAsset, bestScore = -Infinity;

    for (const asset of assets) {
      // 1. Leading-indicator bias (BULLISH=+2, NEUTRAL=0, BEARISH=-2)
      const signal = this.leadingIndicators.analyse(asset);
      const liScore = signal.bias === 'BULLISH' ? 2 : signal.bias === 'BEARISH' ? -2 : 0;

      // Skip assets with a spike warning — too risky to enter
      if (signal.spike && signal.earlyExit) continue;

      // 2. Recent momentum from price history (positive % change = bullish)
      const hist = this.marketData.getPriceHistory(asset);
      let momScore = 0;
      if (hist.length >= 10) {
        const pctChg = (hist.at(-1) - hist.at(-10)) / hist.at(-10);
        momScore = pctChg > 0.0003 ? 1 : pctChg < -0.0003 ? -1 : 0;
      }

      // 3. Prefer assets not recently traded (cooldown avoids flip-flopping)
      const lastTradeAsset = this.trades.at(-1)?.asset;
      const recencyPenalty = lastTradeAsset === asset ? -0.5 : 0;

      const total = liScore + momScore + recencyPenalty;
      // Require minimum history before selecting (prevents trading on 2-bar history)
      if (!hist || hist.length < 60) { continue; }  // MIN_WARMUP_BARS = 60
      if (total > bestScore) { bestScore = total; best = asset; }
    }

    return best;
  }

    // ── Main trading loop ─────────────────────────────────────────────────────
  async runTradingLoop() {
    if (this.isRunning) { console.log('❌ Trading engine already running'); return; }
    this.isRunning = true;
    this._engineStartTime = Date.now();  // Bug #16 fix: record start time for no-trade alert
    this.log('🚀 Trading engine started');
    try { telegram.send('Aladdin engine started — capital $' + this.capital.toFixed(2), 'status'); } catch(_) {}  // B14: never crash on alert failure

    // ── Graceful shutdown handlers (#3) ──────────────────────────────────
    // SIGTERM = PM2 restart/stop. SIGINT = Ctrl-C.
    // Save open position and capital before exiting so crash reconciliation
    // can restore state cleanly on the next start.
    const _shutdown = (signal) => {
      this.log('[SHUTDOWN] ' + signal + ' received — saving state and stopping');
      this.isRunning = false;
      if (this.position) this.savePositionFile();
      this.saveTradesFile();
      try { telegram.send('Engine stopped (' + signal + ') — capital $' + this.capital.toFixed(2), 'status'); } catch(_) {}  // B14: never crash on alert failure
      try { auditLog.flushSync({ type:'SHUTDOWN', signal, capital: this.capital }); } catch(_) {}
      setTimeout(() => process.exit(0), 500);  // allow async saves to flush
    };
    // GC stale cooldown/halt entries every 10 minutes
    this._gcInterval = setInterval(() => {
      const now = Date.now();
      for (const k of Object.keys(this._slCooldownUntil))  if (this._slCooldownUntil[k]  < now) delete this._slCooldownUntil[k];
      for (const k of Object.keys(this._assetHaltedUntil)) if (this._assetHaltedUntil[k] < now) delete this._assetHaltedUntil[k];
    }, 600_000);

    process.once('SIGTERM', () => _shutdown('SIGTERM'));
    process.once('SIGINT',  () => _shutdown('SIGINT'));

    // ── Unhandled rejection guard (#1) ───────────────────────────────────
    // Catches any unhandled async throw in plugins, strategies, or API calls.
    // Logs it and continues — never silently crashes the engine.
    this._rejectionHandler = (reason) => {
      this.log('[UNHANDLED REJECTION] ' + (reason && reason.message || String(reason)));
      try { telegram.send('Unhandled rejection: ' + (reason && reason.message || 'unknown'), 'error'); } catch(_) {}  // B14: never crash on alert failure
    };
    process.on('unhandledRejection', this._rejectionHandler);
    this.deadMansSwitch.start();
    // Start weekly trade report scheduler
    if (process.env.BACKTEST_MODE !== 'true') {
      try { this.weeklyReport.start(); } catch(_) {}
      // Arm graceful shutdown handler
      try { this.gracefulShutdown.attach(this); } catch(_) {}
      // Start log pruner (trims JSONL files daily)
      try { this.logPruner.start(); } catch(_) {}
    }

    while (this.isRunning) {
      // ── Tick-level mutex ──────────────────────────────────────────────────
      // Prevents concurrent tick execution when a slow async operation
      // (Claude API call, ML inference) takes longer than tradingInterval.
      // Without this, the interval can fire a second tick while the first is
      // still awaiting getDecision() — both reach executeDecision() simultaneously.
      if (this._isTicking) {
      this._ticksDropped = (this._ticksDropped || 0) + 1;
      if (this._ticksDropped % 10 === 0)
        this.log('[TIMING] ' + this._ticksDropped + ' ticks dropped — AI/strategy taking longer than tick interval');
        this.log('[TICK SKIP] Previous tick still running — skipping interval');
        await new Promise(r => setTimeout(r, TRADING_CONFIG.tradingInterval));
        continue;
      }
      this._isTicking = true;
      try {
        this.deadMansSwitch.heartbeat();

        // Bug #94 fix: check autoRollback after each tick (uses live Sharpe vs backtest reference)
        if (this.autoRollback && this._lastBacktestSharpe != null && this.riskAdjusted) {
          try {
            const _liveSharpe = this.riskAdjusted.sharpe(20) || 0;
            const _rb = this.autoRollback.check?.(_liveSharpe, this._lastBacktestSharpe, this.trades);
            if (_rb?.shouldRollback) {
              this.log(`🔄 [AutoRollback] Sharpe declined ${this._lastBacktestSharpe.toFixed(2)} → ${_liveSharpe.toFixed(2)} — triggering rollback`);
              try { this.rollbackShadowConfig?.(); } catch(_) {}
            }
          } catch(_) {}
        }

        // ── Per-tick position monitoring ─────────────────────────────────
        if (this.position) {
          const _tickPx = this.priceHistory.at(-1);
          // Update MAE/MFE tracker
          try { this.maeMfe?.update(_tickPx); } catch(_) {}
          // Unrealized P&L alert (warns when floating loss exceeds threshold)
          try { this.unrealizedAlert?.check(this.position, _tickPx, this.selectedAsset); } catch(_) {}
          // Position age alert (warns when approaching force-close time)
          try { this.positionAgeAlert?.check(this.position, this.selectedAsset); } catch(_) {}
        }
        // Equity anomaly — record every tick
        try { this.equityAnomaly?.record(this.capital); } catch(_) {}

        // 2.3: Volatility-of-volatility filter — avoid trading when ATR itself is unstable
        {
          const _atrHistory = (this._atrHistory = this._atrHistory || []);
          if (this.lastATR > 0) {
            _atrHistory.push(this.lastATR);
            if (_atrHistory.length > 20) _atrHistory.shift();
          }
          if (_atrHistory.length >= 10) {
            const _atrMean = _atrHistory.reduce((s,v)=>s+v,0)/_atrHistory.length;
            const _atrVar  = _atrHistory.reduce((s,v)=>s+(v-_atrMean)**2,0)/_atrHistory.length;
            const _atrCV   = Math.sqrt(_atrVar) / (_atrMean || 1);  // coefficient of variation
            this._atrCV    = parseFloat(_atrCV.toFixed(4));
            const _maxCV   = TRADING_CONFIG.maxAtrCV || 0.5;
            if (_atrCV > _maxCV && !this._volVolWarned) {
              this._volVolWarned = true;
              this.log(`⚠️ [#2.3] Vol-of-vol spike: ATR CV=${(_atrCV*100).toFixed(1)}% > ${(_maxCV*100).toFixed(0)}% — reducing exposure`);
            } else if (_atrCV <= _maxCV) {
              this._volVolWarned = false;
            }
          }
        }
        // Fix #88: Alert when same signal fires N times consecutively with no entry (stuck gate)
        {
          const lastDecision = this._lastDecisionAction;
          const currentDecision = this._pendingDecisionAction;  // set in executeDecision
          if (currentDecision && currentDecision !== 'HOLD' && currentDecision === lastDecision) {
            this._consecutiveBlockedSignals = (this._consecutiveBlockedSignals || 0) + 1;
            if (this._consecutiveBlockedSignals >= (TRADING_CONFIG.consecutiveBlockedAlertN || 10)) {
              const msg = `⚠️ [Fix #88] Signal "${currentDecision}" blocked ${this._consecutiveBlockedSignals}× in a row — gate may be stuck`;
              this.log(msg);
              try { require('./telegram').send(msg, 'risk'); } catch(_) {}
              this._consecutiveBlockedSignals = 0;  // reset after alert
            }
          } else {
            this._consecutiveBlockedSignals = 0;
          }
        }
        // v12 3.4: Tail risk check every tick
        if (this.priceHistory.length >= 30) {
          const tailCheck = this.tailRisk?.check(this.priceHistory.slice(-30));
          if (tailCheck?.tailRisk) {
            this._tailRiskMult = tailCheck.sizeMultiplier;
          } else {
            this._tailRiskMult = 1.0;
          }
        }
        // A5: Drawdown early warning — alert at 80% of limit (not just at 100%)
        {
          const _eLim = Math.min(TRADING_CONFIG.globalDrawdownLimit || 0.20, require('./safety-constants').SAFETY.MAX_GLOBAL_DRAWDOWN_PCT);
          const _eDD  = this.initialCapital > 0 ? (this.initialCapital - this.capital) / this.initialCapital : 0;
          const _warn80 = _eLim * 0.80;
          if (_eDD >= _warn80 && _eDD < _eLim && !this._ddWarn80Fired) {
            this._ddWarn80Fired = true;
            const msg = `⚠️ [A5] Drawdown ${(_eDD*100).toFixed(2)}% is 80% of limit ${(_eLim*100).toFixed(1)}% — consider reducing exposure`;
            this.log(msg);
            try { require('./telegram').send(msg, 'risk'); } catch(_) {}
          } else if (_eDD < _warn80) {
            this._ddWarn80Fired = false;  // re-arm after recovery
          }
        }
            // Item 73: Realised vs expected vol divergence alert
        {
          if (this.priceHistory.length >= 12) {
            const _rets73  = this.priceHistory.slice(-12).map((v,i,a)=>i?Math.abs(v-a[i-1])/a[i-1]:0).slice(1);
            const _realVol73 = Math.sqrt(_rets73.reduce((s,v)=>s+v**2,0)/_rets73.length);
            const _implVol73 = (this.lastATR||0.001) / (this.priceHistory.at(-1)||1) / Math.sqrt(12);
            const _ratio73   = _implVol73 > 0 ? _realVol73 / _implVol73 : 1;
            if (_ratio73 > 2.0 && !this._volDivergenceAlerted) {
              this._volDivergenceAlerted = true;
              this.log(`⚠️ [Item 73] Vol divergence: realised=${(_realVol73*100).toFixed(2)}% vs implied=${(_implVol73*100).toFixed(2)}% (${_ratio73.toFixed(1)}×)`);
              try { require('./telegram').send(`⚠️ Vol divergence: realised ${_ratio73.toFixed(1)}× > implied — fat tail event?`, 'risk'); } catch(_) {}
            } else if (_ratio73 < 1.5) this._volDivergenceAlerted = false;
          }
        }
        // Item 70: Cross-asset crisis detector (XAU spike or DXY spike → risk-off)
        {
          if (!this._crisisHistory70) this._crisisHistory70 = { xau:[], dxy:[] };
          const _xauPrice = this._lastXAUPrice || 0;
          const _dxyMove  = this._lastDXYChange || 0;
          // Bug #15 fix: check BOTH XAU move AND DXY move for crisis
          if (!this._crisisHistory70.xau) this._crisisHistory70.xau = [];
          this._crisisHistory70.xau.push({ price: _xauPrice, ts: Date.now() });
          if (this._crisisHistory70.xau.length > 12) this._crisisHistory70.xau.shift();
          const _xauOld = this._crisisHistory70.xau[0]?.price || _xauPrice;
          const _xauMove = _xauOld > 0 ? Math.abs(_xauPrice - _xauOld) / _xauOld : 0;
          const _isXAUCrisis = Math.abs(_dxyMove) > 0.015 || _xauMove > 0.02;
          if (_isXAUCrisis && !this._crisisActive70) {
            this._crisisActive70 = true;
            this.log(`🔴 [Item 70] Cross-asset crisis detected — DXY spike ${(_dxyMove*100).toFixed(2)}% | XAU move ${(_xauMove*100).toFixed(2)}%`);
            try { require('./telegram').send('🔴 Crisis detector: DXY spike > 1.5% — sizes reduced 50%, stops widened 25%', 'halt'); } catch(_) {}
            if (this._crisis70Timer) clearTimeout(this._crisis70Timer);
            this._crisis70Timer = setTimeout(() => { this._crisisActive70 = false; this._crisis70Timer = null; }, 3_600_000);
            this._crisis70Timer.unref();  // Bug #54 fix: stored so stop() can cancel it
          }
        }
        // Item 62: Drawdown velocity alert — 1% drop in 30 min triggers pause + alert
        {
          if (!this._ddVelocityHistory) this._ddVelocityHistory = [];
          this._ddVelocityHistory.push({ capital: this.capital, ts: Date.now() });
          // Keep only last 30 minutes of snapshots
          const _30minAgo = Date.now() - 30*60_000;
          this._ddVelocityHistory = this._ddVelocityHistory.filter(s=>s.ts>_30minAgo);
          if (this._ddVelocityHistory.length >= 2) {
            const _oldest = this._ddVelocityHistory[0];
            const _ddVel  = (_oldest.capital - this.capital) / _oldest.capital;
            const _thresh = TRADING_CONFIG.ddVelocityThreshold || 0.01;
            if (_ddVel > _thresh && !this._ddVelocityPaused) {
              this._ddVelocityPaused = true;
              this.log(`🛑 [Item 62] Drawdown velocity: ${(_ddVel*100).toFixed(2)}% in 30min — pausing 1h`);
              try { require('./telegram').send(`🛑 Rapid drawdown: ${(_ddVel*100).toFixed(2)}% in 30min — paused 1h`, 'halt'); } catch(_) {}
              if (this._ddVelocityTimer) clearTimeout(this._ddVelocityTimer);
          this._ddVelocityTimer = setTimeout(() => { this._ddVelocityPaused = false; this._ddVelocityTimer = null; }, 3_600_000);
          this._ddVelocityTimer.unref();  // Bug #55 fix: stored so stop() can cancel it
            }
          }
        }
        // 3.4: Tail risk detector — detect return kurtosis spikes, reduce exposure
        {
          if (this.priceHistory.length >= 30) {
            const rets = [];
            for (let i = 1; i < Math.min(30, this.priceHistory.length); i++) {
              rets.push((this.priceHistory.at(-i) - this.priceHistory.at(-i-1)) / this.priceHistory.at(-i-1));
            }
            const n    = rets.length;
            const mean = rets.reduce((s,v)=>s+v,0)/n;
            const m2   = rets.reduce((s,v)=>s+(v-mean)**2,0)/n;
            const m4   = rets.reduce((s,v)=>s+(v-mean)**4,0)/n;
            const kurt = m2 > 0 ? m4/(m2**2) - 3 : 0;  // excess kurtosis
            this._excessKurtosis = parseFloat(kurt.toFixed(3));
            const kurtThresh = TRADING_CONFIG.tailRiskKurtThreshold || 3.0;
            if (kurt > kurtThresh && !this._tailRiskActive) {
              this._tailRiskActive = true;
              this.log(`⚠️ [#3.4] Tail risk: excess kurtosis ${kurt.toFixed(2)} > ${kurtThresh} — exposure reduced`);
              try { require('./telegram').send(`⚠️ Tail risk kurtosis spike: ${kurt.toFixed(2)}`, 'risk'); } catch(_) {}
            } else if (kurt <= kurtThresh) {
              this._tailRiskActive = false;
            }
          }
        }
        // A15: Portfolio heat — total % capital at risk across open positions
        {
          const openValue = this.position
            ? (this.position.shares * (this.priceHistory.at(-1)||1))
            : 0;
          const heat = this.capital > 0 ? openValue / this.capital : 0;
          this._portfolioHeat = parseFloat((heat * 100).toFixed(2));
          const maxHeat = TRADING_CONFIG.maxPortfolioHeat || 20;  // default 20% max open exposure
          if (heat * 100 > maxHeat && !this._heatAlerted) {
            this._heatAlerted = true;
            const msg = `⚠️ [A15] Portfolio heat ${this._portfolioHeat}% > ${maxHeat}% limit`;
            this.log(msg);
            try { require('./telegram').send(msg, 'risk'); } catch(_) {}
          } else if (heat * 100 <= maxHeat) {
            this._heatAlerted = false;
          }
        }
        // Fix #59: Clearly distinguish HALTED vs IDLE
        {
          const haltState59 = this.globalHaltTripped ? 'GLOBAL_HALT'
            : this.circuitBreakerTripped ? 'CIRCUIT_BREAKER'
            : (this.flashCrashHaltUntil||0) > Date.now() ? 'FLASH_CRASH_HALT'
            : (this.dailyLockoutUntil||0) > Date.now() ? 'DAILY_LOCKOUT' : null;
          if (haltState59 !== this._lastReportedHaltState59) {
            this._lastReportedHaltState59 = haltState59;
            if (haltState59) {
              try { require('./telegram').send(`🛑 ENGINE: ${haltState59} (risk-triggered halt — not idle)`, 'risk'); } catch(_) {}
            } else if (this._lastReportedHaltState59 !== undefined) {
              try { require('./telegram').send('✅ ENGINE: Halt cleared — resuming', 'status'); } catch(_) {}
            }
          }
        }
        // ── Feature #18: No-trade alert (silent block detection) ──────────
        // Detects when the loop runs but entries are silently blocked (news filter,
        // sector cap, stuck state). Different from deadMansSwitch (loop crash).
        {
          const noTradeHours = TRADING_CONFIG.noTradeAlertHours || 4;
          const noTradeMs    = noTradeHours * 3600_000;
          const lastTrade    = this.trades.length > 0
            ? (this.trades[this.trades.length - 1].timestamp
                ? new Date(this.trades[this.trades.length - 1].timestamp).getTime()
                : Date.now())
            : (this._engineStartTime || Date.now());
          if (!this._noTradeAlertFired && Date.now() - lastTrade > noTradeMs && !this.position) {
            this._noTradeAlertFired = true;
            const hrs = ((Date.now() - lastTrade) / 3600_000).toFixed(1);
            const msg = `⚠️ No trade in ${hrs}h — engine loop running but all entries blocked (check news filter, sector cap, session, confidence)`;
            this.log(msg);
            try { telegram.send(msg, 'risk'); } catch(_) {}
          }
          // Re-arm after a trade closes (treat missing timestamp as now — assume recent)
          if (this._noTradeAlertFired && this.trades.length > 0) {
            const lastT = this.trades[this.trades.length - 1];
            const lastTMs = lastT.timestamp ? new Date(lastT.timestamp).getTime() : Date.now();
            if (Date.now() - lastTMs < 60_000) this._noTradeAlertFired = false;
          }
        }

        // Fix #85: Daily reset aligned to forex day rollover (17:00 New York time)
        // not UTC midnight. The forex business day resets at 17:00 ET = 21:00 UTC winter / 22:00 UTC summer.
        // The bot's daily loss counter was resetting 1-5 hours before the forex day boundary.
        const now85    = new Date();
        const utcH     = now85.getUTCHours();
        const utcM     = now85.getUTCMinutes();
        // Detect US DST: 2nd Sun Mar → 1st Sun Nov
        const { usInDST: usInDST85 } = this._getDSTOffset ? this._getDSTOffset() : { usInDST: false };
        const dayRolloverUTC = usInDST85 ? 21 : 22;  // 17:00 ET in UTC
        // Build a forex day key that changes at rollover hour
        const forexDayKey = utcH >= dayRolloverUTC
          ? now85.toISOString().slice(0, 10) + 'T' + dayRolloverUTC
          : new Date(now85 - 86_400_000).toISOString().slice(0, 10) + 'T' + dayRolloverUTC;
        if (this._lastForexDay && this._lastForexDay !== forexDayKey) {
          this.dailyStartCapital = this.capital;
          this._clearDailyLockout();
          this.log(`[Day Reset #85] New forex day at ${dayRolloverUTC}:00 UTC — dailyStartCapital = $${this.capital.toFixed(2)}`);
        }
        this._lastForexDay = forexDayKey;

        // ── Asset selection: pick best opportunity when no position is open ──
        if (!this.position) {
          // B15: Guard _selectBestAsset so it doesn't race with indicator computation
          // If _isTicking is true somehow (re-entrancy), skip asset reselection this bar
          const best = await this._selectBestAsset();  // async after engine-wiring patches it
          if (best !== this.selectedAsset) {
            this.log('[Asset Switch] ' + this.selectedAsset + ' -> ' + best);
            this.selectedAsset = best.replace(/_/g, '');
          }
        }

                // ── Fetch real live price (Alpha Vantage → cached flat price) ──
        // Fix #19: Refresh ALL tracked assets in parallel so no asset is stale.
        // Previously GBPUSD was priced 2+ seconds stale after EURUSD processing.
        // Fix #49: Degraded mode — detect slow broker API (>5s) and reduce exposure
        const _apiStart = Date.now();
        const _allAssets = TRADING_CONFIG.assets || [this.selectedAsset];
        await Promise.all(_allAssets.map(a => this.marketData.refreshPrice(a).catch(() => {})));
        this._lastPriceAt = Date.now();  // A4: stamp for staleness check
        // Item 8: Update GARCH with latest return
        if (this.garch && this.priceHistory.length >= 2) {
          const p1 = this.priceHistory.at(-1), p2 = this.priceHistory.at(-2);
          if (p2 > 0) this.garch.update((p1-p2)/p2);
        }
        const _apiMs = Date.now() - _apiStart;
        const _degradeMs = TRADING_CONFIG.degradedApiThresholdMs || 5000;
        if (_apiMs > _degradeMs) {
          if (!this._degradedMode) {
            this._degradedMode = true;
            this.log(`[Fix #49] Slow API ${_apiMs}ms > ${_degradeMs}ms — degraded mode (size×0.5, minConf+10)`);
            try { require('./telegram').send(`⚠️ API slow (${_apiMs}ms) — degraded trading mode active`, 'risk'); } catch(_) {}
          }
        } else if (this._degradedMode && _apiMs < _degradeMs / 2) {
          this._degradedMode = false;
          this.log('[Fix #49] API response normal — degraded mode cleared');
        }
        const marketData = this.marketData.fetchPrice(this.selectedAsset);
        this.priceHistory  = marketData.history;
        this.volumeHistory = marketData.volumeHistory;

        // BUG-78 fix: only ping staleDataMonitor when we got a FRESH price (not a cached fallback)
        // 'cache' and 'simulation' sources mean the fetch failed and we're using stale data
        const priceSource = this.marketData.prices?.[this.selectedAsset]?.source;
        const isFreshPrice = priceSource && priceSource !== 'cache' && priceSource !== 'simulation';
        if (isFreshPrice) this.staleDataMonitor.ping();

        // ── Orderflow, sentiment, price divergence, timeseries ────────────
        const curP = this.priceHistory.at(-1) || 0;
        const curV = this.volumeHistory.at(-1) || 0;
        const prevP = this.priceHistory.at(-2) || curP;
        this.orderFlow.update(curP, curV, prevP);
        this.priceDivergence.record(this.selectedAsset, 'primary', curP);
        // BUG-57 fix: also record from alphavantage source when available so analyse() can compare
        // marketData keeps the last source tag — use it to feed the second slot
        const lastSource = this.marketData.prices?.[this.selectedAsset]?.source;
        if (lastSource && lastSource !== 'primary' && lastSource !== 'cache') {
          this.priceDivergence.record(this.selectedAsset, 'alphavantage', curP);
        }
        // Fix #73: Validate staleness of leading indicator data before use
        const _sentimentAge = Date.now() - this._sentimentFetchedAt;
        if (_sentimentAge > 6 * 3600_000 && this._sentimentFetchedAt > 0) {
          this.log(`⚠️ [Fix #73] Sentiment data is ${(_sentimentAge/3600_000).toFixed(1)}h stale — may be unreliable`);
        }
        // Refresh sentiment every 30 min (non-blocking)
        this.sentiment.refresh().catch(() => {});
        // BUG-45 fix: throttle socialTracker to every 30 min (was every tick) and
        // store the result so calculateIndicators() can consume it.
        const now30 = Date.now();
        if (!this._lastSocialRefresh || now30 - this._lastSocialRefresh > 30 * 60_000) {
          this._lastSocialRefresh = now30;
          this.socialTracker.refresh()
            .then(() => { this._lastSocialScore = this.socialTracker.getScore?.(this.selectedAsset); })
            .catch(() => {});
        }

        // Record price for cross-exchange divergence + hedge framework
        this.hedgeFramework.recordPrice(this.selectedAsset, 'primary', curP);
        // Write price + metrics to time-series store
        timeseriesStore.writePrice(this.selectedAsset, {
          price: curP, volume: curV,
          bid: marketData.bid, ask: marketData.ask,
        });
        timeseriesStore.writeMetric({
          capital: this.capital,
          drawdown: this.initialCapital > 0 ? (this.initialCapital - this.capital) / this.initialCapital : 0,
          winRate: this.trades.length > 0 ? this.wins / this.trades.length : 0,
          openTrades: this.position ? 1 : 0,
        });

        // ── Feature #6: Update session drawdown guard every tick ──────────
        this.sessionDrawdown.update(this.capital);

        await this.checkRiskManagement();

        const feedStale = this.staleDataMonitor.isStale();

        this._checkCircuitBreakerExpiry();
        if (!this.circuitBreakerTripped && !this.apiCallInProgress && !feedStale) {
          const indicators = await this.calculateIndicators();
          if (!indicators) {
            await new Promise(r => setTimeout(r, TRADING_CONFIG.tradingInterval));
            continue;
          }

          // ── Staleness gate ────────────────────────────────────────────────
          // computedAt is stamped by normaliseIndicators(). If the indicators
          // are older than maxIndicatorAgeMs (default 60s), something in the
          // pipeline stalled — skip this tick to avoid trading on stale data.
          const indicatorAge = Date.now() - (indicators.computedAt || 0);
          const maxAge = TRADING_CONFIG.maxIndicatorAgeMs || 60_000;
          if (indicators.computedAt && indicatorAge > maxAge) {
            this.log('[STALE] Indicators are ' + (indicatorAge/1000).toFixed(1) + 's old (max ' + (maxAge/1000) + 's) — skipping tick');
            await new Promise(r => setTimeout(r, TRADING_CONFIG.tradingInterval));
            continue;
          }

          // Feature #23: Stamp matrix with build time for staleness checking
          this.correlationMatrix = CorrelationEngine.buildMatrix(
            this.marketData.priceHistories, TRADING_CONFIG.correlationPeriod
          );
          this._corrMatrixBuiltAt = Date.now();

          // ── Per-tick housekeeping ───────────────────────────────────────
          // Rebalance capital allocator based on recent strategy performance
          this.capitalAllocator.rebalanceIfDue();


        // Item 88: System resource monitor — alert on high heap or event loop lag
    if (process.env.BACKTEST_MODE !== 'true' && !this._resourceMonitor88) {
      this._resourceMonitor88 = setInterval(() => {
        const m = process.memoryUsage();
        const heapPct = m.heapUsed / m.heapTotal * 100;
        if (heapPct > 92) {
          this.log(`⚠️ [Item 88] High heap: ${heapPct.toFixed(1)}% — triggering GC`);
          if (global.gc) global.gc();
        }
        const t = Date.now();
        setImmediate(() => {
          const lag = Date.now() - t;
          if (lag > 150) {
            this.log(`⚠️ [Item 88] Event loop lag: ${lag}ms`);
            try { require('./telegram').send(`⚠️ Event loop lag ${lag}ms`, 'risk'); } catch(_) {}
          }
        });
      }, 60_000).unref();
    }
    // Item 93: Live vs backtest deviation alert — every 20 trades
        if (!this._deviation93Watcher) {
          let _lastCheck93 = 0;
          this._deviation93Watcher = setInterval(() => {
            if ((this.trades||[]).length - _lastCheck93 < 20) return;
            _lastCheck93 = (this.trades||[]).length;
            try {
              const _live93  = (this.trades||[]).slice(-20);
              const _rets    = _live93.map(t=>t.profitPercent||0);
              const _mean    = _rets.reduce((s,v)=>s+v,0)/_rets.length;
              const _std     = Math.sqrt(_rets.reduce((s,v)=>s+(_mean-v)**2,0)/_rets.length)||1e-6;
              const _liveSharpe = _mean/_std;
              const _btSharpe   = this._lastBacktestSharpe || _liveSharpe;
              const _deviation  = Math.abs(_liveSharpe - _btSharpe) / Math.abs(_btSharpe||1);
              if (_deviation > 1.0 && Math.abs(_btSharpe) > 0.1) {
                const msg93 = `⚠️ [Item 93] Live Sharpe ${_liveSharpe.toFixed(2)} deviates >1σ from backtest ${_btSharpe.toFixed(2)}`;
                this.log(msg93);
                try { require('./telegram').send(msg93,'risk'); } catch(_) {}
              }
            } catch(_) {}
          }, 300_000).unref();
        }
          // Push current OHLCV bar into ML OHLCV buffer (needed by transformer)
          // BUG-51 fix: marketData.ohlcvHistories never exists — use this.ohlcvHistory which IS populated
          const latestOHLCV = (this.ohlcvHistory && this.ohlcvHistory.length > 0)
            ? this.ohlcvHistory.at(-1)
            : { o: curP, h: curP, l: curP, c: curP, v: curV };
          this.mlConfidence.pushOHLCV({ ...latestOHLCV, rsi: indicators.rsi });
          // Cap ohlcvHistory to prevent unbounded RAM growth
          // B17: Keep exactly 500 bars (length-500 splice is correct — splice removes length-500 items, leaving 500)
          if (this.ohlcvHistory && this.ohlcvHistory.length > 1000) {
            this.ohlcvHistory.splice(0, this.ohlcvHistory.length - 500);  // B17: leaves exactly 500 bars
          }

          // Pass session to strategy context for session-adaptive routing (#3)
          indicators._session = this._currentSession();
          this.lastIndicators = indicators;  // BUG-50 fix: persist so enterPosition can read sr for TP override
          const decision = await this.getDecision(indicators);
          // Audit every decision — builds immutable trace of all tick activity
          auditLog.record({
            type:       'DECISION',
            asset:      this.selectedAsset,
            action:     decision.action,
            confidence: decision.confidence,
            reason:     decision.reason || decision.reasoning,
            aiOverride: decision.aiOverride || false,
            price:      this.priceHistory.at(-1),
            rsi:        indicators.rsi,
            signal:     indicators.signal,
            adxRegime:  indicators.adxRegime,
            session:    this._currentSession(),
            capital:    parseFloat(this.capital.toFixed(2)),
            hasPosition: !!this.position,
            strategy:   decision.strategyName || 'ensemble',
            symbol:     this.selectedAsset,
            timeframe:  indicators._primaryTimeframe || indicators._session?.includes('D1') ? 'D1' : indicators.adxRegime?.source || 'M5',
          });
          // Fix #62: Formal Signal→Filter→Size→Execute pipeline stages (documented)
          // Stage 1: Signal   — decision from getDecision() above
          // Stage 2: Filter   — risk gates in executeDecision (session, drawdown, news, etc.)
          // Stage 3: Size     — Kelly/vol sizing in enterPosition/enterShort
          // Stage 4: Execute  — TWAP/market fill via exchange interface
          await this.executeDecision(decision);

          if (TRADING_CONFIG.autoTrainFrequency > 0 &&
              this.trades.length >= this.lastShadowEval + this.SHADOW_EVAL_TRADES) {
            // Check if recent promotion hurt performance → rollback
            if (this._prePromotionConfig && this._promotionTradeCount) {
              const postTrades = this.trades.slice(this._promotionTradeCount);
              if (postTrades.length >= 10) {
                const postPF = this._calcProfitFactor(postTrades);
                const preTrades = this.trades.slice(Math.max(0, this._promotionTradeCount - 50), this._promotionTradeCount);
                const prePF = this._calcProfitFactor(preTrades);
                if (postPF < prePF * 0.85) {
                  Object.assign(TRADING_CONFIG, this._prePromotionConfig);
                  this._prePromotionConfig = null;
                  this.log('[SHADOW ROLLBACK] Post-promotion PF ' + postPF.toFixed(2) + ' < pre-promotion ' + prePF.toFixed(2) + ' — reverted');
                  try { telegram.send('Shadow strategy rolled back — performance degraded', 'status'); } catch(_) {}  // B14: never crash on alert failure
                } else {
                  this._prePromotionConfig = null;  // promotion holding — clear rollback
                }
              }
            }
            await this.trainModel();

            // ── Walk-forward decay detection (#19) ─────────────────────────
            // Check if OOS performance is declining across folds
            if (this.shadowLog && this.shadowLog.length >= 3) {
              const recent = this.shadowLog.slice(-3);
              const declining = recent.every((r, i) => i === 0 || r.newPF < recent[i-1].newPF);
              if (declining) {
                const lastPF = recent[recent.length-1].newPF;
                this.log('[DECAY] Strategy performance declining over last 3 evals — last PF=' + lastPF.toFixed(2));
                // Reduce position sizing by 30% when decaying
                this._decayMultiplier = 0.70;
                try { telegram.send('⚠️ Strategy decay detected — PF=' + lastPF.toFixed(2) + ' reducing size to 70%', 'status'); } catch(_) {}  // B14: never crash on alert failure
              } else {
                this._decayMultiplier = 1.0;
              }
            }
          }
        }

        if (this.clientCallback) {
          this.clientCallback({ type: 'trading_update', engine: this.getStatus() });
        }

        await new Promise(r => setTimeout(r, TRADING_CONFIG.tradingInterval));
        this._lastLoopError = false;  // clean tick
        // Bug #8 fix: don't reset counter here — let finally block do it to avoid double-reset

      } catch (err) {
        // Bug fix: err.message is undefined when non-Error objects are thrown
        // (strings, plain objects, etc.) — normalize to always get a message.
        const errMsg = (err instanceof Error)
          ? err.message
          : (typeof err === 'string' ? err : JSON.stringify(err));
        const errStack = (err instanceof Error && err.stack) ? err.stack : '';
        this.log(`❌ Trading loop error: ${errMsg}`);
        // Log full stack in development, summarized in production
        if (process.env.NODE_ENV !== 'production') {
          console.error('Trading loop error:', errStack || err);
        } else {
          console.error('Trading loop error:', errMsg);
        }
        // Backoff: if errors are rapid (network storm), avoid spinning at full speed
        this._lastLoopError = true;  // Bug #8 fix: mark error so finally doesn't reset counter
        this._consecutiveLoopErrors = (this._consecutiveLoopErrors || 0) + 1;
        if (this._consecutiveLoopErrors >= 5) {
          const backoffMs = Math.min(30_000, this._consecutiveLoopErrors * 2000);
          this.log(`⚠️ ${this._consecutiveLoopErrors} consecutive errors — backing off ${backoffMs/1000}s`);
          await new Promise(r => setTimeout(r, backoffMs));
        }
      } finally {
        this._isTicking = false;  // always release mutex, even on error
        if (!this._lastLoopError) this._consecutiveLoopErrors = 0;  // reset on clean tick
        this._lastLoopError = false;
      }
    }

    this.log('⏹️ Trading engine stopped');
    try { telegram.send('Aladdin engine stopped', 'status'); } catch(_) {}  // B14: never crash on alert failure
    this.deadMansSwitch.stop();
  }

  async trainModel() {
    if (this.trades.length < 10) return;
    if (this.trades.length < this.lastShadowEval + this.SHADOW_EVAL_TRADES) return;

    this.lastShadowEval = this.trades.length;
    this.modelEpochs++;

    this.log(`🔬 Walk-Forward Optimization: evaluating shadow strategy (epoch ${this.modelEpochs})…`);

    // ── Generate shadow candidate settings ─────────────────────────────
    // Mutate RSI, confidence, stops, TP, MTA alignment — 6 candidates (#11 fix).
    const candidates = [
      { rsiBuyStrong: 40, rsiBuyNormal: 45, minConfidence: 65, stopLoss: 0.018, takeProfit: 0.055, mtaMinAlignment: 0.58, label: 'Tighter RSI' },
      { rsiBuyStrong: 50, rsiBuyNormal: 55, minConfidence: 55, stopLoss: 0.022, takeProfit: 0.045, mtaMinAlignment: 0.50, label: 'Looser RSI'  },
      { rsiBuyStrong: 45, rsiBuyNormal: 52, minConfidence: 62, stopLoss: 0.020, takeProfit: 0.050, mtaMinAlignment: 0.55, label: 'Balanced'    },
      { rsiBuyStrong: 42, rsiBuyNormal: 48, minConfidence: 63, stopLoss: 0.015, takeProfit: 0.060, mtaMinAlignment: 0.60, label: 'Wider TP'    },
      { rsiBuyStrong: 48, rsiBuyNormal: 53, minConfidence: 58, stopLoss: 0.025, takeProfit: 0.040, mtaMinAlignment: 0.52, label: 'Tight SL'    },
      { rsiBuyStrong: 44, rsiBuyNormal: 50, minConfidence: 60, stopLoss: 0.020, takeProfit: 0.050, mtaMinAlignment: 0.65, label: 'Strict MTA'  },
    ];

    // Use the last 50 trades as evaluation window
    const evalTrades = this.trades.slice(-50);
    if (evalTrades.length < 5) return;

    // ── Score: profit factor of live settings (baseline) ───────────────
    // Filter by current minConfidence so the comparison is apples-to-apples
    // with candidate thresholds — prevents selection bias from inflating PF.
    const currentMinConf = TRADING_CONFIG.minConfidence || 60;
    const liveFilteredTrades = evalTrades.filter(t => (t.confidence || 70) >= currentMinConf);
    const livePF = liveFilteredTrades.length >= 3
      ? this._calcProfitFactor(liveFilteredTrades)
      : this._calcProfitFactor(evalTrades);

    // ── Score each candidate by replaying trades ────────────────────────
    let bestCandidate = null;
    let bestPF        = livePF;

    for (const candidate of candidates) {
      // Filter which trades would have been taken under candidate settings
      // (trades with confidence >= candidate.minConfidence are kept;
      //  RSI thresholds affect signal quality but we approximate using
      //  the recorded confidence as a proxy — higher threshold = fewer trades)
      const filteredTrades = evalTrades.filter(t => {
        const conf = t.confidence || 70;
        return conf >= candidate.minConfidence;
      });

      if (filteredTrades.length < 3) continue;

      const candidatePF = this._calcProfitFactor(filteredTrades);
      candidate.pf      = candidatePF;
      candidate.trades  = filteredTrades.length;

      if (candidatePF > bestPF) {
        bestPF        = candidatePF;
        bestCandidate = candidate;
      }
    }

    const improvement = livePF > 0 ? ((bestPF - livePF) / livePF) * 100 : 0;

    this.log(
      `🔬 Shadow Eval — Live PF: ${livePF.toFixed(3)} | ` +
      `Best candidate: "${bestCandidate ? bestCandidate.label : 'none'}" ` +
      `PF: ${bestPF.toFixed(3)} | Improvement: ${improvement.toFixed(1)}%`
    );

    // ── Promote if improvement >= 20% ──────────────────────────────────
    if (bestCandidate && improvement >= 20) {
      const old = {
        minConfidence: TRADING_CONFIG.minConfidence,
      };

      // Apply the winning candidate settings to live config
      // Snapshot current config for rollback before mutating
      const _rollbackConfig = {
        minConfidence:  TRADING_CONFIG.minConfidence,
        stopLoss:       TRADING_CONFIG.stopLoss,
        takeProfit:     TRADING_CONFIG.takeProfit,
        mtaMinAlignment:TRADING_CONFIG.mtaMinAlignment,
      };
      this._prePromotionConfig  = _rollbackConfig;   // used by auto-rollback check in main loop
      this._promotionTradeCount = this.trades.length; // bookmark trade index for post-eval

      TRADING_CONFIG.minConfidence  = bestCandidate.minConfidence;
      if (bestCandidate.stopLoss)        TRADING_CONFIG.stopLoss        = bestCandidate.stopLoss;
      if (bestCandidate.takeProfit)      TRADING_CONFIG.takeProfit      = bestCandidate.takeProfit;
      if (bestCandidate.mtaMinAlignment) TRADING_CONFIG.mtaMinAlignment = bestCandidate.mtaMinAlignment;

      this.shadowSettings = bestCandidate;
      this.log('[SHADOW] Config promoted — rollback snapshot saved');
      this.shadowLog.push({
        epoch:       this.modelEpochs,
        timestamp:   new Date().toISOString(),
        livePF:      parseFloat(livePF.toFixed(3)),
        newPF:       parseFloat(bestPF.toFixed(3)),
        improvement: parseFloat(improvement.toFixed(1)),
        promoted:    bestCandidate.label,
        oldSettings: old,
        newSettings: { minConfidence: bestCandidate.minConfidence },
      });

      // Persist shadow log to disk for audit trail
      try {
        const logPath = path.join(__dirname, 'trade_logs', 'shadow-strategy.json');
        fs.writeFileSync(logPath, JSON.stringify(this.shadowLog, null, 2));
      } catch (e) { /* non-fatal */ }

      // Log to experiment tracker (MLflow-compatible)
      try {
        const run = process.env.BACKTEST_MODE !== 'true' ? expTracker.startRun('shadow-strategy', bestCandidate) : { id: 'backtest-noop', log:()=>{}, end:()=>{} };
        run.logMetric('livePF',      livePF);
        run.logMetric('promotedPF',  bestPF);
        run.logMetric('improvement', improvement);
        run.end('PROMOTED');
      } catch (_) {}

      this.log(
        `✅ SHADOW PROMOTION: "${bestCandidate.label}" is ${improvement.toFixed(1)}% better — ` +
        `live config updated: minConfidence ${old.minConfidence} → ${bestCandidate.minConfidence}`
      );
    } else {
      this.log(`📊 Shadow eval complete — live strategy retained (improvement ${improvement.toFixed(1)}% < 20% threshold)`);
    }
  }

  _calcProfitFactor(trades) {
    const wins   = trades.filter(t => t.profit > 0);
    const losses = trades.filter(t => t.profit <= 0);
    const gross  = wins.reduce((s, t) => s + t.profit, 0);
    const loss   = Math.abs(losses.reduce((s, t) => s + t.profit, 0));
    return loss > 0 ? gross / loss : gross > 0 ? 99 : 0;
  }

  // ── Rollback shadow strategy promotion ──────────────────────────────────
  rollbackShadowConfig() {
    const r = this._shadowRollback || this._prePromotionConfig;  // Bug #3 fix: snapshot saved as _prePromotionConfig
    if (!r) { this.log('[SHADOW] No rollback snapshot available'); return; }
    TRADING_CONFIG.minConfidence  = r.minConfidence;
    TRADING_CONFIG.stopLoss       = r.stopLoss;
    TRADING_CONFIG.takeProfit     = r.takeProfit;
    TRADING_CONFIG.mtaMinAlignment = r.mtaMinAlignment;
    this._shadowRollback = null;
    this.log('[SHADOW] Rolled back to pre-promotion config');
  }

  stop() {
    this.isRunning = false;
    // Remove unhandledRejection handler registered in runTradingLoop
    if (this._rejectionHandler) {
      process.removeListener('unhandledRejection', this._rejectionHandler);
      this._rejectionHandler = null;
    }
    // Bug #52 fix: clear all background timers/intervals on stop
    try { this.weeklyReport?.stop?.(); } catch(_) {}
    try { this.logPruner?.stop?.(); } catch(_) {}
    try { this.gracefulShutdown?._timer && clearInterval(this.gracefulShutdown._timer); } catch(_) {}
    if (this._resourceMonitor88) { clearInterval(this._resourceMonitor88); this._resourceMonitor88 = null; }  // Bug #56 fix
    if (this._deviation93Watcher) { clearInterval(this._deviation93Watcher); this._deviation93Watcher = null; }  // Bug #57 fix
    if (this._gcInterval)       { clearInterval(this._gcInterval);       this._gcInterval = null; }       // Bug #58 fix
    if (this._crisis70Timer)    { clearTimeout(this._crisis70Timer);     this._crisis70Timer = null; }    // Bug #54 fix
    if (this._ddVelocityTimer)  { clearTimeout(this._ddVelocityTimer);   this._ddVelocityTimer = null; }  // Bug #55 fix
  }

  // ── Circuit breaker manual reset (#4) ────────────────────────────────────
  // circuitBreakerTripped blocks all new entries permanently until process restart.
  // This provides an admin reset path (callable via API or admin script) and
  // an auto-expiry so a stale trip doesn't block the engine indefinitely.
  resetCircuitBreaker(reason) {
    reason = reason || 'manual reset';
    this.circuitBreakerTripped = false;
    this._circuitBreakerTrippedAt = null;
    this.log('[CB RESET] Circuit breaker cleared — ' + reason);
    try { telegram.send('Circuit breaker reset: ' + reason, 'status'); } catch(_) {}  // B14: never crash on alert failure
  }

  // Called each tick: auto-expire circuit breaker after circuitBreakerExpireMs
  _checkCircuitBreakerExpiry() {
    const expireMs = TRADING_CONFIG.circuitBreakerExpireMs || 0; // 0 = never auto-expire
    if (!this.circuitBreakerTripped || !expireMs || !this._circuitBreakerTrippedAt) return;
    const age = Date.now() - this._circuitBreakerTrippedAt;
    if (age >= expireMs) {
      this.resetCircuitBreaker('auto-expiry after ' + Math.round(age/60000) + 'min');
    }
  }

  getStatus() {
    const currentPrice = this.priceHistory[this.priceHistory.length - 1] || 0;
    const isShortPos   = this.position?.side === 'SHORT';
    // BUG-80 fix: SHORT equity = capital + unrealised P&L (entry - currentPrice) × shares
    // LONG equity = capital + (currentPrice × shares) — but capital already has positionCost deducted
    const positionPnl = this.position
      ? (isShortPos
          ? (this.position.entry - currentPrice) * this.position.shares
          : (currentPrice - this.position.entry) * this.position.shares)
      : 0;
    const totalValue = this.capital + (this.position
      ? (isShortPos
          ? this.position.cost + positionPnl   // cost = margin reserved; add P&L
          : this.position.shares * currentPrice)
      : 0);
    const pnl = totalValue - this.initialCapital;

    return {
      asset: this.selectedAsset,
      isRunning: this.isRunning,
      capital: this.capital.toFixed(2),
      totalValue: totalValue.toFixed(2),
      pnl: pnl.toFixed(2),
      currentPrice: currentPrice.toFixed(4),
      position: this.position ? {
        entry: this.position.entry.toFixed(4),
        shares: this.position.shares.toFixed(4),
        side: this.position.side || 'LONG',
        // BUG-81 fix: SHORT profits when price falls (entry - currentPrice), not rises
        pnl: (isShortPos
          ? (this.position.entry - currentPrice) * this.position.shares
          : (currentPrice - this.position.entry) * this.position.shares).toFixed(2),
        pnlPercent: (isShortPos
          ? ((this.position.entry - currentPrice) / this.position.entry) * 100
          : ((currentPrice - this.position.entry) / this.position.entry) * 100).toFixed(2),
        stopLoss: this.position.stopLoss ? this.position.stopLoss.toFixed(4) : null,
        takeProfit: this.position.takeProfit ? this.position.takeProfit.toFixed(4) : null,
        highestPrice: this.position.highestPrice ? this.position.highestPrice.toFixed(4) : null,
        trailingStopPrice: this.position.trailingStopPrice ? this.position.trailingStopPrice.toFixed(4) : null,
        trailingStopActivated: this.position.trailingStopActivated || false,
        kellyFraction: this.position.kellyFraction ? (this.position.kellyFraction * 100).toFixed(1) + '%' : null,
        kellyDetails: this.position.kellyDetails || null,
        adjFraction: this.position.adjFraction ? (this.position.adjFraction * 100).toFixed(1) + '%' : null,
        corrMultiplier: this.position.corrMultiplier != null ? this.position.corrMultiplier.toFixed(2) : null,
      } : null,
      // Risk metrics (top-level — not nested inside correlation)
      riskMetrics: RiskMetrics.calculate(this.trades, { capitalBase: this.initialCapital }),
      // Correlation engine state
      correlation: {
        matrix: this.correlationMatrix,
        lastCheck: this.lastCorrelationCheck,
        config: {
          enabled:       TRADING_CONFIG.correlationEnabled,
          period:        TRADING_CONFIG.correlationPeriod,
          highThreshold: TRADING_CONFIG.correlationHighThreshold,
          warnThreshold: TRADING_CONFIG.correlationWarnThreshold,
          sizeReduction: TRADING_CONFIG.correlationSizeReduction,
        }
      },
      // Multi-Timeframe Analysis state
      mta: this.lastMTA ? {
        score:   this.lastMTA.score,
        verdict: this.lastMTA.verdict,
        allowed: this.lastMTA.allowed,
        aligned: this.lastMTA.aligned,
        total:   this.lastMTA.total,
        reason:  this.lastMTA.reason,
        frames:  this.lastMTA.frames,
      } : null,
      // Live Kelly estimate for the NEXT trade (useful for monitoring)
      nextKelly: (() => {
        const k = KellyCriterion.calculate(this.trades, 75); // preview at 75% confidence
        return {
          fraction: (k.fraction * 100).toFixed(1) + '%',
          method: k.details.method,
          winRate: k.details.winRate,
          payoffRatio: k.details.payoffRatio,
        };
      })(),
      trades: this.trades.length,
      wins: this.wins,
      losses: this.losses,
      winRate: this.trades.length > 0 ? ((this.wins / this.trades.length) * 100).toFixed(2) : '0',
      modelEpochs: this.modelEpochs,
      circuitBreakerTripped: this.circuitBreakerTripped,
      globalHaltTripped:     this.globalHaltTripped,

      // Live vs Backtest Drift Monitor
      drift: this.driftMonitor.status(),

      // A/B Strategy Tester
      abTest: this.abTester.status(),

      // Exchange Risk Management
      exchangeRisk: {
        staleData:    this.staleDataMonitor.status(),
        deadMansSwitch: this.deadMansSwitch.status(),
      },

      // Capital Allocator
      capitalAllocation: this.capitalAllocator.status(),

      // Liquidity Scorer
      liquidity: this.liquidityScorer.status(),

      // Confidence Calibrator
      calibration: this.mlConfidence.calibrator.status(),

      // ML OOS Validation (lightweight — only runs when enough data)
      mlOOS: this.mlConfidence.validateOOS({ splitRatio: 0.70, embargoBars: 10 }),

      // Dynamic Slippage
      slippage: {
        configured:       TRADING_CONFIG.slippage,
        dynamic:          parseFloat(this.dynamicSlippage.toFixed(6)),
        dynamicBps:       parseFloat((this.dynamicSlippage * 10000).toFixed(2)),
        tpMultiplier:     parseFloat(this.dynamicTpMultiplier.toFixed(2)),
        historyCount:     this.slippageHistory.length,
        marketThick:      this.dynamicSlippage <= TRADING_CONFIG.slippage * 2,
      },

      // Leading Indicator Pipeline
      leadingIndicators: {
        currentValues: this.leadingIndicators.getCurrentValues(),
        signal:        this.lastLeadingSignal,
      },

      // ── New quality modules ──────────────────────────────────────────────
      modelDecay:      this.modelDecay?.status()      || null,
      overfitGuard:    this.overfitGuard?.summary()   || null,
      equityAnomaly:   this.equityAnomaly?.status()   || null,
      featureImportance: this.featureImportance?.summary() || null,
      latency:         (() => { try { return require('./latency-monitor') && this._latMonStatus?.() || null; } catch(_) { return null; } })(),
      positionGuard: {
        maxOpen:      require('./trading-config').TRADING_CONFIG.maxOpenPositions,
        openCount:    Object.keys(this.openPositions || {}).length,
        openPairs:    Object.keys(this.openPositions || {}),
        correlLockEnabled: require('./trading-config').TRADING_CONFIG.correlationLockEnabled,
      },
      antiMartingale: {
        enabled:           require('./trading-config').TRADING_CONFIG.antiMartingaleEnabled,
        consecutiveLosses: this.consecutiveLosses || 0,
      },
      weeklyReport: { enabled: require('./trading-config').TRADING_CONFIG.weeklyReportEnabled },
      riskAdjusted:    this.riskAdjusted?.status()      || null,
      maeMfe:          this.maeMfe?.summary(50)          || null,
      todHeatmap:      { best: this.todHeatmap?.bestHours(3), worst: this.todHeatmap?.worstHours(3) },
      ensembleDisagree: this.ensembleDisagree?.summary() || null,
      logSizes:        (() => { try { return this.logPruner?.fileSizes(); } catch(_) { return null; } })(),

      // Walk-Forward Optimization
      shadowStrategy: {
        epoch:            this.modelEpochs,
        nextEvalIn:       Math.max(0, this.lastShadowEval + this.SHADOW_EVAL_TRADES - this.trades.length),
        activeSettings:   this.shadowSettings ? this.shadowSettings.label : 'live defaults',
        lastResults:      this.shadowLog.slice(-3),
      },
    };
  }


  // ── Position reconciliation after crash/restart (#crash-reconcile) ────────
  // Called when a position is restored from disk after a gap of > 60 seconds.
  // Fetches the current live price and:
  //   1. Feature #3: Cross-checks against OANDA live positions via API
  //   2. Checks if SL or TP were hit during the gap — exits immediately if so
  //   3. Updates stopLoss to current price - original ATR distance (prevents
  //      stale stops that are wildly far from current market)
  //   4. Logs a reconciliation summary with gap P/L
  async _reconcileRestoredPosition(gapSeconds) {
    if (!this.position) return;
    // Bug #73 fix: wait for price feed to be ready before reconciling
    if (this.priceHistory.length === 0) {
      await new Promise(r => setTimeout(r, 5000));  // give price feed 5s to start
      if (this.priceHistory.length === 0) {
        console.warn('[Reconcile] Price feed not ready — deferring reconcile');
        return;
      }
    }
    try {
      await this.marketData.refreshPrice(this.selectedAsset);
      const priceData    = this.marketData.fetchPrice(this.selectedAsset);
      const currentPrice = priceData?.price;
      // CRITICAL bug fix: if refreshPrice fails (network down), currentPrice is undefined
      // causing .toFixed(5) to throw and leaving position in inconsistent state
      if (typeof currentPrice !== 'number' || !isFinite(currentPrice) || currentPrice <= 0) {
        console.warn('[Reconcile] Could not fetch current price — aborting reconcile, keeping local state');
        return;
      }
      const pos          = this.position;
      const isShortPos   = pos.side === 'SHORT';
      const gapPnlPct    = isShortPos
        ? ((pos.entry - currentPrice) / pos.entry * 100).toFixed(3)
        : ((currentPrice - pos.entry) / pos.entry * 100).toFixed(3);

      console.log(
        `[Reconcile] Gap: ${gapSeconds}s | Side: ${pos.side||'LONG'} | Entry: ${pos.entry.toFixed(5)} | ` +
        `Current: ${currentPrice.toFixed(5)} | Gap P/L: ${gapPnlPct}%`
      );

      // ── Feature #3: Cross-check against OANDA live positions ──────────────
      // If the broker closed/modified the position during the gap (partial fill,
      // broker-side SL move, margin call) this detects it and overrides local state.
      try {
        const { OandaAdapter } = require('./exchange-interface');
        const adapter = new OandaAdapter();
        const livePosArray = await adapter.getOpenPositions();
        const assetNorm = (this.selectedAsset || '').replace('/', '_').replace('-', '_');
        const livePos = livePosArray.find(p =>
          (p.asset || '').replace('/', '_').replace('-', '_') === assetNorm
        );
        if (!livePos) {
          // Broker has NO open position — it was closed (SL/TP/margin) during gap
          console.warn('[Reconcile] ⚠️  OANDA shows NO open position — broker closed during gap');
          try { require('./telegram').send('[Reconcile] Broker closed position during gap — syncing local state', 'risk'); } catch(_) {}
          // Exit at current price to reconcile books; PnL reflects gap movement
          // CRITICAL: must await to prevent double-exit if a tick arrives during exit
          await this.exitPosition(currentPrice, 'Broker Closed During Gap (Reconcile)');
          return;
        }
        // Broker HAS position — check for size discrepancy
        const brokerShares = livePos.size || 0;
        const localShares  = pos.shares || 0;
        const sizeDiff = Math.abs(brokerShares - localShares) / Math.max(localShares, 1);
        if (sizeDiff > 0.05) {  // >5% discrepancy
          console.warn(`[Reconcile] ⚠️  Size mismatch: local=${localShares.toFixed(4)}, broker=${brokerShares.toFixed(4)} — adjusting`);
          pos.shares = brokerShares;
          this.savePositionFile();
        }
        // Sync broker's entry price if materially different (partial fills during gap)
        if (livePos.entryPrice && Math.abs(livePos.entryPrice - pos.entry) / pos.entry > 0.001) {
          console.log(`[Reconcile] Entry price adjusted: ${pos.entry.toFixed(5)} → ${livePos.entryPrice.toFixed(5)}`);
          pos.entry = livePos.entryPrice;
          this.savePositionFile();
        }
        console.log('[Reconcile] ✅ OANDA position verified — size and side match local state');
      } catch (apiErr) {
        console.warn('[Reconcile] Could not reach OANDA API for live verification:', apiErr.message);
        // Proceed with local state — don't block trading on API failure
      }

      // Check if SL was hit during gap
      const sl = pos.stopLoss || (isShortPos ? pos.entry * 1.02 : pos.entry * 0.98);
      const slHit = isShortPos ? currentPrice >= sl : currentPrice <= sl;
      if (slHit) {
        console.warn('[Reconcile] Stop loss was hit during gap — closing position');
        await this.exitPosition(currentPrice, 'Stop Loss (Gap Reconciliation)');
        return;
      }

      // Check if TP was hit during gap
      const tp = pos.takeProfit || (isShortPos ? pos.entry * 0.95 : pos.entry * 1.05);
      const tpHit = isShortPos ? currentPrice <= tp : currentPrice >= tp;
      if (tpHit) {
        console.warn('[Reconcile] Take profit was hit during gap — closing position');
        await this.exitPosition(currentPrice, 'Take Profit (Gap Reconciliation)');
        return;
      }

      // Update stale ATR-based stops to current price if gap > 5 minutes
      if (gapSeconds > 300 && pos.atr) {
        const freshSL = isShortPos
          ? currentPrice + pos.atr * 1.5   // SHORT stop above price
          : currentPrice - pos.atr * 1.5;  // LONG stop below price
        const stopImproved = isShortPos ? freshSL < sl : freshSL > sl;
        if (stopImproved) {
          pos.stopLoss = freshSL;
          console.log(`[Reconcile] Stop updated: ${sl.toFixed(5)} → ${freshSL.toFixed(5)} (price moved in favour)`);
          this.savePositionFile();
        }
      }

      console.log('[Reconcile] ✅ Position valid — continuing to monitor');
    } catch (err) {
      console.warn('[Reconcile] Could not fetch live price — keeping saved stops:', err.message);
    }
  }

  // Fix #63: Serializable state struct snapshot for time-travel debugging and atomic saves
  // Item 33: FX Greeks-equivalent — pip value, carry sensitivity, DV01
  computeFXGreeks(asset, position, currentPrice) {
    if (!position || !currentPrice) return null;
    const isJPY    = (asset||'').includes('JPY');
    const pipSize  = isJPY ? 0.01 : 0.0001;
    const pipValue = position.shares * pipSize;  // P&L per pip move
    const carry    = (() => {
      const swaps = TRADING_CONFIG.swapCosts || {};
      const s = swaps[asset];
      return s ? (position.side === 'SHORT' ? s.short : s.long) * position.shares * currentPrice / 365 : 0;
    })();
    // DV01: P&L sensitivity to 1bp (0.0001) rate change
    const dv01 = position.shares * currentPrice * 0.0001;
    return {
      pipValue:   parseFloat(pipValue.toFixed(4)),   // $ per pip
      carryPerDay:parseFloat(carry.toFixed(4)),        // $ carry per day
      dv01:       parseFloat(dv01.toFixed(4)),          // $ per basis point rate change
      notional:   parseFloat((position.shares * currentPrice).toFixed(2)),
    };
  }

  // Item 37: Multi-pair basket entry
  async checkBasketEntry(signalMap) {
    if (!require('./trading-config').TRADING_CONFIG.basketEntryEnabled || !signalMap) return;
    const buys   = Object.entries(signalMap).filter(([,s])=>s==='BUY').map(([a])=>a);
    const sells  = Object.entries(signalMap).filter(([,s])=>s==='SELL').map(([a])=>a);
    const basket = buys.length >= 3 ? buys.slice(0,3) : sells.length >= 3 ? sells.slice(0,3) : null;
    const side   = buys.length >= 3 ? 'BUY' : 'SELL';
    if (basket && !this.position) {
      this.log(`[Item 37] Basket ${side}: ${basket.join(',')} — 33% size`);
      // Pass 0.33 as corrMultiplier so enterPosition sizes at 33% without mutating shared config
      try { await this.enterPosition(this.priceHistory.at(-1)||0, 70, 0.33); } catch(_) {}
    }
  }

  // Item 38: Pairs correlation divergence
  detectCorrDivergence(priceSeriesA, priceSeriesB) {
    if (!priceSeriesA || !priceSeriesB || priceSeriesA.length < 20) return null;
    const _corrPeriod79 = (require("./trading-config").TRADING_CONFIG.correlationPeriod || 20);  // Bug #79
    const n    = Math.min(priceSeriesA.length, priceSeriesB.length, _corrPeriod79);
    const rA   = priceSeriesA.slice(-n).map((v,i,a)=>i?v/a[i-1]-1:0).slice(1);
    const rB   = priceSeriesB.slice(-n).map((v,i,a)=>i?v/a[i-1]-1:0).slice(1);
    const mA   = rA.reduce((s,v)=>s+v,0)/rA.length, mB = rB.reduce((s,v)=>s+v,0)/rB.length;
    const stdA = Math.sqrt(rA.reduce((s,v)=>s+(v-mA)**2,0)/rA.length)||1e-6;
    const stdB = Math.sqrt(rB.reduce((s,v)=>s+(v-mB)**2,0)/rB.length)||1e-6;
    const spread = (rA.at(-1)-mA)/stdA - (rB.at(-1)-mB)/stdB;
    const thresh = require('./trading-config').TRADING_CONFIG.corrDivergenceThreshold || 1.5;
    if (Math.abs(spread) > thresh) return { spread, action: spread>0?'SELL_A_BUY_B':'BUY_A_SELL_B' };
    return null;
  }

  snapshotState() {
    return {
      capital:           this.capital,
      initialCapital:    this.initialCapital,
      wins:              this.wins,
      losses:            this.losses,
      consecutiveLosses: this.consecutiveLosses,
      consecutiveWins:   this.consecutiveWins,
      position:          this.position ? JSON.parse(JSON.stringify(this.position)) : null,
      selectedAsset:     this.selectedAsset,
      globalHaltTripped: this.globalHaltTripped,
      ts:                Date.now(),
    };
  }

  // Item 7: Circuit breaker per subsystem
  // Proper 3-state circuit breaker: CLOSED → OPEN → HALF_OPEN → CLOSED
  tripBreaker(subsystem, error) {
    const b = this._subsystemBreakers?.[subsystem];
    if (!b) return;
    b.failures++; b.lastFailure = Date.now();
    if (b.state === 'HALF_OPEN') {
      // New failure in HALF_OPEN → back to OPEN
      b.state = 'OPEN'; b.openedAt = Date.now();
      this.log(`🔴 [CB] ${subsystem}: HALF_OPEN→OPEN (failure during probe)`);
      setTimeout(()=>{ b.state='HALF_OPEN'; this.log(`🟡 [CB] ${subsystem}: probing HALF_OPEN`); }, b.resetMs).unref();
      return;
    }
    if (b.failures >= b.threshold && b.state !== 'OPEN') {
      b.state = 'OPEN'; b.openedAt = Date.now();
      this.log(`🔴 [CB] Circuit OPEN: ${subsystem} (${b.failures} failures)`);
      try { require('./telegram').send(`🔴 Circuit OPEN: ${subsystem}`, 'risk'); } catch(_) {}
      setTimeout(()=>{ b.state='HALF_OPEN'; this.log(`🟡 [CB] ${subsystem}: probing HALF_OPEN`); }, b.resetMs).unref();
    }
  }

  isBreaker(subsystem) {
    const b = this._subsystemBreakers?.[subsystem];
    return b?.state === 'OPEN';
  }
  recordSuccess(subsystem) {
    const b = this._subsystemBreakers?.[subsystem];
    if (!b) return;
    if (b.state === 'HALF_OPEN') {
      b.state = 'CLOSED'; b.failures = 0;
      this.log(`🟢 [CB] ${subsystem}: HALF_OPEN→CLOSED (probe succeeded)`);
    }
    if (b.failures > 0) b.failures = Math.max(0, b.failures - 1);
  }

  log(msg) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${msg}`);
  }
}

// ── Mix in method groups ──────────────────────────────────────────────────────
// Each module exports plain functions that use `this` as the engine instance.
// Object.assign adds them to the prototype so they work exactly like methods
// defined directly on the class — zero change to all existing call sites.
Object.assign(TradingEngine.prototype, require('./execution'));
Object.assign(TradingEngine.prototype, require('./risk-manager').engineMethods);
Object.assign(TradingEngine.prototype, require('./strategy').engineMethods);
Object.assign(TradingEngine.prototype, require('./backtest-engine'));

module.exports = {
  TradingEngine,
  Indicators,
  KellyCriterion,
  CorrelationEngine,
  MultiTimeframeAnalyzer,
  LeadingIndicatorFetcher,
  MarketDataFetcher,
  TRADING_CONFIG,
};
