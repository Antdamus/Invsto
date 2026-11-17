# OG Order Link for Firefox

This is a Firefox compatibility build of the shared OG eBay Order Link extension.
It includes the existing TikTok receipt capture and Invsto delivery workflow.
The Firefox package is built separately from the Edge/Chrome ZIP. Version 1.0.34
adds a receipt-launch bridge shared by both builds; existing capture behavior is
preserved.

## Build

Run `python tools/build-firefox-order-link-package.py`. The unsigned test/signing
ZIP and its SHA-256 metadata are written to `output/firefox-order-link`.
The build takes the background script list from the shared worker and binds the
existing Promise-based API calls to Firefox's `browser` namespace. Page-world
scripts that do not use extension APIs are copied unchanged.

## Test installation

In Firefox, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary
Add-on**, and select the unsigned ZIP. This installation is for testing only and
is removed when Firefox restarts. Set the extension's OG Pending Orders URL to
`https://antdamus.github.io/Invsto/pending-orders.html`, then refresh TikTok and
Invsto. Both tabs must be open and signed in within the same Firefox profile.

For the affected store laptop, TikTok playback was verified with
`media.wmf.media-engine.enabled` set to `1` in `about:config`, followed by a normal
Firefox restart. Its original value was `2`. This setting does not prove which
decoder Windows Media Engine uses internally.

Verify the actual end-to-end flow before calling the Firefox build operational:

1. Open the matching TikTok receipt from Invsto.
2. Confirm video playback, seeking and the displayed order/SKU.
3. Pause on the correct item and click **Capture item photo → OG**.
4. Confirm Invsto saves the image to the correct order line and returns to it.
5. Reopen the saved image and verify the frame and item association.

## Permanent installation

Submit the ZIP to Mozilla Add-ons for signing using **On your own** distribution
if this is an internal extension. Install the signed XPI returned by Mozilla.
Do not disable signature checks. A temporary add-on is not a permanent deployment.
The stable add-on ID is `og-order-link@invsto.app`; retain it for later versions.
Firefox builds must be signed again after updates. The existing Invsto update
panel currently distributes the Edge/Chrome ZIP, not a signed Firefox XPI.

## TikTok receipt browser setting

In the TikTok workspace, **Receipt settings** offers Current browser, Microsoft
Edge, or Firefox on Windows. The choice is stored locally in that browser profile;
other computers and marketplace workflows are unaffected. Phones use the current
browser. Microsoft Edge opens through Windows' `microsoft-edge:` handler.

Opening Firefox from another browser requires the small Windows receipt opener
in `downloads/Invsto-Receipt-Opener.zip`. It accepts only numeric TikTok order/SKU
IDs and opens the fixed Invsto receipt-launch page. The Firefox extension reuses
an existing ready TikTok workspace or opens one before launching the exact receipt.
If sign-in is needed, complete it in Firefox and retry the launch page. Invsto and
TikTok sessions are not copied across browsers. Photos save into the shared
Invsto database through the normal signed-in Firefox workspace.

The extension relays selected order details, shipping documents, receipt images
and related evidence to the configured Invsto site. Its Firefox data declaration
covers website content, identifying details, financial information and messages
that can occur in those records. It uses the user's existing Invsto session; it
does not package credentials or copy an Edge browser profile.

References:
- https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background
- https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/
- https://extensionworkshop.com/documentation/publish/submitting-an-add-on/
