'use strict';
// volume-profile.js — Volume Profile & Point of Control (POC)
// Builds a price-volume histogram. The POC is the price level with the highest
// traded volume — a proven support/resistance level in smart money theory.

class VolumeProfile {
  constructor(opts = {}) {
    this.nBins    = opts.nBins    ?? 50;
    this._profile = null;
    this._poc     = null;
    this._vah     = null;  // Value Area High (70% of volume)
    this._val     = null;  // Value Area Low
  }

  // Build profile from OHLCV bars
  build(ohlcvBars) {
    if (!ohlcvBars || ohlcvBars.length < 10) return null;
    const prices = ohlcvBars.flatMap(b => [b.h||b.high||0, b.l||b.low||0, b.c||b.close||0]).filter(p=>p>0);
    const vols   = ohlcvBars.flatMap(b => [b.v/3, b.v/3, b.v/3]);
    const hi = Math.max(...prices), lo = Math.min(...prices);
    if (hi <= lo) return null;
    const step  = (hi - lo) / this.nBins;
    const bins  = Array.from({length:this.nBins}, (_,i) => ({ price: lo + (i+0.5)*step, vol: 0 }));
    prices.forEach((p,i) => {
      const idx = Math.min(this.nBins-1, Math.floor((p-lo)/step));
      bins[idx].vol += vols[i]||0;
    });
    const totalVol = bins.reduce((s,b)=>s+b.vol,0) || 1;
    this._profile  = bins.map(b => ({ ...b, pct: b.vol/totalVol }));
    // POC = bin with highest volume
    this._poc = this._profile.reduce((a,b) => b.vol>a.vol ? b : a).price;
    // Value Area: accumulate 70% of volume around POC
    let accumulated = 0;
    const sorted = [...this._profile].sort((a,b)=>b.vol-a.vol);
    const va = [];
    for (const bin of sorted) {
      va.push(bin.price); accumulated += bin.vol;
      if (accumulated / totalVol >= 0.70) break;
    }
    this._vah = Math.max(...va);
    this._val = Math.min(...va);
    return this;
  }

  // Is current price near the POC? (within 0.5 × ATR)
  nearPOC(price, atr) {
    if (!this._poc) return false;
    return Math.abs(price - this._poc) < (atr||0.001) * 0.5;
  }

  // Get signal: price entering value area from outside = likely support/resistance
  signal(price, atr) {
    if (!this._poc || !this._vah || !this._val) return null;
    const tol = (atr||0.001) * 0.3;
    if (Math.abs(price - this._vah) < tol) return { type:'RESISTANCE', level:this._vah, poc:this._poc };
    if (Math.abs(price - this._val) < tol) return { type:'SUPPORT',    level:this._val, poc:this._poc };
    if (Math.abs(price - this._poc) < tol) return { type:'POC',        level:this._poc, poc:this._poc };
    return null;
  }

  get poc()  { return this._poc; }
  get vah()  { return this._vah; }
  get val()  { return this._val; }
  get profile() { return this._profile; }
}

module.exports = { VolumeProfile };
