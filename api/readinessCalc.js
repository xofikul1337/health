// api/readinessCalc.js

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Compute a readiness score from ONE day's daily_health_summary row.
 * This is "pure": no DB, no Express.
 */
function computeReadiness(dayRow, opts = {}) {
  const {
    // targets
    sleepTargetMinutes = 8 * 60, // 480
    // these are reasonable "soft" ranges; tune later as you learn your users
    hrvGoodMs = 60,
    hrvLowMs = 20,
    restingHrGood = 55,
    restingHrHigh = 85,
  } = opts;

  if (!dayRow) {
    return {
      date: null,
      total: null,
      status: "awaiting_sync",
      message: "Awaiting sync",
      subscores: {},
      weights: {},
      used: {},
      missing: ["sleep", "hrv", "resting_hr", "steps", "active_calories"],
      tips: ["No daily row found for this date."],
    };
  }

  const date = dayRow.date;

  // ---- Extract numbers safely
  const sleepMinutes = toNum(dayRow.sleep_duration_minutes);
  const deepMin = toNum(dayRow.sleep_deep_minutes);
  const remMin = toNum(dayRow.sleep_rem_minutes);
  const coreMin = toNum(dayRow.sleep_core_minutes);
  const awakeMin = toNum(dayRow.sleep_awake_minutes);

  const hrv = toNum(dayRow.hrv);
  const restingHr = toNum(dayRow.resting_hr);

  const steps = toNum(dayRow.steps);
  const activeCalories = toNum(dayRow.active_calories);

  // ---- Missing detection
  const missing = [];
  if (!sleepMinutes || sleepMinutes <= 0) missing.push("sleep");
  if (!hrv) missing.push("hrv");
  if (!restingHr) missing.push("resting_hr");
  if (!Number.isFinite(steps)) missing.push("steps");
  if (!Number.isFinite(activeCalories)) missing.push("active_calories");

  // Sleep stages missing? (optional)
  const hasStages =
    (deepMin && deepMin > 0) ||
    (remMin && remMin > 0) ||
    (coreMin && coreMin > 0) ||
    (awakeMin && awakeMin > 0);

  // ---- Weights (your UI spec)
  const weights = {
    sleep: 0.30,
    hrv: 0.25,
    resting_hr: 0.20,
    recovery: 0.15,     // we’ll compute from steps/active calories (simple proxy)
    subjective: 0.10,   // placeholder for later user input
  };

  // If some metrics missing, we keep total but mark status + explain.
  // (You could also re-normalize weights later; for now: transparent is better.)
  const tips = [];

  // ---- Subscore: Sleep (0-100)
  // Basic: sleepMinutes vs target
  let sleepScore = null;
  if (sleepMinutes && sleepMinutes > 0) {
    const ratio = sleepMinutes / sleepTargetMinutes; // 0..?
    // 1.0 => 100, 0.75 => ~75, cap at 100
    sleepScore = clamp(Math.round(ratio * 100), 0, 100);

    // bonus/penalty from stages if available
    if (hasStages && sleepMinutes > 0) {
      const deepPct = deepMin ? deepMin / sleepMinutes : 0;
      const remPct = remMin ? remMin / sleepMinutes : 0;
      const awakePct = awakeMin ? awakeMin / (sleepMinutes + awakeMin) : 0;

      // “reasonable” bands (not medical, just heuristic)
      // deep 10–25%, rem 15–30%, awake less is better
      let stageAdj = 0;
      if (deepPct > 0 && deepPct < 0.08) stageAdj -= 5;
      if (deepPct > 0.30) stageAdj -= 3;
      if (remPct > 0 && remPct < 0.12) stageAdj -= 4;
      if (awakePct > 0.12) stageAdj -= 5;

      sleepScore = clamp(sleepScore + stageAdj, 0, 100);
    }

    if (sleepMinutes < 6 * 60) tips.push("Sleep was under 6 hours. A longer night will boost readiness most.");
  } else {
    tips.push("Sleep data not synced for this day.");
  }

  // ---- Subscore: HRV (0-100)
  // Map low->0, good->100 (soft clamp)
  let hrvScore = null;
  if (hrv) {
    const scaled = ((hrv - hrvLowMs) / (hrvGoodMs - hrvLowMs)) * 100;
    hrvScore = clamp(Math.round(scaled), 0, 100);
    if (hrv < hrvLowMs) tips.push("HRV is low vs baseline range. Consider lighter training and more recovery.");
  } else {
    tips.push("HRV data not synced for this day.");
  }

  // ---- Subscore: Resting HR (0-100)
  // Lower is better (within reason). Above high => downscore.
  let rhrScore = null;
  if (restingHr) {
    // Good => 100, High => 0 (linear)
    const scaled = ((restingHrHigh - restingHr) / (restingHrHigh - restingHrGood)) * 100;
    rhrScore = clamp(Math.round(scaled), 0, 100);
    if (restingHr >= restingHrHigh) tips.push("Resting HR is elevated. That often correlates with stress/poor recovery.");
  } else {
    tips.push("Resting HR data not synced for this day.");
  }

  // ---- Subscore: Recovery proxy (0-100)
  // We do a simple training-load proxy from steps + active calories.
  // If load is huge but sleep/HRV are weak => lower. If moderate load => better.
  let recoveryScore = null;
  if (Number.isFinite(steps) || Number.isFinite(activeCalories)) {
    const s = Number.isFinite(steps) ? steps : 0;
    const c = Number.isFinite(activeCalories) ? activeCalories : 0;

    // heuristics: 8k steps + 500 active cal = "moderate"
    const load = (s / 8000) + (c / 500);
    // ideal load around ~1.0; too high => penalty
    const deviation = Math.abs(load - 1.0);
    recoveryScore = clamp(Math.round(100 - deviation * 50), 0, 100);

    if (load > 2.0) tips.push("High activity load. Keep volume controlled if recovery signals are mediocre.");
  } else {
    tips.push("Activity data not synced for this day.");
  }

  // ---- Subscore: Subjective (placeholder)
  // Later: store user mood/soreness in a separate table & feed here.
  const subjectiveScore = 50;

  // ---- Weighted total
  const subscores = {
    sleep: sleepScore,
    hrv: hrvScore,
    resting_hr: rhrScore,
    recovery: recoveryScore,
    subjective: subjectiveScore,
  };

  const used = {
    sleep_minutes: sleepMinutes,
    deep_minutes: deepMin,
    rem_minutes: remMin,
    core_minutes: coreMin,
    awake_minutes: awakeMin,
    hrv_ms: hrv,
    resting_hr_bpm: restingHr,
    steps,
    active_calories: activeCalories,
  };

  // If any core score is null, total becomes null (Awaiting sync)
  const coreNull = [sleepScore, hrvScore, rhrScore, recoveryScore].some((x) => x == null);
  let total = null;

  if (!coreNull) {
    const weighted =
      subscores.sleep * weights.sleep +
      subscores.hrv * weights.hrv +
      subscores.resting_hr * weights.resting_hr +
      subscores.recovery * weights.recovery +
      subscores.subjective * weights.subjective;

    total = clamp(Math.round(weighted), 0, 100);
  }

  // ---- Recommendation text (simple)
  let rec = "Awaiting sync";
  if (total != null) {
    if (total >= 85) rec = "Readiness is high. You can push intensity today—still warm up properly.";
    else if (total >= 70) rec = "Readiness is moderate. One main heavy lift, keep volume controlled, prioritize sleep tonight.";
    else if (total >= 50) rec = "Readiness is low-moderate. Prefer technique work, easy cardio, and recovery.";
    else rec = "Readiness is low. Focus on rest, hydration, and sleep—avoid hard training.";
  }

  const status = total == null ? "awaiting_sync" : "ok";

  return {
    date,
    total,
    status,
    message: status === "awaiting_sync" ? "Awaiting sync" : `${total}/100`,
    subscores,
    weights,
    used,
    missing,
    recommendation: rec,
    tips,
  };
}

module.exports = { computeReadiness };
