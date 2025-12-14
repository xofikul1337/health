// api/weeklyReportRoutes.js
const express = require("express");
const supabase = require("./supabaseClient");
const { buildWeeklyReport } = require("./weeklyReportCalc");

const router = express.Router();

function yyyyMmDd(d) {
  // Return UTC date "YYYY-MM-DD"
  const iso = new Date(d).toISOString();
  return iso.slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return yyyyMmDd(d);
}

async function fetchDailyRows(userId, startDate, endDate) {
  const { data, error } = await supabase
    .from("daily_health_summary")
    .select(
      "date, sleep_duration_minutes, hrv, resting_hr, steps, active_calories"
    )
    .eq("user_id", userId)
    .gte("date", startDate)
    .lte("date", endDate)
    .order("date", { ascending: true });

  if (error) throw new Error(error.message);
  return data || [];
}

// -------------------- GET latest report (UI) --------------------
router.get("/latest", async (req, res) => {
  try {
    const userId = req.query.uid;
    if (!userId) return res.status(400).json({ error: "Missing uid" });

    const { data, error } = await supabase
      .from("weekly_reports")
      .select("*")
      .eq("user_id", userId)
      .order("generated_at", { ascending: false })
      .limit(1);

    if (error) return res.status(500).json({ error: error.message });

    const report = data?.[0] || null;
    return res.json({ report });
  } catch (err) {
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

// -------------------- GET reports list (UI optional) --------------------
router.get("/", async (req, res) => {
  try {
    const userId = req.query.uid;
    const limit = Math.min(Number(req.query.limit || 10), 52);

    if (!userId) return res.status(400).json({ error: "Missing uid" });

    const { data, error } = await supabase
      .from("weekly_reports")
      .select("*")
      .eq("user_id", userId)
      .order("generated_at", { ascending: false })
      .limit(limit);

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ reports: data || [] });
  } catch (err) {
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

// -------------------- POST generate report (cron/Postman trigger) --------------------
router.post("/generate", async (req, res) => {
  try {
    const userId = req.query.uid || req.body?.uid;
    if (!userId) return res.status(400).json({ error: "Missing uid" });

    // anchor end date: default today (UTC)
    const end = req.query.end || req.body?.end || yyyyMmDd(new Date());
    const weekEnd = end;
    const weekStart = addDays(weekEnd, -6);

    const prevEnd = addDays(weekStart, -1);
    const prevStart = addDays(prevEnd, -6);

    // fetch daily rows
    const [last7Rows, prev7Rows] = await Promise.all([
      fetchDailyRows(userId, weekStart, weekEnd),
      fetchDailyRows(userId, prevStart, prevEnd),
    ]);

    // build report (pure)
    const report = buildWeeklyReport({
      userId,
      weekStart,
      weekEnd,
      last7Rows,
      prev7Rows,
      sleepGoalMinutes: 450,
    });

    // store into weekly_reports (upsert by user_id + week range)
    const { data, error } = await supabase
      .from("weekly_reports")
      .upsert(report, { onConflict: "user_id,week_start,week_end" })
      .select("*")
      .single();

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ report: data });
  } catch (err) {
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

module.exports = router;
