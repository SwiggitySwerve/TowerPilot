"""Human-like ADB socket taps with jitter, press duration, rate cap, and safety gates."""
from __future__ import annotations

import random
import threading
import time
from typing import Any

from towerpilot import adb

TAP_DRIFT_PX = 2


class TapRefused(RuntimeError):
    """Raised when a safety rail refuses to dispatch a tap."""


class Tapper:
    """Rate-limited, jittered tap dispatcher over ADB socket."""

    def __init__(self, rng: random.Random | None = None) -> None:
        self._lock = threading.Lock()
        self._last_tap = 0.0
        self._rng = rng or random.Random()

    def tap(
        self,
        serial: str,
        x: int,
        y: int,
        *,
        cfg: dict[str, Any],
        input_display: int | None = None,
        reason: str = "",
        frame_size: tuple[int, int] | None = None,
        stop_event: threading.Event | None = None,
    ) -> dict[str, Any]:
        """Dispatch one human-like tap over ADB socket (or simulate in dry_run)."""
        safety = cfg["safety"]
        jitter = int(safety["jitter_px"])
        jx = int(round(x)) + (self._rng.randint(-jitter, jitter) if jitter else 0)
        jy = int(round(y)) + (self._rng.randint(-jitter, jitter) if jitter else 0)

        w, h = frame_size if frame_size is not None else (cfg["screen"]["width"], cfg["screen"]["height"])
        if not (0 <= jx < w and 0 <= jy < h):
            raise TapRefused(f"Tap ({jx}, {jy}) out of bounds for {w}x{h}")

        dry_run = bool(safety["dry_run"])
        result = {
            "x": jx,
            "y": jy,
            "reason": reason,
            "dry_run": dry_run,
            "dispatched": False,
        }
        if dry_run:
            return result

        if not safety["allow_taps"]:
            raise TapRefused("allow_taps is disabled")
        if not serial:
            raise TapRefused("No ADB serial configured")

        min_interval = 1.0 / float(safety["max_taps_per_sec"])
        with self._lock:
            if stop_event is not None and stop_event.is_set():
                raise TapRefused("Tap cancelled before rate-limit wait")
            wait = min_interval - (time.monotonic() - self._last_tap)
            if wait > 0:
                if stop_event is not None:
                    if stop_event.wait(wait):
                        raise TapRefused("Tap cancelled during rate-limit wait")
                else:
                    time.sleep(wait)
            if stop_event is not None and stop_event.is_set():
                raise TapRefused("Tap cancelled before dispatch")

            pmin, pmax = safety["press_ms"]
            dur = self._rng.randint(int(pmin), int(pmax))
            dx = self._rng.randint(-TAP_DRIFT_PX, TAP_DRIFT_PX)
            dy = self._rng.randint(-TAP_DRIFT_PX, TAP_DRIFT_PX)
            ex = max(0, min(w - 1, jx + dx))
            ey = max(0, min(h - 1, jy + dy))

            disp_flag = f" -d {input_display}" if input_display is not None else ""
            cmd = f"input{disp_flag} swipe {jx} {jy} {ex} {ey} {dur}"
            try:
                raw = adb.shell(serial, cmd, timeout=8.0)
            except (OSError, adb.AdbError) as exc:
                raise TapRefused(f"ADB tap failed: {exc}") from exc
            output = raw.decode("utf-8", errors="replace").strip() if raw else ""
            if output:
                raise TapRefused(f"ADB input error: {output}")
            self._last_tap = time.monotonic()

        result["dispatched"] = True
        result["duration_ms"] = dur
        return result

    def swipe(
        self,
        serial: str,
        x1: int,
        y1: int,
        x2: int,
        y2: int,
        *,
        duration_ms: int = 500,
        cfg: dict[str, Any],
        input_display: int | None = None,
        reason: str = "",
        frame_size: tuple[int, int] | None = None,
        stop_event: threading.Event | None = None,
    ) -> dict[str, Any]:
        """Dispatch one human-like swipe over ADB socket (or simulate in dry_run)."""
        safety = cfg["safety"]
        jitter = int(safety["jitter_px"])
        jx1 = int(round(x1)) + (self._rng.randint(-jitter, jitter) if jitter else 0)
        jy1 = int(round(y1)) + (self._rng.randint(-jitter, jitter) if jitter else 0)
        jx2 = int(round(x2)) + (self._rng.randint(-jitter, jitter) if jitter else 0)
        jy2 = int(round(y2)) + (self._rng.randint(-jitter, jitter) if jitter else 0)

        w, h = frame_size if frame_size is not None else (cfg["screen"]["width"], cfg["screen"]["height"])
        if not (0 <= jx1 < w and 0 <= jy1 < h):
            raise TapRefused(f"Swipe start ({jx1}, {jy1}) out of bounds for {w}x{h}")
        if not (0 <= jx2 < w and 0 <= jy2 < h):
            raise TapRefused(f"Swipe end ({jx2}, {jy2}) out of bounds for {w}x{h}")

        dur = int(duration_ms)
        if dur <= 0:
            raise TapRefused(f"Invalid swipe duration_ms: {duration_ms}")

        dry_run = bool(safety["dry_run"])
        result = {
            "x1": jx1,
            "y1": jy1,
            "x2": jx2,
            "y2": jy2,
            "duration_ms": dur,
            "reason": reason,
            "dry_run": dry_run,
            "dispatched": False,
        }
        if dry_run:
            return result

        if not safety["allow_taps"]:
            raise TapRefused("allow_taps is disabled")
        if not serial:
            raise TapRefused("No ADB serial configured")

        min_interval = 1.0 / float(safety["max_taps_per_sec"])
        with self._lock:
            if stop_event is not None and stop_event.is_set():
                raise TapRefused("Swipe cancelled before rate-limit wait")
            wait = min_interval - (time.monotonic() - self._last_tap)
            if wait > 0:
                if stop_event is not None:
                    if stop_event.wait(wait):
                        raise TapRefused("Swipe cancelled during rate-limit wait")
                else:
                    time.sleep(wait)
            if stop_event is not None and stop_event.is_set():
                raise TapRefused("Swipe cancelled before dispatch")

            disp_flag = f" -d {input_display}" if input_display is not None else ""
            cmd = f"input{disp_flag} swipe {jx1} {jy1} {jx2} {jy2} {dur}"
            timeout = max(8.0, dur / 1000.0 + 5.0)
            try:
                raw = adb.shell(serial, cmd, timeout=timeout)
            except (OSError, adb.AdbError) as exc:
                raise TapRefused(f"ADB swipe failed: {exc}") from exc
            output = raw.decode("utf-8", errors="replace").strip() if raw else ""
            if output:
                raise TapRefused(f"ADB input error: {output}")
            self._last_tap = time.monotonic()

        result["dispatched"] = True
        return result
