/* =========================================================
   item.js — OG Jewelers (Product Details)
   Phase 1:
   - Loads a single product from storefront-catalog by ?id=
   - Renders title, price, full description, image, stock badge
   - Adds to cart using SAME contract as index.js (price lock)
   - Opens cart drawer after add (if available)
   - Shows "You may also like" (simple related logic)
   ========================================================= */

(() => {
  "use strict";

  /* =========================
     Nav drawer (mobile header)
  ========================= */
  function setAriaHidden(el, hidden) {
    if (!el) return;
    el.setAttribute("aria-hidden", hidden ? "true" : "false");
  }

  function lockScroll(on) {
    document.documentElement.style.overflow = on ? "hidden" : "";
    document.body.style.overflow = on ? "hidden" : "";
  }

  function navRefs() {
    return {
      btn: document.querySelector('[data-action="open-nav-drawer"]'),
      backdrop: document.querySelector('[data-ui="nav-drawer-backdrop"]'),
      drawer: document.querySelector('[data-ui="nav-drawer"]'),
    };
  }

  function isNavOpen() {
    const { drawer } = navRefs();
    return !!drawer && drawer.getAttribute("aria-hidden") === "false";
  }

  function openNav() {
    const { btn, backdrop, drawer } = navRefs();
    if (!backdrop || !drawer) return;

    backdrop.hidden = false;
    drawer.hidden = false;
    setAriaHidden(drawer, false);
    if (btn) btn.setAttribute("aria-expanded", "true");

    lockScroll(true);

    // focus first link for accessibility
    const first = drawer.querySelector("a, button");
    if (first) first.focus({ preventScroll: true });
  }

  function closeNav() {
    const { btn, backdrop, drawer } = navRefs();
    if (!backdrop || !drawer) return;

    setAriaHidden(drawer, true);
    drawer.hidden = true;
    backdrop.hidden = true;
    if (btn) {
      btn.setAttribute("aria-expanded", "false");
      btn.focus({ preventScroll: true });
    }

    lockScroll(false);
  }

  /* =========================
     Config (match catalogue.js)
  ========================= */
  const SUPABASE_PROJECT_URL = "https://byhytmarmigalvawkedi.supabase.co";
  const STOREFRONT_CHANNEL = "og_main";

  /* =========================
     Cart helpers (aligned with index.js)
  ========================= */
  const CART_KEY = "og_cart_v1";
  const CART_VERSION = 1;
  const PRICE_LOCK_MS = 15 * 60 * 1000;

  function safeParseJSON(s) { try { return JSON.parse(s); } catch { return null; } }

  function getCart() {
    const raw = localStorage.getItem(CART_KEY);
    const cart = safeParseJSON(raw);
    if (!cart || cart.version !== CART_VERSION || !Array.isArray(cart.items)) {
      return { version: CART_VERSION, updated_at: new Date().toISOString(), items: [] };
    }
    return cart;
  }

  function setCart(cart) {
    cart.version = CART_VERSION;
    cart.updated_at = new Date().toISOString();
    try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch {}
    window.dispatchEvent(new Event("og-cart-changed"));
  }

  function makePriceLock(price) {
    const p = Number(price);
    const t0 = Date.now();
    return {
      price_locked: Number.isFinite(p) ? p : 0,
      price_locked_at: new Date(t0).toISOString(),
      price_lock_expires_at: new Date(t0 + PRICE_LOCK_MS).toISOString(),
    };
  }

  function upsertCartItem({ id, qtyDelta = 1, currentPrice }) {
    const cart = getCart();
    const sid = String(id);
    const idx = cart.items.findIndex((x) => String(x.id) === sid);

    const delta = Math.floor(Number(qtyDelta)) || 1;
    const lock = makePriceLock(currentPrice);

    if (idx >= 0) {
      const cur = cart.items[idx];
      const nextQty = Math.max(1, Math.min(99, (Number(cur.qty) || 1) + delta));
      cart.items[idx] = { ...cur, qty: nextQty, ...lock }; // reset lock on add
    } else {
      cart.items.push({ id: sid, qty: Math.max(1, Math.min(99, delta)), ...lock });
    }

    setCart(cart);
  }

  /* =========================
     UI helpers
  ========================= */
  const $ = (sel, root = document) => root.querySelector(sel);

  function money(n) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "$0.00";
    return `$${x.toFixed(2)}`;
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function fiveMinBucket() {
    return Math.floor(Date.now() / 300000);
  }

  function resolveStockBadge(remainingCount) {
    const n = Number(remainingCount);
    if (!Number.isFinite(n)) return { label: "In Stock", tone: "ok" };
    if (n <= 0) return { label: "Sold Out", tone: "bad" };
    if (n < 10) return { label: `Low Stock — Only ${n} left`, tone: "warn" };
    return { label: "In Stock", tone: "ok" };
  }

  function getIdFromUrl() {
    const sp = new URLSearchParams(window.location.search);
    return sp.get("id") || "";
  }

  function pickImage(it) {
    // catalogue uses it.image_url; drawer uses it.image_url too
    // fall back to empty to keep styling clean
    return String(it?.image_url || it?.image || "");
  }

  async function fetchCatalog() {
    const t = fiveMinBucket();
    const url = `${SUPABASE_PROJECT_URL}/functions/v1/storefront-catalog?channel=${encodeURIComponent(
      STOREFRONT_CHANNEL
    )}&t=${t}`;

    const res = await fetch(url, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`catalog_fetch_failed (${res.status}) ${text}`);
    }

    const data = await res.json();
    return Array.isArray(data?.items) ? data.items : [];
  }

  function setLoading(on) {
    const skel = $('[data-ui="item-skeleton"]');
    const wrap = $('[data-ui="item-wrap"]');
    if (skel) skel.hidden = !on;
    if (wrap) wrap.hidden = on;
  }

  function setError(msg) {
    const el = $('[data-ui="item-error"]');
    if (!el) return;
    el.hidden = false;
    el.textContent = String(msg || "Something went wrong.");
  }

  function clearError() {
    const el = $('[data-ui="item-error"]');
    if (!el) return;
    el.hidden = true;
    el.textContent = "";
  }

  let toastTimer = null;
  function toast(msg, ms = 1600) {
    const el = document.querySelector(".toast");
    if (!el) return;
    el.textContent = String(msg || "");
    el.hidden = false;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove("show");
      el.hidden = true;
    }, ms);
  }

  function buildSuggestions(all, current) {
    const curId = String(current?.item_type_id || "");
    const curCats = new Set(Array.isArray(current?.categories) ? current.categories : []);
    const curMat = String(current?.material || "").toLowerCase().trim();

    const scored = (all || [])
      .filter((x) => String(x?.item_type_id || "") && String(x.item_type_id) !== curId)
      .map((x) => {
        const cats = Array.isArray(x?.categories) ? x.categories : [];
        const mat = String(x?.material || "").toLowerCase().trim();
        let score = 0;

        for (const c of cats) if (curCats.has(c)) score += 2;
        if (curMat && mat && curMat === mat) score += 3;

        score += Math.random() * 0.75;
        return { x, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map((s) => s.x);

    return scored;
  }

  function renderSuggestionCard(it) {
    const id = String(it?.item_type_id || "");
    const title = escapeHtml(it?.title || "Item");
    const price = money(it?.display_price);
    const img = pickImage(it);

    return `
      <a class="rel-card" href="item.html?id=${encodeURIComponent(id)}">
        <div class="rel-img" style="--img:url('${String(img).replaceAll("'", "%27")}')"></div>
        <div class="rel-meta">
          <div class="rel-title">${title}</div>
          <div class="rel-price">${price}</div>
        </div>
      </a>
    `;
  }

  function bindActions(currentItem) {
    document.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;

      const action = btn.getAttribute("data-action");

      if (action === "add-to-cart") {
        e.preventDefault();

        const id = String(currentItem?.item_type_id || "");
        const price = Number(currentItem?.display_price) || 0;
        const remaining = Number(currentItem?.remaining_count);

        if (!id) return;

        if (Number.isFinite(remaining) && remaining <= 0) {
          toast("Sold out.");
          return;
        }

        upsertCartItem({ id, qtyDelta: 1, currentPrice: price });

        // open cart drawer if available
        if (typeof window.ogCartDrawerOpen === "function") window.ogCartDrawerOpen();

        toast("Added to cart.");
        return;
      }

      if (action === "open-cart-drawer") {
        e.preventDefault();
        if (typeof window.ogCartDrawerOpen === "function") window.ogCartDrawerOpen();
        return;
      }

            if (action === "open-nav-drawer") {
        e.preventDefault();
        openNav();
        return;
      }

      if (action === "close-nav-drawer") {
        e.preventDefault();
        closeNav();
        return;
      }

    });
  }

  async function init() {
    setLoading(true);
    clearError();
    
    // nav drawer: close on backdrop click + escape + link click
    const { backdrop, drawer } = navRefs();

    if (backdrop) {
      backdrop.addEventListener("click", () => closeNav());
    }

    if (drawer) {
      drawer.addEventListener("click", (e) => {
        const a = e.target.closest("a");
        if (a) closeNav();
      });
    }

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && isNavOpen()) closeNav();
    });

    const id = getIdFromUrl();
    if (!id) {
      setLoading(false);
      setError("Missing item id. Go back to the shop and select a product.");
      return;
    }

    try {
      const all = await fetchCatalog();
      const item = all.find((x) => String(x?.item_type_id || "") === String(id));

      if (!item) {
        setLoading(false);
        setError("That product wasn’t found. It may have been unpublished.");
        return;
      }

      // Fill UI
      const title = String(item.title || "OG Item");
      const desc = String(item.description || "");
      const price = Number(item.display_price) || 0;
      const img = pickImage(item);

      const stock = resolveStockBadge(item.remaining_count);

      const h1 = $('[data-ui="item-title"]');
      const p = $('[data-ui="item-price"]');
      const d = $('[data-ui="item-desc"]');
      const badge = $('[data-ui="item-stock"]');
      const hero = $('[data-ui="item-hero"]');

      if (h1) h1.textContent = title;
      if (p) p.textContent = money(price);
      if (d) d.textContent = desc || "No description yet.";
      if (badge) {
        badge.textContent = stock.label;
        badge.setAttribute("data-tone", stock.tone);
      }
      if (hero) {
        if (img) hero.style.setProperty("--img", `url("${img}")`);
        hero.setAttribute("aria-label", title);
      }

      // Suggestions
      const rel = buildSuggestions(all, item);
      const relWrap = $('[data-ui="related-wrap"]');
      const relGrid = $('[data-ui="related-grid"]');

      if (relWrap && relGrid) {
        if (rel.length) {
          relWrap.hidden = false;
          relGrid.innerHTML = rel.map(renderSuggestionCard).join("");
        } else {
          relWrap.hidden = true;
        }
      }

      bindActions(item);
      setLoading(false);
    } catch (err) {
      console.error(err);
      setLoading(false);
      setError("Could not load product. Please try again.");
    }
  }

  document.addEventListener("DOMContentLoaded", init);

  /* =========================
   Auth UI (Login ↔ Initials)
   (matches index/catalogue behavior)
========================= */

function getSupabaseClientIfReady() {
  const c = window.supabaseClient || window.supabase;
  if (c && c.auth && typeof c.auth.getSession === "function") return c;
  return null;
}

function waitForSupabaseReady(timeoutMs = 3500) {
  return new Promise((resolve) => {
    const readyNow = getSupabaseClientIfReady();
    if (readyNow) return resolve(readyNow);

    const onReady = () => {
      document.removeEventListener("supabase-ready", onReady);
      resolve(getSupabaseClientIfReady() || null);
    };

    document.addEventListener("supabase-ready", onReady);

    const t0 = Date.now();
    const timer = setInterval(() => {
      const client = getSupabaseClientIfReady();
      if (client) {
        clearInterval(timer);
        document.removeEventListener("supabase-ready", onReady);
        resolve(client);
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        document.removeEventListener("supabase-ready", onReady);
        resolve(null);
      }
    }, 60);
  });
}

function computeInitials(user) {
  const meta = user?.user_metadata || {};
  const full = String(meta.full_name || meta.name || "").trim();

  if (full) {
    const parts = full.split(/\s+/).filter(Boolean);
    const a = (parts[0]?.[0] || "").toUpperCase();
    const b = (parts[1]?.[0] || "").toUpperCase();
    return (a + b) || "M";
  }

  const email = String(user?.email || "").trim();
  if (email) return (email[0] || "M").toUpperCase();

  return "M";
}

function setHardHidden(el, shouldHide, showDisplay = "") {
  if (!el) return;
  if (shouldHide) {
    el.hidden = true;
    el.style.display = "none";
    el.setAttribute("aria-hidden", "true");
  } else {
    el.hidden = false;
    el.style.display = showDisplay || "";
    el.setAttribute("aria-hidden", "false");
  }
}

function closeAcctMenu() {
  const menu = document.querySelector('[data-ui="acct-menu"]');
  if (!menu) return;
  menu.hidden = true;
  menu.setAttribute("aria-hidden", "true");
}

function openAcctMenu() {
  const menu = document.querySelector('[data-ui="acct-menu"]');
  if (!menu) return;
  menu.hidden = false;
  menu.setAttribute("aria-hidden", "false");
}

function wireAcctMenu(sb) {
  const chip = document.querySelector('[data-ui="acct-chip"]');
  const menu = document.querySelector('[data-ui="acct-menu"]');
  if (!chip || !menu) return;

  // Toggle menu
  chip.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (menu.hidden) openAcctMenu();
    else closeAcctMenu();
  });

  // Click outside closes
  document.addEventListener("click", () => closeAcctMenu());

  // Sign out handler
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest('[data-action="signout"]');
    if (!btn) return;

    e.preventDefault();
    e.stopPropagation();

    try {
      await sb?.auth?.signOut?.();
    } catch {}

    // Return to index and bust cache so UI updates immediately
    const bust = Date.now();
    window.location.replace(`index.html?logout=1&bust=${bust}`);
  });
}

async function applyAuthUI(sb) {
  const accessBtn = document.querySelector('[data-ui="access-btn"]');
  const chip = document.querySelector('[data-ui="acct-chip"]');
  const initialsEl = document.querySelector('[data-ui="acct-initials"]');

  const drawerAccount = document.querySelector('[data-ui="drawer-account"]');
  const drawerDivider = document.querySelector('[data-ui="drawer-divider"]');
  const drawerInitials = document.querySelector('[data-ui="drawer-initials"]');
  const mobileAccess = document.querySelector('[data-ui="mobile-access"]');

  // Baseline: hide auth-dependent elements until session known
  setHardHidden(chip, true);
  if (initialsEl) initialsEl.textContent = "";
  setHardHidden(drawerAccount, true);
  setHardHidden(drawerDivider, true);

  // Session check
  let session = null;
  try {
    const { data } = await sb.auth.getSession();
    session = data?.session || null;
  } catch {}

  if (session?.user) {
    const initials = computeInitials(session.user);

    if (initialsEl) initialsEl.textContent = initials;
    if (drawerInitials) drawerInitials.textContent = initials;

    setHardHidden(accessBtn, true);
    setHardHidden(mobileAccess, true);

    setHardHidden(chip, false, "inline-flex");
    setHardHidden(drawerAccount, false, "");
    setHardHidden(drawerDivider, false, "");
  } else {
    setHardHidden(chip, true);
    setHardHidden(drawerAccount, true);
    setHardHidden(drawerDivider, true);

    setHardHidden(accessBtn, false, "");
    setHardHidden(mobileAccess, false, "");
  }
}

function initAuthUI() {
  // If item.html doesn’t include supabase scripts yet, fail silently
  waitForSupabaseReady().then(async (sb) => {
    if (!sb) return;

    wireAcctMenu(sb);
    await applyAuthUI(sb);

    // Keep it synced if auth changes while tab is open
    sb.auth.onAuthStateChange(async () => {
      await applyAuthUI(sb);
    });

    // BFCache / tab-switch resilience
    window.addEventListener("pageshow", async () => {
      await applyAuthUI(sb);
    });
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState === "visible") await applyAuthUI(sb);
    });
  });
}

// call it (safe even if supabase not available yet)
initAuthUI();

})();
