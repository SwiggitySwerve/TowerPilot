"""Warm Windows WinRT OCR wrapper (hidden PowerShell 5.1, no console flashes)."""
from __future__ import annotations

import json
import os
import queue
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Iterable

import cv2
import numpy as np

WINOCR_PS1 = Path(__file__).resolve().parent / "winocr.ps1"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
ABOVE_NORMAL = getattr(subprocess, "ABOVE_NORMAL_PRIORITY_CLASS", 0)


def _decode(raw: bytes) -> str:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", "replace")


class WarmOCR:
    """One persistent hidden `winocr.ps1 -Serve` worker for low-latency OCR."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._proc: subprocess.Popen | None = None
        self._lines: queue.Queue[str | None] | None = None
        self._next_id = 0

    def _start(self) -> None:
        proc = subprocess.Popen(
            [
                "powershell.exe",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(WINOCR_PS1),
                "-Serve",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            creationflags=NO_WINDOW | ABOVE_NORMAL,
        )
        lines: queue.Queue[str | None] = queue.Queue()

        def drain() -> None:
            assert proc.stdout is not None
            for raw in iter(proc.stdout.readline, b""):
                lines.put(_decode(raw).rstrip("\r\n"))
            lines.put(None)

        threading.Thread(target=drain, name="winocr-warm", daemon=True).start()
        self._proc, self._lines = proc, lines

    def close(self) -> None:
        proc, self._proc, self._lines = self._proc, None, None
        if proc is None:
            return
        if proc.stdin is not None:
            try:
                proc.stdin.close()
            except OSError:
                pass
        try:
            proc.terminate()
            proc.wait(timeout=1.0)
        except Exception:
            try:
                proc.kill()
            except OSError:
                pass

    def recognize(self, entries: list[dict], deadline: float) -> list[str]:
        wait = max(0.0, deadline - time.monotonic())
        if not self._lock.acquire(timeout=wait):
            raise subprocess.TimeoutExpired("winocr-warm", 0)
        try:
            try:
                if self._proc is None or self._proc.poll() is not None:
                    self.close()
                    self._start()
                assert self._proc is not None and self._proc.stdin is not None and self._lines is not None
                self._next_id += 1
                req_id = str(self._next_id)
                payload = json.dumps({"id": req_id, "images": entries}) + "\n"
                self._proc.stdin.write(payload.encode("utf-8"))
                self._proc.stdin.flush()

                reply: list[str] = []
                begun = False
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        raise subprocess.TimeoutExpired("winocr-warm", 0)
                    try:
                        line = self._lines.get(timeout=remaining)
                    except queue.Empty:
                        raise subprocess.TimeoutExpired("winocr-warm", remaining) from None
                    if line is None:
                        raise subprocess.SubprocessError("winocr-warm exited")
                    if line == f"TP_OCR_BEGIN\t{req_id}" and not begun:
                        begun = True
                    elif line == f"TP_OCR_DONE\t{req_id}" and begun:
                        return reply
                    elif begun and not line.startswith(("TP_OCR_BEGIN", "TP_OCR_DONE", "TP_OCR_ERROR")):
                        reply.append(line)
                    else:
                        raise subprocess.SubprocessError(f"winocr-warm unexpected line: {line!r}")
            except BaseException:
                self.close()
                raise
        finally:
            self._lock.release()


_WARM = WarmOCR()


def _parse_batch_rows(lines: list[str], count: int) -> list[list[tuple[int, int, str]]]:
    rows: list[list[tuple[int, int, str]]] = [[] for _ in range(count)]
    active: int | None = None
    seen = 0
    for line in lines:
        if line.startswith("TP_OCR_IMAGE\t"):
            active = int(line.split("\t", 1)[1])
            if active != seen or active >= count:
                raise ValueError("Invalid OCR image index")
            seen += 1
            continue
        parts = line.split("\t", 2)
        if active is not None and len(parts) == 3:
            try:
                rows[active].append((int(parts[0]), int(parts[1]), parts[2].strip()))
            except ValueError:
                pass
    if seen != count:
        raise ValueError("Incomplete OCR batch response")
    for bucket in rows:
        bucket.sort()
    return rows


def read_lines(
    crops: Iterable[np.ndarray],
    *,
    scale: float = 2.0,
    timeout: float = 3.0,
) -> list[list[tuple[int, int, str]]]:
    """Recognize positioned OCR lines (y, x, text) for each BGR crop in one warm round-trip."""
    crop_list = list(crops)
    if not crop_list:
        return []
    deadline = time.monotonic() + timeout
    temp_paths: list[str] = []
    try:
        entries: list[dict] = []
        slot_map: list[int | None] = []
        for crop in crop_list:
            if crop is None or crop.size == 0:
                slot_map.append(None)
                continue
            img = crop
            if scale != 1.0:
                img = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
            fd, path = tempfile.mkstemp(prefix="tp_ocr_", suffix=".png")
            os.close(fd)
            temp_paths.append(path)
            if not cv2.imwrite(path, img):
                raise OSError("Failed to write temporary OCR crop")
            slot_map.append(len(entries))
            entries.append({"index": len(entries), "path": path})

        if not entries:
            return [[] for _ in crop_list]

        lines = _WARM.recognize(entries, deadline)
        parsed = _parse_batch_rows(lines, len(entries))
        inv = (1.0 / scale) if scale and scale != 1.0 else 1.0
        out: list[list[tuple[int, int, str]]] = []
        for slot in slot_map:
            if slot is None:
                out.append([])
            else:
                out.append(
                    [
                        (int(round(y * inv)), int(round(x * inv)), text)
                        for y, x, text in parsed[slot]
                        if text
                    ]
                )
        return out
    finally:
        for path in temp_paths:
            try:
                os.remove(path)
            except OSError:
                pass


def read_texts(
    crops: Iterable[np.ndarray],
    *,
    scale: float = 2.0,
    timeout: float = 3.0,
) -> list[str]:
    """Recognize text for each BGR crop in a single warm WinRT OCR round-trip."""
    batches = read_lines(crops, scale=scale, timeout=timeout)
    return [" ".join(text for _, _, text in rows).strip() for rows in batches]


def shutdown() -> None:
    _WARM.close()
