'use strict';
// ── Weekly Trade Report Generator ─────────────────────────────────────────────
// Generates a structured weekly summary of all trades and performance.
// Saved to trade_logs/weekly-report-YYYY-MM-DD.json
// Optionally sent via Telegram as a formatted message.

const fs   = require('fs');
const path = require('path');
const { TRADING_CONFIG } = require('./trading-config');

const LOGS_DIR   = path.join(__dirname, 'trade_logs');
const REPORT_DIR = LOGS_DIR;

class WeeklyReportGenerator {
  constructor({ log = console.log, send = null } = {}) {
    this.log   = log;
    this.send  = send;
    this._lastReportDate = null;
    this._enabled = TRADING_CONFIG.weeklyReportEnabled !== false;
    this._reportDay  = TRADING_CONFIG.weeklyReportDay    ?? 5;   // Friday
    this._reportHour = TRADING_CONFIG.weeklyReportHourUTC ?? 21;
    this._timer      = null;
  }

  /** Start the weekly report scheduler */
  start() {
    if (!this._enabled) return;
    // Check every hour
    this._timer = setInterval(() => this._checkAndGenerate(), 60 * 60 * 1000);
    this.log('📋 [WeeklyReport] Scheduler started');
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _checkAndGenerate() {
    const now  = new Date();
    const day  = now.getUTCDay();
    const hour = now.getUTCHours();
    const dateKey = now.toISOString().slice(0, 10);

    if (day === this._reportDay && hour === this._reportHour && this._lastReportDate !== dateKey) {
      this._lastReportDate = dateKey;
      this.generate().catch(e => this.log(`[WeeklyReport] Error: ${e.message}`));
    }
  }

  /**
   * Generate the weekly report from trade logs.
   * @param {object[]} [trades]   – optional: pass trades directly (for testing)
   * @returns {object} report
   */
  async generate(trades = null) {
    try {
      const allTrades = trades || this._loadTrades();
      const weekAgo   = Date.now() - 7 * 24 * 60 * 60 * 1000;
      // FIX: trade.timestamp is ISO string; convert to ms for comparison. trade.exitTime may not exist.
      const weekTrades = allTrades.filter(t => {
        const ts = t.exitTime || (t.timestamp ? new Date(t.timestamp).getTime() : 0);
        return ts >= weekAgo;
      });

      const report = this._buildReport(weekTrades, allTrades);
      this._saveReport(report);
      this._sendReport(report);
      return report;
    } catch (err) {
      this.log(`[WeeklyReport] Failed: ${err.message}`);
      return null;
    }
  }

  _loadTrades() {
    try {
      const p = path.join(LOGS_DIR, 'trades.jsonl');
      if (!fs.existsSync(p)) return [];
      const lines = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
      return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  _buildReport(weekTrades, allTrades) {
    const wins   = weekTrades.filter(t => (t.pnl || t.profit || 0) > 0);
    const losses = weekTrades.filter(t => (t.pnl || t.profit || 0) <= 0);
    const totalPnl    = weekTrades.reduce((s, t) => s + (t.pnl || t.profit || 0), 0);
    const winRate     = weekTrades.length ? wins.length / weekTrades.length : 0;
    const avgWin      = wins.length    ? wins.reduce((s, t) => s + (t.pnl || t.profit || 0), 0) / wins.length : 0;
    const avgLoss     = losses.length  ? losses.reduce((s, t) => s + (t.pnl || t.profit || 0), 0) / losses.length : 0;
    const profitFactor = Math.abs(avgLoss) > 0 ? (avgWin * wins.length) / Math.abs(avgLoss * losses.length) : null;

    const byPair = {};
    for (const t of weekTrades) {
      const pair = t.asset || t.pair || 'UNKNOWN';
      if (!byPair[pair]) byPair[pair] = { trades: 0, pnl: 0, wins: 0 };
      byPair[pair].trades++;
      byPair[pair].pnl  += (t.pnl || t.profit || 0);
      if ((t.pnl || t.profit || 0) > 0) byPair[pair].wins++;
    }

    const maxDrawdown = this._calcMaxDrawdown(weekTrades);
    const allTimeWins = allTrades.filter(t => (t.pnl || t.profit || 0) > 0).length;
    const allTimeWR   = allTrades.length ? allTimeWins / allTrades.length : 0;

    return {
      generatedAt:   new Date().toISOString(),
      period:        'Last 7 days',
      weekSummary: {
        totalTrades:   weekTrades.length,
        wins:          wins.length,
        losses:        losses.length,
        winRate:       parseFloat((winRate * 100).toFixed(1)),
        totalPnl:      parseFloat(totalPnl.toFixed(2)),
        avgWin:        parseFloat(avgWin.toFixed(2)),
        avgLoss:       parseFloat(avgLoss.toFixed(2)),
        profitFactor:  profitFactor !== null ? parseFloat(profitFactor.toFixed(2)) : null,
        maxDrawdown:   parseFloat(maxDrawdown.toFixed(2)),
      },
      byPair,
      allTimeSummary: {
        totalTrades: allTrades.length,
        winRate:     parseFloat((allTimeWR * 100).toFixed(1)),
      },
    };
  }

  _calcMaxDrawdown(trades) {
    let peak = 0, maxDD = 0, running = 0;
    for (const t of trades) {
      running += (t.pnl || t.profit || 0);
      if (running > peak) peak = running;
      const dd = peak - running;
      if (dd > maxDD) maxDD = dd;
    }
    return maxDD;
  }

  _saveReport(report) {
    const date    = new Date().toISOString().slice(0, 10);
    const outPath = path.join(REPORT_DIR, `weekly-report-${date}.json`);
    try {
      fs.mkdirSync(REPORT_DIR, { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
      this.log(`📋 [WeeklyReport] Saved to ${outPath}`);
    } catch (e) {
      this.log(`[WeeklyReport] Save failed: ${e.message}`);
    }
  }

  _sendReport(report) {
    if (!this.send) return;
    const s = report.weekSummary;
    // FIX 17: Telegram uses HTML parse_mode, not Markdown — use <b> not *
    const msg =
      `📋 <b>Weekly Trading Report</b>\n` +
      `Trades: ${s.totalTrades} | W/L: ${s.wins}/${s.losses} | WR: ${s.winRate}%\n` +
      `P&amp;L: $${s.totalPnl >= 0 ? '+' : ''}${s.totalPnl} | PF: ${s.profitFactor ?? 'N/A'}\n` +
      `MaxDD: $${s.maxDrawdown} | AvgWin: $${s.avgWin} | AvgLoss: $${s.avgLoss}`;
    try { this.send(msg, 'info'); } catch (_) {}
  }
}

module.exports = { WeeklyReportGenerator };
