# 🌐 GeoGuess API

The backend that powers my [GeoGuess App](https://github.com/oof2510/GeoguessApp), serving fresh Mapillary street-view shots, tagging them with country data, and keeping the global leaderboard flowing with minimal lag.

## 📚 Table of Contents

- [Why This Exists](#why-this-exists)
- [Feature Highlights](#feature-highlights)
- [How the Image Pipeline Works](#how-the-image-pipeline-works)
- [How the App Uses It](#how-the-app-uses-it)
- [Environment Setup](#environment-setup)
- [Run It Locally](#run-it-locally)
- [API Endpoints](#api-endpoints)
- [Tech Stack](#tech-stack)
- [Contributing](#contributing)
- [License](#license)

## ❓ Why This Exists

Guessing places should feel fast, global, and fair. The API makes that happen by:
1. Pulling Mapillary imagery from a big list of cities + land-heavy regions.
2. Keeping a rolling cache warm so the app doesn’t wait on live Mapillary calls.
3. Limiting the cache to two shots per country so the game stays interesting.
4. Double-checking country data with both OpenStreetMap’s Nominatim and BigDataCloud.

## ✨ Feature Highlights

- **Curated city fallbacks**: Hundreds of cities across North/South America, Europe, Africa, Asia, Oceania, and the Caribbean mean Mapillary almost always has coverage.
- **Parallel cache fills**: Up to four fetches run at once, and a single background task keeps the cache stocked.
- **Country diversity cap**: No more than two cached images from the same ISO code, so players see new places.
- **Geocoding do-over**: If Nominatim says “unknown”, BigDataCloud steps in and we still return a country name + ISO code when possible.
- **Fast empty-cache flow**: When the cache is dry, the API kicks off a 15-image refill and immediately grabs one live Mapillary image so the user isn’t waiting.
- **Clean JSON**: Every response returns `imageUrl`, `coordinates`, `countryName`, and `countryCode`.
- **Rate-limit friendly**: Built-in throttling keeps Mapillary requests comfortably under the 1k/min quota.
- **Leaderboard support**: Manages session signing, score submissions, and the public top list that the app displays.

## 🔄 How the Image Pipeline Works

```mermaid
flowchart TD
    Start[Request /getImage] -->|Cache hit| Pop[Pop cached entry]
    Pop --> RespondCached[Return cached image]
    RespondCached --> Refill[Trigger background refill if cache < 5]

    Start -->|Cache empty| Warmup[Fire fillCache(15) in background]
    Start -->|Cache empty| LiveFetch[getRandomMapillaryImage]
    LiveFetch --> LiveGeo[Reverse geocode (Nominatim -> BigDataCloud)]
    LiveGeo --> RespondLive[Return live image]

    Refill --> WorkerPool[Parallel Mapillary fetches (max 4)]
    WorkerPool --> CheckCountry[Skip if country already has 2 entries]
    CheckCountry --> Enrich[Reverse geocode for cache entry]
    Enrich --> CachePush[Push into cache]
```

- **fillCache(15)** tries up to `15 * 5` fetches so the country cap doesn’t freeze progress.
- **getRandomMapillaryImage** rotates through city fallbacks, land regions, and fully random boxes.
- **reverseGeocodeCountry** runs at zoom levels 3 → 5 → 10 before falling back to BigDataCloud.

## 📱 How the App Uses It

The React Native client plugs straight into these endpoints:

- `GET /getImage` → new round image + country info.
- `POST /game/start` → creates a one-hour session with a unique seed.
- `POST /game/submit` → saves scores once a session is finished.
- `GET /leaderboard/top` → grabs the public leaderboard.

Firebase App Check tokens are required for the POST endpoints—the mobile app takes care of attaching them in the `X-Firebase-AppCheck` header.

## 🔐 Environment Setup

1. **Install packages**
   ```bash
   yarn install
   ```

2. **Drop a `.env` next to `index.js`**
   ```env
   MAP_API_KEY=your_mapillary_token
   MONGO_URI=mongodb+srv://...
   FIREBASE_APP_ID=your_firebase_app_id
   FIREBASE_SERVICE_ACCOUNT_KEY_BASE64=base64_encoded_service_account_json
   PORT=8080 # optional
   ```

   - Use `FIREBASE_SERVICE_ACCOUNT_KEY` if you prefer raw JSON instead of Base64.
   - Need Corepack? `corepack enable` and you’re good.

## 🏃 Run It Locally

```bash
node index.js
```

- Default port: `8080`
- Health check: `http://localhost:8080/health`
- First boot tries to pre-fill 15 images—make sure `MAP_API_KEY` is set.

## 📡 API Endpoints

### `GET /getImage`
- Cache hit → instant response.
- Cache miss → kicks off `fillCache(15)` and also serves a live Mapillary image right away.
- Response sample:
  ```json
  {
    "imageUrl": "https://images.mapillary.com/...",
    "coordinates": { "lat": 47.5079, "lon": -18.8792 },
    "countryName": "Madagascar",
    "countryCode": "MG"
  }
  ```

### `POST /game/start` _(Firebase App Check)_
```json
{
  "gameSessionId": "6651fb7e5a842e0e4d816f17",
  "seed": "vj5o4l1x0r8",
  "expiresAt": "2024-06-08T19:52:31.824Z"
}
```

### `POST /game/submit` _(Firebase App Check)_
```json
{
  "gameSessionId": "6651fb7e5a842e0e4d816f17",
  "score": 9400,
  "metadata": { "rounds": 10 }
}
```

### `GET /leaderboard/top`
- Query param `limit` ranges from 1–100.

### `GET /health`
- Returns `{ "status": "ok", "timestamp": "..." }`

## 🛠️ Tech Stack

- **Node.js + Express** — core API
- **MongoDB** — sessions + leaderboard
- **Mapillary Graph API** — imagery source
- **OpenStreetMap Nominatim** & **BigDataCloud** — reverse geocoding
- **Firebase Admin + App Check** — security layer
- **Axios** — HTTP client with retry + keep-alive

## 🤝 Contributing

Ideas, fixes, PRs—always welcome. If you tweak the cache or geocoding logic, shout out how it affects API latency or accuracy so we can test it properly.

## 📄 License

Licensed under [MPL-2.0](LICENSE).  
API status? Check the live [health endpoint](https://geo.api.oof2510.space/health).

Made with ❤️ by [oof2510](https://oof2510.space) | [API Status](https://geo.api.oof2510.space/health)
