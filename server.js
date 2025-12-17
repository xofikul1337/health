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
app.set("trust proxy", 1);


// ---------- KnowledgeBase AI (plug-in) ----------
const aiChatRoutes = require("./api/aiChatRoutes");
app.use("/api/chat", aiChatRoutes);

// ---------- Readiness Routes (plug-in) ----------
const readinessRoutes = require("./api/readinessRoutes");
app.use("/api/readiness", readinessRoutes);
// ---------- Weekly Rotues ----------
const weeklyReportRoutes = require("./api/weeklyReportRoutes");
app.use("/api/weekly-report", weeklyReportRoutes);

// ---------- Workout Libary ----------
const exerciseRoutes = require("./api/exerciseRoutes");
app.use("/api/exercises", exerciseRoutes);



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
    const metrics = payload?.data?.metrics || payload?.metrics || [];

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
    console.log("[/api/health-data] Metric names:", metricNames);
    console.log(
      "[/api/health-data] Sample metrics (first 3):",
      JSON.stringify(metrics.slice(0, 3), null, 2)
    );

    // ---------- Per-day summary aggregator ----------
    const summary = {};

    // Apple Health date format: "2025-12-09 00:00:00 -0800"
    // We only need "YYYY-MM-DD"
    const ensureDay = (dateStr) => {
      if (!dateStr) return null;

      const trimmed = String(dateStr).trim();
      const first10 = trimmed.slice(0, 10);

      let day = null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(first10)) {
        day = first10;
      } else {
        const parsed = new Date(trimmed);
        if (isNaN(parsed)) return null;
        day = parsed.toISOString().slice(0, 10);
      }

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
          sleep_awake_minutes: 0, // ✅ new

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
      "resting_heart_rate",
      "heart_rate_variability_sdnn",
      "heart_rate_variability",
      "step_count",
      "sleep_analysis",
      "active_energy_burned",
      "active_energy",
      "basal_energy_burned",
      "body_mass",
      "weight_body_mass",
      "body_fat_percentage",
      "blood_glucose",
      "blood_pressure_systolic",
      "blood_pressure_diastolic",
    ];

    // ---------- Main merge loop ----------
    for (const metric of metrics) {
      const name = (metric.name || "").toLowerCase();

      const isKnown = knownNames.some((k) => name === k || name.includes(k));
      if (!isKnown) {
        console.log(
          "[/api/health-data] Unknown metric name from Auto Export:",
          metric.name
        );
      }

      const dataPoints = metric.data || [];
      if (!Array.isArray(dataPoints) || dataPoints.length === 0) continue;

      for (const d of dataPoints) {
        // ✅ dateStr: we try multiple keys
        const dateStr = d.date || d.end || d.endDate || d.start || d.startDate;
        if (!dateStr) continue;

        // ✅ Sleep special-case: we bucket by END if possible (important)
        if (name.includes("sleep_analysis")) {
          const sleepBucketDateStr =
            d.date || d.end || d.endDate || d.start || d.startDate;

          const sleepRow = ensureDay(sleepBucketDateStr);
          if (!sleepRow) continue;

          // (A) Summary-object format (units: "hr")
          // Example: { totalSleep, deep, rem, core, awake, date: "..." }
          const hasSummaryHours =
            typeof d.totalSleep === "number" ||
            typeof d.deep === "number" ||
            typeof d.rem === "number" ||
            typeof d.core === "number" ||
            typeof d.awake === "number";

          if (hasSummaryHours) {
            const totalMin = Math.round((Number(d.totalSleep) || 0) * 60);
            const deepMin = Math.round((Number(d.deep) || 0) * 60);
            const remMin = Math.round((Number(d.rem) || 0) * 60);
            const coreMin = Math.round((Number(d.core) || 0) * 60);
            const awakeMin = Math.round((Number(d.awake) || 0) * 60);

            // overwrite (summary = total for that day)
            sleepRow.sleep_duration_minutes = totalMin;
            sleepRow.sleep_deep_minutes = deepMin;
            sleepRow.sleep_rem_minutes = remMin;
            sleepRow.sleep_core_minutes = coreMin;
            sleepRow.sleep_awake_minutes = awakeMin;

            continue;
          }

          // (B) Segment format with start/end + stage value
          const start = new Date(d.start || d.startDate);
          const end = new Date(d.end || d.endDate);
          if (isNaN(start) || isNaN(end)) continue;

          const minutes = (end - start) / 60000;
          if (!Number.isFinite(minutes) || minutes <= 0) continue;

          sleepRow.sleep_duration_minutes += minutes;

          const stage = d.value;
          // 0 = awake, 1 = asleep, 2 = core, 3 = deep, 4 = rem
          if (stage === 0 || String(stage).toLowerCase() === "awake") {
            sleepRow.sleep_awake_minutes += minutes;
          } else if (stage === 3 || String(stage) === "Deep") {
            sleepRow.sleep_deep_minutes += minutes;
          } else if (stage === 4 || String(stage) === "REM") {
            sleepRow.sleep_rem_minutes += minutes;
          } else if (stage === 2 || stage === 1) {
            sleepRow.sleep_core_minutes += minutes;
          }

          continue;
        }

        // ---------- Non-sleep metrics ----------
        const row = ensureDay(dateStr);
        if (!row) continue;

        const value = d.qty ?? d.avg ?? d.value ?? d.min ?? d.max ?? null;
        if (value == null) continue;

        // 1) Resting HR
        if (name.includes("resting_heart_rate")) {
          row.resting_hr = Number(value);
        }

        // 2) HRV
        if (
          name.includes("heart_rate_variability_sdnn") ||
          name === "heart_rate_variability"
        ) {
          row.hrv = Number(value);
        }

        // 3) Steps
        if (name.includes("step_count")) {
          row.steps += Number(value || 0);
        }

        // 4) Active calories
        if (name.includes("active_energy_burned") || name === "active_energy") {
          row.active_calories += Number(value || 0);
        }

        // 5) Basal calories
        if (name.includes("basal_energy_burned")) {
          row.basal_calories += Number(value || 0);
        }

        // 6) Weight
        if (name.includes("body_mass") || name.includes("weight_body_mass")) {
          row.weight = Number(value);
        }

        // 7) Body fat %
        if (name.includes("body_fat_percentage")) {
          row.body_fat_percentage = Number(value);
        }

        // 8) Glucose
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
      } // ✅ end for d
    } // ✅ end for metric

    // ---------- Build rows & sanitize ----------
    let rows = Object.values(summary);

    if (rows.length === 0) {
      console.warn("[/api/health-data] No valid summary rows generated.");
      return res.json({ message: "No valid data to insert" });
    }

    // integer-safe fields
    rows = rows.map((r) => ({
      ...r,
      steps: Math.round(r.steps || 0),
      active_calories: Math.round(r.active_calories || 0),
      basal_calories: Math.round(r.basal_calories || 0),

      sleep_duration_minutes: Math.round(r.sleep_duration_minutes || 0),
      sleep_deep_minutes: Math.round(r.sleep_deep_minutes || 0),
      sleep_rem_minutes: Math.round(r.sleep_rem_minutes || 0),
      sleep_core_minutes: Math.round(r.sleep_core_minutes || 0),
      sleep_awake_minutes: Math.round(r.sleep_awake_minutes || 0),
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
    const { error } = await supabase
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

// ---------- Health check endpoint ----------
app.get("/", (req, res) => {
  res.send("THOR Health API is running.");
});

// ---------- 404 handler ----------
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// ---------- Error handler ----------
app.use((err, req, res, next) => {
  console.error("[server] Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ---------- Start server (Render uses PORT env) ----------
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`THOR Health API listening on port ${PORT}`);
});

// Increase server timeout
server.setTimeout(180000); // 3 minutes
