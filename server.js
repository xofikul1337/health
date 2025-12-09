// server.js
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

// 🔐 Supabase client (backend only: service role key)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.warn(
    "[server] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars"
  );
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
const app = express();

// ⚠️ Auto Export JSON অনেক বড় হতে পারে, তাই limit বাড়িয়ে দিলাম
app.use(express.json({ limit: "50mb" }));
app.use(cors());

// ---------- Health Auto Export Webhook ----------

app.post("/api/health-data", async (req, res) => {
  try {
    const payload = req.body;
    const metrics = payload?.data?.metrics || [];

    // user mapping: ?uid=... অথবা body.user_id থেকে
    const userId = req.query.uid || req.body.user_id;
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
          date: day, // YYYY-MM-DD (Supabase column type: date)

          resting_hr: null,
          hrv: null,

          sleep_duration_minutes: 0,
          sleep_deep_minutes: 0,
          sleep_rem_minutes: 0,
          sleep_core_minutes: 0,

          systolic: null,
          diastolic: null,

          weight: null,
          body_fat_percentage: null,
          glucose: null,

          steps: 0,
          active_calories: 0,
          basal_calories: 0,
        };
      }
      return summary[day];
    };

    for (const metric of metrics) {
      const name = (metric.name || "").toLowerCase();

      for (const d of metric.data || []) {
        const dateStr = d.date || d.start || d.startDate;
        if (!dateStr) continue;

        const row = ensureDay(dateStr);
        if (!row) continue;

        const value =
          d.qty ?? d.avg ?? d.value ?? d.min ?? d.max ?? null;

        // 1) Resting HR
        if (name.includes("resting_heart_rate")) {
          row.resting_hr = value;
        }

        // 2) HRV
        if (name.includes("heart_rate_variability_sdnn")) {
          row.hrv = value;
        }

        // 3) Steps
        if (name.includes("step_count")) {
          row.steps += Number(value || 0);
        }

        // 4) Active calories
        if (name.includes("active_energy_burned")) {
          row.active_calories += Number(value || 0);
        }

        // 5) Basal calories
        if (name.includes("basal_energy_burned")) {
          row.basal_calories += Number(value || 0);
        }

        // 6) Weight
        if (name.includes("body_mass")) {
          row.weight = value;
        }

        // 7) Body fat %
        if (name.includes("body_fat_percentage")) {
          row.body_fat_percentage = value;
        }

        // 8) Glucose
        if (name.includes("blood_glucose")) {
          row.glucose = value;
        }

        // 9) Blood pressure (systolic / diastolic as separate metrics)
        if (name.includes("blood_pressure_systolic")) {
          row.systolic = value;
        }
        if (name.includes("blood_pressure_diastolic")) {
          row.diastolic = value;
        }

        // 10–11) Sleep (duration + stages)
        if (name.includes("sleep_analysis")) {
          const start = new Date(d.start || d.startDate);
          const end = new Date(d.end || d.endDate);
          if (isNaN(start) || isNaN(end)) continue;

          const minutes = (end - start) / 60000;
          row.sleep_duration_minutes += minutes;

          const stage = d.value;
          // Auto Export: often numeric
          // 0 = awake, 1 = asleep, 2 = core, 3 = deep, 4 = rem
          if (stage === 3 || String(stage) === "Deep") {
            row.sleep_deep_minutes += minutes;
          } else if (stage === 4 || String(stage) === "REM") {
            row.sleep_rem_minutes += minutes;
          } else if (stage === 2 || stage === 1) {
            row.sleep_core_minutes += minutes;
          }
        }
      }
    }

    const rows = Object.values(summary);

    if (rows.length === 0) {
      return res.json({ message: "No valid data to insert" });
    }

    const { data, error } = await supabase
      .from("daily_health_summary")
      .upsert(rows, { onConflict: "user_id,date" }); // UNIQUE(user_id,date)

    if (error) {
      console.error("[/api/health-data] Supabase error:", error);
      return res.status(500).json({ error: error.message });
    }

    return res.json({
      message: "Success",
      inserted_or_updated: rows.length,
      dates: rows.map((r) => r.date).sort(),
    });
  } catch (err) {
    console.error("[/api/health-data] Unexpected error:", err);
    return res
      .status(500)
      .json({ error: "Server error", details: err.message });
  }
});

// ---------- Health check endpoint (for Render) ----------
app.get("/", (req, res) => {
  res.send("THOR Health API is running.");
});

// ---------- Start server (Render uses PORT env) ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`THOR Health API listening on port ${PORT}`);
});
