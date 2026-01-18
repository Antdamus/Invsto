/* set-password.js
   - Handles Supabase invite links + password creation
   - ALSO enforces contractor agreement gate (Edge Function: contractor-agreement)
   - Renders PDF via pdf.js if present, otherwise falls back to opening the signed URL.

   Dependencies:
   - initSupabase.js defines window.supabase AND dispatches document event "supabase-ready"
   - set-password.html should include agreement UI elements (agreementPanel etc.)
*/

const LOGIN_URL = "https://antdamus.github.io/Invsto/"; // where to send users after completion
const AGREEMENT_FN = "contractor-agreement";

// ===== DOM (password) =====
const bannerEl = document.getElementById("banner");
const pw1El = document.getElementById("pw1");
const pw2El = document.getElementById("pw2");
const saveBtn = document.getElementById("btn");

// ===== DOM (agreement) — must exist in your upgraded HTML =====
const agreementPanel = document.getElementById("agreementPanel");
const passwordPanel = document.getElementById("passwordPanel");
const agreementMeta = document.getElementById("agreementMeta");
const pdfScroller = document.getElementById("pdfScroller");
const pdfPages = document.getElementById("pdfPages");
const legalNameEl = document.getElementById("legalName");
const agreeChk = document.getElementById("agreeChk");
const acceptBtn = document.getElementById("acceptBtn");
const agreeHint = document.getElementById("agreeHint");

// ===== utils =====
function setBanner(text, kind = "") {
  if (!bannerEl) return;
  bannerEl.textContent = text || "";
  bannerEl.style.display = text ? "block" : "none";
  bannerEl.classList.remove("ok", "warn", "err");
  if (kind) bannerEl.classList.add(kind);
}

function disablePasswordForm(disabled) {
  if (pw1El) pw1El.disabled = disabled;
  if (pw2El) pw2El.disabled = disabled;
  if (saveBtn) saveBtn.disabled = disabled;
}

function show(el, on) {
  if (!el) return;
  el.style.display = on ? "" : "none";
}

function parseHashParams() {
  const h = window.location.hash || "";
  const raw = h.startsWith("#") ? h.slice(1) : h;
  return new URLSearchParams(raw);
}

function clearUrlHash() {
  try {
    history.replaceState(null, document.title, window.location.pathname + window.location.search);
  } catch {}
}

function normName(s) {
  return String(s || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

async function waitForSupabase() {
  if (window.supabase) return window.supabase;

  // IMPORTANT: initSupabase.js dispatches document event "supabase-ready"
  await new Promise((resolve) => {
    document.addEventListener("supabase-ready", resolve, { once: true });
    setTimeout(resolve, 2500);
  });

  return window.supabase;
}

async function ensureSessionFromUrl(supabase) {
  // If URL has tokens in hash, set session from them
  const p = parseHashParams();
  const access_token = p.get("access_token");
  const refresh_token = p.get("refresh_token");
  const type = p.get("type"); // invite / recovery etc

  if (access_token && refresh_token) {
    const { error } = await supabase.auth.setSession({ access_token, refresh_token });
    clearUrlHash();
    if (error) throw error;
  }

  // Confirm we now have a session
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data?.session) {
    throw new Error(
      type === "invite"
        ? "This invite link is invalid or expired. Ask an admin to resend the invite."
        : "This link is invalid or expired."
    );
  }

  return data.session;
}

async function markEmployeeAccepted(supabase, userId) {
  // optional: your existing field
  try {
    await supabase.from("employees").update({ accepted_at: new Date().toISOString() }).eq("user_id", userId);
  } catch {}
}

function getQueryParams() {
  const q = new URLSearchParams(window.location.search || "");
  return {
    mode: q.get("mode") || "",
    next: q.get("next") || "",
  };
}

function redirectToNextOrLogin(next) {
  const safe = (next || "").trim();
  if (safe) {
    window.location.href = decodeURIComponent(safe);
  } else {
    window.location.href = LOGIN_URL;
  }
}

// ===== agreement flow =====
async function getAgreementStatus(supabase) {
  const { data, error } = await supabase.functions.invoke(AGREEMENT_FN, {
    body: { action: "status" },
  });
  if (error) throw error;
  return data;
}

async function acceptAgreement(supabase, legal_name) {
  const { data, error } = await supabase.functions.invoke(AGREEMENT_FN, {
    body: { action: "accept", legal_name },
  });
  if (error) throw error;
  return data;
}

function setAgreementMeta(text, kind = "") {
  if (!agreementMeta) return;
  agreementMeta.textContent = text || "";
  agreementMeta.classList.remove("ok", "warn", "err");
  if (kind) agreementMeta.classList.add(kind);
}

async function renderPdfSignedUrl(signedUrl) {
  // Prefer pdf.js if present; otherwise fallback link
  const pdfjsLib = window.pdfjsLib || globalThis.pdfjsLib;

  if (!pdfjsLib || !pdfPages) {
    const a = document.createElement("a");
    a.href = signedUrl;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Open agreement PDF";
    if (pdfPages) {
      pdfPages.innerHTML = "";
      pdfPages.appendChild(a);
    }
    return;
  }

  // Worker
pdfjsLib.GlobalWorkerOptions.workerSrc =
  window.PDFJS_WORKER_SRC ||
  pdfjsLib.GlobalWorkerOptions.workerSrc ||
  "pdf.worker.min.js";

  pdfPages.innerHTML = "";

  const loadingTask = pdfjsLib.getDocument(signedUrl);
  const pdf = await loadingTask.promise;

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);

    const container = document.createElement("div");
    container.style.padding = "8px 0";

    const canvas = document.createElement("canvas");
    canvas.style.width = "100%";
    canvas.style.borderRadius = "12px";

    const ctx = canvas.getContext("2d");

    const dpr = Math.min(2, window.devicePixelRatio || 1); // cap at 2 to avoid huge memory
const baseViewport = page.getViewport({ scale: 1.0 });

const targetCssWidth = Math.min(900, (pdfScroller?.clientWidth || 520) - 20);
const cssScale = targetCssWidth / baseViewport.width;

// Render at higher internal resolution
const renderScale = cssScale * dpr;
const renderViewport = page.getViewport({ scale: renderScale });

// CSS size (what user sees)
canvas.style.width = `${Math.floor(targetCssWidth)}px`;
canvas.style.height = `${Math.floor(renderViewport.height / dpr)}px`;

// Internal bitmap size (crisp)
canvas.width = Math.floor(renderViewport.width);
canvas.height = Math.floor(renderViewport.height);

await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;


    container.appendChild(canvas);
    pdfPages.appendChild(container);
  }
}

function enableAgreementControls({ canCheck }) {
  if (agreeChk) agreeChk.disabled = !canCheck;
  if (acceptBtn) acceptBtn.disabled = true;
}

function isScrolledToBottom(el) {
  if (!el) return false;
  const threshold = 24; // px
  return el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
}

function wireAgreementUX(profileDisplayName) {
  if (!pdfScroller || !agreeChk || !acceptBtn || !legalNameEl) return;

  // Start locked
  agreeChk.checked = false;
  agreeChk.disabled = true;
  acceptBtn.disabled = true;

  // Unlock checkbox only after scrolling to bottom
  const onScroll = () => {
    if (isScrolledToBottom(pdfScroller)) {
      agreeChk.disabled = false;
      if (agreeHint) agreeHint.textContent = "Scroll complete — now confirm and sign below.";
      pdfScroller.removeEventListener("scroll", onScroll);
    }
  };
  pdfScroller.addEventListener("scroll", onScroll);
  onScroll();

  const updateAcceptEnabled = () => {
    const legalOk = normName(legalNameEl.value) === normName(profileDisplayName);
    const checked = agreeChk.checked === true;
    acceptBtn.disabled = !(checked && legalOk);

    if (agreeHint) {
      if (agreeChk.disabled) {
        agreeHint.textContent = "You must scroll to the bottom of the agreement before you can accept.";
      } else if (!legalOk) {
        agreeHint.textContent = "Your typed legal name must match your profile name.";
      } else if (!checked) {
        agreeHint.textContent = "Check the box to confirm you agree.";
      } else {
        agreeHint.textContent = "Ready — click Accept Agreement.";
      }
    }
  };

  agreeChk.addEventListener("change", updateAcceptEnabled);
  legalNameEl.addEventListener("input", updateAcceptEnabled);
}

// Show agreement panel and run the flow if required
// Show agreement panel and run the flow if required
async function maybeRunAgreementGate(supabase, { forceMode, next }) {
  // Always check status (fail-closed)
  const status = await getAgreementStatus(supabase);

  // If not required OR already accepted: allow normal flow
  if (!status?.required || status?.accepted) {
    return { gated: false };
  }

  // If contractor requires agreement and hasn't accepted:
  if (!agreementPanel || !passwordPanel) {
    setBanner("Agreement required, but agreement UI is missing on this page.", "err");
    disablePasswordForm(true);
    return { gated: true };
  }

  // Update title/subtitle so it's clear what's happening
  const titleEl = document.getElementById("title");
  const subtitleEl = document.getElementById("subtitle");
  if (titleEl) titleEl.textContent = "Contractor agreement";
  if (subtitleEl) {
    subtitleEl.textContent =
      "Please read and accept this agreement to continue. After accepting, you will set your password.";
  }

  // Switch UI into agreement mode
  show(passwordPanel, false);
  show(agreementPanel, true);

  // Lock password form while agreement is pending
  disablePasswordForm(true);

  setBanner("Contractor agreement required before you can continue.", "warn");
  setAgreementMeta(`Required agreement: ${status.version}`, "warn");

  enableAgreementControls({ canCheck: false });

  // Load PDF (signed URL is only returned when not accepted)
  const signedUrl = status.signed_url;
  if (!signedUrl) {
    setAgreementMeta("Could not load agreement PDF (missing signed URL).", "err");
    return { gated: true };
  }

  await renderPdfSignedUrl(signedUrl);
  wireAgreementUX(status.display_name || "");

  // Wire accept button (IMPORTANT: do NOT redirect away; show password panel next)
  if (acceptBtn) {
    acceptBtn.onclick = async () => {
      try {
        acceptBtn.disabled = true;
        setAgreementMeta("Saving acceptance…", "warn");

        const legal = String(legalNameEl?.value || "").trim();
        if (!legal) {
          setAgreementMeta("Legal name is required.", "err");
          acceptBtn.disabled = false;
          return;
        }

        await acceptAgreement(supabase, legal);

        // Accepted — now continue on-page to password setup
        setAgreementMeta("Accepted. Now set your password below.", "ok");
        setBanner("Agreement accepted. Set your password to finish setup.", "ok");

        // Switch back to password panel
        show(agreementPanel, false);
        show(passwordPanel, true);

        // Update title/subtitle back to password flow
        if (titleEl) titleEl.textContent = "Set your password";
        if (subtitleEl) {
          subtitleEl.textContent =
            "This finishes your account setup. After saving, you’ll be sent to the login page.";
        }

        // Enable password form now
        disablePasswordForm(false);
        pw1El?.focus();

        // NOTE: do NOT redirect here.
        // Password save handler will do the final redirect.
      } catch (e) {
        console.error(e);
        setAgreementMeta(String(e?.message || e), "err");
        acceptBtn.disabled = false;
      }
    };
  }

  return { gated: true };
}


// ===== password flow =====
async function wirePasswordSave(supabase, userId) {
  if (!saveBtn) return;

  saveBtn.addEventListener("click", async () => {
    try {
      const p1 = String(pw1El?.value || "");
      const p2 = String(pw2El?.value || "");
      if (p1.length < 8) throw new Error("Password must be at least 8 characters.");
      if (p1 !== p2) throw new Error("Passwords do not match.");

      disablePasswordForm(true);
      setBanner("Saving password…", "warn");

      const { error } = await supabase.auth.updateUser({ password: p1 });
      if (error) throw error;

      await markEmployeeAccepted(supabase, userId);

      setBanner("Password set. Redirecting…", "ok");

      // IMPORTANT: after setting password, still enforce agreement gate
      // (in case they were invited as contractor and go straight to timeclock)
      const { next } = getQueryParams();
      redirectToNextOrLogin(next || "");
    } catch (e) {
      console.error(e);
      setBanner(String(e?.message || e), "err");
      disablePasswordForm(false);
    }
  });
}

// ===== main =====
async function main() {
  disablePasswordForm(true);
  setBanner("Checking invite link…", "warn");

  const supabase = await waitForSupabase();
  if (!supabase) {
    setBanner("Supabase client not initialized.", "err");
    return;
  }

  try {
    const session = await ensureSessionFromUrl(supabase);

    // Always check agreement status and gate if needed.
    const { mode, next } = getQueryParams();
    const forceAgreementMode = mode === "agreement";

    // If forced, show agreement UI immediately; otherwise status check still gates if required.
    const gate = await maybeRunAgreementGate(supabase, { forceMode: forceAgreementMode, next });

    if (gate.gated) return; // agreement UI takes over

    // Normal password UI
    show(agreementPanel, false);
    show(passwordPanel, true);

    setBanner("Link verified. Set your password.", "ok");
    disablePasswordForm(false);
    await wirePasswordSave(supabase, session.user.id);

  } catch (e) {
    console.error(e);
    setBanner(String(e?.message || e), "err");
    disablePasswordForm(true);
  }
}

document.addEventListener("DOMContentLoaded", main);
