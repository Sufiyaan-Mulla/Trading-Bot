'use strict';
// ── credential-enforcer.js ────────────────────────────────────────────────────
// Startup credential rotation enforcement.
//
// Fixes: Security partial — "Rotate credentials regularly."
//        Also: "Restrict file permissions on secret files" (calls fixEnvPermissions).
//
// On startup:
//   1. Reads credential_rotation.json (written by security-audit.js)
//   2. Checks age of each key against MAX_KEY_AGE_DAYS
//   3. Calls fixEnvPermissions() to chmod .env to 600
//   4. Logs a structured warning for overdue keys
//   5. If mode === 'strict': throws and prevents bot from starting
//   6. If mode === 'warn':   logs and continues (default)
//
// Usage:
//   const { CredentialEnforcer } = require('./credential-enforcer');
//   new CredentialEnforcer({ mode: 'warn', maxAgeDays: 90 }).enforce();
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

const ROTATION_FILE  = path.join(__dirname, 'trade_logs', 'credential_rotation.json');
const ENV_FILE       = path.join(__dirname, '.env');
const TRACKED_KEYS   = ['OANDA_API_KEY', 'OANDA_READONLY_KEY', 'ANTHROPIC_API_KEY', 'ALPHA_VANTAGE_API_KEY', 'TELEGRAM_BOT_TOKEN', 'BACKUP_KEY'];

class CredentialEnforcer {
  constructor(opts = {}) {
    this.mode       = opts.mode       || 'warn';   // 'warn' | 'strict'
    this.maxAgeDays = opts.maxAgeDays || parseInt(process.env.MAX_KEY_AGE_DAYS || '90');
    this._log       = (l, m) => console[l === 'ERROR' ? 'error' : l === 'WARN' ? 'warn' : 'log'](`[CredentialEnforcer] ${m}`);
  }

  // ── Run all enforcement checks ─────────────────────────────────────────────
  enforce() {
    const issues = [];

    // 1. Fix .env permissions
    this._fixPermissions();

    // 2. Check credential ages
    const rotationState = this._loadRotationState();
    const now = Date.now();
    for (const key of TRACKED_KEYS) {
      if (!process.env[key]) continue;   // key not in use
      if (!rotationState[key]) {
        issues.push({ key, severity: 'WARN', reason: 'rotation date not recorded — run SecurityAudit.recordRotation()' });
        this._log('WARN', `${key}: rotation date unknown`);
        continue;
      }
      const ageDays = (now - new Date(rotationState[key]).getTime()) / 86_400_000;
      if (ageDays > this.maxAgeDays) {
        const severity = ageDays > this.maxAgeDays * 1.5 ? 'ERROR' : 'WARN';
        issues.push({ key, severity, ageDays: Math.floor(ageDays), maxAgeDays: this.maxAgeDays,
          reason: `${Math.floor(ageDays)} days old (max ${this.maxAgeDays})` });
        this._log(severity, `${key}: ${Math.floor(ageDays)} days old — ROTATE NOW`);
      } else {
        this._log('INFO', `${key}: OK (${Math.floor(ageDays)}d / ${this.maxAgeDays}d max)`);
      }
    }

    // 3. Strict mode: block startup on ERROR-level issues
    if (this.mode === 'strict') {
      const errors = issues.filter(i => i.severity === 'ERROR');
      if (errors.length) {
        throw new Error(
          '[CredentialEnforcer] STARTUP BLOCKED — overdue credentials:\n' +
          errors.map(e => `  • ${e.key}: ${e.reason}`).join('\n') +
          '\nRotate the listed keys and call SecurityAudit.recordRotation() for each.'
        );
      }
    }

    return { issues, allOk: issues.length === 0 };
  }

  // ── Fix .env file permissions to 600 ─────────────────────────────────────
  _fixPermissions() {
    try {
      if (!fs.existsSync(ENV_FILE)) return;
      const stat = fs.statSync(ENV_FILE);
      const mode = stat.mode & 0o777;
      if (mode !== 0o600) {
        fs.chmodSync(ENV_FILE, 0o600);
        this._log('INFO', `.env permissions fixed: ${mode.toString(8)} → 600`);
      }
    } catch (e) {
      this._log('WARN', 'Could not fix .env permissions: ' + e.message);
    }
  }

  _loadRotationState() {
    try {
      if (fs.existsSync(ROTATION_FILE)) return JSON.parse(fs.readFileSync(ROTATION_FILE, 'utf8'));
    } catch (_) {}
    return {};
  }
}

module.exports = { CredentialEnforcer };
