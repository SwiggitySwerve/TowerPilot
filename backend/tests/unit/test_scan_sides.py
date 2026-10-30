"""The sides of a measured comparison (roadmap item 9, spec 3.6): the overlay applies exactly, the two inventories differ in exactly its files, and the declaration
makes a worker's tree clean, dirty or undeclared."""
import copy
import json
import shutil
from pathlib import Path

import pytest

from runtime import build_info, scan_identity
from scan_sides_loader import ROOT, scan_sides

OVERLAY = scan_sides.load_overlay()
FILES = scan_sides.files_of(OVERLAY)


@pytest.fixture
def tree(tmp_path):
    """A small checkout: the real overlay files, a file the overlay never touches, a test and local state the fingerprint ignores."""
    for rel in FILES:
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / rel, tmp_path / rel)
    for rel, data in (('backend/other.py', b'x = 1\n'), ('backend/tests/test_x.py', b'def test(): pass\n'), ('backend/logs/note.py', b'log = 1\n'), ('backend/dashboard.py', b'app = 1\n')):
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_bytes(data)
    return tmp_path


def write_before(root):
    for rel, data in scan_sides.overlay_bytes(root, OVERLAY).items():
        (root / rel).write_bytes(data)


# -------------------------------------------------------------------------------------------------------------- the overlay document
def document(**changes):
    doc = copy.deepcopy(OVERLAY)
    doc.update(changes)
    return doc


def loaded(tmp_path, doc):
    path = tmp_path / 'overlay.json'
    path.write_text(json.dumps(doc), encoding='utf-8')
    return scan_sides.load_overlay(path)


def test_the_shipped_overlay_loads_and_names_the_five_hunks_in_four_measured_files():
    assert [h['id'] for h in OVERLAY['hunks']] == ['H1', 'H2', 'H3', 'H4', 'H5'] and len(FILES) == 4
    assert OVERLAY['source_commit'] == '17befd2' and set(FILES) <= set(scan_identity.MEASURED_FILES)


@pytest.mark.parametrize('mutate,message', [
    (lambda d: d['hunks'].append(copy.deepcopy(d['hunks'][0])), 'appears twice'),
    (lambda d: d['hunks'][0].update(file='backend/player/other.py'), 'not a measured file'),
    (lambda d: d['hunks'][0].update(new=d['hunks'][0]['old']), 'changes nothing'),
    (lambda d: d['hunks'][0].pop('restores'), 'no restores'),
    (lambda d: d['hunks'][0].update(old=''), 'no old'),
    (lambda d: d.update(hunks=[]), 'not an overlay'),
    (lambda d: d.update(schema_version=2), 'not an overlay'),
])
def test_an_invalid_overlay_is_refused(tmp_path, mutate, message):
    doc = document()
    mutate(doc)
    with pytest.raises(scan_sides.OverlayError, match=message):
        loaded(tmp_path, doc)


def test_the_overlay_hash_follows_the_exact_text():
    first = scan_sides.overlay_hash(OVERLAY)
    assert first == scan_sides.overlay_hash(copy.deepcopy(OVERLAY)) and len(first) == 64
    changed = document()
    changed['hunks'][4]['new'] = changed['hunks'][4]['new'].replace('.8', '.9')
    assert scan_sides.overlay_hash(changed) != first
    renamed = document(claim='another claim', source_commit='deadbeef')
    assert scan_sides.overlay_hash(renamed) == first        # the claim's wording is not the overlay; its text is


# ------------------------------------------------------------------------------------------------------------------ applying hunks
def test_a_hunk_found_zero_or_twice_is_an_error_never_a_guess():
    hunk = OVERLAY['hunks'][0]
    with pytest.raises(scan_sides.OverlayError, match='0 times'):
        scan_sides.apply_hunks('nothing here\n', [hunk])
    with pytest.raises(scan_sides.OverlayError, match='2 times'):
        scan_sides.apply_hunks(hunk['old'] + 'x = 1\n' + hunk['old'], [hunk])
    with pytest.raises(scan_sides.OverlayError, match='0 times'):
        scan_sides.apply_hunks(hunk['old'], [hunk], reverse=True)       # the landed text is not the before text


def test_line_endings_of_the_file_are_kept():
    hunk = OVERLAY['hunks'][0]
    crlf = ('prefix\n' + hunk['old'] + 'suffix\n').replace('\n', '\r\n')
    changed = scan_sides.apply_hunks(crlf, [hunk])
    assert '\r\n' in changed and '\n' not in changed.replace('\r\n', '') and 'pause(.8)' in changed
    assert scan_sides.apply_hunks(changed, [hunk], reverse=True) == crlf


# ------------------------------------------------------------------------------------------------------- E1: the inventories differ exactly there
def test_the_two_sides_inventories_differ_in_exactly_the_overlay_files(tree):
    after = scan_sides.inventory(tree)
    assert 'backend/other.py' in after and 'backend/dashboard.py' in after and not any('tests/' in rel or 'logs/' in rel for rel in after)
    write_before(tree)
    before = scan_sides.inventory(tree)
    assert scan_sides.diff_inventories(after, before) == FILES
    assert scan_sides.diff_inventories(after, after) == []
    assert scan_sides.diff_inventories({'a': '1'}, {'b': '2'}) == ['a', 'b']


def test_a_change_to_a_test_or_to_local_state_is_not_a_difference(tree):
    after = scan_sides.inventory(tree)
    (tree / 'backend/tests/test_x.py').write_bytes(b'def test(): assert False\n')
    (tree / 'backend/logs/note.py').write_bytes(b'log = 2\n')
    assert scan_sides.diff_inventories(after, scan_sides.inventory(tree)) == []


# -------------------------------------------------------------------------------------------------------------------------- declaration
def test_declare_names_both_sides_and_the_before_fingerprint_is_that_of_a_real_before_tree(tree):
    declaration = scan_sides.declare(tree, revision='a' * 40)
    after, before = declaration['sides']['after'], declaration['sides']['before']
    assert after['source_fingerprint'] == build_info.source_fingerprint(tree) and after['overlay_hash'] is None
    assert before['overlay_hash'] == scan_sides.overlay_hash(OVERLAY) and before['source_fingerprint'] != after['source_fingerprint']
    assert after['source_revision'] == before['source_revision'] == 'a' * 40 and set(declaration['files']) == set(FILES)
    assert all(row['after_sha256'] != row['before_sha256'] for row in declaration['files'].values())
    write_before(tree)                                  # the tree is now really the before side: its fingerprint is the declared one
    assert build_info.source_fingerprint(tree) == before['source_fingerprint']


def test_a_trees_state_follows_the_declaration(tree):
    scan_sides.write_declaration(tree, revision='a' * 40)
    sides = scan_identity.declared_sides(tree)
    revision, fingerprint = 'a' * 40, build_info.source_fingerprint(tree)
    assert scan_identity.classify(sides, revision, fingerprint)['side'] == 'after'
    write_before(tree)
    state = scan_identity.classify(sides, revision, build_info.source_fingerprint(tree))
    assert (state['tree_state'], state['side'], state['overlay_hash']) == ('clean', 'before', scan_sides.overlay_hash(OVERLAY))
    (tree / 'backend/other.py').write_bytes(b'x = 2\n')           # an edit nobody declared
    assert scan_identity.classify(sides, revision, build_info.source_fingerprint(tree))['tree_state'] == 'dirty'


def test_declaring_from_the_before_side_or_without_a_revision_is_refused(tree):
    with pytest.raises(scan_sides.OverlayError, match='committed source'):
        scan_sides.declare(tree)
    write_before(tree)
    with pytest.raises(scan_sides.OverlayError, match='found 0 times'):
        scan_sides.declare(tree, revision='a' * 40)


def test_writing_the_declaration_lands_under_logs_and_leaves_the_fingerprint_alone(tree):
    before = build_info.source_fingerprint(tree)
    scan_sides.write_declaration(tree, revision='b' * 40)
    path = tree.joinpath(*scan_identity.SIDES_RELATIVE)
    assert path.exists() and build_info.source_fingerprint(tree) == before
    assert json.loads(path.read_text(encoding='utf-8'))['sides']['after']['source_revision'] == 'b' * 40


def test_the_tool_reads_files_and_hashes_and_nothing_else(monkeypatch, tree):
    import subprocess
    spawned = []
    monkeypatch.setattr(subprocess, 'Popen', lambda *a, **k: spawned.append(a))
    monkeypatch.setattr(subprocess, 'run', lambda *a, **k: spawned.append(a))
    scan_sides.declare(tree, revision='a' * 40)
    scan_sides.inventory(tree)
    assert spawned == []


# ------------------------------------------------------------------------------------------- a hunk detects that it was already applied (F6)
HUNKS = OVERLAY['hunks']
HUNK_IDS = [h['id'] for h in HUNKS]


def landed_text(hunk):
    return (ROOT / hunk['file']).read_text(encoding='utf-8')


@pytest.mark.parametrize('hunk', HUNKS, ids=HUNK_IDS)
def test_applying_a_hunk_forward_twice_is_refused(hunk):
    once = scan_sides.apply_hunks(landed_text(hunk), [hunk])
    assert once != landed_text(hunk)
    with pytest.raises(scan_sides.OverlayError):
        scan_sides.apply_hunks(once, [hunk])


@pytest.mark.parametrize('hunk', HUNKS, ids=HUNK_IDS)
def test_reversing_a_hunk_twice_is_refused(hunk):
    landed = landed_text(hunk)
    back = scan_sides.apply_hunks(scan_sides.apply_hunks(landed, [hunk]), [hunk], reverse=True)
    assert back == landed
    with pytest.raises(scan_sides.OverlayError):
        scan_sides.apply_hunks(back, [hunk], reverse=True)


def test_a_hunk_whose_anchor_text_is_a_prefix_of_what_it_writes_is_refused_by_name_the_second_time():
    h4 = next(h for h in HUNKS if h['id'] == 'H4')
    assert h4['new'].startswith(h4['old'])             # the case the count of the old text alone cannot tell apart
    once = scan_sides.apply_hunks(landed_text(h4), [h4])
    assert once.count(h4['restores']) == landed_text(h4).count(h4['restores']) + 1
    with pytest.raises(scan_sides.OverlayError, match='already applied'):
        scan_sides.apply_hunks(once, [h4])


def test_a_hunk_whose_other_text_contains_its_anchor_still_reverses_cleanly():
    h4 = next(h for h in HUNKS if h['id'] == 'H4')
    before = scan_sides.apply_hunks(landed_text(h4), [h4])
    assert scan_sides.apply_hunks(before, [h4], reverse=True) == landed_text(h4)       # old is inside new here: still a clean reverse


# ------------------------------------------------------------------------------------------------------- check goes through classify (F4)
@pytest.fixture
def git_tree(tree):
    (tree / '.git').mkdir()
    (tree / '.git' / 'HEAD').write_text('a' * 40 + '\n', encoding='utf-8')
    return tree


def test_check_names_the_declared_side_of_the_tree_on_disk(git_tree):
    assert scan_sides.check(git_tree)['tree_state'] == 'undeclared'                 # nothing declared yet
    scan_sides.write_declaration(git_tree, revision='a' * 40)
    state = scan_sides.check(git_tree)
    assert (state['tree_state'], state['side'], state['overlay_hash'], state['source_revision']) == ('clean', 'after', None, 'a' * 40)
    assert state['source_fingerprint'] == build_info.source_fingerprint(git_tree)
    write_before(git_tree)
    state = scan_sides.check(git_tree)
    assert (state['tree_state'], state['side'], state['overlay_hash']) == ('clean', 'before', scan_sides.overlay_hash(OVERLAY))
    (git_tree / 'backend/other.py').write_bytes(b'x = 2\n')
    assert scan_sides.check(git_tree)['tree_state'] == 'dirty'
    (git_tree / '.git' / 'HEAD').write_text('b' * 40 + '\n', encoding='utf-8')              # a commit after the declaration
    assert scan_sides.check(git_tree)['tree_state'] == 'undeclared'


def test_check_asks_scan_identity_classify_and_adds_nothing_of_its_own(git_tree, monkeypatch):
    scan_sides.write_declaration(git_tree, revision='a' * 40)
    calls = []
    monkeypatch.setattr(scan_identity, 'classify', lambda sides, revision, fingerprint: calls.append((sides, revision, fingerprint)) or dict(tree_state='dirty', side='x', overlay_hash='h'))
    state = scan_sides.check(git_tree)
    assert calls == [(scan_identity.declared_sides(git_tree), 'a' * 40, build_info.source_fingerprint(git_tree))]
    assert (state['tree_state'], state['side'], state['overlay_hash']) == ('dirty', 'x', 'h')


def test_the_check_command_exits_zero_only_for_a_clean_tree(git_tree, monkeypatch, capsys):
    monkeypatch.setattr(scan_sides, 'BACKEND', git_tree / 'backend')
    assert scan_sides.main(['check']) == 1 and '"tree_state": "undeclared"' in capsys.readouterr().out
    scan_sides.write_declaration(git_tree, revision='a' * 40)
    assert scan_sides.main(['check']) == 0 and '"tree_state": "clean"' in capsys.readouterr().out
    (git_tree / 'backend/other.py').write_bytes(b'x = 3\n')
    assert scan_sides.main(['check']) == 1 and '"tree_state": "dirty"' in capsys.readouterr().out


def test_declaration_without_revision_requires_committed_lf_source(git_tree):
    # The synthetic .git has no object store: production must not silently pin disk bytes.
    with pytest.raises(scan_sides.OverlayError, match='committed source'):
        scan_sides.declare(git_tree)


@pytest.fixture
def committed_tree(git_tree, monkeypatch):
    import io
    import subprocess
    import tarfile
    from types import SimpleNamespace

    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as archive:
        for path in build_info.source_files(git_tree):
            data = path.read_bytes().replace(b'\r\n', b'\n')
            member = tarfile.TarInfo(path.relative_to(git_tree).as_posix())
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    calls = []
    def run(args, **kwargs):
        calls.append(args)
        return SimpleNamespace(stdout=stream.getvalue())
    monkeypatch.setattr(subprocess, 'run', run)
    return git_tree, calls


def test_committed_lf_bytes_define_the_pair_even_in_a_crlf_checkout(committed_tree):
    root, calls = committed_tree
    expected = scan_sides.declare(root, revision='a' * 40)
    for path in build_info.source_files(root):
        path.write_bytes(path.read_bytes().replace(b'\r\n', b'\n').replace(b'\n', b'\r\n'))
    assert scan_sides.declare(root) == expected
    assert calls == [['git', '-C', str(root), 'archive', 'HEAD', 'backend', 'frontend']]
    assert build_info.source_fingerprint(root) != expected['sides']['after']['source_fingerprint']


@pytest.mark.parametrize('drift', ['edit', 'extra', 'missing'])
def test_declaration_refuses_source_drift_from_committed_head(committed_tree, drift):
    root, _ = committed_tree
    path = root / 'backend/other.py'
    if drift == 'edit':
        path.write_bytes(b'x = 2\n')
    elif drift == 'missing':
        path.unlink()
    else:
        (root / 'backend/extra.py').write_bytes(b'x = 1\n')
    with pytest.raises(scan_sides.OverlayError, match='differs'):
        scan_sides.declare(root)


def test_cli_refusal_has_a_reason_and_nonzero_exit(tree, monkeypatch, capsys):
    monkeypatch.setattr(scan_sides, 'BACKEND', tree / 'backend')
    monkeypatch.setattr(scan_sides, 'committed_sources', lambda root: (_ for _ in ()).throw(scan_sides.OverlayError('source drift')))
    assert scan_sides.main(['declare']) == 2
    assert json.loads(capsys.readouterr().err) == {'comparable': False, 'reason': 'source drift'}
