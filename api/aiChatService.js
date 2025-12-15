// api/aiChatService.js
const supabase = require("./supabaseClient");

/**
 * Dynamic import so this works in CommonJS projects too.
 * Official pattern is openai.responses.create({...})
 */
let _openaiClient = null;
async function getOpenAI() {
  if (_openaiClient) return _openaiClient;
  const mod = await import("openai");
  const OpenAI = mod.default;
  _openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openaiClient;
}

function formatMinutes(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `${h}h ${String(r).padStart(2, "0")}m`;
}

async function fetchLatestDailySummary(userId) {
  const { data, error } = await supabase
    .from("daily_health_summary")
    .select("*")
    .eq("user_id", userId)
    .order("date", { ascending: false })
    .limit(1);

  if (error) throw error;
  return data?.[0] || null;
}

async function fetchLatestWeeklyReport(userId) {
  const { data, error } = await supabase
    .from("weekly_reports")
    .select("*")
    .eq("user_id", userId)
    .order("generated_at", { ascending: false })
    .limit(1);

  if (error) throw error;
  return data?.[0] || null;
}

async function fetchRecentMessages(userId, sessionId, limit = 20) {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("role, content, created_at")
    .eq("user_id", userId)
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

function buildDataContext({ daily, weekly }) {
  const lines = [];

  lines.push("You are THOR AI Assistant.");
  lines.push("You must only use the current user's data shown below. If something is missing, say 'Awaiting sync'.");

  if (daily) {
    lines.push("");
    lines.push(`Latest daily summary date: ${daily.date}`);
    lines.push(`- Readiness inputs:`);
    lines.push(`  - Sleep: ${formatMinutes(daily.sleep_duration_minutes)} (deep ${Math.round(daily.sleep_deep_minutes || 0)}m, rem ${Math.round(daily.sleep_rem_minutes || 0)}m, core ${Math.round(daily.sleep_core_minutes || 0)}m, awake ${Math.round(daily.sleep_awake_minutes || 0)}m)`);
    lines.push(`  - HRV (ms): ${daily.hrv ?? "Awaiting sync"}`);
    lines.push(`  - Resting HR (bpm): ${daily.resting_hr ?? "Awaiting sync"}`);
    lines.push(`  - Steps: ${daily.steps ?? 0}`);
    lines.push(`  - Active calories: ${daily.active_calories ?? 0}`);
  } else {
    lines.push("");
    lines.push("No daily summary found yet for this user.");
  }

  if (weekly) {
    lines.push("");
    lines.push(`Latest weekly report: ${weekly.week_start} → ${weekly.week_end} (status: ${weekly.status || "ok"})`);
    lines.push(`- Summary: ${weekly.summary || "Awaiting sync"}`);
    if (Array.isArray(weekly.trends) && weekly.trends.length) {
      lines.push(`- Trends:`);
      weekly.trends.slice(0, 6).forEach((t) => lines.push(`  - ${t}`));
    }
    if (Array.isArray(weekly.action_items) && weekly.action_items.length) {
      lines.push(`- Action items:`);
      weekly.action_items.slice(0, 6).forEach((a) => lines.push(`  - ${a}`));
    }
  }

  lines.push("");
  lines.push("Behavior rules:");
  lines.push("- Be concise but practical.");
  lines.push("- If user asks for medical diagnosis, provide general info + advise professional help.");
  lines.push("- If asked about other users or global database, refuse.");

  return lines.join("\n");
}

function buildPrompt({ dataContext, history, userMessage }) {
  const transcript = [];

  transcript.push("=== SYSTEM CONTEXT ===");
  transcript.push(dataContext);
  transcript.push("");

  transcript.push("=== CHAT HISTORY (most recent) ===");
  if (!history.length) {
    transcript.push("(no prior messages)");
  } else {
    for (const m of history) {
      transcript.push(`${m.role.toUpperCase()}: ${m.content}`);
    }
  }
  transcript.push("");

  transcript.push("=== USER MESSAGE ===");
  transcript.push(userMessage);

  transcript.push("");
  transcript.push("=== INSTRUCTIONS ===");
  transcript.push("Answer as THOR AI Assistant. Use the user's data context. If data is missing, explicitly say it's awaiting sync.");
  return transcript.join("\n");
}

async function generateAssistantReply({ userId, sessionId, userMessage }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const [daily, weekly, history] = await Promise.all([
    fetchLatestDailySummary(userId),
    fetchLatestWeeklyReport(userId),
    fetchRecentMessages(userId, sessionId, 20),
  ]);

  const dataContext = buildDataContext({ daily, weekly });
  const prompt = buildPrompt({ dataContext, history, userMessage });

  const model = process.env.OPENAI_MODEL || "gpt-5.2";
  const reasoningEffort = process.env.OPENAI_REASONING_EFFORT || "none";
  const verbosity = process.env.OPENAI_VERBOSITY || "low";

  const openai = await getOpenAI();

  const resp = await openai.responses.create({
    model,
    input: prompt,
    reasoning: { effort: reasoningEffort },
    verbosity,
  });

  // Safely extract text
  const text =
    resp.output_text ||
    resp.output?.map((o) => o?.content?.map((c) => c?.text).join("")).join("\n") ||
    "Sorry—no response text.";

  return { reply: text, openai_response_id: resp.id || null };
}

async function createSession({ userId, title }) {
  const { data, error } = await supabase
    .from("chat_sessions")
    .insert([{ user_id: userId, title: title || "Open Chat" }])
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function saveMessage({ userId, sessionId, role, content, meta }) {
  const { error } = await supabase.from("chat_messages").insert([
    {
      user_id: userId,
      session_id: sessionId,
      role,
      content,
      meta: meta || {},
    },
  ]);
  if (error) throw error;

  // touch session last_message_at
  await supabase
    .from("chat_sessions")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", sessionId)
    .eq("user_id", userId);
}

module.exports = {
  generateAssistantReply,
  createSession,
  saveMessage,
};
