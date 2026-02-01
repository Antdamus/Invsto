/* =========================================================
   cart.drawer.js — OG Jewelers
   Toggleable drawer (open/close) + mini-cart rendering
   ========================================================= */

(() => {
  "use strict";

  const CART_KEY = "og_cart_v1";
  const VERSION = 1;

  // Hydration config: set in HTML before this script loads
  const CFG = window.OG_CART_DRAWER_CFG || {};
  const SUPABASE_URL = String(CFG.supabaseUrl || "");
  const CHANNEL = String(CFG.channel || "og_main");
  const FN = String(CFG.fn || "storefront-catalog");

  const $ = (sel, root = document) => root.querySelector(sel);

  const safeParse = (raw) => { try { return JSON.parse(raw); } catch { return null; } };
  const money = (n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return "$0.00";
    return `$${x.toFixed(2)}`;
  };

  const readCart = () => {
    const raw = localStorage.getItem(CART_KEY);
    if (!raw) return { version: VERSION, items: [], updated_at: new Date().toISOString() };
    const parsed = safeParse(raw);
    if (!parsed || parsed.version !== VERSION || !Array.isArray(parsed.items)) {
      return { version: VERSION, items: [], updated_at: new Date().toISOString() };
    }
    return parsed;
  };

  const writeCart = (items) => {
    localStorage.setItem(CART_KEY, JSON.stringify({
      version: VERSION,
      updated_at: new Date().toISOString(),
      items: Array.isArray(items) ? items : [],
    }));
    if (typeof window.ogCartBadgeRefresh === "function") window.ogCartBadgeRefresh();
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

  const resolveCartHref = () => {
    const path = window.location.pathname || "";
    return path.includes("/StoreCart/") ? "./cart.html" : "./StoreCart/cart.html";
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

      // next tick for transitions
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

      // allow transition to finish, then hide
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

  async function hydrateInventory() {
    // If no config, skip hydration (drawer still works)
    if (!SUPABASE_URL) return;

    // refresh cache max every 5 minutes
    if (Date.now() - invLast < 5 * 60 * 1000 && invMap.size) return;

    const url = `${SUPABASE_URL}/functions/v1/${encodeURIComponent(FN)}?channel=${encodeURIComponent(CHANNEL)}&t=${Math.floor(Date.now()/300000)}`;

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

  async function render() {
    const r = refs();
    if (!r.list || !r.empty || !r.subtotal || !r.count) return;

    const cart = readCart();
    const items = cart.items || [];

    // Attempt hydration (won't break render if it fails)
    try { await hydrateInventory(); } catch (e) { /* ignore */ }

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

      return `
        <div class="cd-line" data-id="${id}">
          <div class="cd-thumb">
            ${img ? `<img src="${img}" alt="${title.replaceAll('"', "&quot;")}" loading="lazy">` : ``}
          </div>

          <div class="cd-meta">
            <div class="cd-name">${title}</div>
            ${desc ? `<div class="cd-desc">${desc}</div>` : ``}
            <div class="cd-row">
              <span class="cd-price">${money(price)}</span>
              ${cd ? `<span>LOCKED: ${cd}</span>` : `<span>LOCKED</span>`}
            </div>
          </div>

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

    r.subtotal.textContent = money(computeSubtotal(items));
    if (r.notice) r.notice.hidden = true;
  }

  // -------------------------
  // Mutations
  // -------------------------
  function updateQty(id, delta) {
    const cart = readCart();
    const items = cart.items || [];
    const idx = items.findIndex((x) => String(x?.id) === String(id));
    if (idx < 0) return;

    const cur = items[idx];
    items[idx] = { ...cur, qty: clampQty((Number(cur?.qty) || 1) + delta) };
    writeCart(items);
  }

  function removeLine(id) {
    const cart = readCart();
    const items = (cart.items || []).filter((x) => String(x?.id) !== String(id));
    writeCart(items);
  }

  // -------------------------
  // Wiring (open/close works everywhere)
  // -------------------------
  let tickTimer = null;

  function startTick() {
    if (tickTimer) return;
    tickTimer = window.setInterval(() => {
      if (isOpen()) render();
      else stopTick();
    }, 1000);
  }

  function stopTick() {
    if (!tickTimer) return;
    clearInterval(tickTimer);
    tickTimer = null;
  }

  function wire() {
    // Open drawer when clicking any element with data-action="open-cart-drawer"
    document.addEventListener("click", async (e) => {
      const openBtn = e.target.closest('[data-action="open-cart-drawer"]');
      if (openBtn) {
        // keep link behavior for new tab / modifiers
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        setOpen(true);
        await render();
        startTick();
        return;
      }

      const actionBtn = e.target.closest("[data-action]");
      if (!actionBtn) return;

      const action = actionBtn.getAttribute("data-action");

      if (action === "close-cart-drawer") {
        setOpen(false);
        stopTick();
        return;
      }

      if (action === "go-cart") {
        // let anchor navigate normally
        return;
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
        setOpen(false);
        stopTick();
      });
    }

    // Esc closes
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isOpen()) {
        setOpen(false);
        stopTick();
      }
    });

    // Cross-tab updates
    window.addEventListener("storage", async (e) => {
      if (e.key === CART_KEY && isOpen()) {
        await render();
        startTick();
      }
    });

    // Ensure drawer starts CLOSED (prevents the catalogue “shift” look)
    document.addEventListener("DOMContentLoaded", () => {
      // if markup exists, force closed state
      const rr = refs();
      if (rr.backdrop) { rr.backdrop.hidden = true; rr.backdrop.classList.remove("is-open"); }
      if (rr.drawer) { rr.drawer.hidden = true; rr.drawer.classList.remove("is-open"); rr.drawer.setAttribute("aria-hidden","true"); }
      stopTick();
    });
  }

  wire();
})();
