'use strict';

// Bug fix: atomic state write — prevents corrupt files on crash mid-write
function _atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp';
  require('fs').writeFileSync(tmp, content, 'utf8');
  require('fs').renameSync(tmp, filePath);
}


// ═══════════════════════════════════════════════════════════════════════════════
//  drift-monitor.js
//  Live vs Backtest Performance Drift Monitor
//
//  What it does
//  ────────────
//  On startup it loads the most recent nightly backtest JSON as the benchmark.
//  Every time a live trade closes, it updates a rolling window of live metrics
//  and compares them against the benchmark.
//
//  If any metric drifts beyond its threshold the engine is auto-disabled:
//    • Win rate drops  > WIN_RATE_DRIFT_PP  percentage points below benchmark
//    • Profit factor   < PROFIT_FACTOR_MIN  × benchmark profit factor
//    • Expectancy      < EXPECTANCY_MIN_PCT  % of benchmark expectancy
//
//  Config
//  ──────
//  All thresholds live in DRIFT_CONFIG below — edit to tune sensitivity.
//
//  Integration
//  ───────────
//  const DriftMonitor = require('./drift-monitor');
//  const monitor = new DriftMonitor();
//  monitor.recordTrade(trade);          // call after every live exitPosition
//  if (monitor.isHalted()) { ... }      // check before every enterPosition
//  monitor.reset();                     // manual reset after human review
// ═══════════════════════════════════════════════════════════════════════════════

const fs   = require('fs');
const path = require('path');

// ── Configuration ─────────────────────────────────────────────────────────────
const DRIFT_CONFIG = {
  // Minimum live trades before drift checks begin.
  // Too few trades → metrics are noise. 10 is the minimum meaningful sample.
  minTradesBeforeCheck: 20,

  // Rolling window: only the last N live trades are used for comparison.
  // Older trades are dropped so the monitor reacts to recent regime changes.
  lookbackTrades: 20,

  // Win rate: halt if live win rate is more than this many percentage points
  // below the backtest benchmark.
  // E.g. benchmark 60% + threshold 15pp → halt below 45%
  winRateDriftPP: 15,

  // Profit factor: halt if live profit factor drops below this fraction
  // of the benchmark profit factor.
  // E.g. benchmark 1.8, ratio 0.65 → halt below 1.17
  profitFactorMinRatio: 0.65,

  // Expectancy: halt if live expectancy drops below this fraction
  // of the benchmark expectancy per trade.
  // E.g. benchmark $5/trade, ratio 0.50 → halt below $2.50
  expectancyMinRatio: 0.50,

  // Log directory — must match backtest-nightly.js LOG_DIR
  logDir: path.join(__dirname, 'trade_logs'),

  // After auto-halt, how many minutes before the monitor allows a manual
  // reset via monitor.reset(). Set to 0 to allow instant manual reset.
  haltCooldownMinutes: 60,
};

// ── DriftMonitor class ────────────────────────────────────────────────────────
class DriftMonitor {
  constructor(config = {}) {
    this.cfg       = { ...DRIFT_CONFIG, ...config };
    this.benchmark = null;       // loaded from nightly JSON
    this.liveTrades = [];        // rolling window of closed live trades
    this.halted    = false;      // true = trading blocked
    this.haltReason = '';
    this.haltedAt  = null;       // Date when halt was triggered
    this.driftLog  = [];         // history of drift evaluations

    this._loadBenchmark();
  }

  // ── Benchmark loading ──────────────────────────────────────────────────────

  // Finds and loads the most recent nightly-YYYY-MM-DD.json from trade_logs/.
  _loadBenchmark() {
    const dir = this.cfg.logDir;
    if (!fs.existsSync(dir)) {
      this._log('⚠️  trade_logs/ not found — drift monitoring inactive until first nightly run');
      return;
    }

    const files = fs.readdirSync(dir)
      .filter(f => /^nightly-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort().reverse();  // most recent first

    if (files.length === 0) {
      this._log('⚠️  No nightly backtest reports found — drift monitoring inactive');
      return;
    }

    // Fix #21: Use rolling median of last N nights, not just the most recent.
    // A single bad night (thin data, high slippage) would depress the baseline.
    const N = this.cfg.benchmarkNights || 5;
    const recentFiles = files.slice(0, N);
    const parsed = recentFiles.map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
      catch(_) { return null; }
    }).filter(Boolean);

    if (parsed.length === 0) return;

    const med = (arr) => {
      const s = arr.slice().sort((a,b)=>a-b);
      const m = Math.floor(s.length/2);
      return s.length % 2 === 0 ? (s[m-1]+s[m])/2 : s[m];
    };

    this.benchmark = {
      date:         parsed[0].date,
      winRate:      med(parsed.map(d => d.winRate       || 0)),
      profitFactor: med(parsed.map(d => d.profitFactor  || 0)),
      expectancy:   med(parsed.map(d => d.expectancy    || 0)),
      totalReturn:  med(parsed.map(d => d.totalReturn   || 0)),
      totalTrades:  med(parsed.map(d => d.totalTrades   || 0)),
      verdict:      parsed[0].verdict,
      source:       `median of ${parsed.length} nights`,
    };
    this._log(`✅ Benchmark (rolling median ${parsed.length}/${N} nights): WR=${this.benchmark.winRate.toFixed(1)}% | PF=${this.benchmark.profitFactor.toFixed(3)} | Exp=$${this.benchmark.expectancy.toFixed(2)}`);
  }

  // Reload benchmark — call this after each nightly run to pick up the new report.
  reloadBenchmark() {
    this._loadBenchmark();
  }

  // ── Trade recording ────────────────────────────────────────────────────────

  // Call this after every live trade closes (in exitPosition).
  // trade must have at least: { profit: number }
  recordTrade(trade) {
    if (!trade || typeof trade.profit !== 'number' || !isFinite(trade.profit)) return;
    // Bug fix: NaN passes typeof 'number' check — must also guard isFinite.
    // #1: Reject duplicate-timestamp trades (likely test data pollution)
    // Only dedup on EXPLICIT external timestamps (not internal ts from trading engine)
    const ts = trade.timestamp || trade.closedAt || trade.exitTime;  // NOT trade.ts (auto-assigned)
    if (ts) {
      const isDup = this.liveTrades.some(t => t._origTs === ts);
      if (isDup) { console.warn('[DriftMonitor] Skipping duplicate-timestamp trade — likely test data'); return; }
    }

    // Add to rolling window
    this.liveTrades.push({
      profit: trade.profit,
      win:    trade.profit > 0,
      ts:     Date.now(),
      _origTs: ts || null,
    });

    // Keep only the last N trades
    if (this.liveTrades.length > this.cfg.lookbackTrades) {
      this.liveTrades.shift();
    }

    // Only evaluate after minimum sample size
    if (this.liveTrades.length >= this.cfg.minTradesBeforeCheck) {
      this._evaluate();
    }
  }

  // ── Drift evaluation ───────────────────────────────────────────────────────

  _evaluate() {
    if (!this.benchmark) return;   // no benchmark yet
    if (this.halted)    return;    // already halted — don't re-evaluate

    const live    = this._liveMetrics();
    const bench   = this.benchmark;
    const reasons = [];

    // 1. Win rate drift
    const wrDrift = bench.winRate - live.winRate;   // positive = live is worse
    if (wrDrift > this.cfg.winRateDriftPP) {
      reasons.push(
        `Win rate: live ${live.winRate.toFixed(1)}% vs benchmark ${bench.winRate.toFixed(1)}% ` +
        `(drift −${wrDrift.toFixed(1)}pp, threshold ${this.cfg.winRateDriftPP}pp)`
      );
    }

    // 2. Profit factor drift
    if (bench.profitFactor > 0) {
      const pfRatio = live.profitFactor / bench.profitFactor;
      if (pfRatio < this.cfg.profitFactorMinRatio) {
        reasons.push(
          `Profit factor: live ${live.profitFactor.toFixed(3)} vs benchmark ${bench.profitFactor.toFixed(3)} ` +
          `(ratio ${(pfRatio * 100).toFixed(0)}%, threshold ${(this.cfg.profitFactorMinRatio * 100).toFixed(0)}%)`
        );
      }
    }

    // 3. Expectancy drift
    if (bench.expectancy > 0) {
      const expRatio = live.expectancy / bench.expectancy;
      if (expRatio < this.cfg.expectancyMinRatio) {
        reasons.push(
          `Expectancy: live $${live.expectancy.toFixed(2)} vs benchmark $${bench.expectancy.toFixed(2)} ` +
          `(ratio ${(expRatio * 100).toFixed(0)}%, threshold ${(this.cfg.expectancyMinRatio * 100).toFixed(0)}%)`
        );
      }
    }

    // Record evaluation
    const evaluation = {
      ts:           new Date().toISOString(),
      liveMetrics:  live,
      benchmark:    { winRate: bench.winRate, profitFactor: bench.profitFactor, expectancy: bench.expectancy },
      drifting:     reasons.length > 0,
      reasons,
    };
    this.driftLog.push(evaluation);
    if (this.driftLog.length > 100) this.driftLog.shift();

    if (reasons.length > 0) {
      this._triggerHalt(reasons);
    } else {
      this._log(
        `📊 Drift check OK | Live: WR=${live.winRate.toFixed(1)}% PF=${live.profitFactor.toFixed(3)} ` +
        `Exp=$${live.expectancy.toFixed(2)} | Trades in window: ${this.liveTrades.length}`
      );
    }
  }

  // Compute live metrics from the rolling window
  _liveMetrics() {
    const trades = this.liveTrades;
    const n      = trades.length;
    if (n === 0) return { winRate: 0, profitFactor: 0, expectancy: 0, trades: 0 };

    const wins   = trades.filter(t => t.win);
    const losses = trades.filter(t => !t.win);

    const grossProfit = wins.reduce((s, t)   => s + t.profit, 0);
    const grossLoss   = Math.abs(losses.reduce((s, t) => s + t.profit, 0));

    const winRate     = (wins.length / n) * 100;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0); // BUG-44: cap at 999 instead of Infinity to avoid toFixed() crash
    const expectancy  = trades.reduce((s, t) => s + t.profit, 0) / n;

    return { winRate, profitFactor, expectancy, trades: n };
  }

  // ── Halt / Resume ──────────────────────────────────────────────────────────

  _triggerHalt(reasons) {
    this.halted     = true;
    this.haltReason = reasons.join(' | ');
    this.haltedAt   = new Date();

    this._log('🛑 DRIFT HALT TRIGGERED — live performance has deviated from backtest benchmark');
    for (const r of reasons) this._log(`   • ${r}`);
    this._log('   Trading auto-disabled. Call monitor.reset() after manual review.');

    this._saveDriftReport();
  }

  // Returns true if trading should be blocked
  isHalted() { return this.halted; }

  // Returns human-readable halt status
  haltStatus() {
    if (!this.halted) return null;
    return {
      halted:     true,
      reason:     this.haltReason,
      haltedAt:   this.haltedAt?.toISOString(),
      benchmark:  this.benchmark?.source,
      liveWindow: this.liveTrades.length,
    };
  }

  // Manual reset — call after human review of performance
  reset(force = false) {
    if (this.halted && !force) {
      const minsHalted = this.haltedAt
        ? (Date.now() - this.haltedAt.getTime()) / 60000
        : Infinity;
      if (minsHalted < this.cfg.haltCooldownMinutes) {
        const minsLeft = (this.cfg.haltCooldownMinutes - minsHalted).toFixed(0);
        this._log(`⚠️  Reset blocked: ${minsLeft} min cooldown remaining. Call reset(true) to force.`);
        return false;
      }
    }
    this.halted      = false;
    this.haltReason  = '';
    this.haltedAt    = null;
    this.liveTrades  = [];   // clear window — start fresh after review
    this._log('✅ Drift monitor reset — live trade window cleared, monitoring resumed');
    this._loadBenchmark();   // reload latest benchmark
    return true;
  }

  // ── Status / Reporting ─────────────────────────────────────────────────────

  status() {
    const live  = this._liveMetrics();
    const bench = this.benchmark;
    return {
      halted:          this.halted,
      haltReason:      this.haltReason,
      benchmarkDate:   bench?.date || null,
      benchmarkSource: bench?.source || null,
      benchmark: bench ? {
        winRate:      bench.winRate,
        profitFactor: bench.profitFactor,
        expectancy:   bench.expectancy,
      } : null,
      live: {
        winRate:      parseFloat(live.winRate.toFixed(2)),
        profitFactor: parseFloat(live.profitFactor.toFixed(4)),
        expectancy:   parseFloat(live.expectancy.toFixed(4)),
        trades:       live.trades,
      },
      thresholds: {
        winRateDriftPP:       this.cfg.winRateDriftPP,
        profitFactorMinRatio: this.cfg.profitFactorMinRatio,
        expectancyMinRatio:   this.cfg.expectancyMinRatio,
        minTradesBeforeCheck: this.cfg.minTradesBeforeCheck,
        lookbackTrades:       this.cfg.lookbackTrades,
      },
      recentDrift: this.driftLog.slice(-5),
    };
  }

  printStatus() {
    const s    = this.status();
    const line = '─'.repeat(60);
    console.log('\n' + '═'.repeat(60));
    console.log('  📉 LIVE VS BACKTEST DRIFT MONITOR');
    console.log('═'.repeat(60));

    if (!s.benchmark) {
      console.log('  ⚠️  No benchmark loaded — run backtest-nightly.js first');
      console.log('═'.repeat(60) + '\n');
      return;
    }

    console.log(`  Benchmark: ${s.benchmarkSource} (${s.benchmarkDate})`);
    console.log(`  Status:    ${s.halted ? '🛑 HALTED — trading disabled' : '✅ ACTIVE — within tolerance'}`);
    if (s.halted) console.log(`  Reason:    ${s.haltReason}`);
    console.log(`  ${line}`);

    const pad = (str, n) => String(str).padEnd(n);
    const fmt = v => typeof v === 'number' ? (isFinite(v) ? v.toFixed(3) : '∞') : String(v);

    console.log(`  ${pad('Metric', 18)} ${pad('Benchmark', 14)} ${pad('Live', 14)} ${'Status'}`);
    console.log(`  ${line}`);

    // Win rate
    const wrDrift = s.benchmark ? (s.benchmark.winRate - s.live.winRate) : 0;
    const wrOk    = wrDrift <= this.cfg.winRateDriftPP;
    console.log(
      `  ${pad('Win Rate', 18)} ${pad(fmt(s.benchmark?.winRate) + '%', 14)} ` +
      `${pad(fmt(s.live.winRate) + '%', 14)} ${wrOk ? '✅' : '❌'} drift −${wrDrift.toFixed(1)}pp`
    );

    // Profit factor
    const pfRatio = s.benchmark?.profitFactor > 0 ? s.live.profitFactor / s.benchmark.profitFactor : 1;
    const pfOk    = pfRatio >= this.cfg.profitFactorMinRatio;
    console.log(
      `  ${pad('Profit Factor', 18)} ${pad(fmt(s.benchmark?.profitFactor), 14)} ` +
      `${pad(fmt(s.live.profitFactor), 14)} ${pfOk ? '✅' : '❌'} ratio ${(pfRatio * 100).toFixed(0)}%`
    );

    // Expectancy
    const expRatio = s.benchmark?.expectancy > 0 ? s.live.expectancy / s.benchmark.expectancy : 1;
    const expOk    = expRatio >= this.cfg.expectancyMinRatio;
    console.log(
      `  ${pad('Expectancy/trade', 18)} $${pad(fmt(s.benchmark?.expectancy), 13)} ` +
      `$${pad(fmt(s.live.expectancy), 13)} ${expOk ? '✅' : '❌'} ratio ${(expRatio * 100).toFixed(0)}%`
    );

    console.log(`  ${line}`);
    console.log(`  Live window: ${s.live.trades} trades (min ${s.thresholds.minTradesBeforeCheck} to activate, max ${s.thresholds.lookbackTrades})`);
    console.log('═'.repeat(60) + '\n');
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  _saveDriftReport() {
    try {
      const dir = this.cfg.logDir;
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `drift-halt-${new Date().toISOString().slice(0, 10)}.json`);
      _atomicWrite(file, JSON.stringify({
        haltedAt:   this.haltedAt?.toISOString(),
        haltReason: this.haltReason,
        benchmark:  this.benchmark,
        liveMetrics: this._liveMetrics(),
        liveTrades: this.liveTrades,
      }, null, 2));
      this._log(`📁 Drift halt report saved → ${file}`);
    } catch (err) {
      this._log(`⚠️  Could not save drift report: ${err.message}`);
    }
  }

  _log(msg) {
    console.log(`[DriftMonitor] ${msg}`);
  }

  // Fix #55: Alert on suspicious improvement (look-ahead bias indicator)
  // A sudden Sharpe/PF improvement >50% overnight is more likely a data bug than genuine alpha.
  checkSuspiciousImprovement(newReport, previousReports) {
    if (!previousReports || previousReports.length < 2) return;
    const prevPF  = previousReports.reduce((s,r)=>s+(r.profitFactor||0),0)/previousReports.length;
    const newPF   = newReport.profitFactor || 0;
    if (prevPF > 0 && newPF > prevPF * 1.5) {
      const msg = `⚠️ [Fix #55] SUSPICIOUS IMPROVEMENT: PF jumped ${prevPF.toFixed(2)}→${newPF.toFixed(2)} (+${((newPF/prevPF-1)*100).toFixed(0)}%) overnight. Possible look-ahead bias introduced.`;
      this._log(msg);
      try { require('./telegram').send(msg, 'risk'); } catch(_) {}
      return { suspicious: true, prevPF, newPF, pctImprovement: (newPF/prevPF-1)*100 };
    }
    return { suspicious: false };
  }
}

// Item 108: Load benchmark from live nightly backtest result (not hardcoded JSON)
DriftMonitor.prototype.loadLiveBenchmark = function() {
  const fs = require('fs'), path = require('path');
  const benchPath = path.join(__dirname, 'trade_logs', 'benchmark-latest.json');
  try {
    if (!fs.existsSync(benchPath)) {
      console.warn('[DriftMonitor #108] benchmark-latest.json not found — using defaults');
      return false;
    }
    const data = JSON.parse(fs.readFileSync(benchPath,'utf8'));
    const ageMs = Date.now() - new Date(data.generatedAt||0).getTime();
    if (ageMs > 7*86_400_000) {
      console.warn('[DriftMonitor #108] Benchmark is >7 days old — stale!');
      try { require('./telegram').send('⚠️ Drift benchmark is >7 days old — run nightly backtest', 'risk'); } catch(_) {}
    }
    if (data.winRate)       this._benchmark.winRate       = data.winRate;
    if (data.profitFactor)  this._benchmark.profitFactor  = data.profitFactor;
    if (data.expectancy)    this._benchmark.expectancy    = data.expectancy;
    console.log(`[DriftMonitor #108] Loaded benchmark from ${path.basename(benchPath)}`);
    return true;
  } catch(e) { console.warn('[DriftMonitor #108] Failed to load benchmark:', e.message); return false; }
};

module.exports = { DriftMonitor, DRIFT_CONFIG };
