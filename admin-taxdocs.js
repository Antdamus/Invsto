// admin-taxdocs.js — Tax Docs tab (W-9 Vault) (MAX SECURITY)
// Uses Edge Function "admin-taxdocs" and private bucket "tax-dots".
// - Upload: multipart FormData (Edge Function requires it)
// - List / signed URL / status: JSON routes

function $(id){ return document.getElementById(id); }

// ===== Re-auth (required before viewing W-9) =====
const TAXDOCS_REAUTH_WINDOW_MS = 0; // 3 minutes. Set to 0 to require EVERY view.

function taxdocsLastReauthAt(){
  const v = Number(sessionStorage.getItem("taxdocs_last_reauth_at") || "0");
  return Number.isFinite(v) ? v : 0;
}
function taxdocsSetReauthNow(){
  sessionStorage.setItem("taxdocs_last_reauth_at", String(Date.now()));
}

function ensureTaxDocsReauthModal(){
  if (document.getElementById("taxdocsReauthModal")) return;

  const wrap = document.createElement("div");
  wrap.id = "taxdocsReauthModal";
  wrap.className = "taxdocs-reauth-backdrop hidden";
  wrap.innerHTML = `
    <div class="taxdocs-reauth-card" role="dialog" aria-modal="true" aria-labelledby="taxdocsReauthTitle">
      <h3 id="taxdocsReauthTitle" style="margin:0 0 6px;">Re-authorize to view W-9</h3>
      <p class="muted" style="margin:0 0 12px;">
        For security, please confirm your admin password to open a W-9.
      </p>

      <label class="filter grow" style="margin:0;">
        <span>Password</span>
        <input id="taxdocsReauthPw" type="password" autocomplete="current-password" placeholder="Enter your password" />
      </label>

      <div id="taxdocsReauthErr" class="muted" style="margin-top:10px; min-height:18px;"></div>

      <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:12px;">
        <button id="taxdocsReauthCancel" class="btn ghost">Cancel</button>
        <button id="taxdocsReauthOk" class="btn primary">Continue</button>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  // close on backdrop click
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap) hideTaxDocsReauth();
  });

  // esc to close
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideTaxDocsReauth();
  });
}

function showTaxDocsReauth(){
  ensureTaxDocsReauthModal();
  const el = document.getElementById("taxdocsReauthModal");
  const pw = document.getElementById("taxdocsReauthPw");
  const err = document.getElementById("taxdocsReauthErr");
  if (!el) return;
  el.classList.remove("hidden");
  if (err) err.textContent = "";
  if (pw){ pw.value = ""; setTimeout(() => pw.focus(), 0); }
}

function hideTaxDocsReauth(){
  const el = document.getElementById("taxdocsReauthModal");
  if (!el) return;
  el.classList.add("hidden");
}

async function requireRecentReauth(supabase){
  if (!supabase) throw new Error("supabase missing");

  if (TAXDOCS_REAUTH_WINDOW_MS > 0) {
    const last = taxdocsLastReauthAt();
    if (last && (Date.now() - last) <= TAXDOCS_REAUTH_WINDOW_MS) return true;
  }

  showTaxDocsReauth();

  return await new Promise((resolve, reject) => {
    const okBtn = document.getElementById("taxdocsReauthOk");
    const cancelBtn = document.getElementById("taxdocsReauthCancel");
    const pwEl = document.getElementById("taxdocsReauthPw");
    const errEl = document.getElementById("taxdocsReauthErr");

    const cleanup = () => {
      okBtn?.removeEventListener("click", onOk);
      cancelBtn?.removeEventListener("click", onCancel);
      pwEl?.removeEventListener("keydown", onEnter);
    };

    const onCancel = () => {
      cleanup();
      hideTaxDocsReauth();
      reject(new Error("Re-authorization canceled"));
    };

    const onEnter = (e) => {
      if (e.key === "Enter") onOk();
    };

    const onOk = async () => {
      try{
        const password = pwEl?.value || "";
        if (!password) throw new Error("Password required");

        if (errEl) errEl.textContent = "Re-authorizing…";

        const { data: u, error: uErr } = await supabase.auth.getUser();
        if (uErr || !u?.user?.email) throw new Error("No user email available for re-auth");

        // This refreshes the session only if password is correct.
        const { error: sErr } = await supabase.auth.signInWithPassword({
          email: u.user.email,
          password
        });
        if (sErr) throw sErr;

        taxdocsSetReauthNow();
        cleanup();
        hideTaxDocsReauth();
        resolve(true);
      }catch(e){
        if (errEl) errEl.textContent = e?.message || "Re-auth failed";
      }
    };

    okBtn?.addEventListener("click", onOk);
    cancelBtn?.addEventListener("click", onCancel);
    pwEl?.addEventListener("keydown", onEnter);
  });
}


function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
function fmtTs(ts){
  if (!ts) return "—";
  // ts may arrive as ISO string; show local
  try{
    const d = new Date(ts);
    if (Number.isNaN(+d)) return String(ts);
    return d.toLocaleString();
  }catch{
    return String(ts);
  }
}

function setMsg(text, kind="muted"){
  const el = $("taxdocsMsg");
  if (!el) return;
  el.textContent = text || "—";
  el.classList.remove("ok","warn","err","muted");
  el.classList.add(kind);
}

function getSupabaseBaseUrl(supabase) {
  return (
    supabase?.supabaseUrl ||
    supabase?.rest?.url?.replace(/\/rest\/v1\/?$/, "") ||
    window.SUPABASE_URL ||
    ""
  );
}

async function getAccessToken(supabase) {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  const token = data?.session?.access_token;
  if (!token) throw new Error("No active session");
  return token;
}

// ===== Upload (multipart) =====
export async function uploadW9ViaEdge({ supabase, employeeId, file }) {
  if (!supabase) throw new Error("supabase client missing");
  if (!employeeId) throw new Error("employeeId required");
  if (!file) throw new Error("file required");

  if (file.type !== "application/pdf") throw new Error("W-9 must be a PDF");

  const token = await getAccessToken(supabase);
  const baseUrl = getSupabaseBaseUrl(supabase);
  if (!baseUrl) throw new Error("Missing Supabase base URL");

  const fd = new FormData();
  fd.append("action", "upload_w9");
  fd.append("employee_id", employeeId);
  fd.append("file", file);

  const res = await fetch(`${baseUrl}/functions/v1/admin-taxdocs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });

  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out?.error || `Upload failed (${res.status})`);
  return out; // { ok, doc_id, storage_path }
}

// ===== List (JSON via invokeEdgeJson) =====
export async function listW9ViaEdge({ invokeEdgeJson, employeeId }) {
  if (!invokeEdgeJson) throw new Error("invokeEdgeJson missing");
  if (!employeeId) throw new Error("employeeId required");

  const out = await invokeEdgeJson("admin-taxdocs", {
    action: "list_w9",
    employee_id: employeeId,
  });

  if (!out?.ok) throw new Error(out?.error || "Failed to list W-9s");
  return out.rows || [];
}

// ===== Signed URL (JSON via invokeEdgeJson) =====
export async function getW9SignedUrlViaEdge({ invokeEdgeJson, docId, expiresSeconds = 120 }) {
  if (!invokeEdgeJson) throw new Error("invokeEdgeJson missing");
  if (!docId) throw new Error("docId required");

  const out = await invokeEdgeJson("admin-taxdocs", {
    action: "get_w9_url",
    doc_id: docId,
    expires_seconds: expiresSeconds,
  });

  if (!out?.ok) throw new Error(out?.error || "Failed to get signed URL");
  return out.signed_url;
}

// ===== Status update (JSON via invokeEdgeJson) =====
export async function setW9StatusViaEdge({ invokeEdgeJson, docId, status, reason = "" }) {
  if (!invokeEdgeJson) throw new Error("invokeEdgeJson missing");
  if (!docId) throw new Error("docId required");
  if (!["verified", "rejected"].includes(status)) throw new Error("status must be 'verified' or 'rejected'");
  if (status === "rejected" && !reason) throw new Error("reason required when rejecting");

  const out = await invokeEdgeJson("admin-taxdocs", {
    action: "set_w9_status",
    doc_id: docId,
    status,
    reason,
  });

  if (!out?.ok) throw new Error(out?.error || "Failed to update status");
  return true;
}

/* =========================================================
   Tax Docs Tab UI
   ========================================================= */

let _taxDocsWired = false;
let _lastEmployeeId = "";

async function loadContractors(supabase){
  const sel = $("taxdocsEmployeeSelect");
  if (!sel) return;

  sel.innerHTML = `<option value="">Loading contractors…</option>`;

  // Prefer "worker_type = contractor" (matches your Users UI validations) :contentReference[oaicite:6]{index=6}
  // Fallback: if that filter fails, show all active non-admin employees.
  try{
    const { data, error } = await supabase
      .from("employees")
      .select("id, display_name, worker_type, role, active")
      .eq("active", true)
      .order("display_name", { ascending: true });

    if (error) throw error;

    const rows = (data || []);
    const contractors = rows.filter(r => (r.worker_type === "contractor"));
    const fallback = contractors.length ? contractors : rows.filter(r => r.role !== "admin");

    sel.innerHTML =
      `<option value="">Select a contractor…</option>` +
      fallback.map(r => {
        const label = `${r.display_name || "—"}${r.worker_type ? ` (${r.worker_type})` : ""}`;
        return `<option value="${escapeHtml(r.id)}">${escapeHtml(label)}</option>`;
      }).join("");

  }catch(err){
    console.error(err);
    sel.innerHTML = `<option value="">Failed to load employees</option>`;
  }
}

function statusBadge(row){
  const st = String(row.status || "received");
  const cls =
    st === "verified" ? "td-badge ok" :
    st === "rejected" ? "td-badge err" :
    st === "replaced" ? "td-badge muted" :
    "td-badge warn";
  return `<span class="${cls}">${escapeHtml(st)}</span>`;
}

function rowHtml(r){
  const recv = r.received_at || r.created_at;
  const verOrRej = r.verified_at || r.rejected_at || "—";

  const rejectMeta = r.rejection_reason ? ` title="${escapeHtml(r.rejection_reason)}"` : "";
  const rejectNote = r.rejection_reason ? ` <span class="muted"(style="margin-left:6px") ${rejectMeta}>ⓘ</span>` : "";

  const canVerify = r.status !== "verified";
  const canReject = r.status !== "rejected";

  return `
    <tr data-doc-id="${escapeHtml(r.id)}">
      <td>${statusBadge(r)}${rejectNote}</td>
      <td style="word-break:break-all;"><code>${escapeHtml(r.id)}</code></td>
      <td>${escapeHtml(fmtTs(recv))}</td>
      <td>${escapeHtml(fmtTs(verOrRej))}</td>
      <td>
        <button class="btn small" data-act="view">View</button>
        <button class="btn small" data-act="verify" ${canVerify ? "" : "disabled"}>Verify</button>
        <button class="btn small danger" data-act="reject" ${canReject ? "" : "disabled"}>Reject</button>
      </td>
    </tr>
  `;
}

async function renderForEmployee({ supabase, invokeEdgeJson, showToast }){
  const tb = $("taxdocsTbody");
  const sel = $("taxdocsEmployeeSelect");
  if (!tb || !sel) return;

  const employeeId = (sel.value || "").trim();
  _lastEmployeeId = employeeId;

  if (!employeeId){
    tb.innerHTML = `<tr><td colspan="5" class="muted">Select a contractor to view W-9 history.</td></tr>`;
    return;
  }

  tb.innerHTML = `<tr><td colspan="5" class="muted">Loading…</td></tr>`;

  try{
    const rows = await listW9ViaEdge({ invokeEdgeJson, employeeId });
    if (!rows.length){
      tb.innerHTML = `<tr><td colspan="5" class="muted">No W-9s uploaded yet.</td></tr>`;
      setMsg("Ready. No documents yet.", "muted");
      return;
    }
    tb.innerHTML = rows.map(rowHtml).join("");
    setMsg("Ready.", "ok");
  }catch(err){
    console.error(err);
    tb.innerHTML = `<tr><td colspan="5" class="muted">Failed to load W-9s.</td></tr>`;
    setMsg(err?.message || "Failed to load", "err");
    showToast?.("Failed to load W-9s", "err");
  }
}

async function onUpload({ supabase, invokeEdgeJson, showToast }){
  const sel = $("taxdocsEmployeeSelect");
  const input = $("taxdocsPdfInput");
  const btn = $("taxdocsUploadBtn");
  if (!sel || !input || !btn) return;

  const employeeId = (sel.value || "").trim();
  const file = input.files?.[0];

  if (!employeeId) { showToast?.("Pick a contractor first", "err"); return; }
  if (!file) { showToast?.("Pick a PDF file first", "err"); return; }
  if (!file.name.toLowerCase().endsWith(".pdf")) { showToast?.("File must be a PDF", "err"); return; }

  btn.disabled = true;
  setMsg("Uploading W-9…", "warn");

  try{
    const out = await uploadW9ViaEdge({ supabase, employeeId, file });
    setMsg(`Uploaded. Doc ID: ${out.doc_id}`, "ok");
    input.value = "";
    showToast?.("W-9 uploaded ✅", "ok");
    await renderForEmployee({ supabase, invokeEdgeJson, showToast });
  }catch(err){
    console.error(err);
    setMsg(err?.message || "Upload failed", "err");
    showToast?.(err?.message || "Upload failed", "err");
  }finally{
    btn.disabled = false;
  }
}

async function onTableClick(e, { invokeEdgeJson, showToast }){
  const t = e.target;
  const tr = t.closest("tr[data-doc-id]");
  if (!tr) return;

  const docId = tr.getAttribute("data-doc-id");
  if (!docId) return;

  const viewBtn = t.closest('button[data-act="view"]');
  if (viewBtn){
    viewBtn.disabled = true;
    try{
      await requireRecentReauth(supabase);
      const url = await getW9SignedUrlViaEdge({ invokeEdgeJson, docId, expiresSeconds: 120 });
      window.open(url, "_blank", "noopener,noreferrer");
      showToast?.("Signed URL opened (120s)", "ok");
    }catch(err){
      console.error(err);
      showToast?.(err?.message || "Failed to open", "err");
    }finally{
      viewBtn.disabled = false;
    }
    return;
  }

  const verifyBtn = t.closest('button[data-act="verify"]');
  if (verifyBtn){
    verifyBtn.disabled = true;
    try{
      await setW9StatusViaEdge({ invokeEdgeJson, docId, status:"verified" });
      showToast?.("Marked verified ✅", "ok");
      // refresh current employee list
      if (typeof window.__taxdocsRefresh === "function") await window.__taxdocsRefresh();
    }catch(err){
      console.error(err);
      showToast?.(err?.message || "Failed to verify", "err");
    }finally{
      verifyBtn.disabled = false;
    }
    return;
  }

  const rejectBtn = t.closest('button[data-act="reject"]');
  if (rejectBtn){
    const reason = prompt("Reject W-9 — enter a reason (required):")?.trim() || "";
    if (!reason) return;
    rejectBtn.disabled = true;
    try{
      await setW9StatusViaEdge({ invokeEdgeJson, docId, status:"rejected", reason });
      showToast?.("Rejected", "ok");
      if (typeof window.__taxdocsRefresh === "function") await window.__taxdocsRefresh();
    }catch(err){
      console.error(err);
      showToast?.(err?.message || "Failed to reject", "err");
    }finally{
      rejectBtn.disabled = false;
    }
  }
}

// Public init that admin.js will call once on first tab open
export async function initTaxDocsTab(){
  if (_taxDocsWired) return;
  _taxDocsWired = true;

  const supabase = window.supabase;
  const invokeEdgeJson = window.invokeEdgeJson; // we will expose this from admin.js in the tiny change below
  const showToast = window.showToast;

  if (!supabase) throw new Error("supabase missing on window");
  if (typeof invokeEdgeJson !== "function") throw new Error("invokeEdgeJson missing on window");

  await loadContractors(supabase);

  $("taxdocsEmployeeSelect")?.addEventListener("change", () => {
    renderForEmployee({ supabase, invokeEdgeJson, showToast });
  });

  $("taxdocsRefreshBtn")?.addEventListener("click", () => {
    loadContractors(supabase).then(() => {
      if (_lastEmployeeId) $("taxdocsEmployeeSelect").value = _lastEmployeeId;
      renderForEmployee({ supabase, invokeEdgeJson, showToast });
    });
  });

  $("taxdocsUploadBtn")?.addEventListener("click", () => {
    onUpload({ supabase, invokeEdgeJson, showToast });
  });

  $("taxdocsTbody")?.addEventListener("click", (e) => onTableClick(e, { supabase, invokeEdgeJson, showToast }));


  // allow internal refresh reuse
  window.__taxdocsRefresh = async () => {
    await renderForEmployee({ supabase, invokeEdgeJson, showToast });
  };

  // Render placeholder state
  setMsg("Ready. Select a contractor.", "muted");
}

// Also expose for admin.js lazy init call
window.initTaxDocsTab = initTaxDocsTab;
