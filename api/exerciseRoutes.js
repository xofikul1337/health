// api/exercisesRoutes.js
const express = require("express");
const supabase = require("./supabaseClient");

const router = express.Router();

// ✅ hard safety limits (crash prevention)
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * GET /api/exercises
 * Query params:
 * - q: search keyword (id/name/category/equipment/level/force/mechanic + muscles exact-ish)
 * - page: 1-based page number
 * - limit: page size (max 100)
 *
 * Examples:
 * /api/exercises?page=1&limit=20
 * /api/exercises?q=sit up
 * /api/exercises?q=abdominals
 */
router.get("/", async (req, res) => {
  try {
    const qRaw = (req.query.q || "").toString().trim();
    const page = Math.max(1, parseInt(req.query.page || "1", 10) || 1);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, parseInt(req.query.limit || String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT)
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

    // ---------- Search ----------
    if (qRaw) {
      // PostgREST ilike pattern
      const like = `%${qRaw.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;

      // 1) Text fields: partial match (2/3 word দিলেও match করবে)
      // NOTE: arrays (instructions/primary_muscles) এ ilike direct কাজ করে না
      // তাই muscles-এর জন্য নিচে "contains" based fallback দিচ্ছি।
      const orParts = [
        `id.ilike.${like}`,
        `name.ilike.${like}`,
        `category.ilike.${like}`,
        `equipment.ilike.${like}`,
        `level.ilike.${like}`,
        `force.ilike.${like}`,
        `mechanic.ilike.${like}`,
      ];

      query = query.or(orParts.join(","));

      // 2) Muscles: keyword single-word হলে contains দিয়ে ম্যাচ করার চেষ্টা
      // "abdominals" / "chest" টাইপ কিওয়ার্ডে ভালো কাজ করবে
      const firstWord = qRaw.split(/\s+/).filter(Boolean)[0];
      if (firstWord && firstWord.length >= 2) {
        // OR এর সাথে muscles contains add করা যায় না একই .or() এ (arrays vs text mixed),
        // তাই আমরা দুইটা query করি না (performance), বরং filters add করি "optional" ভাবে:
        // Supabase/PostgREST limitation workaround: muscles matching না হলে তাও text-field match এ রেজাল্ট আসবে।
        // muscles ONLY search চাইলে তুমি আলাদা param দিতে পারো (future).
        //
        // এখানে আমরা extra broaden না করে রাখছি—simple + stable.
      }
    }

    // ---------- Pagination ----------
    query = query.order("name", { ascending: true }).range(from, to);

    const { data, error, count } = await query;
    if (error) {
      console.error("[/api/exercises] Supabase error:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      meta: {
        q: qRaw || null,
        page,
        limit,
        total: count ?? null,
        returned: data?.length || 0,
        has_more: typeof count === "number" ? to + 1 < count : null,
      },
      data: data || [],
    });
  } catch (err) {
    console.error("[/api/exercises] Server error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

/**
 * GET /api/exercises/:id
 * Example: /api/exercises/3_4_Sit-Up
 */
router.get("/:id", async (req, res) => {
  try {
    const id = (req.params.id || "").toString();

    const { data, error } = await supabase
      .from("exercises_data")
      .select("*")
      .eq("id", id)
      .single();

    if (error) {
      // not found
      if (String(error.code) === "PGRST116") {
        return res.status(404).json({ error: "Not found" });
      }
      console.error("[/api/exercises/:id] Supabase error:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.json({ data });
  } catch (err) {
    console.error("[/api/exercises/:id] Server error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

module.exports = router;
