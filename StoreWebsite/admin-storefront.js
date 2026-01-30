/* =========================================================
   admin-storefront.js — OG Jewelers
   Phase 4: Inventory-bound slots (via Edge Function) + Editorial
   Built ON TOP of Phase 3 (Hardened): Draft persistence + Publish + Fallback
   ========================================================= */

(() => {
  if (!document.documentElement.hasAttribute("data-admin")) return;

  /* -------------------------
     Helpers
  ------------------------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const TABLE = "storefront_content";
  const CHANNEL = "og_main";
  const MODE_DRAFT = "draft";
  const MODE_PUBLISHED = "published";
  const LS_KEY = `og_storefront_draft__${CHANNEL}`;

  // ✅ Phase 4: use same Edge Function as catalogue.js (no item_types direct reads)
  const SUPABASE_PROJECT_URL =
    window.SUPABASE_URL || "https://byhytmarmigalvawkedi.supabase.co";
  const STOREFRONT_CATALOG_FN = "storefront-catalog";
  const FALLBACK_IMAGE = "assets/collections/chains.jpg";

  // Inventory binding marker (stored in storefront_content.value)
  const INV_PREFIX = "__inv__:";

  const state = {
    selectedEl: null,
    slot: null,
    draft: {},      // { slot: {type, value} }
    published: {},  // { slot: {type, value} }
    saveTimer: null,
    supabaseReady: false,

    // ✅ Phase 4 inventory cache (from Edge Function)
    invItems: [],          // [{id,name,price,image,raw}]
    invMap: new Map(),     // id -> item
    invLoaded: false,

    // ✅ FIX: if content applies before inventory loads, queue bindings and hydrate later
    pendingInvBinds: new Map(), // slot -> { el, id }

    // ✅ FIX: batch-save multiple slots at once (used by group binding)
    pendingSaveSlots: new Set(),
  };

  /* -------------------------
     Elements
  ------------------------- */
  const panel = $(".admin-panel");
  const panelHeader = $(".admin-panel-header");
  const panelBody = $(".admin-panel-body");
  const publishBtn = $(".admin-btn.primary");
  const previewBtn = $(".admin-btn:not(.primary)");

  // Add a visible status indicator in the admin bar (no HTML changes needed)
  const statusEl = ensureStatusPill();

  /* -------------------------
     Init
  ------------------------- */
  initPanelControls();
  initSlotClicking();
  initPublishPreview();

  boot();

  async function boot() {
    setStatus("Loading…", "dim");

    await waitForSupabase(2500);
    await loadContent();            // Phase 3: loads published + draft (supabase then local)
    await loadInventoryFromEdge();  // Phase 4: load inventory list for picker

    // ✅ inventory often loads AFTER content applied; re-apply so __inv__ markers hydrate
    applyContent(state.published);
    applyContent(state.draft);

    // ✅ apply any bindings we encountered before inventory finished loading
    flushPendingInvBinds();

    setStatus(state.supabaseReady ? "Ready" : "Local mode", state.supabaseReady ? "ok" : "warn");
  }

  /* =========================
     Supabase readiness
  ========================= */
  async function waitForSupabase(timeoutMs = 2000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (window.supabase) {
        state.supabaseReady = true;
        return true;
      }
      await sleep(60);
    }
    state.supabaseReady = false;
    return false;
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /* =========================
     Phase 4: Inventory load (Edge Function)
  ========================= */
  const fiveMinBucket = () => Math.floor(Date.now() / 300000);

  function toNum(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : 0;
  }

  function mapStoreItemToInv(it) {
    // Mirrors your catalogue.js mapping logic
    return {
      id: String(it.item_type_id),
      name: String(it.title || ""),
      price: toNum(it.display_price),
      image: it.image_url || FALLBACK_IMAGE,
      raw: it,
    };
  }

  async function loadInventoryFromEdge() {
    // Admin should still work if inventory cannot load
    try {
      const t = fiveMinBucket();
      const url = `${SUPABASE_PROJECT_URL}/functions/v1/${STOREFRONT_CATALOG_FN}?channel=${encodeURIComponent(CHANNEL)}&t=${t}`;

      const res = await fetch(url, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.warn("⚠️ Inventory load failed:", res.status, txt);
        state.invLoaded = false;
        return;
      }

      const data = await res.json().catch(() => ({}));
      const items = Array.isArray(data?.items) ? data.items : [];
      const inv = items.map(mapStoreItemToInv).filter(x => x.id && x.name);

      state.invItems = inv;
      state.invMap = new Map(inv.map(x => [x.id, x]));
      state.invLoaded = true;

      // If any inventory slots were applied before invLoaded, hydrate them now
      flushPendingInvBinds();
    } catch (e) {
      console.warn("⚠️ Inventory load exception:", e);
      state.invLoaded = false;
    }
  }

  function flushPendingInvBinds() {
    if (!state.invLoaded || !state.pendingInvBinds.size) return;

    for (const [, bind] of state.pendingInvBinds) {
      if (!bind?.el || !bind?.id) continue;
      applyInventoryToSlot(bind.el, bind.id);
    }
    state.pendingInvBinds.clear();
  }

  /* =========================
     Slot clicking
  ========================= */
  function initSlotClicking() {
    $$("[data-slot]").forEach(el => {
      el.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        openEditorFor(el);
      });
    });
  }

  function openEditorFor(el) {
    state.selectedEl = el;
    state.slot = el.getAttribute("data-slot");

    panel.hidden = false;
    panelHeader.textContent = `Edit: ${state.slot}`;

    // Prefer saved content over DOM inference
    const saved = state.draft[state.slot] || state.published[state.slot];
    if (saved) {
      renderEditor(saved);
      return;
    }

    renderEditor(inferEditor(el));
  }

  /* =========================
     Panel controls
  ========================= */
  function initPanelControls() {
    if (!panel.querySelector(".admin-close")) {
      const btn = document.createElement("button");
      btn.className = "admin-close";
      btn.textContent = "×";
      btn.style.cssText =
        "position:absolute;top:12px;right:12px;font-size:22px;background:none;border:none;color:#fff;cursor:pointer;";
      btn.onclick = closePanel;
      panel.appendChild(btn);
    }

    document.addEventListener("keydown", e => {
      if (e.key === "Escape") closePanel();
    });
  }

  function closePanel() {
    panel.hidden = true;
    state.selectedEl = null;
    state.slot = null;
  }

  /* =========================
     Editor inference
  ========================= */
  function inferEditor(el) {
    // If DOM looks like image slot, infer image. Else text.
    if (el.style?.getPropertyValue("--img") || el.tagName === "IMG") {
      return { type: "image", value: extractImage(el) };
    }
    return { type: "text", value: el.textContent.trim() };
  }

  function extractImage(el) {
    const cssImg = el.style.getPropertyValue("--img");
    if (cssImg) return cssImg.replace(/^url\(["']?/, "").replace(/["']?\)$/, "");
    if (el.tagName === "IMG") return el.src;
    return "";
  }

  /* =========================
     ✅ Featured Group Binding (DOT notation)
     Your real featured slot names look like:
       featured.1.image
       featured.1.title
       featured.1.price
       featured.1.subtitle
     Group key should be:
       featured.1
  ========================= */

  function isFeaturedSlot(slot) {
    return /^featured\.\d+(\.|$)/i.test(String(slot || ""));
  }

  function getFeaturedGroupKey(slot) {
    const s = String(slot || "");
    const m = s.match(/^(featured\.\d+)(?:\..+)?$/i);
    return m ? m[1] : null;
  }

  function getGroupSlotElements(groupKey) {
    if (!groupKey) return [];
    const exact = document.querySelector(`[data-slot="${groupKey}"]`);
    const children = $$(`[data-slot^="${groupKey}."]`);
    return exact ? [exact, ...children] : children;
  }

  function bindInventoryToFeaturedGroup(groupKey, itemId) {
    if (!groupKey || !itemId) return;

    const marker = `${INV_PREFIX}${itemId}`;
    const groupEls = getGroupSlotElements(groupKey);

    // If no matching group elements exist, just bind current slot normally
    if (!groupEls.length) {
      queueDraftSave("text", marker);
      applyInventoryToSelectedSlot(itemId);
      return;
    }

    // ✅ Persist same marker for EVERY slot in the group
    for (const el of groupEls) {
      const slotName = el.getAttribute("data-slot");
      if (!slotName) continue;

      // set local draft immediately
      state.draft[slotName] = { type: "text", value: marker };
      state.pendingSaveSlots.add(slotName);

      // hydrate UI
      if (!state.invLoaded) {
        state.pendingInvBinds.set(slotName, { el, id: itemId });
      } else {
        applyInventoryToSlot(el, itemId);
      }
    }

    // always keep local backup so refresh never loses work
    persistDraftLocal();

    // ✅ Debounced batch-save all group slots to Supabase
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      savePendingDraftSlotsToSupabase();
    }, 350);
  }

  async function savePendingDraftSlotsToSupabase() {
    if (!state.pendingSaveSlots.size) return;

    // If no Supabase, still fine (local already persisted)
    if (!state.supabaseReady || !window.supabase) {
      setStatus("Saved (local)", "warn");
      state.pendingSaveSlots.clear();
      return;
    }

    setStatus("Saving…", "dim");

    const slots = [...state.pendingSaveSlots];
    state.pendingSaveSlots.clear();

    const payload = slots
      .map(slot => {
        const v = state.draft[slot];
        if (!v) return null;
        return {
          channel: CHANNEL,
          slot,
          type: v.type,
          value: v.value,
          status: MODE_DRAFT,
        };
      })
      .filter(Boolean);

    if (!payload.length) {
      setStatus("Saved", "ok");
      return;
    }

    const { error } = await window.supabase
      .from(TABLE)
      .upsert(payload, { onConflict: "channel,slot,status" });

    if (error) {
      console.error("❌ Failed to save draft batch (Supabase)", error);
      setStatus("Save failed (check RLS)", "bad");
      return;
    }

    setStatus("Saved", "ok");
  }

  /* =========================
     Render editors (Phase 4)
     - Source selector: Editorial | Inventory
     - Editorial: Text or Image editor
     - Inventory: Picker that saves "__inv__:id" into value
     ✅ FIX: For featured.X.* slots, inventory selection binds ALL featured.X.* slots.
  ========================= */
  function renderEditor(entry) {
    const type = entry?.type || "text";
    const value = entry?.value ?? "";

    const isInventory = typeof value === "string" && value.startsWith(INV_PREFIX);
    const invId = isInventory ? value.slice(INV_PREFIX.length) : "";

    // Default source based on value
    const sourceDefault = isInventory ? "inventory" : "editorial";

    panelBody.innerHTML = `
      <div style="display:flex; gap:10px; align-items:flex-end; flex-wrap:wrap;">
        <div style="flex:1; min-width:180px;">
          <label>Source</label>
          <select id="sf_source">
            <option value="editorial"${sourceDefault === "editorial" ? " selected" : ""}>Editorial</option>
            <option value="inventory"${sourceDefault === "inventory" ? " selected" : ""}>Inventory</option>
          </select>
        </div>

        <div style="flex:1; min-width:180px;">
          <label>Editorial Type</label>
          <select id="sf_editorial_type"${sourceDefault === "inventory" ? " disabled" : ""}>
            <option value="text"${type === "text" && !isInventory ? " selected" : ""}>Text</option>
            <option value="image"${type === "image" && !isInventory ? " selected" : ""}>Image</option>
          </select>
        </div>
      </div>

      <div id="sf_editor" style="margin-top:12px;"></div>
    `;

    const sourceSel = $("#sf_source");
    const edTypeSel = $("#sf_editorial_type");
    const editorWrap = $("#sf_editor");

    const renderSourceBody = () => {
      const source = sourceSel.value;

      if (source === "inventory") {
        edTypeSel.disabled = true;
        renderInventoryPicker(editorWrap, invId);
      } else {
        edTypeSel.disabled = false;
        renderEditorialEditor(editorWrap, edTypeSel.value, isInventory ? "" : value);
      }
    };

    sourceSel.addEventListener("change", () => {
      renderSourceBody();
    });

    edTypeSel.addEventListener("change", () => {
      renderSourceBody();
    });

    renderSourceBody();
  }

  function renderEditorialEditor(root, type, value) {
    root.innerHTML = "";

    if (type === "text") {
      root.innerHTML = `
        <label>Text</label>
        <textarea id="sf_text" rows="4">${escapeHtml(value)}</textarea>
      `;
      $("#sf_text").oninput = (e) => {
        const v = e.target.value;
        applyText(v);
        queueDraftSave("text", v);
      };
      return;
    }

    // image
    root.innerHTML = `
      <label>Image URL</label>
      <input id="sf_img" type="text" value="${escapeAttr(value)}" />
      <div style="margin-top:10px; font-size:12px; opacity:.7;">
        Tip: Inventory mode is best for featured product cards (auto image + price).
      </div>
    `;
    $("#sf_img").oninput = (e) => {
      const v = e.target.value;
      applyImage(v);
      queueDraftSave("image", v);
    };
  }

  function renderInventoryPicker(root, currentId) {
    if (!state.invLoaded || !state.invItems.length) {
      root.innerHTML = `
        <div style="padding:10px; border:1px solid rgba(255,255,255,.12); border-radius:12px;">
          <div style="font-weight:600; margin-bottom:6px;">Inventory unavailable</div>
          <div style="opacity:.75; font-size:13px;">
            Could not load items from Edge Function. Check <code>storefront-catalog</code> availability.
          </div>
        </div>
      `;
      return;
    }

    const optionsHtml = state.invItems
      .map(it => `<option value="${escapeAttr(it.id)}"${it.id === currentId ? " selected" : ""}>${escapeHtml(it.name)}</option>`)
      .join("");

    const isFeatured = isFeaturedSlot(state.slot);
    const groupKey = getFeaturedGroupKey(state.slot);

    root.innerHTML = `
      <label>Search</label>
      <input id="sf_inv_search" type="text" placeholder="Type to filter…" />

      <div style="margin-top:10px;">
        <label>Pick item</label>
        <select id="sf_inv_select" size="8" style="height:auto;">
          ${optionsHtml}
        </select>
      </div>

      <div style="margin-top:10px; font-size:12px; opacity:.75;">
        Inventory mode saves a reference (item_type_id) and pulls image/price/title from the same source as Catalogue.
        ${isFeatured && groupKey ? `<div style="margin-top:6px; opacity:.85;"><b>Note:</b> This binds the entire featured card (<code>${escapeHtml(groupKey)}</code>) so image/title/price/subtitle stay synced.</div>` : ""}
      </div>
    `;

    const search = $("#sf_inv_search");
    const sel = $("#sf_inv_select");

    // Apply current selection immediately (if any)
    if (currentId) {
      if (isFeatured && groupKey) bindInventoryToFeaturedGroup(groupKey, currentId);
      else applyInventoryToSelectedSlot(currentId);
    }

    // Filter options client-side
    search.addEventListener("input", () => {
      const q = (search.value || "").toLowerCase().trim();
      const filtered = !q
        ? state.invItems
        : state.invItems.filter(it => it.name.toLowerCase().includes(q) || it.id.toLowerCase().includes(q));

      sel.innerHTML = filtered
        .map(it => `<option value="${escapeAttr(it.id)}"${it.id === sel.value ? " selected" : ""}>${escapeHtml(it.name)}</option>`)
        .join("");
    });

    sel.addEventListener("change", () => {
      const id = sel.value;
      if (!id) return;

      // ✅ FIX: featured cards bind as a group
      if (isFeatured && groupKey) {
        bindInventoryToFeaturedGroup(groupKey, id);
        return;
      }

      // Otherwise: previous behavior (single slot binding)
      const marker = `${INV_PREFIX}${id}`;
      queueDraftSave("text", marker);
      applyInventoryToSelectedSlot(id);
    });
  }

  /* =========================
     Apply changes
  ========================= */
  function applyText(text) {
    if (state.selectedEl) state.selectedEl.textContent = text;
  }

  function applyImage(url) {
    if (!state.selectedEl) return;

    if (state.selectedEl.tagName === "IMG") {
      state.selectedEl.src = url;
    } else {
      state.selectedEl.style?.setProperty("--img", `url("${url}")`);
      const innerImg = state.selectedEl.querySelector("img");
      if (innerImg) innerImg.src = url;
    }
  }

  function applyInventoryToSelectedSlot(itemId) {
    if (!state.selectedEl) return;
    applyInventoryToSlot(state.selectedEl, itemId);
  }

  function applyInventoryToSlot(slotRoot, itemId) {
    const it = state.invMap.get(String(itemId));
    if (!it) return;

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

    const titleEl =
      slotRoot.querySelector('[data-bind="title"]') ||
      slotRoot.querySelector(".product-title") ||
      slotRoot.querySelector("h1,h2,h3,h4");
    if (titleEl) titleEl.textContent = it.name;

    const priceEl =
      slotRoot.querySelector('[data-bind="price"]') ||
      slotRoot.querySelector(".product-price") ||
      slotRoot.querySelector(".price");
    if (priceEl) priceEl.textContent = formatUSD(it.price);

    slotRoot.dataset.boundItemId = String(itemId);
  }

  function formatUSD(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return "";
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(v);
  }

  /* =========================
     Draft save (debounced) + fallback
  ========================= */
  function queueDraftSave(type, value) {
    if (!state.slot) return;

    state.draft[state.slot] = { type, value };
    persistDraftLocal();

    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => {
      saveDraftToSupabase(state.slot, type, value);
    }, 350);
  }

  function persistDraftLocal() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state.draft));
    } catch (e) {
      console.warn("⚠️ localStorage failed", e);
    }
  }

  async function saveDraftToSupabase(slot, type, value) {
    if (!state.supabaseReady || !window.supabase) {
      setStatus("Saved (local)", "warn");
      return;
    }

    setStatus("Saving…", "dim");

    const { error } = await window.supabase
      .from(TABLE)
      .upsert(
        {
          channel: CHANNEL,
          slot,
          type,
          value,
          status: MODE_DRAFT,
        },
        { onConflict: "channel,slot,status" }
      );

    if (error) {
      console.error("❌ Failed to save draft (Supabase)", error);
      setStatus("Save failed (check RLS)", "bad");
      return;
    }

    setStatus("Saved", "ok");
  }

  /* =========================
     Load content (Supabase first, then local)
  ========================= */
  async function loadContent() {
    if (state.supabaseReady && window.supabase) {
      const ok = await loadFromSupabase();
      if (ok) return;
    }

    loadDraftFromLocal();
    applyContent(state.draft);
  }

  async function loadFromSupabase() {
    setStatus("Loading…", "dim");

    const { data, error } = await window.supabase
      .from(TABLE)
      .select("channel,slot,type,value,status")
      .eq("channel", CHANNEL);

    if (error) {
      console.error("❌ Load failed (Supabase)", error);
      setStatus("Load failed (check RLS)", "bad");
      return false;
    }

    state.published = {};
    state.draft = {};

    for (const row of data || []) {
      if (row.status === MODE_PUBLISHED) state.published[row.slot] = { type: row.type, value: row.value };
      if (row.status === MODE_DRAFT) state.draft[row.slot] = { type: row.type, value: row.value };
    }

    applyContent(state.published);
    applyContent(state.draft);

    persistDraftLocal();

    return true;
  }

  function loadDraftFromLocal() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") state.draft = parsed;
    } catch (e) {
      console.warn("⚠️ Failed to load local draft", e);
    }
  }

  function applyContent(content) {
    Object.entries(content || {}).forEach(([slot, entry]) => {
      const el = document.querySelector(`[data-slot="${slot}"]`);
      if (!el || !entry) return;

      if (entry.type === "text" && typeof entry.value === "string" && entry.value.startsWith(INV_PREFIX)) {
        const id = entry.value.slice(INV_PREFIX.length);

        // ✅ If a featured card somehow got inconsistent in DB, this visually re-syncs the group
        const groupKey = getFeaturedGroupKey(slot);
        if (groupKey) {
          const groupEls = getGroupSlotElements(groupKey);
          if (groupEls.length) {
            for (const ge of groupEls) {
              const gSlot = ge.getAttribute("data-slot") || "";
              if (!state.invLoaded) state.pendingInvBinds.set(gSlot, { el: ge, id });
              else applyInventoryToSlot(ge, id);
            }
            return;
          }
        }

        if (!state.invLoaded) {
          state.pendingInvBinds.set(slot, { el, id });
          return;
        }

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

  /* =========================
     Publish & Preview
  ========================= */
  function initPublishPreview() {
    previewBtn?.addEventListener("click", () => {
      applyContent(state.published);
      applyContent(state.draft);
      alert("Previewing draft");
    });

    publishBtn?.addEventListener("click", async () => {
      if (!state.supabaseReady || !window.supabase) {
        alert("Supabase not ready. Cannot publish right now.");
        return;
      }

      setStatus("Publishing…", "dim");

      const payload = Object.entries(state.draft).map(([slot, v]) => ({
        channel: CHANNEL,
        slot,
        type: v.type,
        value: v.value,
        status: MODE_PUBLISHED,
      }));

      const { error } = await window.supabase
        .from(TABLE)
        .upsert(payload, { onConflict: "channel,slot,status" });

      if (error) {
        console.error("❌ Publish failed", error);
        setStatus("Publish failed (check RLS)", "bad");
        alert("Publish failed");
        return;
      }

      state.published = { ...state.published, ...state.draft };

      applyContent(state.published);
      flushPendingInvBinds();

      setStatus("Published", "ok");
      alert("✅ Published successfully");
    });
  }

  /* =========================
     Admin bar status pill
  ========================= */
  function ensureStatusPill() {
    const bar = $(".admin-bar");
    if (!bar) return null;

    let pill = bar.querySelector("[data-admin-status]");
    if (pill) return pill;

    pill = document.createElement("span");
    pill.setAttribute("data-admin-status", "1");
    pill.style.cssText = `
      margin-left: 10px;
      padding: 4px 10px;
      border-radius: 999px;
      font: 12px/1 Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial;
      border: 1px solid rgba(255,255,255,0.14);
      background: rgba(255,255,255,0.06);
      color: rgba(255,255,255,0.85);
    `;

    const left = bar.querySelector(".admin-left");
    (left || bar).appendChild(pill);
    return pill;
  }

  function setStatus(text, tone = "dim") {
    if (!statusEl) return;
    statusEl.textContent = text;

    const tones = {
      ok:   { bg: "rgba(46, 204, 113, 0.14)", bd: "rgba(46, 204, 113, 0.35)", fg: "rgba(225,255,238,0.95)" },
      warn: { bg: "rgba(241, 196, 15, 0.14)", bd: "rgba(241, 196, 15, 0.35)", fg: "rgba(255,248,220,0.95)" },
      bad:  { bg: "rgba(231, 76, 60, 0.14)",  bd: "rgba(231, 76, 60, 0.35)",  fg: "rgba(255,230,230,0.95)" },
      dim:  { bg: "rgba(255,255,255,0.06)",   bd: "rgba(255,255,255,0.14)",   fg: "rgba(255,255,255,0.85)" },
    };

    const t = tones[tone] || tones.dim;
    statusEl.style.background = t.bg;
    statusEl.style.borderColor = t.bd;
    statusEl.style.color = t.fg;
  }

  /* =========================
     Escaping
  ========================= */
  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function escapeAttr(s) {
    return String(s ?? "").replaceAll('"', "&quot;");
  }
})();
