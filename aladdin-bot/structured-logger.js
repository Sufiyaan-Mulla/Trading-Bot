'use strict';
// ── structured-logger.js — A11: JSON-structured logging for Grafana/Datadog
// Usage: const logger = require('./structured-logger');
//        logger.info('trade', { asset: 'EURUSD', price: 1.08, conf: 72 });
// Outputs: {"ts":"2026-05-16T...","level":"info","tag":"trade","asset":"EURUSD",...}

const STRUCTURED = process.env.STRUCTURED_LOGS === 'true';

// Bug fix: JSON.stringify throws on circular references (e.g. when an engine
// object is accidentally included in log data). A logger must NEVER throw —
// it is called inside catch blocks and risk handlers where a secondary crash
// would completely mask the original error.
function _safeStringify(obj) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(obj, (key, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      if (typeof val === 'bigint') return val.toString();
      if (typeof val === 'function') return '[Function]';
      return val;
    });
  } catch (_) {
    return JSON.stringify({ _serializeError: true });
  }
}

function _emit(level, tag, data) {
  try {
    if (STRUCTURED) {
      process.stdout.write(_safeStringify({ ts: new Date().toISOString(), level, tag, ...data }) + '\n');
    } else {
      const pairs = Object.entries(data).map(([k, v]) => {
        try { return `${k}=${JSON.stringify(v)}`; } catch (_) { return `${k}=[Circular]`; }
      }).join(' ');
      console.log(`[${level.toUpperCase()}] [${tag}] ${pairs}`);
    }
  } catch (_) {
    // Last-resort: never let the logger itself crash the process
    try { process.stderr.write(`[${level}] [${tag}] (log serialization failed)\n`); } catch (__) {}
  }
}

module.exports = {
  info:  (tag, data = {}) => _emit('info',  tag, data),
  warn:  (tag, data = {}) => _emit('warn',  tag, data),
  error: (tag, data = {}) => _emit('error', tag, data),
  trade: (data = {}) => _emit('info', 'trade', data),
  risk:  (data = {}) => _emit('warn', 'risk',  data),
  ml:    (data = {}) => _emit('info', 'ml',    data),
};
