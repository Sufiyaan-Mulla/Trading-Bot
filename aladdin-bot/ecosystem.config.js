'use strict';
// ── ecosystem.config.js ───────────────────────────────────────────────────────
// PM2 process configuration for Aladdin Bot.
// Usage:
//   pm2 start ecosystem.config.js        — start all processes
//   pm2 stop all                         — stop all
//   pm2 restart aladdin-trading          — hot-restart engine
//   pm2 logs aladdin-trading             — tail engine logs
//   pm2 monit                            — live dashboard
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  apps: [

    // ── Main trading engine ───────────────────────────────────────────────────
    {
      name:               'aladdin-trading',
      script:             'backend-server.js',
      instances:          1,        // single instance — engine is not stateless
      autorestart:        true,
      watch:              false,    // never watch — hot-reload handles config changes
      max_memory_restart: '512M',

      // Feature #67: PM2 log rotation (requires pm2-logrotate module)
      // Install: pm2 install pm2-logrotate
      // Then: pm2 set pm2-logrotate:max_size 50M
      //       pm2 set pm2-logrotate:retain 14
      //       pm2 set pm2-logrotate:compress true
      error_file:      './trade_logs/pm2-error.log',
      out_file:        './trade_logs/pm2-out.log',
      merge_logs:      true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      restart_delay:      5000,     // 5 s between auto-restarts
      max_restarts:       10,       // give up after 10 crashes (prevents crash loop)
      min_uptime:         '30s',    // must stay up 30 s to count as successful start

      env: {
        NODE_ENV:     'production',
        OANDA_ENV:    'practice',   // switch to 'live' for real money
        HEALTH_PORT:  '8080',
        METRICS_PORT: '9090',
        DASHBOARD_PORT: '3000',
      },

      env_development: {
        NODE_ENV:      'development',
        OANDA_ENV:     'practice',
        BACKTEST_MODE: 'false',
      },

      // Log files
      out_file:    'trade_logs/pm2-out.log',
      error_file:  'trade_logs/pm2-err.log',
      merge_logs:  true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',

      // Graceful shutdown — let the engine flush backup on SIGTERM
      kill_timeout: 15000,   // 15 s to finish backup before SIGKILL
    },

    // ── Nightly backtest runner ───────────────────────────────────────────────
    {
      name:        'aladdin-nightly',
      script:      'backtest-nightly.js',
      instances:   1,
      autorestart: false,   // runs once per cron trigger
      watch:       false,
      cron_restart: '0 2 * * *',    // 2 AM UTC every night
      env: {
        NODE_ENV:      'production',
        BACKTEST_MODE: 'true',
      },
      out_file:   'trade_logs/nightly-out.log',
      error_file: 'trade_logs/nightly-err.log',
    },

    // ── Monitor process ───────────────────────────────────────────────────────
    {
      name:        'aladdin-monitor',
      script:      'monitor.js',
      instances:   1,
      autorestart: true,
      watch:       false,
      env: { NODE_ENV: 'production' },
      out_file:   'trade_logs/monitor-out.log',
      error_file: 'trade_logs/monitor-err.log',
    },


    // ── Automated nightly grid search (1h after backtest at 03:00 UTC) ─────────
    {
      name:        'aladdin-auto-grid',
      script:      'auto-grid.js',
      instances:   1,
      autorestart: false,
      watch:       false,
      cron_restart: '0 3 * * *',
      env: { NODE_ENV: 'production', BACKTEST_MODE: 'true' },
      out_file:    'trade_logs/auto-grid-out.log',
      error_file:  'trade_logs/auto-grid-err.log',
    },

    // ── Daily lockout auto-reset at midnight UTC ──────────────────────────────
    {
      name:        'aladdin-auto-reset',
      script:      'auto-reset.js',
      instances:   1,
      autorestart: false,
      watch:       false,
      cron_restart: '1 0 * * *',    // 00:01 UTC — after day boundary
      env: { NODE_ENV: 'production' },
      out_file:    'trade_logs/auto-reset-out.log',
      error_file:  'trade_logs/auto-reset-err.log',
    },

    // ── Feature #27: Weekly parameter stability check (Sunday 04:00 UTC) ─────
    {
      name:        'aladdin-param-stability',
      script:      'param-stability.js',
      instances:   1,
      autorestart: false,
      watch:       false,
      cron_restart: '0 4 * * 0',    // 04:00 UTC every Sunday
      env: { NODE_ENV: 'production', BACKTEST_MODE: 'true', STABILITY_REPORT: 'true' },
      out_file:    'trade_logs/param-stability-out.log',
      error_file:  'trade_logs/param-stability-err.log',
    },

  ],
};
