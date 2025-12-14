// api/weeklyReportRoutes.js
const express = require("express");
const router = express.Router();

const supabase = require("./supabaseClient");
const { buildWeeklyReport } = require("./weeklyReportCalc");

// ---- helpers ----
function todayUTCDateStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function addDays(yyyyMmDd, deltaDays) {
  const d = new Date(`${yyyyMmDd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function mondayOfWeek(yyyyMmDd) {
  // ISO-ish: Monday is start
  const d = new Date(`${yyyyMmDd}T00:00:00Z`);
  const day = d.getUTCDay(); // 0 Sun .. 6 Sat
  const diff = (day === 0 ? -6 : 1 - day); // move to Monday
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

async function fetchDailyRows(userId, startDate, endDateInclusive) {
  // Supabase select date range inclusive
  const { data, error } = await supabase
    .from("daily_health_summary")
    .select("date,sleep_duration_minutes,hrv,resting_hr")
    .eq("user_id", userId)
    .gte("date", startDate)
    .lte("date", endDateInclusive)
    .order("date", { ascending: true });

  if (error) throw new Error(error.message);
  return data || [];
}

async function fetchLatestReport(userId) {
  const { data, error } = await supabase
    .from("weekly_reports")
    .select("*")
    .eq("user_id", userId)
    .order("week_end", { ascending: false })
    .limit(1);

  if (error) throw new Error(error.message);
  return (data && data[0]) || null;
}

// ---------------------------------------------
// GET /api/weekly-report/last7?uid=...
// Returns latest weekly report if exists,
// otherwise generates on-the-fly (without saving) as fallback.
// ---------------------------------------------
router.get("/last7", async (req, res) => {
  try {
    const userId = req.query.uid;
    if (!userId) return res.status(400).json({ error: "Missing uid" });

    // 1) try DB latest
    const existing = await fetchLatestReport(userId);
    if (existing) {
      return res.json({ report: existing, source: "db" });
    }

    // 2) fallback: generate but don't insert
    const today = todayUTCDateStr();
    const weekEnd = today;
    const weekStart = addDays(weekEnd, -6);

    const last7Rows = await fetchDailyRows(userId, weekStart, weekEnd);

    const prevEnd = addDays(weekStart, -1);
    const prevStart = addDays(prevEnd, -6);
    const prev7Rows = await fetchDailyRows(userId, prevStart, prevEnd);

    const report = buildWeeklyReport({
      userId,
      weekStart,
      weekEnd,
      last7Rows,
      prev7Rows,
      sleepGoalMinutes: 450,
    });

    return res.json({ report, source: "generated" });
  } catch (err) {
    console.error("[weekly-report] GET /last7 error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

// ---------------------------------------------
// POST /api/weekly-report/generate?uid=...
// Optional body:
// {
//   "week_end": "2025-12-14",       // default today (UTC date string)
//   "sleep_goal_minutes": 450,      // default 450
//   "mode": "rolling" | "monday"    // default rolling (today-6..today)
// }
// Saves/upserts into weekly_reports and returns the row.
// ---------------------------------------------
router.post("/generate", async (req, res) => {
  try {
    const userId = req.query.uid;
    if (!userId) return res.status(400).json({ error: "Missing uid" });

    const body = req.body || {};
    const sleepGoalMinutes = Number(body.sleep_goal_minutes ?? 450);
    const mode = String(body.mode || "rolling").toLowerCase();

    const weekEnd = (body.week_end || todayUTCDateStr()).slice(0, 10);

    let weekStart;
    if (mode === "monday") {
      // Monday-to-Sunday week: weekStart = MondayOfWeek(weekEnd), weekEnd = weekStart+6
      const mon = mondayOfWeek(weekEnd);
      weekStart = mon;
      // ensure weekEnd is mon+6
      const computedEnd = addDays(mon, 6);
      // Use computedEnd instead (so consistent)
      // if user passed different week_end, we normalize to the monday-week window
      // weekEndNormalized:
      const weekEndNormalized = computedEnd;

      // fetch last7 based on normalized window
      const last7Rows = await fetchDailyRows(userId, weekStart, weekEndNormalized);

      const prevEnd = addDays(weekStart, -1);
      const prevStart = addDays(prevEnd, -6);
      const prev7Rows = await fetchDailyRows(userId, prevStart, prevEnd);

      const reportRecord = buildWeeklyReport({
        userId,
        weekStart,
        weekEnd: weekEndNormalized,
        last7Rows,
        prev7Rows,
        sleepGoalMinutes: Number.isFinite(sleepGoalMinutes) ? sleepGoalMinutes : 450,
      });

      // upsert by unique (user_id, week_start, week_end) recommended
      const { data, error } = await supabase
        .from("weekly_reports")
        .upsert(reportRecord, { onConflict: "user_id,week_start,week_end" })
        .select("*")
        .single();

      if (error) throw new Error(error.message);

      return res.json({ report: data });
    }

    // rolling mode (default): weekStart = weekEnd - 6
    weekStart = addDays(weekEnd, -6);

    const last7Rows = await fetchDailyRows(userId, weekStart, weekEnd);

    const prevEnd = addDays(weekStart, -1);
    const prevStart = addDays(prevEnd, -6);
    const prev7Rows = await fetchDailyRows(userId, prevStart, prevEnd);

    const reportRecord = buildWeeklyReport({
      userId,
      weekStart,
      weekEnd,
      last7Rows,
      prev7Rows,
      sleepGoalMinutes: Number.isFinite(sleepGoalMinutes) ? sleepGoalMinutes : 450,
    });

    const { data, error } = await supabase
      .from("weekly_reports")
      .upsert(reportRecord, { onConflict: "user_id,week_start,week_end" })
      .select("*")
      .single();

    if (error) throw new Error(error.message);

    return res.json({ report: data });
  } catch (err) {
    console.error("[weekly-report] POST /generate error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
});

module.exports = router;
