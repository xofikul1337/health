// api/weeklyReportRoutes.js
const express = require("express");
const router = express.Router();

const { supabase } = require("./supabaseClient");
const { buildWeeklyReport, isValidYmd, addDaysUTC } = require("./weeklyReportCalc");

// basic UUID check
function isUuid(v) {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

// Fetch daily rows from daily_health_summary for a date range [start, end]
async function fetchDailyRange(uid, start, end) {
  const { data, error } = await supabase
    .from("daily_health_summary")
    .select(
      [
        "date",
        "sleep_duration_minutes",
        "sleep_deep_minutes",
        "sleep_rem_minutes",
        "sleep_core_minutes",
        "sleep_awake_minutes",
        "hrv",
        "resting_hr",
        "steps",
        "active_calories",
      ].join(",")
    )
    .eq("user_id", uid)
    .gte("date", start)
    .lte("date", end)
    .order("date", { ascending: true });

  if (error) throw new Error(error.message);
  return data || [];
}

/**
 * POST /api/weekly-report/generate
 * Body: { uid, end?: "YYYY-MM-DD", goalSleepMinutes?: 450 }
 * - Computes rolling 7-day report ending "end" (default: today UTC)
 * - Upserts into weekly_reports by (user_id, week_end)
 */
router.post("/generate", async (req, res) => {
  try {
    const uid = req.body?.uid;
    const end = req.body?.end; // optional
    const goalSleepMinutes = Number(req.body?.goalSleepMinutes ?? 450);

    if (!isUuid(uid)) return res.status(400).json({ error: "Invalid uid" });

    let weekEnd = end;
    if (!weekEnd) {
      // default today (UTC date)
      const now = new Date();
      weekEnd = now.toISOString().slice(0, 10);
    }
    if (!isValidYmd(weekEnd)) return res.status(400).json({ error: "Invalid end (YYYY-MM-DD)" });

    const weekStart = addDaysUTC(weekEnd, -6);

    // previous window for trends
    const prevEnd = addDaysUTC(weekStart, -1);
    const prevStart = addDaysUTC(prevEnd, -6);

    const [dailyRows, prevDailyRows] = await Promise.all([
      fetchDailyRange(uid, weekStart, weekEnd),
      fetchDailyRange(uid, prevStart, prevEnd),
    ]);

    const reportRow = buildWeeklyReport({
      uid,
      end: weekEnd,
      goalSleepMinutes,
      dailyRows,
      prevDailyRows,
    });

    const { data, error } = await supabase
      .from("weekly_reports")
      .upsert(reportRow, { onConflict: "user_id,week_end" })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ ok: true, weekly_report: data });
  } catch (err) {
    console.error("[weekly-report] generate error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

/**
 * GET /api/weekly-report/latest?uid=...
 * Returns latest saved weekly report for user (from weekly_reports table).
 */
router.get("/latest", async (req, res) => {
  try {
    const uid = req.query?.uid;
    if (!isUuid(uid)) return res.status(400).json({ error: "Invalid uid" });

    const { data, error } = await supabase
      .from("weekly_reports")
      .select("*")
      .eq("user_id", uid)
      .order("week_end", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });

    if (!data) {
      return res.json({
        weekly_report: null,
        status: "awaiting_sync",
        message: "No weekly report saved yet. Run POST /generate (cron) first.",
      });
    }

    return res.json({ weekly_report: data });
  } catch (err) {
    console.error("[weekly-report] latest error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

/**
 * GET /api/weekly-report/by-end?uid=...&end=YYYY-MM-DD
 * Returns saved weekly report for a specific week_end.
 */
router.get("/by-end", async (req, res) => {
  try {
    const uid = req.query?.uid;
    const end = req.query?.end;

    if (!isUuid(uid)) return res.status(400).json({ error: "Invalid uid" });
    if (!isValidYmd(end)) return res.status(400).json({ error: "Invalid end (YYYY-MM-DD)" });

    const { data, error } = await supabase
      .from("weekly_reports")
      .select("*")
      .eq("user_id", uid)
      .eq("week_end", end)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });

    if (!data) {
      return res.json({
        weekly_report: null,
        status: "not_found",
        message: "No saved report for that week_end. Run POST /generate for that end date.",
      });
    }

    return res.json({ weekly_report: data });
  } catch (err) {
    console.error("[weekly-report] by-end error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

module.exports = router;
