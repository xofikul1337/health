// api/aiChatService.js
const supabase = require("./supabaseClient");
const { computeReadiness } = require("./readinessCalc");

/* -------------------- helpers -------------------- */

function formatMinutes(min) {
  const m = Math.max(0, Math.round(Number(min) || 0));
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `${h}h ${String(r).padStart(2, "0")}m`;
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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

async function fetchDailySummaryLastNDays(userId, n = 7) {
  const { data, error } = await supabase
    .from("daily_health_summary")
    .select("*")
    .eq("user_id", userId)
    .order("date", { ascending: false })
    .limit(n);

  if (error) throw error;
  return data || [];
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

async function fetchWeeklyLast2(userId) {
  const { data, error } = await supabase
    .from("weekly_reports")
    .select("*")
    .eq("user_id", userId)
    .order("generated_at", { ascending: false })
    .limit(2);

  if (error) throw error;
  return data || [];
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

/* -------------------- readiness helpers -------------------- */

function computeReadinessSafe(dayRow) {
  try {
    return computeReadiness(dayRow);
  } catch (e) {
    return computeReadiness(null);
  }
}

function avg(arr, mapper) {
  const vals = (arr || [])
    .map(mapper)
    .map(safeNum)
    .filter((x) => Number.isFinite(x));
  if (!vals.length) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

/* -------------------- prompt building -------------------- */

function buildDataContext({ daily, weekly, last7, last14, weekly2 }) {
  const lines = [];

  lines.push("You are THOR AI Assistant.");
  lines.push("You must ONLY use the current user's data below.");
  lines.push("If data is missing, say 'Awaiting sync' and explain exactly what is missing.");
  lines.push(
    "For explanations, speak in hypotheses (not certainty). Do NOT give medical diagnosis."
  );

  // ---- Readiness today (computed from daily row)
  const readinessToday = computeReadinessSafe(daily);

  lines.push("");
  lines.push("Readiness (computed from daily_health_summary):");
  lines.push(`- Date: ${readinessToday.date || "Awaiting sync"}`);
  lines.push(`- Total: ${readinessToday.total ?? "Awaiting sync"}`);
  lines.push(`- Status: ${readinessToday.status}`);
  lines.push(`- Recommendation: ${readinessToday.recommendation || "Awaiting sync"}`);

  if (readinessToday?.subscores) {
    lines.push(
      `- Subscores: sleep=${readinessToday.subscores.sleep ?? "—"}, hrv=${readinessToday.subscores.hrv ?? "—"}, rhr=${readinessToday.subscores.resting_hr ?? "—"}, recovery=${readinessToday.subscores.recovery ?? "—"}`
    );
  }
  if (Array.isArray(readinessToday?.missing) && readinessToday.missing.length) {
    lines.push(`- Missing: ${readinessToday.missing.join(", ")}`);
  }
  if (Array.isArray(readinessToday?.tips) && readinessToday.tips.length) {
    lines.push(`- Tips: ${readinessToday.tips.slice(0, 6).join(" | ")}`);
  }

  // ---- Latest daily raw (for deeper reasoning)
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

  // ---- Last 7 days summary (sleep week / HRV week)
  if (Array.isArray(last7) && last7.length) {
    lines.push("");
    lines.push("Last 7 days (most recent first):");
    last7.forEach((d) => {
      const r = computeReadinessSafe(d);
      lines.push(
        `- ${d.date}: sleep ${formatMinutes(d.sleep_duration_minutes)} | HRV ${d.hrv ?? "—"} | RHR ${d.resting_hr ?? "—"} | steps ${d.steps ?? 0} | readiness ${r.total ?? "—"}`
      );
    });
  }

  // ---- Weekly reports compare (last 2)
  if (Array.isArray(weekly2) && weekly2.length) {
    lines.push("");
    lines.push("Weekly reports (latest first):");
    weekly2.forEach((w) => {
      lines.push(`- ${w.week_start} → ${w.week_end}: ${w.summary || "Awaiting sync"}`);
      if (Array.isArray(w.trends) && w.trends.length) {
        lines.push(`  Trends: ${w.trends.slice(0, 6).join(" | ")}`);
      }
      if (Array.isArray(w.action_items) && w.action_items.length) {
        lines.push(`  Actions: ${w.action_items.slice(0, 6).join(" | ")}`);
      }
    });
  } else if (weekly) {
    // fallback old behavior
    lines.push("");
    lines.push(`Weekly report (${weekly.week_start} → ${weekly.week_end})`);
    lines.push(`Status: ${weekly.status || "ok"}`);
    lines.push(`Summary: ${weekly.summary || "Awaiting sync"}`);
  }

  // ---- Fallback compare using last14 aggregates (if weekly missing or user asked compare)
  if (Array.isArray(last14) && last14.length >= 10) {
    const recent7 = last14.slice(0, 7);
    const prev7 = last14.slice(7, 14);

    const avgSleepRecent = avg(recent7, (d) => d.sleep_duration_minutes);
    const avgSleepPrev = avg(prev7, (d) => d.sleep_duration_minutes);
    const avgHrvRecent = avg(recent7, (d) => d.hrv);
    const avgHrvPrev = avg(prev7, (d) => d.hrv);
    const avgRhrRecent = avg(recent7, (d) => d.resting_hr);
    const avgRhrPrev = avg(prev7, (d) => d.resting_hr);

    lines.push("");
    lines.push("Week-over-week (computed from daily_health_summary, last 14 days):");
    lines.push(`- Avg sleep (min): this week ${avgSleepRecent ?? "—"} vs last week ${avgSleepPrev ?? "—"}`);
    lines.push(`- Avg HRV (ms): this week ${avgHrvRecent ?? "—"} vs last week ${avgHrvPrev ?? "—"}`);
    lines.push(`- Avg Resting HR (bpm): this week ${avgRhrRecent ?? "—"} vs last week ${avgRhrPrev ?? "—"}`);
  }

  lines.push("");
  lines.push("Rules:");
  lines.push("- Be concise, practical, and supportive.");
  lines.push("- Do NOT give medical diagnosis.");
  lines.push("- For 'Should I train today?', use readiness + sleep + HRV + resting HR + activity load.");
  lines.push("- For HRV questions, use last 7 days trend + sleep + steps/active calories as context.");
  lines.push("- For week comparison, use weekly reports; if missing, use last-14-day computed comparison.");
  lines.push("- Never reference other users.");

  return lines.join("\n");
}

function buildMessages({ dataContext, history, userMessage }) {
  const messages = [];

  messages.push({ role: "system", content: dataContext });

  for (const h of history) {
    messages.push({ role: h.role, content: h.content });
  }

  messages.push({ role: "user", content: userMessage });

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
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: messages,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI error: ${res.status} ${errText}`);
  }

  const json = await res.json();

  const text =
    json.output_text ||
    json.output
      ?.flatMap((o) => o.content?.map((c) => c.text).filter(Boolean))
      .join("\n") ||
    "Sorry, I couldn’t generate a response.";

  return { reply: text, openai_response_id: json.id || null };
}

/* -------------------- public API -------------------- */

async function generateAssistantReply({ userId, sessionId, userMessage }) {
  const [daily, weekly, history, last7, last14, weekly2] = await Promise.all([
    fetchLatestDailySummary(userId),
    fetchLatestWeeklyReport(userId),
    fetchRecentMessages(userId, sessionId, 20),
    fetchDailySummaryLastNDays(userId, 7),
    fetchDailySummaryLastNDays(userId, 14),
    fetchWeeklyLast2(userId),
  ]);

  const dataContext = buildDataContext({ daily, weekly, last7, last14, weekly2 });
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
