/* =========================================================
   cart.core.js — OG Jewelers
   Phase 0: Cart contract + storage + invariants
   ========================================================= */

/* -------------------------
   Constants
------------------------- */
export const CART_STORAGE_KEY = "og_cart_v1";
export const CART_VERSION = 1;
export const PRICE_LOCK_MS = 15 * 60 * 1000; // 15 minutes

/* -------------------------
   Cart shape (authoritative)
------------------------- */
/*
Cart = {
  version: number,
  updated_at: ISOString,
  items: CartLine[]
}

CartLine = {
  id: string,
  qty: number,
  price_locked: number,
  price_locked_at: ISOString,
  price_lock_expires_at: ISOString
}
*/

/* -------------------------
   Helpers
------------------------- */
const nowISO = () => new Date().toISOString();
const nowMs = () => Date.now();

const isValidNumber = (n) => typeof n === "number" && Number.isFinite(n);

/* -------------------------
   Create empty cart
------------------------- */
export function createEmptyCart() {
  return {
    version: CART_VERSION,
    updated_at: nowISO(),
    items: []
  };
}

/* -------------------------
   Load cart from storage
------------------------- */
export function loadCart() {
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY);
    if (!raw) return createEmptyCart();

    const parsed = JSON.parse(raw);

    if (!parsed || parsed.version !== CART_VERSION || !Array.isArray(parsed.items)) {
      return createEmptyCart();
    }

    return parsed;
  } catch {
    return createEmptyCart();
  }
}

/* -------------------------
   Save cart to storage
------------------------- */
export function saveCart(cart) {
  const safeCart = {
    version: CART_VERSION,
    updated_at: nowISO(),
    items: Array.isArray(cart.items) ? cart.items : []
  };

  localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(safeCart));
  return safeCart;
}

/* -------------------------
   Create price lock
------------------------- */
export function createPriceLock(price) {
  if (!isValidNumber(price)) {
    throw new Error("Invalid price for price lock");
  }

  const lockedAtMs = nowMs();

  return {
    price_locked: price,
    price_locked_at: new Date(lockedAtMs).toISOString(),
    price_lock_expires_at: new Date(lockedAtMs + PRICE_LOCK_MS).toISOString()
  };
}

/* -------------------------
   Price lock status
------------------------- */
export function isPriceLockExpired(cartLine) {
  if (!cartLine?.price_lock_expires_at) return true;
  return nowMs() > new Date(cartLine.price_lock_expires_at).getTime();
}

/* -------------------------
   Cart invariants enforcement
------------------------- */
export function normalizeCart(cart) {
  const seen = new Set();
  const normalizedItems = [];

  for (const line of cart.items || []) {
    if (!line?.id || seen.has(line.id)) continue;
    if (!isValidNumber(line.qty) || line.qty < 1) continue;
    if (!isValidNumber(line.price_locked)) continue;

    seen.add(line.id);
    normalizedItems.push({
      id: line.id,
      qty: Math.floor(line.qty),
      price_locked: line.price_locked,
      price_locked_at: line.price_locked_at,
      price_lock_expires_at: line.price_lock_expires_at
    });
  }

  return {
    version: CART_VERSION,
    updated_at: nowISO(),
    items: normalizedItems
  };
}

/* -------------------------
   Cart badge count
------------------------- */
export function getCartQuantity(cart) {
  return (cart.items || []).reduce((sum, line) => sum + line.qty, 0);
}

/* -------------------------
   Hard reset (debug / future use)
------------------------- */
export function clearCart() {
  localStorage.removeItem(CART_STORAGE_KEY);
  return createEmptyCart();
}
