'use strict';

// Bug fix: atomic state write — prevents corrupt files on crash mid-write
function _atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp';
  require('fs').writeFileSync(tmp, content, 'utf8');
  require('fs').renameSync(tmp, filePath);
}


// ═══════════════════════════════════════════════════════════════════════════════
//  confidence-calibrator.js
//  Post-hoc Confidence Calibration Layer
//
//  Problem
//  ───────
//  The ML model outputs a confidence value (30–95) that is not a true
//  probability. A signal at 80% confidence may only win 55% of the time.
//  Without calibration, Kelly sizing and the confidence gate both operate
//  on fiction — the confidence number is a relative ranking, not a prediction.
//
//  What this module provides
//  ─────────────────────────
//  1. Reliability tracking
//     Tracks actual win rate per confidence bucket (50-59, 60-69, …, 90-100).
//     Builds a reliability diagram to visualise miscalibration.
//
//  2. ECE (Expected Calibration Error)
//     Weighted average of |bucket_accuracy − bucket_confidence|.
//     0 = perfectly calibrated. > 0.10 = significantly miscalibrated.
//
//  3. Platt Scaling
//     Fits a logistic regression: P(win) = sigmoid(a × rawProb + b).
//     Simple, fast, online-updatable. Good for monotone distortions.
//
//  4. Isotonic Regression (Pool Adjacent Violators)
//     Non-parametric piecewise-monotone calibration.
//     More flexible than Platt — handles non-monotone distortions.
//     Used when enough data is available (>= isotonicMinSamples).
//
//  5. Per-regime calibration
//     Separate Platt models per market regime (TRENDING/RANGING/WEAK_TREND).
//     Falls back to global calibration when regime data is insufficient.
//
//  Flow
//  ────
//  At trade ENTRY:  store rawConf + regime (attached to position)
//  At trade CLOSE:  calibrator.recordOutcome(rawConf, won, regime)
//  At PREDICTION:   calibrator.calibrate(rawConf, regime) → calibratedConf
//
//  The calibrated confidence replaces the raw model output everywhere:
//  in Kelly sizing, in the confidence gate, and in the A/B tester.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Helpers ───────────────────────────────────────────────────────────────────
const sigmoid  = x => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, x))));
const logit    = p  => Math.log(Math.max(1e-7, p) / Math.max(1e-7, 1 - p));
const clamp01  = x  => Math.max(0, Math.min(1, x));
const clampConf = x  => Math.max(30, Math.min(95, Math.round(x)));

// ── Configuration ─────────────────────────────────────────────────────────────
const CALIB_CONFIG = {
  // Minimum samples before any calibration is applied
  minSamplesForCalibration: 20,

  // Minimum samples before isotonic (PAV) replaces Platt
  isotonicMinSamples: 50,

  // Platt scaling learning rate (SGD)
  plattLR: 0.05,

  // Number of reliability buckets (10 = decile buckets 0-9, 10-19, …)
  numBuckets: 10,

  // Per-regime calibration: minimum samples to use regime-specific model
  regimeMinSamples: 15,

  // Supported regimes
  regimes: ['TRENDING', 'RANGING', 'WEAK_TREND', 'UNKNOWN'],

  // Maximum history kept for isotonic regression
  maxHistory: 500,
};

// ═══════════════════════════════════════════════════════════════════════════════
//  PlattScaler  —  online logistic regression calibration
//  Maps rawProb ∈ [0,1] → calibrated prob ∈ [0,1]
// ═══════════════════════════════════════════════════════════════════════════════
class PlattScaler {
  constructor (lr = CALIB_CONFIG.plattLR) {
    this.lr = lr;
    this.a  = 1.0;   // slope initialised to identity
    this.b  = 0.0;   // bias
    this.n  = 0;
  }

  // Online SGD update with one sample
  update (rawProb, won) {
    const p    = sigmoid(this.a * rawProb + this.b);
    const err  = p - (won ? 1 : 0);           // dL/dp
    this.a    -= this.lr * err * rawProb;
    this.b    -= this.lr * err;
    this.n++;
  }

  // Predict calibrated probability
  predict (rawProb) {
    return clamp01(sigmoid(this.a * rawProb + this.b));
  }

  // Batch fit on historical (rawProb, label) pairs
  fitBatch (samples, epochs = 20) {
    for (let ep = 0; ep < epochs; ep++) {
      for (const { rawProb, won } of samples) {
        this.update(rawProb, won);
      }
    }
  }

  state () { return { a: this.a, b: this.b, n: this.n }; }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  IsotonicCalibrator  —  Pool Adjacent Violators algorithm
//  Produces a piecewise-monotone calibration mapping.
//  Recalculated periodically from the full history.
// ═══════════════════════════════════════════════════════════════════════════════
class IsotonicCalibrator {
  constructor () {
    this.mapping = [];   // sorted [{x, y}] calibration curve
    this.n       = 0;
  }

  // Re-fit on all historical samples (sorted ascending by rawProb)
  fit (samples) {
    if (samples.length < 2) return;
    const sorted = [...samples].sort((a, b) => a.rawProb - b.rawProb);

    // Pool Adjacent Violators: enforce monotone non-decreasing
    const blocks = sorted.map(s => ({ x: s.rawProb, y: s.won ? 1 : 0, w: 1 }));
    let i = 0;
    while (i < blocks.length - 1) {
      if (blocks[i].y > blocks[i + 1].y) {
        // Merge blocks i and i+1
        const merged = {
          x: (blocks[i].x * blocks[i].w + blocks[i + 1].x * blocks[i + 1].w) / (blocks[i].w + blocks[i + 1].w),
          y: (blocks[i].y * blocks[i].w + blocks[i + 1].y * blocks[i + 1].w) / (blocks[i].w + blocks[i + 1].w),
          w:  blocks[i].w + blocks[i + 1].w,
        };
        blocks.splice(i, 2, merged);
        if (i > 0) i--;
      } else {
        i++;
      }
    }

    this.mapping = blocks;
    this.n       = samples.length;
  }

  // Interpolate calibrated probability from the learned curve
  predict (rawProb) {
    if (this.mapping.length === 0) return rawProb;

    // Below first point → extrapolate flat
    if (rawProb <= this.mapping[0].x) return this.mapping[0].y;
    // Above last point → extrapolate flat
    if (rawProb >= this.mapping[this.mapping.length - 1].x) return this.mapping[this.mapping.length - 1].y;

    // Linear interpolation between neighbouring points
    for (let i = 0; i < this.mapping.length - 1; i++) {
      const lo = this.mapping[i], hi = this.mapping[i + 1];
      if (rawProb >= lo.x && rawProb <= hi.x) {
        const t = (rawProb - lo.x) / (hi.x - lo.x + 1e-10);
        return clamp01(lo.y + t * (hi.y - lo.y));
      }
    }
    return rawProb;
  }

  state () { return { n: this.n, points: this.mapping.length }; }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ReliabilityTracker  —  calibration diagnostics
// ═══════════════════════════════════════════════════════════════════════════════
class ReliabilityTracker {
  constructor (numBuckets = CALIB_CONFIG.numBuckets) {
    this.numBuckets = numBuckets;
    this.buckets    = Array.from({ length: numBuckets }, () => ({ count: 0, wins: 0 }));
  }

  // rawProb in [0,1], won: boolean
  record (rawProb, won) {
    const idx = Math.min(this.numBuckets - 1, Math.floor(rawProb * this.numBuckets));
    this.buckets[idx].count++;
    if (won) this.buckets[idx].wins++;
  }

  // ECE: weighted mean absolute calibration error
  ece () {
    const total = this.buckets.reduce((s, b) => s + b.count, 0);
    if (total === 0) return null;
    let ece = 0;
    for (let i = 0; i < this.numBuckets; i++) {
      const b = this.buckets[i];
      if (b.count === 0) continue;
      const bucketMidConf = (i + 0.5) / this.numBuckets;   // expected confidence
      const actualWinRate = b.wins / b.count;               // observed accuracy
      ece += (b.count / total) * Math.abs(actualWinRate - bucketMidConf);
    }
    return parseFloat(ece.toFixed(4));
  }

  // Reliability diagram data: [{bucket, confidence, accuracy, count}]
  diagram () {
    return this.buckets.map((b, i) => ({
      bucket:          i,
      confLow:         parseFloat((i / this.numBuckets).toFixed(2)),
      confHigh:        parseFloat(((i + 1) / this.numBuckets).toFixed(2)),
      midConf:         parseFloat(((i + 0.5) / this.numBuckets).toFixed(2)),
      accuracy:        b.count > 0 ? parseFloat((b.wins / b.count).toFixed(4)) : null,
      count:           b.count,
      wins:            b.wins,
      gap:             b.count > 0
        ? parseFloat((b.wins / b.count - (i + 0.5) / this.numBuckets).toFixed(4))
        : null,
    }));
  }

  totalSamples () { return this.buckets.reduce((s, b) => s + b.count, 0); }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ConfidenceCalibrator  —  main class
// ═══════════════════════════════════════════════════════════════════════════════
class ConfidenceCalibrator {
  constructor (cfg = {}) {
    this.cfg        = { ...CALIB_CONFIG, ...cfg };

    // Global calibrators
    this.platt      = new PlattScaler();
    this.isotonic   = new IsotonicCalibrator();
    this.reliability = new ReliabilityTracker(this.cfg.numBuckets);

    // Per-regime calibrators
    this.regimePlatt = {};
    this.regimeReliability = {};
    for (const r of this.cfg.regimes) {
      this.regimePlatt[r]       = new PlattScaler();
      this.regimeReliability[r] = new ReliabilityTracker(this.cfg.numBuckets);
    }

    // Full history for isotonic refitting
    this.history    = [];   // [{rawProb, won, regime}]
    this.totalSamples = 0;
    this.lastIsotonicFit = 0;
  }

  // ── Record a closed trade outcome ─────────────────────────────────────────
  // rawConf: the confidence value (30–95) at trade entry
  // won: boolean (trade profitable)
  // regime: market regime at entry ('TRENDING', 'RANGING', etc.)
  recordOutcome (rawConf, won, regime = 'UNKNOWN') {
    const rawProb = this._confToProb(rawConf);

    // Update global trackers
    this.platt.update(rawProb, won);
    this.reliability.record(rawProb, won);

    // Update regime-specific trackers
    const r = this.cfg.regimes.includes(regime) ? regime : 'UNKNOWN';
    this.regimePlatt[r].update(rawProb, won);
    this.regimeReliability[r].record(rawProb, won);

    // Add to history for isotonic refitting
    this.history.push({ rawProb, won, regime: r });
    if (this.history.length > this.cfg.maxHistory) this.history.shift();
    this.totalSamples++;

    // Refit isotonic every 10 new samples once we have enough
    if (this.totalSamples >= this.cfg.isotonicMinSamples &&
        this.totalSamples - this.lastIsotonicFit >= 10) {
      this.isotonic.fit(this.history);
      this.lastIsotonicFit = this.totalSamples;
    }
  }

  // ── Apply calibration to a raw confidence value ───────────────────────────
  // Returns { calibratedConf, rawConf, method, calibratedProb, rawProb }
  calibrate (rawConf, regime = 'UNKNOWN') {
    // Bug fix: NaN/null rawConf propagated as calibratedConf=null into enterPosition,
    // where confidence comparisons (conf < minConf) would fail silently or crash.
    // Clamp to a safe default instead.
    const safeRaw = (typeof rawConf === 'number' && isFinite(rawConf))
      ? Math.max(0, Math.min(100, rawConf)) : 50;
    const rawProb = this._confToProb(safeRaw);
    const n       = this.totalSamples;

    // Not enough data — return raw
    if (n < this.cfg.minSamplesForCalibration) {
      return {
        calibratedConf: safeRaw,
        rawConf:        safeRaw,
        method:         'raw_insufficient_data',
        calibratedProb: rawProb,
        rawProb,
        samplesUsed:    n,
        required:       this.cfg.minSamplesForCalibration,
      };
    }

    let calibratedProb, method;

    // Try regime-specific calibration first
    const regimeKey = this.cfg.regimes.includes(regime) ? regime : 'UNKNOWN';
    const regimeSamples = this.history.filter(h => h.regime === regimeKey).length;

    if (regimeSamples >= this.cfg.regimeMinSamples) {
      // Use regime-specific Platt
      calibratedProb = this.regimePlatt[regimeKey].predict(rawProb);
      method         = `platt_regime_${regimeKey}`;
    } else if (n >= this.cfg.isotonicMinSamples && this.isotonic.mapping.length > 1) {
      // Use global isotonic (most flexible)
      calibratedProb = this.isotonic.predict(rawProb);
      method         = 'isotonic';
    } else {
      // Fall back to global Platt
      calibratedProb = this.platt.predict(rawProb);
      method         = 'platt_global';
    }

    calibratedProb = clamp01(calibratedProb);
    const calibratedConf = clampConf(30 + calibratedProb * 65);

    return {
      calibratedConf,
      rawConf,
      method,
      calibratedProb:  parseFloat(calibratedProb.toFixed(4)),
      rawProb:         parseFloat(rawProb.toFixed(4)),
      adjustment:      calibratedConf - rawConf,
      samplesUsed:     n,
      regimeSamples,
    };
  }

  // ── Convert confidence (30–95) ↔ probability (0–1) ───────────────────────
  _confToProb (conf) { return clamp01((conf - 30) / 65); }
  _probToConf (prob) { return clampConf(30 + prob * 65); }

  // ── ECE measurement ───────────────────────────────────────────────────────
  ece (regime = null) {
    if (regime && this.cfg.regimes.includes(regime)) {
      return this.regimeReliability[regime].ece();
    }
    return this.reliability.ece();
  }

  // ── Reliability diagram ───────────────────────────────────────────────────
  reliabilityDiagram (regime = null) {
    if (regime && this.cfg.regimes.includes(regime)) {
      return this.regimeReliability[regime].diagram();
    }
    return this.reliability.diagram();
  }

  // ── Full status ───────────────────────────────────────────────────────────
  status () {
    const globalECE = this.ece();
    const regimeStats = {};
    for (const r of this.cfg.regimes) {
      const n = this.history.filter(h => h.regime === r).length;
      regimeStats[r] = {
        samples:    n,
        ece:        this.regimeReliability[r].ece(),
        platt:      this.regimePlatt[r].state(),
        hasModel:   n >= this.cfg.regimeMinSamples,
      };
    }

    return {
      totalSamples:        this.totalSamples,
      minSamplesRequired:  this.cfg.minSamplesForCalibration,
      isActive:            this.totalSamples >= this.cfg.minSamplesForCalibration,
      globalECE,
      calibrationQuality:  globalECE === null ? 'insufficient_data'
                         : globalECE <= 0.05  ? 'excellent'
                         : globalECE <= 0.10  ? 'good'
                         : globalECE <= 0.15  ? 'moderate'
                         : 'poor',
      platt:               this.platt.state(),
      isotonic:            this.isotonic.state(),
      regimeStats,
      reliabilityDiagram:  this.reliabilityDiagram(),
    };
  }

  printStatus () {
    const s    = this.status();
    const line = '-'.repeat(64);
    console.log('\n' + '='.repeat(64));
    console.log('  CONFIDENCE CALIBRATOR STATUS');
    console.log('='.repeat(64));
    console.log('  Samples: ' + s.totalSamples + ' | Active: ' + (s.isActive ? 'YES' : 'NO (need ' + s.minSamplesRequired + ')'));
    if (s.globalECE !== null) {
      console.log('  Global ECE: ' + s.globalECE + ' (' + s.calibrationQuality + ')');
    }
    console.log('  Platt: a=' + s.platt.a.toFixed(3) + ' b=' + s.platt.b.toFixed(3));
    console.log('  Isotonic: ' + s.isotonic.n + ' samples, ' + s.isotonic.points + ' breakpoints');
    console.log('\n  Reliability Diagram:');
    console.log('  ' + line);
    console.log('  ' + 'Bucket'.padEnd(12) + 'Conf%'.padStart(7) + 'WinRate%'.padStart(10) + 'Gap'.padStart(8) + 'Count'.padStart(7));
    console.log('  ' + line);
    for (const b of s.reliabilityDiagram) {
      if (b.count === 0) continue;
      const acc = b.accuracy !== null ? (b.accuracy * 100).toFixed(1) : '  -';
      const gap = b.gap !== null ? (b.gap >= 0 ? '+' : '') + (b.gap * 100).toFixed(1) : '  -';
      console.log(
        '  ' + (b.confLow * 100).toFixed(0).padStart(3) + '–' + (b.confHigh * 100).toFixed(0).padStart(3) + '%'.padEnd(6) +
        (b.midConf * 100).toFixed(0).padStart(7) +
        acc.padStart(10) + '%' +
        gap.padStart(7) + '%' +
        String(b.count).padStart(7)
      );
    }
    console.log('\n  Per-Regime ECE:');
    for (const [r, rs] of Object.entries(s.regimeStats)) {
      const ece = rs.ece !== null ? rs.ece.toFixed(4) : 'n/a';
      console.log('  ' + r.padEnd(14) + ' samples=' + rs.samples + ' ECE=' + ece + (rs.hasModel ? ' [active]' : ' [insufficient]'));
    }
    console.log('='.repeat(64) + '\n');
  }
}

// Item #39: Online update — stream calibration updates after each closed trade
// Call from execution.js after every exitPosition
ConfidenceCalibrator.prototype.onlineUpdate = function(rawConf, won, regime) {
  // Item #39: alias recordOutcome — increments totalSamples internally
  this.recordOutcome(rawConf, won, regime);
  this.totalSamples = (this.totalSamples || 0) + 1;
  // If we now have enough data, refit the calibration
  const total = this.buckets.reduce((s,b)=>s+b.count,0);
  if (total > 0 && total % 10 === 0) {
    // Trigger a lightweight recalibration every 10 trades
    console.log(`[Calibrator #39] Online recalibration at ${total} samples`);
  }
};

// Item 16: Brier score rolling 30-trade window (not all-time)
ConfidenceCalibrator.prototype.rollingBrierScore = function(windowSize=30) {
  const data = (this._history || []).slice(-windowSize);
  if (data.length < 5) return null;
  const brier = data.reduce((s,d)=>s+(d.predicted/100 - (d.won?1:0))**2,0)/data.length;
  return parseFloat(brier.toFixed(4));
};

// If _history not populated, ensure recordOutcome adds to it
const _origRecord = ConfidenceCalibrator.prototype.recordOutcome;
if (_origRecord) {
  ConfidenceCalibrator.prototype.recordOutcome = function(rawConf, won, regime) {
    if (!this._history) this._history = [];
    this._history.push({ predicted: rawConf, won, regime, ts: Date.now() });
    if (this._history.length > 500) this._history.shift();
    return _origRecord.call(this, rawConf, won, regime);
  };
}

// Item 12: Write calibration curve JSON to trade_logs/ every 50 trades
ConfidenceCalibrator.prototype.writeCalibrationCurve = function() {
  try {
    const fs = require('fs'), path = require('path');
    const dir = path.join(__dirname,'trade_logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
    const buckets = Array.from({length:10},(_,i)=>({
      range:       `${i*10}-${(i+1)*10}%`,
      predicted:   i*10+5,
      actual:      null,
      count:       0,
    }));
    for (const b of (this.buckets||this.reliability||[])) {
      const idx = Math.min(9, Math.floor((b.midpoint||50)/10));
      buckets[idx].actual = b.actualWinRate||b.actual||null;
      buckets[idx].count  = b.count||0;
    }
    const _ccPath = path.join(dir,`calibration-curve-${new Date().toISOString().slice(0,10)}.json`);
    _atomicWrite(_ccPath, JSON.stringify({ generated: new Date().toISOString(), buckets }, null, 2));
  } catch(_) {}
};

ConfidenceCalibrator.prototype.onlineUpdate = function(rawConf, won, regime) {
  this.recordOutcome(rawConf, won, regime);
  const _arr = Array.isArray(this.buckets) ? this.buckets : Array.isArray(this.reliability) ? this.reliability : [];
  const total = _arr.reduce((s,b)=>s+(b.count||0),0);
  if (total > 0 && total % 50 === 0) {
    this.writeCalibrationCurve();
    console.log(`[Calibrator #12] Curve written at ${total} samples`);
  }
};

module.exports = { ConfidenceCalibrator, PlattScaler, IsotonicCalibrator, ReliabilityTracker, CALIB_CONFIG };
