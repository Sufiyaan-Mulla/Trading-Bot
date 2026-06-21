# Changelog

All notable changes to Aladdin Bot are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
Versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [7.3.0] — 2026-05-14

### Added
- `engine-wiring.js` — wires all new modules into live TradingEngine at startup; no core file modification needed
- `backend-server.js` — main entry point; correct 6-phase boot sequence (security → config → engine → wire → servers → backup)
- `trading-cli.js` — CLI for start/stop/status/reset/backup commands
- `ecosystem.config.js` — PM2 config with 3 processes, graceful 15s shutdown, nightly cron at 02:00 UTC
- `.gitignore` — prevents `.env`, `trade_logs/`, `backups/`, `node_modules/` from being committed
- `docker-compose.yml` — trading + nightly services with health check and log rotation
- `config/overrides.json` — seed file for hot-reload with patchable key list
- `test-wiring.js` — 73 tests verifying engine wiring, subsystem attachment, and infrastructure
- `test-suite.js` — master test runner covering all test files with combined summary
- `backtest-full.js`, `grid-search-complete.js`, `grid-search-full.js` — missing script files from package.json
- `auto-reset.js`, `auto-grid.js` — automation scripts for daily lockout reset and nightly grid search
- `test-engines.js`, `test-backend.js`, `test-websocket.js`, `test-frontend.js`, `test-cli.js` — test stubs
- `node_modules/zod` stub, `node_modules/ws` stub, `node_modules/dotenv` stub — offline compatibility
- Rate limiting (60–120 req/min per IP) added to `dashboard.js` and `metrics-server.js`
- `/account` endpoint added to `metrics-server.js` using `OandaReadonlyClient` (readonly key)

### Fixed
- `backend-server.js`: `engine.start()` corrected to `engine.runTradingLoop()` (method didn't exist)
- `grid-search-complete.js`, `auto-grid.js`: `GridSearch` → `GridSearchValidator` (correct export name)
- `execution.js` SHORT entry audit record: added `strategy`, `symbol`, `timeframe` tags (were missing)
- `execution.js` DAILY_LOCKOUT audit record: added `strategy`, `symbol`, `timeframe` tags
- `hot-reload.js`: now silently skips `_`-prefixed metadata keys instead of logging warnings every 2s
- `test-suite.js` parser: now handles both `✅ Passed: N` and `RESULTS: N passed` output formats
- `.env.example`: updated with all 24 env vars introduced across all sessions
- `trading-engine.js`, `execution.js`, `risk-manager.js`: `audit-log` → `audit-tagger` (all audit records now tagged)

---

## [7.2.0] — 2026-05-12

### Added
- `hot-reload.js` — live config patching via `config/overrides.json` without restart
- `monte-carlo.js` — 2 000-path bootstrap simulation with ruin probability and `safePositionSize()`
- `idempotent-executor.js` — SHA-1 dedup window (30 s) + `reconcile()` for post-reconnect state sync
- `fee-model.js` — maker/taker fee model; classifies LIMIT/MARKET/TWAP by spread, urgency, size
- `ohlcv-validator.js` — gap detection, spike filter (ATR-based), gap-fill synthetic candles, `toUTCMs()`
- `weekly-monthly-drawdown.js` — weekly (7 %, 48 h halt) and monthly (15 %, manual-reset) drawdown limits
- `meta-labeler.js` — online logistic regression on 8 features; learns when primary signals actually profit
- `fill-probability.js` — Brownian first-passage model + empirical calibration; `useLimit` flag
- `performance-profiler.js` — startup phase timing, per-tick sub-spans, p50/p95/p99 percentiles
- `backup-manager.js` — scheduled gzip + AES-256-GCM encrypted backups, 14-backup retention
- `exchange-interface.js` — `BaseExchangeAdapter`, `OandaAdapter`, `PaperAdapter`, `createAdapter()`
- `security-audit.js` — 7 startup security checks: permissions, hardcoded secrets, key separation, rotation, IP whitelist, encryption
- `Dockerfile` — non-root container, `HEALTHCHECK` via `/health`, exposes 3000 + 9090
- `.github/workflows/ci.yml` — 5-stage CI: syntax → unit → integration → backtest → Docker build

### Fixed
- `test-new-modules.js` — 195/195 tests passing for all new modules

---

## [7.1.0] — 2026-05-12

### Added
- `di-container.js` — lightweight DI container with singleton/transient/value scopes, override for tests, child containers, cycle detection
- `config-loader.js` — YAML/JSON config loader; writes `config/trading-config.json` on first run; validates on load
- `relative-strength.js` — cross-asset relative-strength + volatility-adjusted opportunity ranker
- `sector-cap.js` — per-sector exposure cap; blocks new positions when sector risk limit reached
- `execution-metrics.js` — per-order latency timer, fill-quality score (slippage vs ATR), rolling p95 latency
- `period-slicer.js` — forces backtest runs on bull, bear, and sideways market slices separately
- `survivorship-filter.js` — marks instruments as delisted; excludes them from backtest universe
- `audit-tagger.js` — wraps `audit-log.js`; enforces consistent `strategy`, `symbol`, `timeframe` tags on every record
- `ip-filter.js` — runtime IP whitelist middleware for Express/http servers
- `credential-enforcer.js` — startup enforcer: fails or warns when credentials are expired or rotation unrecorded
- `typed-indicators.js` — `Float64Array`-backed EMA, SMA, RSI, ATR for 3–5× faster indicator computation
- `parallel-scanner.js` — `Promise.all` multi-asset concurrent scorer; respects per-asset rate limits
- `health-server.js` — standalone `/health` + `/ready` HTTP server on port 8080, independent of metrics
- `rl-integration.js` — wires `QLearning` from `ml-improvements.js` into the engine as a post-filter layer
- `CHANGELOG.md` — this file

---

## [7.0.0] — 2026-05-10

### Added
- Multi-timeframe regime stack (M5 / H1 / D1) via `regime-stack.js`
- Kelly criterion position sizing with half-Kelly + confidence blending
- Correlation engine — blocks/reduces size when new asset correlates > 0.80 with open position
- Economic calendar blackouts — 30 min pre-event, 15 min post-event
- Walk-forward validation — SLIDING / EXPANDING / ANCHORED modes with embargo bars
- Liquidity scorer — blocks entry when spread, depth, or volume conditions are poor
- VaR calculator — historical simulation at 95 % + 99 %, CVaR (Expected Shortfall)
- Audit log — append-only JSONL with 50 MB rotation
- Telegram alerts — rate-limited with emergency bypass
- Real-time dashboard — WebSocket push of PnL, drawdown, open positions
- Prometheus metrics endpoint at `:9090/metrics`
- PM2 ecosystem config for process supervision and auto-restart
- Paper trading mode — full engine simulation against OANDA practice API

### Changed
- Engine refactored into thin orchestrator; execution/risk/strategy in separate mixins
- Safety constants frozen with `Object.freeze()` — cannot be overridden at runtime

---

## [6.x] — (legacy, not tracked in this changelog)
