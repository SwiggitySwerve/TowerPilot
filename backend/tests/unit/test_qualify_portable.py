"""Portable acceptance requires execution evidence, never a JSON success claim."""
import json
import hashlib
import subprocess
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest
import paths as test_paths

ROOT = test_paths.REPO
sys.path.insert(0, str(ROOT / 'tools'))


def test_validator_refuses_stub_report(tmp_path):
    import validate_acceptance
    report = tmp_path / 'acceptance.json'
    report.write_text(json.dumps({'verdict': 'pass', 'steps': [], 'exit_code': 0}))
    assert validate_acceptance.main([str(report), '--archive', str(tmp_path / 'fake.zip')]) == 1


def test_validator_requires_archive_even_for_well_formed_claim(tmp_path):
    import validate_acceptance
    import qualify_portable
    report = tmp_path / 'acceptance.json'
    report.write_text(json.dumps({'schema_version': 1, 'archive_sha256': 'a' * 64,
                                  'verdict': 'pass', 'error': None,
                                  'checks': {k: True for k in qualify_portable.CHECKS}}))
    assert validate_acceptance.main([str(report), '--archive', str(tmp_path / 'missing.zip')]) == 1


@pytest.fixture
def package(tmp_path, monkeypatch):
    """Stub only the archive policy and child execution, exercise real extraction/reporting."""
    import qualify_portable as qp
    archive = tmp_path / 'TowerPilot-9.9.9-windows-x64.zip'
    with zipfile.ZipFile(archive, 'w') as out:
        out.writestr(archive.stem + '/backend/example.txt', 'unchanged')
    monkeypatch.setattr(qp.check_release_zips, 'main', lambda args: 0)
    return qp, archive


def child_success(*args, **kwargs):
    return SimpleNamespace(returncode=0, stdout=json.dumps(
        dict(imports=True, identity=True, app=True, config=True)), stderr='')


def test_qualification_and_independent_validation(package, monkeypatch, tmp_path):
    qp, archive = package
    calls = []

    def child(command, **kwargs):
        calls.append(kwargs['cwd'])
        assert command[0] == str(kwargs['cwd'] / 'runtime/python.exe')
        assert command[1:4] == ['-I', '-B', '-c']
        assert kwargs['env']['PATH'] == str(kwargs['cwd'] / 'runtime')
        assert 'PYTHONPATH' not in kwargs['env']
        assert ' ' in str(kwargs['cwd'])
        return child_success()

    monkeypatch.setattr(qp.subprocess, 'run', child)
    report = tmp_path / 'report.json'
    assert qp.main(['--archive', str(archive), '--report', str(report)]) == 0
    import validate_acceptance
    assert validate_acceptance.main([str(report), '--archive', str(archive)]) == 0
    assert len(calls) == 2 and calls[0] != calls[1]
    assert all(not path.exists() for path in calls)
    assert json.loads(report.read_text())['archive_sha256'] == hashlib.sha256(archive.read_bytes()).hexdigest()


def test_complete_forgery_cannot_bypass_execution(package, monkeypatch, tmp_path):
    qp, archive = package
    report = tmp_path / 'report.json'
    report.write_text(json.dumps(dict(schema_version=1, verdict='pass', error=None,
        archive_sha256=hashlib.sha256(archive.read_bytes()).hexdigest(),
        checks={k: True for k in qp.CHECKS})))
    calls = []

    def broken_child(*args, **kwargs):
        calls.append(kwargs['cwd'])
        return SimpleNamespace(returncode=1, stdout='', stderr='dependency missing')

    monkeypatch.setattr(qp.subprocess, 'run', broken_child)
    import validate_acceptance
    assert validate_acceptance.main([str(report), '--archive', str(archive)]) == 1
    assert len(calls) == 1 and not calls[0].exists()


@pytest.mark.parametrize('failure', ['exit', 'timeout', 'incomplete', 'mutated', 'missing-runtime'])
def test_failed_checks_fail_report_and_clean_up(package, monkeypatch, failure):
    qp, archive = package
    paths = []

    def child(command, **kwargs):
        paths.append(kwargs['cwd'])
        if failure == 'timeout':
            raise subprocess.TimeoutExpired(command, 120)
        if failure == 'missing-runtime':
            raise FileNotFoundError('runtime missing')
        if failure == 'mutated':
            (kwargs['cwd'] / 'backend/example.txt').write_text('changed')
        if failure == 'exit':
            return SimpleNamespace(returncode=1, stdout='', stderr='broken import')
        if failure == 'incomplete':
            return SimpleNamespace(returncode=0, stdout='{}', stderr='')
        return child_success()

    monkeypatch.setattr(qp.subprocess, 'run', child)
    result = qp.qualify(archive)
    assert result['verdict'] == 'fail' and result['error']
    assert len(paths) == 1 and not paths[0].exists()


def test_archive_gate_failure_never_executes(package, monkeypatch):
    qp, archive = package
    monkeypatch.setattr(qp.check_release_zips, 'main', lambda args: 1)
    monkeypatch.setattr(qp.subprocess, 'run', lambda *a, **k: pytest.fail('must not execute'))
    assert qp.qualify(archive)['verdict'] == 'fail'


@pytest.mark.parametrize('name', ['../escape', 'C:/escape', 'x/../../escape',
    'x/CON', 'x/name:stream', 'x/a.', 'x/a ', 'x/back\\slash'])
def test_unsafe_paths_never_extract(tmp_path, name):
    import qualify_portable as qp
    archive = tmp_path / 'x.zip'
    with zipfile.ZipFile(archive, 'w') as out:
        info = zipfile.ZipInfo('placeholder')
        info.filename = name  # bypass ZipInfo's Windows separator normalization
        out.writestr(info, b'bad')
    destination = tmp_path / 'extract'
    destination.mkdir()
    with pytest.raises(ValueError, match='unsafe'):
        qp.extract(archive, destination)
    assert list(destination.iterdir()) == []


def test_real_archive_gate_rejects_stub(tmp_path):
    import qualify_portable as qp
    archive = tmp_path / 'TowerPilot-9.9.9-windows-x64.zip'
    with zipfile.ZipFile(archive, 'w') as out:
        out.writestr(archive.stem + '/fake.txt', 'stub')
    assert qp.qualify(archive)['verdict'] == 'fail'


@pytest.mark.parametrize('action', ["__import__('socket').socket()",
    "__import__('subprocess').run(['adb', 'devices'])"])
def test_probe_guard_refuses_io_before_any_application_import(action):
    import qualify_portable as qp
    guard = qp.PROBE.split('import json')[0]
    result = subprocess.run([sys.executable, '-I', '-c', guard + '\n' + action],
                            capture_output=True, text=True, timeout=10)
    assert result.returncode != 0
    assert 'qualification refused I/O:' in result.stderr
