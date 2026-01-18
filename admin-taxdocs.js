// admin-taxdocs.js — W-9 vault helpers (MAX SECURITY)
// - Upload uses multipart FormData (Edge Function requires it)
// - List / signed URL / status use JSON via invokeEdgeJson()

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

  if (file.type !== "application/pdf") {
    throw new Error("W-9 must be a PDF");
  }

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
export async function getW9SignedUrlViaEdge({ invokeEdgeJson, docId, expiresSeconds = 180 }) {
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
  if (!["verified", "rejected"].includes(status)) {
    throw new Error("status must be 'verified' or 'rejected'");
  }
  if (status === "rejected" && !reason) {
    throw new Error("reason required when rejecting");
  }

  const out = await invokeEdgeJson("admin-taxdocs", {
    action: "set_w9_status",
    doc_id: docId,
    status,
    reason,
  });

  if (!out?.ok) throw new Error(out?.error || "Failed to update status");
  return true;
}
