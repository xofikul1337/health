// api/exerciseRoutes.js
const express = require("express");
const router = express.Router();
const {
  listExercises,
  listFavorites,
  addFavorite,
  removeFavorite,
} = require("./exerciseService");

function getUid(req) {
  return req.query.uid || req.query.user_id || req.body?.user_id;
}

function parseIntSafe(v, def) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

// GET /api/exercises?uid=...&page=1&load=40&q=...
router.get("/", async (req, res) => {
  try {
    const userId = getUid(req);
    if (!userId) return res.status(400).json({ error: "Missing uid/user_id" });

    const page = parseIntSafe(req.query.page, 1);
    const load = parseIntSafe(req.query.load, 40);
    const q = (req.query.q || "").trim();

    const result = await listExercises({ userId, page, load, q });
    return res.json(result);
  } catch (err) {
    console.error("[exercises] list error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

// GET /api/exercises/favorites?uid=...&page=1&load=40&q=...
router.get("/favorites", async (req, res) => {
  try {
    const userId = getUid(req);
    if (!userId) return res.status(400).json({ error: "Missing uid/user_id" });

    const page = parseIntSafe(req.query.page, 1);
    const load = parseIntSafe(req.query.load, 40);
    const q = (req.query.q || "").trim();

    const result = await listFavorites({ userId, page, load, q });
    return res.json(result);
  } catch (err) {
    console.error("[exercises] favorites list error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

// POST /api/exercises/:exerciseId/favorite?uid=...
router.post("/:exerciseId/favorite", async (req, res) => {
  try {
    const userId = getUid(req);
    if (!userId) return res.status(400).json({ error: "Missing uid/user_id" });

    const exerciseId = req.params.exerciseId;
    if (!exerciseId) return res.status(400).json({ error: "Missing exerciseId" });

    await addFavorite({ userId, exerciseId });
    return res.json({ ok: true, is_favorite: true, exercise_id: exerciseId });
  } catch (err) {
    console.error("[exercises] add favorite error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

// DELETE /api/exercises/:exerciseId/favorite?uid=...
router.delete("/:exerciseId/favorite", async (req, res) => {
  try {
    const userId = getUid(req);
    if (!userId) return res.status(400).json({ error: "Missing uid/user_id" });

    const exerciseId = req.params.exerciseId;
    if (!exerciseId) return res.status(400).json({ error: "Missing exerciseId" });

    await removeFavorite({ userId, exerciseId });
    return res.json({ ok: true, is_favorite: false, exercise_id: exerciseId });
  } catch (err) {
    console.error("[exercises] remove favorite error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

module.exports = router;
