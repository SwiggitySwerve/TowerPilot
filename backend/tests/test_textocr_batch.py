import base64
import json
import re
import subprocess
from types import SimpleNamespace

import cv2
import numpy as np
import pytest

from vision import textocr


def _batch_boundary(monkeypatch, tmp_path, output):
    temporary = textocr.tempfile.TemporaryDirectory
    monkeypatch.setattr(textocr.tempfile, 'TemporaryDirectory',
                        lambda **kw: temporary(dir=tmp_path, **kw))
    calls = []

    def run(args, **kwargs):
        script = base64.b64decode(args[-1]).decode('utf-16le')
        manifest = re.search(r"-LiteralPath '([^']+)'", script)[1]
        entries = json.loads(open(manifest, encoding='utf-8').read())
        images = [cv2.imread(entry['path']) for entry in entries]
        calls.append((script, kwargs, images))
        return output(args, entries)

    monkeypatch.setattr(textocr.settings, 'run_hidden', run)
    return calls


def test_batch_recognizes_each_crop_and_scale_separately_with_identical_vote(monkeypatch, tmp_path):
    readings = ['Alpha', 'Alpha', 'Alpba', 'Tourney Pl', 'Tourney P1', 'Tourney P1']

    def output(args, entries):
        lines = [f'TP_OCR_IMAGE\t{entry["index"]}\n4\t6\t{readings[entry["index"]]}'
                 for entry in entries]
        return SimpleNamespace(args=args, returncode=0, stderr=b'', stdout='\n'.join(lines).encode())

    calls = _batch_boundary(monkeypatch, tmp_path, output)
    crops = [np.full((10, 20, 3), 30, np.uint8), np.full((15, 25, 3), 60, np.uint8)]
    assert textocr.read_texts(crops, raise_on_error=True) == ['Alpha', 'Tourney P1']
    assert len(calls) == 1
    assert [image.shape[:2] for image in calls[0][2]] == [(20, 40), (30, 60), (40, 80),
                                                                     (30, 50), (45, 75), (60, 100)]
    assert [int(image[0, 0, 0]) for image in calls[0][2]] == [30, 30, 30, 60, 60, 60]
    assert "$ProgressPreference='SilentlyContinue'" in calls[0][0]
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize('failure', ['timeout', 'exit', 'stderr', 'truncated', 'bad_index'])
def test_batch_failures_stay_distinct_from_empty_text_and_clean_all_artifacts(monkeypatch, tmp_path, failure):
    def output(args, entries):
        if failure == 'timeout':
            raise subprocess.TimeoutExpired(args, .5)
        return SimpleNamespace(args=args, returncode=1 if failure == 'exit' else 0,
                               stderr=b'engine failed' if failure == 'stderr' else b'',
                               stdout=b'TP_OCR_IMAGE\t9' if failure == 'bad_index' else b'')

    _batch_boundary(monkeypatch, tmp_path, output)
    crop = np.zeros((10, 20, 3), np.uint8)
    with pytest.raises((subprocess.SubprocessError, ValueError)):
        textocr.read_texts([crop], scales=(2, 3), raise_on_error=True)
    assert not list(tmp_path.iterdir())
    assert textocr.read_texts([crop], scales=(2, 3)) == ['']
    assert not list(tmp_path.iterdir())


def test_batch_preserves_empty_reading_as_success_and_wrapped_line_order(monkeypatch, tmp_path):
    def output(args, entries):
        stdout = 'TP_OCR_IMAGE\t0\n40\t2\tLevel Skip\n2\t2\tEnemy Attack\nTP_OCR_IMAGE\t1\n'
        return SimpleNamespace(args=args, returncode=0, stderr=b'', stdout=stdout.encode())

    _batch_boundary(monkeypatch, tmp_path, output)
    crop = np.zeros((50, 80, 3), np.uint8)
    assert textocr.read_texts([crop, crop], scales=(1,), raise_on_error=True) == ['Enemy Attack Level Skip', '']
    assert not list(tmp_path.iterdir())


def test_batch_deadline_includes_preparation_and_cleans_all_artifacts(monkeypatch, tmp_path):
    calls = _batch_boundary(monkeypatch, tmp_path, lambda *args: None)
    times = iter((0, 2))
    monkeypatch.setattr(textocr.time, 'monotonic', lambda: next(times, 2))
    with pytest.raises(subprocess.TimeoutExpired):
        textocr.read_texts([np.zeros((10, 20, 3), np.uint8)], timeout=1, raise_on_error=True)
    assert not calls
    assert not list(tmp_path.iterdir())
