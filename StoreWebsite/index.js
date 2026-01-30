// index.js — OG Jewelers Storefront (V2)
// Matches your provided index.html (data-ui + data-action hooks).
// Fixes: search backdrop, X close reliability, close-before-navigate to shop.

console.log("✅ index.js LOADED — storefront v2:", new Date().toISOString());

/* =========================
   Tiny helpers
========================= */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function setAriaHidden(el, hidden) {
  if (!el) return;
  el.setAttribute("aria-hidden", hidden ? "true" : "false");
}

function lockScroll(on) {
  document.documentElement.classList.toggle("lock", on);
  document.body.classList.toggle("lock", on);
}

/* =========================
   UI refs (match your HTML)
========================= */
const ui = {
  year: $('[data-ui="year"]'),

  notice: $('[data-ui="top-notice"]'),

  drawer: $('[data-ui="drawer"]'),
  drawerBackdrop: $('[data-ui="drawer-backdrop"]'),

  modal: $('[data-ui="quickview"]'),
  modalBackdrop: $('[data-ui="modal-backdrop"]'),

  search: $('[data-ui="search"]'),
  searchInput: $('[data-ui="search-input"]'),

  featuredGrid: $('[data-ui="featured-grid"]'),

  qv: {
    title: $('[data-ui="qv-title"]'),
    img: $('[data-ui="qv-img"]'),
    badges: $('[data-ui="qv-badges"]'),
    h: $('[data-ui="qv-h"]'),
    p: $('[data-ui="qv-p"]'),
    price: $('[data-ui="qv-price"]'),
    link: $('[data-ui="qv-link"]'),
    note: $('[data-ui="qv-note"]'),
  },
};

/* =========================
   State
========================= */
const state = {
  mood: "noir", // noir | warm
  moodKey: "og_mood_v1",

  noticeDismissedKey: "og_notice_dismissed_v1",

  featured: [
    {
      slot: "featured.1",
      title: "Diamond Ring",
      subtitle: "A statement in every angle.",
      price: "$2,999",
      badges: ["New"],
      img: "assets/featured/diamond-ring.jpg",
      link: "catalogue.html",
    },
    {
      slot: "featured.2",
      title: "Gold Chain",
      subtitle: "Polished links, premium weight.",
      price: "$1,799",
      badges: ["Best Value"],
      img: "assets/featured/gold-chain.jpg",
      link: "catalogue.html",
    },
    {
      slot: "featured.3",
      title: "Luxury Watch",
      subtitle: "Timepiece with presence.",
      price: "$9,499",
      badges: ["Limited"],
      img: "assets/featured/luxury-watch.jpg",
      link: "catalogue.html",
    },
    {
      slot: "featured.4",
      title: "Diamond Necklace",
      subtitle: "Clean sparkle, camera-ready.",
      price: "$4,599",
      badges: ["OG Pick"],
      img: "assets/featured/diamond-necklace.jpg",
      link: "catalogue.html",
    },
  ],
};

/* =========================
   Search Backdrop (created in JS)
========================= */
let searchBackdrop = null;

function ensureSearchBackdrop() {
  if (!ui.search) return null;

  if (searchBackdrop && document.body.contains(searchBackdrop)) return searchBackdrop;

  searchBackdrop = document.createElement("div");
  searchBackdrop.id = "search-backdrop";
  // Re-use your existing blur backdrop class (same as drawer)
  searchBackdrop.className = "drawer-backdrop";
  searchBackdrop.hidden = true;

  // Click backdrop closes search
  searchBackdrop.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeSearch();
  });

  document.body.appendChild(searchBackdrop);
  return searchBackdrop;
}

function isSearchOpen() {
  return !!ui.search && !ui.search.hasAttribute("hidden");
}

function openSearch() {
  if (!ui.search) return;

  ui.search.removeAttribute("hidden");
  setAriaHidden(ui.search, false);
  lockScroll(true);

  // Focus input
  setTimeout(() => ui.searchInput?.focus({ preventScroll: true }), 30);
}

function closeSearch() {
  if (!ui.search) return;

  ui.search.setAttribute("hidden", "");
  setAriaHidden(ui.search, true);

  lockScroll(false);
}

/* =========================
   Storefront published content loader
========================= */
const SUPABASE_PROJECT_URL =
  window.SUPABASE_URL || "https://byhytmarmigalvawkedi.supabase.co";

const STOREFRONT_CONTENT_FN = "storefront-content";
const STOREFRONT_CATALOG_FN = "storefront-catalog";
const CHANNEL = "og_main";

const INV_PREFIX = "__inv__:";
const FALLBACK_IMAGE = "assets/collections/chains.jpg";

const invState = {
  loaded: false,
  map: new Map(), // id -> {id,name,price,image}
};

const fiveMinBucket = () => Math.floor(Date.now() / 300000);

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

function mapStoreItemToInv(it) {
  return {
    id: String(it.item_type_id),
    name: String(it.title || ""),
    price: toNum(it.display_price),
    image: it.image_url || FALLBACK_IMAGE,
  };
}

async function loadInventoryMapForBindings() {
  try {
    const t = fiveMinBucket();
    const url = `${SUPABASE_PROJECT_URL}/functions/v1/${STOREFRONT_CATALOG_FN}?channel=${encodeURIComponent(CHANNEL)}&t=${t}`;
    const res = await fetch(url, { method: "GET", cache: "no-store" });
    if (!res.ok) return;

    const data = await res.json().catch(() => ({}));
    const items = Array.isArray(data?.items) ? data.items : [];
    const inv = items.map(mapStoreItemToInv).filter((x) => x.id && x.name);

    invState.map = new Map(inv.map((x) => [x.id, x]));
    invState.loaded = true;
  } catch {}
}

function formatUSD(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v);
}

function applyInventoryToSlot(slotRoot, itemId) {
  const it = invState.map.get(String(itemId));
  if (!it || !slotRoot) return;

  // image
  if (slotRoot.style?.getPropertyValue("--img") !== undefined) {
    slotRoot.style.setProperty("--img", `url("${it.image}")`);
  }
  if (slotRoot.tagName === "IMG") {
    slotRoot.src = it.image;
  } else {
    const img =
      slotRoot.querySelector('[data-bind="image"]') ||
      slotRoot.querySelector(".product-media img") ||
      slotRoot.querySelector("img");
    if (img) img.src = it.image;
  }

  // title
  const titleEl =
    slotRoot.querySelector('[data-bind="title"]') ||
    slotRoot.querySelector(".product-title") ||
    slotRoot.querySelector("h1,h2,h3,h4");
  if (titleEl) titleEl.textContent = it.name;

  // price
  const priceEl =
    slotRoot.querySelector('[data-bind="price"]') ||
    slotRoot.querySelector(".product-price") ||
    slotRoot.querySelector(".price");
  if (priceEl) priceEl.textContent = formatUSD(it.price);
}

function getFeaturedGroupKey(slot) {
  const s = String(slot || "");
  const m = s.match(/^(featured\.\d+)(?:\..+)?$/i);
  return m ? m[1] : null;
}

function getGroupSlotElements(groupKey) {
  if (!groupKey) return [];
  const exact = document.querySelector(`[data-slot="${groupKey}"]`);
  const children = $$( `[data-slot^="${groupKey}."]` );
  return exact ? [exact, ...children] : children;
}

function applyPublishedContentMap(content) {
  Object.entries(content || {}).forEach(([slot, entry]) => {
    const el = document.querySelector(`[data-slot="${slot}"]`);
    if (!el || !entry) return;

    // Inventory marker
    if (entry.type === "text" && typeof entry.value === "string" && entry.value.startsWith(INV_PREFIX)) {
      const id = entry.value.slice(INV_PREFIX.length);

      // If this is featured.X.*, sync the whole card group
      const groupKey = getFeaturedGroupKey(slot);
      if (groupKey) {
        const groupEls = getGroupSlotElements(groupKey);
        groupEls.forEach((ge) => applyInventoryToSlot(ge, id));
        return;
      }

      // Otherwise bind just this element
      applyInventoryToSlot(el, id);
      return;
    }

    if (entry.type === "text") el.textContent = entry.value;

    if (entry.type === "image") {
      if (el.tagName === "IMG") el.src = entry.value;
      else el.style?.setProperty("--img", `url("${entry.value}")`);
    }
  });
}

async function loadPublishedStorefrontContent() {
  try {
    // load inventory first so __inv__ markers can hydrate immediately
    await loadInventoryMapForBindings();

    const t = fiveMinBucket();
    const url = `${SUPABASE_PROJECT_URL}/functions/v1/${STOREFRONT_CONTENT_FN}?channel=${encodeURIComponent(CHANNEL)}&t=${t}`;
    const res = await fetch(url, { method: "GET", cache: "no-store" });
    if (!res.ok) return;

    const data = await res.json().catch(() => ({}));
    if (!data?.ok || !data?.content) return;

    applyPublishedContentMap(data.content);
  } catch {}
}


/* =========================
   Drawer (mobile)
========================= */
function isDrawerOpen() {
  return !!ui.drawer && !ui.drawer.hasAttribute("hidden");
}

function openDrawer() {
  if (!ui.drawer || !ui.drawerBackdrop) return;

  ui.drawer.removeAttribute("hidden");
  ui.drawerBackdrop.removeAttribute("hidden");
  setAriaHidden(ui.drawer, false);
  lockScroll(true);

const first = $("a, button", ui.drawer);

  first?.focus({ preventScroll: true });
}

function closeDrawer() {
  if (!ui.drawer || !ui.drawerBackdrop) return;

  ui.drawer.setAttribute("hidden", "");
  ui.drawerBackdrop.setAttribute("hidden", "");
  setAriaHidden(ui.drawer, true);
  lockScroll(false);
}

/* =========================
   Quick View modal
========================= */
let lastFocusEl = null;

function isModalOpen() {
  return !!ui.modal && !ui.modal.hasAttribute("hidden");
}

function openQuickview(payload) {
  if (!ui.modal || !ui.modalBackdrop) return;

  lastFocusEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const p = payload || state.featured[0];

  if (ui.qv.title) ui.qv.title.textContent = "Quick View";
  if (ui.qv.h) ui.qv.h.textContent = p.title || "Featured";
  if (ui.qv.p) ui.qv.p.textContent = p.subtitle || "";
  if (ui.qv.price) ui.qv.price.textContent = p.price || "";
  if (ui.qv.link) ui.qv.link.setAttribute("href", p.link || "catalogue.html");
  if (ui.qv.img) ui.qv.img.style.setProperty("--img", `url('${p.img || ""}')`);

  if (ui.qv.badges) {
    ui.qv.badges.innerHTML = "";
    (p.badges || []).slice(0, 3).forEach((b) => {
      const span = document.createElement("span");
      span.className = "badge";
      span.textContent = b;
      ui.qv.badges.appendChild(span);
    });
  }

  ui.modal.removeAttribute("hidden");
  ui.modalBackdrop.removeAttribute("hidden");
  setAriaHidden(ui.modal, false);

  lockScroll(true);

  const closeBtn = $('[data-action="close-modal"]', ui.modal);
  closeBtn?.focus({ preventScroll: true });
}

function closeQuickview() {
  if (!ui.modal || !ui.modalBackdrop) return;

  ui.modal.setAttribute("hidden", "");
  ui.modalBackdrop.setAttribute("hidden", "");
  setAriaHidden(ui.modal, true);

  lockScroll(false);

  lastFocusEl?.focus?.({ preventScroll: true });
  lastFocusEl = null;
}

function openQuickviewFromTrigger(triggerEl) {
  const card = triggerEl.closest(".card");
  if (!card) return openQuickview();

  const slot = card.getAttribute("data-slot") || "";
  const match = state.featured.find((x) => x.slot === slot);
  openQuickview(match || state.featured[0]);
}

/* =========================
   Mood toggle
========================= */
function hydrateMood() {
  try {
    const saved = localStorage.getItem(state.moodKey);
    if (saved === "warm" || saved === "noir") state.mood = saved;
  } catch {}

  document.documentElement.setAttribute("data-mood", state.mood);
}

function toggleMood(btn) {
  state.mood = state.mood === "noir" ? "warm" : "noir";
  document.documentElement.setAttribute("data-mood", state.mood);

  try {
    localStorage.setItem(state.moodKey, state.mood);
  } catch {}

  if (btn) {
    const pressed = state.mood !== "noir";
    btn.setAttribute("aria-pressed", pressed ? "true" : "false");
    // keep text consistent
    btn.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) n.textContent = pressed ? " Mood: Warm" : " Mood: Noir";
    });
  }
}

/* =========================
   Notice persistence
========================= */
function hydrateNoticeDismissed() {
  try {
    const dismissed = localStorage.getItem(state.noticeDismissedKey);
    if (dismissed === "1") ui.notice?.setAttribute("hidden", "");
  } catch {}
}

function dismissNotice() {
  ui.notice?.setAttribute("hidden", "");
  try {
    localStorage.setItem(state.noticeDismissedKey, "1");
  } catch {}
}

/* =========================
   Collections → catalogue routing
========================= */
function wireCollectionRouting() {
  const tiles = $$(".tile[data-collection]");
  tiles.forEach((tile) => {
    const key = tile.getAttribute("data-collection");
    const a = $(".tile-hit", tile);
    if (!a || !key) return;

    const href = a.getAttribute("href") || "";
    if (href.includes("catalogue.html")) {
      a.setAttribute("href", `catalogue.html?collection=${encodeURIComponent(key)}`);
    }
  });
}

/* =========================
   Featured shuffle
========================= */
function shuffleFeatured() {
  if (!ui.featuredGrid) return;

  const cards = $$(".card", ui.featuredGrid);
  if (cards.length < 2) return;

  const shuffled = cards
    .map((el) => ({ el, r: Math.random() }))
    .sort((a, b) => a.r - b.r)
    .map((x) => x.el);

  shuffled.forEach((c) => ui.featuredGrid.appendChild(c));

  if (!prefersReducedMotion()) {
    ui.featuredGrid.classList.remove("pulse");
    void ui.featuredGrid.offsetHeight;
    ui.featuredGrid.classList.add("pulse");
    setTimeout(() => ui.featuredGrid.classList.remove("pulse"), 420);
  }
}

/* =========================
   Hydrate quickview model from DOM
========================= */
function hydrateFeaturedQuickviewModel() {
  const cards = $$(".card[data-slot^='featured.']");
  if (!cards.length) return;

  cards.forEach((card) => {
    const slot = card.getAttribute("data-slot") || "";
    if (!slot) return;

    const title = $(`[data-slot="${slot}.title"]`, card)?.textContent?.trim() || "";
    const subtitle = $(`[data-slot="${slot}.subtitle"]`, card)?.textContent?.trim() || "";
    const price = $(`[data-slot="${slot}.price"]`, card)?.textContent?.trim() || "";
    const badge = $(`[data-slot="${slot}.badge"]`, card)?.textContent?.trim() || "";

    const imgEl = $(`[data-slot="${slot}.image"]`, card);
    const styleImg = imgEl?.style?.getPropertyValue("--img") || "";
    const img = extractUrlFromCssVar(styleImg) || "";

    const idx = state.featured.findIndex((x) => x.slot === slot);
    const payload = {
      slot,
      title: title || "Featured",
      subtitle,
      price,
      badges: badge ? [badge] : [],
      img,
      link: "catalogue.html",
    };

    if (idx >= 0) state.featured[idx] = payload;
    else state.featured.push(payload);
  });
}

function extractUrlFromCssVar(cssVarVal) {
  if (!cssVarVal) return "";
  const m = cssVarVal.match(/url\((['"]?)(.*?)\1\)/i);
  return m ? m[2] : "";
}

/* =========================
   Soft reveal (optional)
========================= */
function setupReveal() {
  if (prefersReducedMotion()) return;
  if (!("IntersectionObserver" in window)) return;

  const targets = $$(".section, .hero, .footer");
  targets.forEach((el) => el.classList.add("reveal"));

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((ent) => {
        if (ent.isIntersecting) {
          ent.target.classList.add("in");
          io.unobserve(ent.target);
        }
      });
    },
    { threshold: 0.12 }
  );

  targets.forEach((el) => io.observe(el));
}

/* =========================
   Focus trap basics
========================= */
function trapTabFocusSetup() {
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;

    const trapRoot = getTopTrapRoot();
    if (!trapRoot) return;

    const focusables = getFocusable(trapRoot);
    if (!focusables.length) return;

    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return;

    if (e.shiftKey) {
      if (active === first) {
        e.preventDefault();
        last.focus({ preventScroll: true });
      }
    } else {
      if (active === last) {
        e.preventDefault();
        first.focus({ preventScroll: true });
      }
    }
  });
}

function getTopTrapRoot() {
  if (isModalOpen()) return ui.modal;
  if (isSearchOpen()) return ui.search;
  if (isDrawerOpen()) return ui.drawer;
  return null;
}

function getFocusable(root) {
  const selectors = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  return $$(selectors, root).filter((el) => {
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  });
}

/* =========================
   Global click/key handling
========================= */
function onClick(e) {
  // 1) data-action buttons (your primary wiring)
  const btn = e.target.closest("[data-action]");
  if (btn) {
    const action = btn.getAttribute("data-action");

    switch (action) {
      case "dismiss-notice":
        e.preventDefault();
        dismissNotice();
        return;

      case "open-menu":
        e.preventDefault();
        openDrawer();
        return;

case "close-menu": {
  // If it's an anchor (Collections/Featured/Story), let it navigate after closing.
  const href = btn.getAttribute("href") || "";
  const isAnchor = href.startsWith("#");

  e.preventDefault();
  closeDrawer();

  // If it's an in-page anchor, jump after close.
  if (isAnchor) {
    // use rAF so the drawer hides first, then scroll happens reliably
    requestAnimationFrame(() => {
      const target = document.querySelector(href);
      if (target) target.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
      // also update URL hash (optional but nice)
      history.replaceState(null, "", href);
    });
  }

  return;
}


      case "open-quickview":
        e.preventDefault();
        openQuickviewFromTrigger(btn);
        return;

      case "close-modal":
        e.preventDefault();
        closeQuickview();
        return;

      case "open-search":
        e.preventDefault();
        openSearch();
        return;

      case "close-search":
        e.preventDefault();
        closeSearch();
        return;

      case "toggle-mood":
        e.preventDefault();
        toggleMood(btn);
        return;

      case "shuffle-featured":
        e.preventDefault();
        shuffleFeatured();
        return;

      default:
        break;
    }
  }

  // 2) Backdrops close their layers
  if (e.target === ui.drawerBackdrop) {
    e.preventDefault();
    closeDrawer();
    return;
  }
  if (e.target === ui.modalBackdrop) {
    e.preventDefault();
    closeQuickview();
    return;
  }

  // 3) Search: hint buttons inside overlay (data-search)
  const hint = e.target.closest("[data-search]");
  if (hint && ui.search && ui.search.contains(hint)) {
    e.preventDefault();
    const q = hint.getAttribute("data-search") || "";
    if (ui.searchInput) ui.searchInput.value = q;
    closeSearch();
    window.location.href = `catalogue.html?q=${encodeURIComponent(q)}`;
    return;
  }

  // 4) If user clicks any link to catalogue while search is open, close first.
  const a = e.target.closest("a[href]");
  if (a && isSearchOpen()) {
    const href = a.getAttribute("href") || "";
    if (href.includes("catalogue.html")) {
      // Close overlay before navigating so you don't land with it on-screen
      closeSearch();
      // let navigation continue naturally
      return;
    }
  }
}

function onKeyDown(e) {
  if (e.key === "Escape") {
    if (isSearchOpen()) {
      e.preventDefault();
      closeSearch();
      return;
    }
    if (isModalOpen()) {
      e.preventDefault();
      closeQuickview();
      return;
    }
    if (isDrawerOpen()) {
      e.preventDefault();
      closeDrawer();
      return;
    }
  }

  // Enter inside search input → go to catalogue with query
  if (isSearchOpen() && e.key === "Enter") {
    const val = (ui.searchInput?.value || "").trim();
    closeSearch();
    window.location.href = val.length
      ? `catalogue.html?q=${encodeURIComponent(val)}`
      : "catalogue.html";
  }
}

/* =========================
   Boot
========================= */
init();

async function init() {
  // Footer year
  if (ui.year) ui.year.textContent = String(new Date().getFullYear());

  // Wire global handlers
  document.addEventListener("click", onClick, { passive: false });

// Click outside the search shell closes search
ui.search?.addEventListener("click", (e) => {
  if (e.target === ui.search) closeSearch();
});

  document.addEventListener("keydown", onKeyDown);

  // Focus trapping
  trapTabFocusSetup();

  // Optional: reveals
  setupReveal();

  // Mood + routing + quickview
  hydrateMood();
  wireCollectionRouting();

    // Load published storefront content first (so DOM slots reflect live data)
  await loadPublishedStorefrontContent();

  hydrateFeaturedQuickviewModel();

  // Notice persistence
  hydrateNoticeDismissed();
}
