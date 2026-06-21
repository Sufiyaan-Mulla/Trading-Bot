'use strict';
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
// ── model-registry.js — 9.1: Model Registry ─────────────────────────────────
// Versions every ML model with: parameters, performance metrics, training data hash.
// Enables: reproducibility, rollback, comparison, audit trail.

const REGISTRY_DIR = path.join(__dirname, 'model_registry');
const REGISTRY_FILE = path.join(REGISTRY_DIR, 'registry.json');

class ModelRegistry {
  constructor() {
    if (!fs.existsSync(REGISTRY_DIR)) fs.mkdirSync(REGISTRY_DIR, { recursive: true });
    this._registry = this._load();
  }

  _load() {
    try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); } catch(_) { return []; }
  }

  _save() {
    try {
      // Bug fix: direct writeFileSync is non-atomic — a crash mid-write corrupts
      // the registry, and on next start _load() falls back to [] losing all versions.
      // Fix: write via tmp+rename (atomic on same filesystem).
      const tmp = REGISTRY_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._registry, null, 2));
      fs.renameSync(tmp, REGISTRY_FILE);
    } catch(_) {}
  }

  // Hash training data for reproducibility verification
  _hashData(ohlcvHistory) {
    const sample = (ohlcvHistory || []).slice(0, 100).map(b => b.c || 0).join(',');
    return crypto.createHash('sha256').update(sample).digest('hex').slice(0, 16);
  }

  // Register a new model version
  register(modelType, params, metrics, ohlcvHistory) {
    const entry = {
      id:          `${modelType}-${Date.now()}`,
      modelType,
      version:     (this._registry.filter(r => r.modelType === modelType).length + 1),
      registeredAt: new Date().toISOString(),
      params:      params || {},
      metrics:     metrics || {},
      dataHash:    this._hashData(ohlcvHistory),
      active:      true,
    };
    // Deactivate previous versions
    this._registry.forEach(r => { if (r.modelType === modelType) r.active = false; });
    this._registry.push(entry);
    if (this._registry.length > 100) this._registry = this._registry.slice(-100);
    this._save();
    console.log(`[ModelRegistry #9.1] Registered ${modelType} v${entry.version} | metrics: ${JSON.stringify(metrics)}`);
    return entry.id;
  }

  // Get the current active model for a type
  getActive(modelType) {
    return [...this._registry].reverse().find(r => r.modelType === modelType && r.active);
  }

  // Get all versions for comparison
  getHistory(modelType, limit = 10) {
    return this._registry.filter(r => r.modelType === modelType).slice(-limit);
  }

  // Rollback to a specific version
  rollback(registryId) {
    const entry = this._registry.find(r => r.id === registryId);
    if (!entry) throw new Error(`Registry ID ${registryId} not found`);
    this._registry.forEach(r => { if (r.modelType === entry.modelType) r.active = false; });
    entry.active = true;
    this._save();
    console.log(`[ModelRegistry #9.1] Rolled back ${entry.modelType} to v${entry.version}`);
    return entry;
  }

  summary() {
    const byType = {};
    for (const r of this._registry) {
      if (!byType[r.modelType]) byType[r.modelType] = { versions: 0, latestMetrics: {} };
      byType[r.modelType].versions++;
      if (r.active) byType[r.modelType].latestMetrics = r.metrics;
    }
    return byType;
  }
}

module.exports = { ModelRegistry };
