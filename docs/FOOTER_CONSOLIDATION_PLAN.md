# OG Jewelers Footer Consolidation Plan

## Objective

Plan a single global shared footer system for `StoreWebsite/` that eliminates page-by-page footer drift, keeps content consistent, and follows the existing shared-header philosophy without implementing storefront changes yet.

## Source Review

- `docs/legacy/REPO_SUMMARY.md`: not present. Repo state was audited directly.
- `docs/legacy/STOREWEBSITE_AUDIT.md`: reviewed.
- `docs/legacy/STOREWEBSITE_STABILIZATION_PLAN.md`: reviewed.

## Current Footer Audit Summary

Footer fragmentation is real and meaningful.

- `StoreWebsite/index.html` uses a unique inline `prelaunch-footer` with a minimal two-column layout and launch-oriented messaging.
- `StoreWebsite/catalogue.html`, `StoreWebsite/story.html`, and `StoreWebsite/contact.html` each inline the same `site-footer` markup, creating three copies of the same structure.
- Additional storefront pages introduce more footer variants:
  - `StoreWebsite/access.html` uses a compact `.foot` footer.
  - `StoreWebsite/profile.html` uses a similar `.foot` footer.
  - `StoreWebsite/StoreCart/cart.html` uses a separate `.footer` pattern.
  - `StoreWebsite/join.html`, `StoreWebsite/item.html`, and `StoreWebsite/favorites.html` currently have no page footer.
- There is no existing shared footer mount, partial include, or JS footer renderer equivalent to `og.header.js`.
- Footer styling is split across multiple CSS files, and footer content is inconsistent across pages.

## Current Footer Variants By Page

### Required audit pages

| Page | Current markup | Inline or shared | CSS styling | JS involvement | Notes |
| --- | --- | --- | --- | --- | --- |
| `StoreWebsite/index.html` | `<footer class="prelaunch-footer">` | Inline | `StoreWebsite/index.css` | None | Launch-oriented content; no legal/support/shop sections |
| `StoreWebsite/catalogue.html` | `<footer class="site-footer" id="contact">` | Inline duplicate | `StoreWebsite/catalogue.css` | None | Contains Shop, Support, Connect, legal row |
| `StoreWebsite/story.html` | `<footer class="site-footer" id="contact">` | Inline duplicate | `StoreWebsite/catalogue.css` and page-specific shell styles from `StoreWebsite/story.css` | None | Markup matches catalogue footer |
| `StoreWebsite/contact.html` | `<footer class="site-footer" id="contact">` | Inline duplicate | `StoreWebsite/catalogue.css`, plus page-level stylesheets loaded on the page | None | Markup matches catalogue footer |

### Additional storefront pages affecting migration scope

| Page | Current markup | CSS styling | Notes |
| --- | --- | --- | --- |
| `StoreWebsite/access.html` | `<footer class="foot">` | `StoreWebsite/access.css` | Minimal transactional footer |
| `StoreWebsite/profile.html` | `<footer class="foot">` | `StoreWebsite/profile.css` | Minimal member footer |
| `StoreWebsite/StoreCart/cart.html` | `<footer class="footer">` | `StoreWebsite/StoreCart/cart.css` | Cart-specific footer |
| `StoreWebsite/join.html` | None | `StoreWebsite/join.css` defines `.join-footer`, but no markup uses it | Indicates unfinished or removed footer |
| `StoreWebsite/item.html` | None | No page footer styles in use | Candidate for future shared footer adoption |
| `StoreWebsite/favorites.html` | None | No page footer styles in use | Candidate for future shared footer adoption |

## Shared Dependency Summary

### Existing shared mechanism

- Shared header already exists via `StoreWebsite/og.header.js` and mount point `<div id="ogHeaderMount"></div>`.
- No equivalent `og.footer.js`, `ogFooterMount`, footer partial, or footer injection logic exists.

### Current footer dependencies

- `StoreWebsite/index.html` footer depends on `StoreWebsite/index.css`.
- `StoreWebsite/catalogue.html`, `StoreWebsite/story.html`, and `StoreWebsite/contact.html` depend on footer rules in `StoreWebsite/catalogue.css`.
- `StoreWebsite/access.html` depends on `.foot` rules in `StoreWebsite/access.css`.
- `StoreWebsite/profile.html` depends on `.foot` rules in `StoreWebsite/profile.css`.
- `StoreWebsite/StoreCart/cart.html` depends on cart footer rules in `StoreWebsite/StoreCart/cart.css`.
- JS does not mount or control storefront footers today.
- The only footer-related JS found is cart-year handling in `StoreWebsite/StoreCart/cart.js`, which updates `#year` on the cart page. No other page footer is scripted.

## Footer Fragmentation Detail

### 1. What footer markup each required page currently uses

- `StoreWebsite/index.html`: `prelaunch-footer`
- `StoreWebsite/catalogue.html`: `site-footer`
- `StoreWebsite/story.html`: `site-footer`
- `StoreWebsite/contact.html`: `site-footer`

### 2. Whether each footer is inline or shared

- All four required pages use inline footer markup in the HTML file itself.
- `catalogue.html`, `story.html`, and `contact.html` duplicate the same `site-footer` block instead of mounting shared markup.

### 3. Whether any existing shared footer mechanism already exists

- No. A true shared footer mechanism does not exist.

### 4. Which CSS files currently style each footer

- `prelaunch-footer`: `StoreWebsite/index.css`
- `site-footer`: `StoreWebsite/catalogue.css`
- `.foot`: `StoreWebsite/access.css` and `StoreWebsite/profile.css`
- cart `.footer`: `StoreWebsite/StoreCart/cart.css`

### 5. Whether footer behavior/content is duplicated across pages

- Yes.
- `catalogue.html`, `story.html`, and `contact.html` repeat identical `site-footer` markup and rely on the same footer CSS.
- `access.html` and `profile.html` use very similar compact footers but maintain separate markup and styling.

### 6. Whether any JS currently mounts or controls footers

- No shared footer JS exists.
- No page script mounts footer HTML.
- No footer interaction logic is present.
- `StoreWebsite/StoreCart/cart.js` updates the cart page copyright year only.

### 7. Structural differences between the `index.html` prelaunch footer and the `site-footer`

`prelaunch-footer` in `StoreWebsite/index.html`

- Two-part layout: brand/copy block plus a flat link row.
- Messaging is launch-oriented and concise.
- Uses `OG Jewelers` naming.
- Contains only `Contact`, `VIP Access`, `Brand Story`, and `Account`.
- No `Shop`, `Support`, `Connect`, or legal section.
- No social links.
- No `id="contact"` anchor.

`site-footer` in `catalogue.html`, `story.html`, and `contact.html`

- Multi-column grid with brand block plus three columns: `Shop`, `Support`, `Connect`.
- Includes a separate bottom row for copyright and legal links.
- Uses `OG Jewelry` naming.
- Includes social placeholders for `Instagram`, `TikTok`, and `YouTube`.
- Includes an email link.
- Uses `id="contact"` on the footer element.

### 8. Which footer content and links are inconsistent across pages

- Brand naming varies: `OG Jewelers` vs `OG Jewelry`.
- Footer purpose varies: prelaunch marketing vs shop/support/legal navigation.
- `index.html` includes `VIP Access`, `Brand Story`, and `Account`; `site-footer` omits those.
- `site-footer` includes `Shop`, `Support`, `Privacy`, and `Terms`; `index.html` omits all of them.
- `site-footer` shop links point to non-existent `shop.html` routes instead of `catalogue.html`.
- `site-footer` support links point to missing `shipping.html`, `returns.html`, `care.html`, `privacy.html`, and `terms.html`.
- Social links are placeholders (`href="#"`) for Instagram, TikTok, and YouTube.
- Contact email is placeholder text on `site-footer` (`support@your-domain.com`) while the contact page exposes a real email address: `rafa102093@gmail.com`.
- WhatsApp is not present anywhere.
- `access.html`, `profile.html`, and cart use smaller footers with different link sets again.

## Review Gate

### Fragmentation confirmation

Footer fragmentation is real and meaningful because:

- one footer family (`site-footer`) is duplicated inline across multiple high-traffic pages,
- the homepage uses a different content model and styling system,
- secondary pages use separate footer variants or no footer at all,
- broken and placeholder links are embedded directly into current footer copies, and
- there is no single source of truth for footer content, structure, or social links.

### Direction confirmation

A shared global footer is the correct direction.

- It matches the existing shared-header architecture already used in the storefront.
- It centralizes content and reduces repeated HTML drift.
- It gives one place to add Instagram and WhatsApp.
- It allows link cleanup and future legal/support page activation from one source.

### Risks, constraints, and adjustments

- `StoreWebsite/index.html` is the approved canonical baseline, but it cannot be copied blindly because it lacks legal, support, and connect sections expected on interior pages.
- The current `site-footer` carries useful structure that should be normalized into the canonical footer, but some of its links are placeholders or broken and should not be preserved as-is.
- `id="contact"` is currently attached to the duplicated `site-footer`; if other pages still rely on `index.html#contact`, the migration must decide whether the shared footer keeps that anchor or whether navigation is corrected elsewhere.
- Social URLs are not fully available in the repo. The plan should provide slots for Instagram and WhatsApp, but final URLs must remain configurable until confirmed.
- Pages with intentionally minimal transactional layouts (`access.html`, `profile.html`, and possibly `join.html`) should be migrated only after the main storefront pages stabilize, because their UX goals differ from the browse/shop pages.

Agreed. Proceeding with Footer Consolidation Planning.

## Canonical Footer Decision

### Canonical baseline

Use `StoreWebsite/index.html` as the canonical content baseline, per approved direction.

### Normalization required before globalization

The homepage footer should be adapted, not copied verbatim.

Recommended canonical content model:

- Keep the homepage tone, brand wording, and concise value statement from `prelaunch-footer`.
- Expand the structure to support interior-page needs already present in `site-footer`.
- Carry over only the useful section concepts from `site-footer`: `Connect` and legal/support affordances where they map to real destinations.
- Remove or replace broken `shop.html` and placeholder support/legal links during migration.

### Proposed canonical content blocks

1. Brand block
   - Brand name: `OG Jewelers`
   - Short value statement derived from the homepage footer

2. Primary links
   - `Contact`
   - `VIP Access`
   - `Brand Story`
   - `Account`
   - Add `Shop` only if routed to `catalogue.html`

3. Connect / Social
   - `Instagram`
   - `WhatsApp`
   - Optional future additions can remain supported, but TikTok and YouTube should not be hard-coded into the canonical baseline unless still desired
   - Real URLs should come from confirmed repo values or a small config object; do not freeze placeholder `#` links into the final source of truth

4. Legal / support row
   - Include only destinations that actually exist or are explicitly planned
   - If `privacy.html` and `terms.html` do not exist at implementation time, either omit them temporarily or render them as disabled/non-linked text only if the business wants visible placeholders

## Recommended Architecture

### Preferred approach

Use a JS-mounted shared footer modeled on the existing shared header.

Recommended pieces:

- `StoreWebsite/og.footer.js`
- `<div id="ogFooterMount"></div>` on pages that should use the shared footer
- `StoreWebsite/og.footer.css` for canonical shared footer styling
- Optional small config object for social/contact/legal URLs if the team wants content to remain editable without rewriting the renderer

### Why JS-mounted is the best fit

- It aligns with the proven `og.header.js` pattern already used across storefront pages.
- The storefront is currently static HTML, so JS mounting avoids introducing a new build tool or server-side include process.
- It removes duplicated footer markup without requiring page templating infrastructure.
- It allows page-aware path handling similar to `og.header.js`, including `StoreCart/` relative paths if needed later.
- It enables phased migration page by page while preserving current layouts until each page is ready.

### Alternative considered

Manual copy/paste standardization across HTML files was rejected because it would still leave multiple sources of truth and would drift again.

## CSS and JS Implications

### CSS refactor

- Create a dedicated shared footer stylesheet rather than leaving footer rules inside `index.css` or `catalogue.css`.
- Move only canonical footer styles into `StoreWebsite/og.footer.css`.
- Leave page-specific footer variants (`.foot`, cart `.footer`) untouched until their migration phase.
- Avoid coupling the global footer to `catalogue.css` so pages without catalogue styling can still adopt it safely.

### JS refactor

- Add `StoreWebsite/og.footer.js` with the same path-awareness strategy used in `og.header.js`.
- Renderer should support:
  - homepage and interior page mounting,
  - optional `id="contact"` on the mounted footer if navigation compatibility is still required,
  - configurable social/contact URLs,
  - current year rendering within the shared footer itself so pages do not need separate year scripts.
- No current footer behavior needs to be preserved beyond static rendering and year output.

## Social Link Strategy

### Instagram

- Keep Instagram in the canonical `Connect` area.
- Replace placeholder `#` usage with a configurable real URL once confirmed.

### WhatsApp

- Add WhatsApp to the canonical `Connect` area as a first-class social/contact item.
- Use a configurable link slot because no WhatsApp URL or phone deep link was found in the repo.

### Existing repo evidence

- `site-footer` currently includes placeholder Instagram, TikTok, and YouTube links.
- No confirmed WhatsApp URL exists in the repo.
- The contact page contains a real email address that can inform future contact-link normalization, but this plan does not assume that email should automatically become the shared footer contact endpoint without business confirmation.

## Pages That Should Eventually Use the Shared Footer

### Phase 1 target pages

- `StoreWebsite/index.html`
- `StoreWebsite/catalogue.html`
- `StoreWebsite/story.html`
- `StoreWebsite/contact.html`
- `StoreWebsite/favorites.html`
- `StoreWebsite/item.html`

Rationale:

- These are the primary brand and shopping surfaces.
- Most already use the shared header model or fit naturally into it.
- They benefit the most from consistent brand, social, and navigation treatment.

### Phase 2 evaluate separately

- `StoreWebsite/access.html`
- `StoreWebsite/profile.html`
- `StoreWebsite/join.html`
- `StoreWebsite/StoreCart/cart.html`

Rationale:

- These pages currently use intentionally different layouts or lightweight transactional framing.
- They may adopt the shared footer later, but doing so should be a deliberate UX decision rather than an automatic replacement.

### Out of scope for this footer system

- `StoreWebsite/admin-storefront.html`
- `StoreWebsite/StoreAdmin/`

Rationale:

- Admin surfaces are not part of the storefront shared-header philosophy.

## Migration Strategy By Page

### Safest migration order

1. `StoreWebsite/catalogue.html`
2. `StoreWebsite/story.html`
3. `StoreWebsite/contact.html`
4. `StoreWebsite/index.html`
5. `StoreWebsite/favorites.html`
6. `StoreWebsite/item.html`
7. Evaluate transactional pages (`access.html`, `profile.html`, `join.html`, `StoreCart/cart.html`) separately

### Why this order

- `catalogue.html`, `story.html`, and `contact.html` already share the same duplicated footer, so they are the lowest-risk proving ground for the mount mechanism.
- `index.html` should migrate after the shared footer is visually validated on interior pages, because its current footer is the canonical content baseline but not the canonical structure.
- `favorites.html` and `item.html` currently lack a page footer, so they can adopt the final shared system once it is stable.
- Transactional/member/cart pages should wait until the shared footer has proven compatible with the primary storefront experience.

## Executable Implementation Plan

1. Inventory and finalize canonical footer content.
   - Confirm production-ready destinations for `Shop`, `Privacy`, `Terms`, Instagram, and WhatsApp.
   - Replace `shop.html` assumptions with `catalogue.html` routing where applicable.

2. Create the shared footer source of truth.
   - Add `StoreWebsite/og.footer.js` that renders canonical footer HTML into `#ogFooterMount`.
   - Add path-awareness for root pages and `StoreCart/` subdirectory pages if future adoption is needed there.

3. Extract shared footer styling.
   - Add `StoreWebsite/og.footer.css`.
   - Move canonical footer visuals out of `index.css` and `catalogue.css` into the new shared stylesheet during implementation.
   - Keep old footer styles temporarily until each page is migrated.

4. Define footer configuration inputs.
   - Use either hard-coded canonical values inside `og.footer.js` or a tiny global config object for URLs that are currently unknown.
   - Ensure missing Instagram and WhatsApp URLs fail safely without broken `#` placeholders in the final production version.

5. Migrate duplicated `site-footer` pages first.
   - Replace inline footer markup in `StoreWebsite/catalogue.html`, `StoreWebsite/story.html`, and `StoreWebsite/contact.html` with `<div id="ogFooterMount"></div>`.
   - Load `og.footer.css` and `og.footer.js` on those pages.
   - Verify layout parity and path correctness.

6. Adapt the homepage to the shared footer.
   - Replace `prelaunch-footer` in `StoreWebsite/index.html` with the shared mount.
   - Preserve homepage brand tone and copy by baking that content into the canonical shared footer.
   - Confirm the homepage still feels intentional rather than over-expanded.

7. Extend shared footer adoption to footerless storefront pages.
   - Add the mount to `StoreWebsite/favorites.html` and `StoreWebsite/item.html`.
   - Verify spacing, bottom-of-page balance, and no conflicts with cart drawer or page overlays.

8. Reconcile navigation anchors and missing destinations.
   - Decide whether the mounted footer should keep `id="contact"` for backward compatibility.
   - Remove or replace links to missing destinations before declaring the footer canonical.

9. Evaluate secondary pages.
   - Decide case by case whether `access.html`, `profile.html`, `join.html`, and `StoreCart/cart.html` should keep lightweight footers or join the shared system.
   - If migrated, remove their local footer styles only after verification.

10. Cleanup and verification.
   - Delete obsolete inline footer markup and old footer-only CSS rules once every migrated page is stable.
   - Run a final storefront-wide audit to confirm one canonical source of truth remains.

## Risks and Non-Goals

### Risks

- Canonicalizing too much of the current `site-footer` would preserve broken routes and placeholder content.
- Canonicalizing too little from the interior-page footer could leave the shared footer underpowered for browse/shop pages.
- Migrating transactional pages too early could degrade intentionally focused flows.
- Reusing existing class names like `.footer-brand` without isolation could create style collisions because those names already exist in multiple CSS files.

### Non-goals

- No storefront implementation changes in this planning step.
- No unrelated page redesigns.
- No creation of missing legal/support pages in this step.
- No migration of admin pages.
- No assumption that `prelaunch-footer` and `site-footer` are equivalent.

## Definition of Done

Footer consolidation implementation will be done when:

- one shared footer source of truth exists,
- primary storefront pages mount that footer instead of embedding unique HTML copies,
- homepage content baseline is represented in the shared footer,
- Instagram and WhatsApp are included in a dedicated `Connect` area,
- broken `shop.html` and placeholder-only footer links are resolved or deliberately omitted,
- footer styles live in shared footer assets rather than page-specific CSS duplication,
- no required page in the target migration set contains stale inline footer markup, and
- the storefront footer content is consistent and maintainable across pages.

## Verification Hook

### Footer audit findings summary

- Required pages currently use two different footer families: `prelaunch-footer` on the homepage and duplicated `site-footer` on catalogue, story, and contact.
- Broader storefront audit shows at least four footer states: `prelaunch-footer`, `site-footer`, `.foot`, cart `.footer`, plus several pages with no footer.
- The current `site-footer` includes broken or placeholder destinations and inconsistent brand wording.

### Shared footer mechanism already exists?

No. There is no shared footer mechanism today.

### Recommended canonical footer baseline

`StoreWebsite/index.html` is the recommended canonical baseline, adapted and normalized rather than copied literally.

### Preferred architecture

Yes. A JS-mounted shared footer is the preferred architecture.

### Instagram and WhatsApp incorporation

They should live in a dedicated canonical `Connect` area within the shared footer, with configurable URLs so real destinations can be inserted cleanly once confirmed.

### Document path created

`/docs/FOOTER_CONSOLIDATION_PLAN.md`

### Planning status

Planning is complete and ready for implementation.
