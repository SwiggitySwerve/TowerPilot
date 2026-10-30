"""Which code a measured scan ran, and whether that code is a declared side of a before/after pair (roadmap item 9, spec 3.1 and 3.6).

The worker records `identity` into calibrate_metrics.json once, when it starts: the Git revision and the source fingerprint it loaded
(runtime/build_info.py, captured by runtime.operations at worker start), the sha256 of each file whose behavior a scan measures, the Python
version and the Windows build it ran on, and a `tree_state`:

  clean       the revision AND the fingerprint equal a side that backend/logs/scan_sides.json declares (the side's name is recorded);
  dirty       the revision equals a declared side's revision but the fingerprint matches none of them: code was edited after the
              declaration (a dirty tree, or an overlay that was never declared);
  undeclared  no declaration, an unreadable one, no revision (an archive) or a revision no side names.

scan_sides.json is machine state (backend/logs is never shipped or fingerprinted). It will be written by the later package P9-B
(tools/scan_sides.py, not landed yet); until then it does not exist and every scan records tree_state `undeclared`. Nothing here reads
Git: the revision is the HEAD ref the build snapshot already holds. A comparison of two scans (judged elsewhere) refuses a file that is not
`clean`. Pure except for reading the files it is asked about and asking the interpreter and the operating system for their version.
Rules: runtime/scan_metrics.rules.md.
"""
import hashlib
import json
import platform
import sys
from pathlib import Path

SIDES_SCHEMA = 1
SIDES_RELATIVE = ('backend', 'logs', 'scan_sides.json')
# Files whose behavior a calibration scan measures (spec 3.1): a side that differs in any of them is a different measurement.
MEASURED_FILES = (
    'backend/player/calibrate.py', 'backend/player/bootstrap.py', 'backend/player/card_inventory.py',
    'backend/player/collection_scan.py', 'backend/player/mapping_session.py', 'backend/player/module_descriptor.py',
    'backend/player/flow_capture.py', 'backend/vision/textocr.py', 'backend/device/capture.py',
    'backend/interactions/inventory.py',
)


def sha256_file(path: Path) -> str | None:
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except OSError:
        return None


def measured_files(root: Path) -> dict:
    """{relative path: sha256 or None} of every measured file, in a fixed order."""
    return {rel: sha256_file(Path(root) / rel) for rel in MEASURED_FILES}


def declared_sides(root: Path) -> dict:
    """The declaration in backend/logs/scan_sides.json (to be written by P9-B's tools/scan_sides.py): {side name: {source_revision, source_fingerprint, overlay_hash}}; {} when absent or invalid."""
    try:
        document = json.loads(Path(root).joinpath(*SIDES_RELATIVE).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    sides = document.get('sides') if isinstance(document, dict) and document.get('schema_version') == SIDES_SCHEMA else None
    if not isinstance(sides, dict):
        return {}
    return {name: side for name, side in sides.items() if isinstance(side, dict)}


def classify(sides: dict, revision: str | None, fingerprint: str | None) -> dict:
    """{'tree_state', 'side', 'overlay_hash'} for one loaded tree against the declared sides."""
    if not revision or not fingerprint:
        return dict(tree_state='undeclared', side=None, overlay_hash=None)
    same_revision = False
    for name in sorted(sides):
        side = sides[name]
        if side.get('source_revision') != revision:
            continue
        same_revision = True
        if side.get('source_fingerprint') == fingerprint:
            return dict(tree_state='clean', side=name, overlay_hash=side.get('overlay_hash'))
    return dict(tree_state='dirty' if same_revision else 'undeclared', side=None, overlay_hash=None)


def host() -> dict:
    """The interpreter and the Windows build a scan ran on: two scans on different ones are not the same measurement."""
    return dict(python=platform.python_version(), windows='{}.{}.{}'.format(*sys.getwindowsversion()[:3]) if sys.platform == 'win32' else None)


def identity(root: Path, build: dict) -> dict:
    """The identity block of a metrics file. `build` is the process's own start snapshot (runtime.operations.worker_build())."""
    revision, fingerprint = build.get('source_revision'), build.get('source_fingerprint')
    return dict(source_revision=revision, source_fingerprint=fingerprint, build_error=build.get('error'),
                measured_files=measured_files(root), **host(), **classify(declared_sides(root), revision, fingerprint))


def template_inventory(directory: Path) -> dict:
    """{'digest', 'count'}: sha256 over the relative path and sha256 of every file under the account's templates folder, in path order."""
    directory = Path(directory)
    digest, count = hashlib.sha256(), 0
    if directory.is_dir():
        for path in sorted(p for p in directory.rglob('*') if p.is_file()):
            digest.update(path.relative_to(directory).as_posix().encode('utf-8') + b'\0')
            digest.update((sha256_file(path) or 'unreadable').encode('ascii') + b'\0')
            count += 1
    return dict(digest=digest.hexdigest(), count=count)


def start_state(templates: Path, state: dict) -> dict:
    """What a scan started from (spec 3.2 rule 4): the template inventory and the phases the saved state already holds as done."""
    done = sorted(name for name, record in (state.get('phases') or {}).items() if isinstance(record, dict) and record.get('status') == 'done')
    return dict(templates=template_inventory(templates), phases_done=done)
