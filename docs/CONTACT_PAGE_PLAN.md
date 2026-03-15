# OG Jewelers Contact Page Plan

## Objective
Redesign `StoreWebsite/contact.html` into a premium OG Jewelers contact page that feels direct, high-trust, editorial, and consistent with the existing storefront. This is a planning document only. No storefront code changes are included here.

## Legacy Context Review
- `/docs/legacy/REPO_SUMMARY.md`: not present in the repo, so repo state was audited directly.
- `/docs/legacy/STOREWEBSITE_AUDIT.md`: reviewed for storefront architecture, shared dependencies, and cart/favorites behavior.
- `/docs/legacy/STOREWEBSITE_STABILIZATION_PLAN.md`: reviewed for current storefront risks and navigation constraints.

## Review Gate
### Correct page to evolve
Yes. `StoreWebsite/contact.html` is the correct page to evolve.

Reasoning:
- Shared header navigation already points Contact to `contact.html` through `og.header.js`.
- `index.html` footer already links to `contact.html`.
- The file currently exists but is misaligned with its purpose: it is effectively an old story page, not a contact page.

### Current section order assessment
The proposed order is strong:
1. Hero / contact intro
2. Contact methods grid
3. Contact form
4. Hours + address / visit information
5. Footer

This order is good because it starts with direct access, then provides immediate action options, then moves into a lower-friction form, and ends with practical visit details.

Recommended refinement:
- Keep the approved order.
- Add a small trust strip or concierge note inside the hero or immediately below the contact methods grid instead of adding a separate section. This preserves the minimal structure while improving confidence.

### Weaknesses, risks, and recommended improvements
- `contact.html` currently lacks shared storefront parity. It does not load the cart drawer stack or favorites shared assets, even though the shared header renders cart/favorites controls.
- `contact.html` currently uses `story.css`, but the markup does not actually match the richer, parity-complete `story.html` implementation. It is a simpler legacy variant.
- `contact.html` currently uses `index.css`, but with the older homepage font pairing (`Cormorant Garamond` + `Manrope`) replaced by `Cormorant Garamond` + `Inter`. That creates slight typography drift from the homepage.
- The page title and meta description are wrong for a contact page.
- `contact.html` references `assets/story/story.jpg` inline, but there is no matching parity pattern elsewhere in the storefront for contact content.
- There is no current contact-page-specific logic or form behavior, so form submission needs a deliberately safe placeholder path.
- Footer links still include known broken routes like `shop.html`, `shipping.html`, `returns.html`, `care.html`, `privacy.html`, and `terms.html`; this should not block the contact-page redesign, but it remains a storefront risk.

Agreed. Proceeding with Contact Page Planning.

## Dependency Audit Summary
### `StoreWebsite/contact.html` current audit
#### CSS files currently used
- `index.css`
- `og.header.css`
- `story.css`

#### JS files currently used
- `og.header.js`

#### Shared layout components currently used
- Header: yes, through `#ogHeaderMount` plus `og.header.js`
- Footer: yes, inline legacy footer markup inside `contact.html`
- Cart drawer: no
- Favorites shared UI: no

#### Scripts affecting layout or interactivity
- `og.header.js`
  - Mounts either the home header or the default storefront header.
  - On `contact.html`, it mounts the default header with links for shop, favorites, contact, story, login/account, and cart.
  - Handles nav drawer open/close, account menu toggling, and search button behavior.

#### Dependencies inherited from shared/global styles
- `index.css`
  - Supplies global body background treatment, CTA styles like `.primary-cta` and `.secondary-link`, spacing tokens, and homepage-derived visual language.
- `og.header.css`
  - Supplies shared header layout, header icon buttons, badge styles, drawer styles, and utility classes like `.container` and `.item-container`.
- `story.css`
  - Supplies page-specific story-theme colors, section shells, typography, and `.site-footer` margin reset.

#### Existing contact-page-specific logic
- None. The current page has no email, phone, WhatsApp, address, business hours, or form logic.

#### Shared storefront parity status
- No, `contact.html` does not currently have shared storefront parity.

Why:
- It has the shared header mount, but not the cart drawer markup required by `cart.drawer.js`.
- It does not load `cart.shared.js`, so the cart badge cannot stay in sync.
- It does not load `favorites.shared.css`, `favorites.service.global.js`, or `favorites.shared.js`, even though the header links to `favorites.html`.
- It does not load `initSupabase.js` or the Supabase CDN script, which parity pages use before cart drawer and favorites services.
- It uses the simpler inline footer variant rather than the richer storefront page shell used by `story.html`.

### `StoreWebsite/index.html` WhatsApp CTA audit
#### Location
- `StoreWebsite/index.html` hero-to-community flow, in the `familia-section`.
- CTA anchor is at the WhatsApp invitation block in the section starting around lines 170-188.

#### Markup pattern
```html
<div class="familia-actions">
  <a
    class="primary-cta familia-cta"
    href="https://chat.whatsapp.com/EnxoVssJepu7CRySrvMX02"
    target="_blank"
    rel="noopener noreferrer"
  >
    Join our WhatsApp Chat
  </a>
</div>
```

#### Href pattern
- Direct external WhatsApp community invite link:
  `https://chat.whatsapp.com/EnxoVssJepu7CRySrvMX02`

#### Relevant classes
- `familia-actions`
- `primary-cta`
- `familia-cta`

#### CSS/JS/shared dependency involvement
- Styling dependencies:
  - `index.css` provides `primary-cta`, `familia-actions`, and `familia-cta`.
- JS dependencies:
  - None specific to the WhatsApp CTA. It is a plain anchor.
- Shared dependencies:
  - No special shared JS or service dependency is required for the CTA itself.

### Short dependency map
- Shared header shell:
  - `contact.html` -> `og.header.js` + `og.header.css`
- Current page shell:
  - `contact.html` -> `index.css` + `story.css`
- Full storefront parity baseline:
  - `story.html` -> `catalogue.css` + `og.header.css` + `story.css` + `StoreCart/cart.drawer.css` + `Favorites/favorites.shared.css`
  - plus Supabase CDN + `initSupabase.js` + `StoreCart/cart.shared.js` + `StoreCart/cart.drawer.js` + `StoreCart/cart.service.global.js` + `Favorites/favorites.service.global.js` + `Favorites/favorites.shared.js`
- WhatsApp CTA baseline:
  - `index.html` -> plain anchor using `primary-cta familia-cta`, styled by `index.css`, no dedicated JS

## Design Direction
### Core feel
- Premium
- Dark luxury
- Editorial
- Minimal
- Direct and responsive
- High-trust

### Visual direction
- Use a dark layered background with subtle gold accents and glass/panel surfaces, aligned to OG storefront styling.
- Keep typography serif-forward for major headings and restrained sans-serif for utility copy.
- Avoid adding a new loud color system; stay inside the existing black, ivory, gold, and soft metallic range.
- Preserve strong spacing and large negative space so the page reads as concierge service, not generic support.

### Reference alignment
- Berganza-style influence:
  - Clear contact method presentation, immediate access paths, no hunting for details.
- G&G Timepieces-style influence:
  - Simple premium form, restrained fields, no overbuilt support workflows.
- OG alignment:
  - Use the existing OG hero drama, premium CTA styling, and shared header/footer patterns rather than building a new design language.

## Approved Section Order
1. Hero / contact intro
2. Contact methods grid
3. Contact form
4. Hours + address / visit information
5. Footer

No structural change is recommended. The only adjustment is to fold trust messaging into the hero or contact-method cards instead of inserting another full section.

## Content Intent By Section
### 1. Hero / contact intro
Purpose:
- Establish white-glove availability and reassure users they can reach a real team quickly.

Recommended content:
- Eyebrow such as `Contact OG Jewelers`
- Headline focused on direct access, for example: `Speak with OG directly.`
- Short supporting copy that frames concierge support for sourcing, buying, custom work, and appointment coordination.
- Optional micro trust strip with 2-3 short points like `Direct response`, `Miami-based`, `Luxury sourcing guidance`

### 2. Contact methods grid
Purpose:
- Surface the four primary channels immediately with equal clarity.

Recommended cards:
- Email
- WhatsApp
- Call
- Visit Us

Card behavior:
- Each card should have a concise label, direct action link, short expectation-setting copy, and a restrained icon or accent.
- WhatsApp should be the strongest card visually, but not dominant enough to unbalance the page.

### 3. Contact form
Purpose:
- Provide a low-pressure fallback for users who prefer not to call or message immediately.

Fields:
- Name
- Email
- Message

Tone:
- Compact, premium, friction-light, no unnecessary fields.

### 4. Hours + address / visit information
Purpose:
- Reinforce legitimacy and support in-person or scheduled contact.

Recommended content:
- Business hours
- Placeholder Miami address
- Short note encouraging appointments or advance outreach before visiting

### 5. Footer
Purpose:
- Preserve shared storefront navigation and brand consistency.

## Placeholder Business Info
- Email: `rafa102093@gmail.com`
- Phone: `(305) 555-0147`
- Address: `123 Diamond Avenue, Miami, FL 33131`
- Hours:
  - Monday-Friday: `10:00 AM - 6:00 PM`
  - Saturday: `11:00 AM - 5:00 PM`
  - Sunday: `Closed`

## WhatsApp Reuse Strategy
### What should be reused
- Reuse the same destination URL from `index.html`:
  `https://chat.whatsapp.com/EnxoVssJepu7CRySrvMX02`
- Reuse the same CTA class pattern:
  - `primary-cta`
  - `familia-cta`

### How it should be applied on `contact.html`
- Keep the WhatsApp entry as a real anchor, not a button with JS.
- Use the same external-link behavior:
  - `target="_blank"`
  - `rel="noopener noreferrer"`
- Apply the `primary-cta familia-cta` classes on the WhatsApp CTA itself so the visual treatment stays consistent with homepage behavior.
- If a surrounding contact card needs page-specific layout hooks, add wrapper classes around the CTA instead of changing the CTA class contract.

### Why this is the safest reuse path
- The WhatsApp CTA in `index.html` has no JS dependency, so reuse is low risk.
- `primary-cta` already fits the OG premium button language.
- `familia-cta` already expresses the WhatsApp treatment without introducing a second competing button style.

### Recommended implementation shape
- Use the WhatsApp CTA as the card's primary action in the contact methods grid.
- Optionally reuse the `familia-support-note` tone for a short support hint, but do not copy the full homepage block. The contact page needs tighter, more service-oriented language.

## Form Behavior Recommendation
- Keep the form static and simple in the first implementation pass.
- If there is no production-ready backend or edge function dedicated to contact submissions, do not fake a live workflow.
- Safest initial path:
  - Build the form UI and validation states.
  - Use a non-destructive placeholder submission path such as:
    - `mailto:` fallback for early testing, or
    - client-side intercepted submit with a temporary success/info message stating contact workflow is being finalized.
- Preferred production path later:
  - Wire to a dedicated serverless endpoint or Supabase Edge Function once requirements for storage, spam prevention, and notifications are clear.

Recommendation:
- During implementation, keep the form shell production-looking but clearly note in code comments or task notes if submission remains placeholder-only.
- Do not over-engineer spam protection or CRM integration in this redesign pass.

## Shared Layout / Storefront Parity Considerations
### Header
- Keep `#ogHeaderMount` and `og.header.js`.
- Preserve the default storefront header, not the homepage header.

### Footer
- Preserve the inline OG footer structure currently used by `story.html` and the existing `contact.html`.
- Update footer contact email placeholder if desired, but do not broaden scope into a footer system refactor.

### Cart drawer parity
To match parity with `story.html`, plan for:
- `./StoreCart/cart.drawer.css`
- `./StoreCart/cart.shared.js`
- inline `window.OG_CART_DRAWER_CFG`
- `./StoreCart/cart.drawer.js`
- `./StoreCart/cart.service.global.js`
- cart drawer markup at the end of `<body>`

Reason:
- The shared header renders a cart control with `data-action="open-cart-drawer"` on non-cart pages.
- Without the drawer stack and markup, cart behavior is incomplete on the contact page.

### Favorites parity
To match parity with `story.html`, plan for:
- `./Favorites/favorites.shared.css`
- `./Favorites/favorites.service.global.js`
- `./Favorites/favorites.shared.js`

Reason:
- Favorites are a first-class storefront destination and are treated as shared infrastructure on parity content pages.
- Even if the contact page itself has no favorite toggles, using the same baseline as `story.html` avoids drifting into a second-class page shell.

### Supabase / global storefront config
For parity pages, plan for:
- Supabase CDN script
- `initSupabase.js`

Reason:
- Cart and favorites shared infrastructure already assume the standard storefront boot path.

### Page baseline to follow
- Use `StoreWebsite/story.html` as the parity baseline for document structure and shared assets.
- Use `StoreWebsite/index.html` as the visual/CTA baseline for WhatsApp treatment and premium homepage tone.

## Recommended Improvements To The Contact Concept
- Replace the current legacy story-page shell with a parity-rich content page shell matching `story.html`.
- Use a two-column hero only if it supports direct contact clarity; otherwise keep the hero copy-led and let the contact grid carry the action density.
- Make WhatsApp the most immediate action, but keep email and call equally credible so the page does not feel like a community funnel.
- Include one concise trust note such as response expectations or sourcing guidance rather than adding testimonial-heavy sections.
- Add a short visit note near the address and hours to set expectations for appointments, availability, or pre-visit outreach.
- Keep the form compact and visually secondary to direct contact methods.

## Implementation Steps
1. Replace the current `StoreWebsite/contact.html` page shell with the richer parity structure used by `StoreWebsite/story.html`.
2. Update document metadata for contact intent:
   - title
   - meta description
   - aria labels
3. Load the shared parity assets needed for non-home content pages:
   - header assets
   - cart drawer assets and config
   - favorites shared assets
   - Supabase/init baseline used by other parity pages
4. Preserve the existing OG footer structure and keep it inline unless a broader footer refactor is separately approved.
5. Build the new hero/contact intro section with strong editorial typography and concise concierge-oriented copy.
6. Build the contact methods grid with four cards:
   - Email
   - WhatsApp
   - Call
   - Visit Us
7. Reuse the WhatsApp CTA pattern from `index.html` exactly where practical:
   - same invite URL
   - same anchor behavior
   - same `primary-cta familia-cta` classes
8. Add the contact form section with only:
   - Name
   - Email
   - Message
9. Add the hours/address section below the form and include a short visit note.
10. Ensure the page remains visually aligned to OG by reusing existing color tokens, surface treatments, button treatments, and header/footer language.
11. Verify responsive behavior on mobile and desktop:
   - stacked cards and form on smaller screens
   - preserved readability and spacing
12. Verify shared storefront parity:
   - header renders correctly
   - cart badge paints
   - cart drawer opens from header
   - favorites assets do not error
13. If form submission is not backed by production infrastructure, keep behavior explicitly placeholder-safe and avoid implying a live support system exists.

## Risks / Non-Goals
### Risks
- Reusing `familia-cta` on a different page may need small CSS support if the contact page layout differs materially from the homepage block.
- Adding full parity dependencies increases page weight slightly, but this is the correct tradeoff for consistent storefront behavior.
- Footer links remain partially broken elsewhere in the storefront; this should be documented but not expanded into a link-cleanup project here.
- If no real form backend exists, user expectations must be managed carefully.

### Non-goals
- No new backend contact workflow in this pass unless already available.
- No redesign of the shared header or footer systems.
- No unrelated storefront navigation cleanup beyond what the contact page directly needs.
- No refactor of homepage WhatsApp implementation.

## Definition Of Done
- `StoreWebsite/contact.html` is confirmed as the evolved target page.
- The new contact page uses a parity-rich storefront shell aligned with `story.html`.
- The page contains:
  - hero/contact intro
  - contact methods grid
  - contact form
  - hours/address section
  - footer
- WhatsApp reuses the homepage CTA implementation pattern safely.
- Shared header, cart drawer, cart badge, and favorites dependencies are planned for parity.
- Placeholder business info is easy to replace later.
- The form path is explicitly scoped to a safe initial implementation.
- The page direction remains premium, dark, minimal, and consistent with OG.

## Verification Hook
### 1. Contact page concept review summary
`StoreWebsite/contact.html` is the correct page to evolve, but it is currently a legacy story-style page with incomplete storefront parity. The contact-page concept is strong if it stays direct, minimal, and concierge-oriented.

### 2. Recommended improvements
- Upgrade `contact.html` to the same shared storefront baseline as `story.html`.
- Keep the approved section order.
- Add a concise trust note without creating another full section.
- Reuse the homepage WhatsApp CTA contract exactly where possible.
- Keep the form simple and clearly scoped if no backend exists.

### 3. Final approved section order
1. Hero / contact intro
2. Contact methods grid
3. Contact form
4. Hours + address / visit information
5. Footer

### 4. WhatsApp reuse confirmation
Reuse the existing `index.html` WhatsApp anchor pattern:
- href: `https://chat.whatsapp.com/EnxoVssJepu7CRySrvMX02`
- classes: `primary-cta familia-cta`
- behavior: standard external link with `target="_blank"` and `rel="noopener noreferrer"`

### 5. Shared dependencies confirmed in current `contact.html`
- CSS:
  - `index.css`
  - `og.header.css`
  - `story.css`
- JS:
  - `og.header.js`
- Shared components present:
  - header mount
  - inline footer
- Shared parity dependencies currently missing:
  - Supabase/init baseline
  - cart drawer CSS/JS/config/markup
  - cart badge updater
  - favorites shared CSS/JS/services

### 6. Markdown document path created
`/docs/CONTACT_PAGE_PLAN.md`

### 7. Status
Planning is complete and ready for implementation.
