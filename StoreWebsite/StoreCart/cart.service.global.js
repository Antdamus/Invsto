/* =========================================================
   cart.service.global.js — OG Jewelers
   Browser-static bridge to expose cart.service as a global.
   Depends on: cart.service.js (module)
   ========================================================= */

import {
  addToCart,
  setCartQty,
  removeFromCart,
  getCart,
  getCartBadgeCount,
  refreshExpiredPriceLocks,
  computeCartTotals
} from "./cart.service.js";

window.ogCartService = {
  addToCart,
  setCartQty,
  removeFromCart,
  getCart,
  getCartBadgeCount,
  refreshExpiredPriceLocks,
  computeCartTotals
};
