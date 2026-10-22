"""Check both finished release archives against their inventories and app build."""
import argparse
import hashlib
import re
import subprocess
import sys
import zipfile
from collections import Counter
from collections.abc import Mapping
from pathlib import Path, PurePosixPath

from build_release import APP_BUILD, ROOT, app_build_problems, release_files

FORBIDDEN_SEGMENTS = {'node_modules', 'test-results', 'playwright-report', 'coverage'}
FORBIDDEN_SUFFIXES = {'.map', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico',
                      '.svg', '.woff', '.woff2'}
# The portable ZIP's pip packages, written by build_portable. Werkzeug ships its debugger's
# PNGs there; a .png in this one folder of the portable ZIP is the only exemption from the
# rules below. Path segments and every other suffix are checked everywhere (R3-R2-06).
RUNTIME_PACKAGES = 'runtime/Lib/site-packages/'
RUNTIME_PACKAGE_SUFFIX = '.png'


def _inventory_problems(entries: Mapping[str, bytes]) -> list[str]:
    if 'SHA256SUMS.txt' not in entries:
        return ['missing SHA256SUMS.txt']
    problems = []
    listed: Counter[str] = Counter()
    try:
        lines = entries['SHA256SUMS.txt'].decode('utf-8').splitlines()
    except UnicodeDecodeError:
        return ['SHA256SUMS.txt is not UTF-8']
    for number, line in enumerate(lines, 1):
        match = re.fullmatch(r'([0-9a-fA-F]{64})  (.+)', line)
        if match is None:
            problems.append(f'SHA256SUMS.txt malformed line {number}')
            continue
        digest, name = match.groups()
        listed[name] += 1
        if name == 'SHA256SUMS.txt' or name not in entries:
            problems.append(f'SHA256SUMS.txt lists unexpected entry: {name}')
        elif hashlib.sha256(entries[name]).hexdigest() != digest.lower():
            problems.append(f'SHA256SUMS.txt hash mismatch: {name}')
    for name in sorted(set(entries) - {'SHA256SUMS.txt'}):
        if listed[name] != 1:
            problems.append(f'SHA256SUMS.txt must list {name} exactly once (found {listed[name]})')
    return problems


def _check_archive(path: Path, prefix: str, disk_build: Mapping[str, bytes],
                   app_sources: set[str], *, portable: bool = False) -> tuple[list[str], int]:
    problems = []
    sidecar = path.with_suffix('.zip.sha256')
    if not sidecar.is_file():
        problems.append(f'missing sidecar: {sidecar.name}')
    else:
        try:
            match = re.fullmatch(r'([0-9a-fA-F]{64})[ \t]+\*?(.+)', sidecar.read_text().strip())
            if match is None:
                problems.append(f'malformed sidecar: {sidecar.name}')
            else:
                digest, filename = match.groups()
                if filename != path.name:
                    problems.append(f'sidecar names {filename}, expected {path.name}')
                if path.is_file() and hashlib.sha256(path.read_bytes()).hexdigest() != digest.lower():
                    problems.append(f'sidecar hash mismatch: {sidecar.name}')
        except (OSError, UnicodeError) as error:
            problems.append(f'cannot read sidecar {sidecar.name}: {error}')
    if not path.is_file():
        return problems + [f'missing archive: {path.name}'], 0
    entries: dict[str, bytes] = {}
    count = 0
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            count = len(infos)
            for name, occurrences in Counter(info.filename for info in infos).items():
                if occurrences != 1:
                    problems.append(f'duplicate ZIP entry: {name}')
            for info in infos:
                name = info.filename
                parts = name.replace('\\', '/').split('/')
                suffix = PurePosixPath(name).suffix.lower()
                package_image = (portable and name.startswith(f'{prefix}/{RUNTIME_PACKAGES}')
                                 and suffix == RUNTIME_PACKAGE_SUFFIX)
                if FORBIDDEN_SEGMENTS.intersection(part.lower() for part in parts):
                    problems.append(f'forbidden path segment: {name}')
                if suffix in FORBIDDEN_SUFFIXES and not package_image:
                    problems.append(f'forbidden file suffix: {name}')
                if not name.startswith(prefix + '/'):
                    problems.append(f'entry outside expected prefix {prefix}/: {name}')
                    continue
                relative = name[len(prefix) + 1:]
                if '\\' in name or any(part in {'', '.', '..'} for part in relative.split('/')):
                    problems.append(f'invalid ZIP entry path: {name}')
                    continue
                if info.is_dir():
                    problems.append(f'unexpected directory entry: {name}')
                    continue
                entries[relative] = archive.read(info)
    except (OSError, zipfile.BadZipFile, RuntimeError, NotImplementedError) as error:
        return problems + [f'cannot read archive: {error}'], count
    problems.extend(_inventory_problems(entries))
    app_prefix = APP_BUILD + '/'
    app = {name[len(app_prefix):]: data for name, data in entries.items()
           if name.startswith(app_prefix)}
    problems.extend(f'{APP_BUILD}: {problem}' for problem in app_build_problems(app))
    for name in sorted(disk_build.keys() | app.keys()):
        if name not in app:
            problems.append(f'app build file missing from archive: {name}')
        elif name not in disk_build:
            problems.append(f'app build file absent from on-disk build: {name}')
        elif app[name] != disk_build[name]:
            problems.append(f'app build bytes differ from on-disk build: {name}')
    for name in sorted(app_sources - entries.keys()):
        problems.append(f'missing frontend/app source: {name}')
    return problems, count


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dist', type=Path, default=Path('dist'))
    parser.add_argument('--build-dir', type=Path, default=Path(APP_BUILD))
    args = parser.parse_args(argv)
    dist = ROOT / args.dist
    build_dir = ROOT / args.build_dir
    problems = []
    try:
        version = (ROOT / 'VERSION').read_text().strip()
    except (OSError, UnicodeError) as error:
        print(f'cannot read VERSION: {error}')
        return 1
    try:
        disk_build = {path.relative_to(build_dir).as_posix(): path.read_bytes()
                      for path in sorted(build_dir.rglob('*')) if path.is_file()}
        problems.extend(f'on-disk build: {problem}' for problem in app_build_problems(disk_build))
    except OSError as error:
        problems.append(f'cannot read on-disk build: {error}')
        disk_build = {}
    try:
        app_sources = {name for name in release_files(ROOT, build_dir=build_dir)
                       if name.startswith('frontend/app/')}
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        problems.append(f'cannot select release sources: {error}')
        app_sources = set()
    summaries = []
    for filename, prefix, portable in (
            (f'TowerPilot-{version}-source.zip', f'TowerPilot-{version}', False),
            (f'TowerPilot-{version}-windows-x64.zip', f'TowerPilot-{version}-windows-x64', True)):
        archive_problems, count = _check_archive(dist / filename, prefix, disk_build, app_sources,
                                                 portable=portable)
        problems.extend(f'{filename}: {problem}' for problem in archive_problems)
        summaries.append(f'{filename}: {count} entries')
    if problems:
        for problem in problems:
            print(problem)
        return 1
    print('OK: ' + '; '.join(summaries))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
