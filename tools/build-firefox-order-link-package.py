"""Build a Firefox test/signing package without changing the Edge release."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'tools' / 'ebay-og-order-link-extension'
ADDON_ID = 'og-order-link@invsto.app'


def firefox_script(source):
    # Firefox's browser namespace provides the Promise APIs the shared code uses.
    # Bind it locally: do not modify browser globals or rewrite strings/page code.
    if re.search(r'\bchrome\.', source):
        return ('// Firefox API binding; generated from the shared extension source.\n'
                '(function (chrome) {\n' + source + '\n})(globalThis.browser);\n')
    return source


def build(output):
    manifest = json.loads((SOURCE / 'manifest.json').read_text(encoding='utf-8'))
    worker = (SOURCE / manifest['background']['service_worker']).read_text(encoding='utf-8')
    scripts = []
    for arguments in re.findall(r'importScripts\(([^)]*)\)', worker):
        scripts.extend(re.findall(r"['\"]([^'\"]+\.js)['\"]", arguments))
    if not scripts:
        raise ValueError('No background scripts found; review the shared worker before building.')
    manifest['background'] = {'scripts': scripts}
    manifest['browser_specific_settings'] = {'gecko': {
        'id': ADDON_ID,
        'strict_min_version': '142.0',
        'data_collection_permissions': {'required': [
            'websiteContent', 'personallyIdentifyingInfo',
            'financialAndPaymentInfo', 'personalCommunications'
        ]}
    }}

    files = {}
    for path in sorted(SOURCE.iterdir()):
        if path.name == 'worker.js' or path.suffix not in ('.js', '.html', '.css'):
            continue
        text = path.read_text(encoding='utf-8')
        if path.name == 'claim-export.js':
            text = (ROOT / 'weekly-ebay-claims.js').read_text(encoding='utf-8')
        files[path.name] = firefox_script(text) if path.suffix == '.js' else text
    files['manifest.json'] = json.dumps(manifest, indent=2) + '\n'
    files['README-FIREFOX.md'] = (ROOT / 'tools' / 'firefox-order-link.md').read_text(encoding='utf-8')

    required = set(scripts)
    required.add(manifest['options_page'])
    required.add(manifest['action']['default_popup'])
    for entry in manifest['content_scripts']:
        required.update(entry.get('js', []))
        required.update(entry.get('css', []))
    for entry in manifest.get('web_accessible_resources', []):
        required.update(entry['resources'])
    missing = required - files.keys()
    if missing:
        raise ValueError(f'Missing extension files: {sorted(missing)}')

    output.mkdir(parents=True, exist_ok=True)
    archive_path = output / 'OG-Order-Link-Firefox-unsigned.zip'
    with zipfile.ZipFile(archive_path, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, content in sorted(files.items()):
            info = zipfile.ZipInfo(name, date_time=(2026, 11, 16, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, content.encode('utf-8'))
    metadata = {
        'name': manifest['name'], 'version': manifest['version'],
        'browser': 'Firefox', 'signed': False, 'addon_id': ADDON_ID,
        'sha256': hashlib.sha256(archive_path.read_bytes()).hexdigest(),
        'files': len(files), 'background_scripts': scripts,
    }
    (output / 'firefox-package.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'archive': str(archive_path), **metadata}, indent=2))
    return archive_path


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'output' / 'firefox-order-link')
    build(parser.parse_args().output.resolve())
