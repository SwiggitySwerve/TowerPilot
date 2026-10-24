"""Source-at-start provenance must survive later edits and packaged installs."""
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
