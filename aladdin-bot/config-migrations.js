'use strict';
const fs   = require('fs');
const path = require('path');
// config-migrations.js — Item 27: Config Schema Migration Runner
// Automatically upgrades config between schema versions.
// Each migration transforms the old config to match the new schema.

const MIGRATIONS = [
  {
    version: 1,
    description: 'Initial schema',
    up: (cfg) => cfg,
  },
  {
    version: 2,
    description: 'Rename riskPct → positionSize; add maxDailyTrades',
    up: (cfg) => {
      if (cfg.riskPct !== undefined && cfg.positionSize === undefined) {
        cfg.positionSize = cfg.riskPct;
        delete cfg.riskPct;
      }
      if (cfg.maxDailyTrades === undefined) cfg.maxDailyTrades = 10;
      return cfg;
    },
  },
  {
    version: 3,
    description: 'Add HMM and GARCH feature flags',
    up: (cfg) => {
      if (cfg.hmmEnabled === undefined) cfg.hmmEnabled = true;
      if (cfg.garchEnabled === undefined) cfg.garchEnabled = true;
      return cfg;
    },
  },
];

function migrateConfig(configPath) {
  if (!fs.existsSync(configPath)) return;
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath,'utf8'));
    const current = cfg.schemaVersion || 1;
    let   updated = { ...cfg };
    let   applied = 0;
    for (const m of MIGRATIONS) {
      if (m.version > current) {
        console.log(`[Config #27] Applying migration v${m.version}: ${m.description}`);
        updated = m.up(updated);
        updated.schemaVersion = m.version;
        applied++;
      }
    }
    if (applied > 0) {
      fs.writeFileSync(configPath, JSON.stringify(updated, null, 2));
      console.log(`[Config #27] Applied ${applied} migration(s) → schema v${updated.schemaVersion}`);
    }
    return updated;
  } catch(e) {
    console.warn('[Config #27] Migration failed:', e.message);
  }
}

module.exports = { migrateConfig, MIGRATIONS };
