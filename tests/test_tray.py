"""Offline unit tests for towerpilot.tray (no real tray, browser, or network)."""
from __future__ import annotations

import sys
import threading
import types
from pathlib import Path
from typing import Any

from PIL import Image

from towerpilot import tray


class FakeCollector:
    def __init__(self, running: bool = False) -> None:
        self.running = running
        self.starts = 0
        self.stops = 0

    def start(self) -> bool:
        self.starts += 1
        if self.running:
            return False
        self.running = True
        return True

    def stop(self) -> bool:
        self.stops += 1
        if not self.running:
            return False
        self.running = False
        return True


class FakeFrames:
    def __init__(self) -> None:
        self.closed = 0

    def close(self) -> None:
        self.closed += 1


class FakeApp:
    def __init__(self, *, with_shutdown: bool = True) -> None:
        self.collector = FakeCollector()
        self.frames = FakeFrames()
        self.shutdown_calls = 0
        self.run_calls: list[dict[str, Any]] = []
        ext: dict[str, Any] = {
            "collector": self.collector,
            "frames": self.frames,
        }
        if with_shutdown:
            ext["shutdown"] = self._shutdown
        self.extensions = {"towerpilot": ext}

    def _shutdown(self) -> None:
        self.shutdown_calls += 1
        self.collector.stop()
        self.frames.close()

    def run(self, **kwargs: Any) -> None:
        self.run_calls.append(kwargs)


class FakeMenuItem:
    def __init__(
        self,
        text: str,
        action: Any,
        *,
        checked: Any = None,
        default: bool = False,
    ) -> None:
        self.text = text
        self.action = action
        self.checked = checked
        self.default = default


class FakeMenu:
    SEPARATOR = object()

    def __init__(self, *items: Any) -> None:
        self.items = list(items)


class FakeIcon:
    def __init__(self, name: str, icon: Any, title: str, menu: FakeMenu) -> None:
        self.name = name
        self.icon = icon
        self.title = title
        self.menu = menu
        self.stopped = 0
        self.menu_updates = 0
        self.ran = False

    def update_menu(self) -> None:
        self.menu_updates += 1

    def stop(self) -> None:
        self.stopped += 1

    def run(self) -> None:
        self.ran = True


def _install_fake_pystray(monkeypatch) -> types.ModuleType:
    mod = types.ModuleType("pystray")
    mod.MenuItem = FakeMenuItem  # type: ignore[attr-defined]
    mod.Menu = FakeMenu  # type: ignore[attr-defined]
    mod.Icon = FakeIcon  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "pystray", mod)
    return mod


def test_icon_image_generates_in_memory_rgba(tmp_path: Path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    img = tray.icon_image()
    assert isinstance(img, Image.Image)
    assert img.mode == "RGBA"
    assert img.size == (64, 64)
    # Drawn pixels exist (non-empty alpha channel)
    assert img.getbbox() is not None
    # Image-free rule: nothing written to disk
    assert list(tmp_path.iterdir()) == []

    small = tray.icon_image(size=32)
    assert small.mode == "RGBA"
    assert small.size == (32, 32)


def test_redirect_output_noop_when_interactive(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("TOWER_PILOT_WINDOWLESS", raising=False)
    log_path = tmp_path / "logs" / "launcher.log"
    orig_out, orig_err = sys.stdout, sys.stderr

    stream = tray.redirect_output(force=False, log_path=log_path)
    assert stream is None
    assert sys.stdout is orig_out
    assert sys.stderr is orig_err
    assert not log_path.exists()


def test_redirect_output_windowless_env_writes_log(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("TOWER_PILOT_WINDOWLESS", "1")
    log_path = tmp_path / "logs" / "launcher.log"
    orig_out, orig_err = sys.stdout, sys.stderr

    stream = tray.redirect_output(force=False, log_path=log_path)
    try:
        assert stream is not None
        assert sys.stdout is stream
        assert sys.stderr is stream
        print("hello tray log")
    finally:
        sys.stdout = orig_out
        sys.stderr = orig_err
        if stream is not None:
            stream.close()

    text = log_path.read_text(encoding="utf-8")
    assert "launcher start" in text
    assert "hello tray log" in text


def test_redirect_output_when_stdout_missing(tmp_path: Path, monkeypatch):
    monkeypatch.delenv("TOWER_PILOT_WINDOWLESS", raising=False)
    monkeypatch.setattr(sys, "stdout", None)
    log_path = tmp_path / "logs" / "launcher.log"

    stream = tray.redirect_output(force=False, log_path=log_path)
    try:
        assert stream is not None
        assert sys.stdout is stream
        assert sys.stderr is stream
    finally:
        if stream is not None:
            stream.close()

    assert log_path.exists()
    assert "launcher start" in log_path.read_text(encoding="utf-8")


def test_serving_probes_api_status(monkeypatch):
    seen_urls: list[str] = []

    class DummyResp:
        def __init__(self, status: int) -> None:
            self.status = status

        def __enter__(self) -> "DummyResp":
            return self

        def __exit__(self, *exc: Any) -> bool:
            return False

    def fake_urlopen(url: str, timeout: float = 1.0) -> DummyResp:
        seen_urls.append(url)
        return DummyResp(200)

    monkeypatch.setattr(tray.urllib.request, "urlopen", fake_urlopen)
    assert tray.serving(8620) is True
    assert seen_urls == ["http://127.0.0.1:8620/api/status"]

    monkeypatch.setattr(
        tray.urllib.request,
        "urlopen",
        lambda url, timeout=1.0: DummyResp(503),
    )
    assert tray.serving(8620) is False

    def fail_urlopen(url: str, timeout: float = 1.0) -> Any:
        raise OSError("connection refused")

    monkeypatch.setattr(tray.urllib.request, "urlopen", fail_urlopen)
    assert tray.serving(8620) is False


def test_main_single_instance_opens_browser_and_exits(monkeypatch):
    opened: list[str] = []
    factory_called = False

    monkeypatch.setattr(tray, "redirect_output", lambda force=False: None)
    monkeypatch.setattr(tray, "serving", lambda port, host=tray.DEFAULT_HOST, timeout=1.0: True)
    monkeypatch.setattr(tray.webbrowser, "open", lambda url: opened.append(url) or True)

    def _boom() -> Any:
        nonlocal factory_called
        factory_called = True
        raise AssertionError("should not start second Flask instance")

    rc = tray.main(["--port", "8777"], app_factory=_boom)
    assert rc == 0
    assert opened == ["http://127.0.0.1:8777/"]
    assert factory_called is False


def test_main_single_instance_background_is_silent(monkeypatch):
    opened: list[str] = []
    monkeypatch.setattr(tray, "redirect_output", lambda force=False: None)
    monkeypatch.setattr(tray, "serving", lambda port, host=tray.DEFAULT_HOST, timeout=1.0: True)
    monkeypatch.setattr(tray.webbrowser, "open", lambda url: opened.append(url) or True)

    rc = tray.main(["--port", "8777", "--background"], app_factory=lambda: (_ for _ in ()).throw(AssertionError()))
    assert rc == 0
    assert opened == []


def test_tray_menu_callbacks_and_quit(monkeypatch):
    _install_fake_pystray(monkeypatch)
    opened: list[str] = []
    monkeypatch.setattr(tray.webbrowser, "open", lambda url: opened.append(url) or True)

    app = FakeApp(with_shutdown=True)
    icon = tray.build_icon(app, port=8620)

    assert icon.title == "Tower Pilot - http://127.0.0.1:8620/"
    assert isinstance(icon.icon, Image.Image)
    items = icon.menu.items
    assert len(items) == 4
    open_item, harvest_item, sep, quit_item = items
    assert open_item.text == "Open Dashboard"
    assert open_item.default is True
    assert harvest_item.text == "Gem Harvesting"
    assert sep is FakeMenu.SEPARATOR
    assert quit_item.text == "Quit"

    # Open Dashboard
    open_item.action(icon, open_item)
    assert opened == ["http://127.0.0.1:8620/"]

    # Gem Harvesting checkable toggle
    assert harvest_item.checked(harvest_item) is False
    harvest_item.action(icon, harvest_item)
    assert app.collector.running is True
    assert app.collector.starts == 1
    assert harvest_item.checked(harvest_item) is True
    assert icon.menu_updates == 1

    harvest_item.action(icon, harvest_item)
    assert app.collector.running is False
    assert app.collector.stops == 1
    assert harvest_item.checked(harvest_item) is False
    assert icon.menu_updates == 2

    # Quit stops icon and calls app shutdown
    quit_item.action(icon, quit_item)
    assert icon.stopped == 1
    assert app.shutdown_calls == 1


def test_shutdown_app_fallback_without_shutdown_hook(monkeypatch):
    ocr_calls = 0

    def fake_ocr_shutdown() -> None:
        nonlocal ocr_calls
        ocr_calls += 1

    from towerpilot import ocr

    monkeypatch.setattr(ocr, "shutdown", fake_ocr_shutdown)

    app = FakeApp(with_shutdown=False)
    app.collector.start()
    tray.shutdown_app(app)

    assert app.collector.running is False
    assert app.collector.stops == 1
    assert app.frames.closed == 1
    assert ocr_calls == 1


def test_run_tray_fallback_when_pystray_unavailable(monkeypatch):
    def broken_build(*args: Any, **kwargs: Any) -> Any:
        raise ImportError("no pystray")

    monkeypatch.setattr(tray, "build_icon", broken_build)
    app = FakeApp(with_shutdown=True)
    stopped = threading.Event()
    stopped.set()

    rc = tray.run_tray(app, port=8620, stopped=stopped)
    assert rc == 0
    assert app.shutdown_calls == 1


def test_main_starts_server_autostart_and_runs_tray(monkeypatch):
    app = FakeApp(with_shutdown=True)
    opened: list[str] = []
    tray_args: dict[str, Any] = {}

    monkeypatch.setattr(tray, "redirect_output", lambda force=False: None)
    monkeypatch.setattr(tray, "serving", lambda port, host=tray.DEFAULT_HOST, timeout=1.0: False)
    monkeypatch.setattr(tray, "wait_until_ready", lambda port, **kw: True)
    monkeypatch.setattr(tray.webbrowser, "open", lambda url: opened.append(url) or True)

    def fake_tray_runner(a: Any, *, port: int, host: str, stopped: threading.Event) -> int:
        tray_args["app"] = a
        tray_args["port"] = port
        tray_args["host"] = host
        return 0

    rc = tray.main(["--port", "8655", "--autostart"], app_factory=lambda: app, tray_runner=fake_tray_runner)
    assert rc == 0
    assert app.collector.running is True
    assert opened == ["http://127.0.0.1:8655/"]
    assert tray_args == {"app": app, "port": 8655, "host": "127.0.0.1"}


def test_main_startup_failure_shuts_down_and_returns_nonzero(monkeypatch):
    app = FakeApp(with_shutdown=True)
    failures: list[str] = []

    monkeypatch.setattr(tray, "redirect_output", lambda force=False: None)
    monkeypatch.setattr(tray, "serving", lambda port, host=tray.DEFAULT_HOST, timeout=1.0: False)
    monkeypatch.setattr(tray, "wait_until_ready", lambda port, **kw: False)
    monkeypatch.setattr(tray, "report_startup_failure", lambda msg: failures.append(msg))

    rc = tray.main(["--port", "8620"], app_factory=lambda: app)
    assert rc == 1
    assert app.shutdown_calls == 1
    assert len(failures) == 1
