"""Orbit collection has bounded windows; only verified changes count as hits."""
from types import SimpleNamespace

import pytest

from flows import shard
from player.gather_settings import ORBIT_TIMING_FIELDS, validate_orbit_timing


@pytest.fixture
def cycle(monkeypatch):
    state = SimpleNamespace(now=100., balance=200, taps=[], events=[], dry=False)
    monkeypatch.setattr(shard.time, 'monotonic', lambda: state.now)
    monkeypatch.setattr(shard.capture, 'grab', lambda: state.balance)
    monkeypatch.setattr(shard.capture, 'layout_offset', 0)
    monkeypatch.setattr(shard.wave_reader, 'read_wave', lambda frame: 123)
    monkeypatch.setattr(shard.screen, 'identify', lambda frame: SimpleNamespace(name='battle'))
    monkeypatch.setattr(shard, 'read_gem_balance', lambda frame: frame)
    monkeypatch.setattr(shard, 'battlefield_live', lambda *a: (True, 'live'))
    monkeypatch.setattr(shard, '_in_ability_row', lambda p: False)
    monkeypatch.setattr(shard.logger, 'event', lambda kind, **kw: state.events.append((kind, kw)))
    monkeypatch.setattr(shard.act, 'tap', lambda *a, **kw: state.taps.append(a) or {'dry_run': state.dry})
    return state, shard.GemOrbitTapper(enabled=True, jitter=0)


def test_missing_gem_waits_until_next_scheduled_window(cycle):
    state, tapper = cycle
    tapper.poll(200)
    assert len(state.taps) == 3
    assert tapper.next_at == 105
    state.now = 105
    tapper.poll(200)
    assert len(state.taps) == 6
    state.now = 160
    tapper.poll(200)
    assert len(state.taps) == 6
    assert tapper.next_at == 1060
    assert ('gem_orbit_claim', dict(confirmed=False, reason='attempt_timeout', before=200, after=None)) in state.events
    state.now = 1059
    tapper.poll(200)
    assert len(state.taps) == 6
    state.now = 1060
    tapper.poll(200)
    assert len(state.taps) == 9


def test_latest_refusal_keeps_actual_time_and_correlation_without_claiming_reward(cycle, monkeypatch):
    state, tapper = cycle
    monkeypatch.setattr(shard.time, 'time', lambda: 1000+state.now)
    monkeypatch.setattr(shard.wave_reader, 'read_wave', lambda _: None)
    tapper.poll(200)
    refused = tapper.status()['last_refusal']
    assert refused == dict(reason='no_wave', observed_at=1100,
                           window_id=tapper.window_id, attempt_id=tapper.attempt_id)
    assert refused['window_id'] and refused['attempt_id']
    assert state.taps == [] and tapper.status()['last_outcome'] is None
    state.now = 102
    assert tapper.status()['last_refusal'] == refused
    state.now = 160
    tapper.poll(200)
    assert tapper.status()['last_outcome']['confirmed'] is False
    assert tapper.status()['last_refusal'] == refused


@pytest.mark.parametrize('reason', ['no_wave', 'balance_unreadable', 'static'])
def test_refusals_do_not_restart_or_extend_collection_window(cycle, monkeypatch, reason):
    state, tapper = cycle
    if reason == 'no_wave':
        monkeypatch.setattr(shard.wave_reader, 'read_wave', lambda _: None)
    elif reason == 'balance_unreadable':
        state.balance = None
    else:
        monkeypatch.setattr(shard, 'battlefield_live', lambda *a: (False, 'static'))
    for now in [100, 115, 130, 145, 160, 200, 1059]:
        state.now = now
        tapper.poll(state.balance)
    assert state.taps == []
    assert tapper.next_at == 1060
    assert len([e for k, e in state.events if k == 'gem_orbit_window']) == 1


def test_short_interval_caps_window_without_overlap(cycle):
    state, tapper = cycle
    tapper.interval = 10
    tapper.poll(200)
    state.now = 110
    tapper.poll(200)
    assert len(state.taps) == 3
    tapper.poll(200)
    assert len(state.taps) == 6
    assert tapper.window_ends_at == 120


def test_stable_two_gem_increase_ends_window_early(cycle):
    state, tapper = cycle
    tapper.poll(200)
    state.balance = 202
    state.now = 105
    tapper.poll(200)  # old input/new capture: not yet stable
    assert tapper.next_at == 110
    assert not any(k == 'gem_orbit_claim' for k, _ in state.events)
    state.now = 110
    tapper.poll(202)
    assert len(state.taps) == 3
    pause = 950
    assert tapper.next_at == 1060
    assert state.events[-1] == ('gem_orbit_claim', dict(confirmed=True, before=200, after=202, pause_sec=round(pause, 3)))
    state.now = 110
    tapper.poll(202)
    assert len(state.taps) == 3


def test_next_window_starts_sixteen_minutes_after_previous_start(cycle):
    state, tapper = cycle
    tapper.poll(200)
    state.balance = 202
    state.now = 105
    tapper.poll(202)
    assert tapper.next_at == 1060
    state.now = 1059.9
    tapper.poll(202)
    assert len(state.taps) == 3
    state.now = 1060
    tapper.poll(202)
    assert len(state.taps) == 6


@pytest.mark.parametrize('now', [160, 161, 200])
def test_expired_attempt_cannot_confirm_late_balance_increase(cycle, now):
    state, tapper = cycle
    tapper.poll(200)
    state.balance = 202
    state.now = now
    tapper.poll(202)
    assert len(state.taps) == 3
    assert tapper.next_at == 1060
    assert ('gem_orbit_claim', dict(confirmed=False, reason='attempt_timeout', before=200, after=None)) in state.events
    assert not any(k == 'gem_orbit_claim' and e['confirmed'] for k, e in state.events)


def test_capture_crossing_deadline_stops_remaining_taps(cycle, monkeypatch):
    state, tapper = cycle
    def grab():
        if state.taps:
            state.now = 160
        return state.balance
    monkeypatch.setattr(shard.capture, 'grab', grab)
    tapper.poll(200)
    assert len(state.taps) == 1
    assert tapper.next_at == 1060
    assert ('gem_orbit_claim', dict(confirmed=False, reason='attempt_timeout', before=200, after=200)) in state.events


def test_stop_remaining_taps_as_soon_as_balance_increases(cycle, monkeypatch):
    state, tapper = cycle
    def tap(*a, **kw):
        state.taps.append(a)
        state.balance = 202
        return {}
    monkeypatch.setattr(shard.act, 'tap', tap)
    assert tapper.poll(200) == 202
    assert len(state.taps) == 1
    assert not any(k == 'gem_orbit_claim' for k, _ in state.events)


@pytest.mark.parametrize('balance', [None, 206, 208, 199, 1200])
def test_unreadable_or_unrelated_rewards_never_confirm(cycle, balance):
    state, tapper = cycle
    tapper.poll(200)
    state.balance = balance
    state.now = 105
    tapper.poll(balance)
    assert len(state.taps) == 3
    assert not any(k == 'gem_orbit_claim' and e['confirmed'] for k, e in state.events)
    assert tapper.next_at == 120


def test_unreadable_baseline_does_not_tap(cycle):
    state, tapper = cycle
    state.balance = None
    tapper.poll(None)
    assert state.taps == []
    assert state.events[-1] == ('gem_orbit_skip', {'reason': 'balance_unreadable'})


@pytest.mark.parametrize('stage', ['prior', 'fresh', 'between_taps'])
def test_unreadable_observation_retains_dispatched_attempt_for_later_stable_confirmation(cycle, monkeypatch, stage):
    state, tapper = cycle
    tapper.poll(200)
    dispatched = len(state.taps)
    state.now = 105
    if stage == 'prior':
        tapper.poll(None)
    elif stage == 'fresh':
        state.balance = None
        tapper.poll(200)
    else:
        frames = iter([200, None])
        monkeypatch.setattr(shard.capture, 'grab', lambda: next(frames))
        tapper.poll(200)
        monkeypatch.setattr(shard.capture, 'grab', lambda: state.balance)
    assert len(state.taps) == dispatched
    assert tapper.balance_before == 200 and tapper.sent_tap
    assert tapper.window_ends_at == 160
    assert not any(k == 'gem_orbit_claim' for k, _ in state.events)
    state.balance = 202
    state.now = tapper.next_at
    tapper.poll(202)
    assert len(state.taps) == dispatched
    assert next(data for kind, data in state.events if kind == 'gem_orbit_claim')['confirmed'] is True


@pytest.mark.parametrize('final_balance', [None, 206, 199])
def test_paused_attempt_never_guesses_or_confirms_other_rewards(cycle, final_balance):
    state, tapper = cycle
    tapper.poll(200)
    state.balance = None
    state.now = 105
    tapper.poll(None)
    state.balance = final_balance
    state.now = 120
    tapper.poll(final_balance)
    assert len(state.taps) == 3
    assert not any(k == 'gem_orbit_claim' and data['confirmed'] for k, data in state.events)


@pytest.mark.parametrize('prior,fresh', [(None, 206), (206, None), (None, 199),
                                       (199, None), (206, 202), (199, 202)])
def test_partial_or_unstable_pair_cannot_hide_a_conflicting_read(cycle, prior, fresh):
    state, tapper = cycle
    tapper.poll(200)
    state.now, state.balance = 105, fresh
    tapper.poll(prior)
    assert tapper.balance_before is None and not tapper.sent_tap
    state.now, state.balance = tapper.next_at, 202
    tapper.poll(202)
    assert not any(kind == 'gem_orbit_claim' and data['confirmed'] for kind, data in state.events)


@pytest.mark.parametrize('prior,fresh', [(None, 202), (202, None)])
def test_partial_expected_reward_still_needs_later_stable_pair(cycle, prior, fresh):
    state, tapper = cycle
    tapper.poll(200)
    state.now, state.balance = 105, fresh
    tapper.poll(prior)
    assert tapper.balance_before == 200 and tapper.sent_tap
    assert not any(kind == 'gem_orbit_claim' for kind, _ in state.events)
    state.now, state.balance = tapper.next_at, 202
    tapper.poll(202)
    assert next(data for kind, data in state.events if kind == 'gem_orbit_claim')['confirmed'] is True
    assert len(state.taps) == 3


def test_paused_attempt_expires_without_reusing_its_baseline_next_window(cycle):
    state, tapper = cycle
    tapper.poll(200)
    state.balance = None
    state.now = 105
    tapper.poll(None)
    state.now = 160
    tapper.poll(None)
    assert ('gem_orbit_claim', dict(confirmed=False, reason='attempt_timeout', before=200, after=None)) in state.events
    assert tapper.balance_before is None and not tapper.sent_tap
    state.balance = 202
    state.now = 1060
    tapper.poll(202)
    assert len(state.taps) == 6
    assert not any(k == 'gem_orbit_claim' and data['confirmed'] for k, data in state.events)


def test_unknown_counter_diagnostic_saves_only_supplied_crop_once_per_window(cycle, monkeypatch):
    import cv2
    import numpy as np

    from vision.ocr import GEM_BALANCE_REGION

    state, tapper = cycle
    frame = np.zeros((2560, 1080, 3), np.uint8)
    x, y, w, h = GEM_BALANCE_REGION
    frame[y:y+h, x:x+w] = (30, 40, 50)
    monkeypatch.setattr(shard, 'read_gem_balance', lambda _: None)
    monkeypatch.setitem(shard.CONFIG['logging'], 'screenshot_on_trigger', True)
    tapper.poll(frame)
    [diagnostic] = [data for kind, data in state.events if kind == 'gem_orbit_balance_unreadable']
    assert diagnostic['stage'] == 'prior'
    assert diagnostic['before'] is None and diagnostic['tap_sent'] is False
    path = shard.logger.run_file().parent / diagnostic['counter_frame']
    saved = cv2.imread(str(path))
    assert saved.shape == (h, w, 3)
    assert np.array_equal(saved, frame[y:y+h, x:x+w])
    state.now = 115
    tapper.poll(frame)
    assert len(list(path.parent.glob('*gem_balance_unreadable*.png'))) == 1
    state.now = 160
    tapper.poll(frame)
    state.now = 1060
    tapper.poll(frame)
    assert len(list(path.parent.glob('*gem_balance_unreadable*.png'))) == 2
    assert state.taps == []


def test_dry_run_cannot_confirm_a_collection(cycle):
    state, tapper = cycle
    state.dry = True
    tapper.poll(200)
    state.balance = 202
    state.now = 105
    tapper.poll(202)
    assert not any(k == 'gem_orbit_claim' for k, _ in state.events)


def test_returns_post_tap_frame_even_after_last_tap(cycle, monkeypatch):
    state, tapper = cycle
    tapper.taps = 1
    def tap(*a, **kw):
        state.balance = 202
        return {}
    monkeypatch.setattr(shard.act, 'tap', tap)
    assert tapper.poll(200) == 202


@pytest.mark.parametrize('key', ORBIT_TIMING_FIELDS)
@pytest.mark.parametrize('value', [False, float('nan'), float('inf'), -1, '3'])
def test_invalid_timing_is_rejected(key, value):
    assert validate_orbit_timing({key: value})


def test_timing_reaches_runner_and_settings_catalog():
    from control.settings_catalog import catalog
    values = dict(interval_sec=120, retry_interval_sec=3, attempt_timeout_sec=45, retry_backoff_sec=20)
    options = shard.gem_orbit_opts({'gem_orbit': values})
    assert options == dict(enabled=False, interval=120, retry_interval_sec=3, attempt_timeout_sec=45, retry_backoff_sec=20)
    modules = catalog({}, {'policies': {'gather': {'shared': {'gem_orbit': values}}}}, True)
    fields = {f['key']: f for m in modules if m['id'] == 'orbit:shared' for f in m['fields']}
    for key, value in values.items():
        assert fields['gem_orbit.' + key]['value'] == value
