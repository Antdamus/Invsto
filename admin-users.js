// admin-users.js — Users tab cards-only renderer (safe, non-breaking)
// - Reuses admin.js loadUsers()/saveUserRow() where possible
// - Only displays W-9/W-4 presence + verified status (no upload/verify here)

(function(){
  const qs = (id) => document.getElementById(id);

  function esc(s){
    return (s ?? '').toString()
      .replaceAll('&','&amp;')
      .replaceAll('<','&lt;')
      .replaceAll('>','&gt;')
      .replaceAll('"','&quot;')
      .replaceAll("'","&#039;");
  }

  function fmtLocal(ts){
    if (!ts) return "—";
    try{
      const d = new Date(ts);
      if (Number.isNaN(+d)) return String(ts);
      return d.toLocaleString();
    }catch{
      return String(ts);
    }
  }

  function chip(label, kind="muted", icon=""){
    const i = icon ? `<span style="opacity:.95">${icon}</span>` : "";
    return `<span class="uc ${kind}">${i}${esc(label)}</span>`;
  }

  // Fetch "latest active doc" status per employee for W-9/W-4.
  // This assumes employee_tax_docs exists and has: employee_id, doc_type, status, is_active, created_at.
  async function fetchTaxDocStatusMap(supabase, employeeIds){
    const map = new Map(); // key: `${employee_id}:${doc_type}` => { status, is_active, created_at }

    if (!supabase || !employeeIds?.length) return map;

    // If your RLS blocks this, we can switch to a tiny Edge function later.
    const { data, error } = await supabase
      .from("employee_tax_docs")
      .select("employee_id, doc_type, status, is_active, created_at")
      .in("employee_id", employeeIds)
      .in("doc_type", ["w9","w4"])
      .order("created_at", { ascending: false });

    if (error) {
      console.warn("fetchTaxDocStatusMap blocked:", error.message);
      return map;
    }

    // Keep first (latest) record per employee+doctype
    for (const r of (data || [])) {
      const key = `${r.employee_id}:${(r.doc_type || "").toLowerCase()}`;
      if (!map.has(key)) map.set(key, r);
    }
    return map;
  }

  function statusChips(emp, docMap){
    const accepted = !!emp.accepted_at;
    const invitedAt = emp.invited_at || null;

    const statusLabel = accepted ? "Accepted" : "Invited";
    const statusKind  = accepted ? "ok" : "warn";

    const chips = [];
    chips.push(chip(statusLabel, statusKind, accepted ? "✅" : "✉️"));

    if (invitedAt) chips.push(chip(`Invited: ${fmtLocal(invitedAt)}`, "muted", "🕒"));

    // Worker type decides which doc we care about
    const wt = (emp.worker_type || "employee").toLowerCase();
    const wantDoc = wt === "contractor" ? "w9" : "w4";
    const key = `${emp.id}:${wantDoc}`;
    const doc = docMap.get(key);

    if (!doc) {
      chips.push(chip(wantDoc.toUpperCase() + ": missing", "warn", "📄"));
    } else {
      const st = (doc.status || "received").toLowerCase();
      if (st === "verified") chips.push(chip(wantDoc.toUpperCase() + ": verified", "ok", "🛡️"));
      else if (st === "rejected") chips.push(chip(wantDoc.toUpperCase() + ": rejected", "warn", "⚠️"));
      else chips.push(chip(wantDoc.toUpperCase() + `: ${st}`, "muted", "📄"));
    }

    // Legal address chip placeholder (Phase 2 will wire this to address history)
    chips.push(chip("Address: (phase 2)", "muted", "🏠"));

    return chips.join("");
  }

  function cardHtml(emp, docMap){
    const wt = (emp.worker_type || "employee").toLowerCase();
    const role = (emp.role || "employee").toLowerCase();

    const hourlyVal = (emp.hourly_rate === null || emp.hourly_rate === undefined || emp.hourly_rate === "")
      ? ""
      : String(emp.hourly_rate);

    const accepted = !!emp.accepted_at;

    return `
      <div class="user-card" data-employee-id="${esc(emp.id)}">
        <div class="user-card-top">
          <div class="user-card-title">
            <div class="name">${esc(emp.display_name || "—")}</div>
            <div class="email user-email">${esc(emp.email || "—")}</div>
          </div>

          <div class="user-chip-row" style="justify-content:flex-end;">
            ${chip(role, "muted", "🔑")}
            ${chip(wt, "muted", "👤")}
          </div>
        </div>

        <div class="user-chip-row">
          ${statusChips(emp, docMap)}
        </div>

        <div class="user-card-grid">
          <div class="field">
            <label>Display Name</label>
            <input class="input user-name" value="${esc(emp.display_name || "")}" />
          </div>

          <div class="field">
            <label>Role</label>
            <select class="select user-role">
              ${["employee","manager","admin"].map(r=>`<option value="${r}" ${role===r?"selected":""}>${r}</option>`).join("")}
            </select>
          </div>

          <div class="field">
            <label>Worker Type</label>
            <select class="select user-worker-type">
              ${["employee","contractor"].map(t=>`<option value="${t}" ${wt===t?"selected":""}>${t}</option>`).join("")}
            </select>
          </div>

          <div class="field">
            <label>Hourly Rate</label>
            <input
              class="input user-hourly-rate"
              type="number"
              inputmode="decimal"
              min="0"
              step="0.01"
              placeholder="e.g., 18.50"
              value="${esc(hourlyVal)}"
            />
          </div>

          <div class="field" style="grid-column: 1 / -1;">
            <label>Active</label>
            <label class="switch">
              <input class="user-active" type="checkbox" ${emp.active ? "checked":""} />
              <span>${emp.active ? "Yes":"No"}</span>
            </label>
          </div>
        </div>

        <div class="user-card-actions">
          ${accepted ? "" : `<button class="btn small ghost user-resend">Resend</button>`}
          <button class="btn small user-save">Save</button>
        </div>
      </div>
    `;
  }

  async function resendInviteCard(employee_id, email){
    const supabaseClient = window.supabaseClient || window.supabase;
    if (!supabaseClient) throw new Error("supabase client missing");

    const { data, error } = await supabaseClient.functions.invoke('admin-user', {
      body: { action: 'resend', employee_id: employee_id || undefined, email: email || undefined }
    });

    if (error) throw error;
    if (!data?.ok) throw new Error('Resend failed.');

    window.showToast?.('Invite resent ✉️', 'ok');
    if (typeof window.loadUsers === "function") await window.loadUsers();
  }

  async function renderUsersCards(rows){
    const supabase = window.supabaseClient || window.supabase;
    const wrap = qs("usersCards");
    if (!wrap) return;

    if (!rows?.length){
      wrap.innerHTML = `<div class="muted">No users found.</div>`;
      return;
    }

    // build doc status map
    const ids = rows.map(r => r.id).filter(Boolean);
    const docMap = await fetchTaxDocStatusMap(supabase, ids);

    wrap.innerHTML = rows.map(r => cardHtml(r, docMap)).join("");
  }

  function wireUsersCardsActions(){
    const wrap = qs("usersCards");
    if (!wrap) return;

    wrap.addEventListener("click", async (e) => {
      const card = e.target.closest(".user-card");
      if (!card) return;

      // Save uses your existing saveUserRow() from admin.js (it works on any element)
      const saveBtn = e.target.closest(".user-save");
      if (saveBtn){
        saveBtn.disabled = true;
        try{
          if (typeof window.saveUserRow !== "function") throw new Error("saveUserRow missing (admin.js not loaded?)");
          await window.saveUserRow(card);
          window.showToast?.("Saved ✅", "ok");
          if (typeof window.loadUsers === "function") await window.loadUsers();
        }catch(err){
          console.error(err);
          window.showToast?.(err?.message || "Save failed", "err");
        }finally{
          saveBtn.disabled = false;
        }
        return;
      }

      // Resend invite (card-safe)
      const resendBtn = e.target.closest(".user-resend");
      if (resendBtn){
        resendBtn.disabled = true;
        try{
          const employee_id = card.dataset.employeeId || "";
          const email = (card.querySelector(".user-email")?.textContent || "").trim();
          await resendInviteCard(employee_id, email);
        }catch(err){
          console.error(err);
          window.showToast?.(err?.message || "Resend failed", "err");
        }finally{
          resendBtn.disabled = false;
        }
      }
    });
  }

async function initUsersCardsTab(){
  // Official renderer contract (no hijack)
  window.renderUsers = renderUsersCards;

  wireUsersCardsActions();

  // Trigger a refresh using existing pipeline
  if (typeof window.loadUsers === "function") {
    await window.loadUsers();
  } else {
    console.warn("loadUsers missing; users cards will not auto-load.");
  }
}


  window.initUsersCardsTab = initUsersCardsTab;

document.addEventListener("DOMContentLoaded", () => {
  if (qs("usersCards")) {
    wireUsersCardsActions();
    window.renderUsers = renderUsersCards; // register early (safe)
  }
});

})();
