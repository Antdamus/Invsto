/* profile.js — OG Jewelers (Member Profile)
   Now with Supabase persistence:
   - Upserts/reads public.members keyed by auth.user.id
   - RLS enforces privacy (users only see/update their own row)
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

function isNewMemberRow(member) {
  // New row typically has created_at ≈ updated_at (no updates yet)
  // We'll treat "new" as created/updated within ~90 seconds.
  if (!member?.created_at || !member?.updated_at) return false;

  const c = new Date(member.created_at).getTime();
  const u = new Date(member.updated_at).getTime();

  if (!Number.isFinite(c) || !Number.isFinite(u)) return false;

  const diff = Math.abs(u - c);
  return diff < 90_000; // 90 seconds
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
  // Supabase helpers (members table)
  // ---------------------------
  async function upsertAndFetchMember({ userId, email, ctx }) {
    const src = String(ctx?.src || "direct");
    const campaign = String(ctx?.campaign || "") || null;
    const ctxName = String(ctx?.name || "").trim() || null;

    // local prefs fallback
    const localPrefs = getPrefsLocal() || {};
    const localName = String(localPrefs?.name || "").trim() || null;

    // We upsert a baseline row (doesn't overwrite good data unnecessarily)
    // Then we fetch the row to hydrate UI.
    const upsertPayload = {
      id: userId,
      email,
      name: localName || ctxName,          // only initial preference; user can change
      source: src || "direct",
      campaign,
      email_alerts: (localPrefs?.emailAlerts ?? true),
      early_access: (localPrefs?.earlyAccess ?? true)
    };

    // Upsert
    const { error: upsertError } = await window.supabase
      .from("members")
      .upsert(upsertPayload, { onConflict: "id" });

    if (upsertError) throw upsertError;

    // Fetch
    const { data, error: fetchError } = await window.supabase
      .from("members")
      .select("*")
      .eq("id", userId)
      .single();

    if (fetchError) throw fetchError;
    return data;
  }

  async function updateMember(userId, patch) {
    const { error } = await window.supabase
      .from("members")
      .update(patch)
      .eq("id", userId);

    if (error) throw error;
  }

  // ---------------------------
  // Main init
  // ---------------------------
async function init() {
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  // modal wiring
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
  });

  vipOpenBtn?.addEventListener("click", () => showVipModal());

  // sign out
  signOutBtn?.addEventListener("click", onSignOut);

  // ensure supabase exists
  await waitForSupabaseReady();
  if (!window.supabase) {
    setSubtitle("Supabase is not initialized.");
    setStatus("Check initSupabase.js loading order.", "error");
    return;
  }

  // require session
  const { data: { session }, error } = await window.supabase.auth.getSession();
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
    member = await upsertAndFetchMember({ userId, email, ctx });
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
    // keep status quiet for returning users
    setStatus("", "info");
  }

  // Save handlers
  saveNameBtn?.addEventListener("click", () => saveName(userId));
  savePrefsBtn?.addEventListener("click", () => savePrefs(userId));

  // Soft VIP modal: only for NEW members (and only once per browser)
 if (isNew && shouldSoftShowVipModal()) {
  window.setTimeout(() => {
    showVipModal();
    markVipModalShown();
  }, 650);
}


  if (window.location.hash === "#vip") {
    $("#vipPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}


  // ---------------------------
  // Actions
  // ---------------------------
  async function saveName(userId) {
    setStatus("");

    const name = String(nameInput?.value || "").trim();

    // Update local immediately (snappy UX)
    const local = getPrefsLocal() || {};
    setPrefsLocal({ ...local, name, lastUpdatedAt: new Date().toISOString() });

    // Update subtitle
    const greet = name ? `Welcome back, ${name}.` : "Welcome back.";
    setSubtitle(`${greet} Manage your alerts and access here.`);

    // Persist to DB
    try {
      await updateMember(userId, { name: name || null });
      setStatus("✅ Name saved.", "success");
    } catch (e) {
      console.error("Save name failed:", e);
      setStatus("⚠️ Name saved locally, but couldn’t sync yet.", "error");
    }
  }

  async function savePrefs(userId) {
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
      await updateMember(userId, { email_alerts: emailAlerts, early_access: earlyAccess });
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
