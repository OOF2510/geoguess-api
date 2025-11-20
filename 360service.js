const {
  getRandomMapillaryImage,
  reverseGeocodeCountry,
} = require("./imageService.js");

const panoCache = [];
const FILL_CACHE_CONCURRENCY = 5;
const MAX_PANOS_PER_COUNTRY = 2;
let backgroundFillPromise = null;

function getCountryKey(countryCode, countryName) {
  if (countryCode) return countryCode.toUpperCase();
  if (countryName) return countryName.trim().toUpperCase();
  return "UNKNOWN";
}

function canStoreCountry(countryKey) {
  let count = 0;
  for (const item of panoCache) {
    const key =
      item.countryKey || getCountryKey(item.countryCode, item.countryName);
    if (key === countryKey) {
      count += 1;
      if (count >= MAX_PANOS_PER_COUNTRY) {
        return false;
      }
    }
  }
  return true;
}

async function fetchAndStorePanorama(token) {
  const pano = await getRandomMapillaryImage(token, { pano: true });
  if (!pano || !pano.url || !pano.coord) {
    return false;
  }

  const { lat, lon } = pano.coord;
  const countryInfo = (await reverseGeocodeCountry(lat, lon)) || {
    country: null,
    countryCode: null,
    displayName: "Unknown",
  };

  const countryKey = getCountryKey(
    countryInfo.countryCode,
    countryInfo.displayName,
  );
  if (!canStoreCountry(countryKey)) {
    console.log(
      `Skipping pano cache entry for ${countryInfo.displayName || "Unknown"}; already have ${MAX_PANOS_PER_COUNTRY} panoramas`,
    );
    return false;
  }

  panoCache.push({
    imageUrl: pano.url,
    imageId: pano.id,
    contributor: pano.contributor || null,
    coordinates: { lat, lon },
    countryName: countryInfo.displayName,
    countryCode: countryInfo.countryCode,
    country: countryInfo.country,
    countryKey,
  });

  return true;
}

async function fillPanoCache(numImages) {
  const token = process.env.MAP_API_KEY;
  const target = Math.max(0, Math.floor(Number(numImages) || 0));
  if (!token || target <= 0) {
    return;
  }

  console.log(
    `Filling pano cache with ${target} images (up to ${FILL_CACHE_CONCURRENCY} parallel requests)...`,
  );

  let cursor = 0;
  let added = 0;
  const workerCount = Math.min(FILL_CACHE_CONCURRENCY, target);
  const maxAttempts = target * 5;

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      if (added >= target) {
        break;
      }
      if (cursor >= maxAttempts) {
        break;
      }
      cursor += 1;
      try {
        const success = await fetchAndStorePanorama(token);
        if (success) {
          added += 1;
        }
      } catch (err) {
        console.error("Error filling pano cache:", err && err.message);
      }
    }
  });

  await Promise.all(workers);
  console.log(
    `Pano cache fill complete. Added ${added} images. Cache size now ${panoCache.length}`,
  );
  if (added < target) {
    console.warn(
      `Pano cache fill stopped early: added ${added} of ${target} requested images (max attempts ${maxAttempts})`,
    );
  }
}

async function refillPanoCache() {
  if (panoCache.length < 5 && !backgroundFillPromise) {
    backgroundFillPromise = fillPanoCache(5)
      .catch((error) => {
        console.error("Background pano cache fill error:", error && error.message);
      })
      .finally(() => {
        backgroundFillPromise = null;
      });
  }
}

async function getPanoPayload() {
  const token = process.env.MAP_API_KEY;
  if (!token) {
    throw new Error("Mapillary access token missing in environment variables.");
  }

  if (panoCache.length === 0) {
    fillPanoCache(10).catch((err) => {
      console.error("Failed to trigger pano cache refill:", err && err.message);
    });

    const pano = await getRandomMapillaryImage(token, { pano: true });
    if (!pano || !pano.url || !pano.coord) {
      throw new Error(
        "Could not fetch a random panorama right now. Please try again.",
      );
    }

    const { lat, lon } = pano.coord;
    const countryInfo = (await reverseGeocodeCountry(lat, lon)) || {
      country: null,
      countryCode: null,
      displayName: "Unknown",
    };

    return {
      imageUrl: pano.url,
      coordinates: { lat, lon },
      countryName: countryInfo.displayName || "Unknown",
      countryCode: countryInfo.countryCode || null,
      contributor: pano.contributor || null,
    };
  }

  refillPanoCache();

  if (panoCache.length === 0) {
    throw new Error(
      "Could not fetch a cached panorama right now. Please try again.",
    );
  }

  const idx = Math.floor(Math.random() * panoCache.length);
  const cachedPano = panoCache.splice(idx, 1)[0];
  if (!cachedPano) {
    throw new Error(
      "Could not fetch a cached panorama right now. Please try again.",
    );
  }

  return {
    imageUrl: cachedPano.imageUrl,
    coordinates: cachedPano.coordinates,
    countryName: cachedPano.countryName || "Unknown",
    countryCode: cachedPano.countryCode || null,
    contributor: cachedPano.contributor || null,
  };
}

(async () => {
  try {
    await fillPanoCache(10);
    console.log("Panorama cache pre-filled with 10 images");
  } catch (error) {
    console.error("Failed to pre-fill panorama cache:", error);
  }
})();

module.exports = {
  panoCache,
  fetchAndStorePanorama,
  fillPanoCache,
  refillPanoCache,
  getPanoPayload,
};
