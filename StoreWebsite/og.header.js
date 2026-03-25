(function () {
  const mount = document.getElementById("ogHeaderMount");
  if (!mount) return;

  const pathname = window.location.pathname.replace(/\\/g, "/");
  const isStoreCart = /\/StoreCart\/?/i.test(pathname);
  const isHomePage = /(?:^|\/)index\.html$/i.test(pathname) || pathname.endsWith("/StoreWebsite/") || pathname.endsWith("/StoreWebsite");
  const requestedHeaderVariant = document.body?.dataset?.headerVariant || mount.dataset?.headerVariant || "";
  const useHomeHeaderVariant = isHomePage || requestedHeaderVariant === "home";
  const base = isStoreCart ? ".." : ".";

  if (useHomeHeaderVariant) {
    renderHomeHeader();
    return;
  }

  renderDefaultHeader();

  function renderHomeHeader() {
    mount.innerHTML = `
      <a class="skip-link" href="#main">Skip to content</a>

      <header class="site-header og-header og-header-home" data-home-header>
        <div class="item-container og-home-header-inner">
          <div class="og-home-header-side og-home-header-left">
            <button
              class="og-home-menu-btn"
              type="button"
              aria-label="Open menu"
              aria-controls="ogHomeDrawer"
              aria-expanded="false"
              data-action="open-home-nav"
            >
              <span class="og-home-menu-lines" aria-hidden="true"><i></i><i></i><i></i></span>
            </button>
          </div>

          <div class="og-home-header-center">
            <a
              class="og-home-brand"
              href="${base}/index.html"
              aria-label="OG Jewelers home"
            >
              <img
                src="${base}/OG_Logo.png"
                alt="OG Jewelers"
                class="og-home-brand-logo"
                width="132"
                height="132"
                fetchpriority="high"
                decoding="async"
              />
            </a>
          </div>

          <div class="og-home-header-side og-home-header-right" aria-hidden="true"></div>
        </div>
      </header>

      <div class="og-header-spacer" aria-hidden="true"></div>

      <div class="og-home-backdrop" data-ui="home-nav-backdrop" hidden></div>

      <aside class="og-home-drawer" id="ogHomeDrawer" data-ui="home-nav-drawer" aria-hidden="true" hidden>
        <div class="og-home-drawer-top">
          <p class="og-home-drawer-label">OG Jewelers</p>
          <button class="og-home-drawer-close" type="button" aria-label="Close menu" data-action="close-home-nav">&times;</button>
        </div>

        <nav class="og-home-drawer-nav" aria-label="Homepage navigation">
          <a href="${base}/join.html">Join the VIP Community</a>
          <a href="${base}/story.html">Brand Story</a>
          <a href="${base}/contact.html">Contact</a>
          <a href="https://www.ebay.com/ebaylive/sellers/lertro4xscs" target="_blank" rel="noopener noreferrer">Live Shows</a>
          <a href="${base}/access.html">Account</a>
        </nav>
      </aside>
    `;

    const drawer = document.querySelector('[data-ui="home-nav-drawer"]');
    const backdrop = document.querySelector('[data-ui="home-nav-backdrop"]');
    const openBtn = document.querySelector('[data-action="open-home-nav"]');
    const closeBtn = document.querySelector('[data-action="close-home-nav"]');

    function lockScroll(on) {
      document.documentElement.classList.toggle("lock", on);
      document.body.classList.toggle("lock", on);
    }

    function openDrawer() {
      if (!drawer || !backdrop) return;
      drawer.hidden = false;
      backdrop.hidden = false;
      requestAnimationFrame(() => {
        drawer.classList.add("is-open");
        drawer.setAttribute("aria-hidden", "false");
        openBtn?.setAttribute("aria-expanded", "true");
      });
      lockScroll(true);
    }

    function closeDrawer() {
      if (!drawer || !backdrop) return;
      drawer.classList.remove("is-open");
      drawer.setAttribute("aria-hidden", "true");
      openBtn?.setAttribute("aria-expanded", "false");
      backdrop.hidden = true;
      window.setTimeout(() => {
        drawer.hidden = true;
      }, 260);
      lockScroll(false);
    }

    openBtn?.addEventListener("click", openDrawer);
    closeBtn?.addEventListener("click", closeDrawer);
    backdrop?.addEventListener("click", closeDrawer);
    drawer?.addEventListener("click", (event) => {
      const link = event.target.closest("a[href]");
      if (link) closeDrawer();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeDrawer();
    });
  }

  function renderDefaultHeader() {
    const hrefIndex = `${base}/index.html`;
    const hrefShop = `${base}/catalogue.html`;
    const hrefFavorites = `${base}/favorites.html`;
    const hrefJoin = `${base}/join.html`;
    const hrefProfile = `${base}/profile.html`;
    const hrefStory = `${base}/story.html`;
    const hrefContact = `${base}/contact.html`;
    const hrefCart = isStoreCart ? "./cart.html" : `${base}/StoreCart/cart.html`;

    const isCartPage = /\/cart\.html$/i.test(pathname);
    const isCataloguePage = /(?:^|\/)catalogue\.html$/i.test(pathname);
    const searchAction = isCataloguePage ? "open-catalogue-search" : "open-search";

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

      <header class="site-header og-header" data-elevate-on-scroll>
        <div class="item-container header-inner og-header-inner">
          <div class="header-zone header-zone-left">
            <button class="icon-btn og-iconbtn og-navtoggle"
                    type="button"
                    aria-label="Open menu"
                    aria-controls="ogNavDrawer"
                    aria-expanded="false"
                    data-action="open-nav-drawer">
              <span class="og-hamburger" aria-hidden="true"><i></i><i></i><i></i></span>
            </button>

            <nav class="nav og-nav og-utility-nav" aria-label="Primary navigation">
              <a class="icon-btn utility-link" href="${hrefShop}" aria-label="Shop" title="Shop">
                ${shopIconSvg()}
                <span class="sr-only">Shop</span>
              </a>
              <a class="icon-btn utility-link" href="${hrefFavorites}" aria-label="Favorites" title="Favorites">
                ${heartIconSvg()}
                <span class="sr-only">Favorites</span>
              </a>
              <a class="icon-btn utility-link" href="${hrefContact}" aria-label="Contact" title="Contact">
                ${contactIconSvg()}
                <span class="sr-only">Contact</span>
              </a>
              <a class="nav-link story-link" href="${hrefStory}">Story</a>
            </nav>
          </div>

          <div class="header-zone header-zone-center">
            <a class="brand" href="${hrefIndex}" aria-label="OG Jewelry home">
              <span class="brand-mark">
                <img
                  src="${base}/OG-Jewelers.webp"
                  alt=""
                  class="brand-logo"
                  loading="eager"
                  decoding="async"
                />
              </span>
            </a>
          </div>

          <div class="header-zone header-zone-right">
            <div class="header-actions">
              <button class="icon-btn" type="button" aria-label="${isCataloguePage ? "Search catalogue" : "Search"}" data-action="${searchAction}">
                ${searchIconSvg()}
              </button>

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
        </div>
      </header>
      <div class="og-header-spacer" aria-hidden="true"></div>

      <div class="og-navbackdrop" data-ui="nav-drawer-backdrop" hidden></div>

      <aside class="og-navdrawer" id="ogNavDrawer" data-ui="nav-drawer" aria-hidden="true" hidden>
        <div class="og-navdrawer-top">
          <div class="og-navdrawer-title">Menu</div>
          <button class="og-navdrawer-close" type="button" aria-label="Close menu" data-action="close-nav-drawer">&times;</button>
        </div>

        <nav class="nav-drawer" aria-label="Mobile navigation">
          <a class="nav-drawer-link" href="${hrefJoin}" data-ui="mobile-access">Login</a>

          <a class="nav-drawer-link" href="${hrefProfile}" data-ui="drawer-account" hidden>
            <span class="nav-drawer-initials" aria-hidden="true"><span data-ui="drawer-initials">M</span></span>
            <span>Account</span>
          </a>

          <div class="nav-drawer-divider" data-ui="drawer-divider" aria-hidden="true" hidden></div>

          <div class="nav-drawer-utilities" role="group" aria-label="Quick links">
            <a class="nav-drawer-icon" href="${hrefShop}" aria-label="Shop" title="Shop">
              ${shopIconSvg()}
              <span class="sr-only">Shop</span>
            </a>
            <a class="nav-drawer-icon" href="${hrefFavorites}" aria-label="Favorites" title="Favorites">
              ${heartIconSvg()}
              <span class="sr-only">Favorites</span>
            </a>
            <a class="nav-drawer-icon" href="${hrefContact}" aria-label="Contact" title="Contact">
              ${contactIconSvg()}
              <span class="sr-only">Contact</span>
            </a>
          </div>

          <a class="nav-drawer-link" href="${hrefStory}">Story</a>
        </nav>
      </aside>
    `;

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
      setTimeout(() => {
        drawer.hidden = true;
      }, 320);
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

    document.addEventListener("click", (e) => {
      const t = e.target;
      if (!(t instanceof Element)) return;

      const catalogueSearchBtn = t.closest('[data-action="open-catalogue-search"]');
      if (catalogueSearchBtn) {
        e.preventDefault();
        e.stopPropagation();
        window.dispatchEvent(new CustomEvent("og:catalogue-search-open", {
          detail: { source: "header-search" }
        }));
        return;
      }

      const searchBtn = t.closest('[data-action="open-search"]');
      if (!searchBtn) return;

      const inp = document.getElementById("searchInput") || document.querySelector('input[type="search"]');
      if (inp && "focus" in inp) {
        inp.scrollIntoView({ behavior: "smooth", block: "center" });
        inp.focus();
      }
    });
  }

  function searchIconSvg() {
    return `
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M10.5 18a7.5 7.5 0 1 1 0-15a7.5 7.5 0 0 1 0 15Z"></path>
        <path d="M16.2 16.2L21 21"></path>
      </svg>
    `;
  }

  function shopIconSvg() {
    return `
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 3.5 4.5 7.7v8.6L12 20.5l7.5-4.2V7.7L12 3.5Z"></path>
        <path d="M12 3.5v17"></path>
        <path d="M4.5 7.7 12 12l7.5-4.3"></path>
      </svg>
    `;
  }

  function heartIconSvg() {
    return `
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M12 20.2S4 14.9 4 9.3a4.3 4.3 0 0 1 7.4-3.1L12 6.8l.6-.6A4.3 4.3 0 0 1 20 9.3c0 5.6-8 10.9-8 10.9Z"></path>
      </svg>
    `;
  }

  function contactIconSvg() {
    return `
      <svg class="ico" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <rect x="3" y="5" width="18" height="14" rx="2"></rect>
        <path d="m4 7 8 6 8-6"></path>
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
