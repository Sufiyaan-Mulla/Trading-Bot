'use strict';
// ── config-loader.js ──────────────────────────────────────────────────────────
// Loads strategy parameters from config/trading-config.json (YAML/JSON)
// instead of a JS module, so non-developers can edit settings without
// touching code.
//
// Fixes: Config partial — "Store all strategy parameters in YAML/JSON files."
//
// Priority chain:
//   1. config/trading-config.json   (primary, editable without code knowledge)
//   2. trading-config.js            (fallback — existing JS module)
//   3. Built-in safe defaults       (last resort)
//
// Schema validation is performed on load using the same rules as
// config-validator.js (numeric ranges, required fields, type checks).
//
// Usage:
//   const { loadConfig, saveConfig, CONFIG_FILE } = require('./config-loader');
//   const cfg = loadConfig();          // merged, validated config object
//   saveConfig(cfg);                   // write current config back to JSON
//
// The JSON file is the source of truth going forward. Edit it directly or
// via the dashboard. The JS module (trading-config.js) remains as fallback.
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

const CONFIG_DIR  = path.join(__dirname, 'config');
const CONFIG_FILE = path.join(CONFIG_DIR, 'trading-config.json');

// ── Safe defaults ──────────────────────────────────────────────────────────────
const DEFAULTS = {
  positionSize:          0.01,
  stopLoss:              0.02,
  takeProfit:            0.05,
  maxDailyLoss:          0.07,
  minConfidence:         60,
  commission:            0.001,
  slippage:              0.0005,
  kellyEnabled:          true,
  kellyFraction:         0.5,
  kellyMinTrades:        10,
  kellyMaxSize:          0.02,
  kellyMinSize:          0.005,
  trailingStopEnabled:   true,
  trailingStopActivation:0.01,
  trailingStopDistance:  0.005,
  assets:                ['EURUSD','GBPUSD','USDJPY','AUDUSD'],
  tradingInterval:       30000,
};

// ── Schema: field → { type, min, max } ────────────────────────────────────────
const SCHEMA = {
  positionSize:           { type: 'number', min: 0.001,  max: 0.50 },
  stopLoss:               { type: 'number', min: 0.001,  max: 0.20 },
  takeProfit:             { type: 'number', min: 0.001,  max: 0.50 },
  maxDailyLoss:           { type: 'number', min: 0.01,   max: 0.20 },
  minConfidence:          { type: 'number', min: 1,      max: 100  },
  commission:             { type: 'number', min: 0,      max: 0.01 },
  kellyFraction:          { type: 'number', min: 0.1,    max: 1.0  },
  kellyMaxSize:           { type: 'number', min: 0.001,  max: 0.10 },
  kellyMinSize:           { type: 'number', min: 0.001,  max: 0.05 },
  tradingInterval:        { type: 'number', min: 1000,   max: 300000 },
};

// ── Validate a config object — returns array of error strings ─────────────────
function validate(cfg) {
  const errors = [];
  for (const [key, rule] of Object.entries(SCHEMA)) {
    const val = cfg[key];
    if (val === undefined || val === null) continue;   // optional fields can be absent
    if (typeof val !== rule.type) {
      errors.push(`${key}: expected ${rule.type}, got ${typeof val}`);
      continue;
    }
    // Bug fix: NaN passes typeof 'number' — must also guard isFinite
    if (rule.type === 'number' && !isFinite(val)) {
      errors.push(`${key}: value is NaN or Infinity — must be a finite number`);
      continue;
    }
    if (rule.min !== undefined && val < rule.min) errors.push(`${key}: ${val} < min ${rule.min}`);
    if (rule.max !== undefined && val > rule.max) errors.push(`${key}: ${val} > max ${rule.max}`);
  }
  if (cfg.takeProfit <= cfg.stopLoss) {
    errors.push(`takeProfit (${cfg.takeProfit}) must be > stopLoss (${cfg.stopLoss})`);
  }
  if (!Array.isArray(cfg.assets) || cfg.assets.length === 0) {
    errors.push('assets must be a non-empty array');
  } else {
    // Bug fix: duplicate assets caused double position sizing on the same pair
    const dupes = cfg.assets.filter((a, i) => cfg.assets.indexOf(a) !== i);
    if (dupes.length > 0) {
      errors.push(`assets contains duplicates: ${[...new Set(dupes)].join(', ')} — remove them to prevent double sizing`);
    }
    // Also validate each asset is a non-empty string
    const bad = cfg.assets.filter(a => typeof a !== 'string' || !a.trim());
    if (bad.length > 0) errors.push(`assets contains invalid entries: ${JSON.stringify(bad)}`);
  }
  return errors;
}

// ── Load config ───────────────────────────────────────────────────────────────
function loadConfig() {
  // Step 1: start with defaults
  let cfg = { ...DEFAULTS };

  // Step 2: overlay JS module (existing trading-config.js)
  try {
    const jsConfig = require('./trading-config').TRADING_CONFIG;
    cfg = { ...cfg, ...jsConfig };
  } catch (_) {}

  // Step 3: overlay JSON file (takes precedence over JS module)
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const raw  = fs.readFileSync(CONFIG_FILE, 'utf8');
      const json = JSON.parse(raw);
      cfg = { ...cfg, ...json };
      console.log('[ConfigLoader] Loaded JSON config from ' + CONFIG_FILE);
    } catch (e) {
      console.warn('[ConfigLoader] JSON parse error — using JS module fallback:', e.message);
    }
  } else {
    // First run: write the JS config out as JSON for future editing
    _initJsonFile(cfg);
  }

  // Step 4: validate merged config
  const errors = validate(cfg);
  if (errors.length) {
    console.warn('[ConfigLoader] Validation warnings:\n' + errors.map(e => '  • ' + e).join('\n'));
  }

  return cfg;
}

// ── Save config back to JSON file ─────────────────────────────────────────────
function saveConfig(cfg) {
  const errors = validate(cfg);
  if (errors.length) throw new Error('Config invalid:\n' + errors.join('\n'));
  _ensureDir();
  // Write atomically via tmp file
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
  console.log('[ConfigLoader] Saved config to ' + CONFIG_FILE);
}

// ── Patch a subset of keys in the JSON file ───────────────────────────────────
function patchConfig(patch) {
  const current = loadConfig();
  const merged  = { ...current, ...patch };
  saveConfig(merged);
  return merged;
}

// ── Internal helpers ──────────────────────────────────────────────────────────
function _ensureDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function _initJsonFile(cfg) {
  try {
    _ensureDir();
    // Only write safe/non-secret fields
    const safeKeys = Object.keys(DEFAULTS);
    const safeObj  = {};
    for (const k of safeKeys) if (cfg[k] !== undefined) safeObj[k] = cfg[k];
    safeObj._comment = 'Edit this file to change strategy parameters. Restart to apply, or use hot-reload for supported keys.';
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(safeObj, null, 2));
    console.log('[ConfigLoader] Initialised ' + CONFIG_FILE);
  } catch (_) {}
}

module.exports = { loadConfig, saveConfig, patchConfig, validate, CONFIG_FILE, DEFAULTS, SCHEMA };
