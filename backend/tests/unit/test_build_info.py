"""Source-at-start provenance must survive later edits and packaged installs."""
import hashlib
import json
from pathlib import Path

import pytest

from runtime import build_info


def test_source_identity_is_immutable_across_edits_and_ignores_account_state(tmp_path):
    source = tmp_path / 'backend' / 'example.py'
    source.parent.mkdir()
    source.write_text('x = 1', encoding='utf-8')
    started = build_info.snapshot(tmp_path, 'worker')
    assert started['source_revision'] is None
    assert started['error'] is None
    assert build_info.compare(tmp_path, started)['source_changed'] is False
    account = tmp_path / 'backend' / 'accounts' / 'private.py'
    account.parent.mkdir()
    account.write_text('private data', encoding='utf-8')
    assert build_info.compare(tmp_path, started)['source_changed'] is False
    source.write_text('x = 2', encoding='utf-8')
    current = build_info.compare(tmp_path, started)
    assert current['source_changed'] is True
    assert current['source_fingerprint'] == started['source_fingerprint']
    assert current['disk_source_fingerprint'] != started['source_fingerprint']


def test_git_linked_worktree_packed_reference(tmp_path):
    root = tmp_path / 'checkout'
    root.mkdir()
    common = tmp_path / 'git'
    worktree = common / 'worktrees' / 'checkout'
    worktree.mkdir(parents=True)
    (root / '.git').write_text('gitdir: ../git/worktrees/checkout', encoding='utf-8')
    (worktree / 'commondir').write_text('../..', encoding='utf-8')
    (worktree / 'HEAD').write_text('ref: refs/heads/test', encoding='utf-8')
    (common / 'packed-refs').write_text('abc123 refs/heads/test\n', encoding='utf-8')
    assert build_info.revision(root) == 'abc123'


def test_unreadable_source_is_unknown_not_current(tmp_path, monkeypatch):
    def broken(_):
        raise PermissionError('locked source')
    monkeypatch.setattr(build_info, 'source_fingerprint', broken)
    started = build_info.snapshot(tmp_path, 'dashboard')
    assert started['source_fingerprint'] is None
    current = build_info.compare(tmp_path, started)
    assert current['source_changed'] is None
    assert current['error']['type'] == 'PermissionError'

# The exclusion list as it was before item 9 (a literal copy, not read from the module, so the reference does not move when the module's list grows).
_EXCLUDED_BEFORE_ITEM_9 = {'tests', '__pycache__', 'accounts', 'logs', 'runs', 'captures', 'profiles', 'templates', '.venv', 'node_modules'}


def _fingerprint_before_item_9(root):
    """The fingerprint algorithm exactly as it was before runtime/build_info.source_files was extracted (the regression reference)."""
    import hashlib
    import os
    digest = hashlib.sha256()
    sources = []
    for directory in ('backend', 'frontend'):
        base = root / directory
        if not base.exists():
            continue
        for current, directories, filenames in os.walk(base):
            directories[:] = sorted(name for name in directories if name not in _EXCLUDED_BEFORE_ITEM_9)
            sources.extend(Path(current) / name for name in filenames if name.endswith('.py'))
    for path in sorted(sources):
        digest.update(path.relative_to(root).as_posix().encode('utf-8') + b'\0')
        digest.update(path.read_bytes())
        digest.update(b'\0')
    return digest.hexdigest()


def _tree(tmp_path):
    for rel, text in (('backend/a.py', 'a = 1\n'), ('backend/sub/b.py', 'b = 2\n'), ('frontend/helper.py', 'd = 3\n'), ('backend/tests/test_a.py', 'def test(): pass\n'),
                      ('backend/accounts/x.py', 'secret\n'), ('backend/logs/y.py', 'log\n'), ('backend/notes.txt', 'not python\n')):
        path = tmp_path / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
    return tmp_path


def test_the_fingerprint_is_unchanged_by_extracting_the_file_list(tmp_path):
    root = _tree(tmp_path)
    assert build_info.source_fingerprint(root) == _fingerprint_before_item_9(root)
    assert [p.relative_to(root).as_posix() for p in sorted(build_info.source_files(root))] == ['backend/a.py', 'backend/sub/b.py', 'frontend/helper.py']


def test_source_fingerprint_ignores_a_tests_directory_change(tmp_path):
    root = _tree(tmp_path)
    before = build_info.source_fingerprint(root)
    (root / 'backend' / 'tests' / 'test_a.py').write_text('def test(): assert False\n', encoding='utf-8')
    (root / 'backend' / 'tests' / 'new_test.py').write_text('x = 1\n', encoding='utf-8')
    assert build_info.source_fingerprint(root) == before
    (root / 'backend' / 'a.py').write_text('a = 2\n', encoding='utf-8')
    assert build_info.source_fingerprint(root) != before


def test_source_fingerprint_ignores_generated_report_directories(tmp_path):
    """frontend/app/playwright-report and test-results are git-ignored output a Playwright run rewrites: they are not the code a scan ran."""
    root = _tree(tmp_path)
    before = build_info.source_fingerprint(root)
    for rel in ('frontend/app/playwright-report/r12f/write-report.py', 'frontend/app/test-results/run-1/helper.py', 'backend/test-results/x.py', 'frontend/playwright-report/y.py'):
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('generated = True\n', encoding='utf-8')
    assert build_info.source_fingerprint(root) == before
    (root / 'frontend/app/playwright-report/r12f/write-report.py').write_text('generated = False\n', encoding='utf-8')
    assert build_info.source_fingerprint(root) == before
    assert [p.relative_to(root).as_posix() for p in sorted(build_info.source_files(root))] == ['backend/a.py', 'backend/sub/b.py', 'frontend/helper.py']
    (root / 'frontend' / 'app' / 'real.py').write_text('code = 1\n', encoding='utf-8')            # a source file in the same folder is still covered
    assert build_info.source_fingerprint(root) != before


def test_overrides_give_the_fingerprint_of_a_tree_that_is_not_on_disk(tmp_path):
    root = _tree(tmp_path)
    declared = build_info.source_fingerprint(root, {'backend/a.py': b'a = 2\n'})
    assert declared != build_info.source_fingerprint(root)
    (root / 'backend' / 'a.py').write_bytes(b'a = 2\n')
    assert build_info.source_fingerprint(root) == declared


def test_an_override_that_names_no_covered_file_is_an_error(tmp_path):
    root = _tree(tmp_path)
    for rel in ('backend/tests/test_a.py', 'backend/missing.py', 'backend/notes.txt'):
        with pytest.raises(ValueError, match='names no source file'):
            build_info.source_fingerprint(root, {rel: b'x'})


# --------------------------------------------------------------- release identity (item 10 p10a)
def install(root, *, app=None, record=None):
    """A synthetic installed release: one source file, a built app with its inventory, and the identity naming both."""
    (root / 'backend').mkdir(parents=True)
    (root / 'backend' / 'example.py').write_text('x = 1', encoding='utf-8')
    app_dir = root.joinpath(*build_info.APP_BUILD)
    files = {'index.html': b'<p>app</p>', 'assets/main.js': b'console.log(1)'} if app is None else app
    for name, data in files.items():
        (app_dir / name).parent.mkdir(parents=True, exist_ok=True)
        (app_dir / name).write_bytes(data)
    inventory = ''.join(hashlib.sha256(data).hexdigest() + '  ' + name + '\n' for name, data in sorted(files.items()))
    (app_dir / build_info.APP_INVENTORY).write_bytes(inventory.encode())     # bytes: the build writes LF on every system
    identity = dict(schema_version=1, version='9.9.9', kind='source', source_fingerprint=build_info.source_fingerprint(root),
                    app_build_sha256=hashlib.sha256(inventory.encode()).hexdigest(), lock_sha256='0' * 64,
                    built_at='2027-01-15T08:00:00Z', source_revision=None, working_tree='clean')
    (root / build_info.RELEASE_IDENTITY).write_text(json.dumps(identity | (record or {})), encoding='utf-8')
    return identity


def test_a_tree_without_an_identity_is_a_checkout(tmp_path):
    result = build_info.release_identity(tmp_path)
    assert result['kind'] == 'checkout'
    assert result.keys() == {*build_info.IDENTITY_FIELDS, 'matches_source', 'matches_app_build', 'error'}
    assert {key: value for key, value in result.items() if key != 'kind'} == dict.fromkeys(result.keys() - {'kind'})


def test_a_matching_install_reads_true_for_both(tmp_path):
    identity = install(tmp_path)
    result = build_info.release_identity(tmp_path)
    assert {field: result[field] for field in build_info.IDENTITY_FIELDS} == identity | dict(python=None)
    assert (result['matches_source'], result['matches_app_build'], result['error']) == (True, True, None)


@pytest.mark.parametrize(('text', 'error'), [
    ('{broken', 'not valid JSON'), ('[]', 'not an object'), ('"source"', 'not an object'),
    ('{"kind": "unrecognized"}', 'unrecognized kind'), ('{}', 'unrecognized kind'), ('{"kind": ["source"]}', 'unrecognized kind')])
def test_a_record_the_server_cannot_use_is_unknown_and_says_why(tmp_path, text, error):
    (tmp_path / build_info.RELEASE_IDENTITY).write_text(text, encoding='utf-8')
    result = build_info.release_identity(tmp_path)
    assert (result['kind'], result['error'], result['matches_source'], result['matches_app_build']) == ('unknown', error, None, None)


def test_an_identity_that_cannot_be_read_is_unknown_not_a_checkout(tmp_path):
    (tmp_path / build_info.RELEASE_IDENTITY).mkdir()        # reading a folder as a file fails with an OSError
    result = build_info.release_identity(tmp_path)
    assert (result['kind'], result['error']) == ('unknown', 'unreadable')


def test_verify_false_reads_the_record_and_hashes_nothing(tmp_path, monkeypatch):
    install(tmp_path)
    monkeypatch.setattr(build_info, 'source_fingerprint', lambda _: pytest.fail('hashed the source'))
    monkeypatch.setattr(build_info, '_matches_app_build', lambda *_: pytest.fail('hashed the app'))
    result = build_info.release_identity(tmp_path, verify=False)
    assert (result['kind'], result['matches_source'], result['matches_app_build']) == ('source', None, None)


def test_source_that_cannot_be_read_is_unknown_not_a_mismatch(tmp_path, monkeypatch):
    install(tmp_path)
    def broken(_):
        raise PermissionError('locked source')
    monkeypatch.setattr(build_info, 'source_fingerprint', broken)
    assert build_info.release_identity(tmp_path)['matches_source'] is None


def test_an_edited_extra_or_missing_source_file_reads_false_and_state_folders_do_not_count(tmp_path):
    install(tmp_path)
    (tmp_path / 'backend' / 'accounts').mkdir()
    (tmp_path / 'backend' / 'accounts' / 'private.py').write_text('state', encoding='utf-8')
    (tmp_path / 'backend' / '__pycache__').mkdir()
    (tmp_path / 'backend' / '__pycache__' / 'example.py').write_text('cache', encoding='utf-8')
    assert build_info.release_identity(tmp_path)['matches_source'] is True
    (tmp_path / 'backend' / 'example.py').write_text('x = 2', encoding='utf-8')
    assert build_info.release_identity(tmp_path)['matches_source'] is False
    (tmp_path / 'backend' / 'example.py').write_text('x = 1', encoding='utf-8')
    (tmp_path / 'backend' / 'extra.py').write_text('y = 1', encoding='utf-8')
    assert build_info.release_identity(tmp_path)['matches_source'] is False
    (tmp_path / 'backend' / 'extra.py').unlink()
    assert build_info.release_identity(tmp_path)['matches_source'] is True


def test_a_record_without_a_fingerprint_or_inventory_hash_matches_nothing(tmp_path):
    install(tmp_path, record=dict(source_fingerprint=None, app_build_sha256=None))
    result = build_info.release_identity(tmp_path)
    assert (result['matches_source'], result['matches_app_build']) == (False, False)


@pytest.mark.parametrize('change', ['edit', 'delete', 'extra', 'extra-in-new-folder', 'edit-inventory', 'delete-inventory'])
def test_app_bytes_are_checked_against_the_inventory_not_only_the_inventory_against_the_record(tmp_path, change):
    install(tmp_path)
    app = tmp_path.joinpath(*build_info.APP_BUILD)
    assert build_info.release_identity(tmp_path)['matches_app_build'] is True
    if change == 'edit':
        (app / 'assets' / 'main.js').write_bytes(b'console.log(2)')
    elif change == 'delete':
        (app / 'assets' / 'main.js').unlink()
    elif change == 'extra':
        (app / 'assets' / 'extra.js').write_bytes(b'x')
    elif change == 'extra-in-new-folder':
        (app / 'more').mkdir()
        (app / 'more' / 'extra.js').write_bytes(b'x')
    elif change == 'edit-inventory':
        (app / build_info.APP_INVENTORY).write_bytes(b'# edited\n')
    else:
        (app / build_info.APP_INVENTORY).unlink()
    assert build_info.release_identity(tmp_path)['matches_app_build'] is False


@pytest.mark.parametrize('lines', [
    ['not an inventory line'], ['0' * 64 + ' one-space'], [], ['# only a comment'],
    ['{digest}  index.html', '{digest}  index.html'], ['{digest}  BUILD_INVENTORY.txt'], ['{digest}  ../escape.js']])
def test_an_inventory_the_build_would_not_have_written_reads_false(tmp_path, lines):
    install(tmp_path)
    app = tmp_path.joinpath(*build_info.APP_BUILD)
    digest = hashlib.sha256(b'<p>app</p>').hexdigest()
    inventory = ''.join(line.format(digest=digest) + '\n' for line in lines)
    (app / build_info.APP_INVENTORY).write_bytes(inventory.encode())
    record = json.loads((tmp_path / build_info.RELEASE_IDENTITY).read_text(encoding='utf-8'))
    record['app_build_sha256'] = hashlib.sha256(inventory.encode()).hexdigest()    # the record agrees: the inventory itself is wrong
    (tmp_path / build_info.RELEASE_IDENTITY).write_text(json.dumps(record), encoding='utf-8')
    assert build_info.release_identity(tmp_path)['matches_app_build'] is False


def test_an_app_that_cannot_be_read_is_unknown_not_edited(tmp_path, monkeypatch):
    install(tmp_path)
    real = build_info.Path.read_bytes
    def locked(self):
        if self.name == 'main.js':
            raise PermissionError('locked')
        return real(self)
    monkeypatch.setattr(build_info.Path, 'read_bytes', locked)
    assert build_info.release_identity(tmp_path)['matches_app_build'] is None
