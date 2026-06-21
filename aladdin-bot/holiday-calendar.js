'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  HolidayCalendar  —  Feature #89
//
//  Blocks new entries on major bank holidays when Forex spreads widen.
//  Covers US, UK, EU, JP, AU holidays through 2028.
//  Can be extended by adding entries to HOLIDAYS below.
//
//  Usage:
//    const { HolidayCalendar } = require('./holiday-calendar');
//    const cal = new HolidayCalendar();
//    const check = cal.check();   // { blocked, reason, holiday }
// ─────────────────────────────────────────────────────────────────────────────

// Fixed-date holidays (MM-DD format) affecting major FX liquidity centres
const FIXED_HOLIDAYS = {
  '01-01': "New Year's Day",
  '12-25': 'Christmas Day',
  '12-26': 'Boxing Day (UK/AU)',
  '07-04': 'US Independence Day',
  '11-11': 'Veterans Day / Remembrance Day',
  '05-01': 'Labour Day (EU/UK/AU)',
  '08-15': 'Assumption Day (EU)',
  '10-03': 'German Unity Day',
};

// Variable-date holidays (pre-computed through 2028 — update yearly)
// Format: 'YYYY-MM-DD'
const VARIABLE_HOLIDAYS = new Set([
  // Good Friday (US/UK markets closed)
  '2025-04-18', '2026-04-03', '2027-03-26', '2028-04-14',
  // Easter Monday (UK/EU)
  '2025-04-21', '2026-04-06', '2027-03-29', '2028-04-17',
  // US Thanksgiving (4th Thursday November)
  '2025-11-27', '2026-11-26', '2027-11-25', '2028-11-23',
  // US Memorial Day (last Monday May)
  '2025-05-26', '2026-05-25', '2027-05-31', '2028-05-29',
  // US Labor Day (1st Monday September)
  '2025-09-01', '2026-09-07', '2027-09-06', '2028-09-04',
  // US MLK Day (3rd Monday January)
  '2025-01-20', '2026-01-19', '2027-01-18', '2028-01-17',
  // US Presidents Day (3rd Monday February)
  '2025-02-17', '2026-02-16', '2027-02-15', '2028-02-21',
  // UK Early May Bank Holiday (1st Monday May)
  '2025-05-05', '2026-05-04', '2027-05-03', '2028-05-01',
  // UK Spring Bank Holiday (last Monday May)
  '2025-05-26', '2026-05-25', '2027-05-31', '2028-05-27',
  // UK Summer Bank Holiday (last Monday August)
  '2025-08-25', '2026-08-31', '2027-08-30', '2028-08-28',
  // JP Golden Week block
  '2025-05-02', '2025-05-06',
  '2026-05-04', '2026-05-06',
  // JP Respect for the Aged Day (3rd Monday September)
  '2025-09-15', '2026-09-21', '2027-09-20', '2028-09-18',
  // AU Australia Day (26 Jan, observed Mon if weekend)
  '2025-01-27', '2026-01-26', '2027-01-26', '2028-01-26',
  // AU ANZAC Day
  '2025-04-25', '2026-04-25', '2027-04-25', '2028-04-25',
]);

// Days that are NOT full holidays but have significantly reduced liquidity
// (warn but don't block by default)
const REDUCED_LIQUIDITY_DATES = new Set([
  '12-24',  // Christmas Eve
  '12-31',  // New Year's Eve
]);

class HolidayCalendar {
  /**
   * @param {object} opts
   * @param {boolean} [opts.blockOnHoliday]   - halt entries (default true)
   * @param {boolean} [opts.warnOnReduced]    - log warning on reduced-liquidity days (default true)
   * @param {Function} [opts.log]
   */
  constructor(opts = {}) {
    this.blockOnHoliday  = opts.blockOnHoliday  ?? true;
    this.warnOnReduced   = opts.warnOnReduced   ?? true;
    this._log            = opts.log || ((m) => console.log('[Holiday] ' + m));
    this._lastWarnDate   = null;
  }

  _todayUTC() {
    return new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
  }

  /**
   * Returns { blocked, reason, holiday, reducedLiquidity }
   */
  check() {
    const today  = this._todayUTC();
    const mmdd   = today.slice(5);  // MM-DD

    // Check variable holidays first (exact date match)
    if (VARIABLE_HOLIDAYS.has(today)) {
      const name = this._nameForDate(today) || 'Bank Holiday';
      if (this.blockOnHoliday) {
        return { blocked: true, reason: `Market holiday: ${name} (${today}) — entries blocked`, holiday: name };
      }
      return { blocked: false, reducedLiquidity: true, holiday: name };
    }

    // Check fixed holidays
    if (FIXED_HOLIDAYS[mmdd]) {
      const name = FIXED_HOLIDAYS[mmdd];
      if (this.blockOnHoliday) {
        return { blocked: true, reason: `Market holiday: ${name} (${today}) — entries blocked`, holiday: name };
      }
      return { blocked: false, reducedLiquidity: true, holiday: name };
    }

    // Check reduced-liquidity days
    if (REDUCED_LIQUIDITY_DATES.has(mmdd)) {
      if (this.warnOnReduced && this._lastWarnDate !== today) {
        this._lastWarnDate = today;
        this._log(`⚠️ Reduced liquidity day: ${mmdd} — spreads may be wider than usual`);
      }
      return { blocked: false, reducedLiquidity: true, holiday: mmdd };
    }

    return { blocked: false, reducedLiquidity: false };
  }

  _nameForDate(isoDate) {
    // Try variable set description lookup by scanning FIXED for mmdd
    const mmdd = isoDate.slice(5);
    return FIXED_HOLIDAYS[mmdd] || null;
  }

  /** Returns true if today is a market holiday */
  isHoliday() { return this.check().blocked; }

  /** Returns array of upcoming holidays in the next N days */
  upcoming(days = 14) {
    const result = [];
    const base   = new Date();
    for (let i = 0; i <= days; i++) {
      const d = new Date(base);
      d.setUTCDate(base.getUTCDate() + i);
      const iso  = d.toISOString().slice(0, 10);
      const mmdd = iso.slice(5);
      const name = FIXED_HOLIDAYS[mmdd] || (VARIABLE_HOLIDAYS.has(iso) ? 'Bank Holiday' : null);
      if (name) result.push({ date: iso, name });
    }
    return result;
  }
}

module.exports = { HolidayCalendar };
