const axios = require("axios");
const https = require("https");
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });

const imageCache = [];
const FILL_CACHE_CONCURRENCY = 4;
let backgroundFillPromise = null;
const MAX_IMAGES_PER_COUNTRY = 2;
const MAPILLARY_RATE_LIMIT = 900; // stay safely under the official 1000 req/min cap
const MAPILLARY_RATE_WINDOW_MS = 60_000;
const mapillaryCallTimes = [];

function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}

function normalizeLon(lon) {
  let l = lon;
  while (l < -180) l += 360;
  while (l > 180) l -= 360;
  return l;
}

const regionNameFormatter =
  typeof Intl !== "undefined" && typeof Intl.DisplayNames === "function"
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

const COUNTRY_NAME_FALLBACKS = {
  XK: "Kosovo",
  PS: "Palestine",
  BL: "Saint Barthélemy",
  BQ: "Bonaire",
  CW: "Curaçao",
  SX: "Sint Maarten",
  TL: "Timor-Leste",
};

function getCountryNameFromISO(code) {
  if (!code) return null;
  const normalized = code.toUpperCase();
  if (regionNameFormatter) {
    try {
      const name = regionNameFormatter.of(normalized);
      if (name && name !== normalized) {
        return name;
      }
    } catch (err) {}
  }
  return COUNTRY_NAME_FALLBACKS[normalized] || null;
}

function extractCountryInfo(data) {
  if (!data) return null;
  const addr = data.address || {};
  let country = (addr.country || addr.country_name || "").trim();
  let countryCode = (addr.country_code || "").trim().toUpperCase();

  if (country.toLowerCase() === "unknown") {
    country = "";
  }

  if (!country && countryCode) {
    const fallbackName = getCountryNameFromISO(countryCode);
    if (fallbackName) {
      country = fallbackName;
    }
  }

  if (!country && typeof data.display_name === "string") {
    const maybeCountry = data.display_name.split(",").pop().trim();
    const lowercase = maybeCountry.toLowerCase();
    const isWaterBody =
      lowercase.includes("ocean") ||
      lowercase.includes("sea") ||
      lowercase.includes("bay") ||
      lowercase.includes("gulf");
    if (
      maybeCountry &&
      maybeCountry.length <= 60 &&
      !isWaterBody &&
      lowercase !== "unknown"
    ) {
      country = maybeCountry;
    }
  }

  if (country && country.toLowerCase() === "unknown") {
    country = "";
  }

  if (!country && countryCode) {
    country = countryCode;
  }

  if (!country) {
    return null;
  }

  const normalizedCode = countryCode || null;

  return {
    country: country.toLowerCase(),
    countryCode: normalizedCode ? normalizedCode.toUpperCase() : null,
    displayName: country,
  };
}

function getCountryKey(countryCode, countryName) {
  if (countryCode) return countryCode.toUpperCase();
  if (countryName) return countryName.trim().toUpperCase();
  return "UNKNOWN";
}

function canStoreCountry(countryKey) {
  let count = 0;
  for (const item of imageCache) {
    const key =
      item.countryKey || getCountryKey(item.countryCode, item.countryName);
    if (key === countryKey) {
      count += 1;
      if (count >= MAX_IMAGES_PER_COUNTRY) {
        return false;
      }
    }
  }
  return true;
}

const LAND_REGIONS = [
  { name: "North America", left: -168, bottom: 7, right: -52, top: 83 },
  { name: "South America", left: -82, bottom: -56, right: -34, top: 13 },
  { name: "Europe", left: -31, bottom: 34, right: 40, top: 72 },
  { name: "Africa", left: -18, bottom: -35, right: 52, top: 38 },
  { name: "West Asia", left: 25, bottom: 5, right: 75, top: 45 },
  { name: "East Asia", left: 75, bottom: 18, right: 140, top: 55 },
  { name: "SE Asia", left: 90, bottom: -12, right: 150, top: 25 },
  { name: "India", left: 68, bottom: 6, right: 97, top: 36 },
  { name: "Australia", left: 110, bottom: -45, right: 155, top: -10 },
];

function randomLandBBox() {
  const d = 0.09;
  const region = LAND_REGIONS[Math.floor(Math.random() * LAND_REGIONS.length)];
  const lat = region.bottom + Math.random() * (region.top - region.bottom);
  const lon = region.left + Math.random() * (region.right - region.left);
  const box = bboxFromCenter(lat, lon, d);
  return box;
}

async function getRandomMapillaryImage(token) {
  // 1) Try 3 random cities FIRST
  console.log("Trying 3 city fallbacks");
  const cities1 = getRandomCityFallbackBBoxes(3);
  for (const c of cities1) {
    const params = new URLSearchParams();
    params.set("access_token", token);
    params.set(
      "fields",
      "id,computed_geometry,thumb_1024_url,thumb_2048_url,thumb_256_url,thumb_original_url,creator",
    );
    params.set(
      "bbox",
      `${c.left.toFixed(6)},${c.bottom.toFixed(6)},${c.right.toFixed(6)},${c.top.toFixed(6)}`,
    );
    params.set("is_pano", "false");
    params.set("limit", "50");
    try {
      const searchUrl = `https://graph.mapillary.com/images?${params.toString()}`;
      console.log("City fallback", c.name, "bbox", params.get("bbox"));
      const res = await axiosGetWithRetry(
        searchUrl,
        {
          timeout: 4000,
          headers: { "User-Agent": "geoguess-api/1.0" },
        },
        2,
      );
      const arr = (res.data && res.data.data) || [];
      console.log("City results", c.name, arr.length);
      if (!arr.length) continue;
      const choice = arr[Math.floor(Math.random() * arr.length)];
      console.log("City chosen image", c.name, choice && choice.id);
      const img = imageItemToResult(choice);
      if (img) return img;
      const fallback = await getImageDetails(choice.id, token);
      if (fallback) return fallback;
    } catch (e) {
      console.error("City search error", c.name, e && e.message);
    }
  }

  // 2) Random land area
  for (let i = 0; i < 2; i++) {
    const bbox = randomLandBBox();
    const params = new URLSearchParams();
    params.set("access_token", token);
    params.set(
      "fields",
      "id,computed_geometry,thumb_1024_url,thumb_2048_url,thumb_256_url,thumb_original_url,creator",
    );
    params.set(
      "bbox",
      `${bbox.left.toFixed(6)},${bbox.bottom.toFixed(6)},${bbox.right.toFixed(6)},${bbox.top.toFixed(6)}`,
    );
    params.set("is_pano", "false");
    params.set("limit", "35");
    try {
      const searchUrl = `https://graph.mapillary.com/images?${params.toString()}`;
      console.log(
        "Mapillary land (fast) try",
        i + 1,
        "bbox",
        params.get("bbox"),
      );
      const res = await axiosGetWithRetry(
        searchUrl,
        {
          timeout: 2500,
          headers: { "User-Agent": "geoguess-api/1.0" },
        },
        1,
      );
      const arr = (res.data && res.data.data) || [];
      console.log("Mapillary results (land fast)", arr.length);
      if (!arr.length) continue;
      const choice = arr[Math.floor(Math.random() * arr.length)];
      console.log("Chosen image (land fast)", choice && choice.id);
      const img = imageItemToResult(choice);
      if (img) return img;
      const fallback = await getImageDetails(choice.id, token);
      if (fallback) return fallback;
    } catch (e) {
      console.error("Mapillary land (fast) error", e && e.message);
    }
  }

  // 3) Try cities again
  console.log("Trying 3 more city fallbacks");
  const cities2 = getRandomCityFallbackBBoxes(3);
  for (const c of cities2) {
    const params = new URLSearchParams();
    params.set("access_token", token);
    params.set(
      "fields",
      "id,computed_geometry,thumb_1024_url,thumb_2048_url,thumb_256_url,thumb_original_url,creator",
    );
    params.set(
      "bbox",
      `${c.left.toFixed(6)},${c.bottom.toFixed(6)},${c.right.toFixed(6)},${c.top.toFixed(6)}`,
    );
    params.set("is_pano", "false");
    params.set("limit", "50");
    try {
      const searchUrl = `https://graph.mapillary.com/images?${params.toString()}`;
      console.log("City fallback 2", c.name, "bbox", params.get("bbox"));
      const res = await axiosGetWithRetry(
        searchUrl,
        {
          timeout: 4000,
          headers: { "User-Agent": "geoguess-api/1.0" },
        },
        2,
      );
      const arr = (res.data && res.data.data) || [];
      console.log("City results 2", c.name, arr.length);
      if (!arr.length) continue;
      const choice = arr[Math.floor(Math.random() * arr.length)];
      console.log("City chosen image 2", c.name, choice && choice.id);
      const img = imageItemToResult(choice);
      if (img) return img;
      const fallback = await getImageDetails(choice.id, token);
      if (fallback) return fallback;
    } catch (e) {
      console.error("City search error 2", c.name, e && e.message);
    }
  }

  // 4) Two more land searches (normal settings)
  console.log("Trying 2 more land searches");
  for (let i = 0; i < 2; i++) {
    const bbox = randomLandBBox();
    const params = new URLSearchParams();
    params.set("access_token", token);
    params.set(
      "fields",
      "id,computed_geometry,thumb_1024_url,thumb_2048_url,thumb_256_url,thumb_original_url,creator",
    );
    params.set(
      "bbox",
      `${bbox.left.toFixed(6)},${bbox.bottom.toFixed(6)},${bbox.right.toFixed(6)},${bbox.top.toFixed(6)}`,
    );
    params.set("is_pano", "false");
    params.set("limit", "50");
    try {
      const searchUrl = `https://graph.mapillary.com/images?${params.toString()}`;
      console.log(
        "Mapillary land (normal) try",
        i + 1,
        "bbox",
        params.get("bbox"),
      );
      const res = await axiosGetWithRetry(
        searchUrl,
        {
          timeout: 8000,
          headers: { "User-Agent": "geoguess-api/1.0" },
        },
        3,
      );
      const arr = (res.data && res.data.data) || [];
      console.log("Mapillary results (land normal)", arr.length);
      if (!arr.length) continue;
      const choice = arr[Math.floor(Math.random() * arr.length)];
      console.log("Chosen image (land normal)", choice && choice.id);
      const img = imageItemToResult(choice);
      if (img) return img;
      const fallback = await getImageDetails(choice.id, token);
      if (fallback) return fallback;
    } catch (e) {
      console.error("Mapillary land (normal) error", e && e.message);
    }
  }

  // 5) Three true random searches
  console.log("Trying 3 random searches");
  for (let i = 0; i < 3; i++) {
    const bbox = randomBBox();
    const params = new URLSearchParams();
    params.set("access_token", token);
    params.set(
      "fields",
      "id,computed_geometry,thumb_1024_url,thumb_2048_url,thumb_256_url,thumb_original_url,creator",
    );
    params.set(
      "bbox",
      `${bbox.left.toFixed(6)},${bbox.bottom.toFixed(6)},${bbox.right.toFixed(6)},${bbox.top.toFixed(6)}`,
    );
    params.set("is_pano", "false");
    params.set("limit", "50");
    try {
      const searchUrl = `https://graph.mapillary.com/images?${params.toString()}`;
      console.log(
        "Mapillary random search try",
        i + 1,
        "bbox",
        params.get("bbox"),
      );
      const res = await axiosGetWithRetry(
        searchUrl,
        {
          timeout: 20000,
          headers: { "User-Agent": "geoguess-api/1.0" },
        },
        3,
      );
      const arr = (res.data && res.data.data) || [];
      console.log("Mapillary results (random)", arr.length);
      if (!arr.length) continue;
      const choice = arr[Math.floor(Math.random() * arr.length)];
      console.log("Chosen image (random)", choice && choice.id);
      const img = imageItemToResult(choice);
      if (img) return img;
      const fallback = await getImageDetails(choice.id, token);
      if (fallback) return fallback;
    } catch (e) {
      console.error("Mapillary random search error", e && e.message);
    }
  }
  return null;
}

async function getImageDetails(id, token) {
  const params = new URLSearchParams();
  params.set(
    "fields",
    "id,computed_geometry,thumb_1024_url,thumb_2048_url,thumb_256_url,thumb_original_url,creator",
  );
  const url = `https://graph.mapillary.com/${id}?${params.toString()}`;
  const res = await mapillaryGet(url, token, 25000);
  const d = res.data || {};
  const imgUrl =
    d.thumb_1024_url ||
    d.thumb_2048_url ||
    d.thumb_256_url ||
    d.thumb_original_url;
  if (!imgUrl || !d.computed_geometry || !d.computed_geometry.coordinates)
    return null;
  const [lon, lat] = d.computed_geometry.coordinates;
  return {
    url: imgUrl,
    coord: { lat, lon },
    id: d.id,
    contributor: d.creator?.username,
  };
}

function imageItemToResult(item) {
  if (!item) return null;
  const imgUrl =
    item.thumb_1024_url ||
    item.thumb_2048_url ||
    item.thumb_256_url ||
    item.thumb_original_url;
  const cg = item.computed_geometry;
  if (!imgUrl || !cg || !cg.coordinates) return null;
  const [lon, lat] = cg.coordinates;
  return {
    url: imgUrl,
    coord: { lat, lon },
    id: item.id,
    contributor: item.creator?.username,
  };
}

async function mapillaryGet(url, token, timeoutMs) {
  return axiosGetWithRetry(
    url,
    {
      headers: {
        Authorization: `OAuth ${token}`,
        "User-Agent": "geoguess-api/1.0",
      },
      timeout: timeoutMs || 25000,
    },
    3,
  );
}

async function axiosGetWithRetry(url, options, attempts) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      if (typeof url === "string" && url.includes("mapillary.com")) {
        await enforceMapillaryRateLimit();
      }
      return await axios.get(url, { ...options, httpsAgent });
    } catch (e) {
      lastErr = e;
      console.error("HTTP GET retry", i + 1, e && e.message);
      if (i < attempts - 1) {
        const delay = 300 * (i + 1);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

async function enforceMapillaryRateLimit() {
  while (true) {
    const now = Date.now();
    while (
      mapillaryCallTimes.length &&
      now - mapillaryCallTimes[0] >= MAPILLARY_RATE_WINDOW_MS
    ) {
      mapillaryCallTimes.shift();
    }
    if (mapillaryCallTimes.length < MAPILLARY_RATE_LIMIT) {
      mapillaryCallTimes.push(now);
      return;
    }
    const waitMs = MAPILLARY_RATE_WINDOW_MS - (now - mapillaryCallTimes[0]) + 5;
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 200)));
  }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

function getRandomCityFallbackBBoxes(count) {
  const allCities = getCityFallbackBBoxes();
  if (!count || count >= allCities.length) {
    return shuffle(allCities);
  }
  return shuffle(allCities).slice(0, count);
}

function getCityFallbackBBoxes() {
  const d = 0.09;
  const centers = [
    // North America - USA
    { name: "New York", lat: 40.7128, lon: -74.006 },
    { name: "Los Angeles", lat: 34.0522, lon: -118.2437 },
    { name: "San Francisco", lat: 37.7749, lon: -122.4194 },
    { name: "San Diego", lat: 32.7157, lon: -117.1611 },
    { name: "San Jose", lat: 37.3382, lon: -121.8863 },
    { name: "Phoenix", lat: 33.4484, lon: -112.074 },
    { name: "Chicago", lat: 41.8781, lon: -87.6298 },
    { name: "Minneapolis", lat: 44.9778, lon: -93.265 },
    { name: "Denver", lat: 39.7392, lon: -104.9903 },
    { name: "Boston", lat: 42.3601, lon: -71.0589 },
    { name: "Philadelphia", lat: 39.9526, lon: -75.1652 },
    { name: "Washington DC", lat: 38.9072, lon: -77.0369 },
    { name: "Miami", lat: 25.7617, lon: -80.1918 },
    { name: "Seattle", lat: 47.6062, lon: -122.3321 },
    { name: "Portland", lat: 45.5152, lon: -122.6784 },
    { name: "Austin", lat: 30.2672, lon: -97.7431 },
    { name: "San Antonio", lat: 29.4241, lon: -98.4936 },
    { name: "Dallas", lat: 32.7767, lon: -96.797 },
    { name: "Houston", lat: 29.7604, lon: -95.3698 },
    { name: "Atlanta", lat: 33.749, lon: -84.388 },
    { name: "Detroit", lat: 42.3314, lon: -83.0458 },
    { name: "Orlando", lat: 28.5383, lon: -81.3792 },
    { name: "Tampa", lat: 27.9506, lon: -82.4572 },
    { name: "Nashville", lat: 36.1627, lon: -86.7816 },

    // North America - Canada
    { name: "Toronto", lat: 43.6532, lon: -79.3832 },
    { name: "Ottawa", lat: 45.4215, lon: -75.6972 },
    { name: "Vancouver", lat: 49.2827, lon: -123.1207 },
    { name: "Calgary", lat: 51.0447, lon: -114.0719 },
    { name: "Edmonton", lat: 53.5461, lon: -113.4938 },
    { name: "Montreal", lat: 45.5017, lon: -73.5673 },
    { name: "Quebec City", lat: 46.8139, lon: -71.208 },

    // Western Europe
    { name: "London", lat: 51.5074, lon: -0.1278 },
    { name: "Manchester", lat: 53.4808, lon: -2.2426 },
    { name: "Birmingham", lat: 52.4862, lon: -1.8904 },
    { name: "Glasgow", lat: 55.8642, lon: -4.2518 },
    { name: "Edinburgh", lat: 55.9533, lon: -3.1883 },
    { name: "Dublin", lat: 53.3498, lon: -6.2603 },
    { name: "Paris", lat: 48.8566, lon: 2.3522 },
    { name: "Lyon", lat: 45.764, lon: 4.8357 },
    { name: "Marseille", lat: 43.2965, lon: 5.3698 },
    { name: "Toulouse", lat: 43.6047, lon: 1.4442 },
    { name: "Amsterdam", lat: 52.3676, lon: 4.9041 },
    { name: "Rotterdam", lat: 51.9244, lon: 4.4777 },
    { name: "The Hague", lat: 52.0705, lon: 4.3007 },
    { name: "Brussels", lat: 50.8503, lon: 4.3517 },
    { name: "Antwerp", lat: 51.2194, lon: 4.4025 },
    { name: "Berlin", lat: 52.52, lon: 13.405 },
    { name: "Munich", lat: 48.1351, lon: 11.582 },
    { name: "Hamburg", lat: 53.5511, lon: 9.9937 },
    { name: "Cologne", lat: 50.9375, lon: 6.9603 },
    { name: "Frankfurt", lat: 50.1109, lon: 8.6821 },
    { name: "Stuttgart", lat: 48.7758, lon: 9.1829 },
    { name: "Dusseldorf", lat: 51.2277, lon: 6.7735 },
    { name: "Madrid", lat: 40.4168, lon: -3.7038 },
    { name: "Barcelona", lat: 41.3851, lon: 2.1734 },
    { name: "Valencia", lat: 39.4699, lon: -0.3763 },
    { name: "Seville", lat: 37.3891, lon: -5.9845 },
    { name: "Rome", lat: 41.9028, lon: 12.4964 },
    { name: "Milan", lat: 45.4642, lon: 9.19 },
    { name: "Naples", lat: 40.8518, lon: 14.2681 },
    { name: "Turin", lat: 45.0703, lon: 7.6869 },
    { name: "Florence", lat: 43.7696, lon: 11.2558 },
    { name: "Bologna", lat: 44.4949, lon: 11.3426 },
    { name: "Lisbon", lat: 38.7223, lon: -9.1393 },
    { name: "Porto", lat: 41.1579, lon: -8.6291 },
    { name: "Zurich", lat: 47.3769, lon: 8.5417 },
    { name: "Geneva", lat: 46.2044, lon: 6.1432 },
    { name: "Lausanne", lat: 46.5197, lon: 6.6323 },
    { name: "Bern", lat: 46.948, lon: 7.4474 },
    { name: "Vienna", lat: 48.2082, lon: 16.3738 },
    { name: "Prague", lat: 50.0755, lon: 14.4378 },
    { name: "Brno", lat: 49.1951, lon: 16.6068 },
    { name: "Bratislava", lat: 48.1486, lon: 17.1077 },
    { name: "Warsaw", lat: 52.2297, lon: 21.0122 },
    { name: "Krakow", lat: 50.0647, lon: 19.945 },
    { name: "Gdansk", lat: 54.352, lon: 18.6466 },
    { name: "Budapest", lat: 47.4979, lon: 19.0402 },
    { name: "Bucharest", lat: 44.4268, lon: 26.1025 },
    { name: "Athens", lat: 37.9838, lon: 23.7275 },
    { name: "Thessaloniki", lat: 40.6401, lon: 22.9444 },
    { name: "Helsinki", lat: 60.1699, lon: 24.9384 },
    { name: "Gothenburg", lat: 57.7089, lon: 11.9746 },
    { name: "Malmo", lat: 55.604981, lon: 13.003822 },
    { name: "Copenhagen", lat: 55.6761, lon: 12.5683 },
    { name: "Oslo", lat: 59.9139, lon: 10.7522 },
    { name: "Bergen", lat: 60.3913, lon: 5.3221 },
    { name: "Trondheim", lat: 63.4305, lon: 10.3951 },
    { name: "Aarhus", lat: 56.1629, lon: 10.2039 },

    // Central & Eastern Europe
    { name: "Vilnius", lat: 54.6872, lon: 25.2797 },
    { name: "Riga", lat: 56.9496, lon: 24.1052 },
    { name: "Tallinn", lat: 59.437, lon: 24.7536 },
    { name: "Kyiv", lat: 50.4501, lon: 30.5234 },
    { name: "Lviv", lat: 49.8397, lon: 24.0297 },
    { name: "Sofia", lat: 42.6977, lon: 23.3219 },
    { name: "Belgrade", lat: 44.7866, lon: 20.4489 },
    { name: "Zagreb", lat: 45.815, lon: 15.9819 },
    { name: "Ljubljana", lat: 46.0569, lon: 14.5058 },
    { name: "Sarajevo", lat: 43.8563, lon: 18.4131 },
    { name: "Tirana", lat: 41.3275, lon: 19.8187 },
    { name: "Skopje", lat: 41.9973, lon: 21.428 },
    { name: "Pristina", lat: 42.6629, lon: 21.1655 },
    { name: "Chisinau", lat: 47.0105, lon: 28.8638 },
    { name: "Istanbul", lat: 41.0082, lon: 28.9784 },

    // Eastern Europe / Russia
    { name: "Moscow", lat: 55.7558, lon: 37.6173 },
    { name: "St Petersburg", lat: 59.9311, lon: 30.3609 },

    // Central Asia
    { name: "Almaty", lat: 43.222, lon: 76.8512 },
    { name: "Astana", lat: 51.1694, lon: 71.4491 },
    { name: "Tashkent", lat: 41.2995, lon: 69.2401 },
    { name: "Bishkek", lat: 42.8746, lon: 74.5698 },
    { name: "Dushanbe", lat: 38.5598, lon: 68.787 },
    { name: "Ulaanbaatar", lat: 47.8864, lon: 106.9057 },

    // East Asia
    { name: "Tokyo", lat: 35.6762, lon: 139.6503 },
    { name: "Osaka", lat: 34.6937, lon: 135.5023 },
    { name: "Kyoto", lat: 35.0116, lon: 135.7681 },
    { name: "Nagoya", lat: 35.1815, lon: 136.9066 },
    { name: "Fukuoka", lat: 33.5904, lon: 130.4017 },
    { name: "Sapporo", lat: 43.0618, lon: 141.3545 },
    { name: "Seoul", lat: 37.5665, lon: 126.978 },
    { name: "Incheon", lat: 37.4563, lon: 126.7052 },
    { name: "Daegu", lat: 35.8714, lon: 128.6014 },
    { name: "Daejeon", lat: 36.3504, lon: 127.3845 },
    { name: "Busan", lat: 35.1796, lon: 129.0756 },
    { name: "Taipei", lat: 25.033, lon: 121.5654 },
    { name: "Kaohsiung", lat: 22.6273, lon: 120.3014 },
    { name: "Taichung", lat: 24.1477, lon: 120.6736 },
    { name: "Hong Kong", lat: 22.3193, lon: 114.1694 },

    // Southeast Asia
    { name: "Singapore", lat: 1.3521, lon: 103.8198 },
    { name: "Kuala Lumpur", lat: 3.139, lon: 101.6869 },
    { name: "Penang", lat: 5.4141, lon: 100.3288 },
    { name: "Johor Bahru", lat: 1.4927, lon: 103.7414 },
    { name: "Bangkok", lat: 13.7563, lon: 100.5018 },
    { name: "Chiang Mai", lat: 18.7883, lon: 98.9853 },
    { name: "Jakarta", lat: -6.2088, lon: 106.8456 },
    { name: "Surabaya", lat: -7.2575, lon: 112.7521 },
    { name: "Bandung", lat: -6.9175, lon: 107.6191 },
    { name: "Yogyakarta", lat: -7.7956, lon: 110.3695 },
    { name: "Denpasar", lat: -8.6705, lon: 115.2126 },
    { name: "Manila", lat: 14.5995, lon: 120.9842 },
    { name: "Cebu", lat: 10.3157, lon: 123.8854 },
    { name: "Davao", lat: 7.1907, lon: 125.4553 },
    { name: "Ho Chi Minh City", lat: 10.8231, lon: 106.6297 },
    { name: "Da Nang", lat: 16.0544, lon: 108.2022 },
    { name: "Hanoi", lat: 21.0278, lon: 105.8342 },
    { name: "Phnom Penh", lat: 11.5564, lon: 104.9282 },
    { name: "Siem Reap", lat: 13.3671, lon: 103.8448 },
    { name: "Vientiane", lat: 17.9757, lon: 102.6331 },
    { name: "Yangon", lat: 16.8409, lon: 96.1735 },

    // Middle East
    { name: "Dubai", lat: 25.2048, lon: 55.2708 },
    { name: "Abu Dhabi", lat: 24.4539, lon: 54.3773 },
    { name: "Sharjah", lat: 25.3463, lon: 55.4209 },
    { name: "Riyadh", lat: 24.7136, lon: 46.6753 },
    { name: "Jeddah", lat: 21.4858, lon: 39.1925 },
    { name: "Doha", lat: 25.2854, lon: 51.531 },
    { name: "Kuwait City", lat: 29.3759, lon: 47.9774 },
    { name: "Muscat", lat: 23.588, lon: 58.3829 },
    { name: "Tel Aviv", lat: 32.0853, lon: 34.7818 },
    { name: "Amman", lat: 31.9454, lon: 35.9284 },
    { name: "Beirut", lat: 33.8938, lon: 35.5018 },
    { name: "Jerusalem", lat: 31.7683, lon: 35.2137 },
    { name: "Tehran", lat: 35.6892, lon: 51.389 },
    { name: "Baghdad", lat: 33.3152, lon: 44.3661 },
    { name: "Manama", lat: 26.2235, lon: 50.5876 },

    // Africa
    { name: "Cairo", lat: 30.0444, lon: 31.2357 },
    { name: "Alexandria", lat: 31.2001, lon: 29.9187 },
    { name: "Johannesburg", lat: -26.2041, lon: 28.0473 },
    { name: "Pretoria", lat: -25.7479, lon: 28.2293 },
    { name: "Durban", lat: -29.8587, lon: 31.0218 },
    { name: "Cape Town", lat: -33.9249, lon: 18.4241 },
    { name: "Nairobi", lat: -1.2921, lon: 36.8219 },
    { name: "Mombasa", lat: -4.0435, lon: 39.6682 },
    { name: "Addis Ababa", lat: 8.9806, lon: 38.7578 },
    { name: "Dar es Salaam", lat: -6.7924, lon: 39.2083 },
    { name: "Kampala", lat: 0.3476, lon: 32.5825 },
    { name: "Kigali", lat: -1.9579, lon: 30.1127 },
    { name: "Lagos", lat: 6.5244, lon: 3.3792 },
    { name: "Abuja", lat: 9.0765, lon: 7.3986 },
    { name: "Accra", lat: 5.6037, lon: -0.187 },
    { name: "Casablanca", lat: 33.5731, lon: -7.5898 },
    { name: "Rabat", lat: 34.0209, lon: -6.8416 },
    { name: "Marrakesh", lat: 31.6295, lon: -7.9811 },
    { name: "Tunis", lat: 36.8065, lon: 10.1815 },
    { name: "Algiers", lat: 36.7538, lon: 3.0588 },
    { name: "Dakar", lat: 14.7167, lon: -17.4677 },
    { name: "Abidjan", lat: 5.3453, lon: -4.0244 },
    { name: "Bamako", lat: 12.6392, lon: -8.0029 },
    { name: "Ouagadougou", lat: 12.3714, lon: -1.5197 },
    { name: "Cotonou", lat: 6.3771, lon: 2.4251 },
    { name: "Lome", lat: 6.1725, lon: 1.2314 },
    { name: "Freetown", lat: 8.4657, lon: -13.2317 },
    { name: "Conakry", lat: 9.6412, lon: -13.5784 },
    { name: "Nouakchott", lat: 18.0735, lon: -15.9582 },
    { name: "Douala", lat: 4.0511, lon: 9.7679 },
    { name: "Yaounde", lat: 3.848, lon: 11.5021 },
    { name: "Luanda", lat: -8.839, lon: 13.2894 },
    { name: "Lusaka", lat: -15.3875, lon: 28.3228 },
    { name: "Harare", lat: -17.8252, lon: 31.0335 },
    { name: "Maputo", lat: -25.9692, lon: 32.5732 },
    { name: "Windhoek", lat: -22.5609, lon: 17.0658 },
    { name: "Gaborone", lat: -24.6282, lon: 25.9231 },
    { name: "Antananarivo", lat: -18.8792, lon: 47.5079 },
    { name: "Port Louis", lat: -20.1609, lon: 57.5012 },
    { name: "Khartoum", lat: 15.5007, lon: 32.5599 },

    // Latin America
    { name: "Mexico City", lat: 19.4326, lon: -99.1332 },
    { name: "Guadalajara", lat: 20.6597, lon: -103.3496 },
    { name: "Monterrey", lat: 25.6866, lon: -100.3161 },
    { name: "Tijuana", lat: 32.5149, lon: -117.0382 },
    { name: "Guatemala City", lat: 14.6349, lon: -90.5069 },
    { name: "San Salvador", lat: 13.6929, lon: -89.2182 },
    { name: "Tegucigalpa", lat: 14.0723, lon: -87.1921 },
    { name: "Managua", lat: 12.114, lon: -86.2362 },
    { name: "San Jose (CR)", lat: 9.9281, lon: -84.0907 },
    { name: "Panama City", lat: 8.9824, lon: -79.5199 },
    { name: "Belize City", lat: 17.5046, lon: -88.1962 },
    { name: "Havana", lat: 23.1136, lon: -82.3666 },
    { name: "Santo Domingo", lat: 18.4861, lon: -69.9312 },
    { name: "San Juan", lat: 18.4655, lon: -66.1057 },
    { name: "Kingston", lat: 17.9712, lon: -76.792 },
    { name: "Port of Spain", lat: 10.6549, lon: -61.5019 },
    { name: "Bridgetown", lat: 13.0975, lon: -59.6167 },
    { name: "Nassau", lat: 25.0443, lon: -77.3504 },
    { name: "Bogota", lat: 4.711, lon: -74.0721 },
    { name: "Medellin", lat: 6.2442, lon: -75.5812 },
    { name: "Cali", lat: 3.4516, lon: -76.532 },
    { name: "Lima", lat: -12.0464, lon: -77.0428 },
    { name: "Cusco", lat: -13.5319, lon: -71.9675 },
    { name: "Arequipa", lat: -16.409, lon: -71.5375 },
    { name: "Quito", lat: -0.1807, lon: -78.4678 },
    { name: "Guayaquil", lat: -2.1709, lon: -79.9224 },
    { name: "Santiago", lat: -33.4489, lon: -70.6693 },
    { name: "Valparaiso", lat: -33.0472, lon: -71.6127 },
    { name: "La Paz", lat: -16.4897, lon: -68.1193 },
    { name: "Santa Cruz de la Sierra", lat: -17.7833, lon: -63.1821 },
    { name: "Buenos Aires", lat: -34.6037, lon: -58.3816 },
    { name: "Cordoba", lat: -31.4201, lon: -64.1888 },
    { name: "Rosario", lat: -32.9442, lon: -60.6505 },
    { name: "Rio de Janeiro", lat: -22.9068, lon: -43.1729 },
    { name: "São Paulo", lat: -23.5505, lon: -46.6333 },
    { name: "Curitiba", lat: -25.4284, lon: -49.2733 },
    { name: "Porto Alegre", lat: -30.0346, lon: -51.2177 },
    { name: "Belo Horizonte", lat: -19.9167, lon: -43.9345 },
    { name: "Recife", lat: -8.0476, lon: -34.877 },
    { name: "Fortaleza", lat: -3.7319, lon: -38.5267 },
    { name: "Brasilia", lat: -15.7939, lon: -47.8828 },
    { name: "Asuncion", lat: -25.2637, lon: -57.5759 },
    { name: "Montevideo", lat: -34.9011, lon: -56.1645 },
    { name: "Georgetown (GY)", lat: 6.8013, lon: -58.1551 },
    { name: "Paramaribo", lat: 5.852, lon: -55.2038 },

    // Oceania
    { name: "Sydney", lat: -33.8688, lon: 151.2093 },
    { name: "Melbourne", lat: -37.8136, lon: 144.9631 },
    { name: "Adelaide", lat: -34.9285, lon: 138.6007 },
    { name: "Canberra", lat: -35.2809, lon: 149.13 },
    { name: "Brisbane", lat: -27.4698, lon: 153.0251 },
    { name: "Gold Coast", lat: -28.0167, lon: 153.4 },
    { name: "Perth", lat: -31.9505, lon: 115.8605 },
    { name: "Auckland", lat: -36.8485, lon: 174.7633 },
    { name: "Wellington", lat: -41.2866, lon: 174.7756 },
    { name: "Christchurch", lat: -43.5321, lon: 172.6362 },
    { name: "Hamilton (NZ)", lat: -37.787, lon: 175.2793 },
    { name: "Port Moresby", lat: -9.4431, lon: 147.1797 },
    { name: "Suva", lat: -18.1248, lon: 178.4501 },
    { name: "Noumea", lat: -22.2711, lon: 166.438 },
    { name: "Honiara", lat: -9.4456, lon: 159.9729 },

    // South Asia
    { name: "Delhi", lat: 28.6139, lon: 77.209 },
    { name: "Mumbai", lat: 19.076, lon: 72.8777 },
    { name: "Bengaluru", lat: 12.9716, lon: 77.5946 },
    { name: "Chennai", lat: 13.0827, lon: 80.2707 },
    { name: "Kolkata", lat: 22.5726, lon: 88.3639 },
    { name: "Hyderabad", lat: 17.385, lon: 78.4867 },
    { name: "Pune", lat: 18.5204, lon: 73.8567 },
    { name: "Ahmedabad", lat: 23.0225, lon: 72.5714 },
    { name: "Jaipur", lat: 26.9124, lon: 75.7873 },
    { name: "Lucknow", lat: 26.8467, lon: 80.9462 },
    { name: "Surat", lat: 21.1702, lon: 72.8311 },
    { name: "Indore", lat: 22.7196, lon: 75.8577 },
    { name: "Karachi", lat: 24.8607, lon: 67.0011 },
    { name: "Lahore", lat: 31.5204, lon: 74.3587 },
    { name: "Islamabad", lat: 33.6844, lon: 73.0479 },
    { name: "Dhaka", lat: 23.8103, lon: 90.4125 },
    { name: "Chittagong", lat: 22.3569, lon: 91.7832 },
    { name: "Colombo", lat: 6.9271, lon: 79.8612 },
    { name: "Kathmandu", lat: 27.7172, lon: 85.324 },
  ];
  return centers.map((c) => ({
    name: c.name,
    ...bboxFromCenter(c.lat, c.lon, d),
  }));
}

function bboxFromCenter(lat, lon, d) {
  const minLat = clamp(lat - d / 2, -90, 90);
  const maxLat = clamp(lat + d / 2, -90, 90);
  let minLon = lon - d / 2;
  let maxLon = lon + d / 2;
  if (minLon < -180) {
    minLon += 360;
  }
  if (maxLon > 180) {
    maxLon -= 360;
  }
  if (minLon > maxLon) {
    const center = normalizeLon(lon);
    minLon = clamp(center - d / 2, -180, 180);
    maxLon = clamp(center + d / 2, -180, 180);
  }
  return { left: minLon, bottom: minLat, right: maxLon, top: maxLat };
}

function randomBBox() {
  const lat = Math.random() * 170 - 85;
  const lon = Math.random() * 360 - 180;
  const d = 0.09;
  const minLat = clamp(lat - d / 2, -90, 90);
  const maxLat = clamp(lat + d / 2, -90, 90);
  let minLon = lon - d / 2;
  let maxLon = lon + d / 2;
  if (minLon < -180) {
    minLon += 360;
  }
  if (maxLon > 180) {
    maxLon -= 360;
  }
  if (minLon > maxLon) {
    const center = normalizeLon(lon);
    minLon = clamp(center - d / 2, -180, 180);
    maxLon = clamp(center + d / 2, -180, 180);
  }
  return { left: minLon, bottom: minLat, right: maxLon, top: maxLat };
}

async function reverseGeocodeCountry(lat, lon) {
  const url = "https://nominatim.openstreetmap.org/reverse";
  const zoomLevels = [3, 5, 10];

  // Primary service: OpenStreetMap Nominatim with multiple zoom levels
  for (const zoom of zoomLevels) {
    try {
      const res = await axios.get(url, {
        params: {
          format: "jsonv2",
          lat,
          lon,
          zoom,
          addressdetails: 1,
          "accept-language": "en",
        },
        headers: { "User-Agent": "geoguess-api/1.0" },
        timeout: 10000,
      });

      const countryInfo = extractCountryInfo(res.data);
      if (countryInfo) {
        console.log(
          `Successfully geocoded (${lat}, ${lon}) using Nominatim zoom ${zoom}`,
        );
        return countryInfo;
      }
      console.log(
        `Reverse geocode fallback needed (zoom ${zoom}) for`,
        lat,
        lon,
      );
    } catch (e) {
      console.error("Reverse geocode error", `zoom ${zoom}`, e && e.message);
    }
  }

  // Fallback 1: BigDataCloud
  console.log(`Trying BigDataCloud fallback for (${lat}, ${lon})`);
  const fallbackInfo = await reverseGeocodeFallbackService(lat, lon);
  if (fallbackInfo) {
    console.log(`Successfully geocoded (${lat}, ${lon}) using BigDataCloud`);
    return fallbackInfo;
  }

  // Fallback 2: Geocode.xyz
  console.log(`Trying Geocode.xyz fallback for (${lat}, ${lon})`);
  const geocodeXyzInfo = await reverseGeocodeXyzService(lat, lon);
  if (geocodeXyzInfo) {
    console.log(`Successfully geocoded (${lat}, ${lon}) using Geocode.xyz`);
    return geocodeXyzInfo;
  }

  // Fallback 3: GeoNames
  console.log(`Trying GeoNames fallback for (${lat}, ${lon})`);
  const geoNamesInfo = await reverseGeocodeGeoNames(lat, lon);
  if (geoNamesInfo) {
    console.log(`Successfully geocoded (${lat}, ${lon}) using GeoNames`);
    return geoNamesInfo;
  }

  // Fallback 4: Manual country lookup based on coordinates
  console.log(`Trying coordinate-based country lookup for (${lat}, ${lon})`);
  const coordBasedInfo = await getCountryFromCoordinates(lat, lon);
  if (coordBasedInfo) {
    console.log(
      `Successfully geocoded (${lat}, ${lon}) using coordinate-based lookup`,
    );
    return coordBasedInfo;
  }

  console.warn(
    "All reverse geocode attempts failed to resolve country for",
    lat,
    lon,
  );
  return null;
}

async function reverseGeocodeFallbackService(lat, lon) {
  try {
    const res = await axios.get(
      "https://api.bigdatacloud.net/data/reverse-geocode-client",
      {
        params: {
          latitude: lat,
          longitude: lon,
          localityLanguage: "en",
        },
        headers: { "User-Agent": "geoguess-api/1.0" },
        timeout: 10000,
      },
    );

    const data = res.data || {};
    let countryName = (data.countryName || "").trim();
    const countryCode = (data.countryCode || "").trim().toUpperCase();

    if (!countryName && countryCode) {
      const fallbackName = getCountryNameFromISO(countryCode);
      if (fallbackName) {
        countryName = fallbackName;
      }
    }

    if (!countryName && !countryCode) {
      console.log("BigDataCloud returned no country data");
      return null;
    }

    const fallback = {
      country: countryName ? countryName.toLowerCase() : null,
      countryCode: countryCode || null,
      displayName: countryName || countryCode,
    };

    if (!fallback.displayName) {
      return null;
    }

    if (!fallback.country) {
      fallback.country = fallback.displayName.toLowerCase();
    }

    return fallback;
  } catch (error) {
    console.error(
      "BigDataCloud reverse geocode error:",
      error && error.message,
    );
    return null;
  }
}

// Fallback service 2: Geocode.xyz
async function reverseGeocodeXyzService(lat, lon) {
  try {
    const res = await axios.get("https://geocode.xyz/" + lat + "," + lon, {
      params: {
        json: 1,
        geoit: "json",
      },
      headers: { "User-Agent": "geoguess-api/1.0" },
      timeout: 12000,
    });

    const data = res.data || {};
    let countryName = (data.country || "").trim();
    const countryCode = (data.prov || data.countrycode || "")
      .trim()
      .toUpperCase();

    // Filter out error messages
    if (countryName.includes("Throttled") || countryName.includes("error")) {
      console.log("Geocode.xyz throttled or error response");
      return null;
    }

    if (!countryName && countryCode) {
      const fallbackName = getCountryNameFromISO(countryCode);
      if (fallbackName) {
        countryName = fallbackName;
      }
    }

    if (!countryName && !countryCode) {
      console.log("Geocode.xyz returned no country data");
      return null;
    }

    const result = {
      country: countryName ? countryName.toLowerCase() : null,
      countryCode: countryCode || null,
      displayName: countryName || countryCode,
    };

    if (!result.displayName) {
      return null;
    }

    if (!result.country) {
      result.country = result.displayName.toLowerCase();
    }

    return result;
  } catch (error) {
    console.error("Geocode.xyz reverse geocode error:", error && error.message);
    return null;
  }
}

// Fallback service 3: GeoNames (using free API)
async function reverseGeocodeGeoNames(lat, lon) {
  try {
    // Using the free geonames service - requires username but "demo" works for limited requests
    const res = await axios.get("http://api.geonames.org/countryCodeJSON", {
      params: {
        lat: lat,
        lng: lon,
        username: "demo",
        radius: 10,
      },
      headers: { "User-Agent": "geoguess-api/1.0" },
      timeout: 10000,
    });

    const data = res.data || {};
    const countryCode = (data.countryCode || "").trim().toUpperCase();
    let countryName = (data.countryName || "").trim();

    if (!countryName && countryCode) {
      const fallbackName = getCountryNameFromISO(countryCode);
      if (fallbackName) {
        countryName = fallbackName;
      }
    }

    if (!countryName && !countryCode) {
      console.log("GeoNames returned no country data");
      return null;
    }

    const result = {
      country: countryName ? countryName.toLowerCase() : null,
      countryCode: countryCode || null,
      displayName: countryName || countryCode,
    };

    if (!result.displayName) {
      return null;
    }

    if (!result.country) {
      result.country = result.displayName.toLowerCase();
    }

    return result;
  } catch (error) {
    console.error("GeoNames reverse geocode error:", error && error.message);
    return null;
  }
}

// Fallback service 4: Coordinate-based country lookup using rough bounding boxes
async function getCountryFromCoordinates(lat, lon) {
  // Rough country bounding boxes for major countries
  const countryBounds = [
    {
      name: "United States",
      code: "US",
      minLat: 24,
      maxLat: 50,
      minLon: -125,
      maxLon: -66,
    },
    {
      name: "Canada",
      code: "CA",
      minLat: 42,
      maxLat: 84,
      minLon: -141,
      maxLon: -52,
    },
    {
      name: "Mexico",
      code: "MX",
      minLat: 14,
      maxLat: 33,
      minLon: -118,
      maxLon: -86,
    },
    {
      name: "Brazil",
      code: "BR",
      minLat: -34,
      maxLat: 6,
      minLon: -74,
      maxLon: -34,
    },
    {
      name: "Argentina",
      code: "AR",
      minLat: -55,
      maxLat: -21,
      minLon: -73,
      maxLon: -53,
    },
    {
      name: "United Kingdom",
      code: "GB",
      minLat: 49.5,
      maxLat: 61,
      minLon: -8,
      maxLon: 2,
    },
    {
      name: "France",
      code: "FR",
      minLat: 41,
      maxLat: 51,
      minLon: -5,
      maxLon: 10,
    },
    {
      name: "Germany",
      code: "DE",
      minLat: 47,
      maxLat: 55,
      minLon: 5,
      maxLon: 15,
    },
    {
      name: "Spain",
      code: "ES",
      minLat: 36,
      maxLat: 44,
      minLon: -10,
      maxLon: 4,
    },
    {
      name: "Italy",
      code: "IT",
      minLat: 36,
      maxLat: 47,
      minLon: 6,
      maxLon: 19,
    },
    {
      name: "Poland",
      code: "PL",
      minLat: 49,
      maxLat: 55,
      minLon: 14,
      maxLon: 24,
    },
    {
      name: "Russia",
      code: "RU",
      minLat: 41,
      maxLat: 82,
      minLon: 19,
      maxLon: 180,
    },
    {
      name: "China",
      code: "CN",
      minLat: 18,
      maxLat: 54,
      minLon: 73,
      maxLon: 135,
    },
    {
      name: "Japan",
      code: "JP",
      minLat: 24,
      maxLat: 46,
      minLon: 123,
      maxLon: 146,
    },
    {
      name: "India",
      code: "IN",
      minLat: 6,
      maxLat: 36,
      minLon: 68,
      maxLon: 97,
    },
    {
      name: "Australia",
      code: "AU",
      minLat: -44,
      maxLat: -10,
      minLon: 113,
      maxLon: 154,
    },
    {
      name: "South Africa",
      code: "ZA",
      minLat: -35,
      maxLat: -22,
      minLon: 16,
      maxLon: 33,
    },
    {
      name: "Egypt",
      code: "EG",
      minLat: 22,
      maxLat: 32,
      minLon: 24,
      maxLon: 37,
    },
    {
      name: "Turkey",
      code: "TR",
      minLat: 36,
      maxLat: 42,
      minLon: 26,
      maxLon: 45,
    },
    {
      name: "Thailand",
      code: "TH",
      minLat: 5,
      maxLat: 21,
      minLon: 97,
      maxLon: 106,
    },
    {
      name: "Indonesia",
      code: "ID",
      minLat: -11,
      maxLat: 6,
      minLon: 95,
      maxLon: 141,
    },
    {
      name: "Sweden",
      code: "SE",
      minLat: 55,
      maxLat: 69,
      minLon: 11,
      maxLon: 24,
    },
    {
      name: "Norway",
      code: "NO",
      minLat: 58,
      maxLat: 71,
      minLon: 4,
      maxLon: 31,
    },
    {
      name: "Finland",
      code: "FI",
      minLat: 60,
      maxLat: 70,
      minLon: 20,
      maxLon: 32,
    },
    {
      name: "New Zealand",
      code: "NZ",
      minLat: -47,
      maxLat: -34,
      minLon: 166,
      maxLon: 179,
    },
  ];

  // Normalize longitude
  const normalizedLon = normalizeLon(lon);

  for (const country of countryBounds) {
    if (
      lat >= country.minLat &&
      lat <= country.maxLat &&
      normalizedLon >= country.minLon &&
      normalizedLon <= country.maxLon
    ) {
      console.log(`Matched coordinates to ${country.name} using bounding box`);
      return {
        country: country.name.toLowerCase(),
        countryCode: country.code,
        displayName: country.name,
      };
    }
  }

  console.log("No country match found in coordinate-based lookup");
  return null;
}

async function fetchAndStoreImage(token) {
  const img = await getRandomMapillaryImage(token);
  if (!img || !img.url || !img.coord) {
    return false;
  }
  const { lat, lon } = img.coord;
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
      `Skipping cache entry for ${countryInfo.displayName || "Unknown"}; already have ${MAX_IMAGES_PER_COUNTRY} images`,
    );
    return false;
  }

  imageCache.push({
    imageUrl: img.url,
    imageId: img.id,
    contributor: img.contributor || null,
    coordinates: { lat, lon },
    countryName: countryInfo.displayName,
    countryCode: countryInfo.countryCode,
    country: countryInfo.country,
    countryKey,
  });
  return true;
}

async function fillCache(numImages) {
  const token = process.env.MAP_API_KEY;
  const target = Math.max(0, Math.floor(Number(numImages) || 0));
  if (!token || target <= 0) {
    return;
  }

  console.log(
    `Filling cache with ${target} images (up to ${FILL_CACHE_CONCURRENCY} parallel requests)...`,
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
        const success = await fetchAndStoreImage(token);
        if (success) {
          added += 1;
        }
      } catch (e) {
        console.error("Error filling cache:", e && e.message);
      }
    }
  });

  await Promise.all(workers);
  console.log(
    `Cache fill complete. Added ${added} images. Cache size now ${imageCache.length}`,
  );
  if (added < target) {
    console.warn(
      `Cache fill stopped early: added ${added} of ${target} requested images (max attempts ${maxAttempts})`,
    );
  }
}

async function refillCache() {
  if (imageCache.length < 5 && !backgroundFillPromise) {
    backgroundFillPromise = fillCache(5)
      .catch((error) => {
        console.error("Background cache fill error:", error && error.message);
      })
      .finally(() => {
        backgroundFillPromise = null;
      });
  }
}

module.exports = {
  imageCache,
  getRandomMapillaryImage,
  reverseGeocodeCountry,
  fillCache,
  refillCache,
};
