/* =========================================================
   admin-storefront.js — OG Jewelers
   Phase 3 (Hardened): Draft persistence + Publish + Fallback
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

  const state = {
    selectedEl: null,
    slot: null,
    draft: {},      // { slot: {type, value} }
    published: {},  // { slot: {type, value} }
    saveTimer: null,
    supabaseReady: false,
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

  // Boot sequence: wait for Supabase, then load. If Supabase fails, fall back to local.
  boot();

  async function boot() {
    setStatus("Loading…", "dim");

    await waitForSupabase(2500); // waits up to 2.5s
    await loadContent();         // tries Supabase first, then local fallback

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
     Render editors
  ========================= */
  function renderEditor({ type, value }) {
    panelBody.innerHTML = "";

    if (type === "text") {
      panelBody.innerHTML = `<label>Text</label><textarea rows="4">${escapeHtml(value)}</textarea>`;
      panelBody.querySelector("textarea").oninput = e => {
        const v = e.target.value;
        applyText(v);
        queueDraftSave("text", v);
      };
    }

    if (type === "image") {
      panelBody.innerHTML = `<label>Image URL</label><input type="text" value="${escapeAttr(value)}" />`;
      panelBody.querySelector("input").oninput = e => {
        const v = e.target.value;
        applyImage(v);
        queueDraftSave("image", v);
      };
    }
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function escapeAttr(s) {
    return String(s ?? "").replaceAll('"', "&quot;");
  }

  /* =========================
     Apply changes
  ========================= */
  function applyText(text) {
    if (state.selectedEl) state.selectedEl.textContent = text;
  }

  function applyImage(url) {
    if (!state.selectedEl) return;
    // Support both --img elements and <img>
    if (state.selectedEl.tagName === "IMG") {
      state.selectedEl.src = url;
    } else {
      state.selectedEl.style?.setProperty("--img", `url("${url}")`);
    }
  }

  /* =========================
     Draft save (debounced) + fallback
  ========================= */
  function queueDraftSave(type, value) {
    if (!state.slot) return;

    state.draft[state.slot] = { type, value };
    persistDraftLocal(); // always keep local backup so refresh never loses work

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
      // keep local backup already done
      return;
    }

    setStatus("Saved", "ok");
  }

  /* =========================
     Load content (Supabase first, then local)
  ========================= */
  async function loadContent() {
    // 1) Try Supabase load
    if (state.supabaseReady && window.supabase) {
      const ok = await loadFromSupabase();
      if (ok) return;
    }

    // 2) Fallback to local
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

    // reset caches
    state.published = {};
    state.draft = {};

    for (const row of data || []) {
      if (row.status === MODE_PUBLISHED) state.published[row.slot] = { type: row.type, value: row.value };
      if (row.status === MODE_DRAFT) state.draft[row.slot] = { type: row.type, value: row.value };
    }

    // Apply published, then draft overrides in admin view
    applyContent(state.published);
    applyContent(state.draft);

    // Also refresh local backup from what DB says (so you can recover offline later)
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
      // Always allow publish even if Supabase not ready — but warn.
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

      // update published snapshot and keep the UI consistent
      state.published = { ...state.published, ...state.draft };
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
})();
