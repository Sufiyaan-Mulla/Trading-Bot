'use strict';
// ── indicator-schema.js ───────────────────────────────────────────────────────
// Single source of truth for the indicator snapshot shape.
// Uses Zod to parse + coerce the raw object returned by calculateIndicators()
// before it reaches any strategy. Eliminates all ad-hoc typeof/parseFloat
// coercions scattered across strategy files.
//
// Usage:
//   const { normaliseIndicators } = require('./indicator-schema');
//   const indicators = normaliseIndicators(rawSnapshot);  // throws on bad schema
// ─────────────────────────────────────────────────────────────────────────────

const { z } = require('zod');

// Coerce strings to numbers — handles calculateIndicators() returning toFixed() strings
const num = (fallback = 0) =>
  z.union([z.number(), z.string()])
    .transform(v => { const n = typeof v === 'string' ? parseFloat(v) : v; return isNaN(n) ? fallback : n; })
    .default(fallback);

const IndicatorSchema = z.object({
  // Price levels
  price:       num(0),
  vwap:        num(0),

  // EMAs
  ema9:        num(0),
  ema21:       num(0),
  ema50:       num(0),
  ema200:      num(0),
  ema50Slope:  num(0),

  // Momentum
  rsi:         num(50),
  macd:        num(0),
  prevMacd:    num(null).nullable().optional(),
  prevRsi:     num(null).nullable().optional(),

  // Volatility
  atr:         num(0),
  atrPercent:  num(0),
  volatilityLevel: z.string().default('NORMAL'),

  // Bollinger Bands
  bb: z.object({
    upper:  num(0),
    middle: num(0),
    lower:  num(0),
  }).optional().default({ upper: 0, middle: 0, lower: 0 }),

  // Volume
  volRatio:    num(1),
  avgVolume:   num(0),

  // Regime
  signal:         z.string().default('NEUTRAL'),
  marketRegime:   z.string().default('UNKNOWN'),
  adxRegime:      z.string().default('UNKNOWN'),
  adx:            num(0),
  goldenCross:    z.boolean().default(false),
  deathCross:     z.boolean().default(false),

  // Liquidity
  liquidityScore:      num(50),
  liquidityRegime:     z.string().default('NORMAL'),
  liquidityMultiplier: num(1),
  liquidityBlocked:    z.boolean().default(false),

  // Divergence
  divergence: z.object({
    bullish: z.boolean().default(false),
    bearish: z.boolean().default(false),
    type:    z.string().default('NONE'),
  }).optional().default({ bullish: false, bearish: false, type: 'NONE' }),

  // Support / Resistance
  sr: z.object({
    atSupport:    z.boolean().default(false),
    atResistance: z.boolean().default(false),
    entryQuality: z.string().default('WEAK'),
    confluenceScore: num(0),
    rrRatio:      z.number().nullable().optional(),
    nearestSupport:    z.any().optional(),
    nearestResistance: z.any().optional(),
    supports:     z.array(z.any()).default([]),
    resistances:  z.array(z.any()).default([]),
    pivots:       z.any().optional(),
  }).optional().default({}),

  // Dynamic SL/TP
  dynamicLevels: z.object({
    stopLoss:   num(0),
    takeProfit: num(0),
    vwapLevel:  num(0),
  }).optional(),

  // Multi-timeframe & leading
  mta:          z.any().optional(),
  leadingSignal: z.any().optional(),
  performanceState: z.any().optional(),

  // Freshness — always present after normalise()
  computedAt:   z.number().default(() => Date.now()),

  // Passthrough for anything extra
}).passthrough();

/**
 * Parse and coerce a raw indicator snapshot.
 * Converts string numbers → numbers, fills missing fields with safe defaults.
 * Throws a ZodError if a required field is structurally wrong.
 */
function normaliseIndicators(raw) {
  return IndicatorSchema.parse(raw);
}

/**
 * Safe version — returns null on validation failure (with a console warning).
 * Use this at the strategy boundary where a throw would halt the engine.
 */
function safeNormaliseIndicators(raw) {
  const result = IndicatorSchema.safeParse(raw);
  if (!result.success) {
    console.warn('[IndicatorSchema] Validation failed:', result.error.issues.slice(0, 3).map(i => i.path.join('.') + ': ' + i.message).join(' | '));
    return null;
  }
  return result.data;
}

module.exports = { normaliseIndicators, safeNormaliseIndicators, IndicatorSchema };
