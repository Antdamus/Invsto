// Handle login form submission
document.getElementById('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
  
    const { error } = await supabase.auth.signInWithPassword({ email, password });
  
    if (error) {
      alert('Login failed: ' + error.message);
    } else {
      window.location.href = 'dashboard.html';
    }
  });
  
  // Handle logout
  document.getElementById('logout')?.addEventListener('click', async () => {
    await supabase.auth.signOut();
    window.location.href = 'index.html';
  });
  
  // Redirect to login if not authenticated
  (async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session && window.location.pathname.includes('dashboard')) {
      window.location.href = 'index.html';
    }
  })();
  