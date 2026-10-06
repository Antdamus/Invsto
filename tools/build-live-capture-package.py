"""Build the public Live Capture extension from its explicit source files."""
from pathlib import Path
import zipfile
root=Path(__file__).resolve().parents[1]
folder=root/'tools/ebay-live-capture'
files=('manifest.json','worker.js','parser.js','bag-label.js','capture.js','receiver.js','listing.js','README.md')
with zipfile.ZipFile(root/'downloads/Invsto-Live-Capture.zip','w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
 for name in files:
  info=zipfile.ZipInfo(name,date_time=(2026,9,29,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o644<<16
  archive.writestr(info,(folder/name).read_bytes())
print('Built Invsto-Live-Capture.zip')
