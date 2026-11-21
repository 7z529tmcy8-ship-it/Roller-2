// RollerCheck-Server: holt die Feeds der Anbieter, merkt sie sich kurz und gibt der App die Roller in der Nähe.
// Start: node server.js   (Node 20 oder neuer, keine Pakete nötig)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Liest einen GBFS-Feed (Version 2.x oder 3.x) und macht daraus eine einheitliche Liste von E-Rollern.
// GBFS ist das Standardformat, in dem Sharing-Anbieter ihre freien Fahrzeuge veröffentlichen.

const UA = `RollerCheck/0.1 (${process.env.CONTACT_EMAIL || 'kein Kontakt eingetragen'})`;

async function getJson(url, headers = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': UA, ...headers },
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} bei ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// gbfs.json listet, wo die einzelnen Feeds liegen. v2: data.<sprache>.feeds, v3: data.feeds
function pickFeeds(disc) {
  const d = disc?.data || {};
  let list = d.feeds;
  if (!list) {
    const lang = d.de || d.en || d[Object.keys(d)[0]];
    list = lang?.feeds;
  }
  const out = {};
  for (const f of list || []) out[f.name] = f.url;
  return out;
}

// price = Entsperren, per_min_pricing = Minutenpreis (gilt für GBFS 2.x und 3.x)
function planOf(p) {
  const segs = p.per_min_pricing || [];
  const seg = segs.find((s) => Number(s.start) === 0) || segs[0];
  const perMin = seg ? Number(seg.rate) / Number(seg.interval || 1) : null;
  return {
    id: p.plan_id,
    unlock: Number.isFinite(Number(p.price)) ? Number(p.price) : 0,
    perMin: Number.isFinite(perMin) ? perMin : null,
    currency: p.currency || 'EUR',
  };
}

async function readProvider(cfg) {
  // Mehrere mögliche Adressen: die erste, die klappt, wird gemerkt
  if (Array.isArray(cfg.discovery)) {
    let lastErr;
    for (const d of cfg.discovery) {
      try {
        const r = await readProvider({ ...cfg, discovery: d });
        cfg.discovery = d;
        return r;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('Keine Adresse');
  }
  const headers = cfg.headers || {};
  const disc = await getJson(cfg.discovery, headers).catch(() => null);
  const feeds = pickFeeds(disc);
  const base = cfg.discovery.replace(/\/gbfs\.json(\?.*)?$/, '');
  const url = (name) => feeds[name] || `${base}/${name}.json`;
  // GBFS 3 heißt der Feed vehicle_status, GBFS 2 free_bike_status
  const vehicleFeed = feeds.vehicle_status ? 'vehicle_status' : 'free_bike_status';

  const [veh, plansRaw, typesRaw] = await Promise.all([
    getJson(url(vehicleFeed), headers),
    getJson(url('system_pricing_plans'), headers).catch(() => null),
    getJson(url('vehicle_types'), headers).catch(() => null),
  ]);

  const plans = new Map((plansRaw?.data?.plans || []).map((p) => [p.plan_id, planOf(p)]));
  const types = typesRaw?.data?.vehicle_types || [];
  const scooterTypes = new Set(
    types.filter((t) => String(t.form_factor || '').startsWith('scooter')).map((t) => t.vehicle_type_id),
  );
  const typePlan = new Map(
    types.map((t) => [t.vehicle_type_id, t.default_pricing_plan_id || (t.default_pricing_plan_ids || [])[0]]),
  );

  const list = veh?.data?.vehicles || veh?.data?.bikes || [];
  const scooters = [];
  const planCount = new Map();
  for (const v of list) {
    if (v.is_disabled || v.is_reserved) continue;
    const lat = Number(v.lat);
    const lon = Number(v.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // Nur Roller, keine Fahrräder (wenn der Anbieter die Fahrzeugtypen mitliefert)
    if (scooterTypes.size && !scooterTypes.has(v.vehicle_type_id)) continue;

    const planId = v.pricing_plan_id || typePlan.get(v.vehicle_type_id);
    planCount.set(planId, (planCount.get(planId) || 0) + 1);

    const fuel = Number(v.current_fuel_percent);
    const range = Number(v.current_range_meters);
    scooters.push({
      id: String(v.bike_id ?? v.vehicle_id),
      lat,
      lon,
      bat: Number.isFinite(fuel) && v.current_fuel_percent != null ? Math.round(fuel <= 1 ? fuel * 100 : fuel) : null,
      rangeM: Number.isFinite(range) && v.current_range_meters != null ? Math.round(range) : null,
      // Direkt-Links in die Anbieter-App (iOS/Android), wenn der Anbieter sie mitliefert
      uris: v.rental_uris ? { android: v.rental_uris.android, ios: v.rental_uris.ios, web: v.rental_uris.web } : null,
    });
  }

  // Der Preisplan, der bei den meisten Rollern gilt, ist der Standardpreis des Anbieters
  let mainPlanId = [...planCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!plans.has(mainPlanId)) mainPlanId = [...plans.keys()][0];
  const main = plans.get(mainPlanId);
  const pricing = main && main.perMin != null ? { unlock: main.unlock, perMin: main.perMin, currency: main.currency } : null;

  return { scooters, pricing, ttlMs: Number(veh?.ttl || 0) * 1000, lastUpdated: veh?.last_updated ?? null };
}

// Welche Anbieter der Server abfragt. Einen neuen Anbieter einzubauen heißt: einen Eintrag mit der gbfs.json-Adresse ergänzen.
//
// Stand der Recherche (November 2026):
//  - Dott:  öffentlicher GBFS-2.3-Feed für Hannover, ohne Schlüssel. Enthält Positionen, Akku, Preise und App-Links. Gelesen und bestätigt.
//  - Lime:  hat öffentliche GBFS-Feeds (data.lime.bike). Die Adresse für Hannover ("hannover") ist geraten und nicht bestätigt.
//  - Voi:   GBFS nur mit API-Key (Partnerprogramm). Ohne VOI_API_KEY und VOI_ZONE_ID bleibt Voi aus.
//  - Bolt, Ryde: keinen öffentlichen Feed gefunden.

const voiKey = process.env.VOI_API_KEY;
const voiZone = process.env.VOI_ZONE_ID;

const PROVIDERS = [
  {
    id: 'dott',
    name: 'Dott',
    enabled: true,
    discovery: 'https://gbfs.api.ridedott.com/public/v2/hannover/gbfs.json',
  },
  {
    id: 'lime',
    name: 'Lime',
    enabled: process.env.LIME !== 'off',
    // Muster bestätigt (z. B. .../gbfs/dresden/gbfs.json). Der Name für Hannover ist unbestätigt: LIME_URL setzt die Adresse selbst.
    discovery: process.env.LIME_URL
      ? [process.env.LIME_URL]
      : [
          'https://data.lime.bike/api/partners/v2/gbfs/hannover/gbfs.json',
          'https://data.lime.bike/api/partners/v2/gbfs/hanover/gbfs.json',
        ],
    note: 'Adresse für Hannover nicht bestätigt',
  },
  {
    id: 'voi',
    name: 'Voi',
    enabled: Boolean(voiKey && voiZone),
    discovery: `https://api.voiapp.io/v1/partner-apis/gbfs/${voiZone}/gbfs.json`,
    headers: { 'X-Access-Token': voiKey || '' },
    note: 'Braucht einen API-Key von Voi',
  },
  { id: 'bolt', name: 'Bolt', enabled: false, discovery: '', note: 'Kein öffentlicher Feed gefunden' },
  { id: 'ryde', name: 'Ryde', enabled: false, discovery: '', note: 'Kein öffentlicher Feed gefunden' },
];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUB = HERE;
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
    if (rel !== '/index.html') {
      res.writeHead(404).end('Nicht gefunden');
      return;
    }
    const file = path.join(PUB, 'index.html');
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
