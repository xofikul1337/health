// server.js
const express = require("express");
const cors = require("cors");

const app = express();


app.use(express.json({ limit: "50mb" }));
app.use(cors());

// ---------- Health Auto Export Webhook (LOG ONLY VERSION) ----------

app.post("/api/health-data", async (req, res) => {
  try {
    const payload = req.body;

 
    console.log(
      "[/api/health-data] RAW payload snapshot (first 5000 chars):",
      JSON.stringify(payload).slice(0, 5000)
    );

    // user mapping: query.uid বা body.user_id
    const userId = req.query.uid || payload?.user_id;
    console.log(
      "[/api/health-data] userId from request:",
      "query.uid =", req.query.uid,
      "body.user_id =", payload?.user_id,
      "→ final userId =", userId || "(NONE)"
    );

    const metrics = payload?.data?.metrics || [];
    console.log(
      "[/api/health-data] Metrics array type:",
      Array.isArray(metrics) ? "Array" : typeof metrics,
      "| count:",
      Array.isArray(metrics) ? metrics.length : "no metrics array"
    );

    // সব metric name একসাথে দেখাই
    if (Array.isArray(metrics) && metrics.length > 0) {
      const metricNames = metrics.map((m) => m.name);
      console.log("[/api/health-data] Metric names:", metricNames);

      // চাইলে কয়েকটা sample metric বিস্তারিত দেখাই
      const sample = metrics.slice(0, 3);
      console.log(
        "[/api/health-data] Sample metrics (first 3):",
        JSON.stringify(sample, null, 2).slice(0, 5000)
      );
    } else {
      console.log("[/api/health-data] No metrics found in payload.data.metrics");
    }

    // client-কে simple response দিচ্ছি
    return res.json({
      message: "Health data received (log-only mode).",
      received_user_id: userId || null,
      metrics_count: Array.isArray(metrics) ? metrics.length : 0,
    });
  } catch (err) {
    console.error(
      "[/api/health-data] Unexpected error while logging payload:",
      err
    );
    return res
      .status(500)
      .json({ error: "Server error", details: err.message });
  }
});

// ---------- Health check endpoint (for Render) ----------
app.get("/", (req, res) => {
  res.send("THOR Health API (log-only) is running.");
});

// ---------- Start server (Render uses PORT env) ----------
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`THOR Health API listening on port ${PORT}`);
});

// ⏱️ timeout একটু বাড়িয়ে রাখলাম (৩ মিনিট)
server.setTimeout(180000);
