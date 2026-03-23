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
    let lastAddrMap = new Map(); // employee_id -> true (has current address)
    let addrStatusLoaded = false;
let usersCardsInited = false;
  let drawerReady = false;
  let activeEmployeeId = null;

  // dirty-state
  let drawerSnapshot = null; // {name, role, type, hourly, active}
  let drawerDirty = false;

  let activeUserId = null; // auth.users.id


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

    // ---------- address status (Phase 2 chip) ----------
    let addrFetchTimer = null;
    let lastAddrKey = "";

    // ---------- tax doc status (W-9 for contractors, W-4 for employees) ----------
let lastTaxMap = new Map(); // employee_id -> { w9: "verified|received|rejected|...", w4: "..." }
let taxStatusLoaded = false;
let taxFetchTimer = null;
let lastTaxKey = "";

async function refreshTaxStatus(rows) {
  const supabase = window.supabase;
  if (!supabase) return;

  const ids = (Array.isArray(rows) ? rows : [])
    .map((r) => getEmpId(r))
    .filter(Boolean);

  const uniq = Array.from(new Set(ids)).slice(0, 500);
  if (!uniq.length) {
    lastTaxMap = new Map();
    taxStatusLoaded = true;
    return;
  }

  const { data, error } = await supabase
    .from("employee_tax_docs")
    .select("employee_id, doc_type, status, is_active")
    .in("employee_id", uniq)
    .eq("is_active", true);

  if (error) {
    console.error("Tax status load failed", error);
    return;
  }

  const m = new Map();
  (data || []).forEach((r) => {
    const eid = String(r.employee_id || "");
    const dt = String(r.doc_type || "").toLowerCase(); // "w9" | "w4"
    const st = String(r.status || "").toLowerCase();
    if (!eid || !dt) return;
    if (!m.has(eid)) m.set(eid, {});
    m.get(eid)[dt] = st;
  });

  lastTaxMap = m;
  taxStatusLoaded = true;
}

function scheduleTaxStatusRefresh(rows) {
  if (taxFetchTimer) clearTimeout(taxFetchTimer);
  taxFetchTimer = setTimeout(async () => {
    await refreshTaxStatus(rows);
    renderUsersCards(lastRows, lastDocMap, true); // reuse your existing render (skip addr refresh)
  }, 180);
}


    async function refreshAddressStatus(rows) {
    // Lightweight: one query for current address existence for the visible employee ids.
    // No history data pulled.
    const supabase = window.supabase;
    if (!supabase) return;

    const ids = (Array.isArray(rows) ? rows : [])
        .map((r) => getEmpId(r))
        .filter((id) => !!id);

    // De-dupe + keep query size sane
    const uniq = Array.from(new Set(ids)).slice(0, 500);
    if (!uniq.length) {
        lastAddrMap = new Map();
        addrStatusLoaded = true;
        return;
    }

    const { data, error } = await supabase
        .from("employee_legal_addresses")
        .select("employee_id")
        .in("employee_id", uniq)
        .eq("is_current", true);

    if (error) {
        console.error("Address status load failed", error);
        return;
    }

    const m = new Map();
    (data || []).forEach((r) => {
        const eid = String(r.employee_id || "");
        if (eid) m.set(eid, true);
    });

    lastAddrMap = m;
    addrStatusLoaded = true;
    }

    function scheduleAddressStatusRefresh(rows) {
    // debounce so typing in search / toggling doesn't spam queries
    if (addrFetchTimer) clearTimeout(addrFetchTimer);
    addrFetchTimer = setTimeout(async () => {
        await refreshAddressStatus(rows);
        // Re-render chips with updated info
        renderUsersCards(lastRows, lastDocMap, true);
    }, 180);
    }

async function saveUserPhone({ userId, phone, canSms }) {
  const { error } = await supabase.rpc("admin_upsert_user_phone", {
    _user_id: userId,
    _phone_e164: phone,
    _can_sms: canSms
  });

  if (error) {
    console.error("Phone save failed", error);
    alert(error.message);
    return false;
  }

  return true;
}

  // ---------- init ----------
function initUsersCardsTab() {
  if (usersCardsInited) return;
  usersCardsInited = true;

  const cards = qs("#usersCards");
  if (!cards) return;

  const search = qs("#userSearchInput");
  const showInactive = qs("#userShowInactive");

  if (search) search.addEventListener("input", () => renderUsersCards(lastRows, lastDocMap));
  if (showInactive) showInactive.addEventListener("change", () => renderUsersCards(lastRows, lastDocMap));

  cards.addEventListener("pointerdown", (e) => {
    const card = e.target.closest(".user-card");
    if (!card) return;
    card.classList.add("uc-pressed");
  });
  window.addEventListener("pointerup", () => {
    qsa(".user-card.uc-pressed").forEach((c) => c.classList.remove("uc-pressed"));
  });

  cards.addEventListener("click", (e) => {
    const card = e.target.closest(".user-card");
    if (!card) return;

    const employeeId = card.getAttribute("data-employee-id") || "";
    if (!employeeId) return;

    const interactive = e.target.closest("button, a, input, select, textarea, label");
    const btn = e.target.closest("[data-action]");

    if (btn) {
      const action = btn.getAttribute("data-action");
      if (action === "manage") {
        const row = lastRows.find((r) => getEmpId(r) === String(employeeId));
        if (!row) return;
        openUserDrawer(row);
      }
      return;
    }

    if (!interactive) {
      const row = lastRows.find((r) => getEmpId(r) === String(employeeId));
      if (!row) return;
      openUserDrawer(row);
    }
  });

  // ✅ KEEP these exports (your admin shell expects them)
  window.renderUsers = (rows, docMap) => {
    lastRows = Array.isArray(rows) ? rows : [];
    lastDocMap = normalizeDocMap(docMap);
    renderUsersCards(lastRows, lastDocMap);
  };

  window.initUsersCardsTab = initUsersCardsTab;
}


  // ---------- chip UI ----------
  function chip(label, kind = "neutral", icon = "") {
    return `<span class="uc-chip uc-${kind}">${icon ? `<span class="uc-ic">${icon}</span>` : ""}${esc(label)}</span>`;
  }

  function statusChips(row) {
    const chips = [];

    const accepted = !!row.accepted_at || row.accepted === true || row.status === "accepted" || row.invite_status === "accepted";
    chips.push(accepted ? chip("Accepted", "ok", "✅") : chip("Invited", "warn", "✉️"));

    const workerType = (row.worker_type || row.type || "employee").toLowerCase();
const docNeed = workerType === "contractor" ? "w9" : "w4";
const label = workerType === "contractor" ? "W-9" : "W-4";

if (!taxStatusLoaded) {
  chips.push(chip(`${label}: …`, "neutral", "📄"));
} else {
  const st = (lastTaxMap.get(getEmpId(row)) || {})[docNeed];
  if (!st) {
    chips.push(chip(`${label}: missing`, "warn", "📄"));
  } else if (st === "verified") {
    chips.push(chip(`${label}: verified`, "ok", "📄"));
  } else if (st === "rejected") {
    chips.push(chip(`${label}: rejected`, "bad", "⛔"));
  } else {
    chips.push(chip(`${label}: ${st}`, "neutral", "📄"));
  }
}


    const role = row.role || "—";
    chips.push(chip(`Role: ${role}`, "accent", "🧑‍💼"));


    const hasAddr = lastAddrMap.get(getEmpId(row)) === true;
    if (addrStatusLoaded) {
    chips.push(hasAddr ? chip("Address: on file", "ok", "🏠") : chip("Address: missing", "warn", "🏠"));
    } else {
    chips.push(chip("Address: …", "neutral", "🏠"));
    }

    chips.push(row.active ? chip("Active", "ok", "🟢") : chip("Inactive", "bad", "⚪"));

    return chips.join("");
  }

  // ---------- cards renderer ----------
  function renderUsersCards(rows, docMap, skipAddrRefresh = false) {
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

    // Address status chip refresh (debounced + only when needed)
    if (!skipAddrRefresh) {
    const key = filtered.map((r) => getEmpId(r)).filter(Boolean).sort().join("|");
    if (key !== lastAddrKey) {
        lastAddrKey = key;
        addrStatusLoaded = false;
        scheduleAddressStatusRefresh(filtered);
    }
    }

    // Tax status refresh (debounced + only when needed)
    const taxKey = filtered.map((r) => getEmpId(r)).filter(Boolean).sort().join("|");
    if (taxKey !== lastTaxKey) {
    lastTaxKey = taxKey;
    taxStatusLoaded = false;
    scheduleTaxStatusRefresh(filtered);
    }


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

<!-- Contact -->
<section class="ud-section">
  <div class="ud-section-title">Contact</div>

  <div class="ud-grid">
    <label class="ud-field ud-span2">
      <span>Phone (E.164)</span>
      <input
        id="udPhone"
        type="tel"
        placeholder="+13055551234"
        autocomplete="off"
      />
    </label>

    <label class="ud-field ud-active">
      <span>Allow SMS</span>
      <div class="ud-switch">
        <input id="udCanSms" type="checkbox" />
        <span class="muted">Yes</span>
      </div>
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
<!-- Watchlist (who this user watches) -->
<section class="ud-section" id="udWatchSection">
  <div class="ud-section-title">Watchlist</div>
  <div class="ud-hint muted">Assign who this person will receive exception alerts for (active employees only).</div>

  <div class="ud-watch-add">
    <div class="ud-watch-search">
      <input id="udWatchSearch" type="text" autocomplete="off" placeholder="Search active employees…" />
      <div id="udWatchSug" class="ud-watch-sug hidden" aria-label="Suggestions"></div>
    </div>
    <button id="udWatchAddBtn" class="btn" type="button" disabled>Add</button>
  </div>

  <div id="udWatchList" class="ud-watch-list">
    <div class="muted">—</div>
  </div>

  <div id="udWatchMsg" class="ud-watch-msg muted">—</div>
</section>


          <!-- Address (Phase 2: history) -->
<section class="ud-section">
  <div class="ud-section-title">Legal Address</div>

  <div class="ud-hint muted" style="margin-bottom:10px;">
    Updates create a new history record. We never overwrite past addresses.
  </div>

  <!-- Current -->
  <div class="ud-address-current" id="udAddrCurrent">
    <div class="muted">Loading current address…</div>
  </div>

  <!-- Add new -->
  <div class="ud-address-form" style="margin-top:12px;">
    <div class="ud-subtitle" style="margin:6px 0 8px;">Add new address</div>

    <div class="ud-grid">
      <label class="ud-field ud-span2">
        <span>Line 1</span>
        <input id="udAddrLine1" type="text" autocomplete="off" placeholder="123 Main St" />
      </label>

      <label class="ud-field ud-span2">
        <span>Line 2 (optional)</span>
        <input id="udAddrLine2" type="text" autocomplete="off" placeholder="Apt, suite, unit" />
      </label>

      <label class="ud-field">
        <span>City</span>
        <input id="udAddrCity" type="text" autocomplete="off" />
      </label>

      <label class="ud-field">
        <span>State</span>
        <input id="udAddrState" type="text" autocomplete="off" placeholder="FL" />
      </label>

      <label class="ud-field">
        <span>ZIP</span>
        <input id="udAddrZip" type="text" autocomplete="off" placeholder="33101" />
      </label>

      <label class="ud-field">
        <span>Country</span>
        <input id="udAddrCountry" type="text" autocomplete="off" value="US" />
      </label>
    </div>

    <div style="display:flex; gap:10px; margin-top:10px;">
      <button id="udAddrAddBtn" class="btn" type="button">Add address</button>
      <div id="udAddrMsg" class="muted" style="align-self:center;">—</div>
    </div>
  </div>

  <!-- History -->
  <div style="margin-top:14px;">
    <div class="ud-subtitle" style="margin:6px 0 8px;">Address history</div>
    <div class="table-wrapper">
      <table class="table" aria-label="Address history">
        <thead>
          <tr>
            <th style="width:110px;">Current</th>
            <th>Address</th>
            <th style="width:220px;">Created</th>
          </tr>
        </thead>
        <tbody id="udAddrHistory">
          <tr><td colspan="3" class="muted">Loading…</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</section>


          <div class="ud-spacer"></div>

          <!-- Sticky footer -->
          <div class="ud-footer">
            <div class="ud-footer-left">
              <button class="btn ghost" id="udResendBtn" type="button">Resend invite</button>
            </div>
            <div class="ud-footer-right">
              <button class="btn primary" id="udSaveBtn" type="button" disabled>Save profile changes</button>
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

    // Address form button enable/disable
    const updateAddrAddBtn = () => {
    const line1 = (qs("#udAddrLine1")?.value || "").trim();
    const city  = (qs("#udAddrCity")?.value || "").trim();
    const state = (qs("#udAddrState")?.value || "").trim();
    const zip   = (qs("#udAddrZip")?.value || "").trim();

    const ok = !!(line1 && city && state && zip);
    const btn = qs("#udAddrAddBtn");
    if (btn) btn.disabled = !ok;
    };

    // run once on drawer creation
    updateAddrAddBtn();

    // listen to address inputs only
    ["#udAddrLine1","#udAddrCity","#udAddrState","#udAddrZip","#udAddrLine2","#udAddrCountry"].forEach(sel => {
    qs(sel)?.addEventListener("input", updateAddrAddBtn);
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
          
if (activeUserId) {
  await saveUserPhone({
    userId: activeUserId,
    phone: (qs("#udPhone")?.value || "").trim(),
    canSms: !!qs("#udCanSms")?.checked
  });
}


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

    qs("#udAddrAddBtn")?.addEventListener("click", async () => {
        if (!activeEmployeeId) return;
        await addAddressForEmployee(activeEmployeeId);
    });

    setupWatchlistUI();
    drawerReady = true;
  }

function readDrawerState() {
  return {
    name: qs("#udName")?.value || "",
    role: qs("#udRole")?.value || "",
    type: qs("#udType")?.value || "",
    hourly: qs("#udHourly")?.value || "",
    active: !!qs("#udActive")?.checked,
    phone: qs("#udPhone")?.value || "",
    canSms: !!qs("#udCanSms")?.checked
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
    cur.active !== drawerSnapshot.active ||
    cur.phone !== drawerSnapshot.phone ||
    cur.canSms !== drawerSnapshot.canSms;

  setDirty(changed);
}

// =========================================================
// Watchlist (employee_watchers): A watches B
// - active-only picker for watched employees
// - stored in public.employee_watchers
// =========================================================

let watchCache = new Map(); // watcher_employee_id -> [watched_employee_id]

function setWatchMsg(text) {
  const el = qs("#udWatchMsg");
  if (el) el.textContent = text || "—";
}

function activeEmployeesForPicker(excludeEmployeeId) {
  const exclude = String(excludeEmployeeId || "");
  return (Array.isArray(lastRows) ? lastRows : [])
    .filter((r) => !!r && !!getEmpId(r) && r.active === true)
    .map((r) => ({
      id: getEmpId(r),
      name: r.display_name || r.name || r.email || getEmpId(r),
    }))
    .filter((x) => x.id !== exclude)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function hideWatchSuggestions() {
  const sug = qs("#udWatchSug");
  if (sug) sug.classList.add("hidden");
}

function showWatchSuggestions(items) {
  const sug = qs("#udWatchSug");
  if (!sug) return;

  if (!items || !items.length) {
    sug.innerHTML = "";
    sug.classList.add("hidden");
    return;
  }

  sug.innerHTML = items.slice(0, 8).map((it) => `
    <button type="button" class="ud-watch-sug-item" data-emp="${esc(it.id)}">
      <span class="ud-watch-sug-name">${esc(it.name)}</span>
    </button>
  `).join("");

  sug.classList.remove("hidden");
}

function clearWatchPicker() {
  const input = qs("#udWatchSearch");
  const addBtn = qs("#udWatchAddBtn");
  if (input) {
    input.value = "";
    input.dataset.targetId = "";
  }
  if (addBtn) addBtn.disabled = true;
  hideWatchSuggestions();
}

function renderWatchList(watcherEmployeeId, watchedIds) {
  const list = qs("#udWatchList");
  if (!list) return;

  const map = new Map(
    (Array.isArray(lastRows) ? lastRows : [])
      .filter((r) => !!r && !!getEmpId(r))
      .map((r) => [getEmpId(r), r])
  );

  const rows = (watchedIds || [])
    .map((id) => {
      const r = map.get(String(id));
      return {
        id: String(id),
        name: (r && (r.display_name || r.name || r.email)) || String(id),
        active: r ? r.active === true : true
      };
    })
    .filter((x) => x.active) // ✅ active-only targets shown
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!rows.length) {
    list.innerHTML = `<div class="muted">No watch targets yet.</div>`;
    return;
  }

  list.innerHTML = rows.map((x) => `
    <div class="ud-watch-row" data-emp="${esc(x.id)}">
      <div class="ud-watch-left">
        <div class="ud-watch-name">${esc(x.name)}</div>
        <div class="ud-watch-sub muted">${esc(x.id)}</div>
      </div>
      <div class="ud-watch-actions">
        <button type="button" class="btn ghost ud-watch-remove" data-action="watch-remove" data-emp="${esc(x.id)}">
          Remove
        </button>
      </div>
    </div>
  `).join("");
}

async function loadWatchTargets(watcherEmployeeId) {
  const supabase = window.supabase;
  if (!supabase || !watcherEmployeeId) return;

  setWatchMsg("Loading…");

  const { data, error } = await supabase
    .from("employee_watchers")
    .select("watched_employee_id, active")
    .eq("watcher_employee_id", watcherEmployeeId)
    .eq("active", true);

  if (error) {
    console.error("Failed to load watch targets", error);
    setWatchMsg("Failed to load watchlist.");
    return;
  }

  const ids = (data || [])
    .map((r) => String(r.watched_employee_id || ""))
    .filter(Boolean);

  watchCache.set(String(watcherEmployeeId), ids);
  renderWatchList(watcherEmployeeId, ids);

  setWatchMsg("—");
}

async function addWatchTarget(watcherEmployeeId, watchedEmployeeId) {
  const supabase = window.supabase;
  if (!supabase || !watcherEmployeeId || !watchedEmployeeId) return;

  const cached = watchCache.get(String(watcherEmployeeId)) || [];
  if (cached.includes(String(watchedEmployeeId))) {
    setWatchMsg("Already watching that employee.");
    return;
  }

  // ✅ enforce active-only at runtime too
  const ok = activeEmployeesForPicker(watcherEmployeeId).some((x) => x.id === watchedEmployeeId);
  if (!ok) {
    setWatchMsg("Only active employees can be watched.");
    return;
  }

  setWatchMsg("Adding…");

  const { error } = await supabase
    .from("employee_watchers")
    .upsert(
      {
        watcher_employee_id: watcherEmployeeId,
        watched_employee_id: watchedEmployeeId,
        active: true
      },
      { onConflict: "watcher_employee_id,watched_employee_id" }
    );

  if (error) {
    console.error("Failed to add watch target", error);
    setWatchMsg(error.message || "Failed to add.");
    return;
  }

  await loadWatchTargets(watcherEmployeeId);
  setWatchMsg("Added ✅");
  setTimeout(() => setWatchMsg("—"), 900);
}

async function removeWatchTarget(watcherEmployeeId, watchedEmployeeId) {
  const supabase = window.supabase;
  if (!supabase || !watcherEmployeeId || !watchedEmployeeId) return;

  setWatchMsg("Removing…");

  const { error } = await supabase
    .from("employee_watchers")
    .delete()
    .eq("watcher_employee_id", watcherEmployeeId)
    .eq("watched_employee_id", watchedEmployeeId);

  if (error) {
    console.error("Failed to remove watch target", error);
    setWatchMsg(error.message || "Failed to remove.");
    return;
  }

  await loadWatchTargets(watcherEmployeeId);
  setWatchMsg("Removed ✅");
  setTimeout(() => setWatchMsg("—"), 900);
}

function setupWatchlistUI() {
  const input = qs("#udWatchSearch");
  const sug = qs("#udWatchSug");
  const addBtn = qs("#udWatchAddBtn");
  const list = qs("#udWatchList");
  if (!input || !sug || !addBtn || !list) return;

  const refreshSug = () => {
    const watcherId = activeEmployeeId;
    if (!watcherId) return;

    const all = activeEmployeesForPicker(watcherId);
    const q = (input.value || "").trim().toLowerCase();

    if (!q) {
      input.dataset.targetId = "";
      addBtn.disabled = true;
      showWatchSuggestions([]);
      return;
    }

    const matches = all.filter((x) => x.name.toLowerCase().includes(q)).slice(0, 8);
    showWatchSuggestions(matches);

    // only enable Add if we selected a suggestion (explicit)
    input.dataset.targetId = "";
    addBtn.disabled = true;
  };

  input.addEventListener("input", refreshSug);
  input.addEventListener("focus", refreshSug);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideWatchSuggestions();
  });

  // click suggestion
  sug.addEventListener("click", (e) => {
    const btn = e.target.closest(".ud-watch-sug-item");
    if (!btn) return;
    const emp = btn.getAttribute("data-emp") || "";
    if (!emp) return;

    const map = new Map(activeEmployeesForPicker(activeEmployeeId).map((x) => [x.id, x.name]));
    input.value = map.get(emp) || input.value;
    input.dataset.targetId = emp;
    addBtn.disabled = false;
    hideWatchSuggestions();
  });

  // Add target
  addBtn.addEventListener("click", async () => {
    const watcherId = activeEmployeeId;
    const targetId = input.dataset.targetId || "";
    if (!watcherId || !targetId) return;

    await addWatchTarget(watcherId, targetId);
    clearWatchPicker();
  });

  // remove target
  list.addEventListener("click", async (e) => {
    const btn = e.target.closest('[data-action="watch-remove"]');
    if (!btn) return;

    const watcherId = activeEmployeeId;
    const targetId = btn.getAttribute("data-emp") || "";
    if (!watcherId || !targetId) return;

    if (!window.confirm("Remove this watch assignment?")) return;
    await removeWatchTarget(watcherId, targetId);
  });

  // click outside closes suggestions
  document.addEventListener("click", (e) => {
    if (e.target.closest("#udWatchSug")) return;
    if (e.target.closest("#udWatchSearch")) return;
    hideWatchSuggestions();
  });
}

  // ---------- Phase 2: Addresses ----------
function fmtTs(ts){
  if (!ts) return "—";
  try {
    const d = new Date(ts);
    return Number.isNaN(+d) ? String(ts) : d.toLocaleString();
  } catch {
    return String(ts);
  }
}

function addressToOneLine(a){
  const parts = [
    a.line1,
    a.line2,
    `${a.city || ""}${a.city && a.state ? ", " : ""}${a.state || ""} ${a.postal_code || ""}`.trim(),
    a.country || "US"
  ].filter(Boolean);
  return parts.join(" • ");
}

async function loadAddressesForEmployee(employeeId){
  const supabase = window.supabase;
  if (!supabase) throw new Error("supabase missing on window");
  if (!employeeId) return [];

  const { data, error } = await supabase
    .from("employee_legal_addresses")
    .select("id, employee_id, line1, line2, city, state, postal_code, country, is_current, created_at")
    .eq("employee_id", employeeId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return data || [];
}

function renderAddressUI(rows){
  const curBox = qs("#udAddrCurrent");
  const histBody = qs("#udAddrHistory");
  if (!curBox || !histBody) return;

  const current = (rows || []).find(r => r.is_current) || null;

  if (!current){
    curBox.innerHTML = `<div class="muted">No address on file.</div>`;
  } else {
    curBox.innerHTML = `
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:12px;">
        <div>
          <div style="font-weight:700;">Current</div>
          <div class="muted" style="margin-top:4px;">${esc(addressToOneLine(current))}</div>
        </div>
        <div class="muted" style="white-space:nowrap;">${esc(fmtTs(current.created_at))}</div>
      </div>
    `;
  }

  if (!rows || !rows.length){
    histBody.innerHTML = `<tr><td colspan="3" class="muted">No address history.</td></tr>`;
    return;
  }

  histBody.innerHTML = rows.map(r => `
    <tr>
      <td>${r.is_current ? `<span class="uc-chip uc-ok">✅ current</span>` : `<span class="muted">—</span>`}</td>
      <td>${esc(addressToOneLine(r))}</td>
      <td>${esc(fmtTs(r.created_at))}</td>
    </tr>
  `).join("");
}

async function refreshAddresses(employeeId){
  const msg = qs("#udAddrMsg");
  if (msg) msg.textContent = "Loading…";
  try{
    const rows = await loadAddressesForEmployee(employeeId);
    renderAddressUI(rows);
    if (msg) msg.textContent = "—";
  }catch(err){
    console.error(err);
    if (msg) msg.textContent = `Failed: ${err?.message || err}`;
    // keep prior UI if any
  }
}

async function addAddressForEmployee(employeeId){
  const supabase = window.supabase;
  if (!supabase) throw new Error("supabase missing on window");
  if (!employeeId) throw new Error("No employee selected");

  const msg = qs("#udAddrMsg");
  const btn = qs("#udAddrAddBtn");

  const line1 = (qs("#udAddrLine1")?.value || "").trim();
  const line2 = (qs("#udAddrLine2")?.value || "").trim();
  const city  = (qs("#udAddrCity")?.value || "").trim();
  const state = (qs("#udAddrState")?.value || "").trim();
  const zip   = (qs("#udAddrZip")?.value || "").trim();
  const country = (qs("#udAddrCountry")?.value || "US").trim() || "US";

  if (!line1 || !city || !state || !zip){
    if (msg) msg.textContent = "Please fill Line 1, City, State, ZIP.";
    return;
  }

  btn && (btn.disabled = true);
  if (msg) msg.textContent = "Saving…";

  try{
    // Insert as current. Trigger + unique index will flip prior currents off.
    const { error } = await supabase
      .from("employee_legal_addresses")
      .insert([{
        employee_id: employeeId,
        line1,
        line2: line2 || null,
        city,
        state,
        postal_code: zip,
        country,
        is_current: true
      }]);

    if (error) throw error;

    // clear inputs
    ["udAddrLine1","udAddrLine2","udAddrCity","udAddrState","udAddrZip"].forEach(id => {
      const el = qs("#" + id);
      if (el) el.value = "";
    });

    if (msg) msg.textContent = "Saved ✅";
    await refreshAddresses(employeeId);
    setTimeout(() => { if (msg) msg.textContent = "—"; }, 1200);
  }catch(err){
    console.error(err);
    if (msg) msg.textContent = `Save failed: ${err?.message || err}`;
  }finally{
    btn && (btn.disabled = false);
  }
}

async function loadUserPhone(userId) {
  const supabase = window.supabase;
  if (!supabase || !userId) return { phone: "", canSms: true };

  const { data, error } = await supabase
    .from("user_phones")
    .select("phone_e164, can_sms")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("Failed to load user phone", error);
    return { phone: "", canSms: true };
  }

  return {
    phone: data?.phone_e164 || "",
    canSms: data?.can_sms !== false
  };
}



async function openUserDrawer(row) {
    if (!row) return;
    ensureDrawer();

  activeEmployeeId = getEmpId(row);         // employees.id
activeUserId = String(row.user_id || ""); // auth.users.id

const phoneState = await loadUserPhone(activeUserId);


    qs("#udPhone").value = phoneState.phone;
    qs("#udCanSms").checked = phoneState.canSms;


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
    // Phase 2: address section
refreshAddresses(activeEmployeeId);

clearWatchPicker();
loadWatchTargets(activeEmployeeId);

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
    activeUserId = null;

  }

  if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initUsersCardsTab);
} else {
  initUsersCardsTab();
}

})();
