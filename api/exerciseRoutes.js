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
    res.status(400).json({ error: "Missing uid (user_id). Pass ?uid=... or x-user-id header." });
    return null;
  }
  return String(uid);
}

/**
 * GET /api/exercises
 * Query:
 *  - uid (required)
 *  - q (optional) -> partial search across text columns
 *  - muscle (optional) -> exact match in primary_muscles or secondary_muscles
 *  - category (optional) -> exact/partial category filter
 *  - page (optional, default 1)
 *  - limit (optional, default 20, max 50)
 *
 * Returns: { data: [...], meta: { page, limit, total, has_more }, query: {...} }
 */
router.get("/", async (req, res) => {
  try {
    const uid = requireUid(req, res);
    if (!uid) return;

    const qRaw = (req.query.q || "").toString().trim();
    const muscleRaw = (req.query.muscle || "").toString().trim();
    const categoryRaw = (req.query.category || "").toString().trim();

    const page = Math.max(1, toInt(req.query.page, 1));
    const limit = Math.min(MAX_LIMIT, Math.max(1, toInt(req.query.limit, DEFAULT_LIMIT)));
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
    // Supabase OR filter: use ilike on text columns
    if (qRaw.length > 0) {
      // avoid extremely broad queries (optional safety)
      // if (qRaw.length < 2) { ... } // (তুমি চাইলে enable করতে পারো)
      const q = qRaw.replace(/[%_]/g, ""); // basic wildcard sanitization
      const like = `%${q}%`;

      // NOTE: PostgREST "or" syntax
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

    // ----- Muscle filter (optional, exact match on arrays) -----
    // This matches if primary_muscles contains [muscle] OR secondary_muscles contains [muscle]
    if (muscleRaw.length > 0) {
      const m = muscleRaw.toLowerCase();
      query = query.or(
        [
          `primary_muscles.cs.{${m}}`,
          `secondary_muscles.cs.{${m}}`,
        ].join(",")
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
    return res.status(500).json({ error: "Server error", details: err.message });
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
      // not found vs real error
      if (String(error.message || "").toLowerCase().includes("row")) {
        return res.status(404).json({ error: "Not found" });
      }
      console.error("[/api/exercises/:id] supabase error:", error);
      return res.status(500).json({ error: "DB error", details: error.message });
    }

    return res.json({ data, query: { uid } });
  } catch (err) {
    console.error("[/api/exercises/:id] unexpected:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

module.exports = router;
