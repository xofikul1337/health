// api/resolveContextAccess.js
const supabase = require("./supabaseClient");

async function resolveContextAccess({ viewerUid, contextUserId }) {
  if (!viewerUid) throw new Error("Missing viewerUid");

  const target = contextUserId || viewerUid;

  // Self context always ok
  if (target === viewerUid) {
    return { ok: true, dataUid: target, mode: "owner" };
  }

  // Member -> must have Active membership under that owner
  const { data, error } = await supabase
    .from("team_members")
    .select("owner_id, member_user_id, status, permissions, role")
    .eq("owner_id", target)
    .eq("member_user_id", viewerUid)
    .eq("status", "Active")
    .limit(1);

  if (error) throw error;

  const row = data?.[0];
  if (!row) {
    return { ok: false, reason: "Not a member of this owner" };
  }

  const perms = row.permissions || {};
  if (!perms.ai_coach) {
    return { ok: false, reason: "AI Coach disabled for this member context" };
  }

  return { ok: true, dataUid: target, mode: "member", permissions: perms };
}

module.exports = { resolveContextAccess };
