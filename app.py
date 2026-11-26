"""Tower Pilot — minimal Flask server for the live emulator stream and gem collector."""
from __future__ import annotations

import argparse
import atexit
import os
import threading
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from flask import Flask, Response, jsonify, request, send_from_directory

from towerpilot import __version__, ocr
from towerpilot.capture import FrameSource
from towerpilot.collector import GemCollector
from towerpilot.config import CONFIG_PATH, VALID_MODES, deep_merge, load_config, save_config

STATIC_DIR = Path(__file__).resolve().parent / "towerpilot" / "static"

_HARVEST_TOP_KEYS = frozenset({"running", "mode", "ad_gems", "floating_gems"})
_HARVEST_GEM_KEYS = frozenset({"enabled", "timer_interval_sec"})


def _error_frame(message: str, width: int = 540, height: int = 960) -> bytes:
    """Render a clean dark placeholder JPEG when the emulator is offline."""
    canvas = np.full((height, width, 3), (22, 18, 16), dtype=np.uint8)
    cv2.putText(
        canvas,
        "Emulator Offline",
        (40, height // 2 - 20),
        cv2.FONT_HERSHEY_SIMPLEX,
        1.0,
        (120, 130, 235),
        2,
        cv2.LINE_AA,
    )
    wrapped = [message[i : i + 44] for i in range(0, min(len(message), 176), 44)] or [
        "Check MuMu / ADB connection"
    ]
    for idx, line in enumerate(wrapped):
        cv2.putText(
            canvas,
            line,
            (40, height // 2 + 25 + idx * 28),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.52,
            (165, 175, 190),
            1,
            cv2.LINE_AA,
        )
    ok, buf = cv2.imencode(".jpg", canvas, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
    return buf.tobytes() if ok else b""


def _parse_harvest_patch(payload: Any) -> tuple[bool | None, dict[str, Any]]:
    """Validate a POST /api/harvest payload and split into (running, config_patch)."""
    if not isinstance(payload, dict):
        raise ValueError("JSON object expected")

    unknown = set(payload) - _HARVEST_TOP_KEYS
    if unknown:
        raise ValueError(f"Unknown fields: {', '.join(sorted(unknown))}")

    running: bool | None = None
    if "running" in payload:
        if not isinstance(payload["running"], bool):
            raise ValueError("running must be a boolean")
        running = payload["running"]

    cfg_patch: dict[str, Any] = {}
    if "mode" in payload:
        mode = payload["mode"]
        if not isinstance(mode, str) or mode not in VALID_MODES:
            raise ValueError(f"mode must be one of {VALID_MODES}")
        cfg_patch["mode"] = mode

    for section in ("ad_gems", "floating_gems"):
        if section not in payload:
            continue
        sub = payload[section]
        if not isinstance(sub, dict):
            raise ValueError(f"{section} must be a JSON object")
        bad_sub = set(sub) - _HARVEST_GEM_KEYS
        if bad_sub:
            raise ValueError(f"Unknown {section} fields: {', '.join(sorted(bad_sub))}")
        cfg_patch[section] = dict(sub)

    return running, cfg_patch


def create_app(
    *,
    config_path: Path = CONFIG_PATH,
    frame_source: FrameSource | None = None,
    collector: GemCollector | None = None,
) -> Flask:
    app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
    cfg_lock = threading.RLock()
    shutdown_event = threading.Event()
    state: dict[str, Any] = {"cfg": load_config(config_path)}

    frames = frame_source if frame_source is not None else FrameSource(state["cfg"])
    gem_collector = collector if collector is not None else GemCollector(frames, state["cfg"])

    def status_payload() -> dict[str, Any]:
        return {"version": __version__, **gem_collector.status()}

    def update_harvest(payload: dict[str, Any]) -> dict[str, Any]:
        running, cfg_patch = _parse_harvest_patch(payload)
        with cfg_lock:
            if cfg_patch:
                merged = deep_merge(state["cfg"], cfg_patch)
                saved = save_config(merged, config_path)
                state["cfg"] = saved
                gem_collector.reconfigure(saved)
        if running is True:
            gem_collector.start()
        elif running is False:
            gem_collector.stop()
        return status_payload()

    def shutdown() -> None:
        if shutdown_event.is_set():
            return
        shutdown_event.set()
        try:
            gem_collector.stop()
        finally:
            try:
                frames.close()
            finally:
                ocr.shutdown()

    app.extensions["towerpilot"] = {
        "config_path": config_path,
        "frames": frames,
        "collector": gem_collector,
        "shutdown": shutdown,
        "update_harvest": update_harvest,
    }

    @app.route("/")
    def index() -> Response:
        return send_from_directory(STATIC_DIR, "index.html")

    @app.route("/api/status")
    def api_status() -> Response:
        return jsonify(status_payload())

    @app.route("/api/harvest", methods=["POST"])
    def api_harvest() -> tuple[Response, int] | Response:
        payload = request.get_json(silent=True)
        try:
            return jsonify(update_harvest(payload))
        except (ValueError, TypeError) as exc:
            return jsonify({"error": str(exc)}), 400

    @app.route("/api/stream.mjpg")
    def api_stream() -> Response:
        def generate():
            boundary = b"--frame\r\n"
            while not shutdown_event.is_set():
                started = time.monotonic()
                with cfg_lock:
                    cfg_stream = state["cfg"]["stream"]
                    fps = float(cfg_stream["fps"])
                    quality = int(cfg_stream["quality"])
                try:
                    frame, backend = frames.read_frame(prefer_preview=True)
                    if backend == "adb":
                        fps = min(fps, 4.0)
                    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
                    if not ok:
                        continue
                    jpg = buf.tobytes()
                    header = (
                        f"Content-Type: image/jpeg\r\n"
                        f"Content-Length: {len(jpg)}\r\n"
                        f"X-Stream-Backend: {backend}\r\n\r\n"
                    ).encode("ascii")
                    yield boundary + header + jpg + b"\r\n"
                    sleep_for = (1.0 / fps) - (time.monotonic() - started)
                    if sleep_for > 0:
                        shutdown_event.wait(sleep_for)
                except GeneratorExit:
                    return
                except Exception as exc:
                    jpg = _error_frame(str(exc))
                    header = (
                        f"Content-Type: image/jpeg\r\n"
                        f"Content-Length: {len(jpg)}\r\n"
                        f"X-Stream-Backend: offline\r\n\r\n"
                    ).encode("ascii")
                    yield boundary + header + jpg + b"\r\n"
                    shutdown_event.wait(1.5)

        return Response(
            generate(),
            mimetype="multipart/x-mixed-replace; boundary=frame",
            headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
        )

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="Tower Pilot minimal stream viewer and gem collector")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=int(os.environ.get("TOWER_PILOT_PORT", "8620")))
    parser.add_argument("--autostart", action="store_true", help="Start gem harvesting on launch")
    args = parser.parse_args()

    app = create_app()
    ext = app.extensions["towerpilot"]
    atexit.register(ext["shutdown"])
    if args.autostart:
        ext["collector"].start()

    print(f"Tower Pilot v{__version__} listening on http://{args.host}:{args.port}/", flush=True)
    app.run(host=args.host, port=args.port, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
