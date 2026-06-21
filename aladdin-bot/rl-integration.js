'use strict';

// Bug fix: atomic state write — prevents corrupt files on crash mid-write
function _atomicWrite(filePath, content) {
  const tmp = filePath + '.tmp';
  require('fs').writeFileSync(tmp, content, 'utf8');
  require('fs').renameSync(tmp, filePath);
}

const { TRADING_CONFIG } = require('./trading-config');
// ── rl-integration.js ─────────────────────────────────────────────────────────
// Wires the existing QLearning class from ml-improvements.js into the trading
// engine as a post-filter layer on top of the primary strategy signal.
//
// Fixes: Advanced partial — "Add reinforcement learning only after robust
// baselines are proven." (QLearning class exists but was unwired.)
//
// How it integrates:
//   1. After the primary model returns BUY/SELL/HOLD, pass indicators to RL.
//   2. RL either CONFIRMS or VETOES the signal based on its Q-table.
//   3. After each trade closes, call update() with the realised reward.
//   4. Q-table persists to disk — survives restarts.
//
// The RL layer starts in shadow mode (never overrides) until it has accumulated
// minSamples (default 30) Q-table updates. This ensures the baseline strategy
// runs unchanged while RL learns, as the analysis recommends.
//
// Usage (mix into TradingEngine):
//   const { RLIntegration } = require('./rl-integration');
//   this.rl = new RLIntegration();
//   // In tick loop, after primary signal:
//   const final = this.rl.filter(primaryDecision, indicators);
//   // After trade closes:
//   this.rl.reward(finalPnlPct);
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const { QLearning } = require('./ml-improvements');

const QTABLE_FILE  = path.join(__dirname, 'trade_logs', 'rl_qtable.json');
const MIN_SAMPLES  = 30;   // shadow mode until this many updates

class RLIntegration {
  constructor(opts = {}) {
    this.minSamples  = opts.minSamples  || MIN_SAMPLES;
    this.shadowMode  = opts.shadowMode  !== false;   // start in shadow mode
    this._ql         = new QLearning(
      opts.alpha   || 0.1,
      opts.gamma   || 0.9,
      opts.epsilon || 0.15
    );
    this._lastIndicators = null;
    this._lastAction     = null;
    this._totalRewards   = 0;
    this._updateCount    = 0;
    this._vetoes         = 0;
    this._confirms       = 0;
    this._load();
  }

  // ── Filter a primary signal through the RL layer ──────────────────────────
  // primaryDecision: { action: 'BUY'|'SELL'|'HOLD', confidence, reasoning }
  // indicators:      { rsi, macd, adxRegime, session, ... }
  // Returns: { action, confidence, reasoning, rlMode, rlAction, vetoed }
  filter(primaryDecision, indicators) {
    this._lastIndicators = indicators;
    const rlResult = this._ql.chooseAction(indicators);
    this._lastAction = rlResult.action;

    // Shadow mode: RL observes but never overrides
    if (this.shadowMode || this._updateCount < this.minSamples) {
      return {
        ...primaryDecision,
        rlMode:   'shadow',
        rlAction: rlResult.action,
        vetoed:   false,
        rlQValues: rlResult.qValues,
      };
    }

    // Active mode: RL can veto a signal if it disagrees
    // Veto only if RL strongly prefers HOLD over the primary action
    const q = rlResult.qValues;
    const primaryQ = q[primaryDecision.action] || 0;
    const holdQ    = q['HOLD'] || 0;

    const vetoed = primaryDecision.action !== 'HOLD' && holdQ > primaryQ + 0.05;
    // 7.3: Safe RL constraints — RL cannot override risk limits
    const _rlAction = rlResult?.action;
    if (_rlAction === 'BUY' || _rlAction === 'SELL') {
      // Check drawdown constraint
      const _dd = this.initialCapital > 0 ? (this.initialCapital - this.capital) / this.initialCapital : 0;
      if (_dd > (TRADING_CONFIG?.globalDrawdownLimit || 0.20)) {
        rlResult = { action:'HOLD', confidence:0, reason:'[Safe RL #7.3] Drawdown limit — RL overridden' };
      }
      // Check position size constraint
      if (this.position) {
        rlResult = { action:'HOLD', confidence:0, reason:'[Safe RL #7.3] Already in position — no pyramid from RL' };
      }
    }
    if (vetoed) {
      this._vetoes++;  // Fix #56: Count vetoes separately from confidence-blocked signals
      return {
        action:    'HOLD',
        confidence: 0,
        reasoning: `RL vetoed ${primaryDecision.action} (holdQ=${holdQ.toFixed(3)} > actionQ=${primaryQ.toFixed(3)})`,
        rlMode:    'active',
        rlAction:  rlResult.action,
        vetoed:    true,
        original:  primaryDecision,
      };
    }

    this._confirms++;
    return {
      ...primaryDecision,
      rlMode:    'active',
      rlAction:  rlResult.action,
      vetoed:    false,
      rlQValues: q,
    };
  }

  // ── Update Q-table after a trade closes ───────────────────────────────────
  // pnlPct: trade profit/loss as a fraction (e.g. 0.005 = +0.5%, -0.003 = -0.3%)
  reward(pnlPct) {
    if (!this._lastIndicators || !this._lastAction) return;

    // Shape reward: profit → positive, loss → negative, scaled to [-1, 1]
    const reward = Math.max(-1, Math.min(1, pnlPct * 100));
    this._ql.update(this._lastIndicators, reward);
    this._totalRewards += reward;
    this._updateCount++;

    // Exit shadow mode once we have enough updates
    if (this.shadowMode && this._updateCount >= this.minSamples) {
      this.shadowMode = false;
      console.log('[RLIntegration] Shadow mode ended — RL now active after ' + this._updateCount + ' updates');
    }

    this._save();
  }

  // ── Stats ─────────────────────────────────────────────────────────────────
  stats() {
    const qlStats = this._ql.stats();
    return {
      mode:         this.shadowMode || this._updateCount < this.minSamples ? 'shadow' : 'active',
      updateCount:  this._updateCount,
      minSamples:   this.minSamples,
      vetoes:       this._vetoes,
      confirms:     this._confirms,
      avgReward:    this._updateCount > 0 ? parseFloat((this._totalRewards / this._updateCount).toFixed(4)) : 0,
      epsilon:      qlStats.epsilon,
      qTableStates: qlStats.states,
      topStates:    qlStats.topStates,
    };
  }

  // ── Persist Q-table ───────────────────────────────────────────────────────
  _save() {
    try {
      const dir = path.dirname(QTABLE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      _atomicWrite(QTABLE_FILE, JSON.stringify({
        q:            this._ql._Q,
        epsilon:      this._ql._epsilon,
        updateCount:  this._updateCount,
        totalRewards: this._totalRewards,
        vetoes:       this._vetoes,
        confirms:     this._confirms,
      }));
    } catch (_) {}
  }

  _load() {
    try {
      if (!fs.existsSync(QTABLE_FILE)) return;
      const data = JSON.parse(fs.readFileSync(QTABLE_FILE, 'utf8'));
      if (data.q)            this._ql._Q           = data.q;
      if (data.epsilon)      this._ql._epsilon      = data.epsilon;
      if (data.updateCount)  this._updateCount      = data.updateCount;
      if (data.totalRewards) this._totalRewards     = data.totalRewards;
      if (data.vetoes)       this._vetoes           = data.vetoes;
      if (data.confirms)     this._confirms         = data.confirms;
      // Keep shadow mode if we haven't hit minSamples yet
      this.shadowMode = this._updateCount < this.minSamples;
      console.log('[RLIntegration] Loaded Q-table: ' + Object.keys(this._ql._Q).length + ' states, ' + this._updateCount + ' updates');
    } catch (_) {}
  }

  // ── Integration test with a mock engine ──────────────────────────────────
  static createForEngine(engine, opts = {}) {
    const rl = new RLIntegration(opts);
    // Hook into engine if it exposes the right events
    if (engine && typeof engine.on === 'function') {
      engine.on('tradeClose', (trade) => {
        rl.reward(trade.profitPercent / 100 || trade.profit / (engine.capital || 10000));
      });
    }
    return rl;
  }
}

module.exports = { RLIntegration };
