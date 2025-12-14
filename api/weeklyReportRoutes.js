// api/weeklyReportRoutes.js
const express = require("express");
const { supabase } = require("./supabaseClient");
const { weeklyReportCalc } = require("./weeklyReportCalc");

const router = express.Router();

function isoDate(d) {
  // returns YYYY-MM-DD
  return new Date(d).toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

/**
 * GET /api/weekly-report/last7?uid=...&end=YYYY-MM-DD&goalSleepMinutes=450
 * - end optional: default = today (UTC)
 * - fetches 14 days ending at end (inclusive): prev7 + last7
 * - returns summary/trends/action items
 */
router.get("/last7", async (req, res) => {
  try {
    const uid = req.query.uid;
    if (!uid) return res.status(400).json({ error: "Missing uid" });

    const end = req.query.end ? String(req.query.end) : isoDate(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return res.status(400).json({ error: "Invalid end date. Use YYYY-MM-DD" });
    }

    const goalSleepMinutes = req.query.goalSleepMinutes
      ? Number(req.query.goalSleepMinutes)
      : 450;

    // We want 14 days: [end-13 .. end]
    const start = addDays(end, -13);

    const { data, error } = await supabase
      .from("daily_health_summary")
      .select(
        "date,sleep_duration_minutes,resting_hr,hrv,steps,active_calories,basal_calories,sleep_deep_minutes,sleep_rem_minutes,sleep_core_minutes,sleep_awake_minutes"
      )
      .eq("user_id", uid)
      .gte("date", start)
      .lte("date", end)
      .order("date", { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    const report = weeklyReportCalc(data || [], { goalSleepMinutes });

    return res.json({
      weekly_report: {
        uid,
        start_date: start,
        end_date: end,
        ...report,
      },
    });
  } catch (e) {
    console.error("[weekly-report] error:", e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
});

/**
 * POST /api/weekly-report/generate
 * body: { uid, end?: YYYY-MM-DD, goalSleepMinutes?: number }
 * - generates report and (optionally) saves to weekly_reports table if you create it later
 * For now, it just returns the same payload. You can enable DB insert later.
 */
router.post("/generate", async (req, res) => {
  try {
    const uid = req.body?.uid;
    if (!uid) return res.status(400).json({ error: "Missing uid" });

    const end = req.body?.end ? String(req.body.end) : isoDate(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return res.status(400).json({ error: "Invalid end date. Use YYYY-MM-DD" });
    }

    const goalSleepMinutes = req.body?.goalSleepMinutes
      ? Number(req.body.goalSleepMinutes)
      : 450;

    const start = addDays(end, -13);

    const { data, error } = await supabase
      .from("daily_health_summary")
      .select(
        "date,sleep_duration_minutes,resting_hr,hrv,steps,active_calories,basal_calories,sleep_deep_minutes,sleep_rem_minutes,sleep_core_minutes,sleep_awake_minutes"
      )
      .eq("user_id", uid)
      .gte("date", start)
      .lte("date", end)
      .order("date", { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    const report = weeklyReportCalc(data || [], { goalSleepMinutes });

    // Later: save to weekly_reports table here (optional)
    // await supabase.from("weekly_reports").insert({...})

    return res.json({
      weekly_report: {
        uid,
        start_date: start,
        end_date: end,
        ...report,
      },
    });
  } catch (e) {
    console.error("[weekly-report] error:", e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
});

module.exports = router;
