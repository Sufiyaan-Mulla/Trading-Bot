#!/usr/bin/env node
'use strict';
// ── launch.js ─────────────────────────────────────────────────────────────────
// ONE-COMMAND LAUNCHER for Aladdin Bot.
// Run:  node launch.js
//
// What this does automatically:
//   1. Checks Node.js version
//   2. Installs/updates npm packages if needed
//   3. Creates .env from .env.example if missing
//   4. Validates config + API keys
//   5. Creates required directories
//   6. Starts all processes (engine + health + dashboard)
//   7. Shows a live status panel in the terminal
// ─────────────────────────────────────────────────────────────────────────────

const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── ANSI colours ─────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',  bold:   '\x1b[1m',
  red:    '\x1b[31m', green:  '\x1b[32m', yellow: '\x1b[33m',
  blue:   '\x1b[34m', cyan:   '\x1b[36m', white:  '\x1b[37m', grey:   '\x1b[90m',
};
const ok   = (s) => `${C.green}✅ ${s}${C.reset}`;
const warn = (s) => `${C.yellow}⚠️  ${s}${C.reset}`;
const err  = (s) => `${C.red}❌ ${s}${C.reset}`;
const info = (s) => `${C.cyan}ℹ️  ${s}${C.reset}`;
const box  = (s) => `${C.bold}${C.blue}${s}${C.reset}`;

const ROOT = __dirname;

// ─────────────────────────────────────────────────────────────────────────────
// STEP 0 — Banner
// ─────────────────────────────────────────────────────────────────────────────
console.clear();
console.log(box(`
╔══════════════════════════════════════════════════════════╗
║          🤖  ALADDIN TRADING BOT — LAUNCHER              ║
║                                                          ║
║  All features start automatically. Press Ctrl+C to stop. ║
╚══════════════════════════════════════════════════════════╝
`));

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Node version check
// ─────────────────────────────────────────────────────────────────────────────
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.log(err(`Node.js v18+ required. You have v${process.versions.node}.`));
  console.log(info('Download: https://nodejs.org'));
  process.exit(1);
}
console.log(ok(`Node.js v${process.versions.node}`));

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — Install dependencies if node_modules missing or package changed
// ─────────────────────────────────────────────────────────────────────────────
const nodeModulesOk = fs.existsSync(path.join(ROOT, 'node_modules', '.package-lock.json')) ||
                      fs.existsSync(path.join(ROOT, 'node_modules', 'express'));

if (!nodeModulesOk) {
  console.log(info('Installing dependencies (first run — may take 30–60 seconds)…'));
  try {
    execSync('npm install --ignore-scripts', { cwd: ROOT, stdio: 'inherit' });
    console.log(ok('Dependencies installed'));
  } catch(e) {
    console.log(err('npm install failed — check internet connection'));
    process.exit(1);
  }
} else {
  console.log(ok('Dependencies ready'));
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — .env setup
// ─────────────────────────────────────────────────────────────────────────────
const envFile     = path.join(ROOT, '.env');
const envExample  = path.join(ROOT, '.env.example');

if (!fs.existsSync(envFile)) {
  if (fs.existsSync(envExample)) {
    fs.copyFileSync(envExample, envFile);
    console.log(warn('.env created from .env.example — edit it with your API keys before trading live!'));
    console.log(info(`  Open: ${envFile}`));
  } else {
    // Create minimal .env
    fs.writeFileSync(envFile, [
      '# Aladdin Bot — fill in your keys',
      'OANDA_API_KEY=',
      'OANDA_ACCOUNT_ID=',
      'OANDA_ENV=practice',
      'PAPER_MODE=true',
      'TELEGRAM_BOT_TOKEN=',
      'TELEGRAM_CHAT_ID=',
      'AUDIT_HMAC_KEY=' + require('crypto').randomBytes(32).toString('hex'),
      'HEALTH_PORT=8080',
      'DASHBOARD_PORT=3000',
    ].join('\n') + '\n');
    console.log(warn('.env created — add your OANDA_API_KEY before trading live'));
  }
} else {
  console.log(ok('.env found'));
}

// Load .env
require('dotenv').config({ path: envFile });

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4 — Validate key settings
// ─────────────────────────────────────────────────────────────────────────────
const isPaper = process.env.PAPER_MODE === 'true';
const isBacktest = process.env.BACKTEST_MODE === 'true';
const hasOanda = !!process.env.OANDA_API_KEY;
const hasTelegram = !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

console.log('');
console.log(box('── Configuration ──────────────────────────────────────────'));
console.log(isPaper   ? ok('Paper mode ON (no real money)') : warn('LIVE TRADING MODE — real money at risk!'));
console.log(isBacktest ? ok('Backtest mode') : '');
console.log(hasOanda   ? ok('OANDA API key set') : warn('OANDA_API_KEY not set — will use simulated prices'));
console.log(hasTelegram ? ok('Telegram alerts enabled') : warn('Telegram not configured — no mobile alerts'));
console.log(process.env.ANTHROPIC_API_KEY ? ok('Claude AI decisions enabled') : info('ANTHROPIC_API_KEY not set — rule-based mode only'));
console.log(process.env.AUDIT_HMAC_KEY    ? ok('Audit log HMAC key set') : warn('AUDIT_HMAC_KEY not set — add to .env for tamper-proof logs'));

if (!isPaper && !isBacktest && !hasOanda) {
  console.log(err('Live trading requires OANDA_API_KEY. Set PAPER_MODE=true or add your key.'));
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 5 — Create required directories
// ─────────────────────────────────────────────────────────────────────────────
const dirs = ['trade_logs', 'backups', 'config'];
for (const d of dirs) {
  fs.mkdirSync(path.join(ROOT, d), { recursive: true });
}
console.log(ok('Directories ready'));

// ─────────────────────────────────────────────────────────────────────────────
// STEP 6 — Determine ports
// ─────────────────────────────────────────────────────────────────────────────
const HEALTH_PORT    = parseInt(process.env.HEALTH_PORT    || '8080');
const DASHBOARD_PORT = parseInt(process.env.DASHBOARD_PORT || '3000');
const METRICS_PORT   = parseInt(process.env.METRICS_PORT   || '9090');

// ─────────────────────────────────────────────────────────────────────────────
// STEP 7 — Start all processes
// ─────────────────────────────────────────────────────────────────────────────
console.log('');
console.log(box('── Starting Aladdin Bot ───────────────────────────────────'));

const processes = [];
let engineReady = false;

function spawnProc(label, script, extraEnv = {}) {
  if (!fs.existsSync(path.join(ROOT, script))) {
    console.log(warn(`${label}: ${script} not found — skipping`));
    return null;
  }
  const env = { ...process.env, ...extraEnv };
  const proc = spawn(process.execPath, [path.join(ROOT, script)], { env, cwd: ROOT });

  proc.stdout.on('data', (d) => {
    const lines = d.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      // Detect engine ready
      if (line.includes('Trading engine started') || line.includes('🚀')) engineReady = true;
      process.stdout.write(`${C.grey}[${label}]${C.reset} ${line}\n`);
    }
  });
  proc.stderr.on('data', (d) => {
    const lines = d.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      // Suppress expected warnings
      if (line.includes('DeprecationWarning') || line.includes('ExperimentalWarning')) continue;
      process.stdout.write(`${C.yellow}[${label}]${C.reset} ${line}\n`);
    }
  });
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.log(err(`${label} exited with code ${code}`));
    }
  });

  processes.push({ label, proc });
  console.log(ok(`${label} started (pid ${proc.pid})`));
  return proc;
}

// Main trading engine (includes health server, dashboard, all modules)
const engine = spawnProc('ENGINE', 'backend-server.js', {
  HEALTH_PORT:    String(HEALTH_PORT),
  DASHBOARD_PORT: String(DASHBOARD_PORT),
  METRICS_PORT:   String(METRICS_PORT),
});

// ─────────────────────────────────────────────────────────────────────────────
// STEP 8 — Show status panel after engine starts
// ─────────────────────────────────────────────────────────────────────────────
setTimeout(() => {
  const hostname = os.hostname();
  console.log('');
  console.log(box('╔══════════════════════════════════════════════════════════╗'));
  console.log(box('║  🤖  ALADDIN BOT IS RUNNING                              ║'));
  console.log(box('╠══════════════════════════════════════════════════════════╣'));
  console.log(box(`║  📊 Dashboard :  http://localhost:${DASHBOARD_PORT}              ║`));
  console.log(box(`║  💚 Health    :  http://localhost:${HEALTH_PORT}/health        ║`));
  console.log(box(`║  📈 Status    :  http://localhost:${HEALTH_PORT}/status        ║`));
  console.log(box(`║  📡 Metrics   :  http://localhost:${METRICS_PORT}/metrics       ║`));
  console.log(box('╠══════════════════════════════════════════════════════════╣'));
  console.log(box(`║  Mode: ${(isPaper ? 'PAPER TRADING (safe)' : '⚠️  LIVE TRADING').padEnd(48)}║`));
  console.log(box('║  Press Ctrl+C to stop all processes gracefully           ║'));
  console.log(box('╚══════════════════════════════════════════════════════════╝'));
  console.log('');
}, 3000);

// ─────────────────────────────────────────────────────────────────────────────
// STEP 9 — Graceful shutdown on Ctrl+C
// ─────────────────────────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log('');
  console.log(warn(`${signal} received — stopping all processes…`));
  for (const { label, proc } of processes) {
    if (!proc.killed) {
      proc.kill('SIGTERM');
      console.log(info(`  Stopped: ${label}`));
    }
  }
  // Give processes 8s to flush, then force-kill
  setTimeout(() => {
    for (const { proc } of processes) {
      if (!proc.killed) proc.kill('SIGKILL');
    }
    console.log(ok('All stopped. Goodbye.'));
    process.exit(0);
  }, 8000);
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP',  () => shutdown('SIGHUP'));

// Keep launcher alive
setInterval(() => {}, 60_000);
