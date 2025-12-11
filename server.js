// server.js
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

// ---------- Supabase client (backend only: service role key) ----------
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  console.warn(
    "[server] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars"
  );
}

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);
const app = express();

// ---------- Express middleware ----------
app.use(express.json({ limit: "50mb" }));
app.use(cors());

// ---------- Health Auto Export Webhook ----------
app.post("/api/health-data", async (req, res) => {
  try {
    // 1) Raw snapshot log (limited)
    const rawSnapshot = JSON.stringify(req.body).slice(0, 5000);
    console.log(
      "[/api/health-data] RAW payload snapshot (first 5000 chars):",
      rawSnapshot
    );

    const payload = req.body;
    const metrics =
      payload?.data?.metrics || payload?.metrics || [];

    // 2) User mapping
    const userId = req.query.uid || req.body.user_id;
    console.log(
      "[/api/health-data] userId from request: query.uid =",
      req.query.uid,
      "body.user_id =",
      req.body?.user_id,
      "→ final userId =",
      userId
    );
    if (!userId) {
      console.warn(
        "[/api/health-data] Missing user_id/uid. Rejecting request."
      );
      return res.status(400).json({ error: "Missing user_id/uid" });
    }

    // 3) Metrics basic info
    console.log(
      "[/api/health-data] Metrics array type:",
      Array.isArray(metrics) ? "Array" : typeof metrics,
      "| count:",
      Array.isArray(metrics) ? metrics.length : "N/A"
    );

    if (!Array.isArray(metrics) || metrics.length === 0) {
      console.warn("[/api/health-data] No metrics in payload.");
      return res.json({ message: "No metrics in payload" });
    }

    const metricNames = metrics.map((m) => m.name).filter(Boolean);
    console.log(
      "[/api/health-data] Metric names:",
      metricNames
    );

    console.log(
      "[/api/health-data] Sample metrics (first 3):",
      JSON.stringify(metrics.slice(0, 3), null, 2)
    );

    // ---------- Per-day summary aggregator ----------
    const summary = {};

    // Apple Health date format: "2025-12-09 00:00:00 -0800"
    // আমাদের জন্য শুধু "YYYY-MM-DD" দরকার
    const ensureDay = (dateStr) => {
      if (!dateStr) return null;

      const trimmed = String(dateStr).trim();
      const first10 = trimmed.slice(0, 10); // 2025-12-09

      let day = null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(first10)) {
        day = first10;
      } else {
        const parsed = new Date(trimmed);
        if (isNaN(parsed)) return null;
        day = parsed.toISOString().slice(0, 10); // fallback
      }

      if (!summary[day]) {
        summary[day] = {
          user_id: userId,
          date: day, // Supabase: date

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

    // ---------- Known metrics list ----------
    const knownNames = [
      // Core
      "resting_heart_rate",
      "heart_rate_variability_sdnn",
      "heart_rate_variability",
      "step_count",
      "sleep_analysis",

      // Energy
      "active_energy_burned",
      "active_energy",
      "basal_energy_burned",

      // Weight + body comp
      "body_mass",
      "weight_body_mass",
      "body_fat_percentage",

      // Glucose
      "blood_glucose",

      // BP
      "blood_pressure_systolic",
      "blood_pressure_diastolic",
    ];

    // ---------- Main merge loop ----------
    for (const metric of metrics) {
      const name = (metric.name || "").toLowerCase();

      const isKnown = knownNames.some(
        (k) => name === k || name.includes(k)
      );
      if (!isKnown) {
        console.log(
          "[/api/health-data] Unknown metric name from Auto Export:",
          metric.name
        );
      }

      const dataPoints = metric.data || [];
      if (!Array.isArray(dataPoints) || dataPoints.length === 0) continue;

      for (const d of dataPoints) {
        const dateStr = d.date || d.start || d.startDate;
        if (!dateStr) continue;

        const row = ensureDay(dateStr);
        if (!row) continue;

        const value =
          d.qty ?? d.avg ?? d.value ?? d.min ?? d.max ?? null;
        if (value == null) continue;

        // 1) Resting HR
        if (name.includes("resting_heart_rate")) {
          row.resting_hr = Number(value);
        }

        // 2) HRV (Apple কখনো "heart_rate_variability" নামে দেয়)
        if (
          name.includes("heart_rate_variability_sdnn") ||
          name === "heart_rate_variability"
        ) {
          row.hrv = Number(value);
        }

        // 3) Steps (int)
        if (name.includes("step_count")) {
          row.steps += Number(value || 0);
        }

        // 4) Active calories (int)
        if (
          name.includes("active_energy_burned") ||
          name === "active_energy"
        ) {
          row.active_calories += Number(value || 0);
        }

        // 5) Basal calories (int)
        if (name.includes("basal_energy_burned")) {
          row.basal_calories += Number(value || 0);
        }

        // 6) Weight (kg / lb)
        if (
          name.includes("body_mass") ||
          name.includes("weight_body_mass")
        ) {
          row.weight = Number(value);
        }

        // 7) Body fat %
        if (name.includes("body_fat_percentage")) {
          row.body_fat_percentage = Number(value);
        }

        // 8) Glucose (mg/dL)
        if (name.includes("blood_glucose")) {
          row.glucose = Number(value);
        }

        // 9) Blood pressure
        if (name.includes("blood_pressure_systolic")) {
          row.systolic = Number(value);
        }
        if (name.includes("blood_pressure_diastolic")) {
          row.diastolic = Number(value);
        }

        // 10) Sleep (duration + stages)
        if (name.includes("sleep_analysis")) {
          const start = new Date(d.start || d.startDate || dateStr);
          const end = new Date(d.end || d.endDate || dateStr);
          if (isNaN(start) || isNaN(end)) continue;

          const minutes = (end - start) / 60000;
          if (!Number.isFinite(minutes) || minutes <= 0) continue;

          row.sleep_duration_minutes += minutes;

          const stage = d.value;
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

    // ---------- Build rows & type-sanitize ----------
    let rows = Object.values(summary);

    if (rows.length === 0) {
      console.warn(
        "[/api/health-data] No valid summary rows generated."
      );
      return res.json({ message: "No valid data to insert" });
    }

    // Steps / calories integer করে নিচ্ছি (Supabase integer column এর জন্য safe)
    rows = rows.map((r) => ({
      ...r,
      steps: Math.round(r.steps || 0),
      active_calories: Math.round(r.active_calories || 0),
      basal_calories: Math.round(r.basal_calories || 0),
    }));

    console.log(
      "[/api/health-data] Prepared summary rows for dates:",
      rows.map((r) => r.date)
    );
    console.log(
      "[/api/health-data] Example row:",
      JSON.stringify(rows[0], null, 2)
    );

    // ---------- Upsert into Supabase ----------
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
    return res.status(500).json({
      error: "Server error",
      details: err.message,
    });
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

// Render মাঝে মাঝে long request-এ timeout খায়, একটু বাড়িয়ে দিলাম
server.setTimeout(180000); // 3 minutes
