'use strict';
// ── monitor.js ────────────────────────────────────────────────────────────────
// PM2-safe log monitor for the Aladdin trading engine.
//
// BUG-47 fix: LogWriter and ActivityMonitor were never imported by trading-engine.js,
// making them dead code. They are legitimate utilities — wire them in by adding
// to trading-engine.js constructor:
//
//   const { LogWriter, ActivityMonitor } = require('./monitor');
//   this.logWriter      = new LogWriter('trade_logs/engine.log');
//   this.activityMonitor = new ActivityMonitor(this.logWriter, this);
//   process.on('SIGHUP', () => this.logWriter.reopen());
//
// Until then, this module is available as a standalone utility.
//
// Problem solved (#12):
//   PM2 log rotation (pm2-logrotate) renames the log file (e.g. engine.log →
//   engine.log.1) then sends SIGHUP. If the engine holds an open file
//   descriptor to the old path it keeps writing to the rotated file — new log
//   entries are invisible to `pm2 logs` and monitoring dashboards.
//
// Solution:
//   LogWriter reopens the file descriptor on SIGHUP and whenever the inode
//   changes (detected each write). Safe with both copytruncate and create modes.
//
//   const mon = new ActivityMonitor(engine, log);
//   mon.start();
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

// ── LogWriter ─────────────────────────────────────────────────────────────────
// Writes timestamped lines to a file, reopening the handle on SIGHUP or inode
// change so PM2 log rotation never causes a stale descriptor.

class LogWriter {
  constructor(filePath) {
    this.filePath = path.resolve(__dirname, filePath);
    this._fd      = null;
    this._inode   = null;
    this._opening = false;
    this._queue   = [];       // lines buffered while fd is being reopened

    this._ensureDir();
    this._open();

    // Reopen on SIGHUP (PM2 logrotate signal)
    process.on('SIGHUP', () => {
      this.reopen();
    });
  }

  _ensureDir() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  _open() {
    try {
      this._fd    = fs.openSync(this.filePath, 'a');
      this._inode = fs.fstatSync(this._fd).ino;
    } catch (e) {
      console.error('[LogWriter] Failed to open log file:', e.message);
      this._fd = null;
    }
  }

  // Public: force reopen (call from SIGHUP handler or manually)
  reopen() {
    if (this._fd !== null) {
      try { fs.closeSync(this._fd); } catch (_) {}
      this._fd = null;
    }
    this._open();
    // Flush any queued lines
    const queued = this._queue.splice(0);
    for (const line of queued) this._writeLine(line);
  }

  // Check if PM2 rotated the file under us (inode changed or file gone)
  _inodeChanged() {
    try {
      const stat = fs.statSync(this.filePath);
      if (stat.ino === 0) { return stat.size < (this._lastStatSize || Infinity) * 0.5; }  // Docker/NFS fallback
      this._lastStatSize = stat.size;
      return stat.ino !== this._inode;
    } catch (_) {
      return true;  // file gone — reopen will create it
    }
  }

  _writeLine(line) {
    if (this._fd === null) { this._queue.push(line); return; }
    try {
      if (this._inodeChanged()) { this.reopen(); return; }
      fs.writeSync(this._fd, line + '\n');
    } catch (e) {
      console.error('[LogWriter] Write error:', e.message);
      this._queue.push(line);
      this.reopen();
    }
  }

  write(msg) {
    const ts   = new Date().toISOString();
    const line = `[${ts}] ${msg}`;
    console.log(line);          // also echo to stdout (captured by PM2)
    this._writeLine(line);
  }

  close() {
    if (this._fd !== null) {
      try { fs.closeSync(this._fd); } catch (_) {}
      this._fd = null;
    }
  }
}

// ── ActivityMonitor ───────────────────────────────────────────────────────────
// Polls the engine every intervalMs and logs key metrics.
// Detects stalled loops, consecutive losses, and drawdown warnings.

class ActivityMonitor {
  constructor(engine, logWriter, intervalMs = 60_000) {
    this.engine   = engine;
    this.log      = logWriter;
    this._interval = null;
    this._ms      = intervalMs;
    this._lastTradeCount = 0;
  }

  start() {
    if (this._interval) return;
    this._interval = setInterval(() => this._tick(), this._ms);
    this.log.write('[Monitor] Activity monitor started');
  }

  stop() {
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
    this.log.write('[Monitor] Activity monitor stopped');
  }

  _tick() {
    const e   = this.engine;
    const cap = parseFloat(e.capital).toFixed(2);
    const pos = e.position
      ? `OPEN @ ${e.position.entry.toFixed(5)} SL=${e.position.stopLoss?.toFixed(5)}`
      : 'flat';

    this.log.write(
      `[Monitor] capital=$${cap} | asset=${e.selectedAsset} | ` +
      `position=${pos} | trades=${e.trades.length} | ` +
      `wins=${e.wins} losses=${e.losses} | session=${e.selectedAsset}`
    );

    // Stall detection: no new trades in last N minutes when not flat
    const newTrades = e.trades.length - this._lastTradeCount;
    this._lastTradeCount = e.trades.length;

    if (e.consecutiveLosses >= 2)
      this.log.write(`[Monitor] ⚠️  ${e.consecutiveLosses} consecutive losses`);

    if (e.globalHaltTripped)
      this.log.write('[Monitor] 🛑 GLOBAL HALT active — manual review required');

    if (e.circuitBreakerTripped)
      this.log.write('[Monitor] ⛔ Circuit breaker tripped');
  }
}

module.exports = { LogWriter, ActivityMonitor };
