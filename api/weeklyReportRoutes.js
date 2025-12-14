// api/weeklyReportRoutes.js
const express = require("express");
const supabase = require("./supabaseClient");
const { buildWeeklyReport } = require("./weeklyReportCalc");

const router = express.Router();

/**
 * Fetch daily rows for a user within a date window.
 * We fetch a wider window (last 30 days) so both last7 and prev7 are available.
 */
async function fetchDailyRows(uid, endDateStr) {
  // If endDateStr provided -> use it; else DB latest date will be discovered by calc,
  // but to be safe we still pull the last ~30 days.
  // We can query by date >= (endDate - 29) when endDate is provided.
  let fromDate = null;

  if (endDateStr) {
    const end = new Date(`${endDateStr}T00:00:00Z`);
    if (!Number.isNaN(end.getTime())) {
      const from = new Date(end.getTime() - 29 * 24 * 60 * 60 * 1000);
      fromDate = from.toISOString().slice(0, 10);
    }
  }

  let q = supabase
    .from("daily_health_summary")
    .select(
      "date, sleep_duration_minutes, sleep_deep_minutes, sleep_rem_minutes, sleep_core_minutes, sleep_awake_minutes, hrv, resting_hr, steps, active_calories"
    )
    .eq("user_id", uid)
    .order("date", { ascending: true });

  if (fromDate) q = q.gte("date", fromDate);

  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

/**
 * GET /api/weekly-report?uid=...&end=YYYY-MM-DD
 * Returns computed weekly report (does NOT save).
 */
router.get("/", async (req, res) => {
  try {
    const uid = req.query.uid;
    const end = req.query.end; // optional
    const sleepGoal = req.query.sleep_goal_minutes; // optional

    if (!uid) return res.status(400).json({ error: "Missing uid" });

    const rows = await fetchDailyRows(uid, end);

    const report = buildWeeklyReport(rows, {
      endDate: end,
      sleepGoalMinutes: sleepGoal ? Number(sleepGoal) : 450,
    });

    return res.json({ weekly_report: report });
  } catch (err) {
    console.error("[weekly-report] GET error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

/**
 * POST /api/weekly-report
 * Body: { uid, end?: "YYYY-MM-DD", sleep_goal_minutes?: number, save?: boolean }
 *
 * If save=true -> upsert into weekly_reports table.
 * Otherwise just returns report.
 */
router.post("/", async (req, res) => {
  try {
    const { uid, end, sleep_goal_minutes, save } = req.body || {};
    if (!uid) return res.status(400).json({ error: "Missing uid" });

    const rows = await fetchDailyRows(uid, end);

    const report = buildWeeklyReport(rows, {
      endDate: end,
      sleepGoalMinutes: sleep_goal_minutes ? Number(sleep_goal_minutes) : 450,
    });

    if (!save) {
      return res.json({ weekly_report: report });
    }

    // ✅ Optional saving
    // Suggested weekly_reports schema (if you want persistence):
    // - user_id uuid
    // - week_end date
    // - week_start date
    // - status text
    // - summary text
    // - trends jsonb
    // - action_items jsonb
    // - stats jsonb
    // - missing jsonb
    // UNIQUE(user_id, week_end)

    if (!report?.period?.end) {
      return res.status(400).json({ error: "Cannot save: report has no period.end" });
    }

    const payloadToSave = {
      user_id: uid,
      week_end: report.period.end,
      week_start: report.period.start,
      status: report.status,
      summary: report.summary,
      trends: report.trends,
      action_items: report.action_items,
      stats: report.stats,
      missing: report.missing,
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("weekly_reports")
      .upsert(payloadToSave, { onConflict: "user_id,week_end" });

    if (error) {
      console.error("[weekly-report] Save error:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.json({ weekly_report: report, saved: true });
  } catch (err) {
    console.error("[weekly-report] POST error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

module.exports = router;
