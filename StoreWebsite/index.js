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
   Toast (Phase 6B)
========================= */
let toastTimer = null;

function toast(msg, ms = 1600) {
  const el = document.querySelector(".toast");
  if (!el) return;

  el.textContent = String(msg || "");
  el.hidden = false;

  // simple show class if you have styling for it; safe if you don't
  el.classList.add("show");

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    el.hidden = true;
  }, ms);
}

/* =========================
   UI refs (match your HTML)
========================= */
const ui = {
  year: $('[data-ui="year"]'),



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
   Featured favorites UI sync
========================= */
function getFavoriteButtonName(btn) {
  const card = btn?.closest(".card");
  const title =
    card?.querySelector(".card-title")?.textContent?.trim() ||
    card?.getAttribute("data-slot") ||
    "item";
  return title;
}

function syncFavoriteButtonUI(btn) {
  if (!btn) return;

  const pressed = btn.getAttribute("aria-pressed") === "true";
  const icon = btn.querySelector(".fav-toggle-icon");
  const itemName = getFavoriteButtonName(btn);

  if (icon) {
    icon.textContent = pressed ? "♥" : "♡";
  } else {
    btn.textContent = pressed ? "♥" : "♡";
  }

  btn.setAttribute(
    "aria-label",
    pressed
      ? `Remove ${itemName} from favorites`
      : `Add ${itemName} to favorites`
  );

  btn.setAttribute(
    "title",
    pressed ? "Remove from favorites" : "Add to favorites"
  );
}

function syncAllFavoriteButtons(root = document) {
  $$('[data-action="toggle-fav"]', root).forEach(syncFavoriteButtonUI);
}

function initFavoriteButtonsUI() {
  syncAllFavoriteButtons();

  const favButtons = $$('[data-action="toggle-fav"]');

  favButtons.forEach((btn) => {
    const observer = new MutationObserver(() => {
      syncFavoriteButtonUI(btn);
    });

    observer.observe(btn, {
      attributes: true,
      attributeFilter: ["aria-pressed", "class"]
    });
  });

  document.addEventListener("click", (e) => {
    const btn = e.target.closest('[data-action="toggle-fav"]');
    if (!btn) return;

    requestAnimationFrame(() => {
      syncFavoriteButtonUI(btn);
    });
  });
}

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
  // stamp the DOM so quickview knows what inventory id it represents
  if (slotRoot && slotRoot.dataset) slotRoot.dataset.itemId = String(itemId);
  const cardRoot =
    (typeof slotRoot.matches === "function" && slotRoot.matches(".card") && slotRoot) ||
    slotRoot.closest?.(".card") ||
    null;
  const favBtn = cardRoot?.querySelector('[data-action="toggle-fav"]');
  if (favBtn) favBtn.dataset.id = String(itemId);

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
let activeQuickviewId = null;

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
  if (!card) {
    activeQuickviewId = null;
    return openQuickview();
  }

  // If inventory hydrated this card, prefer that (real id/price/image)
  const invId = card.dataset.itemId;
  const inv = invId ? invState.map.get(String(invId)) : null;

  if (inv) {
    activeQuickviewId = String(inv.id);

    openQuickview({
      slot: card.getAttribute("data-slot") || "",
      title: inv.name,
      subtitle: "Featured pick",
      price: formatUSD(inv.price),
      badges: ["Featured"],
      img: inv.image,
      link: "catalogue.html",
    });
    return;
  }

  // fallback to static featured state
  const slot = card.getAttribute("data-slot") || "";
  const match = state.featured.find((x) => x.slot === slot);
  activeQuickviewId = null;
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
   Account dropdown
========================= */

function initAccountDropdown() {
  const chip = document.querySelector('[data-ui="acct-chip"]');
  const menu = document.querySelector('[data-ui="acct-menu"]');
  const signOutBtn = document.querySelector('[data-ui="acct-signout"]');

  if (!chip || !menu) return;

  const closeMenu = () => {
    menu.hidden = true;
    chip.setAttribute("aria-expanded", "false");
  };

  const openMenu = () => {
    menu.hidden = false;
    chip.setAttribute("aria-expanded", "true");
  };

  const toggleMenu = (e) => {
    e.preventDefault(); // don’t navigate to profile on click; menu takes over
    if (menu.hidden) openMenu();
    else closeMenu();
  };

  chip.setAttribute("aria-haspopup", "menu");
  chip.setAttribute("aria-expanded", "false");

  chip.addEventListener("click", toggleMenu);

  // Close on outside click
  document.addEventListener("click", (e) => {
    if (menu.hidden) return;
    const t = e.target;
    if (chip.contains(t) || menu.contains(t)) return;
    closeMenu();
  });

  // Close on escape
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

    // Optional: send them home (keeps UX consistent)
    window.location.href = "index.html";
  });

  // If auth UI hides chip (logged out), ensure menu closes too
  const observer = new MutationObserver(() => {
    if (chip.hidden) closeMenu();
  });
  observer.observe(chip, { attributes: true, attributeFilter: ["hidden"] });
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
      case "add-to-cart":
        e.preventDefault();
        {
          // Prefer the inventory-bound id when available
          const id = activeQuickviewId;
          const addToCart = window.ogCartService?.addToCart;

          if (!id) {
            // no crash; just ignore gracefully
            return;
          }
          if (typeof addToCart !== "function") return;

          const it = invState.map.get(String(id));
          if (!it) {
            // no crash hydration: show “no longer available” path later on cart hydration
            addToCart(id, 1, 0);
            closeQuickview();
            window.ogCartBadgeRefresh?.();
            window.ogCartDrawerOpen?.();
            return;
          }

          addToCart(it.id, 1, it.price);

          closeQuickview();
          window.ogCartBadgeRefresh?.();
          window.ogCartDrawerOpen?.();

        }
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
   Account chip (session -> initials)
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
    }, 50);
  });
}

function computeInitials(user) {
  // Prefer metadata name if available; fallback to email; fallback to "M"
  const meta = user?.user_metadata || {};
  const full =
    String(meta.full_name || meta.name || "").trim();

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

async function applyAccountChip(sb) {
  const chip = document.querySelector('[data-ui="acct-chip"]');
  const initialsEl = document.querySelector('[data-ui="acct-initials"]');
  const accessPill = document.querySelector(".access-pill");

  // Drawer account row
  const drawerAccount = document.querySelector('[data-ui="drawer-account"]');
  const drawerDivider = document.querySelector('[data-ui="drawer-divider"]');
  const drawerInitials = document.querySelector('[data-ui="drawer-initials"]');
  const mobileAccess = document.querySelector('[data-ui="mobile-access"]');

  if (!chip || !initialsEl) return;

  /* ✅ HARD BASELINE (prevents “Member Access” flash)
     Hide everything that depends on auth immediately,
     then reveal the correct UI once session is known. */
  chip.hidden = true;
  if (accessPill) accessPill.style.display = "none";

  if (drawerAccount) drawerAccount.hidden = true;
  if (drawerDivider) drawerDivider.hidden = true;
  if (mobileAccess) mobileAccess.hidden = true;

  initialsEl.textContent = "";
  if (drawerInitials) drawerInitials.textContent = "";

  // Session check
  let session = null;
  try {
    const { data } = await sb.auth.getSession();
    session = data?.session || null;
  } catch {}

  if (session?.user) {
    const initials = computeInitials(session.user);

    // Desktop/header chip
    initialsEl.textContent = initials;
    chip.hidden = false;
    if (accessPill) accessPill.style.display = "none";

    // Drawer account row (mobile)
    if (drawerInitials) drawerInitials.textContent = initials;
    if (drawerAccount) drawerAccount.hidden = false;
    if (drawerDivider) drawerDivider.hidden = false;

    // Logged in => hide Member Access link in drawer
    if (mobileAccess) mobileAccess.hidden = true;
  } else {
    // Logged out => show Member Access
    chip.hidden = true;
    if (accessPill) accessPill.style.display = "";

    // Drawer
    if (drawerAccount) drawerAccount.hidden = true;
    if (drawerDivider) drawerDivider.hidden = true;
    if (mobileAccess) mobileAccess.hidden = false;
  }
}


async function initAccountChip() {
  const sb = await waitForSupabaseReady();
  if (!sb) return;

  // First paint
  await applyAccountChip(sb);

  // Keep in sync
  sb.auth.onAuthStateChange(() => {
    applyAccountChip(sb);
  });
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
initFavoriteButtonsUI();
  initAccountChip();

  initAccountDropdown();

}
/* =========================
   eBay Live homepage section
   Dynamic source: Supabase Edge Function
   - Filters past events
   - Auto sorts upcoming events
   - Shows LIVE NOW badge
   - Limits homepage to 4 cards
========================= */

const EBAY_LIVE_FN_URL =
  "https://byhytmarmigalvawkedi.supabase.co/functions/v1/ebay-live-events";
const EBAY_LIVE_DEBUG =
  location.hostname === "localhost" ||
  location.hostname === "127.0.0.1" ||
  location.hostname.endsWith(".local");
function ebayEsc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseSortableEbayDate(eventOrLabel) {
  if (eventOrLabel && typeof eventOrLabel === "object") {
    if (eventOrLabel.startsAtIso) {
      const isoDate = new Date(eventOrLabel.startsAtIso);
      if (!Number.isNaN(isoDate.getTime())) return isoDate;
    }

    eventOrLabel = eventOrLabel.dateLabel || "";
  }

  const raw = String(eventOrLabel || "").trim();
  if (!raw) return null;

  const match = raw.match(
    /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s+(AM|PM)$/i
  );
  if (!match) return null;

  const [, monRaw, dayStr, hourStr, minStr, ampm] = match;

  const monthMap = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
  };

  const month = monthMap[monRaw.toLowerCase()];
  if (month == null) return null;

  let hour = Number(hourStr);
  const minute = Number(minStr);
  const day = Number(dayStr);

  if (ampm.toUpperCase() === "PM" && hour !== 12) hour += 12;
  if (ampm.toUpperCase() === "AM" && hour === 12) hour = 0;

  const now = new Date();
  let year = now.getFullYear();

  let dt = new Date(year, month, day, hour, minute, 0, 0);

  const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;
  if (now.getTime() - dt.getTime() > SIXTY_DAYS_MS) {
    year += 1;
    dt = new Date(year, month, day, hour, minute, 0, 0);
  }

  return Number.isNaN(dt.getTime()) ? null : dt;
}

function isEventLiveNow(event) {
  const eventDate = parseSortableEbayDate(event);
  if (!eventDate) return false;

  const now = new Date();
  const start = eventDate.getTime();
  const LIVE_WINDOW_MS = 2 * 60 * 60 * 1000;
  const diff = now.getTime() - start;

  return diff >= 0 && diff <= LIVE_WINDOW_MS;
}

function formatDisplayDate(event) {
  const parsed = parseSortableEbayDate(event);
  if (!parsed) return String(event?.dateLabel || "");

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(parsed);
}

function debugEbayLiveEvents(events) {
  if (!EBAY_LIVE_DEBUG) return;

  const rows = (Array.isArray(events) ? events : []).map((event) => {
    const parsed = parseSortableEbayDate(event);

    return {
      title: event?.title || "",
      status: event?.status || "",
      sourceDateLabel: event?.dateLabel || "",
      startsAtIso: event?.startsAtIso || "",
      sourceTimezone: event?.timezone || "",
      viewerTimeZone:
        Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      localDisplay: parsed
        ? new Intl.DateTimeFormat(undefined, {
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            timeZoneName: "short"
          }).format(parsed)
        : "(unparsed)",
      epochMs: parsed ? parsed.getTime() : null,
      isLiveNow: event?.status === "live" || isEventLiveNow(event),
    };
  });

  console.groupCollapsed("[eBay Live] Event time debug");
  console.table(rows);
  console.groupEnd();
}

function filterAndSortUpcomingEvents(events) {
  const now = new Date();

  const mapped = (Array.isArray(events) ? events : []).map((event) => {
    const parsedDate = parseSortableEbayDate(event);
    const liveNow = event?.status === "live" || isEventLiveNow(event);

    return {
      ...event,
      __parsedDate: parsedDate,
      __isLiveNow: liveNow,
    };
  });

  const filtered = mapped.filter((event) => {
    if (event.__isLiveNow) return true;
    if (!event.__parsedDate) return false;
    return event.__parsedDate.getTime() >= now.getTime();
  });

  filtered.sort((a, b) => {
    if (a.__isLiveNow && !b.__isLiveNow) return -1;
    if (!a.__isLiveNow && b.__isLiveNow) return 1;

    const aTime = a.__parsedDate ? a.__parsedDate.getTime() : Number.MAX_SAFE_INTEGER;
    const bTime = b.__parsedDate ? b.__parsedDate.getTime() : Number.MAX_SAFE_INTEGER;

    return aTime - bTime;
  });

  return filtered;
}

function renderEbayLiveEvents(events) {
  const grid = document.getElementById("ebay-live-grid");
  if (!grid) return;

  const list = filterAndSortUpcomingEvents(events).slice(0, 4);

  if (!list.length) {
    grid.innerHTML = `
      <div class="ebay-live-empty">
        No upcoming live shows are scheduled right now.
      </div>
    `;
    return;
  }

  grid.innerHTML = list.map((event) => {
    const title = ebayEsc(event.title || "Upcoming eBay Live");
    const seller = ebayEsc(event.seller || "ogjewelers");
    const dateLabel = ebayEsc(formatDisplayDate(event));
    const image = ebayEsc(event.image || "OG-Jewelers.webp");
    const url = ebayEsc(event.url || "https://www.ebay.com/ebaylive/sellers/lertro4xscs");
    const liveBadge = (event.status === "live" || event.__isLiveNow)
      ? `<span class="ebay-live-now-badge">LIVE NOW</span>`
      : "";

    return `
      <a
        class="ebay-live-card"
        href="${url}"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Open eBay Live event: ${title}"
      >
        <div class="ebay-live-thumb">
          <img src="${image}" alt="${title}" loading="lazy" />
          <span class="ebay-live-date">${dateLabel}</span>
          ${liveBadge}
        </div>

        <div class="ebay-live-body">
          <div class="ebay-live-seller">${seller}</div>
          <h3 class="ebay-live-title">${title}</h3>
          <div class="ebay-live-link">
            Save on eBay <span aria-hidden="true">→</span>
          </div>
        </div>
      </a>
    `;
  }).join("");
}

async function loadEbayLiveEvents() {
  const grid = document.getElementById("ebay-live-grid");
  if (!grid) return;

  try {
    grid.innerHTML = `
      <div class="ebay-live-empty">
        Loading upcoming eBay Live events…
      </div>
    `;

    const res = await fetch(EBAY_LIVE_FN_URL, {
      method: "GET",
      cache: "no-store",
    });

    if (!res.ok) {
      throw new Error(`ebay_live_fetch_failed (${res.status})`);
    }

   const data = await res.json();
const items = Array.isArray(data?.items) ? data.items : [];

debugEbayLiveEvents(items);
renderEbayLiveEvents(items);

  } catch (err) {
    console.error("Failed to load eBay Live events:", err);

    grid.innerHTML = `
      <div class="ebay-live-empty">
        We couldn’t load the upcoming live events right now.
      </div>
    `;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadEbayLiveEvents();
});