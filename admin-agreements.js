// admin-agreements.js
// Admin Agreements panel: upload contractor agreement PDFs + activate + force contractors to re-sign

const AGREEMENTS_FN = "admin-agreements";

function $(id) { return document.getElementById(id); }

async function getAccessToken(supabase) {
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token || "";
}

async function callJson(supabase, body) {
  const { data, error } = await supabase.functions.invoke(AGREEMENTS_FN, { body });
  if (error) throw error;
  return data;
}

// multipart upload (must use fetch, not invoke)
async function uploadPdfViaEdge(supabase, file, activateNow) {
  const token = await getAccessToken(supabase);
  if (!token) throw new Error("No session token");

  const supaUrl =
    window.SUPABASE_URL ||
    window.supabase?.supabaseUrl || // some builds expose this
    null;

  if (!supaUrl) {
    throw new Error("Missing SUPABASE_URL on window. Add window.SUPABASE_URL in initSupabase.js.");
  }

  const fd = new FormData();
  fd.append("action", "upload_publish");
  fd.append("activate_now", activateNow ? "true" : "false");
  fd.append("file", file);

  const res = await fetch(`${supaUrl}/functions/v1/${AGREEMENTS_FN}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });

  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out?.error || `Upload failed (${res.status})`);
  return out;
}

function setMsg(text, kind = "") {
  const el = $("agreementUploadMsg");
  if (!el) return;
  el.textContent = text || "—";
  el.classList.remove("ok", "warn", "err");
  if (kind) el.classList.add(kind);
}

function rowHtml(r) {
  const activeBadge = r.active ? "✅ Yes" : "—";
  const path = `${r.bucket}/${r.path}`;

  return `
    <tr>
      <td><code>${escapeHtml(r.version)}</code></td>
      <td style="word-break:break-all;"><code>${escapeHtml(path)}</code></td>
      <td>${activeBadge}</td>
      <td>
        <button class="btn small" data-act="activate" data-ver="${escapeAttr(r.version)}">Activate + Force</button>
      </td>
    </tr>
  `;
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function escapeAttr(s) {
  return escapeHtml(s).replaceAll("'", "&#39;");
}

async function renderAgreementVersions(supabase) {
  const tbody = $("agreementsTbody");
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="4" class="muted">Loading…</td></tr>`;

  const res = await callJson(supabase, { action: "list" });
  const rows = res?.rows || [];

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">No versions yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(rowHtml).join("");

  // Activate buttons
  tbody.querySelectorAll('button[data-act="activate"]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const version = btn.getAttribute("data-ver");
      if (!version) return;

      btn.disabled = true;
      setMsg(`Activating ${version} and forcing all contractors…`, "warn");

      try {
        await callJson(supabase, { action: "activate", version });
        setMsg(`Active version set to ${version}. Contractors will be forced to re-sign.`, "ok");
        await renderAgreementVersions(supabase);
      } catch (e) {
        setMsg(String(e?.message || e), "err");
      } finally {
        btn.disabled = false;
      }
    });
  });
}

async function initAgreementsPanel() {
  const supabase = window.supabase;
  if (!supabase) return;

  const uploadBtn = $("agreementUploadBtn");
  const fileInput = $("agreementPdfInput");
  const activateChk = $("agreementActivateNow");
  const refreshBtn = $("agreementsRefreshBtn");
  const tabBtn = $("tabAgreements");

  async function openOrRefresh() {
    try {
      setMsg("Loading agreement versions…", "warn");
      await renderAgreementVersions(supabase);
      setMsg("Ready.", "ok");
    } catch (e) {
      setMsg(String(e?.message || e), "err");
    }
  }

  // Load when tab clicked
  if (tabBtn) tabBtn.addEventListener("click", openOrRefresh);
  if (refreshBtn) refreshBtn.addEventListener("click", openOrRefresh);

  // Upload
  if (uploadBtn) {
    uploadBtn.addEventListener("click", async () => {
      try {
        const file = fileInput?.files?.[0];
        if (!file) throw new Error("Pick a PDF file first.");
        if (!file.name.toLowerCase().endsWith(".pdf")) throw new Error("File must be a PDF.");

        const activateNow = !!activateChk?.checked;

        uploadBtn.disabled = true;
        setMsg("Uploading PDF…", "warn");

        const out = await uploadPdfViaEdge(supabase, file, activateNow);

        setMsg(
          activateNow
            ? `Uploaded + activated ${out.version}. Contractors forced to re-sign.`
            : `Uploaded ${out.version}. (Not activated)`,
          "ok"
        );

        // Reset file input
        fileInput.value = "";

        await renderAgreementVersions(supabase);
      } catch (e) {
        setMsg(String(e?.message || e), "err");
      } finally {
        uploadBtn.disabled = false;
      }
    });
  }
}

// Boot
document.addEventListener("supabase-ready", initAgreementsPanel);
document.addEventListener("DOMContentLoaded", initAgreementsPanel);
