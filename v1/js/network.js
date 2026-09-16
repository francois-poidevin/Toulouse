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

// Real physical stop points per itinerary, in visit order ("ordre"), from
// Tisseo's "arrets-itineraire" open dataset. Used to make simulated
// vehicles pause at each real stop (see MODE_CONFIG.dwellSeconds) instead
// of gliding continuously along the route geometry — real buses/trams stop
// to let travelers on/off. Joined against "itineraire" records by the
// shared ligne + nom_iti + sens keys (same as ARRETS_SELECT_FIELDS below).
const ARRETS_API_BASE =
  "https://data.toulouse-metropole.fr/api/explore/v2.1/catalog/datasets/arrets-itineraire/records";
const ARRETS_PAGE_SIZE = 100; // hard API maximum for this endpoint
const ARRETS_SELECT_FIELDS = "ligne,nom_iti,sens,ordre,geo_point_2d";

// Cruise speed (m/s) + line weight per transport mode. Color now comes from
// the "ligne" dataset (see LIGNE_API_BASE above) keyed by line code; this
// table only supplies the fallback color used when a line has no match
// (e.g. API unreachable) and the weight/speed used for every line.
//
// dwellSeconds: how long a simulated vehicle pauses at each real stop
// (from ARRETS_API_BASE below) before resuming — real Tisséo GTFS-RT
// stop_time_update data (arrival/departure times per stop) would give an
// exact per-stop dwell duration, but api.tisseo.fr's GTFS-RT endpoint has
// no CORS headers and can't be fetched from this client-only page (see
// README.md); a fixed per-mode duration is the closest browser-fetchable
// approximation of "vehicle stops to let travelers on/off".
const MODE_CONFIG = {
  bus: { color: "#3ba7ff", weight: 3, speedMps: 8, dwellSeconds: 15 }, // ~29 km/h
  lineo: { color: "#e0203a", weight: 3, speedMps: 9, dwellSeconds: 15 }, // ~32 km/h
  tram: { color: "#a259e6", weight: 4, speedMps: 11, dwellSeconds: 20 }, // ~40 km/h
  metro: { color: "#2ecc71", weight: 4, speedMps: 14, dwellSeconds: 20 }, // ~50 km/h (VAL)
  telepherique: { color: "#ff4fa3", weight: 4, speedMps: 5, dwellSeconds: 25 }, // ~18 km/h
};
const DEFAULT_MODE_CONFIG = { color: "#cccccc", weight: 2, speedMps: 8, dwellSeconds: 15 };

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
 * Fetches a single page of the "arrets-itineraire" dataset (real stop
 * points per itinerary).
 */
async function fetchArretsPage(offset) {
  const apiKey = localStorage.getItem("tisseo_api_key") || "";
  const url = `${ARRETS_API_BASE}?limit=${ARRETS_PAGE_SIZE}&offset=${offset}&select=${encodeURIComponent(
    ARRETS_SELECT_FIELDS
  )}${apiKey ? `&apikey=${encodeURIComponent(apiKey)}` : ""}`;
  const headers = {};
  if (apiKey) {
    headers["Authorization"] = `Apikey ${apiKey}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`Tisseo arrets-itineraire API error ${res.status} at offset ${offset}`);
  }
  return res.json();
}

/**
 * Fetches every record of the "arrets-itineraire" dataset (~7900 stop
 * visits) and returns a Map keyed by the same `ligne_nomIti_sens` triple
 * used to look up itineraries, each value an array of [lat, lng] stops
 * sorted by their real visit order ("ordre") along that itinerary.
 */
async function fetchStopsByItinerary() {
  const grouped = new Map();
  const first = await fetchArretsPage(0);
  const total = first.total_count || 0;
  const allResults = first.results ? first.results.slice() : [];

  const offsets = [];
  for (let offset = ARRETS_PAGE_SIZE; offset < total; offset += ARRETS_PAGE_SIZE) {
    offsets.push(offset);
  }
  const CONCURRENCY = 4;
  let cursor = 0;
  async function worker() {
    while (cursor < offsets.length) {
      const offset = offsets[cursor++];
      const page = await fetchArretsPage(offset);
      if (page.results) allResults.push(...page.results);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, offsets.length) }, () => worker())
  );

  for (const record of allResults) {
    const point = record.geo_point_2d;
    if (!point) continue;
    const key = `${record.ligne || ""}_${record.nom_iti || ""}_${record.sens ?? ""}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ ordre: record.ordre || 0, latLng: [point.lat, point.lon] });
  }

  const result = new Map();
  for (const [key, stops] of grouped) {
    stops.sort((a, b) => a.ordre - b.ordre);
    result.set(key, stops.map((s) => s.latLng));
  }
  return result;
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
let currentStopsLayer = null;
let cachedStopsByItinerary = null;
const activeTravellers = new Map();
let activeVehicles = [];
let activeVehicleTravellers = [];

const scheduleCache = new Map();
let scheduleIndexPromise = null;

async function getScheduleTripsForLine(lineCode) {
  if (!lineCode) return null;
  if (scheduleCache.has(lineCode)) return scheduleCache.get(lineCode);
  if (!scheduleIndexPromise) {
    scheduleIndexPromise = fetch("assets/schedules/index.json")
      .then(r => r.json())
      .catch(() => ({}));
  }
  const index = await scheduleIndexPromise;
  const filename = index[lineCode];
  if (!filename) return null;

  try {
    const res = await fetch(`assets/schedules/${filename}`);
    const text = await res.text();
    const rows = parseCsvText(text);
    const tripsMap = new Map();
    for (const row of rows) {
      if (!tripsMap.has(row.trip_id)) tripsMap.set(row.trip_id, []);
      tripsMap.get(row.trip_id).push(row);
    }
    const trips = [];
    for (const [tripId, stops] of tripsMap) {
      stops.sort((a, b) => parseInt(a.stop_sequence, 10) - parseInt(b.stop_sequence, 10));
      trips.push(stops);
    }
    scheduleCache.set(lineCode, trips);
    return trips;
  } catch (err) {
    console.error("Failed to load schedule CSV for line", lineCode, err);
    return null;
  }
}

function parseCsvText(text) {
  const lines = text.split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim());
  const result = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(",");
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = cols[j] ? cols[j].trim() : "";
    }
    result.push(obj);
  }
  return result;
}

let cachedStopsJson = null;
async function getStopsJson() {
  if (cachedStopsJson) return cachedStopsJson;
  try {
    const res = await fetch("assets/schedules/stops.json");
    cachedStopsJson = await res.json();
  } catch (err) {
    console.error("Failed to load stops.json:", err);
    cachedStopsJson = {};
  }
  return cachedStopsJson;
}

function buildStopsLayer(map, trips, stopsMap) {
  const layerGroup = L.layerGroup();
  const seenStops = new Set();
  if (!trips || !stopsMap) return layerGroup;

  const stopIcon = L.divIcon({
    className: "",
    html: `<div style="
      width: 10px;
      height: 10px;
      background: #ffcc00;
      border: 2px solid #222;
      border-radius: 50%;
      box-shadow: 0 1px 3px rgba(0,0,0,0.4);
    "></div>`,
    iconSize: [10, 10],
    iconAnchor: [5, 5],
  });

  for (const trip of trips) {
    for (const s of trip) {
      if (seenStops.has(s.stop_id)) continue;
      seenStops.add(s.stop_id);

      const stopData = stopsMap[s.stop_id];
      if (!stopData || !stopData.latLng) continue;

      const marker = L.marker(stopData.latLng, { icon: stopIcon });

      const stopName = stopData.name || s.stop_name || "Arrêt";
      marker.bindTooltip(`<strong>Arrêt ID:</strong> ${s.stop_id}<br/><strong>Nom:</strong> ${stopName}`, { direction: "top" });
      layerGroup.addLayer(marker);
    }
  }
  return layerGroup;
}

/**
 * Spawns vehicle markers (icons) whose positions are driven continuously frame-by-frame
 * via requestAnimationFrame, using official schedule CSVs and stops.json mapping.
 */
async function spawnDynamicVehicleMarkersForRecords(map, records, stopsByItinerary) {
  const layerGroup = L.layerGroup();
  const newActiveTravellers = new Map();
  const newActiveVehicleTravellers = [];
  const newActiveVehicles = [];
  const zoomScale = vehicleScaleForZoom(map.getZoom());
  const stopsMap = await getStopsJson();

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
        const trips = await getScheduleTripsForLine(record.ligne);
        if (trips && trips.length > 0 && stopsMap) {
          traveller = createScheduleTraveller(latLngs, trips, stopsMap);
        } else {
          const stopsKey = `${record.ligne || ""}_${record.nom_iti || ""}_${record.sens ?? ""}`;
          const stopLatLngs = (stopsByItinerary && stopsByItinerary.get(stopsKey)) || [];
          traveller = createPathTraveller(latLngs, style.speedMps, {
            stopLatLngs,
            dwellSeconds: style.dwellSeconds,
          });
        }
      }

      newActiveTravellers.set(key, traveller);

      // Get current position
      const { latLng, heading } = traveller.advance(0);
      const vehicle = createVehicleMarker(map, mode, latLng);
      vehicle.setHeading(heading);
      vehicle.setScale(zoomScale);
      newActiveVehicles.push(vehicle);
      newActiveVehicleTravellers.push({ traveller, vehicle });

      // Hover tooltip displaying the name of the item from the API
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
  activeVehicleTravellers = newActiveVehicleTravellers;

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
    const fetches = [
      fetchAllItiRecords(),
      fetchLigneColorMap().catch((err) => {
        console.error("Failed to load Tisseo line colors, using fallback colors:", err);
        return new Map();
      }),
    ];
    // Real stop points only need fetching once per session (they don't
    // change), unlike itineraries/colors which are re-fetched every poll
    // for consistency with the rest of this module's "always live" design.
    if (!cachedStopsByItinerary) {
      fetches.push(
        fetchStopsByItinerary().catch((err) => {
          console.error("Failed to load Tisseo stop points, vehicles won't pause at stops:", err);
          return new Map();
        })
      );
    }
    const [records, ligneColorMap, stopsByItinerary] = await Promise.all(fetches);
    if (stopsByItinerary) {
      cachedStopsByItinerary = stopsByItinerary;
    }

    if (!currentLineLayer) {
      currentLineLayer = buildItiLineLayer(records, ligneColorMap);
      currentLineLayer.addTo(map);
    }

    if (!currentStopsLayer) {
      const stopsMap = await getStopsJson();
      const sampleTrips = [];
      for (const r of records.slice(0, 30)) {
        const trips = await getScheduleTripsForLine(r.ligne);
        if (trips) sampleTrips.push(...trips);
      }
      currentStopsLayer = buildStopsLayer(map, sampleTrips, stopsMap);
      currentStopsLayer.addTo(map);
    }

    if (currentVehicleLayer) {
      map.removeLayer(currentVehicleLayer);
    }

    currentVehicleLayer = await spawnDynamicVehicleMarkersForRecords(
      map,
      records,
      cachedStopsByItinerary
    );
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
 * Loads the full Tisseo network, sets up 60fps smooth animation, and 5-second API polling.
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

  // Smooth 60fps animation loop: advances vehicles continuously frame-by-frame
  // along their route paths with zero 5-sec lag, while API calls remain at 5s intervals.
  let lastTimestamp = null;
  function animationLoop(now) {
    if (lastTimestamp === null) lastTimestamp = now;
    const dtSeconds = (now - lastTimestamp) / 1000;
    lastTimestamp = now;

    for (const item of activeVehicleTravellers) {
      const { latLng, heading } = item.traveller.advance(dtSeconds);
      item.vehicle.setLatLng(latLng);
      item.vehicle.setHeading(heading);
      item.vehicle.tickAnimation(now);
    }

    requestAnimationFrame(animationLoop);
  }
  requestAnimationFrame(animationLoop);

  // Poll the API every 5 seconds (without increasing API call frequency)
  setInterval(() => {
    refreshNetwork(map, statusEl);
  }, 5000);
}
