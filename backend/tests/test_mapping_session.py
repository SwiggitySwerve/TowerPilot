from types import SimpleNamespace
import numpy as np

from player import bootstrap
from player.mapping_session import Session
from player.screen_proof import VisualAnchors
import pytest


def test_new_control_can_use_full_frame_context_after_visual_screen_proof(monkeypatch):
    frame=np.random.default_rng(6).integers(0,255,(60,120,3),dtype=np.uint8)
    calls=[]
    def read(image):
        calls.append(image)
        return [(10,10,'Bots')]
    monkeypatch.setattr(bootstrap,'anchor_present',lambda image,lines,spec: bool(lines))
    session=Session.__new__(Session)
    session.scanner=SimpleNamespace(visual_anchors=VisualAnchors(),read=read)
    session.lines=[]
    edge={'id':'bots','source':'events','route':{'verify':{'text':'Bots','rect':[5,5,70,40]}}}
    first=session.locate(frame,edge)
    session.lines=[]  # subsequent screen observation was also visual-only
    second=session.locate(frame.copy(),edge)
    assert first['identity']==second['identity']=='Bots'
    assert second['source_kind']=='visual_anchor'
    assert len(calls)==1


@pytest.mark.parametrize('screen', ['cards', 'modules'])
def test_inventory_walk_is_not_repeated_on_route_revisit(monkeypatch, screen):
    from player import calibrate
    calls=[]
    monkeypatch.setattr(calibrate, 'read_module_contents', lambda *a: calls.append('inventory') or {})
    session=Session.__new__(Session)
    session.inventories_scanned=set()
    session.scanner=SimpleNamespace(card_inventory=lambda: calls.append('inventory'),
        module_detail=lambda f: None, cal=object(), progress=lambda s: None, state={})
    session.scan_inventory_once(screen, None)
    session.scan_inventory_once(screen, None)
    assert calls == ['inventory']


def test_failed_inventory_walk_can_be_retried():
    session=Session.__new__(Session)
    session.inventories_scanned=set()
    def fail():
        raise RuntimeError('incomplete')
    session.scanner=SimpleNamespace(card_inventory=fail)
    with pytest.raises(RuntimeError):
        session.scan_inventory_once('cards', None)
    assert 'cards' not in session.inventories_scanned


def test_navigation_uses_fresh_source_and_destination_without_pre_delays():
    from player.manifest_driver import Driver
    frame=np.zeros((30,30,3),np.uint8)
    observed, taps, waits = [], [], []
    session=Session.__new__(Session)
    session.expected='home'
    session.edge={'id':'cards','action':'cards','source':'home','destination':'cards',
                  'kind':'navigate','availability':'always'}
    def observe(name):
        observed.append(name)
        return frame.copy(), []
    session.scanner=SimpleNamespace(observed=observe, pause=waits.append,
        check_stop=lambda: None, tap=lambda *a,**k: taps.append(a))
    driver=Driver(observe=session.observe,
        locate=lambda *a: {'verified':True,'rect':[1,1,8,8],'identity':'cards'},
        tap=session.tap, collect=lambda *a: None, publish=lambda e: None,
        check_stop=lambda: None)
    assert driver.step(session.edge)
    assert observed == ['home','home','cards']
    assert len(taps)==1 and waits==[]


def test_unknown_destination_never_replays_navigation_input():
    from player.manifest_driver import Driver, MappingStopped
    frame=np.zeros((30,30,3),np.uint8)
    taps=[]
    session=Session.__new__(Session)
    session.expected='home'
    session.edge={'id':'cards','action':'cards','source':'home','destination':'cards',
                  'kind':'navigate','availability':'always'}
    def observe(name):
        if name=='cards':
            raise RuntimeError('unknown destination')
        return frame.copy(), []
    session.scanner=SimpleNamespace(observed=observe, pause=lambda _: None,
        check_stop=lambda: None, tap=lambda *a,**k: taps.append(a))
    driver=Driver(observe=session.observe,
        locate=lambda *a: {'verified':True,'rect':[1,1,8,8],'identity':'cards'},
        tap=session.tap, collect=lambda *a: pytest.fail('unverified destination'),
        publish=lambda e: None, check_stop=lambda: None)
    with pytest.raises(MappingStopped,match='Destination unconfirmed'):
        driver.step(session.edge)
    assert len(taps)==1


@pytest.mark.parametrize('route_id,optional', [('route_15', True), ('route_21', True),
                                             ('route_0', False), ('route_13', False)])
def test_unverified_route_preserves_manifest_optionality_and_never_sends_input(route_id, optional):
    from player.manifest_driver import Driver, transitions
    edge = next(row for row in transitions() if row['id'] == route_id)
    assert edge['route']['optional'] is optional
    frame = np.zeros((30, 30, 3), np.uint8)
    steps, observations, waits, events, taps = [], [], [], [], []
    scanner = SimpleNamespace(current='home', asset_folder=None, skipped=[],
        begin_step=lambda i: None, step_index=lambda key: 0,
        finish_step=lambda *args: steps.append(args), progress=lambda *a: None,
        pause=waits.append, check_stop=lambda: None,
        observed=lambda name: (observations.append(name) or frame, []),
        tap=lambda *a, **k: taps.append(a))
    session = Session.__new__(Session)
    session.scanner = scanner
    session.expected = 'home'
    session.lines = []
    session.edge = None
    session.driver = Driver(observe=session.observe, locate=session.locate,
        tap=session.tap, collect=lambda *a: pytest.fail('unverified destination was collected'),
        publish=events.append, check_stop=scanner.check_stop)

    session.run([edge])

    skipped, = scanner.skipped
    assert skipped['screen'] == edge['destination']
    assert skipped.get('optional', False) is optional
    assert skipped['reason'] == 'Control not verified against installed artwork or text'
    assert observations == ['home'] * 4 and waits == [.6]
    assert taps == []
    assert [event['status'] for event in events] == ['needs_local_verification'] * 2
    assert steps == [('skipped', 'Control unavailable; no input sent')]


def test_daily_mission_static_label_creates_new_route_image_and_preserves_legacy_bytes(tmp_path, monkeypatch):
    import json
    import cv2
    import settings
    from player import calibrate, collection_scan
    from player.bootstrap_layout import manifest, route_capture_targets, writable_targets
    from player.manifest_driver import transitions

    p = {'state': str(tmp_path / 'calibrate_state.json')}
    templates = tmp_path / 'templates'
    monkeypatch.setattr(calibrate, 'template_path', lambda rel: templates / rel)
    monkeypatch.setattr(settings, 'template_path', lambda rel: templates / rel)
    edge = next(row for row in transitions() if row['id'] == 'route_17')
    rect = edge['route']['verify']['rect']
    assert rect == [910, 185, 165, 48] and manifest()['version'] == 11
    assert route_capture_targets()['route_0'] == 'mapping/v11/route_0.png'
    active = 'mapping/v11/route_17_label.png'
    retired = 'mapping/v11/route_17.png'
    assert active in writable_targets() and retired not in writable_targets()
    old = templates / retired
    old.parent.mkdir(parents=True)
    old.write_bytes(b'existing dynamic-counter route image')
    (tmp_path / 'navigation_manifest.json').write_text(json.dumps({'version': 11, 'controls': {
        'route_17': {'template': retired, 'verified': True},
        'route_0': {'template': 'mapping/v11/route_0.png', 'verified': True}}}))
    rng = np.random.default_rng(51)
    frame = np.zeros((2560, 1080, 3), np.uint8)
    x, y, w, h = rect
    frame[y:y+h, x:x+w] = rng.integers(0, 255, (h, w, 3), np.uint8)
    cv2.putText(frame, 'MISSIONS', (x+10, y+30), cv2.FONT_HERSHEY_SIMPLEX,
                .6, (255, 255, 255), 2)
    other = frame.copy()
    # The completion counter starts below the static label region. Both
    # observations retain the label while the changing counter differs.
    frame[237:260, 955:1015] = 255
    other[237:260, 955:1015] = (10, 40, 90)
    source_frames = iter([frame, other])
    cal = calibrate.Calibration(p, False, bootstrap=True)
    taps = []
    def observed(name):
        return (next(source_frames) if name == 'home' else other.copy()), [(y+15, x+10, 'MISSIONS')]
    scanner = SimpleNamespace(current='home', cal=cal, asset_folder=None,
        asset_index={'images': []}, visual_anchors=VisualAnchors(), state={},
        observed=observed, read=lambda f: [], check_stop=lambda: None,
        tap=lambda *a, **k: taps.append(a), progress=lambda *a, **k: None,
        harvest=lambda *a: None, update_screen_map=lambda *a: None)
    monkeypatch.setattr(collection_scan, 'scan', lambda s, name: other.copy())
    session = Session(scanner)
    assert 'route_17' not in session.saved['controls']
    assert session.saved['controls']['route_0']['verified'] is True
    assert session.driver.step(edge)

    saved = json.loads((tmp_path / 'navigation_manifest.json').read_text())
    control = saved['controls']['route_17']
    assert control['template'] == active and control['rect'] == rect and control['verified']
    assert cv2.imread(str(templates / active)).shape == (48, 165, 3)
    assert np.array_equal(cv2.imread(str(templates / active)), frame[y:y+h, x:x+w])
    assert old.read_bytes() == b'existing dynamic-counter route image'
    assert taps == [(992, 209)]
    assert calibrate.write_template('mapping/v11/route_17_unlisted.png', frame[:40, :40], bootstrap=True) == 'refused'
    assert calibrate.write_template(retired, frame[:40, :40], bootstrap=True) == 'refused'
    assert old.read_bytes() == b'existing dynamic-counter route image'
