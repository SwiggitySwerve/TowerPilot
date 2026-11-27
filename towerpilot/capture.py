"""Emulator frame capture: fast MuMu native stream + reliable ADB socket fallback."""
from __future__ import annotations

import json
import re
import secrets
import socket
import struct
import subprocess
import sys
import threading
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import psutil

from towerpilot import adb
from towerpilot.mumu_worker import find_mumu_dll, validate_dimensions

_START_TIMEOUT = 8.0
_MAX_MESSAGE = 16 * 1024


class CaptureError(RuntimeError):
    """Raised when a frame cannot be captured from the emulator."""


class MuMuUnavailable(CaptureError):
    """Raised when MuMu native capture is not available for this target."""


def decode_raw_screencap(raw: bytes) -> np.ndarray:
    """Decode raw Android RGBA screencap bytes into a BGR ndarray."""
    for _ in range(4):
        if len(raw) >= 12:
            width, height, pixel_format = struct.unpack_from("<III", raw)
            header = len(raw) - width * height * 4
            if 0 < width <= 10000 and 0 < height <= 10000 and header in (12, 16):
                if pixel_format not in (1, 2):
                    raise CaptureError(f"Unsupported screencap pixel format: {pixel_format}")
                rgba = np.frombuffer(raw, np.uint8, offset=header).reshape(height, width, 4)
                return cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGR)
        if not raw.startswith(b"[Warning]"):
            break
        nl = raw.find(b"\n", 0, 512)
        if nl < 0:
            break
        raw = raw[nl + 1 :]
    raise CaptureError(f"Invalid raw screencap payload ({len(raw)} bytes)")


def _port(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError("invalid port")
    port = int(value)
    if not 1 <= port <= 65535:
        raise ValueError("invalid port")
    return port


def _vm_ports(vm_dir: Path) -> set[int]:
    ports: set[int] = set()
    cfg = vm_dir / "configs" / "vm_config.json"
    if cfg.is_file():
        data = json.loads(cfg.read_text(encoding="utf-8-sig"))
        ports.add(_port(data["vm"]["nat"]["port_forward"]["adb"]["host_port"]))
    nemu = vm_dir / f"{vm_dir.name}.nemu"
    if nemu.is_file():
        root = ET.parse(nemu).getroot()
        for node in root.iter():
            if node.tag.rsplit("}", 1)[-1] != "Forwarding":
                continue
            if node.get("name") not in {"ADB_PORT", "ADB_PORT_EX", "ADB_PORT_OLD"}:
                continue
            if node.get("hostip") not in {"127.0.0.1", "localhost"}:
                continue
            if node.get("guestport") != "5555" or node.get("proto") != "1":
                continue
            ports.add(_port(node.get("hostport")))
    return ports


def discover_mumu_target(
    serial: str,
    *,
    adb_exe: str = "",
    install_dir: str = "",
    index: int = -1,
) -> tuple[str, int]:
    """Resolve (install_dir, vm_index) matching `serial`'s loopback ADB port."""
    match = re.fullmatch(r"(?:127\.0\.0\.1|localhost):([0-9]+)", serial.strip())
    if match is None:
        raise MuMuUnavailable("MuMu native stream requires a loopback TCP serial")
    requested_port = _port(match[1])
    roots = adb.candidate_mumu_roots(install_dir, adb_exe)
    if not roots:
        raise MuMuUnavailable("MuMu installation directory not found")

    last_error = "No matching MuMu installation found"
    for root in roots:
        try:
            find_mumu_dll(root)
            vms_dir = root / "vms"
            if not vms_dir.is_dir():
                raise ValueError(f"vms directory missing in {root}")
            matches: list[int] = []
            for vm in sorted(vms_dir.iterdir()):
                m = re.fullmatch(r"MuMuPlayer(?:Global)?-[0-9]+(?:\.[0-9]+)*-([0-9]+)", vm.name)
                if m is None or not vm.is_dir():
                    continue
                if requested_port in _vm_ports(vm):
                    matches.append(int(m[1]))
            if len(matches) != 1:
                raise ValueError(f"cannot uniquely match port {requested_port} under {root}")
            if index >= 0 and index != matches[0]:
                raise ValueError(f"configured mumu_index {index} != matched index {matches[0]}")
            return str(root), matches[0]
        except Exception as exc:
            last_error = str(exc)
    raise MuMuUnavailable(last_error)


def _recv_into(sock: socket.socket, buf: memoryview, deadline: float) -> None:
    offset = 0
    while offset < len(buf):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("MuMu helper deadline exceeded")
        sock.settimeout(remaining)
        n = sock.recv_into(buf[offset:])
        if n == 0:
            raise CaptureError("MuMu helper closed its connection")
        offset += n


def _recv_message(sock: socket.socket, deadline: float) -> dict[str, Any]:
    header = bytearray(4)
    _recv_into(sock, memoryview(header), deadline)
    size = struct.unpack("!I", header)[0]
    if size > _MAX_MESSAGE:
        raise CaptureError("MuMu helper returned oversized message")
    payload = bytearray(size)
    _recv_into(sock, memoryview(payload), deadline)
    msg = json.loads(payload)
    if not isinstance(msg, dict):
        raise CaptureError("MuMu helper returned invalid JSON message")
    return msg


def _terminate_tree(proc: subprocess.Popen) -> None:
    """Cleanly stop helper process and any venv child python processes."""
    try:
        parent = psutil.Process(proc.pid)
        family = parent.children(recursive=True) + [parent]
        for child in family:
            try:
                child.terminate()
            except psutil.Error:
                pass
        _, alive = psutil.wait_procs(family, timeout=0.5)
        for child in alive:
            try:
                child.kill()
            except psutil.Error:
                pass
    except psutil.Error:
        try:
            proc.kill()
        except OSError:
            pass
    try:
        proc.wait(timeout=0.5)
    except (OSError, subprocess.TimeoutExpired):
        pass


class MuMuStream:
    """On-demand BGR frames from an isolated MuMu renderer helper process."""

    def __init__(self, install_dir: str, index: int, package: str = adb.GAME_PKG) -> None:
        self._lock = threading.Lock()
        self._closed = False
        self._proc: subprocess.Popen | None = None
        self._sock: socket.socket | None = None
        deadline = time.monotonic() + _START_TIMEOUT
        token = secrets.token_hex(24)
        repo_root = str(Path(__file__).resolve().parents[1])
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
                listener.bind(("127.0.0.1", 0))
                listener.listen(1)
                cmd = [
                    sys.executable,
                    "-m",
                    "towerpilot.mumu_worker",
                    str(listener.getsockname()[1]),
                    token,
                    install_dir,
                    str(index),
                    package,
                ]
                self._proc = subprocess.Popen(
                    cmd,
                    cwd=repo_root,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                )
                listener.settimeout(max(0.1, deadline - time.monotonic()))
                self._sock, _ = listener.accept()
                self._sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                hello = _recv_message(self._sock, deadline)
                if hello.get("token") != token:
                    raise MuMuUnavailable("MuMu helper auth failed")
                if "error" in hello:
                    raise MuMuUnavailable(f"MuMu helper init failed: {hello['error']}")
                self.width, self.height = validate_dimensions(hello.get("width"), hello.get("height"))
        except Exception as exc:
            self.close()
            if isinstance(exc, MuMuUnavailable):
                raise
            raise MuMuUnavailable(f"MuMu helper failed to start: {exc}") from exc

    def read(self, timeout: float = 2.0) -> np.ndarray:
        deadline = time.monotonic() + timeout
        if not self._lock.acquire(timeout=timeout):
            raise CaptureError("MuMu stream busy")
        try:
            sock = self._sock
            if self._closed or sock is None:
                raise CaptureError("MuMu stream closed")
            sock.settimeout(max(0.1, deadline - time.monotonic()))
            sock.sendall(b"F")
            status = bytearray(1)
            _recv_into(sock, memoryview(status), deadline)
            if status == b"E":
                err = _recv_message(sock, deadline).get("error", "unknown")
                raise CaptureError(f"MuMu capture error: {err}")
            if status != b"F":
                raise CaptureError("MuMu helper returned bad frame header")
            frame = np.empty((self.height, self.width, 3), dtype=np.uint8)
            _recv_into(sock, memoryview(frame).cast("B"), deadline)
            return frame
        except Exception:
            self.close()
            raise
        finally:
            self._lock.release()

    def close(self) -> None:
        self._closed = True
        sock, self._sock = self._sock, None
        if sock is not None:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                sock.close()
            except OSError:
                pass
        proc, self._proc = self._proc, None
        if proc is not None:
            _terminate_tree(proc)


class FrameSource:
    """Unified emulator frame source for both the live web stream and the collector.

    - Preview stream uses MuMu native capture (up to 30 FPS) when available,
      falling back cleanly to ADB raw screencap (capped at 4 FPS).
    - Verified safety captures (`grab_adb`) ALWAYS use the ADB socket screencap
      on the resolved game display so a minimized or covered app is never
      mistaken for a foreground game.
    """

    def __init__(self, cfg: dict[str, Any]) -> None:
        self._lock = threading.RLock()
        self._cfg = cfg
        self._mumu: MuMuStream | None = None
        self._mumu_failed_until = 0.0
        self._display_serial: str | None = None
        self._physical_display: str | None = None
        self._input_display: int | None = None
        self.active_backend: str = "none"
        self.last_error: str | None = None
        self.last_frame: np.ndarray | None = None
        self.last_frame_at: float = 0.0
        self.last_frame_size: tuple[int, int] | None = None

    def reconfigure(self, cfg: dict[str, Any]) -> None:
        with self._lock:
            old_serial = self._cfg["adb"]["serial"]
            old_stream = self._cfg["stream"]
            self._cfg = cfg
            if (
                cfg["adb"]["serial"] != old_serial
                or cfg["stream"]["backend"] != old_stream["backend"]
                or cfg["stream"]["mumu_install_dir"] != old_stream["mumu_install_dir"]
                or cfg["stream"]["mumu_index"] != old_stream["mumu_index"]
            ):
                self._close_mumu_locked()
                self._mumu_failed_until = 0.0
                self._display_serial = None
                self._physical_display = None
                self._input_display = None

    def _close_mumu_locked(self) -> None:
        if self._mumu is not None:
            self._mumu.close()
            self._mumu = None

    def close(self) -> None:
        with self._lock:
            self._close_mumu_locked()

    @property
    def serial(self) -> str:
        return self._cfg["adb"]["serial"]

    @property
    def input_display(self) -> int | None:
        with self._lock:
            _, logical = self._resolve_display_pair_locked()
            return logical

    def _resolve_display_pair_locked(self, force: bool = False) -> tuple[str | None, int | None]:
        """Resolve and validate the (physical, logical) display pair, failing closed on error."""
        serial = self._cfg["adb"]["serial"]
        if not serial:
            raise CaptureError("No ADB serial configured")
        if force or self._display_serial != serial or (
            self._physical_display is not None and self._input_display is None
        ):
            try:
                physical, logical = adb.resolve_game_display(serial)
            except (OSError, adb.AdbError) as exc:
                self._physical_display, self._input_display = None, None
                self._display_serial = None
                raise CaptureError(f"Display lookup failed: {exc}") from exc
            if physical is not None and logical is None:
                self._physical_display, self._input_display = physical, None
                self._display_serial = None
                raise CaptureError(
                    f"Secondary display {physical} has no matching logical input display"
                )
            self._physical_display, self._input_display = physical, logical
            self._display_serial = serial
        return self._physical_display, self._input_display

    def grab_adb_with_display(self) -> tuple[np.ndarray, int | None]:
        """Capture a fresh ADB frame paired atomically with its verified logical input display."""
        with self._lock:
            serial = self._cfg["adb"]["serial"]
            adb_exe = self._cfg["adb"].get("exe", "")
            mumu_dir = self._cfg["stream"].get("mumu_install_dir", "")
            exp_w = self._cfg["screen"]["width"]
            exp_h = self._cfg["screen"]["height"]
        if not serial:
            raise CaptureError("No ADB serial configured")

        try:
            with self._lock:
                display, input_disp = self._resolve_display_pair_locked()
        except CaptureError:
            adb.recover(serial, adb_exe=adb_exe, mumu_install_dir=mumu_dir)
            with self._lock:
                display, input_disp = self._resolve_display_pair_locked(force=True)

        cmd = "screencap" + (f" -d {display}" if display else "")
        raw = b""
        for attempt in (1, 2):
            try:
                raw = adb.exec_out(serial, cmd, timeout=12.0)
                if len(raw) >= 1000:
                    break
            except (OSError, adb.AdbError) as exc:
                if attempt == 2:
                    raise CaptureError(f"ADB screencap failed: {exc}") from exc
                adb.recover(serial, adb_exe=adb_exe, mumu_install_dir=mumu_dir)
                with self._lock:
                    display, input_disp = self._resolve_display_pair_locked(force=True)
                cmd = "screencap" + (f" -d {display}" if display else "")

        if len(raw) < 1000:
            with self._lock:
                new_display, new_input = self._resolve_display_pair_locked(force=True)
            if new_display != display:
                display, input_disp = new_display, new_input
                cmd = "screencap" + (f" -d {display}" if display else "")
                raw = adb.exec_out(serial, cmd, timeout=12.0)

        frame = decode_raw_screencap(raw)
        h, w = frame.shape[:2]
        if (w, h) != (exp_w, exp_h) and display is None:
            # First capture on a multi-display MuMu might have hit landscape launcher.
            with self._lock:
                new_display, new_input = self._resolve_display_pair_locked(force=True)
            if new_display is not None:
                display, input_disp = new_display, new_input
                raw = adb.exec_out(serial, f"screencap -d {display}", timeout=12.0)
                frame = decode_raw_screencap(raw)
        return frame, input_disp

    def grab_adb(self) -> np.ndarray:
        """Capture a fresh frame over ADB socket screencap (with display auto-refresh)."""
        frame, _ = self.grab_adb_with_display()
        return frame

    def _try_mumu(self, timeout: float = 2.0) -> np.ndarray:
        with self._lock:
            if self._mumu is None:
                install_dir, idx = discover_mumu_target(
                    self._cfg["adb"]["serial"],
                    adb_exe=self._cfg["adb"].get("exe", ""),
                    install_dir=self._cfg["stream"].get("mumu_install_dir", ""),
                    index=self._cfg["stream"].get("mumu_index", -1),
                )
                self._mumu = MuMuStream(install_dir, idx)
            mumu = self._mumu
        try:
            return mumu.read(timeout=timeout)
        except Exception:
            with self._lock:
                self._close_mumu_locked()
            raise

    def read_frame(self, *, prefer_preview: bool = True) -> tuple[np.ndarray, str]:
        """Read one frame using configured backend (auto -> mumu -> adb)."""
        backend_pref = self._cfg["stream"]["backend"]
        now = time.monotonic()

        if prefer_preview and backend_pref in ("auto", "mumu") and now >= self._mumu_failed_until:
            try:
                frame = self._try_mumu()
                self._record_frame(frame, "mumu")
                return frame, "mumu"
            except Exception as exc:
                self.last_error = f"MuMu fallback: {exc}"
                self._mumu_failed_until = time.monotonic() + 10.0
                if backend_pref == "mumu":
                    self.active_backend = "none"
                    self.last_error = str(exc)
                    raise CaptureError(str(exc)) from exc

        try:
            frame = self.grab_adb()
        except Exception as exc:
            self.active_backend = "none"
            self.last_error = str(exc)
            raise
        self._record_frame(frame, "adb")
        return frame, "adb"

    def _record_frame(self, frame: np.ndarray, backend: str) -> None:
        self.active_backend = backend
        self.last_error = None
        self.last_frame = frame
        self.last_frame_at = time.monotonic()
        self.last_frame_size = (int(frame.shape[1]), int(frame.shape[0]))

    def latest_or_grab(self, max_age_sec: float = 1.2) -> tuple[np.ndarray, str]:
        """Reuse a fresh stream frame if available, otherwise capture now."""
        frame = self.last_frame
        if frame is not None and (time.monotonic() - self.last_frame_at) <= max_age_sec:
            return frame.copy(), self.active_backend
        return self.read_frame(prefer_preview=True)

    def effective_fps(self) -> float:
        requested = float(self._cfg["stream"]["fps"])
        if self.active_backend == "adb":
            return min(requested, 4.0)
        return requested
