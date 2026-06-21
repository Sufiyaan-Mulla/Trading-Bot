'use strict';
// Fix #66: All production requires at module top-level (no inline requires in hot paths)
const _telegram = (() => { try { return require('./telegram'); } catch(_) { return null; } })();
const _auditLog = (() => { try { return require('./audit-log'); } catch(_) { return null; } })();
// ── risk-manager.js ───────────────────────────────────────────────────────────
// Risk management mixin methods + re-exports of Kelly and Correlation.
//
// Mixin methods (added to TradingEngine.prototype):
//   checkRiskManagement  — SL/TP/trailing/breakeven per-bar checks
//   updateTrailingStop   — ratchets trailing stop as price advances
//   takePartialProfit    — closes fraction at partialProfitTrigger
//   executeDecision      — translates BUY/SELL decision into orders
//
// Re-exports for single-import convenience:
//   KellyCriterion, CorrelationEngine

const { TRADING_CONFIG }    = require('./trading-config');
const { SAFETY }            = require('./safety-constants');
const { KellyCriterion }    = require('./kelly-criterion');
const { CorrelationEngine } = require('./correlation-engine');
const auditLogRM = require('./audit-tagger');
const telegramRM = require('./telegram');

// ── Mixin methods ─────────────────────────────────────────────────────────────
const engineMethods = {

  async updateTrailingStop(currentPrice) {
    const pos = this.position;
    if (!pos || !TRADING_CONFIG.trailingStopEnabled) return;

    const isShort      = pos.side === 'SHORT';
    const baseTrailMult = TRADING_CONFIG.trailingStopDistance || 0.01;
    const atrForTrail   = this.lastATR || pos.atr || currentPrice * 0.001;
    const volLevel      = this.volatilityLevel || 'NORMAL';
    const trailMult     = volLevel === 'HIGH' ? 2.0 : volLevel === 'LOW' ? 0.8 : 1.2;
    const dist          = Math.max(baseTrailMult, atrForTrail / currentPrice * trailMult);
    const activation    = TRADING_CONFIG.trailingStopActivation;

    if (isShort) {
      // BUG-08 fix: removed redundant inner `if (isShort && ...)` — already inside `if (isShort)`
      // Sanity: SHORT trailing stop MUST sit above currentPrice
      if (pos.trailingStopActivated && pos.trailingStopPrice &&
          pos.trailingStopPrice <= currentPrice) {
        pos.trailingStopPrice = currentPrice * (1 + dist * 1.5);
        this.log('[TRAIL SANITY] SHORT trail below/at price — reset to ' + pos.trailingStopPrice.toFixed(5));
      }
      // ── SHORT: tracks LOWEST price, stop ratchets DOWN as profit grows ──
      const profitPct = (pos.entry - currentPrice) / pos.entry;
      if (!pos.lowestPrice || currentPrice < pos.lowestPrice) {
        pos.lowestPrice = currentPrice;
        if (!pos.trailingStopActivated && profitPct >= activation) {
          pos.trailingStopActivated = true;
          pos.trailingStopPrice     = pos.lowestPrice * (1 + dist);
          this.log('[TRAIL SHORT] Activated @ ' + pos.trailingStopPrice.toFixed(5));
          this.savePositionFile();
        }
        if (pos.trailingStopActivated) {
          const newStop = pos.lowestPrice * (1 + dist);
          if (newStop < pos.trailingStopPrice) {
            this.log('[TRAIL SHORT] Stop lowered: ' + pos.trailingStopPrice.toFixed(5) + ' -> ' + newStop.toFixed(5));
            pos.trailingStopPrice = newStop;
            this.savePositionFile();
          }
        }
      }
      // Exit SHORT: price rises back above the trailing stop
      if (pos.trailingStopActivated && currentPrice >= pos.trailingStopPrice) {
        const locked = ((pos.entry - pos.trailingStopPrice) / pos.entry * 100).toFixed(2);
        await this.exitPosition(currentPrice, 'Trailing Stop SHORT (locked ~' + locked + '% profit)');
      }

    } else {
      // ── LONG: tracks HIGHEST price, stop ratchets UP as profit grows ────
      const profitPct = (currentPrice - pos.entry) / pos.entry;
      if (currentPrice > (pos.highestPrice || pos.entry)) {
        pos.highestPrice = currentPrice;
        if (!pos.trailingStopActivated && profitPct >= activation) {
          pos.trailingStopActivated = true;
          pos.trailingStopPrice     = pos.highestPrice * (1 - dist);
          this.log('[TRAIL LONG] Activated @ ' + pos.trailingStopPrice.toFixed(5));
          this.savePositionFile();
        }
        if (pos.trailingStopActivated) {
          const newStop = pos.highestPrice * (1 - dist);
          if (newStop > pos.trailingStopPrice) {
            this.log('[TRAIL LONG] Stop raised: ' + pos.trailingStopPrice.toFixed(5) + ' -> ' + newStop.toFixed(5));
            pos.trailingStopPrice = newStop;
            this.savePositionFile();
          }
        }
      }
      // BUG-05 fix: LONG exit now lives HERE — consistent with SHORT exit above.
      // Previously split into checkRiskManagement(), creating a maintenance hazard.
      if (pos.trailingStopActivated && currentPrice <= pos.trailingStopPrice) {
        const locked = ((pos.trailingStopPrice - pos.entry) / pos.entry * 100).toFixed(2);
        await this.exitPosition(currentPrice, 'Trailing Stop (locked ~' + locked + '% profit)');
      }
    }
  },

  takePartialProfit(fraction) {
    if (!this.position || fraction <= 0 || fraction >= 1) return;
    const currentPrice  = this.priceHistory[this.priceHistory.length - 1];
    const slippage      = currentPrice * TRADING_CONFIG.slippage;
    // BUG-38 fix: SHORT partial close = buying back at ASK (price + slippage)
    //             LONG  partial close = selling at BID (price - slippage)
    const isShortPartialCheck = this.position.side === 'SHORT';
    const exitPrice     = isShortPartialCheck ? currentPrice + slippage : currentPrice - slippage;
    const sharesToClose = this.position.shares * fraction;
    if (sharesToClose < 0.0001) { this.log('⚠️ takePartialProfit: too small'); return; }
    const isShortPartial = this.position.side === 'SHORT';
    const partialCost    = sharesToClose * this.position.entry;
    // SHORT close: buying back at ask (+slippage), profit = (entry-exitPrice)*shares
    const exitValue     = sharesToClose * exitPrice;
    const commission    = exitValue * TRADING_CONFIG.commission;
    const sharesCost    = sharesToClose * this.position.entry;
    // SHORT partial P&L: sold high (entry), buying back low (exitPrice) = profit when entry>exitPrice
    const netProfit = isShortPartial
      ? (this.position.entry - exitPrice) * sharesToClose - commission
      : exitValue - sharesCost - commission;

    this.trades.push({
      id: ++this.tradeId, asset: this.selectedAsset, type: this.position.side || 'LONG',
      entry: this.position.entry, exit: exitPrice, shares: sharesToClose,
      profit: netProfit, profitPercent: partialCost > 0 ? (netProfit / partialCost) * 100 : 0,
      duration: Date.now() - this.position.entryTime,
      reason: `Partial Profit (${(fraction*100).toFixed(0)}%)`,
      timestamp: new Date().toISOString(), commission,
      confidence:    this.position.confidence,
      // BUG-52 fix: add fields required by MLConfidence.recordTrade() for correct labelling
      outcome:       netProfit > 0 ? 'WIN' : 'LOSS',
      rawConfidence: this.position.rawConfidence || this.position.confidence || 0,
      regime:        this.position.regime || 'UNKNOWN',
    });

    // SHORT partial: get back (entry * shares - commission), not exitValue
    this.capital += isShortPartial
      ? (this.position.entry * sharesToClose - commission)
      : (exitValue - commission);
    if (netProfit > 0) this.wins++; else this.losses++;
    this.position.shares          -= sharesToClose;
    this.position.partialDone = true;
    // Feature #11: After partial profit, move stop to breakeven on remainder
    // This is the "scale-out" trailing logic that was missing from the exit decision.
    if (!this.position.breakevenActivated && this.position.entry) {
      const beSlippage = this.position.entry * (TRADING_CONFIG.slippage || 0.0005);
      const isShortBE  = this.position.side === 'SHORT';
      // Set stop just inside breakeven (entry ± tiny buffer) to protect the winner
      this.position.stopLoss          = isShortBE
        ? this.position.entry + beSlippage   // SHORT: stop just above entry
        : this.position.entry - beSlippage;  // LONG:  stop just below entry
      this.position.breakevenActivated = true;
      // Fix #18: Recalculate breakeven price for the REMAINING shares (not original entry)
      // After partial close, the original entry price is no longer the correct breakeven.
      // FIX: this.position.shares is already decremented above, so remainingShares
      // IS this.position.shares now — don't subtract sharesToClose again
      const remainingCost = (this.position.cost || 0) - (sharesToClose * this.position.entry);
      const remainingShares = this.position.shares;  // already reduced
      if (remainingShares > 0 && remainingCost > 0) {
        this.position.entry = remainingCost / remainingShares;  // weighted avg entry
      }
      this.log(`[Partial #11/#18] Stop moved to breakeven @ ${this.position.stopLoss.toFixed(5)} | adj entry: ${this.position.entry.toFixed(5)}`);

    }
    this.log(`💰 PARTIAL ${(fraction*100).toFixed(0)}% @ ${exitPrice.toFixed(4)} | P/L: ${netProfit>=0?'+':''}$${netProfit.toFixed(2)} | Remaining: ${this.position.shares.toFixed(4)}`);
    this.saveTradesFile();
    this.savePositionFile();
  },

  async checkRiskManagement() {
    if (!this.position) return;
    const currentPrice = this.priceHistory[this.priceHistory.length - 1];
    // Bug fix: empty priceHistory yields currentPrice=undefined → profitPct=NaN
    // NaN comparisons are always false, silently skipping all SL/TP checks.
    if (currentPrice == null || !isFinite(currentPrice) || currentPrice <= 0) return;
    const profitPct    = (currentPrice - this.position.entry) / this.position.entry;

    // Fix #24: Maximum holding period — force exit before weekend gap risk materialises.
    // Also prevents zombie positions that missed SL/TP triggers.
    if (this.position.entryTime) {
      const holdMs  = Date.now() - this.position.entryTime;
      const maxHoldMs = (TRADING_CONFIG.maxHoldingHours || 48) * 3_600_000;
      if (holdMs > maxHoldMs) {
        const holdH = (holdMs / 3_600_000).toFixed(1);
        this.log(`⏰ [Fix #24] Max holding period ${holdH}h exceeded (limit ${TRADING_CONFIG.maxHoldingHours || 48}h) — exiting`);
        try { require('./telegram').send(`⏰ Max hold exceeded: ${holdH}h — force exit ${this.selectedAsset}`, 'risk'); } catch(_) {}
        await this.exitPosition(currentPrice, 'MaxHoldingPeriod').catch(() => {});
        return;
      }
      // Additional Friday-close check: exit before weekend if > configurable threshold Friday
      const now     = new Date();
      const dayUTC  = now.getUTCDay();    // 5=Friday
      const hourUTC = now.getUTCHours();
      const closeFridayHour = TRADING_CONFIG.fridayCloseHour || 20; // 20:00 UTC default
      if (dayUTC === 5 && hourUTC >= closeFridayHour && TRADING_CONFIG.closeFridayPositions !== false) {
        this.log(`📅 [Fix #24] Friday ${hourUTC}:00 UTC — closing position to avoid weekend gap risk`);
        try { require('./telegram').send(`📅 Friday close: exiting ${this.selectedAsset} before weekend gap`, 'risk'); } catch(_) {}
        await this.exitPosition(currentPrice, 'FridayWeekendClose').catch(() => {});
        return;
      }
    }

    // ── Per-asset drawdown tracking ───────────────────────────────────────
    // Track peak capital per asset and block trading if a single asset
    // loses more than maxAssetDrawdown (default 5%) from its peak.
    {
      const asset      = this.selectedAsset;
      const maxAssetDD = TRADING_CONFIG.maxAssetDrawdown || 0.05;
      const haltMins   = TRADING_CONFIG.assetHaltMinutes  || 120;

      // Update peak
      if (!this._assetPeakCapital[asset] || this.capital > this._assetPeakCapital[asset]) {
        this._assetPeakCapital[asset] = this.capital;
      }
      const peak = this._assetPeakCapital[asset];
      const dd   = peak > 0 ? (peak - this.capital) / peak : 0;
      this._assetDrawdown[asset] = dd;

      if (dd >= maxAssetDD && !this._assetHaltedUntil[asset]) {
        this._assetHaltedUntil[asset] = Date.now() + haltMins * 60_000;
        this.log('[ASSET HALT] ' + asset + ' drawdown ' + (dd*100).toFixed(1) + '% >= ' + (maxAssetDD*100) + '% — halted ' + haltMins + 'min');
      }
    }

    // ── P/L velocity check — loss acceleration detector (#6) ───────────────
    // Tracks P/L change over recent bars. If the position is losing at an
    // abnormally fast rate (e.g. 0.3% per bar), exit before the full stop hits.
    // This catches fast-moving adverse moves that ATR-based stops lag behind.
    {
      const isShortV  = this.position.side === 'SHORT';
      const curPnlPct = isShortV
        ? (this.position.entry - currentPrice) / this.position.entry
        : (currentPrice - this.position.entry) / this.position.entry;

      // Initialise velocity tracking on position
      if (!this.position._pnlHistory) this.position._pnlHistory = [];
      this.position._pnlHistory.push({ t: Date.now(), pnl: curPnlPct });
      // Keep last 10 snapshots
      if (this.position._pnlHistory.length > 10) this.position._pnlHistory.shift();

      const velWindow  = TRADING_CONFIG.pnlVelocityWindow || 5;  // bars to measure over
      const velThresh  = TRADING_CONFIG.pnlVelocityThreshold || -0.003; // -0.3%/bar = exit

      if (this.position._pnlHistory.length >= velWindow) {
        const oldest = this.position._pnlHistory[this.position._pnlHistory.length - velWindow];
        const newest = this.position._pnlHistory[this.position._pnlHistory.length - 1];
        const velocity = (newest.pnl - oldest.pnl) / velWindow;  // pnl change per bar

        if (velocity < velThresh) {
          const vPct = (velocity * 100).toFixed(3);
          this.log('[PNL VELOCITY] ' + vPct + '%/bar loss rate exceeds threshold (' + (velThresh*100) + '%) — early exit');
          try { auditLogRM.record({ type:'VELOCITY_EXIT', asset:this.selectedAsset, velocity, threshold:velThresh, pnl:curPnlPct }); } catch(_) {}
          try { telegramRM.send(`⚡ P/L Velocity Exit ${vPct}%/bar — ${this.selectedAsset}`, 'risk'); } catch(_) {}
          await this.exitPosition(currentPrice, 'P/L Velocity Exit (' + vPct + '%/bar)');
          return;
        }
      }
    }

    // ── Overnight swap cost (rollover) ─────────────────────────────────────
    // Deduct swap cost once per UTC rollover window if position has been open > 20h.
    // Wednesday rollover = 3× (covers weekend). Applies to both LONG and SHORT.
    {
      const rolloverHour = TRADING_CONFIG.swapRolloverHourUTC || 22;
      const nowUTC       = new Date();
      const utcHour      = nowUTC.getUTCHours();
      const utcMin       = nowUTC.getUTCMinutes();
      const isRollover   = utcHour === rolloverHour && utcMin < 5; // 5-min window
      const openHours    = (Date.now() - (this.position.entryTime || Date.now())) / 3_600_000;

      const todayStr = nowUTC.toISOString().slice(0,10);  // YYYY-MM-DD
      if (isRollover && openHours >= 20 && this.position._swapAppliedDate !== todayStr) {
        const swapTable = TRADING_CONFIG.swapCosts || {};
        const assetSwap = swapTable[this.selectedAsset];
        if (assetSwap) {
          const isShortSwap  = this.position.side === 'SHORT';
          const swapRate     = isShortSwap ? assetSwap.short : assetSwap.long;
          const positionVal  = this.position.shares * currentPrice;
          // Wednesday = 3× rollover
          const dayOfWeek    = nowUTC.getUTCDay();  // 3 = Wednesday
          const multiplier   = dayOfWeek === 3 ? 3 : 1;
          const swapCost     = positionVal * swapRate * multiplier;

          this.capital += swapCost;  // negative = deducted, positive = credited
          if (this.capital < 0) { this.log('[SWAP] Capital went negative after swap — clamping to $1'); this.capital = 1; }
          this.position._swapAppliedDate = nowUTC.toISOString().slice(0, 10);

          const sign = swapCost >= 0 ? '+' : '';
          this.log('[SWAP] ' + this.selectedAsset + ' rollover ' + sign + swapCost.toFixed(4) +
            ' (rate ' + (swapRate*10000).toFixed(2) + ' pips/night' +
            (multiplier === 3 ? ' × 3 Wed rollover' : '') + ')');
          // FIX: Wire SwapCostAlert — was instantiated but never called
          try {
            const _pos = this.position;
            if (_pos && this.swapCostAlert) {
              const _accSwap = (_pos._totalSwapCost = (_pos._totalSwapCost || 0) + swapCost);
              const _tpDist  = Math.abs((_pos.takeProfit || _pos.entry) - _pos.entry);
              const _tpProfit = _tpDist * (_pos.shares || 1);
              this.swapCostAlert.check(_accSwap, _tpProfit, this.selectedAsset);
            }
          } catch(_) {}
        }
      }
      // Reset daily swap flag 1h AFTER rollover (not before) so we don't clear before the charge
      // Bug #23 fix: unconditionally clear swap flag 1h after rollover so next day charges run
      if (utcHour === (rolloverHour + 1) % 24 && this.position._swapAppliedDate) {
        delete this.position._swapAppliedDate;
      }
    }

    // ── Pre-news position management (#22) ──────────────────────────────────
    // Before a high-impact event: tighten stop, take partial, or close
    if (this.economicCalendar && this.position) {
      const preNews = this.economicCalendar.preNewsManagement(
        this.selectedAsset, this.position
      );
      if (preNews) {
        this.log('[CALENDAR] ' + preNews.reason);
        // Close if in event window
        if (preNews.action === 'CLOSE') {
          await this.exitPosition(currentPrice, 'Pre-News Close — ' + preNews.event);
          return;
        }
        // Tighten stop: move SL 50% closer to current price
        if (preNews.action === 'TIGHTEN_AND_PARTIAL' && !this.position._newsTightened) {
          const isS = this.position.side === 'SHORT';
          const slDist = Math.abs(currentPrice - this.position.stopLoss);
          this.position.stopLoss = isS
            ? this.position.stopLoss - slDist * preNews.tightenStopBy
            : this.position.stopLoss + slDist * preNews.tightenStopBy;
          this.position._newsTightened = true;
          this.log('[CALENDAR] Stop tightened to ' + this.position.stopLoss.toFixed(5) + ' before ' + preNews.event);
        }
        // Take partial before event
        if (preNews.takePartial > 0 && !this.position._newsPartialTaken) {
          this.position._newsPartialTaken = true;
          this.takePartialProfit(preNews.takePartial);
        }
      }
    }

    // ── Max open time guard ────────────────────────────────────────────────
    // A position sitting open indefinitely ties up capital and accumulates
    // overnight/weekend risk. Force-close after MAX_OPEN_MS regardless of
    // whether SL/TP has been hit — exits at market with current P/L.
    const MAX_OPEN_MS = TRADING_CONFIG.maxOpenTimeMs || (48 * 60 * 60 * 1000); // default 48h
    const openMs      = Date.now() - (this.position.entryTime || Date.now());
    if (openMs > MAX_OPEN_MS) {
      const hours = (openMs / 3_600_000).toFixed(1);
      this.log(`⏰ MAX OPEN TIME: position open ${hours}h — force closing`);
      await this.exitPosition(currentPrice, `Max Open Time (${hours}h)`);
      return;
    }

    if (TRADING_CONFIG.trailingStopEnabled) this.updateTrailingStop(currentPrice);
    if (!this.position) return;  // trailing stop may have exited position — guard

    if (TRADING_CONFIG.breakevenEnabled && !this.position.breakevenActivated) {
      const isShortPos = this.position.side === 'SHORT';
      // SHORT profits when price falls — invert the profitPct check
      const shortProfitPct = (this.position.entry - currentPrice) / this.position.entry;
      const effectiveProfitPct = isShortPos ? shortProfitPct : profitPct;

      const bbuf = TRADING_CONFIG.breakevenBuffer || 0;
      if (bbuf <= 0) {
        this.log('⚠️ breakevenBuffer is 0 — breakeven disabled (set > 0 to enable)');
      } else if (effectiveProfitPct >= TRADING_CONFIG.breakevenTrigger - 1e-9) {
        if (isShortPos) {
          // Bug #19 fix: SHORT breakeven stop must be ABOVE entry (adverse = price rises)
          // entry * (1 + buffer) sits just above entry — stops out only if price reverses up
          const breakevenStop = this.position.entry * (1 + TRADING_CONFIG.breakevenBuffer);
          if (breakevenStop > this.position.stopLoss) {  // Bug #19 fix: > not <
            this.log('[BREAKEVEN SHORT] stop raised ' + this.position.stopLoss.toFixed(5) + ' to ' + breakevenStop.toFixed(5));
            this.position.stopLoss          = breakevenStop;
            this.position.breakevenActivated = true;
            this.savePositionFile();
          }
        } else {
          // LONG breakeven: move stop UP to entry + buffer
          const breakevenStop = this.position.entry * (1 + TRADING_CONFIG.breakevenBuffer);
          if (breakevenStop > this.position.stopLoss) {
            this.log('[BREAKEVEN LONG] stop raised ' + this.position.stopLoss.toFixed(5) + ' to ' + breakevenStop.toFixed(5));
            this.position.stopLoss          = breakevenStop;
            this.position.breakevenActivated = true;
            this.savePositionFile();
          }
        }
      }
    }

    // Fix #82: Tiered partial close — scale-out schedule (25% at 1R, 25% more at 2R)
    if (TRADING_CONFIG.partialProfitEnabled && this.position.atr > 0) {
      const atr82    = this.position.atr;
      const rPnl82   = (currentPrice - this.position.entry);
      const inR82    = atr82 > 0 ? Math.abs(rPnl82) / atr82 : 0;
      const isLong82 = this.position.side !== 'SHORT';
      const inProfit = isLong82 ? rPnl82 > 0 : rPnl82 < 0;
      if (inProfit) {
        const partial1Done = this.position._partial1Done;
        const partial2Done = this.position._partial2Done;
        if (!partial1Done && inR82 >= 1.0) {
          this.position._partial1Done = true;
          this.log(`[Tiered #82] 1R reached (${inR82.toFixed(2)}R) — taking 25% partial`);
          this.takePartialProfit(0.25);
          return;
        }
        if (partial1Done && !partial2Done && inR82 >= 2.0) {
          this.position._partial2Done = true;
          this.log(`[Tiered #82] 2R reached (${inR82.toFixed(2)}R) — taking second 25% partial`);
          this.takePartialProfit(0.25);
          return;
        }
      }
    }
    if (TRADING_CONFIG.partialProfitEnabled && !this.position.partialDone && this.position.atr > 0) {
      const isShortPos2 = this.position.side === 'SHORT';
      // SHORT partial: price must fall far enough (entry - atr*mult), not rise
      const partialTarget = isShortPos2
        ? this.position.entry - this.position.atr * TRADING_CONFIG.partialProfitTrigger
        : this.position.entry + this.position.atr * TRADING_CONFIG.partialProfitTrigger;
      const partialHit = isShortPos2 ? currentPrice <= partialTarget : currentPrice >= partialTarget;
      if (partialHit) {
        const vLevel   = this.volatilityLevel || 'NORMAL';
        const fraction = vLevel === 'HIGH' ? 0.65 : vLevel === 'LOW' ? 0.35 : TRADING_CONFIG.partialProfitFraction;
        this.takePartialProfit(fraction);
      }
    }

    // BUG-05 fix: LONG trailing exit removed from here — now handled inside updateTrailingStop()
    // alongside the SHORT exit, keeping both sides consistent and in one place.

    if (!this.position) return;  // safety guard — trailing stop may have just exited
    const isShort = this.position.side === 'SHORT';
    if (isShort) {
      // SHORT: stop is ABOVE entry, take profit is BELOW entry
      const sl = this.position.stopLoss   || (this.position.entry * (1 + TRADING_CONFIG.stopLoss));
      const tp = this.position.takeProfit || (this.position.entry * (1 - TRADING_CONFIG.takeProfit));
      // B4: SHORT SL fires when ASK hits the level (OANDA fills SHORT SL at ask)
      const _askPrice = this.currentAsk && this.currentAsk > 0 ? this.currentAsk : currentPrice;
      if (_askPrice >= sl) {
        const coolMs2 = (TRADING_CONFIG.slCooldownMinutes || 20) * 60_000;
        this._slCooldownUntil[this.selectedAsset] = Date.now() + coolMs2;
        this._oco_exiting=true; try { await this.exitPosition(currentPrice, 'Stop Loss SHORT'); } finally { this._oco_exiting=false; } return;  // Bug #21 fix
      }
      // B4: SHORT TP fires when BID drops to the level
      const _bidPrice = this.currentBid && this.currentBid > 0 ? this.currentBid : currentPrice;
      if (_bidPrice <= tp) {
        const tpCooldownMs = (TRADING_CONFIG.tpReentryCooldownBars || 3) * (TRADING_CONFIG.tradingInterval || 30000);
        this._tpCooldownUntil = Date.now() + tpCooldownMs;
        this._oco_exiting=true; try { await this.exitPosition(currentPrice, 'Take Profit SHORT'); } finally { this._oco_exiting=false; } }  // Bug #21 fix
    } else {
      const stopLoss = this.position.stopLoss || (this.position.entry * (1 - TRADING_CONFIG.stopLoss));
      // Item 3: Partial position scaling — add to winners, reduce losers
    if (this.position && TRADING_CONFIG.partialScalingEnabled) {
      const _isLong3 = this.position.side !== 'SHORT';
      const _pnlPct  = _isLong3
        ? (currentPrice - this.position.entry) / this.position.entry
        : (this.position.entry - currentPrice) / this.position.entry;
      // Scale IN: add 25% when 1R profit and no pyramid yet
      if (_pnlPct > 0 && _pnlPct >= (this.position.atr||0.001)/this.position.entry
          && !this.position._scaledIn && TRADING_CONFIG.partialScaleIn) {
        this.log(`[Item 3] Scaling IN +25% at ${(_pnlPct*100).toFixed(2)}% profit`);
        this.addToPosition(currentPrice, 0.25, 'Scale-In');
        this.position._scaledIn = true;
      }
      // Scale OUT: reduce 25% at first target to lock profit
      if (_pnlPct > 0 && !this.position._scaledOut
          && _pnlPct >= (TRADING_CONFIG.partialScaleOutPct || 0.005)) {
        this.log(`[Item 3] Scaling OUT 25% at ${(_pnlPct*100).toFixed(2)}% profit`);
        this.takePartialProfit(0.25);
        this.position._scaledOut = true;
      }
    }
    // Item 34: Bug #20 fix — this block was inside checkRiskManagement (only called when position exists)
    // Moved condition to correctly allow when no position (always false here, so treat as advisory only)
    if (TRADING_CONFIG.newsMeanReversionEnabled && this._newsEventPrice && this.position) {  // Bug #20: was !this.position
      const _msSinceEvent = Date.now() - (this._newsEventTs || 0);
      const _minMs = 15 * 60_000, _maxMs = 30 * 60_000;
      if (_msSinceEvent > _minMs && _msSinceEvent < _maxMs) {
        const _currP34  = this.priceHistory.at(-1) || 0;
        const _move34   = (_currP34 - this._newsEventPrice) / Math.max(this.lastATR||0.001,1e-6);
        const _minMoveR = TRADING_CONFIG.newsMeanRevMinATR || 1.5;
        if (Math.abs(_move34) > _minMoveR) {
          const _revAction = _move34 > 0 ? 'SELL' : 'BUY';
          this.log(`[Item 34] Post-news mean-reversion: ${_move34.toFixed(1)}R spike → ${_revAction}`);
        }
      }
    }
    // News momentum extension: hold position longer when news aligns with direction
    if (this.position && TRADING_CONFIG.newsMomentumEnabled) {
      const _newsScore = this._latestNewsSentiment?.score || 0;
      const _isLong    = this.position.side !== 'SHORT';
      const _aligned   = (_isLong && _newsScore > 0.3) || (!_isLong && _newsScore < -0.3);
      if (_aligned && this.position.takeProfit && !this.position._newsExtended) {
        const _tp     = this.position.takeProfit;
        const _entry  = this.position.entry;
        const _extMult= TRADING_CONFIG.newsMomentumExtMult || 1.25;
        const _newTP  = _isLong ? _entry + (_tp-_entry)*_extMult : _entry - (_entry-_tp)*_extMult;
        this.position.takeProfit  = _newTP;
        this.position._newsExtended = true;
        this.log(`[NewsMom] Sentiment ${_newsScore.toFixed(2)} aligned → TP extended to ${_newTP.toFixed(5)}`);
      }
    }
    // Item 33: Overnight gap fade — detect Sunday open gap vs Friday close
    if (TRADING_CONFIG.overnightGapFadeEnabled) {
      const _now33    = new Date();
      const _day33    = _now33.getUTCDay();
      const _hour33   = _now33.getUTCHours();
      const _isMonOpen = _day33 === 1 && _hour33 < 4;  // Monday 00-04 UTC
      if (_isMonOpen && this._fridayClose && this.priceHistory.length > 0) {
        const _currPrice33 = this.priceHistory.at(-1) || 0;
        const _gap33 = (_currPrice33 - this._fridayClose) / this._fridayClose;
        const _minGap = TRADING_CONFIG.overnightGapMinPct || 0.003;
        if (Math.abs(_gap33) > _minGap && !this._gapFadeTriggered) {
          const _gapAction = _gap33 > 0 ? 'SELL' : 'BUY';
          this.log(`[Item 33] Gap fade: ${(_gap33*100).toFixed(2)}% gap → ${_gapAction}`);
          this._gapFadeTriggered = true;
          this._gapFadeAction    = _gapAction;
        }
      }
      // Record Friday close at 21:00 UTC Friday
      if (_day33 === 5 && _hour33 === 21) {
        this._fridayClose      = this.priceHistory.at(-1) || 0;
        this._gapFadeTriggered = false;
        this._gapFadeAction    = null;
      }
    }
    // Item 2: Dynamic SL tightening near NY session close (21:00 UTC)
    if (this.position && TRADING_CONFIG.sessionCloseTightenEnabled !== false) {
      const _utcH2 = new Date().getUTCHours();
      const _closeH = TRADING_CONFIG.nyCloseHour || 21;
      const _tightenH = TRADING_CONFIG.tightenBeforeCloseHours || 0.5;
      const _isNearClose = _utcH2 === _closeH || (_utcH2 === _closeH - 1 && new Date().getUTCMinutes() >= 30);
      if (_isNearClose && !this.position._slTightened) {
        const _isLong = this.position.side !== 'SHORT';
        const _tightenPct = TRADING_CONFIG.sessionCloseTightenPct || 0.50;
        const _entry   = this.position.entry;
        const _currSL  = this.position.stopLoss;
        const _newSL   = _isLong
          ? _currSL + (_entry - _currSL) * _tightenPct
          : _currSL - (_currSL - _entry) * _tightenPct;
        this.position.stopLoss    = _newSL;
        this.position._slTightened = true;
        this.log(`[Item 2] SL tightened to ${_newSL.toFixed(5)} (${(_tightenPct*100).toFixed(0)}% closer) before NY close`);
      }
    }
    // Item 67: Position age decay — after 4h without target, reduce TP 20%
    if (this.position?.entryTime && this.position.takeProfit) {
      const _holdH67   = (Date.now() - this.position.entryTime) / 3_600_000;
      const _decayH67  = TRADING_CONFIG.positionAgeDecayHours || 4;
      if (_holdH67 >= _decayH67 && !this.position._tpDecayed) {
        const _isLong67 = this.position.side !== 'SHORT';
        const _entry67  = this.position.entry;
        const _tp67     = this.position.takeProfit;
        const _decayPct = TRADING_CONFIG.positionAgeDecayPct || 0.20;
        const _newTP    = _isLong67
          ? _tp67 - (_tp67 - _entry67) * _decayPct
          : _tp67 + (_entry67 - _tp67) * _decayPct;
        this.position.takeProfit  = _newTP;
        this.position._tpDecayed  = true;
        this.log(`[Item 67] TP decayed ${(_decayPct*100).toFixed(0)}% after ${_holdH67.toFixed(1)}h (${_entry67.toFixed(5)} → ${_newTP.toFixed(5)})`);
      }
    }
    // Adaptive ATR stops: widen SL at high vol, tighten at low vol
    if (this.position && TRADING_CONFIG.adaptiveStopsEnabled !== false && this.lastATR) {
      const _baseATR = TRADING_CONFIG.stopLoss || 0.02;
      const _volMult = (() => {
        if (!this.priceHistory || this.priceHistory.length < 20) return 1;
        const _recentRets = this.priceHistory.slice(-20).map((v,i,a)=>i?Math.abs(v-a[i-1])/a[i-1]:0).slice(1);
        const _rvol = Math.sqrt(_recentRets.reduce((s,v)=>s+v**2,0)/_recentRets.length);
        const _rvol20dAvg = (_rvol * Math.sqrt(252*48));  // annualised
        return _rvol20dAvg > 0.15 ? 1.3 : _rvol20dAvg < 0.05 ? 0.75 : 1.0;
      })();
      if (_volMult !== 1.0 && !this.position._adaptiveStopSet) {
        const _isLong = this.position.side !== 'SHORT';
        const _newSL  = _isLong
          ? this.position.entry - this.lastATR * (TRADING_CONFIG.slAtrMult||1.5) * _volMult
          : this.position.entry + this.lastATR * (TRADING_CONFIG.slAtrMult||1.5) * _volMult;
        if ((_isLong && _newSL < this.position.entry) || (!_isLong && _newSL > this.position.entry)) {
          this.position.stopLoss = _newSL;
          this.position._adaptiveStopSet = true;
          this.log(`[AdaptStop] Vol mult ${_volMult.toFixed(2)}× → SL ${_newSL.toFixed(5)}`);
        }
      }
    }
    // Item 66: News-aware stop tightening — 5 min before HIGH-impact event
    if (this.position && this.economicCalendar) {
      try {
        const _events66 = (this.economicCalendar._liveEvents||[]).filter(ev=>{
          const mins = (ev.utcTime - Date.now()) / 60_000;
          return mins > 0 && mins <= 5 && ev.impact === 'HIGH';
        });
        if (_events66.length > 0 && !this.position._newsProtected) {
          const _isLong66 = this.position.side !== 'SHORT';
          const _currSL66 = this.position.stopLoss;
          const _entry66  = this.position.entry;
          const _tightenPct66 = TRADING_CONFIG.newsStopTightenPct || 0.50;
          const _newSL66 = _isLong66
            ? _currSL66 + (_entry66 - _currSL66) * _tightenPct66
            : _currSL66 - (_currSL66 - _entry66) * _tightenPct66;
          this.position.stopLoss      = _newSL66;
          this.position._newsProtected = true;
          this.log(`[Item 66] News SL tightened to ${_newSL66.toFixed(5)} (${_events66[0]?.name||'event'} in <5min)`);
        }
      } catch(_) {}
    }
    // Item 42: Auto breakeven — shift SL to entry after N pips of profit
    if (this.position && TRADING_CONFIG.breakevenPips && !this.position.breakevenActivated) {
      const _pipSize  = this.selectedAsset?.includes('JPY') ? 0.01 : 0.0001;
      const _bePips   = TRADING_CONFIG.breakevenPips * _pipSize;
      const _isLong   = this.position.side !== 'SHORT';
      const _pnlPips  = _isLong
        ? (currentPrice - this.position.entry) / _pipSize
        : (this.position.entry - currentPrice) / _pipSize;
      if (_pnlPips >= TRADING_CONFIG.breakevenPips) {
        const _beStop = _isLong
          ? this.position.entry + _pipSize  // 1 pip above entry for LONG
          : this.position.entry - _pipSize;
        if ((_isLong && _beStop > this.position.stopLoss) ||
            (!_isLong && _beStop < this.position.stopLoss)) {
          this.position.stopLoss = _beStop;
          this.position.breakevenActivated = true;
          this.log(`[Item 42] Breakeven: SL moved to ${_beStop.toFixed(5)} (${_pnlPips.toFixed(1)} pips profit)`);
        }
      }
    }
    // Item #22: Minimum holding period — block early SL/TP triggers within first N minutes
    // Prevents getting stopped out immediately after entry on noise spikes
    if (this.position?.entryTime && TRADING_CONFIG.minHoldMinutes) {
      const holdMs    = Date.now() - this.position.entryTime;
      const minHoldMs = TRADING_CONFIG.minHoldMinutes * 60_000;
      this._inMinHoldPeriod = holdMs < minHoldMs;
      if (holdMs < minHoldMs) {
        this.log(`[#22] Min hold (${(holdMs/60000).toFixed(1)}/${TRADING_CONFIG.minHoldMinutes}min) — deferring SL/TP check`);
        return;
      }
    }
    // Item #3: OCO — mark position as "exiting" before any SL/TP to prevent double-exit
    // The _exiting mutex in exitPosition covers concurrent async calls, but this guards
    // against the case where SL and TP BOTH evaluate true in the same synchronous checkRiskManagement call.
    if (this._oco_exiting) return;  // already dispatched an exit this bar
    // B4: SL fires when BID hits the level (not mid). OANDA fills long SL at bid.
      const _checkPriceLong = this.currentBid && this.currentBid > 0 ? this.currentBid : currentPrice;
      if (_checkPriceLong <= stopLoss) {
        const asset = this.selectedAsset;
        const coolMs = (TRADING_CONFIG.slCooldownMinutes || 20) * 60_000;
        this._slCooldownUntil[asset] = Date.now() + coolMs;
        this._oco_exiting=true; try { await this.exitPosition(currentPrice, this.position.breakevenActivated ? 'Breakeven Stop' : 'Stop Loss (ATR Dynamic)'); } finally { this._oco_exiting=false; }  // Bug #21 fix
        return;
      }
      const takeProfit = this.position.takeProfit || (this.position.entry * (1 + TRADING_CONFIG.takeProfit));
      if (currentPrice >= takeProfit) {
        // Fix #14: Set TP cooldown to prevent immediate re-entry in ranging markets
        const tpCooldownMs = (TRADING_CONFIG.tpReentryCooldownBars || 3) * (TRADING_CONFIG.tradingInterval || 30000);
        this._tpCooldownUntil = Date.now() + tpCooldownMs;
        this._oco_exiting=true; try { await this.exitPosition(currentPrice, 'Take Profit (ATR Dynamic)'); } finally { this._oco_exiting=false; } }  // Bug #21 fix
    }
  },

  async executeDecision(decision) {
    // corrMultiplier declared at top — items #15/#16/#49 modify it before the LONG path
    // where it's also declared locally. This top-level declaration prevents ReferenceError.
    let corrMultiplier = 1;
    // ── Time-based risk reduction (#13) ──────────────────────────────────
    // After 16:00 NY (21:00 UTC): reduce position size 40% — liquidity drops
    const utcHour = new Date().getUTCHours();
    const isLateSession = utcHour >= 21 || utcHour < 5;
    if (isLateSession && !this._lateSessionLogged) {
      this.log('[TIME RISK] Late session — position size reduced 40%');
      this._lateSessionLogged = true;
    }
    if (!isLateSession) this._lateSessionLogged = false;
    this._lateSessionSizeMult = isLateSession ? 0.60 : 1.0;
    const { action } = decision;
    let confidence = decision.confidence;  // Bug #4 fix: must be let — mutated by carry/contrarian/degraded guards
    this._pendingDecisionAction = action;  // Bug #49 fix: write so stuck-signal detector can read it
    if (this.circuitBreakerTripped) return;
    if (this.priceHistory.length === 0) return;

    // ── TOD Heatmap gate — block entries in statistically bad hours ───────
    if (action !== 'HOLD' && this.todHeatmap) {
      const _todCheck = this.todHeatmap.check();
      if (!_todCheck.allowed) return;
    }

    // ── Liquidity gate — block entry in dry markets (Bug #65 fix) ────────
    if (action !== 'HOLD' && decision.indicators?.liquidityBlocked) {
      this.log(`🚫 [LiquidityGate] Entry blocked — dry market (score=${decision.indicators.liquidityScore?.toFixed(2)})`);
      return;
    }

    // ── Ensemble disagreement halt ─────────────────────────────────────────
    // FIX: decision.votes never set by ab-tester; use agreeing/totalStrategies instead
    if (action !== 'HOLD' && this.ensembleDisagree && decision.fromEnsemble &&
        typeof decision.agreeing === 'number' && typeof decision.totalStrategies === 'number' &&
        decision.totalStrategies > 0) {
      const _agreeCount = decision.agreeing;
      const _totalCount = decision.totalStrategies;
      const _oppose     = action === 'BUY' ? 'SELL' : 'BUY';
      const _syntheticVotes = [
        ...Array(_agreeCount).fill(action),
        ...Array(Math.max(0, _totalCount - _agreeCount)).fill(_oppose),
      ];
      const _edCheck = this.ensembleDisagree.evaluate(_syntheticVotes, action);
      if (!_edCheck.allowed) return;
    }

    // Item 43: Session range filter — block entries near session high/low extremes
    if (TRADING_CONFIG.sessionRangeFilter !== false && !process.env.BACKTEST_MODE && this.priceHistory.length >= 10) {
      const _curP43 = this.priceHistory[this.priceHistory.length - 1] || 0;
      const _sessionPrices = this.priceHistory.slice(-Math.min(48, this.priceHistory.length));
      const _sHigh = Math.max(..._sessionPrices);
      const _sLow  = Math.min(..._sessionPrices);
      const _range = _sHigh - _sLow;
      if (_range > 0) {
        const _pct = (_curP43 - _sLow) / _range;
        const _edgePct = TRADING_CONFIG.sessionRangeEdgePct || 0.10;
        if (action === 'BUY'  && _pct > (1 - _edgePct)) {
          this.log(`[Item 43] Near session HIGH (${(_pct*100).toFixed(0)}%) — LONG blocked`); return;
        }
        if (action === 'SELL' && _pct < _edgePct) {
          this.log(`[Item 43] Near session LOW (${(_pct*100).toFixed(0)}%) — SHORT blocked`); return;
        }
      }
    }
    // Item 97: Trading session scheduler — only trade within configured active hours
    if (TRADING_CONFIG.activeSessions && !this.position && !process.env.BACKTEST_MODE && !process.env.PAPER_MODE) {
      const _utcH97 = new Date().getUTCHours();
      const _utcM97 = new Date().getUTCMinutes();
      const _active97 = TRADING_CONFIG.activeSessions.some(sess => {
        const [sh,sm] = (sess.start||'00:00').split(':').map(Number);
        const [eh,em] = (sess.end  ||'24:00').split(':').map(Number);
        const _nowMin  = _utcH97*60+_utcM97;
        const _startMin= sh*60+sm, _endMin= eh*60+em;
        return _nowMin >= _startMin && _nowMin < _endMin;
      });
      if (!_active97) {
        this.log(`[Item 97] Outside active sessions at ${String(_utcH97).padStart(2,'0')}:${String(_utcM97).padStart(2,'0')} UTC — no new entries`);
        return;
      }
    }
    // Item 32: Notional exposure cap in base currency (skip in backtest/paper mode) (e.g. max $50,000 notional open)
    if (TRADING_CONFIG.maxNotionalExposure && this.position && !process.env.BACKTEST_MODE) {
      const _notional = this.position.shares * (this.priceHistory.at(-1) || 1);
      if (_notional > TRADING_CONFIG.maxNotionalExposure) {
        this.log(`🛑 [Item 32] Notional exposure $${_notional.toFixed(0)} > cap $${TRADING_CONFIG.maxNotionalExposure} — no new position`);
        return;
      }
    }
    // Drawdown-adjusted sizing: reduce size when below high-water mark
    if (TRADING_CONFIG.hwmSizingEnabled !== false) {
      if (!this._hwm || this.capital > this._hwm) this._hwm = this.capital;
      const _ddFromHWM = this._hwm > 0 ? (this._hwm - this.capital) / this._hwm : 0;
      if (_ddFromHWM > 0.05) {
        // Reduce size linearly: at 5% DD → 75%, at 15% DD → 25%
        const _hwmMult = Math.max(0.25, 1 - (_ddFromHWM - 0.05) / 0.10 * 0.75);
        corrMultiplier = (corrMultiplier||1) * _hwmMult;
        if (_ddFromHWM > 0.08) this.log(`[HWM] DD ${(_ddFromHWM*100).toFixed(1)}% from HWM → size ×${_hwmMult.toFixed(2)}`);
      }
    }
    // Item 31: Intraday drawdown limit — hourly cap separate from session/global
    if (TRADING_CONFIG.intradayDrawdownLimit) {
      const _hour31 = new Date().getUTCHours();
      if (this._intradayHour !== _hour31) {
        this._intradayHour    = _hour31;
        this._intradayCapital = this.capital;  // reset hourly baseline
      }
      const _intradayDD = this._intradayCapital > 0
        ? (this._intradayCapital - this.capital) / this._intradayCapital : 0;
      if (_intradayDD >= TRADING_CONFIG.intradayDrawdownLimit) {
        this.log(`🛑 [Item 31] Intraday DD ${(_intradayDD*100).toFixed(2)}% ≥ ${(TRADING_CONFIG.intradayDrawdownLimit*100).toFixed(1)}% — no new entries this hour`);
        return;
      }
    }
    // Item 35: Maximum loss per instrument per day
    if (TRADING_CONFIG.maxInstrumentLossPerDay) {
      const _today35 = new Date().toISOString().slice(0,10);
      if (!this._instrumentLoss) this._instrumentLoss = {};
      if (!this._instrumentLossDate || this._instrumentLossDate !== _today35) {
        this._instrumentLoss = {}; this._instrumentLossDate = _today35;
      }
      const _instLoss = this._instrumentLoss[this.selectedAsset] || 0;
      if (_instLoss >= TRADING_CONFIG.maxInstrumentLossPerDay) {
        this.log(`🛑 [Item 35] ${this.selectedAsset} daily loss $${_instLoss.toFixed(2)} ≥ cap $${TRADING_CONFIG.maxInstrumentLossPerDay} — no more entries today`);
        return;
      }
    }
    // Item #11: Max daily trade count limit
    if (TRADING_CONFIG.maxDailyTrades) {
      const today = new Date().toISOString().slice(0,10);
      if (this._dailyTradeDate !== today) { this._dailyTradeDate = today; this._dailyTradeCount = 0; }
      if (this._dailyTradeCount >= TRADING_CONFIG.maxDailyTrades && !this.position) {
        this.log(`🛑 [#11] Max daily trades (${TRADING_CONFIG.maxDailyTrades}) reached — no new entries today`);
        return;
      }
    }
    // Fix #27: Absolute minimum capital floor
    const absFloor = TRADING_CONFIG.minAbsoluteCapital || 0;
    if (absFloor > 0 && this.capital < absFloor && !this.position) {
      this.log(`🛑 [Fix #27] Capital $${this.capital.toFixed(2)} < absolute floor $${absFloor} — no new entries`);
      if (!this._absFloorAlerted) {
        this._absFloorAlerted = true;
        try { require('./telegram').send(`🛑 Absolute capital floor $${absFloor} breached — $${this.capital.toFixed(2)} remaining`, 'halt'); } catch(_) {}
      }
      return;
    } else { this._absFloorAlerted = false; }
    // Item 48: Dynamic confidence floor by regime
    {
      const _regime48 = this.lastMarketRegime || 'UNKNOWN';
      const _floorMap = {
        'STRONG_TREND':   TRADING_CONFIG.minConfidenceTrend   || 55,
        'TRENDING':       TRADING_CONFIG.minConfidenceTrend   || 55,
        'HIGH_VOL':       TRADING_CONFIG.minConfidenceHighVol || 75,
        'CRISIS':         TRADING_CONFIG.minConfidenceCrisis  || 80,
        'RANGING':        TRADING_CONFIG.minConfidence        || 60,
        'MEAN_REVERT':    TRADING_CONFIG.minConfidence        || 60,
      };
      const _dynamicFloor = _floorMap[_regime48] !== undefined ? _floorMap[_regime48] : (TRADING_CONFIG.minConfidence || 60);
      if (confidence < _dynamicFloor) {
        this.log(`[Item 48] Dynamic floor: ${confidence}% < ${_dynamicFloor}% in ${_regime48} regime — blocked`);
        return;
      }
    }
    // Carry premium bonus: widen position size when positive carry (swap) aligns with direction
    if (TRADING_CONFIG.carryPremiumEnabled && this.selectedAsset) {
      const _swaps = TRADING_CONFIG.swapCosts || {};
      const _swap  = _swaps[this.selectedAsset];
      if (_swap) {
        const _isLong     = action !== 'SELL';
        const _carryRate  = _isLong ? (_swap.long||0) : (_swap.short||0);
        const _minCarry   = TRADING_CONFIG.carryMinBps || 0.0002;
        if (_carryRate > _minCarry) {
          // Positive carry: increase confidence by up to 5%
          const _carryBonus = Math.min(5, Math.floor(_carryRate / _minCarry) * 2);
          confidence = Math.min(95, confidence + _carryBonus);
          this.log(`[Carry] Positive carry ${(_carryRate*1e4).toFixed(1)}bps → conf +${_carryBonus}%`);
        }
      }
    }
    // Item 47: Social sentiment contrarian gate (retail >75% long = sell signal)
    if (TRADING_CONFIG.sentimentGateEnabled !== false && this.socialTracker) {
      try {
        const _sentiment47 = this.socialTracker?.getLatestSentiment?.(this.selectedAsset);
        if (_sentiment47 && _sentiment47.longPct !== undefined) {
          const _lp = _sentiment47.longPct;
          const _contrarianThresh = TRADING_CONFIG.sentimentContrarianThresh || 75;
          if (action === 'BUY'  && _lp > _contrarianThresh) {
            confidence = Math.max(0, confidence - 5);
            this.log(`[Item 47] Contrarian: ${_lp.toFixed(0)}% retail long → BUY confidence -5%`);
          }
          if (action === 'SELL' && _lp < (100 - _contrarianThresh)) {
            confidence = Math.max(0, confidence - 5);
            this.log(`[Item 47] Contrarian: ${_lp.toFixed(0)}% retail long → SELL confidence -5%`);
          }
        }
      } catch(_) {}
    }
    // Item 35: Pre-FOMC 2-day drift reduction (30% for 48h window)
    if (this.economicCalendar?.preFOMCDriftMultiplier) {
      const fomc35 = this.economicCalendar.preFOMCDriftMultiplier(this.selectedAsset);
      if (fomc35 < 1.0) {
        corrMultiplier = (corrMultiplier||1) * fomc35;
        this.log(`[Item 35] Pre-FOMC 48h window — size reduced to ${(fomc35*100).toFixed(0)}%`);
      }
    }
    // Item 72: Correlation cluster hard block — no 4th position in cluster with r>0.7
    if (CorrelationEngine?.getCluster) {
      try {
        const _cluster72 = CorrelationEngine.getCluster?.(this.selectedAsset, 0.7) || [];
        const _openInCluster = _cluster72.filter(a => a !== this.selectedAsset && this.openPositions?.[a]).length;
        if (_openInCluster >= 3) {
          this.log(`🛑 [Item 72] Correlation hard block: ${_openInCluster} correlated positions open (r>0.7)`);
          return;
        }
      } catch(_) {}
    }
    // Item #16: Pre-FOMC/ECB size reduction
    if (this.economicCalendar?.preCBSizeMultiplier) {
      const cbMult = this.economicCalendar.preCBSizeMultiplier(this.selectedAsset);
      if (cbMult < 1.0) {
        corrMultiplier = (corrMultiplier || 1) * cbMult;
        this.log(`[#16] Pre-CB event: size reduced to ${(cbMult*100).toFixed(0)}%`);
      }
    }
    // Item #15: Weekend position size reduction (0.25× after Friday 21:00 UTC)
    {
      const _now15  = new Date();
      const _day15  = _now15.getUTCDay();     // 5=Fri 6=Sat 0=Sun
      const _hour15 = _now15.getUTCHours();
      const _weekendStart = TRADING_CONFIG.weekendRiskHour || 21;
      const _isWeekend = (_day15 === 5 && _hour15 >= _weekendStart) || _day15 === 6 || _day15 === 0;
      if (_isWeekend) {
        const _wMult = TRADING_CONFIG.weekendSizeMult || 0.25;
        corrMultiplier = (corrMultiplier || 1) * _wMult;
        this.log(`[#15] Weekend — position size reduced to ${(_wMult*100).toFixed(0)}%`);
      }
    }
    // Bug #11: daily trade counter moved to after enterPosition/enterShort confirms entry
    // Fix #49: Apply degraded mode multipliers before any entry
    if (this._degradedMode && (action === 'BUY' || action === 'SELL')) {
      confidence = Math.max(0, confidence - 10);  // +10 minConf requirement
      corrMultiplier = (corrMultiplier || 1) * 0.5;  // halve position size
    }
    if (this.globalHaltTripped && (action === 'BUY' || action === 'SELL') && !this.position) {
      this.log('🛑 BLOCKED — Global drawdown halt: no new entries (BUY or SHORT) until manually reset');
      return;
    }
    if (this.dailyLockoutUntil > Date.now()) {
      this.log(`⏳ BLOCKED — 24h cool-off active (${((this.dailyLockoutUntil-Date.now())/3600000).toFixed(1)}h remaining)`); return;
    } else if (this.dailyLockoutUntil > 0 && this.dailyLockoutUntil <= Date.now()) {
      this._clearDailyLockout(); this.circuitBreakerTripped = false;
      this.log('✅ 24-hour cool-off expired — engine unlocked');
    }
    if (this.consecutiveHaltUntil > Date.now()) {
      if (action === 'BUY' || (action === 'SELL' && !this.position)) {
        this.log(`⏸️ BLOCKED — Consecutive loss cooldown (${((this.consecutiveHaltUntil-Date.now())/60000).toFixed(1)} min)`); return;
      }
    } else if (this.consecutiveHaltUntil > 0 && this.consecutiveHaltUntil <= Date.now()) {
      this.consecutiveHaltUntil = 0; this.consecutiveLosses = 0;
      this.log('✅ Consecutive loss cooldown expired');
    }
    if (this.flashCrashHaltUntil > Date.now()) {
      this.log(`⚡ BLOCKED — Flash crash halt (${((this.flashCrashHaltUntil-Date.now())/60000).toFixed(1)} min)`); return;
    }

    const currentPrice = this.priceHistory[this.priceHistory.length - 1];

    // BUY with open SHORT = cover the short position
    // ── GC stale cooldown/halt entries (Fix #12) ─────────────────────────
    const _now = Date.now();
    if (this._slCooldownUntil) {
      for (const k of Object.keys(this._slCooldownUntil)) {
        if (this._slCooldownUntil[k] < _now) delete this._slCooldownUntil[k];
      }
    }
    if (this._assetHaltedUntil) {
      for (const k of Object.keys(this._assetHaltedUntil)) {
        if (this._assetHaltedUntil[k] < _now) delete this._assetHaltedUntil[k];
      }
    }

    // ── Per-asset halt gate ───────────────────────────────────────────────
    const assetHalt = this._assetHaltedUntil && this._assetHaltedUntil[this.selectedAsset];
    if (!this.position && assetHalt && _now < assetHalt) {
      const minsLeft2 = ((assetHalt - Date.now()) / 60_000).toFixed(0);
      this.log('[ASSET HALT] ' + this.selectedAsset + ' blocked (BUY+SHORT) — ' + minsLeft2 + ' min remaining');
      return;
    }

    // ── SL re-entry cooldown gate ─────────────────────────────────────────
    const coolUntil = this._slCooldownUntil && this._slCooldownUntil[this.selectedAsset];
    if (!this.position && coolUntil && Date.now() < coolUntil) {
      const minsLeft = ((coolUntil - Date.now()) / 60_000).toFixed(1);
      this.log('[SL COOLDOWN] ' + this.selectedAsset + ' blocked for ' + minsLeft + ' min after stop-loss');
      return;
    }

    if (action === 'BUY' && this.position && this.position.side === 'SHORT') {
      await this.exitPosition(currentPrice, 'Cover SHORT — strategy signal');
      return;
    }

    if (action === 'BUY' && !this.position && this.capital > 0) {
      // Drift monitor halt gate — block new entries when live performance has diverged
      if (this.driftMonitor && this.driftMonitor.isHalted()) {
        this.log('[DRIFT HALT] New entry blocked — ' + (this.driftMonitor.haltStatus()?.reason || 'performance drift'));
        return;
      }
      // Session gate: avoid opening in thin Asian market (#21)
      if (this._isGoodSession && !this._isGoodSession()) {
        this.log('🌙 BLOCKED — Asian session (thin liquidity, wide spreads)'); return;
      }
      const openAsset      = this.position?.asset || this.lastClosedAsset || null;
      const priceHistories = this.marketData?.priceHistories || {};
      // Bug #25 fix: removed corrMultiplier = 1 reset — accumulated multipliers from HWM/FOMC/weekend guards must be preserved

      if (openAsset && openAsset !== this.selectedAsset) {
        const corrCheck = CorrelationEngine.check(this.selectedAsset, openAsset, priceHistories);
        this.lastCorrelationCheck = corrCheck;
        if (corrCheck.blocked) { this.log(`🚫 CORRELATION BLOCK: ${corrCheck.reason}`); return; }
        if (corrCheck.label === 'WARN') { this.log(`⚠️ CORRELATION WARN: ${corrCheck.reason}`); corrMultiplier = corrCheck.sizeMultiplier; }
      }

      // Fix #14: TP cooldown prevents churn after take-profit exit
      if (this._tpCooldownUntil && Date.now() < this._tpCooldownUntil) {
        this.log(`⏳ [Fix #14] TP cooldown: ${((this._tpCooldownUntil-Date.now())/1000).toFixed(0)}s — entry blocked`);
        return;
      }
      const newsCheck = this.newsFilter.checkEntry(this.selectedAsset);
      if (newsCheck.blocked) { this.log(`📰 ${newsCheck.reason}`); return; }
      // Item #10: Carry trade strategy — boost confidence for carry-positive direction
    if (TRADING_CONFIG.carryTradeEnabled) {
      const swapTable = TRADING_CONFIG.swapCosts || {};
      const assetSwap = swapTable[this.selectedAsset];
      if (assetSwap) {
        const volatilityOK = (this.volatilityLevel === 'LOW' || this.volatilityLevel === 'NORMAL');
        const longCarry    = assetSwap.long  > 0 ? assetSwap.long  : 0;
        const shortCarry   = assetSwap.short > 0 ? assetSwap.short : 0;
        const minCarry     = TRADING_CONFIG.carryMinRateDiff || 0.0002;  // ~0.02% daily
        if (action === 'BUY'  && longCarry  > minCarry && volatilityOK) confidence += 5;
        if (action === 'SELL' && shortCarry > minCarry && volatilityOK) confidence += 5;
      }
    }
    // Fix #40: Carry filter — penalise SHORT confidence on positive-carry pairs (AUDJPY, USDJPY)
      if (action === 'SELL') {
        const positiveCarryPairs = TRADING_CONFIG.positiveCarryPairs || ['AUDJPY','USDJPY','NZDJPY'];
        if (positiveCarryPairs.includes(this.selectedAsset || '')) {
          confidence = Math.max(0, confidence - (TRADING_CONFIG.carryShortPenalty || 8));
          this.log(`[Carry #40] SHORT on positive-carry pair — confidence reduced to ${confidence}%`);
        }
      }
      // Fix #11: Block entries during strategy warm-up after champion switch
      // Fix #91: Regime-conditional TP/SL ATR multipliers (uses lastMarketRegime, not indicators param)
    if (!this.position) {
      const regime91 = this.lastMarketRegime || 'UNKNOWN';
      const tpTable = TRADING_CONFIG.regimeTpMult || { TRENDING: 6.0, RANGING: 2.0, WEAK_TREND: 4.0 };
      const slTable = TRADING_CONFIG.regimeSlMult || { TRENDING: 1.0, RANGING: 2.0, WEAK_TREND: 1.5 };
      this.dynamicTpMultiplier = tpTable[regime91] || TRADING_CONFIG.tpAtrMult || 4.0;
      this._dynamicSlMult      = slTable[regime91] || TRADING_CONFIG.slAtrMult || 1.5;
    }
    if (this.abTester && this.abTester._warmupBarsRemaining > 0) {
        this.abTester._warmupBarsRemaining--;
        this.log(`⏳ [Fix #11] ${this.abTester._warmupReason} (${this.abTester._warmupBarsRemaining} bars left)`);
        return;
      }

      // ── Feature #17: Per-pair daily loss limit ────────────────────────
      if (this.perPairLoss) {
        const ppCheck = this.perPairLoss.canEnter(this.selectedAsset, this.capital);
        if (!ppCheck.allowed) { this.log('🚫 [PAIR LOSS] ' + ppCheck.reason); return; }
      }
      // ── Feature #6: Session drawdown halt ─────────────────────────────
      if (this.sessionDrawdown) {
        const sdCheck = this.sessionDrawdown.canEnter();
        if (!sdCheck.allowed) { this.log('🛑 [SESSION DD] ' + sdCheck.reason); return; }
      }

      // Economic calendar blackout (#2)
      if (this.economicCalendar) {
        const calCheck = this.economicCalendar.check(this.selectedAsset);
        if (calCheck.blocked) { this.log('📅 [CALENDAR] ' + calCheck.reason); return; }
      }

      // Currency exposure check (#12)
      if (this.currencyExposure) {
        const posSize = this.capital * (require('./trading-config').TRADING_CONFIG.positionSize || 0.02);
        const expCheck = this.currencyExposure.canAdd(this.selectedAsset, 'LONG', posSize, this.capital);
        if (!expCheck.allowed) { this.log('💱 [EXPOSURE] ' + expCheck.reason); return; }
      }

      if (Object.keys(priceHistories).length > 1) {
        // Feature #23: Only rebuild matrix if stale (> 30 min) or missing
        const CORR_TTL_MS = (TRADING_CONFIG.correlationTTLMins || 30) * 60_000;
        const corrAge = this._corrMatrixBuiltAt ? Date.now() - this._corrMatrixBuiltAt : Infinity;
        if (corrAge > CORR_TTL_MS || !this.correlationMatrix || Object.keys(this.correlationMatrix).length === 0) {
          this.correlationMatrix    = CorrelationEngine.buildMatrix(priceHistories, TRADING_CONFIG.correlationPeriod);
          this._corrMatrixBuiltAt   = Date.now();
          if (corrAge > CORR_TTL_MS) this.log('[Corr] Matrix rebuilt after ' + (corrAge/60000).toFixed(1) + 'min (TTL=' + (CORR_TTL_MS/60000) + 'min)');
        }
      }

      // ── HTF alignment gate (#16) ────────────────────────────────────
      // If signal opposes H1 trend, require higher confidence
      let adjustedConf = confidence;
      const htfBoost = this._lastHTFBoost || 0;
      if (htfBoost > 0 && confidence < (60 + htfBoost)) {
        this.log('[HTF GATE] BUY opposes H1 bias — need ' + (60+htfBoost) + '%, have ' + confidence + '%');
        return;
      }
      // Gradual late-session reduction: scale confidence so Kelly produces smaller size
    // Using Math.max(50,...) was a binary floor — replace with proportional scaling
    const lateMult = this._lateSessionSizeMult || 1.0;
    const decayMult = this._decayMultiplier || 1.0;
    const lateMultAdjustedConf = lateMult < 1.0
      ? Math.round(adjustedConf * lateMult)   // proportional — Kelly sizes down smoothly
      : adjustedConf;
      await this.enterPosition(currentPrice, lateMultAdjustedConf, corrMultiplier * decayMult);
      if (TRADING_CONFIG.maxDailyTrades) this._dailyTradeCount = (this._dailyTradeCount || 0) + 1;  // Bug #11 fix

    } else if (action === 'SELL') {
      if (this.position && this.position.side !== 'SHORT') {
        await this.exitPosition(currentPrice, 'AI Decision — Exit Long');
      } else if (!this.position) {
        // Session gate: avoid opening short in thin Asian market (mirrors BUY-path gate)
        if (this._isGoodSession && !this._isGoodSession()) {
          this.log('🌙 BLOCKED — Asian session (thin liquidity, wide spreads)'); return;
        }
        // Open a short position
        // ── Per-strategy drawdown (#14) ────────────────────────────────
        const stratUsed = this.strategyManager?.lastUsed || 'ensemble';
        if (this._stratPeakCapital) {
          if (!this._stratPeakCapital[stratUsed]) this._stratPeakCapital[stratUsed] = this.capital;
          if (this.capital > this._stratPeakCapital[stratUsed]) this._stratPeakCapital[stratUsed] = this.capital;
          const stratDD = (this._stratPeakCapital[stratUsed] - this.capital) / this._stratPeakCapital[stratUsed];
          const maxStratDD = TRADING_CONFIG.maxStrategyDrawdown || 0.08;
          if (stratDD > maxStratDD) {
            this.log('[STRAT DD] ' + stratUsed + ' drawdown ' + (stratDD*100).toFixed(1) + '% — halting strategy');
            return;
          }
        }

        const newsCheck2 = this.newsFilter.checkEntry(this.selectedAsset);
        if (newsCheck2.blocked) { this.log('📰 ' + newsCheck2.reason); return; }

        // ── Feature #17: Per-pair daily loss limit (SHORT) ────────────────
        if (this.perPairLoss) {
          const ppCheckS = this.perPairLoss.canEnter(this.selectedAsset, this.capital);
          if (!ppCheckS.allowed) { this.log('🚫 [PAIR LOSS SHORT] ' + ppCheckS.reason); return; }
        }
        // ── Feature #6: Session drawdown halt (SHORT) ─────────────────────
        if (this.sessionDrawdown) {
          const sdCheckS = this.sessionDrawdown.canEnter();
          if (!sdCheckS.allowed) { this.log('🛑 [SESSION DD SHORT] ' + sdCheckS.reason); return; }
        }

        // Economic calendar check for SHORT entries too (#4 fix)
        if (this.economicCalendar) {
          const calCheckS = this.economicCalendar.check(this.selectedAsset);
          if (calCheckS.blocked) { this.log('📅 [CALENDAR SHORT] ' + calCheckS.reason); return; }
        }
        // v12 3.1: Risk parity allocation for multi-asset mode
    if (this.riskParity && this.marketData?.priceHistories && TRADING_CONFIG.useRiskParity) {
      const rpResult = this.riskParity.allocate(this.marketData.priceHistories, this.capital);
      const rpWeight = rpResult.weights[this.selectedAsset];
      if (rpWeight && rpWeight < 0.5) {
        corrMultiplier = (corrMultiplier || 1) * rpWeight * 2;  // normalise to [0,1]
        this.log(`[RiskParity] ${this.selectedAsset} weight ${(rpWeight*100).toFixed(1)}% → size adjusted`);
      }
    }
    // A7: Full correlation matrix check for SHORT — was only checking last-closed pair
        let shortCorrMult = 1;
        if (this.correlationMatrix && Object.keys(this.correlationMatrix).length > 0) {
          const matCheck = CorrelationEngine.check(
            this.selectedAsset, this.lastClosedAsset || null,
            this.marketData?.priceHistories || {}, this.correlationMatrix
          );
          if (matCheck.blocked) { this.log('🚫 [A7] CORR BLOCK (short): ' + matCheck.reason); return; }
          if (matCheck.label === 'WARN') shortCorrMult = matCheck.sizeMultiplier;
        } else {
          // Fallback to single-pair check when matrix not yet built
          const lastClosedA = this.lastClosedAsset || null;
          if (lastClosedA && lastClosedA !== this.selectedAsset) {
            const cCheck = CorrelationEngine.check(this.selectedAsset, lastClosedA, this.marketData?.priceHistories || {});
            if (cCheck.blocked) { this.log('🚫 CORRELATION BLOCK (short): ' + cCheck.reason); return; }
            if (cCheck.label === 'WARN') shortCorrMult = cCheck.sizeMultiplier;
          }
        }
        // Clear lastClosedAsset if stale (>30 min)
        if (this._lastClosedAt && Date.now() - this._lastClosedAt > 30*60_000) this.lastClosedAsset = null;
        // Currency exposure check for SHORT path (#8 fix — was completely missing)
        if (this.currencyExposure) {
          const posSizeS = this.capital * (require('./trading-config').TRADING_CONFIG.positionSize || 0.02);
          const expCheckS = this.currencyExposure.canAdd(this.selectedAsset, 'SHORT', posSizeS, this.capital);
          if (!expCheckS.allowed) { this.log('💱 [EXPOSURE SHORT] ' + expCheckS.reason); return; }
        }
        await this.enterShort(currentPrice, confidence, shortCorrMult);
        if (TRADING_CONFIG.maxDailyTrades) this._dailyTradeCount = (this._dailyTradeCount || 0) + 1;  // Bug #11 fix
      }
    }
  },
};

module.exports = {
  ...engineMethods,
  engineMethods,    // also accessible as a group
  KellyCriterion,   // re-export for single-import convenience
  CorrelationEngine,
};
