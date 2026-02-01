/* catalogue.js — OG Jewelers (Catalog)
   Ultra-aesthetic, framework-free catalog with:
   - URL-driven filters (category/material/tag/q/minPrice/maxPrice/sort/page/view)
   - Filter drawer (open/close, backdrop, escape, focus behavior)
   - Chip-based filters + removable active chips
   - Search with debounce
   - Sort + pagination
   - Grid/List view toggle
   - Demo dataset (swap later to Supabase/JSON fetch without changing UI logic)

   Query params supported:
   - category=gold&category=chains (multi)
   - material=gold (multi)
   - tag=featured (multi)
   - q=rope
   - minPrice=0
   - maxPrice=750
   - sort=featured|newest|price_asc|price_desc|name_asc
   - page=1
   - view=grid|list
*/

(() => {
  "use strict";

  /* =========================
     Tiny helpers
  ========================= */
  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const prefersReducedMotion = () =>
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const clampInt = (n, a, b) => {
    const x = Number.isFinite(n) ? n : parseInt(String(n || ""), 10);
    const v = Number.isFinite(x) ? x : a;
    return Math.max(a, Math.min(b, v));
  };

  const formatUSD = (n) => {
    const v = Number(n);
    if (!Number.isFinite(v)) return "";
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v);
  };
  // HTML escape helper (needed by renderCard templates)
const esc = (s) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

    const toPriceNumber = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const s = String(v ?? "").trim();
  // remove $ and commas etc.
  const cleaned = s.replace(/[^0-9.]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
};

/* =========================
   Cart helpers (Phase 3 — aligned with cart.js)
========================= */
const CART_KEY = "og_cart_v1";
const CART_VERSION = 1;
const PRICE_LOCK_MS = 15 * 60 * 1000; // 15 minutes

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
    cart.items[idx] = {
      ...cur,
      qty: nextQty,
      // reset price lock on add (your rule)
      ...lock,
    };
  } else {
    cart.items.push({
      id: sid,
      qty: Math.max(1, Math.min(99, delta)),
      ...lock,
    });
  }

  setCart(cart);
}


   /* =========================
     Data source (Supabase Edge Function)
  ========================= */
  const SUPABASE_PROJECT_URL = "https://byhytmarmigalvawkedi.supabase.co"; // <-- your project
  const STOREFRONT_CHANNEL = "og_main";
  const FALLBACK_IMAGE = "assets/collections/chains.jpg";

  /* =========================
     Auth UI (Member Access ↔ Initials)
  ========================= */
  const getSupabaseClientIfReady = () => {
    const c = window.supabaseClient || window.supabase;
    if (c && c.auth && typeof c.auth.getSession === "function") return c;
    return null;
  };

  const waitForSupabaseReady = (timeoutMs = 3500) => {
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
  };

  const computeInitials = (user) => {
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
  };

// ✅ Force-hide helper (wins even if CSS uses display: flex !important)
const setHardHidden = (el, shouldHide, showDisplay = "") => {
  if (!el) return;

  el.hidden = !!shouldHide;

  if (shouldHide) {
    el.style.display = "none";
    el.setAttribute("aria-hidden", "true");
  } else {
    el.style.display = showDisplay; // "" lets CSS decide
    el.removeAttribute("aria-hidden");
  }
};

const applyAuthUI = async (sb) => {
  const accessBtn = qs('[data-ui="access-btn"]');
  const chip = qs('[data-ui="acct-chip"]');
  const initialsEl = qs('[data-ui="acct-initials"]');
  const acctMenu = qs('[data-ui="acct-menu"]');

  // Mobile drawer
  const mobileAccess = qs('[data-ui="mobile-access"]');
  const mobileAccountWrap = qs('[data-ui="mobile-account-wrap"]');
  const mobileAccount = qs('[data-ui="mobile-account"]');
  const mobileInitials = qs('[data-ui="mobile-initials"]');
  const mobileSignOutBtn = qs('[data-ui="mobile-signout"]');

  // ✅ HARD BASELINE: assume logged out (prevents flash)
  setHardHidden(chip, true);
  if (accessBtn) accessBtn.style.display = "";

  // ✅ DESKTOP MENU: DO NOT hard-hide with display:none (it breaks toggling)
if (acctMenu) {
  acctMenu.hidden = true;
  acctMenu.setAttribute("aria-hidden", "true");
  acctMenu.style.display = ""; // clear any previous inline display:none
}


  // Mobile baseline
  setHardHidden(mobileAccess, false);
  setHardHidden(mobileAccountWrap, true);
  setHardHidden(mobileAccount, true);
  setHardHidden(mobileSignOutBtn, true);

  if (initialsEl) initialsEl.textContent = "";
  if (mobileInitials) mobileInitials.textContent = "";

  // ✅ Session check
  let session = null;
  try {
    const { data } = await sb.auth.getSession();
    session = data?.session || null;
  } catch {
    session = null;
  }

  // ✅ Logged in => show account + signout
  if (session?.user) {
    const initials = computeInitials(session.user);

    if (initialsEl) initialsEl.textContent = initials;
    if (mobileInitials) mobileInitials.textContent = initials;

    setHardHidden(chip, false);
    if (accessBtn) accessBtn.style.display = "none";

    setHardHidden(mobileAccess, true);
    setHardHidden(mobileAccountWrap, false);
    setHardHidden(mobileAccount, false);
    setHardHidden(mobileSignOutBtn, false);
  }
};


const initAuthUI = async () => {
  const sb = await waitForSupabaseReady();
  if (!sb) return;

  // Run once immediately
  await applyAuthUI(sb);

  // Re-apply on auth changes
  sb.auth.onAuthStateChange(async () => {
    await applyAuthUI(sb);
  });

  // ✅ Ensure mobile signout works (your current initAccountDropdown no longer wires it)
  const mobileSignOutBtn = qs('[data-ui="mobile-signout"]');
  if (mobileSignOutBtn && !mobileSignOutBtn.dataset.bound) {
    mobileSignOutBtn.dataset.bound = "1";
    mobileSignOutBtn.addEventListener("click", async () => {
      try {
        await sb.auth.signOut();
      } catch {}
      await applyAuthUI(sb);
      window.location.href = "catalogue.html";
    });
  }
};



async function fetchSpotSnapshot(){
  const url = `${SUPABASE_PROJECT_URL}/functions/v1/spot-snapshot`;
  const res = await fetch(url, { method: "GET", cache: "no-store" });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`spot_snapshot_failed (${res.status}) ${text}`);
  }

  const json = await res.json();
  return Array.isArray(json?.rows) ? json.rows : [];
}


function fmtMoney(n){
  // USD per gram - show 2 decimals (gold), 3 decimals (silver) optional, but we’ll keep it consistent:
  return Number(n).toFixed(2);
}

function fmtTime(ts){
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

async function renderSpotTicker(){
  const el = document.getElementById('spotTicker');
  if (!el) return;

  try{
    const rows = await fetchSpotSnapshot();
    const gold = rows.find(r => r.metal === 'gold');
    const silver = rows.find(r => r.metal === 'silver');

    if (!gold || !silver){
      el.querySelector('.spot-text').textContent = 'Spot unavailable';
      return;
    }

    const asOf = gold.as_of || silver.as_of;
    const time = asOf ? fmtTime(asOf) : '';

    el.querySelector('.spot-text').innerHTML =
      `<b>Gold</b> $${fmtMoney(gold.price_per_gram)}/g
       <span class="muted">•</span>
       <b>Silver</b> $${fmtMoney(silver.price_per_gram)}/g
       <span class="muted">• Updated ${time}</span>`;
  } catch (e){
    console.error('Spot ticker error:', e);
    const txt = el.querySelector('.spot-text');
    if (txt) txt.textContent = 'Spot unavailable';
  }
}

function initSpotTicker(){
  renderSpotTicker();
  setInterval(renderSpotTicker, 60 * 1000);
}

  // This becomes the live dataset (replaces demo PRODUCTS)
  let PRODUCTS = [];

  const fiveMinBucket = () => Math.floor(Date.now() / 300000); // 5 min
  const toNum = (x) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : 0;
  };

  // Map RPC item -> UI product shape used by the existing UI logic
  const mapStoreItemToProduct = (it) => {
    const cats = Array.isArray(it.categories) ? it.categories : [];
    const category = String(cats[0] || "all").toLowerCase();

    const tags = Array.isArray(it.badge_flags) ? it.badge_flags : [];

    return {
      id: String(it.item_type_id),
      name: String(it.title || ""),
      category,
      material: String(it.material || "").toLowerCase(), // returned by RPC if you added it; otherwise empty ok
      price: toNum(it.display_price),
      tags,
      created_at: new Date().toISOString(), // (optional) upgrade later if you add created_at to RPC
      image: it.image_url || FALLBACK_IMAGE,
    };
  };

  const loadCatalog = async () => {
    const t = fiveMinBucket();
    const url = `${SUPABASE_PROJECT_URL}/functions/v1/storefront-catalog?channel=${encodeURIComponent(
      STOREFRONT_CHANNEL
    )}&t=${t}`;

    const res = await fetch(url, {
      method: "GET",
      headers: {
        // For most setups, anon key is NOT required if verify_jwt is off.
        // If your function requires JWT, add Authorization/apikey here later.
        "Content-Type": "application/json",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`catalog_fetch_failed (${res.status}) ${text}`);
    }

    const data = await res.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    PRODUCTS = items.map(mapStoreItemToProduct);
  };


  /* =========================
     State
  ========================= */
  const DEFAULTS = {
    q: "",
    category: new Set(),
    material: new Set(),
    tag: new Set(),
    minPrice: "",
    maxPrice: "",
    sort: "featured",
    page: 1,
    view: "grid",
  };

  const state = {
    ...DEFAULTS,
    pageSize: 12, // adjust later
  };

  /* =========================
     DOM
  ========================= */
  const header = qs("[data-elevate-on-scroll]");
  const yearEl = qs("#year");

const navToggle = qs(".nav-toggle");

// NEW: index-style nav drawer (left slide-in)
const navDrawer = qs("#navDrawer");
const navBackdrop = qs("#navDrawerBackdrop");
const navCloseBtn = qs(".nav-drawer-close");


  const qInput = qs("#q");
  const clearSearchBtn = qs('[data-action="clear-search"]');

  const sortSel = qs("#sort");
  const openFiltersBtn = qs('[data-action="open-filters"]');
  const resetBtns = qsa('[data-action="reset-filters"]');

  const chipsWrap = qs("#chips");
  const activePill = qs("#activeFiltersPill");

  const grid = qs("#grid");
  const emptyState = qs("#emptyState");

  const resultsCount = qs("#resultsCount");
  const resultsCountInline = qs("#resultsCountInline");

  const pathContext = qs("#pathContext");

  const pageNum = qs("#pageNum");
  const pageTotal = qs("#pageTotal");
  const prevBtn = qs('[data-action="prev-page"]');
  const nextBtn = qs('[data-action="next-page"]');
  const toggleViewBtn = qs('[data-action="toggle-view"]');

  // Drawer
  const drawer = qs("#filtersDrawer");
  const backdrop = qs(".drawer-backdrop");
  const applyBtn = qs('[data-action="apply-filters"]');
  const closeBtns = qsa('[data-action="close-filters"]');

  // Drawer fields
  const minPriceInput = qs("#minPrice");
  const maxPriceInput = qs("#maxPrice");
  const chipGrids = qsa(".chip-grid"); // each has data-filter
  const presetPriceBtns = qsa('[data-action="preset-price"]');

  // Toast
  const toastEl = qs(".toast");
  let toastTimer = null;

  /* =========================
     Header elevate on scroll
  ========================= */
  const setHeaderState = () => {
    if (!header) return;
    header.classList.toggle("is-elevated", (window.scrollY || 0) > 6);
  };

  /* =========================
     URL <-> State
  ========================= */
  const parseParams = () => new URLSearchParams(window.location.search);

  const readMulti = (params, key) => new Set(params.getAll(key).map((v) => String(v).trim()).filter(Boolean));

  const writeMulti = (params, key, set) => {
    params.delete(key);
    Array.from(set).forEach((v) => params.append(key, v));
  };

  const readStateFromURL = () => {
    const p = parseParams();

    state.q = (p.get("q") || "").trim();

    state.category = readMulti(p, "category");
    state.material = readMulti(p, "material");
    state.tag = readMulti(p, "tag");

    state.minPrice = (p.get("minPrice") || "").trim();
    state.maxPrice = (p.get("maxPrice") || "").trim();

    state.sort = (p.get("sort") || DEFAULTS.sort).trim();
    state.view = (p.get("view") || DEFAULTS.view).trim();

    state.page = clampInt(parseInt(p.get("page") || "1", 10), 1, 9999);

    // Safety: only allow known values
    if (!["featured", "newest", "price_asc", "price_desc", "name_asc"].includes(state.sort)) {
      state.sort = DEFAULTS.sort;
    }
    if (!["grid", "list"].includes(state.view)) {
      state.view = DEFAULTS.view;
    }
  };

  const writeURLFromState = (replace = false) => {
    const p = new URLSearchParams();

    if (state.q) p.set("q", state.q);
    if (state.minPrice !== "") p.set("minPrice", state.minPrice);
    if (state.maxPrice !== "") p.set("maxPrice", state.maxPrice);

    writeMulti(p, "category", state.category);
    writeMulti(p, "material", state.material);
    writeMulti(p, "tag", state.tag);

    if (state.sort && state.sort !== DEFAULTS.sort) p.set("sort", state.sort);
    if (state.view && state.view !== DEFAULTS.view) p.set("view", state.view);
    if (state.page && state.page !== 1) p.set("page", String(state.page));

    const newUrl = `${window.location.pathname}${p.toString() ? "?" + p.toString() : ""}`;
    if (replace) history.replaceState(null, "", newUrl);
    else history.pushState(null, "", newUrl);
  };

  /* =========================
     UI sync from state
  ========================= */
  const syncControlsFromState = () => {
    if (qInput) qInput.value = state.q || "";
    if (sortSel) sortSel.value = state.sort;

    if (minPriceInput) minPriceInput.value = state.minPrice;
    if (maxPriceInput) maxPriceInput.value = state.maxPrice;

    // Drawer chips active styling
    chipGrids.forEach((gridEl) => {
      const key = gridEl.dataset.filter;
      const set = state[key] instanceof Set ? state[key] : new Set();
      qsa(".chip", gridEl).forEach((btn) => {
        const val = btn.dataset.value;
        btn.classList.toggle("is-active", set.has(val));
      });
    });

    // View mode class
    if (grid) {
      grid.dataset.view = state.view;
    }
  };

  /* =========================
     Filtering + Sorting
  ========================= */
  const matchesSet = (set, value) => (set.size === 0 ? true : set.has(value));

  const matchesTags = (tagSet, tagsArr) => {
    if (tagSet.size === 0) return true;
    const tags = Array.isArray(tagsArr) ? tagsArr : [];
    return Array.from(tagSet).some((t) => tags.includes(t));
  };

  const applyFilters = (items) => {
    const q = (state.q || "").toLowerCase().trim();

    const min = state.minPrice === "" ? null : Number(state.minPrice);
    const max = state.maxPrice === "" ? null : Number(state.maxPrice);

    return items.filter((it) => {
      if (!matchesSet(state.category, it.category)) return false;
      if (!matchesSet(state.material, it.material)) return false;
      if (!matchesTags(state.tag, it.tags)) return false;

      if (Number.isFinite(min) && it.price < min) return false;
      if (Number.isFinite(max) && it.price > max) return false;

      if (q) {
        const hay = `${it.name} ${it.category} ${it.material} ${(it.tags || []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }

      return true;
    });
  };

  const sortItems = (items) => {
    const arr = items.slice();
    switch (state.sort) {
      case "newest":
        arr.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        break;
      case "price_asc":
        arr.sort((a, b) => a.price - b.price);
        break;
      case "price_desc":
        arr.sort((a, b) => b.price - a.price);
        break;
      case "name_asc":
        arr.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        break;
      case "featured":
      default:
        // Featured heuristic: featured tag first, then newest
        arr.sort((a, b) => {
          const af = (a.tags || []).includes("featured") ? 1 : 0;
          const bf = (b.tags || []).includes("featured") ? 1 : 0;
          if (af !== bf) return bf - af;
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        });
        break;
    }
    return arr;
  };

  const paginate = (items) => {
    const total = items.length;
    const pages = Math.max(1, Math.ceil(total / state.pageSize));
    state.page = clampInt(state.page, 1, pages);

    const start = (state.page - 1) * state.pageSize;
    const end = start + state.pageSize;

    return {
      pageItems: items.slice(start, end),
      total,
      pages,
    };
  };

  /* =========================
     Chips / Active count
  ========================= */
  const humanize = (key, val) => {
    const maps = {
      category: { gold: "Gold", diamonds: "Diamonds", chains: "Chains", signature: "Signature" },
      material: { gold: "Gold", silver: "Silver", platinum: "Platinum", diamond: "Diamond" },
      tag: { new: "New", featured: "Featured", best_value: "Best Value", limited: "Limited" },
    };
    return (maps[key] && maps[key][val]) ? maps[key][val] : val;
  };

  const buildActiveChips = () => {
    if (!chipsWrap) return;

    const chips = [];

    // Multi sets
    ["category", "material", "tag"].forEach((k) => {
      Array.from(state[k]).forEach((v) => {
        chips.push({ key: k, value: v, label: `${humanize(k, v)}` });
      });
    });

    // Price chips
    if (state.minPrice !== "" || state.maxPrice !== "") {
      const min = state.minPrice !== "" ? formatUSD(state.minPrice) : "—";
      const max = state.maxPrice !== "" ? formatUSD(state.maxPrice) : "—";
      chips.push({ key: "price", value: "range", label: `Price: ${min} – ${max}` });
    }

    // Search chip
    if (state.q) chips.push({ key: "q", value: state.q, label: `Search: “${state.q}”` });

    // Render
    chipsWrap.innerHTML = chips
      .map((c) => {
        return `
          <button class="active-chip" type="button" data-chip-key="${esc(c.key)}" data-chip-value="${esc(c.value)}" aria-label="Remove ${esc(c.label)}">
            <span class="active-chip-label">${esc(c.label)}</span>
            <span class="active-chip-x" aria-hidden="true">✕</span>
          </button>
        `;
      })
      .join("");

    // Pill count (exclude q? include it. include price.)
    if (activePill) activePill.textContent = String(chips.length);

    // Path context
    if (pathContext) {
      const cat = Array.from(state.category)[0];
      if (cat) pathContext.textContent = humanize("category", cat);
      else pathContext.textContent = "All items";
    }
  };

  const clearChip = (key, value) => {
    if (key === "category" || key === "material" || key === "tag") {
      state[key].delete(value);
    } else if (key === "price") {
      state.minPrice = "";
      state.maxPrice = "";
      if (minPriceInput) minPriceInput.value = "";
      if (maxPriceInput) maxPriceInput.value = "";
    } else if (key === "q") {
      state.q = "";
      if (qInput) qInput.value = "";
    }

    state.page = 1;
    writeURLFromState(false);
    render();
  };

  /* =========================
     Drawer open/close
  ========================= */
  let lastFocus = null;

  const openDrawer = () => {
    if (!drawer || !backdrop) return;
    lastFocus = document.activeElement;

    backdrop.hidden = false;
    drawer.hidden = false;
    document.body.classList.add("drawer-open");

    // Focus first interactive element
    const closeBtn = qs('[data-action="close-filters"]', drawer);
    if (closeBtn) closeBtn.focus({ preventScroll: true });
  };

  const closeDrawer = () => {
    if (!drawer || !backdrop) return;

    drawer.hidden = true;
    backdrop.hidden = true;
    document.body.classList.remove("drawer-open");

    if (lastFocus && typeof lastFocus.focus === "function") {
      lastFocus.focus({ preventScroll: true });
    }
    lastFocus = null;
  };

const handleEscape = (e) => {
  if (e.key !== "Escape") return;

  // Close filters drawer first
  if (drawer && !drawer.hidden) {
    closeDrawer();
    return;
  }

  // Close nav drawer
  if (isNavOpen()) {
    closeNavDrawer();
    return;
  }
};


 /* =========================
   Nav drawer (index-style: left slide-in)
========================= */
const lockScroll = (on) => {
  document.documentElement.classList.toggle("lock", on);
  document.body.classList.toggle("lock", on);
};

const isNavOpen = () => !!navDrawer && !navDrawer.hidden;

const openNavDrawer = () => {
  if (!navDrawer || !navBackdrop || !navToggle) return;

  navBackdrop.hidden = false;
  navDrawer.hidden = false;

  navToggle.setAttribute("aria-expanded", "true");
  navDrawer.setAttribute("aria-hidden", "false");

  document.body.classList.add("menu-open"); // keep your hamburger animation hook
  lockScroll(true);

  // Focus close button or first link
  const focusEl =
    navCloseBtn ||
    qs("a, button", navDrawer);
  focusEl?.focus?.({ preventScroll: true });
};

const closeNavDrawer = () => {
  if (!navDrawer || !navBackdrop || !navToggle) return;

  navDrawer.hidden = true;
  navBackdrop.hidden = true;

  navToggle.setAttribute("aria-expanded", "false");
  navDrawer.setAttribute("aria-hidden", "true");

  document.body.classList.remove("menu-open");
  lockScroll(false);
};

const toggleNavDrawer = () => {
  if (!navDrawer) return;
  if (navDrawer.hidden) openNavDrawer();
  else closeNavDrawer();
};


  /* =========================
     Toast
  ========================= */
  const toast = (text) => {
    if (!toastEl) return;
    toastEl.textContent = text;
    toastEl.hidden = false;
    toastEl.classList.add("show");

    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toastEl.classList.remove("show");
      window.setTimeout(() => (toastEl.hidden = true), prefersReducedMotion() ? 0 : 160);
    }, 1600);
  };

  /* =========================
     Rendering
  ========================= */
  const renderCard = (p) => {
  const tags = (p.tags || []).slice(0, 2)
    .map((t) => `<span class="tag">${esc(humanize("tag", t))}</span>`)
    .join("");

  return `
    <article class="product-card" data-id="${esc(p.id)}">
      <button class="product-hit" type="button"
              data-action="quick-view"
              data-id="${esc(p.id)}"
              aria-label="Quick view ${esc(p.name)}">
        <div class="product-media">
          <img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy" />
        </div>
        <div class="product-body">
          <div class="product-top">
            <h3 class="product-title">${esc(p.name)}</h3>
            <div class="product-price">${esc(formatUSD(p.price))}</div>
          </div>
          <div class="product-meta">
            <span>${esc(humanize("category", p.category))}</span>
            <span class="sep" aria-hidden="true">•</span>
            <span>${esc(humanize("material", p.material))}</span>
          </div>
          <div class="product-tags">${tags}</div>
        </div>
      </button>

      <div class="product-actions">
        <button class="btn ghost" type="button"
                data-action="add-to-cart"
                data-id="${esc(p.id)}">
          Add to cart
        </button>
      </div>
    </article>
  `;
};


  const render = () => {
    // Filters + sort
    const filtered = applyFilters(PRODUCTS);
    const sorted = sortItems(filtered);
    const { pageItems, total, pages } = paginate(sorted);

    // Update counts
    if (resultsCount) resultsCount.textContent = String(total);
    if (resultsCountInline) resultsCountInline.textContent = String(total);

    if (pageNum) pageNum.textContent = String(state.page);
    if (pageTotal) pageTotal.textContent = String(pages);

    if (prevBtn) prevBtn.disabled = state.page <= 1;
    if (nextBtn) nextBtn.disabled = state.page >= pages;

    // Empty state
    if (emptyState) emptyState.hidden = total !== 0;

    // Render grid
    if (grid) {
      grid.innerHTML = pageItems.map(renderCard).join("");
      grid.dataset.view = state.view;
    }

    // Chips
    buildActiveChips();

    // Controls
    syncControlsFromState();
  };

  /* =========================
     Event wiring
  ========================= */
  const debounce = (fn, ms = 180) => {
    let t = null;
    return (...args) => {
      window.clearTimeout(t);
      t = window.setTimeout(() => fn(...args), ms);
    };
  };

  const onSearchInput = debounce(() => {
    state.q = (qInput?.value || "").trim();
    state.page = 1;
    writeURLFromState(false);
    render();
  }, 170);

  const onSortChange = () => {
    state.sort = (sortSel?.value || DEFAULTS.sort).trim();
    state.page = 1;
    writeURLFromState(false);
    render();
  };

  const resetAll = () => {
    state.q = "";
    state.category = new Set();
    state.material = new Set();
    state.tag = new Set();
    state.minPrice = "";
    state.maxPrice = "";
    state.sort = DEFAULTS.sort;
    state.page = 1;
    state.view = state.view || DEFAULTS.view;

    writeURLFromState(false);
    render();
    toast("Filters reset.");
  };

  const applyDrawerToState = () => {
    // price
    state.minPrice = (minPriceInput?.value || "").trim();
    state.maxPrice = (maxPriceInput?.value || "").trim();

    // Safety: swap if min > max
    const min = Number(state.minPrice);
    const max = Number(state.maxPrice);
    if (Number.isFinite(min) && Number.isFinite(max) && min > max) {
      state.minPrice = String(max);
      state.maxPrice = String(min);
      if (minPriceInput) minPriceInput.value = state.minPrice;
      if (maxPriceInput) maxPriceInput.value = state.maxPrice;
    }

    state.page = 1;
    writeURLFromState(false);
    render();
    closeDrawer();
  };

  const toggleSetValue = (key, value) => {
    if (!(state[key] instanceof Set)) return;
    if (state[key].has(value)) state[key].delete(value);
    else state[key].add(value);
  };

  const wireDrawerChips = () => {
    chipGrids.forEach((gridEl) => {
      const key = gridEl.dataset.filter;
      gridEl.addEventListener("click", (e) => {
        const btn = e.target.closest(".chip");
        if (!btn) return;

        const val = btn.dataset.value;
        if (!val) return;

        toggleSetValue(key, val);
        btn.classList.toggle("is-active", state[key].has(val));
      });
    });
  };

  const wirePricePresets = () => {
    presetPriceBtns.forEach((b) => {
      b.addEventListener("click", () => {
        const min = b.dataset.min ?? "";
        const max = b.dataset.max ?? "";

        if (minPriceInput) minPriceInput.value = String(min);
        if (maxPriceInput) maxPriceInput.value = String(max);

        state.minPrice = String(min);
        state.maxPrice = String(max);

        // visual toast, but do NOT apply until user hits Apply (premium feel)
        toast("Preset selected.");
      });
    });
  };

  const wireGlobalClicks = () => {
    document.addEventListener("click", (e) => {
      const el = e.target.closest("[data-action]");
      if (!el) return;

      const action = el.dataset.action;

      // Filter drawer
      if (action === "open-filters") {
        openDrawer();
        return;
      }
      if (action === "close-filters") {
        closeDrawer();
        return;
      }
      if (action === "apply-filters") {
        applyDrawerToState();
        return;
      }

      // Reset
      if (action === "reset-filters") {
        resetAll();
        closeDrawer();
        return;
      }

      // Search
      if (action === "clear-search") {
        state.q = "";
        if (qInput) qInput.value = "";
        state.page = 1;
        writeURLFromState(false);
        render();
        return;
      }

      // Pagination
      if (action === "prev-page") {
        state.page = Math.max(1, state.page - 1);
        writeURLFromState(false);
        render();
        window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
        return;
      }
      if (action === "next-page") {
        state.page = state.page + 1;
        writeURLFromState(false);
        render();
        window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? "auto" : "smooth" });
        return;
      }

      // View toggle
      if (action === "toggle-view") {
        state.view = state.view === "grid" ? "list" : "grid";
        writeURLFromState(false);
        render();
        toast(state.view === "grid" ? "Grid view" : "List view");
        return;
      }

    // Add to cart
if (action === "add-to-cart") {
  const id = el.dataset.id;
  const item = PRODUCTS.find((p) => p.id === id);

  if (item) {
    // IMPORTANT: use the Phase-2/Phase-3 cart contract (price_locked + expires)
    upsertCartItem({
      id: item.id,
      qtyDelta: 1,
      currentPrice: toPriceNumber(item.price),
    });
  } else {
    upsertCartItem({
      id,
      qtyDelta: 1,
      currentPrice: 0,
    });
  }

  window.location.href = "./StoreCart/cart.html";
  return;
}

      if (action === "quick-view") {
        const id = el.dataset.id;
        const item = PRODUCTS.find((p) => p.id === id);
        if (item) toast(item.name);
        return;
      }

      // Chip removal
      const chip = e.target.closest(".active-chip");
      if (chip) {
        const key = chip.dataset.chipKey;
        const val = chip.dataset.chipValue;
        if (key) clearChip(key, val);
      }
    });
  };

  const wireInputs = () => {
    if (qInput) qInput.addEventListener("input", onSearchInput);
    if (sortSel) sortSel.addEventListener("change", onSortChange);

    resetBtns.forEach((b) => b.addEventListener("click", resetAll));
  };

  const wireHeader = () => {
    setHeaderState();
    window.addEventListener("scroll", setHeaderState, { passive: true });
  };

const wireNavDrawer = () => {
  if (navToggle) navToggle.addEventListener("click", toggleNavDrawer);
  if (navCloseBtn) navCloseBtn.addEventListener("click", closeNavDrawer);

  // Close drawer after clicking any link inside it
  if (navDrawer) {
    navDrawer.addEventListener("click", (e) => {
      const a = e.target.closest("a[href]");
      if (a) closeNavDrawer();
    });
  }

  // Backdrop closes drawer
  if (navBackdrop) {
    navBackdrop.addEventListener("click", (e) => {
      e.preventDefault();
      closeNavDrawer();
    });
  }
};


function initAccountDropdown() {
  const chip = qs('[data-ui="acct-chip"]');
  const menu = qs('[data-ui="acct-menu"]');
  const signOutBtn = qs('[data-ui="acct-signout"]');

  if (!chip || !menu) return;

  // ✅ Desktop detection that won't break when DevTools changes viewport width
  const isActuallyVisible = (el) => {
    if (!el) return false;
    if (el.hidden) return false;
    const cs = window.getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0";
  };

  const closeMenu = () => {
    menu.hidden = true;
    menu.setAttribute("aria-hidden", "true");
    chip.setAttribute("aria-expanded", "false");
  };

  const openMenu = () => {
    // ✅ don’t open when logged out / hidden by CSS
    if (chip.hidden) return;
    if (!isActuallyVisible(chip)) return;

    menu.hidden = false;
    menu.style.display = ""; // defeats any leftover inline display:none
    menu.removeAttribute("aria-hidden");
    chip.setAttribute("aria-expanded", "true");
  };

  const toggleMenu = (e) => {
    e.preventDefault();
    e.stopPropagation(); // ✅ prevents any outer click logic from instantly closing it

    if (chip.hidden) return;
    if (!isActuallyVisible(chip)) return;

    if (menu.hidden) openMenu();
    else closeMenu();
  };

  chip.setAttribute("aria-haspopup", "menu");
  chip.setAttribute("aria-expanded", "false");
  closeMenu();

  // ✅ Avoid double-binding if script reloads
  if (!chip.dataset.bound) {
    chip.dataset.bound = "1";
    chip.addEventListener("click", toggleMenu);
  }

  // Click outside closes
  document.addEventListener("click", (e) => {
    if (menu.hidden) return;
    const t = e.target;
    if (chip.contains(t) || menu.contains(t)) return;
    closeMenu();
  });

  // Escape closes
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });

  // Sign out
  signOutBtn?.addEventListener("click", async () => {
    const sb = window.supabaseClient || window.supabase;
    if (!sb?.auth) return;

    closeMenu();
    try {
      await sb.auth.signOut();
    } catch {}

    window.location.href = "catalogue.html";
  });

  // If chip becomes hidden (logout), force menu closed
  const observer = new MutationObserver(() => {
    if (chip.hidden) closeMenu();
  });
  observer.observe(chip, { attributes: true, attributeFilter: ["hidden"] });
}



const outsideClickClose = (e) => {
  // Close filters drawer if click backdrop
  if (backdrop && !backdrop.hidden && e.target === backdrop) {
    closeDrawer();
    return;
  }

  // Close nav drawer if click backdrop
  if (navBackdrop && !navBackdrop.hidden && e.target === navBackdrop) {
    closeNavDrawer();
    return;
  }

  // Optional: click outside drawer closes it (premium feel)
  if (isNavOpen()) {
    const clickedToggle = navToggle && navToggle.contains(e.target);
    const clickedDrawer = navDrawer && navDrawer.contains(e.target);
    if (!clickedToggle && !clickedDrawer) {
      closeNavDrawer();
      return;
    }
  }
};

  /* =========================
     Initial context from URL
  ========================= */
  const initFromURL = () => {
    readStateFromURL();
    syncControlsFromState();

    // Ensure drawer chip visuals reflect URL state
    chipGrids.forEach((gridEl) => {
      const key = gridEl.dataset.filter;
      const set = state[key] instanceof Set ? state[key] : new Set();
      qsa(".chip", gridEl).forEach((btn) => {
        const val = btn.dataset.value;
        btn.classList.toggle("is-active", set.has(val));
      });
    });

    // If URL has min/max, reflect it
    if (minPriceInput) minPriceInput.value = state.minPrice;
    if (maxPriceInput) maxPriceInput.value = state.maxPrice;

    // Sort reflect
    if (sortSel) sortSel.value = state.sort;

    // Search reflect
    if (qInput) qInput.value = state.q;
  };

  /* =========================
     Popstate (back/forward)
  ========================= */
  const wirePopstate = () => {
    window.addEventListener("popstate", () => {
      readStateFromURL();
      syncControlsFromState();
      render();
    });
  };

  /* =========================
     Boot
  ========================= */
  const initYear = () => {
    if (!yearEl) return;
    yearEl.textContent = String(new Date().getFullYear());
  };

    const init = async () => {
    document.addEventListener("keydown", handleEscape);
    document.addEventListener("click", outsideClickClose);

    wireHeader();
    wireNavDrawer();


    wireDrawerChips();
    wirePricePresets();
    wireInputs();
    wireGlobalClicks();
    wirePopstate();

    initYear();

    initAuthUI();

    initAccountDropdown();

    // Load live catalog first (so filters/sorting render against real data)
    try {
      if (grid) grid.innerHTML = ""; // clean slate
      if (resultsCount) resultsCount.textContent = "…";
      if (resultsCountInline) resultsCountInline.textContent = "…";
      await loadCatalog();
    } catch (err) {
      console.error(err);
      toast("Could not load catalog.");
      PRODUCTS = []; // keep empty rather than demo
    }

    // Initialize from URL then render
    initFromURL();

    // Normalize URL params
    writeURLFromState(true);

    initSpotTicker();

    render();
  };


  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
