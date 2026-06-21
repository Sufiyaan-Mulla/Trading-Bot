'use strict';
// ── security-audit.js ─────────────────────────────────────────────────────────
// Runtime security hardening checks and operator guidance.
//
// Covers missing checklist items:
//   ✓ Whitelist IPs where supported
//   ✓ Read-only keys for analytics, separate keys for trading
//   ✓ Rotate credentials regularly
//   ✓ Restrict file permissions on secret files
//   ✓ Encrypt backups containing sensitive config
//
// This module:
//   1. Runs a startup security audit and logs all findings
//   2. Provides checkPermissions() to verify .env file mode
//   3. Provides credentialAge() to warn when keys are overdue for rotation
//   4. Provides ipWhitelistGuidance() to print actionable setup steps
//   5. Enforces key separation: read-only key vs trading key pattern
//
// Usage:
//   const { SecurityAudit } = require('./security-audit');
//   const audit = new SecurityAudit();
//   const report = audit.run();   // run all checks, print findings
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV_FILE       = path.join(__dirname, '.env');
const ROTATION_STATE = path.join(__dirname, 'trade_logs', 'credential_rotation.json');
const MAX_KEY_AGE_DAYS = parseInt(process.env.MAX_KEY_AGE_DAYS || '90');
const UNIX_SECRET_MODE = 0o100600;   // -rw------- (owner read/write only)

class SecurityAudit {
  constructor(opts = {}) {
    this.maxKeyAgeDays = opts.maxKeyAgeDays || MAX_KEY_AGE_DAYS;
    this._findings = [];
    this._log = (level, msg) => {
      const prefix = level === 'PASS' ? '✅' : level === 'WARN' ? '⚠️ ' : '🚨';
      console.log(`[SecurityAudit] ${prefix} ${msg}`);
      this._findings.push({ level, msg, ts: new Date().toISOString() });
    };
  }

  // ── Run all checks ────────────────────────────────────────────────────────
  run() {
    console.log('\n[SecurityAudit] Running security checks...\n');
    this._checkEnvFilePermissions();
    this._checkHardcodedSecrets();
    this._checkKeySeparation();
    this._checkCredentialAge();
    this._checkIpWhitelisting();
    this._checkBackupEncryption();
    this._checkReadOnlyAnalyticsKey();

    const passes = this._findings.filter(f => f.level === 'PASS').length;
    const warns  = this._findings.filter(f => f.level === 'WARN').length;
    const errors = this._findings.filter(f => f.level === 'ERROR').length;

    console.log(`\n[SecurityAudit] Summary: ${passes} pass, ${warns} warn, ${errors} error\n`);
    return { findings: this._findings, passes, warns, errors, secure: errors === 0 };
  }

  // ── 1. .env file permissions ───────────────────────────────────────────────
  _checkEnvFilePermissions() {
    if (!fs.existsSync(ENV_FILE)) {
      this._log('WARN', '.env file not found — ensure secrets are in environment variables');
      return;
    }
    try {
      const stat = fs.statSync(ENV_FILE);
      const mode = stat.mode & 0o777;
      if (mode & 0o044) {
        this._log('ERROR', `.env is readable by group/others (mode ${mode.toString(8)}) — run: chmod 600 .env`);
      } else {
        this._log('PASS', `.env permissions OK (mode ${mode.toString(8)})`);
      }
    } catch (e) {
      this._log('WARN', 'Could not check .env permissions: ' + e.message);
    }
  }

  // Programmatically fix .env permissions (call this from startup if needed)
  fixEnvPermissions() {
    try {
      if (fs.existsSync(ENV_FILE)) {
        fs.chmodSync(ENV_FILE, 0o600);
        this._log('PASS', '.env permissions set to 600');
      }
    } catch (e) {
      this._log('WARN', 'Could not chmod .env: ' + e.message);
    }
  }

  // ── 2. No hardcoded secrets in source ─────────────────────────────────────
  _checkHardcodedSecrets() {
    const secretPatterns = [
      /OANDA_API_KEY\s*=\s*['"][^'"]{10,}['"]/,
      /ANTHROPIC_API_KEY\s*=\s*['"][^'"]{10,}['"]/,
      /sk-[a-zA-Z0-9]{30,}/,
    ];
    const sourceFiles = ['trading-engine.js', 'trading-config.js', 'startup.js'];
    let found = false;
    for (const file of sourceFiles) {
      const fullPath = path.join(__dirname, file);
      if (!fs.existsSync(fullPath)) continue;
      const src = fs.readFileSync(fullPath, 'utf8');
      for (const pat of secretPatterns) {
        if (pat.test(src)) {
          this._log('ERROR', `Possible hardcoded secret in ${file} — move to .env`);
          found = true;
        }
      }
    }
    if (!found) this._log('PASS', 'No hardcoded secrets detected in source files');
  }

  // ── 3. Key separation: read-only vs trading ────────────────────────────────
  _checkKeySeparation() {
    const hasTrading  = !!(process.env.OANDA_API_KEY);
    const hasReadOnly = !!(process.env.OANDA_READONLY_KEY);

    if (!hasReadOnly) {
      this._log('WARN',
        'OANDA_READONLY_KEY not set. Best practice:\n' +
        '  • Create a separate OANDA key with Read-Only permissions for analytics/dashboard\n' +
        '  • Keep your main OANDA_API_KEY for order execution only\n' +
        '  • Set OANDA_READONLY_KEY in .env for metrics-server.js and dashboard.js'
      );
    } else {
      // Verify they are actually different keys
      if (process.env.OANDA_READONLY_KEY === process.env.OANDA_API_KEY) {
        this._log('ERROR', 'OANDA_READONLY_KEY equals OANDA_API_KEY — they must be separate keys');
      } else {
        this._log('PASS', 'Key separation: trading key ≠ read-only key');
      }
    }
  }

  // ── 4. Credential age / rotation ──────────────────────────────────────────
  _checkCredentialAge() {
    let state = {};
    try {
      if (fs.existsSync(ROTATION_STATE)) {
        state = JSON.parse(fs.readFileSync(ROTATION_STATE, 'utf8'));
      }
    } catch (_) {}

    const keys = ['OANDA_API_KEY', 'ANTHROPIC_API_KEY', 'ALPHA_VANTAGE_API_KEY', 'TELEGRAM_BOT_TOKEN'];
    for (const key of keys) {
      if (!process.env[key]) continue;
      const lastRotated = state[key] ? new Date(state[key]) : null;
      if (!lastRotated) {
        this._log('WARN', `${key}: rotation date unknown — record it with SecurityAudit.recordRotation('${key}')`);
        continue;
      }
      const ageDays = (Date.now() - lastRotated.getTime()) / 86400000;
      if (ageDays > this.maxKeyAgeDays) {
        this._log('WARN', `${key}: ${Math.floor(ageDays)} days old — rotate now (max ${this.maxKeyAgeDays} days)`);
      } else {
        this._log('PASS', `${key}: ${Math.floor(ageDays)} days old (max ${this.maxKeyAgeDays})`);
      }
    }
  }

  // Call this after rotating a credential to record the new rotation date
  recordRotation(keyName) {
    let state = {};
    try {
      if (fs.existsSync(ROTATION_STATE)) state = JSON.parse(fs.readFileSync(ROTATION_STATE, 'utf8'));
    } catch (_) {}
    state[keyName] = new Date().toISOString();
    const dir = path.dirname(ROTATION_STATE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ROTATION_STATE, JSON.stringify(state, null, 2));
    console.log(`[SecurityAudit] Recorded rotation of ${keyName}`);
  }

  // ── 5. IP whitelisting guidance ────────────────────────────────────────────
  _checkIpWhitelisting() {
    const hasIpVar = !!(process.env.ALLOWED_IPS || process.env.OANDA_IP_WHITELIST);
    if (!hasIpVar) {
      this._log('WARN',
        'IP whitelisting not configured:\n' +
        '  OANDA: Go to Account Settings → API Access → Restrict IP\n' +
        '  Add your server IP(s) to the whitelist\n' +
        '  Set ALLOWED_IPS=1.2.3.4,5.6.7.8 in .env as a reminder'
      );
    } else {
      this._log('PASS', 'IP whitelist env var is set (verify the actual whitelist at your broker)');
    }
  }

  // ── 6. Backup encryption ───────────────────────────────────────────────────
  _checkBackupEncryption() {
    const hasKey = !!(process.env.BACKUP_KEY);
    if (!hasKey) {
      this._log('WARN',
        'BACKUP_KEY not set — backups are unencrypted.\n' +
        '  Set a strong BACKUP_KEY in .env:\n' +
        '  BACKUP_KEY=' + crypto.randomBytes(24).toString('base64')
      );
    } else if (process.env.BACKUP_KEY.length < 16) {
      this._log('ERROR', 'BACKUP_KEY is too short — use at least 16 characters');
    } else {
      this._log('PASS', 'BACKUP_KEY is set — backups will be AES-256-GCM encrypted');
    }
  }

  // ── 7. Read-only key used by dashboard/analytics ───────────────────────────
  _checkReadOnlyAnalyticsKey() {
    // Check that metrics-server.js and dashboard are not using the trading key
    // (heuristic: if OANDA_READONLY_KEY is set, this is satisfied)
    const note = process.env.OANDA_READONLY_KEY
      ? 'PASS'
      : 'WARN';
    if (note === 'PASS') {
      this._log('PASS', 'Read-only analytics key is configured');
    } else {
      this._log('WARN',
        'Dashboard and metrics server should use a read-only API key, not the trading key.\n' +
        '  Add OANDA_READONLY_KEY to .env and update dashboard.js/metrics-server.js to use it.'
      );
    }
  }
}

module.exports = { SecurityAudit };
