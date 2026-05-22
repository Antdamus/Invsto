(function () {
  let mount = document.getElementById("ogFooterMount");

  const pathname = window.location.pathname.replace(/\\/g, "/");
  const isStoreCart = /\/StoreCart\/?/i.test(pathname);
  const base = isStoreCart ? ".." : ".";
  const legacyFooter = document.querySelector(
    "footer.prelaunch-footer, footer.site-footer, footer.foot, footer.footer"
  );

  if (!mount) {
    mount = document.createElement("div");
    mount.id = "ogFooterMount";

    const main = document.querySelector("main");
    if (legacyFooter && legacyFooter.parentNode) {
      legacyFooter.replaceWith(mount);
    } else if (main && main.parentNode) {
      main.insertAdjacentElement("afterend", mount);
    } else {
      document.body.appendChild(mount);
    }
  } else if (legacyFooter && legacyFooter !== mount.closest("footer")) {
    legacyFooter.remove();
  }

  mount.innerHTML = `
    <footer class="og-site-footer" aria-label="Site footer">
      <div class="og-footer-inner">
        <div class="og-footer-block">
          <a class="og-footer-brand" href="${base}/index.html" aria-label="OG Jewelers home">
            <span class="og-footer-brand-row">
              <span class="og-footer-brand-mark">
                <img src="${base}/OG_Logo.png" alt="OG Jewelers" loading="lazy" decoding="async" />
              </span>
              <span class="og-footer-brand-name">OG Jewelers</span>
            </span>
            <span class="og-footer-brand-note">Fine Jewelry. Timeless Value. Crafted with Intention.</span>
          </a>
        </div>

        <nav class="og-footer-block" aria-label="Footer navigation">
          <p class="og-footer-heading">Explore</p>
          <div class="og-footer-link-grid">
            <a class="og-footer-link" href="${base}/join.html">Join</a>
            <a class="og-footer-link" href="${base}/contact.html">Contact</a>
            <a class="og-footer-link" href="${base}/profile.html">Account</a>
          </div>
        </nav>

        <div class="og-footer-block">
          <p class="og-footer-heading">Community</p>
          <div class="og-footer-socials">
            <a
              class="og-footer-link og-footer-social"
              href="https://www.ebay.com/ebaylive/sellers/lertro4xscs"
              target="_blank"
              rel="noopener noreferrer"
            >
              eBay Lives
            </a>
            <a
              class="og-footer-link og-footer-social"
              href="https://www.instagram.com/ogjewelers/"
              target="_blank"
              rel="noopener noreferrer"
            >
              Instagram
            </a>
            <a
              class="og-footer-link og-footer-social"
              href="https://www.tiktok.com/@og.jewelers"
              target="_blank"
              rel="noopener noreferrer"
            >
              TikTok
            </a>
            <a
              class="og-footer-link og-footer-social"
              href="https://www.facebook.com/profile.php?id=61587108306052"
              target="_blank"
              rel="noopener noreferrer"
            >
              Facebook
            </a>
          </div>
        </div>
      </div>
    </footer>
  `;
})();
