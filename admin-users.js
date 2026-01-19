/* =========================================================
   OG Jewelry — Admin Users Cards + Manage Drawer (Phase 3B)
   FULL REPLACEMENT admin-users.js
   - Card click opens drawer (mobile friendly)
   - Dirty-state save (Save disabled until changes)
   - Drawer sections + sticky footer actions
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

  // dirty-state
  let drawerSnapshot = null; // {name, role, type, hourly, active}
  let drawerDirty = false;

  function getEmpId(r) {
    return String(r?.employee_id || r?.id || "");
  }

  function normalizeDocMap(docMap) {
    if (!docMap) return new Map();
    if (docMap instanceof Map) return docMap;

    const m = new Map();
    try {
      for (const [k, v] of Object.entries(docMap)) m.set(String(k), v);
    } catch (_) {}
    return m;
  }

  // ---------- init ----------
  function initUsersCardsTab() {
    const cards = qs("#usersCards");
    if (!cards) return;

    const search = qs("#userSearchInput");
    const showInactive = qs("#userShowInactive");

    if (search) {
      search.addEventListener("input", () => renderUsersCards(lastRows, lastDocMap));
    }
    if (showInactive) {
      showInactive.addEventListener("change", () => renderUsersCards(lastRows, lastDocMap));
    }

    // Press micro-interaction
    cards.addEventListener("pointerdown", (e) => {
      const card = e.target.closest(".user-card");
      if (!card) return;
      card.classList.add("uc-pressed");
    });
    window.addEventListener("pointerup", () => {
      qsa(".user-card.uc-pressed").forEach((c) => c.classList.remove("uc-pressed"));
    });

    // Delegated click:
    // - Manage button opens drawer
    // - Clicking anywhere on card also opens drawer (except interactive elements)
    cards.addEventListener("click", (e) => {
      const card = e.target.closest(".user-card");
      if (!card) return;

      const employeeId = card.getAttribute("data-employee-id") || "";
      if (!employeeId) return;

      // If clicked an interactive element, don't treat as "open drawer"
      const interactive = e.target.closest("button, a, input, select, textarea, label");
      const btn = e.target.closest("[data-action]");

      // Explicit actions
      if (btn) {
        const action = btn.getAttribute("data-action");
        if (action === "manage") {
          const row = lastRows.find((r) => getEmpId(r) === String(employeeId));
          if (!row) return;
          openUserDrawer(row);
        }
        return;
      }

      // Card click opens drawer (unless interactive)
      if (!interactive) {
        const row = lastRows.find((r) => getEmpId(r) === String(employeeId));
        if (!row) return;
        openUserDrawer(row);
      }
    });

    // Expose renderer so admin.js can call it
    window.renderUsers = (rows, docMap) => {
      lastRows = Array.isArray(rows) ? rows : [];
      lastDocMap = normalizeDocMap(docMap);
      renderUsersCards(lastRows, lastDocMap);
    };
  }

  // ---------- chip UI ----------
  function chip(label, kind = "neutral", icon = "") {
    return `<span class="uc-chip uc-${kind}">${icon ? `<span class="uc-ic">${icon}</span>` : ""}${esc(label)}</span>`;
  }

  function statusChips(row) {
    const chips = [];

    const accepted = row.accepted === true || row.status === "accepted" || row.invite_status === "accepted";
    chips.push(accepted ? chip("Accepted", "ok", "✅") : chip("Invited", "warn", "✉️"));

    const role = row.role || "—";
    const workerType = row.worker_type || row.type || "—";
    chips.push(chip(role, role === "admin" ? "accent" : "neutral", role === "admin" ? "🔑" : "👤"));
    chips.push(chip(workerType, "neutral", workerType === "contractor" ? "🧰" : "🧾"));

    const doc = lastDocMap.get(getEmpId(row));
    if (doc?.status) {
      const t = (doc.doc_type || "tax").toUpperCase();
      const st = String(doc.status).toLowerCase();
      if (st === "verified") chips.push(chip(`${t}: verified`, "ok", "📄"));
      else if (st === "received") chips.push(chip(`${t}: received`, "neutral", "📄"));
      else if (st === "rejected") chips.push(chip(`${t}: rejected`, "bad", "⛔"));
      else chips.push(chip(`${t}: ${st}`, "neutral", "📄"));
    } else {
      chips.push(chip("Tax docs: check tab", "neutral", "📄"));
    }

    chips.push(chip("Address: (phase 2)", "neutral", "🏠"));
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
          <article class="user-card is-clickable" data-employee-id="${esc(getEmpId(r))}">
            <div class="uc-top">
              <div class="uc-identity">
                <div class="uc-name">${esc(name)}</div>
                <div class="uc-sub">
                  ${email ? `<span class="uc-email">${esc(email)}</span>` : `<span class="uc-email muted">—</span>`}
                  ${hourly != null ? `<span class="uc-dot">•</span><span class="uc-hourly">$${esc(hourly)}/hr</span>` : ""}
                </div>
              </div>

              <div class="uc-actions">
                <button class="btn ghost uc-manage" data-action="manage" type="button" aria-label="Manage user">
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

    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <div id="userDrawerBackdrop" class="drawer-backdrop hidden" aria-hidden="true"></div>

      <aside id="userDrawer" class="drawer hidden" role="dialog" aria-modal="true" aria-label="Manage user">
        <div class="drawer-head">
          <div class="drawer-title">
            <div class="ud-title">Manage User</div>
            <div class="ud-sub muted" id="udSub">—</div>
          </div>

          <button class="btn ghost ud-x" id="udCloseBtn" type="button" aria-label="Close">✕</button>
        </div>

        <div class="drawer-body">
          <div class="ud-chips" id="udChips"></div>

          <!-- Profile -->
          <section class="ud-section">
            <div class="ud-section-title">Profile</div>
            <div class="ud-grid">
              <label class="ud-field ud-span2">
                <span>Display Name</span>
                <input class="user-name" id="udName" type="text" autocomplete="off" />
              </label>

              <label class="ud-field ud-span2 ud-email">
                <span>Email</span>
                <input class="user-email" id="udEmail" type="text" readonly />
              </label>
            </div>
          </section>

          <!-- Employment -->
          <section class="ud-section">
            <div class="ud-section-title">Employment</div>
            <div class="ud-grid">
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
            </div>
          </section>

          <!-- Compliance (status only) -->
          <section class="ud-section">
            <div class="ud-section-title">Compliance</div>
            <div class="ud-hint muted">
              Tax docs and address management live in their dedicated tabs (status shown above).
            </div>
          </section>

          <div class="ud-spacer"></div>

          <!-- Sticky footer -->
          <div class="ud-footer">
            <div class="ud-footer-left">
              <button class="btn ghost" id="udResendBtn" type="button">Resend invite</button>
            </div>
            <div class="ud-footer-right">
              <button class="btn primary" id="udSaveBtn" type="button" disabled>Save changes</button>
            </div>
          </div>

          <div class="ud-msg muted" id="udMsg">—</div>
        </div>
      </aside>
    `;
    document.body.appendChild(wrap);

    const backdrop = qs("#userDrawerBackdrop");
    const drawer = qs("#userDrawer");

    const requestClose = () => {
      if (drawerDirty) {
        const ok = window.confirm("You have unsaved changes. Close anyway?");
        if (!ok) return;
      }
      closeUserDrawer();
    };

    backdrop?.addEventListener("click", requestClose);
    qs("#udCloseBtn")?.addEventListener("click", requestClose);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && drawer && !drawer.classList.contains("hidden")) requestClose();
    });

    // Dirty tracking
    const watch = () => setDirtyFromCurrent();
    qsa("#userDrawer input, #userDrawer select").forEach((el) => {
      el.addEventListener("input", watch);
      el.addEventListener("change", watch);
    });

    // Save
    qs("#udSaveBtn")?.addEventListener("click", async () => {
      const msg = qs("#udMsg");
      const saveBtn = qs("#udSaveBtn");
      if (!activeEmployeeId) return;

      const drawerEl = qs("#userDrawer");
      if (!drawerEl) return;

      if (typeof window.saveUserRow === "function") {
        msg.textContent = "Saving…";
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving…";

        try {
          await window.saveUserRow(drawerEl);
          msg.textContent = "Saved ✅";

          // refresh list
          if (typeof window.loadUsers === "function") await window.loadUsers();

          // reset dirty-state snapshot to current
          drawerSnapshot = readDrawerState();
          setDirty(false);
        } catch (err) {
          msg.textContent = `Save failed: ${err?.message || err}`;
          // re-enable if still dirty
          setDirtyFromCurrent();
        } finally {
          if (!drawerDirty) saveBtn.textContent = "Save changes";
          else {
            saveBtn.textContent = "Save changes";
            saveBtn.disabled = false;
          }
        }
        return;
      }

      msg.textContent = "Save handler missing in admin.js.";
    });

    // Resend invite
    qs("#udResendBtn")?.addEventListener("click", async () => {
      const msg = qs("#udMsg");
      const btn = qs("#udResendBtn");
      const email = qs("#udEmail")?.value || "";
      if (!email) return;

      if (typeof window.resendInvite === "function") {
        btn.disabled = true;
        msg.textContent = "Resending invite…";
        try {
          await window.resendInvite(email);
          msg.textContent = "Invite resent ✅";
        } catch (err) {
          msg.textContent = `Resend failed: ${err?.message || err}`;
        } finally {
          btn.disabled = false;
        }
        return;
      }

      msg.textContent = "Resend handler missing in admin.js.";
    });

    drawerReady = true;
  }

  function readDrawerState() {
    return {
      name: qs("#udName")?.value || "",
      role: qs("#udRole")?.value || "",
      type: qs("#udType")?.value || "",
      hourly: qs("#udHourly")?.value || "",
      active: !!qs("#udActive")?.checked,
    };
  }

  function setDirty(on) {
    drawerDirty = !!on;

    const msg = qs("#udMsg");
    const saveBtn = qs("#udSaveBtn");
    if (saveBtn) saveBtn.disabled = !drawerDirty;

    if (!drawerDirty) {
      if (msg && msg.textContent === "Unsaved changes…") msg.textContent = "—";
      return;
    }
    if (msg) msg.textContent = "Unsaved changes…";
  }

  function setDirtyFromCurrent() {
    if (!drawerSnapshot) {
      setDirty(false);
      return;
    }
    const cur = readDrawerState();
    const changed =
      cur.name !== drawerSnapshot.name ||
      cur.role !== drawerSnapshot.role ||
      cur.type !== drawerSnapshot.type ||
      cur.hourly !== drawerSnapshot.hourly ||
      cur.active !== drawerSnapshot.active;

    setDirty(changed);
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
    qs("#udEmail").value = row.email || "";

    qs("#udRole").value = row.role || "employee";
    qs("#udType").value = row.worker_type || row.type || "employee";
    qs("#udHourly").value = row.hourly_rate ?? row.hourly ?? "";
    qs("#udActive").checked = !!row.active;

    drawer.setAttribute("data-employee-id", activeEmployeeId);

    // snapshot + clean state
    drawerSnapshot = readDrawerState();
    setDirty(false);
    qs("#udMsg").textContent = "—";

    // Show
    backdrop.classList.remove("hidden");
    drawer.classList.remove("hidden");
    requestAnimationFrame(() => {
      backdrop.classList.add("show");
      drawer.classList.add("show");
    });

    // focus
    setTimeout(() => qs("#udName")?.focus?.(), 50);
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
    drawerSnapshot = null;
    drawerDirty = false;
  }

  // ---------- boot ----------
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initUsersCardsTab);
  } else {
    initUsersCardsTab();
  }
})();
