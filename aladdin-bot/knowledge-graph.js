'use strict';
// ── knowledge-graph.js — 14.2: Knowledge Graph ───────────────────────────────
// Maps relationships between assets, macroeconomic events, and sentiment.
// Uses a simple weighted adjacency structure to represent:
//   - Asset correlations (EURUSD ↔ GBPUSD: strong positive)
//   - Macro factor loadings (USD Index → EURUSD: negative)
//   - Event impact on pairs (FOMC → USD pairs: high impact)
//
// Useful for: correlation-aware sizing, event-driven stops, macro overlays.

class KnowledgeGraph {
  constructor() {
    this._nodes = new Map();   // name → { type, metadata }
    this._edges = new Map();   // 'A|B' → { weight, relationship, lastUpdated }
    this._initDefaults();
  }

  _initDefaults() {
    // Asset nodes
    ['EURUSD','GBPUSD','USDJPY','AUDUSD','USDCAD','USDCHF','NZDUSD','EURJPY','GBPJPY'].forEach(a =>
      this.addNode(a, 'FX_PAIR', { base: a.slice(0,3), quote: a.slice(3) })
    );
    // Macro factor nodes
    ['USD_INDEX','RISK_APPETITE','US10Y','OIL','GOLD','VIX'].forEach(m =>
      this.addNode(m, 'MACRO_FACTOR')
    );
    // Event nodes
    ['FOMC','ECB','BOJ','BOE','BOC','RBA','NFP','CPI'].forEach(e =>
      this.addNode(e, 'EVENT', { impact: 'HIGH' })
    );

    // Default correlations (approximate)
    this.addEdge('EURUSD','GBPUSD', 0.80, 'POSITIVE_CORR');
    this.addEdge('EURUSD','USDCHF',-0.90, 'NEGATIVE_CORR');
    this.addEdge('EURUSD','USDJPY',-0.30, 'MILD_NEGATIVE');
    this.addEdge('AUDUSD','NZDUSD', 0.85, 'POSITIVE_CORR');
    this.addEdge('USD_INDEX','EURUSD',-0.95, 'FACTOR_LOADING');
    this.addEdge('USD_INDEX','USDJPY', 0.70, 'FACTOR_LOADING');
    this.addEdge('RISK_APPETITE','AUDUSD', 0.75, 'FACTOR_LOADING');
    this.addEdge('VIX','USDJPY',-0.60, 'RISK_OFF');
    this.addEdge('FOMC','EURUSD', 0.90, 'EVENT_IMPACT');
    this.addEdge('FOMC','USDJPY', 0.85, 'EVENT_IMPACT');
    this.addEdge('ECB','EURUSD',  0.95, 'EVENT_IMPACT');
    this.addEdge('NFP','EURUSD',  0.80, 'EVENT_IMPACT');
  }

  addNode(name, type, metadata = {}) {
    this._nodes.set(name, { type, metadata, addedAt: Date.now() });
  }

  addEdge(a, b, weight, relationship = 'CORRELATED') {
    const key = [a,b].sort().join('|');
    this._edges.set(key, { weight: parseFloat(weight.toFixed(4)), relationship, lastUpdated: Date.now() });
  }

  // Update edge weight with new correlation observation
  updateCorrelation(a, b, newWeight, alpha = 0.1) {
    const key = [a,b].sort().join('|');
    const existing = this._edges.get(key);
    const w = existing ? (1-alpha)*existing.weight + alpha*newWeight : newWeight;
    this.addEdge(a, b, w, existing?.relationship || 'CORRELATED');
  }

  getEdge(a, b) {
    return this._edges.get([a,b].sort().join('|')) || null;
  }

  // Get all assets related to a given asset above a weight threshold
  getRelated(asset, minWeight = 0.5) {
    const related = [];
    for (const [key, edge] of this._edges) {
      if (Math.abs(edge.weight) < minWeight) continue;
      const [a, b] = key.split('|');
      if (a === asset) related.push({ asset:b, ...edge });
      if (b === asset) related.push({ asset:a, ...edge });
    }
    return related.sort((x,y) => Math.abs(y.weight)-Math.abs(x.weight));
  }

  // Events that impact a given pair
  getImpactingEvents(pair) {
    return this.getRelated(pair, 0.7).filter(r => {
      const node = this._nodes.get(r.asset);
      return node?.type === 'EVENT';
    });
  }

  // Systemic risk: count highly-correlated pairs to detect crowded trades
  countHighCorrelation(asset, threshold = 0.7) {
    return this.getRelated(asset, threshold).filter(r => r.weight > 0).length;
  }

  summary() {
    return {
      nodes: this._nodes.size,
      edges: this._edges.size,
      types: [...new Set([...this._nodes.values()].map(n=>n.type))],
    };
  }
}

module.exports = { KnowledgeGraph };
