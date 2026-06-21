'use strict';
// ── execution-hooks.js ────────────────────────────────────────────────────────
// Patches the live execution path to fully use the 5 instantiated-but-unwired
// subsystems:
//   1. IdempotentExecutor  — wraps _executeFill with dedup + reconcile on error
//   2. FeeModel            — selects LIMIT/MARKET/TWAP before order placement
//   3. FillProbability     — gates limit orders; downgrades to MARKET if fill unlikely
//   4. ExecutionMetrics    — times every order; logs quality score + alerts on degradation
//   5. SectorCap           — blocks enterPosition when sector exposure limit reached
//
// Applied by engine-wiring.js after instantiating all subsystems.
// Does NOT modify execution.js source — patches are injected at runtime.
// ─────────────────────────────────────────────────────────────────────────────

const { TRADING_CONFIG } = require('./trading-config');

function applyExecutionHooks(engine) {
  if (!engine || engine._execHooksApplied) return;

  // ── 1 + 3 + 4: Wrap _executeFill ─────────────────────────────────────────
  // Called for every LONG order fill. Injects:
  //   • FeeModel    — determine optimal order type
  //   • FillProb    — downgrade limit→market when fill probability < threshold
  //   • ExecMetrics — time the fill, record quality score
  //   • Idempotent  — wrap real fill in dedup submit
  if (typeof engine._executeFill !== 'function') {
    console.warn('[ExecutionHooks] _executeFill not found on engine — hooks skipped');
    return;
  }
  const origFill = engine._executeFill.bind(engine);
  engine._executeFill = async function(targetShares, price, direction = 'BUY') {
    const asset = engine.selectedAsset;

    // ── FeeModel: choose order type ─────────────────────────────────────────
    let orderType = TRADING_CONFIG.orderType || 'market';
    if (engine.feeModel) {
      const spread     = engine.currentSpread || price * 0.0001;
      const spreadFrac = spread / price;
      const atrPct     = engine.lastATR ? engine.lastATR / price : 0.001;
      const tradeValue = targetShares * price;
      const urgency    = engine.circuitBreakerTripped ? 0.9 : 0.4;

      const classified = engine.feeModel.classify(spreadFrac, atrPct, urgency, tradeValue);
      orderType = classified.type.toLowerCase();
      engine.log(`[FeeModel] ${direction} → ${classified.type} (${classified.reason})`);

      // EV check: skip if round-trip fee wipes edge
      if (engine.lastIndicators?.confidence) {
        const ev = engine.feeModel.adjustExpectedValue(
          engine.lastIndicators.confidence / 1000,
          classified.type, targetShares, price
        );
        if (!ev.viable) {
          engine.log(`[FeeModel] EV not viable after fees (adjustedEV=${(ev.adjustedEV*100).toFixed(3)}%) — switching to market`);
          orderType = 'market';
        }
      }
    }

    // ── FillProbability: downgrade limit to market if fill unlikely ──────────
    if (engine.fillProbability && orderType === 'limit') {
      const limitPrice = direction === 'BUY' ? price * 0.9999 : price * 1.0001;
      const fp = engine.fillProbability.estimate({
        currentPrice: price,
        limitPrice,
        atr:       engine.lastATR || price * 0.001,
        maxWaitMs: TRADING_CONFIG.limitOrderTimeoutMs || 30_000,
        side:      direction,
        barMs:     TRADING_CONFIG.tradingInterval || 300_000,
      });
      if (!fp.useLimit) {
        engine.log(`[FillProb] Limit fill prob ${(fp.probability * 100).toFixed(1)}% < threshold — downgrading to MARKET`);
        orderType = 'market';
      } else {
        engine.log(`[FillProb] Limit fill prob ${(fp.probability * 100).toFixed(1)}% ≥ threshold — using LIMIT`);
      }
    }

    // ── ExecutionMetrics: start timer ────────────────────────────────────────
    let metricsId = null;
    if (engine.executionMetrics) {
      metricsId = engine.executionMetrics.begin(asset, direction, price, engine.lastATR || 0);
    }

    // ── IdempotentExecutor: wrap fill in dedup ────────────────────────────────
    let result;
    const spec = { asset, side: direction, size: targetShares, orderType, price };
    if (engine.idempotentExec) {
      try {
        result = await engine.idempotentExec.submit(spec, () => origFill(targetShares, price, direction));
        if (result.deduplicated) {
          engine.log(`[IdempotentExec] Duplicate ${direction} order suppressed for ${asset}`);
        }
      } catch (e) {
        // On error, attempt reconciliation then rethrow
        engine.log(`[IdempotentExec] Order error: ${e.message} — reconciling state`);
        try {
          await engine.idempotentExec.reconcile(async () => ({
            openPositions: engine.position ? [engine.position] : [],
            recentOrders: [],
          }));
        } catch (_) {}
        throw e;
      }
    } else {
      result = await origFill(targetShares, price, direction);
    }

    // ── ExecutionMetrics: record fill ─────────────────────────────────────────
    if (engine.executionMetrics && metricsId !== null) {
      const fillPrice = result?.avgEntryPrice || price;
      const fillRatio = result?.filledShares ? result.filledShares / targetShares : 1.0;
      const record    = engine.executionMetrics.end(metricsId, fillPrice, Math.min(fillRatio, 1));
      if (record) {
        engine.log(`[ExecMetrics] ${direction} fill: latency=${record.latencyMs}ms slippage=${record.slippagePips.toFixed(2)}pips quality=${record.qualityScore.toFixed(0)}/100`);

        // Alert on degraded execution and reduce future position size
        const deg = engine.executionMetrics.isExecDegraded();
        if (deg.degraded) {
          engine.log(`[ExecMetrics] ⚠️  Execution degraded: ${deg.reason}`);
          try { require('./telegram').send(`⚠️ Execution quality degraded: ${deg.reason}`, 'risk'); } catch (_) {}
          // Feature #62: Flag degradation so next entry applies a size penalty
          engine._execDegraded = true;
          engine._execDegradedAt = Date.now();
        } else if (engine._execDegraded) {
          // Clear flag after 30 minutes of good fills
          if (!engine._execDegradedAt || Date.now() - engine._execDegradedAt > 30 * 60_000) {
            engine._execDegraded = false;
            engine.log('[ExecMetrics] ✅ Execution quality restored');
          }
        }

        // Feed outcome back to fill probability model for calibration
        if (engine.fillProbability && orderType === 'limit') {
          engine.fillProbability.recordOutcome({
            distanceATR: Math.abs(fillPrice - price) / (engine.lastATR || price * 0.001),
            timeRatio:   record.latencyMs / (TRADING_CONFIG.tradingInterval || 300_000),
            filled:      fillRatio >= 0.95,
          });
        }
      }
    }

    return result;
  };

  // ── 5. SectorCap: block enterPosition when sector limit reached ────────────
  const origEnter = engine.enterPosition.bind(engine);
  engine.enterPosition = async function(price, confidence, corrMultiplier = 1) {
    // Feature #62: Reduce position size when execution quality is poor
    let effectiveMult = corrMultiplier;
    if (engine._execDegraded) {
      effectiveMult = corrMultiplier * 0.5;
      engine.log('[ExecDeg] Position size halved due to degraded execution quality');
    }
    // SectorCap check — before ANY other guard
    if (engine.sectorCap && !engine.position) {
      const check = engine.sectorCap.canEnter(engine.selectedAsset, engine.capital);
      if (!check.allowed) {
        engine.log(`[SectorCap] ⛔ Entry blocked: ${check.reason}`);
        try {
          require('./audit-tagger').record({
            type: 'SECTOR_BLOCK', asset: engine.selectedAsset, reason: check.reason,
            strategy: engine._lastStrategyName || 'unknown',
            symbol: engine.selectedAsset, timeframe: 'M5',
          });
        } catch (_) {}
        return;
      }
    }
    const result = await origEnter(price, confidence, effectiveMult);

    // Record position open in SectorCap after successful entry
    if (engine.sectorCap && engine.position) {
      engine.sectorCap.open(
        engine.selectedAsset,
        engine.position.shares,
        engine.position.entry,
        engine.capital
      );
    }
    return result;
  };

  // Patch exitPosition to remove from SectorCap
  const origExit = engine.exitPosition.bind(engine);
  engine.exitPosition = function(price, reason) {
    const wasOpen = !!engine.position;
    const asset   = engine.selectedAsset;  // capture before exit clears it
    let result;
    try {
      result = origExit(price, reason);
    } finally {
      // Bug fix #14: sectorCap.close always called, even if origExit throws
      if (wasOpen && engine.sectorCap) {
        engine.sectorCap.close(asset);
      }
    }
    return result;
  };

  // Bug fix #3: wrap enterShort — same guards as enterPosition
  const origEnterShort = engine.enterShort?.bind(engine);
  if (origEnterShort) {
    engine.enterShort = async function(price, confidence, corrMultiplier = 1) {
      // SectorCap check for SHORT
      if (engine.sectorCap && !engine.position) {
        const check = engine.sectorCap.canEnter(engine.selectedAsset, engine.capital);
        if (!check.allowed) {
          engine.log(`[SectorCap] ⛔ SHORT blocked: ${check.reason}`);
          try { require('./audit-tagger').record({ type:'SECTOR_BLOCK', side:'SHORT', asset:engine.selectedAsset,
            reason:check.reason, strategy:engine._lastStrategyName||'unknown', symbol:engine.selectedAsset, timeframe:'M5' }); } catch(_) {}
          return;
        }
      }
      const asset = engine.selectedAsset;
      // ExecutionMetrics: start timer
      let metricsId = null;
      if (engine.executionMetrics) metricsId = engine.executionMetrics.begin(asset, 'SELL', price, engine.lastATR || 0);

      const result = await origEnterShort(price, confidence, corrMultiplier);

      // Record in SectorCap after successful short entry
      if (engine.sectorCap && engine.position) {
        engine.sectorCap.open(asset, engine.position.shares || 0, price, engine.capital);
      }
      // ExecutionMetrics: end timer
      if (engine.executionMetrics && metricsId !== null) {
        engine.executionMetrics.end(metricsId, price, 1.0);
      }
      return result;
    };
  }


  engine._execHooksApplied = true;
  console.log('[ExecHooks] ✅ IdempotentExec + FeeModel + FillProb + ExecMetrics + SectorCap wired into execution path');
}

module.exports = { applyExecutionHooks };
