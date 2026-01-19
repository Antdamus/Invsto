/* =========================================================
   OG Jewelry — Admin Users Cards + Manage Drawer (Phase 3A)
   FULL REPLACEMENT admin-users.js
   - Cards are compact (summary only)
   - Manage drawer holds all edits (mobile friendly)
   - Uses existing window.loadUsers + window.saveUserRow + window.resendInvite (if present)
   ========================================================= */

(function () {
  "use strict";

  // ---------- tiny DOM helpers ----------
  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  // ---------- state ----------
  let lastRows = [];
  let lastDocMap = new Map(); // employee_id -> { status, doc_type }
  let drawerReady = false;
  let activeEmployeeId = null;

  function getEmpId(r){
  return String(r?.employee_id || r?.id || "");
}


  // ---------- init ----------
  function initUsersCardsTab() {
    const cards = qs("#usersCards");
    if (!cards) return;

    // Wire search + show inactive to re-render (admin.js likely already calls loadUsers)
    const search = qs("#userSearchInput");
    const showInactive = qs("#userShowInactive");

    if (search) {
      search.addEventListener("input", () => {
        // admin.js should already re-filter; but we also re-render from cache
        renderUsersCards(lastRows, lastDocMap);
      });
    }
    if (showInactive) {
      showInactive.addEventListener("change", () => {
        renderUsersCards(lastRows, lastDocMap);
      });
    }

    // Delegated click for Manage
    cards.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-action]");
      if (!btn) return;

      const action = btn.getAttribute("data-action");
      const card = btn.closest(".user-card");
      if (!card) return;

      const employeeId = card.getAttribute("data-employee-id") || "";
if (!employeeId) return;

if (action === "manage") {
  const row = lastRows.find((r) => getEmpId(r) === String(employeeId));
  if (!row) return;
  openUserDrawer(row);
}

    });

    // Expose renderer so admin.js can call it
    window.renderUsers = (rows, docMap) => {
      // docMap might come as Map or plain object
      lastRows = Array.isArray(rows) ? rows : [];
      lastDocMap = normalizeDocMap(docMap);
      renderUsersCards(lastRows, lastDocMap);
    };

    // If admin.js already loaded users before this script, it may have cached them.
    // So we do nothing aggressive here.
  }

  function normalizeDocMap(docMap) {
    if (!docMap) return new Map();
    if (docMap instanceof Map) return docMap;

    // allow plain object: { [employeeId]: {status, doc_type} }
    const m = new Map();
    try {
      for (const [k, v] of Object.entries(docMap)) m.set(String(k), v);
    } catch (_) {}
    return m;
  }

  // ---------- chip UI ----------
  function chip(label, kind = "neutral", icon = "") {
    // kind: ok | warn | bad | neutral | accent
    return `<span class="uc-chip uc-${kind}">${icon ? `<span class="uc-ic">${icon}</span>` : ""}${esc(label)}</span>`;
  }

  function statusChips(row) {
    const chips = [];

    // Invite/accepted status
    const accepted = row.accepted === true || row.status === "accepted" || row.invite_status === "accepted";
    chips.push(accepted ? chip("Accepted", "ok", "✅") : chip("Invited", "warn", "✉️"));

    // Worker type + role
    const role = row.role || "—";
    const workerType = row.worker_type || row.type || "—";
    chips.push(chip(role, role === "admin" ? "accent" : "neutral", role === "admin" ? "🔑" : "👤"));
    chips.push(chip(workerType, workerType === "employee" ? "neutral" : "neutral", workerType === "contractor" ? "🧰" : "🧾"));

    // Tax doc status summary (from doc map)
    const doc = lastDocMap.get(getEmpId(row));
    if (doc?.status) {
      const t = (doc.doc_type || "tax").toUpperCase();
      const st = String(doc.status).toLowerCase();
      if (st === "verified") chips.push(chip(`${t}: verified`, "ok", "📄"));
      else if (st === "received") chips.push(chip(`${t}: received`, "neutral", "📄"));
      else if (st === "rejected") chips.push(chip(`${t}: rejected`, "bad", "⛔"));
      else chips.push(chip(`${t}: ${st}`, "neutral", "📄"));
    } else {
      // We don’t upload/verify here; just show a hint
      chips.push(chip("Tax docs: check tab", "neutral", "📄"));
    }

    // Address (Phase 2)
    chips.push(chip("Address: (phase 2)", "neutral", "🏠"));

    // Active indicator
    chips.push(row.active ? chip("Active", "ok", "🟢") : chip("Inactive", "bad", "⚪"));

    return chips.join("");
  }

  // ---------- cards renderer ----------
  function renderUsersCards(rows, docMap) {
    const container = qs("#usersCards");
    if (!container) return;

    lastRows = Array.isArray(rows) ? rows : [];
    lastDocMap = docMap instanceof Map ? docMap : normalizeDocMap(docMap);

    const searchVal = (qs("#userSearchInput")?.value || "").trim().toLowerCase();
    const showInactive = !!qs("#userShowInactive")?.checked;

    const filtered = lastRows.filter((r) => {
      if (!showInactive && r.active === false) return false;

      if (!searchVal) return true;
      const hay = `${r.display_name || ""} ${r.email || ""} ${r.role || ""} ${r.worker_type || ""}`.toLowerCase();
      return hay.includes(searchVal);
    });

    if (!filtered.length) {
      container.innerHTML = `<div class="muted">No users match your filters.</div>`;
      return;
    }

    container.innerHTML = filtered
      .map((r) => {
        const name = r.display_name || r.name || "(no name)";
        const email = r.email || "";
        const hourly = r.hourly_rate ?? r.hourly ?? null;

        return `
          <article class="user-card" data-employee-id="${esc(getEmpId(r))}">
            <div class="uc-top">
              <div class="uc-identity">
                <div class="uc-name">${esc(name)}</div>
                <div class="uc-sub">
                  <span class="uc-email">${esc(email)}</span>
                  ${hourly != null ? `<span class="uc-dot">•</span><span class="uc-hourly">$${esc(hourly)}/hr</span>` : ""}
                </div>
              </div>

              <div class="uc-actions">
                <button class="btn ghost uc-manage" data-action="manage" type="button">
                  Manage
                </button>
              </div>
            </div>

            <div class="uc-chips">
              ${statusChips(r)}
            </div>
          </article>
        `;
      })
      .join("");
  }

  // ---------- drawer ----------
  function ensureDrawer() {
    if (drawerReady) return;

    // Backdrop + drawer injected once (no admin.html edits required)
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <div id="userDrawerBackdrop" class="drawer-backdrop hidden" aria-hidden="true"></div>

      <aside id="userDrawer" class="drawer hidden" role="dialog" aria-modal="true" aria-label="Manage user">
        <div class="drawer-head">
          <div class="drawer-title">
            <div class="ud-title">Manage User</div>
            <div class="ud-sub muted" id="udSub">—</div>
          </div>

          <button class="btn ghost" id="udCloseBtn" type="button">✕</button>
        </div>

        <div class="drawer-body">
          <div class="ud-chips" id="udChips"></div>

          <div class="ud-grid">
            <label class="ud-field">
              <span>Display Name</span>
              <input class="user-name" id="udName" type="text" autocomplete="off" />
            </label>

            <label class="ud-field">
              <span>Role</span>
              <select class="user-role" id="udRole">
                <option value="employee">employee</option>
                <option value="manager">manager</option>
                <option value="admin">admin</option>
              </select>
            </label>

            <label class="ud-field">
              <span>Worker Type</span>
              <select class="user-type" id="udType">
                <option value="employee">employee</option>
                <option value="contractor">contractor</option>
              </select>
            </label>

            <label class="ud-field">
              <span>Hourly Rate</span>
              <input class="user-hourly-rate" id="udHourly" type="number" step="0.01" min="0" />
            </label>

            <label class="ud-field ud-active">
              <span>Active</span>
              <div class="ud-switch">
                <input class="user-active" id="udActive" type="checkbox" />
                <span class="muted">Yes</span>
              </div>
            </label>

            <label class="ud-field ud-email">
              <span>Email</span>
              <input class="user-email" id="udEmail" type="text" readonly />
            </label>
          </div>

          <div class="ud-divider"></div>

          <div class="ud-actions">
            <button class="btn ghost" id="udResendBtn" type="button">Resend invite</button>
            <button class="btn primary" id="udSaveBtn" type="button">Save changes</button>
          </div>

          <div class="ud-msg muted" id="udMsg">—</div>
        </div>
      </aside>
    `;
    document.body.appendChild(wrap);

    const backdrop = qs("#userDrawerBackdrop");
    const drawer = qs("#userDrawer");
    const closeBtn = qs("#udCloseBtn");

    const close = () => closeUserDrawer();

    backdrop?.addEventListener("click", close);
    closeBtn?.addEventListener("click", close);

    // ESC closes
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && drawer && !drawer.classList.contains("hidden")) close();
    });

    // Save
    qs("#udSaveBtn")?.addEventListener("click", async () => {
      const msg = qs("#udMsg");
      if (!activeEmployeeId) return;

      const drawerEl = qs("#userDrawer");
      if (!drawerEl) return;

      // Call your existing save if present (best for compatibility)
      if (typeof window.saveUserRow === "function") {
        msg.textContent = "Saving…";
        try {
          await window.saveUserRow(drawerEl);
          msg.textContent = "Saved ✅";
          // refresh list
          if (typeof window.loadUsers === "function") await window.loadUsers();
        } catch (err) {
          msg.textContent = `Save failed: ${err?.message || err}`;
        }
        return;
      }

      msg.textContent = "Save handler missing in admin.js.";
    });

    // Resend invite
    qs("#udResendBtn")?.addEventListener("click", async () => {
      const msg = qs("#udMsg");
      const email = qs("#udEmail")?.value || "";
      if (!email) return;

      if (typeof window.resendInvite === "function") {
        msg.textContent = "Resending invite…";
        try {
          await window.resendInvite(email);
          msg.textContent = "Invite resent ✅";
        } catch (err) {
          msg.textContent = `Resend failed: ${err?.message || err}`;
        }
        return;
      }

      msg.textContent = "Resend handler missing in admin.js.";
    });

    drawerReady = true;
  }

  function openUserDrawer(row) {
    if (!row) return;
    ensureDrawer();

    activeEmployeeId = getEmpId(row);

    const backdrop = qs("#userDrawerBackdrop");
    const drawer = qs("#userDrawer");
    if (!backdrop || !drawer) return;

    // Populate
    qs("#udSub").textContent = row.email || "—";
    qs("#udChips").innerHTML = `<div class="uc-chips">${statusChips(row)}</div>`;

    qs("#udName").value = row.display_name || row.name || "";
    qs("#udRole").value = row.role || "employee";
    qs("#udType").value = row.worker_type || row.type || "employee";
    qs("#udHourly").value = row.hourly_rate ?? row.hourly ?? "";
    qs("#udActive").checked = !!row.active;
    qs("#udEmail").value = row.email || "";

    // Store the employee id where saveUserRow expects it
    drawer.setAttribute("data-employee-id", activeEmployeeId);

    // Clean msg
    qs("#udMsg").textContent = "—";

    // Show
    backdrop.classList.remove("hidden");
    drawer.classList.remove("hidden");
    requestAnimationFrame(() => {
      backdrop.classList.add("show");
      drawer.classList.add("show");
    });
  }

  function closeUserDrawer() {
    const backdrop = qs("#userDrawerBackdrop");
    const drawer = qs("#userDrawer");
    if (!backdrop || !drawer) return;

    drawer.classList.remove("show");
    backdrop.classList.remove("show");

    setTimeout(() => {
      drawer.classList.add("hidden");
      backdrop.classList.add("hidden");
    }, 160);

    activeEmployeeId = null;
  }

  // ---------- boot ----------
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initUsersCardsTab);
  } else {
    initUsersCardsTab();
  }
})();
