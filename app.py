"""Tower Pilot — minimal Flask server for the live emulator stream and gem collector."""
from __future__ import annotations

import argparse
import atexit
import os
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import cv2
import numpy as np
from flask import Flask, Response, jsonify, request, send_from_directory

from towerpilot import __version__, loadouts, ocr, wiki
from towerpilot.battle_menu import BattleHistoryStore
from towerpilot.capture import FrameSource
from towerpilot.collector import GemCollector
from towerpilot.config import CONFIG_PATH, VALID_MODES, deep_merge, load_config, save_config
from towerpilot.profiles import ProfileStore
from towerpilot.telemetry import Telemetry

STATIC_DIR = Path(__file__).resolve().parent / "towerpilot" / "static"

_HARVEST_TOP_KEYS = frozenset({"running", "mode", "ad_gems", "floating_gems", "run_flow", "run_rules"})
_HARVEST_GEM_KEYS = frozenset({"enabled", "timer_interval_sec"})
_HARVEST_FLOW_KEYS = frozenset({"auto_home", "auto_battle", "auto_retry", "auto_resume"})
_RUN_RULES_KEYS = frozenset(
    {
        "profile_name",
        "finish_and_stop",
        "max_runs",
        "expected_tier",
        "no_start_enabled",
        "no_start_from",
        "no_start_until",
        "freeze_timeout_min",
        "notify_on_death",
    }
)
_ROUTINES_KEYS = frozenset(
    {
        "auto_sync_history",
        "auto_claim_daily",
        "auto_claim_guild",
        "history_interval_min",
        "daily_interval_min",
        "guild_interval_min",
    }
)
_LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})


def _parse_host_port(host_header: str, default_port: int) -> tuple[str, int] | None:
    """Parse a Host header into (lowercase_hostname, effective_port), or None if invalid/non-loopback."""
    raw = host_header.strip()
    if not raw or any(ch in raw for ch in ("/", "\\", "@", " ", "\t", "\r", "\n")):
        return None
    try:
        parsed = urlparse(f"http://{raw}")
        hostname = (parsed.hostname or "").lower()
        port = parsed.port if parsed.port is not None else default_port
    except ValueError:
        return None
    if hostname not in _LOOPBACK_HOSTS:
        return None
    return hostname, port


def _origin_matches_request(url_header: str, expected_scheme: str, expected_host: tuple[str, int]) -> bool:
    """True when Origin/Referer parses cleanly and matches the request's exact loopback origin."""
    raw = url_header.strip()
    if not raw:
        return False
    try:
        parsed = urlparse(raw)
        scheme = parsed.scheme.lower()
        hostname = (parsed.hostname or "").lower()
        default_port = 443 if scheme == "https" else 80
        port = parsed.port if parsed.port is not None else default_port
    except ValueError:
        return False
    if scheme != expected_scheme or hostname not in _LOOPBACK_HOSTS:
        return False
    return (hostname, port) == expected_host


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

    if "run_flow" in payload:
        sub = payload["run_flow"]
        if not isinstance(sub, dict):
            raise ValueError("run_flow must be a JSON object")
        bad_flow = set(sub) - _HARVEST_FLOW_KEYS
        if bad_flow:
            raise ValueError(f"Unknown run_flow fields: {', '.join(sorted(bad_flow))}")
        cfg_patch["run_flow"] = dict(sub)

    if "run_rules" in payload:
        sub = payload["run_rules"]
        if not isinstance(sub, dict):
            raise ValueError("run_rules must be a JSON object")
        bad_rules = set(sub) - _RUN_RULES_KEYS
        if bad_rules:
            raise ValueError(f"Unknown run_rules fields: {', '.join(sorted(bad_rules))}")
        cfg_patch["run_rules"] = dict(sub)

    return running, cfg_patch


def _parse_run_rules_patch(payload: Any) -> tuple[str | None, dict[str, Any]]:
    """Validate a POST /api/run-rules payload into (action, config_patch)."""
    if not isinstance(payload, dict):
        raise ValueError("JSON object expected")
    allowed = _RUN_RULES_KEYS | {"action", "run_flow", "run_rules"}
    unknown = set(payload) - allowed
    if unknown:
        raise ValueError(f"Unknown fields: {', '.join(sorted(unknown))}")

    action = payload.get("action")
    if action is not None and action not in ("reset_run_count",):
        raise ValueError(f"Unknown action: {action}")

    cfg_patch: dict[str, Any] = {}
    if "run_flow" in payload:
        sub = payload["run_flow"]
        if not isinstance(sub, dict):
            raise ValueError("run_flow must be a JSON object")
        bad_flow = set(sub) - _HARVEST_FLOW_KEYS
        if bad_flow:
            raise ValueError(f"Unknown run_flow fields: {', '.join(sorted(bad_flow))}")
        cfg_patch["run_flow"] = dict(sub)

    rules_patch: dict[str, Any] = {}
    if "run_rules" in payload:
        sub = payload["run_rules"]
        if not isinstance(sub, dict):
            raise ValueError("run_rules must be a JSON object")
        bad_rules = set(sub) - _RUN_RULES_KEYS
        if bad_rules:
            raise ValueError(f"Unknown run_rules fields: {', '.join(sorted(bad_rules))}")
        rules_patch.update(sub)

    for key in _RUN_RULES_KEYS:
        if key in payload:
            rules_patch[key] = payload[key]

    if rules_patch:
        cfg_patch["run_rules"] = rules_patch

    return action, cfg_patch


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
    data_dir = config_path.parent / "data"
    account_store = loadouts.AccountStore(data_dir / "account.json")
    history_store = BattleHistoryStore(data_dir / "battle_history.json")
    wiki_cache_path = data_dir / "wiki_cache.json"
    event_log_path = config_path.parent / "logs" / "events.jsonl"
    profile_store = ProfileStore(data_dir / "profiles.json")
    profile_store.seed_from_config(state["cfg"])
    telemetry = Telemetry(event_log_path=event_log_path)
    if collector is not None:
        gem_collector = collector
        if hasattr(collector, "profile_store"):
            profile_store = collector.profile_store
        if hasattr(collector, "telemetry"):
            telemetry = collector.telemetry
        if hasattr(collector, "account_store"):
            account_store = collector.account_store
        if hasattr(collector, "history_store"):
            history_store = collector.history_store
    else:
        gem_collector = GemCollector(
            frames,
            state["cfg"],
            event_log_path=event_log_path,
            profile_store=profile_store,
            telemetry=telemetry,
            account_store=account_store,
            history_store=history_store,
        )

    def status_payload() -> dict[str, Any]:
        return {"version": __version__, **gem_collector.status()}

    def update_harvest(payload: dict[str, Any]) -> dict[str, Any]:
        running, cfg_patch = _parse_harvest_patch(payload)
        if running is not None:
            cfg_patch["running"] = running
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
        "state": state,
        "frames": frames,
        "collector": gem_collector,
        "account_store": account_store,
        "profile_store": profile_store,
        "telemetry": telemetry,
        "wiki_cache_path": wiki_cache_path,
        "shutdown": shutdown,
        "update_harvest": update_harvest,
    }

    @app.before_request
    def _enforce_loopback_origin() -> tuple[Response, int] | None:
        scheme = (request.scheme or "http").lower()
        default_port = 443 if scheme == "https" else 80
        host_pair = _parse_host_port(request.host or "", default_port)
        if host_pair is None:
            return jsonify({"error": "Untrusted Host header"}), 403
        if request.method in ("POST", "PUT", "PATCH", "DELETE"):
            origin = request.headers.get("Origin")
            if origin is not None and not _origin_matches_request(origin, scheme, host_pair):
                return jsonify({"error": "Cross-origin request rejected"}), 403
            referer = request.headers.get("Referer")
            if origin is None and referer is not None and not _origin_matches_request(referer, scheme, host_pair):
                return jsonify({"error": "Cross-origin referer rejected"}), 403
        return None

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

    @app.route("/api/runs")
    def api_runs() -> Response:
        return jsonify(gem_collector.runs_ledger())

    @app.route("/api/profiles", methods=["GET", "POST"])
    def api_profiles() -> tuple[Response, int] | Response:
        if request.method == "GET":
            return jsonify(profile_store.snapshot())
        payload = request.get_json(silent=True)
        try:
            prof = profile_store.upsert(payload)
            return jsonify({"profile": prof, "store": profile_store.snapshot()})
        except (ValueError, TypeError) as exc:
            return jsonify({"error": str(exc)}), 400

    @app.route("/api/profiles/<profile_id>/activate", methods=["POST"])
    def api_profile_activate(profile_id: str) -> tuple[Response, int] | Response:
        raw_body = request.get_data(as_text=True).strip()
        if raw_body:
            payload = request.get_json(silent=True)
            if not isinstance(payload, dict):
                return jsonify({"error": "JSON object expected"}), 400
        else:
            payload = {}
        mode = payload.get("mode", "next")
        if mode not in ("next", "now", "cancel"):
            return jsonify({"error": "mode must be 'next', 'now', or 'cancel'"}), 400
        try:
            if mode == "cancel":
                store_snap = profile_store.queue_next(None)
                telemetry.log(
                    "Cancelled queued profile switch",
                    event="profile_switched",
                    mode="cancel",
                )
            elif mode == "now" and not gem_collector.battle_live:
                store_snap = profile_store.queue_next(profile_id, immediate=True)
                prof = profile_store.get(profile_id)
                gem_collector.on_profile_activated(profile_id, immediate=True)
                telemetry.log(
                    f"Switched active profile to {prof['name'] if prof else profile_id}",
                    event="profile_switched",
                    mode="now",
                    profile_id=profile_id,
                    profile_name=prof["name"] if prof else profile_id,
                )
            else:
                store_snap = profile_store.queue_next(profile_id, immediate=False)
                prof = profile_store.get(profile_id)
                telemetry.log(
                    f"Queued profile for next run: {prof['name'] if prof else profile_id}",
                    event="profile_switched",
                    mode="next",
                    queued_profile_id=profile_id,
                    queued_profile_name=prof["name"] if prof else profile_id,
                )
            return jsonify({"store": store_snap, "status": status_payload()})
        except KeyError as exc:
            return jsonify({"error": str(exc)}), 404
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

    @app.route("/api/profiles/<profile_id>/reset", methods=["POST"])
    def api_profile_reset(profile_id: str) -> tuple[Response, int] | Response:
        try:
            prof = profile_store.reset_runtime(profile_id)
            return jsonify({"profile": prof, "store": profile_store.snapshot()})
        except KeyError as exc:
            return jsonify({"error": str(exc)}), 404

    @app.route("/api/profiles/<profile_id>", methods=["DELETE"])
    def api_profile_delete(profile_id: str) -> tuple[Response, int] | Response:
        try:
            store_snap = profile_store.delete(profile_id)
            return jsonify({"store": store_snap})
        except KeyError as exc:
            return jsonify({"error": str(exc)}), 404
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

    @app.route("/api/metrics")
    def api_metrics() -> Response:
        fmt = (request.args.get("format") or "json").strip().lower()
        if fmt == "prometheus":
            return Response(
                telemetry.to_prometheus(),
                content_type="text/plain; version=0.0.4; charset=utf-8",
            )
        if fmt == "otlp":
            return jsonify(telemetry.to_otlp_json())
        return jsonify(telemetry.snapshot())

    @app.route("/api/run-rules", methods=["POST"])
    def api_run_rules() -> tuple[Response, int] | Response:
        payload = request.get_json(silent=True)
        try:
            action, cfg_patch = _parse_run_rules_patch(payload)
            if cfg_patch:
                with cfg_lock:
                    merged = deep_merge(state["cfg"], cfg_patch)
                    saved = save_config(merged, config_path)
                    state["cfg"] = saved
                    gem_collector.reconfigure(saved)
            if action == "reset_run_count":
                gem_collector.reset_runs_restarted()
            return jsonify(status_payload())
        except (ValueError, TypeError) as exc:
            return jsonify({"error": str(exc)}), 400

    @app.route("/api/account", methods=["GET", "POST"])
    def api_account() -> tuple[Response, int] | Response:
        if request.method == "GET":
            return jsonify({**account_store.snapshot(), "scan": gem_collector.scan_status()})
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "JSON object expected"}), 400
        action = payload.get("action")
        if action == "reset":
            return jsonify({"account": account_store.reset(), "scan": gem_collector.scan_status()})
        if action == "observe":
            try:
                frame, _backend = frames.latest_or_grab(max_age_sec=1.5)
                obs = loadouts.observe_frame(frame)
                # Defense-in-depth (P2-C): never record Workshop/UW unlocks while a battle is live
                if gem_collector.is_battle_live() and obs.get("screen") in ("workshop", "ultimate_weapons"):
                    obs = {**obs, "screen": "battle", "tier": None, "presets": [], "items": [], "line_count": 0}
                snap = account_store.merge_observation(obs)
                return jsonify({"observed": obs, "account": snap, "scan": gem_collector.scan_status()})
            except Exception as exc:
                return jsonify({"error": str(exc)}), 502
        if action == "scan":
            scope = payload.get("scope", "all")
            if not isinstance(scope, str):
                return jsonify({"error": "scope must be a string"}), 400
            queue_if_battle = payload.get("queue_if_battle", True)
            if not isinstance(queue_if_battle, bool):
                return jsonify({"error": "queue_if_battle must be a boolean"}), 400
            try:
                scan_state = gem_collector.request_scan(scope=scope, queue_if_battle=queue_if_battle)
            except ValueError as exc:
                return jsonify({"error": str(exc)}), 400
            except RuntimeError as exc:
                return jsonify({"error": str(exc)}), 409
            return jsonify({"scan": scan_state, "account": {**account_store.snapshot(), "scan": scan_state}})
        if action == "cancel_scan":
            scan_state = gem_collector.cancel_scan()
            return jsonify({"scan": scan_state, "account": {**account_store.snapshot(), "scan": scan_state}})
        return jsonify({"error": "action must be 'observe', 'reset', 'scan', or 'cancel_scan'"}), 400

    @app.route("/api/setup-test", methods=["GET", "POST"])
    def api_setup_test() -> tuple[Response, int] | Response:
        if request.method == "GET":
            return jsonify(gem_collector.setup_test_status())
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "JSON object expected"}), 400
        action = payload.get("action", "start")
        max_wave = payload.get("max_wave", 50)
        profile_id = payload.get("profile_id")
        if profile_id is not None and not isinstance(profile_id, str):
            return jsonify({"error": "profile_id must be a string"}), 400
        try:
            st = gem_collector.request_setup_test(
                action=str(action),
                max_wave=max_wave,
                profile_id=profile_id,
            )
            return jsonify({"setup_test": st, "status": status_payload()})
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except KeyError as exc:
            return jsonify({"error": str(exc)}), 404
        except RuntimeError as exc:
            return jsonify({"error": str(exc)}), 409

    @app.route("/api/routines", methods=["GET", "POST"])
    def api_routines() -> tuple[Response, int] | Response:
        if request.method == "GET":
            with cfg_lock:
                rcfg = dict(state["cfg"].get("routines") or {})
            return jsonify({"routines": rcfg, "battle_menu": gem_collector.battle_menu_status()})

        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            return jsonify({"error": "JSON object expected"}), 400

        action = payload.get("action")
        if action is not None:
            if action == "cancel":
                bm = gem_collector.cancel_battle_menu()
                return jsonify({"battle_menu": bm, "status": status_payload()})
            if action == "run":
                task = payload.get("task")
                if not isinstance(task, str):
                    return jsonify({"error": "task must be a string"}), 400
                try:
                    bm = gem_collector.request_battle_menu(task, trigger="manual")
                    return jsonify({"battle_menu": bm, "status": status_payload()})
                except ValueError as exc:
                    return jsonify({"error": str(exc)}), 400
                except RuntimeError as exc:
                    return jsonify({"error": str(exc)}), 409
            return jsonify({"error": f"Unknown action: {action}"}), 400

        # Otherwise update automatic routine toggles / intervals
        sub = payload.get("routines") if "routines" in payload else payload
        if not isinstance(sub, dict):
            return jsonify({"error": "routines must be a JSON object"}), 400
        bad = set(sub) - _ROUTINES_KEYS
        if bad:
            return jsonify({"error": f"Unknown routines fields: {', '.join(sorted(bad))}"}), 400
        try:
            with cfg_lock:
                merged = deep_merge(state["cfg"], {"routines": dict(sub)})
                saved = save_config(merged, config_path)
                state["cfg"] = saved
                gem_collector.reconfigure(saved)
            return jsonify(status_payload())
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

    @app.route("/api/wiki")
    def api_wiki() -> tuple[Response, int] | Response:
        mode = (request.args.get("mode") or "entry").strip().lower()
        q = (request.args.get("q") or request.args.get("slug") or "").strip()
        cat = (request.args.get("category") or "").strip().lower() or None
        if mode == "search":
            return jsonify({"results": wiki.search_index(q, category=cat)})
        if not q:
            return jsonify({"error": "q or slug is required"}), 400
        refresh = request.args.get("refresh") in ("1", "true", "yes")
        try:
            return jsonify(wiki.fetch_entry(q, refresh=refresh, cache_path=wiki_cache_path))
        except ValueError as exc:
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
    if args.autostart or ext["state"]["cfg"].get("running"):
        ext["collector"].start()

    print(f"Tower Pilot v{__version__} listening on http://{args.host}:{args.port}/", flush=True)
    app.run(host=args.host, port=args.port, threaded=True, use_reloader=False)


if __name__ == "__main__":
    main()
