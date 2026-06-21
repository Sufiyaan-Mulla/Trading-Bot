'use strict';
// async-order-queue.js — Async Order Queue
// Prevents race conditions when multiple signals arrive in the same bar.
// Only one order is processed at a time; duplicates are discarded.

class AsyncOrderQueue {
  constructor() {
    this._queue    = [];
    this._running  = false;
    this._maxDepth = 5;
  }

  // Enqueue an order function (returns a promise)
  enqueue(orderFn, key) {
    // Discard if queue full or same key already queued
    if (this._queue.length >= this._maxDepth) return Promise.resolve(null);
    if (key && this._queue.some(q=>q.key===key)) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      this._queue.push({ orderFn, key, resolve, reject });
      this._drain();
    });
  }

  async _drain() {
    if (this._running || !this._queue.length) return;
    this._running = true;
    const { orderFn, resolve, reject } = this._queue.shift();
    try {
      const result = await orderFn();
      resolve(result);
    } catch(e) {
      reject(e);
    } finally {
      this._running = false;
      if (this._queue.length) setImmediate(() => this._drain());
    }
  }

  get depth()     { return this._queue.length; }
  get isIdle()    { return !this._running && this._queue.length === 0; }
  get isBusy()    { return this._running; }

  clear() { this._queue.length = 0; }
}

module.exports = { AsyncOrderQueue };
