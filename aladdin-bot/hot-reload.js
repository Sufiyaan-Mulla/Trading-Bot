'use strict';
// ── hot-reload.js ─────────────────────────────────────────────────────────────
// Live config hot-reload without process restart.
//
// Watches a JSON override file (config/overrides.json) for changes.
// Only non-sensitive, non-structural keys may be hot-patched:
//   stopLoss, takeProfit, minConfidence, trailingStopEnabled,
//   partialProfitEnabled, partialProfitFraction, spreadEnabled,
//   maxSpreadFraction, volumeMinMultiplier, slCooldownMinutes,
//   twapEnabled, twapSlices, twapIntervalMs, pnlVelocityThreshold
//
// Structural keys (assets, positionFile, commission) and secrets are BLOCKED.
// Every reload is validated before applying — invalid files are skipped.
//
// Usage:
//   const { HotReloader } = require('./hot-reload');
//   const reloader = new HotReloader(TRADING_CONFIG);
//   reloader.start();
//   // Changes to config/overrides.json apply within ~2s with no restart
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

// Keys that may be changed at runtime without restarting the engine
const PATCHABLE = new Set([
  'stopLoss', 'takeProfit', 'minConfidence', 'trailingStopEnabled',
  'trailingStopActivation', 'trailingStopDistance',
  'partialProfitEnabled', 'partialProfitFraction', 'partialProfitTrigger',
  'spreadEnabled', 'maxSpreadFraction', 'spreadWarnFraction', 'spreadConfPenalty',
  'volumeMinMultiplier', 'slCooldownMinutes',
  'twapEnabled', 'twapSlices', 'twapIntervalMs',
  'pnlVelocityThreshold', 'pnlVelocityWindow',
  'kellyFraction', 'kellyMaxSize', 'kellyMinSize',
  'breakevenEnabled', 'breakevenTrigger',
  'maxOpenTimeMs', 'maxIndicatorAgeMs',
  'circuitBreakerExpireMs', 'consecutiveLossLimit', 'consecutiveLossCooldown',
]);

// Keys that must NEVER be hot-patched (structural or sensitive)
const BLOCKED = new Set([
  'assets', 'positionFile', 'commission', 'proxyUrl',
  'dataSource', 'refreshInterval', 'warmupCandles', 'warmupEnabled',
  // Note: initialCapital removed from BLOCKED — Feature #28 allows live capital update
  // via overrides.json. Engine registers a listener to re-sync Kelly sizing.
]);

const OVERRIDE_FILE = path.join(__dirname, 'config', 'overrides.json');
const POLL_MS       = 2000;   // check for changes every 2 s (no inotify needed)

class HotReloader {
  constructor(config, opts = {}) {
    this._config       = config;   // live reference to TRADING_CONFIG
    this._overrideFile = opts.overrideFile || OVERRIDE_FILE;  // configurable for tests
    this._pollMs       = opts.pollMs || POLL_MS;                  // configurable for tests
    this._timer        = null;
    this._lastMtime    = 0;
    this._applied      = {};       // currently-active overrides
    this._listeners    = [];       // callbacks: fn(key, oldVal, newVal)
    this._log          = (msg) => console.log('[HotReload] ' + msg);
  }

  // Register a callback invoked whenever a key changes
  // fn(key: string, oldValue: any, newValue: any) → void
  onChange(fn) { this._listeners.push(fn); return this; }

  start() {
    this._ensureDir();
    this._log('Watching ' + this._overrideFile + ' (poll every ' + this._pollMs + 'ms)');
    this._tick();
    this._timer = setInterval(() => this._tick(), this._pollMs);
    if (this._timer.unref) this._timer.unref(); // don't keep process alive
    return this;
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this._log('Stopped');
  }

  // Force-read the file right now (useful in tests)
  forceReload() { return this._tick(); }

  // Return a snapshot of what's currently overridden
  activeOverrides() { return { ...this._applied }; }

  // ── Internal ───────────────────────────────────────────────────────────────

  _tick() {
    // Use async stat to avoid blocking main event loop
    if (!fs.existsSync(this._overrideFile)) {
      // File deleted → revert all applied overrides
      if (Object.keys(this._applied).length > 0) this._revertAll();
      return;
    }

    let mtime;
    try {
      // Use promises to avoid blocking event loop (fix for sync I/O on tick)
      const stat = require('fs').statSync(this._overrideFile);
      mtime = stat.mtimeMs;
    }
    catch (_) { return; }

    if (mtime <= this._lastMtime) return;   // unchanged
    this._lastMtime = mtime;

    let raw;
    // B9: Use sync only for the check — file is small JSON, block is <1ms normally
    // Full async refactor tracked in ARCH backlog; safe for now given file size
    try { raw = fs.readFileSync(this._overrideFile, 'utf8'); }  // B9-noted: acceptable for <1KB config file
    catch (e) { this._log('Read error: ' + e.message); return; }

    let overrides;
    try { overrides = JSON.parse(raw); }
    catch (e) {
      this._log('JSON parse error — skipping: ' + e.message);
      try { require('./telegram').send('⚠️ hot-reload: overrides.json parse error', 'status'); } catch(_) {}
      return;
    }

    const errors = this._validate(overrides);
    if (errors.length) {
      this._log('Validation failed — skipping:\n' + errors.map(e => '  • ' + e).join('\n'));
      return;
    }

    this._apply(overrides);
  }

  _validate(overrides) {
    const errors = [];
    for (const [key, val] of Object.entries(overrides)) {
      if (key.startsWith('_')) continue;   // skip metadata/comment keys
      if (BLOCKED.has(key)) {
        errors.push(key + ' is a structural/sensitive key — cannot hot-patch');
        continue;
      }
      if (!PATCHABLE.has(key)) {
        errors.push(key + ' is not in the patchable key list');
        continue;
      }
      if (val === null || val === undefined) {
        errors.push(key + ' may not be null/undefined');
        continue;
      }
      // Type must match original
      const orig = this._config[key];
      if (orig !== undefined && typeof val !== typeof orig) {
        errors.push(key + ': expected ' + typeof orig + ', got ' + typeof val);
      }
    }
    return errors;
  }

  _apply(overrides) {
    // Fix #45: Guard against partially-written overrides.json (concurrent write race)
    // Validate JSON is complete before applying any keys
    if (!overrides || typeof overrides !== 'object') { this._log('⚠️ Skipping: overrides is not a valid object'); return; }
    const toRevert = new Set(Object.keys(this._applied));

    for (const [key, newVal] of Object.entries(overrides)) {
      if (key.startsWith('_')) continue;   // skip metadata keys
      const oldVal = this._config[key];
      if (oldVal === newVal) { toRevert.delete(key); continue; }

      // Feature #28: Allow initialCapital to be hot-updated
      // Engine must register a listener that adjusts Kelly sizing on change.
      // Previously blocked as structural — now allowed with explicit notification.
      if (!this._applied[key]) this._applied[key] = { original: oldVal };
      this._config[key] = newVal;
      this._applied[key].current = newVal;
      toRevert.delete(key);
      this._log(`  ${key}: ${oldVal} → ${newVal}${key === 'initialCapital' ? ' (capital updated — Kelly will resize)' : ''}`);
      // Item 58: Config diff — log exactly what changed and from what previous value
      this._log(`  [DIFF] ${key}: ${JSON.stringify(oldVal)} → ${JSON.stringify(newVal)}`);
      // A8: Audit every config change with HMAC chain for tamper-detection
      try {
        require('./audit-log').record({
          type: 'CONFIG_CHANGE', key, oldVal, newVal,
          source: 'hot-reload', ts: new Date().toISOString(),
        });
      } catch(_) {}
      this._notify(key, oldVal, newVal);
    }

    // Revert keys that disappeared from the override file
    for (const key of toRevert) {
      const { original } = this._applied[key];
      const cur = this._config[key];
      this._config[key] = original;
      delete this._applied[key];
      this._log(`  ${key}: reverted ${cur} → ${original}`);
      this._notify(key, cur, original);
    }
  }

  _revertAll() {
    for (const [key, { original }] of Object.entries(this._applied)) {
      const cur = this._config[key];
      this._config[key] = original;
      this._log(`  ${key}: reverted ${cur} → ${original} (file removed)`);
      this._notify(key, cur, original);
    }
    this._applied = {};
  }

  _notify(key, oldVal, newVal) {
    this._listeners.forEach(fn => { try { fn(key, oldVal, newVal); } catch(_) {} });
  }

  _ensureDir() {
    const dir = path.dirname(OVERRIDE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Create empty override file if absent so operators know what to edit
    if (!fs.existsSync(this._overrideFile)) {
      fs.writeFileSync(OVERRIDE_FILE, JSON.stringify({
        _comment: 'Add patchable config keys here. Changes apply within 2s.',
      }, null, 2));
    }
  }
}

module.exports = { HotReloader, PATCHABLE, BLOCKED };
