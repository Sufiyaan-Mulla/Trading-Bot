'use strict';
// ── triple-barrier.js ─────────────────────────────────────────────────────────
// Triple Barrier Labeling (Lopez de Prado, Advances in Financial ML, Ch.3)
//
// Instead of labeling a trade WIN/LOSS (binary), assigns one of:
//   +1  = profit target hit first          (clean long entry worked)
//   -1  = stop loss hit first              (clean long entry failed)
//    0  = time barrier hit (neither hit)   (indeterminate — don't trade)
//
// This produces dramatically better ML labels because:
//  - Ignores trades where the outcome was time-driven, not direction-driven
//  - Penalises trades that required outsized risk to reach profit
//  - Forces ML to learn high-quality setups, not just any winning trade

class TripleBarrier {
  /**
   * @param {object} opts
   * @param {number} opts.ptMult     Profit target = ptMult × ATR  (default 2.0)
   * @param {number} opts.slMult     Stop loss     = slMult × ATR  (default 1.0)
   * @param {number} opts.maxBars    Time barrier  = max bars held  (default 20)
   * @param {Function} opts.log
   */
  constructor(opts = {}) {
    this.ptMult  = opts.ptMult  || 2.0;
    this.slMult  = opts.slMult  || 1.0;
    this.maxBars = opts.maxBars || 20;
    this._log    = opts.log || (() => {});
  }

  /**
   * Label a single event (entry) using triple-barrier method.
   * @param {number}   entryPrice
   * @param {string}   side        'BUY' | 'SELL'
   * @param {number}   atr         Average True Range at entry
   * @param {number[]} futurePrices Array of close prices after entry (up to maxBars)
   * @returns {{ label: 1|0|-1, barHit: number, barrier: 'profit'|'stop'|'time', meta: object }}
   */
  label(entryPrice, side, atr, futurePrices) {
    if (!futurePrices || futurePrices.length === 0) return { label: 0, barHit: 0, barrier: 'time' };
    if (!isFinite(atr) || atr <= 0) atr = entryPrice * 0.001;

    const isLong   = side !== 'SELL';
    const ptLevel  = isLong ? entryPrice + atr * this.ptMult  : entryPrice - atr * this.ptMult;
    const slLevel  = isLong ? entryPrice - atr * this.slMult  : entryPrice + atr * this.slMult;
    const maxBars  = Math.min(this.maxBars, futurePrices.length);

    for (let i = 0; i < maxBars; i++) {
      const p = futurePrices[i];
      if (!isFinite(p)) continue;

      const hitPt = isLong ? (p >= ptLevel) : (p <= ptLevel);
      const hitSl = isLong ? (p <= slLevel) : (p >= slLevel);

      if (hitPt && hitSl) {
        // Both hit same bar — conservative: assume stop hit first (gap scenario)
        return { label: -1, barHit: i + 1, barrier: 'stop',
          meta: { entry: entryPrice, ptLevel, slLevel, exitPrice: p } };
      }
      if (hitPt) {
        return { label: 1,  barHit: i + 1, barrier: 'profit',
          meta: { entry: entryPrice, ptLevel, slLevel, exitPrice: p } };
      }
      if (hitSl) {
        return { label: -1, barHit: i + 1, barrier: 'stop',
          meta: { entry: entryPrice, ptLevel, slLevel, exitPrice: p } };
      }
    }

    return { label: 0, barHit: maxBars, barrier: 'time',
      meta: { entry: entryPrice, ptLevel, slLevel, exitPrice: futurePrices[maxBars - 1] } };
  }

  /**
   * Batch label an array of events from a price series.
   * @param {Array<{entryIdx, side, atr}>} events  Events to label
   * @param {number[]} prices                        Full price series
   * @returns {Array<{...event, label, barHit, barrier}>}
   */
  labelBatch(events, prices) {
    return events.map(ev => {
      const futurePrices = prices.slice(ev.entryIdx + 1, ev.entryIdx + 1 + this.maxBars);
      const result = this.label(prices[ev.entryIdx] || ev.entryPrice || 0, ev.side || 'BUY', ev.atr || 0.001, futurePrices);
      return { ...ev, ...result };
    });
  }

  /**
   * Filter labeled events to remove time-barrier hits (label=0).
   * These are uninformative for ML training.
   */
  static filterInformative(labeledEvents) {
    const all = labeledEvents.length;
    const kept = labeledEvents.filter(e => e.label !== 0);
    return { events: kept, filteredOut: all - kept.length, keepRate: (kept.length / all * 100).toFixed(1) + '%' };
  }

  /**
   * Compute label statistics for quality assessment.
   */
  static stats(labeledEvents) {
    const pos   = labeledEvents.filter(e => e.label ===  1).length;
    const neg   = labeledEvents.filter(e => e.label === -1).length;
    const tie   = labeledEvents.filter(e => e.label ===  0).length;
    const n     = labeledEvents.length || 1;
    const avgBar = labeledEvents.reduce((s, e) => s + (e.barHit || 0), 0) / n;
    return {
      total: n, positive: pos, negative: neg, timeBarrier: tie,
      winRate:  parseFloat((pos / (pos + neg || 1) * 100).toFixed(1)),
      timeRate: parseFloat((tie / n * 100).toFixed(1)),
      avgBarsHeld: parseFloat(avgBar.toFixed(1)),
    };
  }
}

// 1.2: labelSeries — label a full price series for ML training data
TripleBarrier.prototype.labelSeries = function(prices, atrs, side = 'LONG') {
  const labels = [];
  for (let i = 0; i < prices.length - this.maxBars; i++) {
    const future = prices.slice(i + 1, i + 1 + this.maxBars);
    const result = this.label(prices[i], side, atrs[i] || prices[i] * 0.001, future);
    labels.push({ entryIdx: i, entryPrice: prices[i], ...result });
  }
  return labels;
};

// 1.2: stats — distribution of barrier hits
TripleBarrier.prototype.stats = function(labels) {
  const n = labels.length || 1;
  const wins  = labels.filter(l => l.label ===  1).length;
  const loses = labels.filter(l => l.label === -1).length;
  const times = labels.filter(l => l.label ===  0).length;
  return {
    total:       labels.length,
    profitPct:   parseFloat((wins  / n * 100).toFixed(1)),
    stopPct:     parseFloat((loses / n * 100).toFixed(1)),
    timePct:     parseFloat((times / n * 100).toFixed(1)),
    avgBarsHeld: parseFloat((labels.reduce((s,l) => s + (l.barsHeld||0), 0) / n).toFixed(1)),
  };
};

module.exports = { TripleBarrier };
