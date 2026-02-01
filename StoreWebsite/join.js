/* =========================================================
   join.js — OG Jewelers (Join / Alerts Signup)
   - Email-only + consent
   - Passwordless (magic link)
   - Uses Edge Function proxy (rate-limited) instead of direct signInWithOtp
   - Client cooldown: 60s (prevents accidental resends)
   - Neutral messaging (security)
   - Race-proof Supabase readiness
   - Reads URL params: ?src=package|social&campaign=...
   ========================================================= */

(() => {
  "use strict";

  // ---------------------------
  // DOM
  // ---------------------------
  const $ = (sel) => document.querySelector(sel);

  const form = $("#joinForm");
  const nameEl = $("#name");
  const emailEl = $("#email");
  const consentEl = $("#consent");
  const statusEl = $("#status");
  const submitBtn = $("#submitBtn");
  const btnText = submitBtn?.querySelector(".btn-text");
  const srcHidden = $("#src");
  const campaignHidden = $("#campaign");
  const sourcePill = $("#sourcePill");
  const yearEl = $("#year");

  // VIP modal hooks (kept hidden for now — we’ll use on profile.html later)
  const vipBackdrop = $("#vipBackdrop");
  const vipModal = $("#vipModal");
  const vipCloseBtn = $("#vipCloseBtn");
  const vipNotNowBtn = $("#vipNotNowBtn");
  const vipUpgradeBtn = $("#vipUpgradeBtn");

  // ---------------------------
  // UI helpers
  // ---------------------------
  function setStatus(message, kind = "info") {
    if (!statusEl) return;
    statusEl.textContent = message || "";
    statusEl.className = `status ${kind}`.trim();
  }

  function setStatusHTML(html, kind = "info") {
    if (!statusEl) return;
    statusEl.innerHTML = html || "";
    statusEl.className = `status ${kind}`.trim();
  }

  function setLoading(isLoading) {
    if (!submitBtn) return;

    // If cooldown is active, never re-enable the button here
    if (!isLoading && getCooldownUntil() > Date.now()) return;

    submitBtn.disabled = !!isLoading;
    submitBtn.classList.toggle("loading", !!isLoading);
    if (btnText) btnText.textContent = isLoading ? "Sending Link..." : "Join Free";
  }

  function safeLower(s) {
    return String(s || "").trim().toLowerCase();
  }

  function validEmail(email) {
    const e = String(email || "").trim();
    if (e.length < 5) return false;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
  }

  function parseParams() {
    const url = new URL(window.location.href);
    const src = safeLower(url.searchParams.get("src")) || "";
    const campaign = (url.searchParams.get("campaign") || "").trim();
    return { src, campaign };
  }

  function applySourceUI(src, campaign) {
    const pretty =
      src === "package" ? "package" :
      src === "social" ? "social" :
      src ? src : "direct";

    if (sourcePill) sourcePill.textContent = `source: ${pretty}`;
    if (srcHidden) srcHidden.value = pretty;
    if (campaignHidden) campaignHidden.value = campaign || "";

    const subtitle = $("#subtitleText");
    if (!subtitle) return;

    if (pretty === "package") {
      subtitle.textContent =
        "Welcome back. Join for free — get live alerts + early access reserved for OG customers.";
    } else if (pretty === "social") {
      subtitle.textContent =
        "Join for free. Get notified before we go live + early access to limited drops. No spam.";
    } else {
      subtitle.textContent =
        "Join for free. We’ll only email you for lives, drops, and important releases.";
    }
  }

  function hideVipModal() {
    if (vipBackdrop) vipBackdrop.hidden = true;
    if (vipModal) vipModal.hidden = true;
    document.body.classList.remove("modal-open");
  }

  // ---------------------------
  // Cooldown (client-side)
  // ---------------------------
const COOLDOWN_MS = 60 * 1000;
const COOLDOWN_KEY = "og_access_cooldown_until";


  function getCooldownUntil() {
    const n = Number(localStorage.getItem(COOLDOWN_KEY));
    return Number.isFinite(n) ? n : 0;
  }

  function setCooldownUntil(ts) {
    localStorage.setItem(COOLDOWN_KEY, String(ts));
  }

  function startCooldown() {
    if (!submitBtn) return;

    const until = Date.now() + COOLDOWN_MS;
    setCooldownUntil(until);

    const tick = () => {
      const left = getCooldownUntil() - Date.now();
      if (left <= 0) {
        submitBtn.disabled = false;
        submitBtn.classList.remove("cooldown");
        if (btnText) btnText.textContent = "Join Free";
        localStorage.removeItem(COOLDOWN_KEY);
        return;
      }

      submitBtn.disabled = true;
      submitBtn.classList.add("cooldown");

      const secs = Math.ceil(left / 1000);
      if (btnText) btnText.textContent = `Try again in ${secs}s`;

      requestAnimationFrame(tick);
    };

    tick();
  }

  function resumeCooldownIfNeeded() {
    if (getCooldownUntil() > Date.now()) startCooldown();
  }

  // ---------------------------
  // Supabase ready gate (race-proof)
  // ---------------------------
  function getSupabaseClientIfReady() {
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

  function computeRedirectToProfile() {
    const base = `${window.location.origin}${window.location.pathname.replace(/[^/]+$/, "")}`;
    return `${base}profile.html`;
  }

  // ---------------------------
  // Main
  // ---------------------------
  async function init() {
    if (yearEl) yearEl.textContent = String(new Date().getFullYear());

    const { src, campaign } = parseParams();
    applySourceUI(src, campaign);

    // VIP modal close wiring (even though we won't show it here yet)
    vipCloseBtn?.addEventListener("click", hideVipModal);
    vipNotNowBtn?.addEventListener("click", hideVipModal);
    vipBackdrop?.addEventListener("click", hideVipModal);
    vipUpgradeBtn?.addEventListener("click", () => {
      hideVipModal();
      window.location.href = "profile.html#vip";
    });

    const sb = await waitForSupabaseReady();
    if (!sb) {
      setStatus("Supabase is not initialized. Check initSupabase.js loading order.", "error");
      return;
    }

    resumeCooldownIfNeeded();

    // If a session already exists, go straight to profile
    try {
      const { data } = await sb.auth.getSession();
      if (data?.session) {
        window.location.href = "profile.html";
        return;
      }
    } catch (e) {
      console.warn("Session check failed:", e);
    }

    form?.addEventListener("submit", (e) => onSubmit(e, sb));
  }

  async function onSubmit(e, sb) {
    e.preventDefault();

    // If cooldown active, keep the countdown fresh and exit
    if (getCooldownUntil() > Date.now()) {
      startCooldown();
      return;
    }

    setStatus("");

    const name = String(nameEl?.value || "").trim();
    const email = String(emailEl?.value || "").trim();
    const consent = !!consentEl?.checked;

    if (!validEmail(email)) {
      setStatus("Please enter a valid email address.", "error");
      emailEl?.focus();
      return;
    }

    if (!consent) {
      setStatus("Please check the consent box to join alerts.", "error");
      consentEl?.focus();
      return;
    }

    setLoading(true);

    try {
      const src = String(srcHidden?.value || "direct");
      const campaign = String(campaignHidden?.value || "");

      // Store “pre-auth” context so profile.html can read it after magic-link auth
const joinContext = {
  name,
  email: safeLower(email),
  src,
  campaign,

  // NEW: differentiate Join vs Access
  flow: "join",

  // NEW: explicit marketing consent captured here (Join requires consent)
  marketing_opt_in: true,
  marketing_opt_in_at: new Date().toISOString(),

  joined_at: new Date().toISOString()
};
localStorage.setItem("og_join_context", JSON.stringify(joinContext));

      const redirectTo = computeRedirectToProfile();

      // Call Edge Function proxy (rate limited)
      const fnUrl = `${window.SUPABASE_URL}/functions/v1/og_send_magic_link`;

      const res = await fetch(fnUrl, {
        method: "POST",
        credentials: "omit",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: safeLower(email), redirectTo })
      });

      if (res.status === 429) {
        setLoading(false);
        setStatusHTML(
          `<strong>⏳ Please wait a moment.</strong><br>
           <span class="muted">Too many requests. Try again shortly.</span>`,
          "error"
        );
        return;
      }

      if (!res.ok) throw new Error("Request failed. Please try again.");

      const data = await res.json().catch(() => ({}));
      if (!data?.ok) throw new Error("Request failed. Please try again.");

setStatusHTML(
  `<strong>✅ Secure sign-in link sent.</strong><br>
   <span class="muted">For the fastest access, open the sign-in link on <strong>this same device</strong>.</span><br>
   <span class="muted">If you open it on another device, you’ll be signed in there instead.</span><br>
   <span class="muted">No email? Check spam, then try again in 60 seconds.</span>`,
  "success"
);


      setLoading(false);
      startCooldown();

      // Light UX: lock inputs to prevent repeated submits without intent
      if (emailEl) emailEl.readOnly = true;
      if (nameEl) nameEl.readOnly = true;
      if (consentEl) consentEl.disabled = true;

    } catch (err) {
      console.error(err);
      setLoading(false);
      const msg = (err && err.message) ? err.message : "Something went wrong. Please try again.";
      setStatus(`❌ ${msg}`, "error");
    }
  }

  // boot
  init();
})();
