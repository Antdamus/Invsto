/* join.js — OG Jewelers (Join / Alerts Signup)
   - Email-only
   - Passwordless (magic link)
   - Redirect to profile.html after link click
   - Reads URL params: ?src=package|social&campaign=...
*/

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
  // Helpers
  // ---------------------------
  function setStatus(message, kind = "info") {
    if (!statusEl) return;
    statusEl.textContent = message || "";
    statusEl.className = `status ${kind}`.trim();
  }

  function setLoading(isLoading) {
    if (!submitBtn) return;
    submitBtn.disabled = !!isLoading;
    submitBtn.classList.toggle("loading", !!isLoading);
    if (btnText) btnText.textContent = isLoading ? "Sending Link..." : "Join Free";
  }

  function safeLower(s) {
    return String(s || "").trim().toLowerCase();
  }

  function validEmail(email) {
    // pragmatic email validation (not overly strict)
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

    // Optional: customize subtitle slightly by source (pure UX polish)
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
  // Main
  // ---------------------------
  async function init() {
    // footer year
    if (yearEl) yearEl.textContent = String(new Date().getFullYear());

    // source params
    const { src, campaign } = parseParams();
    applySourceUI(src, campaign);

    // modal close wiring (even though we won't show it here yet)
    vipCloseBtn?.addEventListener("click", hideVipModal);
    vipNotNowBtn?.addEventListener("click", hideVipModal);
    vipBackdrop?.addEventListener("click", hideVipModal);
    vipUpgradeBtn?.addEventListener("click", () => {
      // later we’ll route to VIP plans page
      hideVipModal();
      window.location.href = "profile.html#vip";
    });

    // ensure supabase exists (from initSupabase.js)
    await waitForSupabaseReady();
    if (!window.supabase) {
      setStatus("Supabase is not initialized. Check initSupabase.js loading order.", "error");
      return;
    }

    // If a session already exists, go straight to profile
    try {
      const { data } = await window.supabase.auth.getSession();
      if (data?.session) {
        window.location.href = "profile.html";
        return;
      }
    } catch (e) {
      // non-fatal; user can still request link
      console.warn("Session check failed:", e);
    }

    // form submit
    form?.addEventListener("submit", onSubmit);
  }

  async function onSubmit(e) {
    e.preventDefault();
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

      // Store “pre-auth” context in localStorage so profile.html can read it
      // after the magic-link completes auth.
      const joinContext = {
        name,
        email: safeLower(email),
        src,
        campaign,
        joined_at: new Date().toISOString()
      };
      localStorage.setItem("og_join_context", JSON.stringify(joinContext));

      // Send magic link. After clicking, Supabase will redirect to profile.html
      const redirectTo = `${window.location.origin}${window.location.pathname.replace(/[^/]+$/, "")}profile.html`;

      const { error } = await window.supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: redirectTo
        }
      });

      if (error) throw error;

 statusEl.innerHTML = `
  <strong>✅ Secure sign-in link sent.</strong><br>
  <span class="muted">If that email is valid, check your inbox. No email? Check spam, then try again in 60 seconds.</span>
`;
statusEl.className = "status success";

      setLoading(false);

      // Light UX: lock inputs to prevent repeated submits without intent
      if (emailEl) emailEl.readOnly = true;
      if (nameEl) nameEl.readOnly = true;
      if (consentEl) consentEl.disabled = true;

    } catch (err) {
      console.error(err);
      setLoading(false);

      // Common failure modes: bad URL config / rate limit
      const msg = (err && err.message) ? err.message : "Something went wrong. Please try again.";
      setStatus(`❌ ${msg}`, "error");
    }
  }

  // boot
  init();
})();
