// Welche Anbieter der Server abfragt. Einen neuen Anbieter einzubauen heißt: einen Eintrag mit der gbfs.json-Adresse ergänzen.
//
// Stand der Recherche (November 2026):
//  - Dott:  öffentlicher GBFS-2.3-Feed für Hannover, ohne Schlüssel. Enthält Positionen, Akku, Preise und App-Links. Gelesen und bestätigt.
//  - Lime:  hat öffentliche GBFS-Feeds (data.lime.bike). Die Adresse für Hannover ("hannover") ist geraten und nicht bestätigt.
//  - Voi:   GBFS nur mit API-Key (Partnerprogramm). Ohne VOI_API_KEY und VOI_ZONE_ID bleibt Voi aus.
//  - Bolt, Ryde: keinen öffentlichen Feed gefunden.

const voiKey = process.env.VOI_API_KEY;
const voiZone = process.env.VOI_ZONE_ID;

export const PROVIDERS = [
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
    discovery: 'https://data.lime.bike/api/partners/v2/gbfs/hannover/gbfs.json',
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
