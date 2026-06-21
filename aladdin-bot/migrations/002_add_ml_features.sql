-- Migration 002: Add ML feature snapshot column
ALTER TABLE trades ADD COLUMN mlConfidence REAL;
ALTER TABLE trades ADD COLUMN mlFeatures TEXT;
