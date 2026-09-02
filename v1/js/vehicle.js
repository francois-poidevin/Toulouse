// Generic animated top-down vehicle marker: pixel-art sprite sheet (4 frames)
// cycling via CSS background-position, rotated to follow heading. One sprite
// definition per Tisseo transport mode; createVehicleMarker() spawns a
// Leaflet marker driven by this animation for any of them.

const VEHICLE_SPRITES = {
  bus: { url: "assets/bus-sprite.png", frameWidth: 78, frameHeight: 120, frameCount: 4, fps: 6 },
  lineo: { url: "assets/lineo-sprite.png", frameWidth: 78, frameHeight: 120, frameCount: 4, fps: 6 },
  tram: { url: "assets/tram-sprite.png", frameWidth: 72, frameHeight: 150, frameCount: 4, fps: 5 },
  metro: { url: "assets/metro-sprite.png", frameWidth: 60, frameHeight: 150, frameCount: 4, fps: 7 },
  telepherique: { url: "assets/telepherique-sprite.png", frameWidth: 54, frameHeight: 54, frameCount: 4, fps: 4 },
};

// Scale factor applied to raw sprite pixel size to get on-map icon size.
const VEHICLE_ICON_SCALE = 0.5;

function spriteForMode(mode) {
  return VEHICLE_SPRITES[mode] || VEHICLE_SPRITES.bus;
}

/**
 * Creates a Leaflet marker representing an animated pixel-art vehicle for
 * the given transport mode. Returns handles to drive its per-frame
 * animation and heading rotation from an external render loop.
 */
function createVehicleMarker(map, mode, startLatLng) {
  const sprite = spriteForMode(mode);
  const iconSize = [
    sprite.frameWidth * VEHICLE_ICON_SCALE,
    sprite.frameHeight * VEHICLE_ICON_SCALE,
  ];

  const icon = L.divIcon({
    className: "",
    html: `<div class="vehicle-anim" style="
        width:${iconSize[0]}px;
        height:${iconSize[1]}px;
        background-image:url('${sprite.url}');
        background-repeat:no-repeat;
        background-size:${sprite.frameWidth * sprite.frameCount * VEHICLE_ICON_SCALE}px ${iconSize[1]}px;
        image-rendering:pixelated;
        filter:drop-shadow(0 2px 3px rgba(0,0,0,0.55));
        transform-origin:50% 50%;
      "></div>`,
    iconSize,
    iconAnchor: [iconSize[0] / 2, iconSize[1] / 2],
  });

  const marker = L.marker(startLatLng, { icon, interactive: false }).addTo(map);

  let frame = 0;
  const frameIntervalMs = 1000 / sprite.fps;
  let lastFrameTime = performance.now() + Math.random() * 1000; // desync frames across vehicles

  function tickAnimation(now) {
    if (now - lastFrameTime >= frameIntervalMs) {
      frame = (frame + 1) % sprite.frameCount;
      lastFrameTime = now;
      const el = marker.getElement();
      if (el) {
        const inner = el.querySelector(".vehicle-anim");
        if (inner) {
          inner.style.backgroundPosition = `-${frame * iconSize[0]}px 0px`;
        }
      }
    }
  }

  function setHeading(degrees) {
    const el = marker.getElement();
    if (el) {
      const inner = el.querySelector(".vehicle-anim");
      if (inner) {
        inner.style.transform = `rotate(${degrees}deg)`;
      }
    }
  }

  function setLatLng(latLng) {
    marker.setLatLng(latLng);
  }

  function remove() {
    map.removeLayer(marker);
  }

  return { marker, tickAnimation, setHeading, setLatLng, remove };
}

/**
 * Computes the bearing in degrees (0 = north, clockwise) between two
 * [lat, lng] points, for orienting a top-down sprite along its path.
 */
function bearingBetween(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const dLon = toRad(b[1] - a[1]);

  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const brng = toDeg(Math.atan2(y, x));
  return (brng + 360) % 360;
}

/**
 * Wraps a static polyline path into a self-contained "traveller" that can be
 * advanced by an elapsed-time delta, looping back and forth (or wrapping
 * around, for closed-ish loops) along the path at a constant speed.
 *
 * pathLatLngs: array of [lat, lng], already in travel order.
 * speedMps: travel speed in meters/second.
 */
function createPathTraveller(pathLatLngs, speedMps) {
  function haversineMeters(a, b) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(b[0] - a[0]);
    const dLon = toRad(b[1] - a[1]);
    const lat1 = toRad(a[0]);
    const lat2 = toRad(b[0]);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  const cumulative = [0];
  for (let i = 1; i < pathLatLngs.length; i++) {
    cumulative.push(
      cumulative[i - 1] + haversineMeters(pathLatLngs[i - 1], pathLatLngs[i])
    );
  }
  const totalDistance = cumulative[cumulative.length - 1] || 1;

  function positionAtDistance(distanceMeters) {
    const d = Math.max(0, Math.min(totalDistance, distanceMeters));
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] <= d) lo = mid;
      else hi = mid;
    }
    const segStart = cumulative[lo];
    const segEnd = cumulative[hi];
    const segLen = segEnd - segStart || 1;
    const t = (d - segStart) / segLen;
    const a = pathLatLngs[lo];
    const b = pathLatLngs[hi];
    const lat = a[0] + (b[0] - a[0]) * t;
    const lng = a[1] + (b[1] - a[1]) * t;
    return { latLng: [lat, lng], from: a, to: b };
  }

  // Start each traveller at a random offset along its own path so that all
  // vehicles don't appear bunched at their route's origin simultaneously.
  let distanceTravelled = Math.random() * totalDistance;
  let direction = Math.random() < 0.5 ? 1 : -1;

  function advance(dtSeconds) {
    distanceTravelled += direction * speedMps * dtSeconds;
    if (distanceTravelled >= totalDistance) {
      distanceTravelled = totalDistance;
      direction = -1;
    } else if (distanceTravelled <= 0) {
      distanceTravelled = 0;
      direction = 1;
    }
    const { latLng, from, to } = positionAtDistance(distanceTravelled);
    const heading =
      direction === 1 ? bearingBetween(from, to) : bearingBetween(to, from);
    return { latLng, heading };
  }

  return { advance, totalDistance };
}
