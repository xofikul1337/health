// api/weeklyReportCalc.js
// Pure weekly aggregation + safe text template (new user friendly)

function safeNumber(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === "string" && x.trim() === "") return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function avg(values) {
  const nums = values.map(safeNumber).filter((v) => v !== null);
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function round(n, digits = 0) {
  if (!Number.isFinite(n)) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function minutesToHM(min) {
  const m = Math.max(0, Math.round(min || 0));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${String(mm).padStart(2, "0")}m`;
}

function pctChange(current, previous) {
  const c = safeNumber(current);
  const p = safeNumber(previous);
  if (c === null || p === null || p === 0) return null;
  return ((c - p) / p) * 100;
}

/**
 * Build weekly report record (ready to insert/upsert).
 * New-user safe: avoids misleading "trend" claims with tiny sample sizes.
 */
function buildWeeklyReport({
  userId,
  weekStart, // YYYY-MM-DD
  weekEnd,   // YYYY-MM-DD
  last7Rows = [],
  prev7Rows = [],
  sleepGoalMinutes = 450,  // 7h30m default
  minDaysForOk = 4,
  minDaysForCompare = 4,
}) {
  const syncedDays = Array.isArray(last7Rows) ? last7Rows.length : 0;
  const prevDays = Array.isArray(prev7Rows) ? prev7Rows.length : 0;

  // ---------- Status ----------
  let status = "ok";
  if (syncedDays === 0) status = "awaiting_sync";
  else if (syncedDays < minDaysForOk) status = "partial";

  // ---------- Averages (last 7 window) ----------
  const lastSleepAvg = avg(last7Rows.map((r) => r.sleep_duration_minutes));
  const lastHrvAvg = avg(last7Rows.map((r) => r.hrv));
  const lastRhrAvg = avg(last7Rows.map((r) => r.resting_hr));

  // ---------- Previous averages only if enough data ----------
  const canCompare =
    syncedDays >= minDaysForCompare && prevDays >= minDaysForCompare;

  const prevHrvAvg = canCompare ? avg(prev7Rows.map((r) => r.hrv)) : null;
  const prevRhrAvg = canCompare ? avg(prev7Rows.map((r) => r.resting_hr)) : null;

  const hrvPct = canCompare ? pctChange(lastHrvAvg, prevHrvAvg) : null;

  const lastR = safeNumber(lastRhrAvg);
  const prevR = safeNumber(prevRhrAvg);
  const rhrDelta =
    canCompare && lastR !== null && prevR !== null ? lastR - prevR : null;

  // ---------- Trend lines (truthful texts) ----------
  const hrvLine = (() => {
    if (safeNumber(lastHrvAvg) === null) return "HRV awaiting sync.";
    if (!canCompare) return "HRV baseline not available yet.";
    if (hrvPct === null) return "HRV baseline not available yet.";
    if (hrvPct > 5) return `HRV up by ${Math.round(hrvPct)}%.`;
    if (hrvPct < -5) return `HRV down by ${Math.abs(Math.round(hrvPct))}%.`;
    return "HRV stable.";
  })();

  const rhrLine = (() => {
    if (safeNumber(lastRhrAvg) === null) return "Resting HR awaiting sync.";
    if (!canCompare) return "Resting HR baseline not available yet.";
    if (rhrDelta === null) return "Resting HR baseline not available yet.";
    if (rhrDelta <= -2) return `Resting HR down by ${Math.abs(Math.round(rhrDelta))} bpm.`;
    if (rhrDelta >= 2) return `Resting HR up by ${Math.round(rhrDelta)} bpm.`;
    return "Resting HR stable.";
  })();

  const sleepLine = (() => {
    if (lastSleepAvg === null) return "Sleep duration awaiting sync.";
    if (lastSleepAvg + 1 < sleepGoalMinutes) return "Sleep duration slightly below target.";
    return "Sleep duration on target.";
  })();

  const coverageLine =
    status === "partial"
      ? `Only ${syncedDays} of 7 days synced so far—trends may change as more data arrives.`
      : null;

  // ---------- Summary ----------
  const summary = [hrvLine, rhrLine, sleepLine, coverageLine]
    .filter(Boolean)
    .join(" ");

  // ---------- Trends list (UI lines) ----------
  const trends = [];
  trends.push(
    lastSleepAvg !== null
      ? `Average sleep: ${minutesToHM(lastSleepAvg)} (goal ${minutesToHM(sleepGoalMinutes)})`
      : "Average sleep: Awaiting sync"
  );
  trends.push(
    safeNumber(lastHrvAvg) === null ? "HRV: Awaiting sync" : hrvLine.replace(/\.$/, "")
  );
  trends.push(
    safeNumber(lastRhrAvg) === null ? "Resting HR: Awaiting sync" : rhrLine.replace(/\.$/, "")
  );

  // ---------- Action items ----------
  const actionItems = [];

  if (lastSleepAvg !== null && lastSleepAvg + 1 < sleepGoalMinutes) {
    const deficit = Math.max(10, Math.round(sleepGoalMinutes - lastSleepAvg));
    const suggest = deficit >= 30 ? 30 : 15;
    actionItems.push(`Add ${suggest} minutes earlier bedtime`);
  }

  if (status !== "ok") {
    actionItems.push("Sync a few more days to unlock reliable weekly trends.");
  } else {
    actionItems.push("One extra rest/low-intensity day mid-week");
  }

  // ---------- Record for DB ----------
  return {
    user_id: userId,
    week_start: weekStart,
    week_end: weekEnd,
    title: "Last 7 days",
    status,
    summary,

    avg_sleep_minutes: lastSleepAvg !== null ? Math.round(lastSleepAvg) : null,
    sleep_goal_minutes: sleepGoalMinutes,

    avg_hrv_ms: lastHrvAvg !== null ? round(lastHrvAvg, 1) : null,
    hrv_change_pct: hrvPct !== null ? round(hrvPct, 1) : null,

    avg_resting_hr_bpm: lastRhrAvg !== null ? round(lastRhrAvg, 1) : null,
    resting_hr_change_bpm: rhrDelta !== null ? round(rhrDelta, 1) : null,

    trends,
    action_items: actionItems,

    meta: {
      last7_days_count: syncedDays,
      prev7_days_count: prevDays,
      can_compare: canCompare,
      thresholds: {
        minDaysForOk,
        minDaysForCompare,
      },
    },
  };
}

module.exports = { buildWeeklyReport };
