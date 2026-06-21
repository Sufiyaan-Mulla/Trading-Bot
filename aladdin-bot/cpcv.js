'use strict';
// ── cpcv.js — 8.1: Combinatorial Purged Cross Validation ─────────────────────
// Implementation of De Prado's CPCV (Advances in Financial ML, Ch.12).
// Addresses the problem that standard k-fold leaks forward information in
// time series due to overlapping samples.
//
// Key steps:
//   1. Split data into N groups (not random — consecutive time blocks)
//   2. Form all C(N,k) combinations of training groups
//   3. Purge samples that overlap with test period (embargo)
//   4. Evaluate strategy on each held-out combination

class CPCV {
  /**
   * @param {number} nSplits   Number of time splits (default 6)
   * @param {number} nTestSplits  Test groups per combination (default 2)
   * @param {number} embargoPct   Fraction of group to purge on each side (default 0.05)
   */
  constructor(nSplits = 6, nTestSplits = 2, embargoPct = 0.05) {
    this.nSplits      = nSplits;
    this.nTestSplits  = nTestSplits;
    this.embargoPct   = embargoPct;
  }

  // Generate (trainIdx, testIdx) splits with purging
  *splits(n) {
    const groupSize = Math.floor(n / this.nSplits);
    const embargo   = Math.floor(groupSize * this.embargoPct);
    // Groups: [[0..g-1], [g..2g-1], ...]
    const groups = Array.from({length: this.nSplits}, (_, i) => ({
      start: i * groupSize,
      end:   i === this.nSplits - 1 ? n : (i + 1) * groupSize,
    }));

    // All combinations of nTestSplits from nSplits groups
    for (const testGroupIdxs of this._combinations(this.nSplits, this.nTestSplits)) {
      const testGroups  = testGroupIdxs.map(i => groups[i]);
      const trainGroups = groups.filter((_, i) => !testGroupIdxs.includes(i));

      const testStart  = Math.min(...testGroups.map(g => g.start));
      const testEnd    = Math.max(...testGroups.map(g => g.end));

      // Build train indices with embargo around test period
      const trainIdx = [];
      for (const g of trainGroups) {
        for (let i = g.start; i < g.end; i++) {
          // Purge if within embargo of test period
          if (i >= testStart - embargo && i < testEnd + embargo) continue;
          trainIdx.push(i);
        }
      }

      const testIdx = [];
      for (const g of testGroups) for (let i = g.start; i < g.end; i++) testIdx.push(i);

      yield { trainIdx, testIdx, testGroups, embargo };
    }
  }

  *_combinations(n, k) {
    const result = [];
    const combo  = Array.from({length:k}, (_,i)=>i);
    while (true) {
      yield [...combo];
      let i = k - 1;
      while (i >= 0 && combo[i] === n - k + i) i--;
      if (i < 0) break;
      combo[i]++;
      for (let j = i+1; j < k; j++) combo[j] = combo[j-1]+1;
    }
  }

  // Run CPCV evaluation with a provided backtest function
  evaluate(prices, volumes, backtestFn, capital = 10000) {
    const n       = prices.length;
    const results = [];
    for (const { trainIdx, testIdx, testGroups, embargo } of this.splits(n)) {
      if (trainIdx.length < 50 || testIdx.length < 10) continue;
      try {
        const testPrices  = testIdx.map(i => prices[i]);
        const testVolumes = testIdx.map(i => volumes[i] || 1e6);
        const r = backtestFn(testPrices, testVolumes, capital);
        results.push({
          trainBars: trainIdx.length,
          testBars:  testIdx.length,
          embargo,
          capital:   r.capital,
          trades:    r.trades?.length || 0,
          return:    ((r.capital - capital) / capital * 100).toFixed(2) + '%',
        });
      } catch(_) {}
    }
    // Aggregate stats
    const returns = results.map(r => parseFloat(r.return));
    const mean    = returns.reduce((s,v)=>s+v,0) / (returns.length||1);
    const std     = Math.sqrt(returns.reduce((s,v)=>s+(v-mean)**2,0)/(returns.length||1));
    return { folds: results.length, meanReturn: mean.toFixed(2)+'%', stdReturn: std.toFixed(2)+'%', 
             sharpe: (std>0?mean/std:0).toFixed(2), results };
  }
}

module.exports = { CPCV };
