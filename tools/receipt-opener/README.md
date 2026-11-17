# Invsto Firefox receipt opener

Build with `python tools/build-receipt-opener-package.py`. The ZIP contains a
Windows .NET Framework executable and this readme. No external runtime download
is required on Windows 11. The executable is not Authenticode-signed.

Extract the ZIP and open `InvstoReceiptOpener.exe`. Review the Windows prompts
yourself, then choose OK in the install confirmation. The opener is copied into
`%LOCALAPPDATA%\InvstoReceiptOpener` and the `invsto-receipt` URL scheme is
registered under `HKCU\Software\Classes`. Administrator privileges and a change
of default browser are not required. There is no background service.

In Invsto's TikTok workspace, open **Receipt settings** and select **Firefox**.
Install the signed Firefox build of OG Order Link and configure its Pending
Orders URL. Sign in to Invsto and TikTok in Firefox. The opener goes to a fixed
Invsto handoff page. The extension reuses a ready Invsto TikTok workspace or opens
one before opening the matching TikTok order/item receipt. Captures return to that
Firefox workspace and save to the normal shared Invsto database.

Only `invsto-receipt://tiktok/?order=<10–24 digits>&sku=<10–24 digits>` is accepted.
SKU is optional. Extra keys, duplicate keys, credentials, custom ports, fragments,
arbitrary URLs, executable paths and command arguments are rejected. Order and SKU
values remain strings. No cookies, passwords or session tokens pass between
browsers. The handler only launches an installed `firefox.exe` with a canonical
HTTPS URL on `antdamus.github.io/Invsto/tiktok-receipt-launch.html`.

For rollback, choose **Current browser** in Receipt settings. To fully uninstall,
remove the current user's `HKCU\Software\Classes\invsto-receipt` key and the
`%LOCALAPPDATA%\InvstoReceiptOpener` folder after checking their exact paths.

Firefox temporary add-ons disappear after a restart. The permanent setup requires
Mozilla to sign the extension; a prepared unsigned ZIP is not a completed install.
