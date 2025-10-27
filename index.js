require("dotenv").config();
const express = require("express");

const {
  imageCache,
  getRandomMapillaryImage,
  reverseGeocodeCountry,
  fillCache,
  refillCache,
} = require("./imageService.js");

const app = express();
const PORT = process.env.PORT || 8080;

app.get("/getImage", async (req, res) => {
  try {
    if (!process.env.MAP_API_KEY) {
      return res
        .status(500)
        .json({
          error: "Mapillary access token missing in environment variables.",
        });
    }

    let responseData;
    if (imageCache.length > 0) {
      responseData = imageCache.pop();
      // Refill in background
      refillCache();
    } else {
      // Fallback: fetch on demand
      const img = await getRandomMapillaryImage(process.env.MAP_API_KEY);
      if (!img || !img.url || !img.coord) {
        return res
          .status(500)
          .json({
            error:
              "Could not fetch a random image right now. Please try again.",
          });
      }
      const { lat, lon } = img.coord;
      let countryInfo = await reverseGeocodeCountry(lat, lon);
      if (!countryInfo) {
        countryInfo = {
          country: null,
          countryCode: null,
          displayName: "Unknown",
        };
      }
      responseData = {
        imageUrl: img.url,
        coordinates: { lat, lon },
        countryName: countryInfo.displayName,
      };
    }

    res.json(responseData);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, async () => {
  console.log(`Geoguess API listening on port ${PORT}`);
  // Pre-fill cache on startup
  await fillCache(15);
});
