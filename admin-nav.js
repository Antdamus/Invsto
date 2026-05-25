(function () {
  "use strict";

  const ADMIN_NAV_ITEMS = [
    { href: "admin.html", label: "Admin", mark: "A", className: "is-admin-home" },
    { href: "dashboard.html", label: "Dashboard", mark: "D" },
    { href: "locations.html", label: "Locations", mark: "L" },
    { href: "add-item.html", label: "Add Item", mark: "+" },
    { href: "add-inventory.html", label: "Add Inventory", mark: "I" },
    { href: "inventory-activity.html", label: "Daily Adds", mark: "DA" },
    { href: "stock.html", label: "Stock", mark: "S" },
    { href: "store-transfers.html", label: "Store Transfers", mark: "ST" },
    { href: "live-sales.html", label: "Live Sales", mark: "LS" },
    { href: "past-live-sales.html", label: "Past Live Sales", mark: "PL" },
    { href: "pending-orders.html", label: "Pending Orders", mark: "PO" },
    { href: "team-tasks.html", label: "Tasks", mark: "TS" },
    { href: "ebay-order-history.html", label: "Order History", mark: "OH" },
    { href: "ebay-returns.html", label: "Returns", mark: "R" },
    { href: "email-triage.html", label: "Email Triage", mark: "ET" },
    { href: "timeclock.html", label: "Timesheet", mark: "T" },
  ];

  const WORKER_NAV_ITEMS = [
    { href: "worker-dashboard.html", label: "My Dashboard", mark: "D" },
    { href: "timeclock.html", label: "Time Sheet", mark: "T" },
    { href: "add-item.html", label: "Add Item", mark: "+" },
    { href: "add-inventory.html", label: "Add Inventory", mark: "I" },
    { href: "stock.html", label: "Stock", mark: "S" },
    { href: "store-transfers.html", label: "Store Transfers", mark: "ST" },
    { href: "live-sales.html", label: "Live Sales", mark: "LS" },
    { href: "pending-orders.html", label: "Pending Orders", mark: "PO" },
    { href: "team-tasks.html", label: "Tasks", mark: "TS" },
    { href: "ebay-order-history.html", label: "Order History", mark: "OH" },
    { href: "ebay-returns.html", label: "Returns", mark: "R" },
    { href: "locations.html", label: "Locations", mark: "L" },
    { href: "dashboard.html", label: "Admin Dashboard", mark: "AD" },
  ];

  function getNavConfig(role) {
    return role === "admin"
      ? { bodyClass: "admin-role-nav", title: "OG Admin", items: ADMIN_NAV_ITEMS }
      : { bodyClass: "worker-role-nav", title: "OG Worker", items: WORKER_NAV_ITEMS };
  }

  function currentPageName() {
    return (window.location.pathname || "").split("/").pop() || "dashboard.html";
  }

  function ensureAdminNavStyles() {
    if (!document.querySelector('link[href$="admin-nav.css"]')) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "admin-nav.css";
      document.head.appendChild(link);
    }

  }

  function waitForSupabaseReady(timeoutMs = 8000) {
    return new Promise((resolve) => {
      if (window.supabase?.auth?.getSession) {
        resolve(window.supabase);
        return;
      }

      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, timeoutMs);

      document.addEventListener("supabase-ready", () => {
        if (settled) return;
        if (!window.supabase?.auth?.getSession) return;
        settled = true;
        window.clearTimeout(timeout);
        resolve(window.supabase || null);
      }, { once: true });
    });
  }

  async function getCurrentEmployee() {
    const client = await waitForSupabaseReady();
    if (!client?.auth) return null;

    const { data: sessionData } = await client.auth.getSession();
    const user = sessionData?.session?.user;
    if (!user?.id) return null;

    if (window.currentEmployee?.role) return window.currentEmployee;
    if (window.state?.employee?.role) return window.state.employee;

    const { data, error } = await client
      .from("employees")
      .select("id, user_id, display_name, role, active")
      .eq("user_id", user.id)
      .maybeSingle();

    if (error) {
      console.warn("Navigation role lookup failed:", error);
      return null;
    }

    return data || null;
  }

  function navLinkMarkup(item, activePage) {
    const active = item.href === activePage ? " active" : "";
    const className = item.className ? ` ${item.className}` : "";
    return `
      <a class="nav-link${className}${active}" href="${item.href}">
        <span class="admin-nav-icon" aria-hidden="true">${item.mark}</span>
        <span class="link-text">${item.label}</span>
      </a>
    `;
  }

  function mobileLinkMarkup(item, activePage) {
    const active = item.href === activePage ? " class=\"active\"" : "";
    return `<a href="${item.href}"${active}>${item.label}</a>`;
  }

  function ensureMobileShell(title = "OG") {
    let mobileHeader = document.querySelector(".mobile-header");
    if (!mobileHeader) {
      mobileHeader = document.createElement("div");
      mobileHeader.className = "mobile-header";
      mobileHeader.innerHTML = `
        <button class="menu-toggle" id="menu-toggle" aria-label="Open Menu">
          <i data-lucide="menu"></i>
        </button>
        <span class="mobile-title"></span>
      `;
      document.body.prepend(mobileHeader);
    }

    const mobileTitle = mobileHeader.querySelector(".mobile-title");
    if (mobileTitle) mobileTitle.textContent = title;
    const toggle = mobileHeader.querySelector("#menu-toggle");
    if (toggle) {
      toggle.type = "button";
      toggle.setAttribute("aria-controls", "mobile-menu");
      toggle.setAttribute("aria-expanded", "false");
    }

    let mobileMenu = document.getElementById("mobile-menu");
    if (!mobileMenu) {
      mobileMenu = document.createElement("div");
      mobileMenu.className = "mobile-menu";
      mobileMenu.id = "mobile-menu";
      mobileMenu.innerHTML = `<nav class="mobile-nav-links"></nav>`;
      mobileHeader.insertAdjacentElement("afterend", mobileMenu);
    } else if (!mobileMenu.querySelector(".mobile-nav-links")) {
      mobileMenu.innerHTML = `<nav class="mobile-nav-links"></nav>`;
    }
  }

  function ensureSidebar() {
    let sidebar = document.querySelector(".sidebar");
    const hadSidebar = Boolean(sidebar);
    if (!sidebar) {
      sidebar = document.createElement("aside");
      sidebar.className = "sidebar";
      sidebar.innerHTML = `<div class="sidebar-inner"></div>`;
      const page = document.querySelector(".page");
      if (page) page.prepend(sidebar);
      else document.body.prepend(sidebar);
    } else if (!sidebar.querySelector(".sidebar-inner")) {
      sidebar.innerHTML = `<div class="sidebar-inner"></div>`;
    }

    return hadSidebar;
  }

  function bindRoleNavEvents() {
    const logout = async (event) => {
      event.preventDefault();
      if (window.supabase?.auth) await window.supabase.auth.signOut();
      window.location.href = "index.html";
    };

    document.getElementById("logout")?.addEventListener("click", logout);
    document.getElementById("logout-mobile")?.addEventListener("click", logout);
  }

  function setMobileMenuOpen(open) {
    const menu = document.getElementById("mobile-menu");
    const toggle = document.getElementById("menu-toggle");
    if (!menu) return;
    menu.classList.toggle("show", open);
    menu.classList.toggle("is-open", open);
    if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function bindDelegatedMobileNavEvents() {
    if (window.__ogMobileNavBound) return;
    window.__ogMobileNavBound = true;

    document.addEventListener("click", (event) => {
      const toggle = event.target.closest?.("#menu-toggle");
      if (toggle) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const menu = document.getElementById("mobile-menu");
        setMobileMenuOpen(!menu?.classList.contains("show"));
        return;
      }

      const mobileLink = event.target.closest?.("#mobile-menu a");
      if (mobileLink) {
        setMobileMenuOpen(false);
        return;
      }

      const clickedMenu = event.target.closest?.("#mobile-menu");
      const clickedHeader = event.target.closest?.(".mobile-header");
      if (!clickedMenu && !clickedHeader) setMobileMenuOpen(false);
    }, true);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") setMobileMenuOpen(false);
    });
  }

  function renderRoleNavigation(role = "admin") {
    ensureAdminNavStyles();
    const config = getNavConfig(role);
    const activePage = currentPageName();
    ensureMobileShell(config.title);
    const hadSidebar = ensureSidebar();

    document.body.classList.add("admin-unified-nav");
    document.body.classList.toggle("admin-role-nav", role === "admin");
    document.body.classList.toggle("worker-role-nav", role !== "admin");
    document.body.classList.toggle("admin-nav-offset", !hadSidebar);

    const sidebarInner = document.querySelector(".sidebar .sidebar-inner");
    if (sidebarInner) {
      sidebarInner.innerHTML = `
        <div class="logo">OG</div>
        <nav class="nav-links">
          ${config.items.map((item) => navLinkMarkup(item, activePage)).join("")}
          <a class="nav-link" href="#" id="logout">
            <span class="admin-nav-icon" aria-hidden="true">Q</span>
            <span class="link-text">Logout</span>
          </a>
        </nav>
      `;
    }

    const mobileLinks = document.querySelector(".mobile-nav-links");
    if (mobileLinks) {
      mobileLinks.innerHTML = `
        ${config.items.map((item) => mobileLinkMarkup(item, activePage)).join("")}
        <a href="#" id="logout-mobile">Logout</a>
      `;
    }

    bindRoleNavEvents();
    bindDelegatedMobileNavEvents();
    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  function renderAdminNavigation() {
    renderRoleNavigation("admin");
  }

  function renderWorkerNavigation() {
    renderRoleNavigation("worker");
  }

  async function initRoleNavigation() {
    ensureAdminNavStyles();
    const employee = await getCurrentEmployee();
    const role = String(employee?.role || "").toLowerCase();
    if (employee?.active === false || !role) return;
    renderRoleNavigation(role === "admin" ? "admin" : "worker");
  }

  window.OGAdminNavigation = {
    render: renderAdminNavigation,
    items: ADMIN_NAV_ITEMS,
  };
  window.OGWorkerNavigation = {
    render: renderWorkerNavigation,
    items: WORKER_NAV_ITEMS,
  };
  window.OGRoleNavigation = {
    render: renderRoleNavigation,
    adminItems: ADMIN_NAV_ITEMS,
    workerItems: WORKER_NAV_ITEMS,
  };

  document.addEventListener("DOMContentLoaded", () => {
    bindDelegatedMobileNavEvents();
    initRoleNavigation();
  });
})();
