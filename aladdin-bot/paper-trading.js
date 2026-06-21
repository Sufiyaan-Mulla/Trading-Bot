'use strict';
// ── paper-trading.js ──────────────────────────────────────────────────────────
// Paper trading mode for the Aladdin trading engine.
//
// Problem solved (#16):
//   The engine had no way to run live signals against real market prices
//   without risking real money. Paper trading fills this gap — it runs the
//   full engine stack (real prices, real indicators, real AI decisions) but
//   intercepts all order execution and simulates fills instead.
//
// How it works:
//   PaperTrading wraps a TradingEngine instance and monkey-patches:
//     enterPosition  → records a simulated position, deducts from paper capital
//     enterShort     → same for shorts
//     exitPosition   → closes simulated position, logs P/L
//   Everything else (indicators, AI, risk management, session gate, leading
//   indicators, correlation) runs exactly as in live mode.
//
// Usage:
//   const { PaperTrading } = require('./paper-trading');
//   const paper = new PaperTrading({ capital: 10000 });
//   await paper.start();   // runs until paper.stop()
//
// Enable via env: PAPER_TRADING=true node paper-trading.js
// ─────────────────────────────────────────────────────────────────────────────

const { TradingEngine } = require('./trading-engine');
const { TRADING_CONFIG } = require('./trading-config');

class PaperTrading {
  constructor(opts = {}) {
    this.initialCapital = opts.capital || 10_000;
    this.engine         = new TradingEngine();

    // Override capital
    this.engine.capital        = this.initialCapital;
    this.engine.initialCapital = this.initialCapital;

    this._patchEngine();

    this.paperTrades   = [];
    this.paperPosition = null;
    this.paperCapital  = this.initialCapital;
  }

  // ── Patch the three order execution methods ──────────────────────────────
  _patchEngine() {
    const self = this;
    const eng  = this.engine;

    // ── enterPosition (LONG) ──────────────────────────────────────────────
    eng.enterPosition = async function(price, confidence, corrMultiplier = 1) {
      if (self.paperPosition) return;
      if (this._entering) return;  // respect existing mutex
      this._entering = true;
      try {
      const fraction    = Math.min(0.02, Math.max(0.005, TRADING_CONFIG.positionSize));
      const posSize     = self.paperCapital * fraction;
      const atr         = eng.lastATR || price * 0.001;
      const sl          = price - atr * 1.5;
      const tp          = price + atr * 5.0;
      const commission  = posSize * TRADING_CONFIG.commission;

      self.paperPosition = {
        side: 'LONG', entry: price, shares: posSize / price,
        cost: posSize, sl, tp, atr, confidence,
        entryTime: Date.now(), commission,
      };
      self.paperCapital -= (posSize + commission);
      eng.position = self.paperPosition;   // keep engine state in sync

      const msg = `[PAPER] BUY ${(posSize/price).toFixed(4)} ${eng.selectedAsset} @ ${price.toFixed(5)} | SL=${sl.toFixed(5)} TP=${tp.toFixed(5)} | conf=${confidence}%`;
      eng.log(msg);
      self._notify(msg);
      } finally { this._entering = false; }
    };

    // ── enterShort ────────────────────────────────────────────────────────
    eng.enterShort = async function(price, confidence, corrMultiplier = 1) {
      if (self.paperPosition) return;
      if (this._entering) return;
      this._entering = true;
      try {
      const fraction    = Math.min(0.02, Math.max(0.005, TRADING_CONFIG.positionSize));
      const posSize     = self.paperCapital * fraction;
      const atr         = eng.lastATR || price * 0.001;
      const sl          = price + atr * 1.5;
      const tp          = price - atr * 5.0;
      const commission  = posSize * TRADING_CONFIG.commission;

      self.paperPosition = {
        side: 'SHORT', entry: price, shares: posSize / price,
        cost: posSize, sl, tp, atr, confidence,
        entryTime: Date.now(), commission,
      };
      // BUG-10 fix: deduct full position cost (margin) + commission, matching LONG entry
      self.paperCapital -= (posSize + commission);
      eng.position = self.paperPosition;

      const msg = `[PAPER] SHORT ${(posSize/price).toFixed(4)} ${eng.selectedAsset} @ ${price.toFixed(5)} | SL=${sl.toFixed(5)} TP=${tp.toFixed(5)} | conf=${confidence}%`;
      eng.log(msg);
      self._notify(msg);
      } finally { this._entering = false; }
    };

    // ── exitPosition ──────────────────────────────────────────────────────
    eng.exitPosition = function(price, reason) {
      if (!self.paperPosition) return;
      const pos    = self.paperPosition;
      const isShort = pos.side === 'SHORT';
      const slip    = price * (eng.dynamicSlippage || 0);
      // SHORT buyback pays ask (price + slip); LONG sell receives bid (price - slip)
      const exitPrice = isShort ? price + slip : price - slip;
      const exitVal = pos.shares * exitPrice;
      const comm    = exitVal * TRADING_CONFIG.commission;
      const profit  = isShort
        ? (pos.shares * pos.entry - exitVal) - pos.commission - comm
        : exitVal - (pos.shares * pos.entry) - pos.commission - comm;

      // LONG: receive exitVal - commission. SHORT: profit is already net.
      self.paperCapital += profit;

      const trade = {
        id: self.paperTrades.length + 1,
        asset: eng.selectedAsset, side: pos.side,
        entry: pos.entry, exit: price,
        profit: parseFloat(profit.toFixed(2)),
        profitPct: parseFloat(((profit / pos.cost) * 100).toFixed(2)),
        duration: Date.now() - pos.entryTime,
        reason, timestamp: new Date().toISOString(),
        capital: parseFloat(self.paperCapital.toFixed(2)),
      };
      self.paperTrades.push(trade);
      self.paperPosition = null;
      eng.position = null;

      const pnlStr = profit >= 0 ? `+$${profit.toFixed(2)}` : `-$${Math.abs(profit).toFixed(2)}`;
      const msg = `[PAPER] ${isShort ? 'COVER' : 'SELL'} @ ${price.toFixed(5)} | P/L: ${pnlStr} (${trade.profitPct}%) | ${reason} | capital=$${self.paperCapital.toFixed(2)}`;
      eng.log(msg);
      self._notify(msg);
    };
    // ── Override checkRiskManagement to route SL/TP to paper position ─────
    const _origCheckRisk = eng.checkRiskManagement.bind(eng);
    eng.checkRiskManagement = function() {
      if (!self.paperPosition) return;
      const saved  = eng.position;
      eng.position = self.paperPosition;   // temporarily expose paper position
      _origCheckRisk();
      // If exitPosition was called inside checkRiskManagement, paper position is already null
      if (!eng.position) self.paperPosition = null;
      else eng.position = saved;           // restore
    };
  }   // end activate()

  // ── Notify via Telegram if configured ───────────────────────────────────
  _notify(msg) {
    try {
      const tg = require('./telegram');
      if (tg.isEnabled) tg.send('[PAPER] ' + msg, 'trade');
    } catch (_) {}
  }

  // ── Query paper trading status ──────────────────────────────────────────
  status() {
    const trades = this.engine.trades || [];
    const wins   = trades.filter(t => t.profit > 0).length;
    return {
      paperCapital:  parseFloat((this.paperCapital || this.engine.capital).toFixed(2)),
      openPosition:  this.paperPosition,
      trades:        trades.length,
      wins, losses:  trades.length - wins,
      winRate:       trades.length ? parseFloat((wins / trades.length * 100).toFixed(1)) : 0,
      totalPnL:      parseFloat(trades.reduce((s, t) => s + t.profit, 0).toFixed(2)),
    };
  }

  // ── Start the engine in paper mode ───────────────────────────────────────
  async start() {
    this.engine.log(`[PAPER] Paper trading started — capital $${this.initialCapital.toLocaleString()}`);
    await this.engine.runTradingLoop();
  }

  stop() {
    this.engine.stop();
  }

  // ── Summary stats ─────────────────────────────────────────────────────────
  getStats() {
    const trades = this.paperTrades;
    if (trades.length === 0) return { trades: 0, message: 'No paper trades yet' };
    const wins    = trades.filter(t => t.profit > 0);
    const losses  = trades.filter(t => t.profit <= 0);
    const gross   = wins.reduce((s, t) => s + t.profit, 0);
    const loss    = Math.abs(losses.reduce((s, t) => s + t.profit, 0));
    return {
      trades:       trades.length,
      wins:         wins.length,
      losses:       losses.length,
      winRate:      parseFloat(((wins.length / trades.length) * 100).toFixed(1)),
      profitFactor: loss > 0 ? parseFloat((gross / loss).toFixed(3)) : null,
      totalProfit:  parseFloat((this.paperCapital - this.initialCapital).toFixed(2)),
      currentCapital: parseFloat(this.paperCapital.toFixed(2)),
      returnPct:    parseFloat((((this.paperCapital - this.initialCapital) / this.initialCapital) * 100).toFixed(2)),
    };
  }
}

// ── Run directly ──────────────────────────────────────────────────────────────
if (require.main === module) {
  const capital = parseFloat(process.env.PAPER_CAPITAL || '10000');
  const paper   = new PaperTrading({ capital });
  console.log(`[PAPER] Starting paper trading with $${capital.toLocaleString()} virtual capital`);
  paper.start().catch(console.error);

  // Print stats every 5 minutes
  setInterval(() => {
    const stats = paper.getStats();
    console.log('[PAPER STATS]', JSON.stringify(stats));
  }, 5 * 60_000);
}

module.exports = { PaperTrading };
