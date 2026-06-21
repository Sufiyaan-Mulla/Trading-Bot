'use strict';
// ── news-blackout-config.js ───────────────────────────────────────────────────
// Single source of truth for news blackout windows.
// Used by both economic-calendar.js and news-filter.js.
const NEWS_BLACKOUT_CONFIG = Object.freeze({
  highBeforeMs:   30 * 60_000,  // 30 min before HIGH impact
  highAfterMs:    15 * 60_000,  // 15 min after  HIGH impact
  mediumBeforeMs: 10 * 60_000,  // 10 min before MEDIUM impact
  mediumAfterMs:   5 * 60_000,  //  5 min after  MEDIUM impact
});
module.exports = { NEWS_BLACKOUT_CONFIG };
