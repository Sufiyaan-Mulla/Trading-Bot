-- Migration 003: Track spread at entry
ALTER TABLE trades ADD COLUMN spreadAtEntry REAL;
ALTER TABLE trades ADD COLUMN slippageActual REAL;
