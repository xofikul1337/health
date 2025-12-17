// api/exerciseRoutes.js
const express = require("express");
const supabase = require("./supabaseClient");

const router = express.Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

// Helper: parse int safely
function toInt(v, fallback) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

// Helper: require uid
function requireUid(req, res) {
  const uid = req.query.uid || req.headers["x-user-id"];
  if (!uid) {
    res.status(400).json({ error: "Missing uid (user_id)" });
    return null;
  }
  return String(uid);
}

/* ============================================================
   GET /api/exercises
   List exercises with search + filters + pagination
============================================================ */
router.get("/", async (req, res) => {
  try {
    const uid = requireUid(req, res);
    if (!uid) return;

    const qRaw = (req.query.q || "").trim();
    const muscleRaw = (req.query.muscle || "").trim();
    const categoryRaw = (req.query.category || "").trim();

    const page = Math.max(1, toInt(req.query.page, 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, toInt(req.query.limit, DEFAULT_LIMIT)));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = supabase
      .from("exercises_data")
      .select(
        "id,name,force,level,mechanic,equipment,primary_muscles,secondary_muscles,instructions,category,images",
        { count: "exact" }
      );

    // Search
    if (qRaw.length > 0) {
      const q = qRaw.replace(/[%_]/g, "");
      const like = `%${q}%`;

      query = query.or(
        [
          `id.ilike.${like}`,
          `name.ilike.${like}`,
          `category.ilike.${like}`,
          `equipment.ilike.${like}`,
          `level.ilike.${like}`,
          `force.ilike.${like}`,
          `mechanic.ilike.${like}`,
        ].join(",")
      );
    }

    // Category filter
    if (categoryRaw.length > 0) {
      const c = categoryRaw.replace(/[%_]/g, "");
      query = query.ilike("category", `%${c}%`);
    }

    // Muscle filter
    if (muscleRaw.length > 0) {
      const m = muscleRaw.toLowerCase();
      query = query.or(
        [`primary_muscles.cs.{${m}}`, `secondary_muscles.cs.{${m}}`].join(",")
      );
    }

    // Pagination
    query = query.order("name", { ascending: true }).range(from, to);

    const { data, error, count } = await query;

    if (error) {
      console.error("[/api/exercises] DB error:", error);
      return res.status(500).json({ error: "DB error", details: error.message });
    }

    return res.json({
      data: data || [],
      meta: {
        page,
        limit,
        total: count ?? 0,
        has_more: from + (data?.length || 0) < (count ?? 0),
      },
      query: { uid, q: qRaw || null, muscle: muscleRaw || null, category: categoryRaw || null },
    });
  } catch (err) {
    console.error("[/api/exercises] unexpected:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

/* ============================================================
   GET /api/exercises/:id
============================================================ */
router.get("/:id", async (req, res) => {
  try {
    const uid = requireUid(req, res);
    if (!uid) return;

    const id = req.params.id.trim();
    if (!id) return res.status(400).json({ error: "Missing exercise id" });

    const { data, error } = await supabase
      .from("exercises_data")
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      if (String(error.message).toLowerCase().includes("row")) {
        return res.status(404).json({ error: "Not found" });
      }
      console.error("[/api/exercises/:id] DB error:", error);
      return res.status(500).json({ error: "DB error", details: error.message });
    }

    return res.json({ data, query: { uid } });
  } catch (err) {
    console.error("[/api/exercises/:id] unexpected:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

/* ============================================================
   POST /api/exercises/favorite
   Toggle favorite
============================================================ */
router.post("/favorite", async (req, res) => {
  try {
    const uid = req.body.uid || req.query.uid;
    const exercise_id = req.body.exercise_id || req.query.exercise_id;
    const favRaw = req.body.favorite || req.query.favorite;

    if (!uid) return res.status(400).json({ error: "Missing uid" });
    if (!exercise_id) return res.status(400).json({ error: "Missing exercise_id" });
    if (favRaw === undefined) return res.status(400).json({ error: "Missing favorite flag" });

    const favorite = String(favRaw).toLowerCase() === "true";

    // Add to favorites
    if (favorite) {
      const { error } = await supabase
        .from("user_exercise_favorites")
        .upsert(
          {
            user_id: uid,
            exercise_id,
            is_favorite: true,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,exercise_id" }
        );

      if (error) {
        console.error("[favorite insert] error:", error);
        return res.status(500).json({ error: "DB insert error", details: error.message });
      }

      return res.json({
        success: true,
        favorite: true,
        message: "Exercise added to favorites",
      });
    }

    // Remove from favorites
    const { error } = await supabase
      .from("user_exercise_favorites")
      .delete()
      .eq("user_id", uid)
      .eq("exercise_id", exercise_id);

    if (error) {
      console.error("[favorite delete] error:", error);
      return res.status(500).json({ error: "DB delete error", details: error.message });
    }

    return res.json({
      success: true,
      favorite: false,
      message: "Exercise removed from favorites",
    });
  } catch (err) {
    console.error("[/api/exercises/favorite] unexpected:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

module.exports = router;
