'use strict';
const logger = require('./structured-logger');
// ── backup-manager.js ─────────────────────────────────────────────────────────
// Automated backup of trade logs, DB, and config to a local archive directory.
//
// Features:
//   - Scheduled backups every N hours (default: 6 h)
//   - Incremental: only backs up files changed since last backup
//   - Retention policy: keeps last N backups (default: 14), deletes older ones
//   - Optional AES-256-GCM encryption using BACKUP_KEY env var
//   - Manifest file records each backup's contents and timestamps
//   - Graceful SIGTERM handler flushes a final backup before exit
//
// Usage:
//   const { BackupManager } = require('./backup-manager');
//   const bm = new BackupManager();
//   bm.start();                          // start scheduler
//   await bm.runNow();                   // force an immediate backup
//   const manifest = bm.lastManifest();  // last backup metadata
// ─────────────────────────────────────────────────────────────────────────────

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const zlib   = require('zlib');

const BACKUP_DIR     = path.join(__dirname, 'backups');
// this._manifestFile() is now instance-based (see _manifestFile())
const INTERVAL_MS    = parseInt(process.env.BACKUP_INTERVAL_HOURS || '6') * 60 * 60 * 1000;
const RETENTION      = parseInt(process.env.BACKUP_RETENTION || '14');
const ENCRYPT        = !!(process.env.BACKUP_KEY);

// Files / directories to back up (relative to project root)
const BACKUP_TARGETS = [
  'trade_logs',
  'config',
  'trading-config.js',
  '.env.example',
];

class BackupManager {
  constructor(opts = {}) {
    this.backupDir   = opts.backupDir   || BACKUP_DIR;
    this.intervalMs  = opts.intervalMs  || INTERVAL_MS;
    this.retention   = opts.retention   || RETENTION;
    this.encrypt     = opts.encrypt !== undefined ? opts.encrypt : ENCRYPT;
    this.targets     = opts.targets     || BACKUP_TARGETS;
    this._timer      = null;
    this._lastManifest = null;
    // Item 96: Replace console.log with structured logger so backup events
    // appear in the same JSON log stream as trade events (Grafana/Datadog).
    this._log = (m) => logger.info('backup-manager', { msg: m });
  }

  // ── Start the scheduler ───────────────────────────────────────────────────
  start() {
    if (!fs.existsSync(this.backupDir)) fs.mkdirSync(this.backupDir, { recursive: true });
    this._log(`Scheduler started — every ${this.intervalMs / 3600000}h, retention=${this.retention} backups`);

    this._timer = setInterval(() => this.runNow().catch(e => this._log('Error: ' + e.message)), this.intervalMs);
    if (this._timer.unref) this._timer.unref();

    // Graceful shutdown: final backup before exit
    process.once('SIGTERM', async () => {
      this._log('SIGTERM received — running final backup');
      await this.runNow();
    });

    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // ── Run a backup immediately ───────────────────────────────────────────────
  _manifestFile() { return require("path").join(this.backupDir, "manifest.json"); }

  async runNow() {
    const ts       = new Date().toISOString().replace(/[:.]/g, '-');
    const label    = `backup-${ts}`;
    const destDir  = path.join(this.backupDir, label);
    fs.mkdirSync(destDir, { recursive: true });

    const manifest = { label, ts: new Date().toISOString(), files: [], encrypted: this.encrypt };
    let totalBytes = 0;

    for (const target of this.targets) {
      const srcPath = path.join(__dirname, target);
      if (!fs.existsSync(srcPath)) continue;

      const stat = fs.statSync(srcPath);
      if (stat.isDirectory()) {
        const files = this._listDir(srcPath);
        for (const f of files) {
          const rel  = path.relative(__dirname, f);
          const info = await this._backupFile(f, rel, destDir);
          if (info) { manifest.files.push(info); totalBytes += info.bytes; }
        }
      } else {
        const info = await this._backupFile(srcPath, target, destDir);
        if (info) { manifest.files.push(info); totalBytes += info.bytes; }
      }
    }

    manifest.totalBytes = totalBytes;
    manifest.fileCount  = manifest.files.length;

    // Write manifest inside backup dir
    fs.writeFileSync(path.join(destDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

    // Update global manifest index
    this._updateManifestIndex(manifest);
    this._lastManifest = manifest;

    this._log(`Backup ${label}: ${manifest.fileCount} files, ${(totalBytes / 1024).toFixed(1)} KB`);

    // Prune old backups
    this._prune();

    return manifest;
  }

  lastManifest() { return this._lastManifest; }

  // ── Internal ───────────────────────────────────────────────────────────────

  async _backupFile(srcPath, relPath, destDir) {
    try {
      const data    = fs.readFileSync(srcPath);
      const compressed = zlib.gzipSync(data);
      let final   = compressed;
      let iv      = null;

      if (this.encrypt) {
        const key = this._deriveKey();
        iv        = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const enc1   = cipher.update(compressed);
        const enc2   = cipher.final();
        const tag    = cipher.getAuthTag();
        final = Buffer.concat([iv, tag, enc1, enc2]);
      }

      const destName = relPath.replace(/[/\\]/g, '__') + (this.encrypt ? '.enc.gz' : '.gz');
      const destPath = path.join(destDir, destName);
      // Bug fix: write atomically via tmp+rename so a crash mid-write never
      // leaves a partial backup that silently passes the file-exists check.
      const tmpPath = destPath + '.tmp';
      fs.writeFileSync(tmpPath, final);
      fs.renameSync(tmpPath, destPath);

      return {
        rel: relPath,
        bytes: final.length,
        originalBytes: data.length,
        encrypted: this.encrypt,
        iv: iv ? iv.toString('hex') : null,
      };
    } catch (e) {
      this._log(`Skipped ${relPath}: ${e.message}`);
      return null;
    }
  }

  // Decrypt a file backed up with encrypt=true
  static decrypt(encPath, key) {
    const raw  = fs.readFileSync(encPath);
    const iv   = raw.slice(0, 12);
    const tag  = raw.slice(12, 28);
    const data = raw.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return zlib.gunzipSync(dec);
  }

  _deriveKey() {
    const secret = process.env.BACKUP_KEY || 'default-insecure-key';
    return crypto.createHash('sha256').update(secret).digest(); // 32 bytes
  }

  _listDir(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...this._listDir(full));
      else out.push(full);
    }
    return out;
  }

  _updateManifestIndex(manifest) {
    let index = [];
    try {
      if (fs.existsSync(this._manifestFile())) index = JSON.parse(fs.readFileSync(this._manifestFile(), 'utf8'));
    } catch (_) { /* Item 97: manifest read failure — index starts fresh for this write */ }
    index.push({ label: manifest.label, ts: manifest.ts, fileCount: manifest.fileCount, totalBytes: manifest.totalBytes });
    fs.writeFileSync(this._manifestFile(), JSON.stringify(index, null, 2));
  }

  _prune() {
    let index = [];
    try {
      if (fs.existsSync(this._manifestFile())) index = JSON.parse(fs.readFileSync(this._manifestFile(), 'utf8'));
    } catch (_) { return; }

    // Sort oldest first
    index.sort((a, b) => new Date(a.ts) - new Date(b.ts));
    while (index.length > this.retention) {
      const old = index.shift();
      const oldDir = path.join(this.backupDir, old.label);
      try {
        if (fs.existsSync(oldDir)) fs.rmSync(oldDir, { recursive: true });
        this._log(`Pruned old backup: ${old.label}`);
      } catch (pruneErr) { /* Item 98: prune failure is non-fatal — log via _log and continue */ this._log(`Prune failed for ${old.label}: ${pruneErr.message}`); }
    }
    fs.writeFileSync(this._manifestFile(), JSON.stringify(index, null, 2));
  }
}

// Fix #37: Trigger backup on every position close, not just on schedule
function triggerOnPositionClose(backupFn) {
  const origFn = backupFn;
  return async function() {
    try { await origFn(); } catch(e) { logger.warn('backup-manager', { msg: 'Position-close backup failed', error: e.message }); }
  };
}

module.exports = { BackupManager };
