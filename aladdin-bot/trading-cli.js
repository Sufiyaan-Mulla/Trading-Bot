'use strict';
// ── trading-cli.js ────────────────────────────────────────────────────────────
// CLI wrapper for controlling the Aladdin trading engine via PM2.
//
// Commands:
//   node trading-cli.js start   — start the engine (via PM2 or direct)
//   node trading-cli.js stop    — stop the engine
//   node trading-cli.js status  — show engine status from health endpoint
//   node trading-cli.js reset   — clear daily lockout
//   node trading-cli.js backup  — trigger a manual backup
// ─────────────────────────────────────────────────────────────────────────────

const { execSync, spawn } = require('child_process');
const http                = require('http');
const fs                  = require('fs');
const path                = require('path');

const HEALTH_PORT   = parseInt(process.env.HEALTH_PORT   || '8080');
const METRICS_PORT  = parseInt(process.env.METRICS_PORT  || '9090');
const LOCKOUT_FILE  = path.join(__dirname, 'trade_logs', 'daily_lockout.json');

const cmd = process.argv[2];

async function fetchJSON(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: 'localhost', port, path }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (_) { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function cmdStatus() {
  console.log('Aladdin Bot Status\n' + '─'.repeat(40));
  try {
    const health  = await fetchJSON(HEALTH_PORT,  '/health');
    const ready   = await fetchJSON(HEALTH_PORT,  '/ready');
    const metrics = await fetchJSON(METRICS_PORT, '/health');

    console.log(`Health:   ${health.data.status?.toUpperCase()} (HTTP ${health.status})`);
    console.log(`Ready:    ${ready.data.status?.toUpperCase()}`);
    console.log(`Uptime:   ${Math.floor((health.data.uptime || 0) / 60)}m ${(health.data.uptime || 0) % 60}s`);
    console.log(`Halt:     ${health.data.halt || false}`);
    console.log(`Circuit:  ${health.data.circuit || false}`);
    console.log(`Running:  ${ready.data.isRunning || false}`);
    console.log(`Warmup:   ${ready.data.warmupDone || false} (${ready.data.priceHistory || 0} bars)`);
  } catch (e) {
    console.log('Engine not reachable — is it running?');
    console.log('  Error:', e.message);
  }

  // PM2 status if available
  try {
    const pm2out = execSync('pm2 list 2>/dev/null', { encoding: 'utf8' });
    if (pm2out.includes('aladdin')) {
      console.log('\nPM2 processes:');
      pm2out.split('\n').filter(l => l.includes('aladdin') || l.includes('name')).forEach(l => console.log(' ', l));
    }
  } catch (_) {}
}

function cmdStart() {
  try {
    // Try PM2 first
    execSync('pm2 status 2>/dev/null', { stdio: 'ignore' });
    console.log('Starting via PM2...');
    execSync('pm2 start ecosystem.config.js', { stdio: 'inherit' });
  } catch (_) {
    // Fall back to direct node
    console.log('Starting directly (PM2 not available)...');
    const child = spawn('node', ['backend-server.js'], {
      detached: true, stdio: 'inherit',
      env: { ...process.env },
    });
    child.unref();
    console.log('Engine started with PID', child.pid);
  }
}

function cmdStop() {
  try {
    execSync('pm2 stop aladdin-trading 2>/dev/null', { stdio: 'inherit' });
  } catch (_) {
    console.log('PM2 not running — send SIGTERM to node processes manually');
  }
}

function cmdReset() {
  if (fs.existsSync(LOCKOUT_FILE)) {
    fs.unlinkSync(LOCKOUT_FILE);
    console.log('Daily lockout cleared');
  } else {
    console.log('No active lockout');
  }

  // Also clear weekly/monthly drawdown state
  const ddFile = path.join(__dirname, 'trade_logs', 'drawdown_state.json');
  if (fs.existsSync(ddFile)) {
    const state = JSON.parse(fs.readFileSync(ddFile, 'utf8'));
    state.weeklyHaltUntil = null;
    state.monthlyHalt     = false;
    fs.writeFileSync(ddFile, JSON.stringify(state, null, 2));
    console.log('Weekly/monthly drawdown halts cleared');
  }
}

async function cmdBackup() {
  try {
    const { BackupManager } = require('./backup-manager');
    const bm = new BackupManager({ encrypt: !!(process.env.BACKUP_KEY) });
    console.log('Running manual backup...');
    const manifest = await bm.runNow();
    console.log(`Backup complete: ${manifest.fileCount} files, ${(manifest.totalBytes/1024).toFixed(1)} KB → backups/${manifest.label}`);
  } catch (e) {
    console.error('Backup failed:', e.message);
  }
}

(async () => {
  switch (cmd) {
    case 'start':  cmdStart(); break;
    case 'stop':   cmdStop();  break;
    case 'status': await cmdStatus(); break;
    case 'reset':  cmdReset(); break;
    case 'backup': await cmdBackup(); break;
    default:
      console.log('Usage: node trading-cli.js <start|stop|status|reset|backup>');
      process.exit(1);
  }
})();
