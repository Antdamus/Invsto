/* access.js — OG Jewelers (Member Access)
   - Passwordless (magic link)
   - Redirect to profile.html after link click
   - Neutral messaging (security)
   - Race-proof Supabase client readiness
   - Reads URL params: ?src=store|package|social&campaign=...
*/

(() => {
  "use strict";

  // ---------------------------
  // DOM
  // ---------------------------
  const $ = (sel) => document.querySelector(sel);

  const form = $("#accessForm");
  const emailEl = $("#email");
  const statusEl = $("#status");
  const submitBtn = $("#submitBtn");
  const btnText = submitBtn?.querySelector(".btn-text");
  const srcHidden = $("#src");
  const campaignHidden = $("#campaign");
  const sourcePill = $("#sourcePill");
  const yearEl = $("#year");

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
    submitBtn.disabled = !!isLoading;
    submitBtn.classList.toggle("loading", !!isLoading);
    if (btnText) btnText.textContent = isLoading ? "Sending Link..." : "Send Sign-In Link";
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
      src === "store" ? "store" :
      src === "package" ? "package" :
      src === "social" ? "social" :
      src ? src : "store";

    if (sourcePill) sourcePill.textContent = `source: ${pretty}`;
    if (srcHidden) srcHidden.value = pretty;
    if (campaignHidden) campaignHidden.value = campaign || "";

    const subtitle = $("#subtitleText");
    if (!subtitle) return;

    if (pretty === "store") {
      subtitle.textContent = "Secure sign-in to view your profile and manage alerts. No passwords.";
    } else if (pretty === "package") {
      subtitle.textContent = "Welcome back. Secure sign-in to manage alerts and early access.";
    } else {
      subtitle.textContent = "Secure sign-in with a one-time link. No passwords. No friction.";
    }
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
    // Same pattern as join.js, but kept explicit.
    // Ensures redirect works whether site is in a subfolder or root.
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

    const sb = await waitForSupabaseReady();
    if (!sb) {
      setStatus("Supabase is not initialized. Check initSupabase.js loading order.", "error");
      return;
    }

    // If already signed in, go straight to profile
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
    setStatus("");

    const email = String(emailEl?.value || "").trim();
    if (!validEmail(email)) {
      setStatus("Please enter a valid email address.", "error");
      emailEl?.focus();
      return;
    }

    setLoading(true);

    try {
      const src = String(srcHidden?.value || "store");
      const campaign = String(campaignHidden?.value || "");

      // Store minimal context (profile can still read source/campaign)
      const ctx = {
        email: safeLower(email),
        src,
        campaign,
        accessed_at: new Date().toISOString()
      };
      localStorage.setItem("og_join_context", JSON.stringify(ctx));

      const redirectTo = computeRedirectToProfile();

      const { error } = await sb.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo }
      });

      if (error) throw error;

      setStatusHTML(
        `<strong>✅ Secure sign-in link sent.</strong><br>
         <span class="muted">If that email is valid, check your inbox. No email? Check spam, then try again in 60 seconds.</span>`,
        "success"
      );

      setLoading(false);

      // Gentle lock to prevent accidental spam-clicking
      if (emailEl) emailEl.readOnly = true;

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
