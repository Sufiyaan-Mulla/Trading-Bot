'use strict';
// ── liquidity-heatmap.js ──────────────────────────────────────────────────────
// Approximates a liquidity heatmap from price history + S/R data.
//
// Real liquidity heatmaps need L2 order book data. We approximate from:
//   1. Volume-weighted price clusters (price levels where volume concentrated)
//   2. Swing high/low density (more touches = more liquidity at that level)
//   3. Pivot point zones (floor-trader pivots attract liquidity)
//   4. Round number magnetism (1.0800, 1.0850 attract stops/orders)
//
// Output: array of price zones sorted by liquidity score, highlighting where
// large stop clusters and limit orders are likely to exist.
//
// Usage:
//   const { LiquidityHeatmap } = require('./liquidity-heatmap');
//   const hm = LiquidityHeatmap.build(prices, volumes, atr);
//   console.log(hm.zones);           // sorted by liquidity concentration
//   console.log(hm.magnetLevels);    // round numbers near current price
//   console.log(hm.stopClusters);    // likely stop-loss concentration zones
// ─────────────────────────────────────────────────────────────────────────────

const { SupportResistance } = require('./support-resistance');

class LiquidityHeatmap {

  // ── Build heatmap from price + volume history ────────────────────────────
  static build(prices, volumes, atr, opts = {}) {
    if (!prices || prices.length < 20) return LiquidityHeatmap._empty();

    const cur     = prices[prices.length - 1];
    const atrVal  = atr || cur * 0.001;
    const zoneWidth = opts.zoneWidth || atrVal * 0.5;  // merge zones within 0.5 ATR
    const lookRange = opts.lookRange || atrVal * 10;    // look 10 ATR up/down

    // ── 1. Volume-at-price clusters ─────────────────────────────────────────
    const vap = LiquidityHeatmap._volumeAtPrice(prices, volumes, zoneWidth);

    // ── 2. Swing high/low density from S/R ──────────────────────────────────
    const { highs, lows } = SupportResistance.swings(prices, 5);
    const swingLevels = [
      ...highs.map(h => ({ price: h.price, type: 'resistance', weight: 2 })),
      ...lows.map(l  => ({ price: l.price, type: 'support',    weight: 2 })),
    ];

    // ── 3. Pivot points ──────────────────────────────────────────────────────
    const pivots = SupportResistance.pivotPoints(prices, 288);
    const pivotLevels = pivots ? [
      { price: pivots.PP,  type: 'neutral',    weight: 3 },
      { price: pivots.R1,  type: 'resistance', weight: 2.5 },
      { price: pivots.S1,  type: 'support',    weight: 2.5 },
      { price: pivots.R2,  type: 'resistance', weight: 2 },
      { price: pivots.S2,  type: 'support',    weight: 2 },
    ] : [];

    // ── 4. Round number magnetism ────────────────────────────────────────────
    const roundLevels = LiquidityHeatmap._roundNumbers(cur, lookRange, atrVal);

    // ── Combine and score all levels ─────────────────────────────────────────
    const allLevels = [
      ...vap,
      ...swingLevels,
      ...pivotLevels,
      ...roundLevels,
    ].filter(l => l.price > 0 && Math.abs(l.price - cur) <= lookRange);

    // Cluster nearby levels
    const zones = LiquidityHeatmap._clusterZones(allLevels, zoneWidth * 2);

    // Normalise scores to 0–100
    const maxScore = Math.max(...zones.map(z => z.score), 1);
    zones.forEach(z => { z.score = Math.round((z.score / maxScore) * 100); });
    zones.sort((a, b) => b.score - a.score);

    // ── Stop clusters: 1–2 ATR beyond swing highs/lows ──────────────────────
    const stopClusters = [
      ...highs.map(h => ({
        price: parseFloat((h.price + atrVal * 1.5).toFixed(5)),
        type: 'buy_stops',
        reason: 'Above swing high — retail longs stopped, breakout triggers',
      })),
      ...lows.map(l => ({
        price: parseFloat((l.price - atrVal * 1.5).toFixed(5)),
        type: 'sell_stops',
        reason: 'Below swing low — retail shorts stopped, breakdown triggers',
      })),
    ].filter(s => Math.abs(s.price - cur) <= lookRange * 1.5)
     .slice(0, 6);

    // ── Imbalance zones: large price moves with low volume (gap-filling) ─────
    const imbalances = LiquidityHeatmap._findImbalances(prices, volumes, atrVal);

    return {
      currentPrice:  cur,
      atr:           parseFloat(atrVal.toFixed(5)),
      zones:         zones.slice(0, 10),
      stopClusters,
      imbalances:    imbalances.slice(0, 5),
      magnetLevels:  roundLevels.slice(0, 5),
      topZone:       zones[0] || null,
    };
  }

  // ── Volume at price (VAP) using price buckets ─────────────────────────────
  static _volumeAtPrice(prices, volumes, bucketSize) {
    const buckets = {};
    for (let i = 0; i < prices.length; i++) {
      const vol = volumes && volumes[i] ? volumes[i] : 1;
      const bucket = Math.round(prices[i] / bucketSize) * bucketSize;
      const key = bucket.toFixed(5);
      if (!buckets[key]) buckets[key] = { price: bucket, totalVol: 0, count: 0 };
      buckets[key].totalVol += vol;
      buckets[key].count++;
    }
    const avgVol = Object.values(buckets).reduce((s,b)=>s+b.totalVol,0) / Object.keys(buckets).length || 1;
    return Object.values(buckets)
      .filter(b => b.totalVol > avgVol * 0.8)  // above-average volume levels
      .map(b => ({
        price:  parseFloat(b.price.toFixed(5)),
        type:   'volume_cluster',
        weight: Math.min(4, b.totalVol / avgVol),
      }));
  }

  // ── Round numbers (psychological levels) ─────────────────────────────────
  static _roundNumbers(cur, range, atr) {
    const levels = [];
    // Find relevant pip value for this price (0.0050 steps for EUR/USD-range)
    const step = cur < 10 ? 0.0050 : cur < 200 ? 0.50 : 50;
    const start = Math.floor((cur - range) / step) * step;
    const end   = Math.ceil((cur + range) / step) * step;
    // Use integer counting to avoid cumulative float drift
    const startN = Math.floor(start / step);
    const endN   = Math.ceil(end   / step);
    for (let n = startN; n <= endN; n++) {
      const p = parseFloat((n * step).toFixed(5));
      if (Math.abs(p - cur) > range) continue;
      // Extra weight for 00/50 levels (e.g. 1.0800, 1.0850)
      const pStr = p.toFixed(4);
      const is00 = pStr.endsWith('00') || pStr.endsWith('50');
      levels.push({ price: p, type: 'round_number', weight: is00 ? 3 : 1.5 });
    }
    return levels;
  }

  // ── Imbalance zones: big price move with low volume ───────────────────────
  static _findImbalances(prices, volumes, atr) {
    const imbalances = [];
    const avgVol = volumes && volumes.length
      ? volumes.reduce((s,v)=>s+v,0) / volumes.length : 1;

    for (let i = 1; i < prices.length; i++) {
      const move = Math.abs(prices[i] - prices[i-1]);
      const vol  = volumes && volumes[i] ? volumes[i] : avgVol;
      if (move > atr * 1.5 && vol < avgVol * 0.4) {
        imbalances.push({
          price:  parseFloat(((prices[i] + prices[i-1]) / 2).toFixed(5)),
          top:    Math.max(prices[i], prices[i-1]),
          bottom: Math.min(prices[i], prices[i-1]),
          type:   'imbalance',
          reason: 'Large move on thin volume — price likely to return to fill gap',
        });
      }
    }
    return imbalances;
  }

  // ── Cluster nearby zones ──────────────────────────────────────────────────
  static _clusterZones(levels, clusterWidth) {
    if (!levels.length) return [];
    const sorted = levels.slice().sort((a,b) => a.price - b.price);
    const clusters = [];
    let group = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].price - group[group.length-1].price <= clusterWidth) {
        group.push(sorted[i]);
      } else {
        clusters.push(LiquidityHeatmap._mergeGroup(group));
        group = [sorted[i]];
      }
    }
    clusters.push(LiquidityHeatmap._mergeGroup(group));
    return clusters;
  }

  static _mergeGroup(group) {
    const avgPrice = group.reduce((s,l)=>s+l.price,0) / group.length;
    const score    = group.reduce((s,l)=>s+(l.weight||1),0);
    const types    = [...new Set(group.map(l=>l.type))].join(',');
    return {
      price:  parseFloat(avgPrice.toFixed(5)),
      score,
      types,
      touches: group.length,
    };
  }

  static _empty() {
    return { zones:[], stopClusters:[], imbalances:[], magnetLevels:[], topZone:null };
  }
}

module.exports = { LiquidityHeatmap };
