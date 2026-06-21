'use strict';
// ── governance.js ─────────────────────────────────────────────────────────────
// Implements all governance, intelligence, and data-quality features:
//  9.1  Model registry
//  9.3  Human approval mode
//  10.1 Auto rollback
//  11.3 Corporate actions handling
//  14.1 Bayesian decision engine
//  14.2 Knowledge graph
//  14.3 Causal inference (Granger)

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

// ────────────────────────────────────────────────────────────────────────────
// 9.1 Model Registry
// ────────────────────────────────────────────────────────────────────────────
class ModelRegistry {
  /**
   * Versions every model with params, metrics, and training data hash.
   * Enables full reproducibility and rollback.
   */
  constructor(opts = {}) {
    this._dir  = opts.dir || path.join(__dirname, 'trade_logs', 'model-registry');
    this._log  = opts.log || (m => console.log('[ModelRegistry]', m));
    fs.mkdirSync(this._dir, { recursive: true });
    this._index = this._loadIndex();
  }

  _indexPath() { return path.join(this._dir, 'index.json'); }

  _loadIndex() {
    try {
      if (fs.existsSync(this._indexPath())) return JSON.parse(fs.readFileSync(this._indexPath(), 'utf8'));
    } catch (_) {}
    return { models: [], latestByName: {} };
  }

  _saveIndex() {
    try { fs.writeFileSync(this._indexPath(), JSON.stringify(this._index, null, 2)); } catch (_) {}
  }

  /** Hash training data for provenance tracking */
  hashData(data) {
    return crypto.createHash('sha256').update(JSON.stringify(data).slice(0, 10000)).digest('hex').slice(0, 16);
  }

  /**
   * Register a trained model.
   * @param {string} name         Model name (e.g. 'gbm-v1', 'hmm-eurusd')
   * @param {object} params       Hyperparameters used
   * @param {object} metrics      { sharpe, winRate, profitFactor, ... }
   * @param {any}    trainingData Training data (for hashing)
   * @returns {string} versionId
   */
  register(name, params, metrics, trainingData) {
    const versionId  = `${name}-${Date.now()}`;
    const dataHash   = this.hashData(trainingData || {});
    const entry = {
      versionId, name, params, metrics, dataHash,
      registeredAt: new Date().toISOString(),
      active: false,
    };

    // Persist model entry
    try {
      fs.writeFileSync(path.join(this._dir, `${versionId}.json`), JSON.stringify(entry, null, 2));
    } catch (_) {}

    this._index.models.push({ versionId, name, metrics, dataHash, registeredAt: entry.registeredAt });
    this._index.latestByName[name] = versionId;
    this._saveIndex();
    this._log(`✅ Registered ${versionId} | Sharpe: ${metrics?.sharpe?.toFixed(3)||'?'} | dataHash: ${dataHash}`);
    return versionId;
  }

  /** Promote a model version to active */
  promote(versionId) {
    // Demote all versions of same model
    const entry = this._loadVersion(versionId);
    if (!entry) throw new Error(`Version ${versionId} not found`);
    for (const m of this._index.models) {
      if (m.name === entry.name) {
        const v = this._loadVersion(m.versionId);
        if (v) { v.active = false; this._saveVersion(m.versionId, v); }
      }
    }
    entry.active = true;
    entry.promotedAt = new Date().toISOString();
    this._saveVersion(versionId, entry);
    this._log(`🚀 Promoted ${versionId} to active`);
  }

  /** Get the active version for a model name */
  getActive(name) {
    const versionId = this._index.latestByName[name];
    return versionId ? this._loadVersion(versionId) : null;
  }

  _loadVersion(versionId) {
    try {
      const p = path.join(this._dir, `${versionId}.json`);
      return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
    } catch (_) { return null; }
  }

  _saveVersion(versionId, data) {
    try { fs.writeFileSync(path.join(this._dir, `${versionId}.json`), JSON.stringify(data, null, 2)); } catch (_) {}
  }

  list(name) {
    return this._index.models.filter(m => !name || m.name === name).slice(-20);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 9.3 Human Approval Mode
// ────────────────────────────────────────────────────────────────────────────
class HumanApprovalGate {
  /**
   * Requires manual approval (via Telegram or flag file) for trades
   * above a configurable capital threshold.
   * @param {object} opts
   * @param {number}   opts.thresholdPct  Capital % requiring approval (default 0.03 = 3%)
   * @param {number}   opts.timeoutMs     Auto-reject timeout in ms (default 300000 = 5min)
   * @param {string}   opts.flagDir       Directory for approval flag files
   * @param {Function} opts.notify        async fn(message) — send Telegram alert
   * @param {Function} opts.log
   */
  constructor(opts = {}) {
    this.threshold  = opts.thresholdPct || 0.03;
    this.timeoutMs  = opts.timeoutMs    || 300_000;
    this.flagDir    = opts.flagDir      || path.join(__dirname, 'trade_logs', 'approvals');
    this.notify     = opts.notify       || null;
    this._log       = opts.log          || (m => console.log('[HumanApproval]', m));
    fs.mkdirSync(this.flagDir, { recursive: true });
  }

  /**
   * Check if a trade requires human approval.
   * @param {number} positionSize  Dollar value of proposed position
   * @param {number} capital       Current total capital
   * @returns {bool}
   */
  requiresApproval(positionSize, capital) {
    return capital > 0 && (positionSize / capital) >= this.threshold;
  }

  /**
   * Request approval and wait for flag file or timeout.
   * @param {object} tradeDetails  { asset, side, size, confidence, reason }
   * @param {number} capital
   * @returns {Promise<bool>} true = approved, false = rejected/timeout
   */
  async requestApproval(tradeDetails, capital) {
    const approvalId   = `approval-${Date.now()}`;
    const flagPath     = path.join(this.flagDir, `${approvalId}.approved`);
    const rejectPath   = path.join(this.flagDir, `${approvalId}.rejected`);

    const pct = ((tradeDetails.size || 0) / capital * 100).toFixed(1);
    const msg = `⚠️ APPROVAL REQUIRED (${pct}% of capital)\n` +
      `Trade: ${tradeDetails.side||'BUY'} ${tradeDetails.asset||'?'}\n` +
      `Size: $${(tradeDetails.size||0).toFixed(2)} | Conf: ${tradeDetails.confidence||0}%\n` +
      `Reason: ${tradeDetails.reason||''}\n` +
      `Approve: touch ${flagPath}\nReject: touch ${rejectPath}\n` +
      `Auto-reject in ${(this.timeoutMs/60000).toFixed(0)} minutes.`;

    this._log(msg);
    if (this.notify) { try { await this.notify(msg); } catch (_) {} }

    // Write pending file
    try { fs.writeFileSync(path.join(this.flagDir, `${approvalId}.pending`), JSON.stringify({ ...tradeDetails, capital, requestedAt: new Date().toISOString() })); } catch (_) {}

    // Poll for approval/rejection
    const start = Date.now();
    return new Promise(resolve => {
      const poll = setInterval(() => {
        if (fs.existsSync(flagPath)) { clearInterval(poll); this._log(`✅ Trade approved: ${approvalId}`); resolve(true); return; }
        if (fs.existsSync(rejectPath)) { clearInterval(poll); this._log(`❌ Trade rejected: ${approvalId}`); resolve(false); return; }
        if (Date.now() - start > this.timeoutMs) {
          clearInterval(poll);
          this._log(`⏰ Approval timeout — auto-rejected: ${approvalId}`);
          resolve(false);
        }
      }, 5000);
    });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 10.1 Auto Rollback
// ────────────────────────────────────────────────────────────────────────────
class AutoRollback {
  /**
   * Monitors live metrics and reverts to previous model if performance deteriorates.
   * @param {object} opts
   * @param {number}   opts.sharpeDeclineThresh  Rollback if Sharpe drops by this much (default 0.5)
   * @param {number}   opts.winRateDeclineThresh  Rollback if WR drops by this much (default 0.10)
   * @param {number}   opts.checkWindowTrades     Trades to check (default 20)
   * @param {ModelRegistry} opts.registry
   * @param {Function} opts.onRollback   async fn(previousVersion) — called when rollback triggered
   * @param {Function} opts.log
   */
  constructor(opts = {}) {
    this.sharpeDrop  = opts.sharpeDeclineThresh  || 0.5;
    this.wrDrop      = opts.winRateDeclineThresh  || 0.10;
    this.window      = opts.checkWindowTrades     || 20;
    this.registry    = opts.registry             || null;
    this.onRollback  = opts.onRollback           || (async () => {});
    this._log        = opts.log || (m => console.log('[AutoRollback]', m));
    this._baseline   = null;  // { sharpe, winRate } at last promotion
    this._trades     = [];
    this._rolling    = { sharpe: null, winRate: null };
  }

  /** Set baseline metrics at model promotion time */
  setBaseline(sharpe, winRate) {
    this._baseline = { sharpe, winRate, setAt: Date.now() };
    this._log(`Baseline set: Sharpe=${sharpe?.toFixed(3)} WR=${(winRate*100)?.toFixed(1)}%`);
  }

  /** Record trade outcome */
  recordTrade(trade) {
    this._trades.push({ profit: trade.profit || 0, ts: Date.now() });
    if (this._trades.length > this.window * 3) this._trades.shift();
    this._updateRolling();
    this._check();
  }

  _updateRolling() {
    const recent = this._trades.slice(-this.window);
    if (recent.length < 5) return;
    const rets   = recent.map(t => t.profit);
    const mean   = rets.reduce((s,v)=>s+v,0)/rets.length;
    const std    = Math.sqrt(rets.reduce((s,v)=>s+(v-mean)**2,0)/rets.length) || 1;
    const wins   = recent.filter(t=>t.profit>0).length;
    this._rolling.sharpe  = mean/std*Math.sqrt(252);
    this._rolling.winRate = wins/recent.length;
  }

  _check() {
    if (!this._baseline || !this._rolling.sharpe) return;
    const sharpeDrop = this._baseline.sharpe - this._rolling.sharpe;
    const wrDrop     = this._baseline.winRate - this._rolling.winRate;

    if (sharpeDrop >= this.sharpeDrop || wrDrop >= this.wrDrop) {
      const reason = sharpeDrop >= this.sharpeDrop
        ? `Sharpe dropped ${sharpeDrop.toFixed(3)} (baseline: ${this._baseline.sharpe.toFixed(3)} → current: ${this._rolling.sharpe.toFixed(3)})`
        : `Win rate dropped ${(wrDrop*100).toFixed(1)}% (baseline: ${(this._baseline.winRate*100).toFixed(1)}% → current: ${(this._rolling.winRate*100).toFixed(1)}%)`;

      this._log(`⚠️  Auto rollback triggered — ${reason}`);
      this.onRollback({ reason, sharpeDrop, wrDrop, rolling: this._rolling, baseline: this._baseline })
        .catch(e => this._log(`Rollback callback error: ${e.message}`));
      this._baseline = null;  // prevent repeated triggers
    }
  }

  status() {
    return { baseline: this._baseline, rolling: this._rolling, trades: this._trades.length };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 11.3 Corporate Actions Handling
// ────────────────────────────────────────────────────────────────────────────
class CorporateActionsHandler {
  /**
   * Adjusts historical prices for stock splits and dividends.
   * For forex, handles currency redenomination events (e.g. Turkey 2005 TRY).
   */
  constructor(opts = {}) {
    this._actions = opts.actions || {};  // { 'AAPL': [{ date, type, factor }] }
    this._log     = opts.log || (() => {});
  }

  /** Register a corporate action */
  addAction(symbol, date, type, factor) {
    if (!this._actions[symbol]) this._actions[symbol] = [];
    this._actions[symbol].push({ date, type, factor });
    this._actions[symbol].sort((a, b) => new Date(a.date) - new Date(b.date));
    this._log(`Corporate action registered: ${symbol} ${type} ×${factor} on ${date}`);
  }

  /**
   * Adjust a price series for all corporate actions after startDate.
   * @param {string}   symbol
   * @param {number[]} prices    Unadjusted prices (oldest first)
   * @param {string[]} dates     Corresponding ISO date strings
   * @returns {number[]}         Adjusted prices (split/dividend adjusted)
   */
  adjustPrices(symbol, prices, dates) {
    const actions = this._actions[symbol] || [];
    if (!actions.length || !dates) return prices;

    let adjusted = [...prices];
    for (const action of actions) {
      const actionDate = new Date(action.date);
      for (let i = 0; i < dates.length; i++) {
        if (new Date(dates[i]) < actionDate) {
          if (action.type === 'split') {
            adjusted[i] /= action.factor;  // pre-split prices divided by factor
          } else if (action.type === 'dividend') {
            adjusted[i] -= action.factor;  // pre-dividend prices reduced by dividend
          } else if (action.type === 'redenomination') {
            adjusted[i] /= action.factor;  // currency redenomination
          }
        }
      }
    }
    return adjusted.map(p => Math.max(0, parseFloat(p.toFixed(8))));
  }

  hasActions(symbol) { return (this._actions[symbol] || []).length > 0; }
}

// ────────────────────────────────────────────────────────────────────────────
// 14.1 Bayesian Decision Engine
// ────────────────────────────────────────────────────────────────────────────
class BayesianDecisionEngine {
  /**
   * Combines multiple signals probabilistically using Bayesian updating.
   * Each signal is treated as evidence; posterior probability is updated iteratively.
   *
   * Uses Naive Bayes with prior from historical win rate.
   * P(win | signals) ∝ P(signals | win) × P(win)
   */
  constructor(opts = {}) {
    this.priorWinRate = opts.priorWinRate || 0.50;  // base rate win probability
    this._likelihoods = {};  // signal → { winGiven: number, lossGiven: number }
    this._samples     = 0;
    this._log         = opts.log || (() => {});
  }

  /** Update signal likelihoods from closed trade outcome.
   *
   * BUG FIX: Previous impl stored SUM of signal values per win/loss bucket.
   * When signal=1 for every trade, P(signal|win) = P(signal|loss) = 1.0 so
   * the likelihood ratio is always 1 and posteriors never update.
   * Fix: store WINs and TOTAL occurrences per signal → compute win rate directly.
   */
  update(signals, won) {
    this._samples++;
    for (const [signal, value] of Object.entries(signals)) {
      if (value === undefined || value === null) continue;
      // Only treat a signal as "active" when value > 0 (binary or continuous)
      if (Number(value) === 0) continue;
      if (!this._likelihoods[signal]) {
        this._likelihoods[signal] = { wins: 0, total: 0 };
      }
      const L = this._likelihoods[signal];
      L.total++;
      if (won) L.wins++;
    }
  }

  /**
   * Compute posterior win probability given current signals.
   * @param {object} signals  { rsi: 0.8, macdPositive: 1, trendAlign: 0.7, ... }
   * @returns {{ winProb: number, confidence: number, posterior: number, signals: object }}
   */
  infer(signals) {
    let logOdds = Math.log(this.priorWinRate / (1 - this.priorWinRate + 1e-10));

    for (const [signal, value] of Object.entries(signals)) {
      const L = this._likelihoods[signal];
      // Need at least 10 observations with this signal active
      if (!L || L.total < 10) continue;

      // Observed win rate for this signal vs prior win rate
      const signalWinRate = L.wins / L.total;

      // Likelihood ratio: P(win | signal active) / P(win)
      // > 1 means signal correlates with wins, < 1 means with losses
      const lr = signalWinRate / (this.priorWinRate || 0.5);
      logOdds += Math.log(Math.max(0.01, Math.min(100, lr))) * Math.abs(Number(value) || 1);
    }

    const posterior = 1 / (1 + Math.exp(-logOdds));
    const confidence = Math.abs(posterior - 0.5) * 2;  // 0=uncertain, 1=certain

    return {
      winProb:    parseFloat(posterior.toFixed(4)),
      confidence: parseFloat(confidence.toFixed(4)),
      posterior:  parseFloat(posterior.toFixed(4)),
      action:     posterior > 0.55 ? 'BUY' : posterior < 0.45 ? 'SELL' : 'HOLD',
      samples:    this._samples,
    };
  }

  isTrained() { return this._samples >= 20; }
}

// ────────────────────────────────────────────────────────────────────────────
// 14.2 Knowledge Graph
// ────────────────────────────────────────────────────────────────────────────
class KnowledgeGraph {
  /**
   * Maps relationships between assets, macroeconomic events, and sentiment.
   * Enables cross-asset inference: "ECB rate hike → EUR strength → EURUSD bullish".
   */
  constructor(opts = {}) {
    this._nodes = new Map();  // id → { type, label, properties }
    this._edges = [];         // { from, to, relation, weight }
    this._log   = opts.log || (() => {});
    this._buildDefaultGraph();
  }

  _buildDefaultGraph() {
    // Add major forex pairs
    for (const pair of ['EURUSD','GBPUSD','USDJPY','AUDUSD','USDCHF','USDCAD','NZDUSD']) {
      this.addNode(pair, 'CURRENCY_PAIR', { baseCurrency: pair.slice(0,3), quoteCurrency: pair.slice(3) });
    }
    // Add central banks
    for (const [cb, currency] of [['ECB','EUR'],['Fed','USD'],['BOE','GBP'],['BOJ','JPY'],['RBA','AUD'],['SNB','CHF']]) {
      this.addNode(cb, 'CENTRAL_BANK', { currency });
      this.addEdge(cb, currency, 'CONTROLS', 0.9);
    }
    // Add macro events
    for (const [event, effect] of [['FOMC','USD'],['NFP','USD'],['CPI_US','USD'],['CPI_EU','EUR']]) {
      this.addNode(event, 'MACRO_EVENT', { primaryCurrency: effect });
      this.addEdge(event, effect, 'IMPACTS', 0.8);
    }
    // Add correlation edges between pairs (approximate)
    this.addEdge('EURUSD', 'GBPUSD', 'POSITIVELY_CORRELATED', 0.75);
    this.addEdge('EURUSD', 'USDJPY', 'NEGATIVELY_CORRELATED', -0.60);
    this.addEdge('AUDUSD', 'NZDUSD', 'POSITIVELY_CORRELATED', 0.85);
  }

  addNode(id, type, properties = {}) {
    this._nodes.set(id, { id, type, ...properties });
  }

  addEdge(from, to, relation, weight = 1.0) {
    this._edges.push({ from, to, relation, weight });
  }

  /**
   * Query: given a macro event, what are the expected currency impacts?
   * @param {string} eventId  e.g. 'FOMC'
   * @returns {Array<{ currency, pair, expectedImpact }>}
   */
  queryImpact(eventId) {
    const directEdges = this._edges.filter(e => e.from === eventId && e.relation === 'IMPACTS');
    const results     = [];

    for (const edge of directEdges) {
      const currency = edge.to;
      const strength = edge.weight;
      // Find pairs containing this currency
      for (const [id, node] of this._nodes) {
        if (node.type === 'CURRENCY_PAIR') {
          if (node.baseCurrency === currency) {
            results.push({ currency, pair: id, expectedImpact: strength, direction: 'BULLISH_BASE' });
          } else if (node.quoteCurrency === currency) {
            results.push({ currency, pair: id, expectedImpact: -strength, direction: 'BEARISH_BASE' });
          }
        }
      }
    }
    return results;
  }

  /** Find correlated pairs for a given pair */
  getCorrelatedPairs(pair, minWeight = 0.5) {
    return this._edges
      .filter(e => (e.from === pair || e.to === pair) && e.relation.includes('CORRELATED') && Math.abs(e.weight) >= minWeight)
      .map(e => ({ pair: e.from === pair ? e.to : e.from, correlation: e.weight, relation: e.relation }));
  }

  nodeCount() { return this._nodes.size; }
  edgeCount() { return this._edges.length; }
}

// ────────────────────────────────────────────────────────────────────────────
// 14.3 Causal Inference (Granger Causality)
// ────────────────────────────────────────────────────────────────────────────
class CausalInference {
  /**
   * Granger causality test: does X help predict Y beyond Y's own history?
   * Tests H0: X does NOT Granger-cause Y (F-test on restricted vs unrestricted VAR).
   */
  constructor(opts = {}) {
    this.maxLag = opts.maxLag || 5;
    this._log   = opts.log || (() => {});
  }

  /**
   * Test whether series X Granger-causes series Y.
   * @param {number[]} y      Target series (e.g. EURUSD returns)
   * @param {number[]} x      Candidate cause (e.g. SPX returns, sentiment score)
   * @param {number}   lag    Number of lags to test (default maxLag)
   * @returns {{ granger: bool, pValue: number, fStat: number, lag: number }}
   */
  test(y, x, lag) {
    lag = lag || this.maxLag;
    if (!y || !x || y.length < lag * 3 || x.length < lag * 3) {
      return { granger: false, pValue: 1.0, fStat: 0, lag, reason: 'Insufficient data' };
    }

    const n = Math.min(y.length, x.length) - lag;
    if (n < 10) return { granger: false, pValue: 1.0, fStat: 0, lag };

    // Build lagged matrices
    const Y = [], X_restricted = [], X_full = [];
    for (let t = lag; t < n + lag; t++) {
      Y.push(y[t]);
      const restricted = Array.from({length: lag}, (_, l) => y[t - l - 1]);
      X_restricted.push([1, ...restricted]);
      X_full.push([1, ...restricted, ...Array.from({length: lag}, (_, l) => x[t - l - 1])]);
    }

    // Compute RSS for restricted and unrestricted models
    const rssR = this._rss(Y, X_restricted);
    const rssU = this._rss(Y, X_full);

    if (rssU <= 0 || !isFinite(rssR) || !isFinite(rssU)) {
      return { granger: false, pValue: 1.0, fStat: 0, lag };
    }

    // F-statistic: ((RSS_R - RSS_U) / q) / (RSS_U / (n - k))
    const q  = lag;          // number of restrictions
    const k  = X_full[0].length;
    const fStat = ((rssR - rssU) / q) / (rssU / (n - k));

    if (!isFinite(fStat) || fStat < 0) return { granger: false, pValue: 1.0, fStat: 0, lag };

    // Approximate p-value using F distribution CDF approximation
    const pValue = this._fPValue(fStat, q, n - k);
    const granger = pValue < 0.05;

    if (granger) this._log(`Granger causality detected (F=${fStat.toFixed(2)}, p=${pValue.toFixed(4)}, lag=${lag})`);

    return {
      granger, pValue: parseFloat(pValue.toFixed(4)),
      fStat: parseFloat(fStat.toFixed(4)), lag,
      reason: granger ? `X Granger-causes Y (p=${pValue.toFixed(3)})` : `No causal relationship (p=${pValue.toFixed(3)})`,
    };
  }

  /** OLS regression, returns RSS */
  _rss(y, X) {
    const n = y.length, k = X[0].length;
    // Normal equations: β = (X'X)^-1 X'y
    const XtX = Array.from({length:k}, (_,i) => Array.from({length:k}, (_,j) => X.reduce((s,row) => s+row[i]*row[j], 0)));
    const Xty = Array.from({length:k}, (_,i) => X.reduce((s,row,r) => s+row[i]*y[r], 0));

    // Simple Cholesky-based solve (fallback: pseudoinverse via eigendecomposition skipped for brevity)
    let beta;
    try {
      beta = this._solve(XtX, Xty);
    } catch (_) { return Infinity; }

    const yhat = X.map(row => row.reduce((s,v,i) => s+v*(beta[i]||0), 0));
    return yhat.reduce((s, yh, i) => s + (y[i] - yh) ** 2, 0);
  }

  _solve(A, b) {
    const n = b.length;
    const aug = A.map((row, i) => [...row, b[i]]);
    for (let col = 0; col < n; col++) {
      let maxRow = col;
      for (let r = col+1; r < n; r++) if (Math.abs(aug[r][col]) > Math.abs(aug[maxRow][col])) maxRow = r;
      [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];
      const pivot = aug[col][col];
      if (Math.abs(pivot) < 1e-12) throw new Error('Singular matrix');
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = aug[r][col] / pivot;
        for (let c = col; c <= n; c++) aug[r][c] -= f * aug[col][c];
      }
      for (let c = col; c <= n; c++) aug[col][c] /= pivot;
    }
    return aug.map(row => row[n]);
  }

  /** Approximate F distribution p-value */
  _fPValue(f, d1, d2) {
    if (f <= 0 || !isFinite(f)) return 1.0;
    // Wilson-Hilferty approximation for chi-squared
    const x = d1 * f / (d1 * f + d2);
    const a = d1 / 2, b = d2 / 2;
    // Regularised incomplete beta function approximation (Horner's method)
    const p = this._incompleteBeta(x, a, b);
    return Math.max(0, Math.min(1, 1 - p));
  }

  _incompleteBeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Lentz continued fraction (abridged)
    let h = 1, c = 1, d = 1 - (a+b)/(a+1) * x;
    d = d === 0 ? 1e-30 : 1/d; h = d;
    for (let m = 1; m <= 50; m++) {
      for (const sign of [1, -1]) {
        const mn = sign === 1 ? m : -m;
        const num = sign === 1
          ? m*(b-m)*x / ((a+2*m-1)*(a+2*m))
          : -(a+m)*(a+b+m)*x / ((a+2*m)*(a+2*m+1));
        d = 1 + num * d; d = d === 0 ? 1e-30 : d;
        c = 1 + num / c; c = c === 0 ? 1e-30 : c;
        d = 1/d; h *= c*d;
        if (Math.abs(c*d-1) < 1e-7) break;
      }
    }
    const lbeta = lgamma(a) + lgamma(b) - lgamma(a+b);
    return Math.exp(a * Math.log(x) + b * Math.log(1-x) - lbeta) * h / a;
  }

  /** Batch test: find which series causally predict target */
  batchTest(target, candidates, lag) {
    return Object.entries(candidates).map(([name, series]) => ({
      name, ...this.test(target, series, lag || this.maxLag)
    })).sort((a, b) => a.pValue - b.pValue);
  }
}

function lgamma(x) {
  // Stirling approximation
  const g = 7, c = [0.99999999999980993,676.5203681218851,-1259.1392167224028,771.32342877765313,-176.61502916214059,12.507343278686905,-0.13857109526572012,9.9843695780195716e-6,1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI*x)) - lgamma(1-x);
  x--; let a = c[0]; const t = x + g + 0.5;
  for (let i = 1; i < g+2; i++) a += c[i]/(x+i);
  return 0.5*Math.log(2*Math.PI) + (x+0.5)*Math.log(t) - t + Math.log(a);
}

// Item 103: Human approval queue write helper
function writeApprovalRequest(trade, engine) {
  const fs = require('fs'), path = require('path');
  const dir = path.join(__dirname,'trade_logs','approvals');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true});
    const fname = path.join(dir, `approval-${Date.now()}.json`);
    fs.writeFileSync(fname, JSON.stringify({
      ...trade, requestedAt: new Date().toISOString(), status:'PENDING', pid: process.pid
    }, null, 2));
    console.log(`[Governance #103] Approval request written: ${path.basename(fname)}`);
    // Notify operator via Telegram
    try {
      require('./telegram').send(
        `🔔 APPROVAL REQUIRED\n${trade.action} ${trade.asset} @ ${trade.price?.toFixed(5)}\n`+
        `Size: $${trade.tradeValue?.toFixed(0)||'?'} | Conf: ${trade.confidence}%\n`+
        `Reply /approve to execute`, 'risk'
      );
    } catch(_) {}
    return fname;
  } catch(e) { console.warn('[Governance #103] Failed to write approval:', e.message); return null; }
}

module.exports.writeApprovalRequest = writeApprovalRequest;
module.exports = {
  ModelRegistry, HumanApprovalGate, AutoRollback, writeApprovalRequest,
  CorporateActionsHandler, BayesianDecisionEngine,
  KnowledgeGraph, CausalInference,
};
