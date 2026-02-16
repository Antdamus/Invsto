/* =========================================================
   favorites.core.js — OG Jewelers
   Step 1: Favorites storage contract (IDs only)
   ========================================================= */

export const FAVS_STORAGE_KEY = "og_favs_v1";
export const FAVS_VERSION = 1;

function nowMs() {
  return Date.now();
}

function createEmptyFavs(updatedAt = 0) {
  return {
    v: FAVS_VERSION,
    updatedAt: Number.isFinite(updatedAt) ? Math.floor(updatedAt) : 0,
    ids: []
  };
}

function normalizeId(id) {
  if (typeof id !== "string") return "";
  const trimmed = id.trim();
  return trimmed || "";
}

export function normalizeFavs(favs) {
  const source = favs && typeof favs === "object" ? favs : {};
  const rawIds = Array.isArray(source.ids) ? source.ids : [];
  const seen = new Set();
  const ids = [];

  for (const rawId of rawIds) {
    const id = normalizeId(rawId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  const updatedAt = Number.isFinite(source.updatedAt)
    ? Math.max(0, Math.floor(source.updatedAt))
    : 0;

  return {
    v: FAVS_VERSION,
    updatedAt,
    ids
  };
}

export function loadFavs() {
  try {
    const raw = localStorage.getItem(FAVS_STORAGE_KEY);
    if (!raw) return createEmptyFavs();

    const parsed = JSON.parse(raw);
    return normalizeFavs(parsed);
  } catch {
    return createEmptyFavs();
  }
}

export function saveFavs(favs) {
  const normalized = normalizeFavs(favs);

  try {
    localStorage.setItem(FAVS_STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // Gracefully ignore persistence failures (e.g., storage blocked/quota)
  }

  return normalized;
}

export function isFav(id) {
  const normalizedId = normalizeId(id);
  if (!normalizedId) return false;
  return loadFavs().ids.includes(normalizedId);
}

export function getAllIds() {
  return loadFavs().ids.slice();
}

export function addFav(id) {
  const normalizedId = normalizeId(id);
  const favs = loadFavs();

  if (!normalizedId || favs.ids.includes(normalizedId)) {
    return favs;
  }

  const next = {
    ...favs,
    updatedAt: nowMs(),
    ids: [...favs.ids, normalizedId]
  };

  return saveFavs(next);
}

export function removeFav(id) {
  const normalizedId = normalizeId(id);
  const favs = loadFavs();

  if (!normalizedId) return favs;

  const next = {
    ...favs,
    updatedAt: nowMs(),
    ids: favs.ids.filter((favId) => favId !== normalizedId)
  };

  return saveFavs(next);
}

export function toggleFav(id) {
  const normalizedId = normalizeId(id);
  if (!normalizedId) return loadFavs();

  return isFav(normalizedId) ? removeFav(normalizedId) : addFav(normalizedId);
}
