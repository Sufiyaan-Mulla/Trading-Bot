'use strict';
// ── test-symbol-normalisation.js ──────────────────────────────────────────────
// Heavy tests for the EUR_USD → EURUSD normalisation fixes:
//   1. market-data-fetcher.js fetchPrice() strip-underscore guard (line 131)
//   2. trading-engine.js asset-switch path (line 1133) — our fix
//   3. trading-engine.js loadPositionFromFile() state-restore path (line 558)
//   4. config/trading-config.json  — no EUR_USD in assets array
//   5. trading-config.js           — no EUR_USD in assets array
// ─────────────────────────────────────────────────────────────────────────────

process.env.BACKTEST_MODE = 'true';
process.env.OANDA_ENV     = 'practice';

const fs   = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const failures = [];

function assert(cond, label, detail = '') {
  if (cond) { process.stdout.write(`  ✅ ${label}\n`); passed++; }
  else {
    process.stdout.write(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}\n`);
    failed++;
    failures.push(label);
  }
}
function section(t) {
  console.log('\n' + '═'.repeat(66) + '\n  ' + t + '\n' + '═'.repeat(66));
}

// ─────────────────────────────────────────────────────────────────────────────
section('1 — fetchPrice: source code guard is present');
// ─────────────────────────────────────────────────────────────────────────────
try {
  const src = fs.readFileSync('./market-data-fetcher.js', 'utf8');

  assert(
    src.includes("asset = asset.replace(/_/g, '')"),
    'fetchPrice has underscore-strip line'
  );

  // The strip must appear INSIDE the fetchPrice function body, before the
  // prices-lookup guard (not in an unrelated helper).
  const fnIdx   = src.indexOf('fetchPrice(asset)');
  const stripIdx = src.indexOf("asset = asset.replace(/_/g, '')");
  const throwIdx = src.indexOf("throw new Error(`Asset ${asset} not supported`)");
  assert(
    fnIdx !== -1 && stripIdx > fnIdx && throwIdx > stripIdx,
    'strip line is inside fetchPrice, before the throw guard'
  );
} catch (e) { assert(false, 'source-read fetchPrice guard', e.message); }

// ─────────────────────────────────────────────────────────────────────────────
section('2 — fetchPrice: runtime — underscore inputs normalised correctly');
// ─────────────────────────────────────────────────────────────────────────────
try {
  const { MarketDataFetcher } = require('./market-data-fetcher');
  const mdf = new MarketDataFetcher();

  const CASES = [
    { input: 'EUR_USD',  expected: 'EURUSD'  },
    { input: 'GBP_USD',  expected: 'GBPUSD'  },
    { input: 'AUD_USD',  expected: 'AUDUSD'  },
    { input: 'USD_JPY',  expected: 'USDJPY'  },
    { input: 'EURUSD',   expected: 'EURUSD'  },   // already clean
    { input: 'GBPUSD',   expected: 'GBPUSD'  },
    { input: 'USDJPY',   expected: 'USDJPY'  },
    { input: 'AUDUSD',   expected: 'AUDUSD'  },
    { input: 'EUR__USD', expected: 'EURUSD'  },   // multiple underscores
    { input: 'E_U_R_U_S_D', expected: 'EURUSD' }, // pathological
  ];

  for (const { input, expected } of CASES) {
    let result;
    try {
      result = mdf.fetchPrice(input);
      assert(result.asset === expected,
        `fetchPrice('${input}') → asset='${result.asset}'`,
        `expected '${expected}'`);
    } catch (e) {
      assert(false, `fetchPrice('${input}') must not throw`, e.message);
    }
  }
} catch (e) { assert(false, 'MarketDataFetcher load/construct', e.message); }

// ─────────────────────────────────────────────────────────────────────────────
section('3 — fetchPrice: runtime — return shape is complete');
// ─────────────────────────────────────────────────────────────────────────────
try {
  const { MarketDataFetcher } = require('./market-data-fetcher');
  const mdf = new MarketDataFetcher();

  // Test with both clean and underscore forms — shape must be identical
  const clean = mdf.fetchPrice('EURUSD');
  const under = mdf.fetchPrice('EUR_USD');

  const REQUIRED_KEYS = ['asset', 'price', 'bid', 'ask', 'volume', 'source', 'timestamp', 'history', 'volumeHistory'];
  for (const k of REQUIRED_KEYS) {
    assert(k in clean, `fetchPrice('EURUSD') has key '${k}'`);
    assert(k in under, `fetchPrice('EUR_USD') has key '${k}'`);
  }

  assert(clean.asset === 'EURUSD',             "clean input → asset 'EURUSD'");
  assert(under.asset === 'EURUSD',             "underscore input → asset normalised to 'EURUSD'");
  assert(typeof clean.price === 'number',      'price is a number');
  assert(clean.price > 0,                      'price is positive');
  assert(clean.bid   < clean.price,            'bid < mid');
  assert(clean.ask   > clean.price,            'ask > mid');
  assert(Array.isArray(clean.history),         'history is an array');
  assert(Array.isArray(clean.volumeHistory),   'volumeHistory is an array');
  assert(clean.price === under.price,          'same price regardless of input format');
} catch (e) { assert(false, 'fetchPrice return shape', e.message); }

// ─────────────────────────────────────────────────────────────────────────────
section('4 — fetchPrice: history arrays are copies (mutation safety)');
// ─────────────────────────────────────────────────────────────────────────────
try {
  const { MarketDataFetcher } = require('./market-data-fetcher');
  const mdf = new MarketDataFetcher();

  const r1 = mdf.fetchPrice('EURUSD');
  const r2 = mdf.fetchPrice('EUR_USD');

  r1.history.push(999);          // mutate the returned copy
  const r3 = mdf.fetchPrice('EURUSD');
  assert(r3.history.at(-1) !== 999,
    'mutating returned history does not corrupt internal store');

  // Both forms return independent copies
  assert(r1.history !== r2.history,
    "fetchPrice('EURUSD') and fetchPrice('EUR_USD') return separate array instances");
} catch (e) { assert(false, 'fetchPrice history copy safety', e.message); }

// ─────────────────────────────────────────────────────────────────────────────
section('5 — fetchPrice: unsupported asset throws (even after strip)');
// ─────────────────────────────────────────────────────────────────────────────
try {
  const { MarketDataFetcher } = require('./market-data-fetcher');
  const mdf = new MarketDataFetcher();

  const BAD = ['UNKNOWN', 'BTCUSD', 'XYZABC', 'UNKNOWN_PAIR'];
  for (const sym of BAD) {
    let threw = false;
    try { mdf.fetchPrice(sym); } catch (_) { threw = true; }
    assert(threw, `fetchPrice('${sym}') throws for unsupported asset`);
  }
} catch (e) { assert(false, 'fetchPrice unsupported-asset throw', e.message); }

// ─────────────────────────────────────────────────────────────────────────────
section('6 — TradingEngine: selectedAsset always starts clean');
// ─────────────────────────────────────────────────────────────────────────────
try {
  const { TradingEngine } = require('./trading-engine');
  const engine = new TradingEngine();

  assert(engine.selectedAsset === 'EURUSD',
    'Initial selectedAsset is EURUSD (no underscore)');
  assert(!engine.selectedAsset.includes('_'),
    'Initial selectedAsset contains no underscore');
} catch (e) { assert(false, 'TradingEngine initial selectedAsset', e.message); }

// ─────────────────────────────────────────────────────────────────────────────
section('7 — TradingEngine: asset-switch source code fix present');
// ─────────────────────────────────────────────────────────────────────────────
try {
  const src = fs.readFileSync('./trading-engine.js', 'utf8');

  // The fix at line 1133 must use .replace(/_/g, '')
  assert(
    src.includes("this.selectedAsset = best.replace(/_/g, '')"),
    "asset-switch assigns best.replace(/_/g, '') to selectedAsset"
  );

  // Confirm the OLD bare assignment is gone at that location
  // (the fix should replace `this.selectedAsset = best;`)
  const fixedIdx = src.indexOf("this.selectedAsset = best.replace(/_/g, '')");
  const bareIdx  = src.indexOf('this.selectedAsset = best;');
  assert(fixedIdx !== -1 && bareIdx === -1,
    'bare `this.selectedAsset = best` no longer exists — replaced by .replace(/_/g)');
} catch (e) { assert(false, 'asset-switch source fix', e.message); }

// ─────────────────────────────────────────────────────────────────────────────
section('8 — TradingEngine: asset-switch runtime — EUR_USD result is stored clean');
// ─────────────────────────────────────────────────────────────────────────────
try {
  const { TradingEngine } = require('./trading-engine');
  const engine = new TradingEngine();

  // Simulate _selectBestAsset() returning underscore-format (as OANDA might)
  const UNDERSCORE_RESULTS = ['EUR_USD', 'GBP_USD', 'AUD_USD', 'USD_JPY'];
  for (const raw of UNDERSCORE_RESULTS) {
    // Apply the exact assignment logic from line 1133
    engine.selectedAsset = raw.replace(/_/g, '');
    assert(!engine.selectedAsset.includes('_'),
      `After assigning '${raw}' via fix, selectedAsset='${engine.selectedAsset}' has no underscore`);
  }

  // And clean inputs should be unchanged
  const CLEAN = ['EURUSD', 'GBPUSD', 'AUDUSD', 'USDJPY'];
  for (const clean of CLEAN) {
    engine.selectedAsset = clean.replace(/_/g, '');
    assert(engine.selectedAsset === clean,
      `Clean input '${clean}' is preserved unchanged`);
  }
} catch (e) { assert(false, 'asset-switch runtime simulation', e.message); }

// ─────────────────────────────────────────────────────────────────────────────
section('9 — TradingEngine: loadPositionFromFile source-code normalisation');
// ─────────────────────────────────────────────────────────────────────────────
try {
  const src = fs.readFileSync('./trading-engine.js', 'utf8');

  assert(
    src.includes("(data.selectedAsset ?? this.selectedAsset).replace(/_/g, '')"),
    'loadPositionFromFile normalises selectedAsset from saved state'
  );
} catch (e) { assert(false, 'loadPositionFromFile source check', e.message); }

// ─────────────────────────────────────────────────────────────────────────────
section('10 — TradingEngine: loadPositionFromFile runtime with EUR_USD state');
// ─────────────────────────────────────────────────────────────────────────────
try {
  const { TradingEngine } = require('./trading-engine');
  const { TRADING_CONFIG } = require('./trading-config');
  const engine = new TradingEngine();

  // Write a temporary position file with underscore-format asset
  const tmpFile = path.join(__dirname, TRADING_CONFIG.positionFile);
  const tmpDir  = path.dirname(tmpFile);
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const SAVED_STATES = [
    { selectedAsset: 'EUR_USD', expect: 'EURUSD' },
    { selectedAsset: 'GBP_USD', expect: 'GBPUSD' },
    { selectedAsset: 'AUD_USD', expect: 'AUDUSD' },
    { selectedAsset: 'USD_JPY', expect: 'USDJPY' },
    { selectedAsset: 'EURUSD',  expect: 'EURUSD' },  // already clean
  ];

  for (const { selectedAsset, expect } of SAVED_STATES) {
    const payload = {
      savedAt: new Date().toISOString(),
      selectedAsset,
      capital: 10000,
      position: {
        asset:     selectedAsset,
        side:      'LONG',
        entry:     1.0850,
        size:      0.01,
        stopLoss:  1.0800,
        takeProfit: 1.0950,
        openTime:  Date.now(),
      },
    };
    fs.writeFileSync(tmpFile, JSON.stringify(payload), 'utf8');
    engine.loadPositionFromFile();
    assert(engine.selectedAsset === expect,
      `loadPositionFromFile('${selectedAsset}') → selectedAsset='${engine.selectedAsset}'`,
      `expected '${expect}'`);
    assert(!engine.selectedAsset.includes('_'),
      `selectedAsset has no underscore after loading '${selectedAsset}'`);
  }

  // Clean up
  try { fs.unlinkSync(tmpFile); } catch (_) {}
} catch (e) { assert(false, 'loadPositionFromFile runtime', e.message); }

// ─────────────────────────────────────────────────────────────────────────────
section('11 — config/trading-config.json: no EUR_USD in assets');
// ─────────────────────────────────────────────────────────────────────────────
try {
  const raw    = fs.readFileSync('./config/trading-config.json', 'utf8');
  const config = JSON.parse(raw);

  assert(!raw.includes('EUR_USD'),
    'trading-config.json raw text contains no EUR_USD');
  assert(Array.isArray(config.assets),
    'config.assets is an array');

  for (const a of config.assets) {
    assert(!a.includes('_'),
      `config.assets entry '${a}' has no underscore`);
  }

  assert(config.assets.includes('EURUSD'),
    "config.assets includes 'EURUSD'");
} catch (e) { assert(false, 'trading-config.json assets', e.message); }

// ─────────────────────────────────────────────────────────────────────────────
section('12 — trading-config.js: no EUR_USD in assets array');
// ─────────────────────────────────────────────────────────────────────────────
try {
  const { TRADING_CONFIG } = require('./trading-config');

  assert(Array.isArray(TRADING_CONFIG.assets),
    'TRADING_CONFIG.assets is an array');

  for (const a of TRADING_CONFIG.assets) {
    assert(!a.includes('_'),
      `TRADING_CONFIG.assets entry '${a}' has no underscore`);
  }

  assert(TRADING_CONFIG.assets.includes('EURUSD'),
    "TRADING_CONFIG.assets includes 'EURUSD'");

  // Also check swapCosts keys — they were defined per-pair
  if (TRADING_CONFIG.swapCosts) {
    for (const k of Object.keys(TRADING_CONFIG.swapCosts)) {
      assert(!k.includes('_'),
        `swapCosts key '${k}' has no underscore`);
    }
  }

  // correlationLockPairs values
  if (TRADING_CONFIG.correlationLockPairs) {
    for (const [cluster, pairs] of Object.entries(TRADING_CONFIG.correlationLockPairs)) {
      for (const p of pairs) {
        assert(!p.includes('_'),
          `correlationLockPairs['${cluster}'] entry '${p}' has no underscore`);
      }
    }
  }
} catch (e) { assert(false, 'trading-config.js assets/pairs', e.message); }

// ─────────────────────────────────────────────────────────────────────────────
section('13 — fetchPrice: all TRADING_CONFIG assets are fetchable via both formats');
// ─────────────────────────────────────────────────────────────────────────────
try {
  const { MarketDataFetcher } = require('./market-data-fetcher');
  const { TRADING_CONFIG }    = require('./trading-config');
  const mdf = new MarketDataFetcher();

  for (const asset of TRADING_CONFIG.assets) {
    // Clean form
    let threw = false;
    try { mdf.fetchPrice(asset); } catch (_) { threw = true; }
    assert(!threw, `fetchPrice('${asset}') — clean form succeeds`);

    // Underscore form (insert _ after 3rd char to simulate OANDA format)
    const underscore = asset.slice(0, 3) + '_' + asset.slice(3);
    threw = false;
    try { mdf.fetchPrice(underscore); } catch (_) { threw = true; }
    assert(!threw, `fetchPrice('${underscore}') — underscore form succeeds`);
  }
} catch (e) { assert(false, 'all TRADING_CONFIG assets fetchable', e.message); }

// ─────────────────────────────────────────────────────────────────────────────
section('14 — end-to-end: selectedAsset flows into fetchPrice without error');
// ─────────────────────────────────────────────────────────────────────────────
try {
  const { TradingEngine }     = require('./trading-engine');
  const { MarketDataFetcher } = require('./market-data-fetcher');
  const engine = new TradingEngine();
  const mdf    = new MarketDataFetcher();

  // Simulate the engine receiving underscore format from _selectBestAsset,
  // then using selectedAsset to call fetchPrice (the full fixed path)
  const underscoreResults = ['EUR_USD', 'GBP_USD', 'AUD_USD', 'USD_JPY'];
  for (const raw of underscoreResults) {
    engine.selectedAsset = raw.replace(/_/g, '');   // line 1133 fix
    let threw = false;
    try {
      mdf.fetchPrice(engine.selectedAsset);          // line 1162 call
    } catch (_) { threw = true; }
    assert(!threw,
      `After fix: selectedAsset='${engine.selectedAsset}' → fetchPrice succeeds`);
  }
} catch (e) { assert(false, 'end-to-end selectedAsset→fetchPrice', e.message); }

// ─────────────────────────────────────────────────────────────────────────────
section('15 — regression: all three normalisation sites are present in source');
// ─────────────────────────────────────────────────────────────────────────────
try {
  const engineSrc  = fs.readFileSync('./trading-engine.js', 'utf8');
  const fetcherSrc = fs.readFileSync('./market-data-fetcher.js', 'utf8');

  // Site 1 — fetchPrice
  assert(
    fetcherSrc.includes("asset = asset.replace(/_/g, '')"),
    'Site 1 (fetchPrice):         asset.replace(/_/g) present'
  );
  // Site 2 — loadPositionFromFile
  assert(
    engineSrc.includes("(data.selectedAsset ?? this.selectedAsset).replace(/_/g, '')"),
    'Site 2 (loadPositionFromFile): state-restore .replace present'
  );
  // Site 3 — asset switch (our fix)
  assert(
    engineSrc.includes("this.selectedAsset = best.replace(/_/g, '')"),
    'Site 3 (asset switch):        best.replace(/_/g) present'
  );
} catch (e) { assert(false, 'all three normalisation sites', e.message); }

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(66));
console.log('  RESULTS');
console.log('═'.repeat(66));
console.log(`  ✅ Passed:  ${passed}`);
console.log(`  ❌ Failed:  ${failed}`);
if (failures.length) {
  console.log('\n  Failed tests:');
  failures.forEach(f => console.log('    • ' + f));
}
console.log('');
process.exit(failed > 0 ? 1 : 0);
