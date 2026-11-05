"""Collector wait timestamps from synthetic frames, without device input."""
from types import SimpleNamespace

from gem_collector_run import run


def test_collector_times_each_clear_hud_wait_and_resets_on_resume_or_lost_battle(monkeypatch):
    import gem_collector

    now = [100.0]
    published = []
    session = SimpleNamespace(
        battle={'status': 'active'}, effective_preset=lambda: {}, observe=lambda *args: None)
    session.checkpoint = lambda state, **kwargs: published.append(
        getattr(state, 'waiting_for_clear_battle_since', 'missing'))
    monkeypatch.setattr(gem_collector.time, 'time', lambda: now[0])

    def screen(frame):
        now[0] += 1
        return SimpleNamespace(name='unknown' if frame == 'unknown' else 'battle')

    _, polled, _, _ = run(
        monkeypatch, ['clear', 'panel', 'panel', 'clear', 'panel', 'unknown', 'panel'],
        session=session, screen=screen, read_wave=lambda frame: None if frame == 'unknown' else 100,
        hud=lambda frame: frame == 'clear')
    assert published == [None, 102.0, 102.0, None, 105.0, None, 107.0]
    assert polled == ['clear', 'clear']
