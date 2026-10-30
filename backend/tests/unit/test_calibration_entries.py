"""The shared inclusive timestamp boundary preserves bootstrap's existing rule."""
import pytest
from player.calibration_report import entries_since


@pytest.mark.parametrize('since', [0, 1, 2, 3])
def test_entries_since_preserves_the_bootstrap_filter_and_entry_order(since):
    entries = [{}, {'t': 0}, {'t': 1, 'verified': False}, {'t': 2, 'verified': True}]
    assert entries_since(entries, since) == [entry for entry in entries if entry.get('t', 0) >= since]


def test_route_harvest_keeps_the_existing_entry_guard_and_short_circuit(monkeypatch):
    from types import SimpleNamespace
    from player import bootstrap
    scanner = bootstrap.Scanner.__new__(bootstrap.Scanner)
    scanner.visited = set()
    scanner.battle_only = False
    scanner.asset_folder = None
    scanner.started_at = 10
    scanner.cal = SimpleNamespace(entries=[
        {'rel': 'target', 'verified': True, 't': 10},
        {'rel': 'other', 'verified': False, 't': None}])
    scanner.progress = lambda *args: None
    scanner.pause = lambda *args: None
    scanner.observed = lambda *args: (None, [])
    scanner.update_screen_map = lambda *args: None
    scanner.learned_cuts = lambda *args: None
    scanner.cut = lambda *args, **kwargs: pytest.fail('already verified route was recut')
    monkeypatch.setattr(bootstrap, 'manifest', lambda: {
        'screens': {'demo': {'targets': []}}, 'routes': [{'from': 'demo', 'icon': {'rel': 'target'}}]})
    monkeypatch.setattr(bootstrap, 'icon_present', lambda *args: True)
    scanner.harvest('demo', None, [])
