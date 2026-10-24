"""The latency gate for the fast rules (roadmap item 7, spec 3.7, package r18c). The harness and its method: `latency_gate.py`. The pinned unmigrated code and the recorded baseline:
`fixtures/latency_gate/` (README.md there). This package changes no behaviour: the gate exists, and passes on the unmigrated code, BEFORE any fast-site row (C-3 fast rescue, C-4 fleet nuke)
moves onto the schedule policies.

What a migration must not do, and how this file holds it to that:
  * add I/O before the first tap or anywhere on the path (a sqlite connection, a file open, a lock, an image, a log event): `test_the_live_orchestrator_does_no_more_io_...` against counts
    recorded on the unmigrated code, and one negative control per counter showing the gate sees it;
  * add time: p99 of the added whole-call cost <= 100 us and of the added deciding-frame-to-first-tap <= 1 ms, over a seeded 10,000-iteration workload replayed through the unmigrated snapshot and
    the live orchestrator back to back: `test_the_added_cost_...`; negative controls inject 250 us and 2 ms and must fail, and a 60 us injection must be MEASURED as about 60 us;
  * hide a regression behind a vacuous replay: every path is checked to tap (or not) as its name says, the two sides must do identical things on every iteration, and the harness reports ~0
    when both sides are the same code.

Regenerate the structural baseline only on the unmigrated snapshot, as an explicit command (it erases the proof if run after a migration):
    TP_REGENERATE_LATENCY_BASELINE=1 python -m pytest backend/tests/unit/test_action_latency_gate.py -k capture_the_structural_baseline
Keep the artifact of a run: TP_LATENCY_GATE_ARTIFACT=<path> (the test writes one to a temporary folder either way).
"""
import builtins
import gc
import io
import json
import math
import os
import sqlite3
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

import latency_gate as gate

REGENERATE = 'TP_REGENERATE_LATENCY_BASELINE'
ARTIFACT = 'TP_LATENCY_GATE_ARTIFACT'
_BASELINE = {}


def baseline():
    if not _BASELINE:
        _BASELINE.update(json.loads(gate.BASELINE_PATH.read_text(encoding='utf-8')))
    return _BASELINE


# ----------------------------------------------------------------------------------------- the variants
BURN = '\n\ndef _gate_burn_us(us):\n    end = time.perf_counter_ns() + int(us * 1000)\n    while time.perf_counter_ns() < end:\n        pass\n'
FIRE_TAP = '        ev = act.tap(*st.center, reason=reason)\n'
SAMPLE_TOP = '        frame = capture.grab()\n        sample += 1\n'
BURST_TAP = '                if sprint_pt is not None:\n                    act.tap(*sprint_pt, reason="rescue_sprint", instant=True)'
FIRE_SETTLE = '    time.sleep(0.8)                      # let the cooldown state render\n'


@pytest.fixture(scope='module')
def snapshot_text():
    return gate.SNAPSHOT_PATH.read_text(encoding='utf-8')


@pytest.fixture
def make_variant(tmp_path, snapshot_text):
    """A copy of the unmigrated snapshot with one deliberate change (`old` must occur exactly once), as a file the harness can load. `_gate_burn_us` busy-waits that long."""
    def make(old, new, name='variant'):
        assert snapshot_text.count(old) == 1, (snapshot_text.count(old), old)
        path = tmp_path / f'{name}.py.txt'
        path.write_text(snapshot_text.replace(old, new) + BURN, encoding='utf-8', newline='\n')
        return path
    return make


@pytest.fixture
def lock_file(tmp_path, monkeypatch):
    monkeypatch.setenv('TP_GATE_PATH', str(tmp_path / 'probe.lock'))
    return tmp_path / 'probe.lock'


# ----------------------------------------------------------------------------------------- the recorded baseline
@pytest.mark.skipif(not os.environ.get(REGENERATE), reason='explicit developer command, never a test side effect')
def test_capture_the_structural_baseline():
    first, second = gate.record_baseline(), gate.record_baseline()
    assert first == second, 'the structural counts are not deterministic'
    gate.BASELINE_PATH.parent.mkdir(parents=True, exist_ok=True)
    gate.BASELINE_PATH.write_bytes((json.dumps(first, indent=1, sort_keys=True) + '\n').encode('utf-8'))
    assert json.loads(gate.BASELINE_PATH.read_text(encoding='utf-8')) == first


def test_the_baseline_was_recorded_on_the_pinned_snapshot_and_the_snapshot_is_unchanged():
    recorded = baseline()['captured_on']
    assert recorded['snapshot_sha256'] == gate.sha256(gate.SNAPSHOT_PATH), 'the pinned unmigrated snapshot was edited: it is the reference and must never change'
    assert recorded['functions'] == gate.function_hashes(gate.SNAPSHOT_PATH)
    assert set(recorded['functions']) >= {'_fast_wall_watch', 'fire_button', 'fleet_gate', 'watch_frame', 'demon_mode_always', '_run_rules', 'eval_rules'}


def test_every_measured_path_has_a_recorded_baseline_and_nothing_else_does():
    assert set(baseline()['paths']) == set(gate.PATHS)
    assert baseline()['counters'] == list(gate.COUNTERS)


def test_the_recorded_baseline_replays_on_the_snapshot_exactly():
    assert gate.structural_counts(gate.SNAPSHOT_PATH) == baseline()['paths'], 'the harness no longer measures what it recorded: regenerate ONLY if the harness changed, never after a migration'


def test_the_recorded_baseline_is_not_vacuous():
    paths = baseline()['paths']
    quiet = paths['fast_idle_samples']['total']
    assert not any(quiet.values()), 'a pass of nothing-to-do samples does no I/O today'
    assert paths['fast_checkpoint_sample']['total']['sqlite_connect'] > 0, 'the eighth-sample checkpoint reads the ledger: that I/O is in the baseline'
    assert paths['fast_fleet_fire']['before_first_tap']['sqlite_connect'] == paths['fast_fleet_fire']['total']['sqlite_connect'] > 0, 'it happens before the inline fleet tap'
    for name in ('fast_burst_with_sprint_cancel', 'fast_burst_demon_mode_only', 'hp_rescue_fire', 'fire_button_with_confirmation', 'rules_pass_fire_and_defer', 'watch_frame_fleet_fire'):
        assert paths[name]['first_tap'] is True and paths[name]['total']['event'] >= 1, name
    assert paths['fast_strict_unmatched']['first_tap'] is False and paths['fast_strict_unmatched']['total']['event'] == 1
    assert paths['hp_rescue_fire']['before_first_tap']['event'] == 1 and paths['hp_rescue_fire']['before_first_tap']['shot'] == 1, 'the rescue event and its shot precede the tap today'
    assert all(not paths[name]['before_first_tap'] for name in paths if not paths[name]['first_tap'])


# ----------------------------------------------------------------------------------------- every path does what its name says
EXPECTED = {   # path: (taps in order, result, events in order)
    'fast_idle_samples': ([], 'immune', []),
    'fast_checkpoint_sample': ([], 'immune', []),
    'fast_fleet_fire': (['fleet_1495'], 'immune', ['fire', 'fleet_nuke']),
    'fast_burst_with_sprint_cancel': (['rescue_sprint', 'rescue_sprint_yes', 'rescue_dm_0.150'], 'fired', ['rescue', 'rescue_confirm']),
    'fast_burst_demon_mode_only': (['rescue_dm_0.150'], 'fired', ['rescue', 'rescue_confirm']),
    'fast_strict_unmatched': ([], 'immune', ['rescue_dm_unmatched']),
    'hp_rescue_fire': (['rescue_0.100'], False, ['rescue', 'fire']),
    'watch_frame_idle': ([], False, []),
    'watch_frame_demon_mode_always': (['demon_mode_always'], False, ['fire', 'demon_mode_always']),
    'watch_frame_fleet_fire': (['fleet_1495'], False, ['fire', 'fleet_nuke']),
    'watch_frame_wall_watch_entry': ([], False, []),
    'rules_pass_nothing_to_do': ([], None, ['rule_suppressed']),
    'rules_pass_fire_and_defer': (['first'], None, ['fire', 'rule_fire', 'rule_suppressed']),
    'fire_button_with_confirmation': (['gate'], True, ['fire']),
}


@pytest.fixture(scope='module')
def snapshot_world():
    return gate.World(gate.load_orchestrator(gate.SNAPSHOT_PATH, '_latency_gate_test_world'))


def test_the_expectations_cover_every_path():
    assert set(EXPECTED) == set(gate.PATHS)


@pytest.mark.parametrize('name', sorted(gate.PATHS))
def test_every_path_taps_and_decides_as_its_name_says(snapshot_world, name):
    """A script that silently did nothing would make the gate vacuous: no tap to time, nothing to count."""
    path = gate.PATHS[name]
    sessions = gate.RealSessions() if path.session else None
    try:
        with gate.quiet_replay():
            _, tap, digest = gate.measure(snapshot_world, path, 0, sessions)
    finally:
        if sessions:
            sessions.close()
        snapshot_world.m._battle_session = None
    taps, result, events = EXPECTED[name]
    assert [reason for _x, _y, reason in digest[0]] == taps
    assert digest[1] == repr(result)
    assert [kind for kind, _ in snapshot_world.log.events] == events
    assert (tap is not None) == path.has_tap == bool(taps)


def test_the_workload_is_seeded_complete_and_weighted():
    first, second = gate.make_workload(10_000), gate.make_workload(10_000)
    assert first == second and len(first) == 10_000
    assert gate.make_workload(10_000, seed=1) != first
    shares = {name: sum(1 for n, _ in first if n == name) / 10_000 for name in gate.PATHS}
    total = sum(path.weight for path in gate.PATHS.values())
    for name, path in gate.PATHS.items():
        assert 0.75 * path.weight / total < shares[name] < 1.25 * path.weight / total, (name, shares[name])


def test_a_workload_can_be_limited_to_some_paths():
    only = {'fire_button_with_confirmation', 'watch_frame_idle'}
    work = gate.make_workload(300, only=only)
    assert len(work) == 300 and {name for name, _ in work} == only


# ----------------------------------------------------------------------------------------- the structural gate
@pytest.fixture(scope='module')
def live_structural():
    return gate.structural_counts()


def test_the_live_orchestrator_does_no_more_io_than_the_baseline_on_any_path(live_structural):
    """Up to the first tap and in total: no sqlite connection, file open, lock, image write, log event or shot beyond what the unmigrated code did."""
    assert gate.structural_failures(live_structural, baseline()) == []


def test_structural_failures_name_the_path_the_scope_and_the_counter():
    recorded = baseline()
    counts = json.loads(json.dumps(recorded['paths']))
    assert gate.structural_failures(counts, recorded) == []
    for counter in gate.COUNTERS:
        for scope in ('before_first_tap', 'total'):
            changed = json.loads(json.dumps(recorded['paths']))
            changed['fire_button_with_confirmation'][scope][counter] += 1
            if scope == 'before_first_tap':
                changed['fire_button_with_confirmation']['total'][counter] += 1
            failures = gate.structural_failures(changed, recorded)
            assert any(f'fire_button_with_confirmation: {scope} {counter}' in line for line in failures), (counter, scope, failures)
    fewer = json.loads(json.dumps(recorded['paths']))
    fewer['fast_checkpoint_sample']['total']['sqlite_connect'] = 0
    assert gate.structural_failures(fewer, recorded) == [], 'doing LESS I/O than the baseline is allowed'
    lost = json.loads(json.dumps(recorded['paths']))
    del lost['hp_rescue_fire']
    assert any('hp_rescue_fire' in line and 'not measured' in line for line in gate.structural_failures(lost, recorded))
    silent = json.loads(json.dumps(recorded['paths']))
    silent['hp_rescue_fire']['first_tap'] = False
    assert any('hp_rescue_fire' in line and 'tapped' in line for line in gate.structural_failures(silent, recorded))


STRUCTURAL_VARIANTS = [   # (name, old, new, counter, scope that must show it)
    ('sqlite_before_the_tap', FIRE_TAP, '        __import__("sqlite3").connect(":memory:").close()\n' + FIRE_TAP, 'sqlite_connect', 'before_first_tap'),
    ('open_in_the_sample_body', SAMPLE_TOP, SAMPLE_TOP + '        open(__import__("os").devnull).close()\n', 'file_open', 'before_first_tap'),
    ('path_open_in_the_sample_body', SAMPLE_TOP, SAMPLE_TOP + '        __import__("pathlib").Path(__import__("os").devnull).open().close()\n', 'file_open', 'before_first_tap'),
    ('real_logger_event_in_the_sample_body', SAMPLE_TOP, SAMPLE_TOP + '        __import__("runtime.logger").logger.event("gate_probe")\n', 'event', 'before_first_tap'),
    ('real_logger_shot_in_the_sample_body', SAMPLE_TOP, SAMPLE_TOP + '        __import__("runtime.logger").logger.shot(frame, "gate_probe")\n', 'shot', 'before_first_tap'),
    ('lock_before_the_tap', FIRE_TAP, '        from runtime import file_lock as _fl\n        _fl.unlock(_fl.try_lock(__import__("os").environ["TP_GATE_PATH"]))\n' + FIRE_TAP, 'lock_acquire', 'before_first_tap'),
    ('event_in_the_sample_body', SAMPLE_TOP, SAMPLE_TOP + '        logger.event("gate_probe")\n', 'event', 'before_first_tap'),
    ('shot_in_the_sample_body', SAMPLE_TOP, SAMPLE_TOP + '        logger.shot(frame, "gate_probe")\n', 'shot', 'before_first_tap'),
    ('image_written_after_the_tap', FIRE_SETTLE, '    __import__("cv2").imwrite(__import__("os").environ["TP_GATE_PATH"] + ".png", __import__("numpy").zeros((2, 2, 3), "uint8"))\n' + FIRE_SETTLE, 'image_write', 'total'),
    ('record_written_after_the_tap', FIRE_SETTLE, '    __import__("sqlite3").connect(":memory:").close()\n' + FIRE_SETTLE, 'sqlite_connect', 'total'),
]


@pytest.mark.parametrize('name,old,new,counter,scope', STRUCTURAL_VARIANTS, ids=[v[0] for v in STRUCTURAL_VARIANTS])
def test_the_structural_gate_sees_each_kind_of_added_io(make_variant, lock_file, name, old, new, counter, scope):
    if counter == 'lock_acquire':
        pytest.importorskip('runtime.file_lock', reason='the file lock is introduced by r18a')
    variant = make_variant(old, new, name)
    failures = gate.structural_failures(gate.structural_counts(variant), baseline())
    assert failures, f'{name}: the gate did not see it'
    allowed = {counter} | ({'file_open'} if counter == 'lock_acquire' else set())          # taking a lock opens its file
    assert all(any(f' {c} ' in line for c in allowed) for line in failures), failures
    assert any(f': {scope} {counter}' in line for line in failures), failures
    if scope == 'total':
        assert not any('before_first_tap' in line for line in failures), 'a write AFTER the tap must not be reported as one before it'


def test_the_structural_pass_counts_only_the_calling_thread():
    world = SimpleNamespace(log=SimpleNamespace(events=[], shots=[]))
    meter = gate.Meter(world)
    noise = threading.Thread(target=lambda: (open(os.devnull).close(), sqlite3.connect(':memory:').close()))
    with meter.instrument():
        noise.start()
        noise.join()
        open(os.devnull).close()
    assert meter.counts['file_open'] == 1 and meter.counts['sqlite_connect'] == 0


def test_the_instruments_are_removed_afterwards():
    originals = (builtins.open, io.open, sqlite3.connect, time.sleep, gc.isenabled())
    gate.structural_counts()
    gate.paired_replay(gate.SNAPSHOT_PATH, gate.SNAPSHOT_PATH, iterations=30, warmup=5)
    assert (builtins.open, io.open, sqlite3.connect, time.sleep, gc.isenabled()) == originals
    from runtime import logger
    assert logger.event.__module__ == 'runtime.logger' and logger.shot.__module__ == 'runtime.logger'
    assert not [key for key in sys.modules if key.startswith('_latency_gate')]
    import importlib
    assert not hasattr(sys.modules['runtime.logger'], 'events'), 'the fake logger was left installed'
    for package, name in (('device', 'act'), ('device', 'capture'), ('vision', 'detect'), ('vision', 'screen')):
        assert hasattr(getattr(importlib.import_module(package), name), '__file__'), f'{package}.{name} is still a fake'


# ----------------------------------------------------------------------------------------- the timing gate
def test_the_added_cost_of_the_live_orchestrator_is_within_the_targets(tmp_path, live_structural):
    """10,000 seeded iterations over fourteen paths, the unmigrated snapshot against the live orchestrator, back to back. p99 of the added whole-call cost <= 100 us and of the added
    deciding-frame-to-first-tap <= 1 ms, overall and on every path."""
    result = gate.run_gate()
    record = gate.artifact(result, live_structural, baseline())
    text = json.dumps(record, indent=1, sort_keys=True) + '\n'
    (tmp_path / 'latency-gate-artifact.json').write_text(text, encoding='utf-8')
    if os.environ.get(ARTIFACT):
        Path(os.environ[ARTIFACT]).write_text(text, encoding='utf-8')
    final = result['final']
    assert result['passed'], final['verdict']['failures']
    replay = final['replay']
    assert replay['iterations'] == 10_000 and replay['behavior_mismatches'] == []
    for name, path in gate.PATHS.items():
        assert len(replay['pass_us'][name]) > 100, f'{name} was barely exercised'
        assert (len(replay['tap_us'][name]) > 0) == path.has_tap, name
    assert record['timing']['passed'] and record['structural']['passed']


def test_the_artifact_records_source_build_hardware_warmup_and_the_distributions(tmp_path):
    result = gate.run_gate(iterations=200)
    record = gate.artifact(result, gate.structural_counts(), baseline())
    assert set(record) == {'version', 'targets', 'environment', 'sources', 'migrated_fast_functions', 'method', 'timing', 'structural'}
    assert record['targets'] == dict(policy_us=100.0, first_tap_us=1000.0)
    assert record['environment']['python'] and record['environment']['processor'] and record['environment']['cpu_count'] and record['environment']['clock_resolution_ns'] >= 0
    assert {'candidate', 'unmigrated_snapshot', 'harness', 'fakes'} == set(record['sources']) and record['sources']['unmigrated_snapshot']['sha256'] == baseline()['captured_on']['snapshot_sha256']
    assert record['method']['warmup_dropped'] == gate.WARMUP and record['method']['repeats_min_of'] == gate.REPEATS and record['method']['gc'] and record['method']['seed'] == gate.SEED
    overall = record['timing']['overall']['added_pass_us']
    assert set(overall) == {'n', 'min', 'p50', 'p90', 'p99', 'p999', 'max', 'mean'} and overall['n'] == 200
    assert record['timing']['per_path'] and set(record['timing']['per_path']) <= set(gate.PATHS)
    assert record['migrated_fast_functions'] == [name for name in sorted(record['sources']['candidate']['fast_functions']) if record['sources']['candidate']['fast_functions'][name] != baseline()['captured_on']['functions'][name]]
    json.dumps(record)


def test_the_harness_reports_nothing_when_both_sides_are_the_same_code():
    """The noise floor: identical code on both sides adds ~0, so what a real regression adds is not an artifact of the method."""
    result = gate.run_gate(candidate=gate.SNAPSHOT_PATH, iterations=3000)
    assert result['passed']
    overall = result['final']['verdict']['overall']
    assert abs(overall['added_pass_us']['p50']) < 1.0 and overall['added_pass_us']['p99'] < 25.0 and overall['added_first_tap_us']['p99'] < 25.0
    assert abs(overall['added_pass_us']['mean']) < 1.0


@pytest.mark.parametrize('name,old,new,limit', [
    ('250_us_before_the_fire_tap', FIRE_TAP, '        _gate_burn_us(250)\n' + FIRE_TAP, 'policy cost'),
    ('250_us_in_every_sample', SAMPLE_TOP, '        frame = capture.grab()\n        _gate_burn_us(250)\n        sample += 1\n', 'policy cost'),
    ('2_ms_before_the_burst_tap', BURST_TAP, '                _gate_burn_us(2000)\n' + BURST_TAP, 'frame-to-first-tap'),
], ids=['fire_tap_250us', 'sample_250us', 'burst_tap_2ms'])
def test_a_deliberately_slow_variant_fails_the_timing_gate_and_names_the_limit(make_variant, name, old, new, limit):
    result = gate.run_gate(candidate=make_variant(old, new, name), iterations=600, warmup=30)
    assert not result['passed'] and result['repeated'], 'a real regression fails the replay and its repeat'
    assert any(limit in line for line in result['final']['verdict']['failures']), result['final']['verdict']['failures']
    assert all(not a['verdict']['passed'] for a in result['attempts'])


def test_a_small_injected_delay_is_measured_at_about_its_size_and_stays_inside_the_target(make_variant):
    """60 us is under the 100 us target: the gate passes it, and the harness must report it as ~60 us (not 6, not 600)."""
    variant = make_variant(FIRE_TAP, '        _gate_burn_us(60)\n' + FIRE_TAP, 'sixty')
    result = gate.run_gate(candidate=variant, iterations=1500, only={'fire_button_with_confirmation'})
    block = result['final']['verdict']['per_path']['fire_button_with_confirmation']
    assert 50.0 < block['added_pass_us']['p50'] < 90.0 and 50.0 < block['added_first_tap_us']['p50'] < 90.0, block
    assert result['passed']


def test_a_candidate_that_taps_something_else_fails_at_once_and_is_not_repeated(make_variant):
    variant = make_variant(FIRE_TAP, '        ev = act.tap(*st.center, reason=reason + "_changed")\n', 'different')
    result = gate.run_gate(candidate=variant, iterations=300, warmup=20)
    assert not result['passed'] and not result['repeated'] and len(result['attempts']) == 1
    assert 'did different things' in result['final']['verdict']['failures'][0]
    assert result['final']['replay']['behavior_mismatches'][0]['reason'].startswith('baseline and candidate did different things')


def test_each_side_keeps_the_fastest_of_its_repeats_and_the_order_alternates(monkeypatch):
    seen, scripts = [], {'_latency_gate_baseline': iter([100_000, 50_000, 80_000]), '_latency_gate_candidate': iter([90_000, 200_000, 60_000])}
    taps = {'_latency_gate_baseline': iter([30_000, 40_000, 20_000]), '_latency_gate_candidate': iter([35_000, 25_000, 90_000])}

    def scripted(world, path, variation, ctx=None):
        key = world.m.__name__
        seen.append(key)
        return next(scripts[key]), next(taps[key]), ((), 'same')
    monkeypatch.setattr(gate, 'measure', scripted)
    replay = gate.paired_replay(gate.SNAPSHOT_PATH, gate.SNAPSHOT_PATH, iterations=1, warmup=0, repeats=3, only={'fire_button_with_confirmation'})
    assert replay['pass_us']['fire_button_with_confirmation'] == [(60_000 - 50_000) / 1000.0]
    assert replay['tap_us']['fire_button_with_confirmation'] == [(25_000 - 20_000) / 1000.0]
    assert seen[0::2] != seen[1::2] and seen[:2] != seen[2:4], 'the side that goes first alternates by repeat'
    assert sorted(seen) == ['_latency_gate_baseline'] * 3 + ['_latency_gate_candidate'] * 3


def test_warmup_iterations_are_replayed_but_not_counted():
    replay = gate.paired_replay(gate.SNAPSHOT_PATH, gate.SNAPSHOT_PATH, iterations=40, warmup=25, only={'watch_frame_idle'})
    assert len(replay['pass_us']['watch_frame_idle']) == 40 and replay['warmup'] == 25


def test_the_quiet_replay_silences_sleep_and_garbage_collection_and_restores_them():
    sleeper, enabled = time.sleep, gc.isenabled()
    started = time.perf_counter()
    with gate.quiet_replay():
        time.sleep(3)
        assert not gc.isenabled()
    assert time.perf_counter() - started < 1.0 and time.sleep is sleeper and gc.isenabled() == enabled


def test_the_workload_without_a_seed_would_differ_and_with_it_does_not():
    assert gate.make_workload(200, seed=5) == gate.make_workload(200, seed=5) != gate.make_workload(200, seed=6)


def test_a_faster_candidate_is_not_a_failure(make_variant):
    """The sign: the added cost is candidate minus baseline. Slowing the BASELINE side must give negative numbers, never a failure."""
    slow = make_variant(FIRE_TAP, '        _gate_burn_us(250)\n' + FIRE_TAP, 'slow_baseline')
    replay = gate.paired_replay(slow, gate.SNAPSHOT_PATH, iterations=800, only={'fire_button_with_confirmation'})
    verdict = gate.evaluate(replay)
    assert verdict['passed'] and verdict['overall']['added_pass_us']['p50'] < -200.0

# ----------------------------------------------------------------------------------------- the arithmetic
def test_percentile_is_nearest_rank():
    ordered = list(range(1, 101))
    assert gate.percentile(ordered, 0.99) == 99 and gate.percentile(ordered, 0.5) == 50 and gate.percentile(ordered, 1.0) == 100
    assert gate.percentile(list(range(1, 1001)), 0.99) == 990 and gate.percentile(list(range(1001, 0, -1)), 0.99) == 991   # unsorted input is sorted first
    assert gate.percentile([7.0], 0.99) == 7.0 and gate.percentile([3, 1], 0.99) == 3
    assert gate.summarize([]) is None
    summary = gate.summarize([float(n) for n in range(1, 1001)])
    assert (summary['n'], summary['min'], summary['p50'], summary['p90'], summary['p99'], summary['p999'], summary['max']) == (1000, 1.0, 500.0, 900.0, 990.0, 999.0, 1000.0)


def synthetic(values, taps=None, name='fire_button_with_confirmation', mismatches=()):
    pass_us = {path: [] for path in gate.PATHS}
    tap_us = {path: [] for path in gate.PATHS}
    pass_us[name], tap_us[name] = list(values), list(values if taps is None else taps)
    return dict(iterations=len(values), warmup=0, repeats=1, seed=1, pass_us=pass_us, tap_us=tap_us, behavior_mismatches=list(mismatches))


def test_the_p99_decides_a_rare_spike_does_not_and_a_one_percent_regression_does():
    base = [0.0] * 1000
    assert gate.evaluate(synthetic(base[:-5] + [900.0] * 5))['passed'], '0.5% slow is under the 99th percentile'
    failed = gate.evaluate(synthetic(base[:-11] + [150.0] * 11))
    assert not failed['passed'] and any('p99 added policy cost 150.0 us > 100.0 us' in line for line in failed['failures'])
    assert gate.evaluate(synthetic([100.0] * 1000))['passed'], 'exactly the target passes (strictly greater fails)'
    assert not gate.evaluate(synthetic([100.001] * 1000))['passed']
    assert gate.evaluate(synthetic([0.0] * 1000, taps=[1000.0] * 1000))['passed']
    tap_failed = gate.evaluate(synthetic([0.0] * 1000, taps=[1000.5] * 1000))
    assert not tap_failed['passed'] and any('frame-to-first-tap' in line for line in tap_failed['failures'])


def test_every_path_is_judged_on_its_own_not_only_overall():
    """A regression confined to a rare path is diluted overall; the per-path p99 is what catches it."""
    values = {name: [0.0] * 400 for name in gate.PATHS}
    values['hp_rescue_fire'] = [0.0] * 395 + [300.0] * 5                  # 1.25% of its own iterations, 0.09% of all of them
    replay = synthetic([])
    replay['pass_us'], replay['tap_us'] = values, {name: [] for name in gate.PATHS}
    verdict = gate.evaluate(replay)
    assert verdict['overall']['added_pass_us']['p99'] <= 100.0, 'diluted overall'
    assert not verdict['passed'] and any(line.startswith('hp_rescue_fire:') for line in verdict['failures'])


def test_a_replay_in_which_the_two_sides_did_different_things_fails():
    verdict = gate.evaluate(synthetic([0.0] * 100, mismatches=[dict(path='x', index=1, reason='different')]))
    assert not verdict['passed'] and 'different things' in verdict['failures'][0]


def test_the_gate_repeats_a_miss_once_and_fails_only_if_the_repeat_misses_too(monkeypatch):
    replays = []

    def fake(snapshot, candidate, *, iterations, warmup, seed, only):
        replays.append(seed)
        return synthetic([200.0] * 100) if seed == gate.SEED else synthetic([0.0] * 100)
    monkeypatch.setattr(gate, 'paired_replay', fake)
    transient = gate.run_gate(iterations=100)
    assert transient['passed'] and transient['repeated'] and replays == [gate.SEED, gate.SEED + 1], 'a transient miss that does not repeat passes'
    monkeypatch.setattr(gate, 'paired_replay', lambda *a, **k: synthetic([200.0] * 100))
    persistent = gate.run_gate(iterations=100)
    assert not persistent['passed'] and persistent['repeated'] and len(persistent['attempts']) == 2
    monkeypatch.setattr(gate, 'paired_replay', lambda *a, **k: synthetic([0.0] * 100))
    clean = gate.run_gate(iterations=100)
    assert clean['passed'] and not clean['repeated'] and len(clean['attempts']) == 1


def test_a_replay_that_measured_nothing_is_not_repeated_into_a_pass(monkeypatch):
    calls = []

    def fake(snapshot, candidate, *, iterations, warmup, seed, only):
        calls.append(seed)
        return synthetic([0.0] * 100, mismatches=[dict(path='x', index=1, reason='different')]) if seed == gate.SEED else synthetic([0.0] * 100)
    monkeypatch.setattr(gate, 'paired_replay', fake)
    result = gate.run_gate(iterations=100)
    assert not result['passed'] and calls == [gate.SEED], 'different behaviour is a failure at once, not noise'


# ----------------------------------------------------------------------------------------- what is measured
def test_the_first_tap_is_timed_from_the_deciding_capture_or_the_entry_when_the_frame_is_in_hand(snapshot_world):
    m = snapshot_world.m

    def burn(us):
        end = time.perf_counter_ns() + us * 1000
        while time.perf_counter_ns() < end:
            pass

    def after_a_capture(w, v, ctx):
        def call():
            m._fakes['capture'].grab()
            burn(300)
            m._fakes['act'].tap(1, 2, 'x')
            burn(700)                                  # time after the tap is in the pass, not in the first-tap latency
        return call

    def frame_in_hand(w, v, ctx):
        def call():
            burn(200)
            m._fakes['act'].tap(1, 2, 'x')
        return call

    def two_captures(w, v, ctx):
        def call():
            m._fakes['capture'].grab()
            burn(500)
            m._fakes['capture'].grab()                  # the LAST capture before the tap is the deciding one
            burn(100)
            m._fakes['act'].tap(1, 2, 'x')
        return call
    spec = lambda fn: gate.PathSpec('probe', 1, True, False, fn)
    with gate.quiet_replay():
        p1, t1, _ = gate.measure(snapshot_world, spec(after_a_capture), 0)
        p2, t2, _ = gate.measure(snapshot_world, spec(frame_in_hand), 0)
        p3, t3, _ = gate.measure(snapshot_world, spec(two_captures), 0)
    assert 300_000 <= t1 < 600_000 and p1 >= 1_000_000, (t1, p1)
    assert 200_000 <= t2 < 500_000, t2
    assert 100_000 <= t3 < 400_000, t3
    assert gate.measure(snapshot_world, spec(lambda w, v, ctx: (lambda: None)), 0)[1] is None


def test_a_script_is_rebuilt_for_every_call_so_nothing_carries_over(snapshot_world):
    path = gate.PATHS['fire_button_with_confirmation']
    with gate.quiet_replay():
        first = gate.measure(snapshot_world, path, 0)
        second = gate.measure(snapshot_world, path, 0)
    assert first[2] == second[2] and len(first[2][0]) == 1


def test_function_hashes_follow_the_source_text(tmp_path):
    one = tmp_path / 'a.py.txt'
    one.write_text('def fire_button():\n    return 1\n\n\ndef other():\n    return 2\n', encoding='utf-8')
    two = tmp_path / 'b.py.txt'
    two.write_text('def fire_button():\n    return 2\n\n\ndef other():\n    return 2\n', encoding='utf-8')
    a, b = gate.function_hashes(one), gate.function_hashes(two)
    assert set(a) == {'fire_button'} and a != b and a['fire_button'] != b['fire_button']


def test_the_live_artifact_names_the_fast_functions_a_migration_changed(tmp_path):
    changed = tmp_path / 'candidate.py.txt'
    text = gate.SNAPSHOT_PATH.read_text(encoding='utf-8')
    changed.write_text(text.replace('    time.sleep(0.8)                      # let the cooldown state render\n', '    time.sleep(0.8)                      # let the cooldown state render  (changed)\n'), encoding='utf-8')
    result = gate.run_gate(candidate=changed, iterations=100)
    record = gate.artifact(result, gate.structural_counts(changed), baseline(), candidate=changed)
    assert record['migrated_fast_functions'] == ['fire_button']
