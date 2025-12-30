// api/trendsRoutes.js
const express = require("express");

function toISODate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

function daysAgoISO(days) {
  const d = new Date();
  d.setDate(d.getDate() - Number(days || 0));
  return toISODate(d);
}

// Very simple readiness estimate (until you add a readiness table)
// This is NOT your real readiness algorithm, but it gives a chart value 0-100
function estimateReadiness({ hrv, rhr, sleepMin }) {
  const sleepH = Number(sleepMin || 0) / 60;

  // normalize pieces (rough)
  const sleepScore = Math.max(0, Math.min(1, sleepH / 8)); // 0..1
  const hrvScore = hrv == null ? 0.5 : Math.max(0, Math.min(1, Number(hrv) / 80)); // assume 80ms good
  const rhrScore = rhr == null ? 0.5 : Math.max(0, Math.min(1, 1 - (Number(rhr) - 50) / 40)); // 50 best, 90 worst

  const total = 100 * (0.4 * sleepScore + 0.35 * hrvScore + 0.25 * rhrScore);
  return Math.round(Math.max(0, Math.min(100, total)));
}

module.exports = function trendsRoutes(supabase) {
  const router = express.Router();

  // GET /api/trends/health?uid=...&days=7|30|90
  router.get("/health", async (req, res) => {
    try {
      const uid = req.query.uid;
      const days = Number(req.query.days || 30);

      if (!uid) return res.status(400).json({ error: "Missing uid" });
      if (![7, 30, 90].includes(days)) return res.status(400).json({ error: "days must be 7, 30, or 90" });

      const from = daysAgoISO(days);

      const { data, error } = await supabase
        .from("daily_health_summary")
        .select(
          "date, hrv, resting_hr, sleep_duration_minutes, weight, body_fat_percentage, steps"
        )
        .eq("user_id", uid)
        .gte("date", from)
        .order("date", { ascending: true });

      if (error) throw error;

      const rows = (data || []).map((r) => {
        const sleepMin = r.sleep_duration_minutes ?? 0;
        return {
          date: r.date,
          hrv: r.hrv ?? null,
          rhr: r.resting_hr ?? null,
          sleep_minutes: sleepMin,
          sleep_hours: sleepMin ? Math.round((sleepMin / 60) * 10) / 10 : null,
          weight: r.weight ?? null,
          body_fat_percentage: r.body_fat_percentage ?? null,
          steps: r.steps ?? null,

          // Temporary: provide readiness value for chart until real table exists
          readiness_estimate: estimateReadiness({
            hrv: r.hrv,
            rhr: r.resting_hr,
            sleepMin,
          }),
        };
      });

      return res.json({
        meta: { uid, days, from, count: rows.length },
        data: rows,
      });
    } catch (e) {
      console.error("[/api/trends/health] error:", e);
      return res.status(500).json({ error: e.message || "Server error" });
    }
  });

  // GET /api/trends/training-volume?uid=...&days=7|30|90
  // Returns daily totals: set_count + volume (sum weight*reps where possible)
  router.get("/training-volume", async (req, res) => {
    try {
      const uid = req.query.uid;
      const days = Number(req.query.days || 30);

      if (!uid) return res.status(400).json({ error: "Missing uid" });
      if (![7, 30, 90].includes(days)) return res.status(400).json({ error: "days must be 7, 30, or 90" });

      const from = daysAgoISO(days);

      // workouts
      const { data: workouts, error: wErr } = await supabase
        .from("workouts")
        .select("id, workout_date, created_at")
        .eq("user_id", uid)
        .gte("workout_date", from)
        .order("workout_date", { ascending: true });

      if (wErr) throw wErr;

      const workoutIds = (workouts || []).map((w) => w.id);
      if (!workoutIds.length) {
        return res.json({
          meta: { uid, days, from, count: 0 },
          data: [],
        });
      }

      const { data: wex, error: exErr } = await supabase
        .from("workout_exercises")
        .select("id, workout_id")
        .in("workout_id", workoutIds);

      if (exErr) throw exErr;

      const wexIds = (wex || []).map((x) => x.id);
      if (!wexIds.length) {
        return res.json({
          meta: { uid, days, from, count: 0 },
          data: [],
        });
      }

      const { data: sets, error: sErr } = await supabase
        .from("workout_sets")
        .select("workout_exercise_id, weight, reps")
        .in("workout_exercise_id", wexIds);

      if (sErr) throw sErr;

      const wDateMap = new Map((workouts || []).map((w) => [w.id, w.workout_date || (w.created_at ? String(w.created_at).slice(0, 10) : null)]));

      const exToWorkout = new Map((wex || []).map((x) => [x.id, x.workout_id]));

      // aggregate by date
      const byDate = new Map(); // date -> { set_count, volume }
      for (const s of sets || []) {
        const workoutId = exToWorkout.get(s.workout_exercise_id);
        const date = workoutId ? wDateMap.get(workoutId) : null;
        if (!date) continue;

        const reps = Number(s.reps);
        const weight = Number(s.weight);
        const hasVol = Number.isFinite(reps) && Number.isFinite(weight);

        const prev = byDate.get(date) || { date, set_count: 0, volume: 0 };
        prev.set_count += 1;
        if (hasVol) prev.volume += reps * weight;
        byDate.set(date, prev);
      }

      const out = Array.from(byDate.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));

      return res.json({
        meta: { uid, days, from, count: out.length },
        data: out.map((x) => ({
          ...x,
          volume: Math.round(x.volume), // nicer number
        })),
      });
    } catch (e) {
      console.error("[/api/trends/training-volume] error:", e);
      return res.status(500).json({ error: e.message || "Server error" });
    }
  });

  return router;
};
