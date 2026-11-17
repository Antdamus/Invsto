"""Compile and package the narrowly scoped Windows Firefox receipt opener."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'tools' / 'receipt-opener'
OUTPUT = ROOT / 'output' / 'receipt-opener'


if __name__ == '__main__':
    compiler = Path(os.environ.get('WINDIR', r'C:\Windows')) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    if not compiler.is_file():
        raise SystemExit('Build on Windows with the .NET Framework C# compiler installed.')
    OUTPUT.mkdir(parents=True, exist_ok=True)
    executable = OUTPUT / 'InvstoReceiptOpener.exe'
    subprocess.run([str(compiler), '/nologo', '/target:winexe', '/optimize+',
                    '/reference:System.Windows.Forms.dll', '/reference:System.Web.dll',
                    '/out:' + str(executable), str(SOURCE / 'ReceiptOpener.cs')], check=True)
    archive_path = ROOT / 'downloads' / 'Invsto-Receipt-Opener.zip'
    with zipfile.ZipFile(archive_path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        archive.write(executable, executable.name)
        archive.write(SOURCE / 'README.md', 'README.md')
    metadata = {'version': '1.0.0', 'sha256': hashlib.sha256(archive_path.read_bytes()).hexdigest(),
                'executable_sha256': hashlib.sha256(executable.read_bytes()).hexdigest(), 'authenticode_signed': False}
    (OUTPUT / 'package.json').write_text(json.dumps(metadata, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'archive': str(archive_path), **metadata}, indent=2))
