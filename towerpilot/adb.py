"""Socket-only ADB client, MuMu display discovery, and foreground window checks.

Every device command talks directly to the ADB server socket on 127.0.0.1:5037.
Never spawns adb.exe per command (avoids console flashes and Windows socket
buffer exhaustion during long runs).
"""
from __future__ import annotations

import re
import socket
import subprocess
import time
from pathlib import Path

HOST = ("127.0.0.1", 5037)
DEFAULT_TIMEOUT = 15.0
GAME_PKG = "com.TechTreeGames.TheTower"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_DEFAULT_ADB_PATHS = (
    Path(r"C:\Program Files\Netease\MuMuPlayer\nx_main\adb.exe"),
    Path(r"C:\Program Files\Netease\MuMuPlayerGlobal-12.0\shell\adb.exe"),
    Path(r"C:\Program Files\Netease\MuMu Player 12\shell\adb.exe"),
)

_OFFLINE_STALE_S = 30.0
_offline_since: dict[tuple[tuple[str, int], str], float] = {}


class AdbError(RuntimeError):
    """Error returned by the ADB server protocol."""


def _send(sock: socket.socket, payload: str) -> None:
    msg = payload.encode("utf-8")
    sock.sendall(b"%04x" % len(msg) + msg)


def _recv_exact(sock: socket.socket, count: int) -> bytes:
    out = bytearray()
    while len(out) < count:
        chunk = sock.recv(count - len(out))
        if not chunk:
            raise AdbError(f"ADB connection closed after {len(out)}/{count} bytes")
        out.extend(chunk)
    return bytes(out)


def _status(sock: socket.socket, what: str) -> None:
    resp = _recv_exact(sock, 4)
    if resp == b"OKAY":
        return
    if resp == b"FAIL":
        size = int(_recv_exact(sock, 4), 16)
        reason = _recv_exact(sock, size).decode("utf-8", errors="replace")
        raise AdbError(f"{what}: {reason}")
    raise AdbError(f"{what}: unexpected status {resp!r}")


def _host_reply(payload: str, what: str, timeout: float = 10.0) -> str:
    with socket.create_connection(HOST, timeout=timeout) as sock:
        sock.settimeout(timeout)
        _send(sock, payload)
        _status(sock, what)
        size = int(_recv_exact(sock, 4), 16)
        return _recv_exact(sock, size).decode("utf-8", errors="replace")


def exec_out(serial: str, command: str, timeout: float = DEFAULT_TIMEOUT) -> bytes:
    """Run a binary-safe command on `serial` via the ADB server socket."""
    if not serial:
        raise ConnectionError("No ADB serial configured")
    with socket.create_connection(HOST, timeout=timeout) as sock:
        sock.settimeout(timeout)
        _send(sock, f"host:transport:{serial}")
        _status(sock, "transport")
        _send(sock, f"exec:{command}")
        _status(sock, "exec")
        _offline_since.pop((HOST, serial), None)
        chunks: list[bytes] = []
        while True:
            chunk = sock.recv(1 << 20)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)


def shell(serial: str, command: str, timeout: float = DEFAULT_TIMEOUT) -> bytes:
    """Run a shell command on `serial` over the ADB server socket."""
    return exec_out(serial, command, timeout=timeout)


def alive(serial: str, timeout: float = 4.0) -> bool:
    try:
        exec_out(serial, "true", timeout=timeout)
        return True
    except (OSError, AdbError):
        return False


def devices(timeout: float = 4.0) -> list[str]:
    reply = _host_reply("host:devices", "devices", timeout=timeout)
    return [line.split("\t")[0] for line in reply.splitlines() if line.endswith("\tdevice")]


def get_state(serial: str, timeout: float = 2.0) -> str:
    if not serial:
        return "unconfigured"
    try:
        with socket.create_connection(HOST, timeout=timeout) as sock:
            sock.settimeout(timeout)
            _send(sock, f"host-serial:{serial}:get-state")
            _status(sock, "get-state")
            size = int(_recv_exact(sock, 4), 16)
            state = _recv_exact(sock, size).decode("utf-8", errors="replace").strip() or "unknown"
    except AdbError as exc:
        why = str(exc).lower()
        state = "unknown"
        for needle, mapped in (("not found", "missing"), ("offline", "offline"), ("unauthorized", "unauthorized")):
            if needle in why:
                state = mapped
                break
    except OSError:
        state = "no_server"

    key = (HOST, serial)
    if state == "offline":
        _offline_since.setdefault(key, time.monotonic())
    elif state in ("device", "missing", "no_server"):
        _offline_since.pop(key, None)
    return state


def reconnect(serial: str) -> bool:
    try:
        return "connected" in _host_reply(f"host:connect:{serial}", "connect").lower()
    except (OSError, AdbError):
        return False


def disconnect(serial: str) -> bool:
    try:
        _host_reply(f"host:disconnect:{serial}", "disconnect")
        return True
    except (OSError, AdbError):
        return False


def _server_refuses(timeout: float = 3.0) -> bool:
    """True only when TCP connect to the ADB server is actively refused (nothing listening)."""
    try:
        socket.create_connection(HOST, timeout=timeout).close()
    except ConnectionRefusedError:
        return True
    except OSError:
        return False
    return False


def _resolve_adb_exe(adb_exe: str = "") -> Path | None:
    if adb_exe:
        path = Path(adb_exe).expanduser()
        if path.is_file():
            return path
    for candidate in _DEFAULT_ADB_PATHS:
        if candidate.is_file():
            return candidate
    return None


def start_server(adb_exe: str = "", timeout: float = 10.0) -> bool:
    """Sanctioned one-time hidden `adb start-server` when no daemon listens on 5037."""
    exe = _resolve_adb_exe(adb_exe)
    if exe is None:
        return False
    try:
        proc = subprocess.run(
            [str(exe), "start-server"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
            creationflags=NO_WINDOW,
        )
        return proc.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def recover(serial: str, *, adb_exe: str = "", attempts: int = 2, settle: float = 1.5) -> str:
    """Reconnect a dropped TCP emulator serial without killing the ADB server."""
    state = get_state(serial)
    if state == "no_server" and _server_refuses():
        if start_server(adb_exe):
            state = get_state(serial)
    if ":" not in serial:
        return state
    key = (HOST, serial)
    for _ in range(attempts):
        if state == "offline":
            now = time.monotonic()
            if now - _offline_since.get(key, now) >= _OFFLINE_STALE_S:
                disconnect(serial)
                _offline_since.pop(key, None)
        elif state != "missing":
            return state
        if reconnect(serial):
            deadline = time.monotonic() + settle
            state = get_state(serial)
            while state != "device" and time.monotonic() < deadline:
                time.sleep(0.2)
                state = get_state(serial)
        else:
            state = get_state(serial)
    return state


# --- Multi-display helpers (MuMu secondary mumuscreen) -------------------

def parse_screens(surfaceflinger_text: str) -> list[tuple[str, int, str]]:
    """Return (physical_id, port, display_name) for each mumuscreen."""
    return [
        (did, int(port), name)
        for did, port, name in re.findall(
            r'Display (\d+) .*?port=(\d+).*?displayName="(mumuscreen\d+)"',
            surfaceflinger_text,
        )
    ]


def secondary_display(screens: list[tuple[str, int, str]]) -> str | None:
    for did, port, _name in screens:
        if port != 0:
            return did
    return None


def logical_display(dumpsys_display_text: str, physical_id: str) -> int | None:
    match = re.search(
        r"mDisplayId=(\d+)\s*\n\s*mPrimaryDisplayDevice=[^\n(]*\(local:" + re.escape(physical_id) + r"\)",
        dumpsys_display_text,
    )
    return int(match.group(1)) if match else None


def resolve_game_display(serial: str, timeout: float = 8.0) -> tuple[str | None, int | None]:
    """Return (physical_display_id, logical_input_display) for MuMu, or (None, None)."""
    sf = shell(serial, "dumpsys SurfaceFlinger --display-id", timeout=timeout).decode("utf-8", errors="replace")
    screens = parse_screens(sf)
    physical = secondary_display(screens)
    if physical is None:
        return None, None
    dd = shell(serial, "dumpsys display", timeout=timeout).decode("utf-8", errors="replace")
    return physical, logical_display(dd, physical)


# --- Foreground window evidence ------------------------------------------

_SYSTEM_DECOR_PREFIXES = ("StatusBar", "ScreenDecorOverlay", "DockedStackDivider")


def visible_windows(
    serial: str,
    timeout: float = 5.0,
    *,
    display_id: int | None = None,
) -> list[str]:
    """Return front-to-back visible window titles from `dumpsys window windows`.

    When `display_id` is given, only windows on that logical Android display are
    included; missing display metadata fails closed.
    """
    out = shell(serial, "dumpsys window windows", timeout=timeout).decode("utf-8", errors="replace")
    entries = list(re.finditer(r"Window #\d+ Window\{[0-9a-f]+ u\d+ ([^}]+)\}", out))
    visible: list[str] = []
    for idx, entry in enumerate(entries):
        title = entry.group(1)
        end = entries[idx + 1].start() if idx + 1 < len(entries) else len(out)
        block = out[entry.end():end]
        if display_id is not None:
            disp_match = re.search(r"\b(?:mDisplayId|displayId)=(\d+)\b", block)
            if disp_match is None:
                raise ValueError(f"window display id unavailable for {title}")
            if int(disp_match.group(1)) != display_id:
                continue
        flags = re.findall(r"\bis(?:OnScreen|Visible)(?:\(\))?=(true|false)\b", block)
        if not flags:
            raise ValueError(f"window visibility unavailable for {title}")
        if "true" in flags:
            visible.append(title)
    return visible


def foreground_blocker(wins: list[str], game_pkg: str = GAME_PKG) -> str | None:
    """Return None if `game_pkg` is unobstructed in front, else a short reason string."""
    if not wins:
        return "no_windows"
    if not any(w.startswith(game_pkg) for w in wins):
        return "game_not_on_screen"
    for win in wins:
        if win.startswith(game_pkg):
            return None
        if not win.startswith(_SYSTEM_DECOR_PREFIXES):
            return "covered_by:" + win.split("/")[0]
    return "game_not_on_screen"
