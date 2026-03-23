/* =========================================================
   cart.service.js — OG Jewelers
   Phase 1: Cart service (add/update/remove + rolling 15m lock)
   Depends on: cart.core.js
   ========================================================= */

import {
  loadCart,
  saveCart,
  normalizeCart,
  createPriceLock,
  isPriceLockExpired,
  getCartQuantity
} from "./cart.core.js";

/* -------------------------
   Internal: find line
------------------------- */
function findLine(cart, id) {
  const idx = (cart.items || []).findIndex((x) => x.id === id);
  return { idx, line: idx >= 0 ? cart.items[idx] : null };
}

function clampQty(qty) {
  const n = Math.floor(Number(qty));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/* =========================================================
   Public API
   ========================================================= */

/**
 * Add item (or increment existing) AND start/reset 15-min price lock.
 * @param {string} id - canonical inventory id
 * @param {number} qtyDelta - typically 1
 * @param {number} currentPrice - current inventory price at add time
 * @returns {object} updated cart
 */
export function addToCart(id, qtyDelta = 1, currentPrice) {
  if (!id) throw new Error("addToCart: id required");
  if (typeof currentPrice !== "number" || !Number.isFinite(currentPrice)) {
    throw new Error("addToCart: currentPrice must be a finite number");
  }

  const cart = normalizeCart(loadCart());
  const { idx, line } = findLine(cart, id);

  const delta = Math.floor(Number(qtyDelta));
  const safeDelta = Number.isFinite(delta) ? delta : 1;

  const lock = createPriceLock(currentPrice);

  if (!line) {
    cart.items.push({
      id,
      qty: clampQty(safeDelta),
      ...lock
    });
  } else {
    line.qty = clampQty(line.qty + safeDelta);
    // Reset lock on add (your rule)
    line.price_locked = lock.price_locked;
    line.price_locked_at = lock.price_locked_at;
    line.price_lock_expires_at = lock.price_lock_expires_at;
    cart.items[idx] = line;
  }

  return saveCart(normalizeCart(cart));
}

/**
 * Set absolute quantity (keeps existing lock).
 */
export function setCartQty(id, qty) {
  if (!id) throw new Error("setCartQty: id required");

  const cart = normalizeCart(loadCart());
  const { idx, line } = findLine(cart, id);
  if (!line) return cart; // no-op

  line.qty = clampQty(qty);
  cart.items[idx] = line;

  return saveCart(normalizeCart(cart));
}

/**
 * Remove a line entirely.
 */
export function removeFromCart(id) {
  if (!id) throw new Error("removeFromCart: id required");

  const cart = normalizeCart(loadCart());
  cart.items = (cart.items || []).filter((x) => x.id !== id);

  return saveCart(normalizeCart(cart));
}

/**
 * Read cart (normalized).
 */
export function getCart() {
  return normalizeCart(loadCart());
}

/**
 * Badge count = sum(qty).
 */
export function getCartBadgeCount() {
  return getCartQuantity(getCart());
}

/* =========================================================
   Rolling 15-minute price lock refresh
   ========================================================= */

/**
 * Refresh expired price locks using a resolver.
 * Resolver must return { price:number } for available items, or null/undefined if unavailable.
 *
 * @param {(id:string)=>({price:number}|null|undefined)} resolveItem
 * @returns {{ cart: object, refreshedIds: string[], unavailableIds: string[] }}
 */
export function refreshExpiredPriceLocks(resolveItem) {
  if (typeof resolveItem !== "function") {
    throw new Error("refreshExpiredPriceLocks: resolveItem must be a function");
  }

  const cart = normalizeCart(loadCart());
  const refreshedIds = [];
  const unavailableIds = [];

  for (const line of cart.items) {
    // If lock expired, attempt refresh
    if (isPriceLockExpired(line)) {
      const resolved = resolveItem(line.id);

      if (!resolved || typeof resolved.price !== "number" || !Number.isFinite(resolved.price)) {
        // Don’t crash; mark unavailable for UI later
        unavailableIds.push(line.id);
        continue;
      }

      const lock = createPriceLock(resolved.price);
      line.price_locked = lock.price_locked;
      line.price_locked_at = lock.price_locked_at;
      line.price_lock_expires_at = lock.price_lock_expires_at;
      refreshedIds.push(line.id);
    }
  }

  const saved = saveCart(normalizeCart(cart));
  return { cart: saved, refreshedIds, unavailableIds };
}

/* =========================================================
   Totals helper (excludes unavailable from totals)
   ========================================================= */

/**
 * Compute totals from the cart using the same resolver.
 * - Uses line.price_locked (assumes you called refreshExpiredPriceLocks first if needed)
 * - Excludes unavailable items from totals (your rule)
 *
 * @param {(id:string)=>({exists:boolean}|null|undefined)} resolveExists
 * @returns {{
 *   subtotal:number,
 *   totalQty:number,
 *   unavailableIds:string[],
 *   lineTotals: Record<string, number>
 * }}
 */
export function computeCartTotals(resolveExists) {
  if (typeof resolveExists !== "function") {
    throw new Error("computeCartTotals: resolveExists must be a function");
  }

  const cart = normalizeCart(loadCart());
  const unavailableIds = [];
  const lineTotals = {};

  let subtotal = 0;
  let totalQty = 0;

  for (const line of cart.items) {
    const resolved = resolveExists(line.id);

    const exists =
      resolved && typeof resolved.exists === "boolean"
        ? resolved.exists
        : !!resolved; // allow simple truthy return

    if (!exists) {
      unavailableIds.push(line.id);
      continue; // exclude from totals
    }

    const lt = line.qty * line.price_locked;
    lineTotals[line.id] = lt;

    subtotal += lt;
    totalQty += line.qty;
  }

  // Avoid floating drift: keep as number, format in UI later
  return { subtotal, totalQty, unavailableIds, lineTotals };
}
