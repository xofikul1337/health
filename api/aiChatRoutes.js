// api/aiChatRoutes.js
const express = require("express");
const supabase = require("./supabaseClient");
const requireSupabaseAuth = require("./requireSupabaseAuth");
const { resolveContextAccess } = require("./resolveContextAccess");

const {
  generateAssistantReply,
  createSession,
  saveMessage,
} = require("./aiChatService");

const router = express.Router();

// ✅ AUTH REQUIRED (Supabase access token)
router.use(requireSupabaseAuth);

// Create a new session
// POST /api/chat/session  { title?, context_user_id? }
router.post("/session", async (req, res) => {
  try {
    const viewerUid = req.auth.uid;
    const title = req.body?.title;
    const contextUserId = req.body?.context_user_id || "";

    const access = await resolveContextAccess({ viewerUid, contextUserId });
    if (!access.ok) return res.status(403).json({ error: "Forbidden", reason: access.reason });

    const session = await createSession({ userId: access.dataUid, title });
    return res.json({ session, context: { dataUid: access.dataUid, mode: access.mode } });
  } catch (e) {
    console.error("[chat] create session error:", e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
});

// Get history
// GET /api/chat/history?session_id=...&context_user_id=...&limit=50
router.get("/history", async (req, res) => {
  try {
    const viewerUid = req.auth.uid;
    const sessionId = req.query.session_id;
    const contextUserId = req.query.context_user_id || "";
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));

    if (!sessionId) return res.status(400).json({ error: "Missing session_id" });

    const access = await resolveContextAccess({ viewerUid, contextUserId });
    if (!access.ok) return res.status(403).json({ error: "Forbidden", reason: access.reason });

    const { data, error } = await supabase
      .from("chat_messages")
      .select("id, role, content, created_at, meta")
      .eq("user_id", access.dataUid)
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true })
      .limit(limit);

    if (error) throw error;
    return res.json({ session_id: sessionId, messages: data || [], context: { dataUid: access.dataUid, mode: access.mode } });
  } catch (e) {
    console.error("[chat] history error:", e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
});

// Send message
// POST /api/chat/message  { session_id?, context_user_id?, message }
router.post("/message", async (req, res) => {
  try {
    const viewerUid = req.auth.uid;
    const contextUserId = req.body?.context_user_id || "";
    let sessionId = req.body?.session_id;
    const userMessage = req.body?.message;

    if (!userMessage || !String(userMessage).trim()) {
      return res.status(400).json({ error: "Missing message" });
    }

    const access = await resolveContextAccess({ viewerUid, contextUserId });
    if (!access.ok) return res.status(403).json({ error: "Forbidden", reason: access.reason });

    // If no session_id, create
    if (!sessionId) {
      const session = await createSession({ userId: access.dataUid, title: "Open Chat" });
      sessionId = session.id;
    }

    // Save user msg under dataUid context
    await saveMessage({
      userId: access.dataUid,
      sessionId,
      role: "user",
      content: String(userMessage),
      meta: { viewer_uid: viewerUid }, // optional audit
    });

    const { reply, openai_response_id } = await generateAssistantReply({
      userId: access.dataUid,
      sessionId,
      userMessage: String(userMessage),
    });

    await saveMessage({
      userId: access.dataUid,
      sessionId,
      role: "assistant",
      content: reply,
      meta: { openai_response_id, viewer_uid: viewerUid },
    });

    return res.json({
      session_id: sessionId,
      reply,
      context: { dataUid: access.dataUid, mode: access.mode },
    });
  } catch (e) {
    console.error("[chat] message error:", e);
    return res.status(500).json({ error: "Server error", details: e.message });
  }
});

module.exports = router;
