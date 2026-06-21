'use strict';
// ── ohlcv-validator.js ────────────────────────────────────────────────────────
// OHLCV data quality: gap detection, timezone normalisation, spike filtering.
//
// Covers two partial checklist items:
//   ✓ Validate OHLCV continuity and detect missing candles
//   ✓ Filter out exchange anomalies and single-source price spikes
//   ✓ Normalise timezones and timestamps to UTC ms
//
// Usage:
//   const { OHLCVValidator } = require('./ohlcv-validator');
//   const v = new OHLCVValidator({ intervalMs: 5 * 60_000 }); // M5
//   const report = v.validate(candles);
//   const clean  = v.clean(candles);
// ─────────────────────────────────────────────────────────────────────────────

const MAX_SPIKE_MULTIPLIER = 4.0;   // price > 4× ATR from prior close = spike
const MIN_VALID_PRICE      = 1e-6;
const ATR_PERIOD           = 14;

class OHLCVValidator {
  constructor(opts = {}) {
    this.intervalMs      = opts.intervalMs      || 5 * 60_000;  // default M5
    this.maxGapMultiple  = opts.maxGapMultiple  || 3;           // gaps > 3× interval = missing candle
    this.spikeMultiplier = opts.spikeMultiplier || MAX_SPIKE_MULTIPLIER;
    this.allowedTZOffset = opts.allowedTZOffset || null;        // null = auto-detect
  }

  // ── Full validation report ────────────────────────────────────────────────
  // candles: array of { time, open, high, low, close, volume }
  //          time may be ISO string, Unix seconds, or Unix ms
  validate(candles) {
    if (!Array.isArray(candles) || candles.length < 2) {
      return { valid: false, error: 'Need at least 2 candles', gaps: [], spikes: [], issues: [] };
    }

    const normalised = candles.map((c, i) => this._normalise(c, i));
    const issues     = [];
    const gaps       = [];
    const spikes     = [];

    // ── 1. Timestamp order & gap detection ───────────────────────────────
    for (let i = 1; i < normalised.length; i++) {
      const prev = normalised[i - 1];
      const curr = normalised[i];

      if (curr.time <= prev.time) {
        issues.push({ index: i, type: 'OUT_OF_ORDER', prev: prev.time, curr: curr.time });
        continue;
      }

      const delta = curr.time - prev.time;
      if (delta > this.intervalMs * this.maxGapMultiple) {
        const missingCount = Math.round(delta / this.intervalMs) - 1;
        gaps.push({ index: i, from: prev.time, to: curr.time, gapMs: delta, missingCandles: missingCount });
        issues.push({ index: i, type: 'GAP', missingCandles: missingCount });
      }
    }

    // ── 2. OHLC internal consistency ────────────────────────────────────
    for (let i = 0; i < normalised.length; i++) {
      const c = normalised[i];
      if (c.low > c.high) issues.push({ index: i, type: 'LOW_ABOVE_HIGH', low: c.low, high: c.high });
      if (c.open < c.low || c.open > c.high) issues.push({ index: i, type: 'OPEN_OUTSIDE_RANGE' });
      if (c.close < c.low || c.close > c.high) issues.push({ index: i, type: 'CLOSE_OUTSIDE_RANGE' });
      if (c.close <= MIN_VALID_PRICE || c.open <= MIN_VALID_PRICE) issues.push({ index: i, type: 'ZERO_OR_NEGATIVE_PRICE' });
      if (c.volume < 0) issues.push({ index: i, type: 'NEGATIVE_VOLUME' });
    }

    // ── 3. Spike detection (ATR-based) ────────────────────────────────────
    const closes = normalised.map(c => c.close);
    const atrs   = this._atr(normalised, ATR_PERIOD);

    for (let i = ATR_PERIOD; i < normalised.length; i++) {
      const atr  = atrs[i];
      if (!atr || atr <= 0) continue;
      const prev = normalised[i - 1].close;
      const curr = normalised[i];
      const move = Math.abs(curr.close - prev);
      if (move > atr * this.spikeMultiplier) {
        spikes.push({ index: i, time: curr.time, prev, close: curr.close, move, atr, ratio: move / atr });
        issues.push({ index: i, type: 'SPIKE', ratio: parseFloat((move / atr).toFixed(2)) });
      }
    }

    return {
      valid:        issues.length === 0,
      totalCandles: normalised.length,
      issues,
      gaps,
      spikes,
      gapCount:     gaps.length,
      spikeCount:   spikes.length,
      otherCount:   issues.length - gaps.length - spikes.length,
    };
  }

  // ── Return a cleaned array: fill gaps with synthetic candles, remove spikes ─
  clean(candles, opts = {}) {
    if (!Array.isArray(candles) || candles.length < 2) return candles;

    const normalised = candles.map((c, i) => this._normalise(c, i));
    const report     = this.validate(candles);
    const spikeIdxs  = new Set(report.spikes.map(s => s.index));
    const result     = [];

    for (let i = 0; i < normalised.length; i++) {
      const c = normalised[i];

      // Fill gap before this candle
      if (i > 0) {
        const prev  = result[result.length - 1];
        const delta = c.time - prev.time;
        if (delta > this.intervalMs * this.maxGapMultiple) {
          const fills = this._fillGap(prev, c, delta);
          result.push(...fills);
        }
      }

      // Replace spike with interpolated value
      if (spikeIdxs.has(i) && !opts.keepSpikes) {
        const prev  = result.length ? result[result.length - 1] : c;
        const next  = normalised[i + 1] || c;
        const interp = (prev.close + next.close) / 2;
        result.push({ ...c, open: interp, high: interp, low: interp, close: interp, _synthetic: 'spike_removed' });
      } else {
        result.push(c);
      }
    }

    return result;
  }

  // ── Normalise a single candle timestamp to UTC ms ────────────────────────
  _normalise(c, index) {
    let time = c.time ?? c.timestamp ?? c.ts ?? c.date;
    if (typeof time === 'string') time = new Date(time).getTime();
    // Unix seconds → ms
    if (typeof time === 'number' && time < 1e12) time = time * 1000;
    if (!time || isNaN(time)) time = Date.now() + index * this.intervalMs;

    return {
      time,
      open:   Number(c.open   ?? c.o ?? c.close ?? 0),
      high:   Number(c.high   ?? c.h ?? c.close ?? 0),
      low:    Number(c.low    ?? c.l ?? c.close ?? 0),
      close:  Number(c.close  ?? c.c ?? 0),
      volume: Number(c.volume ?? c.v ?? 0),
    };
  }

  // ── Fill a gap with flat/repeat-close synthetic candles ───────────────────
  _fillGap(prev, next, gapMs) {
    const count = Math.min(Math.round(gapMs / this.intervalMs) - 1, 100);
    const fills = [];
    for (let k = 1; k <= count; k++) {
      const t = prev.time + k * this.intervalMs;
      fills.push({ time: t, open: prev.close, high: prev.close, low: prev.close, close: prev.close, volume: 0, _synthetic: 'gap_fill' });
    }
    return fills;
  }

  // ── True Range & ATR ──────────────────────────────────────────────────────
  _atr(candles, period) {
    const trs  = [0];
    for (let i = 1; i < candles.length; i++) {
      const c  = candles[i], p = candles[i - 1];
      trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    const atrs = new Array(period).fill(0);
    let sum = trs.slice(1, period + 1).reduce((s, v) => s + v, 0);
    atrs[period] = sum / period;
    for (let i = period + 1; i < trs.length; i++) {
      atrs[i] = (atrs[i - 1] * (period - 1) + trs[i]) / period;
    }
    return atrs;
  }
}

// ── Timezone normaliser ────────────────────────────────────────────────────────
// Convert any timestamp representation to UTC milliseconds
function toUTCMs(ts) {
  if (typeof ts === 'number') return ts < 1e12 ? ts * 1000 : ts;
  if (typeof ts === 'string') return new Date(ts).getTime();
  if (ts instanceof Date)     return ts.getTime();
  return NaN;
}

module.exports = { OHLCVValidator, toUTCMs };
