/* index.js — Admin Login gate for OG Jewelers
   - Requires initSupabase.js to create window.supabase and fire "supabase-ready"
   - Checks public.user_roles for admin role
   - Redirects admins to /Admin-Storefront/admin-storefront.html
*/

const $ = (s) => document.querySelector(s);

const ADMIN_DESTINATION = "/Admin-Storefront/admin-storefront.html";



function setPill(id, text, state) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.classList.remove("ok", "bad");
  if (state) el.classList.add(state);
}

function setMsg(text, state) {
  const el = $("#msg");
  el.textContent = text || "";
  el.classList.remove("ok", "bad");
  if (state) el.classList.add(state);
}

function setLoading(isLoading) {
  const btn = $("#btnLogin");
  btn.disabled = !!isLoading;
  btn.classList.toggle("loading", !!isLoading);
}

async function waitForSupabase() {
  if (window.supabase) return;
  await new Promise((resolve) =>
    document.addEventListener("supabase-ready", resolve, { once: true })
  );
}

async function getRole(userId) {
  const { data, error } = await window.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data?.role || null;
}

async function checkSessionAndMaybeRedirect() {
  await waitForSupabase();
  setPill("#pillConn", "Connected", "ok");

  const { data: { session }, error } = await window.supabase.auth.getSession();
  if (error) {
    console.error(error);
    setMsg("Could not read session.", "bad");
    return;
  }

  if (!session) {
    setPill("#pillRole", "Signed out");
    $("#btnLogout").hidden = true;
    return;
  }

  // Signed in; check role
  $("#btnLogout").hidden = false;
  setPill("#pillRole", "Checking role…");

  try {
    const role = await getRole(session.user.id);
    if (role === "admin") {
      setPill("#pillRole", "Admin verified", "ok");
      setMsg("Redirecting to Admin Storefront…", "ok");
      window.location.href = ADMIN_DESTINATION;
      return;
    }

    setPill("#pillRole", role ? `Role: ${role}` : "No role row", "bad");
    setMsg("Access denied. This login is for admins only.", "bad");
  } catch (e) {
    console.error(e);
    setPill("#pillRole", "Role check failed", "bad");
    setMsg("Role check failed. See console.", "bad");
  }
}

async function handleLogin(e) {
  e.preventDefault();
  setMsg("");
  setLoading(true);

  try {
    await waitForSupabase();
    setPill("#pillConn", "Connected", "ok");

    const email = ($("#email").value || "").trim();
    const password = $("#password").value || "";

    const { data, error } = await window.supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (error) throw error;

    // Role check after login
    const userId = data?.user?.id;
    if (!userId) throw new Error("Missing user id after login.");

    const role = await getRole(userId);
    if (role !== "admin") {
      setPill("#pillRole", role ? `Role: ${role}` : "No role row", "bad");
      setMsg("Signed in, but not an admin. Access denied.", "bad");
      return;
    }

    setPill("#pillRole", "Admin verified", "ok");
    setMsg("Success. Redirecting…", "ok");
    window.location.href = ADMIN_DESTINATION;
  } catch (err) {
    console.error(err);
    setMsg(err?.message || "Login failed.", "bad");
    setPill("#pillRole", "Role…");
  } finally {
    setLoading(false);
  }
}

async function handleLogout() {
  try {
    await waitForSupabase();
    await window.supabase.auth.signOut();
    setMsg("Signed out.", "ok");
    setPill("#pillRole", "Signed out");
    $("#btnLogout").hidden = true;
  } catch (e) {
    console.error(e);
    setMsg("Sign out failed.", "bad");
  }
}

document.addEventListener("DOMContentLoaded", () => {
  $("#loginForm").addEventListener("submit", handleLogin);
  $("#btnLogout").addEventListener("click", handleLogout);

  // Auto-check existing session
  checkSessionAndMaybeRedirect();

  // If session changes (login/logout in another tab), refresh UI
  waitForSupabase().then(() => {
    window.supabase.auth.onAuthStateChange(() => {
      checkSessionAndMaybeRedirect();
    });
  });
});
