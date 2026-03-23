/* =========================================================
   OG Jewelry — Admin Stores (Phase 1)
   NEW FILE: admin-stores.js  (ES module)
   - Store CRUD (store_locations)
   - Store cache helpers (storeNameById, directions)
   - Emergency exceptions modal (timeclock_store_exceptions)
   ========================================================= */

export function initStores(deps) {
  const {
    // DOM helpers
    qs,
    show,

    // UI helpers
    showToast,

    // Supabase (pass the client or a getter)
    getSupabase, // REQUIRED: () => supabaseClient

    // Shared utilities (from admin.js)
    activateTab,
    toISODate,
    storeOptionsHTML,
    applyDirectionsLinkFromStoreId,
  } = deps;

  /* =========================
     Store name cache (for Overview drawer + anywhere)
     ========================= */

  let _storeNameCache = null; // Map(store_id -> { id, name, lat, lng })
  let _storesInitialized = false;
  let _allStores = []; // cached list

  const STORE_DEFAULTS = {
    radius_m: 50,
    timezone: "America/New_York",
    schedule_enforce: false,
    schedule_grace_in_m: 5,
    schedule_grace_out_m: 5,
    paid_break_cap_min: 30,
    active: true,
  };

  function sb() {
    const client = getSupabase?.();
    if (!client) throw new Error("Supabase client not ready (getSupabase returned null).");
    return client;
  }

  function directionsUrl(lat, lng) {
    if (lat == null || lng == null) return "#";
    const q = `${Number(lat)},${Number(lng)}`;
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}`;
  }

  async function ensureStoreNameCache() {
    if (_storeNameCache) return;

    const { data, error } = await sb()
      .from("store_locations")
      .select("id,name,lat,lng")
      .order("name", { ascending: true });

    if (error) throw error;

    _storeNameCache = new Map();
    for (const s of data || []) {
      _storeNameCache.set(s.id, s);
    }
  }

  function storeNameById(storeId) {
    if (!storeId) return "";
    if (_storeNameCache?.has(storeId)) return _storeNameCache.get(storeId)?.name || "";
    const s = _allStores?.find?.((x) => x.id === storeId);
    return s?.name || "";
  }

  function storeDirectionsHref(storeId) {
    const s = _storeNameCache?.get(storeId) || _allStores?.find?.((x) => x.id === storeId);
    if (!s || s.lat == null || s.lng == null) return null;
    return directionsUrl(s.lat, s.lng);
  }

  /* =========================
     Store Modal (Add/Edit)
     ========================= */

  function setStoreError(msg) {
    const el = qs("storeError");
    if (!el) return;
    el.textContent = msg || "";
    show(el, !!msg);
  }

  function updateDirectionsPreview() {
    const lat = qs("storeLat")?.value;
    const lng = qs("storeLng")?.value;
    const link = qs("storeDirLink");
    const hint = qs("storeDirHint");
    if (!link || !hint) return;

    const ok = lat !== "" && lng !== "" && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
    if (!ok) {
      link.href = "#";
      link.setAttribute("aria-disabled", "true");
      link.style.pointerEvents = "none";
      link.style.opacity = "0.55";
      hint.textContent = "Enter lat/lng to enable Directions";
      return;
    }

    link.href = directionsUrl(lat, lng);
    link.removeAttribute("aria-disabled");
    link.style.pointerEvents = "";
    link.style.opacity = "";
    hint.textContent = `Directions to ${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
  }

  function openStoreModal(store = null) {
    setStoreError("");

    const s = {
      id: store?.id || "",
      name: store?.name ?? "",
      lat: store?.lat ?? "",
      lng: store?.lng ?? "",
      radius_m: store?.radius_m ?? STORE_DEFAULTS.radius_m,
      timezone: store?.timezone ?? STORE_DEFAULTS.timezone,
      schedule_enforce: store?.schedule_enforce ?? STORE_DEFAULTS.schedule_enforce,
      schedule_grace_in_m: store?.schedule_grace_in_m ?? STORE_DEFAULTS.schedule_grace_in_m,
      schedule_grace_out_m: store?.schedule_grace_out_m ?? STORE_DEFAULTS.schedule_grace_out_m,
      paid_break_cap_min: store?.paid_break_cap_min ?? STORE_DEFAULTS.paid_break_cap_min,
      active: store?.active ?? STORE_DEFAULTS.active,
    };

    qs("storeTitle").textContent = store?.id ? "Edit store" : "Add store";
    qs("storeId").value = s.id;
    qs("storeName").value = s.name;
    qs("storeLat").value = s.lat;
    qs("storeLng").value = s.lng;
    qs("storeRadius").value = s.radius_m;
    qs("storeTz").value = s.timezone;
    qs("storeGraceIn").value = s.schedule_grace_in_m;
    qs("storeGraceOut").value = s.schedule_grace_out_m;
    qs("storePaidBreakCap").value = s.paid_break_cap_min;
    qs("storeScheduleEnforce").checked = !!s.schedule_enforce;
    qs("storeActive").checked = !!s.active;

    updateDirectionsPreview();

    qs("storeModal").classList.add("open");
    qs("storeModal").classList.remove("hidden");
    qs("storeModalBackdrop").classList.add("show");
    qs("storeModalBackdrop").classList.remove("hidden");
  }

  function closeStoreModal() {
    qs("storeModal").classList.remove("open");
    qs("storeModalBackdrop").classList.remove("show");
    setTimeout(() => {
      qs("storeModal").classList.add("hidden");
      qs("storeModalBackdrop").classList.add("hidden");
    }, 180);
  }

  function readStoreForm() {
    const id = (qs("storeId").value || "").trim() || null;
    const name = (qs("storeName").value || "").trim();
    const lat = Number(qs("storeLat").value);
    const lng = Number(qs("storeLng").value);
    const radius_m = Number(qs("storeRadius").value);
    const timezone =
      (qs("storeTz").value || STORE_DEFAULTS.timezone).trim() || STORE_DEFAULTS.timezone;
    const schedule_enforce = !!qs("storeScheduleEnforce").checked;
    const schedule_grace_in_m = Number(qs("storeGraceIn").value || STORE_DEFAULTS.schedule_grace_in_m);
    const schedule_grace_out_m = Number(qs("storeGraceOut").value || STORE_DEFAULTS.schedule_grace_out_m);
    const paid_break_cap_min = Number(qs("storePaidBreakCap").value || STORE_DEFAULTS.paid_break_cap_min);
    const active = !!qs("storeActive").checked;

    if (!name) return { ok: false, msg: "Store name is required." };
    if (!Number.isFinite(lat) || !Number.isFinite(lng))
      return { ok: false, msg: "Latitude and longitude must be valid numbers." };
    if (!Number.isFinite(radius_m) || radius_m <= 0)
      return { ok: false, msg: "Radius must be a positive number." };
    if (!Number.isFinite(schedule_grace_in_m) || schedule_grace_in_m < 0)
      return { ok: false, msg: "Grace in must be 0 or more." };
    if (!Number.isFinite(schedule_grace_out_m) || schedule_grace_out_m < 0)
      return { ok: false, msg: "Grace out must be 0 or more." };
    if (!Number.isFinite(paid_break_cap_min) || paid_break_cap_min < 0)
      return { ok: false, msg: "Paid break cap must be 0 or more." };

    return {
      ok: true,
      data: {
        ...(id ? { id } : {}),
        name,
        lat,
        lng,
        radius_m,
        timezone,
        schedule_enforce,
        schedule_grace_in_m,
        schedule_grace_out_m,
        paid_break_cap_min,
        active,
      },
    };
  }

  async function upsertStore() {
    const parsed = readStoreForm();
    if (!parsed.ok) return setStoreError(parsed.msg);
    setStoreError("");

    const payload = parsed.data;

    try {
      let resp;
      if (payload.id) {
        resp = await sb().from("store_locations").update(payload).eq("id", payload.id).select().single();
      } else {
        resp = await sb().from("store_locations").insert(payload).select().single();
      }

      if (resp.error) throw resp.error;

      closeStoreModal();
      showToast?.("Store saved", "ok");
      await loadStores();
    } catch (err) {
      console.error(err);
      setStoreError(err?.message || "Failed to save store");
    }
  }

  function storeStatusPill(active) {
    return `<span class="pill ${active ? "work" : ""} store-pill">${active ? "Active" : "Inactive"}</span>`;
  }

  function renderStoresTable() {
    const tb = qs("storesTbody");
    if (!tb) return;

    const q = (qs("storeSearchInput")?.value || "").trim().toLowerCase();
    const showInactive = !!qs("storeShowInactive")?.checked;

    const rows = _allStores
      .filter((s) => (showInactive ? true : !!s.active))
      .filter((s) => (q ? (s.name || "").toLowerCase().includes(q) : true))
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

    tb.innerHTML = "";
    if (!rows.length) {
      tb.innerHTML = `<tr><td colspan="9" class="muted">No stores found.</td></tr>`;
      return;
    }

    for (const s of rows) {
      const lat = s.lat == null ? "—" : Number(s.lat).toFixed(5);
      const lng = s.lng == null ? "—" : Number(s.lng).toFixed(5);
      const dir = directionsUrl(s.lat, s.lng);

      const tr = document.createElement("tr");
      tr.dataset.storeId = s.id;
      tr.innerHTML = `
        <td><div style="font-weight:600;">${s.name || "—"}</div></td>
        <td>${storeStatusPill(!!s.active)}</td>
        <td><span class="coords">${lat}, ${lng}</span></td>
        <td>${s.radius_m ?? "—"}</td>
        <td>${s.timezone || "—"}</td>
        <td>${s.schedule_enforce ? "Yes" : "No"}</td>
        <td>${s.schedule_grace_in_m ?? "—"}/${s.schedule_grace_out_m ?? "—"}</td>
        <td>${s.paid_break_cap_min ?? "—"} min</td>
        <td>
          <div class="store-actions">
            <button class="btn small" data-store-edit="${s.id}">Edit</button>
            <a class="btn small ghost" href="${dir}" target="_blank" rel="noopener">Directions</a>
            <button class="btn small ghost" data-store-emerg="${s.id}">Emergency</button>
            <button class="btn small ghost" data-store-toggle="${s.id}">${s.active ? "Deactivate" : "Activate"}</button>
          </div>
        </td>
      `;
      tb.appendChild(tr);
    }
  }

  async function loadStores() {
    const tb = qs("storesTbody");
    if (tb) tb.innerHTML = `<tr><td colspan="9" class="muted">Loading…</td></tr>`;

    const { data, error } = await sb()
      .from("store_locations")
      .select("id,name,lat,lng,radius_m,timezone,schedule_enforce,schedule_grace_in_m,schedule_grace_out_m,paid_break_cap_min,active,created_at")
      .order("name", { ascending: true });

    if (error) throw error;

    _allStores = data || [];
    // refresh storeName cache too (nice side effect)
    _storeNameCache = null;
    await ensureStoreNameCache();

    renderStoresTable();
  }

  async function toggleStoreActive(storeId) {
    const s = _allStores.find((x) => x.id === storeId);
    if (!s) return;

    const next = !s.active;
    const verb = next ? "activate" : "deactivate";
    if (!confirm(`Are you sure you want to ${verb} “${s.name}”?`)) return;

    try {
      const { error } = await sb().from("store_locations").update({ active: next }).eq("id", storeId);
      if (error) throw error;
      showToast?.(`Store ${next ? "activated" : "deactivated"}`, "ok");
      await loadStores();
    } catch (err) {
      console.error(err);
      showToast?.(err?.message || "Failed to update store", "err");
    }
  }

  /* =========================
     Emergency Exceptions Modal
     ========================= */

  function setEmergError(msg) {
    const el = qs("emergError");
    if (!el) return;
    el.textContent = msg || "";
    show(el, !!msg);
  }

  function enumerateIsoDates(startIso, endIso) {
    const out = [];
    const start = new Date(startIso + "T00:00:00");
    const end = new Date(endIso + "T00:00:00");
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }

  function openEmergModal(storeId) {
    setEmergError("");

    const s = _allStores.find((x) => x.id === storeId);
    if (!s) return;

    qs("emergStoreId").value = s.id;
    qs("emergStoreName").textContent = s.name || "—";

    const today = toISODate(new Date());
    qs("emergStart").value = today;
    qs("emergEnd").value = today;

    const opt = storeOptionsHTML("");
    qs("emergInStore").innerHTML = opt;
    qs("emergOutStore").innerHTML = opt;

    qs("emergAnyIn").checked = false;
    qs("emergAnyOut").checked = false;

    qs("emergInStore").disabled = false;
    qs("emergOutStore").disabled = false;

    applyDirectionsLinkFromStoreId("", qs("emergInDir"));
    applyDirectionsLinkFromStoreId("", qs("emergOutDir"));

    qs("emergReason").value = "";

    qs("emergModal").classList.add("open");
    qs("emergModal").classList.remove("hidden");
    qs("emergModalBackdrop").classList.add("show");
    qs("emergModalBackdrop").classList.remove("hidden");
  }

  function closeEmergModal() {
    qs("emergModal").classList.remove("open");
    qs("emergModalBackdrop").classList.remove("show");
    setTimeout(() => {
      qs("emergModal").classList.add("hidden");
      qs("emergModalBackdrop").classList.add("hidden");
    }, 180);
  }

  async function saveEmergException() {
    setEmergError("");

    const storeId = (qs("emergStoreId").value || "").trim();
    const start = qs("emergStart").value;
    const end = qs("emergEnd").value;

    if (!storeId) return setEmergError("Missing store id.");
    if (!start || !end) return setEmergError("Start and end date are required.");
    if (end < start) return setEmergError("End date must be on/after start date.");

    const allowAnyIn = !!qs("emergAnyIn").checked;
    const allowAnyOut = !!qs("emergAnyOut").checked;

    const inStoreId = allowAnyIn ? null : qs("emergInStore").value || null;
    const outStoreId = allowAnyOut ? null : qs("emergOutStore").value || null;

    const note = (qs("emergReason").value || "").trim() || null;

    const rows = [];
    for (const d of enumerateIsoDates(start, end)) {
      rows.push({
        store_id: storeId,
        work_date: d,
        allow_clock_in_any_store: allowAnyIn,
        clock_in_store_id: inStoreId,
        allow_clock_out_any_store: allowAnyOut,
        clock_out_store_id: outStoreId,
        note,
      });
    }

    try {
      const { error } = await sb()
        .from("timeclock_store_exceptions")
        .upsert(rows, { onConflict: "store_id,work_date" });

      if (error) throw error;

      showToast?.("Emergency exception saved", "ok");
      closeEmergModal();
    } catch (e) {
      console.error(e);
      setEmergError(e?.message || "Failed to save emergency exception");
    }
  }

  async function clearEmergException() {
    setEmergError("");

    const storeId = (qs("emergStoreId").value || "").trim();
    const start = qs("emergStart").value;
    const end = qs("emergEnd").value;

    if (!storeId) return setEmergError("Missing store id.");
    if (!start || !end) return setEmergError("Start and end date are required.");
    if (end < start) return setEmergError("End date must be on/after start date.");

    try {
      const { error } = await sb()
        .from("timeclock_store_exceptions")
        .delete()
        .eq("store_id", storeId)
        .gte("work_date", start)
        .lte("work_date", end);

      if (error) throw error;

      showToast?.("Emergency exception cleared", "ok");
      closeEmergModal();
    } catch (e) {
      console.error(e);
      setEmergError(e?.message || "Failed to clear emergency exception");
    }
  }

  /* =========================
     Panel Init + Tab Wiring
     ========================= */

  async function initStoresPanel() {
    if (_storesInitialized) return;
    _storesInitialized = true;

    qs("storeSearchInput")?.addEventListener("input", () => renderStoresTable());
    qs("storeShowInactive")?.addEventListener("change", () => renderStoresTable());

    qs("storeAddBtn")?.addEventListener("click", () => openStoreModal(null));

    qs("storesTbody")?.addEventListener("click", (e) => {
      const edit = e.target.closest("[data-store-edit]");
      if (edit) {
        const id = edit.getAttribute("data-store-edit");
        const s = _allStores.find((x) => x.id === id);
        openStoreModal(s || null);
        return;
      }

      const tog = e.target.closest("[data-store-toggle]");
      if (tog) {
        toggleStoreActive(tog.getAttribute("data-store-toggle"));
        return;
      }

      const em = e.target.closest("[data-store-emerg]");
      if (em) {
        openEmergModal(em.getAttribute("data-store-emerg"));
        return;
      }
    });

    // Store modal close + save
    qs("storeCloseBtn")?.addEventListener("click", closeStoreModal);
    qs("storeCancelBtn")?.addEventListener("click", closeStoreModal);
    qs("storeModalBackdrop")?.addEventListener("click", closeStoreModal);
    qs("storeSaveBtn")?.addEventListener("click", upsertStore);

    // Emergency modal close + save
    qs("emergCloseBtn")?.addEventListener("click", closeEmergModal);
    qs("emergCancelBtn")?.addEventListener("click", closeEmergModal);
    qs("emergModalBackdrop")?.addEventListener("click", closeEmergModal);
    qs("emergSaveBtn")?.addEventListener("click", saveEmergException);

    // Optional: clear button if you have it in HTML
    qs("emergClearBtn")?.addEventListener("click", clearEmergException);

    // Emergency modal enable/disable + directions
    qs("emergAnyIn")?.addEventListener("change", () => {
      const any = !!qs("emergAnyIn").checked;
      qs("emergInStore").disabled = any;
      applyDirectionsLinkFromStoreId(any ? "" : qs("emergInStore").value, qs("emergInDir"));
    });

    qs("emergAnyOut")?.addEventListener("change", () => {
      const any = !!qs("emergAnyOut").checked;
      qs("emergOutStore").disabled = any;
      applyDirectionsLinkFromStoreId(any ? "" : qs("emergOutStore").value, qs("emergOutDir"));
    });

    qs("emergInStore")?.addEventListener("change", () => {
      applyDirectionsLinkFromStoreId(qs("emergInStore").value, qs("emergInDir"));
    });

    qs("emergOutStore")?.addEventListener("change", () => {
      applyDirectionsLinkFromStoreId(qs("emergOutStore").value, qs("emergOutDir"));
    });

    // Directions preview (store modal)
    ["storeLat", "storeLng"].forEach((id) => qs(id)?.addEventListener("input", updateDirectionsPreview));

    await loadStores();
  }

  function wireStoresTab() {
    qs("tabStores")?.addEventListener("click", async () => {
      activateTab("stores");
      try {
        await initStoresPanel();
      } catch (e) {
        console.error(e);
        showToast?.("Failed to load stores", "err");
      }
    });
  }

  // Optional convenience boot (if you want the module to wire itself)
  function bootStores() {
    wireStoresTab();
  }

  return {
    bootStores,
    wireStoresTab,
    initStoresPanel,
    ensureStoreNameCache,
    storeNameById,
    storeDirectionsHref,
  };
}
