(function () {
  const mount = document.getElementById("ogFooterMount");
  if (!mount) return;

  const pathname = window.location.pathname.replace(/\\/g, "/");
  const isStoreCart = /\/StoreCart\/?/i.test(pathname);
  const base = isStoreCart ? ".." : ".";
  const currentYear = new Date().getFullYear();

  const defaultConfig = {
    brandName: "OG Jewelers",
    brandCopy: "Luxury jewelry, custom design, and live discovery. Stay close to OG as the next experience takes shape.",
    contactId: "contact",
    contactEmail: "rafa102093@gmail.com",
    social: {
      instagram: "https://www.instagram.com/ogjewelers?igsh=MWIyejVvZzR6ZzE2ag==",
      whatsapp: "https://chat.whatsapp.com/EnxoVssJepu7CRySrvMX02"
    },
    columns: {
      shop: [
        { label: "Shop All", path: "catalogue.html" },
        { label: "Gold", path: "catalogue.html?category=gold" },
        { label: "Diamonds", path: "catalogue.html?category=diamonds" },
        { label: "Chains", path: "catalogue.html?category=chains" },
        { label: "Signature", path: "catalogue.html?category=signature" }
      ],
      house: [
        { label: "Contact", path: "contact.html" },
        { label: "VIP Access", path: "join.html" },
        { label: "Brand Story", path: "story.html" },
        { label: "Account", path: "profile.html" }
      ],
      support: [
        { label: "Contact", path: "contact.html", enabled: true },
        { label: "Shipping", path: "shipping.html", enabled: false },
        { label: "Returns", path: "returns.html", enabled: false },
        { label: "Care", path: "care.html", enabled: false }
      ],
      connect: [
        {
          label: "Instagram",
          hrefKey: "instagram",
          external: true,
          rel: "noopener noreferrer",
          target: "_blank"
        },
        {
          label: "WhatsApp",
          hrefKey: "whatsapp",
          external: true,
          rel: "noopener noreferrer",
          target: "_blank"
        },
        {
          label: "Email",
          href: "mailto:rafa102093@gmail.com"
        }
      ]
    },
    legal: [
      { label: "Privacy", path: "privacy.html", enabled: false },
      { label: "Terms", path: "terms.html", enabled: false }
    ]
  };

  const userConfig = window.OG_FOOTER_CONFIG || {};
  const config = mergeFooterConfig(defaultConfig, userConfig);

  mount.innerHTML = renderFooter(config);

  function mergeFooterConfig(defaults, overrides) {
    return {
      ...defaults,
      ...overrides,
      social: {
        ...defaults.social,
        ...(overrides.social || {})
      },
      columns: {
        shop: overrides.columns?.shop || defaults.columns.shop,
        house: overrides.columns?.house || defaults.columns.house,
        support: overrides.columns?.support || defaults.columns.support,
        connect: overrides.columns?.connect || defaults.columns.connect
      },
      legal: overrides.legal || defaults.legal
    };
  }

  function renderFooter(footerConfig) {
    const shopLinks = renderLinkList(footerConfig.columns.shop);
    const houseLinks = renderLinkList(footerConfig.columns.house);
    const supportLinks = renderLinkList(footerConfig.columns.support);
    const connectLinks = renderLinkList(footerConfig.columns.connect);
    const legalLinks = renderLinkList(footerConfig.legal, "og-footer-legal-link");

    return `
      <footer class="og-site-footer" id="${escapeHtml(footerConfig.contactId)}">
        <div class="og-site-footer__inner">
          <div class="og-site-footer__grid">
            <section class="og-site-footer__brand" aria-label="${escapeHtml(footerConfig.brandName)}">
              <p class="og-site-footer__eyebrow">OG Jewelers</p>
              <p class="og-site-footer__copy">${escapeHtml(footerConfig.brandCopy)}</p>
            </section>

            <nav class="og-site-footer__column" aria-label="Shop">
              <h2 class="og-site-footer__title">Shop</h2>
              ${shopLinks}
            </nav>

            <nav class="og-site-footer__column" aria-label="House">
              <h2 class="og-site-footer__title">House</h2>
              ${houseLinks}
            </nav>

            ${supportLinks ? `
            <nav class="og-site-footer__column" aria-label="Support">
              <h2 class="og-site-footer__title">Support</h2>
              ${supportLinks}
            </nav>
            ` : ""}

            <nav class="og-site-footer__column" aria-label="Connect">
              <h2 class="og-site-footer__title">Connect</h2>
              ${connectLinks}
            </nav>
          </div>

          <div class="og-site-footer__bottom">
            <p class="og-site-footer__meta">© ${currentYear} ${escapeHtml(footerConfig.brandName)}. All rights reserved.</p>
            ${legalLinks ? `<div class="og-site-footer__legal">${legalLinks}</div>` : ""}
          </div>
        </div>
      </footer>
    `;
  }

  function renderLinkList(items, className) {
    const links = (items || [])
      .filter((item) => item && item.enabled !== false)
      .map((item) => renderLink(item, className))
      .join("");

    if (!links) return "";
    return `<div class="og-site-footer__links">${links}</div>`;
  }

  function renderLink(item, className) {
    const href = resolveHref(item);
    if (!href) {
      return `<span class="${className || "og-footer-link"} og-footer-link--muted">${escapeHtml(item.label)}</span>`;
    }

    const classes = className || "og-footer-link";
    const target = item.target ? ` target="${escapeHtml(item.target)}"` : "";
    const rel = item.rel ? ` rel="${escapeHtml(item.rel)}"` : "";

    return `<a class="${classes}" href="${escapeHtml(href)}"${target}${rel}>${escapeHtml(item.label)}</a>`;
  }

  function resolveHref(item) {
    if (item.href) return item.href;
    if (item.hrefKey) return config.social[item.hrefKey] || "";
    if (item.path) return `${base}/${item.path}`;
    return "";
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
