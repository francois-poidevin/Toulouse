// App bootstrap: map init + Tisseo "itineraire" network load + static vehicle icons

(function () {
  const TOULOUSE_CENTER = [43.6045, 1.4442];

  // Clean local storage at each startup so API key is asked every website load
  localStorage.removeItem("tisseo_api_key");

  const modalEl = document.getElementById("api-modal");
  const inputEl = document.getElementById("api-key-input");
  const submitBtn = document.getElementById("api-key-submit");
  const apiBarEl = document.getElementById("api-bar");
  const apiKeyField = document.getElementById("api-key-field");

  let map = null;

  function startApp(apiKey) {
    if (apiKey !== null && apiKey !== undefined && apiKey !== "") {
      localStorage.setItem("tisseo_api_key", apiKey);
    }
    const storedKey = localStorage.getItem("tisseo_api_key") || apiKey || "";

    apiKeyField.value = storedKey;
    apiBarEl.style.display = "flex";

    map = L.map("map", {
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

    loadItiNetwork(map, statusEl);

    setTimeout(() => {
      if (map) map.invalidateSize();
    }, 100);
  }

  // Always show modal dialog at startup since localStorage is cleaned
  modalEl.style.display = "flex";

  submitBtn.addEventListener("click", () => {
    const val = inputEl.value.trim();
    modalEl.style.display = "none";
    startApp(val);
  });

  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      submitBtn.click();
    }
  });
})();
