'use strict';
// vpin.js — Item 6: VPIN (Volume-Synchronized Probability of Informed Trading)
// Measures the proportion of volume that is likely from informed traders.
// High VPIN → avoid entering (toxic order flow dominant).
// Based on Easley, López de Prado & O'Hara (2012).

class VPIN {
  constructor(opts = {}) {
    this.bucketSize = opts.bucketSize || 50;   // volume per bucket
    this.nBuckets   = opts.nBuckets   || 50;   // rolling window
    this._buckets   = [];                       // [{buyVol, sellVol}]
    this._curBuy    = 0;
    this._curSell   = 0;
    this._curVol    = 0;
    this.value      = 0.5;  // current VPIN estimate
  }

  // Update with a new bar: price change classifies volume as buy/sell
  update(close, prevClose, volume) {
    if (!prevClose || prevClose <= 0 || volume <= 0) return;
    const ret    = (close - prevClose) / prevClose;
    const buyFrac = 0.5 + 0.5 * Math.tanh(ret / 0.001);  // sigmoid classifier
    const buyVol  = volume * buyFrac;
    const sellVol = volume * (1 - buyFrac);
    this._curBuy  += buyVol;
    this._curSell += sellVol;
    this._curVol  += volume;

    // When bucket is full, push to history
    while (this._curVol >= this.bucketSize) {
      const overflow = this._curVol - this.bucketSize;
      const ratio    = overflow / Math.max(volume, 1);
      this._buckets.push({
        buyVol:  this._curBuy  - buyVol * ratio,
        sellVol: this._curSell - sellVol * ratio,
      });
      this._curBuy  = buyVol  * ratio;
      this._curSell = sellVol * ratio;
      this._curVol  = overflow;
      if (this._buckets.length > this.nBuckets) this._buckets.shift();
    }

    // Compute VPIN as avg |buyVol - sellVol| / bucketSize
    if (this._buckets.length > 0) {
      const imbalance = this._buckets.reduce((s,b) => s + Math.abs(b.buyVol - b.sellVol), 0);
      this.value = imbalance / (this._buckets.length * this.bucketSize);
    }
  }

  // Is order flow toxic? (VPIN > threshold)
  isToxic(threshold) {
    return this.value > (threshold || 0.35);
  }

  get toxicityLevel() {
    if (this.value < 0.25) return 'LOW';
    if (this.value < 0.35) return 'MODERATE';
    if (this.value < 0.50) return 'HIGH';
    return 'EXTREME';
  }
}

module.exports = { VPIN };
