/* catalogue.js — OG Jewelers (Catalog)
   Ultra-aesthetic, framework-free catalog with:
   - URL-driven filters (category/material/tag/q/minPrice/maxPrice/sort/page/view)
   - Filter drawer (open/close, backdrop, escape, focus behavior)
   - Chip-based filter summary
   - Pagination
   - Grid/List view toggle
   - Mobile-first UI polish

   IMPORTANT: This public storefront reads inventory via a Supabase Edge Function
   and shows only "published" listings.
*/

(() => {
  "use strict";

  /* =========================
     Tiny helpers
  ========================= */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const toNum = (x, fallback = 0) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : fallback;
  };

  const escapeHtml = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  /* =========================
     Data source (Supabase Edge Function)
  ========================= */
  const SUPABASE_PROJECT_URL = "https://byhytmarmigalvawkedi.supabase.co"; // <-- your project
  const STOREFRONT_CHANNEL = "og_main";
  const FALLBACK_IMAGE = "assets/collections/chains.jpg";

  // ✅ IMPORTANT: set this to your PUBLIC bucket name that holds storefront images
  // (This is the bucket where your admin uploads cover images / product photos for the public site.)
  const PUBLIC_PHOTO_BUCKET = "public-ebay-photos";

  const isHttpUrl = (s) => /^https?:\/\//i.test(String(s || ""));

  const publicObjectUrl = (bucket, key) => {
    const k = String(key || "").replace(/^\/+/, "");
    if (!k) return "";
    return `${SUPABASE_PROJECT_URL}/storage/v1/object/public/${bucket}/${encodeURI(k)}`;
  };

  const pickBestImageUrl = (row) => {
    // 1) Admin-controlled listing override (storefront_listings.public_photo_keys)
    const keys = Array.isArray(row?.public_photo_keys) ? row.public_photo_keys : [];
    if (keys.length && keys[0]) return publicObjectUrl(PUBLIC_PHOTO_BUCKET, keys[0]);

    // 2) Direct URL (or key) on item_types.photo_url
    if (row?.photo_url) {
      if (isHttpUrl(row.photo_url)) return row.photo_url;
      return publicObjectUrl(PUBLIC_PHOTO_BUCKET, row.photo_url);
    }

    // 3) item_types.photos array (either URLs or storage keys)
    const photos = Array.isArray(row?.photos) ? row.photos : [];
    const first = photos[0];
    if (first) return isHttpUrl(first) ? first : publicObjectUrl(PUBLIC_PHOTO_BUCKET, first);

    // 4) fallback
    return FALLBACK_IMAGE;
  };

  async function fetchSpotSnapshot() {
    const url = `${SUPABASE_PROJECT_URL}/functions/v1/spot-snapshot`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`spot-snapshot failed: ${res.status}`);
    return res.json();
  }

  /* =========================
     URL State
  ========================= */
  const DEFAULTS = {
    q: "",
    category: "all",
    material: "all",
    tag: "all",
    minPrice: "",
    maxPrice: "",
    sort: "featured",
    page: 1,
    view: "grid",
  };

  const readStateFromUrl = () => {
    const p = new URLSearchParams(location.search);

    const s = {
      q: p.get("q") ?? DEFAULTS.q,
      category: p.get("category") ?? DEFAULTS.category,
      material: p.get("material") ?? DEFAULTS.material,
      tag: p.get("tag") ?? DEFAULTS.tag,
      minPrice: p.get("minPrice") ?? DEFAULTS.minPrice,
      maxPrice: p.get("maxPrice") ?? DEFAULTS.maxPrice,
      sort: p.get("sort") ?? DEFAULTS.sort,
      page: toNum(p.get("page") ?? DEFAULTS.page, 1),
      view: p.get("view") ?? DEFAULTS.view,
    };

    s.page = clamp(s.page, 1, 9999);
    if (!["grid", "list"].includes(s.view)) s.view = "grid";

    return s;
  };

  const writeStateToUrl = (state, replace = true) => {
    const p = new URLSearchParams();

    for (const [k, v] of Object.entries(state)) {
      if (v == null) continue;
      if (String(v) === String(DEFAULTS[k])) continue;
      if (String(v).trim() === "" && String(DEFAULTS[k]).trim() === "") continue;
      p.set(k, String(v));
    }

    const newUrl = `${location.pathname}${p.toString() ? "?" + p.toString() : ""}${location.hash || ""}`;
    if (replace) history.replaceState(null, "", newUrl);
    else history.pushState(null, "", newUrl);
  };

  /* =========================
     In-memory data
  ========================= */
  let allProducts = []; // normalized list used by UI
  let spot = null;      // spot snapshot (if used by your UI)

  // > UI product shape used by the existing UI logic
  const mapStoreItemToProduct = (it) => {
    const cats = Array.isArray(it.categories) ? it.categories : [];
    const category = String(cats[0] || "all").toLowerCase();

    const tags = Array.isArray(it.badge_flags) ? it.badge_flags : [];

    return {
      id: String(it.item_type_id),
      name: String(it.public_title || it.title || ""),
      category,
      material: String(it.metal || "").toLowerCase(),
      price: toNum(it.display_price),
      tags,
      created_at: it.created_at ? new Date(it.created_at).toISOString() : new Date().toISOString(),
      image: pickBestImageUrl(it),
    };
  };

  /* =========================
     Data load
  ========================= */
  const fiveMinBucket = () => Math.floor(Date.now() / (5 * 60 * 1000));

  const loadCatalog = async () => {
    const t = fiveMinBucket();
    const url = `${SUPABASE_PROJECT_URL}/functions/v1/public-storefront?channel_id=${encodeURIComponent(
      STOREFRONT_CHANNEL
    )}&t=${t}`;

    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      cache: "no-store",
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`public-storefront failed ${res.status}: ${txt}`);
    }

    const rows = await res.json();
    const list = Array.isArray(rows?.items) ? rows.items : (Array.isArray(rows) ? rows : []);
    allProducts = list.map(mapStoreItemToProduct);
  };

  /* =========================
     Filtering / sorting
  ========================= */
  const normalize = (s) => String(s || "").trim().toLowerCase();

  const applyFilters = (products, state) => {
    const q = normalize(state.q);
    const cat = normalize(state.category);
    const mat = normalize(state.material);
    const tag = normalize(state.tag);

    const minP = state.minPrice === "" ? null : toNum(state.minPrice, null);
    const maxP = state.maxPrice === "" ? null : toNum(state.maxPrice, null);

    return products.filter((p) => {
      if (cat && cat !== "all" && normalize(p.category) !== cat) return false;
      if (mat && mat !== "all" && normalize(p.material) !== mat) return false;
      if (tag && tag !== "all" && !p.tags.map(normalize).includes(tag)) return false;

      if (minP != null && p.price < minP) return false;
      if (maxP != null && p.price > maxP) return false;

      if (q) {
        const blob = normalize(`${p.name} ${p.category} ${p.material} ${p.tags.join(" ")}`);
        if (!blob.includes(q)) return false;
      }

      return true;
    });
  };

  const applySort = (products, sort) => {
    const s = normalize(sort);

    const arr = products.slice();
    if (s === "price-asc") arr.sort((a, b) => a.price - b.price);
    else if (s === "price-desc") arr.sort((a, b) => b.price - a.price);
    else if (s === "newest") arr.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    else {
      // featured (default) — keep original order from API
    }
    return arr;
  };

  /* =========================
     Rendering
  ========================= */
  const PAGE_SIZE = 12;

  const renderProducts = (products, state) => {
    const container = $("#products");
    if (!container) return;

    container.classList.toggle("list", state.view === "list");

    const total = products.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = clamp(state.page, 1, pages);

    const start = (page - 1) * PAGE_SIZE;
    const chunk = products.slice(start, start + PAGE_SIZE);

    $("#resultsCount") && ($("#resultsCount").textContent = `${total} results`);
    $("#pagePill") && ($("#pagePill").textContent = `Page ${page} / ${pages}`);

    container.innerHTML = chunk
      .map((p) => {
        return `
          <article class="product-card" data-id="${escapeHtml(p.id)}">
            <div class="media">
              <img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name)}" loading="lazy" />
            </div>
            <div class="body">
              <div class="title-row">
                <h3 class="name">${escapeHtml(p.name)}</h3>
                <div class="price">$${escapeHtml(p.price.toFixed(2))}</div>
              </div>
              <div class="meta">
                <span class="pill">${escapeHtml(p.category)}</span>
                ${p.material ? `<span class="pill subtle">${escapeHtml(p.material)}</span>` : ""}
              </div>
              ${p.tags?.length ? `<div class="tags">${p.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
            </div>
          </article>
        `;
      })
      .join("");

    state.page = page;
    writeStateToUrl(state, true);
    renderPagination(pages, state);
  };

  const renderPagination = (pages, state) => {
    const el = $("#pagination");
    if (!el) return;

    const page = clamp(state.page, 1, pages);

    const btn = (label, target, disabled = false) => `
      <button class="page-btn ${disabled ? "disabled" : ""}" ${disabled ? "disabled" : ""} data-page="${target}">
        ${label}
      </button>
    `;

    let html = "";
    html += btn("Prev", page - 1, page <= 1);

    const start = Math.max(1, page - 2);
    const end = Math.min(pages, page + 2);

    if (start > 1) html += btn("1", 1, page === 1);
    if (start > 2) html += `<span class="dots">…</span>`;

    for (let i = start; i <= end; i++) {
      html += btn(String(i), i, i === page);
    }

    if (end < pages - 1) html += `<span class="dots">…</span>`;
    if (end < pages) html += btn(String(pages), pages, page === pages);

    html += btn("Next", page + 1, page >= pages);
    el.innerHTML = html;

    el.onclick = (e) => {
      const b = e.target.closest("[data-page]");
      if (!b || b.disabled) return;
      const next = toNum(b.getAttribute("data-page"), page);
      const ns = readStateFromUrl();
      ns.page = clamp(next, 1, pages);
      writeStateToUrl(ns, false);
      render();
    };
  };

  /* =========================
     Filters UI (lightweight)
  ========================= */
  const bindUI = () => {
    const state = readStateFromUrl();

    $("#q") && ($("#q").value = state.q);
    $("#minPrice") && ($("#minPrice").value = state.minPrice);
    $("#maxPrice") && ($("#maxPrice").value = state.maxPrice);

    $("#sortSelect") && ($("#sortSelect").value = state.sort);
    $("#viewToggle") && ($("#viewToggle").value = state.view);

    // Update on inputs
    const onChange = () => {
      const s = readStateFromUrl();
      s.q = $("#q")?.value ?? "";
      s.minPrice = $("#minPrice")?.value ?? "";
      s.maxPrice = $("#maxPrice")?.value ?? "";
      s.sort = $("#sortSelect")?.value ?? DEFAULTS.sort;
      s.view = $("#viewToggle")?.value ?? DEFAULTS.view;
      s.page = 1;
      writeStateToUrl(s, false);
      render();
    };

    $("#q") && ($("#q").addEventListener("input", onChange));
    $("#minPrice") && ($("#minPrice").addEventListener("input", onChange));
    $("#maxPrice") && ($("#maxPrice").addEventListener("input", onChange));
    $("#sortSelect") && ($("#sortSelect").addEventListener("change", onChange));
    $("#viewToggle") && ($("#viewToggle").addEventListener("change", onChange));

    // Basic category/material/tag dropdowns if present
    $("#categorySelect") &&
      $("#categorySelect").addEventListener("change", () => {
        const s = readStateFromUrl();
        s.category = $("#categorySelect").value || "all";
        s.page = 1;
        writeStateToUrl(s, false);
        render();
      });

    $("#materialSelect") &&
      $("#materialSelect").addEventListener("change", () => {
        const s = readStateFromUrl();
        s.material = $("#materialSelect").value || "all";
        s.page = 1;
        writeStateToUrl(s, false);
        render();
      });

    $("#tagSelect") &&
      $("#tagSelect").addEventListener("change", () => {
        const s = readStateFromUrl();
        s.tag = $("#tagSelect").value || "all";
        s.page = 1;
        writeStateToUrl(s, false);
        render();
      });

    // Back/forward support
    window.addEventListener("popstate", () => render());
  };

  const render = () => {
    const state = readStateFromUrl();
    const filtered = applyFilters(allProducts, state);
    const sorted = applySort(filtered, state.sort);
    renderProducts(sorted, state);
  };

  /* =========================
     Init
  ========================= */
  const init = async () => {
    try {
      $("#statusText") && ($("#statusText").textContent = "Loading spot prices…");

      try {
        spot = await fetchSpotSnapshot();
        $("#statusText") && ($("#statusText").textContent = "Loading catalog…");
      } catch (e) {
        // spot may fail; allow catalog to load anyway
        $("#statusText") && ($("#statusText").textContent = "Loading catalog…");
        console.warn("Spot snapshot failed (non-fatal):", e);
      }

      await loadCatalog();

      bindUI();
      render();

      $("#statusText") && ($("#statusText").textContent = "");
    } catch (e) {
      console.error(e);
      $("#statusText") && ($("#statusText").textContent = "Failed to load shop data.");
    }
  };

  init();
})();
