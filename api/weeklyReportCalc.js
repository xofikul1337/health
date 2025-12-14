// api/weeklyReportCalc.js
// Pure calculation: takes daily rows and returns a weekly report object.

function safeNumber(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function avg(values) {
  const nums = values.map(safeNumber).filter((v) => v !== null);
  if (!nums.length) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return sum / nums.length;
}

function round(n, digits = 0) {
  if (!Number.isFinite(n)) return null;
  const p = Math.pow(10, digits);
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

// Build a short “stable / improving” style text.
function trendTextHRV(pct) {
  if (pct === null) return "HRV awaiting sync.";
  if (pct > 5) return `HRV up by ${Math.round(pct)}%`;
  if (pct < -5) return `HRV down by ${Math.abs(Math.round(pct))}%`;
  return "HRV stable";
}

function trendTextRHR(deltaBpm) {
  if (deltaBpm === null) return "Resting HR awaiting sync.";
  if (deltaBpm <= -2) return `Resting HR down by ${Math.abs(Math.round(deltaBpm))} bpm`;
  if (deltaBpm >= 2) return `Resting HR up by ${Math.round(deltaBpm)} bpm`;
  return "Resting HR stable";
}

// Main function
function buildWeeklyReport({
  userId,
  weekStart, // "YYYY-MM-DD"
  weekEnd,   // "YYYY-MM-DD"
  last7Rows = [],
  prev7Rows = [],
  sleepGoalMinutes = 450, // 7h30m
}) {
  // last7 averages
  const lastSleepAvg = avg(last7Rows.map((r) => r.sleep_duration_minutes));
  const lastHrvAvg = avg(last7Rows.map((r) => r.hrv));
  const lastRhrAvg = avg(last7Rows.map((r) => r.resting_hr));

  // prev7 averages
  const prevHrvAvg = avg(prev7Rows.map((r) => r.hrv));
  const prevRhrAvg = avg(prev7Rows.map((r) => r.resting_hr));

  const hrvPct = pctChange(lastHrvAvg, prevHrvAvg);
  const rhrDelta = (safeNumber(lastRhrAvg) !== null && safeNumber(prevRhrAvg) !== null)
    ? (lastRhrAvg - prevRhrAvg)
    : null;

  // Summary sentence (like your UI)
  const hrvLine = trendTextHRV(hrvPct);
  const rhrLine = trendTextRHR(rhrDelta);

  let sleepLine = "Sleep duration awaiting sync.";
  if (lastSleepAvg !== null) {
    if (lastSleepAvg + 1 < sleepGoalMinutes) sleepLine = "Sleep duration slightly below target.";
    else sleepLine = "Sleep duration on target.";
  }

  const summary = `${hrvLine}, ${rhrLine.toLowerCase()}. ${sleepLine}`;

  // Trends block (UI)
  const trends = [];
  if (lastSleepAvg !== null) {
    trends.push(`Average sleep: ${minutesToHM(lastSleepAvg)} (goal ${minutesToHM(sleepGoalMinutes)})`);
  } else {
    trends.push("Average sleep: Awaiting sync");
  }

  if (hrvPct !== null) trends.push(`${trendTextHRV(hrvPct)}`);
  else trends.push("HRV: Awaiting sync");

  if (rhrDelta !== null) trends.push(`${trendTextRHR(rhrDelta)}`);
  else trends.push("Resting HR: Awaiting sync");

  // Action items (simple rules)
  const actionItems = [];

  if (lastSleepAvg !== null && lastSleepAvg + 1 < sleepGoalMinutes) {
    const deficit = Math.max(10, Math.round((sleepGoalMinutes - lastSleepAvg)));
    // nice-looking “30 minutes earlier bedtime” suggestion
    const suggest = deficit >= 30 ? 30 : 15;
    actionItems.push(`Add ${suggest} minutes earlier bedtime`);
  }

  // if HRV down or RHR up => suggest extra easy day
  const hrvDown = hrvPct !== null && hrvPct < -5;
  const rhrUp = rhrDelta !== null && rhrDelta > 1.5;
  if (hrvDown || rhrUp) {
    actionItems.push("One extra rest/low-intensity day mid-week");
  }

  if (!actionItems.length) {
    actionItems.push("Keep routines consistent—sleep and recovery look stable.");
  }

  return {
    user_id: userId,
    week_start: weekStart,
    week_end: weekEnd,
    title: "Last 7 days",
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
      last7_days_count: last7Rows.length,
      prev7_days_count: prev7Rows.length,
    },
  };
}

module.exports = { buildWeeklyReport };
