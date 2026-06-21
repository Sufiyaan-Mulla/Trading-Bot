'use strict';
// ── telegram.js ───────────────────────────────────────────────────────────────
// Rate-limited Telegram notifications for the Aladdin trading engine.
//
// Problem solved (#13):
//   Without rate limiting, a volatile session can fire hundreds of alerts
//   per minute — Telegram's bot API throttles at 30 messages/second and
//   Telegram will ban the bot token for flood abuse.
//
// Solution:
//   - Hard cap: max MAX_PER_MINUTE messages per 60-second window
//   - Cooldown per category: same alert type won't repeat within COOLDOWN_MS
//   - Queue: excess messages are dropped (not queued) with a "N suppressed" note
//   - Emergency alerts (HALT, CRASH) bypass the rate limit entirely
//
// Setup:
//   Set env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   const tg = require('./telegram');
//   tg.send('Trade opened: BUY EURUSD @ 1.08500', 'trade');
//   tg.alert('GLOBAL HALT triggered', 'halt');   // bypasses rate limit
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');
const { TRADING_CONFIG } = require('./trading-config');

const MAX_PER_MINUTE  = 20;       // hard cap — Telegram allows 30/s but be conservative
const BASE_COOLDOWN_MS = {        // per-category minimum gap — NEVER mutate this const
  trade:    10_000,   // 10 s between trade alerts
  risk:     30_000,   // 30 s between risk warnings
  status:   60_000,   // 1 min between status updates
  error:    20_000,   // 20 s between error alerts
  default:  15_000,
};
const EMERGENCY_CATEGORIES = new Set(['halt', 'crash', 'global_halt']);

class TelegramNotifier {
  constructor() {
    this._token   = process.env.TELEGRAM_BOT_TOKEN  || '';
    this._chatId  = process.env.TELEGRAM_CHAT_ID    || '';
    this._enabled = !!(this._token && this._chatId);

    this._windowStart   = Date.now();
    this._sentThisWindow = 0;
    this._suppressed    = 0;
    this._lastSent      = {};   // category → timestamp
  }

  // ── Public: normal rate-limited send ────────────────────────────────────────
  send(message, category = 'default') {
    // Bug fix: null/undefined/non-string message crashes .slice() before any guard is reached
    if (message == null) return;
    if (typeof message !== 'string') message = String(message);
    // Item 53: Alert deduplication — suppress repeated identical alerts within cooldown
    const _key53 = `${category}:${message.slice(0,60)}`;
    const _now53 = Date.now();
    const _cooldown = TRADING_CONFIG?.alertDedupMs || 300_000;  // 5 min default
    if (!this._alertCache) this._alertCache = {};
    if (this._alertCache[_key53] && _now53 - this._alertCache[_key53] < _cooldown) return;
    this._alertCache[_key53] = _now53;
    // Clean old cache entries
    if (Object.keys(this._alertCache).length > 100) {
      for (const k of Object.keys(this._alertCache)) {
        if (_now53 - this._alertCache[k] > _cooldown * 2) delete this._alertCache[k];
      }
    }
    // Fix #90: Suppress non-critical alerts during configurable quiet hours (Asian session off-hours)
    const _hour = new Date().getUTCHours();
    const _quietStart = parseInt(process.env.QUIET_HOURS_START || '23');
    const _quietEnd   = parseInt(process.env.QUIET_HOURS_END   || '6');
    const _inQuiet    = _quietStart > _quietEnd
      ? (_hour >= _quietStart || _hour < _quietEnd)
      : (_hour >= _quietStart && _hour < _quietEnd);
    const _criticals  = new Set(['halt','crash','global_halt','risk']);
    if (_inQuiet && !_criticals.has(category)) return;  // suppress non-critical in quiet hours
    if (!this._enabled) return;
    if (EMERGENCY_CATEGORIES.has(category)) { this._dispatch(message); return; }

    const now     = Date.now();
    const baseCooldown = (BASE_COOLDOWN_MS[category] ?? BASE_COOLDOWN_MS.default);
    const cooldown = baseCooldown * (this._cooldownMult || 1);

    // Reset minute window
    if (now - this._windowStart >= 60_000) {
      if (this._suppressed > 0) {
        this._dispatch(`[Rate limit] ${this._suppressed} message(s) suppressed in last minute`);
        this._suppressed = 0;
      }
      this._windowStart    = now;
      this._sentThisWindow = 0;
      // Feature #73: Reset per-category budget counters each window
      this._categoryWindowCount = {};
    }

    // Per-category cooldown
    if (this._lastSent[category] && now - this._lastSent[category] < cooldown) {
      this._suppressed++;
      return;
    }

    // Feature #73: Per-category budget — no single category consumes >50% of window
    const CAT_MAX = Math.ceil(MAX_PER_MINUTE * 0.5);
    this._categoryWindowCount = this._categoryWindowCount || {};
    const catCount = (this._categoryWindowCount[category] || 0);
    if (catCount >= CAT_MAX) {
      this._suppressed++;
      return;   // this category is throttled; other categories still get through
    }

    // Per-minute global cap
    if (this._sentThisWindow >= MAX_PER_MINUTE) {
      this._suppressed++;
      return;
    }

    this._lastSent[category] = now;
    this._sentThisWindow++;
    this._categoryWindowCount[category] = catCount + 1;
    this._dispatch(message);
  }

  // ── Public: emergency — bypasses all rate limits ─────────────────────────
  alert(message, category = 'halt') {
    if (!this._enabled) return;
    this._dispatch(`🚨 EMERGENCY [${category.toUpperCase()}]: ${message}`);
  }

  // ── Internal: actual HTTP POST to Telegram Bot API ───────────────────────
  _dispatch(text) {
    if (!this._enabled) return;
    try {
    const body = JSON.stringify({ chat_id: this._chatId, text, parse_mode: 'HTML' });
    const opts = {
      hostname: 'api.telegram.org',
      path:     `/bot${this._token}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => {
      if (res.statusCode === 429) {
        // Telegram told us to back off — double cooldowns temporarily
        console.warn('[Telegram] 429 Too Many Requests — backing off');
        this._cooldownMult = Math.min(8, (this._cooldownMult || 1) * 2);
        setTimeout(() => {
          this._cooldownMult = Math.max(1, (this._cooldownMult || 1) / 2);
        }, 60_000);
      }
    });
    req.on('error', (e) => {
      console.error('[Telegram] Send error:', e.message);
      // Fix #34: Persist failed high-priority alerts to dead-letter queue
      if (text.includes('HALT') || text.includes('CRASH') || text.includes('GLOBAL')) {
        try {
          const fs = require('fs'), path = require('path');
          const dlqPath = path.join(__dirname, 'trade_logs', 'telegram-dlq.jsonl');
          fs.mkdirSync(path.dirname(dlqPath), { recursive: true });
          fs.appendFileSync(dlqPath, JSON.stringify({ ts: new Date().toISOString(), text, err: e.message }) + '\n');
        } catch(_) {}
      }
    });
    req.setTimeout(5000, () => req.destroy());
    req.write(body);
    req.end();
    } catch (err) { console.error('[Telegram] _dispatch error:', err.message); }
  }

  get isEnabled() { return this._enabled; }
}

// Singleton — one notifier for the whole process
const notifier = new TelegramNotifier();
// Item #53: Weekly performance report (Monday 09:00 UTC)
function scheduleWeeklyReport(engineFn) {
  function msUntilNextMonday9am() {
    const now = new Date();
    const d   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 0, 0));
    const daysUntilMon = (8 - now.getUTCDay()) % 7 || 7;
    d.setUTCDate(d.getUTCDate() + daysUntilMon);
    return d - now;
  }
  function scheduleNext() {
    setTimeout(() => {
      try {
        const e = typeof engineFn === 'function' ? engineFn() : null;
        if (e) {
          const msg = `📊 Weekly Report (${new Date().toISOString().slice(0,10)})
`+
            `Capital: $${(e.capital||0).toFixed(2)}
`+
            `Total trades: ${e.trades?.length||0} | W/L: ${e.wins||0}/${e.losses||0}
`+
            `Max DD: ${(((e.initialCapital-e.capital)/e.initialCapital)*100).toFixed(2)}%`;
          require('./telegram').send(msg, 'status');
        }
      } catch(_) {}
      scheduleNext();
    }, msUntilNextMonday9am()).unref();
  }
  scheduleNext();
}

// Item #25: Daily performance report scheduler
function scheduleDailyReport(engineFn) {
  const msUntilMidnight = () => {
    const now = new Date(), midnight = new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1));
    return midnight - now;
  };
  function scheduleNext() {
    setTimeout(() => {
      try {
        const e = typeof engineFn === 'function' ? engineFn() : null;
        if (!e) return scheduleNext();
        const { RiskAdjustedMetrics } = require('./performance-analytics');
        const ram = new RiskAdjustedMetrics();
        const attr = ram.pnlAttribution ? ram.pnlAttribution(e.trades||[]) : {};
        const todayTrades = (e.trades||[]).filter(t => {
          const d = new Date(t.exitTime||t.entryTime||0).toISOString().slice(0,10);
          return d === new Date().toISOString().slice(0,10);
        });
        const todayPnl = todayTrades.reduce((s,t)=>s+(t.profit||0),0);
        const msg = `📊 Daily Report
`+
          `Capital: $${(e.capital||0).toFixed(2)} | Drawdown: ${(((e.initialCapital-e.capital)/e.initialCapital)*100).toFixed(2)}%
`+
          `Today: ${todayTrades.length} trades | P&L: $${todayPnl.toFixed(2)}
`+
          `All-time: ${(e.wins||0)}W ${(e.losses||0)}L | WR: ${e.trades?.length?(e.wins/e.trades.length*100).toFixed(1):0}%`;
        require('./telegram').send(msg, 'status');
      } catch(e) { console.warn('[DailyReport] Failed:', e.message); }
      scheduleNext();
    }, msUntilMidnight()).unref();
  }
  scheduleNext();
}

// Exports updated below
// Item #23: Telegram two-way command handling via polling
class TelegramCommands {
  constructor(botToken, chatId, engine) {
    this._token   = botToken;
    this._chatId  = chatId;
    this._engine  = engine;
    this._offset  = 0;
    this._polling = null;
  }

  start() {
    if (!this._token || this._token === 'your_bot_token_here') return;
    this._polling = setInterval(() => this._poll(), 5000).unref();
    console.log('[TelegramCommands] Polling started — listening for /halt /resume /status /size');
  }

  stop() { clearInterval(this._polling); }

  async _poll() {
    try {
      const https = require('https');
      const url   = `https://api.telegram.org/bot${this._token}/getUpdates?offset=${this._offset}&timeout=1`;
      const data  = await new Promise((res, rej) => {
        https.get(url, r => {
          let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{res(JSON.parse(d))}catch{rej(new Error('parse'))}});
        }).on('error', rej);
      });
      for (const upd of (data.result||[])) {
        this._offset = upd.update_id + 1;
        const text = upd.message?.text || '';
        const chatId = upd.message?.chat?.id?.toString();
        if (chatId !== this._chatId) continue;  // only from authorised chat
        await this._handleCommand(text.trim().toLowerCase());
      }
    } catch(_) {}
  }

  async _handleCommand(cmd) {
    const e = this._engine;
    const send = (msg) => { try { require('./telegram').send(msg, 'status'); } catch(_) {} };
    if (cmd === '/halt' || cmd === '/stop') {
      if (e) { e.globalHaltTripped = true; }
      send('🛑 HALT commanded by operator. No new entries until /resume.');
    } else if (cmd === '/resume') {
      if (e) { e.globalHaltTripped = false; e.circuitBreakerTripped = false; }
      send('✅ RESUME commanded. Trading re-enabled.');
    } else if (cmd === '/status') {
      const cap = e ? `$${e.capital?.toFixed(2)||'?'}` : '?';
      const pos = e?.position ? `${e.position.side} ${e.selectedAsset}` : 'no position';
      const dd  = e && e.initialCapital ? `${(((e.initialCapital-e.capital)/e.initialCapital)*100).toFixed(2)}%` : '?';
      // Item 54: Compute live Sharpe from recent trades
      let sharpeStr = 'N/A';
      try {
        const t54 = (e?.trades||[]).slice(-50);
        if (t54.length >= 10) {
          const rets = t54.map(t=>t.profitPercent||0);
          const m54  = rets.reduce((s,v)=>s+v,0)/rets.length;
          const std54= Math.sqrt(rets.reduce((s,v)=>s+(v-m54)**2,0)/rets.length)||1e-6;
          sharpeStr  = (m54/std54*Math.sqrt(252)).toFixed(2);
        }
      } catch(_) {}
      send(`📊 Status: capital=${cap} | pos=${pos} | DD=${dd} | Sharpe=${sharpeStr} | halted=${e?.globalHaltTripped||false}`);
    } else if (cmd === '/driftreset') {
      // Item 109: Telegram command to reset drift monitor after cooldown
      if (e?._driftMonitor?.reset) {
        try {
          e._driftMonitor.reset();
          send('✅ Drift monitor reset. Normal trading resumed.');
        } catch(err) {
          send(`❌ Drift reset failed: ${err.message}`);
        }
      } else {
        send('No drift monitor active or cooldown not expired.');
      }
    } else if (cmd === '/approve') {
      if (e?._pendingApproval && e._pendingApproval.expires > Date.now()) {
        e._approvalGranted = e._pendingApproval.key;
        e._pendingApproval = null;
        send('✅ Trade APPROVED. Executing entry.');
      } else {
        send('No pending trade awaiting approval.');
      }
    } else if (cmd === '/reject') {
      if (e?._pendingApproval) {
        e._pendingApproval = null;
        send('❌ Trade REJECTED. Skipping entry.');
      } else {
        send('No pending trade to reject.');
      }
    } else if (cmd.startsWith('/size ')) {
      const pct = parseFloat(cmd.split(' ')[1]);
      if (isFinite(pct) && pct > 0 && pct <= 100 && e) {
        const { TRADING_CONFIG } = require('./trading-config');
        TRADING_CONFIG.positionSize = pct / 100;
        send(`✅ Position size set to ${pct}%`);
      }
    }
  }
}

module.exports = notifier;
module.exports.TelegramCommands    = TelegramCommands;
module.exports.scheduleDailyReport  = scheduleDailyReport;
module.exports.scheduleWeeklyReport = scheduleWeeklyReport;
