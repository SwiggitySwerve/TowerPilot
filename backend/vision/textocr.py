"""Read the player's own text off a crop with Windows' built-in OCR.

The names the game lets a player type - card preset tabs, preset picker
rows, category preset tabs - cannot ship with the code and cannot be matched
by template before their template exists. tools/winocr.ps1 drives the WinRT
OCR engine (Windows PowerShell 5.1, present on every Windows 10/11); this
wraps it for one crop at a time, always window-suppressed (a pythonw parent
would otherwise flash a console per call).

Module detail panels and the picker read cleanly at 2-3x; the only
ambiguity seen is l/1 in a label such as "Tourney P1" (2026-09-06), so
`read_text` runs several scales and keeps the majority reading.
"""
import base64
import json
import os
import re
import subprocess
import tempfile
import time
from collections import Counter
from pathlib import Path

import cv2

import settings

WINOCR = settings.ROOT / "tools" / "winocr.ps1"


def _decode(raw: bytes) -> str:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1252", "replace")


def read_lines(bgr, scale: float = 3.0, *, timeout: float = 120,
               raise_on_error: bool = False) -> list[tuple[int, int, str]]:
    """OCR one crop, upscaled by `scale`. Rows (y, x, text) in reading order;
    empty when the engine finds nothing or is unavailable.
    `raise_on_error` lets deadline-sensitive callers distinguish incomplete
    recognition from an empty reading; existing callers keep their behavior.
    """
    deadline = time.monotonic()+timeout if raise_on_error else None
    img = bgr
    if scale != 1.0:
        img = cv2.resize(bgr, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
    fd, path = tempfile.mkstemp(suffix=".png", prefix="tp_ocr_")
    os.close(fd)
    try:
        written = cv2.imwrite(path, img)
        if raise_on_error and not written:
            raise OSError('Windows OCR crop write failed')
        if deadline is not None:
            timeout = deadline-time.monotonic()
            if timeout <= 0:
                raise subprocess.TimeoutExpired('Windows OCR preparation', 0)
        p = settings.run_hidden(
            ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass",
             "-File", str(WINOCR), path],
            capture_output=True, timeout=timeout)
        if raise_on_error and (p.returncode != 0 or p.stderr.strip()):
            raise subprocess.CalledProcessError(p.returncode, p.args,
                                                output=p.stdout, stderr=p.stderr)
        rows = []
        for line in _decode(p.stdout).splitlines():
            parts = line.split("\t", 2)
            if len(parts) == 3:
                try:
                    rows.append((int(parts[0]), int(parts[1]), parts[2].strip()))
                except ValueError:
                    pass
        rows.sort()
        return rows
    except subprocess.TimeoutExpired:
        if raise_on_error:
            raise
        return []
    except (OSError, subprocess.SubprocessError):
        if raise_on_error:
            raise
        return []
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def read_text(bgr, scales=(2.0, 3.0, 4.0)) -> str:
    """The crop's text as one line: the majority reading across `scales`
    (ties go to the reading with the most digits, then the longest)."""
    readings = []
    for sc in scales:
        text = " ".join(t for _, _, t in read_lines(bgr, sc)).strip()
        if text:
            readings.append(" ".join(text.split()))
    return _majority_text(readings)


def _majority_text(readings):
    if not readings:
        return ""
    counts = Counter(readings)
    best = max(counts.items(), key=lambda kv: (kv[1], sum(c.isdigit() for c in kv[0]), len(kv[0])))
    return fix_l1(best[0])


def read_texts(crops, scales=(2.0, 3.0, 4.0), *, timeout=120,
               raise_on_error=False):
    """OCR independent crops/scales with one hidden PowerShell invocation.

    Every image is recognized separately by the same winocr.ps1 reader used
    by read_lines. This preserves crop context and wrapped text without OCR
    merging adjacent labels in a contact sheet. Only process startup is shared;
    each crop still votes across all requested scales exactly as read_text does.
    """
    crops, scales = list(crops), tuple(scales)
    if not crops:
        return []
    if not scales or any(scale <= 0 for scale in scales):
        raise ValueError('OCR scales must be positive')
    if any(crop is None or not crop.size for crop in crops):
        raise ValueError('Cannot batch an empty OCR crop')
    deadline = time.monotonic() + timeout if raise_on_error else None
    try:
        with tempfile.TemporaryDirectory(prefix='tp_ocr_batch_') as directory:
            entries = []
            for index, crop in enumerate(crops):
                for scale_index, scale in enumerate(scales):
                    image = crop if scale == 1.0 else cv2.resize(
                        crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
                    path = Path(directory) / f'{index}_{scale_index}.png'
                    if not cv2.imwrite(str(path), image):
                        raise OSError('Windows OCR crop write failed')
                    entries.append({'path': str(path), 'index': len(entries)})
            manifest = Path(directory) / 'images.json'
            manifest.write_text(json.dumps(entries), encoding='utf-8')
            # EncodedCommand keeps native paths out of shell interpolation.
            # PowerShell string literals escape only a single quote by doubling it.
            literal = lambda value: "'" + str(value).replace("'", "''") + "'"
            script = (
                "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; "
                f"$images = Get-Content -Raw -LiteralPath {literal(manifest)} | ConvertFrom-Json; "
                "foreach ($entry in $images) { "
                "Write-Output ('TP_OCR_IMAGE' + [char]9 + $entry.index); "
                f"& {literal(WINOCR)} $entry.path; "
                "}"
            )
            encoded = base64.b64encode(script.encode('utf-16le')).decode('ascii')
            remaining = timeout if deadline is None else deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired('Windows OCR preparation', 0)
            p = settings.run_hidden(
                ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass',
                 '-EncodedCommand', encoded], capture_output=True, timeout=remaining)
            if p.returncode != 0 or p.stderr.strip():
                raise subprocess.CalledProcessError(p.returncode, p.args,
                                                    output=p.stdout, stderr=p.stderr)
            rows = [[] for _ in entries]
            active = None
            markers = []
            for line in _decode(p.stdout).splitlines():
                if line.startswith('TP_OCR_IMAGE\t'):
                    active = int(line.split('\t', 1)[1])
                    if active != len(markers) or active >= len(rows):
                        raise ValueError('Windows OCR returned an invalid image index')
                    markers.append(active)
                    continue
                parts = line.split('\t', 2)
                if active is not None and len(parts) == 3:
                    rows[active].append((int(parts[0]), int(parts[1]), parts[2].strip()))
            if len(markers) != len(entries):
                raise ValueError('Windows OCR batch ended before all images were recognized')
            result = []
            for index in range(len(crops)):
                readings = []
                for scale_index in range(len(scales)):
                    text = ' '.join(text for _, _, text in sorted(rows[index * len(scales) + scale_index]))
                    text = ' '.join(text.split())
                    if text:
                        readings.append(text)
                result.append(_majority_text(readings))
            return result
    except (OSError, ValueError, subprocess.SubprocessError):
        if raise_on_error:
            raise
        return [''] * len(crops)


def fix_l1(text: str) -> str:
    """'Tourney Pl' -> 'Tourney P1': a two-character token of a capital and
    an l/I is the engine's reading of a capital followed by the digit one
    (seen 2026-09-06); no real preset name is spelt that way."""
    return re.sub(r"\b([A-Z])[lI]\b", r"\g<1>1", text)


def available() -> bool:
    return Path(WINOCR).exists() and os.name == "nt"
