'use strict';
// ── metrics-server.js ─────────────────────────────────────────────────────────
// Prometheus-compatible metrics HTTP server + Sentry error tracking wrapper.
//
// Exposes /metrics on port 9090 (configurable via METRICS_PORT env var).
// Grafana can scrape this endpoint via Prometheus data source.
//
// Also wraps global error handlers to forward to Sentry DSN if configured.
//
// Usage:
//   const { MetricsServer } = require('./metrics-server');
//   const metrics = new MetricsServer(engine);
//   metrics.start();
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');

const { ipFilter }   = require('./ip-filter');
const _rateWindows   = new Map();   // ip → { count, windowStart }
const RATE_LIMIT     = 60;          // requests per window
const RATE_WINDOW_MS = 60_000;      // 1 minute window

function rateLimitCheck(req, res) {
  const ip  = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const win = _rateWindows.get(ip) || { count: 0, windowStart: now };
  if (now - win.windowStart > RATE_WINDOW_MS) { win.count = 0; win.windowStart = now; }
  win.count++;
  _rateWindows.set(ip, win);
  if (win.count > RATE_LIMIT) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
    res.end(JSON.stringify({ error: 'Too Many Requests' }));
    return false;
  }
  return true;
}

class MetricsServer {
  constructor(engine) {
    this.engine  = engine;
    this.port    = parseInt(process.env.METRICS_PORT || '9090');
    this._server = null;
    this._sentryDsn = process.env.SENTRY_DSN || null;
    this._errors = [];   // recent errors for /metrics
  }

  // ── Start the metrics HTTP server ─────────────────────────────────────────
  // Item 28: Push metrics to Prometheus Pushgateway
  async pushToGateway(gatewayUrl, jobName = 'aladdin_bot') {
    if (!gatewayUrl) return;
    const engine = this._engine;
    const lines  = [
      `# TYPE aladdin_capital gauge`,
      `aladdin_capital ${engine?.capital || 0}`,
      `# TYPE aladdin_drawdown gauge`,
      `aladdin_drawdown ${engine && engine.initialCapital ? ((engine.initialCapital - engine.capital)/engine.initialCapital*100) : 0}`,
    ].join('\n') + '\n';
    try {
      const url  = new URL(`${gatewayUrl}/metrics/job/${jobName}`);
      const http = url.protocol === 'https:' ? require('https') : require('http');
      await new Promise((res,rej)=>{
        const req = http.request({ host:url.hostname, port:url.port, path:url.pathname, method:'POST',
          headers:{'Content-Type':'text/plain; version=0.0.4','Content-Length':Buffer.byteLength(lines)} }, r=>{res(r.statusCode);});
        req.on('error',rej); req.write(lines); req.end();
      });
    } catch(e) { console.warn('[Push #28] Gateway push failed:', e.message); }
  }

  start() {
    let allowedIPs = process.env.METRICS_ALLOWED_IPS ? process.env.METRICS_ALLOWED_IPS.split(',') : null;
    // #78: Warn operators when metrics endpoint is open to all IPs
    // Fix #87: Default to localhost-only; require explicit opt-in for remote access
    if (!allowedIPs) {
      console.warn('[MetricsServer #87] METRICS_ALLOWED_IPS not set — defaulting to localhost-only (127.0.0.1)');
      allowedIPs = ['127.0.0.1', '::1'];  // localhost only by default
    }
    const _ipFilter = ipFilter(allowedIPs);
    this._server = http.createServer((req, res) => {
      if (!rateLimitCheck(req, res)) return;
      if (allowedIPs && !_ipFilter(req, res)) return;

      if (req.url === '/account') {
        const { OandaReadonlyClient } = require('./readonly-key-proxy');
        const client = new OandaReadonlyClient();
        client.getAccountSummary()
          .then(summary => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(summary)); })
          .catch(e    => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); });
        return;
      }
      if (req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        res.end(this._collect());
      } else if (req.url === '/health') {
        const ok = this.engine && !this.engine.globalHaltTripped && !this.engine.circuitBreakerTripped;
        res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: ok ? 'ok' : 'degraded', ts: new Date().toISOString() }));
      } else {
        res.writeHead(404); res.end();
      }
    });
    this._server.listen(this.port, () => {
      console.log('[Metrics] Prometheus endpoint: http://localhost:' + this.port + '/metrics');
    });
    this._server.on('error', (e) => console.warn('[Metrics] Server error:', e.message));
    this._initSentry();
    return this;
  }

  stop() { if (this._server) this._server.close(); }

  // ── Collect Prometheus text format ───────────────────────────────────────
  _collect() {
    const e = this.engine;
    if (!e) return '# no engine\n';

    const g = (name, help, value) =>
      `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}\n`;

    // Item #54: Histogram helper — emits p50/p95/p99 quantiles for Grafana
    const hist = (name, help, values) => {
      if (!values || !values.length) return '';
      const sorted = [...values].sort((a, b) => a - b);
      const pct = (q) => sorted[Math.floor(sorted.length * q)] || 0;
      return `# HELP ${name} ${help}\n# TYPE ${name} summary\n` +
        `${name}{quantile="0.5"} ${pct(0.50).toFixed(4)}\n` +
        `${name}{quantile="0.95"} ${pct(0.95).toFixed(4)}\n` +
        `${name}{quantile="0.99"} ${pct(0.99).toFixed(4)}\n` +
        `${name}_count ${sorted.length}\n`;
    };

    const lines = [
      g('aladdin_capital',          'Current capital in USD',       e.capital || 0),
      g('aladdin_trades_total',     'Total closed trades',          e.trades?.length || 0),
      g('aladdin_wins_total',       'Total winning trades',         e.wins || 0),
      g('aladdin_losses_total',     'Total losing trades',          e.losses || 0),
      g('aladdin_win_rate',         'Win rate (0-1)',                e.trades?.length > 0 ? (e.wins / e.trades.length) : 0),
      g('aladdin_consecutive_losses','Current consecutive losses',  e.consecutiveLosses || 0),
      g('aladdin_global_halt',      '1 if global halt tripped',     e.globalHaltTripped ? 1 : 0),
      g('aladdin_circuit_breaker',  '1 if circuit breaker tripped', e.circuitBreakerTripped ? 1 : 0),
      g('aladdin_is_running',       '1 if engine is running',       e.isRunning ? 1 : 0),
      g('aladdin_position_open',    '1 if position is open',        e.position ? 1 : 0),
      g('aladdin_daily_drawdown',   'Daily drawdown fraction',
        e.dailyStartCapital > 0 ? (e.dailyStartCapital - e.capital) / e.dailyStartCapital : 0),
      g('aladdin_total_drawdown',   'Total drawdown from initial',
        e.initialCapital > 0 ? (e.initialCapital - e.capital) / e.initialCapital : 0),
      g('aladdin_errors_recent',    'Errors in last hour',         this._errors.length),
    ];

    if (e.position) {
      const cur = e.priceHistory?.at(-1) || e.position.entry;
      const pnlPct = (cur - e.position.entry) / e.position.entry;
      lines.push(g('aladdin_position_pnl_pct', 'Current position P/L %', pnlPct));
    }

    return lines.join('');
  }

  // ── Lightweight Sentry integration ───────────────────────────────────────
  _initSentry() {
    if (!this._sentryDsn) return;
    // Track unhandled errors and send to Sentry via simple HTTP POST
    const captureError = (err) => {
      const msg = err && err.message ? err.message : String(err);
      this._errors.push({ ts: Date.now(), msg });
      if (this._errors.length > 50) this._errors.shift();
      this._sendToSentry(msg, err?.stack || '');
    };
    process.on('uncaughtException',  captureError);
    process.on('unhandledRejection', captureError);
    console.log('[Metrics] Sentry DSN configured — errors will be forwarded');
  }

  _sendToSentry(message, stack) {
    // Sentry Store API (minimal envelope format)
    try {
      const [, key, host, projectId] = this._sentryDsn.match(/https:\/\/(\w+)@([^/]+)\/(\d+)/) || [];
      if (!key || !host) return;
      const payload = JSON.stringify({
        event_id: Date.now().toString(16),
        timestamp: new Date().toISOString(),
        platform: 'node',
        level: 'error',
        message: { formatted: message },
        exception: { values: [{ type: 'Error', value: message, stacktrace: { frames: [{ filename: stack.split('\n')[1] || 'unknown' }] } }] },
        tags: { service: 'aladdin-bot' },
      });
      const req = http.request({
        hostname: host, path: '/api/' + projectId + '/store/',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sentry-Auth': 'Sentry sentry_version=7, sentry_key=' + key,
        },
      });
      req.on('error', () => {});
      req.write(payload); req.end();
    } catch (_) {}
  }
}

module.exports = { MetricsServer };
