'use strict';
// ── auto-reset.js ─────────────────────────────────────────────────────────────
// Automated reset of daily lockout and weekly halt at the start of each UTC day.
// Run as a cron or via `npm run auto:reset`.
//
// Resets:
//   • trade_logs/daily_lockout.json   (daily drawdown lockout)
//   • DrawdownTracker weekly halt      (only if lock has expired naturally)
//   • Circuit breaker state            (if --circuit flag passed)
//
// Usage:
//   node auto-reset.js                  (reset daily lockout if expired)
//   node auto-reset.js --force          (reset regardless of time)
//   node auto-reset.js --circuit        (also clear circuit breaker state)
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const args    = process.argv.slice(2);

// ── Atomic reset: consecutiveLosses + drift halt + daily lockout ──────────────
// Use --atomic flag. Requires --force to actually clear consecutive-loss state.
if (args.includes('--atomic')) {
  const driftFile = require('path').join(__dirname, 'trade_logs', 'drift-halt.json');
  let cleared = [];

  // Always clear drift halt (not a genuine failure indicator)
  if (fs.existsSync(driftFile)) {
    try { fs.unlinkSync(driftFile); cleared.push('drift-halt'); } catch(_) {}
  }
  // Clear daily lockout (expiry-based, safe to auto-clear)
  if (fs.existsSync(LOCKOUT_FILE)) {
    try { fs.unlinkSync(LOCKOUT_FILE); cleared.push('daily-lockout'); } catch(_) {}
  }
  // Only clear consecutive-loss with explicit --force (requires human review)
  if (args.includes('--force') && fs.existsSync(RISK_FILE)) {
    try {
      const risk = JSON.parse(fs.readFileSync(RISK_FILE, 'utf8'));
      risk.consecutiveLosses    = 0;
      risk.consecutiveHaltUntil = 0;
      fs.writeFileSync(RISK_FILE, JSON.stringify(risk, null, 2));
      cleared.push('consecutiveLosses');
    } catch(_) {}
  } else if (!args.includes('--force')) {
    console.log('⚠️  Consecutive-loss counter NOT cleared — use --force after human review of strategy failure');
  }
  console.log('✅ Atomic reset complete. Cleared:', cleared.join(', ') || 'nothing');
  process.exit(0);
}

const force   = args.includes('--force');
const circuit = args.includes('--circuit');

const LOCKOUT_FILE  = path.join(__dirname, 'trade_logs', 'daily_lockout.json');
const DD_STATE_FILE = path.join(__dirname, 'trade_logs', 'drawdown_state.json');
const RISK_FILE     = path.join(__dirname, 'trade_logs', 'risk-state.json');
const HALT_FILE     = path.join(__dirname, 'trade_logs', 'global_halt.json');

const now = Date.now();

// ── 1. Daily lockout ──────────────────────────────────────────────────────────
if (fs.existsSync(LOCKOUT_FILE)) {
  try {
    const lockout = JSON.parse(fs.readFileSync(LOCKOUT_FILE, 'utf8'));
    const expired = !lockout.lockUntil || now >= lockout.lockUntil;
    if (force || expired) {
      fs.unlinkSync(LOCKOUT_FILE);
      console.log('✅ Daily lockout cleared' + (expired ? ' (expired)' : ' (forced)'));
    } else {
      const remainMins = ((lockout.lockUntil - now) / 60_000).toFixed(0);
      console.log(`⏳ Daily lockout still active for ${remainMins} min — use --force to override`);
    }
  } catch (_) { fs.unlinkSync(LOCKOUT_FILE); console.log('✅ Corrupt lockout file removed'); }
} else {
  console.log('ℹ️  No daily lockout active');
}

// ── 2. Weekly halt ────────────────────────────────────────────────────────────
if (fs.existsSync(DD_STATE_FILE)) {
  try {
    const state = JSON.parse(fs.readFileSync(DD_STATE_FILE, 'utf8'));
    const weeklyExpired = !state.weeklyHaltUntil || now >= state.weeklyHaltUntil;
    if (state.weeklyHaltUntil && weeklyExpired) {
      state.weeklyHaltUntil = null;
      fs.writeFileSync(DD_STATE_FILE, JSON.stringify(state, null, 2));
      console.log('✅ Weekly halt cleared (expired)');
    } else if (state.weeklyHaltUntil) {
      const remainH = ((state.weeklyHaltUntil - now) / 3_600_000).toFixed(1);
      console.log(`⏳ Weekly halt still active for ${remainH}h`);
    }
    if (state.monthlyHalt) {
      console.log('⚠️  Monthly halt is ACTIVE — manual reset required: node trading-cli.js reset');
    }
  } catch (_) {}
}

// ── 3. Circuit breaker ────────────────────────────────────────────────────────
if (circuit) {
  if (fs.existsSync(RISK_FILE)) {
    try {
      const risk = JSON.parse(fs.readFileSync(RISK_FILE, 'utf8'));
      risk.consecutiveLosses    = 0;
      risk.consecutiveHaltUntil = 0;
      fs.writeFileSync(RISK_FILE, JSON.stringify(risk, null, 2));
      console.log('✅ Circuit breaker / consecutive loss counter reset');
    } catch (_) {}
  }
}

// ── 4. Global halt file ───────────────────────────────────────────────────────
if (force && fs.existsSync(HALT_FILE)) {
  const halt = JSON.parse(fs.readFileSync(HALT_FILE, 'utf8'));
  if (halt.halted) {
    halt.halted    = false;
    halt.resetAt   = new Date().toISOString();
    halt.resetBy   = 'auto-reset --force';
    fs.writeFileSync(HALT_FILE, JSON.stringify(halt, null, 2));
    console.log('✅ Global halt cleared (forced)');
  }
}

console.log('\nauto-reset complete at', new Date().toISOString());
