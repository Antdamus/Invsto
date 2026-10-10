"""Package the public eBay label capture extension from its explicit source files."""
from pathlib import Path
import hashlib
import json
import zipfile
root=Path(__file__).resolve().parents[1]
folder=root/'tools/ebay-og-order-link-extension'
files=('manifest.json','background.js','content.js','app-bridge.js','shipping-combine-policy.js','shipping-combine-guard.js','label-capture-probe.js','report-capture-probe.js','options.html','options.js','README.md')
with zipfile.ZipFile(root/'downloads/OG-eBay-Order-Link.zip','w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
 for name in files:
  info=zipfile.ZipInfo(name,date_time=(2026,9,29,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o644<<16
  archive.writestr(info,(folder/name).read_bytes())
manifest = json.loads((folder/'manifest.json').read_text(encoding='utf-8'))
release = {
 'name': manifest['name'],
 'version': manifest['version'],
 'sha256': hashlib.sha256((root/'downloads/OG-eBay-Order-Link.zip').read_bytes()).hexdigest(),
}
(root/'downloads/og-ebay-order-link-release.json').write_text(
 json.dumps(release, indent=2) + '\n', encoding='utf-8'
)
print(f"Built OG-eBay-Order-Link.zip and release metadata ({manifest['version']})")
