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

from towerpilot import __version__, adb, ocr
from towerpilot.capture import FrameSource
from towerpilot.collector import GemCollector
from towerpilot.config import CONFIG_PATH, deep_merge, load_config, save_config

STATIC_DIR = Path(__file__).resolve().parent / "towerpilot" / "static"


def _error_frame(message: str, width: int = 540, height: int = 960) -> bytes:
    """Render a clean dark placeholder JPEG when the emulator is offline."""
    canvas = np.full((height, width, 3), (22, 18, 16), dtype=np.uint8)
    cv2.putText(canvas, "Emulator Offline", (40, height // 2 - 20), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (120, 130, 235), 2, cv2.LINE_AA)
    wrapped = [message[i : i + 44] for i in range(0, min(len(message), 176), 44)] or ["Check MuMu / ADB connection"]
    for idx, line in enumerate(wrapped):
        cv2.putText(canvas, line, (40, height // 2 + 25 + idx * 28), cv2.FONT_HERSHEY_SIMPLEX, 0.52, (165, 175, 190), 1, cv2.LINE_AA)
    ok, buf = cv2.imencode(".jpg", canvas, [int(cv2.IMWRITE_JPEG_QUALITY), 75])
    return buf.tobytes() if ok else b""


def create_app(
    *,
    config_path: Path = CONFIG_PATH,
    frame_source: FrameSource | None = None,
    collector: GemCollector | None = None,
) -> Flask:
    app = Flask(__name__, static_folder=str(STATIC_DIR), static_url_path="/static")
    cfg_lock = threading.RLock()
    state: dict[str, Any] = {"cfg": load_config(config_path)}

    frames = frame_source if frame_source is not None else FrameSource(state["cfg"])
    gem_collector = collector if collector is not None else GemCollector(frames, state["cfg"])

    app.extensions["towerpilot"] = {
        "config_path": config_path,
        "state": state,
        "frames": frames,
        "collector": gem_collector,
        "lock": cfg_lock,
    }

    @app.route("/")
    def index() -> Response:
        return send_from_directory(STATIC_DIR, "index.html")

    @app.route("/api/status")
    def api_status() -> Response:
        with cfg_lock:
            cfg = state["cfg"]
        return jsonify({
            "version": __version__,
            "config": cfg,
            "collector": gem_collector.status(),
        })

    @app.route("/api/config", methods=["GET", "POST"])
    def api_config() -> tuple[Response, int] | Response:
        if request.method == "GET":
            with cfg_lock:
                return jsonify(state["cfg"])
        patch = request.get_json(silent=True)
        if not isinstance(patch, dict):
            return jsonify({"error": "JSON object expected"}), 400
        with cfg_lock:
            merged = deep_merge(state["cfg"], patch)
            try:
                saved = save_config(merged, config_path)
            except (ValueError, TypeError, KeyError) as exc:
                return jsonify({"error": str(exc)}), 400
            state["cfg"] = saved
            frames.reconfigure(saved)
            gem_collector.reconfigure(saved)
        return jsonify(saved)

    @app.route("/api/collector/start", methods=["POST"])
    def api_start() -> Response:
        started = gem_collector.start()
        return jsonify({"started": started, "running": gem_collector.running})

    @app.route("/api/collector/stop", methods=["POST"])
    def api_stop() -> Response:
        stopped = gem_collector.stop()
        return jsonify({"stopped": stopped, "running": gem_collector.running})

    @app.route("/api/collector/tap/ad", methods=["POST"])
    def api_tap_ad() -> Response:
        return jsonify(gem_collector.trigger_ad_gem_now())

    @app.route("/api/collector/tap/floating", methods=["POST"])
    def api_tap_floating() -> Response:
        return jsonify(gem_collector.trigger_floating_gem_now())

    @app.route("/api/events/clear", methods=["POST"])
    def api_clear_events() -> Response:
        gem_collector.clear_events()
        return jsonify({"ok": True})

    @app.route("/api/adb/devices")
    def api_adb_devices() -> Response:
        with cfg_lock:
            serial = state["cfg"]["adb"]["serial"]
        try:
            devs = adb.devices(timeout=3.0)
            state_str = adb.get_state(serial, timeout=2.0) if serial else "unconfigured"
            return jsonify({"ok": True, "devices": devs, "serial": serial, "state": state_str})
        except Exception as exc:
            return jsonify({"ok": False, "devices": [], "serial": serial, "state": "no_server", "error": str(exc)})

    @app.route("/api/snapshot.jpg")
    def api_snapshot() -> Response:
        with cfg_lock:
            quality = int(state["cfg"]["stream"]["quality"])
        try:
            frame, backend = frames.read_frame(prefer_preview=True)
            ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
            if not ok:
                raise RuntimeError("JPEG encode failed")
            return Response(buf.tobytes(), mimetype="image/jpeg", headers={"X-Stream-Backend": backend})
        except Exception as exc:
            return Response(_error_frame(str(exc)), mimetype="image/jpeg", status=503)

    @app.route("/api/stream.mjpg")
    def api_stream() -> Response:
        req_fps = request.args.get("fps", type=float)
        req_quality = request.args.get("quality", type=int)

        def generate():
            boundary = b"--frame\r\n"
            while True:
                started = time.monotonic()
                with cfg_lock:
                    cfg_stream = state["cfg"]["stream"]
                    fps = req_fps if req_fps and 0.5 <= req_fps <= 30.0 else float(cfg_stream["fps"])
                    quality = req_quality if req_quality and 30 <= req_quality <= 95 else int(cfg_stream["quality"])
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
                        time.sleep(sleep_for)
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
                    time.sleep(1.5)

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
    parser.add_argument("--autostart", action="store_true", help="Start the gem collector on launch")
    args = parser.parse_args()

    app = create_app()
    ext = app.extensions["towerpilot"]

    def _cleanup() -> None:
        ext["collector"].stop()
        ext["frames"].close()
        ocr.shutdown()

    atexit.register(_cleanup)
    if args.autostart:
        ext["collector"].start()

    print(f"Tower Pilot v{__version__} listening on http://{args.host}:{args.port}/", flush=True)
    app.run(host=args.host, port=args.port, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
