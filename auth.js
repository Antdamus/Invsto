// auth.js
document.getElementById('login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    alert('Login failed: ' + error.message);
    return;
  }

  const { user } = data;
  const role = user?.user_metadata?.role;

  if (role === 'admin') {
    window.location.href = 'add-item.html';
  } else {
    alert('Access denied. Only admins can access this section.');
    await supabase.auth.signOut();
  }
});

// Optional: Universal logout
document.getElementById('logout')?.addEventListener('click', async () => {
  await supabase.auth.signOut();
  window.location.href = 'index.html';
});
