'use strict';
// error-codes.js — Item 57: Structured Error Codes for Programmatic Alerting
// Every runtime error has a code, severity, and description.

const ERROR_CODES = {
  // Exchange errors (E1xxx)
  E1001: { severity:'CRITICAL', category:'EXCHANGE',  msg:'OANDA API authentication failed' },
  E1002: { severity:'ERROR',    category:'EXCHANGE',  msg:'Order placement rejected by broker' },
  E1003: { severity:'WARNING',  category:'EXCHANGE',  msg:'Partial fill received' },
  E1004: { severity:'CRITICAL', category:'EXCHANGE',  msg:'Position mismatch: local vs broker' },
  E1005: { severity:'ERROR',    category:'EXCHANGE',  msg:'WebSocket connection lost' },
  // Risk errors (E2xxx)
  E2001: { severity:'CRITICAL', category:'RISK',      msg:'Global drawdown limit breached' },
  E2002: { severity:'ERROR',    category:'RISK',      msg:'Intraday drawdown limit breached' },
  E2003: { severity:'WARNING',  category:'RISK',      msg:'Margin utilisation above threshold' },
  E2004: { severity:'CRITICAL', category:'RISK',      msg:'Margin call simulation triggered' },
  E2005: { severity:'ERROR',    category:'RISK',      msg:'Max instrument loss per day reached' },
  // ML errors (E3xxx)
  E3001: { severity:'WARNING',  category:'ML',        msg:'Model not trained — using fallback' },
  E3002: { severity:'ERROR',    category:'ML',        msg:'Feature extraction failed' },
  E3003: { severity:'WARNING',  category:'ML',        msg:'Prediction uncertainty too high' },
  E3004: { severity:'INFO',     category:'ML',        msg:'Monthly retraining triggered' },
  E3005: { severity:'WARNING',  category:'ML',        msg:'Model drift detected — auto-rollback' },
  // Data errors (E4xxx)
  E4001: { severity:'ERROR',    category:'DATA',      msg:'Price feed stale beyond threshold' },
  E4002: { severity:'WARNING',  category:'DATA',      msg:'Timestamp misalignment detected' },
  E4003: { severity:'ERROR',    category:'DATA',      msg:'Primary data vendor failed — fallback' },
  E4004: { severity:'CRITICAL', category:'DATA',      msg:'All data vendors failed' },
  // System errors (E5xxx)
  E5001: { severity:'CRITICAL', category:'SYSTEM',    msg:'Circuit breaker open: exchange' },
  E5002: { severity:'ERROR',    category:'SYSTEM',    msg:'Circuit breaker open: ML subsystem' },
  E5003: { severity:'WARNING',  category:'SYSTEM',    msg:'Event loop lag detected' },
  E5004: { severity:'ERROR',    category:'SYSTEM',    msg:'Memory usage critical' },
  E5005: { severity:'CRITICAL', category:'SYSTEM',    msg:'Health check failed 3× consecutively' },
};

class StructuredError extends Error {
  constructor(code, context = {}) {
    const def = ERROR_CODES[code] || { severity:'UNKNOWN', category:'UNKNOWN', msg:'Unknown error' };
    super(`[${code}] ${def.msg}${context.detail ? ': ' + context.detail : ''}`);
    this.code     = code;
    this.severity = def.severity;
    this.category = def.category;
    this.context  = context;
    this.ts       = new Date().toISOString();
  }

  toJSON() {
    return { code:this.code, severity:this.severity, category:this.category,
             message:this.message, context:this.context, ts:this.ts };
  }
}

function throwError(code, context) { throw new StructuredError(code, context); }
function logError(code, context, log = console.error) {
  const e = new StructuredError(code, context);
  log(e.message);
  return e;
}

module.exports = { ERROR_CODES, StructuredError, throwError, logError };
