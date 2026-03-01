/* =========================================================
   item.js — OG Jewelers (Product Details)
   Rail-free Luxe PDP:
   - Single editorial hero image
   - "Examine craftsmanship" opens inspect viewer (zoom/pan)
   - Editorial lead + Details parsing
   - Curated related (3 cards) + subtle tags
   - Luxe Search Overlay (functional)
   ========================================================= */

(() => {
  "use strict";

  /* =========================
     Shared scroll lock
  ========================= */
  let scrollLockCount = 0;
  function lockScrollAdd() {
    scrollLockCount += 1;
    document.documentElement.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
  }
  function lockScrollRemove() {
    scrollLockCount = Math.max(0, scrollLockCount - 1);
    if (scrollLockCount === 0) {
      document.documentElement.style.overflow = "";
      document.body.style.overflow = "";
    }
  }

  function setAriaHidden(el, hidden) {
    if (!el) return;
    el.setAttribute("aria-hidden", hidden ? "true" : "false");
  }

  /* =========================
     Nav drawer (mobile header)
  ========================= */
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

    lockScrollAdd();
    drawer.querySelector("a,button")?.focus?.({ preventScroll: true });
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
    lockScrollRemove();
  }

  /* =========================
     Search overlay (Luxe)
  ========================= */
  function searchRefs() {
    return {
      overlay: document.querySelector('[data-ui="search"]'),
      input: document.querySelector('[data-ui="search-input"]'),
      shell: document.querySelector(".search-shell"),
    };
  }

  function isSearchOpen() {
    const { overlay } = searchRefs();
    return !!overlay && !overlay.hidden && overlay.classList.contains("is-open");
  }

  function openSearch() {
    const { overlay, input } = searchRefs();
    if (!overlay) return;

    overlay.hidden = false;
    setAriaHidden(overlay, false);

    requestAnimationFrame(() => {
      overlay.classList.add("is-open");
      lockScrollAdd();
      input?.focus?.({ preventScroll: true });
      input?.select?.();
    });
  }

  function closeSearch({ returnFocus = true } = {}) {
    const { overlay } = searchRefs();
    if (!overlay) return;

    overlay.classList.remove("is-open");
    setAriaHidden(overlay, true);
    lockScrollRemove();

    window.setTimeout(() => {
      overlay.hidden = true;
      if (returnFocus) {
        document
          .querySelector('[data-action="open-search"]')
          ?.focus?.({ preventScroll: true });
      }
    }, 220);
  }

  function performSearch(raw) {
    const q = String(raw || "").trim();
    if (!q) return;
    window.location.assign(`catalogue.html?q=${encodeURIComponent(q)}`);
  }

  /* =========================
     Config
  ========================= */
  const SUPABASE_PROJECT_URL = "https://byhytmarmigalvawkedi.supabase.co";
  const STOREFRONT_CHANNEL = "og_main";

  /* =========================
     Helpers
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

  /* =========================================================
     Hero image (rail-free)
  ========================================================= */
  function applyHeroImage(imgUrl) {
    const hero = $('[data-ui="item-hero"]');
    if (!hero) return;

    if (imgUrl) {
      hero.style.setProperty("--img", `url("${imgUrl}")`);
      hero.dataset.inspectSrc = imgUrl;
    } else {
      hero.style.removeProperty("--img");
      hero.dataset.inspectSrc = "";
    }
      /* =========================================================
     4.4 — Provenance line + Editorial secondary image
  ========================================================= */

  function setProvenanceLine(item) {
    const el = document.querySelector('[data-ui="pdp-provenance"]');
    if (!el) return;

    // “House” style line — calm, confident, non-technical
    // If you later add real fields (drop_name, release_tag, etc.), plug them in here.
    const bits = [];

    // Lightly infer “limited” if remaining_count is low
    const remaining = Number(item?.remaining_count);
    if (Number.isFinite(remaining) && remaining > 0 && remaining <= 3) bits.push("Limited availability");

    bits.push("Inspected in-house");
    bits.push("Ships insured");

    el.textContent = bits.join(" • ");
    el.hidden = false;
  }

  function pickSecondaryImage(item, primaryUrl) {
    // Best-effort: support multiple possible field names without breaking anything
    const candidates = [
      item?.secondary_image_url,
      item?.detail_image_url,
      item?.image_url_2,
      item?.image2,
      item?.image_alt,
      item?.alt_image_url,
    ];

    // Some projects store arrays (optional)
    const arr = Array.isArray(item?.images) ? item.images : null;
    if (arr && arr.length > 1) candidates.unshift(arr[1]);

    const primary = String(primaryUrl || "").trim();
    for (const c of candidates) {
      const v = String(c || "").trim();
      if (!v) continue;
      if (primary && v === primary) continue;
      return v;
    }
    return primary || "";
  }

  function applyEditorialImage(imgUrl) {
    const wrap = document.querySelector('[data-ui="editorial-wrap"]');
    const img = document.querySelector('[data-ui="editorial-img"]');
    if (!wrap || !img) return;

    const url = String(imgUrl || "").trim();
    if (!url) {
      wrap.hidden = true;
      img.style.removeProperty("--img");
      return;
    }

    img.style.setProperty("--img", `url("${url}")`);
    wrap.hidden = false;
  }

  function setEditorialCopy(item) {
    const titleEl = document.querySelector('[data-ui="editorial-title"]');
    const subEl = document.querySelector('[data-ui="editorial-sub"]');
    const capEl = document.querySelector('[data-ui="editorial-cap"]');

    const mat = String(item?.material || "").trim();
    const stamp = String(item?.stamp || item?.purity || "").trim();

    if (titleEl) titleEl.textContent = mat ? `The Details in ${mat}` : "The Details";
    if (subEl) {
      subEl.textContent =
        "A closer look at finish, proportion, and how the piece holds light — the details that separate ordinary from OG.";
    }

    if (capEl) {
      const bits = [];
      if (stamp) bits.push(stamp);
      if (mat) bits.push(mat);
      if (bits.length) {
        capEl.textContent = bits.join(" • ");
        capEl.hidden = false;
      } else {
        capEl.hidden = true;
        capEl.textContent = "";
      }
    }
  }
  }

  /* =========================================================
     Product description → Editorial lead + Details list
  ========================================================= */
  function normalizeLines(text) {
    const raw = String(text || "").replace(/\r/g, "");
    const blocks = raw
      .split("\n")
      .map((x) => x.trim())
      .filter((x) => x.length > 0);

    if (blocks.length <= 2 && raw.length > 140) {
      const maybe = raw
        .split(/(?:\n{2,})|(?:\s{2,})/g)
        .map((x) => x.trim())
        .filter(Boolean);
      if (maybe.length > blocks.length) return maybe;
    }
    return blocks;
  }

  function parseLeadAndDetails(descriptionText) {
    const lines = normalizeLines(descriptionText);
    if (!lines.length) return { lead: "", details: [] };

    const details = [];
    const leadParts = [];

    const keyValRx = /^([A-Za-z][A-Za-z\s\/&\-\(\)\.]{1,38})\s*:\s*(.+)$/;

    for (const line of lines) {
      const m = line.match(keyValRx);
      if (m) {
        details.push([m[1].trim(), m[2].trim()]);
        continue;
      }

      const cleaned = line.replace(/^[•\-\u2022]\s*/, "").trim();
      const m2 = cleaned.match(keyValRx);
      if (m2) {
        details.push([m2[1].trim(), m2[2].trim()]);
        continue;
      }

      leadParts.push(line);
    }

    let lead = leadParts.join(" ").replace(/\s+/g, " ").trim();
    if (lead.length > 360) lead = lead.slice(0, 360).trim() + "…";

    return { lead, details };
  }

  function renderDetailsList(detailsPairs) {
    const dl = document.querySelector('[data-ui="details-list"]');
    if (!dl) return;

    const pairs = Array.isArray(detailsPairs) ? detailsPairs : [];
    if (!pairs.length) {
      dl.innerHTML = `
        <dt>Craft</dt><dd>Precision-finished for brilliance and everyday wear.</dd>
        <dt>Care</dt><dd>Avoid harsh chemicals. Store separately for best finish.</dd>
      `;
      return;
    }

    dl.innerHTML = pairs
      .slice(0, 8)
      .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`)
      .join("");
  }

  function setMetaLine(item) {
    const meta = document.querySelector('[data-ui="item-meta"]');
    if (!meta) return;

    const material = String(item?.material || "").trim();
    const stamp = String(item?.stamp || item?.purity || "").trim();
    const cats = Array.isArray(item?.categories) ? item.categories : [];
    const cat = String(cats[0] || "").trim();

    const bits = [];
    if (cat) bits.push(cat);
    if (material) bits.push(material);
    if (stamp) bits.push(stamp);

    if (!bits.length) {
      meta.hidden = true;
      meta.textContent = "";
      return;
    }

    meta.hidden = false;
    meta.textContent = bits.join(" • ");
  }

  /* =========================================================
     Related (curated luxe): 3 cards + subtle tag
  ========================================================= */
  function buildSuggestions(all, current) {
    const curId = String(current?.item_type_id || "");
    const curCats = new Set(
      Array.isArray(current?.categories) ? current.categories : []
    );
    const curMat = String(current?.material || "").toLowerCase().trim();

    const scored = (all || [])
      .filter(
        (x) =>
          String(x?.item_type_id || "") &&
          String(x.item_type_id) !== curId
      )
      .map((x) => {
        const cats = Array.isArray(x?.categories) ? x.categories : [];
        const mat = String(x?.material || "").toLowerCase().trim();
        let score = 0;
        let reason = "OG Pick";

        for (const c of cats) {
          if (curCats.has(c)) {
            score += 2;
            reason = "Similar Style";
          }
        }
        if (curMat && mat && curMat === mat) {
          score += 3;
          reason = "Same Material";
        }

        score += Math.random() * 0.75;
        return { x, score, reason };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    return scored;
  }

  function renderSuggestionCard({ x, reason }) {
    const id = String(x?.item_type_id || "");
    const title = escapeHtml(x?.title || "Item");
    const price = money(x?.display_price);
    const img = pickImage(x);

    return `
      <a class="rel-card" href="item.html?id=${encodeURIComponent(id)}">
        <div class="rel-img" style="--img:url('${String(img).replaceAll("'", "%27")}')"></div>
        <div class="rel-meta">
          <div class="rel-top">
            <div class="rel-title">${title}</div>
            <div class="rel-price">${price}</div>
          </div>
          <div class="rel-tag">${escapeHtml(reason || "OG Pick")}</div>
        </div>
      </a>
    `;
  }

  /* =========================================================
     Inspect Viewer (Zoom/Pan)
  ========================================================= */
  function inspectRefs() {
    return {
      backdrop: document.querySelector('[data-ui="inspect-backdrop"]'),
      modal: document.querySelector('[data-ui="inspect-modal"]'),
      title: document.querySelector('[data-ui="inspect-title"]'),
      viewport: document.querySelector('[data-ui="inspect-viewport"]'),
      img: document.querySelector('[data-ui="inspect-img"]'),
      shimmer: document.querySelector('[data-ui="inspect-shimmer"]'),
      hint: document.querySelector('[data-ui="inspect-hint"]'),
    };
  }

  const inspectState = {
    open: false,
    scale: 1,
    x: 0,
    y: 0,
    min: 1,
    max: 4,
    baseW: 0,
    baseH: 0,
    activePointers: new Map(),
    drag: null,
    pinch: null,
    lastTapAt: 0,
    returnFocusEl: null,
    hintTimer: null,
  };

  function isInspectOpen() {
    const { modal } = inspectRefs();
    return !!modal && !modal.hidden && inspectState.open;
  }

  function clamp(n, a, b) {
    return Math.min(b, Math.max(a, n));
  }

  function computePanBounds() {
    const { viewport } = inspectRefs();
    if (!viewport) return { maxX: 0, maxY: 0 };
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    const w = inspectState.baseW * inspectState.scale;
    const h = inspectState.baseH * inspectState.scale;
    return {
      maxX: Math.max(0, (w - vw) / 2),
      maxY: Math.max(0, (h - vh) / 2),
    };
  }

  function applyInspectTransform() {
    const { img, viewport } = inspectRefs();
    if (!img) return;

    const { maxX, maxY } = computePanBounds();
    inspectState.x = clamp(inspectState.x, -maxX, maxX);
    inspectState.y = clamp(inspectState.y, -maxY, maxY);

    img.style.transform = `translate3d(${inspectState.x}px, ${inspectState.y}px, 0) scale(${inspectState.scale})`;

    const stage = document.querySelector(
      '[data-ui="inspect-modal"] .inspect-stage'
    );
    const badge = document.querySelector('[data-ui="inspect-zoom-badge"]');

    const zoomed = inspectState.scale > 1.01;

    if (viewport) viewport.classList.toggle("is-zoomed", zoomed);
    if (stage) stage.classList.toggle("is-zoomed", zoomed);

    if (badge) {
      const pct = Math.round(inspectState.scale * 100);
      badge.textContent = `${pct}%`;
    }
  }

  function prefersReducedMotion() {
    try {
      return (
        window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      );
    } catch {
      return false;
    }
  }

  function setInspectOpen(open) {
    const { backdrop, modal } = inspectRefs();
    if (!backdrop || !modal) return;

    if (open) {
      backdrop.hidden = false;
      modal.hidden = false;
      modal.setAttribute("aria-hidden", "false");
      requestAnimationFrame(() => {
        backdrop.classList.add("is-open");
        modal.classList.add("is-open");
      });
      lockScrollAdd();
      inspectState.open = true;
    } else {
      backdrop.classList.remove("is-open");
      modal.classList.remove("is-open");
      modal.setAttribute("aria-hidden", "true");
      window.setTimeout(() => {
        if (!inspectState.open) {
          modal.hidden = true;
          backdrop.hidden = true;
        }
      }, prefersReducedMotion() ? 0 : 230);
      lockScrollRemove();
      inspectState.open = false;
    }
  }

  function resetInspectView() {
    inspectState.scale = 1;
    inspectState.x = 0;
    inspectState.y = 0;
    applyInspectTransform();
  }

  function showInspectHintOnce() {
    const { hint } = inspectRefs();
    if (!hint) return;
    hint.style.opacity = "1";
    window.clearTimeout(inspectState.hintTimer);
    inspectState.hintTimer = window.setTimeout(() => {
      hint.style.opacity = "0.75";
      window.setTimeout(() => {
        if (hint) hint.style.opacity = "0";
      }, 1200);
    }, 1400);
  }

  async function openInspectFromHero(titleText) {
    const { img, shimmer, title } = inspectRefs();
    const hero = document.querySelector('[data-ui="item-hero"]');
    const src = String(hero?.dataset?.inspectSrc || "").trim();

    if (!img || !src) {
      toast("No image available.");
      return;
    }

    inspectState.returnFocusEl = document.activeElement;

    if (title) title.textContent = "Examine Craftsmanship";
    if (shimmer) shimmer.hidden = false;

    resetInspectView();
    setInspectOpen(true);

    img.alt = titleText ? String(titleText) : "Product image";
    img.src = src;

    await new Promise((resolve) => {
      if (img.complete) return resolve();
      const onLoad = () => {
        img.removeEventListener("load", onLoad);
        img.removeEventListener("error", onLoad);
        resolve();
      };
      img.addEventListener("load", onLoad);
      img.addEventListener("error", onLoad);
    });

    inspectState.scale = 1;
    inspectState.x = 0;
    inspectState.y = 0;
    applyInspectTransform();

    const rect = img.getBoundingClientRect();
    inspectState.baseW = rect.width || inspectState.baseW || 0;
    inspectState.baseH = rect.height || inspectState.baseH || 0;

    if (shimmer) shimmer.hidden = true;

    showInspectHintOnce();
    document
      .querySelector('[data-action="close-inspect"]')
      ?.focus?.({ preventScroll: true });
  }

  function closeInspect() {
    if (!isInspectOpen()) return;
    const { img, shimmer, hint } = inspectRefs();

    setInspectOpen(false);

    inspectState.activePointers.clear();
    inspectState.drag = null;
    inspectState.pinch = null;
    window.clearTimeout(inspectState.hintTimer);

    if (img) {
      img.src = "";
      img.alt = "";
      img.style.transform = "translate3d(0,0,0) scale(1)";
    }
    if (shimmer) shimmer.hidden = true;
    if (hint) hint.style.opacity = "";

    const prev = inspectState.returnFocusEl;
    inspectState.returnFocusEl = null;
    prev?.focus?.({ preventScroll: true });
  }

  function zoomBy(delta, anchor) {
    const { viewport } = inspectRefs();
    if (!viewport) return;

    const old = inspectState.scale;
    const next = clamp(old + delta, inspectState.min, inspectState.max);
    if (Math.abs(next - old) < 0.001) return;

    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    const ax = anchor?.x ?? vw / 2;
    const ay = anchor?.y ?? vh / 2;
    const dx = ax - vw / 2;
    const dy = ay - vh / 2;

    const k = next / old;
    inspectState.x = (inspectState.x - dx) * k + dx;
    inspectState.y = (inspectState.y - dy) * k + dy;
    inspectState.scale = next;
    applyInspectTransform();
  }

  function wireInspectInputsOnce() {
    const { backdrop, viewport } = inspectRefs();
    if (!viewport || viewport.dataset.wired === "1") return;
    viewport.dataset.wired = "1";

    backdrop?.addEventListener("click", () => closeInspect());

    viewport.addEventListener(
      "wheel",
      (e) => {
        if (!isInspectOpen()) return;
        e.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        const delta = e.deltaY > 0 ? -0.12 : 0.12;
        zoomBy(delta, anchor);
      },
      { passive: false }
    );

    viewport.addEventListener("pointerdown", (e) => {
      if (!isInspectOpen()) return;
      viewport.setPointerCapture?.(e.pointerId);
      inspectState.activePointers.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
      });

      const pts = [...inspectState.activePointers.values()];
      if (pts.length === 1) {
        inspectState.drag = {
          startX: e.clientX,
          startY: e.clientY,
          x0: inspectState.x,
          y0: inspectState.y,
        };
      }
      if (pts.length === 2) {
        const [a, b] = pts;
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        inspectState.pinch = { dist, scale0: inspectState.scale };
        inspectState.drag = null;
      }
    });

    viewport.addEventListener("pointermove", (e) => {
      if (!isInspectOpen()) return;
      if (!inspectState.activePointers.has(e.pointerId)) return;
      inspectState.activePointers.set(e.pointerId, {
        x: e.clientX,
        y: e.clientY,
      });

      const pts = [...inspectState.activePointers.values()];

      if (inspectState.pinch && pts.length === 2) {
        const [a, b] = pts;
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        const ratio = dist / (inspectState.pinch.dist || dist);
        const next = clamp(
          inspectState.pinch.scale0 * ratio,
          inspectState.min,
          inspectState.max
        );
        const old = inspectState.scale;
        inspectState.scale = next;

        const k = next / old;
        inspectState.x *= k;
        inspectState.y *= k;

        applyInspectTransform();
        return;
      }

      if (inspectState.drag && pts.length === 1) {
        const d = inspectState.drag;
        inspectState.x = d.x0 + (e.clientX - d.startX);
        inspectState.y = d.y0 + (e.clientY - d.startY);
        applyInspectTransform();
      }
    });

    const onPointerUp = (e) => {
      if (!inspectState.activePointers.has(e.pointerId)) return;
      inspectState.activePointers.delete(e.pointerId);
      inspectState.drag = null;
      if (inspectState.activePointers.size < 2) inspectState.pinch = null;
    };
    viewport.addEventListener("pointerup", onPointerUp);
    viewport.addEventListener("pointercancel", onPointerUp);

    viewport.addEventListener("click", () => {
      if (!isInspectOpen()) return;
      const now = Date.now();
      const dt = now - (inspectState.lastTapAt || 0);
      inspectState.lastTapAt = now;
      if (dt > 50 && dt < 340) {
        if (inspectState.scale < 1.2) inspectState.scale = 1.85;
        else inspectState.scale = 1;
        inspectState.x = 0;
        inspectState.y = 0;
        applyInspectTransform();
      }
    });
  }

  /* =========================================================
     Actions
  ========================================================= */
  function bindActions(currentItem) {
    document.addEventListener("click", (e) => {
      // 1) Search hint chips (these use data-search, not data-action)
      const hint = e.target.closest("[data-search]");
      if (hint && hint instanceof HTMLElement) {
        const q = String(hint.getAttribute("data-search") || "").trim();
        if (q) {
          const { input } = searchRefs();
          if (input) input.value = q;
          performSearch(q);
        }
        return;
      }

      // 2) Standard actions
      const btn = e.target.closest("[data-action]");
      if (!btn) return;

      const action = btn.getAttribute("data-action");

      // --- Search overlay actions
      if (action === "open-search") {
        e.preventDefault();
        openSearch();
        return;
      }

      if (action === "close-search") {
        e.preventDefault();
        closeSearch();
        return;
      }

      if (action === "search-go") {
        e.preventDefault();
        const { input } = searchRefs();
        performSearch(input?.value || "");
        return;
      }

            // --- Cart actions
      if (action === "go-cart-page") {
        e.preventDefault();
        window.location.assign("./StoreCart/cart.html");
        return;
      }

      if (action === "open-cart-drawer") {
        e.preventDefault();
        window.ogCartDrawerOpen?.();
        return;
      }

      if (action === "add-to-cart") {
        e.preventDefault();

        const addBtn = btn; // clicked button
        const prevLabel = (addBtn && addBtn.textContent) ? addBtn.textContent : "ADD TO CART";

        const id = String(currentItem?.item_type_id || "");
        const price = Number(currentItem?.display_price) || 0;
        const remaining = Number(currentItem?.remaining_count);

        if (!id) return;

        if (Number.isFinite(remaining) && remaining <= 0) {
          toast("Sold out.");
          return;
          
        }

        // ✅ Ritual microstates
        if (addBtn) {
          addBtn.classList.add("is-busy");
          addBtn.disabled = true;
          addBtn.setAttribute("aria-busy", "true");
          addBtn.textContent = "ADDING...";
        }

        // Perform add
        window.ogCartService?.addToCart?.(id, 1, price);
        window.ogCartBadgeRefresh?.();

        // Pulse the first trust chip
        const trustChip = document.querySelector(".trust-row .trust-chip");
        if (trustChip) {
          trustChip.classList.remove("is-pulsing");
          void trustChip.offsetWidth; // restart animation
          trustChip.classList.add("is-pulsing");
          window.setTimeout(() => trustChip.classList.remove("is-pulsing"), 950);
        }


        toast("Added — price locked for 15 minutes.");

        // Button resolve
        window.setTimeout(() => {
          if (!addBtn) return;
          addBtn.classList.remove("is-busy");
          addBtn.classList.add("is-added");
          addBtn.textContent = "ADDED ✓";
        }, 140);

        window.setTimeout(() => {
          if (!addBtn) return;
          addBtn.classList.remove("is-added");
          addBtn.disabled = false;
          addBtn.removeAttribute("aria-busy");
          addBtn.textContent = prevLabel;
        }, 1200);

        return;
      }

      // --- Inspect actions
      if (action === "open-inspect") {
        e.preventDefault();
        wireInspectInputsOnce();
        const title =
          document.querySelector('[data-ui="item-title"]')?.textContent ||
          "Item";
        openInspectFromHero(title);
        return;
      }

      if (action === "close-inspect") {
        e.preventDefault();
        closeInspect();
        return;
      }

      if (action === "inspect-zoom-in") {
        e.preventDefault();
        zoomBy(0.18);
        return;
      }

      if (action === "inspect-zoom-out") {
        e.preventDefault();
        zoomBy(-0.18);
        return;
      }

      if (action === "inspect-reset") {
        e.preventDefault();
        resetInspectView();
        return;
      }

      // --- Nav drawer actions
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

  /* =========================================================
     Init
  ========================================================= */
  async function init() {
    setLoading(true);
    clearError();

    // Nav drawer behaviors
    const { backdrop, drawer } = navRefs();
    backdrop?.addEventListener("click", () => closeNav());
    drawer?.addEventListener("click", (e) => {
      if (e.target.closest("a")) closeNav();
    });

    // Search overlay behaviors (click outside + Enter)
    const s = searchRefs();
    s.overlay?.addEventListener("click", (e) => {
      if (e.target === s.overlay) closeSearch();
    });

    s.input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        performSearch(s.input.value);
      }
    });

    // Global ESC
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (isSearchOpen()) {
        closeSearch();
        return;
      }
      if (isInspectOpen()) {
        closeInspect();
        return;
      }
      if (isNavOpen()) closeNav();
    });

    const id = getIdFromUrl();
    if (!id) {
      setLoading(false);
      setError("Missing item id. Go back to the shop and select a product.");
      return;
    }

    try {
      const all = await fetchCatalog();
      const item = all.find(
        (x) => String(x?.item_type_id || "") === String(id)
      );

      if (!item) {
        setLoading(false);
        setError("That product wasn’t found. It may have been unpublished.");
        return;
      }

      const title = String(item.title || "OG Item");
      const price = Number(item.display_price) || 0;
      const img = pickImage(item);
      const stock = resolveStockBadge(item.remaining_count);

      const titleEl = $('[data-ui="item-title"]');
      const priceEl = $('[data-ui="item-price"]');
      if (titleEl) titleEl.textContent = title;
      if (priceEl) priceEl.textContent = money(price);

      const badge = $('[data-ui="item-stock"]');
      if (badge) {
        badge.textContent = stock.label;
        badge.setAttribute("data-tone", stock.tone);
      }

      setMetaLine(item);

      const hero = $('[data-ui="item-hero"]');
      if (hero) hero.setAttribute("aria-label", title);
      applyHeroImage(img);

      const hit = hero?.querySelector('[data-action="open-inspect"]');
      const pill = hero?.querySelector(".inspect-pill");
      if (hit) hit.disabled = !img;
      if (pill) pill.style.display = img ? "" : "none";

      const { lead, details } = parseLeadAndDetails(
        String(item.description || "")
      );
      const leadEl = document.querySelector('[data-ui="desc-lead"]');
      if (leadEl) {
        leadEl.textContent =
          lead ||
          "Designed to catch light with a refined, high-presence finish — made to be worn, not just owned.";
      }

      const itemId = String(item?.item_type_id || "");
      const addBtn = $('[data-action="add-to-cart"]');
      const favBtn = $('[data-action="toggle-fav"]');
      if (addBtn && itemId) addBtn.dataset.id = itemId;
      if (favBtn && itemId) favBtn.dataset.id = itemId;
      renderDetailsList(details);

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
     (your existing auth code continues below unchanged)
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

  // (…keep the rest of your existing auth/account chip logic exactly as-is…)
})();