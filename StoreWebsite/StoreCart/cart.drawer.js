/* =========================================================
   cart.drawer.js — OG Jewelers
   Toggleable drawer (open/close) + mini-cart rendering
   Phase 6B: public open API + reacts to og-cart-changed
   ========================================================= */

(() => {
  "use strict";

  const CART_KEY = "og_cart_v1";

  // Hydration config: set in HTML before this script loads
  const CFG = window.OG_CART_DRAWER_CFG || {};
  const SUPABASE_URL = String(CFG.supabaseUrl || "");
  const CHANNEL = String(CFG.channel || "og_main");
  const FN = String(CFG.fn || "storefront-catalog");

  const $ = (sel, root = document) => root.querySelector(sel);

  const toPriceNumber = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    const s = String(v ?? "").trim();
    const cleaned = s.replace(/[^0-9.]/g, "");
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  };

  const money = (n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return "$0.00";
    return `$${x.toFixed(2)}`;
  };

  // Product details page link (item.html sits in the site root)
  const itemHrefFor = (id) => {
    const inStoreCart = window.location.pathname.includes("/StoreCart/");
    const base = inStoreCart ? "../item.html" : "item.html";
    const href = `${base}?id=${encodeURIComponent(String(id || ""))}`;
    try {
      return new URL(href, window.location.href).href;
    } catch {
      return href;
    }
  };

  const getCartService = () => window.ogCartService;
  const getCartSafe = () => {
    const svc = getCartService();
    if (!svc) return { items: [] };
    try {
      return svc.getCart();
    } catch {
      return { items: [] };
    }
  };

  const emitCartChanged = () => {
    window.ogCartBadgeRefresh?.();
    window.dispatchEvent(new Event("og-cart-changed"));
  };

  const clampQty = (q) => {
    const n = Math.floor(Number(q));
    return Number.isFinite(n) && n >= 1 ? n : 1;
  };

  const formatCountdown = (expiresAtIso) => {
    if (!expiresAtIso) return null;
    const t = new Date(expiresAtIso).getTime();
    if (!Number.isFinite(t)) return null;
    const ms = t - Date.now();
    if (ms <= 0) return "0:00";
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  };

  // -------------------------
  // DOM refs (drawer markup must exist)
  // -------------------------
  function refs() {
    return {
      backdrop: $('[data-ui="cart-drawer-backdrop"]'),
      drawer: $('[data-ui="cart-drawer"]'),
      list: $('[data-ui="cart-drawer-list"]'),
      empty: $('[data-ui="cart-drawer-empty"]'),
      subtotal: $('[data-ui="cart-drawer-subtotal"]'),
      count: $('[data-ui="cart-drawer-count"]'),
      notice: $('[data-ui="cart-drawer-notice"]'),
    };
  }

  function setOpen(open) {
    const r = refs();
    if (!r.backdrop || !r.drawer) return;

    if (open) {
      r.backdrop.hidden = false;
      r.drawer.hidden = false;

      requestAnimationFrame(() => {
        r.backdrop.classList.add("is-open");
        r.drawer.classList.add("is-open");
      });

      r.drawer.setAttribute("aria-hidden", "false");
      document.documentElement.classList.add("cd-lock");
      document.body.classList.add("cd-lock");
    } else {
      r.backdrop.classList.remove("is-open");
      r.drawer.classList.remove("is-open");
      r.drawer.setAttribute("aria-hidden", "true");
      document.documentElement.classList.remove("cd-lock");
      document.body.classList.remove("cd-lock");

      window.setTimeout(() => {
        r.backdrop.hidden = true;
        r.drawer.hidden = true;
      }, 220);
    }
  }

  function isOpen() {
    const r = refs();
    return !!r.drawer && r.drawer.classList.contains("is-open");
  }

  // -------------------------
  // Inventory hydration (best-effort)
  // -------------------------
  let invMap = new Map();
  let invLast = 0;

  function pickDesc(it) {
    return String(
      it?.description ||
      it?.subtitle ||
      it?.blurb ||
      it?.short_description ||
      it?.details ||
      it?.summary ||
      ""
    );
  }

  async function hydrateInventory(force = false) {
    if (!SUPABASE_URL) return;

    // refresh cache max every 5 minutes
    if (!force && Date.now() - invLast < 5 * 60 * 1000 && invMap.size) return;

    const url =
      `${SUPABASE_URL}/functions/v1/${encodeURIComponent(FN)}` +
      `?channel=${encodeURIComponent(CHANNEL)}` +
      `&t=${Math.floor(Date.now() / 300000)}`;

    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`inventory fetch failed ${res.status}`);
    const data = await res.json();

    const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];

    const map = new Map();
    for (const it of list) {
      const id = String(it?.item_type_id || it?.id || "");
      if (!id) continue;

      map.set(id, {
        title: String(it?.title || it?.name || "Item"),
        image: String(it?.image_url || it?.image || ""),
        desc: pickDesc(it),
        price: toPriceNumber(it?.sale_price ?? it?.price ?? it?.unit_price ?? it?.price_usd ?? it?.display_price ?? it?.amount),
      });
    }

    invMap = map;
    invLast = Date.now();
  }

  // -------------------------
  // Render
  // -------------------------
  function computeSubtotal(items) {
    return (items || []).reduce((sum, line) => {
      const q = Number(line?.qty) || 0;
      const p = Number(line?.price_locked) || 0;
      return sum + q * p;
    }, 0);
  }


  async function refreshExpiredLocksWithService() {
    const svc = getCartService();
    if (!svc) return { changed: false, cart: getCartSafe(), refreshedIds: [] };

    try { await hydrateInventory(true); } catch { /* ignore */ }

    const res = svc.refreshExpiredPriceLocks((id) => {
      const meta = invMap.get(String(id));
      const p = Number(meta?.price);
      if (!Number.isFinite(p) || p <= 0) return null;
      return { price: p };
    });

    if (Array.isArray(res?.refreshedIds) && res.refreshedIds.length) {
      emitCartChanged();
    }

    return {
      changed: Array.isArray(res?.refreshedIds) && res.refreshedIds.length > 0,
      cart: res?.cart || getCartSafe(),
      refreshedIds: Array.isArray(res?.refreshedIds) ? res.refreshedIds : [],
    };
  }

  function showNotice(msg) {
    const r = refs();
    if (!r.notice) return;
    r.notice.textContent = msg;
    r.notice.hidden = false;
    window.setTimeout(() => {
      // only hide if drawer still open
      if (isOpen()) r.notice.hidden = true;
    }, 2400);
  }

  function updateCountdownInPlace() {
    const root = refs().list;
    if (!root) return;
    const cart = getCartSafe();
    const rows = root.querySelectorAll(".cd-line");
    rows.forEach((row) => {
      const id = row.getAttribute("data-id") || "";
      const line = (cart.items || []).find((x) => String(x?.id) === String(id));
      const cd = formatCountdown(line?.price_lock_expires_at);
      const node = row.querySelector("[data-ui='lock']") || row.querySelector(".cd-lock");
      if (node) {
  node.textContent = cd ? `Time remaining: ${cd}` : "Time remaining: 0:00";
} else {
  const spans = row.querySelectorAll(".cd-row span");
  if (spans && spans.length >= 2) {
    spans[1].textContent = cd ? `Time remaining: ${cd}` : "Time remaining: 0:00";
  }
}

    });
  }

  async function render() {
    const r = refs();
    if (!r.list || !r.empty || !r.subtotal || !r.count) return;

    const cart = getCartSafe();
    const items = cart.items || [];

    try { await hydrateInventory(); } catch { /* ignore */ }

    r.count.textContent = String(items.length);

    if (!items.length) {
      r.list.innerHTML = "";
      r.empty.hidden = false;
      r.subtotal.textContent = "$0.00";
      if (r.notice) r.notice.hidden = true;
      return;
    }

    r.empty.hidden = true;

    r.list.innerHTML = items.map((line) => {
      const id = String(line?.id || "");
      const qty = Number(line?.qty) || 1;
      const price = Number(line?.price_locked) || 0;

      const meta = invMap.get(id);
      const title = meta?.title || `Item ${id.slice(0, 6)}…${id.slice(-4)}`;
      const img = meta?.image || "";
      const desc = meta?.desc || "";

      const cd = formatCountdown(line?.price_lock_expires_at);
      const href = itemHrefFor(id);

                  return `
        <div class="cd-line" data-id="${id}">
          <!-- Clickable product area -->
          <a class="cd-link" href="${href}" aria-label="View ${title.replaceAll('"', "&quot;")}">
            <div class="cd-thumb">
              ${img ? `<img src="${img}" alt="${title.replaceAll('"', "&quot;")}" loading="lazy">` : ``}
            </div>

            <div class="cd-meta">
              <div class="cd-name">${title}</div>
              ${desc ? `<div class="cd-desc">${desc}</div>` : ``}
              <div class="cd-row">
                <span class="cd-price">${money(price)}</span>
                <span data-ui="lock" class="cd-lockText">${cd ? `Time remaining: ${cd}` : `Time remaining: 0:00`}</span>
              </div>
            </div>
          </a>

          <!-- Controls stay separate and never navigate -->
          <div class="cd-controls">
            <button class="cd-x" type="button" data-action="remove-line" aria-label="Remove item">×</button>

            <div class="cd-qty" aria-label="Quantity">
              <button type="button" data-action="qty-dec" aria-label="Decrease quantity">−</button>
              <span data-ui="qty">${qty}</span>
              <button type="button" data-action="qty-inc" aria-label="Increase quantity">+</button>
            </div>
          </div>
        </div>
      `;


    }).join("");

    const svc = getCartService();
    const totals = svc
      ? svc.computeCartTotals(() => ({ exists: true }))
      : { subtotal: computeSubtotal(items) };
    r.subtotal.textContent = money(totals.subtotal);
    if (r.notice) r.notice.hidden = true;
  }

  // -------------------------
  // Mutations
  // -------------------------
  function updateQty(id, delta) {
    const svc = getCartService();
    if (!svc) return;
    const cart = svc.getCart();
    const line = (cart.items || []).find((x) => String(x?.id) === String(id));
    if (!line) return;
    const nextQty = clampQty((Number(line?.qty) || 1) + delta);
    svc.setCartQty(id, nextQty);
    emitCartChanged();
  }

  function removeLine(id) {
    const svc = getCartService();
    if (!svc) return;
    svc.removeFromCart(id);
    emitCartChanged();
  }

  // -------------------------
  // Wiring
  // -------------------------
  let tickTimer = null;

  function startTick() {
    if (tickTimer) return;
    tickTimer = window.setInterval(async () => {
      if (!isOpen()) { stopTick(); return; }

      // Update countdown UI cheaply
      try { updateCountdownInPlace(); } catch {}

      // If any lock expired, refresh + full rerender (to restart timer + update prices)
      try {
        const { changed } = await refreshExpiredLocksWithService();
        if (changed) {
          showNotice("Prices updated — lock restarted.");
          await render();
        }
      } catch {}

    }, 1000);
  }

  function stopTick() {
    if (!tickTimer) return;
    clearInterval(tickTimer);
    tickTimer = null;
  }

  async function openProgrammatic() {
    setOpen(true);
    try {
      const { changed } = await refreshExpiredLocksWithService();
      if (changed) showNotice("Prices updated — lock restarted.");
    } catch {}
    await render();
    startTick();
  }

  function closeProgrammatic() {
    setOpen(false);
    stopTick();
  }

  function wire() {
    // Open drawer when clicking any element with data-action="open-cart-drawer"
    document.addEventListener("click", async (e) => {
      const openBtn = e.target.closest('[data-action="open-cart-drawer"]');
      if (openBtn) {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        await openProgrammatic();
        return;
      }
      // If user clicks the product link inside the drawer, close first, then navigate
      const productLink = e.target.closest(".cd-link");
      if (productLink) {
        // Only intercept normal left-click navigation
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;

        const href = productLink.getAttribute("href") || productLink.href;
        if (!href) return;

        e.preventDefault();

        // Close drawer first (keeps it feeling premium)
        closeProgrammatic();

        // Navigate after close animation completes (matches setOpen(false) timeout)
        window.setTimeout(() => {
          window.location.assign(href);
        }, 240);

        return;
      }

      const actionBtn = e.target.closest("[data-action]");
      if (!actionBtn) return;

      const action = actionBtn.getAttribute("data-action");

      if (action === "close-cart-drawer") {
        closeProgrammatic();
        return;
      }

      if (action === "go-cart") {
        return; // let anchor navigate
      }

      const row = actionBtn.closest(".cd-line");
      const id = row?.dataset?.id;
      if (!id) return;

      if (action === "qty-inc") updateQty(id, +1);
      if (action === "qty-dec") updateQty(id, -1);
      if (action === "remove-line") removeLine(id);

      await render();
      startTick();
    });

    // Backdrop closes
    const r = refs();
    if (r.backdrop) {
      r.backdrop.addEventListener("click", () => {
        closeProgrammatic();
      });
    }

    // Esc closes
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isOpen()) {
        closeProgrammatic();
      }
    });

    // Cross-tab updates
    window.addEventListener("storage", async (e) => {
      if (e.key === CART_KEY && isOpen()) {
        await render();
        startTick();
      }
    });

    // ✅ Phase 6B: page-level cart updates (same tab)
    window.addEventListener("og-cart-changed", async () => {
      if (isOpen()) {
        await render();
        startTick();
      }
    });

    // Ensure drawer starts CLOSED
    document.addEventListener("DOMContentLoaded", () => {
      const rr = refs();
      if (rr.backdrop) { rr.backdrop.hidden = true; rr.backdrop.classList.remove("is-open"); }
      if (rr.drawer) { rr.drawer.hidden = true; rr.drawer.classList.remove("is-open"); rr.drawer.setAttribute("aria-hidden", "true"); }
      stopTick();
    });
  }

  // ✅ Phase 6B: Public API (index.js / catalogue.js)
  window.ogCartDrawerOpen = async () => {
    setOpen(true);
    await render();
    startTick();
  };

  window.ogCartDrawerClose = () => {
    setOpen(false);
    stopTick();
  };


  wire();
})();
