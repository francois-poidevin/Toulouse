# Tisséo Live — Toulouse Transit Tracker (POC)

Client-side, static web page that displays an **animated map of the whole
Tisséo public-transport network** (bus, Lineo, tram, metro/VAL,
téléphérique) for Toulouse and its metropolitan area, using **live data
fetched directly in the browser** from the Toulouse Métropole open-data
portal. No backend, no build step, no persistence.

## Functional overview

- Full-screen dark-themed [Leaflet](https://leafletjs.com/) map centered on
  Toulouse, with OSM-based tiles (CARTO dark basemap).
- On load, fetches **every itinerary record** of the Tisséo `itineraire`
  open dataset (one record = one line + direction + full path geometry),
  paginating through the API until all records are retrieved.
- Draws each itinerary as a **clickable/hoverable colored polyline** on the
  map, colored using each line's **official Tisséo color** (fetched from
  the `ligne` open dataset, one distinct color per line rather than one
  color per transport mode), with a tooltip/popup showing line number,
  itinerary name, mode, and distance.
- Spawns one **animated pixel-art vehicle sprite** per itinerary that
  travels back and forth along its real route geometry at a
  mode-appropriate cruise speed, oriented to its direction of travel
  (heading), with a looping frame animation.
- All vehicles are driven by a single shared `requestAnimationFrame` loop.
- A footer status bar reports load progress and a final summary
  (itinerary count per mode, vehicles animated).
- **Not real-time vehicle tracking**: positions are simulated by
  interpolating along the static route shape, not sourced from live GPS
  vehicle feeds. This is a rendering/animation prototype (POC), not an
  operational transit tracker.

## Technical overview

- **Stack**: plain HTML5 + vanilla JavaScript (no framework, no bundler,
  no package manager) + [Leaflet 1.9.4](https://leafletjs.com/) loaded from
  a CDN (`unpkg.com`). Pure static site — open `index.html` directly or
  serve it with any static file server (a local server avoids browser
  `file://` CORS/fetch quirks).
- **Data sources**: two Toulouse Métropole open-data API datasets, both
  public, no API key/auth required, permissive CORS:
  - `itineraire` — full line/direction path geometries:
    `https://data.toulouse-metropole.fr/api/explore/v2.1/catalog/datasets/itineraire/records`
  - `ligne` — one record per line with its official display color as
    separate `r`/`v`/`b` (red/green/blue, 0-255) fields:
    `https://data.toulouse-metropole.fr/api/explore/v2.1/catalog/datasets/ligne/records`
- Data is fetched **only in memory**, re-fetched fresh on every page load;
  nothing is written to `localStorage`/`sessionStorage`/`IndexedDB`.

### File layout

| File | Role |
|---|---|
| `index.html` | Page shell: header, `#map` container, footer, script/style includes. |
| `css/style.css` | Dark theme, layout (fixed header/footer, full-bleed map), Leaflet popup/tooltip theming, pixel-art rendering hints. |
| `js/network.js` | Tisséo API client: paginated fetch of all `itineraire` records + the `ligne` color lookup, per-mode weight/speed config, official per-line color resolution, static polyline layer builder, vehicle-traveller spawner, `loadItiNetwork()` orchestration + status reporting. |
| `js/vehicle.js` | Sprite-based animated vehicle marker (`createVehicleMarker`) and path-following logic (`createPathTraveller`, distance/heading interpolation along a polyline, haversine distance, bearing calculation). |
| `js/app.js` | Bootstrap: Leaflet map init, tile layer, kicks off `loadItiNetwork`, runs the shared animation loop advancing every spawned vehicle each frame. |
| `assets/*-sprite.png` | 4-frame horizontal pixel-art sprite sheets, one per mode (`bus`, `lineo`, `tram`, `metro`, `telepherique`), animated via CSS `background-position`. |

### Key mechanisms

- **Paginated fetch** (`network.js`): API max page size is 100 records;
  `fetchAllItiRecords` fetches page 0 first to learn `total_count`, then
  fetches remaining pages with 4 concurrent workers. `fetchLigneColorMap`
  pages through the (much smaller, ~100-record) `ligne` dataset the same
  way, sequentially, building a `Map<ligne code, "#rrggbb">`. Both fetches
  run in parallel via `Promise.all` in `loadItiNetwork`; a failure fetching
  colors never blocks the network itself (falls back to per-mode colors).
- **Official per-line color** (`rgbToHex`, `colorForLine`): the `ligne`
  dataset's `r`/`v`/`b` fields (0-255 each) are converted to a `#rrggbb`
  string and looked up by the `ligne` code shared with `itineraire`
  records (e.g. `"T1"`, `"112"`, `"A"`). Unmatched lines fall back to the
  per-mode default color.
- **Per-mode config** (`MODE_CONFIG`): line weight and a plausible cruise
  speed (m/s) per mode, used for the simulated animation; also supplies a
  fallback color when a line has no match in the `ligne` dataset.
- **Path traveller** (`vehicle.js`): converts a polyline into a cumulative
  distance table, interpolates lat/lng at any travelled distance (binary
  search over cumulative distances), and bounces back and forth between the
  two ends of the route (each traveller starts at a random offset/direction
  so vehicles aren't bunched together).
- **Sprite animation**: each vehicle is a Leaflet `divIcon` with a `<div>`
  background sprite; a per-frame timer advances `background-position`, and
  heading is applied as a CSS `rotate()` transform.

## Running locally

No install needed. Any static file server works, e.g.:

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

Opening `index.html` directly via `file://` may also work in most browsers
since the API has permissive CORS, but a local server is recommended.

## Data & attribution

- Map tiles: OpenStreetMap contributors, via CARTO (`dark_all` basemap).
- Transit data: Tisséo, via `data.toulouse-metropole.fr` (datasets
  `itineraire` and `ligne`), fetched live and not stored.

## Known limitations (POC status)

- Vehicle motion is a geometric simulation along static route shapes, not
  real Tisséo GPS positions — do not use to infer actual arrival times or
  real vehicle locations.
- No error retry/backoff beyond a single failed fetch attempt (logs to
  console + footer status).
- No tests, no linting, no CI configured.

## TODO — pistes d'évolution

- **API Temps Réel Tisséo** — remplacer/compléter la simulation de
  position par les vraies positions/horaires en temps réel :
  https://data.toulouse-metropole.fr/explore/dataset/api-temps-reel-tisseo/information/
  (services `stops_schedules`, `journeys`, `places`, `lines`,
  `rolling_stocks`, `stop_areas`, `stop_points`, `messages`, `networks`).
  À noter : contrairement aux datasets `itineraire`/`ligne` actuellement
  utilisés, cette API nécessite une clé d'accès (voir la doc du dataset) —
  changement d'architecture non-trivial (gestion de clé côté client vs
  besoin d'un backend/proxy), à cadrer avec l'utilisateur avant
  implémentation. Voir aussi la section "Out of scope" de `AGENTS.md`.
- **Données GTFS Tisséo** — exploiter le jeu de données GTFS statique et/ou
  GTFS-RT (protobuf, positions temps réel des véhicules) comme source
  alternative/complémentaire à `itineraire` :
  https://data.toulouse-metropole.fr/explore/dataset/tisseo-gtfs/information/
  (exports disponibles : `Tisseo_GTFS.zip`, `Tisseo_NeTEx.zip`,
  `Tisseo_GTFSRT.pb`). Le GTFS-RT est un format protobuf binaire — son
  utilisation dans une page 100% client-side vanilla JS impliquerait
  d'ajouter une dépendance de décodage protobuf (`gtfs-realtime-bindings`
  ou équivalent), à discuter avant d'introduire une dépendance externe au
  projet.
