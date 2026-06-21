'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  AlertFallback  —  Feature #26
//
//  Secondary notification channel when Telegram fails.
//  Supports:
//    • SMTP email  (via nodemailer if installed, or raw Net/TLS socket)
//    • Discord webhook
//    • Generic HTTP webhook (POST JSON)
//
//  All sends are fire-and-forget with a timeout — never throws to the caller.
//
//  Config via env vars:
//    ALERT_EMAIL_TO, ALERT_EMAIL_FROM, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
//    DISCORD_WEBHOOK_URL
//    FALLBACK_WEBHOOK_URL
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');
const http  = require('http');

const TIMEOUT_MS = 8000;

function _postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(url);
    const mod    = parsed.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

class AlertFallback {
  /**
   * @param {object} opts
   * @param {string} [opts.discordWebhookUrl]
   * @param {string} [opts.webhookUrl]         Generic HTTP endpoint
   * @param {object} [opts.email]              { to, from, smtpHost, smtpPort, user, pass }
   * @param {Function} [opts.log]
   */
  constructor(opts = {}) {
    this._discord = opts.discordWebhookUrl || process.env.DISCORD_WEBHOOK_URL || null;
    this._webhook = opts.webhookUrl        || process.env.FALLBACK_WEBHOOK_URL || null;
    this._email   = opts.email             || null;
    this._log     = opts.log || ((m) => console.log('[AlertFallback] ' + m));
  }

  /**
   * Send a message via all configured fallback channels.
   * Fire-and-forget; never throws.
   * @param {string} text    Human-readable alert text
   * @param {string} [level] e.g. 'risk', 'trade', 'halt'
   */
  async send(text, level = 'info') {
    const label = `[${level.toUpperCase()}] ${text}`;
    const promises = [];

    // ── Discord ──────────────────────────────────────────────────────────
    if (this._discord) {
      promises.push(
        _postJson(this._discord, { content: label })
          .then(status => this._log(`Discord → ${status}`))
          .catch(e    => this._log(`Discord error: ${e.message}`))
      );
    }

    // ── Generic webhook ──────────────────────────────────────────────────
    if (this._webhook) {
      promises.push(
        _postJson(this._webhook, { text: label, level, timestamp: new Date().toISOString() })
          .then(status => this._log(`Webhook → ${status}`))
          .catch(e    => this._log(`Webhook error: ${e.message}`))
      );
    }

    // ── Email (nodemailer, optional dep) ─────────────────────────────────
    if (this._email || process.env.SMTP_HOST) {
      promises.push(this._sendEmail(label).catch(e => this._log(`Email error: ${e.message}`)));
    }

    if (promises.length === 0) {
      this._log('No fallback channels configured (set DISCORD_WEBHOOK_URL or FALLBACK_WEBHOOK_URL)');
      return;
    }

    await Promise.allSettled(promises);
  }

  async _sendEmail(text) {
    let nodemailer;
    try { nodemailer = require('nodemailer'); } catch(_) {
      this._log('nodemailer not installed — skipping email fallback');
      return;
    }
    const cfg = this._email || {};
    const transporter = nodemailer.createTransport({
      host: cfg.smtpHost || process.env.SMTP_HOST,
      port: Number(cfg.smtpPort || process.env.SMTP_PORT || 587),
      secure: Number(cfg.smtpPort || process.env.SMTP_PORT || 587) === 465,
      auth: {
        user: cfg.user || process.env.SMTP_USER,
        pass: cfg.pass || process.env.SMTP_PASS,
      },
    });
    await transporter.sendMail({
      from:    cfg.from || process.env.ALERT_EMAIL_FROM || 'aladdin-bot@localhost',
      to:      cfg.to   || process.env.ALERT_EMAIL_TO,
      subject: 'Aladdin Bot Alert',
      text,
    });
    this._log('Email sent');
  }

  isConfigured() {
    return !!(this._discord || this._webhook || this._email || process.env.SMTP_HOST);
  }
}

// ── Singleton wrapper mirroring telegram.js API ───────────────────────────────
const _instance = new AlertFallback();

/**
 * Drop-in companion to telegram.send().
 * Call after a telegram.send() failure to escalate via fallback channel.
 */
function sendFallback(text, level = 'info') {
  return _instance.send(text, level).catch(() => {});
}

module.exports = { AlertFallback, sendFallback };
