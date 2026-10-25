"""Starting the dashboard: one instance per port, no threads before the port is owned, and the landing hold.

`dash.serve` is driven for real against ephemeral loopback ports; the conftest guard still refuses 5037, 8620 and
8630. The refresher is replaced by a recorder, so nothing reconciles or launches."""
import socket
import threading
import urllib.error
import urllib.request

import pytest
from werkzeug.serving import make_server

from control.diagnostics import log_root
from runtime import dashboard_start


@pytest.fixture
def recorded(dash, monkeypatch):
    """The refresher recorder and the threads started while `serve` runs."""
    calls = []
    monkeypatch.setattr(dash, '_start_procs_refresher', lambda: calls.append('refresher'))
    started = []
    original = threading.Thread.start
    monkeypatch.setattr(threading.Thread, 'start', lambda self: (started.append(self.name), original(self))[1])
    return calls, started


def events(dash):
    folder = log_root(dash.ROOT) / '_dashboard'
    text = ''.join(path.read_text(encoding='utf-8') for path in sorted(folder.glob('events_*.jsonl')))
    return [line for line in text.splitlines() if 'dashboard_start' in line or 'dashboard_stopped' in line]


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def test_a_second_start_on_a_bound_port_exits_nonzero_and_starts_no_thread(dash, recorded):
    calls, started = recorded
    holder = dashboard_start.bind('127.0.0.1', 0, dash.app)            # the dashboard already serving
    try:
        code = dash.serve(port=holder.server_port)
    finally:
        holder.server_close()
    assert code != 0
    assert calls == [] and started == []                                # no refresher, no harvest tick, no reconnect
    assert any('port_taken' in line for line in events(dash))


def test_a_dashboard_started_the_old_way_is_refused_too(dash, recorded):
    """The running dashboard binds with werkzeug's default (SO_REUSEADDR), which on Windows lets a plain second bind
    share the port; the new start must be refused anyway."""
    calls, started = recorded
    old = make_server('127.0.0.1', 0, dash.app, threaded=True)
    try:
        assert dash.serve(port=old.server_port) != 0
    finally:
        old.server_close()
    assert calls == [] and started == []


def test_the_exclusive_bind_is_released_on_close(dash):
    port = free_port()
    first = dashboard_start.bind('127.0.0.1', port, dash.app)
    with pytest.raises(dashboard_start.PortTaken):
        dashboard_start.bind('127.0.0.1', port, dash.app)
    first.server_close()
    dashboard_start.bind('127.0.0.1', port, dash.app).server_close()    # a restart can take the port back


def test_the_hold_file_makes_a_start_exit_before_it_binds(dash, recorded, monkeypatch):
    calls, started = recorded
    monkeypatch.setattr(dashboard_start, 'bind', lambda *a: pytest.fail('a held start must not bind'))
    hold = dashboard_start.hold_path(log_root(dash.ROOT))
    hold.parent.mkdir(parents=True, exist_ok=True)
    hold.write_text('landing r22a', encoding='utf-8')
    port = free_port()
    code = dash.serve(port=port)
    assert code == 3
    assert calls == [] and started == []
    assert any('landing_hold' in line and 'landing r22a' in line for line in events(dash))
    assert dashboard_start.hold_notice(log_root(dash.ROOT)) == 'landing r22a'
    hold.unlink()
    assert dashboard_start.hold_notice(log_root(dash.ROOT)) is None


def test_an_empty_hold_file_still_holds(dash, recorded):
    hold = dashboard_start.hold_path(log_root(dash.ROOT))
    hold.parent.mkdir(parents=True, exist_ok=True)
    hold.write_text('', encoding='utf-8')
    assert dash.serve(port=free_port()) == 3


def test_a_free_port_with_no_hold_serves_then_starts_the_refresher_after_the_bind(dash, recorded, monkeypatch):
    calls, _ = recorded
    servers = []
    real_bind = dashboard_start.bind
    order = []

    def spy(host, port, app):
        server = real_bind(host, port, app)
        servers.append(server)
        order.append('bind')
        return server

    monkeypatch.setattr(dashboard_start, 'bind', spy)
    monkeypatch.setattr(dash, '_start_procs_refresher', lambda: (order.append('refresher'), calls.append('refresher')))
    port = free_port()
    result = []
    thread = threading.Thread(target=lambda: result.append(dash.serve(port=port)), name='serve-under-test')
    thread.start()
    try:
        for _ in range(100):
            if 'refresher' in order:
                break
            threading.Event().wait(0.05)
        assert order == ['bind', 'refresher']
        assert dash.app.debug is False
        slow = socket.create_connection(('127.0.0.1', port), timeout=5)   # an open stream (like the MJPEG tab) ...
        try:
            slow.sendall(b'GET /api/nothing HTTP/1.1\r\nHost: 127.0.0.1\r\n')   # ... left mid-request
            with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/nothing', timeout=5):
                pass
        except urllib.error.HTTPError as err:
            assert err.code == 404          # answered while the other connection is held: the server is threaded
        finally:
            slow.close()
    finally:
        servers[0].shutdown()
        thread.join(10)
    assert result == [0]
