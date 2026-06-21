/**
 * SAFETY-CONSTANTS.JS — Aladdin Trading Agent
 * ─────────────────────────────────────────────
 * These values are the ABSOLUTE hard limits of the trading system.
 * They are Object.freeze()'d — no code path, AI response, or runtime
 * config update can change them without editing this file manually.
 *
 * Rule: if Claude AI returns an over-confident signal, or if TRADING_CONFIG
 * is misconfigured, these constants are the last line of defence before
 * real money is affected.
 *
 * HOW THEY ARE ENFORCED:
 *   trading-engine.js imports SAFETY and checks every trade against these
 *   values immediately before order execution. Any breach is hard-blocked
 *   and logged as a SAFETY_VIOLATION — the trade is cancelled, not modified.
 *
 * TO CHANGE THESE VALUES:
 *   Edit this file manually, commit the change, and restart the bot.
 *   Do NOT expose these via any API endpoint or runtime config patch.
 */

'use strict';

const SAFETY = Object.freeze({

  // ── Position Sizing ────────────────────────────────────────────────────
  // The absolute maximum fraction of capital that can be risked on a single
  // trade — regardless of what Kelly, AI confidence, or config says.
  // 3% = if you have $10,000, the largest position is $300 (hard failsafe; Kelly already caps at 2%)
  MAX_POSITION_SIZE: 0.03,  // true backstop: Kelly caps at 2% (kellyMaxSize); this is the hard failsafe at 3%

  // Absolute minimum position size — prevents dust trades that cost more
  // in commission than they can ever earn.
  MIN_POSITION_SIZE: 0.001,

  // ── Stop Loss ──────────────────────────────────────────────────────────
  // Stop loss must always be set and within these bounds.
  // A stop loss of 0 (no stop) is never permitted.
  MAX_STOP_LOSS_PCT: 0.05,   // stop can be no wider than 5% from entry
  MIN_STOP_LOSS_PCT: 0.001,  // stop must be at least 0.1% from entry

  // ── Daily Loss ─────────────────────────────────────────────────────────
  // Hard cap on daily loss. Even if TRADING_CONFIG.maxDailyLoss is set
  // higher (misconfiguration), this value overrides it.
  MAX_DAILY_LOSS_PCT: 0.07,  // 7% daily loss = engine stops for 24 hours

  // 24-hour cool-off after daily loss limit is hit.
  // The lock is written to disk — survives process restarts.
  DAILY_LOSS_LOCKOUT_MS: 24 * 60 * 60 * 1000,   // 24 hours in ms

  // ── Flash Crash ────────────────────────────────────────────────────────
  // If price moves more than this % within the detection window below,
  // all BUY orders are blocked for FLASH_CRASH_COOLDOWN_MS.
  FLASH_CRASH_PCT:        0.04,    // 4% move in the detection window
  FLASH_CRASH_WINDOW_MS:  30000,   // 30-second detection window
  FLASH_CRASH_COOLDOWN_MS: 300000, // 5-minute buying pause

  // ── Confidence ─────────────────────────────────────────────────────────
  // AI signals below this confidence are always blocked — regardless of
  // what TRADING_CONFIG.minConfidence is set to.
  MIN_AI_CONFIDENCE: 50,  // lowered from 60: ML typically scores 50-58 for valid signals; 60 was blocking real trades

  // ── Global Drawdown ────────────────────────────────────────────────────
  // If the account ever drops this much from initial capital, the bot
  // halts permanently until manually reset via the API.
  MAX_GLOBAL_DRAWDOWN_PCT: 0.20,   // 20% total account drawdown = permanent halt

  // ── Lockout File ───────────────────────────────────────────────────────
  // Path where the 24-hour daily-loss lockout timestamp is persisted.
  // If the bot restarts while locked, it reads this file and stays locked.
  LOCKOUT_FILE: 'trade_logs/daily_lockout.json',
});

module.exports = { SAFETY };
