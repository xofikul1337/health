// api/pushRoutes.js
const express = require("express");
const { saveSubscription, removeSubscription, sendPushToUser } = require("./pushService");

const router = express.Router();

/**
 * Optional security: require THOR_API_KEY
 */
function requireApiKey(req, res, next) {
  const expected = process.env.THOR_API_KEY;
  if (!expected) return next();
  const got = req.header("x-thor-api-key");
  if (got !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

router.use(requireApiKey);

// POST /api/push/subscribe
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
    console.error("[push] subscribe error:", e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
});

// POST /api/push/unsubscribe
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
    console.error("[push] unsubscribe error:", e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
});

// POST /api/push/test  (optional)
router.post("/test", async (req, res) => {
  try {
    const userId = req.body?.uid;
    if (!userId) return res.status(400).json({ error: "Missing uid" });

    const payload = {
      title: "THOR Reminder",
      body: "This is a test notification.",
      url: "/phase3",
    };

    const results = await sendPushToUser({ userId, payload });
    return res.json({ ok: true, results });
  } catch (e) {
    console.error("[push] test error:", e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
});

module.exports = router;
