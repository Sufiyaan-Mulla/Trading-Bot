'use strict';
// ── audit-tagger.js ───────────────────────────────────────────────────────────
// Wraps audit-log.js to enforce consistent strategy+symbol+timeframe tags.
//
// Fixes: Logging partial — "Tag logs with strategy, symbol, and timeframe."
//
// Every record() call goes through tag enforcement:
//   - strategy:  required — defaults to 'unknown' with a warning if absent
//   - symbol:    required — defaults to 'NONE' with a warning if absent
//   - timeframe: required — defaults to 'M5' with a warning if absent
//
// Usage:
//   const tagger = require('./audit-tagger');
//   tagger.record({ type: 'DECISION', action: 'BUY', strategy: 'trend',
//                   symbol: 'EURUSD', timeframe: 'M5', confidence: 78 });
// ─────────────────────────────────────────────────────────────────────────────

const baseAuditLog = require('./audit-log');

const REQUIRED_TAGS = ['strategy', 'symbol', 'timeframe'];
let _warnCount = 0;
const MAX_WARNS = 20;   // cap console noise

function record(entry) {
  const tagged = { ...entry };
  let warned = false;
  for (const tag of REQUIRED_TAGS) {
    if (!tagged[tag]) {
      if (_warnCount < MAX_WARNS) {
        console.warn(`[AuditTagger] Missing "${tag}" tag in record type="${entry.type || 'unknown'}"`);
        _warnCount++;
        warned = true;
      }
      // Apply defaults so logs remain queryable even when tag is absent
      if (tag === 'strategy')  tagged[tag] = tagged[tag] || 'unknown';
      if (tag === 'symbol')    tagged[tag] = tagged[tag] || 'NONE';
      if (tag === 'timeframe') tagged[tag] = tagged[tag] || 'M5';
    }
  }
  if (warned) tagged._missingTags = REQUIRED_TAGS.filter(t => !entry[t]);
  return baseAuditLog.record(tagged);
}

function flushSync(entry) {
  const tagged = { ...entry };
  for (const tag of REQUIRED_TAGS) {
    if (!tagged[tag]) {
      if (tag === 'strategy')  tagged[tag] = 'unknown';
      if (tag === 'symbol')    tagged[tag] = 'NONE';
      if (tag === 'timeframe') tagged[tag] = 'M5';
    }
  }
  return baseAuditLog.flushSync(tagged);
}

const { tail } = baseAuditLog;
module.exports = { record, flushSync, tail };
