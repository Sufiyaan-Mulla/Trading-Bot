'use strict';
// ── correlation-engine.js ─────────────────────────────────────────────────────
const { TRADING_CONFIG } = require('./trading-config');

class CorrelationEngine {
  static pearson(seriesA, seriesB, period) {
    const len = Math.min(seriesA.length, seriesB.length, period);
    if (len < 5) return 0;
    const a = seriesA.slice(-len), b = seriesB.slice(-len);
    const retA = a.slice(1).map((v,i) => (v - a[i]) / (a[i] || 1));
    const retB = b.slice(1).map((v,i) => (v - b[i]) / (b[i] || 1));
    // Bug fix: NaN prices (from failed fetches or gap-fill errors) propagate
    // through return computation into mean/cov calculations, making all
    // correlation values NaN and silently disabling cross-asset risk checks.
    const validPairs = retA.map((v,i) => [v, retB[i]])
                           .filter(([a,b]) => isFinite(a) && isFinite(b));
    if (validPairs.length < 4) return 0;  // insufficient clean data
    const cleanA = validPairs.map(p => p[0]);
    const cleanB = validPairs.map(p => p[1]);
    const n    = cleanA.length;
    const retA_c = cleanA, retB_c = cleanB;
    const meanA = retA_c.reduce((s,v) => s+v, 0) / n;
    const meanB = retB_c.reduce((s,v) => s+v, 0) / n;
    let cov = 0, varA = 0, varB = 0;
    for (let i = 0; i < n; i++) {
      const da = retA_c[i]-meanA, db = retB_c[i]-meanB;
      cov += da*db; varA += da*da; varB += db*db;
    }
    const denom = Math.sqrt(varA * varB);
    return denom === 0 ? 0 : cov / denom;
  }

  // Fix #83: Spearman rank correlation — more robust to ECB/Fed spike outliers
  static _spearman(a, b) {
    if (!a || !b || a.length < 4) return 0;
    const n = Math.min(a.length, b.length);
    const rankOf = arr => {
      const sorted = [...arr].sort((x,y)=>x-y);
      return arr.map(v => sorted.indexOf(v) + 1);
    };
    const ra = rankOf(a.slice(-n)), rb = rankOf(b.slice(-n));
    const d2 = ra.reduce((s,_,i) => s + (ra[i]-rb[i])**2, 0);
    return 1 - (6 * d2) / (n * (n*n - 1));
  }

  static buildMatrix(priceHistories, period) {
    const assets = Object.keys(priceHistories);
    const matrix = {};
    for (let i = 0; i < assets.length; i++) {
      for (let j = i+1; j < assets.length; j++) {
        const key = `${assets[i]}_${assets[j]}`;
        matrix[key] = parseFloat(CorrelationEngine.pearson(priceHistories[assets[i]], priceHistories[assets[j]], period).toFixed(4));
      }
    }
    return matrix;
  }

  static check(targetAsset, openAsset, priceHistories) {
    // B8: Same-pair always has correlation=1.0 — returning blocked would prevent ALL re-entries
    // after closing EURUSD when lastClosedAsset='EURUSD'
    if (!openAsset || targetAsset === openAsset) {
      return { blocked: false, label: 'OK', sizeMultiplier: 1.0, reason: 'same-pair skip' };
    }
    if (!TRADING_CONFIG.correlationEnabled || targetAsset === openAsset)
      return { blocked: false, sizeMultiplier: 1, correlation: 0, label: 'SAFE', reason: 'No open position' };
    const histA = priceHistories[targetAsset], histB = priceHistories[openAsset];
    if (!histA || !histB)
      return { blocked: false, sizeMultiplier: 1, correlation: 0, label: 'SAFE', reason: 'Insufficient history' };
    const r = CorrelationEngine.pearson(histA, histB, TRADING_CONFIG.correlationPeriod);
    const abs = Math.abs(r);
    const direction = r >= 0 ? 'positive' : 'negative';
    if (abs >= TRADING_CONFIG.correlationHighThreshold)
      return { blocked: true, sizeMultiplier: 0, correlation: r, label: 'BLOCKED',
        reason: `${targetAsset} has ${direction} correlation of ${(abs*100).toFixed(1)}% with open ${openAsset} — blocked` };
    if (abs >= TRADING_CONFIG.correlationWarnThreshold)
      return { blocked: false, sizeMultiplier: TRADING_CONFIG.correlationSizeReduction, correlation: r, label: 'WARN',
        reason: `${targetAsset} elevated correlation ${(abs*100).toFixed(1)}% — size reduced` };
    return { blocked: false, sizeMultiplier: 1, correlation: r, label: 'SAFE',
      reason: `${targetAsset} correlation with ${openAsset} is low (${(abs*100).toFixed(1)}%)` };
  }
}


// #62: EWMA (Exponentially Weighted) correlation — reacts faster to regime breaks



// #62: EWMA (Exponentially Weighted) correlation — static utility
CorrelationEngine.ewma = function(seriesA, seriesB, halfLife = 20) {
  if (!seriesA || !seriesB) return 0;
  const n     = Math.min(seriesA.length, seriesB.length);
  const alpha = 1 - Math.pow(0.5, 1 / halfLife);
  let   covW = 0, varAW = 0, varBW = 0, meanA = 0, meanB = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.pow(1 - alpha, n - 1 - i);
    meanA = meanA * (1 - alpha) + seriesA[i] * alpha;
    meanB = meanB * (1 - alpha) + seriesB[i] * alpha;
    const dA = seriesA[i] - meanA, dB = seriesB[i] - meanB;
    covW  += w * dA * dB; varAW += w * dA * dA; varBW += w * dB * dB;
  }
  const denom = Math.sqrt(varAW * varBW);
  return denom > 0 ? parseFloat((covW / denom).toFixed(4)) : 0;
};

// Fix #100: Dynamic correlation threshold scales with regime
CorrelationEngine.dynamicThreshold = function(baseThreshold, regime) {
  const mult = regime === 'TRENDING' ? 1.3 : regime === 'RANGING' ? 0.9 : 1.0;
  return Math.min(0.95, baseThreshold * mult);
};

module.exports = { CorrelationEngine };
