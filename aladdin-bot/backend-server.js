
// #81: Handle uncaught exceptions with Telegram alert before exit
process.on('uncaughtException', (err) => {
  console.error('[Boot] UNCAUGHT EXCEPTION:', err.stack || err.message);
  try { require('./telegram').send('🚨 Bot crashed: ' + err.message, 'risk'); } catch(_) {}
  setTimeout(() => process.exit(1), 2000);  // allow Telegram to send
});
process.on('unhandledRejection', (reason) => {
  console.error('[Boot] UNHANDLED REJECTION:', reason);
  try { require('./telegram').send('⚠️ Unhandled rejection: ' + String(reason).slice(0, 200), 'risk'); } catch(_) {}
});

'use strict';
// ── backend-server.js ─────────────────────────────────────────────────────────
// Main entry point for the Aladdin Trading Bot.
// Bootstraps all subsystems in the correct order, then starts the engine.
//
// Boot sequence:
//   1. Env + security (credential enforcer, .env permissions)
//   2. Config (JSON loader → hot-reload)
//   3. Engine construction + wiring of all new modules
//   4. Infrastructure servers (health, metrics, dashboard)
//   5. Backup scheduler
//   6. Trading engine start
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config();

const { getProfiler }          = require('./performance-profiler');
const profiler                 = getProfiler();

profiler.startupBegin('boot');
profiler.startupBegin('security');

// ── 1. Security ───────────────────────────────────────────────────────────────
const { CredentialEnforcer }   = require('./credential-enforcer');
const { SecurityAudit }        = require('./security-audit');

new CredentialEnforcer({ mode: 'warn', maxAgeDays: 90 }).enforce();
new SecurityAudit().run();

profiler.startupEnd('security');
profiler.startupBegin('config');

// ── 2. Config ────────────────────────────────────────────────────────────────
const { loadConfig }           = require('./config-loader');
const { TRADING_CONFIG }       = require('./trading-config');
// Merge JSON config into the live TRADING_CONFIG object
const jsonCfg = loadConfig();
Object.assign(TRADING_CONFIG, jsonCfg);

profiler.startupEnd('config');
profiler.startupBegin('engine_construct');

// ── 3. Engine ─────────────────────────────────────────────────────────────────
const { TradingEngine }        = require('./trading-engine');
const { wireEngine }           = require('./engine-wiring');

const engine = new TradingEngine();
wireEngine(engine);   // attaches all new subsystems

// ── 4. Infrastructure servers ─────────────────────────────────────────────────
const { HealthServer }         = require('./health-server');
const { MetricsServer }        = require('./metrics-server');

profiler.startupBegin('servers');

const healthSrv = new HealthServer(engine, { port: parseInt(process.env.HEALTH_PORT || '8080') });
healthSrv.start();

const metricsSrv = new MetricsServer(engine);
metricsSrv.start();

let dashboard;
try {
  const { Dashboard } = require('./dashboard');
  dashboard = new Dashboard(engine).start();
} catch (e) { console.warn('[Boot] Dashboard start failed:', e.message); }

profiler.startupEnd('servers');

// ── 5. Backup scheduler ───────────────────────────────────────────────────────
try {
  const { BackupManager } = require('./backup-manager');
  const bm = new BackupManager({
    intervalMs: (parseInt(process.env.BACKUP_INTERVAL_HOURS || '6')) * 3600_000,
    encrypt:    !!(process.env.BACKUP_KEY),
  });
  bm.start();
  engine.backupManager = bm;
} catch (e) { console.warn('[Boot] BackupManager start failed:', e.message); }

// ── 6. Graceful shutdown ──────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n[Boot] ${signal} received — graceful shutdown`);
  try {
    if (engine.backupManager) await engine.backupManager.runNow();
    engine.stop?.();
    healthSrv.stop();
    metricsSrv.stop();
    dashboard?.stop?.();
  } catch (_) {}
  process.exit(0);
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT',  () => shutdown('SIGINT'));

profiler.startupEnd('boot');
const report = profiler.report();
console.log(`[Boot] Startup complete in ${report.startup._total}ms`);
console.log(`[Boot] Phases: ${JSON.stringify(report.startup)}`);

// ── 7. Start trading ──────────────────────────────────────────────────────────
engine.runTradingLoop?.();

