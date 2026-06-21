'use strict';
// tick-reconstruction.js — Item 24: Synthetic Tick Stream from OHLCV
// Reconstructs a plausible tick sequence from bar OHLCV data.
// Uses the Ohlcv-to-Ticks algorithm: O→H→L→C or O→L→H→C based on bar direction.

function reconstructTicks(ohlcvBar, ticksPerBar = 10) {
  const { o, h, l, c, v } = ohlcvBar;
  if (!o||!h||!l||!c) return [];
  const isBull = c >= o;
  const volPerTick = v / ticksPerBar;
  const ticks = [];

  // Waypoints: bull bar goes O→L→H→C, bear bar goes O→H→L→C
  const waypoints = isBull
    ? [o, l, h, c]
    : [o, h, l, c];

  const segments = waypoints.length - 1;
  const ticksPerSeg = Math.floor(ticksPerBar / segments);
  let t = 0;
  for (let s = 0; s < segments; s++) {
    const from = waypoints[s], to = waypoints[s+1];
    const n    = s === segments-1 ? ticksPerBar - t : ticksPerSeg;
    for (let i = 0; i < n; i++) {
      const frac  = n > 1 ? i/(n-1) : 1;
      const price = from + (to-from) * frac;
      // Add small microstructure noise
      const noise = (Math.random()-0.5) * (h-l) * 0.02;
      ticks.push({ price: parseFloat((price+noise).toFixed(6)), volume: volPerTick, tick: t++ });
    }
  }
  return ticks;
}

function reconstructSeries(ohlcvHistory, ticksPerBar = 10) {
  return ohlcvHistory.flatMap(bar => reconstructTicks(bar, ticksPerBar));
}

module.exports = { reconstructTicks, reconstructSeries };
