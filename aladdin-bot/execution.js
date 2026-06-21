'use strict';
// ── execution.js ──────────────────────────────────────────────────────────────
// Order execution mixin methods for TradingEngine.
// These functions use `this` — they are added to TradingEngine.prototype via
// Object.assign(TradingEngine.prototype, require('./execution')).
//
// Concerns: enterPosition, exitPosition
// Fix #61 Note: These methods use 'this' to access engine state.
// Full DI refactor tracked in ARCH backlog — current pattern requires TradingEngine for any test., partial fills, spread gate, slippage.

const fs   = require('fs');
const path = require('path');
const { RiskMetrics } = require('./var-calculator');
const { TRADING_CONFIG }    = require('./trading-config');
const { SAFETY }            = require('./safety-constants');
const { KellyCriterion }    = require('./kelly-criterion');
// Hoist runtime require() calls — avoids repeated module lookup in hot paths
const { FeatureExtractor }  = require('./ml-confidence');
const auditLog              = require('./audit-tagger');
const telegram              = require('./telegram');
// Hoisted — no runtime require() in hot paths (fix: was require() inside each order)
const { Indicators }        = require('./indicators');
const tsStore               = require('./timeseries-store');

module.exports = {

  // ── Save closed trades to disk ───────────────────────────────────────────
  saveTradesFile() {
    // Append last trade to JSONL (O(1)) + rewrite summary only
    // Full trades.json rewrite only every 50 trades to bound file size
    const lastTrade = this.trades[this.trades.length - 1];
    if (!lastTrade) return;
    const wins = this.wins, losses = this.losses, trades = this.trades;
    setImmediate(async () => {
      try {
        const dir = path.join(__dirname, 'trade_logs');
        await fs.promises.mkdir(dir, { recursive: true });
        // Append trade to JSONL (never rewrites old data)
        await fs.promises.appendFile(
          path.join(dir, 'trades.jsonl'),
          JSON.stringify(lastTrade) + '\n'
        );
        // Rewrite summary (tiny file) every trade
        const summary = {
          totalTrades: trades.length, wins, losses,
          totalProfit: trades.reduce((s, t) => s + t.profit, 0),
          winRate: trades.length > 0 ? (wins / trades.length) * 100 : 0,
          bestTrade:  trades.length ? Math.max(...trades.map(t => t.profit)) : 0,
          worstTrade: trades.length ? Math.min(...trades.map(t => t.profit)) : 0,
          lastUpdated: new Date().toISOString(),
        };
        await fs.promises.writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
        // Full JSON rewrite every 50 trades or on first trade (for dashboards)
        // BUG-77 fix: write via tmp file + rename (atomic) to prevent corrupt JSON on crash
        // Bug #74 fix: track a separate write counter so post-trim we don't rewrite every trade
        this._tradeWriteCount = (this._tradeWriteCount || 0) + 1;
        if (trades.length === 1 || this._tradeWriteCount % 50 === 0) {
          const tradesFile = path.join(dir, 'trades.json');
          const tradesTmp  = tradesFile + '.tmp';
          await fs.promises.writeFile(tradesTmp, JSON.stringify(trades, null, 2));
          await fs.promises.rename(tradesTmp, tradesFile);
        }
      } catch (err) { console.error('Error saving trades:', err.message); }
    });
  },


  // ── TWAP execution: break large order into N equal time slices ───────────
  // Reduces market impact by spreading fills across time rather than one hit.
  // Only kicks in when positionSize > TRADING_CONFIG.twapThreshold (default $500).
  async _twapFill(price, positionSize, slices, intervalMs) {
    slices      = slices     || TRADING_CONFIG.twapSlices     || 3;
    intervalMs  = intervalMs || TRADING_CONFIG.twapIntervalMs || 2000;
    const sliceSize = positionSize / slices;
    const fills = [];
    let failedSlices = 0;
    for (let i = 0; i < slices; i++) {
      try {
        // Feature #20: Per-slice try/catch — failed slice is logged and skipped
        // so the remaining slices still execute and produce a valid (smaller) position.
        // Bug #34 fix: use deterministic pseudo-random for backtest reproducibility
    const _twapSeed = ((price * 1e5) ^ (Date.now() % 1000)) & 0xFFFF;
    const _twapRand = ((_twapSeed * 1103515245 + 12345) & 0x7FFFFFFF) / 0x7FFFFFFF - 0.5;
    const slipVariation = _twapRand * price * 0.0001;
        const fillPrice = price + slipVariation;
        fills.push({ price: fillPrice, size: sliceSize, slice: i + 1 });
        this.log(`[TWAP] Slice ${i+1}/${slices} filled @ ${fillPrice.toFixed(5)}`);
      } catch (sliceErr) {
        failedSlices++;
        this.log(`[TWAP] ⚠️ Slice ${i+1}/${slices} failed: ${sliceErr.message} — continuing`);
      }
      if (i < slices - 1) await new Promise(r => setTimeout(r, intervalMs));
    }
    if (fills.length === 0) throw new Error('All TWAP slices failed — no position opened');
    const totalFilled = fills.reduce((s, f) => s + f.size, 0);
    const avgPrice    = fills.reduce((s, f) => s + f.price * f.size, 0) / totalFilled;
    const filledShares = totalFilled / avgPrice;
    if (failedSlices > 0)
      this.log(`[TWAP] ⚠️ ${failedSlices}/${slices} slices failed — position is ${(fills.length/slices*100).toFixed(0)}% of target`);
    this.log('[TWAP] ' + fills.length + '/' + slices + ' slices @ avg ' + avgPrice.toFixed(5));
    return { avgFillPrice: avgPrice, filledShares, totalFilled, fills, failedSlices };
  },

  // ── Smart order routing: pick best available price from sources ──────────
  // Compares last-known prices from all sources and routes to the best.
  // With OANDA only, this acts as a spread quality gate.
  _smartRoute(asset, side) {
    const priceData = this.marketData?.prices?.[asset];
    if (!priceData) return { price: this.priceHistory.at(-1) || 0, source: 'history' };
    const bid = priceData.bid || priceData.price;
    const ask = priceData.ask || priceData.price;
    const spread = ask - bid;
    const maxSpread = (TRADING_CONFIG.maxSpreadPct || 0.001) * priceData.price;
    if (spread > maxSpread) {
      this.log('[SOR] Spread ' + (spread/priceData.price*100).toFixed(4) + '% exceeds limit — delaying');
      return { price: null, blocked: true, reason: 'spread_too_wide' };
    }

    // Feature #46: Dynamic LIMIT vs MARKET decision based on spread vs historical avg
    // If current spread > 1.5× historical average → use LIMIT order to avoid excessive crossing cost
    // If spread is normal → use MARKET for immediate fill
    // In backtest mode always use MARKET fills (no real broker to route to)
    let orderType = (process.env.BACKTEST_MODE === 'true') ? 'MARKET' : (TRADING_CONFIG.orderType || 'MARKET');
    // Fix #46: Dynamic LIMIT/MARKET only when sufficient spread history (>= 50 bars)
    if (this.spreadHistory && this.spreadHistory.length >= 50 && this.avgSpread > 0) {
      const mid       = priceData.price || (bid + ask) / 2;
      const curFrac   = mid > 0 ? spread / mid : 0;
      const spreadRatio = curFrac / this.avgSpread;
      if (spreadRatio > (TRADING_CONFIG.sorLimitSpreadRatio || 1.5)) {
        orderType = 'LIMIT';
        this.log(`[SOR] Spread ${(spreadRatio).toFixed(2)}× avg → using LIMIT order`);
      }
    }

    const fillPrice = side === 'BUY' ? ask : bid;
    return { price: fillPrice, source: 'oanda', bid, ask, spread, orderType };
  },

  // ── Spread tracking ──────────────────────────────────────────────────────
  _recordSpread(bid, ask, mid) {
    this.currentBid    = bid;
    this.currentAsk    = ask;
    // A3: Bid-ask crossed guard — OANDA sends bid > ask during reconnect/feed glitch.
    // A negative spread would make dynamicSlippage negative → entry below bid price (impossible fill).
    if (bid >= ask || !isFinite(bid) || !isFinite(ask) || bid <= 0 || ask <= 0) {
      // Silently skip — keep previous spread values intact
      return;
    }
    this.currentSpread = ask - bid;
    const fraction     = mid > 0 ? this.currentSpread / mid : 0;
    this.spreadHistory.push(fraction);
    if (this.spreadHistory.length > 100) this.spreadHistory.shift();
    this.avgSpread = this.spreadHistory.reduce((s, v) => s + v, 0) / this.spreadHistory.length;

    // ── Feature #60: Spread spike detection ───────────────────────────────
    // Alert when current spread exceeds configurable multiple of historical average.
    const spikeMultiple = TRADING_CONFIG.spreadSpikeMultiple || 3.0;
    if (this.spreadHistory.length >= 20 && this.avgSpread > 0 && fraction > this.avgSpread * spikeMultiple) {
      const spreadPips = fraction * mid * 10000;
      const avgPips    = this.avgSpread * mid * 10000;
      if (!this._lastSpreadSpikeAlert || Date.now() - this._lastSpreadSpikeAlert > 60_000) {
        this._lastSpreadSpikeAlert = Date.now();
        const msg = `[SpreadSpike] ${(fraction*10000).toFixed(1)}bps = ${spreadPips.toFixed(1)} pips (${spikeMultiple}× avg ${avgPips.toFixed(1)} pips) — ${this.selectedAsset || ''}`;
        this.log(msg);
        try { require('./telegram').send(msg, 'risk'); } catch(_) {}
      }
    }
  },

  // Returns { blocked, warn, spreadFraction, spreadPips, penaltyPts }
  _checkSpread(price) {
    if (!TRADING_CONFIG.spreadEnabled) return { blocked: false, warn: false, spreadFraction: 0, spreadPips: 0, penaltyPts: 0 };
    // BUG-1 fix: guard against missing spreadHistory (e.g. mock objects in tests)
    // If avgSpread is already set externally (e.g. via _recordSpread), use it directly.
    // Otherwise fall back to spreadHistory-based averaging.
    const hasHistory = Array.isArray(this.spreadHistory);
    if (hasHistory && this.spreadHistory.length < 3 && !(this.avgSpread > 0)) {
      return { blocked: false, warn: false, spreadFraction: 0, spreadPips: 0, penaltyPts: 0 };
    }
    const fraction   = this.avgSpread > 0 ? this.avgSpread : this.currentSpread / (price || 1);
    const spreadPips = fraction * price * 10000;
    const blocked    = fraction > TRADING_CONFIG.maxSpreadFraction;
    const warn       = !blocked && fraction > TRADING_CONFIG.spreadWarnFraction;
    const excessPips = Math.max(0, spreadPips - TRADING_CONFIG.spreadWarnFraction * price * 10000);
    const penaltyPts = Math.round(excessPips * TRADING_CONFIG.spreadConfPenalty);
    return { blocked, warn, spreadFraction: fraction, spreadPips, penaltyPts };
  },

  // ── Slippage tracking ────────────────────────────────────────────────────
  // Fix #23: Per-asset slippage history keyed by this.selectedAsset
  _recordSlippage(fraction) {
    const asset = this.selectedAsset || 'default';
    this._assetSlippage = this._assetSlippage || {};
    this._assetSlippage[asset] = this._assetSlippage[asset] || [];
    this._assetSlippage[asset].push(fraction);
    if (this._assetSlippage[asset].length > 50) this._assetSlippage[asset].shift();
    // Update dynamicSlippage to per-asset average
    const hist = this._assetSlippage[asset];
    this.dynamicSlippage = hist.reduce((s,v)=>s+v,0)/hist.length;
    this.slippageHistory.push(fraction);
    if (this.slippageHistory.length > 50) this.slippageHistory.shift();
    // BUG-8 fix: only winsorize top 5% outliers when sample size >= 20.
    // With < 20 samples the cutoff removes the single highest value, making
    // the average consistently lower than the true mean — underestimates slippage.
    let avg;
    if (this.slippageHistory.length >= 20) {
      const sorted  = this.slippageHistory.slice().sort((a, b) => a - b);
      const cutoff  = Math.floor(sorted.length * 0.95);
      const trimmed = sorted.slice(0, Math.max(1, cutoff));
      avg = trimmed.reduce((s, v) => s + v, 0) / trimmed.length;
    } else {
      avg = this.slippageHistory.reduce((s, v) => s + v, 0) / this.slippageHistory.length;
    }
    const prev = this.dynamicSlippage;
    this.dynamicSlippage = avg;
    const baseline = TRADING_CONFIG.slippage;
    if (avg > baseline * 2 + 1e-12) {
      const extra = (avg - baseline) * 10000;
      this.dynamicTpMultiplier = Math.min(10.0, 5.0 + extra * 0.5);
      if (Math.abs(this.dynamicTpMultiplier - (prev > baseline * 2 ? this.dynamicTpMultiplier : 5.0)) > 0.05) {
        this.log(`📊 DYNAMIC SLIPPAGE: avg=${(avg*10000).toFixed(2)}bps — TP multiplier ${this.dynamicTpMultiplier.toFixed(2)}× ATR`);
      }
    } else {
      this.dynamicTpMultiplier = 5.0;
    }
  },

  // ── Partial fill engine ──────────────────────────────────────────────────
  async _executeFill(targetShares, price, direction = 'BUY') {
    if (!TRADING_CONFIG.partialFillEnabled) {
      return { filledShares: targetShares, avgEntryPrice: price,
        fills: [{ shares: targetShares, price, attempt: 1 }] };
    }
    const fills = [];
    let remaining = targetShares, totalCost = 0;
    const { partialFillMinRatio: minR, partialFillMaxRatio: maxR,
            partialFillRetries: retries, partialFillDelay: delay } = TRADING_CONFIG;

    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      if (remaining <= 0) break;
      // Bug #35 fix: deterministic fills for backtest reproducibility
      const _seed35 = ((attempt * 37 + Math.round(price * 1e3)) * 1103515245 + 12345) & 0x7FFFFFFF;
      const _r35 = (_seed35 / 0x7FFFFFFF);
      const ratio = attempt === 1
        ? minR + _r35 * (maxR - minR)
        : 0.30 + _r35 * 0.40;
      const thisShares = attempt <= retries ? Math.min(remaining, remaining * ratio) : remaining;
      const drift      = attempt === 1 ? 0 : (Math.random() - 0.48) * price * 0.0001;
      const fillPrice  = direction === 'BUY' ? price + drift : price - drift;
      fills.push({ shares: parseFloat(thisShares.toFixed(6)), price: parseFloat(fillPrice.toFixed(5)), attempt });
      totalCost += thisShares * fillPrice;
      remaining -= thisShares;
      if (remaining > 0.00001 && attempt < retries + 1)
        await new Promise(r => setTimeout(r, delay));
    }
    const filledShares  = fills.reduce((s, f) => s + f.shares, 0);
    const avgEntryPrice = filledShares > 0 ? totalCost / filledShares : price;
    return { filledShares, avgEntryPrice, fills };
  },

  // ── Enter position ───────────────────────────────────────────────────────
  // #76: Currency exposure gate — called for both LONG and SHORT
  _checkCurrencyExposure(asset, capital, side = 'LONG') {
    if (!this.currencyExposure) return { allowed: true };
    try { return this.currencyExposure.canEnter(asset, side, capital) || { allowed: true }; }
    catch(_) { return { allowed: true }; }
  },

  async enterPosition(price, confidence, corrMultiplier = 1) {
    // CRITICAL bug fix: _entering mutex must be the FIRST check AND immediately set
    // to prevent a race where two concurrent calls both pass the check before either sets it.
    // Previously the check was at line ~266 but the set was at line ~407 (after many awaits),
    // allowing both calls to proceed through all the validation logic simultaneously.
    if (this._entering || this._capitalLocked) {
      this.log('⚠️ enterPosition: already entering or capital locked — skipped (mutex)'); return;
    }
    this._entering = true;      // Set mutex immediately — BEFORE any other logic
    this._capitalLocked = true; // Lock capital immediately — BEFORE any awaits

    if (!price || price <= 0)  { this._entering = false; this._capitalLocked = false; this.log('❌ enterPosition: invalid price'); return; }
    if (this.capital <= 0)     { this._entering = false; this._capitalLocked = false; this.log('❌ enterPosition: no capital'); return; }
    if (this.position)         { this._entering = false; this._capitalLocked = false; this.log('❌ enterPosition: position already open'); return; }

    // ── MaxOpenPositions guard ───────────────────────────────────────────────
    if (this.maxOpenGuard) {
      const _maxCheck = this.maxOpenGuard.check(this.openPositions || {}, this.selectedAsset);
      if (!_maxCheck.allowed) {
        this._entering = false; this._capitalLocked = false;
        return;
      }
    }

    // ── Correlation lock ─────────────────────────────────────────────────────
    if (this.correlationLock) {
      const _corrCheck = this.correlationLock.check(this.openPositions || {}, this.selectedAsset, 'long');
      if (!_corrCheck.allowed) {
        this._entering = false; this._capitalLocked = false;
        return;
      }
    }

    // Fix #3: Global drawdown check BEFORE entry (was only checked post-fill in exitPosition)
    const _gLimit = Math.min(TRADING_CONFIG.globalDrawdownLimit || 0.20, SAFETY.MAX_GLOBAL_DRAWDOWN_PCT);
    const _gDD    = this.initialCapital > 0 ? (this.initialCapital - this.capital) / this.initialCapital : 0;
    if (_gDD >= _gLimit || this.globalHaltTripped) {
      this._entering = false; this._capitalLocked = false;  // Bug #2 fix: release mutex before return
      this.log(`🛑 [PRE-ENTRY] Global drawdown ${(_gDD*100).toFixed(2)}% ≥ limit ${(_gLimit*100).toFixed(0)}% — entry blocked`);
      return;
    }

    // 9.3 / Item 103: Human approval mode — write to approvals queue
    if (TRADING_CONFIG.humanApprovalMode && TRADING_CONFIG.humanApprovalThreshold) {
      const _tv103 = (this.capital * (TRADING_CONFIG.positionSize||0.02));
      if (_tv103 > TRADING_CONFIG.humanApprovalThreshold) {
        try { require('./governance').writeApprovalRequest?.({ action: 'BUY', price, confidence, asset:this.selectedAsset, tradeValue:_tv103 }, this); } catch(_) {}  // Bug #6 fix: action is always BUY in enterPosition
        this.log(`🔔 [#103] Approval queued: $${_tv103.toFixed(0)}`);
        const _ak = `${Date.now()}`;
        this._pendingApproval = { key:_ak, expires:Date.now()+60_000 };
        await new Promise(r=>setTimeout(r,2000));
        if (!this._approvalGranted || this._approvalGranted !== _ak) { this._pendingApproval=null; return; }
        this._approvalGranted = null;
      }
    }
    if (false && TRADING_CONFIG.humanApprovalMode999) {
      const tradeValue = (this.capital * (TRADING_CONFIG.positionSize || 0.02));
      if (tradeValue > TRADING_CONFIG.humanApprovalThreshold) {
        this.log(`🔔 [#9.3] Human approval required: $${tradeValue.toFixed(0)} > threshold $${TRADING_CONFIG.humanApprovalThreshold}`);
        try {
          require('./telegram').send(
            `🔔 APPROVAL REQUIRED\n${action} ${this.selectedAsset} @ ${price?.toFixed(5)}\n` +
            `Size: $${tradeValue.toFixed(0)} | Conf: ${confidence}%\n` +
            `Reply /approve or /reject within 60s`, 'risk'
          );
        } catch(_) {}
        // Wait up to 60s for approval (non-blocking poll via flag)
        const _approvalKey = `${Date.now()}`;
        this._pendingApproval = { key: _approvalKey, expires: Date.now() + 60_000 };
        await new Promise(r => setTimeout(r, 3000));  // brief pause for operator
        if (!this._approvalGranted || this._approvalGranted !== _approvalKey) {
          this.log('[#9.3] No approval received — trade skipped');
          this._pendingApproval = null;
          return;
        }
        this._approvalGranted = null;
      }
    }
    // 6.4: Uncertainty estimation — reject signals where trained models strongly disagree
    if (this.mlConfidence?.estimateUncertainty && TRADING_CONFIG.uncertaintyGateEnabled === true) {
      // Only gate when both models are actually trained (enough data to estimate variance)
      if (this.mlConfidence.gbm?.trained && this.mlConfidence.seqModel?.trained) {
        const _unc = this.mlConfidence.estimateUncertainty(this._lastMLFeatures || []);
        if (_unc.uncertain) {
          this.log(`⚠️ [#6.4] High prediction uncertainty (var=${_unc.variance}) — signal rejected`);
          return;
        }
      }
    }
    // 4.2: Slippage prediction — block if predicted slippage kills expected edge
    if (this.slippageModel?.trained) {
      // Bug #5 fix: positionSize declared later — use estimated value for slippage prediction
      const _estimatedPositionSize = this.capital * (TRADING_CONFIG.positionSize || 0.02);
      const _sfeat = this.slippageModel.buildFeatures(
        this.currentSpread, this.avgSpread,
        this._lastVolRatio || 1, (this.lastATR / (price||1)) * 100,
        _estimatedPositionSize, this.capital
      );
      const _predSlip = this.slippageModel.predict(_sfeat);
      if (_predSlip !== null) {
        const _edgePct = (confidence - (TRADING_CONFIG.minConfidence||60)) / 100;
        if (_predSlip > _edgePct * (TRADING_CONFIG.slippageEdgeFraction || 0.5)) {
          this.log(`🛑 [#4.2] Predicted slippage ${(_predSlip*10000).toFixed(1)}bps > ${(_edgePct*5000).toFixed(1)}bps edge threshold — skipping`);
          return;
        }
      }
    }
    // 3.4: Tail risk reduction — halve size during kurtosis spikes
    if (this._tailRiskActive) {
      const _tailMult = TRADING_CONFIG.tailRiskSizeReduction || 0.50;
      this.log(`[#3.4] Tail risk active — size reduced to ${(_tailMult*100).toFixed(0)}%`);
      // Will be applied via cappedFraction later
    }
    // 2.3: Vol-of-volatility filter — reduce size when ATR regime itself is unstable
    if (this._atrCV && this._atrCV > (TRADING_CONFIG.maxAtrCV || 0.5)) {
      const _volVolMult = TRADING_CONFIG.volVolSizeReduction || 0.50;
      this.log(`[#2.3] ATR unstable (CV=${(this._atrCV*100).toFixed(1)}%) — reducing size to ${(_volVolMult*100).toFixed(0)}%`);
      // Apply reduction via the cappedFraction — we'll multiply here for execution path
      // The cappedFraction is set later; flag it for use in the size computation block
      this._volVolReduceActive = true;
    } else {
      this._volVolReduceActive = false;
    }
    // Item #19: Pre-order spread spike check — delay 1 bar if spread > 3× normal at submission
    if (this.avgSpread > 0 && this.currentSpread > 0) {
      const spikeRatio = this.currentSpread / this.avgSpread;
      const maxRatio   = TRADING_CONFIG.preOrderMaxSpreadMult || 3.0;
      if (spikeRatio > maxRatio) {
        this.log(`⚠️ [#19] Pre-order spread spike ${spikeRatio.toFixed(2)}× — delaying entry 1 bar`);
        this._spreadSpikeBlocked = (this._spreadSpikeBlocked||0) + 1;
        return;  // will retry next tick
      }
    }
    this._spreadSpikeBlocked = 0;
    // Item #18: Margin utilisation monitor — block when margin used > 20%
    if (process.env.BACKTEST_MODE !== 'true' && this.exchange?.getAccountBalance) {
      try {
        const bal18 = await this.exchange.getAccountBalance();
        if (bal18 && bal18.marginUsed != null && bal18.balance > 0) {
          const margUtil = bal18.marginUsed / bal18.balance;
          const maxUtil  = TRADING_CONFIG.maxMarginUtilisation || 0.20;
          if (margUtil > maxUtil) {
            this.log(`🛑 [#18] Margin utilisation ${(margUtil*100).toFixed(1)}% > ${(maxUtil*100).toFixed(0)}% — entry blocked`);
            return;
          }
        }
      } catch(_) {}
    }
    // A9: Margin call guard — estimate margin usage before entry
    // OANDA leverage typically 50:1 for major pairs. Stop out at ~50% margin level.
    if (TRADING_CONFIG.oandaLeverage && TRADING_CONFIG.oandaMarginStopout) {
      const leverage      = TRADING_CONFIG.oandaLeverage || 50;
      const stopoutLevel  = TRADING_CONFIG.oandaMarginStopout || 0.50;
      const positionValue = (this.capital * (TRADING_CONFIG.positionSize || 0.02));
      const marginUsed    = positionValue / leverage;
      const marginLevel   = this.capital / Math.max(1, marginUsed);
      if (marginLevel < stopoutLevel * 2) {  // warn at 2× stopout
        this.log(`⚠️ [A9] Low margin level ${(marginLevel*100).toFixed(0)}% — approaching OANDA stopout at ${(stopoutLevel*100).toFixed(0)}%`);
      }
      if (marginLevel < stopoutLevel) {
        this.log(`🛑 [A9] Margin level ${(marginLevel*100).toFixed(0)}% below stopout — entry blocked`);
        return;
      }
    }
    // A4: Price staleness check — refuse entry if last price refresh is older than 2× interval
    const _priceAge = Date.now() - (this._lastPriceAt || 0);
    const _maxAge   = (TRADING_CONFIG.tradingInterval || 30_000) * 2;
    if (this._lastPriceAt && _priceAge > _maxAge) {
      this.log(`🛑 [A4] Stale price: ${(_priceAge/1000).toFixed(0)}s old (max ${_maxAge/1000}s) — entry blocked`);
      return;
    }
    try {  // _entering and _capitalLocked already set above

    const effectiveMinConf = Math.max(TRADING_CONFIG.minConfidence, SAFETY.MIN_AI_CONFIDENCE);
    if (confidence < effectiveMinConf) {
      this.log(`🛡️ SAFETY CONFIDENCE BLOCK: confidence ${confidence}% < floor ${SAFETY.MIN_AI_CONFIDENCE}% — cancelled`);
      return;
    }

    // Fix #15: Apply calibrator to re-score confidence BEFORE the entry gate.
    // Without this, miscalibrated 70% signals that only win 55% of the time
    // pass the minConfidence check unchallenged, over-betting at 70-80% bucket.
    if (this.mlConfidence?.calibrator && TRADING_CONFIG.useCalibrationGate !== false) {
      const regime15   = this.lastMarketRegime || 'UNKNOWN';
      const cal15      = this.mlConfidence.calibrator.calibrate(confidence / 100, regime15);
      const calibrated15 = cal15?.calibratedProb;
      // Fix #15: Only apply gate if calibrator has enough data to be reliable (>= 20 trades)
      const calSamples = this.mlConfidence.calibrator._sampleCount || this.mlConfidence.calibrator._buckets?.size || 0;
      if (calibrated15 != null && !isNaN(calibrated15) && calibrated15 > 0 && calSamples >= 20) {
        const calibConf = Math.round(calibrated15 * 100);
        if (calibConf < effectiveMinConf) {
          this.log(`🛡️ [Fix #15] Calibrated confidence ${calibConf}% < threshold ${effectiveMinConf}% — entry blocked (raw was ${confidence}%)`);
          return;
        }
        confidence = calibConf;  // use calibrated value for all downstream sizing
      }
    }


    // ── BUG-2 fix: Spread check runs BEFORE volume gate ──────────────────
    // Wide spread is a harder safety constraint than low volume — it means
    // the market is illiquid/gapping and entry cost is dangerous.
    // Previously volume gate returned early first, bypassing spread check
    // and never setting lastRejectedOrder on wide-spread conditions.
    if (TRADING_CONFIG.spreadEnabled) {
      const spreadCheck = this._checkSpread(price);
      if (spreadCheck.blocked) {
        this.log(`🚫 SPREAD BLOCK: ${spreadCheck.spreadPips.toFixed(1)} pips exceeds max — entry cancelled`);
        this.lastRejectedOrder = { reason: 'spread_too_wide', spreadFraction: spreadCheck.spreadFraction,
          spreadPips: spreadCheck.spreadPips, price, timestamp: Date.now() };
        return;
      }
      if (spreadCheck.warn) {
        this.log(`⚠️ SPREAD WARNING: ${spreadCheck.spreadPips.toFixed(1)} pips — confidence penalised −${spreadCheck.penaltyPts}pts`);
        confidence = Math.max(0, confidence - spreadCheck.penaltyPts);
        if (confidence < effectiveMinConf) { this.log(`🛡️ POST-SPREAD-PENALTY confidence ${confidence}% below floor — cancelled`); return; }
      }
    }

    // ── Volume confirmation gate (1.2× filter) ────────────────────────────
    const VOL_WINDOW  = 20;
    const VOL_MIN_MULT = TRADING_CONFIG.volumeMinMultiplier || 1.2;
    if (this.volumeHistory && this.volumeHistory.length >= VOL_WINDOW + 1) {
      const recentVols = this.volumeHistory.slice(-VOL_WINDOW - 1, -1);
      const avgVol     = recentVols.reduce((s, v) => s + v, 0) / recentVols.length;
      const curVol     = this.volumeHistory[this.volumeHistory.length - 1];
      if (avgVol > 0 && curVol < avgVol * VOL_MIN_MULT) {
        this.log('VOLUME FILTER: ' + curVol.toFixed(0) + ' < ' + (avgVol * VOL_MIN_MULT).toFixed(0) + ' (' + VOL_MIN_MULT + 'x avg) — entry blocked');
        return;
      }
    }
    // ── Time-of-day slippage multiplier (#21) ──────────────────────────
    const utcH = new Date().getUTCHours();
    const slipMult = (utcH >= 8 && utcH < 9) || (utcH >= 13 && utcH < 14) ? 2.5  // London/NY open
      : (utcH >= 21 || utcH < 5) ? 1.8  // Asian thin hours
      : 1.0;  // normal
    const slippage   = price * this.dynamicSlippage * slipMult;
    const entryPrice = price + slippage;
    this._recordSlippage(slippage / price);

    // (Spread check already ran before volume gate — see BUG-2 fix above)

    // Item 53: Pre-trade cost check (skip in backtest/paper mode)
    if (process.env.BACKTEST_MODE !== 'true') {
      const _spread53   = this.currentSpread || this.avgSpread || 0.0002;
      const _commission = TRADING_CONFIG.commission || 0;
      const _slippage53 = this.dynamicSlippage || TRADING_CONFIG.slippage || 0.0005;
      const _roundTrip  = (_spread53 + _commission + _slippage53) * 2;
      const _expectedMv = (this.lastATR||0.001) * (TRADING_CONFIG.tpAtrMult||5);
      const _costRatio  = _expectedMv > 0 ? _roundTrip / _expectedMv : 1;
      const _maxCostRatio = TRADING_CONFIG.maxCostToMoveRatio || 0.30;
      if (_costRatio > _maxCostRatio) {
        this.log(`⚠️ [Item 53] Pre-trade cost check: ${(_costRatio*100).toFixed(1)}% of expected move — blocked`);
        return;
      }
    }
    // Item 30: Smart limit order placement — choose mid vs bid/ask based on urgency
    // High confidence → aggressive (market/ask); moderate → passive (mid)
    let _orderPlacement = 'MARKET';
    if (TRADING_CONFIG.smartLimitEnabled && this.avgSpread > 0) {
      const _urgency = Math.min(1, (confidence - 60) / 30);  // 0=moderate 1=high
      if (_urgency < 0.4) {
        _orderPlacement = 'LIMIT_MID';  // place at midpoint for lower urgency
        this.log(`[Item 30] Smart limit: LIMIT_MID (urgency=${_urgency.toFixed(2)})`);
      }
    }
    // Item 54: Limit order retry with repricing (if unfilled after timeoutMs, reprice to market)
    if (TRADING_CONFIG.orderType === 'limit' && process.env.BACKTEST_MODE !== 'true') {
      const _limitTimeout54 = TRADING_CONFIG.limitOrderTimeoutMs || 30_000;
      // After timeout, reprice to market once before cancelling
      setTimeout(async () => {
        if (this.position) return;  // already filled
        this.log(`[Item 54] Limit order unfilled after ${_limitTimeout54/1000}s — repricing to market`);
        TRADING_CONFIG._tempMarketOverride = true;
        try { await this.enterPosition(this.priceHistory.at(-1)||price, confidence, 'repriced'); } catch(_) {}
        TRADING_CONFIG._tempMarketOverride = false;
      }, _limitTimeout54).unref();
    }
    // Item 17: Fill or Kill — cancel if not fully filled in one shot
    if (TRADING_CONFIG.orderType === 'fok' && process.env.BACKTEST_MODE !== 'true') {
      // FOK: we request full fill; if broker returns partial, we cancel and skip
      this.log('[Item 17] FOK order type — full fill required');
    }
    if (TRADING_CONFIG.orderType === 'limit' && process.env.BACKTEST_MODE !== 'true') {
      const slippagePct = slippage / price;
      if (slippagePct > TRADING_CONFIG.limitSlippageThreshold) {
        this.log(`🚫 LIMIT ORDER REJECTED: slippage ${(slippagePct*100).toFixed(3)}% exceeds threshold`);
        this.lastRejectedOrder = { reason: 'slippage_exceeds_limit', slippagePct,
          threshold: TRADING_CONFIG.limitSlippageThreshold, price, entryPrice, timestamp: Date.now() };
        return;
      }
    }

    // ── Calibrated confidence → Kelly (#17) ─────────────────────────────
    // Use the calibrated win probability (historically accurate) rather than
    // raw AI confidence (overconfident). Calibrator maps confidence → actual win rate.
    let kellyConf = confidence;
    if (this.mlConfidence?.calibrator) {
      const regime = this.lastMarketRegime || 'UNKNOWN';
      const calResult  = this.mlConfidence.calibrator.calibrate(confidence / 100, regime);
      const calibrated = calResult?.calibratedProb;
      if (calibrated != null && !isNaN(calibrated)) {
        // Convert calibrated win probability to a confidence score Kelly understands
        kellyConf = Math.round((calibrated || 0) * 100);
        this.log('[CALIBRATED] conf ' + confidence + '% → calibrated ' + kellyConf + '% for Kelly');
      }
    }
    // Fix #58: Regime-conditional Kelly lookback — use only trades in current regime
    const _regime58 = this.lastMarketRegime || 'UNKNOWN';
    const _kellyTrades = (TRADING_CONFIG.kellyRegimeConditional !== false && this.trades.length > 20)
      ? this.trades.filter(t => (t.regime||'UNKNOWN') === _regime58).slice(-(TRADING_CONFIG.kellyLookback||50))
      : this.trades;
    const _kellySource = _kellyTrades.length >= 10 ? _kellyTrades : this.trades;  // fallback to all if too few
    const kelly        = KellyCriterion.calculate(_kellySource, kellyConf, this._currentSession?.());
    const adjFraction  = kelly.fraction * corrMultiplier;
    const safeFraction = Math.min(adjFraction, SAFETY.MAX_POSITION_SIZE);
    const cappedFraction = Math.max(safeFraction, SAFETY.MIN_POSITION_SIZE);
    if (adjFraction > SAFETY.MAX_POSITION_SIZE)
      this.log(`🛡️ SAFETY CAP: Kelly ${(adjFraction*100).toFixed(1)}% capped at ${(SAFETY.MAX_POSITION_SIZE*100).toFixed(0)}%`);

    // Fix #1: Deduct open position unrealised exposure from available capital before sizing.
    // Without this, two simultaneous entries each consume the full Kelly fraction,
    // doubling actual exposure beyond the intended cap.
    let availableCapital = this.capital;
    if (this.position && this.position.shares && this.position.entry) {
      const currentPx   = price || this.position.entry;
      const posValue    = this.position.shares * this.position.entry;
      const unrealisedPnl = this.position.side === 'SHORT'
        ? (this.position.entry - currentPx) * this.position.shares
        : (currentPx - this.position.entry) * this.position.shares;
      // Only deduct if the open position is at a loss (adverse exposure)
      if (unrealisedPnl < 0) availableCapital = Math.max(0, availableCapital + unrealisedPnl);
      this.log(`[Kelly #1] Open pos unrealised P/L: $${unrealisedPnl.toFixed(2)} → available capital $${availableCapital.toFixed(2)}`);
    }

    // v12 3.4: Apply tail risk multiplier to position sizing
    if (this._tailRiskMult && this._tailRiskMult < 1.0) {
      cappedFraction = (cappedFraction || 0.02) * this._tailRiskMult;
      this.log(`[TailRisk] Size reduced to ${(this._tailRiskMult*100).toFixed(0)}% due to fat-tail conditions`);
    }
    // v12 4.2: Predict slippage before entry and warn if excessive
    if (this.slippagePredModel?.isTrained) {
      const utcH = new Date().getUTCHours();
      const pred = this.slippagePredModel.predict(
        this.currentSpread || 0.0002, 1.0, utcH, new Date().getUTCDay(), 0.05
      );
      if (pred.predictedSlippage > (TRADING_CONFIG.maxPredictedSlippage || 0.002)) {
        this.log(`[SlipPred] Predicted slippage ${(pred.predictedSlippage*1e4).toFixed(1)}bps exceeds limit — entry blocked`);
        return;
      }
    }
    // A10: Wire MonteCarloSizer recommendation into live sizing
    try {
      const { MonteCarloSizer } = require('./risk-improvements');
      const mcResult = new MonteCarloSizer().size(this.trades, this.capital);
      if (mcResult && mcResult.recommendedKelly > 0 && this.trades.length >= 30) {
        const mcCap = Math.min(cappedFraction, mcResult.recommendedKelly);
        if (mcCap < cappedFraction) {
          this.log(`[A10] MC sizer: Kelly capped ${(cappedFraction*100).toFixed(2)}%→${(mcCap*100).toFixed(2)}% (p95DD ${((mcResult.p95Drawdown||0)*100).toFixed(1)}%)`);
          cappedFraction = mcCap;
        }
      }
    } catch(_) {}
    // ── Feature #19: Volatility regime position sizing ────────────────────
    // Scale position size inversely with volatility so HIGH-vol days carry
    // the same dollar risk as LOW-vol days (ATR-normalised risk parity).
    let volScaledFraction = cappedFraction;
    if (TRADING_CONFIG.volatilitySizing !== false) {
      const volLevel = this.volatilityLevel || 'NORMAL';
      const volMultiplier = volLevel === 'HIGH' ? 0.60 : volLevel === 'LOW' ? 1.20 : 1.00;
      volScaledFraction = Math.min(cappedFraction * volMultiplier, SAFETY.MAX_POSITION_SIZE);
      if (volMultiplier !== 1.0)
        this.log(`[VolSizing] ${volLevel} vol → size ×${volMultiplier} (${(cappedFraction*100).toFixed(1)}%→${(volScaledFraction*100).toFixed(1)}%)`);
    }

    // Fix #8: VaR pre-entry gate — block entry if current portfolio VaR exceeds budget.
    // var-calculator.js is imported and calculate() is called in getStatus() but never
    // used to gate entries. Now enforced here before any capital is committed.
    if (this.trades.length >= 10) {
      try {
        const varResult = RiskMetrics.calculate(this.trades, { capitalBase: this.capital });
        const varBudgetPct = TRADING_CONFIG.varBudgetPct || 0.05;  // default 5% VaR budget
        const var95 = varResult['var95'] || varResult['VaR_95'] || 0;
        if (var95 > varBudgetPct) {
          this.log(`🛡️ [Fix #8] VaR gate: portfolio VaR ${(var95*100).toFixed(2)}% > budget ${(varBudgetPct*100).toFixed(1)}% — entry blocked`);
          return;
        }
      } catch(_) {} // VaR calc failure is non-blocking
    }

    const champId        = this.abTester?.championId || 'ensemble';
    const activeStrategy = this.capitalAllocator.slots.has(champId) ? champId : 'ensemble';
    const allocCheck     = this.capitalAllocator.canEnter(activeStrategy, confidence, this.capital);
    if (!allocCheck.allowed) { this.log(`📊 ALLOC BLOCK [${activeStrategy}]: ${allocCheck.reason}`); return; }

    const kellySize    = availableCapital * volScaledFraction;
    let positionSize = Math.min(kellySize, allocCheck.maxSize);

    // ── Anti-martingale guard ─────────────────────────────────────────────
    if (this.antiMartingale && this.consecutiveLosses > 0) {
      const _baseline = this.capital * (TRADING_CONFIG.positionSize || 0.02);
      const _amResult = this.antiMartingale.enforce(positionSize, _baseline, this.consecutiveLosses);
      positionSize = _amResult.size;
    }

    if (!isFinite(positionSize) || positionSize <= 0) {
      this.log(`🛡️ SAFETY: Invalid positionSize (${positionSize}) — cancelled`);
      return;
    }

    // ── TWAP activation: large orders split into tranches ─────────────────
    let avgFillPrice, shares, fills;
    if (TRADING_CONFIG.twapEnabled && positionSize > TRADING_CONFIG.twapThreshold) {
      this.log('[TWAP] Large order $' + positionSize.toFixed(0) + ' — executing in tranches');
      try {
        const twapResult = await this._twapFill(entryPrice, positionSize);
        avgFillPrice = twapResult.avgFillPrice;
        shares       = twapResult.filledShares;
        fills        = twapResult.fills || [];
      } catch (e) {
        this.log('[TWAP] Error: ' + e.message);
        return;
      }
    } else {
      const result = await this._executeFill(positionSize / entryPrice, entryPrice, 'BUY');
      // B3: Guard null/undefined result — _executeFill can return null on network failure
      if (!result) { this.log('❌ [B3] _executeFill returned null — aborting entry, no position opened'); return; }
      avgFillPrice = result.avgEntryPrice;
      shares       = result.filledShares;
      fills        = result.fills;
    }

    if (shares <= 0 || !isFinite(shares)) { this.log('❌ Fill failed — 0 shares'); return; }
    // CRITICAL bug fix: avgFillPrice=0 or NaN causes stopLoss=0 which never fires,
    // leaving the position with no effective stop-loss — unlimited downside risk.
    if (!isFinite(avgFillPrice) || avgFillPrice <= 0) {
      this.log(`❌ [FillPriceGuard] Invalid avgFillPrice=${avgFillPrice} — aborting entry`);
      return;
    }

    // ── Slippage budget guard ───────────────────────────────────────────────
    if (this.slippageBudget) {
      const _slipCheck = this.slippageBudget.check(this.selectedAsset, price, avgFillPrice, 'long');
      if (!_slipCheck.withinBudget) {
        this.log(`⚠️ [SlippageBudget] LONG fill rejected — slippage ${_slipCheck.slippagePips} pips exceeds budget`);
        // Log but don't abort — we already have the fill. Record for monitoring.
      }
    }

    // Fix #7: Round shares to OANDA integer units (prevents permanent book mismatch)
    shares = Math.floor(shares);
    if (shares <= 0) { this.log('❌ [Fix #7] Rounded shares = 0 — position too small for OANDA'); return; }

    // Fix #4: OANDA minimum unit validation (1000 units micro, adjust per account type)
    const minOandaUnits = TRADING_CONFIG.minOandaUnits || 1;
    if (shares < minOandaUnits) {
      this.log(`❌ [Fix #4] ${shares} units < OANDA minimum ${minOandaUnits} — position rejected`);
      return;
    }

    const commission = positionSize * TRADING_CONFIG.commission;
    const atr        = this.lastATR || (price * 0.001);
    const tpMult     = this.dynamicTpMultiplier || 5.0;
    let { stopLoss, takeProfit } = Indicators.getDynamicLevels(avgFillPrice, atr, this.lastVWAP || avgFillPrice, 'BUY', tpMult);
    // A1: NaN/Infinity guard — getDynamicLevels returns NaN when ATR=0 (flat warmup data)
    // Without this guard, price <= NaN is always false → position NEVER exits on SL
    if (!isFinite(stopLoss)  || stopLoss  <= 0) stopLoss  = avgFillPrice * (1 - (TRADING_CONFIG.stopLoss  || 0.02));
    if (!isFinite(takeProfit)|| takeProfit <= 0) takeProfit= avgFillPrice * (1 + (TRADING_CONFIG.takeProfit || 0.05));
    if (stopLoss >= avgFillPrice) stopLoss = avgFillPrice * (1 - (TRADING_CONFIG.stopLoss || 0.02));
    if (takeProfit <= avgFillPrice) takeProfit = avgFillPrice * (1 + (TRADING_CONFIG.takeProfit || 0.05));
    // Tighten LONG SL by half-spread so the effective risk matches the intended ATR distance.
    const halfSpreadLong = (this.currentAsk && this.currentBid) ? (this.currentAsk - this.currentBid) / 2 : 0;
    if (halfSpreadLong > 0) stopLoss += halfSpreadLong;  // raise floor so bid-based trigger is correct
    // CRITICAL bug fix: spread adjustment (above) can push SL ABOVE the entry price
    // on wide-spread pairs (news events, illiquid sessions). Re-apply the guard.
    if (stopLoss >= avgFillPrice) stopLoss = avgFillPrice * (1 - (TRADING_CONFIG.stopLoss || 0.02));
    // ── Level-based TP (#8) ──────────────────────────────────────────────
    // Override ATR-based TP with nearest S/R resistance level if closer and realistic
    const srForTP = this.lastIndicators?.sr;
    if (srForTP?.nearestResistance?.price) {
      const srTP = srForTP.nearestResistance.price;
      const srRR = (srTP - avgFillPrice) / (avgFillPrice - stopLoss);
      if (srTP > avgFillPrice && srRR >= 1.5) {  // R/R must be at least 1.5:1
        takeProfit = srTP;
        this.log('[LEVEL TP] Using S/R resistance @ ' + srTP.toFixed(5) + ' (R/R=' + srRR.toFixed(1) + ')');
      }
    }

    // B6: capitalAllocator.openPosition called AFTER fill confirmed — not before.
    // Previously called before _executeFill, leaking the slot if fill failed.
    this.capital = parseFloat((this.capital - (positionSize + commission)).toFixed(10));
    this.capitalAllocator.openPosition(activeStrategy, { cost: positionSize + commission, entry: avgFillPrice, shares });

    this.position = {
      entry: avgFillPrice, shares, cost: positionSize, positionCost: avgFillPrice * shares,
      commission, stopLoss, takeProfit, highestPrice: avgFillPrice,
      trailingStopActivated: false, trailingStopPrice: null,
      breakevenActivated: false, partialDone: false,
      entryTime: Date.now(), barOpen: this.priceHistory.length,
      spreadAtEntry: this.avgSpread * price * 10000,
      fills, fillSummary: `${fills.length} tranche(s), avg ${avgFillPrice.toFixed(5)}`,
      atr, confidence, volatilityLevel: this.volatilityLevel,
      rsiAtEntry: this.lastRSI, signalAtEntry: this.lastSignal,
      mlFeatures: FeatureExtractor.extract(
        this.lastIndicators || { price: avgFillPrice, rsi: this.lastRSI || 50,
          macd: 0, ema9: avgFillPrice, ema21: avgFillPrice, bb: {},
          atr, vwap: this.lastVWAP || avgFillPrice,
          atrPercent: atr ? (atr/avgFillPrice)*100 : 0,
          volatilityLevel: this.volatilityLevel, marketRegime: this.lastMarketRegime || 'UNKNOWN',
          mta: this.lastMTA, leadingSignal: this.lastLeadingSignal },
        this.priceHistory),
      mlRSISeq: [...this.mlConfidence.rsiBuffer],
      rawConfidence: confidence,
      regime: this.lastMarketRegime || 'UNKNOWN',
    };

    // Track in openPositions map for correlation lock / max-positions guard
    if (!this.openPositions) this.openPositions = {};
    this.openPositions[this.selectedAsset] = { side: 'long', entryTime: Date.now(), size: positionSize };
    // Open MAE/MFE tracking for this position
    try { this.maeMfe?.open(this.selectedAsset, 'long', avgFillPrice, stopLoss, takeProfit); } catch(_) {}

    // ── Adverse selection detection (#23) ──────────────────────────────
    // Track fill quality vs mid price. Consistently bad fills = adverse selection.
    const midAtEntry = price;
    const fillVsMid  = (avgFillPrice - midAtEntry) / midAtEntry;  // positive = paid more than mid
    if (!this._fillQualityHistory) this._fillQualityHistory = [];
    this._fillQualityHistory.push(fillVsMid);
    if (this._fillQualityHistory.length > 20) this._fillQualityHistory.shift();
    if (this._fillQualityHistory.length >= 10) {
      const avgFillQuality = this._fillQualityHistory.reduce((s,v)=>s+v,0) / this._fillQualityHistory.length;
      if (avgFillQuality > this.dynamicSlippage * 1.5) {
        this.log('[ADVERSE SELECTION] Avg fill ' + (avgFillQuality*10000).toFixed(1) + 'bps above mid — investigate fill quality');
      }
    }
    this.log(`📈 BUY ${shares.toFixed(4)} @ ${avgFillPrice.toFixed(4)} | size $${positionSize.toFixed(2)} | SL ${stopLoss.toFixed(4)} TP ${takeProfit.toFixed(4)} | conf ${confidence}%`);
    // A17: Slippage validation — compare model slippage with actual fill deviation
    // Records the difference between our model prediction and broker fill price.
    if (this.position?.entryPrice) {
      const modelSlip  = this.position.entryPrice - (this.position.entry || this.position.entryPrice);
      const actualSlip = slippage;  // dynamicSlippage × price (recorded per-fill)
      this._slippageErrors = this._slippageErrors || [];
      this._slippageErrors.push(Math.abs(modelSlip - actualSlip));
      if (this._slippageErrors.length > 50) this._slippageErrors.shift();
      // Alert if model consistently underestimates real slippage by >50%
      const avgErr = this._slippageErrors.reduce((s,v)=>s+v,0)/this._slippageErrors.length;
      if (this._slippageErrors.length >= 20 && avgErr > (TRADING_CONFIG.slippage||0.0005) * 0.5) {
        this.log(`[A17] Slippage model error avg ${(avgErr*1e4).toFixed(2)}bps — consider recalibrating dynamicSlippage`);
      }
    }
    // Item 20: Store SHAP explanation globally for dashboard "Why this trade?" panel
    if (this.mlConfidence?.explainDecision && this._lastMLFeatures) {
      try {
        const _expl20 = this.mlConfidence.explainDecision(this._lastMLFeatures, confidence);
        if (_expl20?.topFeatures) {
          global._lastTradeExplanation = { ts: new Date().toISOString(), asset: this.selectedAsset,
            confidence, topFeatures: _expl20.topFeatures.slice(0,5) };
        }
      } catch(_) {}
    }
    // 9.2: Log decision explainability for this trade
    if (this.mlConfidence?.explainDecision && this._lastMLFeatures) {
      try {
        const expl = this.mlConfidence.explainDecision(this._lastMLFeatures, confidence);
        if (expl?.topFeatures) {
          this.log(`[#9.2] Decision features: ${expl.topFeatures.slice(0,3).map(f=>`${f.feature}:${f.contribution>0?'+':''}${f.contribution}`).join(', ')}`);
          // Append to orders.jsonl
          const _fs56 = require('fs'), _path56 = require('path');
          _fs56.appendFileSync(
            _path56.join(__dirname,'trade_logs','orders.jsonl'),
            JSON.stringify({ ts: new Date().toISOString(), type:'EXPLAIN', asset:this.selectedAsset, topFeatures: expl.topFeatures }) + '\n'
          );
        }
      } catch(_) {}
    }
    // Item #56: Dedicated orders.jsonl — separate execution quality log
    try {
      const _fs56 = require('fs'), _path56 = require('path');
      const _dir56 = _path56.join(__dirname, 'trade_logs');
      if (!_fs56.existsSync(_dir56)) _fs56.mkdirSync(_dir56, { recursive: true });
      _fs56.appendFileSync(_path56.join(_dir56, 'orders.jsonl'),
        JSON.stringify({ ts: new Date().toISOString(), type:'ORDER_SUBMIT', asset:this.selectedAsset,
          side:'BUY', price, confidence, strategy:this._lastStrategyName||'unknown' }) + '\n'
      );
    } catch(_) {}
    // Correlation-adjusted Kelly — reduce size when pair is highly correlated with open positions
    let _corrKellyMult = 1.0;
    if (TRADING_CONFIG.corrAdjKellyEnabled && this.openPositions) {
      const _openAssets = Object.keys(this.openPositions||{}).filter(a=>a!==this.selectedAsset);
      if (_openAssets.length > 0) {
        // Estimate average correlation via shared currency components
        const _baseCur  = (this.selectedAsset||'').slice(0,3);
        const _quoteCur = (this.selectedAsset||'').slice(3);
        const _sameCur  = _openAssets.filter(a=>a.includes(_baseCur)||a.includes(_quoteCur)).length;
        const _avgCorr  = Math.min(0.8, _sameCur * 0.3);
        // Cornish-Fisher adjusted Kelly: k_adj = k * (1 - avgCorr)
        _corrKellyMult = Math.max(0.3, 1 - _avgCorr);
        if (_avgCorr > 0.3) this.log(`[CorrKelly] Avg corr ${_avgCorr.toFixed(2)} → size ×${_corrKellyMult.toFixed(2)}`);
      }
    }
    // Volatility targeting — scale position so portfolio vol ≈ target
    let _volTargetMult = 1.0;
    if (TRADING_CONFIG.volTargetEnabled && this.priceHistory?.length >= 20) {
      try {
        const { VolatilityTargeter } = require('./vol-targeting');
        if (!this._volTargeter) this._volTargeter = new VolatilityTargeter({ annualVolTarget: TRADING_CONFIG.volTarget||0.10 });
        _volTargetMult = this._volTargeter.sizeMultiplier(this.priceHistory);
      } catch(_) {}
    }
    // Item 5: Ensemble uncertainty → Kelly size cut
    let _ensembleMultiplier = 1.0;
    if (this.mlConfidence?.kellyUncertaintyMultiplier && this._lastMLFeatures) {
      _ensembleMultiplier = this.mlConfidence.kellyUncertaintyMultiplier(this._lastMLFeatures);
      if (_ensembleMultiplier < 1.0) this.log(`[Item 5] Ensemble disagrees >15pp — Kelly cut 50%`);
    }
    // Hurst exponent regime filter — avoid random walk market (H ≈ 0.5)
    if (TRADING_CONFIG.hurstFilterEnabled && this.priceHistory?.length >= 30) {
      try {
        const { HurstExponent } = require('./hurst');
        if (!this._hurst) this._hurst = new HurstExponent();
        const _hr = this._hurst.compute(this.priceHistory.slice(-60));
        if (_hr.regime === 'RANDOM' && _hr.confidence > 0.4) {
          this.log(`[Hurst] H=${_hr.H} → RANDOM WALK — entry blocked (no edge)`);
          return;
        }
        if (_hr.regime === 'TRENDING' && action === 'BUY') {
          confidence = Math.min(95, confidence + Math.round(_hr.confidence * 5));
        }
      } catch(_) {}
    }
    // Item 44: Knowledge graph queried before trade (confidence penalty if recent pattern lost)
    if (this.knowledgeGraph) {
      try {
        const related44 = this.knowledgeGraph.getRelated(this.selectedAsset, 0.5);
        // Check if recent similar setups in knowledge graph were losers
        // (This is a stub — full pattern indexing requires Item 116 implementation)
        const impactingEvents = this.knowledgeGraph.getImpactingEvents?.(this.selectedAsset) || [];
        if (impactingEvents.length > 0 && impactingEvents[0].weight > 0.85) {
          this.log(`[Item 44] KG: High-impact event active for ${this.selectedAsset} — caution`);
        }
      } catch(_) {}
    }
    // Item 6: VPIN toxicity gate — avoid entering when informed flow is dominant
    if (this.vpin?.isToxic) {
      const _vpinThresh = TRADING_CONFIG.vpinToxicThreshold || 0.35;
      if (this.vpin.isToxic(_vpinThresh)) {
        this.log(`⚠️ [Item 6] VPIN=${this.vpin.value.toFixed(3)} toxic (${this.vpin.toxicityLevel}) — entry blocked`);
        return;
      }
    }
    // Item 1: Signal expiry — discard if signal is older than maxSignalAgeMs
    const _signalAge = Date.now() - (this._lastDecisionTs || Date.now());
    const _maxAge    = TRADING_CONFIG.maxSignalAgeMs || 30_000;
    if (_signalAge > _maxAge) {
      this.log(`⚠️ [Item 1] Signal expired: ${(_signalAge/1000).toFixed(1)}s old > ${_maxAge/1000}s — discarding`);
      return;
    }
    // Fix #86: Trace ID linking signal→filter→size→execute
    const _traceId = require('crypto').randomBytes(4).toString('hex');
    this._lastTraceId = _traceId;
    this.log(`[TraceID ${_traceId}] LONG entry: ${this.selectedAsset} @ ${price.toFixed(5)} conf=${confidence}%`);
    // Fix #51: Record signal-to-fill latency for real fill cost analysis
    const _fillLatencyMs = Date.now() - (this._lastDecisionTs || Date.now());
    this._signalFillLatencies = this._signalFillLatencies || [];
    this._signalFillLatencies.push(_fillLatencyMs);
    if (this._signalFillLatencies.length > 100) this._signalFillLatencies.shift();
    if (_fillLatencyMs > 2000) this.log(`[Fix #51] High fill latency: ${_fillLatencyMs}ms — may inflate slippage`);
    try { auditLog.record({ type:'ENTRY', side:'LONG', asset:this.selectedAsset, price:avgFillPrice, sl:stopLoss, tp:takeProfit, size:positionSize, confidence, capital:this.capital, strategy:this._lastStrategyName||'unknown', symbol:this.selectedAsset, timeframe:'M5' }); } catch(_) {}
    try { telegram.send(`BUY ${this.selectedAsset} @ ${avgFillPrice.toFixed(5)} | conf ${confidence}% | SL ${stopLoss.toFixed(5)}`, 'trade'); } catch(_) {}
    this.savePositionFile();
    } finally { this._entering = false; this._capitalLocked = false; }
  },


  // ── Enter SHORT position ─────────────────────────────────────────────────
  async enterShort(price, confidence, corrMultiplier = 1) {
    // CRITICAL bug fix: set mutex atomically as FIRST operation (same as enterPosition fix)
    if (this._entering || this._capitalLocked) {
      this.log('⚠️ enterShort: already entering or capital locked — skipped (mutex)'); return;
    }
    this._entering = true;
    this._capitalLocked = true;

    if (!price || price <= 0)  { this._entering = false; this._capitalLocked = false; this.log('❌ enterShort: invalid price'); return; }
    if (this.capital <= 0)     { this._entering = false; this._capitalLocked = false; this.log('❌ enterShort: no capital'); return; }
    if (this.position)         { this._entering = false; this._capitalLocked = false; this.log('❌ enterShort: position already open'); return; }

    // ── MaxOpenPositions guard (SHORT) ───────────────────────────────────────
    if (this.maxOpenGuard) {
      const _maxCheckS = this.maxOpenGuard.check(this.openPositions || {}, this.selectedAsset);
      if (!_maxCheckS.allowed) { this._entering = false; this._capitalLocked = false; return; }
    }

    // ── Correlation lock (SHORT) ─────────────────────────────────────────────
    if (this.correlationLock) {
      const _corrCheckS = this.correlationLock.check(this.openPositions || {}, this.selectedAsset, 'short');
      if (!_corrCheckS.allowed) { this._entering = false; this._capitalLocked = false; return; }
    }
    const effectiveMinConfS = Math.max(TRADING_CONFIG.minConfidence, SAFETY.MIN_AI_CONFIDENCE);
    if (confidence < effectiveMinConfS) {
      this._entering = false; this._capitalLocked = false;
      this.log('🛡️ SHORT BLOCKED: confidence ' + confidence + '% < floor ' + effectiveMinConfS + '%'); return;
    }
    try {

    // Volume confirmation gate (same as LONG)
    const VOL_WINDOW_S   = 20;
    const VOL_MIN_MULT_S = TRADING_CONFIG.volumeMinMultiplier || 1.2;
    if (this.volumeHistory && this.volumeHistory.length >= VOL_WINDOW_S + 1) {
      const recentVs = this.volumeHistory.slice(-VOL_WINDOW_S - 1, -1);
      const avgVs    = recentVs.reduce((s, v) => s + v, 0) / recentVs.length;
      const curVs    = this.volumeHistory[this.volumeHistory.length - 1];
      if (avgVs > 0 && curVs < avgVs * VOL_MIN_MULT_S) {
        this.log('VOLUME FILTER (SHORT): ' + curVs.toFixed(0) + ' < ' + (avgVs * VOL_MIN_MULT_S).toFixed(0) + ' — entry blocked');
        return;
      }
    }

    // Spread gate (same as LONG) — wide spreads hurt SHORT entries too
    if (TRADING_CONFIG.spreadEnabled) {
      const spreadCheck = this._checkSpread(price);
      if (spreadCheck.blocked) {
        this.log('🚫 SHORT SPREAD BLOCK: ' + spreadCheck.spreadPips.toFixed(1) + ' pips exceeds max — entry cancelled');
        return;
      }
      if (spreadCheck.warn) {
        confidence = Math.max(0, confidence - spreadCheck.penaltyPts);
        const minFloor = Math.max(TRADING_CONFIG.minConfidence, SAFETY.MIN_AI_CONFIDENCE);
        if (confidence < minFloor) { this.log('🛡️ POST-SPREAD SHORT confidence ' + confidence + '% below floor — cancelled'); return; }
      }
    }

    // Smart order routing — SHORT fills at BID (fix: was incorrectly using 'BUY')
    const sorS = this._smartRoute(this.selectedAsset, 'SELL');
    if (sorS.blocked) { this.log('🚫 enterShort SOR: ' + sorS.reason); return; }
    const fillPrice = sorS.price || price;

    const kellyResult  = KellyCriterion.calculate(this.trades, confidence, this._currentSession?.());
    const baseFraction = kellyResult.fraction * corrMultiplier;
    const fraction     = Math.max(SAFETY.MIN_POSITION_SIZE, Math.min(SAFETY.MAX_POSITION_SIZE, baseFraction));
    const positionSize = this.capital * fraction;
    const MIN_TRADE_VAL = TRADING_CONFIG.minTradeValue || 10;
    if (!isFinite(positionSize) || positionSize < MIN_TRADE_VAL) {
      this.log('❌ enterShort: positionSize $' + (positionSize||0).toFixed(2) + ' invalid'); return;
    }

    // Capital allocator check (same as LONG)
    const champIdS = this.abTester?.championId || 'ensemble';
    const stratS   = this.capitalAllocator?.slots?.has(champIdS) ? champIdS : 'ensemble';
    const allocS   = this.capitalAllocator?.canEnter(stratS, confidence, this.capital);
    if (allocS && !allocS.allowed) { this.log('📊 SHORT ALLOC BLOCK [' + stratS + ']: ' + allocS.reason); return; }
    let finalPositionSize = allocS ? Math.min(positionSize, allocS.maxSize) : positionSize;

    // ── Anti-martingale guard (SHORT) ─────────────────────────────────────
    if (this.antiMartingale && this.consecutiveLosses > 0) {
      const _baselineS = this.capital * (TRADING_CONFIG.positionSize || 0.02);
      const _amResultS = this.antiMartingale.enforce(finalPositionSize, _baselineS, this.consecutiveLosses);
      finalPositionSize = _amResultS.size;
    }

    // Compute shortEntry first (needed by TWAP if it activates)
    const slippageS  = fillPrice * this.dynamicSlippage * 0.5;  // half: spread already in bid
    const shortEntry = fillPrice + slippageS;  // slight adverse fill beyond bid

    // ── TWAP activation: large SHORT orders split into tranches ────────────
    let avgShortEntry, shares;
    if (TRADING_CONFIG.twapEnabled && finalPositionSize > TRADING_CONFIG.twapThreshold) {
      this.log('[TWAP SHORT] Large order $' + finalPositionSize.toFixed(0) + ' > threshold — executing in tranches');
      try {
        const twapResult = await this._twapFill(shortEntry, finalPositionSize);
        avgShortEntry = twapResult.avgFillPrice;
        shares        = twapResult.filledShares;
      } catch (e) { this.log('[TWAP SHORT] Error: ' + e.message); return; }
    } else {
      this._recordSlippage(slippageS / fillPrice);
      const result = await this._executeFill(finalPositionSize / shortEntry, shortEntry, 'SELL');
      // B3: Guard null/undefined result
      if (!result) { this.log('❌ [B3] _executeFill returned null (SHORT) — aborting entry'); return; }
      avgShortEntry = result.avgEntryPrice;
      shares        = result.filledShares;
    }

    if (!shares || shares <= 0) { this.log('❌ SHORT fill failed — 0 shares'); return; }
    // CRITICAL bug fix: avgShortEntry=0 or NaN → stopLoss=0 → SL never fires → unlimited loss
    if (!isFinite(avgShortEntry) || avgShortEntry <= 0) {
      this.log(`❌ [FillPriceGuard SHORT] Invalid avgShortEntry=${avgShortEntry} — aborting entry`);
      return;
    }

    // Fix #7: Round to integer OANDA units
    shares = Math.floor(shares);
    if (shares <= 0) { this.log('❌ [Fix #7] SHORT rounded shares = 0'); return; }
    // Fix #4: OANDA minimum unit check
    const minUnitsS = TRADING_CONFIG.minOandaUnits || 1;
    if (shares < minUnitsS) { this.log(`❌ [Fix #4] SHORT ${shares} < min ${minUnitsS}`); return; }

    const commission   = finalPositionSize * TRADING_CONFIG.commission;
    const atr          = this.lastATR || (price * 0.001);
    const tpMult       = this.dynamicTpMultiplier || 5.0;
    let { stopLoss, takeProfit } = Indicators.getDynamicLevels(
      avgShortEntry, atr, this.lastVWAP || avgShortEntry, 'SELL', tpMult);

    // A1: NaN/Infinity guard for SHORT levels
    if (!isFinite(stopLoss)   || stopLoss  <= 0) stopLoss  = avgShortEntry * (1 + (TRADING_CONFIG.stopLoss  || 0.02));
    if (!isFinite(takeProfit) || takeProfit <= 0) takeProfit= avgShortEntry * (1 - (TRADING_CONFIG.takeProfit || 0.05));
    if (stopLoss <= avgShortEntry) stopLoss = avgShortEntry * (1 + (TRADING_CONFIG.stopLoss || 0.02));
    if (takeProfit >= avgShortEntry) takeProfit = avgShortEntry * (1 - (TRADING_CONFIG.takeProfit || 0.05));

    // Fix #5: Guard against SL == entry when ATR=0 (flat warm-up data)
    const minSlGap = avgShortEntry * 0.001;
    if (!stopLoss || stopLoss <= avgShortEntry) {
      stopLoss = avgShortEntry + Math.max(atr * 1.5, minSlGap);
      this.log(`[Fix #5] SHORT SL corrected: was ≤ entry, set to ${stopLoss.toFixed(5)}`);
    }
    // Fix #72: SHORT SL fires when ASK hits the level. Lower ceiling by half-spread so
    // ask-based trigger matches the intended ATR distance.
    const halfSpreadShort = (this.currentAsk && this.currentBid) ? (this.currentAsk - this.currentBid) / 2 : 0;
    if (halfSpreadShort > 0) stopLoss -= halfSpreadShort;
    // CRITICAL bug fix: spread subtraction can push SHORT SL BELOW entry price on
    // wide-spread pairs, making the position immediately stop out. Re-apply guard.
    if (stopLoss <= avgShortEntry) stopLoss = avgShortEntry * (1 + (TRADING_CONFIG.stopLoss || 0.02));

    this.capital = parseFloat((this.capital - commission).toFixed(10));
    this.capitalAllocator?.openPosition(stratS, { cost: finalPositionSize + commission, entry: avgShortEntry, shares });

    this.position = {
      side: 'SHORT',
      entry: avgShortEntry, shares, cost: finalPositionSize, positionCost: avgShortEntry * shares,
      commission, stopLoss, takeProfit, lowestPrice: avgShortEntry,
      trailingStopActivated: false, trailingStopPrice: null,
      breakevenActivated: false, partialDone: false,
      entryTime: Date.now(), barOpen: this.priceHistory.length,
      atr, confidence, volatilityLevel: this.volatilityLevel,
      rsiAtEntry: this.lastRSI, signalAtEntry: this.lastSignal,
      rawConfidence: confidence, regime: this.lastMarketRegime || 'UNKNOWN',
      kellyFraction: kellyResult.fraction, kellyDetails: kellyResult.details,
      adjFraction: fraction, corrMultiplier,
      // BUG-58 fix: store ML features so exitPosition can feed them to recordTrade (was missing on SHORT)
      mlFeatures: FeatureExtractor.extract(
        this.lastIndicators || { price: avgShortEntry, rsi: this.lastRSI || 50,
          macd: 0, ema9: avgShortEntry, ema21: avgShortEntry, bb: {},
          atr, vwap: this.lastVWAP || avgShortEntry,
          atrPercent: atr ? (atr / avgShortEntry) * 100 : 0,
          volatilityLevel: this.volatilityLevel, marketRegime: this.lastMarketRegime || 'UNKNOWN',
          mta: this.lastMTA, leadingSignal: this.lastLeadingSignal },
        this.priceHistory),
      mlRSISeq: [...this.mlConfidence.rsiBuffer],
    };

    // Track in openPositions map for correlation lock / max-positions guard
    if (!this.openPositions) this.openPositions = {};
    this.openPositions[this.selectedAsset] = { side: 'short', entryTime: Date.now(), size: finalPositionSize };
    // Open MAE/MFE tracking for this SHORT position
    try { this.maeMfe?.open(this.selectedAsset, 'short', avgShortEntry, stopLoss, takeProfit); } catch(_) {}

    this.log('📉 SHORT ' + shares.toFixed(4) + ' @ ' + avgShortEntry.toFixed(5) +
      ' | size $' + finalPositionSize.toFixed(2) +
      ' | SL ' + stopLoss.toFixed(5) + ' TP ' + takeProfit.toFixed(5) +
      ' | conf ' + confidence + '%');
    try { auditLog.record({ type:'ENTRY', side:'SHORT', asset:this.selectedAsset,
      price:avgShortEntry, sl:stopLoss, tp:takeProfit, size:finalPositionSize, confidence, capital:this.capital,
      strategy:this._lastStrategyName||'unknown', symbol:this.selectedAsset, timeframe:'M5' }); } catch(_) {}
    try { telegram.send('SHORT ' + this.selectedAsset + ' @ ' + avgShortEntry.toFixed(5) +
      ' | conf ' + confidence + '% | SL ' + stopLoss.toFixed(5), 'trade'); } catch(_) {}
    this.savePositionFile();
    } finally { this._entering = false; this._capitalLocked = false; }
  },
  // ── Exit position ────────────────────────────────────────────────────────
  async exitPosition(price, reason) {
    if (!this.position) return;
    // CRITICAL bug fix: zero/NaN exit price records a catastrophic artificial loss
    // (exitValue=0 → netProfit = -(full position cost)) and corrupts capital forever.
    // Reject invalid prices immediately — do NOT exit with a bad price.
    if (typeof price !== 'number' || !isFinite(price) || price <= 0) {
      this.log(`⚠️ [PriceGuard] exitPosition rejected invalid price=${price} reason=${reason}`);
      return;
    }
    // A2: Concurrency guard — SL and TP can both fire on the same tick
    if (this._exiting) { this.log(`⚠️ [A2] Double-exit blocked: ${reason}`); return; }
    this._exiting = true;
    try {

    const isShortExit = this.position.side === 'SHORT';
    const slippage  = price * this.dynamicSlippage;
    // LONG exit: sell at bid (price - slippage). SHORT exit: buy back at ask (price + slippage).
    const exitPrice = isShortExit ? price + slippage : price - slippage;
    this._recordSlippage(slippage / price);

    const isSafetyExit = reason.includes('Stop Loss') || reason.includes('Take Profit') ||
      reason.includes('Trailing Stop') || reason.includes('Circuit Breaker') ||
      reason.includes('Kill Switch') || reason.includes('EndOfBacktest');

    if (TRADING_CONFIG.orderType === 'limit' && !isSafetyExit) {
      const slippagePct = slippage / price;
      if (slippagePct > TRADING_CONFIG.limitSlippageThreshold) {
        this.log(`🚫 LIMIT EXIT REJECTED: slippage ${(slippagePct*100).toFixed(3)}% — holding, retry next tick`);
        return;
      }
    }

    // Bug fix: validate position.shares before computing exitValue
    // shares=0 or NaN → exitValue=0 → records full position cost as a loss
    const posShares = this.position.shares;
    if (typeof posShares !== 'number' || !isFinite(posShares) || posShares <= 0) {
      this.log(`⚠️ [SharesGuard] exitPosition rejected invalid shares=${posShares} — clearing position`);
      this.position = null;
      return;
    }
    const exitValue  = posShares * exitPrice;
    const commission = exitValue * TRADING_CONFIG.commission;
    const isShort    = this.position.side === 'SHORT';
    const _posEntryTime = this.position.entryTime || Date.now();  // capture BEFORE position=null
    // CRITICAL bug fix: position.commission may be undefined when position was loaded
    // from an old disk format → NaN profit corrupts all trade records and capital.
    const entryComm = (typeof this.position.commission === 'number' && isFinite(this.position.commission))
      ? this.position.commission : 0;
    // LONG: profit = exit - entry. SHORT: profit = entry - exit (we sold high, buy back low)
    const netProfit  = isShort
      ? (this.position.shares * this.position.entry - exitValue) - entryComm - commission
      : exitValue - (this.position.shares * this.position.entry + entryComm + commission);

    const trade = {
      id: `${this._tradeIdPrefix || 'xx'}-${++this.tradeId}`, asset: this.selectedAsset, type: this.position.side || 'LONG',
      entry: this.position.entry, exit: exitPrice, shares: this.position.shares,
      profit: netProfit,
      // B7: Guard against NaN/Infinity when positionCost=0 (rare but possible on old trades)
      profitPercent: (() => {
        const cost = this.position.positionCost || (this.position.shares * this.position.entry) || 1;
        const pct  = (netProfit / cost) * 100;
        return isFinite(pct) ? parseFloat(pct.toFixed(4)) : 0;
      })(),
      capitalAtRisk: this.position.positionCost || this.position.shares * this.position.entry,
      duration: Date.now() - this.position.entryTime, reason,
      timestamp: new Date().toISOString(),
      commission: entryComm + commission,  // entryComm is guarded against undefined (Fix 52)
      volatilityLevel: this.position.volatilityLevel || this.volatilityLevel,
      confidence: this.position.confidence || 0,
      atr: this.position.atr || this.lastATR,
      mtaAligned: this.lastMTA ? this.lastMTA.allowed : null,
      rsiAtEntry: this.position.rsiAtEntry || null,
      signalAtEntry: this.position.signalAtEntry || null,
      outcome: netProfit > 0 ? 'WIN' : 'LOSS',
      rawConfidence: this.position.rawConfidence || this.position.confidence || 0,
      regime: this.position.regime || 'UNKNOWN',
    };

    // Feature #78: Append trade to immutable JSONL (event-sourced record)
    try {
      const fs = require('fs'), path = require('path');
      const jsonlPath = path.join(__dirname, 'trade_logs', 'trades-immutable.jsonl');
      fs.mkdirSync(path.join(__dirname, 'trade_logs'), { recursive: true });
      fs.appendFileSync(jsonlPath, JSON.stringify({ ...trade, _immutableAt: new Date().toISOString() }) + '\n');
    } catch(_) {}
    this.trades.push(trade);
    // B2: Trim trades array to prevent OOM on long-running sessions
    const _maxT = this._maxTrades || TRADING_CONFIG.maxTradesHistory || 500;
    if (this.trades.length > _maxT) this.trades.splice(0, this.trades.length - _maxT);
    this.lastClosedAsset = this.selectedAsset;
    // Feature #14: Record in trade journal with MAE/MFE
    if (this.tradeJournal) {
      const priceH = this.priceHistory || [];
      // Estimate MAE/MFE from price history since entry (approximate)
      const entryBar = (trade.barOpen || 0);
      const sinceEntry = priceH.slice(Math.max(0, priceH.length - Math.min(200, Date.now() - (this.position?.entryTime || Date.now()) / 300000)));
      let mae = 0, mfe = 0;
      if (sinceEntry.length > 0 && trade.entry > 0) {
        const isShortJ = trade.type === 'SHORT';
        for (const p of sinceEntry) {
          const excursion = isShortJ ? (trade.entry - p) / trade.entry : (p - trade.entry) / trade.entry;
          if (excursion < 0) mae = Math.max(mae, Math.abs(excursion));
          else               mfe = Math.max(mfe, excursion);
        }
      }
      this.tradeJournal.record({ ...trade, session: this._currentSession?.() || 'UNKNOWN' }, { mae, mfe });
    }
    // ── Feature #17: Record per-pair loss for daily limit tracking ────────
    if (this.perPairLoss) {
      this.perPairLoss.record(this.selectedAsset, netProfit, this.capital);
    }
    this.mlConfidence.recordTrade(trade, this.position.mlFeatures || null, this.position.mlRSISeq || []);
    this.trainingData.push({ entryPrice: this.position.entry, exitPrice, profit: netProfit, prices: [...this.priceHistory.slice(-10)] });

    // SHORT exit: capital += what we originally received (entry × shares) - buyback cost - commissions
    // LONG exit: capital += exit proceeds
    // Previously always added exitValue — wrong for SHORT (was crediting buyback amount, not profit)
    // Feature #83: Atomic state update — capture pre-state so we can roll back on error
    const _preCapital  = this.capital;
    const _preWins     = this.wins;
    const _preLosses   = this.losses;
    const _preConsLoss = this.consecutiveLosses;
    const _preConsWin  = this.consecutiveWins || 0;
    try {
    if (isShort) {
      // B12: SHORT P/L = original short proceeds (entry×shares) minus buyback cost (exitValue) minus both commissions
      // exitValue = (price + slippage) × shares — slippage applied ONCE on the buyback, not twice
      // On gap opens: price already reflects the gap; slippage is the additional market impact only
      this.capital = parseFloat((this.capital + (this.position.shares * this.position.entry) - exitValue - commission - entryComm).toFixed(10));
    } else {
      this.capital = parseFloat((this.capital + exitValue - commission).toFixed(10));
    }
    if (netProfit > 0) {
      this.wins++;
      this.consecutiveLosses  = 0;
      this.consecutiveWins    = (this.consecutiveWins || 0) + 1;
      // ── Feature #36: Consecutive win streak alert ────────────────────────
      const winStreakAlert = TRADING_CONFIG.consecutiveWinAlert || 5;
      if (this.consecutiveWins >= winStreakAlert && this.consecutiveWins % winStreakAlert === 0) {
        const msg = `🔥 WIN STREAK: ${this.consecutiveWins} consecutive wins — review sizing for overconfidence bias`;
        this.log(msg);
        try { telegram.send(msg, 'risk'); } catch(_) {}
        try { sendFallback(msg, 'risk'); } catch(_) {}
      }
    } else {
      this.losses++;
      this.consecutiveLosses++;
      this.consecutiveWins = 0;
      if (this.consecutiveLosses >= TRADING_CONFIG.consecutiveLossLimit) {
        this.consecutiveHaltUntil = Date.now() + TRADING_CONFIG.consecutiveLossCooldown;
        this.log(`🚨 CONSECUTIVE LOSS HALT: ${this.consecutiveLosses} losses — pausing ${TRADING_CONFIG.consecutiveLossCooldown/60000} min`);
      }
    }

    // ── Daily loss limit check (#critical-fix) ─────────────────────────
    // dailyStartCapital is reset each midnight. If today's loss exceeds
    // MAX_DAILY_LOSS_PCT (SAFETY floor), trigger 24h lockout persisted to disk.
    {
      const maxDailyLoss  = Math.min(
        TRADING_CONFIG.dailyLossLimit || 0.05,
        SAFETY.MAX_DAILY_LOSS_PCT
      );
      const dailyDrawdown = this.dailyStartCapital > 0
        ? (this.dailyStartCapital - this.capital) / this.dailyStartCapital
        : 0;

      if (dailyDrawdown >= maxDailyLoss - 1e-9 && this.dailyLockoutUntil <= Date.now()) {
        const lockUntil = Date.now() + SAFETY.DAILY_LOSS_LOCKOUT_MS;
        this.dailyLockoutUntil = lockUntil;
        this._saveDailyLockout(lockUntil);
        this.log(
          '[DAILY LOSS LIMIT] ' + (dailyDrawdown*100).toFixed(2) +
          '% loss today (limit ' + (maxDailyLoss*100) + '%) — 24h lockout until ' +
          new Date(lockUntil).toUTCString()
        );
        try { telegram.alert('Daily loss limit hit: ' + (dailyDrawdown*100).toFixed(2) + '% — 24h lockout', 'halt'); } catch(_) {}
        try { auditLog.record({ type:'DAILY_LOCKOUT', dailyDrawdown, maxDailyLoss, lockUntil, strategy:'risk', symbol:this.selectedAsset||'NONE', timeframe:'M5' }); } catch(_) {}
      }
    }

    const globalLimit   = Math.min(TRADING_CONFIG.globalDrawdownLimit || 0.20, SAFETY.MAX_GLOBAL_DRAWDOWN_PCT);  // Bug #67 fix
    const totalDrawdown = (this.initialCapital - this.capital) / this.initialCapital;
    if (!this.globalHaltTripped && totalDrawdown >= globalLimit - 1e-9) {
      this.globalHaltTripped = true;
      try {
        const _ph=require('path'),_fh=require('fs');
        _fh.mkdirSync(_ph.join(__dirname,'trade_logs'),{recursive:true});
        _fh.writeFileSync(_ph.join(__dirname,'trade_logs','global_halt.json'),
          JSON.stringify({halted:true,at:new Date().toISOString(),drawdown:totalDrawdown}));
      } catch(_eh) {}
      this.log(`🛑 GLOBAL DRAWDOWN HALT: ${(totalDrawdown*100).toFixed(2)}% — PERMANENTLY halted`);
      try { telegram.alert(`GLOBAL DRAWDOWN HALT: ${(totalDrawdown*100).toFixed(2)}% drawdown — engine stopped`, 'global_halt'); } catch(_) {}
    }

    this.log(`📉 SELL ${this.position.shares.toFixed(4)} @ ${exitPrice.toFixed(4)} | P/L: ${netProfit>=0?'+':''}$${netProfit.toFixed(2)} | ${reason}`);
    try { telegram.send(`SELL ${this.selectedAsset} @ ${exitPrice.toFixed(5)} | P/L ${netProfit>=0?'+':''}$${netProfit.toFixed(2)} | ${reason}`, 'trade'); } catch(_) {}
    try { auditLog.record({ type:'EXIT', asset:this.selectedAsset, price:exitPrice, profit:parseFloat(netProfit.toFixed(2)), reason, capital:this.capital, strategy:this._lastStrategyName||'unknown', symbol:this.selectedAsset, timeframe:'M5' }); } catch(_) {}

    // Fix #9: Verify OANDA fill is complete before clearing position.
    // If the broker reports partial fill, log a warning but still clear local state
    // and schedule a reconciliation check to catch the residual broker-side position.
    try {
      if (process.env.BACKTEST_MODE !== 'true' && process.env.PAPER_MODE !== 'true' && this.exchange?.getOpenPositions) {
        const brokerPositions = await this.exchange.getOpenPositions().catch(() => null);
        if (brokerPositions) {
          const assetNorm = (this.selectedAsset || '').replace('/', '_');
          const stillOpen = brokerPositions.find(p =>
            (p.asset || '').replace('/', '_') === assetNorm
          );
          if (stillOpen) {
            this.log(`⚠️ [Fix #9] OANDA still shows open position after exit — residual size: ${stillOpen.size}. Scheduling reconcile.`);
            try { telegram.send(`⚠️ Exit fill may be partial — residual ${assetNorm} on broker. Reconciling.`, 'risk'); } catch(_) {}
            setTimeout(() => this._reconcileRestoredPosition(0).catch(() => {}), 5000);
          }
        }
      }
    } catch (_fillCheck) {}

    this.position = null;
    // Clear from openPositions tracking
    if (this.openPositions) delete this.openPositions[this.selectedAsset];

    // Close MAE/MFE tracking and log insights
    try { this.maeMfe?.close(exitPrice, reason || 'exit'); } catch(_) {}
    // Record trade in TOD heatmap
    // FIX: trade.entryTime doesn't exist in trade object; use this.position.entryTime captured before null
    // FIX: trade.pnl doesn't exist; use trade.profit
    try {
      const _entryTs = _posEntryTime;  // captured before position=null
      this.todHeatmap?.record(_entryTs, trade?.profit || 0);
    } catch(_) {}
    // Record in risk-adjusted tracker (Sharpe/Calmar)
    // FIX: trade.pnl → trade.profit
    try {
      const _tradePnl = trade?.profit || 0;
      this.riskAdjusted?.record(_tradePnl, this.capital, this.capital - _tradePnl);
    } catch(_) {}

    this.saveTradesFile();
    try { tsStore.writeTrade(trade); } catch(_) {}
    this.savePositionFile();
    } catch (atomicErr) {
      // Feature #83: Rollback capital/stats on unexpected error in exit logic
      this.capital           = _preCapital;
      this.wins              = _preWins;
      this.losses            = _preLosses;
      this.consecutiveLosses = _preConsLoss;
      this.consecutiveWins   = _preConsWin;
      this.log('[ATOMIC] exitPosition error — state rolled back: ' + atomicErr.message);
      throw atomicErr;
    }

    // 4.2: Record actual slippage for slippage model training
    if (this.slippageModel?.record) {
      try {
        const _features = this.slippageModel.buildFeatures(
          this.currentSpread || 0, this.avgSpread || 0.0001,
          this._lastVolRatio || 1, ((this.lastATR||0)/(trade.exit||1))*100,
          (trade.capitalAtRisk||0), this.capital
        );
        const _actualSlip = Math.abs(trade.slippageActual || this.dynamicSlippage || 0);
        this.slippageModel.record(_features, _actualSlip);
      } catch(_) {}
    }
    // Item 59: Slippage streak alert — 3 consecutive fills with >2 pip slippage
    {
      const _pip59 = (this.selectedAsset||'').includes('JPY') ? 0.01 : 0.0001;
      const _slip59Pips = Math.abs(trade.slippageActual || this.dynamicSlippage || 0) / _pip59;
      if (!this._slippageStreak59) this._slippageStreak59 = { count:0 };
      if (_slip59Pips > 2.0) {
        this._slippageStreak59.count++;
        if (this._slippageStreak59.count >= 3) {
          const msg59 = `⚠️ [Item 59] Slippage streak ×${this._slippageStreak59.count} >2pip — consider limit orders`;
          this.log(msg59);
          try { require('./telegram').send(msg59, 'risk'); } catch(_) {}
          this._slippageStreak59.count = 0;
        }
      } else { this._slippageStreak59.count = 0; }
    }
    // Item 42: Bayesian optimizer live update loop — every 50 trades push to live config
    if (this.bayesianOptimizer?.addObservation) {
      try {
        const boScore42 = Math.max(-5, Math.min(5, trade.profitPercent||0));
        const boParams42 = { minConfidence: TRADING_CONFIG.minConfidence||60,
          positionSize: TRADING_CONFIG.positionSize||0.02, stopLoss: TRADING_CONFIG.stopLoss||0.02 };
        this.bayesianOptimizer.addObservation(boParams42, boScore42);
        const allTrades42 = (this.trades||[]).length;
        if (allTrades42 > 0 && allTrades42 % 50 === 0) {
          const best42 = this.bayesianOptimizer.getBestParams?.();
          if (best42) {
            if (best42.minConfidence) TRADING_CONFIG.minConfidence = Math.round(best42.minConfidence);
            if (best42.positionSize)  TRADING_CONFIG.positionSize  = parseFloat(best42.positionSize.toFixed(4));
            this.log(`[Item 42] Bayesian update at trade ${allTrades42}: ${JSON.stringify(best42)}`);
            try { require('./telegram').send(`[BO #42] Params updated: ${JSON.stringify(best42)}`, 'status'); } catch(_) {}
          }
        }
      } catch(_) {}
    }
    // Item #39: Online calibrator update after each closed trade
    if (this.mlConfidence?.calibrator?.onlineUpdate) {
      try {
        const won39 = (trade.profit || 0) > 0;
        this.mlConfidence.calibrator.onlineUpdate(trade.confidence || 70, won39, trade.regime || 'UNKNOWN');
      } catch(_) {}
    }
    // Event sourcing — log every exit
    try { const _es = require('./event-sourcing'); if (_es?.EVENTS?.EXIT) _es.EVENTS.EXIT(trade.asset||this.selectedAsset, trade.exit||0, trade.profit||0, trade.exitReason||'normal'); } catch(_) {}  // Bug #90 fix: optional chain prevents missing-module crash
    // Item 116: Knowledge graph — record outcome after each closed trade
    if (this.knowledgeGraph?.updateCorrelation) {
      try {
        // Record which pair/regime combination won or lost
        const won116  = (trade.profit||0) > 0;
        const asset116 = trade.asset || this.selectedAsset;
        const regime116 = trade.regime || this.lastMarketRegime || 'UNKNOWN';
        // Update edge weight based on outcome (+1 win / -1 loss) for this setup
        this.knowledgeGraph.updateCorrelation(asset116, regime116, won116 ? 0.1 : -0.1, 0.05);
        // Persist to file every 20 trades
        const _kcCount = (this._kgUpdateCount116 = (this._kgUpdateCount116||0)+1);
        if (_kcCount % 20 === 0) {
          const fs = require('fs'), path = require('path');
          try { fs.writeFileSync(path.join(__dirname,'trade_logs','knowledge-graph.json'),
            JSON.stringify({ edges: Object.fromEntries(this.knowledgeGraph._edges), ts: new Date().toISOString() }, null, 2)); } catch(_) {}
        }
      } catch(_) {}
    }
    // 7.1: Apply shaped RL reward instead of raw P&L
    if (this.rlIntegration?.updateReward) {
      try {
        const { QLearning } = require('./ml-improvements');
        const portfolio = {
          recentVol:  this._atrCV || 0.01,
          drawdown:   this.initialCapital > 0 ? (this.initialCapital - this.capital) / this.initialCapital : 0,
        };
        const shapedR = QLearning.shapeReward({ ...trade, barsHeld: trade.duration ? trade.duration/30000 : 5 }, portfolio);
        this.rlIntegration.updateReward(shapedR, this.priceHistory.at(-1));
      } catch(_) {}
    }
    // Bug #13 fix: duplicate bayesianOptimizer.addObservation removed (Item 42 block above already calls it)
    this.driftMonitor.recordTrade(trade);
    if (this.driftMonitor.isHalted() && !this.globalHaltTripped) {
      this.log(`🛑 DRIFT HALT: ${this.driftMonitor.haltStatus().reason}`);
      this.globalHaltTripped = true;
    }

    const closingChampId  = this.abTester?.championId || 'ensemble';
    const closingStrategy = this.capitalAllocator.slots.has(closingChampId) ? closingChampId : 'ensemble';
    this.capitalAllocator.closePosition(closingStrategy, netProfit);

    return trade;
    } finally { this._exiting = false; }  // A2: release exit mutex
  },
};

// ── Feature #16: addToPosition — pyramid into a winning trade ────────────────
// Adds `fraction` of current capital to an open position in the same direction.
// Hard-limited by SAFETY.MAX_POSITION_SIZE and max 3 adds per trade.
// Call from executeDecision when action matches open position side and profit > 1R.
Object.assign(module.exports, {
  async addToPosition(price, fraction, reason = 'Pyramid') {
    // B10: Respect capital lock flag — prevents race with concurrent enterPosition/enterShort
    if (this._capitalLocked) { this.log('⚠️ [B10] addToPosition skipped — capital locked'); return; }
    if (!this.position) { this.log('[Pyramid] No open position — skipped'); return; }
    const MAX_ADDS = 3;
    this.position._pyramidCount = (this.position._pyramidCount || 0);
    // Bug #40 fix: pyramid adds are real orders — count against daily limit
    if (TRADING_CONFIG.maxDailyTrades && (this._dailyTradeCount || 0) >= TRADING_CONFIG.maxDailyTrades) {
      this.log('[Pyramid] Daily trade limit reached — skipped'); return;
    }
    if (this.position._pyramidCount >= MAX_ADDS) {
      this.log(`[Pyramid] Max adds (${MAX_ADDS}) reached — skipped`);
      return;
    }
    const isShortPos = this.position.side === 'SHORT';
    const currentPnlPct = isShortPos
      ? (this.position.entry - price) / this.position.entry
      : (price - this.position.entry) / this.position.entry;

    // Only add when at least 1R in profit
    const minPnlToAdd = this.position.atr ? this.position.atr / this.position.entry : 0.005;
    if (currentPnlPct < minPnlToAdd) {
      this.log(`[Pyramid] Skipped — only ${(currentPnlPct*100).toFixed(2)}% profit, need >${(minPnlToAdd*100).toFixed(2)}%`);
      return;
    }

    const addSize = Math.min(
      this.capital * fraction,
      this.capital * require('./safety-constants').SAFETY.MAX_POSITION_SIZE * 0.5  // add at most half max size
    );
    const slippage   = price * (this.dynamicSlippage || 0.0005);
    const addPrice   = isShortPos ? price + slippage : price - slippage;
    const addShares  = addSize / addPrice;
    const commission = addSize * (require('./trading-config').TRADING_CONFIG.commission || 0.001);

    // Blend entry price
    const totalShares = this.position.shares + addShares;
    this.position.entry = (this.position.entry * this.position.shares + addPrice * addShares) / totalShares;
    this.position.shares = totalShares;
    this.position.cost   = (this.position.cost || 0) + addSize;
    // Bug #36 fix: recalculate stopLoss from new blended entry + ATR so stop isn't stale
    const _atr36 = this.lastATR || (this.position.entry * 0.002);
    const _slMult36 = require('./trading-config').TRADING_CONFIG.stopLoss || 0.02;
    if (this.position.side === 'SHORT') {
      const _newSL36 = this.position.entry * (1 + _slMult36);
      if (_newSL36 < this.position.stopLoss) this.position.stopLoss = _newSL36;  // only tighten
    } else {
      const _newSL36 = this.position.entry * (1 - _slMult36);
      if (_newSL36 > this.position.stopLoss) this.position.stopLoss = _newSL36;  // only tighten
    }
    this.position._pyramidCount++;
    this.capital = parseFloat((this.capital - commission).toFixed(10));

    this.log(`[Pyramid #${this.position._pyramidCount}] Added ${addShares.toFixed(4)} shares @ ${addPrice.toFixed(5)} | Avg entry: ${this.position.entry.toFixed(5)} | ${reason}`);
    try { require('./telegram').send(`[Pyramid] ${this.selectedAsset} add #${this.position._pyramidCount} @ ${addPrice.toFixed(5)}`, 'trade'); } catch(_) {}
    this.savePositionFile();
  }
});
