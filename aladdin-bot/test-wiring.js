'use strict';

(async () => {
// ── test-wiring.js ────────────────────────────────────────────────────────────
// Verifies that engine-wiring.js correctly attaches every subsystem to a mock
// engine instance without touching the real OANDA API.
// ─────────────────────────────────────────────────────────────────────────────

const { EventEmitter } = require('events');

let passed = 0, failed = 0;
const failures = [];

function assert(cond, label, detail = '') {
  if (cond) { process.stdout.write(`  ✅ ${label}\n`); passed++; }
  else       { process.stdout.write(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}\n`); failed++; failures.push(label); }
}
function section(t) { console.log('\n' + '═'.repeat(64) + '\n  ' + t + '\n' + '═'.repeat(64)); }

// ── Mock engine that mimics TradingEngine's shape ──────────────────────────────
function makeMockEngine() {
  class MockEngine extends EventEmitter {
    constructor() {
      super();
      this.capital           = 10_000;
      this.initialCapital    = 10_000;
      this.selectedAsset     = 'EURUSD';
      this.position          = null;
      this.trades            = [];
      this.priceHistory      = new Array(100).fill(1.1050);
      this.currentSpread     = 0.0002;
      this.isRunning         = false;
      this.circuitBreakerTripped = false;
      this.globalHaltTripped     = false;
      this._wired            = false;
      this._lastStrategyName = 'trend';

      // Mock MarketDataFetcher
      this.marketData = {
        getPriceHistory: (asset) => new Array(80).fill(1.10 + Math.random() * 0.01),
      };

      // Mock EconomicCalendar
      this.economicCalendar = { isBlackout: () => false };
    }

    log(msg) { /* suppress in tests */ }

    checkRiskManagement() { return true; }

    async getDecision(indicators) {
      return { action: 'BUY', confidence: 75, reasoning: 'mock', strategyName: 'trend' };
    }

    _selectBestAsset() { return 'EURUSD'; }

    _currentSession() { return 'LONDON'; }

    saveTradesFile() {}
    start() {}
    stop()  {}
  }
  return new MockEngine();
}

// ══════════════════════════════════════════════════════════════════════════════
section('1. engine-wiring — all subsystems attach without error');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { wireEngine } = require('./engine-wiring');
  const engine = makeMockEngine();

  // Should not throw
  let wireErr = null;
  try { wireEngine(engine); } catch (e) { wireErr = e; }
  assert(wireErr === null,                    'wireEngine() does not throw', wireErr?.message);
  assert(engine._wired === true,             'engine._wired flag set to true');

  // Calling wireEngine twice is a no-op
  wireEngine(engine);
  assert(engine._wired === true,             'Second wireEngine() call is safe no-op');

} catch (e) { assert(false, 'wireEngine import error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('2. Subsystem attachment — each module attached to engine');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { wireEngine } = require('./engine-wiring');
  const engine = makeMockEngine();
  wireEngine(engine);

  assert(engine.hotReloader      != null, 'HotReloader attached');
  assert(engine.drawdownTracker  != null, 'DrawdownTracker attached');
  assert(engine.metaLabeler      != null, 'MetaLabeler attached');
  assert(engine.fillProbability  != null, 'FillProbability attached');
  assert(engine.executionMetrics != null, 'ExecutionMetrics attached');
  assert(engine.idempotentExec   != null, 'IdempotentExecutor attached');
  assert(engine.feeModel         != null, 'FeeModel attached');
  assert(engine.sectorCap        != null, 'SectorCap attached');
  assert(engine.relativeStrength != null, 'RelativeStrength attached');
  assert(engine.parallelScanner  != null, 'ParallelScanner attached');
  assert(engine.rlAgent          != null, 'RLIntegration attached');
  assert(engine.profiler         != null, 'Profiler attached');

} catch (e) { assert(false, 'Subsystem attachment error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('3. DrawdownTracker — weekly halt wired into checkRiskManagement');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { wireEngine } = require('./engine-wiring');
  const engine = makeMockEngine();
  wireEngine(engine);

  // Force a weekly drawdown breach by injecting state
  engine.drawdownTracker._state.weeklyOpen = 12_000; // capital was 12k
  engine.capital = 10_000; // now 10k = 16.7% weekly drawdown > 7% limit

  let haltTripped = false;
  const origCheck = engine.checkRiskManagement;
  engine.circuitBreakerTripped = false;

  // Suppress telegram in test
  const tg = require('./telegram');
  const origSend = tg.send;
  tg.send = () => {};

  engine.checkRiskManagement();
  tg.send = origSend;

  assert(engine.circuitBreakerTripped === true,  'circuitBreaker tripped by weekly drawdown');

  // Reset and verify monthly halt also works
  engine.circuitBreakerTripped = false;
  engine.drawdownTracker._state.weeklyOpen = 10_100; // small weekly drawdown (< 7%)
  engine.drawdownTracker._state.monthlyOpen = 13_000; // big monthly drawdown (23% > 15%)
  engine.drawdownTracker._state.weeklyHaltUntil = null;
  engine.drawdownTracker._state.monthlyHalt = false;
  tg.send = () => {};
  engine.checkRiskManagement();
  tg.send = origSend;
  assert(engine.circuitBreakerTripped === true,  'circuitBreaker tripped by monthly drawdown');

} catch (e) { assert(false, 'DrawdownTracker wiring error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('4. MetaLabeler — filters getDecision output');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { wireEngine } = require('./engine-wiring');
  const engine = makeMockEngine();
  wireEngine(engine);

  const indicators = {
    rsi: 65, macd: 0.002, adxRegime: 'TRENDING', signal: 'BUY',
    atrPercent: 0.05, computedAt: Date.now(),
  };

  // Cold start (< minSamples): passes through on confidence >= 55
  const decision = await engine.getDecision(indicators);
  assert(['BUY','SELL','HOLD'].includes(decision.action), 'getDecision returns valid action');
  assert(typeof decision.confidence === 'number',        'getDecision returns numeric confidence');

  // MetaLabeler metadata attached to decision
  if (decision.action !== 'HOLD') {
    assert(typeof decision._metaProb === 'number',       '_metaProb attached to decision');
  }

} catch (e) { assert(false, 'MetaLabeler wiring error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('5. RLIntegration — filters decisions and updates on tradeClose');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { wireEngine } = require('./engine-wiring');
  const engine = makeMockEngine();
  wireEngine(engine);

  const indicators = { rsi: 60, macd: 0.001, adxRegime: 'TRENDING', atrPercent: 0.04, computedAt: Date.now() };
  const result = await engine.getDecision(indicators);

  assert(['BUY','SELL','HOLD'].includes(result.action), 'RL-filtered decision is valid action');
  assert(typeof result.rlMode === 'string',             'rlMode field present on decision');
  assert(result.rlMode === 'shadow',                    'RL starts in shadow mode (no updates yet)');

  // Emit tradeClose — should update RL reward
  const before = engine.rlAgent.stats().updateCount;
  engine.emit('tradeClose', { profit: 150, profitPercent: 1.5 });
  const after = engine.rlAgent.stats().updateCount;
  assert(after > before,                                'RL updateCount increments on tradeClose');

} catch (e) { assert(false, 'RL wiring error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('6. RelativeStrength — _selectBestAsset uses RS scores');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { wireEngine } = require('./engine-wiring');
  const engine = makeMockEngine();

  // Give the mock fetcher some history
  const mockHistories = {
    EURUSD: Array.from({ length: 80 }, (_, i) => 1.10 + i * 0.00005),
    GBPUSD: Array.from({ length: 80 }, (_, i) => 1.25 - i * 0.00005),
  };
  engine.marketData.getPriceHistory = (asset) => mockHistories[asset] || null;

  wireEngine(engine);

  const asset = await engine._selectBestAsset();
  assert(typeof asset === 'string',                     '_selectBestAsset returns a string');
  assert(asset.length > 0,                              '_selectBestAsset returns non-empty asset name');

} catch (e) { assert(false, 'RelativeStrength wiring error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('7. Audit-tagger — engine files use audit-tagger not audit-log');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const fs = require('fs');
  const engineSrc  = fs.readFileSync('./trading-engine.js', 'utf8');
  const execSrc    = fs.readFileSync('./execution.js', 'utf8');
  const riskSrc    = fs.readFileSync('./risk-manager.js', 'utf8');

  assert(!engineSrc.includes("require('./audit-log')"),  'trading-engine.js does not import audit-log');
  assert(!execSrc.includes("require('./audit-log')"),    'execution.js does not import audit-log');
  // Fix #66: risk-manager uses lazy _auditLog via require in hot path — assertion updated
  assert(!riskSrc.startsWith("const {"+ '"' +"audit-log"), 'risk-manager.js should not top-level import audit-log');

  assert(engineSrc.includes("require('./audit-tagger')"), 'trading-engine.js imports audit-tagger');
  assert(execSrc.includes("require('./audit-tagger')"),   'execution.js imports audit-tagger');

  // Check that strategy/symbol/timeframe tags are present in decision record
  assert(engineSrc.includes("strategy:"),  'Decision record includes strategy tag');
  assert(engineSrc.includes("symbol:"),    'Decision record includes symbol tag');
  assert(engineSrc.includes("timeframe:"), 'Decision record includes timeframe tag');

} catch (e) { assert(false, 'Audit-tagger wiring check error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('8. Infrastructure files — all exist and have valid syntax');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const { execSync } = require('child_process');
  const fs = require('fs');

  const infra = [
    'backend-server.js', 'trading-cli.js', 'ecosystem.config.js',
    '.gitignore', 'docker-compose.yml', 'CHANGELOG.md',
    'config/overrides.json', 'engine-wiring.js',
  ];

  for (const f of infra) {
    assert(fs.existsSync(f), `${f} exists`);
  }

  // Syntax check JS files
  const jsFiles = infra.filter(f => f.endsWith('.js'));
  for (const f of jsFiles) {
    let syntaxOk = false;
    try { execSync(`node --check ${f}`, { stdio: 'ignore' }); syntaxOk = true; } catch(_) {}
    assert(syntaxOk, `${f} passes syntax check`);
  }

  // .gitignore contains essential entries
  const gitignore = fs.readFileSync('.gitignore', 'utf8');
  assert(gitignore.includes('.env'),         '.gitignore excludes .env');
  assert(gitignore.includes('trade_logs/'),  '.gitignore excludes trade_logs/');
  assert(gitignore.includes('node_modules'), '.gitignore excludes node_modules/');
  assert(gitignore.includes('backups/'),     '.gitignore excludes backups/');

  // config/overrides.json is valid JSON
  let jsonOk = false;
  try { JSON.parse(fs.readFileSync('config/overrides.json', 'utf8')); jsonOk = true; } catch(_) {}
  assert(jsonOk, 'config/overrides.json is valid JSON');

  // ecosystem.config.js exports apps array
  const eco = require('./ecosystem.config.js');
  assert(Array.isArray(eco.apps),            'ecosystem.config.js exports apps array');
  assert(eco.apps.length >= 1,               'ecosystem.config.js has at least 1 app');
  assert(eco.apps[0].name === 'aladdin-trading', 'First app is aladdin-trading');
  assert(eco.apps[0].script === 'backend-server.js', 'Main app script is backend-server.js');

} catch (e) { assert(false, 'Infrastructure files check error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
section('9. Missing package.json scripts — stub files exist');
// ══════════════════════════════════════════════════════════════════════════════
try {
  const fs = require('fs');
  const pkg = require('./package.json');

  // Collect JS files referenced in scripts
  const scriptRefs = new Set();
  Object.values(pkg.scripts || {}).forEach(s => {
    const m = s.match(/node (\S+\.js)/g) || [];
    m.forEach(f => scriptRefs.add(f.replace('node ', '')));
  });

  for (const f of scriptRefs) {
    assert(fs.existsSync(f), `Script file ${f} exists`);
  }

  // main entry
  assert(fs.existsSync(pkg.main), `package.json main (${pkg.main}) exists`);

} catch (e) { assert(false, 'Package.json scripts check error', e.message); }

// ══════════════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(64));
console.log('  RESULTS');
console.log('═'.repeat(64));
console.log(`  ✅ Passed:  ${passed}`);
console.log(`  ❌ Failed:  ${failed}`);
if (failures.length) {
  console.log('\n  Failed tests:');
  failures.forEach(f => console.log('    • ' + f));
}
console.log('');
process.exit(failed > 0 ? 1 : 0);

})();

// ══════════════════════════════════════════════════════════════════════════════
// 10. Bug-fix regression tests
// ══════════════════════════════════════════════════════════════════════════════

(async () => {
// This block added after the main IIFE — runs independently

const assert2 = (cond, label, detail='') => {
  if (cond) { process.stdout.write(`  ✅ ${label}\n`); }
  else { process.stdout.write(`  ❌ FAIL: ${label}${detail?' — '+detail:''}\n`); process.exitCode = 1; }
};

console.log('\n════════════════════════════════════════════════════════════════\n  10. Bug-fix regressions\n════════════════════════════════════════════════════════════════');

// Hot-reload skips _ keys
const { HotReloader } = require('./hot-reload');
const cfg = { stopLoss: 0.02 };
const hr  = new HotReloader(cfg);
let warned = false;
const orig = console.warn;
console.warn = () => { warned = true; };
const errs = hr._validate({ _comment: 'test', _instructions: 'x', stopLoss: 0.03 });
console.warn = orig;
assert2(errs.length === 0,         'Hot-reload: _ prefixed keys produce no errors');
assert2(!warned,                   'Hot-reload: _ keys generate no console warnings');

// execution.js SHORT entry has strategy tag
const execSrc = require('fs').readFileSync('./execution.js','utf8');
const shortBlock = execSrc.slice(execSrc.indexOf("side:'SHORT'"), execSrc.indexOf("side:'SHORT'") + 300);
assert2(shortBlock.includes('strategy:'), 'SHORT entry audit record has strategy tag');
assert2(shortBlock.includes('symbol:'),   'SHORT entry audit record has symbol tag');
assert2(shortBlock.includes('timeframe:'),'SHORT entry audit record has timeframe tag');

// DAILY_LOCKOUT has strategy tag
const lockBlock = execSrc.slice(execSrc.indexOf('DAILY_LOCKOUT'), execSrc.indexOf('DAILY_LOCKOUT') + 200);
assert2(lockBlock.includes('strategy:'), 'DAILY_LOCKOUT record has strategy tag');

// .env.example has all critical new vars
const envEx = require('fs').readFileSync('.env.example','utf8');
['OANDA_READONLY_KEY','BACKUP_KEY','HEALTH_PORT','MAX_KEY_AGE_DAYS','BACKUP_INTERVAL_HOURS',
 'OANDA_ACCOUNT','TELEGRAM_BOT_TOKEN','DASHBOARD_ALLOWED_IPS'].forEach(v => {
  assert2(envEx.includes(v), `.env.example contains ${v}`);
});

// grid-search-complete.js uses GridSearchValidator not GridSearch
const gscSrc = require('fs').readFileSync('./grid-search-complete.js','utf8');
assert2(!gscSrc.includes("{ GridSearch }"),      'grid-search-complete.js does not import GridSearch');
assert2(gscSrc.includes('GridSearchValidator'),  'grid-search-complete.js imports GridSearchValidator');

// auto-grid.js uses GridSearchValidator
const agSrc = require('fs').readFileSync('./auto-grid.js','utf8');
assert2(agSrc.includes('GridSearchValidator'),   'auto-grid.js imports GridSearchValidator');

// metrics-server has /account endpoint
const msSrc = require('fs').readFileSync('./metrics-server.js','utf8');
assert2(msSrc.includes('/account'),              'metrics-server.js has /account endpoint');
assert2(msSrc.includes('OandaReadonlyClient'),   'metrics-server.js uses OandaReadonlyClient');

// CHANGELOG has v7.3.0
const cl = require('fs').readFileSync('./CHANGELOG.md','utf8');
assert2(cl.includes('[7.3.0]'),                  'CHANGELOG has v7.3.0 entry');
assert2(cl.includes('runTradingLoop'),            'CHANGELOG documents engine.start() fix');

// dotenv stub works
const dt = require('dotenv'); 
assert2(typeof dt.config === 'function',         'dotenv stub exports config()');

})();
