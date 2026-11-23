'use strict';

// Works out the address phones should use to reach this server.
// Deployed: the public URL. Local: this laptop's Wi-Fi address.

const os = require('os');

function lanIp() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;
      candidates.push({ name, address: a.address });
    }
  }
  // en0 is Wi-Fi on a Mac; prefer it when there are several.
  const wifi = candidates.find((c) => c.name === 'en0');
  return (wifi || candidates[0] || {}).address || null;
}

function publicUrlFromEnv() {
  const url =
    process.env.PUBLIC_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    (process.env.RAILWAY_PUBLIC_DOMAIN && `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
  return url ? url.replace(/\/+$/, '') : null;
}

function resolveBase({ host, proto, port }) {
  const fromEnv = publicUrlFromEnv();
  if (fromEnv) return { url: fromEnv, local: false, lanMissing: false };

  const hostname = String(host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const isLoopback = ['', 'localhost', '127.0.0.1', '::1'].includes(hostname);
  if (isLoopback) {
    const ip = lanIp();
    if (ip) return { url: `http://${ip}:${port}`, local: true, lanMissing: false };
    return { url: `http://localhost:${port}`, local: true, lanMissing: true };
  }
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  return { url: `${proto || 'http'}://${host}`, local: isIp, lanMissing: false };
}

module.exports = { resolveBase, lanIp };
