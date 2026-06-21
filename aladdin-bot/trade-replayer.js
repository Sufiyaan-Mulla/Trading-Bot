'use strict';
// ── Trade Replay Tool ─────────────────────────────────────────────────────────
// Replays historical trade decisions from the audit log / trades.jsonl
// for debugging, what-if analysis, and strategy validation.
// Does NOT re-execute live orders — simulation only.

const fs   = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, 'trade_logs');

class TradeReplayer {
  constructor({ log = console.log } = {}) {
    this.log = log;
  }

  /**
   * Load all trades from trades.jsonl
   * @returns {object[]}
   */
  loadTrades() {
    const p = path.join(LOGS_DIR, 'trades.jsonl');
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8')
      .trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  }

  /**
   * Replay all trades through a custom outcome function.
   * Useful for what-if analysis (e.g. "what if SL was 2× wider?").
   *
   * @param {object[]} trades     – trade records
   * @param {Function} adjustFn  – (trade) => modifiedTrade (return null to skip)
   * @returns {{ trades: object[], summary: object }}
   */
  replay(trades, adjustFn = t => t) {
    let capital = 0, peak = 0, maxDD = 0;
    const replayed = [];

    for (const original of trades) {
      const t = adjustFn({ ...original });
      if (!t) continue;

      const pnl = t.pnl || t.profit || 0;
      capital += pnl;
      if (capital > peak) peak = capital;
      const dd = peak - capital;
      if (dd > maxDD) maxDD = dd;

      replayed.push({ ...t, replayPnl: pnl, replayCapital: parseFloat(capital.toFixed(2)) });
    }

    const wins   = replayed.filter(t => (t.pnl || t.profit || 0) > 0);
    const losses = replayed.filter(t => (t.pnl || t.profit || 0) <= 0);
    const winRate = replayed.length ? wins.length / replayed.length : 0;
    const totalPnl = replayed.reduce((s, t) => s + (t.pnl || t.profit || 0), 0);

    const summary = {
      totalTrades:   replayed.length,
      wins:          wins.length,
      losses:        losses.length,
      winRate:       parseFloat((winRate * 100).toFixed(1)),
      totalPnl:      parseFloat(totalPnl.toFixed(2)),
      maxDrawdown:   parseFloat(maxDD.toFixed(2)),
    };

    this.log(`🔄 [Replay] ${replayed.length} trades — P&L: $${totalPnl.toFixed(2)} | WR: ${(winRate*100).toFixed(1)}% | MaxDD: $${maxDD.toFixed(2)}`);
    return { trades: replayed, summary };
  }

  /**
   * What-if: replay with a different SL multiplier.
   * @param {number} slMultiplier  – e.g. 2.0 to double all stop losses
   */
  whatIfSL(slMultiplier) {
    const trades = this.loadTrades();
    this.log(`🔄 [Replay] What-if: SL × ${slMultiplier}`);
    return this.replay(trades, t => {
      if (!t.stopLoss || !t.entryPrice) return t;
      const originalRisk = Math.abs(t.entryPrice - t.stopLoss);
      const newRisk      = originalRisk * slMultiplier;
      // Proportionally adjust pnl (simplified — assumes linear risk scaling)
      const riskRatio    = newRisk / (originalRisk || 1);
      const adjustedPnl  = (t.pnl || t.profit || 0) * riskRatio;
      return { ...t, pnl: parseFloat(adjustedPnl.toFixed(4)), profit: parseFloat(adjustedPnl.toFixed(4)) };
    });
  }

  /**
   * Filter replay to a specific pair.
   * @param {string} pair  – e.g. 'EURUSD'
   */
  filterByPair(pair) {
    const trades = this.loadTrades().filter(t => (t.asset || t.pair || '') === pair);
    this.log(`🔄 [Replay] Filtering to ${pair} — ${trades.length} trades`);
    return this.replay(trades);
  }

  /**
   * Filter replay to a date range.
   * @param {Date} from
   * @param {Date} to
   */
  filterByDate(from, to) {
    const fromTs = from.getTime();
    const toTs   = to.getTime();
    const trades = this.loadTrades().filter(t => {
      // FIX: trade.timestamp is ISO string; convert to ms for numeric comparison
      const ts = t.exitTime || (t.timestamp ? new Date(t.timestamp).getTime() : 0);
      return ts >= fromTs && ts <= toTs;
    });
    this.log(`🔄 [Replay] ${from.toISOString().slice(0,10)} → ${to.toISOString().slice(0,10)} — ${trades.length} trades`);
    return this.replay(trades);
  }
}

module.exports = { TradeReplayer };
