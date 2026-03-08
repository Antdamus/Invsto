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



/* =========================
   Auth UI (Member Access ↔ Initials)
   FIX: tab-switch / BFCache resilient
========================= */
/* =========================
   Auth UI (Revamped: stable across tab switches + no random disappear)
========================= */

let __og_lastKnownUser = null;

function forceLogoutUI() {
  // kill any cached user immediately so UI can’t “stick”
  __og_lastKnownUser = null;
  __og_signingOut = true;

  // desktop: hide account UI
  qsa('[data-ui="acct-initials"]').forEach((el) => (el.textContent = ""));
  qsa('[data-ui="acct-chip"]').forEach((chip) => setHardHidden(chip, true));
  qsa('[data-ui="acct-menu"]').forEach((m) => {
    m.hidden = true;
    m.setAttribute("aria-hidden", "true");
  });

  // ✅ desktop: SHOW member access when logged out
  qsa('[data-ui="access-btn"]').forEach((btn) => setHardHidden(btn, false, ""));

  // mobile: hide account wrap, show member access
  setHardHidden(qs('[data-ui="mobile-account-wrap"]'), true);
  setHardHidden(qs('[data-ui="mobile-account"]'), true);
  setHardHidden(qs('[data-ui="mobile-signout"]'), true);

  // ✅ mobile: SHOW member access when logged out
  setHardHidden(qs('[data-ui="mobile-access"]'), false, "");
}

let __og_authWiringBound = false;
let __og_signingOut = false;

// ✅ Force-hide helper (wins even if CSS uses display:flex !important)
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

// ✅ More resilient "who is logged in?" resolver.
// - Tries getSession (fast, local)
// - Falls back to getUser (also local but sometimes more reliable depending on state)
// - If both fail, returns null (but we won't instantly nuke UI if we have a cached user)
async function resolveUser(sb) {
  if (!sb?.auth) return null;

  try {
    const { data } = await sb.auth.getSession();
    const u = data?.session?.user || null;
    if (u) return u;
  } catch {}

  try {
    const { data } = await sb.auth.getUser();
    const u = data?.user || null;
    if (u) return u;
  } catch {}

  return null;
}

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

const applyAuthUI = async (sb) => {
  // ✅ Grab ALL possible matches (covers duplicated header DOM)
  const accessBtns = qsa('[data-ui="access-btn"]');
  const chips = qsa('[data-ui="acct-chip"]');
  const initialsEls = qsa('[data-ui="acct-initials"]');
  const acctMenus = qsa('[data-ui="acct-menu"]');

  // Mobile drawer
  const mobileAccess = qs('[data-ui="mobile-access"]');
  const mobileAccountWrap = qs('[data-ui="mobile-account-wrap"]');
  const mobileAccount = qs('[data-ui="mobile-account"]');
  const mobileInitials = qs('[data-ui="mobile-initials"]');
  const mobileSignOutBtn = qs('[data-ui="mobile-signout"]');

  // ✅ Baseline: hide dropdown menu always until user clicks chip
  acctMenus.forEach((menu) => {
    if (!menu) return;
    menu.hidden = true;
    menu.setAttribute("aria-hidden", "true");
    menu.style.display = "";
  });

  // We'll resolve auth state:
  const freshUser = await resolveUser(sb);

  // ✅ Cache behavior:
  // If we got a real user -> cache it.
  // If we didn't get a user due to a transient auth hiccup,
  // do NOT blow away UI if we *previously* knew the user.
  if (freshUser) {
    __og_lastKnownUser = freshUser;
  } else if (__og_signingOut) {
    // if user is signing out, allow clearing UI
    __og_lastKnownUser = null;
  }

  const user = freshUser || __og_lastKnownUser;

  // ✅ Render based on "best known" user
  if (user) {
    const initials = computeInitials(user);

    initialsEls.forEach((el) => (el.textContent = initials));
    if (mobileInitials) mobileInitials.textContent = initials;

    chips.forEach((chip) => setHardHidden(chip, false));
    setHardHidden(mobileAccess, true);
    setHardHidden(mobileAccountWrap, false);
    setHardHidden(mobileAccount, false);
    setHardHidden(mobileSignOutBtn, false);

    // Logged in: hide Member Access
accessBtns.forEach((btn) => setHardHidden(btn, true));
setHardHidden(mobileAccess, true);

  } else {
    // Logged out (or truly no session)
    initialsEls.forEach((el) => (el.textContent = ""));
    if (mobileInitials) mobileInitials.textContent = "";

    // Logged out: show Member Access
accessBtns.forEach((btn) => setHardHidden(btn, false, ""));
setHardHidden(mobileAccess, false, "");


    chips.forEach((chip) => setHardHidden(chip, true));

    // keep hidden when logged out (your preference)
    setHardHidden(mobileAccess, true);
    setHardHidden(mobileAccountWrap, true);
    setHardHidden(mobileAccount, true);
    setHardHidden(mobileSignOutBtn, true);
  }
};

const initAuthUI = async () => {
  const sb = await waitForSupabaseReady();
  if (!sb) return;

  // Paint now
  await applyAuthUI(sb);

  // Auth changes (real signal)
  sb.auth.onAuthStateChange(async (_event) => {
    __og_signingOut = false; // reset unless our handler set it
    await applyAuthUI(sb);
  });

  // Bind rehydrate wiring once
  if (!__og_authWiringBound) {
    __og_authWiringBound = true;

    // BFCache restore
    window.addEventListener("pageshow", async (e) => {
      // if persisted, this is a BFCache restore — rehydrate
      if (e.persisted) await applyAuthUI(sb);
      else await applyAuthUI(sb);
    });

    // Tab becomes visible again
    document.addEventListener("visibilitychange", async () => {
      if (document.visibilityState === "visible") {
        await applyAuthUI(sb);
      }
    });

    // Cross-tab sign-in/out sync
    window.addEventListener("storage", async () => {
      await applyAuthUI(sb);
    });
  }

  // ✅ Ensure mobile signout always works (waits for SB inside handler)
qsa('[data-ui="mobile-signout"]').forEach((btn) => {
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = "1";

  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    forceLogoutUI();

    try {
      const sb2 = await waitForSupabaseReady();
      await sb2?.auth?.signOut?.();
    } catch {}

    const bust = Date.now();
    window.location.replace(`catalogue.html?logout=1&bust=${bust}`);
  });
});

};



  // This becomes the live dataset (replaces demo PRODUCTS)
  let PRODUCTS = [];

  const fiveMinBucket = () => Math.floor(Date.now() / 300000); // 5 min
  const toNum = (x) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : 0;
  };

  // Map RPC item -> UI product shape used by the existing UI logic
// Map RPC item -> UI product shape used by the existing UI logic
const mapStoreItemToProduct = (it) => {
  const normalizeToken = (v) =>
    String(v || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "_");

  const catsRaw = Array.isArray(it.categories) ? it.categories : [];
  const categories = catsRaw
    .map(normalizeToken)
    .filter(Boolean);

  const primaryCategory = categories[0] || "all";

  const tags = Array.isArray(it.badge_flags) ? it.badge_flags.map(normalizeToken).filter(Boolean) : [];

  const material = normalizeToken(it.material || "");

  return {
  id: String(it.item_type_id),
  name: String(it.title || ""),
  description: String(it.description || ""),          // ✅ NEW (for quick view)
  remaining_count: Number(it.remaining_count),        // ✅ NEW (optional: later stock messaging)
  category: primaryCategory,
  categories,
  material,
  price: toNum(it.display_price),
  tags,
  created_at: new Date().toISOString(),
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

  const hudWrap = qs('[data-ui="catalogue-hud"]');
  const hudPanel = qs('[data-ui="catalogue-hud-panel"]');
  const hudToggle = qs('[data-action="toggle-hud"]');


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
     Quick View Modal (index-style)
  ========================= */
  const qv = qs('[data-ui="quickview"]');
  const qvBackdrop = qs('[data-ui="modal-backdrop"]');

  const qvTitle = qs('[data-ui="qv-title"]');
  const qvImg = qs('[data-ui="qv-img"]');
  const qvBadges = qs('[data-ui="qv-badges"]');
  const qvH = qs('[data-ui="qv-h"]');
  const qvP = qs('[data-ui="qv-p"]');
  const qvPrice = qs('[data-ui="qv-price"]');
  const qvLink = qs('[data-ui="qv-link"]');
  const qvAdd = qs('[data-ui="qv-add"]');

  let activeQuickviewId = null;

  const isQuickviewOpen = () => !!qv && !qv.hidden;

  const openQuickview = (item) => {
    if (!qv || !qvBackdrop || !item) return;

    activeQuickviewId = String(item.id);

    if (qvTitle) qvTitle.textContent = "Quick View";
    if (qvH) qvH.textContent = item.name || "Item";
    if (qvP) qvP.textContent = item.description || "No description yet.";
    if (qvPrice) qvPrice.textContent = formatUSD(item.price);

    if (qvImg) qvImg.style.setProperty("--img", `url("${item.image || ""}")`);

    // badges from tags (simple + consistent)
    if (qvBadges) {
      const tags = (item.tags || []).slice(0, 3);
      qvBadges.innerHTML = tags.map(t => `<span class="badge">${esc(humanize("tag", t))}</span>`).join("");
    }

    // ✅ This is the key: "View in shop" -> item page
    if (qvLink) qvLink.href = `item.html?id=${encodeURIComponent(String(item.id))}`;

    // make the modal’s Add-to-cart button reuse the existing handler
    if (qvAdd) qvAdd.dataset.id = String(item.id);

    qvBackdrop.hidden = false;
    qv.hidden = false;
    document.documentElement.style.overflow = "hidden";
  };

  const closeQuickview = () => {
    if (!qv || !qvBackdrop) return;
    qv.hidden = true;
    qvBackdrop.hidden = true;
    document.documentElement.style.overflow = "";
    activeQuickviewId = null;
  };

  
  /* =========================
     Header elevate on scroll
  ========================= */
  const setHeaderState = () => {
    if (!header) return;
    header.classList.toggle("is-elevated", (window.scrollY || 0) > 6);
  };

  /* =========================
     HUD presentation state
  ========================= */
  const HUD_IDLE_MS = 15000;
  let hudIdleTimer = null;
  let hudIntroTimer = null;
  let hudPointerInside = false;

  const isHudExpanded = () => !!hudWrap && hudWrap.classList.contains("is-expanded");
  const isDrawerOpen = () => !!drawer && !drawer.hidden;

  const hudHasFocus = () => {
    const active = document.activeElement;
    if (!active) return false;
    if (hudPanel && hudPanel.contains(active)) return true;
    if (hudToggle && hudToggle.contains(active)) return true;
    return false;
  };

  const clearHudTimers = () => {
    window.clearTimeout(hudIdleTimer);
    window.clearTimeout(hudIntroTimer);
  };

  const canHudAutoCollapse = () => {
    if (!isHudExpanded()) return false;
    if (isDrawerOpen()) return false;
    if (hudHasFocus()) return false;
    if (hudPointerInside) return false;
    return true;
  };

  const scheduleHudAutoCollapse = (delay = HUD_IDLE_MS) => {
    window.clearTimeout(hudIdleTimer);
    if (!hudWrap || !hudPanel || !isHudExpanded()) return;

    hudIdleTimer = window.setTimeout(() => {
      if (canHudAutoCollapse()) {
        setHudExpanded(false);
      } else {
        scheduleHudAutoCollapse(2200);
      }
    }, delay);
  };

  const setHudExpanded = (expanded, opts = {}) => {
    const { focusSearch = false, returnFocus = false, idleMs = HUD_IDLE_MS } = opts;
    if (!hudWrap || !hudPanel || !hudToggle) return;

    hudWrap.classList.toggle("is-expanded", !!expanded);
    hudWrap.classList.toggle("is-collapsed", !expanded);
    hudToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    hudPanel.setAttribute("aria-hidden", expanded ? "false" : "true");
    try { hudPanel.inert = !expanded; } catch {}

    if (expanded) {
      if (focusSearch && qInput) qInput.focus({ preventScroll: true });
      scheduleHudAutoCollapse(idleMs);
      return;
    }

    window.clearTimeout(hudIdleTimer);
    if (returnFocus && hudToggle) hudToggle.focus({ preventScroll: true });
  };

  const recordHudActivity = (delay = HUD_IDLE_MS) => {
    if (!hudWrap) return;

    if (!isHudExpanded()) {
      setHudExpanded(true, { idleMs: delay });
      return;
    }

    scheduleHudAutoCollapse(delay);
  };

  const initHudBehavior = () => {
    if (!hudWrap || !hudPanel || !hudToggle) return;

    // Ensure deterministic initial state classes.
    hudWrap.classList.add("is-expanded");
    hudWrap.classList.remove("is-collapsed");
    hudPanel.setAttribute("aria-hidden", "false");
    hudToggle.setAttribute("aria-expanded", "true");

    hudToggle.addEventListener("click", (e) => {
      e.preventDefault();

      if (isHudExpanded()) {
        if (isDrawerOpen()) return;
        setHudExpanded(false, { returnFocus: true });
      } else {
        setHudExpanded(true, { focusSearch: false });
      }
    });

    ["input", "change", "focusin", "keydown", "pointerdown", "click"].forEach((evt) => {
      hudPanel.addEventListener(evt, () => recordHudActivity());
    });

    hudPanel.addEventListener("mouseenter", () => {
      hudPointerInside = true;
      recordHudActivity();
    });

    hudPanel.addEventListener("mouseleave", () => {
      hudPointerInside = false;
      scheduleHudAutoCollapse(2600);
    });

    hudWrap.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (!hudHasFocus()) scheduleHudAutoCollapse(2600);
      }, 0);
    });

    const startCollapsed = window.matchMedia("(max-width: 820px)").matches;
    setHudExpanded(!startCollapsed);

    if (!startCollapsed) {
      const introDelay = prefersReducedMotion() ? 900 : 2400;
      hudIntroTimer = window.setTimeout(() => {
        if (canHudAutoCollapse()) setHudExpanded(false);
      }, introDelay);
    }
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

const buildDynamicFilterChips = () => {
  // Build unique pools from PRODUCTS
  const catSet = new Set();
  const matSet = new Set();

  PRODUCTS.forEach((p) => {
    (Array.isArray(p.categories) ? p.categories : []).forEach((c) => c && catSet.add(c));
    if (p.material) matSet.add(p.material);
  });

  const cats = Array.from(catSet).sort((a, b) => a.localeCompare(b));
  const mats = Array.from(matSet).sort((a, b) => a.localeCompare(b));

  // Render to chip grids
  const renderGrid = (key, values) => {
    const gridEl = qs(`.chip-grid[data-filter="${key}"]`);
    if (!gridEl) return;

    gridEl.innerHTML = values
      .map((v) => {
        const active = state[key] instanceof Set && state[key].has(v);
        return `<button class="chip${active ? " is-active" : ""}" type="button" data-value="${esc(v)}">${esc(humanize(key, v))}</button>`;
      })
      .join("");

    // If empty, show subtle placeholder
    if (!values.length) {
      gridEl.innerHTML = `<span class="muted" style="opacity:.8">No options available</span>`;
    }
  };

  renderGrid("category", cats);
  renderGrid("material", mats);
};


  /* =========================
     Filtering + Sorting
  ========================= */

const matchesSet = (set, value) => (set.size === 0 ? true : set.has(value));

const matchesAnyFromArray = (set, arr) => {
  if (set.size === 0) return true;
  const a = Array.isArray(arr) ? arr : [];
  return a.some((v) => set.has(v));
};

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
    // ✅ Category: match ANY category from it.categories
    if (!matchesAnyFromArray(state.category, it.categories)) return false;

    // Material: still single token per item
    if (!matchesSet(state.material, it.material)) return false;

    // Tags: match any tag
    if (!matchesTags(state.tag, it.tags)) return false;

    // Price
    if (Number.isFinite(min) && it.price < min) return false;
    if (Number.isFinite(max) && it.price > max) return false;

    // Search
    if (q) {
      const catText = Array.isArray(it.categories) ? it.categories.join(" ") : "";
      const hay = `${it.name} ${catText} ${it.material} ${(it.tags || []).join(" ")}`.toLowerCase();
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
const titleize = (v) => {
  const s = String(v || "")
    .replace(/[_-]+/g, " ")
    .trim();
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
};

const humanize = (key, val) => {
  const maps = {
    tag: { new: "New", featured: "Featured", best_value: "Best Value", limited: "Limited" },
  };
  if (maps[key] && maps[key][val]) return maps[key][val];
  return titleize(val);
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

    setHudExpanded(true);
    clearHudTimers();

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

    recordHudActivity();
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
  const displayName = String(p.name || "")
    .replace(/\b925\s*fine\s*silver\b/gi, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s\-|,\/]+|[\s\-|,\/]+$/g, "")
    .trim() || String(p.name || "");
  const href = `item.html?id=${encodeURIComponent(p.id)}`;
  const metaBits = [
    humanize("category", p.category),
    humanize("material", p.material)
  ].filter((v) => v && !["Uncategorized", "Unknown"].includes(v));
  const subtleMeta = metaBits.length ? `<div class="product-meta">${esc(metaBits[0])}</div>` : "";

  return `
    <article class="product-card" data-id="${esc(p.id)}">
      <button class="fav-toggle product-fav" type="button"
              data-action="toggle-fav"
              data-id="${esc(p.id)}"
              aria-pressed="false"
              aria-label="Add ${esc(displayName)} to favorites"
              title="Add to favorites">
        <span class="fav-toggle-icon" aria-hidden="true">&#9825;</span>
      </button>

      <a class="product-hit"
         href="${href}"
         aria-label="View details for ${esc(displayName)}">
        <div class="product-media">
          <img src="${esc(p.image)}" alt="${esc(displayName)}" loading="lazy" />
        </div>
        <div class="product-body">
          <h3 class="product-title">${esc(displayName)}</h3>
          <div class="product-price">${esc(formatUSD(p.price))}</div>
          ${subtleMeta}
        </div>
      </a>

      <div class="product-actions">
        <button class="product-cta" type="button"
                data-action="add-to-cart"
                data-id="${esc(p.id)}">
          Quick add
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

    // Only these are real state sets
    const isSetKey = key === "category" || key === "material" || key === "tag";
    if (!isSetKey) return;

    gridEl.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip");
      if (!btn) return;

      e.preventDefault();

      const val = btn.dataset.value;
      if (!val) return;

      // Toggle state
      toggleSetValue(key, val);

      // Toggle UI class
      btn.classList.toggle("is-active", state[key].has(val));

      // ✅ Instant apply behavior
      state.page = 1;
      writeURLFromState(false);
      render();
    });
  });
};


const wirePricePresets = () => {
  presetPriceBtns.forEach((b) => {
    b.addEventListener("click", (e) => {
      e.preventDefault();

      const min = (b.dataset.min ?? "").trim();
      const max = (b.dataset.max ?? "").trim();

      // Update inputs
      if (minPriceInput) minPriceInput.value = String(min);
      if (maxPriceInput) maxPriceInput.value = String(max);

      // Update state
      state.minPrice = String(min);
      state.maxPrice = String(max);

      // Safety: swap if min > max (same rule as applyDrawerToState)
      const nMin = Number(state.minPrice);
      const nMax = Number(state.maxPrice);
      if (Number.isFinite(nMin) && Number.isFinite(nMax) && nMin > nMax) {
        state.minPrice = String(nMax);
        state.maxPrice = String(nMin);
        if (minPriceInput) minPriceInput.value = state.minPrice;
        if (maxPriceInput) maxPriceInput.value = state.maxPrice;
      }

      // ✅ Apply instantly (match category/material behavior)
      state.page = 1;
      writeURLFromState(false);
      render();

      toast("Price applied.");
    });
  });
};


const wireGlobalClicks = () => {
  // Escape closes quick view
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isQuickviewOpen()) closeQuickview();
  });

  document.addEventListener("click", (e) => {
    // Backdrop closes quick view
    if (qvBackdrop && e.target === qvBackdrop && isQuickviewOpen()) {
      closeQuickview();
      return;
    }
    if (hudWrap && hudWrap.contains(e.target) && !e.target.closest('[data-action="toggle-hud"]')) {
      recordHudActivity();
    }


    // ✅ 1) Active chip removal FIRST (does not use data-action)
    const chip = e.target.closest(".active-chip");
    if (chip) {
      const key = chip.dataset.chipKey;
      const val = chip.dataset.chipValue;
      if (key) clearChip(key, val);
      return;
    }

    const el = e.target.closest("[data-action]");
    const action = el ? el.dataset.action : "";

    // Close quick view
    if (action === "close-quickview") {
      closeQuickview();
      return;
    }

    // ✅ 2) Then handle data-action clicks
    if (!el) return;

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

    if (action === "quick-view") {
      const id = el.dataset.id;
      const item = PRODUCTS.find((p) => p.id === id);
      if (item) openQuickview(item);
      return;
    }


    // Add to cart
    if (action === "add-to-cart") {
      const id = el.dataset.id;
      const item = PRODUCTS.find((p) => p.id === id);
      const currentPrice = item ? toPriceNumber(item.price) : 0;

      if (window.ogCartService && typeof window.ogCartService.addToCart === "function") {
        window.ogCartService.addToCart(id, 1, currentPrice);
        window.ogCartBadgeRefresh?.();
        window.ogCartDrawerOpen?.();
      }
      return;
    }

  
  });
};

const wirePriceInputsLive = () => {
  const applyNow = debounce(() => {
    state.minPrice = (minPriceInput?.value || "").trim();
    state.maxPrice = (maxPriceInput?.value || "").trim();

    const nMin = Number(state.minPrice);
    const nMax = Number(state.maxPrice);
    if (Number.isFinite(nMin) && Number.isFinite(nMax) && nMin > nMax) {
      state.minPrice = String(nMax);
      state.maxPrice = String(nMin);
      if (minPriceInput) minPriceInput.value = state.minPrice;
      if (maxPriceInput) maxPriceInput.value = state.maxPrice;
    }

    state.page = 1;
    writeURLFromState(false);
    render();
  }, 180);

  if (minPriceInput) minPriceInput.addEventListener("input", applyNow);
  if (maxPriceInput) maxPriceInput.addEventListener("input", applyNow);
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

// ✅ Bind ALL signout buttons (desktop + any duplicates)
qsa('[data-ui="acct-signout"]').forEach((btn) => {
  if (!btn || btn.dataset.bound) return;
  btn.dataset.bound = "1";

  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    closeMenu();
    forceLogoutUI(); // ✅ immediate UI change (no waiting)

    try {
      const sb = await waitForSupabaseReady();
      await sb?.auth?.signOut?.();
    } catch {}

    // ✅ hard reload the SAME page (cache-bust)
    const bust = Date.now();
    window.location.replace(`catalogue.html?logout=1&bust=${bust}`);
  });
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
    initHudBehavior();


    wireDrawerChips();

    wirePricePresets();
wirePriceInputsLive();

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
      buildDynamicFilterChips();
    } catch (err) {
      console.error(err);
      toast("Could not load catalog.");
      PRODUCTS = []; // keep empty rather than demo
    }

    // Initialize from URL then render
    initFromURL();

    // Normalize URL params
    writeURLFromState(true);
// ✅ clean up logout param so URLs stay pretty
try {
  const u = new URL(window.location.href);
  if (u.searchParams.has("logout")) {
    u.searchParams.delete("logout");
    try {
  const u = new URL(window.location.href);
  if (u.searchParams.has("logout")) {
    u.searchParams.delete("logout");
    u.searchParams.delete("bust");
    const qs = u.searchParams.toString();
    history.replaceState(null, "", u.pathname + (qs ? "?" + qs : ""));
  }
} catch {}

  }
} catch {}

    render();
  };


  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
