"""Only a recognized battle with a readable wave may reach gem collection."""
import types
from unittest.mock import Mock

import pytest

from device import act
from gem_collector_run import run as run_world


def test_harvesting_never_polls_ad_gems_or_sends_input_on_home(monkeypatch):
    # Keep a spy for the removed entry point: this test fails on the old Home branch.
    ad = types.SimpleNamespace(enabled=True, poll_home=Mock(), leave_home=Mock())
    gems = types.SimpleNamespace(ad_gems=ad, orbit=types.SimpleNamespace(enabled=True),
                                 busy=lambda: [], poll=Mock())
    tap, swipe = Mock(), Mock()
    monkeypatch.setattr(act, 'tap', tap)
    monkeypatch.setattr(act, 'swipe', swipe)
    run_world(monkeypatch, ['home'], fence=lambda: None, gems=gems)

    ad.poll_home.assert_not_called()
    gems.poll.assert_not_called()
    tap.assert_not_called()
    swipe.assert_not_called()


@pytest.mark.parametrize('name', ['home', 'cards', 'modules', 'guild', 'tournament',
                                  'game_stats', 'tournament_stats', 'unknown'])
@pytest.mark.parametrize('wave', [None, 100])
@pytest.mark.parametrize('harvesting', [False, True])
def test_nonbattle_screens_are_observation_only(monkeypatch, name, wave, harvesting):
    from flows.shard import GemWatch

    gems = GemWatch({'gem_delay_sec': (0, 0)})
    ad_poll, orbit_poll = Mock(wraps=gems.ad_gems.poll), Mock(wraps=gems.orbit.poll)
    monkeypatch.setattr(gems.ad_gems, 'poll', ad_poll)
    monkeypatch.setattr(gems.orbit, 'poll', orbit_poll)
    tap, swipe = Mock(), Mock()
    monkeypatch.setattr(act, 'tap', tap)
    monkeypatch.setattr(act, 'swipe', swipe)
    grabbed = []
    events, _, returned, _ = run_world(
        monkeypatch, [name, name], gems=gems, grabbed=grabbed,
        fence=(lambda: None) if harvesting else None, read_wave=lambda frame: wave)

    assert not returned and grabbed == [name, name]
    assert ('gem_collector_state', {'state': 'waiting_for_battle'}) in events
    ad_poll.assert_not_called()
    orbit_poll.assert_not_called()
    tap.assert_not_called()
    swipe.assert_not_called()


@pytest.mark.parametrize('status', ['prepared', 'active'])
def test_home_checkpoints_do_not_preserve_an_ad_offer(monkeypatch, status):
    session = types.SimpleNamespace(
        battle=dict(status=status, id='b1'), effective_preset=lambda: {}, checkpoint=Mock())
    _, polled, _, _ = run_world(monkeypatch, ['home'], session=session, fence=lambda: None)
    assert polled == []
    assert session.checkpoint.call_args.kwargs == {'battle_visible': False}


def test_a_battle_without_a_readable_wave_does_not_collect(monkeypatch):
    _, polled, _, _ = run_world(monkeypatch, ['battle'], read_wave=lambda frame: None)
    assert polled == []


@pytest.mark.parametrize('battle_kind', ['normal', 'tournament'])
def test_a_recognized_battle_still_claims_then_waits_on_home(monkeypatch, battle_kind):
    from flows.shard import GemWatch
    from interactions import ad_gems
    from tap_recorder import tap_recorder

    # Both battle types use the classifier's same 'battle' name and readable wave.
    initial, fresh, after = [f'{battle_kind}-{phase}' for phase in ('offer', 'fresh', 'after')]
    gems = GemWatch({'gem_delay_sec': (0, 0)})
    orbit = Mock(side_effect=lambda frame, reads=None: frame)
    monkeypatch.setattr(gems.orbit, 'poll', orbit)
    monkeypatch.setattr(ad_gems, 'find_claim_rect',
                        lambda frame, **kw: None if frame == after else (0, 1250, 200, 100))
    monkeypatch.setattr(ad_gems.overlays, 'windows',
                        lambda serial, **kw: [ad_gems.overlays.GAME_PKG + '/Activity'])
    taps = tap_recorder(monkeypatch, act)
    _, _, returned, _ = run_world(
        monkeypatch, [initial, fresh, after, 'home'], gems=gems, fence=lambda: None,
        screen=lambda frame: types.SimpleNamespace(name='home' if frame == 'home' else 'battle'),
        read_wave=lambda frame: None if frame == 'home' else 100)

    assert not returned and len(taps.calls) == 1
    assert gems.ad_gems.last_outcome['reason'] == 'offer_disappeared'
    assert gems.ad_gems.counters['confirmed'] == 1
    orbit.assert_called_once()
    assert orbit.call_args.args == (after,)
