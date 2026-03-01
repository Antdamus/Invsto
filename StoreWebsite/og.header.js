/* =========================================================
   og.header.js — Shared OG Jewelers header (EXACT item header)
   + Cart icon opens cart drawer (fallback navigates to cart)
   ========================================================= */

(function () {
  const mount = document.getElementById("ogHeaderMount");
  if (!mount) return;

  const isStoreCart = /\/StoreCart\/?/i.test(window.location.pathname);
  const base = isStoreCart ? ".." : ".";

  // Match item.html intent (path-adjusted for StoreCart)
  const hrefIndex   = `${base}/index.html`;
  const hrefShop    = `${base}/catalogue.html`;
  const hrefVault   = `${base}/favorites.html`;
  const hrefJoin    = `${base}/join.html`;
  const hrefProfile = `${base}/profile.html`;
  const hrefCart    = isStoreCart ? `./cart.html` : `./StoreCart/cart.html`;

  const isCartPage = /\/cart\.html$/i.test(window.location.pathname);

  // ✅ Key fix:
  // - On NON-cart pages: anchor has BOTH href (fallback) and data-action (drawer open)
  // - On cart page: plain anchor (no drawer open)
  const cartControl = isCartPage
    ? `<a class="icon-btn og-cartbtn" href="${hrefCart}" aria-label="Cart">
         ${bagIconSvg()}
         <span class="cart-badge" data-ui="cart-count" hidden>0</span>
       </a>`
    : `<a class="icon-btn og-cartbtn" href="${hrefCart}" aria-label="Cart" data-action="open-cart-drawer">
         ${bagIconSvg()}
         <span class="cart-badge" data-ui="cart-count" hidden>0</span>
       </a>`;

  mount.innerHTML = `
    <a class="skip-link" href="#main">Skip to content</a>

    <!-- Header (structure matches item.html) -->
    <header class="site-header og-header" data-elevate-on-scroll>
      <div class="item-container header-inner og-header-inner">

        <button class="btn ghost icon-only og-iconbtn og-navtoggle"
                type="button"
                aria-label="Open menu"
                aria-controls="ogNavDrawer"
                aria-expanded="false"
                data-action="open-nav-drawer">
          <span class="og-hamburger" aria-hidden="true"><i></i><i></i><i></i></span>
        </button>

        <a class="brand og-brand" href="${hrefIndex}" aria-label="OG Jewelers Home">
          <span class="brand-mark og-brand-mark" aria-hidden="true">OG</span>
          <span class="brand-name og-brand-name">OG Jewelers</span>
        </a>

        <nav class="nav og-nav" aria-label="Primary navigation">
          <a class="nav-link og-nav-link" href="${hrefShop}">Shop</a>
          <a class="nav-link og-nav-link" href="${hrefVault}">Vault</a>
          <a class="nav-link og-nav-link" href="${hrefIndex}#story">Story</a>
          <a class="nav-link og-nav-link" href="${hrefIndex}#contact">Contact</a>
        </nav>

        <div class="header-actions">
          <button class="icon-btn" type="button" aria-label="Search" data-action="open-search">
            ${searchIconSvg()}
          </button>

          <!-- EXACT item: login points to join.html -->
          <a class="btn btn-ghost og-loginbtn" href="${hrefJoin}" data-ui="access-btn">Login</a>

          <button class="acct-chip" type="button" aria-label="Account" data-ui="acct-chip" hidden>
            <span class="acct-initials" data-ui="acct-initials">M</span>
          </button>

          <div class="acct-menu" data-ui="acct-menu" aria-hidden="true" hidden>
            <a class="acct-menu-item" href="${hrefProfile}">Account</a>
            <button class="acct-menu-item danger" type="button" data-action="signout">Sign out</button>
          </div>

          ${cartControl}
        </div>
      </div>
    </header>

    <!-- Mobile Nav Drawer (same as item.html) -->
    <div class="og-navbackdrop" data-ui="nav-drawer-backdrop" hidden></div>

    <aside class="og-navdrawer" id="ogNavDrawer" data-ui="nav-drawer" aria-hidden="true" hidden>
      <div class="og-navdrawer-top">
        <div class="og-navdrawer-title">Menu</div>
        <button class="og-navdrawer-close" type="button" aria-label="Close menu" data-action="close-nav-drawer">×</button>
      </div>

      <nav class="nav-drawer" aria-label="Mobile navigation">
        <a class="nav-drawer-link" href="${hrefJoin}" data-ui="mobile-access">Login</a>

        <a class="nav-drawer-link" href="${hrefProfile}" data-ui="drawer-account" hidden>
          <span class="nav-drawer-initials" aria-hidden="true"><span data-ui="drawer-initials">M</span></span>
          <span>Account</span>
        </a>

        <div class="nav-drawer-divider" data-ui="drawer-divider" aria-hidden="true" hidden></div>

        <a class="nav-drawer-link" href="${hrefShop}">Shop</a>
        <a class="nav-drawer-link" href="${hrefVault}">Vault</a>
        <a class="nav-drawer-link" href="${hrefIndex}#story">Story</a>
        <a class="nav-drawer-link" href="${hrefIndex}#contact">Contact</a>
      </nav>
    </aside>
  `;

  // ---- Behavior (drawer + account menu) ----
  const $ = (sel) => document.querySelector(sel);

  const drawer = $('[data-ui="nav-drawer"]');
  const backdrop = $('[data-ui="nav-drawer-backdrop"]');
  const openBtn = document.querySelector('[data-action="open-nav-drawer"]');
  const closeBtn = document.querySelector('[data-action="close-nav-drawer"]');

  function openDrawer() {
    if (!drawer || !backdrop) return;
    drawer.hidden = false;
    backdrop.hidden = false;
    requestAnimationFrame(() => {
      drawer.classList.add("is-open");
      drawer.setAttribute("aria-hidden", "false");
      openBtn?.setAttribute("aria-expanded", "true");
    });
    document.documentElement.classList.add("lock");
    document.body.classList.add("lock");
  }

  function closeDrawer() {
    if (!drawer || !backdrop) return;
    drawer.classList.remove("is-open");
    drawer.setAttribute("aria-hidden", "true");
    openBtn?.setAttribute("aria-expanded", "false");
    backdrop.hidden = true;
    setTimeout(() => { drawer.hidden = true; }, 320);
    document.documentElement.classList.remove("lock");
    document.body.classList.remove("lock");
  }

  openBtn?.addEventListener("click", openDrawer);
  closeBtn?.addEventListener("click", closeDrawer);
  backdrop?.addEventListener("click", closeDrawer);

  const acctChip = $('[data-ui="acct-chip"]');
  const acctMenu = $('[data-ui="acct-menu"]');

  function closeAcctMenu() {
    if (!acctMenu) return;
    acctMenu.hidden = true;
    acctMenu.setAttribute("aria-hidden", "true");
    acctChip?.setAttribute("aria-expanded", "false");
  }

  function toggleAcctMenu() {
    if (!acctMenu) return;
    if (!acctMenu.hidden) closeAcctMenu();
    else {
      acctMenu.hidden = false;
      acctMenu.setAttribute("aria-hidden", "false");
      acctChip?.setAttribute("aria-expanded", "true");
    }
  }

  acctChip?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleAcctMenu();
  });

  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (acctMenu && !acctMenu.hidden && !acctMenu.contains(t) && t !== acctChip) closeAcctMenu();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeDrawer();
      closeAcctMenu();
    }
  });

  // Search fallback: focus #searchInput if present
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const searchBtn = t.closest('[data-action="open-search"]');
    if (!searchBtn) return;

    const inp = document.getElementById("searchInput") || document.querySelector('input[type="search"]');
    if (inp && "focus" in inp) {
      inp.scrollIntoView({ behavior: "smooth", block: "center" });
      inp.focus();
    }
  });

  function searchIconSvg() {
    return `
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M10.5 18a7.5 7.5 0 1 1 0-15a7.5 7.5 0 0 1 0 15Z"></path>
        <path d="M16.2 16.2L21 21"></path>
      </svg>
    `;
  }

  function bagIconSvg() {
    return `
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M6 8h12l-1 13H7L6 8Z"></path>
        <path d="M9 8V7a3 3 0 0 1 6 0v1"></path>
      </svg>
    `;
  }
})();