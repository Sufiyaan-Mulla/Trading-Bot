'use strict';
// ── ip-filter.js ──────────────────────────────────────────────────────────────
// Runtime IP whitelist middleware for http.createServer / Express.
//
// Fixes: Security partial — "Whitelist IPs where supported by exchanges."
//
// Usage (http.createServer):
//   const { ipFilter } = require('./ip-filter');
//   const filter = ipFilter(['1.2.3.4', '10.0.0.0/8']);
//   http.createServer((req, res) => {
//     if (!filter(req, res)) return;   // returns false and closes if blocked
//     handleRequest(req, res);
//   });
//
// Usage (Express):
//   app.use(require('./ip-filter').expressMiddleware(['1.2.3.4']));
// ─────────────────────────────────────────────────────────────────────────────

function parseAllowList(list) {
  if (!list || !list.length) return null;   // null = allow all
  return list.map(entry => {
    if (entry.includes('/')) {
      const [ip, bits] = entry.split('/');
      return { type: 'cidr', ip, mask: parseInt(bits) };
    }
    return { type: 'exact', ip: entry };
  });
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct), 0) >>> 0;
}

function ipMatchesCIDR(ip, cidrIp, mask) {
  try {
    const ipInt   = ipToInt(ip);
    const netInt  = ipToInt(cidrIp);
    const maskBits = (-1 << (32 - mask)) >>> 0;
    return (ipInt & maskBits) === (netInt & maskBits);
  } catch (_) { return false; }
}

function isAllowed(remoteIp, rules) {
  if (!rules) return true;                     // no rules = open
  if (!remoteIp) return false;
  const ip = remoteIp.replace('::ffff:', ''); // strip IPv6 prefix from IPv4
  for (const rule of rules) {
    if (rule.type === 'exact' && rule.ip === ip) return true;
    if (rule.type === 'cidr'  && ipMatchesCIDR(ip, rule.ip, rule.mask)) return true;
  }
  return false;
}

const TRUSTED_PROXIES = (process.env.TRUSTED_PROXIES || '127.0.0.1,::1').split(',').map(s => s.trim());

function getRemoteIp(req) {
  const socketIp = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  // Only trust X-Forwarded-For if the actual socket IP is a known trusted proxy
  const socketClean = socketIp.replace('::ffff:', '');
  if (TRUSTED_PROXIES.includes(socketClean) && req.headers['x-forwarded-for']) {
    return req.headers['x-forwarded-for'].split(',')[0].trim();
  }
  return socketClean;
}

// ── Factory: returns a filter function ────────────────────────────────────────
function ipFilter(allowList) {
  const rules = parseAllowList(allowList);
  return function filter(req, res) {
    if (isAllowed(getRemoteIp(req), rules)) return true;
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden', ip: getRemoteIp(req) }));
    return false;
  };
}

// ── Express middleware ────────────────────────────────────────────────────────
function expressMiddleware(allowList) {
  const rules = parseAllowList(allowList);
  return function(req, res, next) {
    if (isAllowed(getRemoteIp(req), rules)) return next();
    res.status(403).json({ error: 'Forbidden' });
  };
}

module.exports = { ipFilter, expressMiddleware, isAllowed, parseAllowList, getRemoteIp };
