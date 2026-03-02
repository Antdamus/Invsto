# Contact Page Routing Plan (StoreWebsite)

## Overview / Goal
Change StoreWebsite navigation so **Contact** routes to a standalone page at `StoreWebsite/contact.html` instead of scrolling to an in-page `#contact` anchor. Keep **Story** behavior unchanged (still scrolls to `#story` on homepage).

## Scope
- Create `StoreWebsite/contact.html`.
- Update shared header navigation Contact link to point to the new page.
- Update homepage story-card CTA to point to the new contact page.
- Validate navigation from main storefront pages (`index`, `catalogue`, `item`, `favorites`, `StoreCart/cart`).

## Non-goals
- No redesign of global header/footer system.
- No behavioral changes to Story nav link.
- No admin storefront (`admin-storefront.html`) changes.
- No required removal of existing `id="contact"` anchors unless they cause confusion.

## Contracts (must hold)
- Shared nav **Contact** link resolves to:
  - `./contact.html` on root StoreWebsite pages.
  - `../contact.html` on `StoreWebsite/StoreCart/cart.html` context (via shared header path logic).
- Shared nav **Story** link remains `index.html#story`.
- Homepage story-card CTA for story discovery points to `contact.html`.
- Existing footer/support links to `contact.html` remain valid.

## Step-by-step plan
1. Create `StoreWebsite/contact.html` using existing storefront structure:
   - Include shared header mount (`#ogHeaderMount`) and `og.header.js`.
   - Reuse existing storefront styling approach (`index.css`/`og.header.css` and footer style pattern as needed).
   - Add static “Our Story / Who we are” content adapted from current homepage story section.
2. Update shared header Contact link in `StoreWebsite/og.header.js`:
   - Desktop nav: `href="${base}/contact.html"`.
   - Mobile drawer nav: `href="${base}/contact.html"`.
   - Leave Story links as `href="${hrefIndex}#story"`.
3. Update homepage story-card CTA in `StoreWebsite/index.html`:
   - Replace or retarget the story-specific CTA so it links to `contact.html`.
   - Keep other CTAs (e.g., Shop) unchanged.
4. Optional cleanup:
   - Keep existing `id="contact"` anchor unless it causes ambiguity after migration.
5. QA:
   - Verify Contact nav from `index.html`, `catalogue.html`, `item.html`, `favorites.html`, and `StoreCart/cart.html` reaches `contact.html`.
   - Verify Story nav still scrolls to homepage `#story`.
   - Verify no console errors, broken links, or layout regressions.

## File checklist (expected touched files)
- `StoreWebsite/contact.html` (new)
- `StoreWebsite/og.header.js` (Contact nav href update)
- `StoreWebsite/index.html` (story-card CTA target update)
- `StoreWebsite/index.css` (optional, only if contact page reuses classes needing minimal additions)

## QA checklist
- [ ] `index.html` header Contact opens `contact.html`.
- [ ] `catalogue.html` header Contact opens `contact.html`.
- [ ] `item.html` header Contact opens `contact.html`.
- [ ] `favorites.html` header Contact opens `contact.html`.
- [ ] `StoreCart/cart.html` header Contact opens `../contact.html` correctly.
- [ ] Story nav still routes to `index.html#story` and scrolls correctly.
- [ ] Homepage story CTA links to `contact.html`.
- [ ] No JS console errors after navigation.
- [ ] No visual regressions in header/footer across affected pages.
