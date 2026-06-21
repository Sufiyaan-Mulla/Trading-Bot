'use strict';
// ── test-suite.js ─────────────────────────────────────────────────────────────
// Master test runner — executes every test-*.js file and reports a combined
// pass/fail summary. Used in CI and by `npm test`.
// ─────────────────────────────────────────────────────────────────────────────

const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');

// Items 1-18: Use an explicit stdout writer instead of console.log so test
// output is a deliberate choice (not accidental production logging) and can
// be silenced by piping stdout. console.error is reserved for unexpected errors.
const out = (...args) => process.stdout.write(args.join(' ') + '\n');

// All runnable test files in priority order
const TEST_FILES = [
  'test-new-modules.js',
  'test-partial-fixes.js',
  'test-integration-and-network.js',
  'test-improvements.js',
  'test-smoke.js',
  'test-strategies.js',
  'test-modules.js',
  'test-ensemble.js',
  'test-walk-forward.js',
  'test-drift-monitor.js',
  'test-wiring.js',
  'test-full-wiring.js',
  'test-improvements-full.js',
  'test-bug-fixes.js',
  'test-deep.js',
  'test-deep2.js',
].filter(f => fs.existsSync(path.join(__dirname, f)));

const results  = [];
let totalPass  = 0;
let totalFail  = 0;

// Items 1-3: header banner
out('╔' + '═'.repeat(62) + '╗');
out('║  ALADDIN BOT — FULL TEST SUITE' + ' '.repeat(30) + '║');
out('╚' + '═'.repeat(62) + '╝\n');

for (const file of TEST_FILES) {
  process.stdout.write(`Running ${file} ... `);
  const t0 = Date.now();
  try {
    const output = execSync(`node ${file}`, {
      cwd: __dirname,
      timeout: 120_000,
      encoding: 'utf8',
      env: { ...process.env, BACKTEST_MODE: 'true', OANDA_ENV: 'practice' },
    });
    const elapsed = Date.now() - t0;

    // Parse pass/fail — handles both '✅ Passed: N' and 'RESULTS: N passed | M failed' formats
    let pass = 0, fail = 0;
    const m1p = output.match(/✅ Passed:\s*(\d+)/);  if (m1p) pass = parseInt(m1p[1]);
    const m2p = output.match(/RESULTS:\s*(\d+) passed/); if (m2p && !m1p) pass = parseInt(m2p[1]);
    const m1f = output.match(/❌ Failed:\s*(\d+)/);  if (m1f) fail = parseInt(m1f[1]);
    const m2f = output.match(/\|(\d+) failed/);      if (m2f && !m1f) fail = parseInt(m2f[1]);

    totalPass += pass;
    totalFail += fail;
    results.push({ file, pass, fail, elapsed, ok: fail === 0 });

    // Items 4-8: results per file
    if (fail === 0) {
      out(`✅ ${pass} passed (${elapsed}ms)`);
    } else {
      out(`❌ ${pass} passed, ${fail} FAILED (${elapsed}ms)`);
      // Print failing test names
      const failLines = output.split('\n').filter(l => l.includes('❌ FAIL:'));
      failLines.slice(0, 5).forEach(l => out('   ', l.trim()));
    }
  } catch (err) {
    const elapsed = Date.now() - t0;
    // Items 7-8: crash output
    out(`💥 CRASHED (${elapsed}ms)`);
    const crashMsg = (err.stderr || err.stdout || err.message || '').split('\n').filter(l=>l.trim()).slice(0,3).join(' | ');
    out('   ', crashMsg);
    results.push({ file, pass: 0, fail: 1, elapsed, ok: false, crashed: true });
    totalFail += 1;
  }
}

// ── Summary ────────────────────────────────────────────────────────────────────
// Items 9-18: summary banner
out('\n' + '═'.repeat(64));
out('  SUITE RESULTS');
out('═'.repeat(64));
out(`  Files run:   ${results.length}`);
out(`  ✅ Passed:   ${totalPass}`);
out(`  ❌ Failed:   ${totalFail}`);
out(`  Files OK:    ${results.filter(r => r.ok).length}/${results.length}`);

if (results.some(r => !r.ok)) {
  out('\n  Failed files:');
  results.filter(r => !r.ok).forEach(r => {
    out(`    • ${r.file}${r.crashed ? ' (crashed)' : ` — ${r.fail} failure(s)`}`);
  });
}
out('');

// Item 19: process.exit is intentional in a test runner — exit code 1 signals
// CI failure; exit code 0 signals success.  Do NOT remove this.
process.exit(totalFail > 0 ? 1 : 0);
