"""Synthetic HUDs: readable waves alone never authorize collector input."""
from types import SimpleNamespace
from unittest.mock import Mock

import cv2
import numpy as np
import pytest

from device import act
from gem_collector_run import run as run_world
from player.bootstrap_layout import manifest
from vision import detect, screen
from vision.hud import menu_toggle_visible


def battle_frame(panel=None):
    """A synthetic battle HUD. 'side_menu' opens the menu (X); 'side_menu_perk' also
    dims it under a modal; any other panel dims the closed menu."""
    layout = manifest()
    frame = np.zeros((layout['layout']['height'], layout['layout']['width'], 3), np.uint8)
    x, y, w, h = layout['side_menu']['toggle']['rect']
    cv2.rectangle(frame, (x+3, y+3), (x+w-4, y+h-4), (235,)*3, 3)
    for top in (18, 40, 62):
        cv2.rectangle(frame, (x+20, y+top), (x+w-20, y+top+12), (235,)*3, -1)
    if panel in ('side_menu', 'side_menu_perk'):
        frame[y:y+h, x:x+w] = 0
        cv2.line(frame, (x+20, y+20), (x+w-20, y+h-20), (255,)*3, 12)
        cv2.line(frame, (x+w-20, y+20), (x+20, y+h-20), (255,)*3, 12)
    if panel not in (None, 'side_menu'):
        # In-game modal scrim dims the underlying HUD, including a closed menu.
        frame //= 4
        cv2.rectangle(frame, (80, 420), (1000, 1450), (90, 30, 25), -1)
    return frame


def no_template(rel):
    raise detect.TemplateMissing(rel)


@pytest.mark.parametrize('panel', ['perk_choice', 'target_priority', 'orb_adjuster', 'side_menu_perk'])
def test_panel_with_readable_wave_sends_no_collector_input(monkeypatch, panel):
    monkeypatch.setattr(detect, '_tpl', no_template)
    tap, swipe = Mock(), Mock()
    monkeypatch.setattr(act, 'tap', tap)
    monkeypatch.setattr(act, 'swipe', swipe)
    gems = SimpleNamespace(ad_gems=SimpleNamespace(enabled=True),
                           orbit=SimpleNamespace(enabled=True), busy=lambda: [])
    gems.poll = Mock(side_effect=lambda frame, reads=None: act.tap(100, 1200))
    run_world(monkeypatch, [battle_frame(panel)], gems=gems,
              screen=screen.identify, read_wave=lambda frame: 100, hud=menu_toggle_visible)
    gems.poll.assert_not_called()
    tap.assert_not_called()
    swipe.assert_not_called()


def test_open_side_menu_still_collects(monkeypatch):
    # Saved live battle frames show the side menu open (X): that is a clear battle.
    monkeypatch.setattr(detect, '_tpl', no_template)
    opened = battle_frame('side_menu')
    events, polled, _, _ = run_world(
        monkeypatch, [opened, opened], screen=screen.identify,
        read_wave=lambda frame: 100, hud=menu_toggle_visible)
    assert len(polled) == 2
    assert [data['state'] for name, data in events if name == 'gem_collector_state'] == ['collecting']


def test_clean_battle_resumes_after_panel_closes(monkeypatch):
    monkeypatch.setattr(detect, '_tpl', no_template)
    clear = battle_frame()
    events, polled, _, _ = run_world(
        monkeypatch, [clear, battle_frame('perk_choice'), clear],
        screen=screen.identify, read_wave=lambda frame: 100, hud=menu_toggle_visible)
    assert len(polled) == 2 and all(frame is clear for frame in polled)
    assert [data['state'] for name, data in events if name == 'gem_collector_state'] == [
        'collecting', 'waiting_for_clear_battle', 'collecting']


@pytest.mark.parametrize('scale', [0.8, 1, 1.5])
@pytest.mark.parametrize('panel', [None, 'perk_choice', 'side_menu', 'side_menu_perk'])
def test_structural_guard_scales_without_templates(monkeypatch, scale, panel):
    from player import bootstrap_layout
    from player.geometry import Display
    frame = battle_frame(panel)
    frame = cv2.resize(frame, (int(1080*scale), int(2560*scale)), interpolation=cv2.INTER_NEAREST)
    token = bootstrap_layout.bind_display(Display(frame.shape[1], frame.shape[0], int(360*scale)))
    monkeypatch.setattr(detect, '_tpl', lambda rel: pytest.fail('HUD guard must not load a template'))
    try:
        assert menu_toggle_visible(frame) is (panel in (None, 'side_menu'))
    finally:
        bootstrap_layout._display.reset(token)


@pytest.mark.parametrize('kind', ['dimmed', 'blank', 'wrong_size', 'occluded', 'chevron'])
def test_unknown_hud_is_not_permission(kind):
    frame = battle_frame()
    x, y, w, h = manifest()['side_menu']['toggle']['rect']
    if kind == 'dimmed':
        frame //= 2
    elif kind == 'blank':
        frame[:] = 0
    elif kind == 'wrong_size':
        frame = frame[:-1]
    elif kind == 'occluded':
        frame[y+30:y+60, x:x+w] = 0
    else:
        frame[y:y+h, x:x+w] = 0
        cv2.line(frame, (x+15, y+20), (x+w//2, y+65), (255,)*3, 10)
        cv2.line(frame, (x+w//2, y+65), (x+w-15, y+20), (255,)*3, 10)
    assert not menu_toggle_visible(frame)


@pytest.mark.parametrize('panel', [None, 'perk_choice', 'side_menu', 'side_menu_perk'])
def test_real_ad_routine_rechecks_fresh_pixels_and_collector_keeps_observing(monkeypatch, panel):
    from flows.shard import GemWatch
    from interactions import ad_gems
    from tap_recorder import tap_recorder
    monkeypatch.setattr(detect, '_tpl', no_template)
    initial, fresh, after = battle_frame(), battle_frame(panel), battle_frame()
    monkeypatch.setattr(ad_gems, 'find_claim_rect',
                        lambda frame, **kw: None if frame is after else (0, 1250, 200, 100))
    monkeypatch.setattr(ad_gems.overlays, 'windows',
                        lambda serial, **kw: [ad_gems.overlays.GAME_PKG+'/Activity'])
    taps = tap_recorder(monkeypatch, act)

    def factory(gather, **kwargs):
        gems = GemWatch({'gem_delay_sec': (0, 0)}, **kwargs)
        monkeypatch.setattr(gems.orbit, 'poll', lambda frame, reads=None: frame)
        return gems

    grabbed = []
    events, _, returned, gems = run_world(
        monkeypatch, [initial, fresh, after], grabbed=grabbed, gem_factory=factory,
        screen=screen.identify, read_wave=lambda frame: 100, hud=menu_toggle_visible)
    assert not returned and len(grabbed) == 3
    if panel in (None, 'side_menu'):
        assert len(taps.calls) == 1
        assert gems.ad_gems.last_outcome['reason'] == 'offer_disappeared'
    else:
        taps.assert_no_taps('overlay appeared after the initial offer frame')
        # A covered HUD is a skip before input, not lost ownership.
        assert (gems.ad_gems.last_outcome['outcome'], gems.ad_gems.last_outcome['reason']) == (
            'skipped', 'fresh_frame_obscured')
        assert gems.ad_gems.visibility_reason != 'ownership_lost'


def test_panel_after_the_claim_tap_is_an_unconfirmed_claim(monkeypatch):
    from flows.shard import GemWatch
    from interactions import ad_gems
    from tap_recorder import tap_recorder
    monkeypatch.setattr(detect, '_tpl', no_template)
    initial, fresh, after = battle_frame(), battle_frame(), battle_frame('perk_choice')
    monkeypatch.setattr(ad_gems, 'find_claim_rect', lambda frame, **kw: (0, 1250, 200, 100))
    monkeypatch.setattr(ad_gems.overlays, 'windows',
                        lambda serial, **kw: [ad_gems.overlays.GAME_PKG+'/Activity'])
    taps = tap_recorder(monkeypatch, act)

    def factory(gather, **kwargs):
        gems = GemWatch({'gem_delay_sec': (0, 0)}, **kwargs)
        monkeypatch.setattr(gems.orbit, 'poll', lambda frame, reads=None: frame)
        return gems

    _, _, returned, gems = run_world(
        monkeypatch, [initial, fresh, after], gem_factory=factory,
        screen=screen.identify, read_wave=lambda frame: 100, hud=menu_toggle_visible)
    assert not returned and len(taps.calls) == 1
    assert (gems.ad_gems.last_outcome['outcome'], gems.ad_gems.last_outcome['reason']) == (
        'not_confirmed', 'post_claim_obscured')


@pytest.mark.parametrize('block_at', ['fresh', 'motion', 'second_tap', None])
def test_orbit_rechecks_each_supplied_and_captured_frame(monkeypatch, block_at):
    from flows import shard
    from gem_collector import CollectionObscured, collection_guard
    from tap_recorder import tap_recorder
    clear, panel = battle_frame(), battle_frame('perk_choice')
    monkeypatch.setattr(detect, '_tpl', no_template)
    monkeypatch.setattr(shard.wave_reader, 'read_wave', lambda frame: 100)
    monkeypatch.setattr(shard.capture, 'layout_offset', 0)
    monkeypatch.setattr(shard, 'read_gem_balance', lambda frame: 200)
    monkeypatch.setattr(shard, 'find_orbit_gem', lambda frame, **kwargs:
                        SimpleNamespace(center=(680., 805.), rect=(640, 765, 80, 80), score=.99))
    frames = iter([panel if block_at == 'fresh' else clear,
                   panel if block_at == 'second_tap' else clear, clear, clear])
    monkeypatch.setattr(shard.capture, 'grab', lambda: next(frames))
    monkeypatch.setattr(shard.act, 'wait_for_tap_slot', lambda: 0)
    monkeypatch.setattr(shard, 'battlefield_observation',
                        lambda *args, **kwargs: (True, 'live', panel if block_at == 'motion' else clear))
    taps = tap_recorder(monkeypatch, act)
    tapper = shard.GemOrbitTapper(enabled=True, jitter=0, guard=collection_guard)
    if block_at is None:
        tapper.poll(clear)
        assert len(taps.calls) == 3
    else:
        with pytest.raises(CollectionObscured):
            tapper.poll(clear)
        assert len(taps.calls) == (1 if block_at == 'second_tap' else 0)


def test_other_abort_still_propagates(monkeypatch):
    from interactions.tourney import Abort
    monkeypatch.setattr(detect, '_tpl', no_template)
    gems = SimpleNamespace(ad_gems=SimpleNamespace(enabled=True),
                           orbit=SimpleNamespace(enabled=True), busy=lambda: [],
                           poll=Mock(side_effect=Abort('ownership lost')))
    with pytest.raises(Abort, match='ownership lost'):
        run_world(monkeypatch, [battle_frame()], gems=gems,
                  screen=screen.identify, read_wave=lambda frame: 100, hud=menu_toggle_visible)
