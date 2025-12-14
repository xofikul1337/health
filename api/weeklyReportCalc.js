// api/weeklyReportCalc.js

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function fmtMinutesToHM(min) {
  const m = Math.max(0, Math.round(min || 0));
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${String(mm).padStart(2, "0")}m`;
}

function pctChange(curr, prev) {
  const c = Number(curr);
  const p = Number(prev);
  if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) return null;
  return ((c - p) / p) * 100;
}

function avg(arr) {
  const xs = (arr || []).filter((x) => Number.isFinite(x));
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * rows: array from daily_health_summary (already filtered by user_id + date range)
 * options:
 * - goalSleepMinutes default 450 (7h30m)
 */
function weeklyReportCalc(rows, options = {}) {
  const goalSleepMinutes = Number(options.goalSleepMinutes ?? 450);

  // defensive sort by date asc
  const sorted = [...(rows || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));

  // Split into last7 + prev7 (by date window, not by "available points count")
  // The route will already fetch 14 days: prev7 + last7.
  const last7 = sorted.slice(-7);
  const prev7 = sorted.slice(-14, -7);

  const sleepValsLast = last7
    .map((r) => Number(r.sleep_duration_minutes))
    .filter((m) => Number.isFinite(m) && m > 0);

  const hrvValsLast = last7
    .map((r) => Number(r.hrv))
    .filter((x) => Number.isFinite(x) && x > 0);

  const rhrValsLast = last7
    .map((r) => Number(r.resting_hr))
    .filter((x) => Number.isFinite(x) && x > 0);

  const sleepAvgLast = avg(sleepValsLast);
  const hrvAvgLast = avg(hrvValsLast);
  const rhrAvgLast = avg(rhrValsLast);

  const hrvValsPrev = prev7
    .map((r) => Number(r.hrv))
    .filter((x) => Number.isFinite(x) && x > 0);

  const rhrValsPrev = prev7
    .map((r) => Number(r.resting_hr))
    .filter((x) => Number.isFinite(x) && x > 0);

  const hrvAvgPrev = avg(hrvValsPrev);
  const rhrAvgPrev = avg(rhrValsPrev);

  const hrvDeltaPct = pctChange(hrvAvgLast, hrvAvgPrev);
  const rhrDeltaBpm = (Number.isFinite(rhrAvgLast) && Number.isFinite(rhrAvgPrev))
    ? (rhrAvgLast - rhrAvgPrev)
    : null;

  // ---------- Summary sentence (UI style) ----------
  let summaryLine = "Weekly summary is being prepared.";
  if (Number.isFinite(hrvDeltaPct) && Number.isFinite(rhrDeltaBpm)) {
    const hrvWord = hrvDeltaPct > 2 ? "improving" : hrvDeltaPct < -2 ? "down" : "stable";
    const rhrWord = rhrDeltaBpm < -0.5 ? "improving" : rhrDeltaBpm > 0.5 ? "worsening" : "stable";
    summaryLine = `HRV ${hrvWord}, resting HR ${rhrWord}.`;
  } else if (Number.isFinite(hrvDeltaPct)) {
    const hrvWord = hrvDeltaPct > 2 ? "improving" : hrvDeltaPct < -2 ? "down" : "stable";
    summaryLine = `HRV ${hrvWord}.`;
  } else if (Number.isFinite(rhrDeltaBpm)) {
    const rhrWord = rhrDeltaBpm < -0.5 ? "improving" : rhrDeltaBpm > 0.5 ? "worsening" : "stable";
    summaryLine = `Resting HR ${rhrWord}.`;
  }

  // Sleep commentary
  if (Number.isFinite(sleepAvgLast)) {
    const sleepGap = goalSleepMinutes - sleepAvgLast;
    if (sleepGap > 15) summaryLine += " Sleep duration slightly below target.";
    else if (sleepGap < -15) summaryLine += " Sleep duration above target.";
    else summaryLine += " Sleep close to target.";
  } else {
    summaryLine += " Sleep data missing for this week.";
  }

  // ---------- Trends block (UI style) ----------
  const trends = [];

  if (Number.isFinite(sleepAvgLast)) {
    trends.push({
      label: "Average sleep",
      value: `${fmtMinutesToHM(sleepAvgLast)} (goal ${fmtMinutesToHM(goalSleepMinutes)})`,
      raw: { avg_minutes: Math.round(sleepAvgLast), goal_minutes: goalSleepMinutes },
    });
  }

  if (Number.isFinite(hrvAvgLast)) {
    const deltaTxt =
      Number.isFinite(hrvDeltaPct) ? `${hrvDeltaPct >= 0 ? "up" : "down"} by ${Math.abs(round1(hrvDeltaPct))}%` : "trend unavailable";
    trends.push({
      label: "HRV",
      value: `${round1(hrvAvgLast)} ms (${deltaTxt})`,
      raw: { avg_ms: round1(hrvAvgLast), delta_pct: Number.isFinite(hrvDeltaPct) ? round1(hrvDeltaPct) : null },
    });
  }

  if (Number.isFinite(rhrAvgLast)) {
    const deltaTxt =
      Number.isFinite(rhrDeltaBpm) ? `${rhrDeltaBpm >= 0 ? "up" : "down"} by ${Math.abs(round1(rhrDeltaBpm))} bpm` : "trend unavailable";
    trends.push({
      label: "Resting HR",
      value: `${round1(rhrAvgLast)} bpm (${deltaTxt})`,
      raw: { avg_bpm: round1(rhrAvgLast), delta_bpm: Number.isFinite(rhrDeltaBpm) ? round1(rhrDeltaBpm) : null },
    });
  }

  // ---------- Action items heuristic ----------
  const actionItems = [];

  if (Number.isFinite(sleepAvgLast)) {
    const sleepGap = goalSleepMinutes - sleepAvgLast;
    if (sleepGap > 20) {
      // suggest modest step to avoid unrealistic advice
      const addMin = clamp(Math.round(sleepGap / 2), 15, 45);
      actionItems.push(`Add ${addMin} minutes earlier bedtime.`);
    }
  } else {
    actionItems.push("Enable sleep tracking so weekly readiness can include sleep trends.");
  }

  // If HRV down and RHR up => suggest extra easy day
  const hrvDown = Number.isFinite(hrvDeltaPct) && hrvDeltaPct < -5;
  const rhrUp = Number.isFinite(rhrDeltaBpm) && rhrDeltaBpm > 1;

  if (hrvDown || rhrUp) {
    actionItems.push("Add one extra rest/low-intensity day mid-week.");
  }

  if (actionItems.length === 0) {
    actionItems.push("Keep your current routine—consistency is your unfair advantage.");
  }

  // ---------- Missing coverage ----------
  const missing = [];
  if (!Number.isFinite(sleepAvgLast)) missing.push("sleep");
  if (!Number.isFinite(hrvAvgLast)) missing.push("hrv");
  if (!Number.isFinite(rhrAvgLast)) missing.push("resting_hr");

  // pick date label as end of window (last row date)
  const endDate = sorted.length ? sorted[sorted.length - 1].date : null;

  return {
    date_range: {
      // route will pass explicit range; we still provide endDate for UI
      end_date: endDate,
      days_in_window: sorted.length,
    },
    summary: summaryLine,
    trends,
    action_items: actionItems,
    used: {
      goal_sleep_minutes: goalSleepMinutes,
      last7: {
        sleep_avg_minutes: Number.isFinite(sleepAvgLast) ? Math.round(sleepAvgLast) : null,
        hrv_avg_ms: Number.isFinite(hrvAvgLast) ? round1(hrvAvgLast) : null,
        resting_hr_avg_bpm: Number.isFinite(rhrAvgLast) ? round1(rhrAvgLast) : null,
      },
      prev7: {
        hrv_avg_ms: Number.isFinite(hrvAvgPrev) ? round1(hrvAvgPrev) : null,
        resting_hr_avg_bpm: Number.isFinite(rhrAvgPrev) ? round1(rhrAvgPrev) : null,
      },
      deltas: {
        hrv_delta_pct: Number.isFinite(hrvDeltaPct) ? round1(hrvDeltaPct) : null,
        resting_hr_delta_bpm: Number.isFinite(rhrDeltaBpm) ? round1(rhrDeltaBpm) : null,
      },
    },
    missing,
  };
}

module.exports = { weeklyReportCalc };
