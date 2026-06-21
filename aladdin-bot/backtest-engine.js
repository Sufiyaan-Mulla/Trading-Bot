'use strict';
// ── backtest-engine.js ────────────────────────────────────────────────────────
// runBacktest() mixin for TradingEngine.
// Wired via Object.assign(TradingEngine.prototype, require('./backtest-engine')).
//
// When the dashboard sends { cmd:'backtest' } over WebSocket the engine calls
// this method.  It:
//   1. Saves live capital/trades/position so they can be restored later.
//   2. Runs a full bar-by-bar simulation using SharedSignalAdapter (same signal
//      code as live trading — no divergence possible).
//   3. Updates engine state (this.capital, this.trades, this.position,
//      this.backtestMode) so the dashboard's normal 2-second push shows
//      live progress with no extra plumbing.
//   4. Saves a JSON report to trade_logs/backtest-dashboard.json.
//   5. After 30 s restores live state and clears backtestMode.
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const { SharedSignalAdapter }   = require('./shared-signal-adapter');
const { learnFromBacktest }     = require('./strategy-learner');

// ── Candle generator (mirrors backtest-full.js) ──────────────────────────────
function _syntheticCandles(n, asset) {
  let price = asset === 'USDJPY' ? 150.0
            : asset.startsWith('GBP') ? 1.25
            : asset.startsWith('AUD') ? 0.655
            : 1.1050;
  let s = 42;
  const rng = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 - 0.5; };
  const candles = [];
  for (let i = 0; i < n; i++) {
    price = Math.max(0.0001, price * (1 + 0.00001 + rng() * 0.0006));
    candles.push({
      time:   Date.now() - (n - i) * 300_000,
      open:   price,
      high:   price * (1 + Math.abs(rng()) * 0.0003),
      low:    price * (1 - Math.abs(rng()) * 0.0003),
      close:  price,
      volume: 800 + Math.abs(rng()) * 500,
    });
  }
  return candles;
}

module.exports = {

  async runBacktest(opts = {}) {
    if (this._btRunning) {
      this.log('[Backtest] Already running — ignoring duplicate request');
      return;
    }
    this._btRunning   = true;
    this.backtestMode = true;

    // ── Save live state ─────────────────────────────────────────────────────
    const _saved = {
      capital:  this.capital,
      trades:   this.trades.slice(),
      position: this.position,
    };

    const asset = this.selectedAsset || 'EURUSD';
    const BARS  = opts.bars || 1500;

    this.log('[Backtest] Starting ' + asset + ' | ' + BARS + ' bars…');

    // ── Build candles ───────────────────────────────────────────────────────
    // Prefer the engine's own warm price history; fall back to synthetic.
    let candles;
    if (this.priceHistory && this.priceHistory.length >= 100) {
      const ph = this.priceHistory;
      candles = ph.map((p, i) => ({
        time:   Date.now() - (ph.length - i) * 300_000,
        open:   p, high: p * 1.0003, low: p * 0.9997, close: p, volume: 1000,
      }));
    } else {
      candles = _syntheticCandles(BARS, asset);
    }

    // ── Backtest parameters ─────────────────────────────────────────────────
    const initialCap  = this.initialCapital || 10_000;
    const slippage    = opts.slippage    || 0.0005;
    const commission  = opts.commission  || 0.0001;   // per-trade fraction of position
    const stopLoss    = opts.stopLoss    || 0.02;
    const takeProfit  = opts.takeProfit  || 0.05;
    const minConf     = opts.minConfidence || 60;
    const sizeFrac    = opts.sizeFraction  || 0.02;   // fraction of equity per trade

    const adapter = new SharedSignalAdapter('trend');
    const closes  = candles.map(c => c.close);

    let equity   = initialCap;
    let position = null;   // { entry, side, shares, bar, confidence }
    const trades = [];

    // ── Reset engine display state ──────────────────────────────────────────
    this.capital  = initialCap;
    this.trades   = [];
    this.position = null;

    try {
      for (let i = 50; i < candles.length; i++) {
        const history  = closes.slice(0, i + 1);
        const ohlcv    = candles[i];
        const price    = ohlcv.close;
        const context  = { hasPosition: !!position, capital: equity, selectedAsset: asset };
        const decision = adapter.decide(history, ohlcv, context);

        // ── Exit ─────────────────────────────────────────────────────────────
        if (position) {
          const rawPnlPct = position.side === 'BUY'
            ? (price - position.entry) / position.entry
            : (position.entry - price) / position.entry;

          const shouldExit = decision.action === 'SELL'
            || rawPnlPct <= -stopLoss
            || rawPnlPct >=  takeProfit;

          if (shouldExit) {
            const exitPrice  = position.side === 'BUY'
              ? price * (1 - slippage)
              : price * (1 + slippage);
            const exitPnlPct = position.side === 'BUY'
              ? (exitPrice - position.entry) / position.entry
              : (position.entry - exitPrice) / position.entry;
            const profit = position.shares * position.entry * exitPnlPct
                         - commission * position.shares * position.entry;
            equity += profit;

            trades.push({
              asset,
              entry:         parseFloat(position.entry.toFixed(5)),
              exit:          parseFloat(exitPrice.toFixed(5)),
              profit:        parseFloat(profit.toFixed(2)),
              profitPercent: parseFloat((exitPnlPct * 100).toFixed(3)),
              confidence:    position.confidence,
              regime:        'BACKTEST',
              reason:        decision.action === 'SELL' ? 'signal'
                           : rawPnlPct <= -stopLoss     ? 'stop_loss'
                           : 'take_profit',
              duration:      (i - position.bar) * 300_000,
            });
            position         = null;
            this.capital     = equity;
            this.trades      = trades.slice();
            this.position    = null;
          }
        }

        // ── Entry ─────────────────────────────────────────────────────────────
        if (!position
            && (decision.action === 'BUY' || decision.action === 'SELL')
            && (decision.confidence || 0) >= minConf) {
          const side       = decision.action;
          const entryPrice = side === 'BUY'
            ? price * (1 + slippage)
            : price * (1 - slippage);
          const posSize    = equity * sizeFrac;
          const shares     = posSize / entryPrice;

          position = { entry: entryPrice, side, shares, bar: i, confidence: decision.confidence || 0 };

          // Mirror the live position shape so the dashboard renders it properly
          this.position = {
            entry:       entryPrice,
            side,
            shares,
            stopLoss:    side === 'BUY'
              ? entryPrice * (1 - stopLoss)
              : entryPrice * (1 + stopLoss),
            takeProfit:  side === 'BUY'
              ? entryPrice * (1 + takeProfit)
              : entryPrice * (1 - takeProfit),
            confidence:  decision.confidence || 0,
            regime:      'BACKTEST',
            fillSummary: 'BT @ ' + entryPrice.toFixed(5),
          };
          this.capital = equity;
        }

        // Yield every 100 bars so WS push timers can fire between chunks
        if (i % 100 === 0) {
          this.capital = equity;
          await new Promise(r => setImmediate(r));
        }
      }

      // ── Close any trade still open at end of data ─────────────────────────
      if (position) {
        const lastPrice  = closes[closes.length - 1];
        const pnlPct     = position.side === 'BUY'
          ? (lastPrice - position.entry) / position.entry
          : (position.entry - lastPrice) / position.entry;
        const profit     = position.shares * position.entry * pnlPct
                         - commission * position.shares * position.entry;
        equity += profit;
        trades.push({
          asset,
          entry:         parseFloat(position.entry.toFixed(5)),
          exit:          parseFloat(lastPrice.toFixed(5)),
          profit:        parseFloat(profit.toFixed(2)),
          profitPercent: parseFloat((pnlPct * 100).toFixed(3)),
          confidence:    position.confidence,
          regime:        'BACKTEST',
          reason:        'end_of_data',
          duration:      0,
        });
      }

      // ── Final state ───────────────────────────────────────────────────────
      this.capital  = equity;
      this.trades   = trades;
      this.position = null;

      const wins     = trades.filter(t => t.profit > 0).length;
      const totalPnl = trades.reduce((s, t) => s + t.profit, 0);
      const ret      = (equity - initialCap) / initialCap * 100;
      const wr       = trades.length ? (wins / trades.length * 100).toFixed(1) : '0';

      this.log(
        '[Backtest] Done — ' + trades.length + ' trades | ' +
        wr + '% win rate | ' + ret.toFixed(2) + '% return | $' + totalPnl.toFixed(2)
      );

      // ── Save report ───────────────────────────────────────────────────────
      const btTs  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const btId  = 'bt-' + btTs;
      const report = {
        backtestId:  btId,
        asset,
        bars:        candles.length,
        finalEquity: parseFloat(equity.toFixed(2)),
        totalReturn: parseFloat(ret.toFixed(2)),
        tradeCount:  trades.length,
        winRate:     trades.length ? parseFloat(wr) : 0,
        totalPnl:    parseFloat(totalPnl.toFixed(2)),
        trades,
        generatedAt: new Date().toISOString(),
      };

      try {
        const dir = path.join(__dirname, 'trade_logs');
        fs.mkdirSync(dir, { recursive: true });

        // Always-overwritten dashboard file (used by UI)
        fs.writeFileSync(path.join(dir, 'backtest-dashboard.json'), JSON.stringify(report, null, 2));

        // Timestamped archive — never overwritten, one file per run
        fs.writeFileSync(path.join(dir, btId + '.json'), JSON.stringify(report, null, 2));

        // Prune archive: keep the 30 most recent bt-*.json files
        const btFiles = fs.readdirSync(dir)
          .filter(f => f.startsWith('bt-') && f.endsWith('.json'))
          .sort().reverse();
        for (const f of btFiles.slice(30)) {
          try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
        }
      } catch (_) {}

      // ── ML learning: analyse trades and generate new strategy config ──────
      try {
        const learned = learnFromBacktest(trades, {
          totalReturn: parseFloat(ret.toFixed(2)),
          backtestId:  btId,
        });
        this._lastLearnedConfig = learned;
        // Reload learned weights into the strategy manager on the next decide() call
        if (this.strategyManager) this.strategyManager._learnedConfig = undefined;
        this.log('[Learner] New strategy config — ' + (learned.recommendation || '').slice(0, 100));
        if (typeof this.emit === 'function') this.emit('learning-complete', learned);
      } catch (lErr) {
        this.log('[Learner] Learning failed: ' + lErr.message);
      }

    } catch (err) {
      this.log('[Backtest] Error: ' + err.message);
    } finally {
      // Show results for 30 s, then restore live state
      setTimeout(() => {
        this.capital      = _saved.capital;
        this.trades       = _saved.trades;
        this.position     = _saved.position;
        this.backtestMode = false;
        this._btRunning   = false;
        this.log('[Backtest] Results cleared — live state restored');
      }, 30_000);
    }
  },

};
