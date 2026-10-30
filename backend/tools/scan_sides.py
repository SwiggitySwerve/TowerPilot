"""The two sides of a measured setup comparison, and the overlay that makes the before side (roadmap item 9, spec 3.6).

A speed claim is a comparison of two scans of the same account on two source trees. The AFTER side is the landed code. The BEFORE side is the same code with the
reverse of the claim's own change put back: five pause changes that commit 17befd2 made in the setup scans (backend/tools/overlays/p9b_pauses.json holds the five
hunks as exact text, old = the landed text, new = the text with the pause). Everything else, the recorder, the gates, the sealing, the final Home check, is
identical on both sides, so the scans differ only in those pauses and a speed claim built on them names exactly that.

This module never imports scan code, runs a scan or touches the device. Declaration reads committed LF bytes with git archive HEAD;
synthetic trees can supply an explicit revision. Runtime identity still comes from runtime.build_info.revision. What it does:

  overlay      load and validate the hunks; apply them forward (after -> before) or in reverse; a hunk whose text is not found exactly once is an error, never a guess
  inventory    the sha256 of every source file a fingerprint covers (runtime/build_info.source_files): two inventories of the two sides differ in exactly the overlay's files
  declare      the declaration backend/logs/scan_sides.json that runtime/scan_identity reads: the revision, the fingerprint of each side (the before fingerprint is computed
               over the after tree with the overlay's bytes substituted, build_info.source_fingerprint(overrides=...), so it needs no second checkout) and the overlay hash
  swap set     the before text of each overlay file, which the land script of the swap package installs and restores byte for byte (P9-B)

  check        which declared side the tree on disk is, decided by runtime.scan_identity.classify (the call a worker makes at start): tree_state clean | dirty | undeclared and the side

Usage (from the checkout):  python backend/tools/scan_sides.py declare | inventory [--out FILE] | diff A.json B.json | check
  declare runs on the AFTER side, after the last landing and commit and before the first measured run, and again after ANY commit (the declared revision is HEAD at declare time).
  check exits 0 only for a clean tree, 1 for a dirty or undeclared one.
Rules: backend/tools/scan_sides.rules.md.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from runtime import build_info, scan_identity  # noqa: E402

OVERLAY = Path(__file__).with_name('overlays') / 'p9b_pauses.json'
SCHEMA = 1


class OverlayError(ValueError):
    """The overlay does not apply to this tree: a hunk is missing, ambiguous, or the file is not a measured file."""


def load_overlay(path=OVERLAY):
    document = json.loads(Path(path).read_text(encoding='utf-8'))
    if not isinstance(document, dict) or document.get('schema_version') != SCHEMA or not isinstance(document.get('hunks'), list) or not document['hunks']:
        raise OverlayError('not an overlay document')
    seen = set()
    for hunk in document['hunks']:
        for key in ('id', 'file', 'old', 'new', 'restores'):
            if not isinstance(hunk.get(key), str) or not hunk[key]:
                raise OverlayError(f'hunk {hunk.get("id")!r} has no {key}')
        if hunk['id'] in seen:
            raise OverlayError(f'hunk {hunk["id"]} appears twice')
        seen.add(hunk['id'])
        if hunk['file'] not in scan_identity.MEASURED_FILES:
            raise OverlayError(f'hunk {hunk["id"]} edits {hunk["file"]}, which is not a measured file')
        if hunk['old'] == hunk['new']:
            raise OverlayError(f'hunk {hunk["id"]} changes nothing')
    return document


def overlay_hash(document):
    """sha256 of the overlay's exact text: the id, file, old and new of every hunk in order."""
    canonical = json.dumps([[h['id'], h['file'], h['old'], h['new']] for h in document['hunks']], ensure_ascii=True, separators=(',', ':'))
    return hashlib.sha256(canonical.encode('utf-8')).hexdigest()


def files_of(document):
    return sorted({hunk['file'] for hunk in document['hunks']})


def apply_hunks(text, hunks, *, reverse=False):
    """`text` (a file's contents) with every hunk applied, each found exactly once. Line endings of the file are kept (hunks are written with LF).

    A hunk is self-detecting: it is refused when the text it would write is already present beyond the one place it is replacing. That matters when the text to
    find is a prefix of the text to write (H4 adds a line after its anchor), where a second application would find its anchor again and double the pause."""
    crlf = '\r\n' in text
    body = text.replace('\r\n', '\n')
    for hunk in hunks:
        old, new = (hunk['new'], hunk['old']) if reverse else (hunk['old'], hunk['new'])
        found = body.count(old)
        if found != 1:
            raise OverlayError(f'hunk {hunk["id"]} ({hunk["file"]}): its {"before" if reverse else "after"} text was found {found} times, not once')
        if body.count(new) - old.count(new) > 0:                # the text to write is already there outside the one place being replaced
            raise OverlayError(f'hunk {hunk["id"]} ({hunk["file"]}): already applied, its {"after" if reverse else "before"} text is present')
        body = body.replace(old, new)
    return body.replace('\n', '\r\n') if crlf else body


def overlay_bytes(root, document, *, reverse=False):
    """{relative path: bytes} of each overlay file after applying the overlay (or its reverse) to the tree at `root`. Nothing is written."""
    out = {}
    for rel in files_of(document):
        text = (Path(root) / rel).read_bytes().decode('utf-8')
        out[rel] = apply_hunks(text, [h for h in document['hunks'] if h['file'] == rel], reverse=reverse).encode('utf-8')
    return out


def inventory(root):
    """{relative path: sha256} of every source file the fingerprint covers, in path order."""
    root = Path(root)
    return {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(build_info.source_files(root), key=lambda p: p.relative_to(root).as_posix())}


def diff_inventories(a, b):
    """The relative paths that differ between two inventories (added, removed or changed), sorted."""
    return sorted(rel for rel in set(a) | set(b) if a.get(rel) != b.get(rel))


def committed_sources(root):
    """Read HEAD blobs through an archive (the same bytes as git show HEAD:path).

    Never hash CRLF checkout bytes as the landed identity. No checkout or device
    is changed. Extra, missing or edited source is refused by declare().
    """
    import io
    import subprocess
    import tarfile

    try:
        result = subprocess.run(['git', '-C', str(root), 'archive', 'HEAD', 'backend', 'frontend'],
                                check=True, capture_output=True)
        with tarfile.open(fileobj=io.BytesIO(result.stdout)) as archive:
            blobs = {member.name: archive.extractfile(member).read()
                     for member in archive.getmembers() if member.isfile() and member.name.endswith('.py')}
    except (OSError, subprocess.CalledProcessError, tarfile.TarError) as exc:
        raise OverlayError('cannot read committed source from HEAD') from exc
    # Use the fingerprint owner's exclusion rules, including excluded directories.
    covered = {path.relative_to(root).as_posix() for path in build_info.source_files(root)}
    # Project the archive through the owner's public inventory, so its exclusions
    # stay authoritative even for a committed file missing from the checkout.
    import tempfile
    with tempfile.TemporaryDirectory(prefix='scan-sides-') as folder:
        archived = Path(folder)
        for rel, data in blobs.items():
            target = archived / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        committed = {path.relative_to(archived).as_posix(): path.read_bytes()
                     for path in build_info.source_files(archived)}
    if set(committed) != covered:
        raise OverlayError('committed source inventory differs from the checkout')
    changed = [rel for rel, data in committed.items()
               if (root / rel).read_bytes().replace(b'\r\n', b'\n') != data]
    if changed:
        raise OverlayError('source differs from committed HEAD: ' + ', '.join(sorted(changed)))
    return committed


def declare(root, revision=None):
    """Declare HEAD's LF bytes; explicit revision is for synthetic/source-only trees.

    CRLF checkout conversions are accepted as input, but are never recorded as
    the landed bytes. check() still compares the actual loaded bytes: normalize
    the measured checkout to LF before starting any worker.
    """
    root = Path(root)
    document = load_overlay()
    sources = committed_sources(root) if revision is None else {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in build_info.source_files(root)}
    before = {rel: apply_hunks(sources[rel].decode('utf-8'),
                              [h for h in document['hunks'] if h['file'] == rel]).encode('utf-8')
              for rel in files_of(document)}
    revision = revision or build_info.revision(root)
    if not revision:
        raise OverlayError('the tree has no Git revision; pass one')
    return dict(schema_version=scan_identity.SIDES_SCHEMA, overlay_hash=overlay_hash(document), files={
        rel: dict(after_sha256=hashlib.sha256(sources[rel]).hexdigest(), before_sha256=hashlib.sha256(data).hexdigest())
        for rel, data in sorted(before.items())}, sides=dict(
        after=dict(source_revision=revision, source_fingerprint=build_info.source_fingerprint(root, overrides=sources), overlay_hash=None),
        before=dict(source_revision=revision, source_fingerprint=build_info.source_fingerprint(root, overrides=sources | before), overlay_hash=overlay_hash(document))))


def write_declaration(root, revision=None):
    from runtime.files import atomic_json
    declaration = declare(root, revision)
    atomic_json(Path(root).joinpath(*scan_identity.SIDES_RELATIVE), declaration)
    return declaration


def check(root):
    """Which declared side the tree at `root` is, decided by the same call a worker makes at start: scan_identity.classify of the tree's revision and fingerprint
    against backend/logs/scan_sides.json. {source_revision, source_fingerprint, tree_state, side, overlay_hash}."""
    root = Path(root)
    revision, fingerprint = build_info.revision(root), build_info.source_fingerprint(root)
    return dict(source_revision=revision, source_fingerprint=fingerprint, **scan_identity.classify(scan_identity.declared_sides(root), revision, fingerprint))


def _main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('declare', help='write backend/logs/scan_sides.json for the checkout (the AFTER side)')
    inv = sub.add_parser('inventory', help='print the sha256 inventory of the source the fingerprint covers')
    inv.add_argument('--out')
    diff = sub.add_parser('diff', help='the paths that differ between two inventory files')
    diff.add_argument('a')
    diff.add_argument('b')
    sub.add_parser('check', help='which declared side the tree on disk is (tree_state clean | dirty | undeclared); exit 0 only when clean')
    args = parser.parse_args(argv)
    root = BACKEND.parent
    if args.command == 'declare':
        declaration = write_declaration(root)
        print(json.dumps(declaration['sides'], indent=1))
    elif args.command == 'inventory':
        text = json.dumps({rel: hashlib.sha256(data).hexdigest()
                           for rel, data in sorted(committed_sources(root).items())}, indent=1)
        if args.out:
            Path(args.out).write_bytes((text + '\n').encode('utf-8'))
        else:
            print(text)
    elif args.command == 'diff':
        a, b = (json.loads(Path(p).read_text(encoding='utf-8')) for p in (args.a, args.b))
        print(json.dumps(diff_inventories(a, b), indent=1))
    else:
        state = check(root)
        print(json.dumps(state, indent=1))
        return 0 if state['tree_state'] == 'clean' else 1
    return 0


def main(argv=None):
    try:
        return _main(argv)
    except (OSError, ValueError) as exc:
        print(json.dumps(dict(comparable=False, reason=str(exc))), file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())
