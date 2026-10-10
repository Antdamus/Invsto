# Client catalogue hosting

Client share links use `https://www.og-jewelers.com/private-catalogue#<share_token>`.
The token stays in the fragment; it is not sent to the static website host.
The client calls the curated `storefront-catalog?catalogue=<share_token>` endpoint,
which returns the explicitly selected client fields and chosen retail price only.

Cloudflare Pages project `invsto` serves `www.og-jewelers.com` from production
branch **initialaunch**, root **StoreWebsite**, build command `exit 0`, output `.`.
The **JoinPage** branch serves the staff Invsto app through GitHub Pages. Its
Cloudflare builds are previews, not the branded website's production deployment.

`node tools/build-client-catalogue.mjs` generates the client-only
`StoreWebsite/private-catalogue.html` shell. It references versioned public
catalogue CSS and JavaScript from Invsto's GitHub Pages deployment. No staff
authentication scripts or inventory management pages are included in that shell.

When changing the shell or its versioned asset URLs, deploy the assets to JoinPage,
then copy only the generated shell into an isolated checkout of initialaunch and
publish that change. Do not merge the full Invsto branch into the storefront.
Verify the branded page and its public API request before changing share links.

Staff previews intentionally remain on the same origin as the catalogue manager:
their postMessage exchange validates both opener and origin. Publishing a catalogue
is separate from previewing it. Existing GitHub catalogue links continue to work.
