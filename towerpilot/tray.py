"""Persistent Windows system-tray launcher for Tower Pilot.

Runs the local Flask dashboard in a daemon thread and owns the main thread
for a notification-area icon so closing the browser never stops gem
harvesting. The tray icon is drawn in memory with Pillow (zero shipped
image files).
"""
from __future__ import annotations

import argparse
import logging
import os
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser
from pathlib import Path
from typing import Any, Callable, TextIO

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8620
LOG_PATH = ROOT / "logs" / "launcher.log"
TITLE = "Tower Pilot"
STALL_NOTIFY_SEC = 600.0
STALL_CHECK_SEC = 15.0


def dashboard_url(port: int, host: str = DEFAULT_HOST) -> str:
    return f"http://{host}:{port}/"


def status_url(port: int, host: str = DEFAULT_HOST) -> str:
    return f"http://{host}:{port}/api/status"


def redirect_output(force: bool = False, log_path: Path | None = None) -> TextIO | None:
    """Redirect stdout/stderr to logs/launcher.log when launched windowlessly."""
    if (
        not force
        and sys.stdout is not None
        and sys.stderr is not None
        and os.environ.get("TOWER_PILOT_WINDOWLESS") != "1"
    ):
        return None
    target = log_path if log_path is not None else LOG_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    stream = open(target, "a", encoding="utf-8", buffering=1)
    sys.stdout = stream
    sys.stderr = stream
    print(f"--- {time.strftime('%Y-%m-%d %H:%M:%S')} launcher start", flush=True)
    return stream


def serving(port: int, host: str = DEFAULT_HOST, timeout: float = 1.0) -> bool:
    """Return True if a Tower Pilot instance is already answering on this port."""
    try:
        with urllib.request.urlopen(status_url(port, host), timeout=timeout) as resp:
            return getattr(resp, "status", 200) == 200
    except OSError:
        return False


def open_dashboard(port: int, host: str = DEFAULT_HOST) -> None:
    webbrowser.open(dashboard_url(port, host))


def wait_until_ready(
    port: int,
    *,
    host: str = DEFAULT_HOST,
    attempts: int = 60,
    delay: float = 0.25,
    stopped: threading.Event | None = None,
) -> bool:
    """Wait for the local Flask server to answer /api/status."""
    for _ in range(attempts):
        if stopped is not None and stopped.is_set():
            return False
        if serving(port, host=host, timeout=0.5):
            return True
        if stopped is None:
            time.sleep(delay)
        else:
            stopped.wait(delay)
    return False


def report_startup_failure(message: str, log_path: Path | None = None) -> None:
    """Log a startup failure and show a Windows dialog when interactive."""
    target = log_path if log_path is not None else LOG_PATH
    full = (
        f"{message}\n\nSee the launcher log at:\n{target}\n\n"
        "Retry Start Tower Pilot after correcting the error."
    )
    print(full, file=sys.stderr, flush=True)
    if sys.platform == "win32":
        import ctypes

        try:
            ctypes.windll.user32.MessageBoxW(None, full, TITLE, 0x10)
        except OSError:
            traceback.print_exc()


def icon_image(size: int = 64):
    """Draw the Tower Pilot tray icon in memory (three ascending cyan bars)."""
    from PIL import Image, ImageDraw

    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    pad = max(1, size // 16)
    draw.rounded_rectangle(
        (pad, pad, size - pad, size - pad),
        radius=max(2, size // 6),
        fill=(18, 22, 42, 255),
    )
    bar = max(2, size // 8)
    base = int(size * 0.78)
    top = int(size * 0.22)
    for idx in range(3):
        x = int(size * 0.24) + idx * (bar + max(1, bar // 2))
        y_top = top + (2 - idx) * (base - top) // 3
        draw.rounded_rectangle(
            (x, y_top, x + bar, base),
            radius=max(1, bar // 3),
            fill=(64, 224, 208, 255),
        )
    return image


def shutdown_app(app: Any) -> None:
    """Cleanly stop the collector, close frame capture, and shut down OCR."""
    ext = getattr(app, "extensions", {}).get("towerpilot", {})
    shutdown_fn = ext.get("shutdown")
    if callable(shutdown_fn):
        shutdown_fn()
        return

    collector = ext.get("collector")
    if collector is not None:
        try:
            collector.stop()
        except Exception:
            traceback.print_exc()

    frames = ext.get("frames")
    if frames is not None:
        try:
            frames.close()
        except Exception:
            traceback.print_exc()

    try:
        from towerpilot import ocr

        ocr.shutdown()
    except Exception:
        traceback.print_exc()


def toggle_harvesting(app: Any) -> bool:
    """Toggle gem harvesting via update_harvest (persisting to config.yaml) and return new state."""
    ext = app.extensions["towerpilot"]
    collector = ext["collector"]
    next_running = not bool(collector.running)
    updater = ext.get("update_harvest")
    if callable(updater):
        updater({"running": next_running})
    elif next_running:
        collector.start()
    else:
        collector.stop()
    return bool(collector.running)


def build_icon(
    app: Any,
    *,
    port: int,
    host: str = DEFAULT_HOST,
    on_quit: Callable[[Any, Any], None] | None = None,
):
    """Build the minimal pystray notification-area icon and menu."""
    import pystray

    collector = app.extensions["towerpilot"]["collector"]
    url = dashboard_url(port, host)

    def _open(icon: Any, item: Any) -> None:
        open_dashboard(port, host)

    def _toggle(icon: Any, item: Any) -> None:
        toggle_harvesting(app)
        if icon is not None and hasattr(icon, "update_menu"):
            icon.update_menu()

    def _is_harvesting(item: Any) -> bool:
        return bool(collector.running)

    def _quit(icon: Any, item: Any) -> None:
        if on_quit is not None:
            on_quit(icon, item)
        else:
            icon.stop()
            shutdown_app(app)

    menu = pystray.Menu(
        pystray.MenuItem("Open Dashboard", _open, default=True),
        pystray.MenuItem("Gem Harvesting", _toggle, checked=_is_harvesting),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", _quit),
    )
    return pystray.Icon("tower_pilot", icon_image(), f"{TITLE} - {url}", menu)


def run_tray(
    app: Any,
    *,
    port: int,
    host: str = DEFAULT_HOST,
    stopped: threading.Event | None = None,
    on_shutdown: Callable[[], None] | None = None,
) -> int:
    """Run the tray icon on the main thread, falling back cleanly if unavailable."""
    cleaned = threading.Event()

    def _shutdown_once() -> None:
        if cleaned.is_set():
            return
        cleaned.set()
        if on_shutdown is not None:
            on_shutdown()
        else:
            shutdown_app(app)

    def _on_quit(icon: Any, item: Any) -> None:
        icon.stop()
        _shutdown_once()

    try:
        icon = build_icon(app, port=port, host=host, on_quit=_on_quit)
    except Exception:  # noqa: BLE001 - tray is optional
        traceback.print_exc()
        print(
            f"No system tray available; serving in foreground on {dashboard_url(port, host)}. "
            "Press Ctrl+C to quit.",
            flush=True,
        )
        wait_event = stopped if stopped is not None else threading.Event()
        try:
            while not wait_event.wait(0.5):
                pass
        except KeyboardInterrupt:
            pass
        finally:
            _shutdown_once()
        return 0

    watch_stop = stopped if stopped is not None else threading.Event()
    collector = app.extensions.get("towerpilot", {}).get("collector")
    if collector is not None and hasattr(collector, "set_notifier"):
        def _tray_notify(message: str, title: str = TITLE) -> None:
            try:
                icon.notify(message, title)
            except Exception:
                pass

        collector.set_notifier(_tray_notify)

    def _watch_server() -> None:
        stalled_since: float | None = None
        notified = False
        while not watch_stop.wait(STALL_CHECK_SEC) and not cleaned.is_set():
            if (
                collector is None
                or not getattr(collector, "running", False)
                or getattr(collector, "battle_live", False)
                or getattr(collector, "flow_hold_reason", None)
            ):
                stalled_since = None
                notified = False
                continue
            now = time.monotonic()
            if stalled_since is None:
                stalled_since = now
            elif not notified and (now - stalled_since) >= STALL_NOTIFY_SEC:
                notified = True
                try:
                    icon.notify("No live battle detected for 10+ minutes.", TITLE)
                except Exception:
                    pass
        if watch_stop.is_set() and not cleaned.is_set():
            print("Dashboard server stopped; closing tray icon.", flush=True)
            icon.stop()

    threading.Thread(target=_watch_server, name="towerpilot-tray-watch", daemon=True).start()

    try:
        icon.run()
    except KeyboardInterrupt:
        icon.stop()
    finally:
        if collector is not None and hasattr(collector, "set_notifier"):
            collector.set_notifier(None)
        _shutdown_once()
    return 0


def _create_flask_app() -> Any:
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    from app import create_app

    return create_app()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Tower Pilot persistent system-tray launcher")
    parser.add_argument("--host", default=DEFAULT_HOST)
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("TOWER_PILOT_PORT", str(DEFAULT_PORT))),
    )
    parser.add_argument(
        "--background",
        action="store_true",
        help="Start in tray without opening the browser or dialogs",
    )
    parser.add_argument(
        "--autostart",
        action="store_true",
        help="Start gem harvesting immediately on launch",
    )
    return parser.parse_args(argv)


def main(
    argv: list[str] | None = None,
    *,
    app_factory: Callable[[], Any] | None = None,
    tray_runner: Callable[..., int] | None = None,
) -> int:
    args = parse_args(argv)
    stream = redirect_output(force=args.background)
    if stream is not None or args.background:
        logging.getLogger("werkzeug").setLevel(logging.WARNING)

    if serving(args.port, host=args.host, timeout=0.5):
        if args.background:
            return 0
        url = dashboard_url(args.port, args.host)
        print(f"Tower Pilot is already serving on {url}; opening dashboard.", flush=True)
        open_dashboard(args.port, args.host)
        return 0

    app = app_factory() if app_factory is not None else _create_flask_app()
    ext = app.extensions["towerpilot"]
    persisted_running = bool(ext.get("state", {}).get("cfg", {}).get("running", False))
    if args.autostart or persisted_running:
        ext["collector"].start()

    stopped = threading.Event()

    def _serve() -> None:
        try:
            app.run(host=args.host, port=args.port, threaded=True, use_reloader=False)
        except BaseException:
            traceback.print_exc()
        finally:
            stopped.set()

    threading.Thread(target=_serve, name="towerpilot-http", daemon=True).start()

    if not wait_until_ready(args.port, host=args.host, stopped=stopped):
        message = (
            "Tower Pilot stopped before becoming ready."
            if stopped.is_set()
            else "Tower Pilot did not become ready before startup timed out."
        )
        shutdown_app(app)
        if args.background:
            print(message, flush=True)
        else:
            report_startup_failure(message)
        return 1

    if not args.background:
        open_dashboard(args.port, args.host)

    runner = tray_runner if tray_runner is not None else run_tray
    return runner(app, port=args.port, host=args.host, stopped=stopped)


if __name__ == "__main__":
    sys.exit(main())
