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
    // 🔍 raw payload snapshot log (cut to 2000 chars to avoid log spam)
    console.log(
      "[/api/health-data] Incoming payload snapshot:",
      JSON.stringify(req.body).slice(0, 2000)
    );

    const payload = req.body;
    const metrics = payload?.data?.metrics || [];

    // basic stats
    console.log(
      "[/api/health-data] Metrics count:",
      Array.isArray(metrics) ? metrics.length : "no metrics array"
    );

    // user mapping: ?uid=... অথবা body.user_id থেকে
    const userId = req.query.uid || req.body.user_id;
    if (!userId) {
      console.warn(
        "[/api/health-data] Missing user_id/uid. Query.uid =",
        req.query.uid,
        "body.user_id =",
        req.body?.user_id
      );
      return res.status(400).json({ error: "Missing user_id/uid" });
    }

    const summary = {};

    // ✅ FIXED: date format (e.g. "2025-12-03 21:00:00 -0800")
    const ensureDay = (dateStr) => {
      if (!dateStr) return null;

      const trimmed = String(dateStr).trim();

      // প্রথম ১০ ক্যারেক্টার নিলে সরাসরি "YYYY-MM-DD"
      const first10 = trimmed.slice(0, 10); // e.g. "2025-12-03"
      let day = null;

      if (/^\d{4}-\d{2}-\d{2}$/.test(first10)) {
        day = first10;
      } else {
        // fallback: Date parser try করি
        const parsed = new Date(trimmed);
        if (isNaN(parsed)) return null;
        day = parsed.toISOString().slice(0, 10);
      }

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

      // অচেনা metric detect করার জন্য light log
      const knownNames = [
        "resting_heart_rate",
        "heart_rate_variability_sdnn",
        "heart_rate_variability",   // ✅ নতুন
        "step_count",
        "active_energy_burned",
        "active_energy",            // ✅ নতুন
        "basal_energy_burned",
        "body_mass",
        "body_fat_percentage",
        "blood_glucose",
        "blood_pressure_systolic",
        "blood_pressure_diastolic",
        "sleep_analysis",
      ];
      const isKnown = knownNames.some((k) => name.includes(k) || name === k);
      if (!isKnown) {
        console.log(
          "[/api/health-data] Unknown metric name from Auto Export:",
          metric.name
        );
      }

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

        // 2) HRV (sdnn বা generic heart_rate_variability দুটোই)
        if (
          name.includes("heart_rate_variability_sdnn") ||
          name === "heart_rate_variability"
        ) {
          row.hrv = value;
        }

        // 3) Steps
        if (name.includes("step_count")) {
          row.steps += Number(value || 0);
        }

        // 4) Active calories (Apple এর active_energy ধরছি)
        if (
          name.includes("active_energy_burned") ||
          name === "active_energy"
        ) {
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
      console.warn(
        "[/api/health-data] No valid summary rows generated. Metrics length:",
        Array.isArray(metrics) ? metrics.length : "no metrics",
        "Payload snapshot:",
        JSON.stringify(payload).slice(0, 2000)
      );
      return res.json({ message: "No valid data to insert" });
    }

    console.log(
      "[/api/health-data] Prepared summary rows for dates:",
      rows.map((r) => r.date)
    );

    const { data, error } = await supabase
      .from("daily_health_summary")
      .upsert(rows, { onConflict: "user_id,date" }); // UNIQUE(user_id,date)

    if (error) {
      console.error(
        "[/api/health-data] Supabase error while upserting rows for dates:",
        rows.map((r) => r.date),
        "Error:",
        error
      );
      return res.status(500).json({ error: error.message });
    }

    console.log(
      "[/api/health-data] Upsert success. user_id:",
      userId,
      "rows:",
      rows.length
    );

    return res.json({
      message: "Success",
      inserted_or_updated: rows.length,
      dates: rows.map((r) => r.date).sort(),
    });
  } catch (err) {
    console.error(
      "[/api/health-data] Unexpected error while processing payload:",
      err
    );
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
const server = app.listen(PORT, () => {
  console.log(`THOR Health API listening on port ${PORT}`);
});

// ⏱️ Increase server timeout (e.g. 3 minutes)
server.setTimeout(180000);
