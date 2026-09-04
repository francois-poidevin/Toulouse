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
  const apiKey = localStorage.getItem("tisseo_api_key") || "";
  const url = `${ITI_API_BASE}?limit=${ITI_PAGE_SIZE}&offset=${offset}&select=${encodeURIComponent(
    ITI_SELECT_FIELDS
  )}${apiKey ? `&apikey=${encodeURIComponent(apiKey)}` : ""}`;
  const headers = {};
  if (apiKey) {
    headers["Authorization"] = `Apikey ${apiKey}`;
  }
  const res = await fetch(url, { headers });
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
  const firstResults = first.results || [];

  const offsets = [];
  for (let offset = ITI_PAGE_SIZE; offset < total; offset += ITI_PAGE_SIZE) {
    offsets.push(offset);
  }

  // Pages are fetched concurrently and can resolve out of order; writing
  // each page's results into its own slot (rather than push()ing as they
  // arrive) keeps the final record order deterministic across refreshes.
  // spawnDynamicVehicleMarkersForRecords() keys each vehicle "traveller" by
  // its index in this array — an unstable order would make that key change
  // every 5s poll, discarding the in-flight traveller and respawning it at
  // a random position (looked like vehicles randomly teleporting/"moving
  // too fast").
  const pages = [firstResults];
  let loaded = firstResults.length;
  if (onProgress) onProgress(loaded, total);

  const CONCURRENCY = 4;
  let cursor = 0;
  async function worker() {
    while (cursor < offsets.length) {
      const myIndex = cursor++;
      const offset = offsets[myIndex];
      const page = await fetchItiPage(offset);
      const results = page.results || [];
      pages[myIndex + 1] = results;
      loaded += results.length;
      if (onProgress) onProgress(loaded, total);
    }
  }
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, offsets.length) },
    () => worker()
  );
  await Promise.all(workers);

  return pages.flat();
}

/**
 * Fetches a single page of the "ligne" dataset (official per-line colors).
 */
async function fetchLignePage(offset) {
  const apiKey = localStorage.getItem("tisseo_api_key") || "";
  const url = `${LIGNE_API_BASE}?limit=${LIGNE_PAGE_SIZE}&offset=${offset}&select=${encodeURIComponent(
    LIGNE_SELECT_FIELDS
  )}${apiKey ? `&apikey=${encodeURIComponent(apiKey)}` : ""}`;
  const headers = {};
  if (apiKey) {
    headers["Authorization"] = `Apikey ${apiKey}`;
  }
  const res = await fetch(url, { headers });
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

let currentVehicleLayer = null;
let currentLineLayer = null;
const activeTravellers = new Map();
// Handles of every currently-spawned vehicle, kept only to rescale their
// icons live on "zoomend" (see wireVehicleZoomScaling below) without
// waiting for the next 5s API poll.
let activeVehicles = [];

/**
 * Spawns vehicle markers (icons) whose positions advance along the network geometry
 * on each 5-second API poll cycle, oriented to their heading, with hover tooltips
 * displaying the item name from the API.
 */
function spawnDynamicVehicleMarkersForRecords(map, records) {
  const layerGroup = L.layerGroup();
  const newActiveTravellers = new Map();
  const newActiveVehicles = [];
  const zoomScale = vehicleScaleForZoom(map.getZoom());

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    try {
      const shape = record.geo_shape;
      if (!shape || !shape.geometry) continue;

      const paths = extractLineStringPaths(shape.geometry);
      if (!paths.length) continue;

      const coords = longestPath(paths);
      if (!coords || coords.length < 2) continue;

      const mode = (record.mode || "").trim().toLowerCase();
      const latLngs = coords.map(([lon, lat]) => [lat, lon]);
      const style = configForMode(mode);

      const key = `${record.ligne || ""}_${record.nom_iti || ""}_${i}`;
      let traveller = activeTravellers.get(key);
      if (!traveller) {
        traveller = createPathTraveller(latLngs, style.speedMps);
      }

      // Advance traveller position by 5 seconds on each API call interval
      const { latLng, heading } = traveller.advance(5);
      newActiveTravellers.set(key, traveller);

      const vehicle = createVehicleMarker(map, mode, latLng);
      vehicle.setHeading(heading);
      vehicle.setScale(zoomScale);
      newActiveVehicles.push(vehicle);

      // Vehicle name/identity shown on hover, per requirement: line code +
      // itinerary name (e.g. "T1 – Palais de Justice - Aéroconstellation")
      // doubles as the vehicle's display name since the API has no
      // per-vehicle id, only per-itinerary route names.
      const label = `${record.ligne || "?"} \u2013 ${record.nom_iti || "?"}`;
      vehicle.marker.bindTooltip(label, { sticky: true, direction: "top" });

      const popupHtml =
        `<strong>Ligne:</strong> ${record.ligne || "?"}<br/>` +
        `<strong>Itin\u00e9raire:</strong> ${record.nom_iti || "n/a"}<br/>` +
        `<strong>Mode:</strong> ${mode || "n/a"}`;
      vehicle.marker.bindPopup(popupHtml);

      layerGroup.addLayer(vehicle.marker);
    } catch (err) {
      console.error("Skipping dynamic marker error:", err);
    }
  }

  activeTravellers.clear();
  for (const [k, v] of newActiveTravellers) {
    activeTravellers.set(k, v);
  }
  activeVehicles = newActiveVehicles;

  return layerGroup;
}

/**
 * Refreshes network data and icon positions by calling the API.
 */
let refreshInFlight = false;

async function refreshNetwork(map, statusEl) {
  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  // A full refresh (363 itineraries, paginated) can take longer than the
  // 5s poll interval; skip overlapping runs instead of racing on
  // currentVehicleLayer/activeTravellers.
  if (refreshInFlight) return;
  refreshInFlight = true;

  try {
    const [records, ligneColorMap] = await Promise.all([
      fetchAllItiRecords(),
      fetchLigneColorMap().catch((err) => {
        console.error("Failed to load Tisseo line colors, using fallback colors:", err);
        return new Map();
      }),
    ]);

    if (!currentLineLayer) {
      currentLineLayer = buildItiLineLayer(records, ligneColorMap);
      currentLineLayer.addTo(map);
    }

    if (currentVehicleLayer) {
      map.removeLayer(currentVehicleLayer);
    }

    currentVehicleLayer = spawnDynamicVehicleMarkersForRecords(map, records);
    currentVehicleLayer.addTo(map);

    const counts = {};
    for (const r of records) {
      const m = (r.mode || "?").trim();
      counts[m] = (counts[m] || 0) + 1;
    }
    const summary = Object.entries(counts)
      .map(([m, c]) => `${m}: ${c}`)
      .join(", ");
    setStatus(`Tisseo network: ${records.length} itin\u00e9raires (${summary}) \u2014 refreshed at ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.error("Failed to refresh Tisseo network:", err);
    setStatus("Failed to refresh Tisseo network (see console)");
  } finally {
    refreshInFlight = false;
  }
}

/**
 * Loads the full Tisseo network and sets up 5-second periodic API polling.
 */
async function loadItiNetwork(map, statusEl) {
  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  setStatus("Loading Tisseo network\u2026");
  await refreshNetwork(map, statusEl);

  // Rescale every currently-spawned vehicle icon immediately on zoom, so
  // icons shrink/grow proportionally to zoom without waiting for the next
  // 5s poll (which would also respawn/reset the vehicle layer).
  map.on("zoomend", () => {
    const scale = vehicleScaleForZoom(map.getZoom());
    for (const vehicle of activeVehicles) {
      vehicle.setScale(scale);
    }
  });

  // Poll the API every 5 seconds and refresh icon positions on the map
  setInterval(() => {
    refreshNetwork(map, statusEl);
  }, 5000);
}
