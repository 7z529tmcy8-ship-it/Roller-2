// RollerCheck-Server: holt die Feeds der Anbieter, merkt sie sich kurz und gibt der App die Roller in der Nähe.
// Start: node server.js   (Node 20 oder neuer, keine Pakete nötig)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readProvider } from './lib/gbfs.js';
import { PROVIDERS } from './lib/providers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(HERE, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const MAX_AGE_MS = 5 * 60 * 1000; // Daten, die älter sind, gelten als ungültig
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function createServer(providers = PROVIDERS, opts = {}) {
  const refreshMs = opts.refreshMs ?? 30000; // nicht öfter als alle 30 Sekunden bei den Anbietern nachfragen
  const data = new Map();
  const timers = new Map();
  const hits = new Map();
  let closed = false;

  for (const p of providers) {
    data.set(p.id, {
      status: p.enabled ? 'loading' : 'off',
      note: p.note || null,
      scooters: [],
      pricing: null,
      updatedAt: null,
      error: null,
    });
  }

  async function refresh(p) {
    if (closed) return;
    let wait = refreshMs;
    try {
      const r = await readProvider(p);
      data.set(p.id, { status: 'ok', note: p.note || null, scooters: r.scooters, pricing: r.pricing, updatedAt: Date.now(), error: null });
      wait = Math.max(refreshMs, r.ttlMs || 0);
    } catch (e) {
      const prev = data.get(p.id);
      const tooOld = !prev.updatedAt || Date.now() - prev.updatedAt > MAX_AGE_MS;
      data.set(p.id, { ...prev, status: tooOld ? 'error' : 'ok', scooters: tooOld ? [] : prev.scooters, error: String(e.message || e) });
      wait = Math.max(refreshMs, 60000);
    }
    if (!closed) timers.set(p.id, setTimeout(() => refresh(p), wait));
  }

  function send(res, code, obj, extra = {}) {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'x-content-type-options': 'nosniff',
      ...extra,
    });
    res.end(JSON.stringify(obj));
  }

  function limited(req) {
    const ip = (process.env.TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?';
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now > h.reset) {
      hits.set(ip, { n: 1, reset: now + 60000 });
      if (hits.size > 5000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
      return false;
    }
    return ++h.n > 120; // höchstens 120 Anfragen pro Minute und Person
  }

  function status() {
    const out = {};
    for (const [id, s] of data) {
      out[id] = {
        status: s.status,
        updatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : null,
        total: s.scooters.length,
        pricing: s.pricing,
        ...(s.error ? { error: s.error } : {}),
        ...(s.note ? { note: s.note } : {}),
      };
    }
    return out;
  }

  function api(req, res, url) {
    if (req.method === 'OPTIONS') return send(res, 204, {}, { 'access-control-allow-methods': 'GET' });
    if (req.method !== 'GET') return send(res, 405, { error: 'Nur GET' });
    if (limited(req)) return send(res, 429, { error: 'Zu viele Anfragen' });

    if (url.pathname === '/api/health') return send(res, 200, { ok: true, providers: status() });

    if (url.pathname === '/api/scooters') {
      const q = url.searchParams;
      const lat = Number(q.get('lat'));
      const lng = Number(q.get('lng'));
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 47 || lat > 55.5 || lng < 5 || lng > 16) {
        return send(res, 400, { error: 'lat und lng fehlen oder liegen nicht in Deutschland' });
      }
      const radius = clamp(Number(q.get('radius')) || 1500, 100, 5000);
      const perProvider = clamp(Number(q.get('limit')) || 150, 1, 500); // pro Anbieter, damit einer nicht alle anderen verdrängt
      const scooters = [];
      for (const [id, s] of data) {
        if (s.status !== 'ok') continue;
        const near = [];
        for (const sc of s.scooters) {
          const d = haversine(lat, lng, sc.lat, sc.lon);
          if (d <= radius) near.push({ id: `${id}:${sc.id}`, p: id, lat: sc.lat, lon: sc.lon, bat: sc.bat, rangeM: sc.rangeM, uris: sc.uris, d: Math.round(d) });
        }
        near.sort((a, b) => a.d - b.d);
        scooters.push(...near.slice(0, perProvider));
      }
      scooters.sort((a, b) => a.d - b.d);
      return send(res, 200, { generatedAt: new Date().toISOString(), center: { lat, lng }, radius, providers: status(), scooters });
    }
    return send(res, 404, { error: 'Unbekannte Adresse' });
  }

  async function serveStatic(res, pathname) {
    let rel;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(PUB, rel));
    if (!file.startsWith(PUB + path.sep)) {
      res.writeHead(403).end('Verboten');
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'x-content-type-options': 'nosniff' });
      res.end(body);
    } catch {
      res.writeHead(404).end('Nicht gefunden');
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return api(req, res, url);
      return await serveStatic(res, url.pathname);
    } catch {
      if (!res.headersSent) send(res, 500, { error: 'Serverfehler' });
    }
  });

  return {
    http: server,
    refreshAll: () => Promise.all(providers.filter((p) => p.enabled).map((p) => refresh(p))),
    listen: (port) => new Promise((ok) => server.listen(port, ok)),
    close: () => {
      closed = true;
      timers.forEach(clearTimeout);
      server.closeAllConnections?.();
      return new Promise((ok) => server.close(ok));
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const port = Number(process.env.PORT) || 3000;
  const app = createServer();
  app.refreshAll();
  app.listen(port).then(() => {
    console.log(`RollerCheck läuft auf http://localhost:${port}`);
    console.log(`Status der Anbieter: http://localhost:${port}/api/health`);
  });
}
