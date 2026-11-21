# RollerCheck-Server

Holt Live-Daten von E-Roller-Anbietern und zeigt sie in der RollerCheck-Karte.

## Starten
1. Node.js 20 oder neuer installieren (nodejs.org).
2. Im Ordner: `node server.js`
3. Im Browser öffnen: http://localhost:3000
4. Prüfen, welcher Anbieter läuft: http://localhost:3000/api/health

Es werden keine Pakete gebraucht. Test ohne Internet: `node test/run.js`

## Welche Anbieter sind live?
| Anbieter | Stand |
|---|---|
| Dott | Öffentlicher Feed für Hannover, kein Schlüssel nötig. Positionen, Akku, Preise und App-Links. |
| Lime | Hat öffentliche Feeds. Die Adresse für Hannover ist **geraten und nicht geprüft**. Wenn `/api/health` bei Lime „error" zeigt, stimmt sie nicht. Abschalten: `LIME=off node server.js` |
| Voi | Nur mit API-Key von Voi (Partnerprogramm). Dann: `VOI_API_KEY=... VOI_ZONE_ID=... node server.js` |
| Bolt, Ryde | Kein öffentlicher Feed gefunden. In der App steht „Noch nicht angebunden". |

Ist der Server nicht erreichbar, zeigt die Karte Demo-Daten (ausgedacht) und sagt das auch.

## Wichtig vor dem echten Start
- **Nutzungsbedingungen prüfen.** Die Feeds sind öffentlich lesbar. Ob man sie für eine Seite mit Provisionen nutzen darf, steht in den Bedingungen der Anbieter. Für Provisionen brauchst du sowieso einen Vertrag (Partnerprogramm) mit den Anbietern.
- Trage deine E-Mail ein, damit Anbieter dich erreichen können: `CONTACT_EMAIL=du@example.de node server.js`
- Der Server fragt die Anbieter höchstens alle 30 Sekunden ab, egal wie viele Nutzer es gibt.
- Hinter einem Proxy (z. B. bei Hosting-Diensten): `TRUST_PROXY=1` setzen.
- Port ändern: `PORT=8080`

## Dateien
- `server.js`: Server und Schnittstelle (`/api/scooters`, `/api/health`)
- `lib/providers.js`: Liste der Anbieter. Neuer Anbieter = ein Eintrag mit der `gbfs.json`-Adresse
- `lib/gbfs.js`: Liest das Standardformat GBFS (Version 2 und 3)
- `public/index.html`: die App
- `test/run.js`: Test mit Test-Feeds
