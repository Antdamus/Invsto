// admin-taxdocs.js — Tax Docs tab (W-9 + W-4 Vault) (MAX SECURITY)
// Uses Edge Function "admin-taxdocs" and private bucket (your Edge uses "tax-dots").
// - Upload: multipart FormData (Edge requires it)
// - List / signed URL / status: JSON routes via invokeEdgeJson
//
// IMPORTANT:
// admin.js currently imports these named exports:
//   uploadW9ViaEdge, listW9ViaEdge, getW9SignedUrlViaEdge, setW9StatusViaEdge
// This file MUST export them to avoid the import error.

function $(id){ return document.getElementById(id); }

// ===== Re-auth (required before viewing docs) =====
const TAXDOCS_REAUTH_WINDOW_MS = 0; // set >0 to allow a short "recent reauth" window

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
      <h3 id="taxdocsReauthTitle" style="margin:0 0 6px;">Re-authorize to view tax docs</h3>
      <p class="muted" style="margin:0 0 12px;">
        For security, please confirm your admin password to open a document.
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

  wrap.addEventListener("click", (e) => { if (e.target === wrap) hideTaxDocsReauth(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTaxDocsReauth(); });

  $("taxdocsReauthCancel")?.addEventListener("click", hideTaxDocsReauth);
}

function showTaxDocsReauth(){
  ensureTaxDocsReauthModal();
  const el = $("taxdocsReauthModal");
  const pw = $("taxdocsReauthPw");
  const err = $("taxdocsReauthErr");
  if (!el) return;
  el.classList.remove("hidden");
  if (err) err.textContent = "";
  if (pw){ pw.value = ""; setTimeout(() => pw.focus(), 0); }
}

function hideTaxDocsReauth(){
  const el = $("taxdocsReauthModal");
  if (!el) return;
  el.classList.add("hidden");
}

async function requireRecentReauth(supabase){
  if (!supabase) throw new Error("supabase missing");
  const now = Date.now();
  const last = taxdocsLastReauthAt();
  if (TAXDOCS_REAUTH_WINDOW_MS > 0 && (now - last) <= TAXDOCS_REAUTH_WINDOW_MS) return true;

  // show modal and wait
  showTaxDocsReauth();

  return await new Promise((resolve, reject) => {
    const okBtn = $("taxdocsReauthOk");
    const pwEl = $("taxdocsReauthPw");
    const errEl = $("taxdocsReauthErr");

    const cleanup = () => {
      okBtn?.removeEventListener("click", onOk);
    };

    const onOk = async () => {
      try{
        const pw = (pwEl?.value || "").trim();
        if (!pw) { if (errEl) errEl.textContent = "Password required."; return; }

        // verify by attempting sign-in with same email (common pattern)
        const { data: u } = await supabase.auth.getUser();
        const email = u?.user?.email;
        if (!email) throw new Error("No user email");

        const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
        if (error) throw new Error("Re-auth failed");

        taxdocsSetReauthNow();
        hideTaxDocsReauth();
        cleanup();
        resolve(true);
      }catch(e){
        if (errEl) errEl.textContent = String(e?.message || e);
      }
    };

    okBtn?.addEventListener("click", onOk);
  });
}

// ===== helpers =====
function esc(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;");
}
function fmtTs(ts){
  if (!ts) return "—";
  try{
    const d = new Date(ts);
    if (Number.isNaN(+d)) return String(ts);
    return d.toLocaleString();
  }catch{ return String(ts); }
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

// ====== EXPORTS (W-9 legacy) ======
export async function uploadW9ViaEdge({ supabase, employeeId, file }) {
  return uploadDocMultipart({ supabase, employeeId, file, docType: "w9" });
}
export async function listW9ViaEdge({ invokeEdgeJson, employeeId }) {
  return listDocs({ invokeEdgeJson, employeeId, docType: "w9" });
}
export async function getW9SignedUrlViaEdge({ invokeEdgeJson, docId, expiresSeconds = 120 }) {
  return getSignedUrl({ invokeEdgeJson, docId, docType: "w9", expiresSeconds });
}
export async function setW9StatusViaEdge({ invokeEdgeJson, docId, status, reason = "" }) {
  return setStatus({ invokeEdgeJson, docId, docType: "w9", status, reason });
}

// ====== EXPORTS (W-4 new) ======
export async function uploadW4ViaEdge({ supabase, employeeId, file }) {
  return uploadDocMultipart({ supabase, employeeId, file, docType: "w4" });
}
export async function listW4ViaEdge({ invokeEdgeJson, employeeId }) {
  return listDocs({ invokeEdgeJson, employeeId, docType: "w4" });
}
export async function getW4SignedUrlViaEdge({ invokeEdgeJson, docId, expiresSeconds = 120 }) {
  return getSignedUrl({ invokeEdgeJson, docId, docType: "w4", expiresSeconds });
}
export async function setW4StatusViaEdge({ invokeEdgeJson, docId, status, reason = "" }) {
  return setStatus({ invokeEdgeJson, docId, docType: "w4", status, reason });
}

// ====== core Edge calls ======
async function uploadDocMultipart({ supabase, employeeId, file, docType }) {
  if (!supabase) throw new Error("supabase client missing");
  if (!employeeId) throw new Error("employeeId required");
  if (!file) throw new Error("file required");
  if (file.type !== "application/pdf") throw new Error(`${docType.toUpperCase()} must be a PDF`);

  const token = await getAccessToken(supabase);
  const baseUrl = getSupabaseBaseUrl(supabase);
  if (!baseUrl) throw new Error("Missing Supabase base URL");

  // IMPORTANT: this must match your deployed function name.
  // Your Edge function code expects "upload_w9" / "upload_w4" in multipart.
  const fnName = "admin-taxdocs";

  const fd = new FormData();
  fd.append("action", `upload_${docType}`);
  fd.append("employee_id", employeeId);
  fd.append("file", file);

  const res = await fetch(`${baseUrl}/functions/v1/${fnName}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: fd,
  });

  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out?.error || `Upload failed (${res.status})`);
  return out;
}

async function listDocs({ invokeEdgeJson, employeeId, docType }) {
  if (!invokeEdgeJson) throw new Error("invokeEdgeJson missing");
  if (!employeeId) throw new Error("employeeId required");

  const out = await invokeEdgeJson("admin-taxdocs", {
    action: `list_${docType}`,
    employee_id: employeeId,
  });

  if (!out?.ok) throw new Error(out?.error || `Failed to list ${docType.toUpperCase()}s`);
  return out.rows || [];
}

async function getSignedUrl({ invokeEdgeJson, docId, docType, expiresSeconds = 120 }) {
  if (!invokeEdgeJson) throw new Error("invokeEdgeJson missing");
  if (!docId) throw new Error("docId required");

  const out = await invokeEdgeJson("admin-taxdocs", {
    action: `get_${docType}_url`,
    doc_id: docId,
    expires_seconds: expiresSeconds,
  });

  if (!out?.ok) throw new Error(out?.error || "Failed to get signed URL");
  // your Edge returns { signed_url: ... }
  return out.signed_url || out.signedUrl || out.url;
}

async function setStatus({ invokeEdgeJson, docId, docType, status, reason = "" }) {
  if (!invokeEdgeJson) throw new Error("invokeEdgeJson missing");
  if (!docId) throw new Error("docId required");
  if (!["verified", "rejected"].includes(status)) throw new Error("status must be 'verified' or 'rejected'");
  if (status === "rejected" && !reason) throw new Error("reason required when rejecting");

  const out = await invokeEdgeJson("admin-taxdocs", {
    action: `set_${docType}_status`,
    doc_id: docId,
    status,
    reason,
  });

  if (!out?.ok) throw new Error(out?.error || "Failed to update status");
  return true;
}

// =========================================================
// UI (supports either W-9-only UI OR doc type selector UI)
// =========================================================
let _taxDocsWired = false;
let _lastEmployeeId = "";
let _lastDocType = "w9";

function currentDocType(){
  const sel = $("taxdocsDocType");
  const v = (sel?.value || "w9").toLowerCase();
  return (v === "w4") ? "w4" : "w9";
}

function applyDocTypeLabels(docType){
  const btn = $("taxdocsUploadBtn");
  const fileLbl = $("taxdocsFileLabel");
  const personLbl = $("taxdocsPersonLabel");

  if (btn) btn.textContent = docType === "w4" ? "Upload W-4" : "Upload W-9";
  if (fileLbl) fileLbl.textContent = docType === "w4" ? "W-4 PDF" : "W-9 PDF";
  if (personLbl) personLbl.textContent = docType === "w4" ? "Employee" : "Contractor";
}

async function loadPeople(supabase, docType){
  const sel = $("taxdocsEmployeeSelect");
  if (!sel) return;

  sel.innerHTML = `<option value="">Loading…</option>`;

  // Load active people; filter by worker_type in JS to avoid relying on schema quirks
  const { data, error } = await supabase
    .from("employees")
    .select("id, display_name, worker_type, role, active")
    .eq("active", true)
    .order("display_name", { ascending: true });

  if (error) {
    sel.innerHTML = `<option value="">Failed to load</option>`;
    return;
  }

  const rows = (data || []).filter(r => (r.role || "").toLowerCase() !== "admin");

  const filtered =
    docType === "w9"
      ? rows.filter(r => (r.worker_type || "").toLowerCase() === "contractor")
      : rows.filter(r => (r.worker_type || "employee").toLowerCase() !== "contractor");

  sel.innerHTML =
    `<option value="">Select a ${docType === "w4" ? "employee" : "contractor"}…</option>` +
    filtered.map(r => `<option value="${esc(r.id)}">${esc(r.display_name || "—")}</option>`).join("");
}

function rowHtml(r){
  const recv = r.received_at || r.created_at;
  const verOrRej = r.verified_at || r.rejected_at || "—";
  const st = String(r.status || "received");

  return `
    <tr data-doc-id="${esc(r.id)}">
      <td><span class="td-badge">${esc(st)}</span></td>
      <td style="word-break:break-all;"><code>${esc(r.id)}</code></td>
      <td>${esc(fmtTs(recv))}</td>
      <td>${esc(fmtTs(verOrRej))}</td>
      <td>
        <button class="btn small" data-act="view">View</button>
        <button class="btn small" data-act="verify">Verify</button>
        <button class="btn small danger" data-act="reject">Reject</button>
      </td>
    </tr>
  `;
}

async function renderForPerson({ supabase, invokeEdgeJson, showToast }){
  const tb = $("taxdocsTbody");
  const sel = $("taxdocsEmployeeSelect");
  if (!tb || !sel) return;

  const employeeId = (sel.value || "").trim();
  const docType = currentDocType();
  _lastEmployeeId = employeeId;
  _lastDocType = docType;

  if (!employeeId){
    tb.innerHTML = `<tr><td colspan="5" class="muted">Select a person to view documents.</td></tr>`;
    return;
  }

  tb.innerHTML = `<tr><td colspan="5" class="muted">Loading…</td></tr>`;

  try{
    const rows = docType === "w4"
      ? await listW4ViaEdge({ invokeEdgeJson, employeeId })
      : await listW9ViaEdge({ invokeEdgeJson, employeeId });

    if (!rows.length){
      tb.innerHTML = `<tr><td colspan="5" class="muted">No documents yet.</td></tr>`;
      setMsg("Ready. No documents yet.", "muted");
      return;
    }

    tb.innerHTML = rows.map(rowHtml).join("");
    setMsg("Ready.", "ok");
  }catch(err){
    console.error(err);
    tb.innerHTML = `<tr><td colspan="5" class="muted">Failed to load.</td></tr>`;
    setMsg(err?.message || "Failed to load", "err");
    showToast?.("Failed to load", "err");
  }
}

async function onUpload({ supabase, invokeEdgeJson, showToast }){
  const sel = $("taxdocsEmployeeSelect");
  const input = $("taxdocsPdfInput");
  const btn = $("taxdocsUploadBtn");
  if (!sel || !input || !btn) return;

  const employeeId = (sel.value || "").trim();
  const file = input.files?.[0];
  const docType = currentDocType();

  if (!employeeId) { showToast?.("Pick a person first", "err"); return; }
  if (!file) { showToast?.("Pick a PDF file first", "err"); return; }
  if (!file.name.toLowerCase().endsWith(".pdf")) { showToast?.("File must be a PDF", "err"); return; }

  btn.disabled = true;
  setMsg(`Uploading ${docType.toUpperCase()}…`, "warn");

  try{
    const out = docType === "w4"
      ? await uploadW4ViaEdge({ supabase, employeeId, file })
      : await uploadW9ViaEdge({ supabase, employeeId, file });

    setMsg(`Uploaded. Doc ID: ${out.doc_id}`, "ok");
    input.value = "";
    showToast?.(`${docType.toUpperCase()} uploaded ✅`, "ok");
    await renderForPerson({ supabase, invokeEdgeJson, showToast });
  }catch(err){
    console.error(err);
    setMsg(err?.message || "Upload failed", "err");
    showToast?.(err?.message || "Upload failed", "err");
  }finally{
    btn.disabled = false;
  }
}

async function onTableClick(e, { supabase, invokeEdgeJson, showToast }){
  const t = e.target;
  const tr = t.closest("tr[data-doc-id]");
  if (!tr) return;

  const docId = tr.getAttribute("data-doc-id");
  if (!docId) return;

  const docType = currentDocType();

  const viewBtn = t.closest('button[data-act="view"]');
  if (viewBtn){
    viewBtn.disabled = true;
    try{
      await requireRecentReauth(supabase);
      const url = docType === "w4"
        ? await getW4SignedUrlViaEdge({ invokeEdgeJson, docId, expiresSeconds: 120 })
        : await getW9SignedUrlViaEdge({ invokeEdgeJson, docId, expiresSeconds: 120 });

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
      if (docType === "w4") {
        await setW4StatusViaEdge({ invokeEdgeJson, docId, status:"verified" });
      } else {
        await setW9StatusViaEdge({ invokeEdgeJson, docId, status:"verified" });
      }
      showToast?.("Marked verified ✅", "ok");
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
    const reason = prompt(`Reject ${docType.toUpperCase()} — enter a reason (required):`)?.trim() || "";
    if (!reason) return;
    rejectBtn.disabled = true;
    try{
      if (docType === "w4") {
        await setW4StatusViaEdge({ invokeEdgeJson, docId, status:"rejected", reason });
      } else {
        await setW9StatusViaEdge({ invokeEdgeJson, docId, status:"rejected", reason });
      }
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

// Public init that admin.js can call (or you can call via window.initTaxDocsTab)
export async function initTaxDocsTab(){
  if (_taxDocsWired) return;
  _taxDocsWired = true;

  const supabase = window.supabase;
  const invokeEdgeJson = window.invokeEdgeJson;
  const showToast = window.showToast;

  if (!supabase) throw new Error("supabase missing on window");
  if (typeof invokeEdgeJson !== "function") throw new Error("invokeEdgeJson missing on window");

  // If you have the doc type selector, wire it. If not, it just defaults to W-9.
  $("taxdocsDocType")?.addEventListener("change", async () => {
    const dt = currentDocType();
    applyDocTypeLabels(dt);
    $("taxdocsEmployeeSelect").value = "";
    await loadPeople(supabase, dt);
    $("taxdocsTbody").innerHTML = `<tr><td colspan="5" class="muted">Select a person to view documents.</td></tr>`;
  });

  const dt = currentDocType();
  applyDocTypeLabels(dt);
  await loadPeople(supabase, dt);

  $("taxdocsEmployeeSelect")?.addEventListener("change", () => {
    renderForPerson({ supabase, invokeEdgeJson, showToast });
  });

  $("taxdocsRefreshBtn")?.addEventListener("click", () => {
    const dt2 = currentDocType();
    loadPeople(supabase, dt2).then(() => {
      if (_lastEmployeeId) $("taxdocsEmployeeSelect").value = _lastEmployeeId;
      renderForPerson({ supabase, invokeEdgeJson, showToast });
    });
  });

  $("taxdocsUploadBtn")?.addEventListener("click", () => {
    onUpload({ supabase, invokeEdgeJson, showToast });
  });

  $("taxdocsTbody")?.addEventListener("click", (e) => onTableClick(e, { supabase, invokeEdgeJson, showToast }));

  // allow internal refresh reuse
  window.__taxdocsRefresh = async () => {
    await renderForPerson({ supabase, invokeEdgeJson, showToast });
  };

  setMsg("Ready. Select a person.", "muted");
}

window.initTaxDocsTab = initTaxDocsTab;
