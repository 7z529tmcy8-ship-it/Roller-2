// Liest einen GBFS-Feed (Version 2.x oder 3.x) und macht daraus eine einheitliche Liste von E-Rollern.
// GBFS ist das Standardformat, in dem Sharing-Anbieter ihre freien Fahrzeuge veröffentlichen.

const UA = `RollerCheck/0.1 (${process.env.CONTACT_EMAIL || 'kein Kontakt eingetragen'})`;

export async function getJson(url, headers = {}, timeoutMs = 15000) {
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

export async function readProvider(cfg) {
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
