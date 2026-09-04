# AGENTS.md

Guidance for LLM coding agents working in this repository.

## What this repo is

Static, client-only web page (no backend, no build step, no package
manager, no framework) that renders an animated map of the Tisséo
(Toulouse) transit network using Leaflet + a public open-data API. See
`README.md` for the full functional/technical description before making
changes.

There is **no `package.json`, no bundler, no test suite, no CI, no git
repo initialized** at the time of writing. Treat any tooling suggestions
(npm scripts, linters, etc.) as things to *propose*, not assume exist.

## Repo layout (do not restructure without being asked)

```
index.html        # page shell, script/style includes, external CDN links
css/style.css      # all styling
js/app.js          # bootstrap: API-key modal, map init, kicks off loadItiNetwork
js/network.js      # Tisseo API fetch + line rendering + vehicle spawning + 5s poll loop
js/vehicle.js      # sprite marker + path-following math + zoom-scale
assets/*.png       # 4-frame sprite sheets, one per transport mode
```

Load order in `index.html` matters: Leaflet → `vehicle.js` → `network.js`
→ `app.js` (later files call functions defined in earlier ones; there are
no ES modules, everything is global function scope via IIFEs/top-level
`function` declarations).

## How to run / verify changes

No build step. Serve statically and check the browser:

```bash
python3 -m http.server 8000   # from repo root
```

Open `http://localhost:8000/` and check the browser console + the footer
status text (`#network-status`) for load progress/errors. There is no
automated test suite — manual verification in a browser (or reasoning
about the code) is the only validation available. If you add non-trivial
logic, prefer to keep it easy to eyeball-verify (e.g., log to console)
rather than inventing a test framework unless asked.

## Conventions to preserve

- **Vanilla JS only**, ES2017-ish, no transpilation, no modules (`type=
  module` is NOT used) — new code must work as a plain `<script>` include
  and expose functions as top-level `function` declarations if they need
  to be called from another file (see how `network.js` calls
  `createPathTraveller`/`createVehicleMarker` from `vehicle.js`).
- **No persistence of transit data**: never add `localStorage`/
  `sessionStorage`/`IndexedDB`/cookies for the fetched `itineraire`/`ligne`
  records — the existing design intentionally re-fetches fresh from the
  API on every 5s poll. If asked to add caching, flag this tension
  explicitly first. The one existing exception is the optional API key
  (`js/app.js`), kept in `localStorage` only for the session and
  explicitly cleared on every page load — don't extend this pattern to
  other data without being asked.
- **API key is optional today**: the `itineraire`/`ligne` datasets are
  public and keyless; the startup modal's API key is forwarded (as
  `Authorization: Apikey …` + `apikey=` query param) but nothing currently
  requires it. Don't remove the modal/key plumbing without being asked —
  it's there for the real-time API TODO (see `README.md`).
- **Per-mode config pattern**: transport-mode-specific values (weight,
  speed, dwell duration, sprite sheet geometry, fallback color) live in
  small config objects (`MODE_CONFIG` in `network.js`, `VEHICLE_SPRITES` in
  `vehicle.js`) keyed by lowercase mode string (`bus`, `lineo`, `tram`,
  `metro`, `telepherique`), each with a `DEFAULT_MODE_CONFIG`/fallback.
  Follow this pattern for any new per-mode behavior instead of branching
  with `if/else` chains.
- **Per-line color comes from the `ligne` dataset, not `MODE_CONFIG`**:
  each polyline's actual display color is looked up by line code (e.g.
  `"T1"`, `"112"`) in a `Map` built by `fetchLigneColorMap()` from the
  `ligne` dataset's `r`/`v`/`b` fields (`network.js`, `colorForLine`).
  `MODE_CONFIG.<mode>.color` is only the fallback used when a line has no
  match. Don't reintroduce per-mode coloring for lines — Tisséo assigns a
  distinct official color per line, not per mode.
- **Animation is simulated, not real-time**: vehicle positions are
  interpolated along static route geometry (`createPathTraveller` in
  `vehicle.js`), not live GPS. Don't conflate this with a "real vehicle
  tracker" claim in code/comments/UI copy.
- **Vehicle traveller identity is index-based**: `spawnDynamicVehicleMarkersForRecords`
  keys each vehicle's `activeTravellers` entry by
  `` `${ligne}_${nom_iti}_${arrayIndex}` ``, so it depends on
  `fetchAllItiRecords` returning records in a stable order across every 5s
  poll. If you change how records are fetched/paged/filtered, keep that
  order deterministic (or switch to a non-index-based key) — an unstable
  order resets travellers to a random position every poll (this exact bug
  was fixed once already).
- **Rendering perf**: the line layer uses a single shared `L.canvas()`
  renderer for all polylines (`network.js`); keep that shared-renderer
  pattern if adding more vector layers, rather than one SVG/canvas
  renderer per feature.
- Comments in existing files explain *why*, not just *what* (e.g., why
  CARTO tiles instead of osm.org, why in-memory only). Match that style
  for non-obvious decisions.

## Things to double-check before/after edits

- If changing the Tisséo API query (`ITI_API_BASE`, `ITI_SELECT_FIELDS`,
  page size), confirm field names still match what
  `buildItiLineLayer`/`spawnDynamicVehicleMarkersForRecords` read (`ligne`,
  `nom_iti`, `mode`, `sens`, `dist_spa`, `geo_shape`) — the dataset is
  external and not versioned in this repo. Same applies to
  `ARRETS_API_BASE`/`ARRETS_SELECT_FIELDS` (`arrets-itineraire`, read by
  `fetchStopsByItinerary`: `ligne`, `nom_iti`, `sens`, `ordre`,
  `geo_point_2d`) — its join key (`ligne`+`nom_iti`+`sens`) must keep
  matching `itineraire`'s.
- **Before adding any new Tisséo real-time data source, check CORS
  first.** `api.tisseo.fr` (GTFS-RT `.pb`/`.json`, and the legacy
  `api.tisseo.fr/v2/*` REST API) sends no
  `Access-Control-Allow-Origin` header at all — confirmed directly with
  `curl -I -H "Origin: ..."`. A browser `fetch()` from this client-only
  page will have the response blocked even though the request itself
  succeeds server-side (so testing with `curl`/Node alone will misleadingly
  look fine). `data.toulouse-metropole.fr/api/explore/...` datasets do have
  CORS (`access-control-allow-origin: *`); anything served instead from
  `data.toulouse-metropole.fr/explore/...` (no `/api/` segment, e.g. static
  file downloads) does not. Verify with a real `Origin` header before
  wiring up a new endpoint, not just a plain request. See the GTFS-RT
  investigation in README.md's TODO section for the full writeup.
- If changing/adding sprite assets, keep `frameWidth`/`frameHeight`/
  `frameCount` in `VEHICLE_SPRITES` in sync with the actual PNG dimensions
  (sprite sheets are horizontal strips of `frameCount` equal-width
  frames).
- `index.html`'s footer text and dataset attribution link should stay
  accurate if the data source changes.
- There's no linter/formatter configured — match existing indentation (2
  spaces) and style manually.

## Out of scope unless explicitly requested

- Adding a backend/proxy server.
- Introducing a bundler/framework (React, Vue, webpack, vite, etc.).
- Switching to real-time GPS vehicle feeds (Tisséo also exposes
  real-time APIs, but this repo currently only consumes the static
  `itineraire` dataset — a switch would be a significant functional
  change, confirm with the user first). See the "TODO — pistes
  d'évolution" section in `README.md` for the two candidate APIs
  (`api-temps-reel-tisseo`, `tisseo-gtfs`) already earmarked for this.
- Adding persistence of fetched data.
