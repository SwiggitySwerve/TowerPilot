"""Offline installed-package qualification; no server, browser, adb or emulator.

The bundled interpreter imports the application and exercises Flask in-process.
This checks installation, not tray integration or a live game. Reports are evidence
summaries, not signatures; validate_acceptance independently repeats qualification.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PureWindowsPath
import subprocess
import tempfile
import zipfile

import check_release_zips

CHECKS = ('archive', 'imports', 'identity', 'app', 'config', 'unchanged')

# Run only inside the extracted package, under its private interpreter. Refuse
# network and process creation before importing application or dependency code.
PROBE = r'''
import sys
def offline(event, args):
    # platform.uname reads the local hostname; it does not open a connection.
    if (event.startswith('socket.') and event != 'socket.gethostname') or event in ('subprocess.Popen', 'os.system', 'os.startfile'):
        raise RuntimeError('qualification refused I/O: ' + event)
sys.addaudithook(offline)
import json
from pathlib import Path
root = Path.cwd()
config = root / 'backend/config.yaml'
assert not config.exists(), 'extraction already configured'
import cv2, numpy, yaml, psutil, flask, pystray, PIL, UnityPy
import dashboard
assert Path(sys.executable).resolve() == (root / 'runtime/python.exe').resolve(), 'wrong interpreter'
client = dashboard.app.test_client()
dashboard.app.testing = True
identity = json.loads((root / 'release_identity.json').read_text(encoding='utf-8'))
response = client.get('/api/runtime')
assert response.status_code == 200, 'runtime route failed'
release = response.get_json()['release']
assert release['kind'] == 'portable-windows-x64', 'wrong release kind'
assert release['working_tree'] == 'clean', 'unclean build'
assert release['matches_source'] is True and release['matches_app_build'] is True, 'identity mismatch'
assert all(release[k] == v for k, v in identity.items()), 'runtime identity differs'
app = root / 'frontend/webui/app'
for name in ['index.html'] + [p.relative_to(app).as_posix() for p in app.rglob('*') if p.is_file()]:
    response = client.get('/ui/app/' + name)
    assert response.status_code == 200 and response.data == (app / name).read_bytes(), 'app not served: ' + name
assert client.get('/api/config').status_code == 200, 'config route failed'
assert config.read_bytes() == (root / 'backend/config.example.yaml').read_bytes(), 'seed differs'
print(json.dumps(dict(imports=True, identity=True, app=True, config=True)))
'''


def extract(archive: Path, destination: Path) -> Path:
    """Reject Windows aliases/traversal before writing any member."""
    prefix = archive.stem
    with zipfile.ZipFile(archive) as source:
        seen = set()
        for info in source.infolist():
            parts = info.filename.split('/')
            if (parts[0] != prefix or len(parts) < 2 or info.orig_filename != info.filename
                    or '\\' in info.filename
                    or any(not p or p in ('.', '..') or ':' in p or p.endswith(('.', ' '))
                           or PureWindowsPath(p).is_reserved() for p in parts)
                    or info.is_dir() or (info.external_attr >> 16) & 0o170000 == 0o120000
                    or info.filename.casefold() in seen):
                raise ValueError('unsafe or duplicate ZIP member: ' + info.filename)
            seen.add(info.filename.casefold())
        source.extractall(destination)
    return destination / prefix


def qualify(archive: Path) -> dict:
    """Return a complete success or explicit failure; always remove our extraction."""
    archive = Path(archive).resolve()
    report = dict(schema_version=1, archive_sha256=None, verdict='fail', checks={}, error=None)
    try:
        report['archive_sha256'] = hashlib.sha256(archive.read_bytes()).hexdigest()
        if check_release_zips.main(['--archive', str(archive), '--kind', 'portable']) != 0:
            raise ValueError('archive gate failed; nothing executed')
        report['checks']['archive'] = True
        with tempfile.TemporaryDirectory(prefix='Tower Pilot qualification ') as work:
            root = extract(archive, Path(work))
            before = {p.relative_to(root): hashlib.sha256(p.read_bytes()).digest()
                      for p in root.rglob('*') if p.is_file()}
            # A minimal inherited environment preserves only Windows loader inputs.
            # No system Python, user site, configured device or dashboard settings.
            env = {k: os.environ[k] for k in ('SystemRoot', 'WINDIR', 'TEMP', 'TMP') if k in os.environ}
            env.update(PATH=str(root / 'runtime'), PYTHONNOUSERSITE='1', TOWER_PILOT_PORT='0')
            result = subprocess.run([str(root / 'runtime/python.exe'), '-I', '-B', '-c', PROBE],
                                    cwd=root, env=env, capture_output=True, text=True, timeout=120,
                                    creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if result.returncode != 0:
                raise ValueError('bundled self-check failed: ' + result.stdout + result.stderr)
            lines = result.stdout.strip().splitlines()
            if not lines:
                raise ValueError('bundled self-check returned no evidence')
            checks = json.loads(lines[-1])
            if checks != dict(imports=True, identity=True, app=True, config=True):
                raise ValueError('bundled self-check returned incomplete evidence')
            report['checks'].update(checks)
            for name, digest in before.items():
                if hashlib.sha256((root / name).read_bytes()).digest() != digest:
                    raise ValueError('shipped file changed: ' + name.as_posix())
            report['checks']['unchanged'] = True
        report['verdict'] = 'pass'
    except (OSError, ValueError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        report['error'] = str(error)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args(argv)
    if args.report.resolve() in (args.archive.resolve(), args.archive.with_suffix('.zip.sha256').resolve()):
        parser.error('report must not overwrite archive or sidecar')
    report = qualify(args.archive)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(report['verdict'] + (': ' + report['error'] if report['error'] else ''))
    return 0 if report['verdict'] == 'pass' else 1


if __name__ == '__main__':
    raise SystemExit(main())
