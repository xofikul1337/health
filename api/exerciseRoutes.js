// api/exerciseRoutes.js
const express = require("express");
const supabase = require("./supabaseClient");

const router = express.Router();

// Hard safety limits (avoid API crash)
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
    res
      .status(400)
      .json({ error: "Missing uid (user_id). Pass ?uid=... or x-user-id header." });
    return null;
  }
  return String(uid);
}

/**
 * GET /api/exercises
 * Query:
 *  - uid (required)
 *  - q (optional)        -> partial search across text columns
 *  - muscle (optional)   -> exact match in primary_muscles or secondary_muscles
 *  - category (optional) -> exact/partial category filter
 *  - page (optional, default 1)
 *  - limit (optional, default 20, max 50)
 *
 * Returns:
 *  {
 *    data: [...],
 *    meta: { page, limit, total, has_more },
 *    query: { ... }
 *  }
 */
router.get("/", async (req, res) => {
  try {
    const uid = requireUid(req, res);
    if (!uid) return;

    const qRaw = (req.query.q || "").toString().trim();
    const muscleRaw = (req.query.muscle || "").toString().trim();
    const categoryRaw = (req.query.category || "").toString().trim();

    const page = Math.max(1, toInt(req.query.page, 1));
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, toInt(req.query.limit, DEFAULT_LIMIT))
    );
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    // Base query
    let query = supabase
      .from("exercises_data")
      .select(
        "id,name,force,level,mechanic,equipment,primary_muscles,secondary_muscles,instructions,category,images",
        { count: "exact" }
      );

    // ----- Search (partial) -----
    if (qRaw.length > 0) {
      const q = qRaw.replace(/[%_]/g, ""); // basic wildcard sanitization
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

    // ----- Category filter (optional) -----
    if (categoryRaw.length > 0) {
      const c = categoryRaw.replace(/[%_]/g, "");
      query = query.ilike("category", `%${c}%`);
    }

    // ----- Muscle filter (optional, array contains) -----
    if (muscleRaw.length > 0) {
      const m = muscleRaw.toLowerCase();
      query = query.or(
        [`primary_muscles.cs.{${m}}`, `secondary_muscles.cs.{${m}}`].join(",")
      );
    }

    // Pagination + ordering
    query = query.order("name", { ascending: true }).range(from, to);

    const { data, error, count } = await query;
    if (error) {
      console.error("[/api/exercises] supabase error:", error);
      return res.status(500).json({ error: "DB error", details: error.message });
    }

    const total = count ?? 0;
    const has_more = from + (data?.length || 0) < total;

    return res.json({
      data: data || [],
      meta: {
        page,
        limit,
        total,
        has_more,
      },
      query: {
        uid, // required by your contract (not used to filter this global dataset)
        q: qRaw || null,
        muscle: muscleRaw || null,
        category: categoryRaw || null,
      },
    });
  } catch (err) {
    console.error("[/api/exercises] unexpected:", err);
    return res
      .status(500)
      .json({ error: "Server error", details: err.message || String(err) });
  }
});

/**
 * GET /api/exercises/:id
 * Query: uid (required)
 */
router.get("/:id", async (req, res) => {
  try {
    const uid = requireUid(req, res);
    if (!uid) return;

    const id = (req.params.id || "").toString().trim();
    if (!id) return res.status(400).json({ error: "Missing exercise id" });

    const { data, error } = await supabase
      .from("exercises_data")
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      const msg = String(error.message || "").toLowerCase();
      if (msg.includes("row") || msg.includes("no rows")) {
        return res.status(404).json({ error: "Not found" });
      }
      console.error("[/api/exercises/:id] supabase error:", error);
      return res.status(500).json({ error: "DB error", details: error.message });
    }

    return res.json({ data, query: { uid } });
  } catch (err) {
    console.error("[/api/exercises/:id] unexpected:", err);
    return res
      .status(500)
      .json({ error: "Server error", details: err.message || String(err) });
  }
});

/**
 * POST /api/exercises/favorite
 *
 * Query or Body:
 *  - uid          (required)
 *  - exercise_id  (required)
 *  - favorite     (required) -> "true" or "false"
 *
 * Behavior:
 *  - favorite=true  -> upsert into exercise_favorites
 *  - favorite=false -> delete from exercise_favorites
 */
router.post("/favorite", async (req, res) => {
  try {
    const uid = req.body.uid || req.query.uid;
    const exercise_id = req.body.exercise_id || req.query.exercise_id;
    const favRaw = req.body.favorite || req.query.favorite;

    if (!uid) {
      return res.status(400).json({ error: "Missing uid" });
    }
    if (!exercise_id) {
      return res.status(400).json({ error: "Missing exercise_id" });
    }
    if (favRaw === undefined || favRaw === null) {
      return res.status(400).json({ error: "Missing favorite flag (true/false)" });
    }

    const favorite = String(favRaw).toLowerCase() === "true";

    // favorite = true -> upsert
    if (favorite) {
      const { error } = await supabase
        .from("exercise_favorites")
        .upsert(
          {
            user_id: uid,
            exercise_id: exercise_id,
          },
          { onConflict: "user_id,exercise_id" }
        );

      if (error) {
        console.error("[/api/exercises/favorite] insert error:", error);
        return res
          .status(500)
          .json({ error: "DB insert error", details: error.message });
      }

      return res.json({
        success: true,
        message: "Exercise added to favorites",
        favorite: true,
        user_id: uid,
        exercise_id,
      });
    }

    // favorite = false -> delete
    const { error } = await supabase
      .from("exercise_favorites")
      .delete()
      .eq("user_id", uid)
      .eq("exercise_id", exercise_id);

    if (error) {
      console.error("[/api/exercises/favorite] delete error:", error);
      return res
        .status(500)
        .json({ error: "DB delete error", details: error.message });
    }

    return res.json({
      success: true,
      message: "Exercise removed from favorites",
      favorite: false,
      user_id: uid,
      exercise_id,
    });
  } catch (err) {
    console.error("[/api/exercises/favorite] unexpected:", err);
    return res
      .status(500)
      .json({ error: "Server error", details: err.message || String(err) });
  }
});

module.exports = router;
