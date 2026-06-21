'use strict';
const { NEWS_BLACKOUT_CONFIG } = require('./news-blackout-config');

// ═══════════════════════════════════════════════════════════════════════════════
//  news-filter.js
//  Economic calendar news filter — blocks trades before/after high-impact events
//
//  How it works:
//    1. NewsFilter holds a list of scheduled events (fetched from a free API
//       or manually configured). Each event has: time, currency, impact level.
//    2. Before every entry, checkEntry() is called with the traded asset.
//    3. If a HIGH-impact event affecting that asset's currencies is within
//       the blackout window (e.g. 10 min before / 5 min after), the trade
//       is blocked.
//    4. Events can be loaded from Forex Factory-style JSON, or added manually.
//
//  Impact levels:  HIGH (NFP, FOMC, CPI) → always block
//                  MEDIUM (retail sales, PMI) → block if withinMediumWindow
//                  LOW → never block
//
//  Usage in trading-engine.js:
//    const { NewsFilter } = require('./news-filter');
//    this.newsFilter = new NewsFilter();
//    // In getRuleBasedDecision or executeDecision:
//    const newsCheck = this.newsFilter.checkEntry(this.selectedAsset);
//    if (newsCheck.blocked) { this.log(newsCheck.reason); return; }
// ═══════════════════════════════════════════════════════════════════════════════

// ── Currency → pairs mapping ─────────────────────────────────────────────────
// Which forex pairs are affected by each currency's news events
const CURRENCY_PAIRS = {
  USD: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD'],
  EUR: ['EURUSD', 'EURGBP', 'EURJPY', 'EURCHF', 'EURAUD'],
  GBP: ['GBPUSD', 'EURGBP', 'GBPJPY', 'GBPCHF', 'GBPAUD'],
  JPY: ['USDJPY', 'EURJPY', 'GBPJPY', 'AUDJPY', 'CADJPY'],
  AUD: ['AUDUSD', 'AUDNZD', 'AUDJPY', 'AUDCAD'],
  CAD: ['USDCAD', 'CADJPY', 'AUDCAD'],
  CHF: ['USDCHF', 'EURCHF', 'GBPCHF'],
  NZD: ['NZDUSD', 'AUDNZD', 'NZDJPY'],
};

// ── Known high-impact recurring events ───────────────────────────────────────
// These are pre-seeded — the filter also accepts dynamically loaded events
const RECURRING_HIGH_IMPACT = [
  { name: 'Non-Farm Payrolls',        currency: 'USD', impact: 'HIGH',   dayOfMonth: null, dayOfWeek: 5, weekOfMonth: 1 },
  { name: 'FOMC Rate Decision',       currency: 'USD', impact: 'HIGH',   recurring: 'FOMC' },
  { name: 'CPI',                      currency: 'USD', impact: 'HIGH',   recurring: 'monthly' },
  { name: 'GDP',                      currency: 'USD', impact: 'HIGH',   recurring: 'quarterly' },
  { name: 'BOE Rate Decision',        currency: 'GBP', impact: 'HIGH',   recurring: 'BOE' },
  { name: 'ECB Rate Decision',        currency: 'EUR', impact: 'HIGH',   recurring: 'ECB' },
  { name: 'BOJ Rate Decision',        currency: 'JPY', impact: 'HIGH',   recurring: 'BOJ' },
  { name: 'RBA Rate Decision',        currency: 'AUD', impact: 'HIGH',   recurring: 'RBA' },
];

class NewsFilter {
  constructor (opts = {}) {
    // Blackout windows in milliseconds
    this.highBeforeMs   = NEWS_BLACKOUT_CONFIG.highBeforeMs;
    this.highAfterMs    = NEWS_BLACKOUT_CONFIG.highAfterMs;
    this.mediumBeforeMs = NEWS_BLACKOUT_CONFIG.mediumBeforeMs;
    this.mediumAfterMs  = NEWS_BLACKOUT_CONFIG.mediumAfterMs;
    this.enabled        = opts.enabled !== false;

    // Event store: { time: Date, currency, impact, name }
    this.events = [];

    // Auto-fetch calendar from free API if apiUrl provided
    this.apiUrl    = opts.apiUrl    || null;
    this.lastFetch = 0;
    this.fetchEveryMs = (opts.fetchEveryHours || 6) * 3_600_000;

    // BUG-9 fix: seedOnInit=false lets tests start with truly empty events.
    // Default is true (production always seeds recurring events).
    if (opts.seedOnInit !== false) {
      this._seedRecurringEvents();
    }
  }

  // ── Seed known recurring high-impact events for the next 30 days ─────────
  // Approximates NFP (first Friday), FOMC (8 meetings/year ~every 6 weeks),
  // CPI (mid-month), and central bank rate decisions.
  // These are rough schedules — a live calendar feed is more accurate,
  // but this ensures the blackout window always fires around known risk times.
  _seedRecurringEvents() {
    const now    = new Date();
    const events = [];

    // NFP — first Friday of each month, 13:30 UTC
    for (let m = 0; m < 2; m++) {
      const month = new Date(now.getFullYear(), now.getMonth() + m, 1);
      let day = 1;
      while (new Date(month.getFullYear(), month.getMonth(), day).getDay() !== 5) day++;
      const nfp = new Date(Date.UTC(month.getFullYear(), month.getMonth(), day, 13, 30));
      events.push({ name: 'Non-Farm Payrolls (NFP)', currency: 'USD', impact: 'HIGH', time: nfp });
    }

    // CPI — around 12th of each month, 13:30 UTC
    for (let m = 0; m < 2; m++) {
      const cpi = new Date(Date.UTC(now.getFullYear(), now.getMonth() + m, 12, 13, 30));
      events.push({ name: 'CPI', currency: 'USD', impact: 'HIGH', time: cpi });
    }

    // FOMC — approximate (8 meetings/year, roughly every 6 weeks from Jan)
    // Pre-seed the next two likely windows around Wed 19:00 UTC
    const fomcBase = new Date(Date.UTC(now.getFullYear(), 0, 29, 19, 0)); // Jan 29 approx
    for (let i = 0; i < 8; i++) {
      const fomc = new Date(fomcBase.getTime() + i * 45 * 24 * 3_600_000);
      if (Math.abs(fomc - now) < 60 * 24 * 3_600_000) {
        events.push({ name: 'FOMC Rate Decision', currency: 'USD', impact: 'HIGH', time: fomc });
      }
    }

    // Load only future events (or very recent — within last 10 min)
    const valid = events.filter(e => e.time.getTime() > now.getTime() - 10 * 60_000);
    if (valid.length > 0) this.loadEvents([...this.events.map(e => ({...e, time: e.time})), ...valid]);
  }

  // ── Load events from an array ────────────────────────────────────────────
  // Each event: { time: Date|string|number, currency: 'USD', impact: 'HIGH'|'MEDIUM'|'LOW', name: string }
  loadEvents (events) {
    this.events = events
      .filter(e => e.time && e.currency && e.impact)
      .map(e => ({
        ...e,
        time:     new Date(e.time),
        currency: e.currency.toUpperCase(),
        impact:   e.impact.toUpperCase(),
      }))
      .filter(e => !isNaN(e.time.getTime()));
    return this.events.length;
  }

  // ── Add a single event ───────────────────────────────────────────────────
  addEvent (event) {
    const e = {
      name:     event.name     || 'Unknown',
      currency: (event.currency || 'USD').toUpperCase(),
      impact:   (event.impact   || 'HIGH').toUpperCase(),
      time:     new Date(event.time),
    };
    if (!isNaN(e.time.getTime())) {
      this.events.push(e);
    }
    return this;
  }

  // ── Fetch from Forex Factory-compatible JSON endpoint ────────────────────
  async fetchCalendar (url) {
    const fetchUrl = url || this.apiUrl;
    if (!fetchUrl) return 0;
    try {
      const res  = await fetch(fetchUrl, { signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      const arr  = Array.isArray(data) ? data : data.events || data.data || [];
      return this.loadEvents(arr.map(e => ({
        name:     e.title || e.name || e.event,
        currency: e.country || e.currency,
        impact:   e.impact || e.volatility,
        time:     e.date || e.datetime || e.time,
      })));
    } catch (err) {
      console.warn(`[NewsFilter] Calendar fetch failed: ${err.message}`);
      return 0;
    }
  }

  // ── Core gate — call before every entry ─────────────────────────────────
  // Returns { blocked, reason, event|null, minutesUntil|minutesSince }

  // ── Convert recurring event tags to approximate datetime windows ──────────
  // Called by _seedRecurringEvents to produce real Date objects for FOMC etc.
  _recurringToDates(event, nowMs = Date.now()) {
    const dates = [];
    const now   = new Date(nowMs);
    const year  = now.getUTCFullYear();
    const month = now.getUTCMonth();

    switch (event.recurring) {
      case 'FOMC':
        // ~8 meetings/year, roughly every 6 weeks starting late Jan
        for (let m = 0; m < 12; m += 1.5) {
          const d = new Date(Date.UTC(year, 0, 29 + Math.round(m * 45)));
          d.setUTCHours(18, 0, 0, 0);  // 2pm ET = 18:00 UTC approx
          dates.push(d.getTime());
        }
        break;
      case 'ECB':
      case 'BOE':
      case 'BOJ':
      case 'RBA':
        // ~8 meetings/year, roughly every 6 weeks
        for (let i = 0; i < 8; i++) {
          const d = new Date(Date.UTC(year, Math.floor(i * 1.5), 15));
          d.setUTCHours(12, 0, 0, 0);
          dates.push(d.getTime());
        }
        break;
      case 'monthly':
        dates.push(new Date(Date.UTC(year, month, 15, 13, 0, 0, 0)).getTime());
        break;
      case 'quarterly':
        [2, 5, 8, 11].forEach(m => dates.push(new Date(Date.UTC(year, m, 28, 13, 0, 0, 0)).getTime()));
        break;
    }
    return dates.filter(ts => ts > nowMs - 7 * 86400_000 && ts < nowMs + 60 * 86400_000);
  }

  checkEntry (asset, nowMs = Date.now()) {
    if (!this.enabled) {
      return { blocked: false, reason: 'News filter disabled', event: null };
    }

    // Auto-refresh calendar if stale
    if (this.apiUrl && nowMs - this.lastFetch > this.fetchEveryMs) {
      this.lastFetch = nowMs;
      this.fetchCalendar().catch(() => {});
    }

    // Find currencies this asset is exposed to
    const affectedCurrencies = this._currenciesForAsset(asset);
    if (affectedCurrencies.length === 0) {
      return { blocked: false, reason: `No currency mapping for ${asset}`, event: null };
    }

    // Prune stale events (> 2 hours ago)
    this.events = this.events.filter(e => nowMs - e.time.getTime() < 2 * 3_600_000);

    // Check all upcoming and recent events
    for (const event of this.events) {
      if (!affectedCurrencies.includes(event.currency)) continue;

      const diffMs = event.time.getTime() - nowMs;  // positive = future, negative = past
      const beforeMs = event.impact === 'HIGH' ? this.highBeforeMs : this.mediumBeforeMs;
      const afterMs  = event.impact === 'HIGH' ? this.highAfterMs  : this.mediumAfterMs;

      // Skip LOW impact
      if (event.impact === 'LOW') continue;
      // Skip MEDIUM if not close
      if (event.impact === 'MEDIUM' && (diffMs > beforeMs || diffMs < -afterMs)) continue;
      // Skip HIGH if not close
      if (event.impact === 'HIGH'   && (diffMs > beforeMs || diffMs < -afterMs)) continue;

      // Within blackout window
      const minutesUntil = Math.round(diffMs / 60_000);
      const label = diffMs > 0
        ? `${minutesUntil}min before`
        : `${-minutesUntil}min after`;

      return {
        blocked: true,
        reason:  `NEWS BLOCK: ${event.name} (${event.impact}) ${event.currency} — ${label} event. Spread will be 3-10× normal.`,
        event,
        minutesUntil,
      };
    }

    return { blocked: false, reason: 'No high-impact events in blackout window', event: null };
  }

  // ── List upcoming events for a given asset ───────────────────────────────
  upcomingFor (asset, windowMs = 4 * 3_600_000, nowMs = Date.now()) {
    const currencies = this._currenciesForAsset(asset);
    return this.events
      .filter(e => {
        const diff = e.time.getTime() - nowMs;
        return diff > 0 && diff <= windowMs && currencies.includes(e.currency);
      })
      .sort((a, b) => a.time - b.time);
  }

  // ── Status summary ───────────────────────────────────────────────────────
  status (nowMs = Date.now()) {
    const upcoming = this.events.filter(e => e.time.getTime() > nowMs);
    const recent   = this.events.filter(e => e.time.getTime() <= nowMs && nowMs - e.time.getTime() < 3_600_000);
    return {
      enabled:       this.enabled,
      totalEvents:   this.events.length,
      upcomingCount: upcoming.length,
      recentCount:   recent.length,
      highImpactNext: upcoming.find(e => e.impact === 'HIGH') || null,
      windowsMs: {
        highBefore: this.highBeforeMs,
        highAfter:  this.highAfterMs,
        mediumBefore: this.mediumBeforeMs,
        mediumAfter:  this.mediumAfterMs,
      },
    };
  }

  // ── Private ──────────────────────────────────────────────────────────────
  _currenciesForAsset (asset) {
    const currencies = [];
    for (const [ccy, pairs] of Object.entries(CURRENCY_PAIRS)) {
      if (pairs.includes(asset)) currencies.push(ccy);
    }
    // Also try to extract base/quote directly from the symbol
    if (currencies.length === 0 && asset.length === 6) {
      currencies.push(asset.slice(0, 3).toUpperCase());
      currencies.push(asset.slice(3, 6).toUpperCase());
    }
    return currencies;
  }
}

module.exports = { NewsFilter, CURRENCY_PAIRS, RECURRING_HIGH_IMPACT };
