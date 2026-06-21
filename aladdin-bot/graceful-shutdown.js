'use strict';
// ── Graceful Shutdown Handler ─────────────────────────────────────────────────
// Catches SIGTERM / SIGINT / uncaughtException and:
//   1. Saves position state to disk
//   2. Optionally closes open position at market (configurable)
//   3. Flushes audit log
//   4. Exits with correct code
//
// Without this, a kill-9 during enterPosition can leave the broker with an open
// trade that the bot doesn't know about on restart — causing doubled exposure.

const fs   = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, 'trade_logs');

class GracefulShutdown {
  constructor({ log = console.log, send = null } = {}) {
    this.log       = log;
    this.send      = send;
    this._engine   = null;
    this._hooked   = false;
    this._exiting  = false;
    this._flattenOnExit = process.env.FLATTEN_ON_EXIT === 'true';
  }

  /** Attach to a TradingEngine instance */
  attach(engine) {
    this._engine = engine;
    if (!this._hooked) {
      this._hooked = true;
      process.on('SIGTERM', () => this._shutdown('SIGTERM', 0));
      process.on('SIGINT',  () => this._shutdown('SIGINT',  0));
      process.on('uncaughtException', (err) => {
        this.log(`💥 [Shutdown] uncaughtException: ${err.message}\n${err.stack}`);
        this._shutdown('uncaughtException', 1);
      });
      process.on('unhandledRejection', (reason) => {
        this.log(`💥 [Shutdown] unhandledRejection: ${reason}`);
        this._shutdown('unhandledRejection', 1);
      });
      this.log('🛡️ [Shutdown] Graceful shutdown handler armed');
    }
  }

  async _shutdown(signal, exitCode) {
    if (this._exiting) return;   // prevent double-fire
    this._exiting = true;

    this.log(`\n🛑 [Shutdown] Signal: ${signal} — starting graceful shutdown`);
    const msg = `🛑 Bot shutting down (${signal})${this._engine?.position ? ' — POSITION OPEN' : ''}`;
    try { this.send?.(msg, 'halt'); } catch (_) {}

    const e = this._engine;

    // 1. Stop the trading loop
    try {
      if (e?.isRunning) {
        e.isRunning = false;
        this.log('[Shutdown] Trading loop stopped');
      }
    } catch (_) {}

    // 2. Save position + trades state
    try {
      if (e?.savePositionFile) {
        e.savePositionFile();
        this.log('[Shutdown] Position state saved');
      }
    } catch (err) {
      this.log(`[Shutdown] Position save failed: ${err.message}`);
    }
    // FIX 14: Also flush trades file — trade records could be lost mid-exit otherwise
    try {
      if (e?.saveTradesFile) {
        e.saveTradesFile();
        this.log('[Shutdown] Trades file flushed');
      }
    } catch (err) {
      this.log(`[Shutdown] Trades flush failed: ${err.message}`);
    }

    // 3. Save risk state
    try {
      if (e?.capital !== undefined) {
        const riskState = {
          capital:              e.capital,
          consecutiveLosses:    e.consecutiveLosses || 0,
          consecutiveHaltUntil: e.consecutiveHaltUntil || 0,
          drawdownHaltUntil:    e.drawdownHaltUntil || 0,
          shutdownAt:           new Date().toISOString(),
          signal,
          hadPosition:          !!e.position,
        };
        fs.mkdirSync(LOGS_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(LOGS_DIR, 'risk-state.json'),
          JSON.stringify(riskState, null, 2)
        );
        this.log('[Shutdown] Risk state saved');
      }
    } catch (err) {
      this.log(`[Shutdown] Risk state save failed: ${err.message}`);
    }

    // 4. Optionally flatten open position
    if (this._flattenOnExit && e?.position && e?.exitPosition) {
      try {
        this.log('[Shutdown] FLATTEN_ON_EXIT=true — closing open position at market');
        const price = e.priceHistory?.at(-1);
        if (price && price > 0) {
          await Promise.race([
            e.exitPosition(price, `graceful_shutdown_${signal}`),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
          ]);
          this.log('[Shutdown] Position closed successfully');
          try { this.send?.('✅ Position flattened on shutdown', 'trade'); } catch (_) {}
        }
      } catch (err) {
        this.log(`[Shutdown] Flatten failed: ${err.message} — position may still be open on broker`);
        try { this.send?.(`⚠️ Flatten failed on shutdown: ${err.message}`, 'halt'); } catch (_) {}
      }
    } else if (e?.position) {
      this.log('[Shutdown] Position still open — set FLATTEN_ON_EXIT=true to auto-close');
      try {
        this.send?.(
          `⚠️ Bot exited with open ${e.position.side || 'LONG'} position on ${e.selectedAsset} — check broker!`,
          'halt'
        );
      } catch (_) {}
    }

    // 5. Flush weekly report scheduler
    try { e?.weeklyReport?.stop?.(); } catch (_) {}

    // 6. Write shutdown entry to audit log
    try {
      const shutdownEntry = JSON.stringify({
        type: 'SHUTDOWN', signal, exitCode,
        hasPosition: !!e?.position,
        capital: e?.capital,
        ts: Date.now(),
      }) + '\n';
      fs.appendFileSync(path.join(LOGS_DIR, 'audit.jsonl'), shutdownEntry);
    } catch (_) {}

    this.log(`[Shutdown] Complete. Exiting with code ${exitCode}.`);

    // Small delay to flush stdout/file buffers
    await new Promise(r => setTimeout(r, 300));
    process.exit(exitCode);
  }

  /** Manually trigger shutdown (e.g. from CLI) */
  async trigger(signal = 'MANUAL') {
    await this._shutdown(signal, 0);
  }
}

module.exports = { GracefulShutdown };
