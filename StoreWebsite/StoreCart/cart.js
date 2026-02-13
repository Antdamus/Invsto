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
  const CART_STORAGE_KEY = "og_cart_v1";
  const CART_VERSION = 1;
  const PRICE_LOCK_MS = 15 * 60 * 1000;

  const SUPABASE_PROJECT_URL =
    window.SUPABASE_URL || "https://byhytmarmigalvawkedi.supabase.co";
  const CHANNEL = "og_main";
  const STOREFRONT_CATALOG_FN = "storefront-catalog";
  const FALLBACK_IMAGE = "assets/collections/chains.jpg";

  /* -------------------------
     Helpers
  ------------------------- */
  const nowMs = () => Date.now();
  const iso = (ms) => new Date(ms).toISOString();

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

  /* -------------------------
     Cart core (local)
  ------------------------- */
  function createEmptyCart() {
    return { version: CART_VERSION, updated_at: new Date().toISOString(), items: [] };
  }

  function normalizeCart(cart) {
    const items = Array.isArray(cart?.items) ? cart.items : [];
    const seen = new Set();
    const out = [];

    for (const line of items) {
      if (!line || !line.id) continue;
      const id = String(line.id);
      if (seen.has(id)) continue;

      const qty = Math.floor(Number(line.qty));
      const price = Number(line.price_locked);

      if (!Number.isFinite(qty) || qty < 1) continue;
      if (!Number.isFinite(price)) continue;

      seen.add(id);
      out.push({
        id,
        qty,
        price_locked: price,
        price_locked_at: String(line.price_locked_at || ""),
        price_lock_expires_at: String(line.price_lock_expires_at || ""),
      });
    }

    return {
      version: CART_VERSION,
      updated_at: String(cart?.updated_at || new Date().toISOString()),
      items: out,
    };
  }

  function loadCart() {
    try {
      const raw = localStorage.getItem(CART_STORAGE_KEY);
      if (!raw) return createEmptyCart();
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== CART_VERSION || !Array.isArray(parsed.items)) {
        return createEmptyCart();
      }
      return normalizeCart(parsed);
    } catch {
      return createEmptyCart();
    }
  }

  function saveCart(cart) {
    const safe = normalizeCart(cart);
    safe.updated_at = new Date().toISOString();
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(safe));
    return safe;
  }

  function createPriceLock(price) {
    const p = Number(price);
    if (!Number.isFinite(p)) throw new Error("Invalid price for lock");
    const t0 = nowMs();
    return {
      price_locked: p,
      price_locked_at: iso(t0),
      price_lock_expires_at: iso(t0 + PRICE_LOCK_MS),
    };
  }

  function isLockExpired(line) {
    const exp = new Date(line?.price_lock_expires_at || 0).getTime();
    if (!Number.isFinite(exp) || exp <= 0) return true;
    return nowMs() > exp;
  }

  function cartQtySum(cart) {
    return (cart.items || []).reduce((s, x) => s + (x.qty || 0), 0);
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

  async function refreshExpiredLocks(cart) {
    const expiredIds = (cart.items || []).filter(isLockExpired).map((x) => x.id);
    if (!expiredIds.length) return { cart, refreshed: [], unavailable: [] };

    const map = await fetchInventoryMap({ force: true });

    const refreshed = [];
    const unavailable = [];

    for (const line of cart.items) {
      if (!isLockExpired(line)) continue;

      const it = map.get(String(line.id));
      if (!it) {
        unavailable.push(line.id);
        continue;
      }

      const lock = createPriceLock(it.price);
      line.price_locked = lock.price_locked;
      line.price_locked_at = lock.price_locked_at;
      line.price_lock_expires_at = lock.price_lock_expires_at;
      refreshed.push(line.id);
    }

    const saved = saveCart(cart);
    return { cart: saved, refreshed, unavailable };
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
      paintBadges(cart);
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

    paintBadges(cart);
  }

  function paintBadges(cart) {
    try {
      const total = cartQtySum(cart);
      document.querySelectorAll('[data-ui="cart-count"]').forEach((b) => {
        b.textContent = String(total);
        b.hidden = total <= 0;
      });
    } catch {}
  }

  /* -------------------------
     Events
  ------------------------- */
  function findLine(cart, id) {
    const idx = cart.items.findIndex((x) => x.id === id);
    return { idx, line: idx >= 0 ? cart.items[idx] : null };
  }

  function setQty(cart, id, qty) {
    const { idx, line } = findLine(cart, id);
    if (!line) return cart;
    const q = Math.max(1, Math.floor(Number(qty) || 1));
    line.qty = q;
    cart.items[idx] = line;
    return saveCart(cart);
  }

  function incQty(cart, id, delta) {
    const { idx, line } = findLine(cart, id);
    if (!line) return cart;
    line.qty = Math.max(1, Math.floor((line.qty || 1) + delta));
    cart.items[idx] = line;
    return saveCart(cart);
  }

  function removeLine(cart, id) {
    cart.items = cart.items.filter((x) => x.id !== id);
    return saveCart(cart);
  }

  function clearCart() {
    localStorage.removeItem(CART_STORAGE_KEY);
    return createEmptyCart();
  }

  function bindEvents() {
    // Delegated events for cart lines
    el.list.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;

      const row = e.target.closest(".cart-line");
      const id = row?.dataset?.id;
      if (!id) return;

      let cart = loadCart();

      const action = btn.dataset.action;
      if (action === "remove") {
        cart = removeLine(cart, id);
        render(cart);
        return;
      }
      if (action === "inc") {
        cart = incQty(cart, id, +1);
        render(cart);
        return;
      }
      if (action === "dec") {
        cart = incQty(cart, id, -1);
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

      let cart = loadCart();
      cart = setQty(cart, id, input.value);
      render(cart);
    });

    // Clear cart
    el.clearBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const cart = clearCart();
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
    const cart = loadCart();

    const anyExpired = (cart.items || []).some(isLockExpired);
    if (anyExpired) {
      const res = await refreshExpiredLocks(cart);
      if (res.refreshed.length && el.banner) el.banner.hidden = false;
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

    if (el.year) el.year.textContent = String(new Date().getFullYear());

    bindEvents();

    await fetchInventoryMap({ force: false });

    let cart = loadCart();
    const res = await refreshExpiredLocks(cart);
    if (res.refreshed.length && el.banner) el.banner.hidden = false;

    render(res.cart);

    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(() => tick().catch(() => {}), 1000);
  }

  document.addEventListener("DOMContentLoaded", () => {
    init().catch((e) => console.error("cart init error:", e));
  });
})();
