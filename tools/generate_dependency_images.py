"""Regenerate dependency_images.json from hash-verified portable input artifacts.

Run: python tools/generate_dependency_images.py --archive dist/<portable.zip>
Downloads go into a TemporaryDirectory, never the checkout. Wheels are inspected
without importing or executing them. The pinned tpk_ar sdist is inspected too;
an sdist image requires a reviewed built wheel before it can be allowed.
"""
import argparse
import hashlib
import json
import tarfile
import tempfile
import urllib.request
import zipfile
from collections.abc import Mapping
from pathlib import Path, PurePosixPath

from release_archive_policy import pins_digest


def _verified_download(artifact: dict, directory: Path) -> Path:
    path = directory / artifact['filename']
    if not path.exists():
        urllib.request.urlretrieve(artifact['url'], path)
    if hashlib.sha256(path.read_bytes()).hexdigest() != artifact['sha256']:
        raise ValueError(f"Pinned artifact hash mismatch: {artifact['filename']}")
    return path


def generate(pins_path: Path, artifact_dir: Path,
             installed: Mapping[str, bytes] | None = None) -> dict[str, object]:
    """Inspect every pinned input, refusing bytes that disagree with its pin."""
    pins_bytes = pins_path.read_bytes()
    pins = json.loads(pins_bytes)
    images = []
    files = {}
    inspected = []
    source_metadata = []
    for row in pins['packages']:
        package, version = row['requirement'].split('==')
        artifact, = row['artifacts']
        filename = artifact['filename']
        path = _verified_download(artifact, artifact_dir)
        digest = artifact['sha256']
        count = 0
        if filename.endswith('.whl'):
            members = {}
            with zipfile.ZipFile(path) as wheel:
                for name in sorted(wheel.namelist()):
                    if name.endswith('/'):
                        continue
                    parts = name.split('/')
                    # Wheel .data/{purelib,platlib} files relocate into site-packages.
                    if parts[0].endswith('.data'):
                        if len(parts) < 3 or parts[1] not in {'purelib', 'platlib'}:
                            if PurePosixPath(name).suffix.lower() == '.png':
                                raise ValueError(f'Image outside wheel site-packages: {filename}')
                            continue
                        relative = '/'.join(parts[2:])
                    else:
                        relative = name
                    installed_path = 'runtime/Lib/site-packages/' + relative
                    member_hash = hashlib.sha256(wheel.read(name)).hexdigest()
                    # pip creates these files; they cannot establish installed provenance.
                    if (PurePosixPath(relative).name not in {'RECORD', 'INSTALLER'}
                            and PurePosixPath(relative).suffix.lower() != '.pyc'):
                        members[installed_path] = member_hash
                    if PurePosixPath(name).suffix.lower() != '.png':
                        continue
                    images.append({
                        'path': installed_path,
                        'sha256': member_hash,
                        'package': package, 'version': version,
                        'wheel': filename, 'wheel_sha256': digest, 'wheel_path': name,
                    })
                    count += 1
            files[filename] = members
        else:
            with tarfile.open(path) as source:
                if any(PurePosixPath(member.name).suffix.lower() == '.png'
                       for member in source.getmembers()):
                    raise ValueError(f'Source image needs a reviewed built wheel: {filename}')
                if installed is not None:
                    member, = [m for m in source.getmembers()
                               if len(m.name.split('/')) == 2 and m.name.endswith('/PKG-INFO')
                               and m.isfile()]
                    original = source.extractfile(member).read()
                    name = ('runtime/Lib/site-packages/' + package.replace('-', '_')
                            + '-' + version + '.dist-info/METADATA')
                    data = installed.get(name)
                    if data is None or data.replace(b'\r\n', b'\n') != original.replace(b'\r\n', b'\n'):
                        raise ValueError(f'Installed source metadata differs from pinned PKG-INFO: {filename}')
                    source_metadata.append({
                        'path': name, 'sha256': hashlib.sha256(data).hexdigest(),
                        'artifact': filename, 'artifact_sha256': digest,
                        'source_member': member.name, 'verified_as': 'sdist-pkg-info-crlf-to-lf',
                    })
        inspected.append({'requirement': row['requirement'], 'filename': filename,
                          'sha256': digest, 'png_count': count})
        print(f'{filename}: verified, {count} PNGs')
    python_license = None
    if 'python' in pins:
        artifact = pins['python']
        with zipfile.ZipFile(_verified_download(artifact, artifact_dir)) as runtime:
            data = runtime.read('LICENSE.txt')
        python_license = {
            'path': 'runtime/LICENSE.txt', 'sha256': hashlib.sha256(data).hexdigest(),
            'artifact': artifact['filename'], 'artifact_sha256': artifact['sha256'],
            'source_member': 'LICENSE.txt', 'verified_as': 'exact-member',
        }
    return {
        'schema_version': 1,
        'generation': {
            'command': 'python tools/generate_dependency_images.py --archive dist/<portable.zip>',
            'method': 'Download every pinned artifact into a temporary directory; verify '
                      'SHA-256 before inspecting wheel members and the source-build exception. '
                      'Member hashes cover exact uncompressed bytes at installed paths; no images '
                      'are stored in the repository.',
            'pins_sha256': pins_digest(pins_bytes),
        },
        'inspected_artifacts': inspected,
        'images': sorted(images, key=lambda image: image['path']),
        'files': files,
        'source_metadata': source_metadata,
        'python_license': python_license,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    directory = Path(__file__).resolve().parent
    parser.add_argument('--pins', type=Path, default=directory / 'portable_pins.json')
    parser.add_argument('--output', type=Path, default=directory / 'dependency_images.json')
    parser.add_argument('--archive', type=Path, help='portable ZIP supplying installed source-built METADATA')
    args = parser.parse_args()
    installed = None
    if args.archive:
        with zipfile.ZipFile(args.archive) as archive:
            installed = {name.split('/', 1)[1]: archive.read(name)
                         for name in archive.namelist() if name.endswith('.dist-info/METADATA')}
    with tempfile.TemporaryDirectory(prefix='dependency-images-') as work:
        manifest = generate(args.pins, Path(work), installed)
    args.output.write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
