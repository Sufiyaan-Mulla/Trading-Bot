'use strict';
// ── sentiment.js ─────────────────────────────────────────────────────────────
// Rule-based NLP sentiment scorer for forex news headlines.
// Scores -1.0 (strong bearish) to +1.0 (strong bullish) per currency.
//
// Approach: weighted keyword matching on headline text.
// No paid API required — uses pre-seeded lexicon + optional RSS feed parsing.
//
// Usage:
//   const { SentimentAnalyser } = require('./sentiment');
//   const s = new SentimentAnalyser();
//   s.addHeadline('Fed raises rates, dollar surges', 'USD');
//   const score = s.getScore('EURUSD');  // -0.6 (bearish EUR/bullish USD)
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');

// ── Forex sentiment lexicon ───────────────────────────────────────────────────
const BULLISH_WORDS = [
  'surges','rallies','rallied','soaring','soars','jumped','jumping',
  'rises','rose','climbed','climbing','gained','gaining','boosted',
  'stronger','strengthening','strengthens','beats','exceeded','exceeds','surprised',
  'recovering','grows','grew','expanded','expanding','positively','outperforming',
  'surge','rally','soar','jump','rise','climb','gain','boost','strong',
  'hawkish','rate hike','tighten','inflation','beat','exceed','surprise',
  'robust','solid','optimism','recovery','growth','expansion','positive',
  'buy','bullish','upside','outperform','upgrade'
];
const BEARISH_WORDS = [
  'falls','fell','plunges','plunged','sinking','sank','slides','slid',
  'tumbles','tumbled','declined','declining','weakens','weakened','weaker',
  'cutting','reduced','easing','missed','missed','disappointed','disappointing',
  'receding','slowed','slowing','risked','fears','crises','crashed','collapsing',
  'negatively','contracted','contracting',
  'fall','drop','plunge','sink','slide','tumble','decline','weak','dovish',
  'cut','reduce','ease','miss','disappoint','recession','slowdown','risk',
  'sell','bearish','downside','underperform','downgrade','concern','fear',
  'crisis','collapse','crash','negative','contraction','deficit'
];
const CURRENCY_TERMS = {
  USD: ['dollar','usd','fed','fomc','powell','treasury','us economy','american'],
  EUR: ['euro','eur','ecb','lagarde','eurozone','european'],
  GBP: ['pound','gbp','boe','bailey','britain','uk economy','sterling'],
  JPY: ['yen','jpy','boj','ueda','japan','japanese'],
  AUD: ['aussie','aud','rba','australia','australian'],
};
const INTENSIFIERS = ['very','extremely','significantly','sharply','massively','highly'];
const NEGATORS     = ['not','no','never','without','despite','unchanged','flat'];

class SentimentAnalyser {
  constructor() {
    this._headlines  = [];   // { text, currency, ts, score }
    this._windowMs   = 4 * 3600_000;   // use last 4 hours
    this._lastFetch  = 0;
    this._fetchEvery = 30 * 60_000;    // refresh RSS every 30 min
  }

  // ── Score a single headline ───────────────────────────────────────────────
  scoreHeadline(text) {
    const lower = text.toLowerCase();
    const words  = lower.split(/\W+/);
    let score = 0;
    let i = 0;

    for (; i < words.length; i++) {
      const w = words[i];
      const prevWord  = i > 0 ? words[i-1] : '';
      const isNegated = NEGATORS.includes(prevWord);
      const isAmplified = i > 0 && INTENSIFIERS.includes(prevWord);
      const mult = isAmplified ? 1.5 : 1.0;

      if (BULLISH_WORDS.includes(w)) score += isNegated ? -0.2 : 0.3 * mult;
      if (BEARISH_WORDS.includes(w)) score += isNegated ?  0.2 : -0.3 * mult;
    }

    return Math.max(-1, Math.min(1, score));
  }

  // ── Detect which currencies are mentioned ─────────────────────────────────
  detectCurrencies(text) {
    const lower = text.toLowerCase();
    const found = [];
    for (const [ccy, terms] of Object.entries(CURRENCY_TERMS)) {
      if (terms.some(t => lower.includes(t))) found.push(ccy);
    }
    return found.length > 0 ? found : ['USD'];  // default USD if unclear
  }

  // ── Add a headline manually ───────────────────────────────────────────────
  addHeadline(text, currency = null) {
    const score = this.scoreHeadline(text);
    const currencies = currency ? [currency] : this.detectCurrencies(text);
    for (const ccy of currencies) {
      this._headlines.push({ text, currency: ccy, score, ts: Date.now() });
    }
  }

  // ── Get aggregate sentiment for a forex pair ──────────────────────────────
  // Returns score: positive = bullish for base currency, negative = bearish
  getScore(pair) {
    const base  = pair.substring(0, 3).toUpperCase();
    const quote = pair.substring(3, 6).toUpperCase();
    const cutoff = Date.now() - this._windowMs;

    const fresh = this._headlines.filter(h => h.ts > cutoff);
    const baseItems  = fresh.filter(h => h.currency === base);
    const quoteItems = fresh.filter(h => h.currency === quote);

    const avg = arr => arr.length ? arr.reduce((s,h) => s+h.score, 0) / arr.length : 0;
    const baseScore  = avg(baseItems);
    const quoteScore = avg(quoteItems);

    // Net: bullish base + bearish quote = positive score
    const net = baseScore - quoteScore;
    // confidence: fraction of maximum expected headlines (20 = full confidence)
    const rawHeadlineCount = (this._headlines || []).length;
    const confidence = Math.min(1, rawHeadlineCount / 20);  // 20 headlines = full confidence

    return {
      score:       parseFloat(net.toFixed(3)),
      confidence:  parseFloat(confidence.toFixed(2)),
      baseScore:   parseFloat(baseScore.toFixed(3)),
      quoteScore:  parseFloat(quoteScore.toFixed(3)),
      headlines:   fresh.length,
      regime:      net > 0.2 ? 'BULLISH' : net < -0.2 ? 'BEARISH' : 'NEUTRAL',
    };
  }

  // ── Fetch free RSS headlines (ForexFactory / FXStreet public feeds) ───────
  async fetchRSS(url) {
    return new Promise((resolve) => {
      const req = https.get(url, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try {
            const titles = [...raw.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g)]
              .map(m => m[1]);
            const altTitles = [...raw.matchAll(/<title>(.*?)<\/title>/g)]
              .map(m => m[1]).filter(t => t.length > 10 && !t.includes('<'));
            resolve([...titles, ...altTitles].slice(0, 20));
          } catch (_) { resolve([]); }
        });
      });
      req.on('error', () => resolve([]));
      req.setTimeout(5000, () => { req.destroy(); resolve([]); });
    });
  }

  async refresh() {
    if (Date.now() - this._lastFetch < this._fetchEvery) return;
    this._lastFetch = Date.now();
    // Prune old headlines before adding new ones (prevents unbounded growth)
    const cutoff = Date.now() - this._windowMs;
    this._headlines = this._headlines.filter(h => h.ts > cutoff);
    // Free public forex RSS feeds (no API key required)
    const feeds = [
      'https://www.forexlive.com/feed/',
      'https://www.fxstreet.com/rss/news',
    ];
    for (const url of feeds) {
      const headlines = await this.fetchRSS(url);
      for (const h of headlines) this.addHeadline(h);
    }
  }
}

module.exports = { SentimentAnalyser };
