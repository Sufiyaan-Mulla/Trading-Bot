'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  SecretsManager  —  Feature #70
//
//  Retrieves secrets from:
//    1. HashiCorp Vault (VAULT_ADDR + VAULT_TOKEN env vars)
//    2. AWS Secrets Manager (AWS_REGION + AWS credentials)
//    3. Kubernetes Secret (mounted at /var/run/secrets/aladdin/)
//    4. Environment variables (fallback — always available)
//
//  Usage:
//    const { SecretsManager } = require('./secrets-manager');
//    const sm = new SecretsManager();
//    const key = await sm.get('OANDA_API_KEY');
//
//  Auto-rotation: re-fetches secrets every rotationIntervalMs (default 1h).
// ─────────────────────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');
const http = require('http');
const https= require('https');

const K8S_SECRETS_DIR = '/var/run/secrets/aladdin';
const ROTATION_MS     = 60 * 60_000;  // 1 hour

class SecretsManager {
  constructor(opts = {}) {
    this._cache      = {};
    this._fetchedAt  = {};
    this._rotationMs = opts.rotationIntervalMs || ROTATION_MS;
    this._log        = opts.log || ((m) => console.log('[Secrets] ' + m));
    this._provider   = this._detectProvider();
    this._log(`Provider: ${this._provider}`);
  }

  _detectProvider() {
    if (process.env.VAULT_ADDR && process.env.VAULT_TOKEN) return 'vault';
    if (process.env.AWS_REGION && (process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ROLE_ARN)) return 'aws';
    if (fs.existsSync(K8S_SECRETS_DIR)) return 'k8s';
    return 'env';
  }

  async get(key) {
    const age = this._fetchedAt[key] ? Date.now() - this._fetchedAt[key] : Infinity;
    if (this._cache[key] && age < this._rotationMs) return this._cache[key];
    const value = await this._fetch(key);
    if (value) { this._cache[key] = value; this._fetchedAt[key] = Date.now(); }
    return value || process.env[key] || null;
  }

  async _fetch(key) {
    try {
      switch (this._provider) {
        case 'vault':  return await this._fromVault(key);
        case 'aws':    return await this._fromAWS(key);
        case 'k8s':    return this._fromK8s(key);
        default:       return process.env[key] || null;
      }
    } catch (e) {
      this._log(`Warning: failed to fetch ${key} from ${this._provider}: ${e.message}`);
      return process.env[key] || null;
    }
  }

  // HashiCorp Vault KV v2
  async _fromVault(key) {
    const base    = process.env.VAULT_ADDR;
    const token   = process.env.VAULT_TOKEN;
    const mount   = process.env.VAULT_MOUNT || 'secret';
    const path_   = process.env.VAULT_PATH  || 'aladdin';
    const url     = `${base}/v1/${mount}/data/${path_}`;
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, { headers: { 'X-Vault-Token': token } }, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            resolve(j?.data?.data?.[key] || null);
          } catch { resolve(null); }
        });
      });
      // Bug fix: no timeout on Vault HTTP request — a hung connection stalls
      // secret fetch for minutes, blocking bot startup on cold starts.
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('Vault request timeout')); });
      req.on('error', reject);
    });
  }

  // AWS Secrets Manager via AWS SDK (optional dep)
  async _fromAWS(key) {
    let AWS;
    try { AWS = require('@aws-sdk/client-secrets-manager'); } catch {
      this._log('AWS SDK not installed — npm install @aws-sdk/client-secrets-manager');
      return process.env[key] || null;
    }
    const client = new AWS.SecretsManagerClient({ region: process.env.AWS_REGION });
    const secretId = process.env.AWS_SECRET_ID || 'aladdin-bot/prod';
    const resp = await client.send(new AWS.GetSecretValueCommand({ SecretId: secretId }));
    const json = JSON.parse(resp.SecretString || '{}');
    return json[key] || null;
  }

  // Kubernetes mounted secret files
  _fromK8s(key) {
    const filePath = path.join(K8S_SECRETS_DIR, key);
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, 'utf8').trim();
    return null;
  }

  // Pre-load all known secrets at startup
  async warmup(keys = ['OANDA_API_KEY', 'OANDA_ACCOUNT', 'TELEGRAM_BOT_TOKEN', 'ANTHROPIC_API_KEY']) {
    const results = await Promise.allSettled(keys.map(k => this.get(k)));
    const loaded  = results.filter(r => r.status === 'fulfilled' && r.value).length;
    this._log(`Warmed up ${loaded}/${keys.length} secrets`);
    return loaded;
  }
}

// Singleton
let _instance = null;
function getSecretsManager(opts) {
  if (!_instance) _instance = new SecretsManager(opts);
  return _instance;
}

module.exports = { SecretsManager, getSecretsManager };
