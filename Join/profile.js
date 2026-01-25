/* profile.js — OG Jewelers (Member Profile)
   Supabase persistence + luxury UX polish:
   - Uses public.members keyed by auth.user.id
   - RLS privacy enforced (users only see/update their own row)
   - Handles OTP hash errors (otp_expired, etc.) gracefully
   - Race-proof Supabase client detection (CDN global vs actual client)
   - New vs returning member greeting + VIP modal only for NEW members
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

  function getPrefsLocal() {
    return safeParseJSON(localStorage.getItem(LS_PREFS)) || null;
  }

  function setPrefsLocal(prefs) {
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
    return localStorage.getItem(LS_VIP_SHOWN) !== "1";
  }

  function markVipModalShown() {
    localStorage.setItem(LS_VIP_SHOWN, "1");
  }

  // NEW vs RETURNING heuristic (works well without extra columns)
  function isNewMemberRow(member) {
    if (!member?.created_at || !member?.updated_at) return false;

    const c = new Date(member.created_at).getTime();
    const u = new Date(member.updated_at).getTime();

    if (!Number.isFinite(c) || !Number.isFinite(u)) return false;

    // New row typically has created_at ≈ updated_at
    return Math.abs(u - c) < 90_000; // 90 seconds
  }

  // ---------------------------
  // Supabase ready gate (race-proof)
  // ---------------------------
  function getSupabaseClientIfReady() {
    // initSupabase.js should set window.supabaseClient and/or window.supabase to the CLIENT.
    // BUT the CDN may also create window.supabase as a library namespace.
    // We only accept an object that has auth.getSession().
    const c = window.supabaseClient || window.supabase;
    if (c && c.auth && typeof c.auth.getSession === "function") return c;
    return null;
  }

  function waitForSupabaseReady() {
    return new Promise((resolve) => {
      const readyNow = getSupabaseClientIfReady();
      if (readyNow) return resolve(readyNow);

      const onReady = () => {
        document.removeEventListener("supabase-ready", onReady);
        const client = getSupabaseClientIfReady();
        resolve(client || null);
      };

      document.addEventListener("supabase-ready", onReady);

      // Safety: poll briefly in case the event never fires (load race)
      const t0 = Date.now();
      const timer = setInterval(() => {
        const client = getSupabaseClientIfReady();
        if (client) {
          clearInterval(timer);
          document.removeEventListener("supabase-ready", onReady);
          resolve(client);
        } else if (Date.now() - t0 > 3000) {
          clearInterval(timer);
          document.removeEventListener("supabase-ready", onReady);
          resolve(null);
        }
      }, 50);
    });
  }

  // ---------------------------
  // Supabase helpers (members table)
  // ---------------------------
  async function upsertAndFetchMember(sb, { userId, email, ctx }) {
    const src = String(ctx?.src || "direct");
    const campaign = String(ctx?.campaign || "") || null;
    const ctxName = String(ctx?.name || "").trim() || null;

    // local prefs fallback (first-load convenience)
    const localPrefs = getPrefsLocal() || {};
    const localName = String(localPrefs?.name || "").trim() || null;

    const upsertPayload = {
      id: userId,
      email,
      name: localName || ctxName,
      source: src || "direct",
      campaign,
      email_alerts: (localPrefs?.emailAlerts ?? true),
      early_access: (localPrefs?.earlyAccess ?? true),
    };

    const { error: upsertError } = await sb
      .from("members")
      .upsert(upsertPayload, { onConflict: "id" });

    if (upsertError) throw upsertError;

    const { data, error: fetchError } = await sb
      .from("members")
      .select("*")
      .eq("id", userId)
      .single();

    if (fetchError) throw fetchError;
    return data;
  }

  async function updateMember(sb, userId, patch) {
    const { error } = await sb
      .from("members")
      .update(patch)
      .eq("id", userId);

    if (error) throw error;
  }

  // ---------------------------
  // Auth hash error handler
  // ---------------------------
  function handleAuthHashErrorsOrNull() {
    const hash = window.location.hash || "";
    if (!hash.includes("error_code=")) return null;

    const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
    const code = params.get("error_code");
    const desc = params.get("error_description");

    if (!code) return null;

    const nice =
      code === "otp_expired"
        ? "That sign-in link has expired (or was already used). Please request a fresh link."
        : (desc ? decodeURIComponent(desc.replace(/\+/g, " ")) : "Sign-in failed. Please try again.");

    // Clear hash so it doesn't stick on refresh
    history.replaceState(null, "", window.location.pathname);

    return nice;
  }

  // ---------------------------
  // Main init
  // ---------------------------
  async function init() {
    const authHashError = handleAuthHashErrorsOrNull();
    if (authHashError) {
      setSubtitle("Sign-in link issue");
      setStatus(`⚠️ ${authHashError}`, "error");
      setTimeout(() => { window.location.href = "join.html"; }, 1600);
      return;
    }

    if (yearEl) yearEl.textContent = String(new Date().getFullYear());

    // Modal wiring
    vipCloseBtn?.addEventListener("click", () => { hideVipModal(); markVipModalShown(); });
    vipNotNowBtn?.addEventListener("click", () => { hideVipModal(); markVipModalShown(); });
    vipBackdrop?.addEventListener("click", () => { hideVipModal(); markVipModalShown(); });

    vipUpgradeBtn?.addEventListener("click", () => {
      hideVipModal();
      markVipModalShown();
      window.location.hash = "vip";
      $("#vipPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    vipLearnBtn?.addEventListener("click", () => {
      window.location.hash = "vip";
      $("#vipPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
      showVipModal();
      // user expressed interest (we'll persist later when VIP is real)
    });

    vipOpenBtn?.addEventListener("click", () => showVipModal());

    // Sign out
    signOutBtn?.addEventListener("click", onSignOut);

    // Ensure Supabase exists (client, not CDN namespace)
    const sb = await waitForSupabaseReady();
    if (!sb) {
      setSubtitle("Supabase is not initialized.");
      setStatus("Check initSupabase.js loading order.", "error");
      return;
    }

    // Require session
    const { data: { session }, error } = await sb.auth.getSession();
    if (error) console.warn("Session error:", error);

    if (!session) {
      window.location.href = "join.html";
      return;
    }

    const user = session.user;
    const userId = user?.id;
    const email = user?.email || "—";

    if (!userId) {
      setSubtitle("Missing user session.");
      setStatus("Please sign in again.", "error");
      window.location.href = "join.html";
      return;
    }

    if (emailValueEl) emailValueEl.textContent = email;

    const ctx = getJoinContext();

    // Upsert + fetch member row
    let member = null;
    let isNew = false;

    try {
      member = await upsertAndFetchMember(sb, { userId, email, ctx });
      isNew = isNewMemberRow(member);
    } catch (e) {
      console.error("Member upsert/fetch failed:", e);
      setStatus("⚠️ Could not load your saved profile yet. Using local settings for now.", "error");
    }

    // Hydrate UI from member row (preferred), else local
    const localPrefs = getPrefsLocal() || {};
    const name = (member?.name ?? localPrefs?.name ?? ctx?.name ?? "") || "";
    const emailAlerts = (member?.email_alerts ?? localPrefs?.emailAlerts ?? true);
    const earlyAccess = (member?.early_access ?? localPrefs?.earlyAccess ?? true);

    if (nameInput) nameInput.value = name;
    if (emailAlertsToggle) emailAlertsToggle.checked = !!emailAlerts;
    if (earlyAccessToggle) earlyAccessToggle.checked = !!earlyAccess;

    // Source chip
    const src = member?.source || ctx?.src || "direct";
    const campaign = member?.campaign || ctx?.campaign || "";
    if (sourceChip) {
      sourceChip.textContent = campaign ? `source: ${src} • ${campaign}` : `source: ${src}`;
    }

    setMemberPill("Member");

    // Tier pill (future)
    const vipStatus = member?.vip_status || "free";
    if (tierPill) tierPill.textContent = vipStatus === "vip" ? "VIP Member" : "Free Member";

    // Greeting + success moment (NEW vs RETURNING)
    if (isNew) {
      setSubtitle("Welcome to OG. Your membership is active.");
      setStatus("✅ Membership activated. You’re on the list for live alerts and early access.", "success");
    } else {
      const greet = name ? `Welcome back, ${name}.` : "Welcome back.";
      setSubtitle(`${greet} Manage your alerts and access here.`);
      setStatus("", "info");
    }

    // Save handlers (use sb + userId)
    saveNameBtn?.addEventListener("click", () => saveName(sb, userId));
    savePrefsBtn?.addEventListener("click", () => savePrefs(sb, userId));

    // Soft VIP modal only for NEW members (and only once)
    if (isNew && shouldSoftShowVipModal()) {
      window.setTimeout(() => {
        showVipModal();
        markVipModalShown(); // once means once
      }, 650);
    }

    if (window.location.hash === "#vip") {
      $("#vipPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  // ---------------------------
  // Actions
  // ---------------------------
  async function saveName(sb, userId) {
    setStatus("");

    const name = String(nameInput?.value || "").trim();

    // Update local immediately
    const local = getPrefsLocal() || {};
    setPrefsLocal({ ...local, name, lastUpdatedAt: new Date().toISOString() });

    // Update subtitle immediately
    const greet = name ? `Welcome back, ${name}.` : "Welcome back.";
    setSubtitle(`${greet} Manage your alerts and access here.`);

    // Persist to DB
    try {
      await updateMember(sb, userId, { name: name || null });
      setStatus("✅ Name saved.", "success");
    } catch (e) {
      console.error("Save name failed:", e);
      setStatus("⚠️ Name saved locally, but couldn’t sync yet.", "error");
    }
  }

  async function savePrefs(sb, userId) {
    setStatus("");

    const emailAlerts = !!emailAlertsToggle?.checked;
    const earlyAccess = !!earlyAccessToggle?.checked;

    // Update local immediately
    const local = getPrefsLocal() || {};
    setPrefsLocal({
      ...local,
      emailAlerts,
      earlyAccess,
      lastUpdatedAt: new Date().toISOString()
    });

    // Persist to DB
    try {
      await updateMember(sb, userId, { email_alerts: emailAlerts, early_access: earlyAccess });
      const onOff = emailAlerts ? "ON" : "OFF";
      setStatus(`✅ Preferences saved. Email alerts are ${onOff}.`, "success");
    } catch (e) {
      console.error("Save prefs failed:", e);
      setStatus("⚠️ Preferences saved locally, but couldn’t sync yet.", "error");
    }
  }

  async function onSignOut() {
    setStatus("");
    try {
      const sb = getSupabaseClientIfReady();
      if (sb) await sb.auth.signOut();
    } catch (e) {
      console.warn("Sign out failed:", e);
    } finally {
      window.location.href = "join.html";
    }
  }

  // boot
  init();
})();
