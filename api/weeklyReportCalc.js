// api/weeklyReportCalc.js

function isValidYmd(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function toDateUTC(ymd) {
  // interpret YYYY-MM-DD as UTC midnight
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatYmdUTC(dt) {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDaysUTC(ymd, delta) {
  const dt = toDateUTC(ymd);
  dt.setUTCDate(dt.getUTCDate() + delta);
  return formatYmdUTC(dt);
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function round(n, digits = 0) {
  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
}

function avg(arr) {
  const nums = arr.filter((x) => Number.isFinite(x));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function pctChange(current, prev) {
  if (!Number.isFinite(current) || !Number.isFinite(prev) || prev === 0) return null;
  return ((current - prev) / prev) * 100;
}

function minutesToHhMm(min) {
  const m = Math.max(0, Math.round(min || 0));
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${hh}h ${String(mm).padStart(2, "0")}m`;
}

/**
 * Build weekly report payload from daily rows (daily_health_summary).
 * daily rows expected fields:
 * - date (YYYY-MM-DD)
 * - sleep_duration_minutes, sleep_deep_minutes, sleep_rem_minutes, sleep_core_minutes, sleep_awake_minutes
 * - hrv, resting_hr, steps, active_calories
 */
function buildWeeklyReport({
  uid,
  end, // YYYY-MM-DD
  goalSleepMinutes = 450,
  dailyRows = [],
  prevDailyRows = [], // previous 7 days for trend comparison
}) {
  if (!uid) throw new Error("Missing uid");
  if (!isValidYmd(end)) throw new Error("Invalid end date (YYYY-MM-DD required)");

  const weekEnd = end;
  const weekStart = addDaysUTC(weekEnd, -6);

  // Current window aggregation
  const sleepMins = [];
  const hrvVals = [];
  const rhrVals = [];

  let daysCount = 0;
  let daysWithSleep = 0;
  let daysWithHrv = 0;
  let daysWithRhr = 0;

  for (const r of dailyRows) {
    // ensure row within [weekStart, weekEnd]
    if (!r?.date || r.date < weekStart || r.date > weekEnd) continue;
    daysCount++;

    const s = Number(r.sleep_duration_minutes || 0);
    if (Number.isFinite(s) && s > 0) {
      sleepMins.push(s);
      daysWithSleep++;
    }

    const h = Number(r.hrv);
    if (Number.isFinite(h) && h > 0) {
      hrvVals.push(h);
      daysWithHrv++;
    }

    const rr = Number(r.resting_hr);
    if (Number.isFinite(rr) && rr > 0) {
      rhrVals.push(rr);
      daysWithRhr++;
    }
  }

  const avgSleep = avg(sleepMins);
  const avgHrv = avg(hrvVals);
  const avgRhr = avg(rhrVals);

  // Previous window aggregation (trend baseline)
  const prevSleep = avg(
    prevDailyRows
      .filter((r) => r?.sleep_duration_minutes > 0)
      .map((r) => Number(r.sleep_duration_minutes))
  );
  const prevHrv = avg(
    prevDailyRows
      .filter((r) => Number.isFinite(Number(r.hrv)) && Number(r.hrv) > 0)
      .map((r) => Number(r.hrv))
  );
  const prevRhr = avg(
    prevDailyRows
      .filter((r) => Number.isFinite(Number(r.resting_hr)) && Number(r.resting_hr) > 0)
      .map((r) => Number(r.resting_hr))
  );

  const sleepChangePct = avgSleep != null && prevSleep != null ? pctChange(avgSleep, prevSleep) : null;
  const hrvChangePct = avgHrv != null && prevHrv != null ? pctChange(avgHrv, prevHrv) : null;
  const restingHrChangeBpm = avgRhr != null && prevRhr != null ? (avgRhr - prevRhr) : null; // positive = worse

  // Text template + action items
  const trendBits = [];

  // Sleep trend vs goal + vs previous
  if (avgSleep != null) {
    const goalDelta = Math.round(avgSleep - goalSleepMinutes);
    const goalNote =
      goalDelta >= 0
        ? `on target (goal ${minutesToHhMm(goalSleepMinutes)})`
        : `below target (goal ${minutesToHhMm(goalSleepMinutes)})`;

    trendBits.push(`Average sleep: ${minutesToHhMm(avgSleep)} (${goalNote})`);
  } else {
    trendBits.push(`Average sleep: Awaiting sync`);
  }

  if (avgHrv != null) {
    const change = hrvChangePct != null ? `${round(hrvChangePct, 0)}%` : "—";
    trendBits.push(`HRV ${hrvChangePct == null ? "stable" : (hrvChangePct >= 0 ? "up" : "down")} by ${change}`);
  } else {
    trendBits.push(`HRV: Awaiting sync`);
  }

  if (avgRhr != null) {
    const change = restingHrChangeBpm != null ? `${round(Math.abs(restingHrChangeBpm), 0)} bpm` : "—";
    const dir =
      restingHrChangeBpm == null ? "stable" : (restingHrChangeBpm <= 0 ? "down" : "up");
    trendBits.push(`Resting HR ${dir} by ${change}`);
  } else {
    trendBits.push(`Resting HR: Awaiting sync`);
  }

  // Action items: keep them conservative + data-dependent
  const actions = [];

  if (avgSleep != null && avgSleep < goalSleepMinutes) {
    actions.push("Add 30 minutes earlier bedtime");
  }

  // If HRV down or Resting HR up, suggest extra recovery day
  const stressFlag =
    (hrvChangePct != null && hrvChangePct < -3) ||
    (restingHrChangeBpm != null && restingHrChangeBpm > 1);

  if (stressFlag) {
    actions.push("One extra rest/low-intensity day mid-week");
  }

  // If we have no actions (all good), still return something light
  if (actions.length === 0) {
    actions.push("Maintain consistency: keep sleep and training routines steady");
  }

  // One-liner summary (UI header)
  let summaryText = "Weekly report generated.";
  if (avgSleep != null && avgHrv != null && avgRhr != null) {
    // small narrative
    const hrvWord =
      hrvChangePct == null ? "stable" : (hrvChangePct >= 0 ? "improving" : "dipping");
    const rhrWord =
      restingHrChangeBpm == null ? "steady" : (restingHrChangeBpm <= 0 ? "improving" : "elevated");

    summaryText = `HRV ${hrvWord}, resting HR ${rhrWord}. Sleep ${avgSleep >= goalSleepMinutes ? "near target" : "slightly below target"}.`;
  } else if (avgSleep == null && avgHrv == null && avgRhr == null) {
    summaryText = "Awaiting sync: not enough data this week.";
  }

  const trendsJson = {
    window: { week_start: weekStart, week_end: weekEnd },
    averages: {
      sleep_minutes: avgSleep != null ? Math.round(avgSleep) : null,
      hrv_ms: avgHrv != null ? round(avgHrv, 1) : null,
      resting_hr_bpm: avgRhr != null ? round(avgRhr, 1) : null,
    },
    changes_vs_prev7: {
      sleep_change_pct: sleepChangePct != null ? round(sleepChangePct, 1) : null,
      hrv_change_pct: hrvChangePct != null ? round(hrvChangePct, 1) : null,
      resting_hr_change_bpm: restingHrChangeBpm != null ? round(restingHrChangeBpm, 1) : null,
    },
    lines: trendBits,
  };

  return {
    user_id: uid,
    week_start: weekStart,
    week_end: weekEnd,

    goal_sleep_minutes: Math.round(Number(goalSleepMinutes) || 450),

    days_count: daysCount,
    days_with_sleep: daysWithSleep,
    days_with_hrv: daysWithHrv,
    days_with_resting_hr: daysWithRhr,

    avg_sleep_minutes: avgSleep != null ? Math.round(avgSleep) : null,
    avg_hrv: avgHrv != null ? round(avgHrv, 4) : null,
    avg_resting_hr: avgRhr != null ? round(avgRhr, 4) : null,

    sleep_change_pct: sleepChangePct != null ? round(sleepChangePct, 6) : null,
    hrv_change_pct: hrvChangePct != null ? round(hrvChangePct, 6) : null,
    resting_hr_change_bpm: restingHrChangeBpm != null ? round(restingHrChangeBpm, 6) : null,

    summary_text: summaryText,
    trends_json: trendsJson,
    action_items_json: actions,
  };
}

module.exports = {
  buildWeeklyReport,
  isValidYmd,
  addDaysUTC,
};
