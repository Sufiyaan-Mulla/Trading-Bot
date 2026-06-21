'use strict';
// hurst.js — Hurst Exponent & Fractal Dimension Filter
// H < 0.5 → mean-reverting (use mean-reversion strategies)
// H = 0.5 → random walk (avoid, no edge)
// H > 0.5 → trending (use trend-following strategies)
// Uses Rescaled Range (R/S) analysis (original Hurst method).

class HurstExponent {
  // Compute Hurst exponent for a price series
  compute(prices, minLag=10, maxLag=null) {
    if (!prices || prices.length < 20) return { H: 0.5, regime: 'RANDOM' };
    const n    = prices.length;
    const _max = maxLag || Math.floor(n / 2);

    // Use log returns for stationarity
    const logRets = prices.slice(1).map((p,i) => Math.log(p/prices[i]));
    if (logRets.length < 10) return { H: 0.5, regime: 'RANDOM' };

    // R/S analysis at multiple lags
    const points = [];
    for (let lag = minLag; lag <= _max; lag = Math.round(lag * 1.3) || lag+1) {
      const chunks = [];
      for (let start = 0; start + lag <= logRets.length; start += lag) {
        const sub  = logRets.slice(start, start+lag);
        const mean = sub.reduce((s,v)=>s+v,0)/sub.length;
        // Cumulative deviation
        let cumDev = 0, maxD = -Infinity, minD = Infinity;
        for (const r of sub) { cumDev += r-mean; maxD=Math.max(maxD,cumDev); minD=Math.min(minD,cumDev); }
        const R   = maxD - minD;
        const S   = Math.sqrt(sub.reduce((s,v)=>s+(v-mean)**2,0)/sub.length) || 1e-10;
        if (R > 0 && S > 0) chunks.push(R/S);
      }
      if (chunks.length > 0) {
        const avgRS = chunks.reduce((s,v)=>s+v,0)/chunks.length;
        points.push({ logLag: Math.log(lag), logRS: Math.log(avgRS) });
      }
    }
    if (points.length < 3) return { H: 0.5, regime: 'RANDOM' };

    // OLS regression of log(R/S) on log(lag) → slope = H
    const mX = points.reduce((s,p)=>s+p.logLag,0)/points.length;
    const mY = points.reduce((s,p)=>s+p.logRS,0)/points.length;
    const cov = points.reduce((s,p)=>s+(p.logLag-mX)*(p.logRS-mY),0);
    const varX= points.reduce((s,p)=>s+(p.logLag-mX)**2,0) || 1e-8;
    const H   = Math.max(0.01, Math.min(0.99, cov/varX));

    const regime = H < 0.45 ? 'MEAN_REVERTING' : H > 0.55 ? 'TRENDING' : 'RANDOM';
    // Confidence in the regime (0-1, based on distance from 0.5)
    const confidence = Math.min(1, Math.abs(H - 0.5) / 0.25);

    return {
      H:           parseFloat(H.toFixed(3)),
      regime,
      confidence:  parseFloat(confidence.toFixed(3)),
      // Suggested strategy multiplier
      trendMult:   H > 0.55 ? 1.0 + (H-0.5)*2 : H < 0.45 ? 0.5 : 1.0,
      revMult:     H < 0.45 ? 1.0 + (0.5-H)*2 : H > 0.55 ? 0.5 : 1.0,
    };
  }
}

module.exports = { HurstExponent };
