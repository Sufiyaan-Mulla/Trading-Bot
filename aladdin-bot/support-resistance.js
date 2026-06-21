'use strict';
// support-resistance.js — swing high/low, pivot points, proximity scoring

class SupportResistance {

  static swings(prices, lookback) {
    lookback = lookback || 5;
    const highs = [], lows = [], n = prices.length;
    for (let i = lookback; i < n - lookback; i++) {
      const p = prices[i];
      let isHigh = true, isLow = true;
      for (let j = 1; j <= lookback; j++) {
        if (prices[i-j] >= p || prices[i+j] >= p) isHigh = false;
        if (prices[i-j] <= p || prices[i+j] <= p) isLow  = false;
        if (!isHigh && !isLow) break;
      }
      if (isHigh) highs.push({ price: p, index: i });
      if (isLow)  lows.push({  price: p, index: i });
    }
    return { highs, lows };
  }

  static pivotPoints(prices, sessionBars) {
    sessionBars = sessionBars || 288;
    if (prices.length < 2) return null;
    const sl = prices.slice(-Math.min(sessionBars, prices.length));
    const H = Math.max(...sl), L = Math.min(...sl), C = sl[sl.length - 1];
    const PP = (H + L + C) / 3;
    return {
      PP, H, L, C,
      R1: 2*PP - L,  R2: PP + (H-L),  R3: H + 2*(PP-L),
      S1: 2*PP - H,  S2: PP - (H-L),  S3: L - 2*(H-PP),
    };
  }

  static _cluster(levels, clusterPct) {
    clusterPct = clusterPct || 0.0005;
    if (!levels.length) return [];
    const sorted = levels.slice().sort((a,b) => a.price - b.price);
    const out = [];
    let group = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      if (Math.abs(sorted[i].price - group[group.length-1].price) / group[group.length-1].price <= clusterPct) {
        group.push(sorted[i]);
      } else {
        out.push(SupportResistance._merge(group));
        group = [sorted[i]];
      }
    }
    out.push(SupportResistance._merge(group));
    return out;
  }

  static _merge(group) {
    const avg = group.reduce((s,l) => s + l.price, 0) / group.length;
    const str = group.reduce((s,l) => s + (l.strength||1), 0);
    return { price: parseFloat(avg.toFixed(5)), strength: str, touches: group.length, type: group[0].type };
  }

  static analyse(prices, atr, opts) {
    opts = opts || {};
    const lookback     = opts.swingLookback || 5;
    const maxLevels    = opts.maxLevels     || 8;
    const sessionBars  = opts.sessionBars   || 288;
    const proximityATR = opts.proximityATR  || 0.5;

    if (!prices || prices.length < lookback * 2 + 5) return SupportResistance._empty();

    const cur  = prices[prices.length - 1];
    const atrV = atr || cur * 0.001;
    const n    = prices.length;

    const raw = [];
    const { highs, lows } = SupportResistance.swings(prices, lookback);
    for (const h of highs) { const s = 1 + h.index/n; raw.push({ price: h.price, type: 'resistance', strength: s }); }
    for (const l of lows)  { const s = 1 + l.index/n; raw.push({ price: l.price, type: 'support',    strength: s }); }

    const pv = SupportResistance.pivotPoints(prices, sessionBars);
    if (pv) {
      const add = (price, type, w) => raw.push({ price, type, strength: w });
      add(pv.PP, cur >= pv.PP ? 'support' : 'resistance', 2.0);
      add(pv.R1, 'resistance', 1.8); add(pv.R2, 'resistance', 1.5); add(pv.R3, 'resistance', 1.2);
      add(pv.S1, 'support',    1.8); add(pv.S2, 'support',    1.5); add(pv.S3, 'support',    1.2);
    }

    const supports    = SupportResistance._cluster(raw.filter(l => l.type === 'support'))
      .filter(l => l.price < cur).sort((a,b) => b.price - a.price).slice(0, maxLevels);
    const resistances = SupportResistance._cluster(raw.filter(l => l.type === 'resistance'))
      .filter(l => l.price > cur).sort((a,b) => a.price - b.price).slice(0, maxLevels);

    const ns  = supports[0]    || null;
    const nr  = resistances[0] || null;
    const dS  = ns ? (cur - ns.price) / atrV : Infinity;
    const dR  = nr ? (nr.price - cur) / atrV : Infinity;

    const atSupport    = dS <= proximityATR;
    const atResistance = dR <= proximityATR;

    const nearCount = [...supports, ...resistances]
      .filter(l => Math.abs(l.price - cur) / atrV <= 2.0).length;

    const entryQuality = (atSupport || atResistance)
      ? ((atSupport ? ns : nr).touches >= 2 ? 'STRONG' : 'MODERATE')
      : 'WEAK';

    const rrRatio = (dS > 0 && dS < Infinity && dR < Infinity)
      ? parseFloat((dR / dS).toFixed(2)) : null;

    return {
      supports:          supports.map(l    => ({ price: l.price, strength: parseFloat(l.strength.toFixed(2)), touches: l.touches||1 })),
      resistances:       resistances.map(l => ({ price: l.price, strength: parseFloat(l.strength.toFixed(2)), touches: l.touches||1 })),
      nearestSupport:    ns ? { price: ns.price, distATR: parseFloat(dS.toFixed(2)) } : null,
      nearestResistance: nr ? { price: nr.price, distATR: parseFloat(dR.toFixed(2)) } : null,
      atSupport, atResistance,
      confluenceScore: Math.min(100, nearCount * 20),
      entryQuality, rrRatio,
      pivots: pv ? { PP: parseFloat(pv.PP.toFixed(5)), R1: parseFloat(pv.R1.toFixed(5)), S1: parseFloat(pv.S1.toFixed(5)), R2: parseFloat(pv.R2.toFixed(5)), S2: parseFloat(pv.S2.toFixed(5)) } : null,
    };
  }

  static _empty() {
    return { supports:[], resistances:[], nearestSupport:null, nearestResistance:null,
             atSupport:false, atResistance:false, confluenceScore:0, entryQuality:'WEAK', rrRatio:null, pivots:null };
  }
}

module.exports = { SupportResistance };
