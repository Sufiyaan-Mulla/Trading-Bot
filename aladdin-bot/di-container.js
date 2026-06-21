'use strict';
// ── di-container.js ───────────────────────────────────────────────────────────
// Lightweight dependency injection container.
//
// Fixes: Architecture partial — "Use dependency injection so components can be
// tested independently."
//
// Why: currently every module requires dependencies directly, making
// it impossible to swap an implementation in tests without monkey-patching.
// With a DI container you register a factory once and every consumer gets the
// same (or a test-double) instance without touching import paths.
//
// Usage:
//   const { container } = require('./di-container');
//
//   // Register singletons (built once, reused everywhere)
//   container.singleton('telegram',  () => require('./telegram'));
//   container.singleton('auditLog',  () => require('./audit-log'));
//   container.singleton('riskMgr',   (c) => new RiskManager(c.get('auditLog')));
//
//   // Register transient (new instance each time)
//   container.transient('profiler',  () => new Profiler());
//
//   // Resolve
//   const tg = container.get('telegram');
//
//   // Override in tests (before any get() call)
//   container.override('telegram', { send: () => {} });
//   container.reset('telegram');   // restore original factory
// ─────────────────────────────────────────────────────────────────────────────

class DIContainer {
  constructor() {
    this._factories   = new Map();   // name → { fn, scope }
    this._instances   = new Map();   // name → resolved instance (singletons)
    this._overrides   = new Map();   // name → override value (for tests)
    this._resolving   = new Set();   // cycle detection
    this._maxDepth    = 20;            // #57: guard against very deep chains
  }

  // ── Registration ───────────────────────────────────────────────────────────

  // Register a singleton factory: resolved once and cached forever.
  singleton(name, factory) {
    this._factories.set(name, { fn: factory, scope: 'singleton' });
    return this;
  }

  // Register a transient factory: new instance every get() call.
  transient(name, factory) {
    this._factories.set(name, { fn: factory, scope: 'transient' });
    return this;
  }

  // Register a pre-built value (no factory, just the value itself).
  value(name, val) {
    this._factories.set(name, { fn: () => val, scope: 'singleton' });
    this._instances.set(name, val);
    return this;
  }

  // ── Resolution ─────────────────────────────────────────────────────────────

  get(name) {
    // Test override always wins
    if (this._overrides.has(name)) return this._overrides.get(name);

    if (!this._factories.has(name)) {
      throw new Error(`[DI] No registration for "${name}". Did you forget to register it?`);
    }

    const reg = this._factories.get(name);

    if (reg.scope === 'singleton') {
      if (this._instances.has(name)) return this._instances.get(name);

      // Cycle detection + max depth guard (#57)
      if (this._resolving.has(name)) {
        throw new Error(`[DI] Circular dependency detected for "${name}"`);
      }
      if (this._resolving.size >= this._maxDepth) {
        throw new Error(`[DI] Max dependency depth (${this._maxDepth}) exceeded resolving "${name}" — possible cycle or very deep chain`);
      }
      this._resolving.add(name);
      try {
        const instance = reg.fn(this);
        this._instances.set(name, instance);
        return instance;
      } finally {
        this._resolving.delete(name);
      }
    }

    // Transient: always call factory
    return reg.fn(this);
  }

  // Check if a name is registered
  has(name) { return this._factories.has(name); }

  // List all registered names
  registrations() { return [...this._factories.keys()]; }

  // ── Test support ───────────────────────────────────────────────────────────

  // Temporarily replace a registration with a mock/stub.
  override(name, value) {
    this._overrides.set(name, value);
    return this;
  }

  // Remove an override, restoring the original factory.
  reset(name) {
    this._overrides.delete(name);
    this._instances.delete(name);   // force re-resolve on next get()
    return this;
  }

  // Clear all resolved singleton instances (keeps factories).
  clearInstances() {
    this._instances.clear();
    return this;
  }

  // Create a child container that inherits registrations but has its own cache.
  child() {
    const c = new DIContainer();
    for (const [name, reg] of this._factories.entries()) {
      c._factories.set(name, reg);
    }
    return c;
  }
}

// ── Global application container ──────────────────────────────────────────────
// Pre-registered with all standard Aladdin modules.
// Components should use container.get('name') instead of require() for
// any dependency they want to be testable/swappable.
const container = new DIContainer();

// Core infrastructure
container.singleton('auditLog',    () => require('./audit-log'));
container.singleton('telegram',    () => require('./telegram'));
container.singleton('config',      () => require('./trading-config').TRADING_CONFIG);
container.singleton('safety',      () => require('./safety-constants').SAFETY);

// Risk
container.singleton('kelly',       () => require('./kelly-criterion').KellyCriterion);
container.singleton('correlation', () => require('./correlation-engine').CorrelationEngine);
container.singleton('varCalc',     () => require('./var-calculator').RiskMetrics);

// Strategy
container.singleton('regimeStack', (c) => {
  const { RegimeStack } = require('./regime-stack');
  return new RegimeStack();
});
container.singleton('economicCal', (c) => {
  const { EconomicCalendar } = require('./economic-calendar');
  return new EconomicCalendar();
});

// Execution
container.singleton('feeModel', (c) => {
  const { FeeModel } = require('./fee-model');
  return FeeModel.fromConfig(c.get('config'));
});
container.singleton('fillProb', () => {
  const { FillProbability } = require('./fill-probability');
  return new FillProbability();
});

// Monitoring
container.singleton('profiler', () => {
  const { getProfiler } = require('./performance-profiler');
  return getProfiler();
});
container.singleton('backupMgr', () => {
  const { BackupManager } = require('./backup-manager');
  return new BackupManager();
});

// Fix #46: Add destroy() lifecycle to drain pending writes before process exit
// Usage: process.on('SIGTERM', () => container.destroy())

module.exports = { DIContainer, container };
