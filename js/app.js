// App bootstrap: map init + Tisseo "itineraire" network load + shared
// animation loop driving every spawned vehicle (bus, lineo, tram, metro,
// telepherique) simultaneously along its own real line geometry.

(function () {
  const TOULOUSE_CENTER = [43.6045, 1.4442];

  const map = L.map("map", {
    zoomControl: true,
  }).setView(TOULOUSE_CENTER, 12);

  // CARTO's free raster tiles (built on OSM data) are used instead of the
  // osm.org tile server directly: osm.org's usage policy blocks requests
  // without a proper Referer header, which fails for local/file-based
  // testing and some GitHub Pages setups. CARTO has no such restriction
  // for this kind of light usage and needs no API key.
  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    {
      attribution:
        "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors &copy; <a href='https://carto.com/attributions'>CARTO</a>",
      subdomains: "abcd",
      maxZoom: 20,
    }
  ).addTo(map);

  const statusEl = document.getElementById("network-status");

  // Load the full Tisseo network (bus/lineo/tram/metro/telepherique) straight
  // from the public "itineraire" API, client-side only, nothing persisted.
  // Once loaded, every returned traveller is advanced by a single shared
  // requestAnimationFrame loop below.
  let travellers = [];
  loadItiNetwork(map, statusEl).then((spawned) => {
    travellers = spawned;
  });

  let lastTimestamp = null;

  function step(timestamp) {
    if (lastTimestamp === null) lastTimestamp = timestamp;
    const dtSeconds = (timestamp - lastTimestamp) / 1000;
    lastTimestamp = timestamp;

    for (const { traveller, vehicle } of travellers) {
      const { latLng, heading } = traveller.advance(dtSeconds);
      vehicle.setLatLng(latLng);
      vehicle.setHeading(heading);
      vehicle.tickAnimation(timestamp);
    }

    requestAnimationFrame(step);
  }

  requestAnimationFrame(step);
})();
