"""Source identity of a measured scan (roadmap item 9, spec 3.1 and 3.6): declared sides, clean or dirty, measured files, start state."""
import hashlib
import json
import platform
import sys
from pathlib import Path

import pytest

from runtime import build_info, scan_identity

AFTER = dict(source_revision='a' * 40, source_fingerprint='f1', overlay_hash=None)
BEFORE = dict(source_revision='a' * 40, source_fingerprint='f2', overlay_hash='o1')
SIDES = {'after': AFTER, 'before': BEFORE}


def declare(root, sides=SIDES, schema=1):
    path = Path(root).joinpath(*scan_identity.SIDES_RELATIVE)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({'schema_version': schema, 'sides': sides}), encoding='utf-8')


@pytest.mark.parametrize('fingerprint,state,side,overlay', [('f1', 'clean', 'after', None), ('f2', 'clean', 'before', 'o1'), ('f3', 'dirty', None, None)])
def test_a_loaded_tree_is_clean_only_when_revision_and_fingerprint_equal_a_declared_side(fingerprint, state, side, overlay):
    assert scan_identity.classify(SIDES, 'a' * 40, fingerprint) == dict(tree_state=state, side=side, overlay_hash=overlay)


@pytest.mark.parametrize('sides,revision,fingerprint', [({}, 'a' * 40, 'f1'), (SIDES, 'b' * 40, 'f1'), (SIDES, None, 'f1'), (SIDES, 'a' * 40, None)])
def test_no_declaration_a_foreign_revision_or_no_revision_is_undeclared(sides, revision, fingerprint):
    assert scan_identity.classify(sides, revision, fingerprint) == dict(tree_state='undeclared', side=None, overlay_hash=None)


def test_the_declaration_is_read_from_the_machine_state_file_and_anything_else_is_nothing(tmp_path):
    assert scan_identity.declared_sides(tmp_path) == {}
    declare(tmp_path)
    assert scan_identity.declared_sides(tmp_path) == SIDES
    declare(tmp_path, schema=2)
    assert scan_identity.declared_sides(tmp_path) == {}
    path = tmp_path.joinpath(*scan_identity.SIDES_RELATIVE)
    path.write_text('not json', encoding='utf-8')
    assert scan_identity.declared_sides(tmp_path) == {}
    path.write_text(json.dumps({'schema_version': 1, 'sides': {'after': AFTER, 'broken': 'text'}}), encoding='utf-8')
    assert scan_identity.declared_sides(tmp_path) == {'after': AFTER}


def test_the_declaration_lives_under_logs_which_the_fingerprint_never_covers(tmp_path):
    (tmp_path / 'backend').mkdir()
    (tmp_path / 'backend' / 'a.py').write_text('x = 1\n', encoding='utf-8')
    before = build_info.source_fingerprint(tmp_path)
    declare(tmp_path)
    assert build_info.source_fingerprint(tmp_path) == before


def test_identity_names_the_measured_files_in_a_fixed_order_and_the_tree_state(tmp_path):
    (tmp_path / 'backend' / 'player').mkdir(parents=True)
    (tmp_path / 'backend' / 'player' / 'calibrate.py').write_bytes(b'x = 1\n')
    declare(tmp_path)
    block = scan_identity.identity(tmp_path, dict(source_revision='a' * 40, source_fingerprint='f2', error=None))
    assert list(block['measured_files']) == list(scan_identity.MEASURED_FILES)
    assert block['measured_files']['backend/player/calibrate.py'] == hashlib.sha256(b'x = 1\n').hexdigest()
    assert block['measured_files']['backend/vision/textocr.py'] is None
    assert (block['tree_state'], block['side'], block['overlay_hash']) == ('clean', 'before', 'o1')
    assert (block['source_revision'], block['source_fingerprint'], block['build_error']) == ('a' * 40, 'f2', None)


def test_the_host_is_the_interpreter_and_the_windows_build_this_process_runs_on():
    assert scan_identity.host() == dict(python=platform.python_version(), windows='{}.{}.{}'.format(*sys.getwindowsversion()[:3]))


def test_identity_names_the_python_and_the_windows_build_it_ran_on(tmp_path, monkeypatch):
    monkeypatch.setattr(scan_identity, 'host', lambda: dict(python='3.12.10', windows='10.0.26100'))
    block = scan_identity.identity(tmp_path, dict(source_revision='a' * 40, source_fingerprint='f1', error=None))
    assert (block['python'], block['windows']) == ('3.12.10', '10.0.26100')
    monkeypatch.setattr(scan_identity, 'host', lambda: dict(python='3.13.7', windows='10.0.19045'))
    other = scan_identity.identity(tmp_path, dict(source_revision='a' * 40, source_fingerprint='f1', error=None))
    assert (other['python'], other['windows']) == ('3.13.7', '10.0.19045') and other['tree_state'] == block['tree_state']


def test_a_failed_build_snapshot_is_undeclared_with_its_error(tmp_path):
    block = scan_identity.identity(tmp_path, dict(source_revision=None, source_fingerprint=None, error={'type': 'OSError', 'message': 'x'}))
    assert block['tree_state'] == 'undeclared' and block['build_error'] == {'type': 'OSError', 'message': 'x'}


def test_the_template_inventory_changes_with_content_path_and_count_and_not_with_order(tmp_path):
    empty = scan_identity.template_inventory(tmp_path / 'missing')
    assert empty['count'] == 0
    folder = tmp_path / 'templates'
    (folder / 'cards').mkdir(parents=True)
    (folder / 'cards' / 'a.png').write_bytes(b'1')
    (folder / 'b.png').write_bytes(b'2')
    first = scan_identity.template_inventory(folder)
    assert first['count'] == 2 and first['digest'] != empty['digest'] and scan_identity.template_inventory(folder) == first
    (folder / 'b.png').write_bytes(b'3')
    changed = scan_identity.template_inventory(folder)
    assert changed['count'] == 2 and changed['digest'] != first['digest']
    (folder / 'b.png').write_bytes(b'2')
    assert scan_identity.template_inventory(folder) == first
    (folder / 'b.png').rename(folder / 'c.png')
    assert scan_identity.template_inventory(folder)['digest'] != first['digest']


def test_the_start_state_names_the_templates_and_the_phases_already_done(tmp_path):
    state = {'phases': {'cards': {'status': 'done'}, 'modules': {'status': 'running'}, 'bots': 'text', 'guardians': {'status': 'done'}}}
    got = scan_identity.start_state(tmp_path / 'none', state)
    assert got['phases_done'] == ['cards', 'guardians'] and got['templates']['count'] == 0
    assert scan_identity.start_state(tmp_path / 'none', {})['phases_done'] == []


def test_host_never_uses_shell_capable_platform_version(monkeypatch):
    monkeypatch.setattr(platform, 'version', lambda: pytest.fail('may spawn cmd'))
    assert scan_identity.host()['windows']
