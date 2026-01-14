/* set-password.js
   Handles Supabase invite links + password creation.

   Expected URL format (Supabase invite):
     .../set-password.html#access_token=...&refresh_token=...&type=invite

   Dependencies:
   - initSupabase.js defines window.supabase (your existing file does)
*/

const LOGIN_URL = "https://antdamus.github.io/Invsto/";

// ===== DOM =====
const bannerEl = document.getElementById("banner");
const pw1El = document.getElementById("pw1"); // <-- make sure set-password.html uses id="pw1"
const pw2El = document.getElementById("pw2");
const saveBtn = document.getElementById("btn");

function setBanner(text, kind = "") {
  if (!bannerEl) return;

  bannerEl.textContent = text || "";
  bannerEl.style.display = text ? "block" : "none";

  // CSS supports: .banner, .ok, .warn, .err
  bannerEl.classList.remove("ok", "warn", "err");
  if (kind) bannerEl.classList.add(kind);
}

function disableForm(disabled) {
  if (pw1El) pw1El.disabled = disabled;
  if (pw2El) pw2El.disabled = disabled;
  if (saveBtn) saveBtn.disabled = disabled;
}

function parseHashParams() {
  const h = window.location.hash || "";
  const raw = h.startsWith("#") ? h.slice(1) : h;
  return new URLSearchParams(raw);
}

function clearUrlHash() {
  // Remove token fragments from the address bar (safer)
  try {
    history.replaceState(null, document.title, window.location.pathname + window.location.search);
  } catch {
    // ignore
  }
}

async function waitForSupabase() {
  if (window.supabase) return window.supabase;

  // initSupabase.js dispatches 'supabase:ready' in your project
  await new Promise((resolve) => {
    window.addEventListener("supabase:ready", resolve, { once: true });
    // fallback timeout so the page doesn't hang forever
    setTimeout(resolve, 2500);
  });

  return window.supabase;
}

async function ensureSessionFromUrl(supabase) {
  // 1) If URL has tokens in the hash, set a session from them
  const p = parseHashParams();
  const access_token = p.get("access_token");
  const refresh_token = p.get("refresh_token");
  const type = p.get("type"); // invite / recovery etc

  if (access_token && refresh_token) {
    const { error } = await supabase.auth.setSession({ access_token, refresh_token });
    clearUrlHash();
    if (error) throw error;
  }

  // 2) Confirm we now have a session
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data?.session) {
    // If the link is missing tokens (or already used/expired), you'll land here.
    throw new Error(
      type === "invite"
        ? "This invite link is invalid or expired. Ask an admin to resend the invite."
        : "This link is invalid or expired."
    );
  }

  return data.session;
}

async function markEmployeeAccepted(supabase, userId) {
  // Optional: if you added employees.accepted_at, this will mark it.
  // If RLS blocks it, we ignore the error because password set is still valid.
  try {
    await supabase
      .from("employees")
      .update({ accepted_at: new Date().toISOString() })
      .eq("user_id", userId);
  } catch {
    // ignore
  }
}

async function main() {
  disableForm(true);
  setBanner("Checking invite link...");

  const supabase = await waitForSupabase();
  if (!supabase) {
    setBanner("Supabase client did not initialize. Please refresh.", "err");
    return;
  }

  let session;
  try {
    session = await ensureSessionFromUrl(supabase);
  } catch (e) {
    setBanner(e?.message || String(e), "err");
    return;
  }

  setBanner("Invite verified. Please set a password.", "ok");
  disableForm(false);

  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const p1 = (pw1El?.value || "").trim();
      const p2 = (pw2El?.value || "").trim();

      if (!p1 || p1.length < 8) {
        setBanner("Password must be at least 8 characters.", "warn");
        return;
      }
      if (p1 !== p2) {
        setBanner("Passwords do not match.", "warn");
        return;
      }

      disableForm(true);
      setBanner("Saving password...");

      const { error } = await supabase.auth.updateUser({ password: p1 });
      if (error) {
        setBanner(error.message || "Could not save password.", "err");
        disableForm(false);
        return;
      }

      await markEmployeeAccepted(supabase, session.user.id);

      setBanner("Password saved! Redirecting to login...", "ok");

      // small delay so the user sees confirmation
      setTimeout(() => {
        window.location.href = LOGIN_URL;
      }, 1200);
    });
  }
}

main();
