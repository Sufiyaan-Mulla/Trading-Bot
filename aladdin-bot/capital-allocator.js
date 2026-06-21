'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  capital-allocator.js
//  Dynamic Capital Allocation Engine
//
//  What it does
//  ────────────
//  Splits total trading capital across multiple named strategy slots. Each slot
//  runs independently — it can hold a position, accumulate trades, and have its
//  own performance history. Capital is dynamically redistributed between slots
//  based on recent performance (profit factor, win rate, Sharpe).
//
//  Key features
//  ────────────
//  • Per-strategy capital slices — each strategy can only risk its own slice
//  • Portfolio exposure cap — total open risk never exceeds maxExposurePct
//  • Performance-weighted rebalancing — outperforming strategies get more capital
//  • Momentum smoothing — new weights blend 70% old / 30% performance target
//  • Hard weight floors and ceilings — no strategy starved or over-concentrated
//  • Rebalancing triggered by: N trades completed OR performance gap widens
//
//  Strategies tracked (default)
//  ────────────────────────────
//  trend          EMA50/200 trend follower
//  meanReversion  RSI/BB mean reversion
//  ensemble       Ensemble voting result (champion of A/B tester)
//
//  Usage
//  ─────
//  const alloc = new CapitalAllocator({ totalCapital: 10000 });
//  const { allowed, maxSize } = alloc.canEnter('trend', confidence);
//  if (allowed) { ... enter position with maxSize ... }
//  alloc.openPosition('trend', { entry, shares, cost, stopLoss, takeProfit });
//  alloc.closePosition('trend', profit);
//  alloc.rebalanceIfDue();   // call each bar
// ═══════════════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');

// ── Configuration ─────────────────────────────────────────────────────────────
const ALLOC_CONFIG = {
  // Initial equal-weight distribution across strategies
  initialWeights: {
    trend:         1 / 3,
    meanReversion: 1 / 3,
    ensemble:      1 / 3,
  },

  // Hard floor — no strategy can drop below this weight (prevents starvation)
  minWeight: 0.10,   // 10%

  // Hard ceiling — no strategy can exceed this weight (prevents over-concentration)
  maxWeight: 0.60,   // 60%

  // Maximum total portfolio exposure as fraction of capital.
  // If sum of all open positions >= this, no new entries are allowed.
  maxExposurePct: 0.35,   // Item #110: Reduced from 80% to 35% (safer for correlated FX)

  // Minimum trades a slot must have before its performance affects rebalancing.
  // Before this, the slot keeps its initial weight.
  minTradesForRebalancing: 10,

  // Rebalance after this many total trades (across all slots)
  rebalanceEveryNTrades: 5,

  // Momentum smoothing: new_weight = old × (1 - blend) + target × blend
  // 0.3 = slow adaptation. 1.0 = instant switch.
  rebalanceBlend: 0.30,

  // Minimum performance gap (composite score) to trigger an early rebalance
  // before rebalanceEveryNTrades. Prevents thrashing on small differences.
  earlyRebalanceGap: 0.25,

  // Log directory for rebalancing events
  logDir: path.join(__dirname, 'trade_logs'),
};

// ── StrategySlot ──────────────────────────────────────────────────────────────
class StrategySlot {
  constructor (id, weight, totalCapital) {
    this.id             = id;
    this.targetWeight   = weight;
    this.currentWeight  = weight;
    this.capital        = totalCapital * weight;   // allocated capital
    this.position       = null;                    // open position if any — hasPosition getter derives from this
    this.trades         = [];                      // closed trade history
    this.totalPnL       = 0;
    this.tradeCount     = 0;
  }

  // ── Metrics ────────────────────────────────────────────────────────────────
  metrics (window = 20) {
    const recent = this.trades.slice(-window);
    const n      = recent.length;
    if (n === 0) return { trades: 0, winRate: 0, profitFactor: 0, expectancy: 0, sharpe: 0 };

    const wins   = recent.filter(t => t.profit > 0);
    const losses = recent.filter(t => t.profit <= 0);
    const gp     = wins.reduce((s, t)   => s + t.profit, 0);
    const gl     = Math.abs(losses.reduce((s, t) => s + t.profit, 0));
    const pfRaw  = gl > 0 ? gp / gl : (gp > 0 ? 9.99 : 0);
    const pf     = Math.min(5.0, pfRaw);  // cap at 5.0 — Infinity on all-wins
    const wr     = wins.length / n * 100;
    const exp    = recent.reduce((s, t) => s + t.profit, 0) / n;

    // Trade-level Sharpe
    let sharpe = 0;
    if (n > 2) {
      const std = Math.sqrt(recent.reduce((s, t) => s + (t.profit - exp) ** 2, 0) / n);
      sharpe    = std > 0 ? (exp / std) * Math.sqrt(n) : 0;
    }

    return {
      trades:       n,
      winRate:      parseFloat(wr.toFixed(2)),
      profitFactor: parseFloat(pf.toFixed(4)),
      expectancy:   parseFloat(exp.toFixed(4)),
      sharpe:       parseFloat(sharpe.toFixed(4)),
    };
  }

  // Composite performance score used for weight allocation
  // PF 40% + WR 30% + Sharpe 30%  (all normalised to similar scales)
  compositeScore () {
    const m = this.metrics();
    if (m.trades === 0) return 0;
    const pfNorm     = Math.min(m.profitFactor, 5) / 5;         // 0-1
    const wrNorm     = m.winRate / 100;                          // 0-1
    const sharpeNorm = Math.max(0, Math.min(m.sharpe, 5)) / 5;  // 0-1
    return pfNorm * 0.40 + wrNorm * 0.30 + sharpeNorm * 0.30;
  }

  get hasPosition () { return this.position !== null; }
}

// ── CapitalAllocator ──────────────────────────────────────────────────────────
class CapitalAllocator {
  constructor (opts = {}) {
    this.cfg           = { ...ALLOC_CONFIG, ...opts };
    this.totalCapital  = (opts.totalCapital != null && opts.totalCapital > 0) ? opts.totalCapital : 10_000;
    this.slots         = new Map();
    this.tradesSinceRebalance = 0;
    this.rebalanceLog  = [];
    this.barCount      = 0;

    // Initialise slots from config weights
    const weights = this.cfg.initialWeights;
    for (const [id, w] of Object.entries(weights)) {
      this.slots.set(id, new StrategySlot(id, w, this.totalCapital));
    }
  }

  // ── Capital query ──────────────────────────────────────────────────────────

  // Check if a strategy is allowed to open a new position.
  // Returns { allowed, maxSize, reason }
  canEnter (strategyId, confidence = 60, liveCapital = null) {
    const slot = this.slots.get(strategyId);
    if (!slot) return { allowed: false, maxSize: 0, reason: 'Unknown strategy: ' + strategyId };
    if (slot.hasPosition) return { allowed: false, maxSize: 0, reason: 'Position already open' };
    if (slot.capital <= 0) return { allowed: false, maxSize: 0, reason: 'No capital in slot' };

    // Sync total capital from engine if provided (prevents stale slot sizing)
    if (liveCapital != null && liveCapital > 0) {
      this.totalCapital = liveCapital;
    }

    // Bug fix: totalCapital=0 made exposure ratio NaN (0/0), passing the cap check
    // and allowing trades with no actual capital behind them.
    if (!this.totalCapital || this.totalCapital <= 0) {
      return { allowed: false, maxSize: 0, reason: 'Total capital is zero or unset' };
    }

    // Bug fix: NaN confidence (e.g. from a failed ML model call) produced NaN maxSize
    // which then propagated into position sizing, creating an order of size NaN.
    const safeConf = (typeof confidence === 'number' && isFinite(confidence))
      ? Math.max(0, Math.min(100, confidence)) : 60;

    // Check portfolio-level exposure cap
    const totalExposure = this._totalExposure();
    // Item 110: Hard ceiling at 50% regardless of config
    const _hardCeiling110 = Math.min(this.cfg.maxExposurePct, 0.50);
    if (totalExposure >= this.totalCapital * _hardCeiling110) {
      return {
        allowed:  false,
        maxSize:  0,
        reason:   `Portfolio exposure cap reached (${(totalExposure / this.totalCapital * 100).toFixed(1)}% of capital)`,
      };
    }

    // Max size for this slot = slot capital × Kelly-like confidence scaling
    // conf 60 → 50% of slot, conf 100 → 100% of slot
    const confScale  = Math.max(0.50, Math.min(1.0, (safeConf - 40) / 60));
    const maxSize    = slot.capital * confScale;
    const remaining  = this.totalCapital * this.cfg.maxExposurePct - totalExposure;

    return {
      allowed:     true,
      maxSize:     Math.min(maxSize, remaining, slot.capital),
      slotCapital: parseFloat(slot.capital.toFixed(2)),
      slotWeight:  parseFloat(slot.currentWeight.toFixed(4)),
      confScale:   parseFloat(confScale.toFixed(3)),
      reason:      'OK',
    };
  }

  // ── Position lifecycle ─────────────────────────────────────────────────────

  // Record that a strategy opened a position
  openPosition (strategyId, positionData) {
    const slot = this.slots.get(strategyId);
    if (!slot) throw new Error('Unknown strategy: ' + strategyId);
    slot.position    = { ...positionData, openedAt: Date.now() };
    // hasPosition getter returns true automatically when slot.position !== null
  }

  // Record that a strategy closed a position
  closePosition (strategyId, profit) {
    const slot = this.slots.get(strategyId);
    if (!slot) throw new Error('Unknown strategy: ' + strategyId);
    if (!slot.position) return;

    slot.capital     += profit;       // update slot capital with trade result
    slot.totalPnL    += profit;
    slot.tradeCount++;
    slot.position    = null;
    // hasPosition getter returns false automatically when slot.position === null

    const trade = { profit, win: profit > 0, ts: Date.now() };
    slot.trades.push(trade);
    if (slot.trades.length > 100) slot.trades.shift();

    // Also update total capital (sum of all slots)
    this.totalCapital = this._sumSlotCapitals();

    this.tradesSinceRebalance++;
    this.rebalanceIfDue();

    return trade;
  }

  // ── Rebalancing ────────────────────────────────────────────────────────────

  // Call every bar — triggers rebalancing when conditions are met
  tick () {
    this.barCount++;
    this.rebalanceIfDue();
  }

  rebalanceIfDue () {
    const eligibleSlots = [...this.slots.values()]
      .filter(s => s.trades.length >= this.cfg.minTradesForRebalancing);

    if (eligibleSlots.length === 0) return;

    // Trigger by trade count
    if (this.tradesSinceRebalance >= this.cfg.rebalanceEveryNTrades) {
      this._rebalance('trade_count');
      return;
    }

    // Early trigger by performance gap
    if (eligibleSlots.length >= 2) {
      const scores  = eligibleSlots.map(s => s.compositeScore());
      const gap     = Math.max(...scores) - Math.min(...scores);
      if (gap >= this.cfg.earlyRebalanceGap) {
        this._rebalance('performance_gap');
      }
    }
  }

  _rebalance (trigger) {
    this.tradesSinceRebalance = 0;

    const slotArr   = [...this.slots.values()];
    const eligible  = slotArr.filter(s => s.trades.length >= this.cfg.minTradesForRebalancing);
    const ineligible = slotArr.filter(s => s.trades.length < this.cfg.minTradesForRebalancing);

    // If not enough eligible slots, skip
    if (eligible.length === 0) return;

    // Compute performance-based target weights for eligible slots
    const scores = eligible.map(s => ({ slot: s, score: s.compositeScore() }));
    const totalScore = scores.reduce((s, x) => s + x.score, 0);

    const newWeights = {};

    if (totalScore === 0) {
      // All scores are 0 — equal weight among eligible
      for (const { slot } of scores) {
        newWeights[slot.id] = 1 / slotArr.length;
      }
    } else {
      for (const { slot, score } of scores) {
        newWeights[slot.id] = (score / totalScore) * (eligible.length / slotArr.length);
      }
    }

    // Ineligible slots keep their current weight
    for (const slot of ineligible) {
      newWeights[slot.id] = slot.currentWeight;
    }

    // Apply min/max constraints and normalise
    for (const id of Object.keys(newWeights)) {
      newWeights[id] = Math.max(this.cfg.minWeight, Math.min(this.cfg.maxWeight, newWeights[id]));
    }
    const total = Object.values(newWeights).reduce((s, w) => s + w, 0);
    for (const id of Object.keys(newWeights)) newWeights[id] /= total;

    // Momentum smoothing: blend old weight with target weight
    const oldWeights = {};
    for (const slot of slotArr) oldWeights[slot.id] = slot.currentWeight;

    const event = { trigger, bar: this.barCount, ts: new Date().toISOString(), changes: [] };

    for (const slot of slotArr) {
      const target   = newWeights[slot.id] ?? slot.currentWeight;
      const blended  = slot.currentWeight * (1 - this.cfg.rebalanceBlend) + target * this.cfg.rebalanceBlend;
      const oldW     = slot.currentWeight;

      slot.currentWeight  = parseFloat(blended.toFixed(6));
      slot.targetWeight   = parseFloat(target.toFixed(6));
      slot.capital        = this.totalCapital * slot.currentWeight;

      event.changes.push({
        id:        slot.id,
        oldWeight: parseFloat(oldW.toFixed(4)),
        newWeight: parseFloat(blended.toFixed(4)),
        score:     parseFloat((slot.compositeScore()).toFixed(4)),
        capital:   parseFloat(slot.capital.toFixed(2)),
      });
    }

    this.rebalanceLog.push(event);
    if (this.rebalanceLog.length > 50) this.rebalanceLog.shift();

    console.log(`[CapitalAllocator] Rebalanced (${trigger}) at bar ${this.barCount}:`);
    for (const c of event.changes) {
      const dir = c.newWeight > c.oldWeight ? '▲' : c.newWeight < c.oldWeight ? '▼' : '─';
      console.log(`  ${dir} ${c.id.padEnd(16)} ${(c.oldWeight * 100).toFixed(1)}% → ${(c.newWeight * 100).toFixed(1)}%  score=${c.score.toFixed(3)}  capital=$${c.capital.toFixed(0)}`);
    }

    this._saveRebalanceLog();
  }

  // ── Portfolio analytics ────────────────────────────────────────────────────

  // Total capital currently locked in open positions
  _totalExposure () {
    let exposure = 0;
    for (const slot of this.slots.values()) {
      if (slot.position) exposure += slot.position.cost || 0;
    }
    return exposure;
  }

  // Sum of all slot capitals (used to update totalCapital after trades)
  _sumSlotCapitals () {
    return [...this.slots.values()].reduce((s, slot) => s + slot.capital, 0);
  }

  // Add a new strategy slot at runtime
  addSlot (id, initialWeight) {
    if (this.slots.has(id)) throw new Error('Slot already exists: ' + id);
    const slot = new StrategySlot(id, initialWeight, this.totalCapital);
    this.slots.set(id, slot);
    // Renormalise existing weights to accommodate new slot
    this._renormalise();
    return slot;
  }

  _renormalise () {
    const total = [...this.slots.values()].reduce((s, sl) => s + sl.currentWeight, 0);
    for (const slot of this.slots.values()) {
      slot.currentWeight /= total;
      slot.capital = this.totalCapital * slot.currentWeight;
    }
  }

  // ── Status and reporting ───────────────────────────────────────────────────

  status () {
    const slots = [];
    for (const slot of this.slots.values()) {
      slots.push({
        id:            slot.id,
        currentWeight: parseFloat(slot.currentWeight.toFixed(4)),
        targetWeight:  parseFloat(slot.targetWeight.toFixed(4)),
        capital:       parseFloat(slot.capital.toFixed(2)),
        hasPosition:   slot.hasPosition,
        tradeCount:    slot.tradeCount,
        totalPnL:      parseFloat(slot.totalPnL.toFixed(2)),
        metrics:       slot.metrics(),
      });
    }

    const exposure = this._totalExposure();
    return {
      totalCapital:      parseFloat(this.totalCapital.toFixed(2)),
      totalExposure:     parseFloat(exposure.toFixed(2)),
      exposurePct:       parseFloat((exposure / this.totalCapital * 100).toFixed(1)),
      maxExposurePct:    this.cfg.maxExposurePct * 100,
      slots,
      rebalanceLog:      this.rebalanceLog.slice(-5),
      tradesSinceRebalance: this.tradesSinceRebalance,
      barCount:          this.barCount,
    };
  }

  printStatus () {
    const s    = this.status();
    const line = '-'.repeat(72);
    console.log('\n' + '='.repeat(72));
    console.log('  CAPITAL ALLOCATOR -- PORTFOLIO SNAPSHOT');
    console.log('  Total: $' + s.totalCapital.toFixed(2) +
      '  |  Exposure: $' + s.totalExposure.toFixed(2) + ' (' + s.exposurePct + '%)' +
      '  |  Max: ' + s.maxExposurePct + '%');
    console.log('='.repeat(72));
    console.log('  ' + 'Strategy'.padEnd(16) + 'Weight'.padStart(8) + 'Capital'.padStart(10) +
      'Trades'.padStart(8) + 'WR%'.padStart(7) + 'PF'.padStart(7) + 'P&L'.padStart(10) + '  Pos');
    console.log('  ' + line);
    for (const sl of s.slots) {
      const m   = sl.metrics;
      const pos = sl.hasPosition ? 'OPEN' : '----';
      console.log(
        '  ' + sl.id.padEnd(16) +
        (sl.currentWeight * 100).toFixed(1).padStart(7) + '%' +
        ('$' + sl.capital.toFixed(0)).padStart(10) +
        String(sl.tradeCount).padStart(8) +
        m.winRate.toFixed(1).padStart(7) +
        m.profitFactor.toFixed(3).padStart(7) +
        ('$' + sl.totalPnL.toFixed(2)).padStart(10) +
        '  ' + pos
      );
    }
    console.log('  ' + line);
    if (s.rebalanceLog.length > 0) {
      const last = s.rebalanceLog.at(-1);
      console.log('  Last rebalance: bar ' + last.bar + ' (' + last.trigger + ')');
    }
    console.log('='.repeat(72) + '\n');
  }

  _saveRebalanceLog () {
    try {
      if (!fs.existsSync(this.cfg.logDir)) fs.mkdirSync(this.cfg.logDir, { recursive: true });
      fs.writeFileSync(
        path.join(this.cfg.logDir, 'capital-allocation.json'),
        JSON.stringify(this.rebalanceLog, null, 2)
      );
    } catch { /* non-fatal */ }
  }
}

// Item #51: Canary release — apply new params to 10% of capital for 24h before full promotion
class CanaryRelease {
  constructor(opts = {}) {
    this._canaryPct     = opts.canaryPct     || 0.10;  // 10% of capital
    this._canaryHours   = opts.canaryHours   || 24;
    this._stagedParams  = null;
    this._stagedAt      = null;
    this._results       = { trades: 0, profit: 0, wins: 0 };
  }

  stageParams(params) {
    this._stagedParams = params;
    this._stagedAt     = Date.now();
    this._results      = { trades: 0, profit: 0, wins: 0 };
    console.log(`[Canary #51] New params staged: ${JSON.stringify(params)} — canary period: ${this._canaryHours}h`);
  }

  isActive() {
    if (!this._stagedParams || !this._stagedAt) return false;
    return (Date.now() - this._stagedAt) < this._canaryHours * 3_600_000;
  }

  canaryCapitalMultiplier() { return this.isActive() ? this._canaryPct : 1.0; }

  recordCanaryTrade(profit) {
    if (!this.isActive()) return;
    this._results.trades++;
    this._results.profit += profit;
    if (profit > 0) this._results.wins++;
  }

  promote() {
    // Auto-promote if canary period expires with positive results
    if (!this._stagedParams) return false;
    const elapsedH = (Date.now() - this._stagedAt) / 3_600_000;
    if (elapsedH < this._canaryHours) return false;
    const wr = this._results.trades > 0 ? this._results.wins/this._results.trades : 0;
    if (this._results.trades >= 3 && wr >= 0.5 && this._results.profit > 0) {
      console.log(`[Canary #51] ✅ Promoting staged params (WR=${(wr*100).toFixed(0)}% over ${this._results.trades} trades)`);
      const { TRADING_CONFIG } = require('./trading-config');
      Object.assign(TRADING_CONFIG, this._stagedParams);
      this._stagedParams = null;
      return true;
    }
    console.log(`[Canary #51] ❌ Rejecting staged params (WR=${(wr*100).toFixed(0)}% insufficient)`);
    this._stagedParams = null;
    return false;
  }
}

module.exports.CanaryRelease = CanaryRelease;
module.exports = { CapitalAllocator, CanaryRelease, StrategySlot, ALLOC_CONFIG };
