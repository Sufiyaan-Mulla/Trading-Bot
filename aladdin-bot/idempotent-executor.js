'use strict';
// ── idempotent-executor.js ────────────────────────────────────────────────────
// Prevents duplicate orders and reconciles local vs exchange state on reconnect.
//
// Problems solved:
//   1. DUPLICATE ORDERS — network retry after timeout fires the same order twice.
//      Solution: every order gets a deterministic idempotency key derived from
//      (asset, side, timestamp-bucket). If the same key is submitted within
//      DEDUP_WINDOW_MS the second call is a no-op and returns the first result.
//
//   2. STATE DRIFT — after a reconnect the local position file may be stale.
//      Solution: reconcile() reads the exchange's open orders/positions and
//      patches local state (this.position, this.trades) to match reality.
//
// Usage (mix into TradingEngine):
//   const { IdempotentExecutor } = require('./idempotent-executor');
//   this._idem = new IdempotentExecutor(this);
//   // Before placing any order:
//   const result = await this._idem.submit(orderSpec, executeFn);
//   // On reconnect:
//   await this._idem.reconcile(fetchExchangeStateFn);
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const DEDUP_WINDOW_MS = 30_000;   // 30 s — orders with same key within this window are deduped
const STORE_FILE      = path.join(__dirname, 'trade_logs', 'idem_store.json');

class IdempotentExecutor {
  constructor(engine) {
    this._engine  = engine;
    this._pending  = new Map();   // key → { result, ts }   (completed)
    this._inFlight = new Map();   // key → Promise           (in-progress, race guard)
    this._log     = (m) => console.log('[IdempotentExec] ' + m);
    this._loadStore();
  }

  // ── Submit an order idempotently ──────────────────────────────────────────
  // orderSpec: { asset, side, size, price? }
  // executeFn: async () → orderResult  (the real order placement call)
  // Returns the order result (either fresh or cached from a recent duplicate).
  async submit(orderSpec, executeFn) {
    const key = this._makeKey(orderSpec);
    const now = Date.now();

    // Check persistent cache (completed orders)
    const cached = this._pending.get(key);
    if (cached && (now - cached.ts) < DEDUP_WINDOW_MS) {
      this._log(`DEDUP hit for key ${key} — returning cached result`);
      return { ...cached.result, deduplicated: true };
    }

    // Bug fix: race condition — without in-flight tracking, two concurrent calls
    // with the same key both pass the cache check above (cache not yet written)
    // and both execute the real order, causing duplicate trades.
    // Fix: store a Promise immediately so any concurrent call awaits the same one.
    if (this._inFlight.has(key)) {
      this._log(`IN-FLIGHT dedup for key ${key} — awaiting existing promise`);
      const result = await this._inFlight.get(key);
      return { ...result, deduplicated: true };
    }

    // Execute the real order
    this._log(`Submitting order: ${orderSpec.side} ${orderSpec.asset} size=${orderSpec.size}`);
    const promise = executeFn();
    this._inFlight.set(key, promise);

    let result;
    try {
      result = await promise;
    } catch (err) {
      this._inFlight.delete(key);
      this._log(`Order failed: ${err.message}`);
      throw err;
    }

    this._inFlight.delete(key);
    // Cache the completed result
    this._pending.set(key, { result, ts: now, spec: orderSpec });
    this._saveStore();
    this._prune();

    return result;
  }

  // ── Reconcile local state with exchange after reconnect ───────────────────
  // fetchFn: async () → { openPositions: [...], recentOrders: [...] }
  //   openPositions: [{ asset, side, size, entryPrice, openedAt }]
  //   recentOrders:  [{ orderId, status, asset, side, size, filledAt, fillPrice }]
  //
  // Actions taken:
  //   - Position in exchange but not locally → restore position
  //   - Position locally but not in exchange → mark as closed (exchange closed it)
  //   - Position differs in size → patch local size
  async reconcile(fetchFn) {
    this._log('Reconciling local state with exchange...');
    let exchangeState;
    try {
      exchangeState = await fetchFn();
    } catch (err) {
      this._log('Could not fetch exchange state: ' + err.message);
      return { reconciled: false, error: err.message };
    }

    const { openPositions = [], recentOrders = [] } = exchangeState;
    const engine = this._engine;
    const diffs  = [];

    // ── Position reconciliation ────────────────────────────────────────────
    const localPos = engine.position;
    const exchPos  = openPositions.find(p => p.asset === (localPos?.asset || engine.selectedAsset));

    if (!localPos && exchPos) {
      // Exchange has a position we don't know about — restore it
      engine.position = {
        asset:       exchPos.asset,
        side:        exchPos.side,
        size:        exchPos.size,
        entry:       exchPos.entryPrice,
        openedAt:    exchPos.openedAt || Date.now(),
        _reconciled: true,
      };
      diffs.push({ type: 'RESTORED_POSITION', detail: exchPos });
      this._log(`Restored position: ${exchPos.side} ${exchPos.asset} @ ${exchPos.entryPrice}`);

    } else if (localPos && !exchPos) {
      // We think we have a position but exchange doesn't — it was closed externally
      const closedAt    = Date.now();
      const closedPrice = localPos.entry;   // fallback price if we can't determine fill
      const closedOrder = recentOrders.find(o => o.asset === localPos.asset && o.status === 'filled');
      const fillPrice   = closedOrder?.fillPrice || closedPrice;

      diffs.push({ type: 'POSITION_CLOSED_EXTERNALLY', localPos, fillPrice });
      this._log(`Position ${localPos.side} ${localPos.asset} was closed externally @ ${fillPrice}`);
      // Record as a trade
      if (engine.trades) {
        const profit = localPos.side === 'LONG'
          ? (fillPrice - localPos.entry) * (localPos.size || 1)
          : (localPos.entry - fillPrice) * (localPos.size || 1);
        engine.trades.push({
          asset: localPos.asset, side: localPos.side,
          entry: localPos.entry, exit: fillPrice,
          profit, closedAt, source: 'reconcile',
        });
      }
      engine.position = null;

    } else if (localPos && exchPos && Math.abs(localPos.size - exchPos.size) > 0.0001) {
      // Size mismatch — patch local
      diffs.push({ type: 'SIZE_PATCHED', localSize: localPos.size, exchSize: exchPos.size });
      this._log(`Size patched: local=${localPos.size} → exchange=${exchPos.size}`);
      engine.position.size = exchPos.size;
    }

    this._log(`Reconciliation complete. Diffs: ${diffs.length}`);
    return { reconciled: true, diffs };
  }

  // ── Generate a deterministic idempotency key ───────────────────────────────
  // Key includes asset, side, and a 30-second time bucket.
  // Two submissions of the same order within 30 s produce the same key.
  _makeKey(spec) {
    const bucket = Math.floor(Date.now() / DEDUP_WINDOW_MS);
    const raw    = `${spec.asset}|${spec.side}|${spec.size}|${bucket}`;
    return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
  }

  // ── Remove entries older than DEDUP_WINDOW_MS ─────────────────────────────
  _prune() {
    const cutoff = Date.now() - DEDUP_WINDOW_MS * 2;
    for (const [key, entry] of this._pending.entries()) {
      if (entry.ts < cutoff) this._pending.delete(key);
    }
  }

  // ── Persist/load the dedup store across restarts ──────────────────────────
  _saveStore() {
    try {
      const dir = path.dirname(STORE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const obj = {};
      for (const [k, v] of this._pending.entries()) obj[k] = v;
      fs.writeFileSync(STORE_FILE, JSON.stringify(obj));
    } catch (_) {}
  }

  _loadStore() {
    try {
      if (!fs.existsSync(STORE_FILE)) return;
      const obj  = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      const cutoff = Date.now() - DEDUP_WINDOW_MS * 2;
      for (const [k, v] of Object.entries(obj)) {
        if (v.ts > cutoff) this._pending.set(k, v);
      }
      this._log(`Loaded ${this._pending.size} unexpired dedup entries from disk`);
      this._prune();   // #65: prune immediately after load to bound startup memory
    } catch (_) {}
  }

  // Expose dedup window for tests
  static get DEDUP_WINDOW_MS() { return DEDUP_WINDOW_MS; }
}

// Item 74: Clear idempotency keys older than 24 hours on session start
IdempotentExecutor.prototype.cleanupStaleKeys = function() {
  const now   = Date.now();
  const maxAge = 24 * 3_600_000;
  let cleared = 0;
  for (const [key, ts] of Object.entries(this._store||{})) {
    if (now - ts > maxAge) { delete this._store[key]; cleared++; }
  }
  if (cleared > 0) console.log(`[IdempotentExec #74] Cleared ${cleared} stale keys`);
  // Persist cleaned store
  try {
    const fs=require('fs'),path=require('path');
    fs.writeFileSync(path.join(__dirname,'trade_logs','idem_store.json'),JSON.stringify(this._store,null,2));
  } catch(_) {}
  return cleared;
};

// Duplicate signal check within 60 seconds
IdempotentExecutor.prototype.isDuplicateSignal = function(signalKey, windowMs=60_000) {
  const now = Date.now();
  const key = `sig:${signalKey}`;
  if (this._store?.[key] && now - this._store[key] < windowMs) return true;
  if (!this._store) this._store = {};
  this._store[key] = now;
  return false;
};

module.exports = { IdempotentExecutor };
