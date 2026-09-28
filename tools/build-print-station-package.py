"""Build the public Windows helper ZIP from an explicit allowlist, with reproducible bytes."""
from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parents[1]
files = ('Install-Print-Station.cmd', 'install-print-station.ps1', 'print-station-agent.cjs',
         'dymo-web-service-print.js', 'station-public-config.json', 'PRINT-STATION-README.txt',
         'Diagnose-Print-Station.cmd')
config = json.loads((root / 'tools/station-public-config.json').read_text(encoding='utf-8-sig'))
# Only the site's existing public browser configuration belongs in the download.
import base64
payload = json.loads(base64.urlsafe_b64decode(config['anonKey'].split('.')[1] + '==='))
assert payload['role'] == 'anon', 'Never package a privileged API key'
assert config['anonKey'] in (root / 'initSupabase.js').read_text(encoding='utf-8-sig')
assert config['url'] == 'https://byhytmarmigalvawkedi.supabase.co'
target = root / 'downloads/Invsto-Print-Station-Windows.zip'
target.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for name in files:
        data = (root / 'tools' / name).read_bytes()
        info = zipfile.ZipInfo(name, date_time=(2026, 9, 27, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        archive.writestr(info, data)
with zipfile.ZipFile(target) as archive:
    assert set(archive.namelist()) == set(files)
    assert archive.testzip() is None
    for name in files:
        assert archive.read(name) == (root / 'tools' / name).read_bytes()
print(f'{target.name}: {target.stat().st_size} bytes; SHA256 {hashlib.sha256(target.read_bytes()).hexdigest()}')
