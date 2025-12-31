const supabase = require("../supabaseClient");
const { sendPushToUser } = require("./pushService");

const WEEK_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function todayDayKey() {
  const todayIndex = new Date().getDay(); // 0=Sun..6=Sat
  return WEEK_DAYS[todayIndex === 0 ? 6 : todayIndex - 1];
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return null;
  const diff = d.getTime() - Date.now();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function uniq(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

async function runReminders({ dryRun = false } = {}) {
  // --- users with active subscriptions
  const { data: subRows, error: subErr } = await supabase
    .from("push_subscriptions")
    .select("user_id");
  if (subErr) throw subErr;

  const userIds = uniq((subRows || []).map((r) => r.user_id));
  if (!userIds.length) return { sent: 0, detail: [] };

  // --- current protocols
  const { data: protocols, error: pErr } = await supabase
    .from("protocols")
    .select("id, user_id")
    .eq("is_current", true)
    .in("user_id", userIds);
  if (pErr) throw pErr;

  const protocolIds = (protocols || []).map((p) => p.id);
  const protocolByUser = {};
  (protocols || []).forEach((p) => (protocolByUser[p.user_id] = p.id));

  // --- compounds with schedule
  let compounds = [];
  if (protocolIds.length) {
    const { data, error } = await supabase
      .from("protocol_compounds")
      .select("protocol_id, compound_name, dose, unit, route, schedule_days")
      .in("protocol_id", protocolIds);
    if (error) throw error;
    compounds = data || [];
  }

  // --- inventory checks
  const { data: invComp, error: invErr } = await supabase
    .from("inventory_compounds")
    .select("user_id, name, quantity, low_stock_threshold, expiration_date")
    .in("user_id", userIds);
  if (invErr) throw invErr;

  const { data: invSupp, error: suppErr } = await supabase
    .from("inventory_supplements")
    .select("user_id, name, servings_per_container, daily_usage, low_stock_days")
    .in("user_id", userIds);
  if (suppErr) throw suppErr;

  // --- peptide expiry
  const { data: peptides, error: pepErr } = await supabase
    .from("peptide_inventory")
    .select("user_id, name, exp_date, vial_mg, used_mcg")
    .in("user_id", userIds);
  if (pepErr) throw pepErr;

  const todayKey = todayDayKey();
  const results = [];

  for (const userId of userIds) {
    const payloads = [];

    // Injection reminders (protocol schedule)
    const pId = protocolByUser[userId];
    if (pId) {
      const todays = compounds.filter(
        (c) => c.protocol_id === pId && (c.schedule_days || []).includes(todayKey)
      );
      if (todays.length) {
        const list = todays
          .map((c) => `${c.compound_name} ${c.dose}${c.unit || ""} (${c.route || "IM"})`)
          .join(", ");
        payloads.push({
          title: "Injection Reminder",
          body: `Today: ${list}`,
          url: "/phase3",
        });
      }
    }

    // Inventory low stock / expiring
    const lowComp = (invComp || []).filter((c) => {
      if (c.user_id !== userId) return false;
      const q = Number(c.quantity || 0);
      const thr = Number(c.low_stock_threshold || 0);
      const expDays = daysUntil(c.expiration_date);
      return q <= thr || (expDays != null && expDays <= 14);
    });
    if (lowComp.length) {
      payloads.push({
        title: "Inventory Alert",
        body: `Low/expiring: ${lowComp.map((c) => c.name).slice(0, 6).join(", ")}`,
        url: "/phase3",
      });
    }

    // Supplements low days
    const lowSupp = (invSupp || []).filter((s) => {
      if (s.user_id !== userId) return false;
      const servings = Number(s.servings_per_container || 0);
      const usage = Number(s.daily_usage || 1);
      const daysRemaining = Math.floor(servings / Math.max(usage, 1));
      const lowDays = Number(s.low_stock_days || 0);
      return daysRemaining <= lowDays;
    });
    if (lowSupp.length) {
      payloads.push({
        title: "Supplement Alert",
        body: `Low supply: ${lowSupp.map((s) => s.name).slice(0, 6).join(", ")}`,
        url: "/phase3",
      });
    }

    // Peptide expiry reminder
    const expPep = (peptides || []).filter((p) => {
      if (p.user_id !== userId) return false;
      const expDays = daysUntil(p.exp_date);
      return expDays != null && expDays <= 7;
    });
    if (expPep.length) {
      payloads.push({
        title: "Peptide Expiry",
        body: `Expiring soon: ${expPep.map((p) => p.name).slice(0, 6).join(", ")}`,
        url: "/phase3",
      });
    }

    if (!payloads.length) continue;

    if (!dryRun) {
      for (const payload of payloads) {
        await sendPushToUser({ userId, payload });
      }
    }

    results.push({ userId, notifications: payloads.length });
  }

  return { sent: results.length, detail: results };
}

module.exports = { runReminders };
