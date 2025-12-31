const webpush = require("web-push");
const supabase = require("../supabaseClient");

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@thor.app";

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.warn("[push] Missing VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY");
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

async function saveSubscription({ userId, subscription, userAgent }) {
  const endpoint = subscription?.endpoint;
  const p256dh = subscription?.keys?.p256dh;
  const auth = subscription?.keys?.auth;
  if (!endpoint || !p256dh || !auth) throw new Error("Invalid subscription payload");

  const { error } = await supabase
    .from("push_subscriptions")
    .upsert(
      {
        user_id: userId,
        endpoint,
        p256dh,
        auth,
        user_agent: userAgent || null,
        last_seen: new Date().toISOString(),
      },
      { onConflict: "user_id,endpoint" }
    );

  if (error) throw error;
}

async function removeSubscription({ userId, endpoint }) {
  const { error } = await supabase
    .from("push_subscriptions")
    .delete()
    .eq("user_id", userId)
    .eq("endpoint", endpoint);

  if (error) throw error;
}

async function sendPushToUser({ userId, payload }) {
  const { data, error } = await supabase
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth")
    .eq("user_id", userId);

  if (error) throw error;

  const subs = data || [];
  const results = [];

  for (const s of subs) {
    const subscription = {
      endpoint: s.endpoint,
      keys: { p256dh: s.p256dh, auth: s.auth },
    };

    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));
      results.push({ endpoint: s.endpoint, ok: true });
    } catch (err) {
      results.push({ endpoint: s.endpoint, ok: false, error: err?.message });
      if (err?.statusCode === 410 || err?.statusCode === 404) {
        await removeSubscription({ userId, endpoint: s.endpoint });
      }
    }
  }

  return results;
}

module.exports = { saveSubscription, removeSubscription, sendPushToUser };
