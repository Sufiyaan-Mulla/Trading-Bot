'use strict';
// wyckoff.js — Item 47: Wyckoff Accumulation/Distribution Phase Identification
// Identifies which Wyckoff phase the market is in:
// Accumulation: PS → SC → AR → ST → Spring → Test → SOS → BU
// Distribution: PSY → BC → AR → ST → UTAD → LPSY → SOW

class WyckoffAnalyser {
  constructor() {
    this._phase  = 'UNKNOWN';
    this._events = [];
  }

  analyse(prices, volumes, atr) {
    if (!prices || prices.length < 30) return { phase:'UNKNOWN', confidence:0 };
    const n    = prices.length;
    const _atr = atr || prices.slice(-14).reduce((s,v,i,a)=>i?s+Math.abs(v-a[i-1]):s,0)/13||0.001;
    const high = Math.max(...prices.slice(-30));
    const low  = Math.min(...prices.slice(-30));
    const range = high - low;
    const curr  = prices.at(-1);
    // Volume analysis
    const avgVol = volumes?.length ? volumes.slice(-20).reduce((s,v)=>s+v,0)/20 : 1;
    const lastVol = volumes?.at(-1) || avgVol;
    const highVol = lastVol > avgVol * 1.5;

    // Phase A: Stopping action (high vol at extremes)
    const nearLow  = (curr - low)  / range < 0.15;
    const nearHigh = (high - curr) / range < 0.15;

    if (nearLow && highVol)  return { phase:'ACCUMULATION_A', confidence:65, note:'Selling climax (SC) candidate' };
    if (nearHigh && highVol) return { phase:'DISTRIBUTION_A', confidence:65, note:'Buying climax (BC) candidate' };
    // Phase B: Building cause (range-bound)
    const isRanging = range < _atr * 8;
    if (isRanging) return { phase:'PHASE_B_CAUSE', confidence:55, note:'Building cause in trading range' };
    // Phase C: Spring/UTAD test
    if (nearLow && !highVol)  return { phase:'ACCUMULATION_C', confidence:60, note:'Spring — test without volume' };
    if (nearHigh && !highVol) return { phase:'DISTRIBUTION_C', confidence:60, note:'UTAD — test without volume' };
    // Phase D/E: Trending
    const momentum = prices.at(-1) - prices.at(-10);
    if (momentum > _atr * 3) return { phase:'MARKUP', confidence:65, note:'SOS — mark-up phase' };
    if (momentum < -_atr * 3) return { phase:'MARKDOWN', confidence:65, note:'SOW — mark-down phase' };
    return { phase:'UNCLEAR', confidence:30 };
  }
}

module.exports = { WyckoffAnalyser };
