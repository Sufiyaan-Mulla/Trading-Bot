'use strict';
// ── Time-of-Day Performance Heatmap ──────────────────────────────────────────
// Tracks win rate, avg P&L, and trade count for every UTC hour (0–23).
// After enough data, identifies the best and worst hours to trade.
// Optionally blocks entries during statistically bad hours.

const fs   = require('fs');
const path = require('path');
const { TRADING_CONFIG } = require('./trading-config');

const PERSIST_PATH = path.join(__dirname, 'trade_logs', 'tod-heatmap.json');
const MIN_TRADES_TO_BLOCK = 10;  // need at least 10 trades before blocking an hour

class TODHeatmap {
  constructor({ log = console.log } = {}) {
    this.log = log;
    // hours[0..23] → { trades, wins, totalPnl }
    this._hours = Array.from({ length: 24 }, () => ({ trades: 0, wins: 0, totalPnl: 0 }));
    this._load();
  }

  /**
   * Record a completed trade.
   * @param {number} entryTimestamp  ms timestamp of trade entry
   * @param {number} pnl             trade P&L (positive=win)
   */
  record(entryTimestamp, pnl) {
    const hour = new Date(entryTimestamp).getUTCHours();
    const slot = this._hours[hour];
    slot.trades++;
    slot.totalPnl += pnl;
    if (pnl > 0) slot.wins++;
    this._save();
  }

  /**
   * Check if the current UTC hour is a blocked (bad) trading hour.
   * Returns false if not enough data to make a decision.
   * @param {number} [nowMs]  override for testing
   * @returns {{ allowed: boolean, hour: number, winRate: number|null, reason?: string }}
   */
  check(nowMs = Date.now()) {
    if (!TRADING_CONFIG.todHeatmapBlockEnabled) return { allowed: true, hour: -1, winRate: null };

    const hour = new Date(nowMs).getUTCHours();
    const slot = this._hours[hour];
    if (slot.trades < MIN_TRADES_TO_BLOCK) {
      return { allowed: true, hour, winRate: null, reason: 'insufficient_data' };
    }

    const winRate = slot.wins / slot.trades;
    const threshold = TRADING_CONFIG.todHeatmapBlockThreshold || 0.35;
    if (winRate < threshold) {
      const reason = `TOD block: hour ${hour}:00 UTC win rate ${(winRate*100).toFixed(0)}% < ${(threshold*100).toFixed(0)}% (${slot.trades} trades)`;
      this.log(`🕐 [TODHeatmap] ${reason}`);
      return { allowed: false, hour, winRate: parseFloat(winRate.toFixed(3)), reason };
    }
    return { allowed: true, hour, winRate: parseFloat(winRate.toFixed(3)) };
  }

  /** Full heatmap data — 24 hours */
  getHeatmap() {
    return this._hours.map((slot, hour) => ({
      hour,
      label:   `${String(hour).padStart(2,'0')}:00 UTC`,
      trades:  slot.trades,
      wins:    slot.wins,
      losses:  slot.trades - slot.wins,
      winRate: slot.trades > 0 ? parseFloat((slot.wins / slot.trades).toFixed(3)) : null,
      avgPnl:  slot.trades > 0 ? parseFloat((slot.totalPnl / slot.trades).toFixed(2)) : null,
      totalPnl: parseFloat(slot.totalPnl.toFixed(2)),
    }));
  }

  /** Best N hours by win rate (minimum trades required) */
  bestHours(n = 5, minTrades = 5) {
    return this.getHeatmap()
      .filter(h => h.trades >= minTrades && h.winRate !== null)
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, n);
  }

  /** Worst N hours by win rate (minimum trades required) */
  worstHours(n = 5, minTrades = 5) {
    return this.getHeatmap()
      .filter(h => h.trades >= minTrades && h.winRate !== null)
      .sort((a, b) => a.winRate - b.winRate)
      .slice(0, n);
  }

  /** Human-readable summary string */
  summary() {
    const best  = this.bestHours(3);
    const worst = this.worstHours(3);
    const total = this._hours.reduce((s, h) => s + h.trades, 0);
    if (total === 0) return 'No data yet';

    const fmtHour = h => `${h.label} (${(h.winRate*100).toFixed(0)}% WR, ${h.trades}t)`;
    return [
      `📊 TOD Heatmap — ${total} trades`,
      `  Best:  ${best.map(fmtHour).join(' | ')}`,
      `  Worst: ${worst.map(fmtHour).join(' | ')}`,
    ].join('\n');
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(PERSIST_PATH), { recursive: true });
      fs.writeFileSync(PERSIST_PATH, JSON.stringify(this._hours));
    } catch (_) {}
  }

  _load() {
    try {
      if (fs.existsSync(PERSIST_PATH)) {
        const data = JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf8'));
        if (Array.isArray(data) && data.length === 24) this._hours = data;
      }
    } catch (_) {}
  }

  reset() {
    this._hours = Array.from({ length: 24 }, () => ({ trades: 0, wins: 0, totalPnl: 0 }));
    this._save();
  }
}

module.exports = { TODHeatmap };
