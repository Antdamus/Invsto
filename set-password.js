(function(){
  const msg = document.getElementById('msg');
  const btn = document.getElementById('btn');

  function setMsg(t){ msg.textContent = t || ''; }

  // Important: if your initSupabase.js exposes supabaseClient, wait for it
  async function ensureSessionFromUrl(){
    // Newer Supabase email links often use ?code=... and need exchange
    const url = new URL(window.location.href);
    const code = url.searchParams.get('code');

    // Older style uses #access_token=... in hash
    const hasHashTokens = /access_token=/.test(url.hash);

    try {
      if (code) {
        // Exchange the code for a session
        const { data, error } = await supabaseClient.auth.exchangeCodeForSession(code);
        if (error) throw error;

        // Clean URL
        url.searchParams.delete('code');
        window.history.replaceState({}, document.title, url.toString());
        return data?.session;
      }

      if (hasHashTokens) {
        // supabase-js will pick this up on load, but we can just check session
        const { data } = await supabaseClient.auth.getSession();
        return data?.session;
      }

      // No invite tokens
      return null;
    } catch (e) {
      console.error(e);
      setMsg('This link is invalid or expired. Ask an admin to resend the invite.');
      return null;
    }
  }

  async function main(){
    setMsg('Checking invite link…');
    const session = await ensureSessionFromUrl();
    if (!session) {
      setMsg('No invite session found. Ask an admin to resend the invite.');
      btn.disabled = true;
      return;
    }

    setMsg('Create a password to finish setup.');

    btn.addEventListener('click', async () => {
      const pw = document.getElementById('pw').value.trim();
      const pw2 = document.getElementById('pw2').value.trim();
      if (!pw || pw.length < 8) return setMsg('Password must be at least 8 characters.');
      if (pw !== pw2) return setMsg('Passwords do not match.');

      btn.disabled = true;
      setMsg('Saving password…');

      const { error } = await supabaseClient.auth.updateUser({ password: pw });
      if (error) {
        console.error(error);
        btn.disabled = false;
        return setMsg(error.message || 'Failed to set password.');
      }

      // Mark accepted (your RPC)
      try { await supabaseClient.rpc('mark_invite_accepted'); } catch {}

      setMsg('Password saved. Redirecting…');
      window.location.href = 'timeclock.html'; // or wherever workers should go
    });
  }

  window.addEventListener('DOMContentLoaded', main);
})();
