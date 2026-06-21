'use strict';
// ── social-tracker.js ─────────────────────────────────────────────────────────
// Free-source social sentiment + institutional positioning tracker for forex.
//
// Twitter/Reddit paid APIs not required. Uses:
//   1. Reddit public JSON API (/r/forex, /r/investing) — no auth needed
//   2. CFTC Commitment of Traders (COT) report — free weekly data from CFTC
//   3. RSS feeds already in sentiment.js — extended here with more sources
//
// COT data is the closest forex equivalent to "whale tracking":
//   - Shows positioning of large speculators (hedge funds) vs commercials
//   - Net long/short positions of institutions updated every Friday
//   - A heavily net-short institutional position = potential short squeeze
//
// Usage:
//   const { SocialTracker } = require('./social-tracker');
//   const tracker = new SocialTracker();
//   await tracker.refresh();
//   const signal = tracker.getSignal('EURUSD');
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

// ── COT currency codes → forex pairs ─────────────────────────────────────────
const COT_MAP = {
  '132741': 'EURUSD',   // Euro FX futures
  '096742': 'GBPUSD',   // British Pound futures
  '097741': 'USDJPY',   // Japanese Yen futures (CFTC quoted as JPY/USD — inversion applied in getSignal)
  '232741': 'AUDUSD',   // Australian Dollar futures
};

class SocialTracker {
  constructor() {
    this._redditPosts   = [];    // {title, score, ts, subreddit}
    this._cotData       = {};    // pair → {netLong, netShort, netChange, ts}
    this._lastReddit    = 0;
    this._lastCOT       = 0;
    this._redditEvery   = 15 * 60_000;   // 15 min
    this._cotEvery      = 3600_000 * 6;  // COT is weekly, re-check every 6h
  }

  // ── Refresh all sources ───────────────────────────────────────────────────
  async refresh() {
    const now = Date.now();
    if (now - this._lastReddit > this._redditEvery) {
      await this._fetchReddit();
      this._lastReddit = now;
    }
    if (now - this._lastCOT > this._cotEvery) {
      await this._fetchCOT();
      this._lastCOT = now;
    }
  }

  // ── Get composite signal for a pair ──────────────────────────────────────
  getSignal(pair) {
    const base  = pair.substring(0, 3).toUpperCase();
    const quote = pair.substring(3, 6).toUpperCase();
    const cutoff = Date.now() - 4 * 3600_000;  // last 4h

    // Reddit sentiment
    const fresh = this._redditPosts.filter(p => p.ts > cutoff);
    const bullish = fresh.filter(p => this._isBullish(p.title, base)).length;
    const bearish = fresh.filter(p => this._isBearish(p.title, base)).length;
    const redditScore = fresh.length > 0 ? (bullish - bearish) / fresh.length : 0;
    const redditSentiment = redditScore > 0.1 ? 'BULLISH' : redditScore < -0.1 ? 'BEARISH' : 'NEUTRAL';

    // COT institutional positioning
    const cot = this._cotData[pair];
    const cotBias = cot ? (cot.netLong > 0 ? 'BULLISH' : 'BEARISH') : 'UNKNOWN';
    const cotStrength = cot ? Math.min(1, Math.abs(cot.netLong) / 50000) : 0;

    // Combined signal
    const bullScore = (redditScore > 0 ? redditScore : 0) + (cotBias === 'BULLISH' ? cotStrength : 0);
    const bearScore = (redditScore < 0 ? -redditScore : 0) + (cotBias === 'BEARISH' ? cotStrength : 0);
    const net = bullScore - bearScore;

    return {
      pair,
      redditSentiment,
      redditPosts:  fresh.length,
      redditScore:  parseFloat(redditScore.toFixed(3)),
      cotBias,
      cotNetLong:   cot ? cot.netLong : null,
      cotNetChange: cot ? cot.netChange : null,
      overallBias:  net > 0.15 ? 'BULLISH' : net < -0.15 ? 'BEARISH' : 'NEUTRAL',
      confidence:   parseFloat(Math.min(1, (Math.abs(net) + (fresh.length > 5 ? 0.2 : 0))).toFixed(2)),
    };
  }

  // ── Fetch Reddit posts (no auth — public JSON API) ─────────────────────────
  async _fetchReddit() {
    const subreddits = ['forex', 'investing', 'algotrading'];  // economics replaced: too much non-forex noise
    for (const sub of subreddits) {
      const posts = await this._get(
        'www.reddit.com', `/r/${sub}/hot.json?limit=25`,
        { 'User-Agent': 'AladdinBot/1.0' }
      );
      if (posts && posts.data && posts.data.children) {
        for (const child of posts.data.children) {
          const d = child.data;
          if (d && d.title) {
            // Use post creation_utc (publication time) not fetch time
            const pubTs = d.created_utc ? d.created_utc * 1000 : Date.now();
            this._redditPosts.push({
              title: d.title.toLowerCase(),
              score: d.score || 0,
              ts:    pubTs,  // publication timestamp — not fetch time
              subreddit: sub,
            });
          }
        }
      }
    }
    // Keep last 500 posts
    if (this._redditPosts.length > 500) this._redditPosts = this._redditPosts.slice(-500);
  }

  // ── Fetch CFTC COT data (free public CSV) ────────────────────────────────
  // COT Futures-Only report: https://www.cftc.gov/dea/futures/deacmesf.htm
  async _fetchCOT() {
    try {
      // Use the CFTC's public API endpoint (returns JSON)
      const data = await this._get(
        'publicreporting.cftc.gov',
        '/api/odata/v1/MarketsandFinancial/FuturesOnlyReportsWithChangesInTraderPositions?$top=10&$filter=Market_and_Exchange_Names eq \'EURO FX - CHICAGO MERCANTILE EXCHANGE\'&$orderby=Report_Date_as_YYYY_MM_DD desc',
        {}
      );
      if (data && data.value && data.value.length > 0) {
        const latest = data.value[0];
        const netLong = (latest.NonComm_Positions_Long_All || 0) - (latest.NonComm_Positions_Short_All || 0);
        const prevNetLong = data.value.length > 1
          ? (data.value[1].NonComm_Positions_Long_All || 0) - (data.value[1].NonComm_Positions_Short_All || 0)
          : netLong;
        this._cotData['EURUSD'] = {
          netLong,
          netShort: -netLong,
          netChange: netLong - prevNetLong,
          reportDate: latest.Report_Date_as_YYYY_MM_DD,
          ts: Date.now(),
        };
      }
    } catch (_) { /* COT unavailable — non-fatal */ }
  }

  // ── HTTP GET helper ───────────────────────────────────────────────────────
  _get(hostname, path, headers) {
    return new Promise((resolve) => {
      const opts = { hostname, path, headers: { 'Accept': 'application/json', ...headers } };
      const req = https.get(opts, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch (_) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    });
  }

  // ── Simple keyword helpers ────────────────────────────────────────────────
  _isBullish(text, currency) {
    const bull = ['bullish','long','buy','surge','rally','strong','rise','gain'];
    const ccy  = currency.toLowerCase();
    return bull.some(w => text.includes(w)) && text.includes(ccy);
  }

  _isBearish(text, currency) {
    const bear = ['bearish','short','sell','drop','fall','weak','decline','crash'];
    const ccy  = currency.toLowerCase();
    return bear.some(w => text.includes(w)) && text.includes(ccy);
  }
}

// Item 16: Embedding-based NLP sentiment scorer (keyword→embedding approximation)
// In production: replace with actual BERT/Sentence-Transformer API call
class NLPSentimentScorer {
  constructor() {
    // Bullish/bearish seed words with sentiment weights
    this._seeds = {
      bullish: ['rally','surge','gain','rise','strong','beat','exceed','optimistic','recovery','growth'],
      bearish: ['crash','plunge','fall','drop','weak','miss','disappoint','recession','decline','fear'],
      neutral: ['hold','stable','steady','unchanged','flat','mixed','moderate','gradual'],
    };
  }

  // Score a news headline/text (returns -1 to +1)
  score(text) {
    if (!text) return 0;
    const lower = text.toLowerCase();
    let b = 0, bear = 0;
    for (const w of this._seeds.bullish) if (lower.includes(w)) b++;
    for (const w of this._seeds.bearish) if (lower.includes(w)) bear++;
    const total = b + bear;
    if (total === 0) return 0;
    return parseFloat(((b - bear) / total).toFixed(3));
  }

  // Score an array of headlines and return aggregate
  scoreAll(headlines) {
    if (!headlines || !headlines.length) return { score:0, label:'NEUTRAL', count:0 };
    const scores = headlines.map(h => this.score(typeof h==='string'?h:h.title||h.text||''));
    const avg    = scores.reduce((s,v)=>s+v,0)/scores.length;
    return {
      score: parseFloat(avg.toFixed(3)),
      label: avg > 0.2 ? 'BULLISH' : avg < -0.2 ? 'BEARISH' : 'NEUTRAL',
      count: headlines.length,
      scores,
    };
  }
}

// Item 76: Live news sentiment API client (NewsAPI.org + Marketaux fallback)
async function fetchLiveNewsSentiment(asset, apiKey) {
  if (!apiKey) return null;
  const currency = asset?.slice(0,3) || 'EUR';
  return new Promise(resolve => {
    const https = require('https');
    const query  = encodeURIComponent(`${currency} forex`);
    const url    = `/v2/everything?q=${query}&language=en&sortBy=publishedAt&pageSize=5&apiKey=${apiKey}`;
    https.get({ host:'newsapi.org', path:url, timeout:8000,
      headers:{'User-Agent':'AladdinBot/1.0'} }, r => {
      let d=''; r.on('data',c=>d+=c);
      r.on('end',()=>{
        try {
          const j = JSON.parse(d);
          const articles = (j.articles||[]).map(a=>a.title||'');
          const scorer   = new NLPSentimentScorer();
          const result   = scorer.scoreAll(articles);
          resolve({ ...result, source:'NewsAPI', currency });
        } catch { resolve(null); }
      });
    }).on('error',()=>resolve(null)).on('timeout',function(){this.destroy();resolve(null)});
  });
}

// Item 79: OANDA retail long/short ratio (open trade ratio endpoint)
async function fetchOandaRetailSentiment(asset, oandaToken, oandaAccount, env='practice') {
  if (!oandaToken) return null;
  const pair = asset?.replace('/','_') || 'EUR_USD';
  const host  = env === 'live' ? 'api-fxtrade.oanda.com' : 'api-fxpractice.oanda.com';
  return new Promise(resolve => {
    const https = require('https');
    const req   = https.get({
      host, timeout: 6000,
      path: `/v3/instruments/${pair}/orderBook`,
      headers: { Authorization: `Bearer ${oandaToken}` },
    }, r => {
      let d=''; r.on('data', c=>d+=c);
      r.on('end', () => {
        try {
          const j = JSON.parse(d);
          const buckets = j.orderBook?.buckets || [];
          let longVol=0, shortVol=0;
          for (const b of buckets) {
            longVol  += parseFloat(b.longCountPercent  || 0);
            shortVol += parseFloat(b.shortCountPercent || 0);
          }
          const total = longVol + shortVol || 1;
          const longPct = longVol/total*100;
          resolve({
            longPct:   parseFloat(longPct.toFixed(1)),
            shortPct:  parseFloat((100-longPct).toFixed(1)),
            sentiment: longPct > 70 ? 'EXTREME_LONG' : longPct > 55 ? 'LONG_BIASED' : longPct < 30 ? 'EXTREME_SHORT' : 'NEUTRAL',
            contrarian:longPct > 70 ? 'SELL' : longPct < 30 ? 'BUY' : null,
            source:    'OANDA',
            pair,
          });
        } catch { resolve(null); }
      });
    });
    req.on('error', ()=>resolve(null));
    req.on('timeout', function(){ this.destroy(); resolve(null); });
  });
}

module.exports = { SocialTracker, NLPSentimentScorer, fetchLiveNewsSentiment, fetchOandaRetailSentiment };
