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

  const esc = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  /* =========================
     Demo data (replace later)
     - category: gold|diamonds|chains|signature
     - material: gold|silver|platinum|diamond
     - tags: array: new|featured|best_value|limited
  ========================= */
  const PRODUCTS = [
    {
      id: "p1",
      name: "Diamond Studs",
      category: "diamonds",
      material: "diamond",
      price: 650,
      tags: ["featured", "best_value"],
      created_at: "2026-01-10",
      image: "assets/featured/diamond-studs.jpg",
    },
    {
      id: "p2",
      name: "Gold Rope Chain",
      category: "chains",
      material: "gold",
      price: 1200,
      tags: ["featured"],
      created_at: "2026-01-02",
      image: "assets/featured/gold-rope.jpg",
    },
    {
      id: "p3",
      name: "Signature Pendant",
      category: "signature",
      material: "gold",
      price: 980,
      tags: ["limited", "new"],
      created_at: "2026-01-16",
      image: "assets/featured/signature-pendant.jpg",
    },
    {
      id: "p4",
      name: "Tennis Bracelet",
      category: "diamonds",
      material: "diamond",
      price: 2200,
      tags: ["featured"],
      created_at: "2025-12-18",
      image: "assets/featured/tennis-bracelet.jpg",
    },
    {
      id: "p5",
      name: "Gold Cuban Chain",
      category: "chains",
      material: "gold",
      price: 1750,
      tags: ["best_value"],
      created_at: "2025-12-28",
      image: "assets/collections/chains.jpg",
    },
    {
      id: "p6",
      name: "Classic Gold Band",
      category: "gold",
      material: "gold",
      price: 340,
      tags: ["best_value"],
      created_at: "2025-12-05",
      image: "assets/collections/gold.jpg",
    },
    {
      id: "p7",
      name: "Platinum Minimal Ring",
      category: "signature",
      material: "platinum",
      price: 1450,
      tags: ["new"],
      created_at: "2026-01-12",
      image: "assets/story/craft.jpg",
    },
    {
      id: "p8",
      name: "Silver Figaro Chain",
      category: "chains",
      material: "silver",
      price: 260,
      tags: ["best_value"],
      created_at: "2025-11-20",
      image: "assets/collections/chains.jpg",
    },
  ];

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
  const mobileMenu = qs("#mobileMenu");

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

    // Close drawer first
    if (drawer && !drawer.hidden) {
      closeDrawer();
      return;
    }

    // Close mobile menu if open
    if (mobileMenu && !mobileMenu.hidden) {
      closeMobileMenu();
    }
  };

  /* =========================
     Mobile menu
  ========================= */
  const openMobileMenu = () => {
    if (!mobileMenu || !navToggle) return;
    mobileMenu.hidden = false;
    navToggle.setAttribute("aria-expanded", "true");
    document.body.classList.add("menu-open");
  };

  const closeMobileMenu = () => {
    if (!mobileMenu || !navToggle) return;
    mobileMenu.hidden = true;
    navToggle.setAttribute("aria-expanded", "false");
    document.body.classList.remove("menu-open");
  };

  const toggleMobileMenu = () => {
    if (!mobileMenu) return;
    if (mobileMenu.hidden) openMobileMenu();
    else closeMobileMenu();
  };

  const outsideClickClose = (e) => {
    // Close drawer if click backdrop
    const isBackdrop = backdrop && !backdrop.hidden && backdrop.contains(e.target);
    if (isBackdrop) closeDrawer();

    // Close mobile menu on outside click
    if (mobileMenu && !mobileMenu.hidden) {
      const clickedToggle = navToggle && navToggle.contains(e.target);
      const clickedMenu = mobileMenu.contains(e.target);
      if (!clickedToggle && !clickedMenu) closeMobileMenu();
    }
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
    const tags = (p.tags || []).slice(0, 2).map((t) => `<span class="tag">${esc(humanize("tag", t))}</span>`).join("");
    return `
      <article class="product-card" data-id="${esc(p.id)}">
        <button class="product-hit" type="button" data-action="quick-view" data-id="${esc(p.id)}" aria-label="Quick view ${esc(p.name)}">
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

      // Quick view placeholder
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

  const wireMobileMenu = () => {
    if (navToggle) navToggle.addEventListener("click", toggleMobileMenu);

    // Close menu after clicking a link inside it
    if (mobileMenu) {
      mobileMenu.addEventListener("click", (e) => {
        const a = e.target.closest("a");
        if (!a) return;
        closeMobileMenu();
      });
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

  const init = () => {
    document.addEventListener("keydown", handleEscape);
    document.addEventListener("click", outsideClickClose);

    wireHeader();
    wireMobileMenu();

    wireDrawerChips();
    wirePricePresets();
    wireInputs();
    wireGlobalClicks();
    wirePopstate();

    initYear();

    // Initialize from URL then render
    initFromURL();

    // Replace URL with normalized params (no duplicates / invalid values)
    writeURLFromState(true);

    render();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
