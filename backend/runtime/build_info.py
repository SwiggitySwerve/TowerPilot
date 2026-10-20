"""Source provenance captured when a process loads, independent of Git executables.

The fingerprint describes source on disk at capture time, not a claim that every
module was already imported. Local account data and generated files are excluded.
"""
import hashlib
import os
from pathlib import Path
import time
import uuid


_EXCLUDED = {'tests', '__pycache__', 'accounts', 'logs', 'runs', 'captures',
             'profiles', 'templates', '.venv', 'node_modules'}


def source_fingerprint(root: Path) -> str:
    """Hash application source only; stable across file timestamps and checkout paths."""
    digest = hashlib.sha256()
    sources = []

    def unreadable(error: OSError) -> None:
        raise error

    for directory in ('backend', 'frontend'):
        base = root / directory
        if not base.exists():
            continue  # source-only fixtures and partial packaged installs
        for current, directories, filenames in os.walk(base, onerror=unreadable):
            directories[:] = sorted(name for name in directories if name not in _EXCLUDED)
            sources.extend(Path(current) / name for name in filenames if name.endswith('.py'))
    if not sources:
        raise FileNotFoundError('No application Python source found')
    for path in sorted(sources):
        digest.update(path.relative_to(root).as_posix().encode('utf-8') + b'\0')
        digest.update(path.read_bytes())
        digest.update(b'\0')
    return digest.hexdigest()


def revision(root: Path) -> str | None:
    """Read loose or packed Git refs, including linked worktrees; archives return None."""
    git = root / '.git'
    if git.is_file():
        git = root / git.read_text(encoding='utf-8').strip().removeprefix('gitdir: ')
    if not git.is_dir():
        return None
    head = (git / 'HEAD').read_text(encoding='utf-8').strip()
    if not head.startswith('ref: '):
        return head
    ref = head.removeprefix('ref: ')
    common = git
    if (git / 'commondir').exists():
        common = git / (git / 'commondir').read_text(encoding='utf-8').strip()
    for directory in (git, common):
        if (directory / ref).exists():
            return (directory / ref).read_text(encoding='utf-8').strip()
    packed = common / 'packed-refs'
    if packed.exists():
        for line in packed.read_text(encoding='utf-8').splitlines():
            if line.endswith(' ' + ref):
                return line.split()[0]
    return None


def snapshot(root: Path, role: str) -> dict:
    """Capture once in each process before its long-running work begins."""
    result = dict(role=role, pid=os.getpid(), session_id=str(uuid.uuid4()),
                  captured_at=time.time(), source_revision=None,
                  source_fingerprint=None, error=None)
    try:
        result.update(source_revision=revision(root), source_fingerprint=source_fingerprint(root))
    except (OSError, ValueError) as exc:
        result['error'] = {'type': type(exc).__name__, 'message': str(exc)}
    return result


def compare(root: Path, started: dict) -> dict:
    """Explicit freshness check; never relabel an old process with the new disk revision."""
    result = dict(started, disk_source_fingerprint=None, source_changed=None)
    try:
        current = source_fingerprint(root)
        result['disk_source_fingerprint'] = current
        if started.get('source_fingerprint') is not None:
            result['source_changed'] = current != started['source_fingerprint']
    except (OSError, ValueError) as exc:
        result['error'] = {'type': type(exc).__name__, 'message': str(exc)}
    return result
