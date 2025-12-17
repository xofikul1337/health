// api/exerciseRoutes.js
const express = require("express");
const router = express.Router();

const {
  listExercisesUserMode,
  searchExercisesPublic,
  setFavorite,
} = require("./exerciseService");

// -------------
// GET /api/exercises
// - user-specific: uid required
// - supports suggestion mode by default (first load): limit=40, offset/page
// Query:
//   uid=... (required)
//   limit=40 default
//   offset=0 default (or page=1)
//   mode=suggest | all   (default: suggest)
// -------------
router.get("/", async (req, res) => {
  try {
    const uid = req.query.uid;
    if (!uid) return res.status(400).json({ error: "Missing uid" });

    const mode = (req.query.mode || "suggest").toLowerCase();
    const limit = Math.min(Number(req.query.limit || 40) || 40, 100);
    const offset =
      req.query.offset != null
        ? Math.max(0, Number(req.query.offset) || 0)
        : Math.max(0, ((Number(req.query.page || 1) || 1) - 1) * limit);

    const result = await listExercisesUserMode({ uid, mode, limit, offset });
    return res.json(result);
  } catch (err) {
    console.error("[/api/exercises] error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

// -------------
// GET /api/exercises/search?q=...
// - no uid required
// Query:
//   q (required)
//   limit=40 default
//   offset/page
// -------------
router.get("/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.status(400).json({ error: "Missing q" });

    const limit = Math.min(Number(req.query.limit || 40) || 40, 100);
    const offset =
      req.query.offset != null
        ? Math.max(0, Number(req.query.offset) || 0)
        : Math.max(0, ((Number(req.query.page || 1) || 1) - 1) * limit);

    const result = await searchExercisesPublic({ q, limit, offset });
    return res.json(result);
  } catch (err) {
    console.error("[/api/exercises/search] error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

// -------------
// POST /api/exercises/:id/favorite
// Body: { uid: "...", favorite: true/false }
// fav=true => insert into exercise_favorites
// fav=false => delete from exercise_favorites
// -------------
router.post("/:id/favorite", async (req, res) => {
  try {
    const exerciseId = req.params.id;
    const uid = req.body?.uid;
    const favorite = req.body?.favorite;

    if (!uid) return res.status(400).json({ error: "Missing uid" });
    if (typeof favorite !== "boolean")
      return res.status(400).json({ error: "favorite must be boolean" });

    const result = await setFavorite({ uid, exerciseId, favorite });
    return res.json(result);
  } catch (err) {
    console.error("[/api/exercises/:id/favorite] error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

module.exports = router;
