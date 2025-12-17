// api/exerciseService.js
const supabase = require("./supabaseClient");

function buildOrFilter(q) {
  // PostgREST .or() string
  // NOTE: arrays (primary_muscles etc) partial-match is tricky without a view.
  // We’ll do strong scalar search via ilike, plus “contains” for arrays if query looks like a single token.
  const escaped = q.replace(/[%_]/g, "\\$&"); // escape % _ for safety-ish
  const like = `*${escaped}*`;

  const scalarParts = [
    `name.ilike.${like}`,
    `force.ilike.${like}`,
    `level.ilike.${like}`,
    `mechanic.ilike.${like}`,
    `equipment.ilike.${like}`,
    `category.ilike.${like}`,
    // If you later add a generated column for arrays, you can include that here too.
  ];

  return scalarParts.join(",");
}

function isSingleToken(q) {
  return !!q && !/\s/.test(q.trim());
}

async function fetchFavoritesMap(userId, exerciseIds) {
  if (!exerciseIds.length) return new Set();

  const { data, error } = await supabase
    .from("exercise_favorites")
    .select("exercise_id")
    .eq("user_id", userId)
    .in("exercise_id", exerciseIds);

  if (error) throw error;
  return new Set((data || []).map((r) => r.exercise_id));
}

function withFavoriteFlag(items, favSet) {
  return items.map((x) => ({
    ...x,
    is_favorite: favSet.has(x.id),
  }));
}

async function listExercises({ userId, page = 1, load = 40, q = "" }) {
  const from = (page - 1) * load;
  const to = from + load - 1;

  let query = supabase
    .from("exercises")
    .select(
      "id,name,force,level,mechanic,equipment,primary_muscles,secondary_muscles,instructions,category,images",
      { count: "exact" }
    );

  if (q) {
    query = query.or(buildOrFilter(q));

    // Optional: array contains exact muscle token
    if (isSingleToken(q)) {
      // Add extra OR by querying again would be heavy; simplest is broaden scalar filter only.
      // If you want exact muscle match too, we can do it by widening the OR string,
      // but PostgREST array operators in .or string are finicky.
      // Practical option: keep scalar OR as above (works great for users).
    }
  }

  query = query.order("name", { ascending: true }).range(from, to);

  const { data, error, count } = await query;
  if (error) throw error;

  const items = data || [];
  const favSet = await fetchFavoritesMap(userId, items.map((x) => x.id));

  return {
    page,
    load,
    total: count ?? items.length,
    items: withFavoriteFlag(items, favSet),
  };
}

async function listFavorites({ userId, page = 1, load = 40, q = "" }) {
  const from = (page - 1) * load;
  const to = from + load - 1;

  // Join favorites -> exercises
  let query = supabase
    .from("exercise_favorites")
    .select(
      "created_at, exercises:exercise_id (id,name,force,level,mechanic,equipment,primary_muscles,secondary_muscles,instructions,category,images)",
      { count: "exact" }
    )
    .eq("user_id", userId);

  // Search inside joined exercise fields
  if (q) {
    const escaped = q.replace(/[%_]/g, "\\$&");
    const like = `*${escaped}*`;
    query = query.or(
      [
        `exercises.name.ilike.${like}`,
        `exercises.force.ilike.${like}`,
        `exercises.level.ilike.${like}`,
        `exercises.mechanic.ilike.${like}`,
        `exercises.equipment.ilike.${like}`,
        `exercises.category.ilike.${like}`,
      ].join(",")
    );
  }

  query = query.order("created_at", { ascending: false }).range(from, to);

  const { data, error, count } = await query;
  if (error) throw error;

  const items = (data || [])
    .map((r) => r.exercises)
    .filter(Boolean)
    .map((ex) => ({ ...ex, is_favorite: true }));

  return {
    page,
    load,
    total: count ?? items.length,
    items,
  };
}

async function addFavorite({ userId, exerciseId }) {
  // idempotent: upsert-like behavior via insert ignoring conflict
  const { error } = await supabase
    .from("exercise_favorites")
    .insert([{ user_id: userId, exercise_id: exerciseId }], { upsert: false });

  // If already exists, PostgREST may throw 409; treat as success
  if (error) {
    // Supabase-js error shape can vary; safe soft handling:
    if (String(error.code) === "23505" || String(error.status) === "409") return;
    throw error;
  }
}

async function removeFavorite({ userId, exerciseId }) {
  const { error } = await supabase
    .from("exercise_favorites")
    .delete()
    .eq("user_id", userId)
    .eq("exercise_id", exerciseId);

  if (error) throw error;
}

module.exports = {
  listExercises,
  listFavorites,
  addFavorite,
  removeFavorite,
};
