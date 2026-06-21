'use strict';
// ── timeseries-store.js ───────────────────────────────────────────────────────
// Time-series storage adapter. Writes to:
//   - trade_logs/timeseries.jsonl  (always, zero-dependency)
//   - TimescaleDB via pg driver    (when TIMESCALE_URL env is set)
//
// Tables / series stored:
//   prices    (asset, price, bid, ask, volume, ts)
//   trades    (all fields from trade records)
//   metrics   (capital, drawdown, winRate, ts)
//
// Usage:
//   const ts = require('./timeseries-store');
//   ts.writePrice('EURUSD', { price: 1.085, bid: 1.0849, ask: 1.0851, volume: 50000 });
//   ts.writeTrade(tradeRecord);
//   ts.writeMetric({ capital: 10230, drawdown: 0.01, winRate: 0.62 });
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'trade_logs');
const LOG_FILE = path.join(LOG_DIR, 'timeseries.jsonl');
const MAX_BYTES = 100 * 1024 * 1024;  // 100 MB — rotate

// ── TimescaleDB client (optional — only used when TIMESCALE_URL is set) ─────
let pgPool = null;
let _schemaEnsured = false;  // BUG-25 fix: only run CREATE TABLE once per process
function _getPgPool() {
  if (pgPool) return pgPool;
  if (!process.env.TIMESCALE_URL) return null;
  try {
    const { Pool } = require('pg');
    pgPool = new Pool({ connectionString: process.env.TIMESCALE_URL });
    pgPool.on('error', () => { pgPool = null; });  // reset on failure
    return pgPool;
  } catch (_) { return null; }
}

// ── Bootstrap TimescaleDB schema (hypertables) ────────────────────────────
async function _ensureSchema(pool) {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS prices (
        ts        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        asset     TEXT        NOT NULL,
        price     DOUBLE PRECISION,
        bid       DOUBLE PRECISION,
        ask       DOUBLE PRECISION,
        volume    DOUBLE PRECISION
      );
      SELECT create_hypertable('prices','ts', if_not_exists => TRUE);

      CREATE TABLE IF NOT EXISTS trades (
        ts         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        id         INTEGER, asset TEXT, side TEXT,
        entry      DOUBLE PRECISION, exit DOUBLE PRECISION,
        profit     DOUBLE PRECISION, reason TEXT,
        confidence DOUBLE PRECISION, regime TEXT
      );
      SELECT create_hypertable('trades','ts', if_not_exists => TRUE);

      CREATE TABLE IF NOT EXISTS metrics (
        ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        capital     DOUBLE PRECISION,
        drawdown    DOUBLE PRECISION,
        win_rate    DOUBLE PRECISION,
        open_trades INTEGER
      );
      SELECT create_hypertable('metrics','ts', if_not_exists => TRUE);
    `);
  } catch (_) {}  // hypertable may already exist
}

// ── Local JSONL append ────────────────────────────────────────────────────
function _localAppend(type, record) {
  setImmediate(() => {
    try {
      if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
      if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_BYTES) {
        fs.renameSync(LOG_FILE, LOG_FILE + '.' + Date.now());
      }
      // Bug fix: JSON.stringify throws on circular refs in trade/price objects.
      // The logger path must never throw — wrap in a safe serialiser.
      const seen = new WeakSet();
      const safeJSON = JSON.stringify({ type, ts: new Date().toISOString(), ...record }, (k, v) => {
        if (typeof v === 'object' && v !== null) { if (seen.has(v)) return '[Circular]'; seen.add(v); }
        return (typeof v === 'number' && !isFinite(v)) ? null : v;  // NaN/Inf → null in JSONL
      });
      try { fs.appendFileSync(LOG_FILE, safeJSON + '\n'); } catch(e) { console.error('[TS] disk full?', e.message); }
    } catch (_) {}
  });
}

// ── Public API ────────────────────────────────────────────────────────────
const store = {
  writePrice(asset, data) {
    _localAppend('price', { asset, ...data });
    const pool = _getPgPool();
    if (pool) {
      const doWrite = () => pool.query(
        'INSERT INTO prices (asset, price, bid, ask, volume) VALUES ($1,$2,$3,$4,$5)',
        [asset, data.price, data.bid, data.ask, data.volume]
      ).catch(() => {});
      if (_schemaEnsured) { doWrite(); }
      else { _ensureSchema(pool).then(() => { _schemaEnsured = true; doWrite(); }); }
    }
  },

  writeTrade(trade) {
    _localAppend('trade', trade);
    const pool = _getPgPool();
    if (pool) {
      const doWrite = () => pool.query(
        'INSERT INTO trades (id,asset,side,entry,exit,profit,reason,confidence,regime) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [trade.id, trade.asset, trade.type, trade.entry, trade.exit, trade.profit,
         trade.reason, trade.rawConfidence, trade.regime]
      ).catch(() => {});
      if (_schemaEnsured) { doWrite(); }
      else { _ensureSchema(pool).then(() => { _schemaEnsured = true; doWrite(); }); }
    }
  },

  writeMetric(data) {
    _localAppend('metric', data);
    const pool = _getPgPool();
    if (pool) {
      const doWrite = () => pool.query(
        'INSERT INTO metrics (capital, drawdown, win_rate, open_trades) VALUES ($1,$2,$3,$4)',
        [data.capital, data.drawdown, data.winRate, data.openTrades || 0]
      ).catch(() => {});
      if (_schemaEnsured) { doWrite(); }
      else { _ensureSchema(pool).then(() => { _schemaEnsured = true; doWrite(); }); }
    }
  },

  // Query last N price records (JSONL fallback when no TimescaleDB)
  queryPrices(asset, n = 100) {
    try {
      const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').filter(Boolean);
      return lines
        .map(l => { try { return JSON.parse(l); } catch(_) { return null; } })
        .filter(r => r && r.type === 'price' && r.asset === asset)
        .slice(-n);
    } catch (_) { return []; }
  },
};

module.exports = store;
