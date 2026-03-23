/* =========================================================
   cart.js — OG Jewelers
   FIXED: DOM-safe init (no null addEventListener crashes)
   Phase 2: Cart page (render + qty controls + 15-min rolling lock)
   ========================================================= */

(() => {
  "use strict";

  /* -------------------------
     Config
  ------------------------- */
  const SUPABASE_PROJECT_URL =
    window.SUPABASE_URL || "https://byhytmarmigalvawkedi.supabase.co";
  const CHANNEL = "og_main";
  const STOREFRONT_CATALOG_FN = "storefront-catalog";
  const FALLBACK_IMAGE = "assets/collections/chains.jpg";

  /* -------------------------
     Helpers
  ------------------------- */
  const nowMs = () => Date.now();

  const esc = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  const formatUSD = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return "$0.00";
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v);
  };

  const fmtDuration = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  };

  const fiveMinBucket = () => Math.floor(Date.now() / 300000);
  const getCartService = () => window.ogCartService;

  function getCartSafe() {
    const svc = getCartService();
    if (!svc) return { items: [] };
    try {
      return svc.getCart();
    } catch {
      return { items: [] };
    }
  }

  /* -------------------------
     Inventory hydration (Edge Function)
  ------------------------- */
  const invState = {
    loaded: false,
    map: new Map(),
    lastFetchMs: 0,
  };

  function mapStoreItemToInv(it) {
    const toNum = (x) => {
      const n = Number(x);
      return Number.isFinite(n) ? n : 0;
    };
    return {
      id: String(it.item_type_id),
      name: String(it.title || ""),
      price: toNum(it.display_price),
      image: it.image_url || FALLBACK_IMAGE,
    };
  }

  async function fetchInventoryMap({ force = false } = {}) {
    try {
      if (!force && invState.loaded && invState.map.size) return invState.map;

      const t = fiveMinBucket();
      const url = `${SUPABASE_PROJECT_URL}/functions/v1/${STOREFRONT_CATALOG_FN}?channel=${encodeURIComponent(
        CHANNEL
      )}&t=${t}`;

      const res = await fetch(url, { method: "GET", cache: "no-store" });
      if (!res.ok) throw new Error(`inv_fetch_failed (${res.status})`);

      const data = await res.json().catch(() => ({}));
      const items = Array.isArray(data?.items) ? data.items : [];
      const inv = items.map(mapStoreItemToInv).filter((x) => x.id && x.name);

      invState.map = new Map(inv.map((x) => [x.id, x]));
      invState.loaded = true;
      invState.lastFetchMs = nowMs();
      return invState.map;
    } catch (e) {
      console.error("Inventory load error:", e);
      invState.loaded = false;
      invState.map = invState.map || new Map();
      return invState.map;
    }
  }

  async function refreshPriceLocksFromService() {
    const map = await fetchInventoryMap({ force: true });
    const svc = getCartService();
    if (!svc) return { cart: getCartSafe(), refreshedIds: [], unavailableIds: [] };
    return svc.refreshExpiredPriceLocks((id) => {
      const it = map.get(String(id));
      return it ? { price: Number(it.price) } : null;
    });
  }

  /* -------------------------
     DOM (resolved at init)
  ------------------------- */
  let el = null;

  function resolveDom() {
    const dom = {
      year: document.getElementById("year"),
      banner: document.getElementById("cartBanner"),
      list: document.getElementById("cartList"),
      empty: document.getElementById("cartEmpty"),
      subtotal: document.getElementById("subtotalVal"),
      unavail: document.getElementById("unavailVal"),
      count: document.getElementById("countVal"),
      clearBtn: document.getElementById("clearCartBtn"),
    };

    // Required elements for cart logic
    const missing = [];
    if (!dom.list) missing.push("#cartList");
    if (!dom.empty) missing.push("#cartEmpty");
    if (!dom.subtotal) missing.push("#subtotalVal");
    if (!dom.unavail) missing.push("#unavailVal");
    if (!dom.count) missing.push("#countVal");
    if (!dom.clearBtn) missing.push("#clearCartBtn");

    if (missing.length) {
      console.error(
        "❌ cart.html is missing required elements:",
        missing.join(", "),
        "\nFix cart.html IDs or ensure cart.js is only loaded on cart.html."
      );
      return null;
    }

    return dom;
  }

  /* -------------------------
     Render
  ------------------------- */
  function render(cart) {
    const map = invState.map || new Map();
    const lines = cart.items || [];

    if (!lines.length) {
      el.list.innerHTML = "";
      el.empty.hidden = false;
      el.subtotal.textContent = formatUSD(0);
      el.unavail.textContent = "0";
      el.count.textContent = "0";
      paintBadges();
      return;
    }

    el.empty.hidden = true;

    let subtotal = 0;
    let unavailableCount = 0;
    let totalQty = 0;

    const html = lines
      .map((line) => {
        const it = map.get(String(line.id));
        const isAvailable = !!it;

        if (!isAvailable) unavailableCount += 1;
        else {
          subtotal += line.qty * line.price_locked;
          totalQty += line.qty;
        }

        const expMs = new Date(line.price_lock_expires_at || 0).getTime();
        const remaining = Number.isFinite(expMs) ? expMs - nowMs() : 0;
        const lockText = isAvailable ? `Locked: ${fmtDuration(remaining)}` : `Unavailable`;

        const title = isAvailable ? it.name : `Item no longer available`;
        const img = isAvailable ? it.image : FALLBACK_IMAGE;

        return `
          <article class="cart-line ${isAvailable ? "" : "is-unavailable"}" data-id="${esc(line.id)}">
            <a class="cart-line-media" href="../item.html?id=${encodeURIComponent(String(line.id || ""))}" aria-label="View ${esc(title)}">
              <img src="${esc(img)}" alt="${esc(title)}" loading="lazy" />
            </a>

            <div class="cart-line-body">
              <div class="cart-line-top">
                <a class="cart-line-title" href="../item.html?id=${encodeURIComponent(String(line.id || ""))}">
                  ${esc(title)}
                </a>
                <button class="icon-btn danger" type="button" data-action="remove" aria-label="Remove item">×</button>
              </div>

              <div class="cart-line-meta">
                <span class="pill ${isAvailable ? "pill-gold" : "pill-muted"}" data-ui="lock-pill">
                  ${esc(lockText)}
                </span>
                <span class="price">${formatUSD(line.price_locked)}</span>
              </div>

              <div class="cart-line-actions">
                <div class="qty">
                  <button class="qty-btn" type="button" data-action="dec" ${isAvailable ? "" : "disabled"} aria-label="Decrease quantity">−</button>
                  <input class="qty-input" type="number" min="1" step="1" value="${line.qty}" ${isAvailable ? "" : "disabled"} aria-label="Quantity" />
                  <button class="qty-btn" type="button" data-action="inc" ${isAvailable ? "" : "disabled"} aria-label="Increase quantity">+</button>
                </div>

                <div class="line-subtotal ${isAvailable ? "" : "muted"}">
                  ${isAvailable ? formatUSD(line.qty * line.price_locked) : "Excluded"}
                </div>
              </div>
            </div>
          </article>
        `;
      })
      .join("");

    el.list.innerHTML = html;

    el.subtotal.textContent = formatUSD(subtotal);
    el.unavail.textContent = String(unavailableCount);
    el.count.textContent = String(totalQty);

    paintBadges();
  }

  function paintBadges() {
    try {
      const svc = getCartService();
      const total = svc ? svc.getCartBadgeCount() : 0;
      document.querySelectorAll('[data-ui="cart-count"]').forEach((b) => {
        b.textContent = String(total);
        b.hidden = total <= 0;
      });
    } catch {}
  }

  /* -------------------------
     Events
  ------------------------- */
  function setQtyWithService(id, qty) {
    const svc = getCartService();
    if (!svc) return getCartSafe();
    return svc.setCartQty(id, qty);
  }

  function incrementQtyWithService(id, delta) {
    const svc = getCartService();
    if (!svc) return getCartSafe();
    const cart = svc.getCart();
    const line = (cart.items || []).find((x) => String(x.id) === String(id));
    if (!line) return cart;
    return svc.setCartQty(id, Number(line.qty || 0) + Number(delta || 0));
  }

  function removeLineWithService(id) {
    const svc = getCartService();
    if (!svc) return getCartSafe();
    return svc.removeFromCart(id);
  }

  function clearCartWithService() {
    const svc = getCartService();
    if (!svc) return getCartSafe();
    const ids = (svc.getCart().items || []).map((line) => line.id);
    for (const id of ids) svc.removeFromCart(id);
    return svc.getCart();
  }

  function bindEvents() {
    // Delegated events for cart lines
    el.list.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;

      const row = e.target.closest(".cart-line");
      const id = row?.dataset?.id;
      if (!id) return;

      const action = btn.dataset.action;
      if (action === "remove") {
        const cart = removeLineWithService(id);
        render(cart);
        return;
      }
      if (action === "inc") {
        const cart = incrementQtyWithService(id, +1);
        render(cart);
        return;
      }
      if (action === "dec") {
        const cart = incrementQtyWithService(id, -1);
        render(cart);
        return;
      }
    });

    // Qty input changes
    el.list.addEventListener("change", (e) => {
      const input = e.target.closest(".qty-input");
      if (!input) return;
      const row = e.target.closest(".cart-line");
      const id = row?.dataset?.id;
      if (!id) return;

      const cart = setQtyWithService(id, input.value);
      render(cart);
    });

    // Clear cart
    el.clearBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const cart = clearCartWithService();
      if (el.banner) el.banner.hidden = true;
      render(cart);
    });
  }

  /* -------------------------
     Tick: countdown + auto refresh
  ------------------------- */
  let tickTimer = null;

  function updateCountdownPills(cart) {
    const now = nowMs();
    const rows = el.list.querySelectorAll(".cart-line");
    rows.forEach((row) => {
      const id = row.dataset.id;
      const line = (cart.items || []).find((x) => x.id === id);
      if (!line) return;

      const pill = row.querySelector('[data-ui="lock-pill"]');
      if (!pill) return;

      const it = invState.map.get(String(id));
      if (!it) {
        pill.textContent = "Unavailable";
        pill.classList.add("pill-muted");
        return;
      }

      const expMs = new Date(line.price_lock_expires_at || 0).getTime();
      const remaining = Number.isFinite(expMs) ? expMs - now : 0;
      pill.textContent = `Locked: ${fmtDuration(remaining)}`;
    });
  }

  async function tick() {
    const cart = getCartSafe();
    const anyExpired = (cart.items || []).some((line) => {
      const exp = new Date(line?.price_lock_expires_at || 0).getTime();
      return !Number.isFinite(exp) || exp <= 0 || nowMs() > exp;
    });
    if (anyExpired) {
      const res = await refreshPriceLocksFromService();
      if (res.refreshedIds.length && el.banner) el.banner.hidden = false;
      render(res.cart);
      updateCountdownPills(res.cart);
      return;
    }

    updateCountdownPills(cart);
  }

  /* -------------------------
     Boot
  ------------------------- */
  async function init() {
    el = resolveDom();
    if (!el) return; // <- prevents crash, shows console error

    if (!getCartService()) {
      console.error("❌ window.ogCartService is missing; ensure cart.service.global.js loads first.");
      return;
    }

    if (el.year) el.year.textContent = String(new Date().getFullYear());

    bindEvents();

    await fetchInventoryMap({ force: false });

    const res = await refreshPriceLocksFromService();
    if (res.refreshedIds.length && el.banner) el.banner.hidden = false;

    render(res.cart);

    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(() => tick().catch(() => {}), 1000);
  }

  document.addEventListener("DOMContentLoaded", () => {
    init().catch((e) => console.error("cart init error:", e));
  });
})();
