'use strict';
// ── slippage-model.js — 4.2: Slippage Prediction ML Model ────────────────────
// Predicts expected slippage BEFORE entry using market microstructure features.
// If predicted slippage would eliminate the edge, the trade is skipped.
//
// Features: [spread%, volRatio, atrPct, timeOfDay, spreadTrend, positionFrac]
// Target:   actual slippage as fraction of price

class SlippageModel {
  constructor() {
    this._data      = [];   // [{features, actualSlip}]
    this._maxData   = 200;
    this._coeffs    = null; // simple linear regression coefficients
    this._trained   = false;
  }

  // Record actual slippage after a fill for training
  record(features, actualSlipFraction) {
    if (!isFinite(actualSlipFraction)) return;
    this._data.push({ features, slip: actualSlipFraction });
    if (this._data.length > this._maxData) this._data.shift();
    if (this._data.length >= 20 && this._data.length % 10 === 0) this._fit();
  }

  // Fit simple linear regression on accumulated data
  _fit() {
    const n  = this._data.length;
    const X  = this._data.map(d => d.features);
    const y  = this._data.map(d => d.slip);
    const k  = X[0].length;
    // OLS: coeffs = (X'X)^-1 X'y (simple ridge to avoid singularity)
    const lambda = 1e-6;
    const XtX    = Array.from({length:k}, (_, i) => Array.from({length:k}, (_,j) => {
      let s = i===j ? lambda : 0;
      for (const xi of X) s += xi[i]*xi[j];
      return s;
    }));
    const Xty = Array.from({length:k}, (_,i) => { let s=0; for (let r=0;r<n;r++) s+=X[r][i]*y[r]; return s; });
    // Gaussian elimination
    const A = XtX.map((row,i) => [...row, Xty[i]]);
    for (let p=0;p<k;p++) {
      const piv = A[p][p]; if (Math.abs(piv)<1e-12) continue;
      for (let r=0;r<k;r++) if(r!==p) { const f=A[r][p]/piv; for(let c=0;c<=k;c++) A[r][c]-=f*A[p][c]; }
      for (let c=0;c<=k;c++) A[p][c]/=piv;
    }
    this._coeffs = A.map(row=>row[k]);
    this._trained = true;
  }

  // Predict expected slippage fraction
  predict(features) {
    if (!this._trained || !this._coeffs) return null;
    let pred = 0;
    for (let i=0;i<Math.min(features.length,this._coeffs.length);i++) pred+=features[i]*this._coeffs[i];
    return Math.max(0, Math.min(pred, 0.01));  // cap at 1% max predicted slippage
  }

  // Build feature vector from current market conditions
  buildFeatures(spread, avgSpread, volRatio, atrPct, positionSize, capital) {
    // Bug fix: NaN spread (e.g. from a failed price fetch) produced a NaN feature
    // that silently flowed into the linear model, returning NaN predicted slippage
    // which then corrupted position sizing downstream.
    const safeSpread   = (typeof spread    === 'number' && isFinite(spread))    ? spread    : 0;
    const safeAvgSpread= (typeof avgSpread === 'number' && isFinite(avgSpread) && avgSpread > 0) ? avgSpread : 1;
    const safeVol      = (typeof volRatio  === 'number' && isFinite(volRatio))  ? volRatio  : 1;
    const safeAtr      = (typeof atrPct    === 'number' && isFinite(atrPct))    ? atrPct    : 0;
    const safeSize     = (typeof positionSize==='number'&& isFinite(positionSize))? positionSize : 0;
    const safeCap      = (typeof capital   === 'number' && isFinite(capital) && capital > 0) ? capital : 1;

    const spreadPct   = safeSpread / safeAvgSpread;
    const timeH       = new Date().getUTCHours() / 24;
    const posFrac     = safeSize / safeCap;
    return [spreadPct, Math.min(safeVol, 5)/5, Math.min(safeAtr,3)/3, timeH, Math.min(posFrac,0.1)*10, 1.0];
  }

  get trained()   { return this._trained; }
  get sampleCount(){ return this._data.length; }
}

module.exports = { SlippageModel };
