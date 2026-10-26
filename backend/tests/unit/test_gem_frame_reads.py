"""One frame, one reading of its wave and its screen (FOCUS #11 step 2).

Before: the collector read the wave twice per pass, then the Ad Gem observation read the wave and the screen of the
same frame again. The readings are now taken once and reused only for the identical frame object."""
import types

from flows import shard
from gem_collector_run import run
from interactions.ad_gems import AdGemCollector
from vision.frame_reads import FrameReads


class Frame:
    pass


def test_reads_are_taken_once_for_their_own_frame_and_never_reused_for_another(monkeypatch):
    from vision import screen, wave_reader
    waves, screens = [], []
    monkeypatch.setattr(wave_reader, 'read_wave', lambda f: waves.append(f) or None)       # None is a reading too
    monkeypatch.setattr(screen, 'identify', lambda f: screens.append(f) or types.SimpleNamespace(name='home'))
    mine, other = Frame(), Frame()
    reads = FrameReads(mine)
    assert reads.wave(mine) is None and reads.wave(mine) is None and waves == [mine]
    assert reads.screen(mine).name == reads.screen(mine).name == 'home' and screens == [mine]
    reads.wave(other)
    reads.wave(other)
    reads.screen(other)
    assert waves == [mine, other, other] and screens == [mine, other]


def test_a_collector_pass_reads_each_frames_wave_and_screen_at_most_once(monkeypatch):
    frames = [Frame() for _ in range(8)]
    waves, screens = [], []
    gems = types.SimpleNamespace(ad_gems=AdGemCollector(), orbit=shard.GemOrbitTapper(), guard=None)
    gems.busy = lambda: shard.GemWatch.busy(gems)
    gems.poll = lambda frame, reads=None: shard.GemWatch.poll(gems, frame, reads=reads)
    monkeypatch.setattr(shard, 'find_orbit_gem', lambda frame, **kw: None)
    from interactions import ad_gems
    monkeypatch.setattr(ad_gems, 'find_claim_rect', lambda frame, **kw: None)
    events, _, returned, _ = run(
        monkeypatch, frames, gems=gems,
        read_wave=lambda f: waves.append(f) or 100,
        screen=lambda f: screens.append(f) or types.SimpleNamespace(name='battle'))
    assert not returned
    assert gems.ad_gems.counters['checks'] >= 1           # the Ad Gem observation did look at a frame
    for frame in frames:
        assert waves.count(frame) <= 1 and screens.count(frame) <= 1
    assert len(waves) == len(frames) and len(screens) == len(frames)


def test_an_owner_handed_another_frame_reads_it_itself(monkeypatch):
    """The ad routine's later looks use fresh captures: their readings never come from the loop's frame."""
    seen = []
    from interactions import ad_gems
    monkeypatch.setattr(ad_gems.wave_reader, 'read_wave', lambda f: seen.append(('wave', f)) or 100)
    monkeypatch.setattr(ad_gems.screen, 'identify', lambda f: seen.append(('screen', f)) or types.SimpleNamespace(name='battle'))
    monkeypatch.setattr(ad_gems, 'find_claim_rect', lambda frame, **kw: None)
    loop_frame, fresh = Frame(), Frame()
    collector = AdGemCollector()
    collector._observe(fresh, reads=FrameReads(loop_frame))
    assert seen == [('wave', fresh), ('screen', fresh)]