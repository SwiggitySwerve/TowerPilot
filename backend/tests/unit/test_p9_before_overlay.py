"""E2 (spec 3.6): the before side is the after side plus ONLY the five pauses. Both file sets run the same synthetic setup workloads of backend/tests/unit/test_setup_readiness.py
(cards, collection, mapping, module detail): the persisted results are equal and the requested waits differ exactly where the overlay says."""
import json
import sys
import types
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from device import act
from fixture_json import render_fixture_json
from paths import FIXTURES
from scan_sides_loader import ROOT, scan_sides

OVERLAY = scan_sides.load_overlay()


def side(rel, name, *, before):
    """The module at `rel` of this checkout (before=False) or with the overlay applied (before=True), executed under its own name."""
    text = (ROOT / rel).read_text(encoding='utf-8')
    if before:
        text = scan_sides.apply_hunks(text, [h for h in OVERLAY['hunks'] if h['file'] == rel])
    module = types.ModuleType(name)
    module.__file__ = str(ROOT / rel)
    sys.modules[name] = module
    exec(compile(text, str(ROOT / rel), 'exec'), module.__dict__)
    return module


@pytest.fixture(params=[False, True], ids=['after', 'before'])
def before(request):
    return request.param


# ----------------------------------------------------------------------------------------------------------------- H1 cards
def card_scan(module, tmp_path, monkeypatch):
    frame = np.random.default_rng(17).integers(0, 80, (2560, 1080, 3), dtype=np.uint8)
    waits, moves = [], []
    monkeypatch.setattr(module, 'tile_rects', lambda f: [(32, 1100, 244, 301)])
    monkeypatch.setattr(module, 'page_shift', lambda a, b: 0)
    cal = SimpleNamespace(p={'report': str(tmp_path / 'report.json')}, player={}, cut=lambda *a: {'verified': True}, save_report=lambda: None)
    result = module.scan(cal, grab=lambda: frame.copy(), swipe=lambda *a, **k: moves.append(a), read=lambda f: [(0, 0, 'Damage')], prove=lambda f: True,
                         pause=waits.append, check_stop=lambda: None)
    return result, waits, moves, json.loads((tmp_path / 'card_manifest.json').read_text())


def test_cards_before_and_after_persist_the_same_inventory_and_differ_by_the_scroll_pause(tmp_path, monkeypatch):
    after = side('backend/player/card_inventory.py', 'p9_cards_after', before=False)
    before = side('backend/player/card_inventory.py', 'p9_cards_before', before=True)
    (tmp_path / 'a').mkdir()
    (tmp_path / 'b').mkdir()
    a_result, a_waits, a_moves, a_stored = card_scan(after, tmp_path / 'a', monkeypatch)
    b_result, b_waits, b_moves, b_stored = card_scan(before, tmp_path / 'b', monkeypatch)
    assert a_stored == a_result and b_stored == b_result and a_result == b_result and a_result['complete']
    assert len(a_moves) == len(b_moves) == 4
    assert sum(a_waits) == pytest.approx(len(a_moves) * .6)
    assert sum(b_waits) - sum(a_waits) == pytest.approx(len(a_moves) * .8)
    assert sorted(b_waits) == sorted(a_waits + [.8] * len(a_moves))


# ----------------------------------------------------------------------------------------------------------------- H2 collection
def collection_scan(module, tmp_path, monkeypatch):
    state = {'position': 1}
    moves, waits = [], []
    monkeypatch.setattr(module, 'manifest', lambda: {'screens': {'list': {'scan_collection': {'viewport': [10, 20, 80, 100], 'max_pages': 8}}}})

    def swipe(x, y, x2, y2, duration, reason):
        moves.append((y, y2))
        state['position'] = max(0, min(1, state['position'] + (1 if y > y2 else -1)))

    monkeypatch.setattr(act, 'swipe', swipe)
    scanner = SimpleNamespace(cal=SimpleNamespace(p={'state': str(tmp_path / 'state.json')}), state={}, skipped=[], check_stop=lambda: None, pause=waits.append,
                              progress=lambda _: None, read=lambda f: [(5, 7, str(int(f[0, 0, 0])))],
                              observed=lambda name: (np.full((140, 110, 3), state['position'] * 40, np.uint8), []))
    module.scan(scanner, 'list')
    return json.loads((tmp_path / 'screen_collections/list/observations.json').read_text()), waits, moves


def test_collection_before_and_after_persist_the_same_observations_and_differ_by_the_scroll_pause(tmp_path, monkeypatch):
    after = side('backend/player/collection_scan.py', 'p9_collection_after', before=False)
    before = side('backend/player/collection_scan.py', 'p9_collection_before', before=True)
    (tmp_path / 'a').mkdir()
    (tmp_path / 'b').mkdir()
    a_stored, a_waits, a_moves = collection_scan(after, tmp_path / 'a', monkeypatch)
    b_stored, b_waits, b_moves = collection_scan(before, tmp_path / 'b', monkeypatch)
    assert a_stored == b_stored and a_stored['complete'] and a_moves == b_moves
    assert sum(a_waits) == pytest.approx((len(a_moves) + 1) * .3)
    assert sum(b_waits) - sum(a_waits) == pytest.approx(len(a_moves) * .7)


# ----------------------------------------------------------------------------------------------------------------- H3, H4 mapping
def mapping_run(module):
    waits, taps, observed = [], [], []
    scanner = SimpleNamespace(pause=waits.append, check_stop=lambda: None, tap=lambda *a, **k: taps.append((a, k)),
                              observed=lambda name: observed.append(name) or ('frame', ['line']))
    session = module.Session.__new__(module.Session)
    session.scanner = scanner
    session.expected = 'home'
    session.edge = {'action': 'open perks', 'destination': 'perks_hub'}
    seen = session.observe()
    session.tap(10, 20)
    return seen, waits, taps, observed, session.expected


def test_mapping_before_and_after_do_the_same_work_and_differ_by_the_observe_and_tap_pauses():
    after = mapping_run(side('backend/player/mapping_session.py', 'p9_mapping_after', before=False))
    before = mapping_run(side('backend/player/mapping_session.py', 'p9_mapping_before', before=True))
    assert after[0] == before[0] == (('frame', 'home'))
    assert after[2:] == before[2:] and after[4] == 'perks_hub'
    assert after[1] == []
    assert before[1] == [.25, .8]


# ----------------------------------------------------------------------------------------------------------------- H5 module detail
def module_run(module_name, before, monkeypatch, markers):
    """The workload of test_setup_readiness.test_module_opening_observes_animation (the 'grid' outcome) on the Scanner of this side. `markers` are the frames
    the device shows after the tile is tapped: the after side polls through the opening animation (frame 1 is mid-animation), the before side's fixed wait lets
    the animation finish, so its first frame is already settled."""
    from interactions import inventory
    from player import module_descriptor
    from vision import pills, textocr
    bootstrap = side('backend/player/bootstrap.py', module_name, before=before)
    grid = np.random.default_rng(18).integers(0, 200, (2560, 1080, 3), dtype=np.uint8)
    grid[0, 0] = 0
    frames = []
    for marker in markers:
        frame = grid.copy()
        frame[0, 0] = marker
        frames.append(frame)
    frames.append(grid.copy())
    waits, taps, cuts, readings = [], [], [], []
    monkeypatch.setattr(pills, 'grid_rows', lambda f: [1100])
    monkeypatch.setattr(inventory, '_find_close', lambda f: (927, 878) if f[0, 0, 0] else None)

    def locate(icon, frame):
        marker = int(frame[0, 0, 0])
        if marker == 1:
            raise RuntimeError('artwork still opening')
        readings.append(marker)
        return [200, 900, 150, 150]

    monkeypatch.setattr(module_descriptor, 'locate_icon', locate)
    monkeypatch.setattr(textocr, 'read_lines', lambda *a: [(0, 0, 'Epic'), (20, 0, 'Death Penalty')])
    scanner = bootstrap.Scanner.__new__(bootstrap.Scanner)
    scanner.cal = SimpleNamespace(cut=lambda *a: cuts.append(a))
    scanner.skipped = []
    scanner.asset_folder = None
    scanner.check_stop = lambda: None
    scanner.progress = lambda s: None
    scanner.observed = lambda name: (grid.copy(), [])
    scanner.tap = lambda *a, **k: taps.append(a)
    scanner.grab = lambda: frames.pop(0)
    scanner.pause = waits.append
    scanner.read = lambda f: []
    scanner.cut = lambda *a, **k: None
    monkeypatch.setattr(bootstrap, 'screen_matches', lambda f, lines, name: not f[0, 0, 0])
    scanner.module_detail(grid)
    return cuts, taps, waits, readings, frames


def test_module_detail_before_waits_once_where_the_after_side_polls_and_reads_the_same_module(monkeypatch):
    a_cuts, a_taps, a_waits, a_readings, a_left = module_run('p9_bootstrap_after', False, monkeypatch, (1, 2, 3, 4))
    b_cuts, b_taps, b_waits, b_readings, b_left = module_run('p9_bootstrap_before', True, monkeypatch, (3, 4))
    assert [c[1] for c in a_cuts] == [c[1] for c in b_cuts] == ['modules/death_penalty.png'] and a_taps == b_taps
    assert a_waits == [.25, .25, .3, .6]                       # settle polls (two steps), the follow-up frame and the close check
    assert b_waits[0] == .8 and b_waits[1:] == [.3, .6]         # one fixed wait, then the same follow-up frame and close check
    settle_polls = sum(a_waits[:2])
    assert sum(b_waits) - sum(a_waits) == pytest.approx(.8 - settle_polls)        # the per-site accounting: added fixed wait minus the settle polls it replaces
    assert a_left == [] and b_left == []
    assert a_readings == [2, 3, 3, 4] and b_readings == [3, 4]          # the settle check reads the descriptor position twice; the fixed wait reads it once per frame


# ------------------------------------------------------------------------------------------------------ E3: the overlay is exactly the five pauses
HUNKS = OVERLAY['hunks']


def test_the_overlay_applies_forward_and_reverses_to_the_same_bytes():
    forward = scan_sides.overlay_bytes(ROOT, OVERLAY)
    assert set(forward) == {h['file'] for h in HUNKS} and len(HUNKS) == 5
    for rel, data in forward.items():
        landed = (ROOT / rel).read_bytes()
        assert data != landed
        back = scan_sides.apply_hunks(data.decode('utf-8'), [h for h in HUNKS if h['file'] == rel], reverse=True).encode('utf-8')
        assert back == landed, rel


@pytest.mark.parametrize('hunk', HUNKS, ids=[h['id'] for h in HUNKS])
def test_each_hunk_only_adds_its_pause(hunk):
    if hunk['id'] == 'H5':          # a fixed wait and one grab replace the settle poll (module_descriptor.settled_panel)
        assert 'settled_panel' in hunk['old'] and 'settled_panel' not in hunk['new'] and hunk['new'].count('self.pause(.8)') == 1 and hunk['new'].count('self.grab()') == 1
        return
    kept = [line for line in hunk['new'].splitlines() if line.strip() != hunk['restores']]
    assert kept == hunk['old'].splitlines() and hunk['new'].splitlines().count(next(l for l in hunk['new'].splitlines() if l.strip() == hunk['restores'])) == 1


@pytest.mark.parametrize('hunk', HUNKS, ids=[h['id'] for h in HUNKS])
def test_the_recorded_pause_length_is_the_one_the_hunk_restores(hunk):
    import re
    assert [float(value) for value in re.findall(r'pause\((\.\d+)\)', hunk['new']) if value] == [hunk['adds_pause_s']]


HISTORY_PATH = FIXTURES / 'p9b_17befd2_hunks.json'


def history():
    """The recorded diff of the overlay's source commit (backend/tests/fixtures/p9b_17befd2_hunks.json). The packaging tool captured it once with a read-only `git show`; the tests read this file and never Git."""
    return json.loads(HISTORY_PATH.read_text(encoding='utf-8'))


def git_hunks(commit, rel):
    """The diff hunks `commit` made in `rel`, each a list of (kind, stripped text) with kind ' ' context, '-' removed, '+' added."""
    document = history()
    assert document['commit'].startswith(commit), (commit, document['commit'])
    return [[(row[0], row[1:]) for row in rows] for rows in document['files'][rel]]


def test_the_recorded_history_is_the_overlays_commit_for_exactly_the_overlay_files():
    document = history()
    assert document['schema_version'] == 1 and len(document['commit']) == 40 and document['commit'].startswith(OVERLAY['source_commit'])
    assert sorted(document['files']) == scan_sides.files_of(OVERLAY)
    for rel, hunks in document['files'].items():
        assert hunks and all(rows and all(row[0] in ' -+' for row in rows) for rows in hunks), rel


def test_the_recorded_history_is_written_by_the_compact_fixture_writer():
    assert HISTORY_PATH.read_bytes().decode('utf-8') == render_fixture_json(history())


def test_the_history_tests_start_no_process_and_so_never_run_git():
    import ast
    for path in (Path(__file__),):
        modules = {alias.name.split('.')[0] for node in ast.walk(ast.parse(path.read_text(encoding='utf-8'))) if isinstance(node, ast.Import) for alias in node.names}
        modules |= {node.module.split('.')[0] for node in ast.walk(ast.parse(path.read_text(encoding='utf-8'))) if isinstance(node, ast.ImportFrom) and node.module}
        assert 'subprocess' not in modules, path.name


ANCHOR = {'H1': 0, 'H2': 0, 'H3': 0, 'H4': 1, 'H5': 0}      # which line of the hunk's landed text names the diff hunk it belongs to (swipe, act.swipe, def observe, self.expected, def grab_panel)


def line_before_restored(hunk):
    """The stripped line that sits directly above the hunk's first restored line once the hunk is applied to the landed file."""
    text = scan_sides.apply_hunks((ROOT / hunk['file']).read_text(encoding='utf-8'), [hunk]).replace('\r\n', '\n')
    new_lines = hunk['new'].splitlines()
    first = next(i for i, line in enumerate(new_lines) if line.strip() == hunk['restores'].splitlines()[0].strip())
    return text.splitlines()[text[:text.index(hunk['new'])].count('\n') + first - 1].strip()


@pytest.mark.parametrize('hunk', HUNKS, ids=[h['id'] for h in HUNKS])
def test_the_overlay_restores_the_lines_the_17befd2_commit_removed(hunk):
    """E3, by correspondence: the diff hunk of 17befd2 that holds the hunk's anchor line removed the restored line(s), directly below the line the overlay puts them under."""
    anchor = hunk['old'].splitlines()[ANCHOR[hunk['id']]].strip()
    restored = [line.strip() for line in hunk['restores'].splitlines()]
    wanted = [line_before_restored(hunk)] + restored
    candidates = [rows for rows in git_hunks(OVERLAY['source_commit'], hunk['file']) if anchor in {text for _, text in rows}]
    assert candidates, ('no diff hunk of the commit holds the anchor line', hunk['id'], anchor)
    corresponding = []
    for rows in candidates:
        removed = [text for kind, text in rows if kind == '-']
        parent_side = [text for kind, text in rows if kind in (' ', '-')]          # what the commit's parent had
        adjacent = any(parent_side[i:i + len(wanted)] == wanted for i in range(len(parent_side) - len(wanted) + 1))
        if all(line in removed for line in restored) and adjacent:
            corresponding.append(rows)
    assert corresponding, ('the commit did not remove these lines directly below that line in the diff hunk of the anchor', hunk['id'], wanted)


def test_the_overlay_does_not_touch_a_file_that_is_not_measured():
    scan_identity = __import__('runtime.scan_identity', fromlist=['x'])
    assert {h['file'] for h in HUNKS} <= set(scan_identity.MEASURED_FILES)
