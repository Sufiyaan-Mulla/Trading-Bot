'use strict';
// ── engine-wiring.js ──────────────────────────────────────────────────────────
// Wires every new module into a live TradingEngine instance.
// Called once from backend-server.js right after the engine is constructed.
//
// Does NOT modify trading-engine.js source — injects subsystems into the
// running instance so the engine can be updated without touching the core file.
//
// Modules wired:
//   HotReloader            — live config patching
//   DrawdownTracker        — weekly + monthly drawdown limits
//   MetaLabeler            — signal quality filter (post-strategy pre-execution)
//   FillProbability        — limit-vs-market order selector
//   ExecutionMetrics       — per-order latency + fill quality
//   IdempotentExecutor     — duplicate order prevention + reconciliation
//   FeeModel               — maker/taker fee-aware order classification
//   SectorCap              — multi-position sector exposure cap
//   RelativeStrength       — cross-asset strength ranker
//   ParallelScanner        — concurrent multi-asset scoring
//   RLIntegration          — Q-learning post-filter on signals
//   Profiler               — startup + tick benchmarking
// ─────────────────────────────────────────────────────────────────────────────

const { TRADING_CONFIG }        = require('./trading-config');

function wireEngine(engine) {
  if (!engine) throw new Error('[Wiring] engine must be provided');
  if (engine._wired) { console.log('[Wiring] Already wired — skipping'); return engine; }

  const { applyExecutionHooks } = require('./execution-hooks');

  console.log('[Wiring] Attaching new subsystems to engine...');

  // ── 1. Hot-reload ──────────────────────────────────────────────────────────
  try {
    const { HotReloader } = require('./hot-reload');
    engine.hotReloader = new HotReloader(TRADING_CONFIG);
    engine.hotReloader.onChange((key, oldVal, newVal) => {
      engine.log(`[HotReload] ${key}: ${oldVal} → ${newVal}`);
      // Feature #28: Re-sync initialCapital when changed via overrides.json
      if (key === 'initialCapital' && typeof newVal === 'number' && newVal > 0) {
        engine.initialCapital = newVal;
        engine.log(`[HotReload] initialCapital updated to $${newVal} — Kelly sizing will reflect new capital`);
        try { require('./telegram').send(`[HotReload] initialCapital → $${newVal}`, 'status'); } catch(_) {}
      }
    });
    engine.hotReloader.start();
    console.log('[Wiring] ✅ HotReloader');
  } catch (e) { console.warn('[Wiring] HotReloader failed:', e.message); }

  // ── 2. Weekly/Monthly drawdown tracker ────────────────────────────────────
  try {
    const { DrawdownTracker } = require('./weekly-monthly-drawdown');
    engine.drawdownTracker = new DrawdownTracker(engine.capital, {
      weeklyLimitPct:  TRADING_CONFIG.weeklyDrawdownLimit  || 0.07,
      monthlyLimitPct: TRADING_CONFIG.monthlyDrawdownLimit || 0.15,
    });
    // Hook into the existing risk check — called from checkRiskManagement
    const origCheck = engine.checkRiskManagement.bind(engine);
    engine.checkRiskManagement = function(...args) {
      const ddCheck = engine.drawdownTracker.check(engine.capital);
      if (ddCheck.halt && !engine.circuitBreakerTripped) {
        engine.circuitBreakerTripped = true;
        engine.log(`[DrawdownTracker] HALT — ${ddCheck.reason} (weekly ${ddCheck.weeklyDD}%, monthly ${ddCheck.monthlyDD}%)`);
        require('./telegram').send(`⛔ ${ddCheck.reason} — trading halted`, 'risk');
      }
      return origCheck(...args);
    };
    console.log('[Wiring] ✅ DrawdownTracker');
  } catch (e) { console.warn('[Wiring] DrawdownTracker failed:', e.message); }

  // ── 3. Meta-labeler ────────────────────────────────────────────────────────
  try {
    const { MetaLabeler } = require('./meta-labeler');
    engine.metaLabeler = new MetaLabeler({ threshold: 0.50, minSamples: 20 });
    // Wrap getDecision to filter through meta-labeler
    const origGetDecision = engine.getDecision.bind(engine);
    engine.getDecision = async function(indicators) {
      const decision = await origGetDecision(indicators);
      if (decision.action === 'HOLD') return decision;
      const session = engine._currentSession ? engine._currentSession() : 'UNKNOWN';
      const features = {
        confidence:     decision.confidence || 0,
        regimeScore:    indicators.adxRegime === 'TRENDING' ? 0.9 : indicators.adxRegime === 'RANGING' ? 0.4 : 0.6,
        spreadAtrRatio: engine.currentSpread && indicators.atrPercent
          ? (engine.currentSpread / (indicators.atrPercent / 100)) : 0.5,
        sessionWeight:  session === 'LONDON_NY_OVERLAP' ? 1.1 : session === 'ASIAN' ? 0.8 : 1.0,
        atrPercentile:  Math.min(1, (indicators.atrPercent || 0.05) / 0.20),
        newsProximity:  engine.economicCalendar?.isBlackout(engine.selectedAsset) ? 1 : 0,
      };
      const meta = engine.metaLabeler.evaluate(features);
      decision._metaFeatures = features;
      decision._metaProb     = meta.probability;
      if (!meta.accept) {
        engine.log(`[MetaLabeler] Filtered ${decision.action} (meta-prob ${(meta.probability*100).toFixed(1)}%)`);
        return { action: 'HOLD', confidence: 0, reasoning: `Meta-labeler filtered: ${meta.reason}`, _metaFiltered: true };
      }
      return decision;
    };
    // Train meta-labeler after each trade closes
    engine.on('tradeClose', (trade) => {
      if (trade._metaFeatures) {
        engine.metaLabeler.update(trade._metaFeatures, trade.profit > 0 ? 1 : 0);
      }
    });
    console.log('[Wiring] ✅ MetaLabeler');
  } catch (e) { console.warn('[Wiring] MetaLabeler failed:', e.message); }

  // ── 4. Fill probability ────────────────────────────────────────────────────
  try {
    const { FillProbability } = require('./fill-probability');
    engine.fillProbability = new FillProbability({ threshold: 0.65 });
    console.log('[Wiring] ✅ FillProbability');
  } catch (e) { console.warn('[Wiring] FillProbability failed:', e.message); }

  // ── 5. Execution metrics ───────────────────────────────────────────────────
  try {
    const { ExecutionMetrics } = require('./execution-metrics');
    engine.executionMetrics = new ExecutionMetrics();
    console.log('[Wiring] ✅ ExecutionMetrics');
  } catch (e) { console.warn('[Wiring] ExecutionMetrics failed:', e.message); }

  // ── 6. Idempotent executor ─────────────────────────────────────────────────
  try {
    const { IdempotentExecutor } = require('./idempotent-executor');
    engine.idempotentExec = new IdempotentExecutor(engine);
    console.log('[Wiring] ✅ IdempotentExecutor');
  } catch (e) { console.warn('[Wiring] IdempotentExecutor failed:', e.message); }

  // ── 7. Fee model ──────────────────────────────────────────────────────────
  try {
    const { FeeModel } = require('./fee-model');
    engine.feeModel = FeeModel.fromConfig(TRADING_CONFIG);
    console.log('[Wiring] ✅ FeeModel');
  } catch (e) { console.warn('[Wiring] FeeModel failed:', e.message); }

  // ── 8. Sector cap ─────────────────────────────────────────────────────────
  try {
    const { SectorCap } = require('./sector-cap');
    engine.sectorCap = new SectorCap({
      maxOpenPositions:     TRADING_CONFIG.maxOpenPositions    || 5,
      maxSectorPositions:   TRADING_CONFIG.maxSectorPositions  || 2,
      maxSectorExposurePct: TRADING_CONFIG.maxSectorExposure   || 0.30,
    });
    console.log('[Wiring] ✅ SectorCap');
  } catch (e) { console.warn('[Wiring] SectorCap failed:', e.message); }

  // ── 9. Relative strength ranker ───────────────────────────────────────────
  try {
    const { RelativeStrength } = require('./relative-strength');
    engine.relativeStrength = new RelativeStrength();
    // Patch _selectBestAsset to use relative strength scores
    const origSelect = engine._selectBestAsset.bind(engine);
    engine._selectBestAsset = async function() {
      const assets = TRADING_CONFIG.assets || ['EURUSD'];
      if (assets.length <= 1) return origSelect();

      // ── Use ParallelScanner to score assets concurrently ────────────────
      const scanner = engine.parallelScanner;
      const rs      = engine.relativeStrength;
      let scores;

      if (scanner) {
        scores = await scanner.scan(assets, async (asset) => {
          globalThis._currentScoringAsset = asset;  // Bug fix #13: set before ADX cache key lookup
          const hist = engine.marketData.getPriceHistory(asset);
          if (!hist || hist.length < 25) return { asset, score: -Infinity, insufficient: true };
          rs?.update(asset, hist, null);
          const ranked = rs?.rank() || [];
          const entry  = ranked.find(r => r.asset === asset);
          return { asset, score: entry?.score || 0, zScore: entry?.zScore || 0 };
        });
      } else {
        // Fallback: sequential
        scores = assets.map(asset => {
          globalThis._currentScoringAsset = asset;  // Bug fix #13: fallback path
          const hist = engine.marketData.getPriceHistory(asset);
          if (!hist || hist.length < 25) return { asset, score: -Infinity };
          rs?.update(asset, hist, null);
          const ranked = rs?.rank() || [];
          const entry  = ranked.find(r => r.asset === asset);
          return { asset, score: entry?.score || 0 };
        });
      }

      // Sort by score descending, pick best with sufficient history
      scores.sort((a, b) => (b.score || 0) - (a.score || 0));
      for (const s of scores) {
        if (s.score === -Infinity || s.insufficient) continue;
        const hist = engine.marketData.getPriceHistory(s.asset);
        if (hist && hist.length >= 60) return s.asset;
      }
      return await origSelect();
    };
    console.log('[Wiring] ✅ RelativeStrength → _selectBestAsset');
  } catch (e) { console.warn('[Wiring] RelativeStrength failed:', e.message); }

  // ── 10. Parallel scanner ──────────────────────────────────────────────────
  try {
    const { ParallelScanner } = require('./parallel-scanner');
    engine.parallelScanner = new ParallelScanner({ concurrencyLimit: 4, timeoutMs: 3000 });
    console.log('[Wiring] ✅ ParallelScanner');
  } catch (e) { console.warn('[Wiring] ParallelScanner failed:', e.message); }

  // ── 11. RL integration ────────────────────────────────────────────────────
  try {
    const { RLIntegration } = require('./rl-integration');
    engine.rlAgent = new RLIntegration({ minSamples: 30, epsilon: 0.10 });
    // Wrap getDecision to pass through RL filter (after meta-labeler)
    const preRLDecision = engine.getDecision.bind(engine);
    engine.getDecision = async function(indicators) {
      const decision = await preRLDecision(indicators);
      if (decision.action === 'HOLD') return decision;
      const rlResult = engine.rlAgent.filter(decision, indicators);
      if (rlResult.vetoed) {
        engine.log(`[RL] Vetoed ${decision.action} — ${rlResult.reasoning}`);
      }
      // Store indicator snapshot for reward update
      engine._lastRLIndicators = indicators;
      return rlResult;
    };
    engine.on('tradeClose', (trade) => {
      const pnlPct = trade.profitPercent != null ? trade.profitPercent / 100
        : (trade.profit || 0) / (engine.capital || 10000);
      engine.rlAgent.reward(pnlPct);
    });
    console.log('[Wiring] ✅ RLIntegration');
  } catch (e) { console.warn('[Wiring] RLIntegration failed:', e.message); }

  // ── 12. Performance profiler ──────────────────────────────────────────────
  try {
    const { getProfiler } = require('./performance-profiler');
    engine.profiler = getProfiler();
    engine.profiler.startupEnd('engine_construct');
    console.log('[Wiring] ✅ Profiler');
  } catch (e) { console.warn('[Wiring] Profiler failed:', e.message); }

  // ── 13. Emit tradeClose events (needed by meta-labeler + RL) ─────────────
  // Patch the trade-recording path so events fire
  try {
    const origSaveTrades = engine.saveTradesFile?.bind(engine);
    if (origSaveTrades) {
      engine.saveTradesFile = function() {
        const lastTrade = engine.trades[engine.trades.length - 1];
        if (lastTrade) engine.emit('tradeClose', lastTrade);
        return origSaveTrades();
      };
    }
    console.log('[Wiring] ✅ tradeClose event emitter');
  } catch (e) { console.warn('[Wiring] tradeClose emitter failed:', e.message); }


  // ── 13. Execution hooks — wire 5 subsystems into live execution path ──────
  try {
    applyExecutionHooks(engine);
  } catch (e) { console.warn('[Wiring] ExecutionHooks failed:', e.message); }

  // ── 14. Reconnect reconciliation ──────────────────────────────────────────
  try {
    const origLoop = engine.runTradingLoop?.bind(engine);
    if (origLoop && engine.idempotentExec) {
      engine.runTradingLoop = async function() {
        // Reconcile state on every (re)start — 5s timeout prevents indefinite hang
        try {
          const _timeout = new Promise(r => setTimeout(r, 5000, 'timeout'));
          const _reconcile = engine.idempotentExec.reconcile(async () => ({
            openPositions: engine.position ? [{ ...engine.position, asset: engine.selectedAsset, entryPrice: engine.position.entry }] : [],
            recentOrders: [],
          }));
          const result = await Promise.race([_reconcile, _timeout]);
          if (result === 'timeout') {
            engine.log('[Reconcile] Timed out after 5s — proceeding without reconciliation');
          } else {
            engine.log('[Reconcile] State reconciled on start');
          }
        } catch (e) { engine.log('[Reconcile] ' + e.message); }
        return origLoop();
      };
    }
    console.log('[Wiring] ✅ Reconnect reconciliation');
  } catch (e) { console.warn('[Wiring] Reconnect reconciliation failed:', e.message); }

  // ── 15. Dependency injection — replace direct requires with container ─────
  try {
    const { container } = require('./di-container');
    // Override engine's telegram reference with container-managed instance
    // This enables test overrides: container.override('telegram', mockTelegram)
    if (!engine._diWired) {
      const tg = container.get('telegram');
      if (tg && tg !== require('./telegram')) engine._telegram = tg;
      // Store container reference on engine for subsystem use
      engine.container = container;
      engine._diWired  = true;
    }
    console.log('[Wiring] ✅ DI container bound to engine');
  } catch (e) { console.warn('[Wiring] DI container failed:', e.message); }


  // ── 16. MarketStructure + LiquidityHeatmap ────────────────────────────────
  try {
    const { MarketStructure }  = require('./market-structure');
    const { LiquidityHeatmap } = require('./liquidity-heatmap');
    engine.marketStructure  = new MarketStructure();
    engine.liquidityHeatmap = new LiquidityHeatmap();
    // Patch calculateIndicators to include MarketStructure + LiquidityHeatmap outputs
    const origCalc = engine.calculateIndicators?.bind(engine);
    if (origCalc) {
      engine.calculateIndicators = async function(...args) {
        const ind = await origCalc(...args);
        if (ind && engine.priceHistory.length >= 20) {
          try {
            ind.marketStructure  = engine.marketStructure.analyse(engine.priceHistory);
            ind.liquidityHeatmap = engine.liquidityHeatmap.score(engine.priceHistory, engine.volumeHistory || []);
          } catch(_) {}
        }
        return ind;
      };
    }
    console.log('[Wiring] ✅ MarketStructure + LiquidityHeatmap');
  } catch (e) { console.warn('[Wiring] MarketStructure/LiquidityHeatmap failed:', e.message); }


  // ── 17. risk-improvements.js 4 classes ────────────────────────────────────
  try {
    const { DynamicTakeProfit, SessionTimeExits, MonteCarloSizer, SessionRiskBudget } = require('./risk-improvements');
    engine.dynamicTakeProfit  = new DynamicTakeProfit();
    engine.sessionTimeExits   = new SessionTimeExits();
    engine.monteCarloSizer    = new MonteCarloSizer();
    engine.sessionRiskBudget  = new SessionRiskBudget();
    // Wire SessionTimeExits into risk check: exit if session close approaching
    const origRisk = engine.checkRiskManagement.bind(engine);
    engine.checkRiskManagement = function() {
      if (engine.position && engine.sessionTimeExits) {
        const utcH = new Date().getUTCHours();
        const utcM = new Date().getUTCMinutes();
        const check = engine.sessionTimeExits.shouldExit(engine.position, utcH, utcM);
        if (check.exit) {
          engine.log('[SessionTimeExits] ' + check.reason);
          // Bug fix #19: exitPosition is synchronous but use try-catch for safety
          try { engine.exitPosition(engine.priceHistory?.at(-1) || 0, check.reason); } catch(e) { engine.log('[SessionTimeExits] Exit failed: ' + e.message); }
        }
      }
      return origRisk();
    };
    console.log('[Wiring] ✅ DynamicTakeProfit + SessionTimeExits + MonteCarloSizer + SessionRiskBudget');
  } catch (e) { console.warn('[Wiring] risk-improvements failed:', e.message); }


  // A13: Feature input drift detector
  try {
    const { FeatureInputDriftDetector } = require('./feature-input-drift');
    engine.featureInputDrift = new FeatureInputDriftDetector({
      log: m => engine.log(m),
      notify: (m, cat) => { try { require('./telegram').send(m, cat); } catch(_) {} },
    });
    // Record features on each trade close (reference = training distribution)
    engine.on('tradeClose', trade => {
      if (engine.featureInputDrift && trade.mlFeatures) {
        engine.featureInputDrift.recordReference(trade.mlFeatures);
      }
    });
    console.log('[Wiring] ✅ FeatureInputDriftDetector');
  } catch(e) { console.warn('[Wiring] featureInputDrift failed:', e.message); }

  // A12: Set event listener limit to prevent memory leak warnings
  // Multiple wiring modules add 'tradeClose' listeners — cap at 20
  engine.setMaxListeners(20);

  // ── 18. indicators-new.js + ml-improvements unused classes ────────────────
  try {
    const { IndicatorsNew }          = require('./indicators-new');
    const { ConceptDriftDetector, EnsembleUncertainty, FeatureImportance } = require('./ml-improvements');
    engine.indicatorsNew         = IndicatorsNew;
    engine.conceptDriftDetector  = new ConceptDriftDetector({ windowSize: 50 });
    engine.ensembleUncertainty   = new EnsembleUncertainty();
    // Feature #32: Instantiate FeatureImportance and record on every trade close
    engine.featureImportance     = new FeatureImportance();
    engine.on('tradeClose', (trade) => {
      if (engine.featureImportance && trade.mlFeatures && Array.isArray(trade.mlFeatures)) {
        const label = trade.profit > 0 ? 1 : 0;
        engine.featureImportance.record(trade.mlFeatures, label);
        const total = engine.featureImportance.count?.() || 0;
        if (total > 0 && total % 50 === 0) {
          const top = engine.featureImportance.topFeatures?.(5);
          if (top) engine.log('[FeatureImportance] Top-5: ' + JSON.stringify(top));
        }
      }
      if (engine.conceptDriftDetector && trade.mlConfidence != null) {
        const won    = trade.profit > 0 ? 1 : 0;
        const drifted = engine.conceptDriftDetector.update(trade.mlConfidence / 100, won);
        if (drifted?.driftDetected) {
          engine.log('[ConceptDrift] ⚠️  ML prediction drift detected — triggering retrain NOW');
          try { require('./telegram').send('⚠️ ML concept drift detected — triggering retrain', 'risk'); } catch(_) {}
          // Feature #39: Actually trigger retrain instead of just logging
          if (typeof engine.trainModel === 'function' && !engine._retrainInProgress) {
            engine._retrainInProgress = true;
            engine.trainModel()
              .then(() => {
                engine._retrainInProgress = false;
                engine.log('[ConceptDrift] ✅ Retrain complete after drift detection');
                try { require('./telegram').send('✅ ML retrain complete (drift triggered)', 'status'); } catch(_) {}
              })
              .catch((e) => {
                engine._retrainInProgress = false;
                engine.log('[ConceptDrift] ❌ Retrain failed: ' + e.message);
              });
          }
        }
      }
    });
    console.log('[Wiring] ✅ IndicatorsNew + ConceptDriftDetector + EnsembleUncertainty');
  } catch (e) { console.warn('[Wiring] ml-improvements wiring failed:', e.message); }

  engine._wired = true;
  console.log('[Wiring] All subsystems attached ✅');
  return engine;
}

// Item 101: Schedule dynamic ensemble weight updates every 50 trades / 7 days
function wireEnsembleWeightUpdate(engine) {
  // Update every 7 days
  if (process.env.BACKTEST_MODE !== 'true') {
    setInterval(() => {
      if (engine.abTester?.updateDynamicWeights) {
        const w = engine.abTester.updateDynamicWeights();
        engine.log(`[DynWeights #101] Updated: ${JSON.stringify(w)}`);
        try { require('./telegram').send(`[EnsembleWeights] Updated: ${JSON.stringify(w)}`, 'status'); } catch(_) {}
      }
    }, 7 * 24 * 3_600_000).unref();
  }
  // Also update every 50 trades
  const origExit = engine.exitPosition?.bind(engine);
  if (origExit) {
    engine._ensembleUpdateCount101 = 0;
    engine.exitPosition = async function(...args) {
      const result = await origExit(...args);
      engine._ensembleUpdateCount101++;
      if (engine._ensembleUpdateCount101 % 50 === 0 && engine.abTester?.updateDynamicWeights) {
        engine.abTester.updateDynamicWeights();
      }
      return result;
    };
  }
}

module.exports = { wireEngine };
