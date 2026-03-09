# STORY_PAGE_REDESIGN_PLAN

## Objective
Refine the existing `StoreWebsite/story.html` into a premium heritage brand page for OG Jewelers that communicates four-generation expertise, Venezuelan roots, direct-source philosophy, Miami Diamond District identity, craftsmanship, trust, and founder presence.

## Brand Direction
- Tone: 80% luxury heritage, 20% Miami energy.
- Positioning: Luxury boutique jewelry brand.
- Typography: `Cormorant Garamond` for editorial headlines, `Inter` for body and utility copy.
- Experience principle: Editorial, premium, minimal, and credible.

## Current Technical Baseline (Audit)
### Loaded CSS in `story.html`
- `StoreWebsite/catalogue.css`
- `StoreWebsite/og.header.css`
- `StoreWebsite/story.css`
- `StoreWebsite/StoreCart/cart.drawer.css`
- `StoreWebsite/Favorites/favorites.shared.css`

### Loaded JS in `story.html`
- `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2`
- `StoreWebsite/initSupabase.js`
- `StoreWebsite/StoreCart/cart.shared.js`
- Inline config block setting `window.OG_CART_DRAWER_CFG`
- `StoreWebsite/StoreCart/cart.drawer.js`
- `StoreWebsite/StoreCart/cart.service.global.js` (module)
- `StoreWebsite/Favorites/favorites.service.global.js` (module)
- `StoreWebsite/Favorites/favorites.shared.js`
- `StoreWebsite/og.header.js`

### Shared Layout Components
- Header mount point exists: `#ogHeaderMount`.
- Header/nav/menu are injected by `og.header.js`.
- Cart icon and badge UI are injected by `og.header.js` and painted by `cart.shared.js`.
- No footer is currently rendered in `story.html`.

### Layout/Animation Scripts Impacting `story.html`
- `og.header.js`: sticky/elevated header state, mobile nav drawer open/close, search focus behavior, account menu toggle, spot ticker polling.
- `cart.drawer.js`: intercepts `[data-action="open-cart-drawer"]` clicks; expects cart drawer DOM nodes and manages open/close animation/timers.
- `favorites.shared.js`: delegated click handling and repaint loop for favorite toggles (currently no favorite toggles on page content).

### Inherited Dependencies from `catalogue.css` and shared styles
- Global reset and body defaults (`*`, `html/body`, `body`, `a`).
- Shared layout helper `.container` used by story sections.
- Shared utility patterns (`.btn`, `.site-header`, `.nav-link`, `.skip-link`, `.lock`) overlap with `og.header.css`/`story.css`.
- `story.css` overrides many visual styles, but still depends on `.container` width behavior and overall token consistency.

### JS Logic Currently Tied to `story.html`
- No story-specific script file exists.
- Functional behavior on this page is entirely inherited from shared header/cart/favorites scripts.
- Important caveat: `story.html` currently loads cart drawer scripts but does not include cart drawer markup (`data-ui="cart-drawer*"`), so drawer-open behavior should be validated during implementation.

## Dependency Map (Short)
`story.html` -> (`catalogue.css` + `og.header.css` + `story.css`) + (cart/favorites shared CSS)

`story.html` -> `og.header.js` -> injects header/nav/cart control + spot ticker + menu/account behavior

`story.html` -> `cart.shared.js` + `cart.service.global.js` + `cart.drawer.js` -> cart badge + drawer logic

`story.html` -> favorites shared modules -> favorites toggle behavior (currently unused by story content blocks)

## Section Structure (Approved)
1. Hero
2. Our Heritage (Venezuelan roots)
3. We Are the Source
4. Craftsmanship / Selection
5. Miami Diamond District
6. Client Philosophy
7. Founder Signature

## Narrative Content Plan
### 1) Hero
- One-line brand thesis: heritage authority + modern luxury confidence.
- Supporting copy: four generations, direct source, Miami context.
- Optional micro-fact row under hero: `4 Generations`, `Direct Source`, `Miami Diamond District`.

### 2) Our Heritage (Venezuelan roots)
- Origin story: family trade roots in Venezuela and migration of craft standards.
- Emphasize continuity of standards across generations.
- Add one short timeline strip with 3-4 milestones.

### 3) We Are the Source
- Explain direct relationships with suppliers and sourcing discipline.
- Distinguish from broad marketplace resellers.
- Use trust language around transparency, quality control, and value.

### 4) Craftsmanship / Selection
- Editorial statement on how pieces are selected.
- Pair with clean static jewelry cards (no heavy hover) from existing OG assets.
- Focus on material, setting, finish, and wearability criteria.

### 5) Miami Diamond District
- Position OG Jewelers inside Miami’s luxury ecosystem.
- Connect city pace/energy to curation and client service standards.
- Add visual block for Miami atmosphere (image-led, restrained overlays).

### 6) Client Philosophy
- Trust, discretion, long-term relationships, repeat clients.
- Include concise value strip: `Authenticity`, `Direct Access`, `Curated Selection`, `Personal Guidance`.

### 7) Founder Signature
- Founder section featuring Otello Guillen.
- Include a structured portrait placeholder card (fixed ratio) so a real photo can be dropped in later without layout change.
- Include signed-note style founder statement and name/title lockup.

## Visual Design Guidance
### Backgrounds
- Keep dark editorial base, soften current radial glow.
- Use subtle gold noise texture and low-contrast gradient bands for section rhythm.
- Alternate section surfaces between transparent-dark and matte-charcoal panels.

### Jewelry Card Grid
- Static cards only; minimal motion.
- 2-4 column responsive grid with consistent image aspect ratio.
- Card anatomy: image, piece name/category, one-line craftsmanship note.

### Miami Section Visuals
- Preferred image types:
  - Miami skyline at dusk/blue-hour (luxury context)
  - Downtown/Brickell night lights with reflective surfaces
  - Diamond District street/detail atmosphere shots
  - Optional warm sunset cityline as secondary image
- Style direction: cinematic, clean, no neon overload.

### Founder Section
- Two-column desktop / single-column mobile.
- Left: portrait placeholder block (e.g., 4:5 ratio, framed card).
- Right: founder narrative, signature quote, founder metadata.

### Value Strip / Trust Signals
- Horizontal strip with 4 trust pillars and subtle icon markers.
- Keep high legibility, low ornamentation.

### Motion / Reveal Effects
- Use only subtle on-scroll reveals (fade + 10-16px translate).
- No parallax-heavy behavior, no aggressive hover transforms.
- Respect `prefers-reduced-motion`.

## Typography Hierarchy
- H1: `Cormorant Garamond`, high-contrast editorial scale.
- H2: `Cormorant Garamond`, slightly tighter line height.
- Body: `Inter` for readability and trust tone.
- Kicker/labels: `Inter` uppercase with increased letter spacing.
- Founder signature line: serif style with elevated tracking.

## Layout System
- Keep existing `.container` rhythm for consistency.
- Section spacing: generous desktop cadence, tightened mobile cadence.
- Use modular blocks:
  - Editorial text block
  - Visual media block
  - Card grid block
  - Value strip block
- Maintain current responsive behavior and avoid introducing framework dependencies.

## Image Requirements
### Existing Jewelry Images (now)
- Reuse currently available OG jewelry images already in repo/runtime usage.
- Normalize crop ratios for a cohesive grid.

### Miami Images (later drop-in)
- 3-5 high-res images:
  - 1 hero-scale skyline
  - 2 district/streetscape context
  - 1-2 supporting atmosphere images

### Founder Image (later drop-in)
- One high-resolution portrait, 4:5 preferred.
- Keep placeholder dimensions identical to final image container.

## Recommended Asset Folder Location
Current `StoreWebsite` structure does not show a dedicated local `assets/` directory tree in place. Recommended structure:
- `StoreWebsite/assets/story/hero/`
- `StoreWebsite/assets/story/jewelry/`
- `StoreWebsite/assets/story/miami/`
- `StoreWebsite/assets/story/founder/`

This keeps story assets isolated, predictable, and aligned with existing relative path usage in `story.html`.

## Implementation Steps
1. Confirm and lock final section copy outlines for all seven sections.
2. Refactor `StoreWebsite/story.html` content blocks to the approved section order and semantic headings.
3. Add new section scaffolds: Heritage, Source, Craftsmanship grid, Miami, Client Philosophy, Founder Signature.
4. Add founder portrait placeholder block with fixed aspect ratio and future image slot.
5. Replace current generic story text with heritage-led editorial copy.
6. Update `StoreWebsite/story.css` to support section-specific layouts, value strip, jewelry card grid, and subtle reveals.
7. Keep shared header integration intact (`#ogHeaderMount`, `og.header.js`) and avoid global regressions.
8. Add the canonical cart drawer DOM block to `StoreWebsite/story.html` (match `index.html`/`catalogue.html` structure and `data-ui`/`data-action` hooks) so shared cart scripts function correctly.
9. Validate cart icon and drawer behavior on story page; confirm open/close, subtotal/count rendering, and navigation behavior with current shared scripts.
10. Add the canonical `site-footer` block used in `StoreWebsite/index.html`/`StoreWebsite/catalogue.html` to `StoreWebsite/story.html` (reuse structure, do not redesign), and ensure key links stay consistent with storefront navigation (`contact.html`, shop/catalogue destination) plus copyright line.
11. Add placeholder image references to proposed story asset paths (without requiring final Miami downloads yet).
12. Run responsive QA (mobile/tablet/desktop) and reduced-motion QA.
13. Final content pass for luxury tone consistency and factual messaging.

## Asset Requirements
- Jewelry images: existing OG inventory visuals or current local story-safe images.
- Miami set: skyline + district + atmosphere set (to be added later).
- Founder portrait: final photography pending; use placeholder until delivered.
- Optional subtle texture overlay (single lightweight image) if needed for premium depth.

## Risks / Non-Goals
### Risks
- Current shared cart drawer scripts may not fully function in `story.html` without cart drawer markup; verify behavior during implementation.
- Legacy docs are partially stale; rely on current file behavior first.
- Missing/placeholder assets can weaken perceived premium tone until replaced.

### Non-Goals
- No new page creation.
- No broad storefront refactor.
- No cart/favorites architecture changes beyond story-page compatibility checks.

## Definition of Done
- `StoreWebsite/story.html` is updated (not replaced by a new page) with the approved seven-section narrative.
- Page visually communicates heritage luxury with Miami context and founder presence.
- Founder section includes a photo placeholder that supports future drop-in with no layout rework.
- Jewelry cards are clean/static and premium.
- Miami section is structured for future image insertion.
- Typography and spacing align with OG visual language.
- Mobile and desktop layouts are stable and readable.
- Story page planning is complete and implementation-ready.
- Story page includes the canonical storefront footer structure and consistent core footer links.
