(function () {
  const banner = document.getElementById('banner');
  const btn = document.getElementById('btn');

  const LOGIN_URL = 'https://antdamus.github.io/Invsto/';

  function setBanner(text, kind = 'warn') {
    banner.className = `banner ${kind}`;
    banner.textContent = text || '';
  }

  function disableForm(disabled) {
    btn.disabled = !!disabled;
    document.getElementById('pw').disabled = !!disabled;
    document.getElementById('pw2').disabled = !!disabled;
  }

  async function ensureSessionFromUrl() {
  const url = new URL(window.location.href);

  const code = url.searchParams.get('code');                 // PKCE flow
  const type = url.searchParams.get('type');                 // invite / recovery / magiclink
  const token_hash =
    url.searchParams.get('token_hash') ||                    // common
    url.searchParams.get('token') ||                         // sometimes present
    null;

  const hasHashTokens =
    /access_token=/.test(url.hash) || /refresh_token=/.test(url.hash);

  try {
    // 1) PKCE code exchange (newer email links)
    if (code) {
      const { data, error } = await supabaseClient.auth.exchangeCodeForSession(code);
      if (error) throw error;

      // clean URL
      url.searchParams.delete('code');
      window.history.replaceState({}, document.title, url.toString());
      return data?.session || null;
    }

    // 2) Implicit hash tokens (older style, or if verify redirected with tokens)
    if (hasHashTokens) {
      const { data } = await supabaseClient.auth.getSession();
      return data?.session || null;
    }

    // 3) OTP verify flow (invite/recovery links sometimes land with token_hash)
    if (type && token_hash) {
      const { data, error } = await supabaseClient.auth.verifyOtp({
        type,
        token_hash,
      });
      if (error) throw error;

      // clean URL
      url.searchParams.delete('type');
      url.searchParams.delete('token_hash');
      url.searchParams.delete('token');
      window.history.replaceState({}, document.title, url.toString());

      return data?.session || null;
    }

    return null;
  } catch (e) {
    console.error("ensureSessionFromUrl error:", e);
    return null;
  }
}


  function validatePasswords(pw, pw2) {
    if (!pw || pw.length < 8) return 'Password must be at least 8 characters.';
    if (pw !== pw2) return 'Passwords do not match.';
    return null;
  }

  async function main() {
    setBanner('Checking invite link…', 'warn');
    disableForm(true);

    const session = await ensureSessionFromUrl();
    if (!session) {
      setBanner(
        'This link is invalid or expired.\nAsk an admin to resend the invite.',
        'err'
      );
      return;
    }

    disableForm(false);
    setBanner('Create a password to finish setup.', 'warn');

    btn.addEventListener('click', async () => {
      const pw = document.getElementById('pw').value.trim();
      const pw2 = document.getElementById('pw2').value.trim();

      const err = validatePasswords(pw, pw2);
      if (err) {
        setBanner(err, 'err');
        return;
      }

      disableForm(true);
      setBanner('Saving password…', 'warn');

      // 1) set password
      const { error } = await supabaseClient.auth.updateUser({ password: pw });
      if (error) {
        console.error(error);
        disableForm(false);
        setBanner(error.message || 'Failed to set password.', 'err');
        return;
      }

      // 2) optional: confirm we still have a valid user session
      const { data: uData, error: uErr } = await supabaseClient.auth.getUser();
      if (uErr || !uData?.user) {
        console.error(uErr);
        // Password may still be set, but session state is weird—send them to login anyway
        setBanner(
          'Password saved ✅\nPlease log in to continue.\nRedirecting…',
          'ok'
        );
        setTimeout(() => (window.location.href = LOGIN_URL), 1200);
        return;
      }

      // 3) mark accepted (your RPC)
      try { await supabaseClient.rpc('mark_invite_accepted'); } catch {}

      // 4) success UI + redirect
      let s = 3;
      setBanner(`Password saved ✅\nRedirecting to login in ${s}…`, 'ok');

      const timer = setInterval(() => {
        s -= 1;
        if (s <= 0) {
          clearInterval(timer);
          window.location.href = LOGIN_URL;
          return;
        }
        setBanner(`Password saved ✅\nRedirecting to login in ${s}…`, 'ok');
      }, 1000);
    });
  }

  window.addEventListener('DOMContentLoaded', main);
})();
