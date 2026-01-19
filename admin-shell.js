/* =========================================================
   OG Jewelry — Admin Shell (Mobile Nav + Sheets + Sync)
   NEW FILE: admin-shell.js
   - Bottom nav -> triggers existing top tabs via .click()
   - Filters sheet open/close + Apply mirrors to desktop inputs
   - More sheet open/close + routes to hidden tabs via .click()
   - Keeps bottom-nav active state synced with top tab selection
   ========================================================= */

(function () {
  "use strict";

  // ---------- tiny helpers ----------
  const qs = (idOrSel, root = document) => {
    if (!idOrSel) return null;
    // allow passing "#id" or "id" or ".class"
    if (idOrSel.startsWith("#") || idOrSel.startsWith(".") || idOrSel.includes(" ")) {
      return root.querySelector(idOrSel);
    }
    return root.getElementById(idOrSel);
  };

  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const isHidden = (el) => !el || el.classList.contains("hidden");

  const show = (el) => {
    if (!el) return;
    el.classList.remove("hidden");
    // allow CSS to animate if you use .open
    el.classList.add("open");
  };

  const hide = (el) => {
    if (!el) return;
    el.classList.remove("open");
    el.classList.add("hidden");
  };

  const lockScroll = (locked) => {
    document.documentElement.classList.toggle("no-scroll", !!locked);
    document.body.classList.toggle("no-scroll", !!locked);
  };

  const fireInput = (el) => {
    if (!el) return;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  // ---------- routing (bottom nav / sheets -> top tabs) ----------
  const TAB_TO_BTN_ID = {
    overview: "tabOverview",
    payroll: "tabPayroll",
    schedule: "tabSchedule",
    users: "tabUsers",
    stores: "tabStores",
    agreements: "tabAgreements",
    taxdocs: "tabTaxDocs",
  };

  function clickTopTab(key) {
    const btnId = TAB_TO_BTN_ID[key];
    const btn = btnId ? qs(btnId) : null;
    if (!btn) return false;
    btn.click(); // IMPORTANT: uses your existing admin.js wiring
    syncBottomNav(key);
    return true;
  }

  function syncBottomNav(activeKey) {
    const navBtns = qsa(".bottom-nav .bottom-nav-btn");
    if (!navBtns.length) return;

    navBtns.forEach((b) => {
      const k = b.getAttribute("data-tab") || "";
      b.classList.toggle("active", k === activeKey);
    });
  }

  // Also sync when user taps the desktop tabs (or JS activates tabs by clicking them)
  function wireTopTabSync() {
    const idToKey = Object.entries(TAB_TO_BTN_ID).reduce((acc, [k, id]) => {
      acc[id] = k;
      return acc;
    }, {});

    qsa(".tabs .tab").forEach((b) => {
      b.addEventListener("click", () => {
        const key = idToKey[b.id];
        if (!key) return;

        // Only bottom-nav keys show here; hidden tabs route through More sheet.
        if (["overview", "payroll", "schedule", "users"].includes(key)) {
          syncBottomNav(key);
        } else {
          // if user clicked Stores/Agreements/Tax Docs from desktop,
          // remove active highlight from bottom buttons (optional).
          syncBottomNav(""); 
        }
      });
    });
  }

  // ---------- sheets ----------
  function openSheet(sheetId, backdropId) {
    const sheet = qs(sheetId);
    const bd = qs(backdropId);
    if (!sheet || !bd) return;

    show(bd);
    show(sheet);
    bd.setAttribute("aria-hidden", "false");
    lockScroll(true);
  }

  function closeSheet(sheetId, backdropId) {
    const sheet = qs(sheetId);
    const bd = qs(backdropId);
    if (!sheet || !bd) return;

    hide(sheet);
    hide(bd);
    bd.setAttribute("aria-hidden", "true");
    lockScroll(false);
  }

  function closeAllSheets() {
    closeSheet("filtersSheet", "filtersBackdrop");
    closeSheet("moreSheet", "moreBackdrop");
  }

  function isAnySheetOpen() {
    return !isHidden(qs("filtersSheet")) || !isHidden(qs("moreSheet"));
  }

  // ---------- filters mirroring ----------
  function syncDesktopToSheet() {
    const month = qs("monthInput")?.value || "";
    const search = qs("searchInput")?.value || "";
    const m2 = qs("monthInputSheet");
    const s2 = qs("searchInputSheet");
    if (m2) m2.value = month;
    if (s2) s2.value = search;
  }

  function applySheetToDesktop() {
    const month = qs("monthInputSheet")?.value || "";
    const search = qs("searchInputSheet")?.value || "";

    const m1 = qs("monthInput");
    const s1 = qs("searchInput");
    if (m1 && month) m1.value = month;
    if (s1) s1.value = search;

    // keep quick search in sync too
    const sq = qs("searchQuick");
    if (sq) sq.value = search;

    fireInput(m1);
    fireInput(s1);
  }

  // ---------- wiring ----------
  function wireBottomNav() {
    qsa(".bottom-nav .bottom-nav-btn[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-tab");
        if (!key) return;
        clickTopTab(key);
      });
    });

    // More button
    qs("openMoreBtn")?.addEventListener("click", () => openSheet("moreSheet", "moreBackdrop"));
  }

  function wireMoreSheet() {
    const bd = qs("moreBackdrop");
    bd?.addEventListener("click", () => closeSheet("moreSheet", "moreBackdrop"));

    qs("closeMoreBtn")?.addEventListener("click", () => closeSheet("moreSheet", "moreBackdrop"));

    qsa("#moreSheet .sheet-link[data-tab]").forEach((b) => {
      b.addEventListener("click", () => {
        const key = b.getAttribute("data-tab");
        if (!key) return;
        closeSheet("moreSheet", "moreBackdrop");
        clickTopTab(key);
      });
    });
  }

  function wireFiltersSheet() {
    qs("openFiltersBtn")?.addEventListener("click", () => {
      syncDesktopToSheet();
      openSheet("filtersSheet", "filtersBackdrop");
    });

    qs("closeFiltersBtn")?.addEventListener("click", () => closeSheet("filtersSheet", "filtersBackdrop"));
    qs("filtersBackdrop")?.addEventListener("click", () => closeSheet("filtersSheet", "filtersBackdrop"));

    qs("applyFiltersBtn")?.addEventListener("click", () => {
      applySheetToDesktop();
      closeSheet("filtersSheet", "filtersBackdrop");
    });
  }

  function wireQuickSearch() {
    const sq = qs("searchQuick");
    if (!sq) return;

    sq.addEventListener("input", () => {
      const v = (sq.value || "").toString();
      const s1 = qs("searchInput");
      const s2 = qs("searchInputSheet");
      if (s1) s1.value = v;
      if (s2) s2.value = v;
      fireInput(s1);
    });
  }

  function wireEscClose() {
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (isAnySheetOpen()) closeAllSheets();
    });
  }

  function bootShell() {
    // If the admin app is hidden (guard not passed), still safe; listeners will just sit.
    wireBottomNav();
    wireMoreSheet();
    wireFiltersSheet();
    wireQuickSearch();
    wireTopTabSync();
    wireEscClose();

    // Initial bottom-nav active state
    // (Overview is default active in HTML, but this keeps it deterministic)
    syncBottomNav("overview");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootShell);
  } else {
    bootShell();
  }
})();
