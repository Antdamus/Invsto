/* profile.js — OG Jewelers (Member Profile)
   MVP behavior (no DB required yet):
   - Requires Supabase session; otherwise redirect to join.html
   - Hydrates UI from:
     1) Supabase user email
     2) localStorage "og_join_context" (name, src, campaign)
     3) localStorage "og_member_prefs" (emailAlerts, earlyAccess, name)
   - Soft VIP modal shown once (stored flag in localStorage)
*/

(() => {
  "use strict";

  // ---------------------------
  // DOM helpers
  // ---------------------------
  const $ = (sel) => document.querySelector(sel);

  const yearEl = $("#year");
  const subtitleEl = $("#profileSubtitle");
  const statusEl = $("#status");

  const emailValueEl = $("#emailValue");
  const nameInput = $("#nameInput");
  const saveNameBtn = $("#saveNameBtn");

  const sourceChip = $("#sourceChip");
  const memberPill = $("#memberPill");
  const tierPill = $("#tierPill");

  const emailAlertsToggle = $("#emailAlertsToggle");
  const earlyAccessToggle = $("#earlyAccessToggle");
  const savePrefsBtn = $("#savePrefsBtn");

  const signOutBtn = $("#signOutBtn");

  const vipLearnBtn = $("#vipLearnBtn");
  const vipOpenBtn = $("#vipOpenBtn");

  // VIP modal
  const vipBackdrop = $("#vipBackdrop");
  const vipModal = $("#vipModal");
  const vipCloseBtn = $("#vipCloseBtn");
  const vipNotNowBtn = $("#vipNotNowBtn");
  const vipUpgradeBtn = $("#vipUpgradeBtn");

  // ---------------------------
  // State keys
  // ---------------------------
  const LS_JOIN_CTX = "og_join_context";
  const LS_PREFS = "og_member_prefs";
  const LS_VIP_SHOWN = "og_vip_modal_shown_once";

  // ---------------------------
  // UI helpers
  // ---------------------------
  function setStatus(message, kind = "info") {
    if (!statusEl) return;
    statusEl.textContent = message || "";
    statusEl.className = `status ${kind}`.trim();
  }

  function setSubtitle(text) {
    if (!subtitleEl) return;
    subtitleEl.textContent = text || "";
  }

  function setMemberPill(text) {
    if (memberPill) memberPill.textContent = text;
  }

  function safeParseJSON(s) {
    try { return JSON.parse(s); } catch { return null; }
  }

  function getJoinContext() {
    return safeParseJSON(localStorage.getItem(LS_JOIN_CTX)) || null;
  }

  function getPrefs() {
    return safeParseJSON(localStorage.getItem(LS_PREFS)) || null;
  }

  function setPrefs(prefs) {
    localStorage.setItem(LS_PREFS, JSON.stringify(prefs));
  }

  function showVipModal() {
    if (vipBackdrop) vipBackdrop.hidden = false;
    if (vipModal) vipModal.hidden = false;
    document.body.classList.add("modal-open");
  }

  function hideVipModal() {
    if (vipBackdrop) vipBackdrop.hidden = true;
    if (vipModal) vipModal.hidden = true;
    document.body.classList.remove("modal-open");
  }

  function shouldSoftShowVipModal() {
    // Only show once per browser (MVP). Later we can key it per-user in DB.
    return localStorage.getItem(LS_VIP_SHOWN) !== "1";
  }

  function markVipModalShown() {
    localStorage.setItem(LS_VIP_SHOWN, "1");
  }

  // ---------------------------
  // Supabase ready gate
  // ---------------------------
  function waitForSupabaseReady() {
    return new Promise((resolve) => {
      if (window.supabase) return resolve(window.supabase);
      const onReady = () => {
        document.removeEventListener("supabase-ready", onReady);
        resolve(window.supabase);
      };
      document.addEventListener("supabase-ready", onReady);
    });
  }

  // ---------------------------
  // Main init
  // ---------------------------
  async function init() {
    // footer year
    if (yearEl) yearEl.textContent = String(new Date().getFullYear());

    // modal wiring
    vipCloseBtn?.addEventListener("click", () => { hideVipModal(); markVipModalShown(); });
    vipNotNowBtn?.addEventListener("click", () => { hideVipModal(); markVipModalShown(); });
    vipBackdrop?.addEventListener("click", () => { hideVipModal(); markVipModalShown(); });

    vipUpgradeBtn?.addEventListener("click", () => {
      // Later: go to pricing / checkout. For now, anchor to VIP panel.
      hideVipModal();
      markVipModalShown();
      window.location.hash = "vip";
      $("#vipPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    vipLearnBtn?.addEventListener("click", () => {
      window.location.hash = "vip";
      $("#vipPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
      // soft show modal if user explicitly asks
      showVipModal();
    });

    vipOpenBtn?.addEventListener("click", () => {
      showVipModal();
    });

    // sign out
    signOutBtn?.addEventListener("click", onSignOut);

    // Ensure Supabase exists
    await waitForSupabaseReady();
    if (!window.supabase) {
      setSubtitle("Supabase is not initialized.");
      setStatus("Check initSupabase.js loading order.", "error");
      return;
    }

    // Require session
    const { data: { session }, error } = await window.supabase.auth.getSession();
    if (error) console.warn("Session error:", error);

    if (!session) {
      // Not logged in → back to join
      window.location.href = "join.html";
      return;
    }

    // Hydrate UI from session
    const user = session.user;
    const email = user?.email || "—";

    if (emailValueEl) emailValueEl.textContent = email;

    // Context (from join page)
    const ctx = getJoinContext();
    const src = ctx?.src || "direct";
    const campaign = ctx?.campaign || "";

    if (sourceChip) {
      sourceChip.textContent = campaign ? `source: ${src} • ${campaign}` : `source: ${src}`;
    }

    // Load prefs (local)
    const existingPrefs = getPrefs();

    // Default prefs if none exist
    const defaults = {
      name: (existingPrefs?.name ?? ctx?.name ?? ""),
      emailAlerts: (existingPrefs?.emailAlerts ?? true),
      earlyAccess: (existingPrefs?.earlyAccess ?? true),
      lastUpdatedAt: new Date().toISOString()
    };

    // Apply to UI
    if (nameInput) nameInput.value = defaults.name || "";
    if (emailAlertsToggle) emailAlertsToggle.checked = !!defaults.emailAlerts;
    if (earlyAccessToggle) earlyAccessToggle.checked = !!defaults.earlyAccess;

    // Save back (in case it was missing)
    setPrefs(defaults);

    setMemberPill("Member");
    if (tierPill) tierPill.textContent = "Free Member";

    // Subtitle greeting
    const greet = defaults.name ? `Welcome back, ${defaults.name}.` : "Welcome back.";
    setSubtitle(`${greet} Manage your alerts and access here.`);

    // Save handlers
    saveNameBtn?.addEventListener("click", () => saveName());
    savePrefsBtn?.addEventListener("click", () => savePrefs());

    // If user landed here from magic link, show a premium success moment
    // (Supabase adds tokens in URL; initSupabase uses detectSessionInUrl)
    // We'll just show a gentle success message once per visit.
    setStatus("✅ You’re in. Your membership is active.", "success");

    // Soft VIP modal: show after a tiny delay, only once
    if (shouldSoftShowVipModal()) {
      window.setTimeout(() => {
        showVipModal();
        // Note: we only mark as "shown" when they dismiss or click continue,
        // so if they refresh immediately it can reappear — that’s okay for MVP.
      }, 650);
    }

    // If URL has #vip, scroll to VIP panel
    if (window.location.hash === "#vip") {
      $("#vipPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  // ---------------------------
  // Actions
  // ---------------------------
  function saveName() {
    setStatus("");

    const prefs = getPrefs() || {};
    const name = String(nameInput?.value || "").trim();

    // Save local
    const updated = {
      ...prefs,
      name,
      lastUpdatedAt: new Date().toISOString()
    };
    setPrefs(updated);

    // Update subtitle instantly
    const greet = name ? `Welcome back, ${name}.` : "Welcome back.";
    setSubtitle(`${greet} Manage your alerts and access here.`);

    setStatus("✅ Name saved.", "success");
  }

  function savePrefs() {
    setStatus("");

    const prefs = getPrefs() || {};
    const updated = {
      ...prefs,
      emailAlerts: !!emailAlertsToggle?.checked,
      earlyAccess: !!earlyAccessToggle?.checked,
      lastUpdatedAt: new Date().toISOString()
    };
    setPrefs(updated);

    const onOff = updated.emailAlerts ? "ON" : "OFF";
    setStatus(`✅ Preferences saved. Email alerts are ${onOff}.`, "success");
  }

  async function onSignOut() {
    setStatus("");
    try {
      await window.supabase.auth.signOut();
    } catch (e) {
      console.warn("Sign out failed:", e);
    } finally {
      window.location.href = "join.html";
    }
  }

  // boot
  init();
})();
