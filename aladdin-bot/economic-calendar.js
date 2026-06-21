'use strict';
const logger = require('./structured-logger');
const { NEWS_BLACKOUT_CONFIG } = require('./news-blackout-config');
// ── economic-calendar.js ──────────────────────────────────────────────────────
// Forex economic calendar awareness.
// Tracks high-impact events (NFP, FOMC, CPI, etc.) and provides:
//   1. Pre-event blackout: block new entries 30 min before
//   2. Post-event cooldown: block entries 15 min after
//   3. Pre-news position management: tighten stops, take partials
//   4. Volatility expansion factor for the event window
//
// Uses a weekly-seeded schedule (recurring events) + optional live feed.
// No API key required — uses predictable calendar patterns.
// ─────────────────────────────────────────────────────────────────────────────

// High-impact recurring events by day-of-week and UTC hour (approximate)
const RECURRING_EVENTS = [
  // NFP: first Friday of month 13:30 UTC — handled separately
  { name:'US_CPI',      dayOfMonth:[10,11,12,13,14], utcHour:13, utcMin:30, pairs:['EURUSD','GBPUSD','USDJPY'], impact:'HIGH' },
  { name:'FOMC',        dayOfWeek: [3], utcHour:19, utcMin:0,   pairs:['EURUSD','GBPUSD','USDJPY'], impact:'VERY_HIGH' },
  { name:'BOE',         dayOfWeek: [4], utcHour:12, utcMin:0,   pairs:['GBPUSD'],                   impact:'HIGH' },
  { name:'ECB',         dayOfWeek: [4], utcHour:13, utcMin:15,  pairs:['EURUSD'],                   impact:'HIGH' },
  { name:'BOJ',         dayOfWeek: [2], utcHour:3,  utcMin:0,   pairs:['USDJPY'],                   impact:'HIGH' },
  { name:'US_JOBLESS',  dayOfWeek: [4], utcHour:13, utcMin:30,  pairs:['EURUSD','GBPUSD','USDJPY'], impact:'MEDIUM' },
  { name:'US_RETAIL',   dayOfMonth:[14,15,16,17,18], utcHour:13, utcMin:30, pairs:['EURUSD','GBPUSD'], impact:'MEDIUM' },
];

// Bug fix #10: use shared NEWS_BLACKOUT_CONFIG instead of local constants
const BLACKOUT_BEFORE_MS  = NEWS_BLACKOUT_CONFIG.highBeforeMs;  // 30 min
const COOLDOWN_AFTER_MS   = NEWS_BLACKOUT_CONFIG.highAfterMs;   // 15 min
const EVENT_WINDOW_MS     = 5  * 60_000;   // 5 min around event = highest vol

class EconomicCalendar {
  constructor() {
    this._upcomingEvents = [];
    this._lastRefresh    = 0;
  }

  // ── Check if current time is in a blackout/cooldown window ───────────────
  check(asset, now) {
    now = now || Date.now();
    const nowDate = new Date(now);
    const events  = this._getRelevantEvents(asset, nowDate);

    for (const ev of events) {
      const evMs     = this._eventTimeMs(ev, nowDate);
      const msBefore = evMs - now;
      const msAfter  = now - evMs;

      if (msBefore >= 0 && msBefore < BLACKOUT_BEFORE_MS) {
        return {
          blocked:  true, cooldown: false,
          reason:   ev.name + ' in ' + Math.ceil(msBefore/60000) + ' min — entry blocked',
          event:    ev.name, impact: ev.impact,
          volatilityExpansion: ev.impact === 'VERY_HIGH' ? 4 : 2.5,
          minsToEvent: Math.ceil(msBefore/60000),
        };
      }
      if (msAfter >= 0 && msAfter < COOLDOWN_AFTER_MS) {
        return {
          blocked:  true, cooldown: true,
          reason:   ev.name + ' cooldown (' + Math.ceil((COOLDOWN_AFTER_MS-msAfter)/60000) + ' min left)',
          event:    ev.name, impact: ev.impact,
          volatilityExpansion: ev.impact === 'VERY_HIGH' ? 3 : 2,
          minsToEvent: -Math.ceil(msAfter/60000),
        };
      }
    }
    return { blocked: false, volatilityExpansion: 1 };
  }

  // ── Pre-news position management advice ──────────────────────────────────
  // Returns actions to take on open position before an imminent event
  preNewsManagement(asset, position, now) {
    now = now || Date.now();
    if (!position) return null;
    const nowDate = new Date(now);
    const events  = this._getRelevantEvents(asset, nowDate);

    for (const ev of events) {
      const evMs     = this._eventTimeMs(ev, nowDate);
      const msBefore = evMs - now;

      // 30–45 min before a HIGH or VERY_HIGH impact event
      if (msBefore > 0 && msBefore < 45 * 60_000 && (ev.impact === 'HIGH' || ev.impact === 'VERY_HIGH')) {
        const minsLeft = Math.ceil(msBefore / 60_000);
        const inWindow  = msBefore < EVENT_WINDOW_MS;

        return {
          action:        inWindow ? 'CLOSE' : 'TIGHTEN_AND_PARTIAL',
          event:         ev.name,
          impact:        ev.impact,
          minsToEvent:   minsLeft,
          // Tighten stop to 50% of current distance
          tightenStopBy: 0.5,
          // Take 40% partial profit before event
          takePartial:   !inWindow ? 0.40 : 0,
          reason:        ev.name + ' in ' + minsLeft + 'min — ' + (inWindow ? 'close position' : 'tighten + partial'),
        };
      }
    }
    return null;
  }

  // ── Get events relevant to this asset and date ────────────────────────────
  _getRelevantEvents(asset, nowDate) {
    const base  = asset ? asset.substring(0,3) : '';
    const quote = asset ? asset.substring(3,6) : '';
    return RECURRING_EVENTS.filter(ev => {
      const pairMatch = !ev.pairs || ev.pairs.some(p =>
        p.startsWith(base) || p.endsWith(quote) || p === asset
      );

      // Day-of-week check
      const dowMatch = !ev.dayOfWeek || ev.dayOfWeek.includes(nowDate.getUTCDay());

      // Day-of-month check (event occurs on these days of month)
      const domMatch = !ev.dayOfMonth || ev.dayOfMonth.includes(nowDate.getUTCDate());

      return pairMatch && (dowMatch || domMatch);
    });
  }

  // ── Estimate event timestamp in ms ───────────────────────────────────────
  _eventTimeMs(ev, nowDate) {
    const today = new Date(Date.UTC(
      nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate(),
      ev.utcHour, ev.utcMin || 0, 0
    ));
    if (nowDate.getTime() - today.getTime() > 12 * 3600_000) {
      const tomorrow = new Date(today);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      return tomorrow.getTime();
    }
    return today.getTime();
  }

  // Item #16: Pre-CB decision size multiplier — gradually reduce as major CB event approaches
  // Item 35: Pre-FOMC 2-day drift reduction (30%) — extends existing 1-day reduction
  preFOMCDriftMultiplier(asset) {
    const currencies = (asset||'').match(/.{1,3}/g)||[];
    const now        = Date.now();
    const events     = this._liveEvents || [];
    const CB_EVENTS  = ['FOMC','Fed','ECB','BOE','BOJ','SNB','RBA','BOC'];
    let minDaysAway  = Infinity;
    for (const ev of events) {
      const isCB  = CB_EVENTS.some(k => (ev.name||'').includes(k));
      const isCur = currencies.includes(ev.currency);
      if (isCB && isCur) {
        const daysAway = (ev.utcTime - now) / 86_400_000;
        if (daysAway > 0 && daysAway < minDaysAway) minDaysAway = daysAway;
      }
    }
    if (minDaysAway <= 2) return 0.70;  // 2 days before: 30% reduction
    return 1.0;
  }

  preCBSizeMultiplier(asset) {
    const currencies = (asset||'').match(/.{1,3}/g)||[];
    const now = Date.now();
    const events = this._liveEvents || [];
    const CB_EVENTS = ['FOMC','Fed','ECB','BOE','BOJ','SNB','RBA','BOC'];
    let minDaysAway = Infinity;
    for (const ev of events) {
      const isCB  = CB_EVENTS.some(k => (ev.name||'').includes(k));
      const isCur = currencies.includes(ev.currency);
      if (isCB && isCur) {
        const daysAway = (ev.utcTime - now) / 86_400_000;
        if (daysAway > 0 && daysAway < minDaysAway) minDaysAway = daysAway;
      }
    }
    if (minDaysAway <= 1) return 0.50;  // day before: 50%
    if (minDaysAway <= 2) return 0.75;  // 2 days before: 75%
    return 1.0;
  }
  // Feature #88: Fetch live economic calendar from a real API
  // Uses Forex Factory JSON feed (no key required) with a weekly cache.
  // Falls back to hardcoded patterns on network error.
  async fetchLive() {
    const CACHE_MS = 6 * 3600_000;  // cache 6 hours
    if (this._liveCacheAt && Date.now() - this._liveCacheAt < CACHE_MS) return true;

    return new Promise((resolve) => {
      const https = require('https');
      // Forex Factory provides a public JSON calendar endpoint
      const url = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
      const req = https.get(url, { timeout: 10000 }, (res) => {
        if (res.statusCode !== 200) { resolve(false); return; }
        let raw = '';
        res.on('data', d => { raw += d; if (raw.length > 500_000) req.destroy(); });
        res.on('end', () => {
          try {
            const events = JSON.parse(raw);
            this._liveEvents = events.filter(e => e.impact === 'High').map(e => ({
              name:      e.title,
              utcTime:   new Date(e.date).getTime(),
              currency:  e.country,
            }));
            this._liveCacheAt = Date.now();
            logger.info('economic-calendar', { msg: 'Fetched live high-impact events', count: this._liveEvents.length });
            resolve(true);
          } catch(err) {
            console.warn('[EconCal] Live parse error:', err.message);
            resolve(false);
          }
        });
      });
      req.on('error',   () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  // Override check() to use live events when available
  checkWithLive(asset) {
    if (this._liveEvents && this._liveEvents.length > 0) {
      const now = Date.now();
      const BLACKOUT = BLACKOUT_BEFORE_MS;
      const COOLDOWN = COOLDOWN_AFTER_MS;
      const currencies = (asset || '').match(/.{1,3}/g) || [];
      for (const ev of this._liveEvents) {
        const minsToEvent = (ev.utcTime - now) / 60_000;
        if (currencies.includes(ev.currency)) {
          if (minsToEvent >= 0 && minsToEvent <= BLACKOUT / 60_000) {
            return { blocked: true, reason: `[LiveCal] ${ev.name} in ${minsToEvent.toFixed(0)}min` };
          }
          if (minsToEvent < 0 && Math.abs(ev.utcTime - now) < COOLDOWN) {
            return { blocked: true, reason: `[LiveCal] Post-${ev.name} cooldown` };
          }
        }
      }
    }
    // Fall back to hardcoded patterns
    return this.check(asset);
  }
}

module.exports = { EconomicCalendar, BLACKOUT_BEFORE_MS, COOLDOWN_AFTER_MS };
