'use strict';
// ── leading-indicator-fetcher.js ──────────────────────────────────────────────
const https = require('https');

class LeadingIndicatorFetcher {
  constructor() {
    this._resultCache = {};
    this._cacheTTL = 6 * 3600_000;  // 6h cache TTL
    this.histories = { DXY: [], XAU: [], US10Y: [] };
    this._seed('DXY',   104.50);
    this._seed('XAU',   2350.00);
    this._seed('US10Y', 4.35);
    this.lastFetch     = 0;
    this.fetchInterval = 60_000;
    this.lastSignal    = null;
    this.RELATIONSHIPS = {
      'EURUSD': { DXY: 'up', US10Y: 'up', XAU: 'down' },
      'GBPUSD': { DXY: 'up', US10Y: 'up', XAU: null   },
      'USDJPY': { DXY: 'down', US10Y: 'down', XAU: null },
      'AUDUSD': { DXY: 'up', US10Y: 'up',  XAU: 'down' },
    };
  }

  _seed(indicator, basePrice) {
    const h=[]; let p=basePrice;
    for(let i=0;i<30;i++){ p=p*(1+(Math.random()-0.5)*0.001); h.push(parseFloat(p.toFixed(4))); }
    this.histories[indicator]=h;
  }

  _simulateTick(indicator) {
    const h=this.histories[indicator], cur=h[h.length-1];
    const vol=indicator==='XAU'?0.002:indicator==='US10Y'?0.005:0.001;
    const next=Math.max(0.01,cur*(1+(Math.random()-0.5)*vol));
    h.push(parseFloat(next.toFixed(4)));
    if(h.length>60) h.shift();
    return next;
  }

  async _fetchUS10Y() {
    const key = process.env.ALPHA_VANTAGE_API_KEY;
    if (!key || key === 'your_alpha_vantage_key_here') return null;
    const url = `https://www.alphavantage.co/query?function=TREASURY_YIELD&interval=daily&maturity=10year&apikey=${key}`;
    return new Promise((resolve) => {
      const req = https.get(url, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(raw);
            const data = json['data'];
            if (!data || !Array.isArray(data) || data.length === 0) { resolve(null); return; }
            // data is newest-first: reverse to oldest-first, take last 30, parse as float
            const values = data
              .filter(d => d.value && d.value !== '.')
              .reverse()
              .slice(-30)
              .map(d => parseFloat(parseFloat(d.value).toFixed(4)));
            resolve(values.length > 0 ? values : null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    });
  }

  async _fetchAlphaVantage(symbol, outputKey) {
    const key=process.env.ALPHA_VANTAGE_API_KEY;
    if(!key||key==='your_alpha_vantage_key_here') return null;
    const url=`https://www.alphavantage.co/query?function=TIME_SERIES_INTRADAY&symbol=${symbol}&interval=5min&outputsize=compact&apikey=${key}`;
    return new Promise((resolve)=>{
      const req=https.get(url,(res)=>{
        let raw='';
        res.on('data',c=>raw+=c);
        res.on('end',()=>{
          try { const json=JSON.parse(raw),series=json['Time Series (5min)']; if(!series){resolve(null);return;} resolve(Object.values(series).reverse().slice(-30).map(e=>parseFloat(e[outputKey]))); }
          catch { resolve(null); }
        });
      });
      req.on('error',()=>resolve(null));
      req.setTimeout(8000,()=>{req.destroy();resolve(null);});
    });
  }

  async update() {
    const now=Date.now();
    if(now-this.lastFetch<this.fetchInterval) return;
    this.lastFetch=now;
    const hasKey=process.env.ALPHA_VANTAGE_API_KEY&&process.env.ALPHA_VANTAGE_API_KEY!=='your_alpha_vantage_key_here';
    if(hasKey){
      const [dxy,xau,us10y] = await Promise.all([
        this._fetchAlphaVantage('DX-Y.NYB','4. close'),
        this._fetchAlphaVantage('GLD','4. close'),
        this._fetchUS10Y(),
      ]);
      if(dxy   && dxy.length   > 0) this.histories.DXY   = dxy;   else this._simulateTick('DXY');
      if(xau   && xau.length   > 0) this.histories.XAU   = xau;   else this._simulateTick('XAU');
      if(us10y && us10y.length > 0) this.histories.US10Y = us10y; else this._simulateTick('US10Y');
    } else {
      this._simulateTick('DXY'); this._simulateTick('XAU'); this._simulateTick('US10Y');
    }
  }

  _momentum(indicator, period=10) {
    const h=this.histories[indicator];
    if(h.length<period+1) return {direction:'flat',changePct:0,spike:false};
    const old=h[h.length-1-period], now=h[h.length-1], chg=(now-old)/old;
    const prev=h[h.length-2], barMove=Math.abs((now-prev)/prev);
    const spikeThreshold=indicator==='XAU'?0.008:0.003;
    return { direction:chg>0.0005?'up':chg<-0.0005?'down':'flat', changePct:parseFloat((chg*100).toFixed(3)), spike:barMove>=spikeThreshold, current:now, barMovePct:parseFloat((barMove*100).toFixed(3)) };
  }

  analyse(asset) {
    const cached = this._resultCache[asset];
    if (cached && Date.now() - cached._ts < this._cacheTTL) return cached;
    const norm=asset.replace('/','').replace('_','').toUpperCase();
    const rel=this.RELATIONSHIPS[norm]||this.RELATIONSHIPS['EURUSD'];
    const mom={DXY:this._momentum('DXY',10),XAU:this._momentum('XAU',10),US10Y:this._momentum('US10Y',10)};
    let score=0, spike=false; const notes=[];
    for(const [ind,m] of Object.entries(mom)){
      const bearDir=rel[ind];
      if(!bearDir||m.direction==='flat') continue;
      const isBearish=m.direction===bearDir, weight=ind==='DXY'?2:1;
      if(isBearish){score-=weight;notes.push(`${ind} → BEARISH for ${norm}`);}
      else{score+=weight;notes.push(`${ind} → BULLISH for ${norm}`);}
      if(m.spike){spike=true;notes.push(`⚡ ${ind} SPIKE: ${m.barMovePct}%`);}
    }
    const bias=score>=2?'BULLISH':score<=-2?'BEARISH':'NEUTRAL';
    const earlyExit=spike&&score<=-1;
    const signal = {bias,score,spike,earlyExit,indicators:mom,detail:notes.join(' | '),_ts:Date.now()};
    this.lastSignal          = signal;
    this._resultCache[asset] = signal;  // BUG-41 fix: write to cache so TTL works on next call
    return signal;
  }

  getCurrentValues() {
    return { DXY:this.histories.DXY.at(-1)||null, XAU:this.histories.XAU.at(-1)||null, US10Y:this.histories.US10Y.at(-1)||null };
  }
}

// Item #34: CNN Fear & Greed Index (free public endpoint)
async function fetchFearGreed() {
  return new Promise(resolve => {
    const https = require('https');
    https.get('https://fear-and-greed-index.p.rapidapi.com/v1/fgi', {
      headers: { 'X-RapidAPI-Key': process.env.RAPIDAPI_KEY || '', 'X-RapidAPI-Host': 'fear-and-greed-index.p.rapidapi.com' },
      timeout: 5000
    }, r => {
      let d=''; r.on('data',c=>d+=c);
      r.on('end',()=>{
        try {
          const j = JSON.parse(d);
          const score = j.fgi?.now?.value ?? j.value ?? 50;
          resolve({ score: parseFloat(score), label: score<25?'EXTREME_FEAR':score<45?'FEAR':score<55?'NEUTRAL':score<75?'GREED':'EXTREME_GREED' });
        } catch { resolve({ score: 50, label: 'NEUTRAL' }); }
      });
    }).on('error',()=>resolve({ score:50, label:'NEUTRAL' })).on('timeout',function(){this.destroy();resolve({score:50,label:'NEUTRAL'})});
  });
}

// Item #36: Live OANDA swap rate fetcher
async function fetchOandaSwapRates(asset, apiKey, account) {
  // OANDA provides financing rates via /v3/instruments/{}/financing
  return null;  // stub — implement when OANDA account configured
}

// Item #38: SPX futures as risk-off indicator (via Alpha Vantage)
async function fetchSPXFutures() {
  const avKey = process.env.ALPHA_VANTAGE_API_KEY;
  if (!avKey) return null;
  return new Promise(resolve => {
    const https = require('https');
    const url = `/query?function=GLOBAL_QUOTE&symbol=SPY&apikey=${avKey}`;
    https.get({ host:'www.alphavantage.co', path:url, timeout:5000 }, r=>{
      let d=''; r.on('data',c=>d+=c);
      r.on('end',()=>{
        try {
          const j=JSON.parse(d), q=j['Global Quote'];
          const changePct=parseFloat(q?.['10. change percent']||0);
          resolve({ changePct, riskOff: changePct < -1.0 });
        } catch { resolve(null); }
      });
    }).on('error',()=>resolve(null)).on('timeout',function(){this.destroy();resolve(null)});
  });
}

// Item 9: Cross-asset momentum signal for FX
// Combines SPX direction + US10Y yield direction → risk-on/risk-off overlay
function crossAssetMomentum(spxChangePct, us10yChangePct) {
  // SPX up + yields up = risk-on (buy AUD/JPY, sell USDJPY)
  // SPX down + yields down = risk-off (buy JPY, buy USD)
  const spxSignal  = spxChangePct  > 0.5 ? 1 : spxChangePct  < -0.5 ? -1 : 0;
  const bondSignal = us10yChangePct > 0.05 ? 1 : us10yChangePct < -0.05 ? -1 : 0;
  const combined   = spxSignal * 0.6 + bondSignal * 0.4;
  return {
    spx:      spxSignal,
    bonds:    bondSignal,
    combined: parseFloat(combined.toFixed(2)),
    riskOn:   combined > 0.3,
    riskOff:  combined < -0.3,
  };
}

// Item 80: US 2Y-10Y yield curve slope from FRED
async function fetchYieldCurveSlope() {
  return new Promise(resolve => {
    const https = require('https');
    const today = new Date().toISOString().slice(0,10);
    https.get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=T10Y2Y&vintage_date=${today}`,
      { timeout:8000 }, r => {
      let d=''; r.on('data',c=>d+=c);
      r.on('end',()=>{
        try {
          const lines=d.trim().split('\n'),last=lines.at(-1)?.split(',');
          const spread=parseFloat(last?.[1]||'0');
          resolve({ spread, inverted:spread<0, signal:spread<-0.5?'STRONG_INVERSION':spread<0?'INVERSION':'NORMAL', USDWeak:spread<0 });
        } catch { resolve({ spread:0, signal:'UNKNOWN', inverted:false, USDWeak:false }); }
      });
    }).on('error',()=>resolve(null)).on('timeout',function(){this.destroy();resolve(null)});
  });
}

module.exports = { LeadingIndicatorFetcher };
