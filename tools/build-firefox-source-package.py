"""Build the reproducible source archive required for Mozilla add-on review."""
from pathlib import Path
import hashlib
import zipfile

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / 'tools' / 'ebay-og-order-link-extension'
package = ROOT / 'downloads' / 'OG-Order-Link-Firefox-unsigned.zip'
paths = [ROOT / 'tools' / 'build-firefox-order-link-package.py',
         ROOT / 'tools' / 'firefox-order-link.md', ROOT / 'weekly-ebay-claims.js']
paths += sorted(p for p in EXTENSION.iterdir() if p.suffix in ('.js', '.html', '.css', '.json', '.md'))
readme = '''# OG Order Link Firefox — reviewer build instructions

The extension is plain JavaScript, HTML and CSS. A Python script mechanically
converts the Chromium manifest/background entry points and wraps extension API
scripts to use Firefox's Promise-based browser namespace. It does not minify,
obfuscate, bundle third-party libraries, or download dependencies.

Build environment used: Windows 11 x64, Python 3.14.2, standard library only.
The build also runs on Linux/macOS with Python 3.10 or newer. Python is available
at https://www.python.org/downloads/ or via the operating system package manager.
No Node/npm environment, credentials, API keys, or network access is needed.

From the directory containing this README, run:

    python3 tools/build-firefox-order-link-package.py --output build

On Windows, use `python` if `python3` is not installed. Output:
`build/OG-Order-Link-Firefox-unsigned.zip`.

The archive uses deterministic file metadata. Its expected SHA-256 is:
''' + hashlib.sha256(package.read_bytes()).hexdigest() + '''

The shared source directory includes worker.js for the Chromium background list;
the Firefox build creates background.scripts and does not package worker.js.
weekly-ebay-claims.js is copied into the package as claim-export.js.

This is an internal Invsto marketplace-order integration, intended for unlisted
self-distribution. Users sign in to their own marketplace and Invsto accounts.
The configured Invsto URL receives selected order/shipping/receipt evidence.
The package contains no user sessions or credentials. Window receipt capture
uses an explicit browser chooser, checks four temporary corner markers, crops
locally, stops the stream, and requires confirmation of the cropped preview.
Only the cropped JPEG is delivered to the authenticated Invsto workspace.
'''

destination = ROOT / 'downloads' / 'OG-Order-Link-Firefox-source.zip'
files = {p.relative_to(ROOT).as_posix(): p.read_bytes() for p in paths}
files['REVIEWER-README.md'] = readme.encode('utf-8')
with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name, data in sorted(files.items()):
        info = zipfile.ZipInfo(name, date_time=(2026, 11, 16, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, data)
print(destination)
print('SHA-256:', hashlib.sha256(destination.read_bytes()).hexdigest())
