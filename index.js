require("dotenv").config();
const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const crypto = require("crypto");

const admin = require("firebase-admin");
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

const AI_MATCH_ROUNDS = parseInt(process.env.AI_MATCH_ROUNDS, 10) || 5;
const AI_MATCH_EXPIRY_MINUTES =
  parseInt(process.env.AI_MATCH_EXPIRY_MINUTES, 10) || 60;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

const aiMatches = new Map();

const MONGO_URI = process.env.MONGO_URI;
const DB_NAME = process.env.DB_NAME || "geoguess-db";

let db;
let gameSessions;
let scores;
let isInitialized = false;

let firebaseAppCheckInitialized = false;
let firebaseAppCheckInstance;

function initializeFirebaseAppCheck() {
  if (firebaseAppCheckInitialized) {
    return;
  }

  try {
    if (!admin.apps.length) {
      const serviceAccountBase64 =
        process.env.FIREBASE_SERVICE_ACCOUNT_KEY_BASE64;
      const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

      if (serviceAccountBase64) {
        const decodedJson = Buffer.from(
          serviceAccountBase64,
          "base64",
        ).toString("utf8");
        admin.initializeApp({
          credential: admin.credential.cert(JSON.parse(decodedJson)),
        });
      } else if (serviceAccountJson) {
        admin.initializeApp({
          credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
        });
      } else {
        admin.initializeApp();
      }
    }

    if (typeof admin.appCheck !== "function") {
      throw new Error("Firebase Admin SDK does not expose appCheck()");
    }

    firebaseAppCheckInitialized = true;
  } catch (error) {
    firebaseAppCheckInitialized = false;
    console.error("Firebase App Check initialization failed:", error);
  }
}

initializeFirebaseAppCheck();

function getFirebaseAppCheckInstance() {
  if (!firebaseAppCheckInitialized) {
    return null;
  }

  if (!firebaseAppCheckInstance) {
    firebaseAppCheckInstance = admin.appCheck();
  }

  return firebaseAppCheckInstance;
}

const allowedAppIds = process.env.FIREBASE_APP_IDS
  ? process.env.FIREBASE_APP_IDS.split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  : [];

async function verifyFirebaseAppCheck(req, res, next) {
  const appCheck = getFirebaseAppCheckInstance();

  if (!appCheck) {
    return res.status(500).json({ error: "app_check_not_configured" });
  }

  const token = req.header("X-Firebase-AppCheck");

  if (!token) {
    return res.status(401).json({ error: "missing_app_check_token" });
  }

  try {
    const decodedToken = await appCheck.verifyToken(token);

    if (
      allowedAppIds.length > 0 &&
      !allowedAppIds.includes(decodedToken.appId)
    ) {
      return res.status(401).json({ error: "app_check_app_id_mismatch" });
    }

    req.appCheckToken = decodedToken;
    next();
  } catch (error) {
    console.error("App Check token verification failed:", error);
    return res.status(401).json({ error: "invalid_app_check_token" });
  }
}

app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);

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
  await gameSessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // Auto-delete expired
  await scores.createIndex({ score: -1 }); // For leaderboard queries
  await scores.createIndex({ createdAt: -1 });

  isInitialized = true;
}

async function getImagePayload() {
  if (!process.env.MAP_API_KEY) {
    throw new Error("Mapillary access token missing in environment variables.");
  }

  if (imageCache.length === 0) {
    fillCache(15).catch((err) => {
      console.error("Failed to trigger cache refill:", err && err.message);
    });

    const img = await getRandomMapillaryImage(process.env.MAP_API_KEY);
    if (!img || !img.url || !img.coord) {
      throw new Error(
        "Could not fetch a random image right now. Please try again.",
      );
    }

    const { lat, lon } = img.coord;
    const countryInfo = (await reverseGeocodeCountry(lat, lon)) || {
      country: null,
      countryCode: null,
      displayName: "Unknown",
    };

    return {
      imageUrl: img.url,
      coordinates: { lat, lon },
      countryName: countryInfo.displayName || "Unknown",
      countryCode: countryInfo.countryCode || null,
    };
  }

  refillCache();

  const cachedImage = imageCache.pop();
  if (!cachedImage) {
    throw new Error(
      "Could not fetch a random image right now. Please try again.",
    );
  }

  return {
    imageUrl: cachedImage.imageUrl,
    coordinates: cachedImage.coordinates,
    countryName: cachedImage.countryName || "Unknown",
    countryCode: cachedImage.countryCode || null,
  };
}

function normalizeCountry(text) {
  const normalized = (text || "").trim().toLowerCase();
  return normalized
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function countryAliases(country, code) {
  const base = new Set();
  const c = (country || "").toLowerCase();
  const cc = (code || "").toLowerCase();

  if (c) base.add(c);
  if (cc) base.add(cc);

  if (c.includes("united states")) {
    base.add("usa");
    base.add("us");
    base.add("united states of america");
    base.add("america");
  }
  if (c.includes("united kingdom")) {
    base.add("uk");
    base.add("great britain");
    base.add("britain");
    base.add("england");
  }
  if (c.includes("russia")) {
    base.add("russian federation");
  }
  if (c.includes("south korea")) {
    base.add("korea");
    base.add("republic of korea");
  }
  if (c.includes("north korea")) {
    base.add("dprk");
    base.add("democratic peoples republic of korea");
  }
  if (c.includes("united arab emirates") || c === "uae") {
    base.add("united arab emirates");
    base.add("uae");
  }
  if (c.includes("czechia")) {
    base.add("czech republic");
  }
  if (c.includes("eswatini")) {
    base.add("swaziland");
  }
  if (c.includes("east timor")) {
    base.add("timor leste");
  }
  if (
    c.includes("ivory coast") ||
    c.includes("côte d'ivoire") ||
    c.includes("cote divoire")
  ) {
    base.add("cote divoire");
    base.add("cote d'ivoire");
    base.add("ivory coast");
  }

  return Array.from(base);
}

function matchGuess(guess, country, code) {
  if (!guess) return false;
  const normalizedGuess = normalizeCountry(guess);
  if (!normalizedGuess) return false;
  if (code) {
    const normalizedCode = code.trim().toLowerCase();
    if (normalizedGuess === normalizedCode) {
      return true;
    }
  }
  const normalizedCountry = country ? normalizeCountry(country) : null;
  if (!normalizedCountry) return false;
  const aliases = countryAliases(normalizedCountry, code || null);
  return aliases.some((alias) => normalizedGuess === alias);
}

function summarizeHemisphere(lat, lon) {
  const hemispheres = [];
  hemispheres.push(lat >= 0 ? "Northern Hemisphere" : "Southern Hemisphere");
  hemispheres.push(lon >= 0 ? "Eastern Hemisphere" : "Western Hemisphere");
  return hemispheres.join(" & ");
}

function climateBand(lat) {
  const absLat = Math.abs(lat);
  if (absLat < 15) return "tropical";
  if (absLat < 35) return "subtropical";
  if (absLat < 55) return "temperate";
  if (absLat < 66) return "cool temperate";
  return "polar";
}

function fallbackAiGuess(round, reason) {
  const { countryName, countryCode } = round;
  const pool = [
    "Brazil",
    "United States",
    "Canada",
    "France",
    "Germany",
    "South Africa",
    "Australia",
    "Japan",
    "India",
    "Argentina",
  ];

  const candidates = [];
  const seen = new Set();

  if (countryName && !seen.has(countryName)) {
    seen.add(countryName);
    candidates.push({
      countryName,
      confidence: 0.85,
      explanation:
        "Correct country included to keep fallback behaviour plausible.",
    });
  }

  while (candidates.length < 3) {
    const guess = pool[Math.floor(Math.random() * pool.length)];
    if (seen.has(guess)) {
      continue;
    }
    seen.add(guess);
    candidates.push({
      countryName: guess,
      confidence: 0.35,
      explanation:
        reason === "missing_api_key"
          ? "Random fallback guess because no OpenRouter API key is configured."
          : "Random fallback guess because the OpenRouter request failed.",
    });
  }

  const decorated = candidates.map((candidate) => ({
    countryName: candidate.countryName,
    confidence: candidate.confidence,
    explanation: candidate.explanation,
    isCorrect: matchGuess(candidate.countryName, countryName, countryCode),
  }));

  const chosen = decorated[Math.floor(Math.random() * decorated.length)];

  return {
    countryName: chosen.countryName,
    confidence: chosen.confidence,
    explanation: chosen.explanation,
    isCorrect: chosen.isCorrect,
    candidates: decorated,
    fallbackReason: reason,
  };
}

const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || "mistralai/mistral-small-3.2-24b-instruct:free";

async function fetchAiGuess(round) {
  if (!OPENROUTER_API_KEY) {
    return fallbackAiGuess(round, "missing_api_key");
  }

  const { coordinates, countryName, countryCode, imageUrl } = round;
  const { lat, lon } = coordinates;
  const hemisphereSummary = summarizeHemisphere(lat, lon);
  const band = climateBand(lat);
  const prompt = `You are playing a GeoGuessr-style geography duel. Study the attached Street View image and return three plausible country guesses ranked in order of confidence.\n\nFollow these rules strictly:\n1. Only respond with JSON shaped like {"guesses":[{...}]}.\n2. Provide exactly three guesses. Each guess requires countryName (string), confidence (number 0-1), and explanation (short sentence referencing visual or geographic cues).\n3. Base your reasoning primarily on the image. Use the metadata that follows as supporting context only.\n4. Never include any non-JSON commentary.\n5. Never mention metadata or the prompt itself.`;

  const metadata = `Supporting metadata:\n- Hemispheres: ${hemisphereSummary}\n- Approximate climate band: ${band}`;

  try {
    const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "HTTP-Referer": "https://github.com/oof2510/geoguessapp",
        "X-Title": "GeoFinder AI Duel",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are an assistant that only returns valid JSON responses representing GeoGuessr-style country guesses.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageUrl } },
              { type: "text", text: metadata },
            ],
          },
        ],
        temperature: 0.15,
        max_output_tokens: 350,
        top_p: 0.7,
      }),
    });

    if (!response.ok) {
      console.error(
        "OpenRouter request failed",
        response.status,
        await response.text(),
      );
      return fallbackAiGuess(round, "bad_response");
    }

    const data = await response.json();
    const choice = data && data.choices && data.choices[0];
    if (!choice || !choice.message || !choice.message.content) {
      return fallbackAiGuess(round, "empty_response");
    }

    const raw = choice.message.content.trim();
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, ""));
    } catch (err) {
      console.error("Failed to parse AI response", raw, err);
      return fallbackAiGuess(round, "parse_error");
    }

    const guesses = Array.isArray(parsed?.guesses) ? parsed.guesses : [];

    const normalizedGuesses = guesses
      .map((guess) => {
        if (!guess || typeof guess.countryName !== "string") {
          return null;
        }

        const trimmedName = guess.countryName.trim();
        if (!trimmedName) {
          return null;
        }

        const explanation =
          typeof guess.explanation === "string" && guess.explanation.trim()
            ? guess.explanation.trim()
            : "Guess derived from OpenRouter model output.";

        const confidence =
          typeof guess.confidence === "number" && guess.confidence >= 0
            ? Math.min(guess.confidence, 1)
            : null;

        return {
          countryName: trimmedName,
          confidence,
          explanation,
        };
      })
      .filter(Boolean);

    if (!normalizedGuesses.length) {
      return fallbackAiGuess(round, "invalid_payload");
    }

    const decorated = normalizedGuesses.map((guess) => ({
      countryName: guess.countryName,
      confidence:
        typeof guess.confidence === "number"
          ? guess.confidence
          : matchGuess(guess.countryName, countryName, countryCode || null)
            ? 0.8
            : 0.45,
      explanation: guess.explanation,
      isCorrect: matchGuess(
        guess.countryName,
        countryName,
        countryCode || null,
      ),
    }));

    let totalWeight = decorated.reduce(
      (sum, guess) => sum + guess.confidence,
      0,
    );
    let r = Math.random() * totalWeight;
    let cumulative = 0;
    let chosen = null;
    for (let guess of decorated) {
      cumulative += guess.confidence;
      if (r < cumulative) {
        chosen = guess;
        break;
      }
    }
    chosen = chosen || decorated[0];

    return {
      countryName: chosen.countryName,
      confidence: chosen.confidence,
      explanation: chosen.explanation,
      isCorrect: chosen.isCorrect,
      candidates: decorated,
    };
  } catch (error) {
    console.error("OpenRouter call failed", error);
    return fallbackAiGuess(round, "request_failure");
  }
}

function pruneExpiredMatches(now = Date.now()) {
  const cutoff = now - AI_MATCH_EXPIRY_MINUTES * 60 * 1000;
  for (const [matchId, match] of aiMatches.entries()) {
    if (match.createdAt < cutoff) {
      aiMatches.delete(matchId);
    }
  }
}

async function createAiRound(roundIndex) {
  const payload = await getImagePayload();
  return {
    index: roundIndex,
    imageUrl: payload.imageUrl,
    coordinates: payload.coordinates,
    countryName: payload.countryName,
    countryCode: payload.countryCode,
    resolved: false,
    aiGuess: null,
    player: null,
  };
}

async function createAiMatch() {
  const rounds = [];
  for (let i = 0; i < AI_MATCH_ROUNDS; i += 1) {
    const round = await createAiRound(i);
    rounds.push(round);
  }

  const matchId = crypto.randomUUID();
  const match = {
    id: matchId,
    rounds,
    totalRounds: rounds.length,
    currentRound: 0,
    playerScore: 0,
    aiScore: 0,
    status: "in-progress",
    createdAt: Date.now(),
    history: [],
  };

  aiMatches.set(matchId, match);
  return match;
}

function getMatch(matchId) {
  if (!matchId) return null;
  return aiMatches.get(matchId) || null;
}

function serializeRoundForClient(round) {
  if (!round) return null;
  return {
    roundIndex: round.index,
    imageUrl: round.imageUrl,
  };
}

function buildRoundSummary(round) {
  return {
    roundIndex: round.index,
    correctCountry: {
      name: round.countryName,
      code: round.countryCode || null,
    },
    coordinates: round.coordinates,
    player:
      round.player && round.player.guess
        ? {
            guess: round.player.guess,
            normalizedGuess: normalizeCountry(round.player.guess),
            isCorrect: Boolean(round.player.isCorrect),
          }
        : null,
    ai: round.aiGuess
      ? {
          countryName: round.aiGuess.countryName,
          confidence: round.aiGuess.confidence,
          explanation: round.aiGuess.explanation,
          isCorrect: Boolean(round.aiGuess.isCorrect),
          candidates: Array.isArray(round.aiGuess.candidates)
            ? round.aiGuess.candidates
            : null,
          fallbackReason: round.aiGuess.fallbackReason || null,
        }
      : null,
  };
}

// Public endpoint: Get random image
app.get("/getImage", async (req, res) => {
  try {
    const payload = await getImagePayload();
    res.json(payload);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Game start: Create game session
app.post("/game/start", verifyFirebaseAppCheck, async (req, res) => {
  try {
    await initializeDatabase();

    // Generate a random seed for this game
    const seed = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour

    // Create game session
    const result = await gameSessions.insertOne({
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
app.post("/game/submit", verifyFirebaseAppCheck, async (req, res) => {
  try {
    await initializeDatabase();
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

app.post("/ai-duel/start", verifyFirebaseAppCheck, async (req, res) => {
  try {
    pruneExpiredMatches();
    const match = await createAiMatch();
    const firstRound = serializeRoundForClient(match.rounds[0]);
    res.json({
      matchId: match.id,
      totalRounds: match.totalRounds,
      round: firstRound,
      scores: { player: match.playerScore, ai: match.aiScore },
      status: match.status,
    });
  } catch (error) {
    console.error("Failed to start AI duel", error);
    res.status(500).json({ error: "ai_duel_start_failed" });
  }
});

app.post("/ai-duel/guess", verifyFirebaseAppCheck, async (req, res) => {
  try {
    const { matchId, roundIndex, guess } = req.body || {};

    if (!matchId || typeof roundIndex !== "number" || roundIndex < 0) {
      return res.status(400).json({ error: "invalid_request" });
    }

    pruneExpiredMatches();
    const match = getMatch(matchId);
    if (!match) {
      return res.status(404).json({ error: "match_not_found" });
    }

    if (match.status === "completed") {
      return res.status(409).json({
        error: "match_completed",
        scores: { player: match.playerScore, ai: match.aiScore },
        history: match.history,
      });
    }

    if (roundIndex !== match.currentRound) {
      const currentRound = serializeRoundForClient(
        match.rounds[match.currentRound],
      );
      return res.status(409).json({
        error: "round_out_of_sync",
        expectedRound: currentRound,
      });
    }

    const round = match.rounds[roundIndex];
    if (!round) {
      return res.status(400).json({ error: "round_not_found" });
    }

    if (!round.resolved) {
      const playerGuess = typeof guess === "string" ? guess : "";
      const playerIsCorrect = matchGuess(
        playerGuess,
        round.countryName,
        round.countryCode || null,
      );

      round.player = {
        guess: playerGuess,
        isCorrect: playerIsCorrect,
      };

      if (playerIsCorrect) {
        match.playerScore += 1;
      }

      if (!round.aiGuess) {
        round.aiGuess = await fetchAiGuess(round);
        if (round.aiGuess && round.aiGuess.isCorrect) {
          match.aiScore += 1;
        }
      }

      const summary = buildRoundSummary(round);
      match.history.push(summary);
      round.resolved = true;

      if (round.index + 1 >= match.totalRounds) {
        match.status = "completed";
      } else {
        match.currentRound = round.index + 1;
      }
    }

    const payload = {
      matchId: match.id,
      roundIndex: round.index,
      totalRounds: match.totalRounds,
      playerResult: round.player
        ? {
            guess: round.player.guess,
            normalizedGuess: normalizeCountry(round.player.guess),
            isCorrect: Boolean(round.player.isCorrect),
          }
        : null,
      aiResult: round.aiGuess,
      correctCountry: {
        name: round.countryName,
        code: round.countryCode || null,
      },
      coordinates: round.coordinates,
      scores: { player: match.playerScore, ai: match.aiScore },
      status: match.status,
      history: match.history,
    };

    if (match.status !== "completed") {
      payload.nextRound = serializeRoundForClient(
        match.rounds[match.currentRound],
      );
    }

    res.json(payload);
  } catch (error) {
    console.error("Failed to process AI duel guess", error);
    res.status(500).json({ error: "ai_duel_guess_failed" });
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

    // Return sanitized data
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

app.get("/test-ai", async (req, res) => {
  const key = req.query.key;
  if (key !== process.env.AI_TESTING_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const imagePayload = await getImagePayload();
    const aiGuess = await fetchAiGuess(imagePayload);
    res.json({
      ...aiGuess,
      imageUrl: imagePayload.imageUrl,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal server error" });
  }
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
