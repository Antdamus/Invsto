# OG Order Link for Firefox

This is a Firefox compatibility build of the shared OG eBay Order Link extension.
It includes the existing TikTok receipt capture and Invsto delivery workflow.
The Firefox package is built separately from the Edge/Chrome ZIP. Version 1.0.35
adds a window-capture fallback for video surfaces missing from tab screenshots.
Version 1.0.36 strengthens the blank-frame check for centered play icons.
Version 1.0.34 added the receipt-launch bridge shared by both builds.

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

If the normal capture reports a blank frame while the item is visible, use
**Capture from window**. Choose the Firefox window showing the receipt (or that
screen if window capture also omits the video). Four temporary corner markers
verify and crop the selected surface to this receipt. Full-window pixels stay
in memory on the computer; only the cropped JPEG can be sent to Invsto. Sharing
stops before the review dialog appears. Check the preview, then choose **Save
photo to OG**. Cancel, missing markers, changed receipt identity/time/geometry,
and blank frames do not upload a photo. No additional persistent extension
permission is added; the browser asks for a screen/window choice each time.

Firefox's Media Engine DcompSurfaceImage cannot provide a source surface for
ordinary screenshot readback:
https://raw.githubusercontent.com/mozilla-firefox/firefox/main/gfx/layers/DcompSurfaceImage.h

## Permanent installation

Version 1.0.36 was approved and signed by Mozilla for **On your own** distribution.
Download `downloads/OG-Order-Link-Firefox.xpi`. In Firefox's Add-ons Manager,
choose the gear menu, **Install Add-on From File**, and select the XPI. Review
Firefox's permissions to finish. This installation persists across restarts.
The signed package must be copied unchanged; modifying it invalidates signing.

For later releases, submit the new unsigned ZIP and reproducible source archive
to Mozilla Add-ons using **On your own** distribution, then publish the signed
XPI and its `downloads/og-firefox-order-link-release.json` metadata together.
Do not disable signature checks. A temporary add-on is not a permanent deployment.
The stable add-on ID is `og-order-link@invsto.app`; retain it for later versions.
Firefox builds must be signed again after updates. Invsto's update panel selects
the signed XPI for Firefox and the separate ZIP for Edge/Chrome. Updates remain
manual; the extension has no automatic update URL.

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
