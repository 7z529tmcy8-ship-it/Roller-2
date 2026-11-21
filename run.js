// Test ohne Internet: Ein Mini-Server tut so, als wäre er Dott (GBFS 2.3) und Voi (GBFS 3, mit API-Key).
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../server.js';

const base = { is_disabled: false, is_reserved: false };
const dottBikes = [
  { ...base, bike_id: 'a1', lat: 52.377, lon: 9.7415, vehicle_type_id: 's', current_fuel_percent: 0.89, current_range_meters: 20000, pricing_plan_id: 'plan1', rental_uris: { android: 'https://x/a1', ios: 'https://x/i1' } },
  { ...base, bike_id: 'a2', lat: 52.378, lon: 9.743, vehicle_type_id: 's', current_fuel_percent: 0.5, pricing_plan_id: 'plan1' },
  { ...base, bike_id: 'dis', lat: 52.3766, lon: 9.7411, vehicle_type_id: 's', is_disabled: true },
  { ...base, bike_id: 'res', lat: 52.3766, lon: 9.7411, vehicle_type_id: 's', is_reserved: true },
  { ...base, bike_id: 'bike', lat: 52.3766, lon: 9.7411, vehicle_type_id: 'b' },
  { ...base, bike_id: 'far', lat: 52.52, lon: 13.4, vehicle_type_id: 's', pricing_plan_id: 'plan1' },
];

const mock = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const origin = `http://127.0.0.1:${mock.address().port}`;
  const json = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/dott/gbfs.json') {
    return json({ data: { en: { feeds: ['free_bike_status', 'vehicle_types', 'system_pricing_plans'].map((name) => ({ name, url: `${origin}/dott/${name}.json` })) } } });
  }
  if (u.pathname === '/dott/free_bike_status.json') return json({ ttl: 30, data: { bikes: dottBikes } });
  if (u.pathname === '/dott/vehicle_types.json') return json({ data: { vehicle_types: [{ vehicle_type_id: 's', form_factor: 'scooter' }, { vehicle_type_id: 'b', form_factor: 'bicycle' }] } });
  if (u.pathname === '/dott/system_pricing_plans.json') return json({ data: { plans: [{ plan_id: 'plan1', currency: 'EUR', price: 1, per_min_pricing: [{ start: 0, rate: 0.29, interval: 1 }] }] } });

  if (u.pathname.startsWith('/voi/')) {
    if (req.headers['x-access-token'] !== 'secret') return json({ error: 'no key' }, 401);
    if (u.pathname === '/voi/gbfs.json') return json({ data: { feeds: ['vehicle_status', 'vehicle_types', 'system_pricing_plans'].map((name) => ({ name, url: `${origin}/voi/${name}.json` })) } });
    if (u.pathname === '/voi/vehicle_status.json') return json({ ttl: 30, data: { vehicles: [{ ...base, vehicle_id: 'v1', lat: 52.3768, lon: 9.7405, vehicle_type_id: 'vs', current_range_meters: 15000 }] } });
    if (u.pathname === '/voi/vehicle_types.json') return json({ data: { vehicle_types: [{ vehicle_type_id: 'vs', form_factor: 'scooter_standing', default_pricing_plan_ids: ['vp'] }] } });
    if (u.pathname === '/voi/system_pricing_plans.json') return json({ data: { plans: [{ plan_id: 'vp', price: 0, per_min_pricing: [{ start: 0, rate: 0.22, interval: 1 }] }] } });
  }
  json({ error: 'nope' }, 404);
});
await new Promise((ok) => mock.listen(0, '127.0.0.1', ok));
const o = `http://127.0.0.1:${mock.address().port}`;

const app = createServer(
  [
    { id: 'dott', name: 'Dott', enabled: true, discovery: `${o}/dott/gbfs.json` },
    { id: 'voi', name: 'Voi', enabled: true, discovery: `${o}/voi/gbfs.json`, headers: { 'X-Access-Token': 'secret' } },
    { id: 'kaputt', name: 'Kaputt', enabled: true, discovery: `${o}/gibts-nicht/gbfs.json` },
    { id: 'bolt', name: 'Bolt', enabled: false, discovery: '', note: 'kein Feed' },
  ],
  { refreshMs: 60000 },
);
await app.refreshAll();
await app.listen(0);
const port = app.http.address().port;
const get = (p) => fetch(`http://127.0.0.1:${port}${p}`);

try {
  // Roller in der Nähe, nach Entfernung sortiert
  const r = await get('/api/scooters?lat=52.3765&lng=9.741&radius=1500');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.providers.dott.status, 'ok');
  assert.equal(j.providers.voi.status, 'ok');
  assert.equal(j.providers.kaputt.status, 'error');
  assert.equal(j.providers.bolt.status, 'off');
  assert.deepEqual(j.providers.dott.pricing, { unlock: 1, perMin: 0.29, currency: 'EUR' });
  assert.deepEqual(j.providers.voi.pricing, { unlock: 0, perMin: 0.22, currency: 'EUR' });
  assert.equal(j.providers.dott.total, 3); // a1, a2, far (ohne gesperrt, reserviert, Fahrrad)
  const ids = j.scooters.map((s) => s.id);
  assert.deepEqual(ids.sort(), ['dott:a1', 'dott:a2', 'voi:v1']);
  assert.ok(j.scooters.every((s, i, a) => i === 0 || a[i - 1].d <= s.d), 'nach Entfernung sortiert');
  const a1 = j.scooters.find((s) => s.id === 'dott:a1');
  assert.equal(a1.bat, 89);
  assert.equal(a1.uris.ios, 'https://x/i1');
  assert.equal(j.scooters.find((s) => s.id === 'voi:v1').bat, null);

  // kleiner Radius (Minimum 100 m): a2 ist weiter weg, Voi (ca. 47 m) kommt vor a1 (ca. 65 m)
  const small = await (await get('/api/scooters?lat=52.3765&lng=9.741&radius=100')).json();
  assert.deepEqual(small.scooters.map((s) => s.id), ['voi:v1', 'dott:a1']);

  // falsche Eingaben
  assert.equal((await get('/api/scooters?lat=abc&lng=9')).status, 400);
  assert.equal((await get('/api/scooters?lat=10&lng=9')).status, 400);
  assert.equal((await get('/api/gibts-nicht')).status, 404);

  // Status
  const h = await (await get('/api/health')).json();
  assert.equal(h.ok, true);

  // Webseite und Schutz vor ../
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /RollerCheck/);
  const status = await new Promise((ok) => http.get({ host: '127.0.0.1', port, path: '/..%2fserver.js' }, (x) => { x.resume(); ok(x.statusCode); }));
  assert.equal(status, 403);

  console.log('Alle Tests bestanden.');
} finally {
  await app.close();
  mock.closeAllConnections?.();
  mock.close();
}
