# geoguess-api

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/OOF2510/geoguess-api&env=MAP_API_KEY&envDescription=Mapillary%20API%20access%20token&envLink=https%3A%2F%2Fwww.mapillary.com%2Fdashboard%2Fdevelopers)

An Express-based API that powers a Geoguessr-style game by fetching random street-level images from the Mapillary platform. The service preloads and caches images so clients can quickly serve players new locations to guess.

## Features

- **Randomized image sourcing**: Tries curated city bounding boxes, land-heavy regions, and fully random geographic boxes to find fresh photos.
- **Image caching**: Warms a cache of Mapillary images on startup and refills it in the background when the cache runs low to minimize API latency.
- **Reverse geocoding**: Looks up the country for each image via OpenStreetMap so clients can reveal or validate the location after a guess.
- **Robust retries**: Adds timeout handling and retry logic around Mapillary requests for improved reliability.

## Requirements

- Node.js 18+ (tested with modern LTS versions)
- Yarn (the repo uses `yarn@4.10.3` via Corepack)
- Mapillary API access token (`MAP_API_KEY`)

## Setup

1. Install dependencies:

   ```sh
   yarn install
   ```

2. Create a `.env` file alongside `index.js` and add your Mapillary token:

   ```env
   MAP_API_KEY=your_mapillary_access_token
   # Optional: override default server port
   PORT=8080
   ```

   You can generate a token from the [Mapillary developer dashboard](https://www.mapillary.com/dashboard/developers).

## One-click deploy

- Use the **Deploy with Vercel** button above to clone this repository into a new Vercel project.
- During setup, provide the `MAP_API_KEY` value in the Environment Variables step (or add it later under *Settings → Environment Variables*).
- After deployment, Vercel will expose the API under your chosen project domain.

## Running the server

Start the Express server:

```sh
node index.js
```

By default the API listens on `http://localhost:8080`. Set the `PORT` environment variable to change it.

On boot the service fills the image cache (10 images by default). Whenever a request consumes a cached entry the server refills the cache in the background to keep the pipeline warm.

## API

### `GET /getImage`

Returns a random Mapillary image along with coordinate metadata:

```json
{
  "imageUrl": "https://scontent-iad3-1.xx.fbcdn.net/m1/v/t6/An-rMI1JBjFNqolZ8PaLWHXY020kJZeBVdFuMwAr_-b7TGrBy9TC5x5IEzZgBUJcgu2V8VEQ_z-4h7zQVkIr-lr2PbkJD3RsfE_cdHSPNhigbxpT7bZk7eRv2lldWoUmcQrtacpAHVrLlMNjJj1bQA?stp=s1024x768&edm=AOnQwmMEAAAA&_nc_gid=YkvmVn0xIBTA98UoYjq5gw&_nc_oc=AdlGVeQnKjsLth2vVppl_glyRAm-LpD-mCLo_FdBJT_5Ph5M-o1Z1NwYeRg2Zy1_EaM&ccb=10-5&oh=00_AfcVvHJnUQjQFRf1AQe6bb4-A6ZnkVMbUHZKxjWBNGcIaQ&oe=692488B3&_nc_sid=201bca",
  "coordinates": {
    "lat": 36.714769079885,
    "lon": 3.0154622847408
  },
  "countryName": "Algeria"
}
```

- If cached images are available, the endpoint serves one immediately and triggers a background refill.
- If the cache is empty, the server fetches a fresh image on demand before responding.
- `countryName` falls back to `"Unknown"` when reverse geocoding cannot determine a country.

## How it works

- Selects random bounding boxes from curated city lists, landmass regions, or fully random areas to maximize the chance of finding imagery.
- Calls the Mapillary Images API with retry logic and graceful degradation when responses are empty or fail.
- Converts Mapillary image metadata into a consistent response shape and enriches it with OpenStreetMap reverse geocoding results.

These decisions are optimized for delivering varied, real-world locations suitable for a geolocation guessing game while keeping latency low.
