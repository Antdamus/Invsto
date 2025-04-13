// === SHOW PASSWORD TOGGLE ===
document.getElementById("toggle-password")?.addEventListener("click", () => {
  const passwordInput = document.getElementById("password");
  const isPassword = passwordInput.type === "password";
  passwordInput.type = isPassword ? "text" : "password";
  document.getElementById("toggle-password").textContent = isPassword ? "🙈" : "👁";
});

// === LOGIN HANDLER ===
document.getElementById("login-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value.trim();
  const feedback = document.getElementById("login-feedback");

  feedback.style.color = "#333";
  feedback.textContent = "⏳ Logging in...";

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    feedback.style.color = "crimson";
    feedback.textContent = `❌ Login failed: ${error.message}`;
    return;
  }

  const user = data?.user;

  if (!user) {
    feedback.style.color = "crimson";
    feedback.textContent = "❌ Unexpected error. No user returned.";
    return;
  }

  const role = user.user_metadata?.role;

  if (role === "admin") {
    feedback.style.color = "green";
    feedback.textContent = "✅ Login successful. Redirecting...";
    setTimeout(() => {
      window.location.href = "dashboard.html";
    }, 1000);
  } else {
    feedback.style.color = "darkorange";
    feedback.textContent = "⚠️ You do not have admin access.";
    await supabase.auth.signOut();
  }
});

// === RESET PASSWORD LINK ===
document.getElementById("reset-link")?.addEventListener("click", async (e) => {
  e.preventDefault();
  const email = document.getElementById("email").value.trim();
  const feedback = document.getElementById("login-feedback");

  if (!email) {
    feedback.style.color = "crimson";
    feedback.textContent = "📧 Please enter your email to reset password.";
    return;
  }

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + "/reset.html"
  });

  if (error) {
    feedback.style.color = "crimson";
    feedback.textContent = `❌ Reset failed: ${error.message}`;
  } else {
    feedback.style.color = "green";
    feedback.textContent = "✅ Check your inbox for reset instructions.";
  }
});

// === OPTIONAL: Logout handler (for use elsewhere) ===
document.getElementById("logout")?.addEventListener("click", async () => {
  await supabase.auth.signOut();
  window.location.href = "login.html";
});
