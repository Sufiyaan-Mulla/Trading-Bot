'use strict';
// ── config-validator.js ───────────────────────────────────────────────────────
// Validates TRADING_CONFIG and environment on startup.
// Fails fast with a clear error rather than surfacing bad config mid-trade.
//
// Usage (called in TradingEngine constructor):
//   const { validateConfig } = require('./config-validator');
//   validateConfig();  // throws ConfigError if invalid

const { TRADING_CONFIG } = require('./trading-config');
const { SAFETY }         = require('./safety-constants');

class ConfigError extends Error {
  constructor(issues) {
    super('Config validation failed:\n' + issues.map(i => '  • ' + i).join('\n'));
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

function validateConfig() {
  const issues = [];
  const warn   = [];

  // Feature #41: Schema version check
  const CONFIG_SCHEMA_VERSION = 1;
  const fileVersion = TRADING_CONFIG.schemaVersion;
  if (fileVersion == null) {
    warn.push('config schemaVersion missing — add "schemaVersion": ' + CONFIG_SCHEMA_VERSION + ' to trading-config.json');
  } else if (typeof fileVersion !== 'number' || fileVersion !== CONFIG_SCHEMA_VERSION) {
    issues.push(
      'Config schemaVersion ' + fileVersion + ' does not match expected ' + CONFIG_SCHEMA_VERSION +
      '. Migrate config or update CONFIG_SCHEMA_VERSION in config-validator.js'
    );
  }

  // ── Numeric range checks ─────────────────────────────────────────────────
  const numRange = (key, obj, min, max, label) => {
    const v = obj[key];
    if (v == null || typeof v !== 'number' || isNaN(v)) {
      issues.push((label||key) + ' must be a number, got: ' + v);
    } else if (v < min || v > max) {
      issues.push((label||key) + ' must be ' + min + '–' + max + ', got: ' + v);
    }
  };

  numRange('minConfidence',      TRADING_CONFIG, 1, 100,  'minConfidence');
  numRange('stopLoss',           TRADING_CONFIG, 0.001, 0.20, 'stopLoss');
  numRange('takeProfit',         TRADING_CONFIG, 0.001, 0.50, 'takeProfit');
  numRange('positionSize',       TRADING_CONFIG, 0.001, 0.50, 'positionSize');
  numRange('commission',         TRADING_CONFIG, 0, 0.01,     'commission');
  numRange('maxOpenTimeMs',      TRADING_CONFIG, 60_000, 30*24*3600_000, 'maxOpenTimeMs');
  numRange('maxIndicatorAgeMs',  TRADING_CONFIG, 1_000, 3600_000, 'maxIndicatorAgeMs');
  numRange('slCooldownMinutes',  TRADING_CONFIG, 0, 1440, 'slCooldownMinutes');
  numRange('volumeMinMultiplier',TRADING_CONFIG, 0.5, 5.0, 'volumeMinMultiplier');
  numRange('maxAssetDrawdown',   TRADING_CONFIG, 0.01, 0.50, 'maxAssetDrawdown');

  numRange('MAX_POSITION_SIZE',  SAFETY, 0.001, 0.50, 'SAFETY.MAX_POSITION_SIZE');
  numRange('MIN_AI_CONFIDENCE',  SAFETY, 1, 100,      'SAFETY.MIN_AI_CONFIDENCE');

  // ── TWAP config validation (BUG-07 fix) ───────────────────────────────────
  numRange('twapThreshold',  TRADING_CONFIG, 100, 1_000_000, 'twapThreshold');
  numRange('twapSlices',     TRADING_CONFIG, 2, 20,          'twapSlices');
  numRange('twapIntervalMs', TRADING_CONFIG, 500, 300_000,   'twapIntervalMs');
  // Detect if threshold looks like the duplicate override (500) instead of intended (2000)
  if (TRADING_CONFIG.twapEnabled && TRADING_CONFIG.twapThreshold < 1000) {
    warn.push('twapThreshold is ' + TRADING_CONFIG.twapThreshold + ' which is very low — TWAP will fire on almost every order. Intended value is likely 2000.');
  }

  // ── Logical consistency ───────────────────────────────────────────────────
  const tp = TRADING_CONFIG.takeProfit;
  const sl = TRADING_CONFIG.stopLoss;
  if (sl != null && tp != null && !isNaN(sl) && !isNaN(tp) && tp <= sl) {
    issues.push('takeProfit (' + tp + ') must be > stopLoss (' + sl + ')');
  }

  // Cross-validate positionSize vs kellyMaxSize — fixed fallback must not exceed Kelly cap
  const ps = TRADING_CONFIG.positionSize, km = TRADING_CONFIG.kellyMaxSize;
  if (ps && km && ps > km) {
    warn.push('positionSize (' + ps + ') > kellyMaxSize (' + km + ') — fixed-size fallback exceeds Kelly cap; set positionSize <= kellyMaxSize');
  }

  if (TRADING_CONFIG.kellyMaxSize && SAFETY.MAX_POSITION_SIZE &&
      SAFETY.MAX_POSITION_SIZE < TRADING_CONFIG.kellyMaxSize) {
    issues.push('SAFETY.MAX_POSITION_SIZE must be >= kellyMaxSize (would block all Kelly-sized trades)');
  }

  // ── Assets list ───────────────────────────────────────────────────────────
  const validAssets = ['EURUSD','GBPUSD','USDJPY','AUDUSD','USDCAD','USDCHF','NZDUSD'];
  if (!Array.isArray(TRADING_CONFIG.assets) || TRADING_CONFIG.assets.length === 0) {
    issues.push('assets must be a non-empty array');
  } else {
    TRADING_CONFIG.assets.forEach(a => {
      if (!validAssets.includes(a)) warn.push('Unknown asset: ' + a + ' (not in supported forex pairs list)');
    });
  }

  // ── Placeholder key check ────────────────────────────────────────────────────
  // Detects values that look like copy-pasted examples rather than real keys.
  // Set SKIP_PLACEHOLDER_KEY_CHECK=true in .env if a real key is being flagged.
  const skipKeyCheck = process.env.SKIP_PLACEHOLDER_KEY_CHECK === 'true';
  const suspectEnvVars = ['ANTHROPIC_API_KEY','ALPHA_VANTAGE_API_KEY','TELEGRAM_BOT_TOKEN'];
  for (const varName of suspectEnvVars) {
    const val = process.env[varName];
    if (val && (val.includes('your_') || val.includes('REPLACE_ME') || val === 'test')) {
      const msg = varName + ' looks like a placeholder — set a real value in .env'
        + (skipKeyCheck ? ' (suppressed by SKIP_PLACEHOLDER_KEY_CHECK)' : '');
      if (skipKeyCheck) warn.push(msg);
      else issues.push(msg);
    }
  }

  // ── Environment warnings (not hard failures) ──────────────────────────────
  if (!process.env.ALPHA_VANTAGE_API_KEY) warn.push('ALPHA_VANTAGE_API_KEY not set — prices will use seed values (not live)');
  if (!process.env.ANTHROPIC_API_KEY)   warn.push('ANTHROPIC_API_KEY not set — Claude AI decisions disabled');
  if (!process.env.TELEGRAM_BOT_TOKEN)  warn.push('TELEGRAM_BOT_TOKEN not set — alerts silenced');

  if (warn.length) {
    console.warn('[ConfigValidator] Warnings:\n' + warn.map(w => '  ⚠️  ' + w).join('\n'));
  }

  // Bug fix #13: timezone consistency — TZ env must be UTC so that all date
  // comparisons (session windows, Friday close, rollover hours) are consistent
  // regardless of which server the bot runs on.
  const tz = process.env.TZ;
  if (tz && tz !== 'UTC' && tz !== 'Etc/UTC') {
    warn.push(
      'TZ env is set to "' + tz + '" — the bot assumes UTC for all session/rollover ' +
      'windows. Set TZ=UTC in your .env to avoid incorrect trade timing.'
    );
  }

  // Bug fix #6: verify trade_logs/ directory exists and is writable before
  // any trading begins. Without this the engine starts normally then crashes
  // mid-run the first time it tries to persist a trade record.
  const _path = require('path');
  const _fs   = require('fs');
  const tradeLogsDir = _path.join(__dirname, 'trade_logs');
  try {
    if (!_fs.existsSync(tradeLogsDir)) {
      _fs.mkdirSync(tradeLogsDir, { recursive: true });
    }
    const probe = _path.join(tradeLogsDir, '.write-probe');
    _fs.writeFileSync(probe, '1');
    _fs.unlinkSync(probe);
  } catch (dirErr) {
    issues.push('trade_logs/ is missing or not writable: ' + dirErr.message);
  }

  if (issues.length) {
    throw new ConfigError(issues);
  }

  console.log('[ConfigValidator] ✅ Config valid — ' + warn.length + ' warning(s)');
  return true;
}

module.exports = { validateConfig, ConfigError };
