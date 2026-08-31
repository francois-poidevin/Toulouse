// Tisseo "itineraire" network — full line itineraries (Toulouse + surrounding
// area), fetched live, client-side, with NO API key / credentials (public
// dataset, permissive CORS). Each record is already a complete travel path
// (one line, one direction), so no segment-chaining is needed.
//
// IMPORTANT: results are kept only in an in-memory JS array for the lifetime
// of the page. Nothing is written to localStorage/sessionStorage/IndexedDB —
// every page load re-fetches fresh data from the API.

const ITI_API_BASE =
  "https://data.toulouse-metropole.fr/api/explore/v2.1/catalog/datasets/itineraire/records";
const ITI_PAGE_SIZE = 100; // hard API maximum for this endpoint
const ITI_SELECT_FIELDS = "ligne,nom_iti,mode,sens,dist_spa,geo_shape";

// Official per-line color, from Tisseo's own "ligne" open dataset (r/v/b =
// red/vert/bleu, 0-255 each). Joined against "itineraire" records by their
// shared "ligne" code (e.g. "T1", "112", "A"). Fetched live, same as the
// network itself — never hardcoded/persisted.
const LIGNE_API_BASE =
  "https://data.toulouse-metropole.fr/api/explore/v2.1/catalog/datasets/ligne/records";
const LIGNE_PAGE_SIZE = 100; // hard API maximum for this endpoint
const LIGNE_SELECT_FIELDS = "ligne,r,v,b";

// Cruise speed (m/s) + line weight per transport mode. Color now comes from
// the "ligne" dataset (see LIGNE_API_BASE above) keyed by line code; this
// table only supplies the fallback color used when a line has no match
// (e.g. API unreachable) and the weight/speed used for every line.
const MODE_CONFIG = {
  bus: { color: "#3ba7ff", weight: 3, speedMps: 8 }, // ~29 km/h
  lineo: { color: "#e0203a", weight: 3, speedMps: 9 }, // ~32 km/h
  tram: { color: "#a259e6", weight: 4, speedMps: 11 }, // ~40 km/h
  metro: { color: "#2ecc71", weight: 4, speedMps: 14 }, // ~50 km/h (VAL)
  telepherique: { color: "#ff4fa3", weight: 4, speedMps: 5 }, // ~18 km/h
};
const DEFAULT_MODE_CONFIG = { color: "#cccccc", weight: 2, speedMps: 8 };

function configForMode(mode) {
  return MODE_CONFIG[mode] || DEFAULT_MODE_CONFIG;
}

/**
 * Converts r/v/b (0-255 strings or numbers, as returned by the "ligne"
 * dataset) into a "#rrggbb" CSS color string.
 */
function rgbToHex(r, v, b) {
  const clamp = (n) => Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
  const toHex = (n) => clamp(n).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(v)}${toHex(b)}`;
}

/**
 * Resolves a line's display color: the official color from the "ligne"
 * dataset lookup map when available, otherwise the per-mode fallback color.
 */
function colorForLine(ligneColorMap, ligne, mode) {
  const hex = ligneColorMap && ligneColorMap.get(ligne);
  return hex || configForMode(mode).color;
}

/**
 * Normalizes a GeoJSON LineString/MultiLineString geometry into a flat array
 * of paths (each path an array of [lon, lat] pairs). The "itineraire"
 * dataset mostly returns LineString, but some records (e.g. metro line A)
 * are MultiLineString (several disjoint segments, notably branches/depot
 * spurs) — treating them as a single flat coordinate list corrupts every
 * lat/lng pair and used to crash the whole network load.
 */
function extractLineStringPaths(geometry) {
  if (!geometry || !geometry.coordinates || !geometry.coordinates.length) {
    return [];
  }
  if (geometry.type === "MultiLineString") {
    return geometry.coordinates;
  }
  // Default / "LineString": a single path.
  return [geometry.coordinates];
}

/**
 * Picks the longest path (by point count) out of a MultiLineString's
 * segments, used to drive a single vehicle sprite along one continuous
 * route when a record has several disjoint segments.
 */
function longestPath(paths) {
  let best = paths[0];
  for (const path of paths) {
    if (path.length > best.length) best = path;
  }
  return best;
}

/**
 * Fetches a single page of the "itineraire" dataset.
 */
async function fetchItiPage(offset) {
  const url = `${ITI_API_BASE}?limit=${ITI_PAGE_SIZE}&offset=${offset}&select=${encodeURIComponent(
    ITI_SELECT_FIELDS
  )}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Tisseo API error ${res.status} at offset ${offset}`);
  }
  return res.json();
}

/**
 * Fetches every record of the "itineraire" dataset by paging through the
 * API. Records are only ever held in memory (the returned array) — never
 * persisted to any browser storage.
 *
 * @param {(loaded: number, total: number) => void} onProgress
 */
async function fetchAllItiRecords(onProgress) {
  const first = await fetchItiPage(0);
  const total = first.total_count || 0;
  const records = first.results ? first.results.slice() : [];
  if (onProgress) onProgress(records.length, total);

  const offsets = [];
  for (let offset = ITI_PAGE_SIZE; offset < total; offset += ITI_PAGE_SIZE) {
    offsets.push(offset);
  }

  const CONCURRENCY = 4;
  let cursor = 0;
  async function worker() {
    while (cursor < offsets.length) {
      const myIndex = cursor++;
      const offset = offsets[myIndex];
      const page = await fetchItiPage(offset);
      if (page.results) {
        records.push(...page.results);
      }
      if (onProgress) onProgress(records.length, total);
    }
  }
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, offsets.length) },
    () => worker()
  );
  await Promise.all(workers);

  return records;
}

/**
 * Fetches a single page of the "ligne" dataset (official per-line colors).
 */
async function fetchLignePage(offset) {
  const url = `${LIGNE_API_BASE}?limit=${LIGNE_PAGE_SIZE}&offset=${offset}&select=${encodeURIComponent(
    LIGNE_SELECT_FIELDS
  )}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Tisseo ligne API error ${res.status} at offset ${offset}`);
  }
  return res.json();
}

/**
 * Fetches every record of the "ligne" dataset (small: ~100 lines total) and
 * returns a Map of line code ("ligne", e.g. "T1", "112", "A") to its
 * official "#rrggbb" color. In-memory only, re-fetched on every page load,
 * same as the itineraire network itself.
 */
async function fetchLigneColorMap() {
  const colorMap = new Map();
  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const page = await fetchLignePage(offset);
    const results = page.results || [];
    for (const record of results) {
      if (!record.ligne) continue;
      colorMap.set(record.ligne, rgbToHex(record.r, record.v, record.b));
    }
    offset += LIGNE_PAGE_SIZE;
    if (offset >= (page.total_count || 0)) break;
  }
  return colorMap;
}

/**
 * Draws one clickable polyline per itinerary, colored using the line's
 * official color (from the "ligne" dataset when available, else a per-mode
 * fallback), showing "<ligne> - <nom_iti>" as a hover tooltip and in a
 * click popup.
 */
function buildItiLineLayer(records, ligneColorMap) {
  const layerGroup = L.layerGroup();
  const renderer = L.canvas({ padding: 0.5 });

  for (const record of records) {
    const shape = record.geo_shape;
    if (!shape || !shape.geometry) continue;

    const paths = extractLineStringPaths(shape.geometry);
    if (!paths.length) continue;

    const mode = (record.mode || "").trim();
    const line = record.ligne || "?";
    const style = configForMode(mode);
    const color = colorForLine(ligneColorMap, line, mode);

    const label = `${line} \u2013 ${record.nom_iti || "?"}`;
    const popupHtml =
      `<strong>Ligne:</strong> ${line}<br/>` +
      `<strong>Itin\u00e9raire:</strong> ${record.nom_iti || "n/a"}<br/>` +
      `<strong>Mode:</strong> ${mode || "n/a"}` +
      (record.dist_spa
        ? `<br/><strong>Distance:</strong> ${(record.dist_spa / 1000).toFixed(1)} km`
        : "");

    // A MultiLineString (e.g. metro line A, which has branch/depot spurs)
    // is drawn as one polyline per segment so every part of the network is
    // visible, not just the first segment.
    for (const path of paths) {
      if (!path || path.length < 2) continue;
      const latLngs = path.map(([lon, lat]) => [lat, lon]);

      const polyline = L.polyline(latLngs, {
        renderer,
        color,
        weight: style.weight,
        opacity: 0.55,
        lineCap: "round",
      });

      polyline.bindTooltip(label, { sticky: true, direction: "top" });
      polyline.bindPopup(popupHtml);

      polyline.on("mouseover", () => {
        polyline.setStyle({ weight: style.weight + 3, opacity: 0.9 });
      });
      polyline.on("mouseout", () => {
        polyline.setStyle({ weight: style.weight, opacity: 0.55 });
      });

      layerGroup.addLayer(polyline);
    }
  }

  return layerGroup;
}

/**
 * Spawns one animated vehicle traveller per itinerary record whose geometry
 * has at least two points. Returns an array of { traveller, vehicle, mode }
 * to be driven by the shared animation loop in app.js.
 */
function spawnVehiclesForRecords(map, records) {
  const spawned = [];

  for (const record of records) {
    try {
      const shape = record.geo_shape;
      if (!shape || !shape.geometry) continue;

      const paths = extractLineStringPaths(shape.geometry);
      if (!paths.length) continue;

      // For a MultiLineString (e.g. metro line A branches/depot spurs), a
      // single vehicle rides the longest continuous segment rather than
      // jumping across disjoint sub-paths.
      const coords = longestPath(paths);
      if (!coords || coords.length < 2) continue;

      const mode = (record.mode || "").trim().toLowerCase();
      const style = configForMode(mode);

      const latLngs = coords.map(([lon, lat]) => [lat, lon]);
      const traveller = createPathTraveller(latLngs, style.speedMps);
      const vehicle = createVehicleMarker(map, mode, latLngs[0]);

      const label = `${record.ligne || "?"} \u2013 ${record.nom_iti || "?"}`;
      vehicle.marker.bindTooltip(label, { direction: "top", offset: [0, -10] });

      spawned.push({ traveller, vehicle, mode });
    } catch (err) {
      // Never let one malformed record abort the whole network load — log
      // and skip it instead so every other line/vehicle still spawns.
      console.error("Skipping record due to error:", record, err);
    }
  }

  return spawned;
}

/**
 * Loads the full Tisseo "itineraire" network onto the given map: draws the
 * static line geometries (clickable, with ligne + nom_iti hints) AND spawns
 * one animated vehicle per itinerary, all sharing the caller's render loop.
 *
 * Reports progress via the optional statusEl (any element with .textContent).
 *
 * @returns {Promise<Array>} the spawned vehicle travellers, for the caller's
 *   animation loop to advance every frame.
 */
async function loadItiNetwork(map, statusEl) {
  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  setStatus("Loading Tisseo network\u2026");
  try {
    // Fetched in parallel: the network geometry (itineraire) and the
    // official per-line colors (ligne) are independent datasets. A failure
    // fetching colors must not block the network itself — fall back to
    // per-mode colors instead (see colorForLine).
    const [records, ligneColorMap] = await Promise.all([
      fetchAllItiRecords((loaded, total) => {
        setStatus(`Loading Tisseo network\u2026 ${loaded}/${total}`);
      }),
      fetchLigneColorMap().catch((err) => {
        console.error("Failed to load Tisseo line colors, using fallback colors:", err);
        return new Map();
      }),
    ]);

    const lineLayer = buildItiLineLayer(records, ligneColorMap);
    lineLayer.addTo(map);

    const vehicles = spawnVehiclesForRecords(map, records);

    const counts = {};
    for (const r of records) {
      const m = (r.mode || "?").trim();
      counts[m] = (counts[m] || 0) + 1;
    }
    const summary = Object.entries(counts)
      .map(([m, c]) => `${m}: ${c}`)
      .join(", ");
    setStatus(`Tisseo network: ${records.length} itin\u00e9raires (${summary}) \u2014 ${vehicles.length} vehicles animated`);

    return vehicles;
  } catch (err) {
    console.error("Failed to load Tisseo network:", err);
    setStatus("Failed to load Tisseo network (see console)");
    throw err;
  }
}
