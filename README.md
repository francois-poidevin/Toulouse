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
- Spawns one **pixel-art vehicle sprite** per itinerary that travels back
  and forth along its real route geometry at a mode-appropriate cruise
  speed, oriented to its direction of travel (heading), **pausing at each
  real stop** (fetched from the `arrets-itineraire` dataset) for a
  per-mode dwell duration to simulate letting passengers on/off, instead
  of gliding non-stop end to end.
- **Positions refresh every 5 seconds** by re-polling the API
  (`setInterval` in `loadItiNetwork`): each vehicle's simulated position is
  advanced by 5 simulated seconds of travel (or dwell time, while stopped)
  and jumps to the new spot on each poll — there is no continuous
  per-frame interpolation between polls.
- **Vehicle icons shrink/grow with map zoom** (smaller when zoomed out, to
  avoid cluttering the map with ~360 full-size sprites at a wide view),
  rescaled live on zoom without waiting for the next poll.
- **Hovering a vehicle icon shows a tooltip** with its line + itinerary
  name (e.g. "T1 – Palais de Justice - Aéroconstellation"), the same label
  shown when hovering the line's polyline.
- A startup modal asks for an optional Tisséo API key (not required by the
  `itineraire`/`ligne` datasets used today, but forwarded as an
  `Authorization: Apikey …` header when supplied); it is kept in
  `localStorage` only for the duration of the session and cleared again on
  every page load — see "No persistence" below.
- A footer status bar reports load progress and a final summary
  (itinerary count per mode, last refresh time).
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
- **Data sources**: three Toulouse Métropole open-data API datasets, all
  public, no API key/auth required, permissive CORS:
  - `itineraire` — full line/direction path geometries:
    `https://data.toulouse-metropole.fr/api/explore/v2.1/catalog/datasets/itineraire/records`
  - `ligne` — one record per line with its official display color as
    separate `r`/`v`/`b` (red/green/blue, 0-255) fields:
    `https://data.toulouse-metropole.fr/api/explore/v2.1/catalog/datasets/ligne/records`
  - `arrets-itineraire` — real physical stop points per itinerary, in visit
    order, used to make simulated vehicles pause at each stop:
    `https://data.toulouse-metropole.fr/api/explore/v2.1/catalog/datasets/arrets-itineraire/records`
- Transit data (`itineraire`/`ligne`/`arrets-itineraire` records) is
  fetched **only in memory**; nothing is written to `localStorage`/
  `sessionStorage`/`IndexedDB`. `itineraire`/`ligne` are re-fetched fresh
  on every 5s poll; `arrets-itineraire` (stop points) is fetched once per
  session since stop locations don't change. The one exception to the
  no-persistence rule is the optional API key entered in the startup
  modal, stored in `localStorage` only for the session and explicitly
  cleared again on every page load (`js/app.js`).

### File layout

| File | Role |
|---|---|
| `index.html` | Page shell: header, `#map` container, footer, script/style includes. |
| `css/style.css` | Dark theme, layout (fixed header/footer, full-bleed map), Leaflet popup/tooltip theming, pixel-art rendering hints. |
| `js/network.js` | Tisséo API client: paginated fetch of all `itineraire` records + the `ligne` color lookup + `arrets-itineraire` real stop points (`fetchStopsByItinerary`), per-mode weight/speed/dwell config, official per-line color resolution, static polyline layer builder, vehicle marker spawner (`spawnDynamicVehicleMarkersForRecords`), 5s poll loop (`refreshNetwork`/`loadItiNetwork`) + status reporting, zoom-driven icon rescaling. |
| `js/vehicle.js` | Sprite-based vehicle marker (`createVehicleMarker`, heading + zoom-scale via CSS transform) and path-following logic (`createPathTraveller`, distance/heading interpolation along a polyline, haversine distance, bearing calculation, stop-projection + dwell handling, `vehicleScaleForZoom`). |
| `js/app.js` | Bootstrap: API-key modal, Leaflet map init, tile layer, kicks off `loadItiNetwork`. |
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
- **Per-mode config** (`MODE_CONFIG`): line weight, a plausible cruise
  speed (m/s), and a per-stop dwell duration (seconds) per mode, used for
  the simulated animation; also supplies a fallback color when a line has
  no match in the `ligne` dataset.
- **Real stop points** (`network.js`, `fetchStopsByItinerary`): fetches
  every record of `arrets-itineraire` (~7900 stop visits across all
  itineraries) and groups them by the same `ligne_nomIti_sens` key used to
  join against `itineraire`, sorted by each stop's real visit order
  (`ordre`). Fetched once per session (cached in
  `cachedStopsByItinerary`), unlike itineraries/colors which re-fetch every
  5s poll, since stop locations don't change during a session.
- **Path traveller with stop dwelling** (`vehicle.js`,
  `createPathTraveller`): converts a polyline into a cumulative distance
  table, interpolates lat/lng at any travelled distance (binary search over
  cumulative distances), and bounces back and forth between the two ends of
  the route (each traveller starts at a random offset/direction so vehicles
  aren't bunched together). When real stop coordinates are supplied, each
  stop is projected onto its nearest point along the route polyline
  (`projectStopsOntoPath`) and `advance()` treats those projected distances
  as waypoints: the vehicle travels at cruise speed until it reaches one,
  then pauses there for `MODE_CONFIG.<mode>.dwellSeconds` before resuming —
  simulating a vehicle stopping for passengers, not gliding through stops.
  This is a fixed per-mode duration, not a real per-stop schedule: Tisséo's
  actual per-stop arrival/departure predictions (GTFS-RT `trip_update`,
  which would give an exact dwell window per stop) can't be fetched from
  this client-only page — see "Known limitations" below.
- **5-second poll cycle** (`network.js`, `refreshNetwork`/`loadItiNetwork`):
  every 5s, the API is re-fetched and each itinerary's existing traveller
  (kept in `activeTravellers`, keyed by `ligne_nomIti_index`) is advanced by
  5 simulated seconds and its marker jumped to the new position/heading — a
  full re-fetch, not a live-GPS feed. `refreshInFlight` skips overlapping
  polls if a fetch takes longer than 5s. Traveller identity depends on
  record order staying stable across polls: `fetchAllItiRecords` writes
  concurrently-fetched pages into fixed array slots rather than appending
  in arrival order, precisely so the index-based key doesn't shift and
  reset travellers to a random position every poll.
- **Zoom-driven icon scale** (`vehicle.js`, `vehicleScaleForZoom`,
  `vehicle.setScale`): vehicle icon size scales linearly with map zoom
  (smaller when zoomed out), applied via CSS `transform: scale(...)`
  combined with the existing heading `rotate(...)`, clamped to a min/max so
  icons stay legible even at the widest zoom-out. Rescaled instantly on the
  map's `zoomend` event (`activeVehicles`), independently of the 5s poll.
- **Sprite rendering**: each vehicle is a Leaflet `divIcon` with a `<div>`
  background sprite, `interactive: true` (default) so hover/click events
  fire — needed for the per-vehicle tooltip/popup bound in `network.js`.
  Per-frame walk-cycle animation (`tickAnimation`, cycling
  `background-position`) exists in `vehicle.js` but currently has no
  caller (see "Known limitations").

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
  real vehicle locations. Positions jump every 5s (poll cycle), not
  continuously animated between polls.
- **No real per-vehicle GPS position is publicly available at all** —
  investigated directly (see TODO below): confirmed Tisséo's GTFS-RT feed
  contains zero `VehiclePosition` entities. Stop dwelling (see "Path
  traveller with stop dwelling" above) uses a fixed per-mode duration, not
  a real per-stop schedule, because the one Tisséo feed that has real
  arrival/departure predictions (`trip_update`) is not fetchable from this
  client-only page (CORS, see TODO).
- Sprite walk-cycle frame animation (`tickAnimation` in `vehicle.js`) is
  currently unused — nothing drives it since the switch to poll-based
  positioning, so vehicle sprites are static images (rotated/scaled) rather
  than frame-animated.
- No error retry/backoff beyond a single failed fetch attempt per poll
  cycle (logs to console + footer status; the next 5s poll will retry).
- No tests, no linting, no CI configured.

## TODO — pistes d'évolution

- **API Temps Réel Tisséo / GTFS-RT — investigated, blocked by CORS.**
  Both real-time sources were checked directly against the live feed
  (fetched and parsed, not just read about):
  - `api-temps-reel-tisseo` (services `stops_schedules`, `journeys`,
    `places`, `lines`, `rolling_stocks`, `stop_areas`, `stop_points`,
    `messages`, `networks`) requires a key obtained by emailing
    `opendata@tisseo.fr` — this dataset's data.toulouse-metropole.fr entry
    is only a PDF spec, not itself queryable.
  - `tisseo-gtfs`'s GTFS-RT feed
    (`https://api.tisseo.fr/opendata/gtfsrt/GtfsRt.pb`, JSON mirror at
    `GtfsRt.json`) is keyless and updates every ~5s, but as of this
    writing contains **only `trip_update` (arrival/departure time
    predictions per stop) and `alert` entities — zero `vehicle`
    (`VehiclePosition`) entities**, confirmed by fetching and parsing a
    live snapshot (1447 entities: 1384 `trip_update`, 63 `alert`, 0
    `vehicle`). So even with a key, no real per-vehicle GPS position is
    exposed by Tisséo today.
  - Worse, `api.tisseo.fr` sends **no CORS headers** on either the `.pb`
    or `.json` GTFS-RT endpoint (checked directly with `curl -I
    -H Origin: ...`), unlike `data.toulouse-metropole.fr`'s own API
    (`access-control-allow-origin: *`). A browser `fetch()` from this
    client-only page is blocked from reading the response even though the
    request itself succeeds — this is a hard wall for a backend-less
    architecture (see "Out of scope" in `AGENTS.md`). The Toulouse portal
    only redirects to `api.tisseo.fr` for GTFS-RT; the static GTFS ZIP
    (`stop_times.txt`, which would give scheduled dwell times without
    needing real-time data) is served from
    `data.toulouse-metropole.fr/explore/...` (not `/api/explore/...`) and
    also has no CORS headers — checked directly, also blocked.
  - Net effect used in this codebase: stop **dwelling** is implemented
    (see "Path traveller with stop dwelling" above) using real stop
    *locations* (`arrets-itineraire`, which does have CORS), but with a
    fixed per-mode dwell duration rather than the real per-stop
    arrival/departure window, since the data with real timings can't be
    fetched from the browser. Revisit if Tisséo ever adds CORS headers to
    `api.tisseo.fr`, or if a backend/proxy becomes acceptable (would need
    explicit sign-off — see `AGENTS.md`).
