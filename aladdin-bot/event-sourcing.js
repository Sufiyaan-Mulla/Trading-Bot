'use strict';
const fs   = require('fs');
const path = require('path');
// event-sourcing.js — Append-only Decision Event Journal
// Every major bot decision is appended to an immutable event log.
// This enables:
//  • Full audit trail (regulator/compliance)
//  • Replay of any time period to reproduce bot behaviour
//  • Root-cause analysis of unusual trades
// Events are newline-delimited JSON (NDJSON), one event per line.

const LOG_DIR = path.join(__dirname, 'trade_logs');
const LOG_FILE = path.join(LOG_DIR, 'decisions.ndjson');

let _seqId = 0;

function appendEvent(type, payload) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, {recursive:true});
    const event = {
      id:      ++_seqId,
      ts:      new Date().toISOString(),
      type,    // e.g. SIGNAL_GENERATED, TRADE_ENTERED, TRADE_EXITED, HALT_TRIGGERED
      ...payload,
    };
    fs.appendFileSync(LOG_FILE, JSON.stringify(event) + '\n', 'utf8');
    return event;
  } catch(_) { return null; }
}

// Replay all events from file (for analysis/debugging)
function replayEvents(filterFn) {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const lines  = fs.readFileSync(LOG_FILE,'utf8').trim().split('\n').filter(Boolean);
    const events = lines.map(l=>{ try{return JSON.parse(l);}catch{return null;} }).filter(Boolean);
    return filterFn ? events.filter(filterFn) : events;
  } catch(_) { return []; }
}

// Rotate log when >100MB
function rotateIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > 100 * 1024 * 1024) {
      const stamp = new Date().toISOString().replace(/:/g,'-').slice(0,16);
      fs.renameSync(LOG_FILE, LOG_FILE.replace('.ndjson', `-${stamp}.ndjson`));
    }
  } catch(_) {}
}

// Log key events from execution pipeline
const EVENTS = {
  SIGNAL:       (asset, action, conf, regime) => appendEvent('SIGNAL_GENERATED', {asset,action,conf,regime}),
  ENTRY:        (asset, price, side, size)    => appendEvent('TRADE_ENTERED',    {asset,price,side,size}),
  EXIT:         (asset, price, pnl, reason)   => appendEvent('TRADE_EXITED',     {asset,price,pnl,reason}),
  HALT:         (reason, capital)             => appendEvent('HALT_TRIGGERED',   {reason,capital}),
  REGIME_CHANGE:(from, to)                    => appendEvent('REGIME_CHANGE',    {from,to}),
  ML_RETRAIN:   (samples, score)              => appendEvent('ML_RETRAINED',     {samples,score}),
  CONFIG_CHANGE:(key, from, to)               => appendEvent('CONFIG_CHANGED',   {key,from,to}),
};

module.exports = { appendEvent, replayEvents, rotateIfNeeded, EVENTS };
