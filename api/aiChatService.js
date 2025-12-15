// api/aiChatService.js
const supabase = require("./supabaseClient");

/* -------------------- helpers -------------------- */

function formatMinutes(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `${h}h ${String(r).padStart(2, "0")}m`;
}

/* -------------------- fetch user data -------------------- */

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
    .select("role, content")
    .eq("user_id", userId)
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

/* -------------------- prompt building -------------------- */

function buildDataContext({ daily, weekly }) {
  const lines = [];

  lines.push("You are THOR AI Assistant.");
  lines.push("You must ONLY use the current user's data below.");
  lines.push("If data is missing, say 'Awaiting sync'.");

  if (daily) {
    lines.push("");
    lines.push(`Latest daily summary (${daily.date}):`);
    lines.push(`- Sleep: ${formatMinutes(daily.sleep_duration_minutes)}`);
    lines.push(`  Deep: ${daily.sleep_deep_minutes || 0}m`);
    lines.push(`  REM: ${daily.sleep_rem_minutes || 0}m`);
    lines.push(`  Core: ${daily.sleep_core_minutes || 0}m`);
    lines.push(`  Awake: ${daily.sleep_awake_minutes || 0}m`);
    lines.push(`- HRV (ms): ${daily.hrv ?? "Awaiting sync"}`);
    lines.push(`- Resting HR (bpm): ${daily.resting_hr ?? "Awaiting sync"}`);
    lines.push(`- Steps: ${daily.steps ?? 0}`);
    lines.push(`- Active calories: ${daily.active_calories ?? 0}`);
  } else {
    lines.push("");
    lines.push("No daily summary available yet.");
  }

  if (weekly) {
    lines.push("");
    lines.push(`Weekly report (${weekly.week_start} → ${weekly.week_end})`);
    lines.push(`Status: ${weekly.status || "ok"}`);
    lines.push(`Summary: ${weekly.summary || "Awaiting sync"}`);

    if (Array.isArray(weekly.trends)) {
      lines.push("Trends:");
      weekly.trends.forEach((t) => lines.push(`- ${t}`));
    }

    if (Array.isArray(weekly.action_items)) {
      lines.push("Action items:");
      weekly.action_items.forEach((a) => lines.push(`- ${a}`));
    }
  }

  lines.push("");
  lines.push("Rules:");
  lines.push("- Be concise, practical, and supportive.");
  lines.push("- Do NOT give medical diagnosis.");
  lines.push("- Never reference other users.");

  return lines.join("\n");
}

function buildMessages({ dataContext, history, userMessage }) {
  const messages = [];

  messages.push({
    role: "system",
    content: dataContext,
  });

  for (const h of history) {
    messages.push({
      role: h.role,
      content: h.content,
    });
  }

  messages.push({
    role: "user",
    content: userMessage,
  });

  return messages;
}

/* -------------------- OpenAI HTTPS call -------------------- */

async function callOpenAI({ messages }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: messages,
      temperature: 0.3,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI error: ${res.status} ${errText}`);
  }

  const json = await res.json();

  const text =
    json.output_text ||
    json.output?.flatMap(o =>
      o.content?.map(c => c.text).filter(Boolean)
    ).join("\n") ||
    "Sorry, I couldn’t generate a response.";

  return { reply: text, openai_response_id: json.id || null };
}

/* -------------------- public API -------------------- */

async function generateAssistantReply({ userId, sessionId, userMessage }) {
  const [daily, weekly, history] = await Promise.all([
    fetchLatestDailySummary(userId),
    fetchLatestWeeklyReport(userId),
    fetchRecentMessages(userId, sessionId, 20),
  ]);

  const dataContext = buildDataContext({ daily, weekly });
  const messages = buildMessages({ dataContext, history, userMessage });

  return await callOpenAI({ messages });
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
