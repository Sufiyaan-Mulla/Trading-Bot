-- Migration 001: Initial schema (applied at first boot)
-- Run via: node db-store.js --migrate
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY, asset TEXT, type TEXT, entry REAL, exit REAL,
  profit REAL, profitPercent REAL, confidence INTEGER, strategy TEXT,
  session TEXT, regime TEXT, entryTime INTEGER, exitTime INTEGER, reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_trades_asset ON trades(asset);
CREATE INDEX IF NOT EXISTS idx_trades_exit  ON trades(exitTime);
