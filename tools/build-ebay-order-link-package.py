"""Package the public eBay label capture extension from its explicit source files."""
from pathlib import Path
import zipfile
root=Path(__file__).resolve().parents[1]
folder=root/'tools/ebay-og-order-link-extension'
files=('manifest.json','background.js','content.js','app-bridge.js','label-capture-probe.js','report-capture-probe.js','options.html','options.js','README.md')
with zipfile.ZipFile(root/'downloads/OG-eBay-Order-Link.zip','w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
 for name in files:
  info=zipfile.ZipInfo(name,date_time=(2026,9,29,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o644<<16
  archive.writestr(info,(folder/name).read_bytes())
print('Built OG-eBay-Order-Link.zip')
