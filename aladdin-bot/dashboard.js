'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
//  dashboard.js  —  Aladdin Bot real-time operator dashboard
//  Shows ALL systems: liquidity, calibration, drift, A/B, allocation, price source
// ═══════════════════════════════════════════════════════════════════════════════
const http = require('http');
const { WebSocketServer } = require('ws');
const PORT = parseInt(process.env.DASHBOARD_PORT || 3000);

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sufiyaan Bot — Dashboard</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.0/chart.umd.min.js"><\/script>
<style>
:root{
  --bg:#0d0d0d;--bg2:#111111;--bg3:#181818;--bg4:#1f1f1f;
  --border:#252525;--border2:#303030;
  --gold:#c8922a;--gold-light:#e0a83a;--gold-dim:rgba(200,146,42,.14);
  --text:#d8cfc0;--dim:#6b6358;--faint:#1c1c1c;
  --green:#4caf7d;--red:#e05252;--yellow:#c8a020;
  --blue:#5b8ccc;--cyan:#5ba8b8;--purple:#9b7acc;--orange:#cc7a40;
  --font:'SF Mono',ui-monospace,'Cascadia Code',monospace;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--font);font-size:12px;overflow-x:hidden}
::selection{background:rgba(200,146,42,.22)}

/* ── colour helpers ── */
.g{color:var(--green)}.r{color:var(--red)}.y{color:var(--yellow)}
.b{color:var(--blue)}.c{color:var(--cyan)}.p{color:var(--purple)}
.val{font-weight:600;font-variant-numeric:tabular-nums;text-align:right}
.val.g{color:var(--green)}.val.r{color:var(--red)}.val.y{color:var(--yellow)}
.val.b{color:var(--blue)}.val.c{color:var(--cyan)}.val.p{color:var(--purple)}
.val.sm{font-size:10px;color:var(--dim)}

/* ── badges ── */
.badge{display:inline-block;padding:2px 8px;border-radius:3px;font-size:10px;font-weight:700;letter-spacing:.04em}
.bg{background:rgba(76,175,125,.12);color:var(--green)}
.br{background:rgba(224,82,82,.12);color:var(--red)}
.by{background:rgba(200,160,32,.12);color:var(--yellow)}
.bb{background:rgba(91,140,204,.12);color:var(--blue)}
.bc{background:rgba(91,168,184,.12);color:var(--cyan)}
.bp{background:rgba(155,122,204,.12);color:var(--purple)}
.bo{background:rgba(204,122,64,.12);color:var(--orange)}
.bx{background:rgba(107,99,88,.12);color:var(--dim)}
.badge-gold{background:var(--gold-dim);color:var(--gold);border:1px solid rgba(200,146,42,.28)}

/* ── header ── */
header{
  position:sticky;top:0;z-index:10;
  background:rgba(13,13,13,.96);backdrop-filter:blur(12px);
  border-bottom:1px solid var(--border);
  padding:10px 20px;display:flex;align-items:center;justify-content:space-between;
}
.logo-circle{
  width:30px;height:30px;border-radius:50%;
  background:var(--gold);color:#000;
  display:flex;align-items:center;justify-content:center;
  font-size:14px;font-weight:800;flex-shrink:0;
}
.brand-title{font-size:14px;font-weight:700;letter-spacing:.06em;color:var(--text)}
.hdr-left{display:flex;align-items:center;gap:10px}
.hdr-right{display:flex;align-items:center;gap:12px;font-size:11px;color:var(--dim)}
#dot{width:7px;height:7px;border-radius:50%;background:var(--dim)}
#dot.live{background:var(--gold);box-shadow:0 0 8px var(--gold);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}

/* ── nav / ctrl ── */
.ctrl-strip{
  background:rgba(13,13,13,.92);border-bottom:1px solid var(--border);
  padding:8px 20px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;
}
.ctrl-btn{
  padding:5px 16px;border-radius:4px;border:1px solid var(--border2);
  background:var(--bg3);color:var(--text);font-family:var(--font);
  font-size:11px;cursor:pointer;font-weight:600;letter-spacing:.04em;
  transition:background .15s,border-color .15s;
}
.ctrl-btn:hover{background:var(--bg4);border-color:var(--gold)}
.ctrl-btn:disabled{opacity:.4;cursor:default}
.ctrl-btn-start{border-color:var(--green);color:var(--green)}
.ctrl-btn-start:hover{background:rgba(76,175,125,.15)}
.ctrl-btn-stop{border-color:var(--red);color:var(--red)}
.ctrl-btn-stop:hover{background:rgba(224,82,82,.15)}
.ctrl-btn-bt{border-color:var(--purple);color:var(--purple)}
.ctrl-btn-bt:hover{background:rgba(155,122,204,.15)}
.ctrl-btn-bt.bt-active{background:rgba(155,122,204,.25);animation:pulse 1.5s infinite}
.ctrl-select{
  padding:4px 8px;border-radius:4px;border:1px solid var(--border2);
  background:var(--bg3);color:var(--text);font-family:var(--font);font-size:11px;cursor:pointer;
}
#ctrl-status{font-size:10px;color:var(--dim);margin-left:4px;min-width:120px}

/* ── page layout ── */
.page{padding:14px;display:flex;flex-direction:column;gap:12px}
.stat-row{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.main-row{display:grid;grid-template-columns:1fr 310px;gap:12px;align-items:start}
.left-col{display:flex;flex-direction:column;gap:12px}
.right-col{display:flex;flex-direction:column;gap:12px}
@media(max-width:1100px){.main-row{grid-template-columns:1fr}}
@media(max-width:700px){.stat-row{grid-template-columns:1fr 1fr}}

/* ── card ── */
.card{
  background:var(--bg2);border:1px solid var(--border);border-radius:8px;
  padding:14px;position:relative;overflow:hidden;
}
.card::before{
  content:'';position:absolute;inset:0;border-radius:8px;pointer-events:none;
  background:linear-gradient(135deg,rgba(200,146,42,.025) 0%,transparent 55%);
}
.card-title{
  font-size:9px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;
  color:var(--dim);margin-bottom:10px;display:flex;align-items:center;gap:6px;
}
.card-title .dot,.card-title-dot{width:5px;height:5px;border-radius:50%;background:var(--gold-dim)}

/* ── stat cards ── */
.stat-card{padding:16px}
.stat-label{font-size:9px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);margin-bottom:6px}
.stat-value{font-size:22px;font-weight:700;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1}
.stat-sub{font-size:10px;color:var(--dim);margin-top:3px}

/* ── rows / table ── */
.row{display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--faint)}
.row:last-child{border-bottom:none}
.lbl{color:var(--dim);font-size:11px}
.big{font-size:22px;font-weight:700;letter-spacing:-.02em;line-height:1}
.big-sub{font-size:10px;color:var(--dim);margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:11px}
th{color:var(--dim);font-weight:600;text-align:left;padding:3px 6px;border-bottom:1px solid var(--border);font-size:10px;letter-spacing:.04em}
td{padding:5px 6px;border-bottom:1px solid var(--faint)}
tr:last-child td{border-bottom:none}
tr:hover td{background:var(--bg3)}

/* ── chart ── */
.chart-wrap{position:relative;height:160px}

/* ── confidence bar ── */
.conf-gauge{height:10px;background:var(--faint);border-radius:5px;overflow:hidden;margin:8px 0}
.conf-fill{height:100%;border-radius:5px;transition:width .5s,background .5s;background:var(--gold)}

/* ── misc bars ── */
.bar-wrap{background:var(--faint);border-radius:2px;height:4px;margin-top:4px;overflow:hidden}
.bar{height:100%;border-radius:2px;transition:width .5s,background .5s}

/* ── live price rows ── */
.price-row{display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--faint)}
.price-row:last-child{border-bottom:none}
.price-pair{color:var(--dim);font-size:11px;font-weight:600}
.price-val{font-size:12px;font-weight:700;font-variant-numeric:tabular-nums}

/* ── AB / alloc ── */
.ab-row{display:grid;grid-template-columns:1fr auto auto auto;gap:6px;align-items:center;padding:4px 0;border-bottom:1px solid var(--faint)}
.ab-row:last-child{border-bottom:none}
.ab-name{font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ab-champ{color:var(--gold);font-size:9px;font-weight:700;letter-spacing:.06em}
.alloc-row{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--faint)}
.alloc-row:last-child{border-bottom:none}
.alloc-name{flex:0 0 90px;font-size:11px;color:var(--dim)}
.alloc-bar-wrap{flex:1;background:var(--faint);border-radius:2px;height:6px}
.alloc-bar{height:100%;border-radius:2px;background:var(--gold);transition:width .5s}
.alloc-pct{flex:0 0 38px;text-align:right;font-size:11px;font-weight:600}

/* ── source pill / ece ── */
.src-pill{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:600;background:var(--bg3);border:1px solid var(--border2)}
.src-dot{width:6px;height:6px;border-radius:50%}
.ece-gauge{position:relative;height:4px;background:var(--faint);border-radius:2px;margin:6px 0 2px}
.ece-fill{position:absolute;left:0;top:0;height:100%;border-radius:2px;transition:width .5s,background .5s}
.ece-labels{display:flex;justify-content:space-between;font-size:9px;color:var(--dim)}
</style>
</head>
<body>

<header>
  <div class="hdr-left">
    <div class="logo-circle">S</div>
    <span class="brand-title">Sufiyaan Bot</span>
    <span class="badge badge-gold">Running</span>
    <span class="badge bx">Paper Mode</span>
    <span id="asset-badge" class="badge bx" style="display:none">—</span>
    <span id="src-pill" class="src-pill" style="display:none"><span class="src-dot" id="src-dot" style="background:var(--dim)"></span><span id="src-text">—</span></span>
  </div>
  <div class="hdr-right">
    <span id="live-clock">—</span>
    <span id="dot"></span>
    <span id="conn-text">Connecting…</span>
    <span id="last-tick" style="display:none">—</span>
  </div>
</header>

<div class="ctrl-strip">
  <button id="btn-start" class="ctrl-btn ctrl-btn-start">&#9654; Start</button>
  <button id="btn-stop"  class="ctrl-btn ctrl-btn-stop">&#9632; Stop</button>
  <select id="pair-select" class="ctrl-select">
    <option value="">&#8212; Select Pair &#8212;</option>
    <option value="EURUSD">EUR/USD</option>
    <option value="GBPUSD">GBP/USD</option>
    <option value="USDJPY">USD/JPY</option>
    <option value="AUDUSD">AUD/USD</option>
    <option value="USDCAD">USD/CAD</option>
    <option value="NZDUSD">NZD/USD</option>
    <option value="AAPL">AAPL</option>
    <option value="TSLA">TSLA</option>
    <option value="SPY">SPY</option>
  </select>
  <button id="btn-backtest" class="ctrl-btn ctrl-btn-bt">&#9889; Backtest</button>
  <span id="ctrl-status"></span>
</div>

<div id="learn-banner" style="display:none;margin:6px 16px 0;padding:10px 14px;background:rgba(155,122,204,.15);border:1px solid rgba(155,122,204,.4);border-radius:6px;font-size:12px;line-height:1.5">
  <span style="color:var(--purple);font-weight:600">&#129302; AI learned a new strategy</span>
  <span id="learn-meta" style="color:var(--dim);margin-left:8px"></span>
  <div id="learn-rec" style="color:var(--text);margin-top:4px"></div>
  <div id="learn-conf" style="color:var(--dim);font-size:11px;margin-top:2px"></div>
</div>

<div class="page">

  <!-- 4 stat cards -->
  <div class="stat-row grid">
    <div class="card stat-card">
      <div class="stat-label">Capital</div>
      <div class="stat-value" id="capital">—</div>
      <div class="stat-sub" id="return-sub">—</div>
    </div>
    <div class="card stat-card">
      <div class="stat-label">Total P&amp;L</div>
      <div class="stat-value" id="total-pnl">—</div>
      <div class="stat-sub" id="total-pnl-sub">since inception</div>
    </div>
    <div class="card stat-card">
      <div class="stat-label">Win Rate</div>
      <div class="stat-value" id="wr-stat">—</div>
      <div class="stat-sub" id="wr-stat-sub">—</div>
    </div>
    <div class="card stat-card">
      <div class="stat-label">Daily P&amp;L</div>
      <div class="stat-value" id="daily-pnl-stat">—</div>
      <div class="stat-sub">today</div>
    </div>
  </div>

  <!-- main 2-col -->
  <div class="main-row">

    <!-- LEFT -->
    <div class="left-col">

      <div class="card">
        <div class="card-title"><span class="dot"></span>Equity Curve</div>
        <div class="chart-wrap"><canvas id="eq-canvas"></canvas></div>
      </div>

      <div class="card">
        <div class="card-title"><span class="dot" id="pos-dot" style="background:var(--dim)"></span>Open Position</div>
        <div id="no-pos" style="color:var(--dim);padding:20px 0;text-align:center;font-size:11px">No open position</div>
        <div id="pos-body" style="display:none">
          <div class="row"><span class="lbl">Asset</span><span class="val" id="p-asset">—</span></div>
          <div class="row"><span class="lbl">Entry</span><span class="val" id="p-entry">—</span></div>
          <div class="row"><span class="lbl">Current</span><span class="val" id="p-price">—</span></div>
          <div class="row"><span class="lbl">Unrealised P&amp;L</span><span class="val" id="p-upnl">—</span></div>
          <div class="row"><span class="lbl">Stop Loss</span><span class="val r" id="p-sl">—</span></div>
          <div class="row"><span class="lbl">Take Profit</span><span class="val g" id="p-tp">—</span></div>
          <div class="row"><span class="lbl">Confidence</span><span class="val" style="color:var(--gold)" id="p-conf">—</span></div>
          <div class="row"><span class="lbl">Regime at entry</span><span class="val sm" id="p-regime">—</span></div>
          <div class="row"><span class="lbl">Fill</span><span class="val sm" id="p-fill">—</span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-title"><span class="dot"></span>Recent Trades</div>
        <table id="trades-table">
          <thead><tr>
            <th>#</th><th>Asset</th><th>Entry</th><th>Exit</th>
            <th>P&amp;L</th><th>%</th><th>Conf</th><th>Regime</th><th>Reason</th><th>Duration</th>
          </tr></thead>
          <tbody id="trades-body"><tr><td colspan="10" style="text-align:center;color:var(--dim);padding:16px">No trades yet</td></tr></tbody>
        </table>
      </div>

    </div>

    <!-- RIGHT SIDEBAR -->
    <div class="right-col">

      <div class="card">
        <div class="card-title"><span class="dot"></span>AI Confidence</div>
        <div class="big" id="conf-score" style="color:var(--gold)">—</div>
        <div class="big-sub" id="conf-label">no prediction</div>
        <div class="conf-gauge"><div class="conf-fill" id="conf-bar" style="width:0%"></div></div>
        <div class="row"><span class="lbl">Signal</span><span class="val" id="conf-signal">—</span></div>
        <div class="row"><span class="lbl">Mode</span><span id="conf-mode">—</span></div>
      </div>

      <div class="card">
        <div class="card-title"><span class="dot"></span>Live Prices</div>
        <div class="price-row"><span class="price-pair">EUR/USD</span><span class="price-val" id="price-EURUSD" style="color:var(--dim)">—</span></div>
        <div class="price-row"><span class="price-pair">GBP/USD</span><span class="price-val" id="price-GBPUSD" style="color:var(--dim)">—</span></div>
        <div class="price-row"><span class="price-pair">USD/JPY</span><span class="price-val" id="price-USDJPY" style="color:var(--dim)">—</span></div>
        <div class="price-row"><span class="price-pair">AUD/USD</span><span class="price-val" id="price-AUDUSD" style="color:var(--dim)">—</span></div>
      </div>

      <div class="card">
        <div class="card-title"><span class="dot"></span>Risk</div>
        <div class="row"><span class="lbl">Peak Capital</span><span class="val" id="peak">—</span></div>
        <div class="row"><span class="lbl">Drawdown</span><span class="val" id="dd">—</span></div>
        <div class="row"><span class="lbl">Spread</span><span class="val" id="spread">—</span></div>
        <div class="bar-wrap"><div class="bar" id="spread-bar"></div></div>
        <div class="row" style="margin-top:6px"><span class="lbl">Slippage</span><span class="val" id="slip">—</span></div>
        <div class="row"><span class="lbl">TP multiplier</span><span class="val" id="tp-mult">—</span></div>
        <div class="row"><span class="lbl">Rejected orders</span><span class="val" id="rejected">—</span></div>
        <div class="row"><span class="lbl">Last rejected</span><span class="val sm" id="last-reject">—</span></div>
      </div>

      <div class="card">
        <div class="card-title"><span class="dot"></span>Performance</div>
        <div class="row"><span class="lbl">Win rate</span><span class="val" id="wr">—</span></div>
        <div class="row"><span class="lbl">Profit factor</span><span class="val" id="pf">—</span></div>
        <div class="row"><span class="lbl">Sharpe</span><span class="val" id="sharpe">—</span></div>
        <div class="row"><span class="lbl">Expectancy</span><span class="val" id="exp">—</span></div>
        <div class="row"><span class="lbl">Max drawdown</span><span class="val" id="mdd">—</span></div>
        <div class="row"><span class="lbl">Total trades</span><span class="val" id="trades">—</span></div>
        <div class="row"><span class="lbl">Wins / Losses</span><span class="val" id="wl">—</span></div>
      </div>

    </div>
  </div>
</div>

<!-- hidden compat: legacy IDs still written by update() -->
<div style="display:none" aria-hidden="true">
  <span id="daily-pnl">—</span>
  <span id="regime-badge">—</span><span id="cross">—</span><span id="vol">—</span>
  <span id="liq-badge">—</span><span id="liq-score">—</span><span id="liq-mult">—</span><span id="liq-session">—</span>
  <div class="bar-wrap"><div class="bar" id="liq-bar" style="width:0%"></div></div>
  <span id="cal-status">—</span><span id="cal-method">—</span><span id="cal-samples">—</span>
  <span id="ece-val">—</span><div class="ece-gauge"><div class="ece-fill" id="ece-bar"></div></div>
  <span id="cal-quality">—</span><div id="regime-ece">—</div>
  <span id="drift-status">—</span><span id="drift-trades">—</span>
  <span id="drift-wr">—</span><span id="drift-pf">—</span><span id="drift-exp">—</span><span id="drift-reason">—</span>
  <div id="ab-list">—</div><span id="ensemble-status">—</span><span id="ens-threshold">—</span><span id="ens-vote">—</span>
  <div id="alloc-list">—</div><span id="alloc-rebal">—</span>
  <span id="ml-trained">—</span><span id="ml-gbm">—</span><span id="ml-seq">—</span>
  <span id="ml-ens">—</span><span id="ml-n">—</span><span id="ml-ver">—</span><span id="ml-oos">—</span>
  <div id="news-list"></div>
  <canvas id="equity-canvas"></canvas>
</div>

<script>
const $ = id => document.getElementById(id);
const fmt$ = v => v == null ? '—' : (v < 0 ? '-$' : '$') + Math.abs(Number(v)).toFixed(2);
const fmtP = v => v == null ? '—' : Number(v).toFixed(2) + '%';
const fmtN = (v, d=4) => v == null ? '—' : Number(v).toFixed(d);
const clr  = v => Number(v) > 0 ? 'g' : Number(v) < 0 ? 'r' : '';
const eqData = [];

const REGIME_CLR = { TRENDING:'bb', WEAK_TREND:'by', RANGING:'by', BEAR:'br', UNKNOWN:'bx' };
const LIQ_CLR   = { DEEP:'bg', NORMAL:'bc', THIN:'by', DRY:'br' };
const LIQ_CLR2  = { DEEP:'var(--green)', NORMAL:'var(--cyan)', THIN:'var(--yellow)', DRY:'var(--red)' };

function badge(text, cls) { return '<span class="badge ' + cls + '">' + (text||'—') + '</span>'; }

/* ── live clock ── */
function updateClock() { const el = $('live-clock'); if (el) el.textContent = new Date().toLocaleTimeString(); }
setInterval(updateClock, 1000);
updateClock();

/* ── Chart.js equity curve ── */
let eqChart = null;
function initChart() {
  const canvas = $('eq-canvas');
  if (!canvas || !window.Chart) return;
  eqChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{ data: [], borderColor: '#c8922a', backgroundColor: 'rgba(200,146,42,.08)',
        borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 300 },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: { display: true, grid: { color: 'rgba(255,255,255,.04)' },
          ticks: { color: '#6b6358', font: { size: 9 }, maxTicksLimit: 4,
            callback: function(v) { return '$' + Number(v).toFixed(0); } } }
      }
    }
  });
}

function drawCurve() {
  if (!eqChart) { initChart(); if (!eqChart) return; }
  eqChart.data.labels = eqData.map(function(_, i) { return i; });
  eqChart.data.datasets[0].data = eqData;
  var last = eqData[eqData.length - 1], first = eqData[0];
  var col = (!last || last >= first) ? '#c8922a' : '#e05252';
  eqChart.data.datasets[0].borderColor = col;
  eqChart.data.datasets[0].backgroundColor = col + '14';
  eqChart.update('none');
}

function update(d) {
  /* ── Header ── */
  $('asset-badge').textContent = d.asset || '—';
  $('last-tick').textContent   = new Date(d.ts).toLocaleTimeString();

  const srcMap = {
    OANDA:'var(--green)', AlphaVantage:'var(--cyan)', seed_no_api:'var(--red)',
    seed:'var(--yellow)', cached:'var(--orange)'
  };
  const srcLabel = d.priceSource || '—';
  const srcColor = srcMap[srcLabel] || 'var(--dim)';
  $('src-dot').style.background = srcColor;
  $('src-text').textContent = srcLabel;

  /* ── Capital ── */
  const cap = Number(d.capital);
  const ini = Number(d.initialCapital) || 10000;
  const ret = (cap - ini) / ini * 100;
  $('capital').textContent    = fmt$(cap);
  $('capital').className      = 'stat-value ' + clr(cap - ini);
  $('return-sub').textContent = (ret >= 0 ? '+' : '') + ret.toFixed(2) + '% total return';

  const totalPnl = cap - ini;
  $('total-pnl').textContent  = fmt$(totalPnl);
  $('total-pnl').className    = 'stat-value ' + clr(totalPnl);
  $('total-pnl-sub').textContent = (ret >= 0 ? '+' : '') + ret.toFixed(2) + '% return';

  $('daily-pnl').textContent      = fmt$(d.dailyPnl);
  $('daily-pnl').className        = 'val ' + clr(d.dailyPnl);
  $('daily-pnl-stat').textContent = fmt$(d.dailyPnl);
  $('daily-pnl-stat').className   = 'stat-value ' + clr(d.dailyPnl);

  $('peak').textContent = fmt$(d.peakCapital);
  const dd = d.maxDrawdown || 0;
  $('dd').textContent = fmtP(-dd);
  $('dd').className   = 'val ' + (dd > 15 ? 'r' : dd > 8 ? 'y' : 'g');

  if (d.equityPoint != null) { eqData.push(d.equityPoint); if (eqData.length > 300) eqData.shift(); }
  drawCurve();

  /* ── Position ── */
  if (d.position) {
    $('no-pos').style.display   = 'none';
    $('pos-body').style.display = '';
    $('pos-dot').style.background = 'var(--gold)';
    $('p-asset').textContent  = d.asset || '—';
    $('p-entry').textContent  = fmtN(d.position.entry, 5);
    $('p-price').textContent  = fmtN(d.marketPrice, 5);
    const isShortPos = d.position.side === 'SHORT';
    const upnl = isShortPos
      ? d.position.shares * ((d.position.entry||0) - (d.marketPrice||0))
      : d.position.shares * ((d.marketPrice||0) - (d.position.entry||0));
    $('p-upnl').textContent = fmt$(upnl);
    $('p-upnl').className   = 'val ' + clr(upnl);
    $('p-sl').textContent   = fmtN(d.position.stopLoss, 5);
    $('p-tp').textContent   = fmtN(d.position.takeProfit, 5);
    $('p-conf').textContent = d.position.confidence ? d.position.confidence + '%' : '—';
    $('p-regime').textContent = d.position.regime || '—';
    $('p-fill').textContent   = d.position.fillSummary || '—';
  } else {
    $('no-pos').style.display   = '';
    $('pos-body').style.display = 'none';
    $('pos-dot').style.background = 'var(--dim)';
  }

  /* ── Performance ── */
  const m = d.metrics || {};
  $('wr').textContent       = m.winRate  != null ? fmtP(m.winRate) : '—';
  $('wr').className         = 'val ' + (m.winRate > 55 ? 'g' : m.winRate > 40 ? 'y' : 'r');
  $('wr-stat').textContent  = m.winRate  != null ? fmtP(m.winRate) : '—';
  $('wr-stat').className    = 'stat-value ' + (m.winRate > 55 ? 'g' : m.winRate > 40 ? 'y' : 'r');
  $('wr-stat-sub').textContent = m.trades ? m.trades + ' trades' : '—';
  $('pf').textContent       = m.pf != null ? fmtN(m.pf, 3) : '—';
  $('pf').className         = 'val ' + (m.pf > 1.5 ? 'g' : m.pf > 1 ? 'y' : 'r');
  $('sharpe').textContent   = m.sharpe != null ? fmtN(m.sharpe, 3) : '—';
  $('sharpe').className     = 'val ' + (m.sharpe > 1 ? 'g' : m.sharpe > 0 ? 'y' : 'r');
  $('exp').textContent      = m.expectancy != null ? fmt$(m.expectancy) : '—';
  $('exp').className        = 'val ' + clr(m.expectancy);
  $('mdd').textContent      = m.maxDrawdown != null ? fmtP(-m.maxDrawdown) : '—';
  $('mdd').className        = 'val ' + (m.maxDrawdown > 15 ? 'r' : m.maxDrawdown > 8 ? 'y' : 'g');
  $('trades').textContent   = m.trades ?? '—';
  $('wl').textContent       = m.wins != null ? m.wins + 'W / ' + m.losses + 'L' : '—';

  /* ── Regime ── */
  $('regime-badge').innerHTML = badge(d.marketRegime, REGIME_CLR[d.marketRegime] || 'bx');
  $('cross').innerHTML = d.goldenCross == null ? '—' : d.goldenCross
    ? badge('BULL ▲', 'bg') : badge('BEAR ▼', 'br');
  $('vol').textContent = d.volatilityLevel || '—';
  $('vol').className   = 'val ' + (d.volatilityLevel === 'HIGH' ? 'y' : d.volatilityLevel === 'LOW' ? 'c' : '');

  /* ── Liquidity ── */
  const liq = d.liquidity || {};
  $('liq-badge').innerHTML   = badge(liq.regime, LIQ_CLR[liq.regime] || 'bx');
  $('liq-score').textContent = liq.score != null ? liq.score + '/100' : '—';
  $('liq-score').className   = 'val ' + (liq.score > 70 ? 'g' : liq.score > 40 ? 'y' : 'r');
  $('liq-mult').textContent  = liq.multiplier != null ? '×' + liq.multiplier.toFixed(2) : '—';
  $('liq-session').textContent = liq.session || '—';
  const lb = $('liq-bar');
  lb.style.width      = (liq.score || 0) + '%';
  lb.style.background = LIQ_CLR2[liq.regime] || 'var(--dim)';

  /* ── Calibration ── */
  const cal = d.calibration || {};
  $('cal-status').innerHTML    = cal.isActive ? badge('ACTIVE', 'bg') : badge('WARMING UP', 'bx');
  $('cal-method').textContent  = cal.method || '—';
  $('cal-samples').textContent = cal.totalSamples != null ? cal.totalSamples + ' / ' + cal.minSamplesRequired : '—';
  const ece = cal.globalECE;
  $('ece-val').textContent = ece != null ? ece.toFixed(4) : '—';
  $('ece-val').className   = 'val ' + (ece != null ? (ece < 0.05 ? 'g' : ece < 0.10 ? 'y' : 'r') : '');
  const ecePct = ece != null ? Math.min(100, ece / 0.25 * 100) : 0;
  const eceBar = $('ece-bar');
  eceBar.style.width      = ecePct + '%';
  eceBar.style.background = ece < 0.05 ? 'var(--green)' : ece < 0.10 ? 'var(--yellow)' : 'var(--red)';
  const qualMap = { excellent:'bg', good:'bc', moderate:'by', poor:'br', insufficient_data:'bx' };
  $('cal-quality').innerHTML = cal.calibrationQuality ? badge(cal.calibrationQuality.replace('_',' ').toUpperCase(), qualMap[cal.calibrationQuality] || 'bx') : '—';
  const rs = cal.regimeStats || {};
  $('regime-ece').innerHTML = Object.entries(rs).filter(function(_ref) { return _ref[1].samples > 0; }).map(function(_ref2) {
    var r = _ref2[0], v = _ref2[1];
    return '<div class="row"><span class="lbl">' + r + '</span><span class="val sm">' +
      v.samples + ' trades, ECE ' + (v.ece != null ? v.ece.toFixed(4) : 'n/a') + '</span></div>';
  }).join('') || '<span style="color:var(--dim);font-size:11px">No regime data yet</span>';

  /* ── Drift Monitor ── */
  const dr = d.drift || {};
  $('drift-status').innerHTML   = dr.halted ? badge('HALTED ⛔', 'br') : dr.active ? badge('MONITORING', 'bg') : badge('INACTIVE', 'bx');
  $('drift-trades').textContent = dr.liveTrades != null ? dr.liveTrades : '—';
  $('drift-wr').textContent  = dr.wrDelta  != null ? (dr.wrDelta  >= 0 ? '+' : '') + dr.wrDelta.toFixed(1)  + 'pp' : '—';
  $('drift-wr').className    = 'val ' + (dr.wrDelta  < -10 ? 'r' : dr.wrDelta  < 0 ? 'y' : 'g');
  $('drift-pf').textContent  = dr.pfDelta  != null ? (dr.pfDelta  >= 0 ? '+' : '') + dr.pfDelta.toFixed(3)  : '—';
  $('drift-pf').className    = 'val ' + (dr.pfDelta  < -0.3 ? 'r' : dr.pfDelta  < 0 ? 'y' : 'g');
  $('drift-exp').textContent = dr.expDelta != null ? (dr.expDelta >= 0 ? '+$' : '-$') + Math.abs(dr.expDelta).toFixed(2) : '—';
  $('drift-exp').className   = 'val ' + clr(dr.expDelta);
  $('drift-reason').textContent = dr.haltReason || (dr.halted ? 'see logs' : '—');

  /* ── A/B Tester ── */
  const ab = d.abTest || {};
  const contestants = ab.contestants || [];
  $('ab-list').innerHTML = contestants.length ? contestants.map(function(c) {
    const isChamp = c.id === ab.championId;
    const wrCls   = c.winRate > 55 ? 'g' : c.winRate > 40 ? 'y' : 'r';
    return '<div class="ab-row">' +
      '<span class="ab-name">' + (isChamp ? '<span class="ab-champ">★ </span>' : '') + c.id + '</span>' +
      '<span class="val ' + wrCls + '">' + (c.winRate != null ? c.winRate.toFixed(1) + '%' : '—') + '</span>' +
      '<span class="val" style="color:var(--dim)">' + (c.pf != null ? 'PF ' + c.pf.toFixed(2) : '—') + '</span>' +
      '<span class="val sm">' + (c.trades ?? 0) + 'T</span>' +
      '</div>';
  }).join('') : '<span style="color:var(--dim);font-size:11px">No A/B data yet</span>';
  $('ensemble-status').innerHTML = ab.ensembleEnabled ? badge('ON', 'bg') : badge('OFF', 'bx');
  $('ens-threshold').textContent = ab.ensembleThreshold ?? '—';
  $('ens-vote').textContent = ab.lastVote ? ab.lastVote.action + ' (' + (ab.lastVote.score ?? 0) + ')' : '—';

  /* ── Capital Allocation ── */
  const alloc = d.allocation || {};
  const slots = alloc.slots || [];
  const totalCap = slots.reduce(function(s, sl) { return s + (sl.allocated || 0); }, 0) || 1;
  $('alloc-list').innerHTML = slots.length ? slots.map(function(sl) {
    const pct = (sl.allocated / totalCap * 100) || 0;
    return '<div class="alloc-row">' +
      '<span class="alloc-name">' + sl.id + '</span>' +
      '<div class="alloc-bar-wrap"><div class="alloc-bar" style="width:' + pct.toFixed(1) + '%"></div></div>' +
      '<span class="alloc-pct">' + pct.toFixed(0) + '%</span>' +
      '</div>';
  }).join('') : '<span style="color:var(--dim);font-size:11px">No allocation data</span>';
  $('alloc-rebal').textContent = alloc.rebalanceCount ?? '—';

  /* ── ML ── */
  const ml = d.mlStats || {};
  $('ml-trained').innerHTML = ml.trained ? badge('TRAINED', 'bg') : badge('UNTRAINED', 'bx');
  $('ml-gbm').textContent   = ml.gbmAcc != null ? ml.gbmAcc + '%' : '—';
  $('ml-seq').textContent   = ml.seqAcc != null ? ml.seqAcc + '%' : '—';
  $('ml-ens').textContent   = ml.ensAcc != null ? ml.ensAcc + '%' : '—';
  $('ml-n').textContent     = ml.trainSamples ?? '—';
  $('ml-ver').textContent   = ml.version ?? '—';
  const oos = d.mlOOS || {};
  $('ml-oos').textContent = oos.accuracy != null ? oos.accuracy + '% (' + (oos.grade || '?') + ')' : '—';
  $('ml-oos').className   = 'val ' + (oos.accuracy > 55 ? 'g' : oos.accuracy > 50 ? 'y' : 'r');

  /* ── ML Signal Confidence ── */
  const confScore = d.mlConfidenceScore;
  const confEl = $('conf-score');
  if (confScore != null) {
    confEl.textContent = confScore.toFixed(1) + '%';
    confEl.className   = 'big';
    confEl.style.color = 'var(--gold)';
    $('conf-label').textContent = 'confidence';
    const cb = $('conf-bar');
    cb.style.width      = Math.min(100, confScore) + '%';
    cb.style.background = confScore > 70 ? 'var(--gold)' : confScore > 55 ? 'var(--yellow)' : 'var(--red)';
  } else {
    confEl.textContent = '—';
    confEl.className   = 'big';
    confEl.style.color = 'var(--gold)';
    $('conf-label').textContent = 'no prediction';
    $('conf-bar').style.width = '0%';
  }
  const sig = d.mlSignal;
  $('conf-signal').textContent = sig || '—';
  $('conf-signal').className   = 'val ' + (sig === 'BUY' ? 'g' : sig === 'SELL' ? 'r' : '');
  $('conf-mode').innerHTML = d.backtestMode ? badge('BACKTEST', 'bp') : badge('LIVE', 'bg');

  /* ── Learned strategy banner ── */
  var ls = d.learnedStrategy;
  if (ls && ls.generatedAt) {
    var banner   = $('learn-banner');
    var metaEl   = $('learn-meta');
    var recEl    = $('learn-rec');
    var confEl2  = $('learn-conf');
    if (banner && banner.getAttribute('data-at') !== ls.generatedAt) {
      banner.setAttribute('data-at', ls.generatedAt);
      banner.style.display = 'block';
      if (metaEl) metaEl.textContent = ls.tradeCount + ' trades | ' + ls.winRate + '% win rate | minConf → ' + ls.learnedMinConfidence;
      if (recEl)  recEl.textContent  = ls.recommendation || '';
      if (confEl2) confEl2.textContent = 'Bias: ' + (ls.strategyBias || '—') + ' | Win avg conf: ' + (ls.avgWinningConfidence || '—') + ' | Loss avg conf: ' + (ls.avgLosingConfidence || '—');
    }
  }

  /* ── Engine status → ctrl-status ── */
  if (d.engineStatus) {
    var cstEl = $('ctrl-status');
    if (cstEl) {
      var txt = cstEl.textContent;
      // Only auto-update when it shows a transient/stale state
      if (txt === 'Starting…' || txt === 'Connected' || txt === 'Idle' || txt === '') {
        if (d.engineStatus === 'RUNNING') {
          setCtrlStatus('Running', 'var(--green)');
        } else if (d.engineStatus === 'HALTED') {
          setCtrlStatus('HALTED', 'var(--red)');
        } else if (d.engineStatus === 'CIRCUIT_BREAKER') {
          setCtrlStatus('Circuit Breaker', 'var(--red)');
        } else if (d.engineStatus === 'IDLE') {
          setCtrlStatus('Idle', 'var(--dim)');
        }
      }
    }
  }

  /* Sync pair selector with active asset */
  const pairSel = $('pair-select');
  if (d.asset && pairSel.value !== d.asset) pairSel.value = d.asset;

  /* ── Live Prices ── */
  ['EURUSD','GBPUSD','USDJPY','AUDUSD'].forEach(function(p) {
    const el = $('price-' + p);
    if (!el) return;
    if (d.asset === p && d.marketPrice) {
      el.textContent  = fmtN(d.marketPrice, 5);
      el.style.color  = 'var(--text)';
    } else {
      el.style.color  = 'var(--dim)';
    }
  });

  /* ── Execution ── */
  const sp = d.spread || {};
  $('spread').textContent = sp.pips != null ? sp.pips.toFixed(2) + ' pips' : '—';
  $('spread').className   = 'val ' + (sp.fraction > 0.0005 ? 'r' : sp.fraction > 0.0003 ? 'y' : 'g');
  const sb = $('spread-bar');
  sb.style.width      = sp.fraction != null ? Math.min(100, sp.fraction / 0.001 * 100) + '%' : '0%';
  sb.style.background = sp.fraction > 0.0005 ? 'var(--red)' : sp.fraction > 0.0003 ? 'var(--yellow)' : 'var(--gold)';
  $('slip').textContent     = d.dynamicSlippage != null ? (d.dynamicSlippage * 10000).toFixed(2) + ' bps' : '—';
  $('tp-mult').textContent  = d.tpMultiplier != null ? d.tpMultiplier.toFixed(2) + '×' : '—';
  $('rejected').textContent = d.rejectedOrders ?? '—';
  $('last-reject').textContent = d.lastRejectedReason || '—';

  /* ── Trades ── */
  const trades = d.recentTrades || [];
  if (trades.length) {
    $('trades-body').innerHTML = trades.slice(-15).reverse().map(function(t, i) {
      const cls = t.profit > 0 ? 'g' : 'r';
      const dur = t.duration ? Math.round(t.duration / 60000) + 'm' : '—';
      return '<tr>' +
        '<td style="color:var(--dim)">' + (trades.length - i) + '</td>' +
        '<td>' + (t.asset || '—') + '</td>' +
        '<td>' + fmtN(t.entry, 5) + '</td>' +
        '<td>' + fmtN(t.exit, 5) + '</td>' +
        '<td class="' + cls + '">' + (t.profit >= 0 ? '+' : '') + fmt$(t.profit) + '</td>' +
        '<td class="' + cls + '">' + (t.profitPercent != null ? (t.profitPercent >= 0 ? '+' : '') + fmtN(t.profitPercent, 2) + '%' : '—') + '</td>' +
        '<td>' + (t.confidence ? t.confidence + '%' : '—') + '</td>' +
        '<td>' + (t.regime || t.volatilityLevel || '—') + '</td>' +
        '<td style="font-size:10px;color:var(--dim)">' + (t.reason || '—') + '</td>' +
        '<td style="color:var(--dim)">' + dur + '</td>' +
        '</tr>';
    }).join('');
  }
}

/* ── WebSocket ── */
let ws, rtimer;

function sendCmd(payload) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  } else {
    setCtrlStatus('Not connected', 'var(--red)');
  }
}

function setCtrlStatus(msg, color) {
  const el = $('ctrl-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = color || 'var(--dim)';
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host);
  ws.onopen    = function() { $('dot').className = 'live'; $('conn-text').textContent = 'Live'; clearTimeout(rtimer); setCtrlStatus('Connected', 'var(--gold)'); };
  ws.onmessage = function(e) { try { update(JSON.parse(e.data)); } catch(_){} };
  ws.onclose   = function() { $('dot').className = ''; $('conn-text').textContent = 'Reconnecting…'; rtimer = setTimeout(connect, 3000); setCtrlStatus('Reconnecting…', 'var(--yellow)'); };
  ws.onerror   = function() { ws.close(); };
}
connect();

/* ── Control button handlers ── */
document.addEventListener('DOMContentLoaded', function() {
  const btnStart    = $('btn-start');
  const btnStop     = $('btn-stop');
  const pairSelect  = $('pair-select');
  const btnBacktest = $('btn-backtest');

  btnStart.addEventListener('click', function() {
    sendCmd({ cmd: 'start' });
    setCtrlStatus('Starting…', 'var(--green)');
  });

  btnStop.addEventListener('click', function() {
    sendCmd({ cmd: 'stop' });
    setCtrlStatus('Stopping…', 'var(--red)');
  });

  pairSelect.addEventListener('change', function() {
    const pair = pairSelect.value;
    if (pair) {
      sendCmd({ cmd: 'setPair', pair });
      setCtrlStatus('Switching to ' + pair + '…', 'var(--cyan)');
    }
  });

  btnBacktest.addEventListener('click', function() {
    sendCmd({ cmd: 'backtest' });
    btnBacktest.classList.add('bt-active');
    setCtrlStatus('Backtest running…', 'var(--purple)');
  });
});
window.addEventListener('resize', drawCurve);
<\/script>
</body>
</html>`;

// ── Dashboard server ──────────────────────────────────────────────────────────
const { ipFilter: _dashIpFilter } = require('./ip-filter');
const _dashRateMap = new Map();
function _dashRateCheck(req, res) {
  const ip  = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const w   = _dashRateMap.get(ip) || { count: 0, start: now };
  if (now - w.start > 60_000) { w.count = 0; w.start = now; }
  w.count++;
  _dashRateMap.set(ip, w);
  if (w.count > 120) {   // 120 req/min — generous for dashboard polling
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Too Many Requests' }));
    return false;
  }
  return true;
}

class Dashboard {
  constructor(engine = null, port = PORT) {
    this.engine      = engine;
    this.port        = port;
    this.clients     = new Set();
    this.server      = null;
    this.wss         = null;
    this.pushTimer   = null;
    this.peakCapital    = engine?.initialCapital || 10_000;
    this.rejectedOrders = 0;
  }

  start() {
    const _allowedDashIPs = process.env.DASHBOARD_ALLOWED_IPS ? process.env.DASHBOARD_ALLOWED_IPS.split(',') : null;
    const _dashFilter = _dashIpFilter(_allowedDashIPs);
    this.server = http.createServer((req, res) => {
      if (!_dashRateCheck(req, res)) return;
      if (_allowedDashIPs && !_dashFilter(req, res)) return;
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', clients: this.clients.size }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
    });
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', ws => {
      this.clients.add(ws);
      ws.send(JSON.stringify(this._snapshot()));
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        const e = this.engine;
        if (!e) return;
        switch (msg.cmd) {
          case 'start':
            if (e.isRunning) {
              // Already running — just push current state so client clears "Starting…"
              break;
            }
            if (typeof e.start === 'function') {
              e.start();
            } else if (typeof e.runTradingLoop === 'function') {
              e.runTradingLoop().catch(err =>
                console.error('[Dashboard] Engine start error:', err.message)
              );
            } else {
              e.isRunning = true;
              e.halted    = false;
            }
            break;
          case 'stop':
            if (typeof e.stop === 'function') {
              e.stop();
            } else {
              e.isRunning = false;
              e.halted    = true;
            }
            break;
          case 'setPair':
            if (msg.pair) {
              if (typeof e.selectAsset === 'function') {
                e.selectAsset(msg.pair);
              } else {
                e.selectedAsset = msg.pair;
              }
            }
            break;
          case 'backtest':
            if (typeof e.runBacktest === 'function') {
              Promise.resolve(e.runBacktest()).catch(err =>
                console.error('[Dashboard] Backtest error:', err.message)
              );
            }
            break;
        }
        this.push();
      });
    });
    this.server.listen(this.port, () =>
      console.log(`[Dashboard] ✅  http://localhost:${this.port}`));
    this.pushTimer = setInterval(() => this.push(), 2000);
    return this;
  }

  stop() { clearInterval(this.pushTimer); this.clients.forEach(ws => ws.close()); this.server?.close(); }
  attach(engine) { this.engine = engine; this.peakCapital = engine.capital || engine.initialCapital; engine.on('priceUpdate', () => this.push()); return this; }
  push() {
    if (!this.clients.size) return;
    const data = JSON.stringify(this._snapshot());
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(data);
  }

  _snapshot() {
    const e = this.engine;
    if (!e) return { _demo: true, ts: Date.now(), capital: 10000, initialCapital: 10000 };

    const cap   = e.capital || 0;
    const ini   = e.initialCapital || 10000;
    if (cap > this.peakCapital) this.peakCapital = cap;
    if (e.lastRejectedOrder) this.rejectedOrders++;

    const trades  = e.trades || [];
    const wins    = trades.filter(t => t.profit > 0);
    const losses  = trades.filter(t => t.profit <= 0);
    const gp      = wins.reduce((s,t) => s + t.profit, 0);
    const gl      = Math.abs(losses.reduce((s,t) => s + t.profit, 0));
    const wr      = trades.length ? wins.length / trades.length * 100 : 0;
    const pf      = gl > 0 ? gp / gl : gp > 0 ? 9.99 : 0;
    const avgW    = wins.length   ? gp / wins.length   : 0;
    const avgL    = losses.length ? gl / losses.length : 0;
    const exp     = avgW * (wr/100) - avgL * (1 - wr/100);
    const price   = e.priceHistory?.at(-1) || 0;
    const equity  = cap + (e.position ? e.position.shares * price : 0);

    // ── Drift monitor ────────────────────────────────────────────────────
    const driftStatus  = e.driftMonitor?.status?.() || {};
    // BUG-76 fix: status() returns .live and .benchmark, not .liveMetrics/.benchmarkMetrics
    // Also no .active field — use !.halted as the active indicator
    const driftMetrics = driftStatus.live      || {};
    const benchMetrics = driftStatus.benchmark || {};
    const drift = {
      active:     !driftStatus.halted && !!driftStatus.benchmarkSource,
      halted:     driftStatus.halted,
      liveTrades: driftMetrics.trades,
      haltReason: driftStatus.haltReason,
      wrDelta:    (driftMetrics.winRate != null && benchMetrics.winRate != null)
        ? driftMetrics.winRate - benchMetrics.winRate : null,
      pfDelta:    (driftMetrics.profitFactor != null && benchMetrics.profitFactor != null)
        ? driftMetrics.profitFactor - benchMetrics.profitFactor : null,
      expDelta:   (driftMetrics.expectancy != null && benchMetrics.expectancy != null)
        ? driftMetrics.expectancy - benchMetrics.expectancy : null,
    };

    // ── A/B tester ───────────────────────────────────────────────────────
    const abStatus = e.abTester?.status?.() || {};
    const contestants = abStatus.contestants
      ? Object.entries(abStatus.contestants).map(([id, c]) => ({
          id, trades: c.trades, winRate: c.winRate, pf: c.profitFactor,
        })).sort((a,b) => (b.winRate||0) - (a.winRate||0))
      : [];
    const abTest = {
      championId:       e.abTester?.championId,
      contestants,
      ensembleEnabled:  abStatus.ensembleEnabled,
      ensembleThreshold: abStatus.ensembleThreshold,
      lastVote:         abStatus.lastDecision,
    };

    // ── Capital allocation ────────────────────────────────────────────────
    const allocStatus = e.capitalAllocator?.status?.() || {};
    const slots = allocStatus.slots
      ? Object.entries(allocStatus.slots).map(([id, s]) => ({ id, allocated: s.allocated, trades: s.trades }))
      : [];
    const allocation = { slots, rebalanceCount: allocStatus.rebalanceCount };

    // ── Liquidity ─────────────────────────────────────────────────────────
    const liqStatus  = e.liquidityScorer?.status?.() || {};
    const lastComp   = e.liquidityScorer?.lastResult?.components || {};
    const sessionBonus = lastComp.session;
    const sessionLabel = sessionBonus > 10 ? 'London+NY overlap ▲'
      : sessionBonus > 0  ? 'Active session ↑'
      : sessionBonus < -10 ? 'Off-hours ▼'
      : sessionBonus < 0  ? 'Asian session ↓' : 'Normal';
    const liquidity = {
      score:      liqStatus.lastScore,
      regime:     liqStatus.lastRegime,
      multiplier: liqStatus.lastMultiplier,
      session:    sessionLabel,
    };

    // ── Calibration ───────────────────────────────────────────────────────
    const calStatus  = e.mlConfidence?.calibrator?.status?.() || {};
    const lastCalib  = e.mlConfidence?.calibrator?.lastResult;
    const calibration = {
      ...calStatus,
      method: lastCalib?.method,
    };

    // ── Price source ─────────────────────────────────────────────────────
    const priceCache = e.marketData?.prices?.[e.selectedAsset] || {};
    const priceSource = (priceCache.source || 'unknown').replace('_cached', '');

    return {
      ts:            Date.now(),
      asset:         e.selectedAsset,
      priceSource,
      capital:       cap,
      initialCapital: ini,
      dailyPnl:      cap - (e.dailyStartCapital || ini),
      peakCapital:   this.peakCapital,
      equityPoint:   equity,
      marketPrice:   price,
      maxDrawdown:   e.maxDrawdown || 0,
      position:      e.position,
      marketRegime:  e.lastMarketRegime,
      goldenCross:   e.lastGoldenCross,
      volatilityLevel: e.volatilityLevel,
      dynamicSlippage: e.dynamicSlippage,
      tpMultiplier:  e.dynamicTpMultiplier,
      spread:        { fraction: e.avgSpread, pips: e.avgSpread ? e.avgSpread * price * 10000 : 0 },
      rejectedOrders:    this.rejectedOrders,
      lastRejectedReason: e.lastRejectedOrder?.reason,
      metrics:       { trades: trades.length, wins: wins.length, losses: losses.length, winRate: wr, pf, expectancy: exp, maxDrawdown: e.maxDrawdown || 0, sharpe: 0 },
      recentTrades:  trades.slice(-15),
      // ── backward-compat fields ──────────────────────────────────────────
      totalReturn:   (cap - ini) / ini * 100,
      selectedAsset: e.selectedAsset,
      newsStatus:    e.newsFilter?.status?.() || {},
      liquidity,
      calibration,
      drift,
      abTest,
      allocation,
      mlStats:           e.mlConfidence?.getStats?.() || {},
      mlOOS:             e.mlConfidence?.validateOOS?.({ splitRatio: 0.70, embargoBars: 10 }) || {},
      mlConfidenceScore: e.lastMlConfidence ?? e.lastSignalConfidence ?? e.position?.confidence ?? null,
      mlSignal:          e.lastSignal || e.lastMlSignal || null,
      backtestMode:      e.backtestMode || false,
      learnedStrategy:   e._lastLearnedConfig || null,
      isRunning:         !!e.isRunning,
      engineStatus:      e.globalHaltTripped ? 'HALTED'
                       : e.circuitBreakerTripped ? 'CIRCUIT_BREAKER'
                       : e.isRunning ? 'RUNNING' : 'IDLE',
    };
  }
}

module.exports = { Dashboard };

if (require.main === module) {
  new Dashboard(null, PORT).start();
  console.log('[Dashboard] Demo mode — no engine attached');
}
