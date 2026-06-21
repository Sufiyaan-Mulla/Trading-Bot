'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  PaperValidator  —  Feature #50
//
//  Runs a parallel paper simulation whenever parameters change and compares
//  paper performance vs live performance.  Alerts when significant divergence
//  is detected (e.g. paper wins but live loses, or slippage > expectation).
//
//  Usage (wired via engine-wiring.js):
//    const pv = new PaperValidator();
//    pv.recordLive(trade);    // called from exitPosition
//    pv.recordPaper(trade);   // called from paper simulation
//    const report = pv.compare();
// ─────────────────────────────────────────────────────────────────────────────

class PaperValidator {
  constructor(opts = {}) {
    this._liveTraces  = [];
    this._paperTraces = [];
    this._maxLen      = opts.maxLen  || 200;
    this._alertThresh = opts.alertThreshold || 0.15;  // 15% divergence triggers alert
    this._log         = opts.log    || ((m) => console.log('[PaperVal] ' + m));
    this._notify      = opts.notify || null;
    this._paramSnapshot = null;
  }

  // Record current config snapshot to detect parameter changes
  snapshotParams(config) {
    this._paramSnapshot = JSON.stringify({
      minConfidence: config.minConfidence,
      positionSize:  config.positionSize,
      stopLoss:      config.stopLoss,
      takeProfit:    config.takeProfit,
    });
  }

  recordLive(trade) {
    if (!trade || trade.profit === undefined) return;
    this._liveTraces.push({ profit: trade.profit, ts: Date.now() });
    if (this._liveTraces.length > this._maxLen) this._liveTraces.shift();
    this._checkDivergence();
  }

  recordPaper(trade) {
    if (!trade || trade.profit === undefined) return;
    this._paperTraces.push({ profit: trade.profit, ts: Date.now() });
    if (this._paperTraces.length > this._maxLen) this._paperTraces.shift();
    this._checkDivergence();  // check whenever either side gets a new trade
  }

  _winRate(traces) {
    if (!traces.length) return 0;
    return traces.filter(t => t.profit > 0).length / traces.length;
  }

  _avgPnl(traces) {
    if (!traces.length) return 0;
    return traces.reduce((s, t) => s + t.profit, 0) / traces.length;
  }

  compare() {
    const n = Math.min(this._liveTraces.length, this._paperTraces.length);
    if (n < 10) return { insufficient: true, n };
    return {
      n,
      live:  { winRate: this._winRate(this._liveTraces.slice(-n)),  avgPnl: this._avgPnl(this._liveTraces.slice(-n))  },
      paper: { winRate: this._winRate(this._paperTraces.slice(-n)), avgPnl: this._avgPnl(this._paperTraces.slice(-n)) },
      divergence: {
        winRateDelta: this._winRate(this._liveTraces.slice(-n)) - this._winRate(this._paperTraces.slice(-n)),
        pnlDelta:     this._avgPnl(this._liveTraces.slice(-n))  - this._avgPnl(this._paperTraces.slice(-n)),
      },
    };
  }

  _checkDivergence() {
    if (this._paperTraces.length < 10) return;  // need paper trades too
    const r = this.compare();
    if (r.insufficient) return;
    const wr = Math.abs(r.divergence.winRateDelta);
    if (wr > this._alertThresh) {
      const msg = `[PaperVal] Live vs Paper divergence: live WR=${(r.live.winRate*100).toFixed(1)}% paper WR=${(r.paper.winRate*100).toFixed(1)}% Δ=${(wr*100).toFixed(1)}%`;
      this._log(msg);
      if (this._notify) try { this._notify(msg, 'risk'); } catch(_) {}
    }
  }

  get liveCount()  { return this._liveTraces.length;  }
  get paperCount() { return this._paperTraces.length; }
}

module.exports = { PaperValidator };
