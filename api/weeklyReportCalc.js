// api/weeklyReportCalc.js
// Pure aggregation + text template (no DB, no Express)

function parseDateYYYYMMDD(s) {
  if (!s) return null;
  // daily_health_summary.date is likely "YYYY-MM-DD"
  const d = new Date(`${String(s).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtHhMmFromMinutes(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${String(mm).padStart(2, "0")}m`;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function round1(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.round(x * 10) / 10;
}

function avg(nums) {
  const arr = (nums || []).map(Number).filter((x) => Number.isFinite(x));
  if (arr.length === 0) return null;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function sum(nums) {
  const arr = (nums || []).map(Number).filter((x) => Number.isFinite(x));
  return arr.reduce((s, v) => s + v, 0);
}

function pctChange(current, previous) {
  const c = Number(current);
  const p = Number(previous);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  return ((c - p) / p) * 100;
}

/**
 * Build weekly report from daily rows (from daily_health_summary).
 *
 * rows fields used:
 * - date (YYYY-MM-DD)
 * - sleep_duration_minutes (int)
 * - hrv (float ms)
 * - resting_hr (float bpm)
 * - steps (int)
 * - active_calories (int)
 *
 * Options:
 * - endDate: "YYYY-MM-DD" (optional). If missing, uses max(date) from rows.
 * - sleepGoalMinutes: default 450 (7h30m)
 */
function buildWeeklyReport(rows, options = {}) {
  const sleepGoalMinutes = Number(options.sleepGoalMinutes || 450);

  const cleaned = (rows || [])
    .map((r) => ({
      ...r,
      _d: parseDateYYYYMMDD(r.date),
    }))
    .filter((r) => r._d);

  if (cleaned.length === 0) {
    return {
      status: "awaiting_sync",
      message: "No data found for this user yet.",
      period: null,
      summary: "Awaiting sync",
      trends: [],
      action_items: ["Sync your Apple Health data to generate a weekly report."],
      stats: {},
      missing: ["sleep", "hrv", "resting_hr"],
    };
  }

  // Determine end date: prefer explicit, else latest date in DB.
  let end = options.endDate ? parseDateYYYYMMDD(options.endDate) : null;
  if (!end) {
    end = cleaned.reduce((mx, r) => (r._d > mx ? r._d : mx), cleaned[0]._d);
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const start7 = new Date(end.getTime() - 6 * dayMs);
  const startPrev7 = new Date(end.getTime() - 13 * dayMs);
  const endPrev7 = new Date(end.getTime() - 7 * dayMs);

  const inRange = (d, a, b) => d >= a && d <= b;

  const last7 = cleaned.filter((r) => inRange(r._d, start7, end));
  const prev7 = cleaned.filter((r) => inRange(r._d, startPrev7, endPrev7));

  // Helpers to pick available values (ignore null)
  const pick = (arr, key) =>
    arr
      .map((r) => r[key])
      .map(Number)
      .filter((x) => Number.isFinite(x) && x !== 0);

  // Sleep averages (minutes)
  const avgSleepLast7 = avg(
    last7
      .map((r) => Number(r.sleep_duration_minutes))
      .filter((x) => Number.isFinite(x) && x > 0)
  );

  const avgSleepPrev7 = avg(
    prev7
      .map((r) => Number(r.sleep_duration_minutes))
      .filter((x) => Number.isFinite(x) && x > 0)
  );

  // HRV (ms)
  const avgHrvLast7 = avg(pick(last7, "hrv"));
  const avgHrvPrev7 = avg(pick(prev7, "hrv"));

  // Resting HR (bpm)
  const avgRhrLast7 = avg(pick(last7, "resting_hr"));
  const avgRhrPrev7 = avg(pick(prev7, "resting_hr"));

  // Activity (optional in text)
  const sumStepsLast7 = sum(
    last7.map((r) => Number(r.steps)).filter((x) => Number.isFinite(x) && x >= 0)
  );
  const sumActiveCalLast7 = sum(
    last7
      .map((r) => Number(r.active_calories))
      .filter((x) => Number.isFinite(x) && x >= 0)
  );

  const hrvDeltaPct = pctChange(avgHrvLast7, avgHrvPrev7);
  const rhrDelta = Number.isFinite(avgRhrLast7) && Number.isFinite(avgRhrPrev7)
    ? avgRhrLast7 - avgRhrPrev7
    : null;

  // Missing detection
  const missing = [];
  if (!Number.isFinite(avgSleepLast7)) missing.push("sleep");
  if (!Number.isFinite(avgHrvLast7)) missing.push("hrv");
  if (!Number.isFinite(avgRhrLast7)) missing.push("resting_hr");

  // Build narrative pieces
  const trends = [];
  const action_items = [];

  if (Number.isFinite(avgSleepLast7)) {
    trends.push(`Average sleep: ${fmtHhMmFromMinutes(avgSleepLast7)} (goal ${fmtHhMmFromMinutes(sleepGoalMinutes)})`);
    if (avgSleepLast7 + 1 < sleepGoalMinutes) {
      action_items.push("Add 30 minutes earlier bedtime");
    }
  } else {
    trends.push("Average sleep: Awaiting sync");
  }

  if (Number.isFinite(hrvDeltaPct)) {
    const sign = hrvDeltaPct >= 0 ? "up" : "down";
    trends.push(`HRV ${sign} by ${Math.abs(Math.round(hrvDeltaPct))}%`);
    if (hrvDeltaPct < -5) action_items.push("Plan one extra low-intensity / recovery day this week");
  } else {
    trends.push("HRV: Awaiting sync");
  }

  if (Number.isFinite(rhrDelta)) {
    const sign = rhrDelta <= 0 ? "down" : "up";
    trends.push(`Resting HR ${sign} by ${Math.abs(Math.round(rhrDelta * 10) / 10)} bpm`);
    if (rhrDelta > 2) action_items.push("Reduce intensity 1 day; prioritize sleep + hydration");
  } else {
    trends.push("Resting HR: Awaiting sync");
  }

  // Simple extra action item based on load (optional)
  if (sumStepsLast7 > 70000 || sumActiveCalLast7 > 3500) {
    // high load week
    action_items.push("One extra rest/low-intensity day mid-week");
  }

  // Summary sentence (short like UI)
  let summary = "Weekly report generated.";
  if (Number.isFinite(hrvDeltaPct) && Number.isFinite(rhrDelta)) {
    const hrvWord = hrvDeltaPct >= 0 ? "stable/improving" : "dropping";
    const rhrWord = rhrDelta <= 0 ? "improving" : "rising";
    summary = `HRV ${hrvWord}, resting HR ${rhrWord}.`;
  } else if (missing.length > 0) {
    summary = "Partial data synced. Some metrics are missing.";
  }

  // Always keep action items short, unique, max 3
  const uniq = [...new Set(action_items)].slice(0, 3);
  if (uniq.length === 0) {
    uniq.push("Keep consistency: sleep, hydration, and steady training load.");
  }

  const period = {
    start: start7.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
    days_included: last7.length,
  };

  return {
    status: missing.length >= 2 ? "partial" : "ok",
    message: "Success",
    period,
    summary,
    trends,
    action_items: uniq,
    stats: {
      avg_sleep_minutes_last7: Number.isFinite(avgSleepLast7) ? Math.round(avgSleepLast7) : null,
      sleep_goal_minutes: sleepGoalMinutes,
      avg_hrv_ms_last7: round1(avgHrvLast7),
      hrv_change_pct: round1(hrvDeltaPct),
      avg_resting_hr_bpm_last7: round1(avgRhrLast7),
      resting_hr_change_bpm: round1(rhrDelta),
      steps_total_last7: Math.round(sumStepsLast7),
      active_calories_total_last7: Math.round(sumActiveCalLast7),
    },
    missing,
  };
}

module.exports = {
  buildWeeklyReport,
};
