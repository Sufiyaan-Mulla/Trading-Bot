'use strict';
// ── orderflow.js ──────────────────────────────────────────────────────────────
// Approximates orderflow metrics from OHLCV close-only price+volume data.
//
// True orderflow requires L2 order book tick data. With close-only bars we
// approximate using price direction × volume as a proxy for buy/sell pressure:
//   - Price up bar  → buying pressure  (+volume to delta)
//   - Price down bar → selling pressure (-volume to delta)
//   - Flat bar       → neutral (split 50/50)
//
// Metrics produced:
//   cumulativeDelta    — running sum of directional volume
//   deltaSlope         — rate of change of delta (momentum of buying pressure)
//   buyPressure        — fraction of recent volume on up-bars (0-1)
//   icebergDetected    — large price move on unusually LOW volume (hidden orders)
//   exhaustionSignal   — large volume but tiny price move (absorption/exhaustion)
//   deltaRegime        — 'ACCUMULATION' | 'DISTRIBUTION' | 'NEUTRAL'
// ─────────────────────────────────────────────────────────────────────────────

class OrderFlow {
  constructor(opts = {}) {
    this._baseWindow  = opts.window      || 20;   // base bars for rolling metrics
    this._window      = this._baseWindow;         // current window (session-adjusted)
    this._deltaHistory = [];
    this._volumeHistory = [];
    this._priceHistory  = [];
  }

  // ── Update with one new bar ───────────────────────────────────────────────
  setSessionWindow(utcHour) {
    if (utcHour >= 21 || utcHour < 7)        this._window = Math.max(5, Math.floor(this._baseWindow * 0.5));
    else if (utcHour >= 12 && utcHour < 16)  this._window = Math.min(30, Math.floor(this._baseWindow * 1.25));
    else                                      this._window = this._baseWindow;
  }

  update(price, volume, prevPrice) {
    const vol = volume || 1_000_000;  // fallback if volume unavailable
    const diff = price - (prevPrice || price);

    // Directional volume: proportional to price move magnitude
    let barDelta;
    if (Math.abs(diff) < price * 0.00001) {
      barDelta = 0;              // flat bar — neutral
    } else if (diff > 0) {
      barDelta = +vol;           // up bar — buying pressure
    } else {
      barDelta = -vol;           // down bar — selling pressure
    }

    this._deltaHistory.push(barDelta);
    this._volumeHistory.push(vol);
    this._priceHistory.push(price);

    if (this._deltaHistory.length > this._window * 2) {
      this._deltaHistory.shift();
      this._volumeHistory.shift();
      this._priceHistory.shift();
    }
  }

  // ── Analyse current orderflow state ──────────────────────────────────────
  analyse() {
    const n = this._deltaHistory.length;
    if (n < 5) return OrderFlow._empty();

    const window = Math.min(this._window, n);
    const recentDelta  = this._deltaHistory.slice(-window);
    const recentVol    = this._volumeHistory.slice(-window);
    const recentPrices = this._priceHistory.slice(-window);

    // Cumulative delta over window
    const cumulativeDelta = recentDelta.reduce((s, v) => s + v, 0);

    // Delta slope: linear regression slope of delta over last N bars
    const deltaSlope = this._slope(recentDelta.map((_, i) => i), recentDelta);

    // Buy pressure: fraction of volume on up-bars
    const buyVol  = recentDelta.filter(d => d > 0).reduce((s,v) => s + Math.abs(v), 0);
    const totalVol = recentVol.reduce((s,v) => s+v, 0);
    const buyPressure = totalVol > 0 ? buyVol / totalVol : 0.5;

    // Average volume
    const avgVol = totalVol / window;
    const lastVol = recentVol[recentVol.length - 1];

    // Price move over window
    const priceMove = Math.abs(recentPrices[recentPrices.length-1] - recentPrices[0]);
    const priceMovePct = recentPrices[0] > 0 ? priceMove / recentPrices[0] : 0;

    // Iceberg detection: significant price move on < 30% of avg volume
    // (hidden large orders absorbing visible flow)
    const icebergDetected = lastVol < avgVol * 0.30 && priceMovePct > 0.002;

    // Exhaustion/absorption: large volume but tiny price move
    // (big orders being absorbed — potential reversal)
    const exhaustionSignal = lastVol > avgVol * 2.0 && priceMovePct < 0.0005;

    // Delta regime
    let deltaRegime = 'NEUTRAL';
    if (cumulativeDelta > totalVol * 0.15 && deltaSlope > 0) deltaRegime = 'ACCUMULATION';
    else if (cumulativeDelta < -totalVol * 0.15 && deltaSlope < 0) deltaRegime = 'DISTRIBUTION';

    return {
      cumulativeDelta:  parseFloat(cumulativeDelta.toFixed(0)),
      deltaSlope:       parseFloat(deltaSlope.toFixed(2)),
      buyPressure:      parseFloat(buyPressure.toFixed(3)),
      icebergDetected,
      exhaustionSignal,
      deltaRegime,
      avgVolume:        parseFloat(avgVol.toFixed(0)),
      lastVolume:       lastVol,
      // Real OANDA orderbook bias (if available from recordOrderBook())
      obLongBias:       this._lastOrderBook?.longBias   || 'NEUTRAL',
      obLongPct:        this._lastOrderBook?.avgLongPct || 50,
    };
  }

  // Feature #34: Store real OANDA orderbook snapshot
  // Call from market-data-fetcher every N minutes: of.recordOrderBook(await adapter.getOrderBook(asset))
  recordOrderBook(ob) {
    if (!ob || ob.error) return;
    this._lastOrderBook = ob;
  }

  // ── Linear regression slope ───────────────────────────────────────────────
  _slope(xs, ys) {
    const n = xs.length;
    if (n < 2) return 0;
    const mx = xs.reduce((s,v) => s+v, 0) / n;
    const my = ys.reduce((s,v) => s+v, 0) / n;
    const num = xs.reduce((s,x,i) => s + (x-mx)*(ys[i]-my), 0);
    const den = xs.reduce((s,x) => s + (x-mx)**2, 0);
    return den !== 0 ? num / den : 0;
  }

  static _empty() {
    return {
      cumulativeDelta: 0, deltaSlope: 0, buyPressure: 0.5,
      icebergDetected: false, exhaustionSignal: false,
      deltaRegime: 'NEUTRAL', avgVolume: 0, lastVolume: 0,
    };
  }
}

module.exports = { OrderFlow };
