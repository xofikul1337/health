const express = require("express");
const { saveSubscription, removeSubscription } = require("./pushService");
const { runReminders } = require("./pushReminders");

const router = express.Router();

function requireApiKey(req, res, next) {
  const expected = process.env.THOR_API_KEY;
  if (!expected) return next();
  const got = req.header("x-thor-api-key");
  if (got !== expected) return res.status(401).json({ error: "Unauthorized" });
  next();
}

router.use(requireApiKey);

// subscribe
router.post("/subscribe", async (req, res) => {
  try {
    const userId = req.body?.uid;
    const subscription = req.body?.subscription;
    const userAgent = req.body?.user_agent;

    if (!userId || !subscription) {
      return res.status(400).json({ error: "Missing uid or subscription" });
    }

    await saveSubscription({ userId, subscription, userAgent });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: e.message });
  }
});

// unsubscribe
router.post("/unsubscribe", async (req, res) => {
  try {
    const userId = req.body?.uid;
    const endpoint = req.body?.endpoint;

    if (!userId || !endpoint) {
      return res.status(400).json({ error: "Missing uid or endpoint" });
    }

    await removeSubscription({ userId, endpoint });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: e.message });
  }
});

// run cron reminders
router.post("/run-reminders", async (req, res) => {
  try {
    const dryRun = !!req.body?.dryRun;
    const result = await runReminders({ dryRun });
    return res.json({ ok: true, result });
  } catch (e) {
    return res.status(500).json({ error: "Server error", details: e.message });
  }
});

module.exports = router;
