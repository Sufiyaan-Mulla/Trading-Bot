'use strict';
// ── health-server.js ──────────────────────────────────────────────────────────
// Standalone /health + /ready HTTP server on its own port (default 8080).
//
// Fixes: Deployment partial — "Implement health-check endpoints."
//
// The existing /health endpoint lives inside metrics-server.js (port 9090).
// This module provides a dedicated lightweight server that:
//   • Responds immediately (no engine dependency required for /ping)
//   • Separates liveness (/health) from readiness (/ready)
//   • Is safe to probe from Docker HEALTHCHECK and Kubernetes probes
//   • Does NOT expose metrics or sensitive state
//
// Liveness  (/health): is the process alive and not in a fatal halt?
// Readiness (/ready):  is the engine fully warmed up and ready to trade?
// Ping      (/ping):   always 200 — used by load balancers
//
// Usage:
//   const { HealthServer } = require('./health-server');
//   const srv = new HealthServer(engine);
//   srv.start();   // listens on HEALTH_PORT (default 8080)
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');

const PORT = parseInt(process.env.HEALTH_PORT || '8080');

class HealthServer {
  constructor(engine, opts = {}) {
    this._engine  = engine;
    this._port    = opts.port || PORT;
    this._server  = null;
    this._startTs = Date.now();
  }

  start() {
    this._server = http.createServer((req, res) => {
      const url = req.url.split('?')[0];
      switch (url) {
        // Item 88: System resource monitor
        case '/health/resources': {
          const _mem  = process.memoryUsage();
          const _heap = (_mem.heapUsed / _mem.heapTotal * 100).toFixed(1);
          const _rss  = (_mem.rss / 1024 / 1024).toFixed(1);
          // Event loop lag measurement
          const _before88 = Date.now();
          setImmediate(() => {
            const _lag88 = Date.now() - _before88;
            const _status88 = {
              heapUsedPct:  parseFloat(_heap),
              rssMB:        parseFloat(_rss),
              eventLoopLagMs: _lag88,
              uptime:       Math.floor(process.uptime()),
              status:       _lag88 > 100 || parseFloat(_heap) > 90 ? 'DEGRADED' : 'OK',
            };
            // Alert if critical
            if (_lag88 > 200 || parseFloat(_heap) > 92) {
              try { require('./telegram').send(`⚠️ System resources: heap=${_heap}% lag=${_lag88}ms`, 'risk'); } catch(_) {}
            }
            res.writeHead(200, {'Content-Type':'application/json'});
            res.end(JSON.stringify(_status88));
          });
          return;
        }
        case '/health/feeds': {
          // Item 89: Per-source feed health status
          const _engine89 = global._engineInstance;
          const _feeds89  = {
            oanda:        { stale: !_engine89 || (Date.now()-(_engine89._lastPriceAt||0))>60000,
                            lastUpdate: new Date(_engine89?._lastPriceAt||0).toISOString() },
            alphaVantage: { stale: !_engine89?._lastAVAt || (Date.now()-(_engine89._lastAVAt||0))>300000,
                            lastUpdate: new Date(_engine89?._lastAVAt||0).toISOString() },
            news:         { stale: !_engine89?._lastNewsAt || (Date.now()-(_engine89._lastNewsAt||0))>900000,
                            lastUpdate: new Date(_engine89?._lastNewsAt||0).toISOString() },
          };
          const _anyStale = Object.values(_feeds89).some(f=>f.stale);
          const _status89 = JSON.stringify({ status: _anyStale?'DEGRADED':'OK', feeds: _feeds89 });
          res.writeHead(_anyStale?207:200,{'Content-Type':'application/json'}); res.end(_status89);
          return;
        }
        case '/dashboard': {
          // Item 18: Serve interactive equity curve dashboard
          try {
            const fs   = require('fs'), path = require('path');
            const html = fs.readFileSync(path.join(__dirname,'dashboard.html'),'utf8');
            res.writeHead(200,{'Content-Type':'text/html'}); res.end(html);
          } catch(_) { res.writeHead(404); res.end('Not found'); }
          return;
        }
        case '/health': return this._liveness(res);
        case '/ready':  return this._readiness(res);
        case '/ping':       return this._ping(res);
        case '/api/status/shap': {
          // Item 20: Return SHAP explanation for last trade
          const _shap = global._lastTradeExplanation || null;
          res.writeHead(200,{'Content-Type':'application/json'}); res.end(JSON.stringify(_shap));
          return;
        }
        case '/api/status': {
          // Item #52: Internal watchdog — alert if health check fails consecutively
    {
      let _watchdogFails = 0;
      setInterval(() => {
        const port52 = this._port || 8080;
        const http   = require('http');
        http.get(`http://localhost:${port52}/health`, res => {
          if (res.statusCode === 200) { _watchdogFails = 0; }
          else { _watchdogFails++; }
          if (_watchdogFails >= 3) {
            try { require('./telegram').send(`🚨 Watchdog: health check failed ${_watchdogFails}× — investigate!`, 'halt'); } catch(_) {}
          }
          res.resume();
        }).on('error', () => {
          _watchdogFails++;
          if (_watchdogFails >= 3) {
            try { require('./telegram').send(`🚨 Watchdog: health endpoint unreachable (${_watchdogFails}×)`, 'halt'); } catch(_) {}
          }
        });
      }, 120_000).unref();  // check every 2 minutes
    }
    // Item #47: Event loop lag monitor + memory growth alert
    {
      const perf_hooks = require('perf_hooks');
      let _lastObsTime = Date.now();
      const _lagObserver = new perf_hooks.PerformanceObserver(() => {});
      // Simple lag check via setImmediate timing
      setInterval(() => {
        const _start = Date.now();
        setImmediate(() => {
          const lagMs = Date.now() - _start;
          if (lagMs > 100) {
            console.warn(`[Health #47] Event loop lag: ${lagMs}ms — possible blocking operation`);
            try { require('./telegram').send(`⚠️ Event loop lag ${lagMs}ms — check for blocking code`, 'risk'); } catch(_) {}
          }
          const memMB = process.memoryUsage().rss / 1024 / 1024;
          if (memMB > (parseInt(process.env.OOM_WARN_MB)||400)) {
            console.warn(`[Health #47] Memory ${memMB.toFixed(0)}MB — approaching OOM`);
          }
        });
      }, 30_000).unref();
    }
    // Fix #103: Require shared-secret token to prevent information leakage
          const _tok = process.env.HEALTH_SECRET_TOKEN;
          if (_tok) {
            const _provided = (req.headers['x-health-token'] || '') || (new URL('http://h' + req.url).searchParams.get('token') || '');
            if (_provided !== _tok) { res.writeHead(401); res.end(JSON.stringify({error:'Unauthorized'})); return; }
          }
          return this._status(res);
        }
        default:        res.writeHead(404); res.end('Not found');
      }
    });
    this._server.listen(this._port, () => {
      console.log('[HealthServer] Listening on :' + this._port + ' (/health /ready /ping)');
    });
    this._server.on('error', e => console.warn('[HealthServer]', e.message));
    return this;
  }

  stop() { if (this._server) this._server.close(); }

  // ── Liveness: is the process healthy? ────────────────────────────────────
  _liveness(res) {
    const e   = this._engine;
    const ok  = !e || (!e.globalHaltTripped && !e.circuitBreakerTripped);
    const body = JSON.stringify({
      status:   ok ? 'ok' : 'degraded',
      uptime:   Math.floor((Date.now() - this._startTs) / 1000),
      halt:     e?.globalHaltTripped     || false,
      circuit:  e?.circuitBreakerTripped || false,
      ts:       new Date().toISOString(),
    });
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  // ── Readiness: is the engine ready to trade? ──────────────────────────────
  _readiness(res) {
    const e      = this._engine;
    const ready  = e && e.isRunning && (e.priceHistory?.length || 0) >= 50;
    const body   = JSON.stringify({
      status:        ready ? 'ready' : 'not_ready',
      isRunning:     e?.isRunning     || false,
      priceHistory:  e?.priceHistory?.length || 0,
      warmupDone:    (e?.priceHistory?.length || 0) >= 50,
      ts:            new Date().toISOString(),
    });
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  // ── Ping: simple alive check ───────────────────────────────────────────────

  // ── /api/status: lightweight engine status ───────────────────────────────
  _status(res) {
    const e = this._engine;
    const body = JSON.stringify({
      halt:         e?.globalHaltTripped || false,
      circuit:      e?.circuitBreakerTripped || false,
      isRunning:    e?.isRunning || false,
      position:     e?.position ? { side: e.position.side, entry: e.position.entry, asset: e?.selectedAsset } : null,
      capital:      e?.capital || 0,
      lastTrade:    e?.trades?.length ? e.trades[e.trades.length - 1] : null,
      ts:           new Date().toISOString(),
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(body);
  }

  _ping(res) {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('pong');
  }
}

module.exports = { HealthServer };
