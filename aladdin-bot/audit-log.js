'use strict';
// ── audit-log.js ─────────────────────────────────────────────────────────────
// Fix #6: HMAC-SHA256 hash chain on every audit record.
// Tampering is detectable by running audit-log.verify().
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const LOG_DIR       = path.join(__dirname, 'trade_logs');
const MAX_BYTES     = 50 * 1024 * 1024;
const MAX_ROTATIONS = parseInt(process.env.AUDIT_MAX_ROTATIONS || '5');
// Bug fix: a known public fallback HMAC key lets anyone forge audit records.
// Generate a random key per process if env is missing, and warn loudly.
let HMAC_KEY = process.env.AUDIT_HMAC_KEY;
if (!HMAC_KEY) {
  HMAC_KEY = require('crypto').randomBytes(32).toString('hex');  // ephemeral — audit chain restarts each run
  if (process.env.NODE_ENV !== 'test') {
    console.warn('[AuditLog] ⚠️  AUDIT_HMAC_KEY not set — using ephemeral key. Chain integrity will NOT survive restarts. Set AUDIT_HMAC_KEY in .env for production.');
  }
}

let _prevHash = '0'.repeat(64);

function _logPath()  { return process.env.AUDIT_LOG_PATH || path.join(LOG_DIR, 'audit.jsonl'); }
function _ensureDir(){ if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); }
function _hmac(data) { return crypto.createHmac('sha256', HMAC_KEY).update(data).digest('hex'); }

function _rotate() {
  try {
    const p = _logPath();
    if (!fs.existsSync(p) || fs.statSync(p).size < MAX_BYTES) return;
    const rotated = p + '.' + Date.now();
    fs.renameSync(p, rotated);
    try {
      const dir  = path.dirname(p);
      const base = path.basename(p) + '.';
      const rots = fs.readdirSync(dir).filter(f => f.startsWith(base)).sort();
      while (rots.length > MAX_ROTATIONS) fs.unlinkSync(path.join(dir, rots.shift()));
    } catch(_) {}
  } catch(_) {}
}

function record(entry) {
  setImmediate(() => {
    try {
      _ensureDir(); _rotate();
      const payload = JSON.stringify({ ts: new Date().toISOString(), ...entry });
      const hash    = _hmac(_prevHash + payload);
      const line    = JSON.stringify({ ...JSON.parse(payload), _h: hash, _ph: _prevHash }) + '\n';
      _prevHash = hash;
      fs.appendFileSync(_logPath(), line);
    } catch (e) { console.error('[AuditLog] Write error:', e.message); }
  });
}

function verify() {
  try {
    const lines = fs.readFileSync(_logPath(), 'utf8').trim().split('\n').filter(Boolean);
    let prev = '0'.repeat(64);
    for (let i = 0; i < lines.length; i++) {
      const rec = JSON.parse(lines[i]);
      const { _h, _ph, ...rest } = rec;
      if (!_h) continue;
      if (_hmac((_ph || prev) + JSON.stringify(rest)) !== _h)
        return { valid: false, firstTamperedLine: i + 1, checked: i + 1 };
      prev = _h;
    }
    return { valid: true, firstTamperedLine: null, checked: lines.length };
  } catch(e) { return { valid: false, error: e.message, checked: 0 }; }
}

function tail(n = 20) {
  try {
    const raw = fs.readFileSync(_logPath(), 'utf8');
    return raw.trim().split('\n').filter(Boolean).slice(-n)
      .map(l => { try { return JSON.parse(l); } catch(_) { return l; } });
  } catch(_) { return []; }
}

function flushSync(entry) {
  try {
    _ensureDir();
    const payload = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    const hash    = _hmac(_prevHash + payload);
    fs.appendFileSync(_logPath(), JSON.stringify({ ...JSON.parse(payload), _h: hash, _ph: _prevHash }) + '\n');
    _prevHash = hash;
  } catch(_) {}
}

module.exports = { record, tail, flushSync, verify };
