// auth.js
// Login + automatic role routing using the employees table (admin -> dashboard, employee -> worker dashboard)

function waitForSupabaseReady() {
  return new Promise((resolve) => {
    if (window.supabase) return resolve(window.supabase);
    document.addEventListener("supabase-ready", () => resolve(window.supabase), { once: true });
  });
}

async function getEmployeeRoleByUserId(userId) {
  const sb = await waitForSupabaseReady();

  // Pull role from employees table (source of truth)
  const { data: emp, error } = await sb
    .from("employees")
    .select("role, active")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  setLoginLoadingState(false);
  return emp; // { role, active } or null
}

function setLoginLoadingState(isLoading) {
  const btn = document.getElementById("login-submit") || document.querySelector(".login-button");
  const email = document.getElementById("email");
  const password = document.getElementById("password");
  const toggle = document.getElementById("toggle-password");

  if (!btn) return;

  if (isLoading) {
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.classList.add("is-loading");
    btn.dataset.originalText = btn.textContent;
    btn.textContent = "Entering…";

    if (email) email.disabled = true;
    if (password) password.disabled = true;
    if (toggle) toggle.disabled = true;
  } else {
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
    btn.classList.remove("is-loading");
    btn.textContent = btn.dataset.originalText || btn.textContent;

    if (email) email.disabled = false;
    if (password) password.disabled = false;
    if (toggle) toggle.disabled = false;
  }
}


async function routeUser(session) {
  const sb = await waitForSupabaseReady();

  if (!session?.user?.id) return;

  let emp = null;
  try {
    emp = await getEmployeeRoleByUserId(session.user.id);
  } catch (err) {
    console.error("❌ Role lookup failed:", err);
    return;
  }

  // If user has no employee row or is inactive, sign out and stay on login
  if (!emp || emp.active === false) {
    await sb.auth.signOut();
    return;
  }

  const role = String(emp.role || "").toLowerCase();

  if (role === "admin") {
    window.location.href = "dashboard.html";
  } else if (role === "employee") {
    window.location.href = "worker-dashboard.html";
  } else {
    // Unknown role -> safest behavior
    await sb.auth.signOut();
  }
}

/* =========================
   SHOW PASSWORD TOGGLE
========================= */
document.getElementById("toggle-password")?.addEventListener("click", () => {
  const passwordInput = document.getElementById("password");
  if (!passwordInput) return;

  const isPassword = passwordInput.type === "password";
  passwordInput.type = isPassword ? "text" : "password";

  const btn = document.getElementById("toggle-password");
  if (btn) btn.textContent = isPassword ? "🙈" : "👁";
});

/* =========================
   AUTO-ROUTE IF ALREADY LOGGED IN
   (Makes it automatic on refresh too)
========================= */
(async () => {
  const sb = await waitForSupabaseReady();
  const { data: { session }, error } = await sb.auth.getSession();
  if (error) console.error("❌ Session error:", error);

  if (session) {
    // If already logged in, send them to the correct dashboard automatically
    await routeUser(session);
  }
})();

/* =========================
   LOGIN HANDLER
========================= */
document.getElementById("login-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();

  const sb = await waitForSupabaseReady();

  const email = document.getElementById("email")?.value.trim();
  const password = document.getElementById("password")?.value.trim();
  const feedback = document.getElementById("login-feedback");

  if (!email || !password) return;

setLoginLoadingState(true);

if (feedback) {
  feedback.style.color = "#d6b25e";
  feedback.textContent = "⏳ Entering secure portal…";
}

  const { data, error } = await sb.auth.signInWithPassword({ email, password });

  if (error) {
    if (feedback) {
      feedback.style.color = "crimson";
      feedback.textContent = `❌ Login failed: ${error.message}`;
    }
    setLoginLoadingState(false);
    return;
  }

  const session = data?.session;
  if (!session) {
    if (feedback) {
      feedback.style.color = "crimson";
      feedback.textContent = "❌ Unexpected error. No session returned.";
    }
    setLoginLoadingState(false);
    return;
  }

  // Route based on employees.role (admin/employee)
  try {
    const emp = await getEmployeeRoleByUserId(session.user.id);

    if (!emp || emp.active === false) {
      if (feedback) {
        feedback.style.color = "crimson";
        feedback.textContent = "⚠️ Your account is not active. Contact an admin.";
      }
      await sb.auth.signOut();
      setLoginLoadingState(false);
      return;
    }

    const role = String(emp.role || "").toLowerCase();

    if (feedback) {
      feedback.style.color = "green";
      feedback.textContent = "✅ Login successful. Redirecting...";
    }

    setTimeout(() => {
      if (role === "admin") window.location.href = "dashboard.html";
      else window.location.href = "worker-dashboard.html";
    }, 500);

  } catch (err) {
    console.error("❌ Role lookup failed after login:", err);
    if (feedback) {
      feedback.style.color = "crimson";
      feedback.textContent = "❌ Could not verify your role. Please try again.";
    }
    await sb.auth.signOut();
    setLoginLoadingState(false);
  }
});

/* =========================
   RESET PASSWORD LINK
========================= */
document.getElementById("reset-link")?.addEventListener("click", async (e) => {
  e.preventDefault();

  const sb = await waitForSupabaseReady();

  const email = document.getElementById("email")?.value.trim();
  const feedback = document.getElementById("login-feedback");

  if (!email) {
    if (feedback) {
      feedback.style.color = "crimson";
      feedback.textContent = "📧 Please enter your email to reset password.";
    }
    return;
  }

  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + "/reset.html",
  });

  if (error) {
    if (feedback) {
      feedback.style.color = "crimson";
      feedback.textContent = `❌ Reset failed: ${error.message}`;
    }
  } else {
    if (feedback) {
      feedback.style.color = "green";
      feedback.textContent = "✅ Check your inbox for reset instructions.";
    }
  }
});
