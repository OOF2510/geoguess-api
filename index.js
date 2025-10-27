require("dotenv").config();
const express = require("express");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const { MongoClient, ObjectId } = require("mongodb");

const cors = require("cors");

const {
  imageCache,
  getRandomMapillaryImage,
  reverseGeocodeCountry,
  fillCache,
  refillCache,
} = require("./imageService.js");

const app = express();
const PORT = process.env.PORT || 8080;
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || "geoguess-db";

let db;
let gameSessions;
let scores;
let isInitialized = false;

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);

//Session

app.use(
  session({
    name: "geoguess.sid",
    secret:
      process.env.SESSION_SECRET || "your-secret-key-change-in-production",
    resave: false,
    saveUninitialized: true, // Create session for anonymous users
    store: MongoStore.create({
      mongoUrl: MONGO_URI,
      dbName: DB_NAME,
      collectionName: "sessions",
      ttl: 60 * 60 * 24 * 1, // 1 day
    }),
    cookie: {
      httpOnly: true,
      secure: true, // Cookies only work over HTTPS
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 24 * 1, // 1 day
    },
  }),
);

//Ensure session exists
function ensureSession(req, res, next) {
  if (!req.session.id) {
    return res.status(500).json({ error: "session_error" });
  }
  next();
}

async function initializeDatabase() {
  if (isInitialized) return;
  
  // Connect to MongoDB with serverless-optimized options
  const client = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
    socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
    connectTimeoutMS: 10000, // Give up initial connection after 10 seconds
    maxPoolSize: 1, // Maintain up to 1 socket connection for serverless
    minPoolSize: 0, // Allow connection pool to close completely
    maxIdleTimeMS: 0, // Close connections after the specified time
    retryWrites: true,
    retryReads: true,
    tls: true,
    tlsAllowInvalidCertificates: false,
    tlsAllowInvalidHostnames: false,
  });
  
  await client.connect();
  console.log("Connected to MongoDB");

  db = client.db(DB_NAME);
  gameSessions = db.collection("gameSessions");
  scores = db.collection("scores");

  // Create indexes
  await gameSessions.createIndex({ sessionId: 1 });
  await gameSessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // Auto-delete expired
  await scores.createIndex({ score: -1 }); // For leaderboard queries
  await scores.createIndex({ createdAt: -1 });
  
  isInitialized = true;
}

// Public endpoint: Get random image
app.get("/getImage", async (req, res) => {
  try {
    if (!process.env.MAP_API_KEY) {
        return res.status(500).json({
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
          return res.status(500).json({
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

// Game start: Create game session
app.post("/game/start", ensureSession, async (req, res) => {
  try {
    await initializeDatabase();
      const sessionId = req.session.id;

      // Generate a random seed for this game
      const seed =
        Math.random().toString(36).slice(2) + Date.now().toString(36);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour

      // Create game session
      const result = await gameSessions.insertOne({
        sessionId,
        seed,
        startedAt: now,
        expiresAt,
        used: false,
      });

      res.json({
        gameSessionId: result.insertedId.toString(),
        seed,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (err) {
      console.error("Error starting game:", err);
      res.status(500).json({ error: "server_error" });
    }
  });

// Submit score
app.post("/game/submit", ensureSession, async (req, res) => {
  try {
    await initializeDatabase();
      const sessionId = req.session.id;
      const { gameSessionId, score, metadata } = req.body;

      // Validate input
      if (!gameSessionId || typeof score !== "number") {
        return res.status(400).json({ error: "bad_request" });
      }

      // Convert gameSessionId to ObjectId
      let gsId;
      try {
        gsId = new ObjectId(gameSessionId);
      } catch (e) {
        return res.status(400).json({ error: "invalid_game_session_id" });
      }

      // Find game session
      const gs = await gameSessions.findOne({ _id: gsId });
      if (!gs) {
        return res.status(400).json({ error: "session_missing" });
      }

      // Validate game session
      if (gs.used) {
        return res.status(400).json({ error: "session_already_used" });
      }

      if (gs.sessionId !== sessionId) {
        return res.status(403).json({ error: "session_mismatch" });
      }

      if (new Date() > gs.expiresAt) {
        return res.status(400).json({ error: "session_expired" });
      }

      // Plausibility checks
      if (score < 0) {
        return res.status(400).json({ error: "invalid_score" });
      }

      const maxPossible = 100000;
      if (score > maxPossible) {
        return res.status(400).json({ error: "impossible_score" });
      }

      // Mark game session as used
      await gameSessions.updateOne({ _id: gsId }, { $set: { used: true } });

      // Store score
      await scores.insertOne({
        gameSessionId: gsId,
        sessionId,
        score,
        createdAt: new Date(),
        metadata: metadata || {},
      });

      res.json({ ok: true });
    } catch (err) {
      console.error("Error submitting score:", err);
      res.status(500).json({ error: "server_error" });
    }
  });

// Leaderboard: Get top scores (public)
app.get("/leaderboard/top", async (req, res) => {
  try {
    await initializeDatabase();
      const limit = parseInt(req.query.limit) || 50;
      const maxLimit = 100;
      const finalLimit = Math.min(limit, maxLimit);

      const topScores = await scores
        .find()
        .sort({ score: -1 })
        .limit(finalLimit)
        .toArray();

      // Return sanitized data (no session IDs exposed)
      const leaderboard = topScores.map((s, index) => ({
        rank: index + 1,
        score: s.score,
        createdAt: s.createdAt,
      }));

      res.json(leaderboard);
    } catch (err) {
      console.error("Error fetching leaderboard:", err);
      res.status(500).json({ error: "server_error" });
    }
  });

  // Health check
  app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

// Pre-fill cache on module load (works in serverless)
(async () => {
  try {
    await fillCache(15);
    console.log("Image cache pre-filled with 15 images");
  } catch (error) {
    console.error("Failed to pre-fill cache:", error);
  }
})();

// Vercel serverless function export
module.exports = app;
