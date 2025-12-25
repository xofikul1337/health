// api/aiChatRoutes.js
const express = require("express");
const supabase = require("./supabaseClient");
const {
  generateAssistantReply,
  createSession,
  saveMessage,
} = require("./aiChatService");

const router = express.Router();

/**
 * Optional security: require THOR_API_KEY
 * If you don't set THOR_API_KEY, it won't block (but it's less secure).
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

// Create a new session
// POST /api/chat/session  { uid, title? }
router.post("/session", async (req, res) => {
  try {
    const userId = req.body?.uid;
    const title = req.body?.title;

    if (!userId) return res.status(400).json({ error: "Missing uid" });

    const session = await createSession({ userId, title });
    return res.json({ session });
  } catch (e) {
    console.error("[chat] create session error:", e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
});

// Get history
// GET /api/chat/history?uid=...&session_id=...&limit=50
router.get("/history", async (req, res) => {
  try {
    const userId = req.query.uid;
    const sessionId = req.query.session_id;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));

    if (!userId || !sessionId) {
      return res.status(400).json({ error: "Missing uid or session_id" });
    }

    const { data, error } = await supabase
      .from("chat_messages")
      .select("id, role, content, created_at, meta")
      .eq("user_id", userId)
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) throw error;
    return res.json({ session_id: sessionId, messages: data || [] });
  } catch (e) {
    console.error("[chat] history error:", e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
});

// Send a message and get assistant reply
// POST /api/chat/message  { uid, session_id?, message }
router.post("/message", async (req, res) => {
  try {
    const userId = req.body?.uid;
    let sessionId = req.body?.session_id;
    const userMessage = req.body?.message;

    if (!userId) return res.status(400).json({ error: "Missing uid" });
    if (!userMessage || !String(userMessage).trim()) {
      return res.status(400).json({ error: "Missing message" });
    }

    // If no session_id provided, auto-create one
    if (!sessionId) {
      const session = await createSession({ userId, title: "Open Chat" });
      sessionId = session.id;
    }

    // Save user message
    await saveMessage({
      userId,
      sessionId,
      role: "user",
      content: String(userMessage),
      meta: {},
    });

    // Generate assistant reply using ONLY this user's data + this session history
    const { reply, openai_response_id } = await generateAssistantReply({
      userId,
      sessionId,
      userMessage: String(userMessage),
    });

    // Save assistant message
    await saveMessage({
      userId,
      sessionId,
      role: "assistant",
      content: reply,
      meta: { openai_response_id },
    });

    return res.json({ session_id: sessionId, reply });
  } catch (e) {
    console.error("[chat] message error:", e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
});

module.exports = router;
