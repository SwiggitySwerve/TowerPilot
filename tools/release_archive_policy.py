"""Release archive rules: reject local state and personal content at the ZIP boundary.

Dependency image exceptions are trusted checker data, never archive-supplied data.
Only dependency licence/notice files waive the e-mail marker. Every text file
still receives all other marker checks and the caller's local forbid list.
"""
import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from pathlib import Path, PurePosixPath

from build_release import APP_BUILD, APP_INVENTORY

STATE_DIRECTORIES = (
    'backend/accounts', 'backend/logs', 'backend/runs', 'backend/captures',
    'backend/templates', 'tools/platform-tools', 'tools/scrcpy', 'dist',
)
TEXT_SUFFIXES = {
    '', '.txt', '.md', '.rst', '.py', '.pyi', '.json', '.jsonl', '.yaml', '.yml',
    '.toml', '.ini', '.cfg', '.conf', '.lock', '.html', '.css', '.js', '.mjs',
    '.cjs', '.ts', '.tsx', '.ps1', '.cmd', '.bat', '.xml', '.csv', '.pth',
}
MARKERS = {
    'windows-user-profile': re.compile(r'\b[a-z]:[\\/]+users[\\/]+[^\\/\s"<>]+', re.I),
    'drive-project-path': re.compile(
        r'\b[a-z]:[\\/]+(?:projects?|repos?|workspaces?|worktrees?)[\\/]', re.I),
    'tool-temp-path': re.compile(
        r'(?:[\\/](?:tmp|temp)[\\/]+|%temp%[\\/]+)'
        r'\.?(?:codex|claude|t3|towerpilot|tower-pilot|portable-build|pytest)[\w.-]*', re.I),
    'url-credentials': re.compile(r'\b[a-z][a-z0-9+.-]*://[^\s/@]+@', re.I),
    'email': re.compile(r'\b[a-z0-9.!#$%&\x27*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b', re.I),
}


def dependency_images(directory: Path) -> dict[str, str]:
    """Load trusted exact paths/hashes, verifying their provenance against pins."""
    pins_bytes = (directory / 'portable_pins.json').read_bytes()
    pins = json.loads(pins_bytes)
    manifest = json.loads((directory / 'dependency_images.json').read_bytes())
    if manifest['generation']['pins_sha256'] != hashlib.sha256(pins_bytes).hexdigest():
        raise ValueError('dependency image allowlist is stale against portable pins')
    artifacts = {(row['requirement'], artifact['filename'], artifact['sha256'])
                 for row in pins['packages'] for artifact in row['artifacts']}
    images = {}
    for image in manifest['images']:
        provenance = (image['package'] + '==' + image['version'],
                      image['wheel'], image['wheel_sha256'])
        path, digest = image['path'], image['sha256']
        if (provenance not in artifacts or not image['wheel'].endswith('.whl')
                or not path.startswith('runtime/Lib/site-packages/')
                or PurePosixPath(path).suffix.lower() != '.png'
                or any(part in {'', '.', '..'} for part in path.split('/'))
                or '\\' in path or path in images or not re.fullmatch('[0-9a-f]{64}', digest)):
            raise ValueError('invalid dependency image allowlist entry')
        images[path] = digest
    return images


def state_path(name: str) -> bool:
    """Windows releases reject case variants of every forbidden local-state path."""
    name = name.replace('\\', '/').lower().rstrip('/')
    return (name == 'backend/config.yaml' or name.startswith('backend/config.yaml.bak-')
            or name == '.claude/settings.local.json'
            or any(name == directory or name.startswith(directory + '/')
                   for directory in STATE_DIRECTORIES)
            or (name.startswith('backend/profiles/') and name != 'backend/profiles/default.yaml'))


def _dependency_licence(name: str) -> bool:
    parts = name.split('/')
    if (len(parts) < 5 or parts[:3] != ['runtime', 'Lib', 'site-packages']
            or not parts[3].endswith('.dist-info')):
        return False
    # METADATA, RECORD, code, and arbitrary text under dist-info are NOT licences.
    return (PurePosixPath(name).suffix.lower() in {'', '.txt', '.md', '.rst'}
            and re.fullmatch(r'(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?',
                             parts[-1], re.I) is not None)


def content_problems(entries: Mapping[str, bytes], forbidden: Sequence[str]) -> list[str]:
    problems = []
    for name, data in entries.items():
        if PurePosixPath(name).suffix.lower() not in TEXT_SUFFIXES:
            continue
        encoding = 'utf-16' if data.startswith((b'\xff\xfe', b'\xfe\xff')) else 'utf-8-sig'
        text = data.decode(encoding, errors='replace')
        for marker, pattern in MARKERS.items():
            if marker == 'email' and _dependency_licence(name):
                continue
            if pattern.search(text):
                problems.append(f'content marker {marker}: {name}')
        if any(value.casefold() in text.casefold() for value in forbidden):
            problems.append(f'content marker local-forbid-list: {name}')
    return problems


def metadata_problems(entries: Mapping[str, bytes], prefix: str, *, portable: bool,
                      require_identity: bool) -> list[str]:
    problems = []
    try:
        version = entries['VERSION'].decode('utf-8').strip()
        if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._+-]*', version):
            raise ValueError
    except (KeyError, UnicodeError, ValueError):
        return ['missing or invalid VERSION']
    expected_prefix = 'TowerPilot-' + version + ('-windows-x64' if portable else '')
    if prefix != expected_prefix:
        problems.append('VERSION does not match archive name')
    limits = f'docs/RELEASE_{version}.md'
    if limits not in entries:
        problems.append(f'missing environment limits document: {limits}')
    elif not re.search(rb'^#{1,6}[ \t]+Environment limits[ \t]*\r?$', entries[limits], re.M | re.I):
        problems.append(f'missing Environment limits heading: {limits}')
    # p10a activates this flag at the caller. Until then identity is optional.
    if not require_identity:
        return problems
    try:
        identity = json.loads(entries['release_identity.json'])
        if not isinstance(identity, dict):
            raise ValueError
    except (KeyError, ValueError, UnicodeError):
        return problems + ['missing or invalid release_identity.json']
    expected = {'version': version, 'kind': 'portable-windows-x64' if portable else 'source',
                'working_tree': 'clean',
                'app_build_sha256': hashlib.sha256(
                    entries.get(APP_BUILD + '/' + APP_INVENTORY, b'')).hexdigest()}
    for field, value in expected.items():
        if identity.get(field) != value:
            problems.append(f'release identity mismatch: {field}')
    return problems
