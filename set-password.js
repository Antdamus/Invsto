// set-password.js
(function () {
  const msg = document.getElementById("msg");
  const btn = document.getElementById("btn");
  const pwEl = document.getElementById("pw");
  const pw2El = document.getElementById("pw2");

  const LOGIN_URL = "https://antdamus.github.io/Invsto/"; // ✅ your login page

  function setMsg(text, kind = "") {
    msg.textContent = text || "";
    msg.style.color =
      kind === "error" ? "crimson" :
      kind === "success" ? "limegreen" :
      "";
  }

  function waitForSupabaseReady() {
    return new Promise((resolve) => {
      if (window.supabaseClient) return resolve(window.supabaseClient);
      if (window.supabase) return resolve(window.supabase);
      document.addEventListener(
        "supabase-ready",
        () => resolve(window.supabaseClient || window.supabase),
        { once: true }
      );
    });
  }

  function parseHashTokens() {
    const h = (window.location.hash || "").replace(/^#/, "");
    if (!h) return null;
    const p = new URLSearchParams(h);
    const access_token = p.get("access_token");
    const refresh_token = p.get("refresh_token");
    const type = p.get("type");
    if (!access_token || !refresh_token) return null;
    return { access_token, refresh_token, type };
  }

  async function ensureInviteSession(sb) {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const hashTokens = parseHashTokens();

    try {
      // ✅ New-style links: ?code=...
      if (code) {
        const { data, error } = await sb.auth.exchangeCodeForSession(code);
        if (error) throw error;

        // Clean URL
        url.searchParams.delete("code");
        window.history.replaceState({}, document.title, url.toString());
        return data?.session || null;
      }

      // ✅ Old-style links: #access_token=...&refresh_token=...
      if (hashTokens) {
        const { data, error } = await sb.auth.setSession({
          access_token: hashTokens.access_token,
          refresh_token: hashTokens.refresh_token,
        });
        if (error) throw error;

        // Clean hash so refresh doesn't re-run
        window.history.replaceState(
          {},
          document.title,
          window.location.pathname + window.location.search
        );

        return data?.session || null;
      }

      // Fallback: maybe detectSessionInUrl already handled it
      const { data } = await sb.auth.getSession();
      return data?.session || null;
    } catch (e) {
      console.error("ensureInviteSession error:", e);
      return null;
    }
  }

  async function main() {
    btn.disabled = true;
    setMsg("Checking invite link…");

    const sb = await waitForSupabaseReady();

    const session = await ensureInviteSession(sb);
    if (!session) {
      setMsg("This link is invalid or expired. Ask an admin to resend the invite.", "error");
      btn.disabled = true;
      return;
    }

    setMsg("Create a password to finish setup.");
    btn.disabled = false;

    btn.addEventListener("click", async () => {
      const pw = (pwEl.value || "").trim();
      const pw2 = (pw2El.value || "").trim();

      if (!pw || pw.length < 8) return setMsg("Password must be at least 8 characters.", "error");
      if (pw !== pw2) return setMsg("Passwords do not match.", "error");

      btn.disabled = true;
      setMsg("Saving password…");

      const { error } = await sb.auth.updateUser({ password: pw });

      if (error) {
        console.error("updateUser error:", error);
        btn.disabled = false;
        return setMsg(error.message || "Failed to set password.", "error");
      }

      // Optional: mark accepted (ignore if you don't have this RPC)
      try {
        await sb.rpc("mark_invite_accepted");
      } catch (e) {
        // not fatal
        console.warn("mark_invite_accepted skipped:", e);
      }

      setMsg("✅ Password saved! Redirecting to login…", "success");

      // For clarity: sign out so login is clean (optional but recommended)
      try { await sb.auth.signOut(); } catch {}

      setTimeout(() => {
        window.location.href = LOGIN_URL;
      }, 900);
    });
  }

  window.addEventListener("DOMContentLoaded", main);
})();
