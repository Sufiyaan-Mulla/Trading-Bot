'use strict';
// ── Log Pruner ────────────────────────────────────────────────────────────────
// Prevents trade_logs/*.jsonl files from growing unbounded.
// Runs on a schedule (default: daily) and trims JSONL files to a max line count,
// keeping the most recent entries. Also deletes stale daily drift-halt files.

const fs   = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, 'trade_logs');

const DEFAULTS = {
  'trades.jsonl':           50_000,
  'trades-immutable.jsonl': 50_000,
  'audit.jsonl':            100_000,
  'timeseries.jsonl':       20_000,
  'orders.jsonl':           10_000,
  'decisions.ndjson':       10_000,
};

const STALE_DAYS = 30;   // delete drift-halt files older than this

class LogPruner {
  constructor({ log = console.log } = {}) {
    this.log    = log;
    this._timer = null;
  }

  /** Start scheduled pruning (default: every 24h) */
  start(intervalMs = 24 * 60 * 60 * 1000) {
    this.prune();  // run immediately on start
    this._timer = setInterval(() => this.prune(), intervalMs);
    this._timer.unref?.();  // don't prevent process exit
    this.log('🧹 [LogPruner] Scheduled — runs every 24h');
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  /** Run all pruning tasks */
  prune() {
    let totalRemoved = 0;
    totalRemoved += this._pruneJSONL();
    totalRemoved += this._pruneStaleFiles();
    if (totalRemoved > 0) this.log(`🧹 [LogPruner] Done — removed ${totalRemoved} lines/files`);
    return totalRemoved;
  }

  /** Trim JSONL files to max line counts */
  _pruneJSONL() {
    let removed = 0;
    for (const [filename, maxLines] of Object.entries(DEFAULTS)) {
      const filePath = path.join(LOGS_DIR, filename);
      try {
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, 'utf8');
        const lines   = content.split('\n').filter(l => l.trim());
        if (lines.length <= maxLines) continue;

        const keep = lines.slice(-maxLines);
        fs.writeFileSync(filePath, keep.join('\n') + '\n');
        const trimmed = lines.length - keep.length;
        removed += trimmed;
        this.log(`🧹 [LogPruner] ${filename}: trimmed ${trimmed} old lines (kept ${keep.length})`);
      } catch (err) {
        this.log(`🧹 [LogPruner] ${filename}: error — ${err.message}`);
      }
    }
    return removed;
  }

  /** Delete stale drift-halt and weekly-report files */
  _pruneStaleFiles() {
    let removed = 0;
    try {
      const files = fs.readdirSync(LOGS_DIR);
      const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (!file.match(/^(drift-halt|weekly-report)-\d{4}-\d{2}-\d{2}\.json$/)) continue;
        const filePath = path.join(LOGS_DIR, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(filePath);
            removed++;
            this.log(`🧹 [LogPruner] Deleted stale file: ${file}`);
          }
        } catch (_) {}
      }
    } catch (_) {}
    return removed;
  }

  /** Return current sizes of tracked log files */
  fileSizes() {
    const result = {};
    for (const filename of Object.keys(DEFAULTS)) {
      const filePath = path.join(LOGS_DIR, filename);
      try {
        if (!fs.existsSync(filePath)) { result[filename] = null; continue; }
        const stat  = fs.statSync(filePath);
        const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(l => l.trim()).length;
        result[filename] = { bytes: stat.size, lines, maxLines: DEFAULTS[filename] };
      } catch { result[filename] = null; }
    }
    return result;
  }
}

module.exports = { LogPruner };
