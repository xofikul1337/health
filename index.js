const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const payload = req.body;
    const metrics = payload?.data?.metrics || [];
    const userId = req.query.uid || req.body.user_id || "unknown_user";

    if (!userId) {
      return res.status(400).json({ error: "Missing user_id/uid" });
    }

    const summary = {};

    const ensureDay = (dateStr) => {
      const day = (dateStr || "").split("T")[0];
      if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
      if (!summary[day]) {
        summary[day] = {
          user_id: userId,
          date: day,
          resting_hr: null,
          hrv: null,
          sleep_duration_minutes: 0,
          sleep_deep_minutes: 0,
          sleep_rem_minutes: 0,
          sleep_core_minutes: 0,
          systolic: null,
          diastolic: null,
          weight_kg: null,
          body_fat_percentage: null,
          glucose_mgdl: null,
          steps: 0,
          active_calories: 0,
          basal_calories: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
      }
      return summary[day];
    };

    for (const metric of metrics) {
      const name = (metric.name || "").toLowerCase();
      for (const d of metric.data || []) {
        // Date handling
        const dateStr = d.date || d.start || d.startDate;
        if (!dateStr) continue;

        const row = ensureDay(dateStr);
        if (!row) continue;

        // Helper to get value
        const value = d.qty ?? d.avg ?? d.value ?? d.min ?? d.max ?? null;

        // Mapping
        if (name.includes("resting_heart_rate")) {
          row.resting_hr = value;
        }
        if (name.includes("heart_rate_variability_sdnn")) {
          row.hrv = value;
        }
        if (name.includes("step_count")) {
          row.steps += Number(value || 0);
        }
        if (name.includes("active_energy_burned")) {
          row.active_calories += Number(value || 0);
        }
        if (name.includes("basal_energy_burned")) {
          row.basal_calories += Number(value || 0);
        }
        if (name.includes("body_mass")) {
          row.weight_kg = value;
        }
        if (name.includes("body_fat_percentage")) {
          row.body_fat_percentage = value;
        }
        if (name.includes("blood_glucose")) {
          row.glucose_mgdl = value;
        }
        if (name.includes("blood_pressure_systolic")) {
          row.systolic = value;
        }
        if (name.includes("blood_pressure_diastolic")) {
          row.diastolic = value;
        }

        // Sleep Analysis – এটা সবচেয়ে গুরুত্বপূর্ণ ফিক্স
        if (name.includes("sleep_analysis")) {
          const start = new Date(d.start || d.startDate);
          const end = new Date(d.end || d.endDate);
          if (isNaN(start) || isNaN(end)) continue;

          const minutes = (end - start) / 60000;
          row.sleep_duration_minutes += minutes;

          // Health Auto Export usually uses numbers:
          // 0 = awake, 1 = asleep, 2 = core, 3 = deep, 4 = rem
          const stage = d.value;
          if (stage === 3 || String(stage) === "Deep") row.sleep_deep_minutes += minutes;
          else if (stage === 4 || String(stage) === "REM") row.sleep_rem_minutes += minutes;
          else if (stage === 2 || stage === 1) row.sleep_core_minutes += minutes;
        }
      }
    }

    const rows = Object.values(summary);
    if (rows.length === 0) {
      return res.json({ message: "No valid data to insert" });
    }

    const { data, error } = await supabase
      .from("daily_health_summary")
      .upsert(rows, { onConflict: "user_id,date" });

    if (error) {
      console.error("Supabase error:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      message: "Success",
      inserted_or_updated: rows.length,
      date_range: rows.map(r => r.date).sort(),
    });

  } catch (err) {
    console.error("Unexpected error:", err);
    return res.status(500).json({ error: "Server error", details: err.message });
  }
};
