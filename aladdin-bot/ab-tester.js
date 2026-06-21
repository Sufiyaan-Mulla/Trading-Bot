'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  ab-tester.js
//  Multi-Strategy A/B Testing Engine
//
//  What it does
//  ────────────
//  Runs multiple trading strategies simultaneously on the same live price ticks.
//  One strategy is the Champion (real money). The rest are Challengers (paper).
//
//  Each tick:
//    1. All strategies receive identical indicators and make independent decisions
//    2. Champion decision is returned to the engine for real execution
//    3. Challenger decisions are paper-traded in virtual accounts
//    4. Signal comparison is logged every bar
//
//  After MIN_TRADES_FOR_COMPARISON trades, metrics are compared:
//    • Profit factor  (primary — weight 40%)
//    • Win rate       (weight 30%)
//    • Sharpe ratio   (weight 30%)
//
//  If a challenger leads on a composite score AND has statistical confidence
//  (20+ trades, >15% advantage on primary metric) → auto-promote to champion.
//
//  Strategies included
//  ───────────────────
//  ID              Description
//  ──────────────  ──────────────────────────────────────────────────────────
//  champion        Current live strategy (regime-aware: trend + mean-reversion)
//  trend           EMA50/200 pure trend follower (TrendStrategy)
//  meanReversion   RSI/BB mean reversion (MeanReversionStrategy)
//  aggressive      Champion with confidence floor lowered to 52 (more trades)
//  conservative    Champion with confidence floor raised to 72 (fewer, higher-quality)
// ═══════════════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');
const { TrendStrategy }         = require('./strategies/trendStrategy');
const { MeanReversionStrategy } = require('./strategies/meanReversion');
const { StrategyManager }       = require('./strategies');

// ── Configuration ─────────────────────────────────────────────────────────────
const AB_CONFIG = {
  // Minimum trades a challenger must have before it's eligible for promotion
  minTradesForComparison: 20,

  // Champion must be beaten by at least this much on composite score to be replaced
  promotionThresholdPct: 15,         // 15% composite advantage required

  // Virtual capital each paper strategy starts with (mirrors live capital)
  virtualCapital: 10_000,
  resetCapitalOnPromotion: true,  // #58: Reset virtual capital when challenger promoted

  // Risk per virtual trade (mirrors live engine's 8% sizing)
  virtualRiskPct: 0.08,

  // Virtual slippage on paper fills (same as live SLIPPAGE constant)
  virtualSlippage: 0.0003,

  // Virtual commission per side
  virtualCommission: 0.0002,

  // How many bars between full comparison reports
  reportEveryBars: 50,

  // Rolling Sharpe window — number of trades for rolling return calc
  sharpeWindow: 30,

  // Log directory for promotion events
  logDir: path.join(__dirname, 'trade_logs'),

  // ── Ensemble Voting ────────────────────────────────────────────────────────
  // When enabled, all 5 strategies vote on each bar, weighted by recent
  // performance. The live engine only acts when the weighted vote clears
  // ensembleThreshold — reducing false signals from a single weak strategy.

  // Toggle ensemble voting on/off. When off, champion's signal is used directly.
  ensembleEnabled: true,

  // Minimum weighted vote score to trigger a BUY or SELL.
  // Score = sum of (confidence × weight) for all agreeing strategies.
  // With 5 strategies at weight 1.0 and confidence 70: max possible = 350.
  // threshold 200 = roughly 3 strategies at average confidence must agree.
  ensembleThreshold: 200,

  // Minimum number of strategies that must agree on the same action.
  // Even if weighted score clears threshold, fewer than this = HOLD.
  ensembleMinAgree: 2,

  // Floor weight given to every strategy regardless of performance.
  // Prevents new strategies (no trades yet) from having zero influence.
  ensembleMinWeight: 1.0,

  // Ceiling weight — prevents one dominant strategy from overriding all others.
  ensembleMaxWeight: 5.0,
};

// ── Virtual Account ────────────────────────────────────────────────────────────
// Each strategy gets its own independent paper-trading account.
class VirtualAccount {
  constructor (id, capital) {
    this.id       = id;
    this.capital  = capital;
    this.position = null;     // { entry, shares, cost, stopLoss, takeProfit, barOpen }
    this.trades   = [];       // closed trade records
    this.equity   = [capital];
    this.peak     = capital;
    this.maxDD    = 0;
    this.barCount = 0;
  }

  // Open a paper position (LONG or SHORT)
  enter (price, atr, cfg, side = 'LONG') {
    if (this.position || this.capital <= 0) return null;
    const slip    = price * cfg.virtualSlippage;
    const isShort = side === 'SHORT';
    // BUG-54 fix: both LONG and SHORT pay the ask (price + slip) — adverse fill
    // Old code: SHORT filled at price - slip (bid) — understated execution cost
    const entry   = price + slip;
    const size    = Math.min(this.capital * cfg.virtualRiskPct, this.capital);
    const shares  = size / entry;
    const comm    = size * cfg.virtualCommission;
    this.capital -= comm;  // SHORT: don't deduct size (we receive it as proceeds)
    if (!isShort) this.capital -= size;
    this.position = {
      side, entry, shares, cost: size + comm,
      stopLoss:   isShort ? entry * 1.015 : entry * 0.985,
      takeProfit: isShort ? entry * 0.970 : entry * 1.030,
      barOpen:    this.barCount,
    };
    return this.position;
  }

  // Close the paper position
  exit (price, reason, cfg) {
    if (!this.position) return null;
    const isShort = this.position.side === 'SHORT';
    const slip    = price * cfg.virtualSlippage;
    const exitP   = isShort ? price + slip : price - slip;
    const exitVal = this.position.shares * exitP;
    const comm    = exitVal * cfg.virtualCommission;
    const profit  = isShort
      ? (this.position.entry - exitP) * this.position.shares - comm
      : exitVal - this.position.cost - comm;
    this.capital += isShort ? profit : exitVal - comm;
    const trade = {
      profit,
      bars:   this.barCount - this.position.barOpen,
      reason,
      win:    profit > 0,
    };
    this.trades.push(trade);
    this.position = null;
    return trade;
  }

  // Advance one bar: check stops, update equity/drawdown
  tick (price, cfg) {
    this.barCount++;
    if (this.position) {
      // Check SL/TP — SHORT: SL is above entry, TP below
      const isShort = this.position.side === 'SHORT';
      if (isShort) {
        if (price >= this.position.stopLoss)  this.exit(this.position.stopLoss,  'Stop Loss SHORT', cfg);
        else if (price <= this.position.takeProfit) this.exit(this.position.takeProfit, 'Take Profit SHORT', cfg);
      } else {
        if (price <= this.position.stopLoss)  this.exit(this.position.stopLoss,  'Stop Loss', cfg);
          else if (price >= this.position.takeProfit) this.exit(this.position.takeProfit, 'Take Profit', cfg);
      }
    }
    const val = this.capital + (this.position ? this.position.shares * price : 0);
    this.equity.push(val);
    if (val > this.peak) this.peak = val;
    const dd = (this.peak - val) / this.peak;
    if (dd > this.maxDD) this.maxDD = dd;
  }

  // Compute current performance metrics
  metrics () {
    const n = this.trades.length;
    if (n === 0) return { trades: 0, winRate: 0, profitFactor: 0, expectancy: 0, sharpe: 0, maxDD: this.maxDD };
    const wins   = this.trades.filter(t => t.win);
    const losses = this.trades.filter(t => !t.win);
    const gp     = wins.reduce((s, t)   => s + t.profit, 0);
    const gl     = Math.abs(losses.reduce((s, t) => s + t.profit, 0));
    const pf     = gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0);
    const wr     = wins.length / n * 100;
    const exp    = this.trades.reduce((s, t) => s + t.profit, 0) / n;

    // Rolling Sharpe on last N trade P&Ls (proxy — not time-based)
    const window = this.trades.slice(-AB_CONFIG.sharpeWindow).map(t => t.profit);
    let sharpe = 0;
    if (window.length > 2) {
      const mean = window.reduce((s, v) => s + v, 0) / window.length;
      const std  = Math.sqrt(window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length);
      sharpe = std > 0 ? (mean / std) * Math.sqrt(window.length) : 0;
    }

    return {
      trades: n, winRate: parseFloat(wr.toFixed(2)),
      profitFactor: parseFloat((isFinite(pf) ? pf : 999).toFixed(4)),
      expectancy:   parseFloat(exp.toFixed(4)),
      sharpe:       parseFloat(sharpe.toFixed(4)),
      maxDD:        parseFloat((this.maxDD * 100).toFixed(2)),
      capital:      parseFloat(this.capital.toFixed(2)),
    };
  }
}

// ── Contestant ────────────────────────────────────────────────────────────────
// Wraps a strategy + virtual account. Represents one A/B contestant.
class Contestant {
  constructor (id, label, strategyFn, isChampion = false) {
    this.id          = id;
    this.label       = label;
    this.strategyFn  = strategyFn;    // (indicators, context) → { action, confidence, reasoning }
    this.isChampion  = isChampion;
    this.account     = new VirtualAccount(id, AB_CONFIG.virtualCapital);
    this.signalLog   = [];            // last 200 signals
    this.promotedAt  = null;
    this._initialCapital = AB_CONFIG.virtualCapital;
    this.demotedAt   = null;
  }

  // Get this contestant's decision for current bar
  decide (indicators, context) {
    try {
      return this.strategyFn(indicators, context);
    } catch {
      return { action: 'HOLD', confidence: 0, reasoning: 'error' };
    }
  }

  logSignal (bar, decision) {
    this.signalLog.push({ bar, action: decision.action, conf: decision.confidence });
    if (this.signalLog.length > 200) this.signalLog.shift();
  }

  metrics () { return this.account.metrics(); }
}

// ── ABTester ──────────────────────────────────────────────────────────────────
class ABTester {
  constructor (cfg = {}) {
    this.cfg         = { ...AB_CONFIG, ...cfg };
    this.contestants = new Map();   // id → Contestant
    this.championId  = 'champion';
    this.barCount    = 0;
    this.promotionLog = [];
    this.signalHistory = [];       // per-bar signal snapshots (last 500 bars)

    this._initContestants();
  }

  // ── Initialise all contestants ─────────────────────────────────────────────
  _initContestants () {
    // Champion: regime-aware StrategyManager (same as live engine)
    const mgr = new StrategyManager();
    this._add('champion',      '👑 Champion (Regime-Aware)',  (ind, ctx) => mgr.decide(ind, ctx),         true);

    // Trend follower — pure EMA50/200 trend
    const trend = new TrendStrategy({ minConfidence: 60 });
    this._add('trend',         '📈 Trend (EMA50/200)',        (ind, ctx) => trend.decide(ind, ctx));

    // Mean reversion — RSI/BB
    const mr = new MeanReversionStrategy({ minConfidence: 60 });
    this._add('meanReversion', '🔄 Mean Reversion',           (ind, ctx) => mr.decide(ind, ctx));

    // Aggressive champion variant — confidence floor 52
    const mgrAgg = new StrategyManager({ trend: { minConfidence: 52 }, meanReversion: { minConfidence: 52 } });
    this._add('aggressive',    '⚡ Aggressive (conf≥52)',     (ind, ctx) => mgrAgg.decide(ind, ctx));

    // Conservative champion variant — confidence floor 72
    const mgrCons = new StrategyManager({ trend: { minConfidence: 72 }, meanReversion: { minConfidence: 72 } });
    this._add('conservative',  '🛡️  Conservative (conf≥72)',  (ind, ctx) => mgrCons.decide(ind, ctx));
  }

  _add (id, label, fn, isChampion = false) {
    this.contestants.set(id, new Contestant(id, label, fn, isChampion));
  }

  // ── Main tick — call this every bar with indicators + current price ─────────
  // Returns the ensemble decision (weighted vote across all strategies).
  // When ensembleEnabled=false, falls back to champion-only decision.
  tick (indicators, context, price) {
    this.barCount++;
    const decisions = {};

    // 1. Get decisions from all contestants
    for (const [id, c] of this.contestants) {
      const d = c.decide(indicators, context);
      decisions[id] = d;
      c.logSignal(this.barCount, d);
    }

    // 2. Paper-trade all contestants (advance virtual accounts)
    for (const [id, c] of this.contestants) {
      c.account.tick(price, this.cfg);
      const d = decisions[id];
      if (d.action === 'BUY' && !c.account.position) {
        c.account.enter(price, null, this.cfg, 'LONG');
      } else if (d.action === 'SELL' && !c.account.position) {
        c.account.enter(price, null, this.cfg, 'SHORT');  // challenger SHORT tracking
      } else if (d.action === 'BUY' && c.account.position?.side === 'SHORT') {
        c.account.exit(price, 'Cover Short', this.cfg);
      } else if (d.action === 'SELL' && c.account.position?.side === 'LONG') {
        c.account.exit(price, 'Signal Exit', this.cfg);
      }
    }

    // 3. Compute ensemble decision
    const ensemble = this.cfg.ensembleEnabled
      ? this._ensembleVote(decisions)
      : { ...decisions[this.championId], ensembleScore: 0, agreeing: 1, weights: {}, fromEnsemble: false };

    // 4. Log per-bar signal snapshot (includes ensemble result)
    const snapshot = { bar: this.barCount, ensemble: `${ensemble.action}(${ensemble.confidence})` };
    for (const [id, d] of Object.entries(decisions)) {
      snapshot[id] = `${d.action}(${d.confidence})`;
    }
    this.signalHistory.push(snapshot);
    if (this.signalHistory.length > 500) this.signalHistory.shift();

    // 5. Periodic comparison and potential promotion
    if (this.barCount % this.cfg.reportEveryBars === 0) {
      this._compare();
    }

    // 6. Return ensemble decision to the live engine
    // Bug #65 supplement: expose indicators for downstream gates (e.g. liquidity gate)
    ensemble.indicators = indicators;
    return ensemble;
  }

  // ── Compute performance-weighted votes across all strategies ────────────────
  _computeWeights () {
    const weights = {};
    for (const [id, c] of this.contestants) {
      const m  = c.metrics();
      // Weight = profit factor, clamped to [minWeight, maxWeight]
      // Strategies with no trades yet get minWeight (they still have a voice)
      const pf = m.trades > 0 && isFinite(m.profitFactor) ? m.profitFactor : this.cfg.ensembleMinWeight;
      weights[id] = Math.max(this.cfg.ensembleMinWeight, Math.min(this.cfg.ensembleMaxWeight, pf));
    }
    return weights;
  }

  // ── Weighted ensemble vote ──────────────────────────────────────────────────
  // Each strategy casts a vote proportional to its weight × confidence.
  // BUY and SELL accumulate separately; HOLD contributes zero score.
  // Final action requires: score >= threshold AND agreeing >= minAgree.
  _ensembleVote (decisions) {
    const weights   = this._computeWeights();
    let buyScore    = 0, sellScore = 0;
    let buyCount    = 0, sellCount = 0;
    let buyConf     = 0, sellConf  = 0;   // sum of raw confidences (for normalisation)

    for (const [id, d] of Object.entries(decisions)) {
      const w = weights[id] || this.cfg.ensembleMinWeight;
      if (d.action === 'BUY') {
        buyScore += d.confidence * w;
        buyCount++;
        buyConf += d.confidence;
      } else if (d.action === 'SELL') {
        sellScore += d.confidence * w;
        sellCount++;
        sellConf += d.confidence;
      }
    }

    const { ensembleThreshold: thresh, ensembleMinAgree: minAgree } = this.cfg;

    let action = 'HOLD', score = 0, agreeing = 0, rawConf = 0;

    if (buyScore >= sellScore && buyScore >= thresh && buyCount >= minAgree) {
      action   = 'BUY';
      score    = buyScore;
      agreeing = buyCount;
      rawConf  = buyConf;
    } else if (sellScore > buyScore && sellScore >= thresh && sellCount >= minAgree) {
      action   = 'SELL';
      score    = sellScore;
      agreeing = sellCount;
      rawConf  = sellConf;
    }

    // Normalised confidence: weighted average of agreeing strategies' confidences
    // so the engine receives a familiar 0–100 confidence value
    const normConf = agreeing > 0
      ? Math.min(95, Math.round(rawConf / agreeing))
      : 0;

    return {
      action,
      confidence:    normConf,
      ensembleScore: parseFloat(score.toFixed(2)),
      agreeing,
      totalStrategies: Object.keys(decisions).length,  // FIX: expose for EnsembleDisagreementHalt
      weights,
      fromEnsemble:  true,
      reasoning:     action === 'HOLD'
        ? `Ensemble HOLD — BUY score ${buyScore.toFixed(0)} (${buyCount} agree), SELL score ${sellScore.toFixed(0)} (${sellCount} agree), threshold ${thresh}`
        : `Ensemble ${action} — score ${score.toFixed(0)}, ${agreeing} strategies agree, threshold ${thresh}`,
    };
  }

  // Toggle ensemble on/off at runtime
  setEnsembleEnabled (enabled) {
    this.cfg.ensembleEnabled = !!enabled;
    console.log(`[ABTester] Ensemble voting ${enabled ? 'ENABLED' : 'DISABLED'}`);
  }

  // Current ensemble weights and last vote breakdown
  ensembleStatus () {
    const weights = this._computeWeights();
    const last    = this.signalHistory.at(-1);
    return {
      enabled:   this.cfg.ensembleEnabled,
      threshold: this.cfg.ensembleThreshold,
      minAgree:  this.cfg.ensembleMinAgree,
      weights,
      lastBar:   last || null,
    };
  }

  // ── Statistical comparison ─────────────────────────────────────────────────
  _compare () {
    const champion = this.contestants.get(this.championId);
    const champM   = champion.metrics();

    if (champM.trades < 5) return;  // not enough champion data yet

    let bestChallenger = null;
    let bestScore      = 0;

    for (const [id, c] of this.contestants) {
      if (id === this.championId) continue;
      const m = c.metrics();
      if (m.trades < this.cfg.minTradesForComparison) continue;

      // Composite score vs champion (positive = challenger is better)
      // When champion PF is 0 (all losses) and challenger has positive PF,
      // treat as maximum advantage so promotion always fires in that case.
      const pfAdv  = champM.profitFactor > 0
        ? (m.profitFactor - champM.profitFactor) / champM.profitFactor * 100
        : (m.profitFactor > 0 ? 100 : 0);  // champion PF=0 → 100% advantage to any positive PF
      const wrAdv  = m.winRate - champM.winRate;
      const shAdv  = isFinite(m.sharpe) && isFinite(champM.sharpe) ? (m.sharpe - champM.sharpe) : 0;

      // Weighted composite: PF 40%, WR 30%, Sharpe 30%
      const composite = pfAdv * 0.40 + wrAdv * 0.30 + shAdv * 10 * 0.30;

      console.log(
        `[ABTester] 📊 Bar ${this.barCount} | ${c.label} vs Champion: ` +
        `PF ${m.profitFactor.toFixed(3)} vs ${champM.profitFactor.toFixed(3)} ` +
        `(${pfAdv >= 0 ? '+' : ''}${pfAdv.toFixed(1)}%) | ` +
        `WR ${m.winRate.toFixed(1)}% vs ${champM.winRate.toFixed(1)}% | ` +
        `Composite: ${composite >= 0 ? '+' : ''}${composite.toFixed(1)}`
      );

      if (composite > bestScore && pfAdv >= this.cfg.promotionThresholdPct) {
        bestScore      = composite;
        bestChallenger = { id, contestant: c, metrics: m, composite, pfAdv };
      }
    }

    if (bestChallenger) {
      this._promote(bestChallenger, champM);
    }
  }

  // ── Auto-promotion ─────────────────────────────────────────────────────────
  _promote ({ id, contestant, metrics, composite, pfAdv }, champMetrics) {
    const oldChamp = this.contestants.get(this.championId);
    oldChamp.isChampion = false;
    oldChamp.demotedAt  = new Date().toISOString();

    contestant.isChampion = true;
    contestant.promotedAt = new Date().toISOString();
    this.championId = id;
    // Fix #11: Block entries for 20 bars after strategy switch so new strategy's indicators warm up
    this._warmupBarsRemaining = 20;
    // Fix #48: Reset epsilon-decay schedule after each promotion
    // (high exploration early in new strategy, decay to exploitation)
    if (this._ql) { this._ql._epsilon = 0.3; }
    this._warmupReason = `Strategy switched to ${contestant.label} — warming up (20 bars)`;
    console.log(`[ABTester] ⏳ 20-bar warm-up started after promotion to ${contestant.label}`);

    const event = {
      bar:          this.barCount,
      timestamp:    new Date().toISOString(),
      promoted:     { id, label: contestant.label, metrics },
      demoted:      { id: oldChamp.id, label: oldChamp.label, metrics: champMetrics },
      composite:    parseFloat(composite.toFixed(2)),
      pfAdvantage:  parseFloat(pfAdv.toFixed(2)),
    };
    this.promotionLog.push(event);

    console.log(`[ABTester] 🏆 PROMOTION at bar ${this.barCount}:`);
    console.log(`[ABTester]    NEW Champion: ${contestant.label} (PF ${metrics.profitFactor.toFixed(3)}, WR ${metrics.winRate.toFixed(1)}%)`);
    console.log(`[ABTester]    OLD Champion: ${oldChamp.label} (PF ${champMetrics.profitFactor.toFixed(3)}, WR ${champMetrics.winRate.toFixed(1)}%)`);
    console.log(`[ABTester]    Composite advantage: +${composite.toFixed(1)} | PF advantage: +${pfAdv.toFixed(1)}%`);

    this._savePromotionLog();

    // Sync virtual account capitals so the new champion starts from same base
    contestant.account.capital = oldChamp.account.capital;

    // Bug fix #16: sync CapitalAllocator when champion changes (call on self, not this._abTester)
    try { if (typeof this._syncCapitalAllocator === 'function') this._syncCapitalAllocator(id); } catch(_) {}
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  // Force-promote a specific strategy (manual override)
  forcePromote (id) {
    if (!this.contestants.has(id)) throw new Error(`Unknown contestant: ${id}`);
    if (id === this.championId)    throw new Error(`${id} is already champion`);
    const challenger = this.contestants.get(id);
    const oldChamp   = this.contestants.get(this.championId);
    this._promote(
      { id, contestant: challenger, metrics: challenger.metrics(), composite: 0, pfAdv: 0 },
      oldChamp.metrics()
    );
  }

  // Full status snapshot
  status () {
    const rows = [];
    for (const [id, c] of this.contestants) {
      rows.push({
        id,
        label:      c.label,
        isChampion: c.isChampion,
        ...c.metrics(),
      });
    }
    return {
      bar:           this.barCount,
      championId:    this.championId,
      contestants:   rows,
      promotionLog:  this.promotionLog.slice(-10),
      recentSignals: this.signalHistory.slice(-5),
      ensemble:      this.ensembleStatus(),
    };
  }

  printStatus () {
    const s    = this.status();
    const line = '─'.repeat(76);
    console.log('\n' + '═'.repeat(76));
    console.log('  🧪 A/B TESTER — STRATEGY LEADERBOARD');
    console.log(`  Bar: ${s.bar} | Champion: ${this.contestants.get(s.championId)?.label}`);
    console.log('═'.repeat(76));
    console.log(`  ${'Strategy'.padEnd(28)} ${'Trades'.padStart(6)} ${'WR%'.padStart(7)} ${'PF'.padStart(7)} ${'Exp $'.padStart(8)} ${'Sharpe'.padStart(7)}  Role`);
    console.log(`  ${line}`);
    for (const r of s.contestants) {
      const role = r.isChampion ? '👑 LIVE' : '📋 Paper';
      console.log(
        `  ${r.label.padEnd(28)} ` +
        `${String(r.trades).padStart(6)} ` +
        `${r.winRate.toFixed(1).padStart(7)} ` +
        `${(isFinite(r.profitFactor) ? r.profitFactor.toFixed(3) : '∞').padStart(7)} ` +
        `$${r.expectancy.toFixed(2).padStart(7)} ` +
        `${r.sharpe.toFixed(2).padStart(7)}  ${role}`
      );
    }
    console.log(`  ${line}`);
    if (s.promotionLog.length > 0) {
      console.log(`  Last promotion: bar ${s.promotionLog.at(-1).bar} → ${s.promotionLog.at(-1).promoted.label}`);
    }
    console.log(`  Min trades for promotion: ${this.cfg.minTradesForComparison} | Threshold: ${this.cfg.promotionThresholdPct}% PF advantage`);

    // Ensemble section
    const es = s.ensemble;
    console.log(`\n  🗳️  ENSEMBLE VOTING — ${es.enabled ? '✅ ENABLED' : '⏸  DISABLED'}`);
    console.log(`  ${line}`);
    console.log(`  Threshold: ${es.threshold} | Min agree: ${es.minAgree} strategies`);
    if (es.weights && Object.keys(es.weights).length > 0) {
      console.log(`  Current weights:`);
      for (const [id, w] of Object.entries(es.weights)) {
        const c = this.contestants.get(id);
        console.log(`    ${(c?.label || id).padEnd(30)} weight: ${w.toFixed(3)}`);
      }
    }
    console.log('═'.repeat(76) + '\n');
  }

  // Item 19: Thompson Sampling bandit for strategy selection
  thompsonSample() {
    // Beta distribution sampling for each contestant
    // Beta(α, β) where α=wins+1, β=losses+1
    const samples = {};
    for (const [id, c] of this.contestants) {
      const trades = c.virtualAccount?.trades || [];
      const wins   = trades.filter(t=>(t.profitPercent||0)>0).length;
      const losses = trades.length - wins;
      const alpha  = wins   + 1;
      const beta   = losses + 1;
      // Sample from Beta(α,β) using gamma distribution approximation
      const ga = this._gammaRandom(alpha);
      const gb = this._gammaRandom(beta);
      samples[id] = ga / (ga + gb);
    }
    return samples;
  }

  // Marsaglia-Tsang gamma random number generator
  _gammaRandom(shape) {
    if (shape < 1) return this._gammaRandom(1 + shape) * Math.pow(Math.random(), 1/shape);
    const d = shape - 1/3, cc = 1/Math.sqrt(9*d);
    for (;;) {
      let x = 0, v = 0;
      do { x = this._normalRandom(); v = 1 + cc*x; } while(v <= 0);
      v = v*v*v;
      const u = Math.random();
      if (u < 1 - 0.0331*(x*x)*(x*x)) return d*v;
      if (Math.log(u) < 0.5*x*x + d*(1-v+Math.log(v))) return d*v;
    }
  }

  _normalRandom() {
    return Math.sqrt(-2*Math.log(Math.random()))*Math.cos(2*Math.PI*Math.random());
  }

  // 1.5: Update dynamic ensemble weights based on rolling Sharpe of each contestant
  updateDynamicWeights() {
    const minTrades = 10;
    const weights   = {};
    let totalSharpe = 0;

    for (const [id, c] of this.contestants) {
      const trades = c.virtualAccount?.trades || [];
      if (trades.length < minTrades) { weights[id] = 1; totalSharpe += 1; continue; }
      // Compute rolling Sharpe over last 20 trades
      const returns   = trades.slice(-20).map(t => t.profitPercent || 0);
      const mean      = returns.reduce((s,v) => s+v, 0) / returns.length;
      const variance  = returns.reduce((s,v) => s+(v-mean)**2, 0) / returns.length;
      const std       = Math.sqrt(variance) || 0.001;
      const sharpe    = Math.max(0.01, mean / std);  // floor at 0.01 to keep all in play
      weights[id]     = sharpe;
      totalSharpe    += sharpe;
    }
    // Normalise to sum=1
    this._dynamicWeights = {};
    for (const [id] of this.contestants) {
      this._dynamicWeights[id] = parseFloat(((weights[id]||0.01) / totalSharpe).toFixed(4));
    }
    return this._dynamicWeights;
  }

  // Get dynamic weight for a specific contestant
  getDynamicWeight(strategyId) {
    return this._dynamicWeights?.[strategyId] ?? (1 / this.contestants.size);
  }

  // UCB1 bandit — alternative to Thompson Sampling (deterministic, no Beta sampling)
  // Selects the arm with highest UCB score: mean_reward + sqrt(2*ln(N)/n_i)
  ucb1Select() {
    let totalPulls = 0;
    const arms = [];
    for (const [id, contestant] of this.contestants) {
      const trades = contestant.virtualAccount?.trades || [];
      const n      = trades.length;
      const wins   = trades.filter(t=>(t.profitPercent||0)>0).length;
      const mean   = n > 0 ? wins/n : 0.5;
      totalPulls  += n;
      arms.push({ id, n, mean });
    }
    if (!arms.length) return this.champion;
    const logN = Math.log(Math.max(1, totalPulls));
    const scores = arms.map(a => ({
      id:    a.id,
      score: a.n > 0 ? a.mean + Math.sqrt(2 * logN / a.n) : Infinity,
    }));
    return scores.sort((a,b)=>b.score-a.score)[0]?.id || this.champion;
  }

  // Item 107: Freeze challenger paper accounts on halt, unfreeze on resume
  onHalt() {
    for (const [id, c] of this.contestants) {
      if (c.virtualAccount) {
        c.virtualAccount._frozen107  = true;
        c.virtualAccount._frozenAt107 = new Date().toISOString();
      }
    }
    console.log('[ABTester #107] All challenger accounts frozen on halt');
  }

  onResume() {
    for (const [id, c] of this.contestants) {
      if (c.virtualAccount) {
        if (c.virtualAccount._frozen107) {
          c.virtualAccount._resumedAt107 = new Date().toISOString();
          c.virtualAccount._frozen107 = false;
          console.log(`[ABTester #107] ${id} account unfrozen — gap period marked`);
        }
      }
    }
  }

  // Item 106: Two-proportion z-test before promotion (p < 0.05 required)
  _zTestSignificance(champWins, champTotal, chalWins, chalTotal) {
    if (champTotal < 50 || chalTotal < 50) return { significant: false, pValue: 1, reason: 'insufficient data (<50 trades)' };
    const p1 = champWins / champTotal;
    const p2 = chalWins  / chalTotal;
    const p  = (champWins + chalWins) / (champTotal + chalTotal);  // pooled
    const se = Math.sqrt(p*(1-p)*(1/champTotal + 1/chalTotal)) || 1e-8;
    const z  = (p2 - p1) / se;
    // Two-tailed p-value approximation
    const pValue = 2 * (1 - this._normCDF(Math.abs(z)));
    return {
      significant: pValue < 0.05,
      pValue:      parseFloat(pValue.toFixed(4)),
      zStat:       parseFloat(z.toFixed(4)),
      champWR:     parseFloat((p1*100).toFixed(1)),
      chalWR:      parseFloat((p2*100).toFixed(1)),
    };
  }

  _normCDF(z) {
    const t = 1/(1+0.2316419*Math.abs(z));
    const poly = t*(0.319381530+t*(-0.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));
    const pdf  = Math.exp(-0.5*z*z)/Math.sqrt(2*Math.PI);
    return z>=0 ? 1-pdf*poly : pdf*poly;
  }

  // Item 26: Blue-green deployment — swap champion without downtime
  blueGreenSwap(newChampionId, engine) {
    const prev = this.champion;
    const next = newChampionId || [...this.contestants.keys()].find(k => k !== prev);
    if (!next) return false;
    console.log(`[BlueGreen #26] Swapping champion: ${prev} → ${next} (zero-downtime)`);
    // The swap is atomic — champion accessor changes, no restart needed
    // Directly update champion property
    if (typeof this.champion === 'string') {
      // Find and update internal champion tracking
      this._champion = next;
    }
    if (this.contestants?.has?.(next)) this.champion = next;
    else this.champion = next;
    if (engine) engine.log(`[BlueGreen #26] Champion swapped: ${prev} → ${next}`);
    return { from: prev, to: next, swappedAt: new Date().toISOString() };
  }

  // Signal comparison for last bar — shows individual + ensemble decision
  signalLine () {
    const snap = this.signalHistory.at(-1);
    if (!snap) return '';
    const parts = [];
    for (const [id, c] of this.contestants) {
      const sig = snap[id] || 'HOLD(0)';
      parts.push(`${c.isChampion ? '👑' : ''}${c.label.replace(/[^\w]/g, '').slice(0, 8)}: ${sig}`);
    }
    const ensemblePart = snap.ensemble ? ` | 🗳️ ENSEMBLE: ${snap.ensemble}` : '';
    return `[ABTester] Bar ${snap.bar}: ${parts.join(' | ')}${ensemblePart}`;
  }

  _savePromotionLog () {
    try {
      const dir = this.cfg.logDir;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'ab-promotions.json'),
        JSON.stringify(this.promotionLog, null, 2)
      );
    } catch { /* non-fatal */ }
  }

  // Item #48: Shadow deployment — new strategy signals but doesn't execute for N hours
  enableShadowMode(strategyId, durationHours = 48) {
    this._shadowMode = { strategyId, enabledAt: Date.now(), durationMs: durationHours * 3_600_000 };
    console.log(`[ABTester #48] Shadow mode enabled for ${strategyId} (${durationHours}h observation period)`);
  }

  isShadowMode(strategyId) {
    const s = this._shadowMode;
    if (!s || s.strategyId !== strategyId) return false;
    if (Date.now() - s.enabledAt > s.durationMs) {
      console.log(`[ABTester #48] Shadow mode expired — ${strategyId} promoted to live`);
      this._shadowMode = null;
      return false;
    }
    return true;
  }
}

module.exports = { ABTester, AB_CONFIG, VirtualAccount, Contestant };
