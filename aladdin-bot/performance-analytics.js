'use strict';
// ── performance-analytics.js ──────────────────────────────────────────────────
// IMPROVEMENTS #20-23: Advanced Performance Analytics
//
//   #20 TradeAttribution     — which signals drove each trade's P&L
//   #21 TimeHeatmap          — win-rate by hour × day-of-week grid
//   #22 RiskAdjustedMetrics  — Sharpe, Sortino, Calmar ratios
//   #23 EquityAnalytics      — drawdown waterfall, streak analysis
// ─────────────────────────────────────────────────────────────────────────────

// ── #20: Trade Attribution ─────────────────────────────────────────────────────
class TradeAttribution {
  constructor() {
    this._records = [];  // { factors, pnlPct, won }
    this._maxHistory = 200;
  }

  // Record which factors contributed to a trade
  // factors: { rsi, macd, ema, sr, sentiment, cot, ichimoku, stochRSI, ... }
  record(tradeId, factors, pnlPct, won, strategy) {
    this._records.push({ tradeId, factors: { ...factors }, pnlPct, won, strategy, ts: Date.now() });
    if (this._records.length > this._maxHistory) this._records.shift();
  }

  // Compute average PnL by factor (which factors correlate with profit)
  attributeByFactor() {
    if (this._records.length < 5) return {};

    const factorNames = ['rsi', 'macd', 'regime', 'sr', 'sentiment', 'cot', 'ichimoku', 'stochRSI', 'squeeze', 'session'];
    const result = {};

    for (const factor of factorNames) {
      const relevant = this._records.filter(r => r.factors[factor] != null);
      if (relevant.length < 3) continue;

      const wins   = relevant.filter(r => r.won);
      const losses = relevant.filter(r => !r.won);
      const avgPnL = relevant.reduce((s, r) => s + r.pnlPct, 0) / relevant.length;

      result[factor] = {
        trades:   relevant.length,
        winRate:  parseFloat((wins.length / relevant.length * 100).toFixed(1)),
        avgPnL:   parseFloat((avgPnL * 100).toFixed(3)),
        addingAlpha: avgPnL > 0,
      };
    }
    return result;
  }

  // Attribution by strategy
  attributeByStrategy() {
    const strategies = [...new Set(this._records.map(r => r.strategy))];
    return strategies.map(strat => {
      const records = this._records.filter(r => r.strategy === strat);
      const wins    = records.filter(r => r.won);
      const avgPnL  = records.reduce((s, r) => s + r.pnlPct, 0) / records.length;
      return {
        strategy: strat,
        trades:   records.length,
        winRate:  parseFloat((wins.length / records.length * 100).toFixed(1)),
        avgPnL:   parseFloat((avgPnL * 100).toFixed(3)),
      };
    });
  }

  report() {
    return {
      byFactor:   this.attributeByFactor(),
      byStrategy: this.attributeByStrategy(),
      totalTrades: this._records.length,
    };
  }
}

// ── #21: Time-of-Day × Day-of-Week Heatmap ───────────────────────────────────
class TimeHeatmap {
  constructor() {
    // 7 days × 24 hours grid: { wins, losses, totalPnL }
    this._grid = {};
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        this._grid[`${d}_${h}`] = { wins: 0, losses: 0, totalPnL: 0, trades: 0 };
      }
    }
  }

  record(openTime, won, pnlPct) {
    const d  = openTime.getUTCDay();
    const h  = openTime.getUTCHours();
    const cell = this._grid[`${d}_${h}`];
    if (!cell) return;
    cell.trades++;
    cell.totalPnL += pnlPct;
    if (won) cell.wins++; else cell.losses++;
  }

  // Get best/worst hours
  bestHours(n = 5) {
    return Object.entries(this._grid)
      .filter(([, c]) => c.trades >= 3)
      .map(([key, c]) => ({
        key,
        day:     ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][parseInt(key.split('_')[0])],
        hour:    parseInt(key.split('_')[1]),
        trades:  c.trades,
        winRate: parseFloat((c.wins / c.trades * 100).toFixed(1)),
        avgPnL:  parseFloat((c.totalPnL / c.trades * 100).toFixed(3)),
      }))
      .sort((a, b) => b.avgPnL - a.avgPnL)
      .slice(0, n);
  }

  worstHours(n = 5) {
    return Object.entries(this._grid)
      .filter(([, c]) => c.trades >= 3)
      .map(([key, c]) => ({
        key, day: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][parseInt(key.split('_')[0])],
        hour: parseInt(key.split('_')[1]),
        trades: c.trades,
        winRate: parseFloat((c.wins / c.trades * 100).toFixed(1)),
        avgPnL:  parseFloat((c.totalPnL / c.trades * 100).toFixed(3)),
      }))
      .sort((a, b) => a.avgPnL - b.avgPnL)
      .slice(0, n);
  }

  // Kelly time modifier: if this hour is historically bad → reduce size
  getTimeMod(utcDay, utcHour) {
    const cell = this._grid[`${utcDay}_${utcHour}`];
    if (!cell || cell.trades < 3) return 1.0;  // no data → neutral
    const avgPnL = cell.totalPnL / cell.trades;
    if (avgPnL > 0.005)  return 1.15;   // historically profitable hour → slight boost
    if (avgPnL > 0)      return 1.0;
    if (avgPnL > -0.005) return 0.85;   // slight negative → reduce
    return 0.70;                         // historically bad → big reduce
  }
}

// Fix #43: Map UTC hour to named session for consistent labelling
function _hourToSession(utcHour) {
  if (utcHour >= 13 && utcHour < 16) return 'LONDON_NY';
  if (utcHour >= 16 && utcHour < 21) return 'NEW_YORK';
  if (utcHour >= 8  && utcHour < 13) return 'LONDON';
  return 'ASIAN';
}

// ── #22: Risk-Adjusted Metrics ────────────────────────────────────────────────
class RiskAdjustedMetrics {
  constructor(riskFreeRate = 0.05) {
    this._riskFreeRate = riskFreeRate;
    this._trades       = [];
    this._equityCurve  = [1.0];
    // Fix #54: Track all-time max drawdown across restarts
    this._allTimeMaxDD  = 0;
    this._allTimePeak   = 1.0;
    this._loadAllTimeDD();
    // ── Feature #9: Persist equity curve to disk ─────────────────────────
    this._ecFile = require('path').join(__dirname, 'trade_logs', 'equity-curve.json');
    this._loadCurve();
  }

  _loadAllTimeDD() {
    if (process.env.BACKTEST_MODE === 'true') return;
    try {
      const fs = require('fs'), path = require('path');
      const p  = path.join(__dirname, 'trade_logs', 'all-time-drawdown.json');
      if (fs.existsSync(p)) {
        const d = JSON.parse(fs.readFileSync(p,'utf8'));
        this._allTimeMaxDD  = d.maxDD || 0;
        this._allTimePeak   = d.peak  || 1.0;
      }
    } catch(_) {}
  }

  _saveAllTimeDD() {
    if (process.env.BACKTEST_MODE === 'true') return;
    try {
      const fs = require('fs'), path = require('path');
      const dir = path.join(__dirname, 'trade_logs');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir,'all-time-drawdown.json'),
        JSON.stringify({ maxDD: this._allTimeMaxDD, peak: this._allTimePeak, updatedAt: new Date().toISOString() }));
    } catch(_) {}
  }

  _loadCurve() {
    // Skip disk load in BACKTEST_MODE (test isolation — no cross-test contamination)
    if (process.env.BACKTEST_MODE === 'true') return;
    try {
      const fs   = require('fs');
      const data = JSON.parse(fs.readFileSync(this._ecFile, 'utf8'));
      if (Array.isArray(data.curve) && data.curve.length > 0) {
        this._equityCurve = data.curve;
        this._trades      = data.trades || [];
      }
    } catch(_) { /* first run or missing file — start fresh */ }
  }

  _saveCurve() {
    try {
      const fs = require('fs');
      fs.mkdirSync(require('path').join(__dirname, 'trade_logs'), { recursive: true });
      fs.writeFileSync(this._ecFile,
        JSON.stringify({ curve: this._equityCurve, trades: this._trades, updatedAt: new Date().toISOString() })
      );
    } catch(_) {}
  }

  addTrade(pnlPct) {
    // Bug fix: NaN/Infinity pnlPct permanently corrupts the equity curve — once
    // NaN propagates through multiplication every subsequent equity value is NaN,
    // making sharpe/sortino/calmar impossible to compute for the rest of the session.
    if (typeof pnlPct !== 'number' || !isFinite(pnlPct)) return;
    this._trades.push(pnlPct);
    const lastEquity = this._equityCurve[this._equityCurve.length - 1];
    const newEquity  = lastEquity * (1 + pnlPct);
    this._equityCurve.push(newEquity);
    // Fix #54: Update all-time peak and drawdown
    if (newEquity > this._allTimePeak) this._allTimePeak = newEquity;
    const dd = this._allTimePeak > 0 ? (this._allTimePeak - newEquity) / this._allTimePeak : 0;
    if (dd > this._allTimeMaxDD) { this._allTimeMaxDD = dd; this._saveAllTimeDD(); }
    this._saveCurve();
  }

  // Sharpe Ratio = (mean return - risk free) / std deviation
  sharpeRatio(annualizationFactor = 252) {
    if (this._trades.length < 5) return null;
    const mean = this._trades.reduce((s, v) => s + v, 0) / this._trades.length;
    const rfPerTrade = this._riskFreeRate / annualizationFactor;
    const excess  = this._trades.map(r => r - rfPerTrade);
    const exMean  = excess.reduce((s, v) => s + v, 0) / excess.length;
    const std     = Math.sqrt(excess.reduce((s, v) => s + (v - exMean) ** 2, 0) / excess.length);
    if (std < 1e-10) return null;
    return parseFloat((exMean / std * Math.sqrt(annualizationFactor)).toFixed(3));
  }

  // Sortino Ratio = (mean return - risk free) / downside deviation
  sortinoRatio(annualizationFactor = 252) {
    if (this._trades.length < 5) return null;
    const mean       = this._trades.reduce((s, v) => s + v, 0) / this._trades.length;
    const rfPerTrade = this._riskFreeRate / annualizationFactor;
    const excessMean = mean - rfPerTrade;
    const downsideReturns = this._trades.filter(r => r < 0);
    if (downsideReturns.length < 2) return null;
    const downsideVar = downsideReturns.reduce((s, v) => s + v ** 2, 0) / downsideReturns.length;
    const downsideStd = Math.sqrt(downsideVar);
    if (downsideStd < 1e-10) return null;
    return parseFloat((excessMean / downsideStd * Math.sqrt(annualizationFactor)).toFixed(3));
  }

  // Maximum drawdown from equity curve
  maxDrawdown() {
    if (this._equityCurve.length < 2) return 0;
    let peak = this._equityCurve[0], maxDD = 0;
    for (const v of this._equityCurve) {
      if (v > peak) peak = v;
      const dd = (peak - v) / peak;
      if (dd > maxDD) maxDD = dd;
    }
    return parseFloat(maxDD.toFixed(4));
  }

  // Calmar Ratio = annualized return / max drawdown
  calmarRatio(annualizationFactor = 252) {
    if (this._trades.length < 5) return null;
    const totalReturn = this._equityCurve[this._equityCurve.length - 1] - 1;
    const annualizedReturn = totalReturn * (annualizationFactor / this._trades.length);
    const maxDD = this.maxDrawdown();
    if (maxDD < 1e-10) return null;
    return parseFloat((annualizedReturn / maxDD).toFixed(3));
  }

  // Profit Factor = gross wins / gross losses
  profitFactor() {
    const wins   = this._trades.filter(r => r > 0).reduce((s, v) => s + v, 0);
    const losses = this._trades.filter(r => r < 0).reduce((s, v) => s + Math.abs(v), 0);
    if (losses < 1e-10) return wins > 0 ? 999 : 1;
    return parseFloat((wins / losses).toFixed(3));
  }

  // Win rate, average win/loss
  winStats() {
    if (!this._trades.length) return {};
    const wins   = this._trades.filter(r => r > 0);
    const losses = this._trades.filter(r => r <= 0);
    return {
      winRate:    parseFloat((wins.length / this._trades.length * 100).toFixed(1)),
      avgWin:     wins.length   ? parseFloat((wins.reduce((s, v)   => s + v, 0) / wins.length   * 100).toFixed(3)) : 0,
      avgLoss:    losses.length ? parseFloat((losses.reduce((s, v) => s + v, 0) / losses.length * 100).toFixed(3)) : 0,
      expectancy: parseFloat((this._trades.reduce((s, v) => s + v, 0) / this._trades.length * 100).toFixed(3)),
    };
  }

  fullReport() {
    return {
      trades:        this._trades.length,
      sharpe:        this.sharpeRatio(),
      sortino:       this.sortinoRatio(),
      calmar:        this.calmarRatio(),
      maxDrawdown:   this.maxDrawdown(),
      profitFactor:  this.profitFactor(),
      ...this.winStats(),
    };
  }
}

// Item 19: Regime contribution report — P&L by HMM state
RiskAdjustedMetrics.prototype.regimeContribution = function(trades) {
  const by = {};
  for (const t of (trades||[])) {
    const regime = t.hmmState || t.regime || 'UNKNOWN';
    if (!by[regime]) by[regime] = { trades:0, totalPnl:0, wins:0 };
    by[regime].trades++;
    by[regime].totalPnl += t.profit||0;
    if ((t.profit||0)>0) by[regime].wins++;
  }
  return Object.entries(by).map(([regime,s])=>({
    regime,
    trades:   s.trades,
    totalPnl: parseFloat(s.totalPnl.toFixed(2)),
    winRate:  s.trades>0 ? parseFloat((s.wins/s.trades*100).toFixed(1)) : 0,
    avgPnl:   s.trades>0 ? parseFloat((s.totalPnl/s.trades).toFixed(2)) : 0,
  })).sort((a,b)=>b.totalPnl-a.totalPnl);
};

// Item #24: P&L attribution method on RiskAdjustedMetrics
RiskAdjustedMetrics.prototype.pnlAttribution = function(trades) {
  const by = key => {
    const m={};
    (trades||[]).forEach(t=>{const k=t[key]||'UNK';if(!m[k])m[k]={trades:0,totalPnl:0,wins:0};m[k].trades++;m[k].totalPnl+=(t.profit||0);if((t.profit||0)>0)m[k].wins++;});
    return Object.entries(m).map(([n,s])=>({name:n,trades:s.trades,totalPnl:parseFloat(s.totalPnl.toFixed(2)),winRate:parseFloat((s.wins/s.trades*100).toFixed(1)),avgPnl:parseFloat((s.totalPnl/s.trades).toFixed(2))})).sort((a,b)=>b.totalPnl-a.totalPnl);
  };
  return {byStrategy:by('strategy'),bySession:by('session'),byPair:by('asset')};
};

// Item 20: Trade clustering — identify which setups generate alpha
function clusterTrades(trades, k = 3) {
  if (!trades || trades.length < k*3) return [];
  // Features: [confidence, holdMinutes, profitPercent, spreadAtEntry]
  const feat = trades.map(t => [
    (t.confidence||60)/100,
    Math.min((t.duration||0)/60000, 120)/120,
    Math.max(-5, Math.min(5, t.profitPercent||0))/5,
    Math.min(t.spreadAtEntry||0.0002, 0.002)/0.002,
  ]);
  // Simple k-means
  let centroids = feat.slice(0,k).map(f=>[...f]);
  for (let iter=0;iter<20;iter++) {
    const clusters = Array.from({length:k},()=>[]);
    feat.forEach((f,i)=>{
      const dists = centroids.map(c=>c.reduce((s,v,j)=>(s+(v-f[j])**2),0));
      clusters[dists.indexOf(Math.min(...dists))].push(i);
    });
    const prev = JSON.stringify(centroids);
    centroids = clusters.map(cl=>{
      if (!cl.length) return centroids[clusters.indexOf(cl)];
      return feat[0].map((_,j)=>cl.reduce((s,i)=>s+feat[i][j],0)/cl.length);
    });
    if (JSON.stringify(centroids)===prev) break;
  }
  // Label clusters by P&L
  return centroids.map((c,i)=>({
    cluster:    i,
    confidence: parseFloat((c[0]*100).toFixed(1)),
    holdMins:   parseFloat((c[1]*120).toFixed(0)),
    avgPnlPct:  parseFloat((c[2]*5).toFixed(2)),
    spreadMulti:parseFloat((c[3]*10).toFixed(1)),
    label:      c[2]>0.2?'ALPHA_SOURCE': c[2]<-0.2?'LOSS_SOURCE':'NEUTRAL',
  })).sort((a,b)=>b.avgPnlPct-a.avgPnlPct);
}

// Item 39: 30-minute time-of-day heatmap (upgrade from hourly)
class ThirtyMinHeatmap {
  constructor() { this._slots = Array.from({length:48},()=>({count:0,wins:0,pnl:0})); }
  record(closedAt, won, profit) {
    const d   = new Date(closedAt||Date.now());
    const idx = d.getUTCHours()*2 + (d.getUTCMinutes()>=30?1:0);
    const s   = this._slots[idx];
    s.count++; s.pnl += profit||0; if(won) s.wins++;
  }
  getWorstSlots(n=10) {
    return this._slots.map((s,i)=>({
      slot: `${String(Math.floor(i/2)).padStart(2,'0')}:${i%2?'30':'00'}`,
      winRate: s.count>0 ? parseFloat((s.wins/s.count*100).toFixed(1)) : null,
      avgPnl:  s.count>0 ? parseFloat((s.pnl/s.count).toFixed(2)) : null,
      count:   s.count,
    })).filter(s=>s.count>=3).sort((a,b)=>(a.avgPnl||0)-(b.avgPnl||0)).slice(0,n);
  }
  shouldBlock(utcHours, utcMins, minTrades=200) {
    if (this._slots.reduce((s,v)=>s+v.count,0)<minTrades) return false;
    const idx  = utcHours*2+(utcMins>=30?1:0);
    const s    = this._slots[idx];
    if (s.count < 3) return false;
    const avgPnl = s.pnl/s.count;
    // Block bottom 20% performing slots
    const allPnls = this._slots.filter(x=>x.count>=3).map(x=>x.pnl/x.count).sort((a,b)=>a-b);
    const cutoff  = allPnls[Math.floor(allPnls.length*0.20)]||0;
    return avgPnl < cutoff;
  }
}

// Item 48: Multi-currency P&L conversion — convert position P&L to account base currency
function convertPnlToBase(pnl, pair, accountCurrency, fxRates) {
  const quoteCurrency = pair?.slice(3) || accountCurrency;
  if (quoteCurrency === accountCurrency || !fxRates) return pnl;
  const rate = fxRates[`${quoteCurrency}${accountCurrency}`] ||
               (1 / (fxRates[`${accountCurrency}${quoteCurrency}`] || 1));
  return pnl * rate;
}

// Item 29: Post-trade TCA (Transaction Cost Analysis)
function generateTCA(trades, prices) {
  if (!trades || !trades.length) return null;
  const results = trades.map(t => {
    const arrival  = t.entryPrice || t.entry || 0;
    const vwap     = prices ? prices.slice(0,5).reduce((s,v)=>s+v,0)/5 : arrival;
    const implCost = arrival > 0 ? Math.abs(arrival - vwap) / arrival * 10000 : 0;  // bps
    const explicit = (t.commission||0) + (t.spreadAtEntry||0);
    return {
      id:           t.id,
      asset:        t.asset,
      arrivalPrice: parseFloat(arrival.toFixed(6)),
      vwapBenchmark:parseFloat(vwap.toFixed(6)),
      implicitCost: parseFloat(implCost.toFixed(2)),  // bps
      explicitCost: parseFloat(explicit.toFixed(6)),
      totalCostBps: parseFloat((implCost + explicit*10000).toFixed(2)),
    };
  });
  const avgImplicit = results.reduce((s,r)=>s+r.implicitCost,0)/results.length;
  const avgExplicit = results.reduce((s,r)=>s+r.explicitCost,0)/results.length;
  return { trades:results, avgImplicitCostBps:parseFloat(avgImplicit.toFixed(2)),
    avgExplicitCost:parseFloat(avgExplicit.toFixed(6)), totalTrades:results.length };
}

module.exports = { TradeAttribution, TimeHeatmap, ThirtyMinHeatmap, RiskAdjustedMetrics, clusterTrades, generateTCA, convertPnlToBase, stressTestES: require('./monte-carlo').stressTestES };
