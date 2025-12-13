// api/readinessRoutes.js
const express = require("express");
const supabase = require("./supabaseClient");
const { computeReadiness } = require("./readinessCalc");

const router = express.Router();

function requireUid(req, res) {
  const uid = req.query.uid;
  if (!uid) {
    res.status(400).json({ error: "Missing uid" });
    return null;
  }
  return uid;
}

// GET /api/readiness/today?uid=...
// "today" = latest available date in daily_health_summary for that user
router.get("/today", async (req, res) => {
  try {
    const uid = requireUid(req, res);
    if (!uid) return;

    const { data, error } = await supabase
      .from("daily_health_summary")
      .select("*")
      .eq("user_id", uid)
      .order("date", { ascending: false })
      .limit(1);

    if (error) return res.status(500).json({ error: error.message });

    const row = data && data.length ? data[0] : null;
    const readiness = computeReadiness(row);

    return res.json({ readiness });
  } catch (e) {
    console.error("[readiness/today] error:", e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
});

// GET /api/readiness/by-date?uid=...&date=YYYY-MM-DD
router.get("/by-date", async (req, res) => {
  try {
    const uid = requireUid(req, res);
    if (!uid) return;

    const date = req.query.date;
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return res.status(400).json({ error: "Missing/invalid date (YYYY-MM-DD)" });
    }

    const { data, error } = await supabase
      .from("daily_health_summary")
      .select("*")
      .eq("user_id", uid)
      .eq("date", date)
      .limit(1);

    if (error) return res.status(500).json({ error: error.message });

    const row = data && data.length ? data[0] : null;
    const readiness = computeReadiness(row);

    return res.json({ readiness });
  } catch (e) {
    console.error("[readiness/by-date] error:", e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
});

// GET /api/readiness/range?uid=...&start=YYYY-MM-DD&end=YYYY-MM-DD
router.get("/range", async (req, res) => {
  try {
    const uid = requireUid(req, res);
    if (!uid) return;

    const start = req.query.start;
    const end = req.query.end;

    if (!start || !end) {
      return res.status(400).json({ error: "Missing start/end" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(start)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(end))) {
      return res.status(400).json({ error: "Invalid start/end format (YYYY-MM-DD)" });
    }

    const { data, error } = await supabase
      .from("daily_health_summary")
      .select("*")
      .eq("user_id", uid)
      .gte("date", start)
      .lte("date", end)
      .order("date", { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    const list = (data || []).map((row) => computeReadiness(row));

    return res.json({ uid, start, end, readiness: list });
  } catch (e) {
    console.error("[readiness/range] error:", e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
});

module.exports = router;
