/* =========================================================
   favorites.service.js — OG Jewelers
   Step 2: Favorites service layer + event emission
   ========================================================= */

import {
  addFav,
  removeFav,
  toggleFav,
  isFav as coreIsFav,
  getAllIds as coreGetAllIds
} from "./favorites.core.js";

function emitChanged() {
  window.dispatchEvent(new CustomEvent("og-favs-changed"));
}

export function toggle(id) {
  const next = toggleFav(id);
  emitChanged();
  return next;
}

export function add(id) {
  const next = addFav(id);
  emitChanged();
  return next;
}

export function remove(id) {
  const next = removeFav(id);
  emitChanged();
  return next;
}

export function isFav(id) {
  return coreIsFav(id);
}

export function getAllIds() {
  return coreGetAllIds();
}

export function syncIfLoggedIn() {}

export function mergeOnLogin() {}
