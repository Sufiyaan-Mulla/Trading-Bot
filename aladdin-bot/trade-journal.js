'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  TradeJournal  —  Feature #14
//
//  Records every closed trade with MAE/MFE tracking and produces breakdowns
//  by pair, session, regime, and confidence bucket.
//
//  Usage:
//    const { TradeJournal } = require('./trade-journal');
//    const journal = new TradeJournal();
//    journal.record(trade, { mae: 0.003, mfe: 0.012 });
//    journal.byPair();        // { EURUSD: { trades, winRate, avgPnl, ... }, ... }
//    journal.bySession();     // { LONDON: { ... }, NEW_YORK: { ... }, ... }
//    journal.byRegime();      // { TRENDING: { ... }, RANGING: { ... }, ... }
//    journal.expectancyByConfidence();  // Feature #74
// ─────────────────────────────────────────────────────────────────────────────

class TradeJournal {
  constructor(opts = {}) {
    this._entries   = [];
    this._maxLen    = opts.maxEntries || 5000;
    this._log       = opts.log || (() => {});
  }

  /**
   * Record a closed trade. Call from exitPosition.
   * @param {object} trade        - the trade object from exitPosition
   * @param {object} [extremes]   - { mae: fraction, mfe: fraction } price extremes
   */
  record(trade, extremes = {}) {
    if (!trade) return;
    this._entries.push({
      id:         trade.id,
      asset:      trade.asset      || 'UNKNOWN',
      session:    trade.session    || 'UNKNOWN',
      regime:     trade.regime     || 'UNKNOWN',
      side:       trade.type       || 'LONG',
      entry:      trade.entry      || 0,
      exit:       trade.exit       || 0,
      profit:     trade.profit     || 0,
      profitPct:  trade.profitPercent || 0,
      won:        (trade.profit || 0) > 0,
      confidence: trade.confidence || trade.rawConfidence || 0,
      duration:   trade.duration   || 0,
      // MAE = Maximum Adverse Excursion (worst drawdown while in trade)
      mae:        extremes.mae     || 0,
      // MFE = Maximum Favorable Excursion (best profit while in trade)
      mfe:        extremes.mfe     || 0,
      ts:         Date.now(),
    });
    if (this._entries.length > this._maxLen) this._entries.shift();
  }

  // ── Aggregation helper ──────────────────────────────────────────────────
  _aggregate(entries) {
    if (!entries.length) return null;
    const wins    = entries.filter(e => e.won);
    const losses  = entries.filter(e => !e.won);
    const totalPnl = entries.reduce((s, e) => s + e.profit, 0);
    const grossW  = wins.reduce((s, e) => s + e.profit, 0);
    const grossL  = Math.abs(losses.reduce((s, e) => s + e.profit, 0));
    const avgMae  = entries.reduce((s, e) => s + e.mae, 0) / entries.length;
    const avgMfe  = entries.reduce((s, e) => s + e.mfe, 0) / entries.length;
    // Expectancy: average $ won or lost per trade
    const expectancy = entries.reduce((s, e) => s + e.profit, 0) / entries.length;
    return {
      trades:       entries.length,
      wins:         wins.length,
      losses:       losses.length,
      winRate:      parseFloat((wins.length / entries.length * 100).toFixed(1)),
      profitFactor: grossL > 0 ? parseFloat((grossW / grossL).toFixed(3)) : grossW > 0 ? Infinity : 0,
      totalPnl:     parseFloat(totalPnl.toFixed(2)),
      avgPnl:       parseFloat((totalPnl / entries.length).toFixed(2)),
      expectancy:   parseFloat(expectancy.toFixed(2)),
      avgMae:       parseFloat(avgMae.toFixed(5)),
      avgMfe:       parseFloat(avgMfe.toFixed(5)),
      maeToMfe:     avgMfe > 0 ? parseFloat((avgMae / avgMfe).toFixed(3)) : null,
    };
  }

  /** Breakdown by currency pair */
  byPair() {
    const groups = {};
    for (const e of this._entries) {
      (groups[e.asset] = groups[e.asset] || []).push(e);
    }
    const out = {};
    for (const [pair, entries] of Object.entries(groups)) out[pair] = this._aggregate(entries);
    return out;
  }

  /** Breakdown by session (LONDON, NEW_YORK, LONDON_NY_OVERLAP, ASIAN) */
  bySession() {
    const groups = {};
    for (const e of this._entries) {
      (groups[e.session] = groups[e.session] || []).push(e);
    }
    const out = {};
    for (const [sess, entries] of Object.entries(groups)) out[sess] = this._aggregate(entries);
    return out;
  }

  /** Breakdown by regime (TRENDING, RANGING, WEAK_TREND) */
  byRegime() {
    const groups = {};
    for (const e of this._entries) {
      (groups[e.regime] = groups[e.regime] || []).push(e);
    }
    const out = {};
    for (const [reg, entries] of Object.entries(groups)) out[reg] = this._aggregate(entries);
    return out;
  }

  /**
   * Feature #74 — Dollar expectancy by confidence bucket (10pt buckets)
   * Returns [{ bucket: '60-70', trades, expectancy, winRate }, ...]
   */
  expectancyByConfidence() {
    const buckets = {};
    for (const e of this._entries) {
      const lo  = Math.floor(e.confidence / 10) * 10;
      const key = `${lo}-${lo + 10}`;
      (buckets[key] = buckets[key] || []).push(e);
    }
    return Object.entries(buckets)
      .sort(([a], [b]) => parseInt(a) - parseInt(b))
      .map(([bucket, entries]) => ({
        bucket,
        trades:      entries.length,
        winRate:     parseFloat((entries.filter(e => e.won).length / entries.length * 100).toFixed(1)),
        expectancy:  parseFloat((entries.reduce((s, e) => s + e.profit, 0) / entries.length).toFixed(2)),
        avgMae:      parseFloat((entries.reduce((s, e) => s + e.mae, 0) / entries.length).toFixed(5)),
        avgMfe:      parseFloat((entries.reduce((s, e) => s + e.mfe, 0) / entries.length).toFixed(5)),
      }));
  }

  /** Calmar ratio per strategy — Feature #49 */
  calmarByStrategy(trades) {
    if (!trades || !trades.length) return {};
    const byStrat = {};
    for (const t of trades) {
      const s = t.strategy || 'ensemble';
      (byStrat[s] = byStrat[s] || []).push(t);
    }
    const out = {};
    for (const [strat, stratTrades] of Object.entries(byStrat)) {
      let peak = 0, capital = 0, maxDD = 0;
      const totalReturn = stratTrades.reduce((s, t) => s + (t.profit || 0), 0);
      for (const t of stratTrades) {
        capital += t.profit || 0;
        if (capital > peak) peak = capital;
        const dd = peak > 0 ? (peak - capital) / peak : 0;
        if (dd > maxDD) maxDD = dd;
      }
      out[strat] = {
        totalReturn: parseFloat(totalReturn.toFixed(2)),
        maxDrawdown: parseFloat(maxDD.toFixed(4)),
        calmar:      maxDD > 0 ? parseFloat((totalReturn / Math.max(1, Math.abs(maxDD * peak))).toFixed(3)) : null,
        trades:      stratTrades.length,
      };
    }
    return out;
  }

  /** Fix #38: Correlation between ML confidence and actual hold duration */
  confidenceVsHoldTime() {
    const buckets = {};
    for (const e of this._entries) {
      if (!e.duration) continue;
      const lo = Math.floor(e.confidence / 10) * 10;
      const key = `${lo}-${lo+10}`;
      (buckets[key] = buckets[key] || []).push(e.duration / 60_000);
    }
    return Object.entries(buckets).sort(([a],[b])=>parseInt(a)-parseInt(b)).map(([bucket, durations]) => ({
      bucket,
      trades:      durations.length,
      avgHoldMins: parseFloat((durations.reduce((s,v)=>s+v,0)/durations.length).toFixed(1)),
    }));
  }

  get count() { return this._entries.length; }
  all()       { return [...this._entries]; }
  clear()     { this._entries = []; }
}

module.exports = { TradeJournal };
