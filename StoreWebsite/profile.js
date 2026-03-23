/* profile.js - OG Jewelers (Member Profile)
   Supabase persistence + luxury member portal polish:
   - Uses public.members keyed by auth.user.id
   - RLS privacy enforced (users only see/update their own row)
   - Handles OTP hash errors (otp_expired, etc.) gracefully
   - Race-proof Supabase client detection (CDN global vs actual client)
   - New vs returning member greeting + VIP modal only for NEW members
*/

(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  const yearEl = $("#year");
  const profileTitleEl = $("#profileTitle");
  const subtitleEl = $("#profileSubtitle");
  const statusEl = $("#status");

  const emailValueEl = $("#emailValue");
  const nameInput = $("#nameInput");
  const saveNameBtn = $("#saveNameBtn");

  const sourceChip = $("#sourceChip");
  const memberPill = $("#memberPill");
  const tierPill = $("#tierPill");
  const vipChip = $("#vipChip");

  const emailAlertsToggle = $("#emailAlertsToggle");
  const earlyAccessToggle = $("#earlyAccessToggle");
  const savePrefsBtn = $("#savePrefsBtn");

  const signOutBtn = $("#signOutBtn");
  const inlineSignOutBtn = $('[data-action="profile-signout"]');

  const vipLearnBtn = $("#vipLearnBtn");
  const vipOpenBtn = $("#vipOpenBtn");

  const vipBackdrop = $("#vipBackdrop");
  const vipModal = $("#vipModal");
  const vipCloseBtn = $("#vipCloseBtn");
  const vipNotNowBtn = $("#vipNotNowBtn");
  const vipUpgradeBtn = $("#vipUpgradeBtn");

  const LS_JOIN_CTX = "og_join_context";
  const LS_PREFS = "og_member_prefs";
  const LS_VIP_SHOWN = "og_vip_modal_shown_once";

  function setStatus(message, kind = "info") {
    if (!statusEl) return;
    statusEl.textContent = message || "";
    statusEl.className = `status status-panel ${kind}`.trim();
  }

  function setSubtitle(text) {
    if (subtitleEl) subtitleEl.textContent = text || "";
  }

  function setTitle(text) {
    if (profileTitleEl) profileTitleEl.textContent = text || "";
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

  function computeDefaultPrefsFromCtx(ctx) {
    const flow = String(ctx?.flow || "").toLowerCase();
    const optedIn = ctx?.marketing_opt_in === true;

    if (flow === "join" && optedIn) {
      return { emailAlerts: true, earlyAccess: true };
    }

    return { emailAlerts: false, earlyAccess: false };
  }

  function isNewMemberRow(member) {
    if (!member?.created_at || !member?.updated_at) return false;

    const createdAt = new Date(member.created_at).getTime();
    const updatedAt = new Date(member.updated_at).getTime();

    if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt)) return false;

    return Math.abs(updatedAt - createdAt) < 90_000;
  }

  function getSupabaseClientIfReady() {
    const client = window.supabaseClient || window.supabase;
    if (client && client.auth && typeof client.auth.getSession === "function") return client;
    return null;
  }

  function waitForSupabaseReady() {
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
        } else if (Date.now() - t0 > 3000) {
          clearInterval(timer);
          document.removeEventListener("supabase-ready", onReady);
          resolve(null);
        }
      }, 50);
    });
  }

  async function upsertAndFetchMember(sb, { userId, email, ctx }) {
    const src = String(ctx?.src || "direct");
    const campaign = String(ctx?.campaign || "") || null;
    const ctxName = String(ctx?.name || "").trim() || null;

    const localPrefs = getPrefsLocal() || {};
    const localName = String(localPrefs?.name || "").trim() || null;
    const ctxDefaults = computeDefaultPrefsFromCtx(ctx);

    const upsertPayload = {
      id: userId,
      email,
      name: localName || ctxName,
      source: src || "direct",
      campaign,
      email_alerts: localPrefs?.emailAlerts ?? ctxDefaults.emailAlerts,
      early_access: localPrefs?.earlyAccess ?? ctxDefaults.earlyAccess,
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

  function handleAuthHashErrorsOrNull() {
    const hash = window.location.hash || "";
    if (!hash.includes("error_code=")) return null;

    const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
    const code = params.get("error_code");
    const desc = params.get("error_description");

    if (!code) return null;

    const nice =
      code === "otp_expired"
        ? "That sign-in link has expired or was already used. Please request a fresh link."
        : (desc ? decodeURIComponent(desc.replace(/\+/g, " ")) : "Sign-in failed. Please try again.");

    history.replaceState(null, "", window.location.pathname);
    return nice;
  }

  function applyMembershipTone({ name, isNew, emailAlerts, earlyAccess, vipStatus }) {
    const hasName = !!name;
    const personalName = hasName ? `, ${name}` : "";
    const isVip = vipStatus === "vip";

    if (isVip) {
      setMemberPill("VIP Member");
      if (vipChip) vipChip.textContent = "VIP Active";
      setTitle(`Welcome back${personalName}. Your VIP lane is open.`);
      setSubtitle("Your member lounge is active with priority access, private release timing, and collector updates shaped around the OG world.");
      return;
    }

    setMemberPill("Private Member");

    if (isNew) {
      setTitle(hasName ? `Welcome back, ${name}.` : "Welcome back.");
      if (emailAlerts || earlyAccess) {
        setSubtitle("Your membership is active, and your alerts are already set to keep you close to lives, drops, and early access moments.");
      } else {
        setSubtitle("Your membership is active. Set your alert preferences below to shape how closely you stay connected to upcoming OG moments.");
      }
      return;
    }

    setTitle(hasName ? `Welcome back, ${name}.` : "Welcome back.");
    setSubtitle("This is your private member access for alerts, live timing, and early access preferences.");
  }

  async function init() {
    const authHashError = handleAuthHashErrorsOrNull();
    if (authHashError) {
      setTitle("Private access needs a fresh link.");
      setSubtitle("We could not complete your member sign-in.");
      setStatus(authHashError, "error");
      setTimeout(() => { window.location.href = "join.html"; }, 1600);
      return;
    }

    if (yearEl) yearEl.textContent = String(new Date().getFullYear());

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

    signOutBtn?.addEventListener("click", onSignOut);
    inlineSignOutBtn?.addEventListener("click", onSignOut);

    const sb = await waitForSupabaseReady();
    if (!sb) {
      setTitle("Private member access is not ready.");
      setSubtitle("The OG lounge could not finish loading.");
      setStatus("Check initSupabase.js loading order.", "error");
      return;
    }

    const { data: { session }, error } = await sb.auth.getSession();
    if (error) console.warn("Session error:", error);

    if (!session) {
      window.location.href = "join.html";
      return;
    }

    const user = session.user;
    const userId = user?.id;
    const email = user?.email || "-";

    if (!userId) {
      setTitle("Your member session could not be restored.");
      setSubtitle("Please sign in again to continue.");
      setStatus("Missing user session.", "error");
      window.location.href = "join.html";
      return;
    }

    if (emailValueEl) emailValueEl.textContent = email;

    const ctx = getJoinContext();

    let member = null;
    let isNew = false;

    try {
      member = await upsertAndFetchMember(sb, { userId, email, ctx });
      isNew = isNewMemberRow(member);
    } catch (e) {
      console.error("Member upsert/fetch failed:", e);
      setStatus("Could not load your saved profile yet. Using local settings for now.", "error");
    }

    const localPrefs = getPrefsLocal() || {};
    const ctxDefaults = computeDefaultPrefsFromCtx(ctx);

    const name = (member?.name ?? localPrefs?.name ?? ctx?.name ?? "") || "";
    const emailAlerts = member?.email_alerts ?? localPrefs?.emailAlerts ?? ctxDefaults.emailAlerts;
    const earlyAccess = member?.early_access ?? localPrefs?.earlyAccess ?? ctxDefaults.earlyAccess;

    if (nameInput) nameInput.value = name;
    if (emailAlertsToggle) emailAlertsToggle.checked = !!emailAlerts;
    if (earlyAccessToggle) earlyAccessToggle.checked = !!earlyAccess;

    const src = member?.source || ctx?.src || "direct";
    const campaign = member?.campaign || ctx?.campaign || "";
    if (sourceChip) {
      sourceChip.textContent = campaign ? `source: ${src} | ${campaign}` : `source: ${src}`;
    }

    const vipStatus = member?.vip_status || "free";
    if (tierPill) tierPill.textContent = vipStatus === "vip" ? "VIP Member" : "Free Member";

    applyMembershipTone({
      name,
      isNew,
      emailAlerts: !!emailAlerts,
      earlyAccess: !!earlyAccess,
      vipStatus
    });

    if (isNew) {
      if (emailAlerts || earlyAccess) {
        setStatus("Membership activated. Your alerts and early access settings are ready, and you can refine them anytime.", "success");
      } else {
        setStatus("Membership activated. Choose how closely you want to stay connected below.", "success");
      }
    } else {
      setStatus("", "info");
    }

    saveNameBtn?.addEventListener("click", () => saveName(sb, userId, vipStatus));
    savePrefsBtn?.addEventListener("click", () => savePrefs(sb, userId));

    if (window.location.hash === "#vip") {
      $("#vipPanel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (isNew && shouldSoftShowVipModal()) {
      window.setTimeout(() => {
        showVipModal();
      }, 500);
    }
  }

  async function saveName(sb, userId, vipStatus = "free") {
    setStatus("");

    const name = String(nameInput?.value || "").trim();
    const local = getPrefsLocal() || {};
    setPrefsLocal({ ...local, name, lastUpdatedAt: new Date().toISOString() });

    applyMembershipTone({
      name,
      isNew: false,
      emailAlerts: !!emailAlertsToggle?.checked,
      earlyAccess: !!earlyAccessToggle?.checked,
      vipStatus
    });

    try {
      await updateMember(sb, userId, { name: name || null });
      setStatus("Your member name has been saved.", "success");
    } catch (e) {
      console.error("Save name failed:", e);
      setStatus("Your name was saved locally, but could not sync yet.", "error");
    }
  }

  async function savePrefs(sb, userId) {
    setStatus("");

    const emailAlerts = !!emailAlertsToggle?.checked;
    const earlyAccess = !!earlyAccessToggle?.checked;

    const local = getPrefsLocal() || {};
    setPrefsLocal({
      ...local,
      emailAlerts,
      earlyAccess,
      lastUpdatedAt: new Date().toISOString()
    });

    try {
      await updateMember(sb, userId, { email_alerts: emailAlerts, early_access: earlyAccess });
      const summary = emailAlerts
        ? "Preferences saved. You will stay close to lives, drops, and member timing."
        : "Preferences saved. Live and drop alerts are currently paused.";
      setStatus(summary, "success");
    } catch (e) {
      console.error("Save prefs failed:", e);
      setStatus("Your preferences were saved locally, but could not sync yet.", "error");
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

  init();
})();
