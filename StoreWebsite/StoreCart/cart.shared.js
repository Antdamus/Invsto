/* =========================================================
   cart.shared.js — OG Jewelers
   Shared: cart badge updater (reads localStorage og_cart_v1)
   Safe to include on any page (index, catalogue, cart)
   ========================================================= */

(() => {
  "use strict";

  const CART_STORAGE_KEY = "og_cart_v1";
  const CART_VERSION = 1;

  const readCartQty = () => {
    try {
      const raw = localStorage.getItem(CART_STORAGE_KEY);
      if (!raw) return 0;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== CART_VERSION || !Array.isArray(parsed.items)) return 0;
      return parsed.items.reduce((sum, line) => sum + (Number(line?.qty) || 0), 0);
    } catch {
      return 0;
    }
  };

  const paintBadges = () => {
    const total = readCartQty();
    document.querySelectorAll('[data-ui="cart-count"]').forEach((b) => {
      b.textContent = String(total);
      b.hidden = total <= 0;
    });
  };

  // Initial paint
  document.addEventListener("DOMContentLoaded", paintBadges);

  // Update across tabs/windows
  window.addEventListener("storage", (e) => {
    if (e.key === CART_STORAGE_KEY) paintBadges();
  });

  // Optional: allow other scripts to trigger manual refresh
  window.ogCartBadgeRefresh = paintBadges;
})();
