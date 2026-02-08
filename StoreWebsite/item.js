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
    });
  }

  async function init() {
    setLoading(true);
    clearError();

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
})();
