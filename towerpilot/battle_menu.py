"""In-battle Side Menu routine controller & Battle History persistent store.

Safely opens the live battle side menu (`REF_SIDE_MENU_TOGGLE`) to execute
read-only observations and zero-spend free reward claims without ever ending
or disrupting a live battle:
- `history`:       View Battle History -> scrape authoritative Coins, Coins/hr,
                   Cells, Wave, Tier, Date, and exact real duration -> merge into
                   `data/battle_history.json` to reconcile the Run Ledger.
- `cards`:         View Cards -> scan owned/equipped cards into AccountStore.
- `modules`:       View Modules -> scan equipped/owned modules into AccountStore.
- `daily_quests`:  View Daily Missions -> claim completed free quests (excluding
                   5-gem reroll icons) and unlocked Weekly Challenge reward chests.
- `guild_rewards`: View Guild -> claim unlocked free Guild contribution chests
                   (100 / 250 / 500 / 750), strictly excluding Store and Leave.

Safety invariants (CLAUDE.md Rules 2 & 3):
- Runs 1 step per collector tick (0 extra threads) with fresh ADB + foreground
  checks before every tap/swipe.
- Every dismiss/return tap verifies the frame is an unobstructed overlay with
  zero promo/purchase/denylisted text; return-to-game taps require fresh OCR
  reading `RETURN TO GAME` inside the bottom bar.
- Every tap passes a point-level forbidden-zone check (Store, EXIT BATTLE,
  Guild Leave, Guild Store).
- Daily/Guild claims are verified on the subsequent frame before incrementing
  claim counters or logging claimed events.
"""
from __future__ import annotations

import copy
import json
import os
import re
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Callable

import cv2
import numpy as np

from towerpilot import detectors, loadouts, ocr, run_rules, screens
from towerpilot.config import ROOT

DEFAULT_HISTORY_PATH = ROOT / "data" / "battle_history.json"

# Pixel-verified 1080x2560 Battle Side Menu icon rects (x, y, w, h)
REF_MENU_DAILY = (864, 124, 92, 92)
REF_MENU_CARDS = (864, 229, 92, 92)
REF_MENU_MODULES = (969, 334, 92, 92)
REF_MENU_HISTORY = (864, 544, 92, 92)
REF_MENU_GUILD = (969, 544, 92, 92)
REF_MENU_CLOSE = (969, 19, 92, 92)

# Bottom "Tap To Return To Game" bar shared across in-battle menu overlays
REF_RETURN_BAR = (170, 2390, 740, 120)
REF_OVERLAY_HEADER = (0, 80, 820, 140)
REF_REWARD_DISMISS_PT = (540, 2220)

# Strictly forbidden rects (Store, Exit Battle, Guild Leave, Guild Store tab)
REF_FORBIDDEN_STORE = (850, 0, 114, 120)
REF_FORBIDDEN_EXIT = (850, 640, 230, 110)
REF_FORBIDDEN_GUILD_LEAVE = (840, 440, 240, 100)
REF_FORBIDDEN_GUILD_STORE = (620, 235, 330, 105)

VALID_TASKS = ("history", "cards", "modules", "daily_quests", "guild_rewards")

_STEP_DELAY_SEC = 1.0
_MAX_FAILURES = 4
_MAX_SCROLL_PAGES = 3
_MAX_CLAIMS_PER_RUN = 10
_MAX_RETURN_ATTEMPTS = 4

_TASK_ICON_RECTS: dict[str, tuple[int, int, int, int]] = {
    "history": REF_MENU_HISTORY,
    "cards": REF_MENU_CARDS,
    "modules": REF_MENU_MODULES,
    "daily_quests": REF_MENU_DAILY,
    "guild_rewards": REF_MENU_GUILD,
}

_TASK_LABELS: dict[str, str] = {
    "history": "Battle History",
    "cards": "Cards",
    "modules": "Modules",
    "daily_quests": "Daily Quests",
    "guild_rewards": "Guild Rewards",
}

# Pixel-verified 1080px horizontal chest centers on Guild screen (measured from live_guild.png)
_GUILD_CHEST_X_BY_THRESHOLD: dict[int, int] = {
    100: 181,
    250: 375,
    500: 695,
    750: 1015,
}

_DATE_RE = re.compile(r"\b(\d{1,2}/\d{1,2}/\d{2,4})\b")
_TIER_RE = re.compile(r"\bTier\s*[:#-]?\s*([0-9IliOo]{1,2})\s*(\+)?", re.IGNORECASE)
_WAVE_RE = re.compile(r"\bWave\s*[:#-]?\s*([\d,]{1,7})\b", re.IGNORECASE)
_COINS_RE = re.compile(r"\bCoins\s*:\s*([\d,.Oo]+\s*[kKmMbBtTqQsSoOnNdD]?)", re.IGNORECASE)
_CPH_RE = re.compile(r"Coins\s*/\s*Hour\s*:\s*([\d,.Oo]+\s*[kKmMbBtTqQsSoOnNdD]?)", re.IGNORECASE)
_CELLS_RE = re.compile(r"\bCells\s*:\s*([\d,.Oo]+\s*[kKmMbBtTqQsSoOnNdD]?)", re.IGNORECASE)
_COMPLETED_RE = re.compile(r"completed\s*(\d{1,2})\s*/\s*(\d{1,2})", re.IGNORECASE)
_CONTRIB_RE = re.compile(r"Total\s+Contribution\s*[:#-]?\s*([\d,]+)", re.IGNORECASE)

_DANGER_OVERLAY_RE = re.compile(
    r"(\$\s*\d|\bBUY\b|\bSPECIAL\s+OFFER\b|\bLIMITED\s+OFFER\b|\bEVENT\s+BOOST\b|"
    r"\bGET\s+ANOTHER\s+TICKET\b|\bSHATTER\b|\bMERGE\b|\bSURRENDER\b|\bEXIT\s+BATTLE\b|"
    r"\bEND\s+ROUND\b|\bREROLL\b|\bLEAVE\s+GUILD\b|\bGAME\s+STATS\b)",
    re.IGNORECASE,
)


def _clean_amount(raw: str | None) -> str | None:
    if not raw:
        return None
    s = raw.strip().replace(",", "").replace(" ", "")
    if s in ("O", "o"):
        return "0"
    return s


def _pt_in_rect(pt: tuple[int, int], rect: tuple[int, int, int, int]) -> bool:
    x, y, w, h = rect
    return x <= pt[0] <= x + w and y <= pt[1] <= y + h


def _green_checkmark_ratio(crop: np.ndarray) -> float:
    """Fraction of bright green pixels (the claimed checkmark icon) inside a chest box."""
    if crop is None or crop.size == 0:
        return 0.0
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    green = cv2.inRange(hsv, (40, 100, 120), (88, 255, 255))
    return float(np.count_nonzero(green)) / float(crop.shape[0] * crop.shape[1])


def _white_lock_ratio(crop: np.ndarray) -> float:
    """Detect the bright white padlock icon centered inside a locked chest box."""
    if crop is None or crop.size == 0:
        return 0.0
    h, w = crop.shape[:2]
    inner = crop[int(h * 0.28) : int(h * 0.78), int(w * 0.28) : int(w * 0.72)]
    if inner.size == 0:
        return 0.0
    hsv = cv2.cvtColor(inner, cv2.COLOR_BGR2HSV)
    white = cv2.inRange(hsv, (0, 0, 215), (180, 45, 255))
    return float(np.count_nonzero(white)) / float(inner.shape[0] * inner.shape[1])


def _date_sort_key(date_str: str | None) -> tuple[int, int, int]:
    if not date_str:
        return (0, 0, 0)
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})$", date_str.strip())
    if not m:
        return (0, 0, 0)
    mo, dy, yr = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if yr < 100:
        yr += 2000
    return (yr, mo, dy)


def _has_dangerous_overlay_text(text: str) -> bool:
    if not text:
        return False
    return bool(_DANGER_OVERLAY_RE.search(text))


def history_entry_key(entry: dict[str, Any]) -> tuple[Any, ...]:
    """Stable deduplication key for a Battle History row."""
    return (
        str(entry.get("date") or ""),
        entry.get("tier"),
        bool(entry.get("tournament", False)),
        entry.get("wave"),
        str(entry.get("total_coins_raw") or entry.get("coins_raw") or ""),
    )


def parse_battle_history_page(
    lines: list[tuple[int, int, str]],
    *,
    frame_height: int = detectors.REF_H,
) -> list[dict[str, Any]]:
    """Parse OCR lines `(y, x, text)` from a BATTLE HISTORY screen into run records.

    Skips partially clipped bottom cards whose metrics row (`Coins:` / `Coins/Hour:`)
    is missing so incomplete rows never pollute deduplication or ledger reconciliation.
    """
    if not lines:
        return []
    sy = frame_height / float(detectors.REF_H)
    row_band = max(45, int(round(135 * sy)))
    min_y = int(round(230 * sy))
    max_y = int(round(2390 * sy))

    body = [(y, x, t.strip()) for y, x, t in lines if min_y <= y <= max_y and t and t.strip()]
    body.sort(key=lambda it: (it[0], it[1]))

    anchors: list[int] = []
    for y, _x, text in body:
        if _TIER_RE.search(text) or _WAVE_RE.search(text):
            if not anchors or (y - anchors[-1]) > int(round(90 * sy)):
                anchors.append(y)

    entries: list[dict[str, Any]] = []
    for idx, ay in enumerate(anchors):
        next_ay = anchors[idx + 1] if idx + 1 < len(anchors) else max_y
        lo_y = ay - int(round(36 * sy))
        hi_y = min(ay + row_band, next_ay - int(round(30 * sy)))
        card_lines = [t for y, _x, t in body if lo_y <= y <= hi_y]
        joined = " ".join(card_lines)

        m_tier = _TIER_RE.search(joined)
        m_wave = _WAVE_RE.search(joined)
        if not m_tier or not m_wave:
            continue

        m_coins = _COINS_RE.search(joined)
        m_cph = _CPH_RE.search(joined)
        # Skip clipped bottom cards that are missing their Coins metrics line
        if not m_coins and not m_cph:
            continue

        tier_digits = m_tier.group(1).translate(str.maketrans("IliOo", "11100"))
        if not tier_digits.isdigit():
            continue
        tier = int(tier_digits)
        tournament = bool(m_tier.group(2))
        wave = int(m_wave.group(1).replace(",", ""))
        m_date = _DATE_RE.search(joined)
        date_str = m_date.group(1) if m_date else None

        m_cells = _CELLS_RE.search(joined)

        coins_raw = _clean_amount(m_coins.group(1)) if m_coins else None
        cph_raw = _clean_amount(m_cph.group(1)) if m_cph else None
        cells_raw = _clean_amount(m_cells.group(1)) if m_cells else None

        coins_val = run_rules.parse_coins(coins_raw)
        cph_val = run_rules.parse_coins(cph_raw)
        cells_val = run_rules.parse_coins(cells_raw)
        if coins_val is None and cph_val is None:
            continue

        duration_sec: float | None = None
        if coins_val is not None and coins_val > 0 and cph_val is not None and cph_val > 0:
            dur = (coins_val / cph_val) * 3600.0
            if 10.0 <= dur <= 72.0 * 3600.0:
                duration_sec = round(dur, 1)

        entries.append(
            {
                "source": "battle_history",
                "date": date_str,
                "tier": tier,
                "tournament": tournament,
                "wave": wave,
                "total_coins_raw": coins_raw,
                "total_coins": coins_val,
                "coins_verified": coins_val is not None,
                "coins_per_hour": cph_val,
                "coins_per_hour_fmt": cph_raw or (run_rules.format_coins(cph_val) if cph_val else None),
                "cells_raw": cells_raw,
                "cells": cells_val,
                "duration_sec": duration_sec,
                "duration_exact": duration_sec is not None,
                "profile": "Tournament" if tournament else "",
            }
        )
    return entries


def _estimate_token_center_x(
    lx: int,
    text: str,
    match_start: int,
    match_end: int,
    *,
    frame_width: int,
    sx: float,
    char_px: float = 20.0,
) -> int:
    """Estimate horizontal center of a token inside a potentially merged OCR line."""
    mid_char = (match_start + match_end) * 0.5
    est = int(round(lx + mid_char * char_px * sx))
    return max(int(round(60 * sx)), min(frame_width - int(round(60 * sx)), est))


def _find_green_claim_buttons(
    frame: np.ndarray,
    *,
    ocr_fn: Callable[[list[np.ndarray]], list[str]] | None = None,
) -> list[tuple[int, int, int, int]]:
    """Locate bright green CLAIM buttons inside Daily Mission cards via HSV contour + tight crop OCR."""
    h, w = frame.shape[:2]
    sx, sy = w / float(detectors.REF_W), h / float(detectors.REF_H)
    bx, by = int(round(40 * sx)), int(round(560 * sy))
    bw, bh = int(round(820 * sx)), int(round(1720 * sy))
    band = frame[by : by + bh, bx : bx + bw]
    if band.size == 0 or int(band.max()) < 40:
        return []

    hsv = cv2.cvtColor(band, cv2.COLOR_BGR2HSV)
    green = cv2.inRange(hsv, (40, 80, 120), (92, 255, 255))
    cnts, _ = cv2.findContours(green, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    min_w, max_w = int(round(140 * sx)), int(round(780 * sx))
    min_h, max_h = int(round(44 * sy)), int(round(140 * sy))

    candidates: list[tuple[int, int, int, int]] = []
    for c in cnts:
        x, y, cw, ch = cv2.boundingRect(c)
        if min_w <= cw <= max_w and min_h <= ch <= max_h:
            candidates.append((bx + x, by + y, cw, ch))
    if not candidates:
        return []
    candidates.sort(key=lambda r: (r[1], r[0]))
    crops = [frame[y : y + ch, x : x + cw] for x, y, cw, ch in candidates]
    reader = ocr_fn if ocr_fn is not None else (lambda items: ocr.read_texts(items, scale=2.0, timeout=2.0))
    try:
        texts = reader(crops)
    except Exception:
        return []
    hits: list[tuple[int, int, int, int]] = []
    for rect, raw in zip(candidates, texts):
        up = " ".join((raw or "").upper().split())
        if re.search(r"\bCLAIM\b", up) and not _has_dangerous_overlay_text(up) and "GEM" not in up:
            hits.append(rect)
    return hits


def detect_daily_missions_claimables(
    frame: np.ndarray,
    lines: list[tuple[int, int, str]],
    *,
    button_ocr_fn: Callable[[list[np.ndarray]], list[str]] | None = None,
) -> dict[str, Any]:
    """Identify safe, zero-spend claim targets on a verified DAILY MISSIONS screen.

    Uses HSV green-button contour + tight crop OCR first (never mis-aims on merged text),
    with a strict token-offset fallback when a standalone `CLAIM` line is detected
    inside `x < 860` (far from the x~1030 5-gem reroll button).
    """
    h, w = frame.shape[:2]
    sx, sy = w / float(detectors.REF_W), h / float(detectors.REF_H)

    completed: int | None = None
    goal: int | None = None
    for _y, _x, text in lines:
        m = _COMPLETED_RE.search(text)
        if m:
            completed = int(m.group(1))
            goal = int(m.group(2))
            break

    # 1. Mission card CLAIM buttons: HSV green contour + tight crop OCR preferred
    mission_claims = _find_green_claim_buttons(frame, ocr_fn=button_ocr_fn)
    if not mission_claims:
        min_card_y = int(round(560 * sy))
        max_card_y = int(round(2280 * sy))
        max_safe_x = int(round(860 * sx))
        for ly, lx, text in lines:
            if not (min_card_y <= ly <= max_card_y and lx <= max_safe_x):
                continue
            up = " ".join(text.upper().split())
            if _has_dangerous_overlay_text(up) or "GEM" in up:
                continue
            m_claim = re.search(r"\bCLAIM\b", up)
            if not m_claim:
                continue
            # Aim at the CLAIM token position (never at a merged description prefix)
            cx = _estimate_token_center_x(lx, up, m_claim.start(), m_claim.end(), frame_width=w, sx=sx, char_px=18.0)
            rw = int(round(200 * sx))
            rh = int(round(70 * sy))
            cx = min(max_safe_x - rw // 2, max(int(round(120 * sx)), cx))
            cy = ly + int(round(14 * sy))
            mission_claims.append((cx - rw // 2, cy - rh // 2, rw, rh))

    # 2. Weekly Challenge milestone chests (numbers 5..35 along y ~ 390..500)
    chest_claims: list[tuple[int, tuple[int, int, int, int]]] = []
    if completed is not None and completed >= 5:
        num_y_lo, num_y_hi = int(round(390 * sy)), int(round(500 * sy))
        chest_w = int(round(120 * sx))
        chest_h = int(round(120 * sy))
        seen_milestones: set[int] = set()
        # Collect (ms, ly, cx) for every visible milestone token; spread merged lines across 5 fixed slots
        raw_hits: list[tuple[int, int, int]] = []
        for ly, lx, text in lines:
            if not (num_y_lo <= ly <= num_y_hi):
                continue
            matches = list(re.finditer(r"\b(5|10|15|20|25|30|35)\b", text))
            if len(matches) == 1:
                m = matches[0]
                cx = max(chest_w // 2, min(w - chest_w // 2, lx + int(round(22 * sx))))
                raw_hits.append((int(m.group(1)), ly, cx))
            elif len(matches) > 1:
                # Merged OCR line (e.g. "15 20 25 30 35"): map each match proportionally across chest pitch (~185px)
                step_x = int(round(185 * sx))
                base_x = max(chest_w // 2, lx + int(round(22 * sx)))
                for idx, m in enumerate(matches):
                    cx = min(w - chest_w // 2, base_x + idx * step_x)
                    raw_hits.append((int(m.group(1)), ly, cx))

        for ms, ly, cx in raw_hits:
            if ms > completed or ms in seen_milestones:
                continue
            seen_milestones.add(ms)
            cy = max(chest_h // 2, ly - int(round(78 * sy)))
            rect = (cx - chest_w // 2, cy - chest_h // 2, chest_w, chest_h)
            crop = frame[rect[1] : rect[1] + rect[3], rect[0] : rect[0] + rect[2]]
            if _green_checkmark_ratio(crop) >= 0.035:
                continue
            if _white_lock_ratio(crop) >= 0.14:
                continue
            chest_claims.append((ms, rect))

    return {
        "completed": completed,
        "goal": goal,
        "mission_claims": mission_claims,
        "chest_claims": chest_claims,
    }


def detect_guild_claimables(
    frame: np.ndarray,
    lines: list[tuple[int, int, str]],
) -> dict[str, Any]:
    """Identify unlocked, unclaimed weekly Guild contribution chests (100/250/500/750).

    Maps each threshold to its verified horizontal chest slot (immune to merged OCR lines)
    and strictly excludes the Guild `Leave` button and `Store` tab.
    """
    h, w = frame.shape[:2]
    sx, sy = w / float(detectors.REF_W), h / float(detectors.REF_H)

    total_contribution: int | None = None
    for _y, _x, text in lines:
        m = _CONTRIB_RE.search(text)
        if m:
            total_contribution = int(m.group(1).replace(",", ""))
            break

    forbidden_leave = detectors.scale_rect(REF_FORBIDDEN_GUILD_LEAVE, frame.shape)
    forbidden_store = detectors.scale_rect(REF_FORBIDDEN_GUILD_STORE, frame.shape)
    chest_claims: list[tuple[int, tuple[int, int, int, int]]] = []
    if total_contribution is not None and total_contribution >= 100:
        num_y_lo, num_y_hi = int(round(710 * sy)), int(round(820 * sy))
        chest_w = int(round(105 * sx))
        chest_h = int(round(98 * sy))
        seen_thresholds: set[int] = set()
        for ly, lx, text in lines:
            if not (num_y_lo <= ly <= num_y_hi):
                continue
            matches = list(re.finditer(r"\b(100|250|500|750)\b", text))
            for m in matches:
                thr = int(m.group(1))
                if thr > total_contribution or thr in seen_thresholds:
                    continue
                seen_thresholds.add(thr)
                # Every matched threshold (100/250/500/750) has a verified horizontal slot
                cx = int(round(_GUILD_CHEST_X_BY_THRESHOLD[thr] * sx))
                cx = max(chest_w // 2, min(w - chest_w // 2, cx))
                cy = max(int(round(650 * sy)), ly - int(round(49 * sy)))
                rect = (cx - chest_w // 2, cy - chest_h // 2, chest_w, chest_h)
                center = (rect[0] + rect[2] // 2, rect[1] + rect[3] // 2)
                if _pt_in_rect(center, forbidden_leave) or _pt_in_rect(center, forbidden_store):
                    continue
                crop = frame[rect[1] : rect[1] + rect[3], rect[0] : rect[0] + rect[2]]
                if _green_checkmark_ratio(crop) >= 0.035:
                    continue
                chest_claims.append((thr, rect))

    return {
        "total_contribution": total_contribution,
        "chest_claims": chest_claims,
    }


class BattleHistoryStore:
    """Thread-safe atomic JSON store for authoritative in-game Battle History runs."""

    def __init__(self, path: Path = DEFAULT_HISTORY_PATH) -> None:
        self._path = path
        self._lock = threading.RLock()

    @staticmethod
    def _empty() -> dict[str, Any]:
        return {"version": 1, "synced_at": None, "runs": []}

    def _read_unlocked(self) -> dict[str, Any]:
        if not self._path.is_file():
            return self._empty()
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except Exception:
            return self._empty()
        if not isinstance(raw, dict):
            return self._empty()
        runs = raw.get("runs")
        return {
            "version": 1,
            "synced_at": raw.get("synced_at"),
            "runs": list(runs) if isinstance(runs, list) else [],
        }

    def _write_unlocked(self, data: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(data, indent=2, sort_keys=False)
        fd, tmp = tempfile.mkstemp(prefix=".history_", suffix=".tmp", dir=str(self._path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(payload)
            os.replace(tmp, self._path)
        except BaseException:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return copy.deepcopy(self._read_unlocked())

    def merge_runs(self, new_runs: list[dict[str, Any]], *, synced_at: float | None = None) -> dict[str, int]:
        """Merge newly scraped Battle History entries, preserving newest-first order."""
        with self._lock:
            data = self._read_unlocked()
            existing: list[dict[str, Any]] = data["runs"]
            by_key: dict[tuple[Any, ...], dict[str, Any]] = {
                history_entry_key(r): dict(r) for r in existing
            }
            ordered_keys: list[tuple[Any, ...]] = []
            added = 0
            updated = 0

            for item in new_runs:
                if not isinstance(item, dict):
                    continue
                if item.get("total_coins") is None and item.get("coins_per_hour") is None:
                    continue
                k = history_entry_key(item)
                if k not in by_key:
                    added += 1
                    by_key[k] = dict(item)
                else:
                    merged = dict(by_key[k])
                    changed = False
                    for fld, val in item.items():
                        if val is not None and merged.get(fld) != val:
                            merged[fld] = val
                            changed = True
                    if changed:
                        updated += 1
                    by_key[k] = merged
                if k not in ordered_keys:
                    ordered_keys.append(k)

            for r in existing:
                k = history_entry_key(r)
                if k not in ordered_keys:
                    ordered_keys.append(k)

            merged_list = [by_key[k] for k in ordered_keys]
            merged_list.sort(key=lambda r: _date_sort_key(r.get("date")), reverse=True)
            data["runs"] = merged_list[:100]
            data["synced_at"] = round(synced_at if synced_at is not None else time.time(), 3)
            self._write_unlocked(data)
            return {"added": added, "updated": updated, "total": len(data["runs"])}


class BattleMenuRoutine:
    """Single-step-per-tick controller for safe in-battle Side Menu routines."""

    def __init__(
        self,
        *,
        grab_verified_frame: Callable[[], tuple[np.ndarray, int | None]],
        check_foreground: Callable[[int | None], tuple[bool, str]],
        tap: Callable[..., dict[str, Any] | None],
        swipe: Callable[..., dict[str, Any] | None],
        log: Callable[..., Any],
        history_store: BattleHistoryStore,
        account_store: loadouts.AccountStore,
        notify: Callable[[str], None] | None = None,
        stop_event: threading.Event | None = None,
        step_delay_sec: float = _STEP_DELAY_SEC,
        lines_fn: Callable[[list[np.ndarray]], list[list[tuple[int, int, str]]]] | None = None,
        button_ocr_fn: Callable[[list[np.ndarray]], list[str]] | None = None,
    ) -> None:
        self._grab = grab_verified_frame
        self._check_fg = check_foreground
        self._tap = tap
        self._swipe = swipe
        self._log = log
        self._history_store = history_store
        self._account_store = account_store
        self._notify = notify
        self._stop_event = stop_event or threading.Event()
        self._step_delay_sec = step_delay_sec
        self._lines_fn = lines_fn
        self._button_ocr_fn = button_ocr_fn

        self._lock = threading.RLock()
        self.active: bool = False
        self.task: str | None = None
        self.phase: str = "idle"
        self.detail: str = ""
        self.error: str | None = None
        self.last_result: dict[str, Any] | None = None
        self.last_completed_at: dict[str, float] = {}
        self._next_step_at: float = 0.0
        self._failures: int = 0
        self._return_attempts: int = 0
        self._page: int = 0
        self._claims_done: int = 0
        self._claim_attempts: int = 0
        self._pending_claim: dict[str, Any] | None = None
        self._accumulated_runs: list[dict[str, Any]] = []
        self._seen_keys: set[tuple[Any, ...]] = set()
        self._seen_items: set[str] = set()
        self._waiting_dismiss: bool = False
        self._cancelling: bool = False
        self._abort_reason_after_return: str | None = None

    def status(self) -> dict[str, Any]:
        with self._lock:
            return {
                "active": self.active,
                "task": self.task,
                "phase": self.phase,
                "detail": self.detail,
                "error": self.error,
                "last_result": copy.deepcopy(self.last_result),
                "last_completed_at": dict(self.last_completed_at),
            }

    def start(self, task: str, *, battle_live: bool, trigger: str = "manual") -> dict[str, Any]:
        if task not in VALID_TASKS:
            raise ValueError(f"task must be one of {VALID_TASKS}")
        if not battle_live:
            raise RuntimeError("Battle Menu routines require a live battle on screen")
        with self._lock:
            if self.active:
                raise RuntimeError(f"Battle Menu routine already running ({self.task})")
            self.active = True
            self.task = task
            self.phase = "open_menu"
            self.detail = f"Opening Battle Menu for {_TASK_LABELS[task]}"
            self.error = None
            self._next_step_at = 0.0
            self._failures = 0
            self._return_attempts = 0
            self._page = 0
            self._claims_done = 0
            self._claim_attempts = 0
            self._pending_claim = None
            self._accumulated_runs = []
            self._seen_keys = set()
            self._seen_items = set()
            self._waiting_dismiss = False
            self._cancelling = False
            self._abort_reason_after_return = None
            self._log(
                f"Battle Menu routine started: {_TASK_LABELS[task]} ({trigger})",
                event="battle_menu_started",
                task=task,
                trigger=trigger,
            )
            return self.status()

    def cancel(self, *, hard: bool = False) -> dict[str, Any]:
        """Cancel the routine. When `hard=False` and an overlay is open, drains via verified return-to-game first."""
        with self._lock:
            was = self.active
            task = self.task
            if not was:
                return self.status()
            if not hard and self.phase in ("work", "return_to_game", "close_menu") and not self._stop_event.is_set():
                self._cancelling = True
                self._waiting_dismiss = False
                self._pending_claim = None
                self._return_attempts = 0
                self.phase = "return_to_game"
                self.detail = "Cancelling — returning cleanly to battle"
                self._next_step_at = 0.0
                self._log(f"Battle Menu routine cancelling ({task})", event="battle_menu_cancelled", task=task)
                return self.status()
            self.active = False
            self.task = None
            self.phase = "idle"
            self.detail = ""
            self.error = None
            self._cancelling = False
            self._abort_reason_after_return = None
            self._log(f"Battle Menu routine cancelled ({task})", event="battle_menu_cancelled", task=task)
            return self.status()

    def _read_lines(self, img: np.ndarray, *, scale: float = 1.0) -> list[tuple[int, int, str]]:
        if self._lines_fn is not None:
            batches = self._lines_fn([img])
            return batches[0] if batches else []
        batches = ocr.read_lines([img], scale=scale, timeout=2.5)
        return batches[0] if batches else []

    def _read_header(self, frame: np.ndarray) -> str:
        hx, hy, hw, hh = detectors.scale_rect(REF_OVERLAY_HEADER, frame.shape)
        crop = frame[hy : hy + hh, hx : hx + hw]
        if self._lines_fn is not None:
            lines = self._read_lines(crop, scale=1.5)
            return " ".join(t for _, _, t in lines).upper()
        texts = ocr.read_texts([crop], scale=1.5, timeout=2.0)
        return (texts[0] if texts else "").upper()

    def _read_return_bar(self, frame: np.ndarray) -> str:
        rx, ry, rw, rh = detectors.scale_rect(REF_RETURN_BAR, frame.shape)
        crop = frame[ry : ry + rh, rx : rx + rw]
        if self._lines_fn is not None:
            lines = self._read_lines(crop, scale=1.5)
            return " ".join(t for _, _, t in lines).upper()
        texts = ocr.read_texts([crop], scale=1.5, timeout=2.0)
        return (texts[0] if texts else "").upper()

    def _verified_grab_and_fg(self) -> tuple[np.ndarray, int | None] | None:
        if self._stop_event.is_set():
            self.cancel(hard=True)
            return None
        try:
            fresh, disp = self._grab()
        except Exception as exc:
            self._failures += 1
            if self._failures >= _MAX_FAILURES:
                self._abort(f"capture failed: {exc}")
            return None
        ok, why = self._check_fg(disp)
        if not ok:
            self._abort(f"foreground blocked: {why}")
            return None
        return fresh, disp

    def _abort(self, reason: str) -> bool:
        task = self.task
        self.active = False
        self.phase = "aborted"
        self.detail = reason
        self.error = reason
        self._cancelling = False
        self._abort_reason_after_return = None
        self._pending_claim = None
        self._log(f"Battle Menu routine aborted ({task}): {reason}", event="battle_menu_aborted", task=task, reason=reason)
        if callable(self._notify):
            try:
                self._notify(f"Battle Menu routine paused ({task}): {reason}")
            except Exception:
                pass
        return False

    def _abort_via_return(self, reason: str) -> bool:
        """Attempt bounded verified return-to-game before finalizing an abort, so overlays don't strand harvesting."""
        self._abort_reason_after_return = reason
        self._waiting_dismiss = False
        self._pending_claim = None
        self._return_attempts = 0
        self.phase = "return_to_game"
        self.detail = f"Returning to battle ({reason})"
        return True

    def _finish(self, result: dict[str, Any], summary: str) -> bool:
        task = self.task or "unknown"
        if self._cancelling:
            self.active = False
            self.task = None
            self.phase = "idle"
            self.detail = ""
            self.error = None
            self._cancelling = False
            return False
        if self._abort_reason_after_return:
            return self._abort(self._abort_reason_after_return)
        self.active = False
        self.phase = "done"
        self.detail = summary
        self.error = None
        self.last_result = {"task": task, "summary": summary, **result}
        self.last_completed_at[task] = round(time.time(), 3)
        self._log(
            f"Battle Menu routine complete: {summary}",
            event="battle_menu_completed",
            task=task,
            **result,
        )
        return False

    def _safe_tap(
        self,
        pt: tuple[int, int],
        frame: np.ndarray,
        *,
        reason: str,
        input_display: int | None,
        allow_close_toggle: bool = False,
        guild_guard: bool = False,
        allow_guild_750_chest: bool = False,
    ) -> dict[str, Any] | None:
        """Single point-level safety fence enforced on EVERY Battle Menu routine tap."""
        menu_state = detectors.side_menu_state(frame)
        forbidden: list[tuple[int, int, int, int]] = []
        # Keep EXIT BATTLE & STORE fences unconditional; exempt only header-verified Guild 750 chest
        if not (allow_guild_750_chest and guild_guard and menu_state == "obscured"):
            forbidden.append(REF_FORBIDDEN_EXIT)
        if not allow_close_toggle:
            forbidden.append(REF_FORBIDDEN_STORE)
        if guild_guard:
            forbidden.extend((REF_FORBIDDEN_GUILD_LEAVE, REF_FORBIDDEN_GUILD_STORE))
        for raw_rect in forbidden:
            if _pt_in_rect(pt, detectors.scale_rect(raw_rect, frame.shape)):
                if menu_state == "obscured" and not reason.startswith("battle_menu:return_"):
                    self._abort_via_return(f"refused tap inside forbidden zone ({reason})")
                else:
                    self._abort(f"refused tap inside forbidden zone ({reason})")
                return None
        return self._tap(pt, frame, reason=reason, input_display=input_display)

    def _frame_has_forbidden_overlay(self, frame: np.ndarray) -> str | None:
        """Check header & return bar for promo/purchase/game-stats/forbidden text (Rule 2)."""
        hdr = self._read_header(frame)
        if _has_dangerous_overlay_text(hdr) or screens.is_forbidden_label(hdr):
            return f"forbidden or purchase overlay detected ({hdr[:48]})"
        bar = self._read_return_bar(frame)
        if _has_dangerous_overlay_text(bar) or screens.is_forbidden_label(bar):
            return f"forbidden or purchase prompt in bottom bar ({bar[:48]})"
        return None

    def _tap_verified_return_to_game(self, frame: np.ndarray, disp: int | None, *, reason: str) -> bool:
        """Tap the bottom return bar ONLY after fresh OCR confirms `RETURN TO GAME` and zero danger text."""
        if detectors.side_menu_state(frame) in ("closed", "open"):
            return False
        danger = self._frame_has_forbidden_overlay(frame)
        if danger:
            self._abort(danger)
            return False
        bar_text = self._read_return_bar(frame)
        if "RETURN TO GAME" not in bar_text and "RETURN" not in bar_text:
            self._abort(f"return bar not verified (saw '{bar_text[:40]}') — refusing blind tap")
            return False
        scaled = detectors.scale_rect(REF_RETURN_BAR, frame.shape)
        pt = detectors.sample_interior_point(scaled, inset_px=16)
        return self._safe_tap(pt, frame, reason=reason, input_display=disp) is not None

    def _tap_verified_reward_dismiss(self, frame: np.ndarray, disp: int | None, *, reason: str) -> bool:
        """Dismiss a reward modal ONLY when battle HUD is obscured and zero promo/spend/stats text is shown."""
        if detectors.side_menu_state(frame) in ("closed", "open"):
            return False
        danger = self._frame_has_forbidden_overlay(frame)
        if danger:
            self._abort(danger)
            return False
        # Require either verified RETURN TO GAME bar or explicit reward-popup text (never blind on unknown modal)
        bar_text = self._read_return_bar(frame)
        hdr = self._read_header(frame)
        safe_context = (
            "RETURN TO GAME" in bar_text
            or "CONTINUE" in bar_text
            or "DAILY" in hdr
            or "MISSION" in hdr
            or "GUILD" in hdr
            or "REWARD" in hdr
            or "CLAIMED" in hdr
        )
        if not safe_context:
            self._abort("unidentified overlay during reward dismiss — refusing blind tap")
            return False
        pt = detectors.scale_point(REF_REWARD_DISMISS_PT, frame.shape)
        return (
            self._safe_tap(
                (int(round(pt[0])), int(round(pt[1]))),
                frame,
                reason=reason,
                input_display=disp,
                guild_guard=(self.task == "guild_rewards"),
            )
            is not None
        )

    def step(self, frame: np.ndarray, now: float) -> bool:
        """Execute at most one verified step. Returns True while owning the loop."""
        with self._lock:
            if not self.active or self.task is None:
                return False
            if now < self._next_step_at:
                return True

            if self.phase == "open_menu":
                grabbed = self._verified_grab_and_fg()
                if grabbed is None:
                    return self.active
                fresh, disp = grabbed
                mstate = detectors.side_menu_state(fresh)
                if mstate == "open":
                    self.phase = "open_target"
                    self.detail = f"Opening {_TASK_LABELS[self.task]}"
                    self._failures = 0
                    self._next_step_at = now + 0.3
                    return True
                if mstate == "closed":
                    rect = detectors.scale_rect(detectors.REF_SIDE_MENU_TOGGLE, fresh.shape)
                    pt = detectors.sample_interior_point(rect, inset_px=12)
                    res = self._safe_tap(pt, fresh, reason="battle_menu:open", input_display=disp, allow_close_toggle=True)
                    if res is not None:
                        self.phase = "open_target"
                        self.detail = f"Opening {_TASK_LABELS[self.task]}"
                        self._failures = 0
                        self._next_step_at = now + self._step_delay_sec
                    return self.active
                self._failures += 1
                if self._failures >= _MAX_FAILURES:
                    return self._abort("battle side menu toggle not visible")
                self._next_step_at = now + self._step_delay_sec
                return True

            if self.phase == "open_target":
                grabbed = self._verified_grab_and_fg()
                if grabbed is None:
                    return self.active
                fresh, disp = grabbed
                mstate = detectors.side_menu_state(fresh)
                if mstate == "closed":
                    self.phase = "open_menu"
                    self._next_step_at = now + 0.4
                    return True
                if mstate != "open":
                    # Never treat an unexpected obscured screen (run ended / promo popup) as our target overlay
                    return self._abort("battle HUD obscured before target icon was tapped")
                scaled_icon = detectors.scale_rect(_TASK_ICON_RECTS[self.task], fresh.shape)
                pt = detectors.sample_interior_point(scaled_icon, inset_px=12)
                res = self._safe_tap(pt, fresh, reason=f"battle_menu:open_{self.task}", input_display=disp)
                if res is not None:
                    self.phase = "work"
                    self.detail = f"Reading {_TASK_LABELS[self.task]}"
                    self._failures = 0
                    self._next_step_at = now + self._step_delay_sec
                return self.active

            if self.phase == "work":
                return self._step_work(now)

            if self.phase == "return_to_game":
                grabbed = self._verified_grab_and_fg()
                if grabbed is None:
                    return self.active
                fresh, disp = grabbed
                mstate = detectors.side_menu_state(fresh)
                if mstate == "closed":
                    return self._complete_current_task()
                if mstate == "open":
                    self.phase = "close_menu"
                    self._failures = 0
                    self._next_step_at = now + 0.3
                    return True
                self._return_attempts += 1
                if self._return_attempts > _MAX_RETURN_ATTEMPTS:
                    return self._abort("could not return to battle from overlay")
                ok = self._tap_verified_return_to_game(fresh, disp, reason=f"battle_menu:return_{self.task}")
                if not self.active:
                    return False
                if ok:
                    self._next_step_at = now + self._step_delay_sec
                return True

            if self.phase == "close_menu":
                grabbed = self._verified_grab_and_fg()
                if grabbed is None:
                    return self.active
                fresh, disp = grabbed
                mstate = detectors.side_menu_state(fresh)
                if mstate == "closed":
                    return self._complete_current_task()
                if mstate == "open":
                    self._failures += 1
                    if self._failures > _MAX_FAILURES:
                        return self._abort("could not close Battle Menu after repeated taps")
                    rect = detectors.scale_rect(REF_MENU_CLOSE, fresh.shape)
                    pt = detectors.sample_interior_point(rect, inset_px=12)
                    self._safe_tap(pt, fresh, reason="battle_menu:close", input_display=disp, allow_close_toggle=True)
                    self._next_step_at = now + 0.8
                    return self.active
                # Unexpected overlay popped back -> bounded verified return
                self.phase = "return_to_game"
                self._next_step_at = now + 0.5
                return True

            return False

    def _complete_current_task(self) -> bool:
        if self._cancelling or self._abort_reason_after_return:
            return self._finish({}, "")
        task = self.task
        if task == "history":
            stats = self._history_store.merge_runs(self._accumulated_runs)
            return self._finish(
                stats,
                f"Battle History synced ({stats['added']} new, {stats['total']} total runs)",
            )
        if task == "cards":
            return self._finish(
                {"cards_seen": len(self._seen_items)},
                f"Cards scanned in battle ({len(self._seen_items)} cards)",
            )
        if task == "modules":
            return self._finish(
                {"modules_seen": len(self._seen_items)},
                f"Modules scanned in battle ({len(self._seen_items)} modules)",
            )
        if task == "daily_quests":
            return self._finish(
                {"claimed": self._claims_done},
                f"Daily Quests checked ({self._claims_done} claimed)",
            )
        if task == "guild_rewards":
            return self._finish(
                {"claimed": self._claims_done},
                f"Guild Rewards checked ({self._claims_done} claimed)",
            )
        return self._finish({}, "Routine finished")

    def _confirm_pending_claim(self, *, kind: str, still_present: bool) -> None:
        """Verify on the next frame that the tapped claim target disappeared before counting/logging."""
        pending = self._pending_claim
        if pending is None or pending.get("kind") != kind:
            return
        self._pending_claim = None
        if still_present:
            self._log(
                f"Claim target did not clear ({kind}) — not counted",
                event="battle_menu_claim_unverified",
                task=self.task,
                claim_kind=kind,
            )
            return
        self._claims_done += 1
        if kind == "daily_quest":
            self.detail = f"Claimed daily quest #{self._claims_done}"
            self._log("Daily Quest claimed", event="daily_quest_claimed", count=self._claims_done)
        elif kind == "daily_chest":
            ms = pending.get("key")
            self.detail = f"Claimed weekly chest ({ms})"
            self._log("Weekly Challenge chest claimed", event="daily_reward_claimed", milestone=ms, count=self._claims_done)
        elif kind == "guild_chest":
            thr = pending.get("key")
            self.detail = f"Claimed Guild chest ({thr})"
            self._log(
                f"Guild reward chest ({thr}) claimed",
                event="guild_reward_claimed",
                threshold=thr,
                total_contribution=pending.get("total_contribution"),
                count=self._claims_done,
            )

    def _step_work(self, now: float) -> bool:
        grabbed = self._verified_grab_and_fg()
        if grabbed is None:
            return self.active
        fresh, disp = grabbed
        task = self.task

        # Never run overlay work or dismiss taps if we are still on the live battle HUD
        mstate = detectors.side_menu_state(fresh)
        if mstate in ("closed", "open"):
            self._failures += 1
            if self._failures >= 2:
                return self._abort("overlay did not open (still on battle HUD)")
            self._next_step_at = now + self._step_delay_sec
            return True

        danger = self._frame_has_forbidden_overlay(fresh)
        if danger:
            return self._abort(danger)

        if task == "history":
            hdr = self._read_header(fresh)
            if "HISTORY" not in hdr:
                self._failures += 1
                if self._failures >= _MAX_FAILURES:
                    return self._abort_via_return(f"expected BATTLE HISTORY, saw '{hdr[:32]}'")
                self._next_step_at = now + self._step_delay_sec
                return True
            lines = self._read_lines(fresh, scale=1.0)
            parsed = parse_battle_history_page(lines, frame_height=fresh.shape[0])
            new_on_page = 0
            for item in parsed:
                k = history_entry_key(item)
                if k not in self._seen_keys:
                    self._seen_keys.add(k)
                    self._accumulated_runs.append(item)
                    new_on_page += 1
            self._page += 1
            self._failures = 0
            self.detail = f"Battle History page {self._page} ({len(self._accumulated_runs)} runs)"
            if self._page < _MAX_SCROLL_PAGES and new_on_page > 0:
                sx, sy = fresh.shape[1] / float(detectors.REF_W), fresh.shape[0] / float(detectors.REF_H)
                self._swipe(
                    (int(round(540 * sx)), int(round(1920 * sy))),
                    (int(round(540 * sx)), int(round(720 * sy))),
                    fresh,
                    duration_ms=550,
                    reason=f"battle_menu:scroll_history_{self._page}",
                    input_display=disp,
                )
                self._next_step_at = now + self._step_delay_sec
                return True
            self.phase = "return_to_game"
            self._next_step_at = now + 0.4
            return True

        if task == "cards":
            hdr = self._read_header(fresh)
            if "CARD" not in hdr and self._page == 0:
                self._failures += 1
                if self._failures >= _MAX_FAILURES:
                    return self._abort_via_return(f"expected CARDS, saw '{hdr[:32]}'")
                self._next_step_at = now + self._step_delay_sec
                return True
            obs = loadouts.parse_cards_page(fresh)
            cards_found = obs.get("cards") or []
            new_cards = 0
            for c in cards_found:
                slug = str(c.get("slug") or c.get("name") or "")
                if slug and slug not in self._seen_items:
                    self._seen_items.add(slug)
                    new_cards += 1
            if cards_found or obs.get("active_slots"):
                self._account_store.record_cards_scan(
                    obs.get("active_preset"),
                    cards_found,
                    active_slots=obs.get("active_slots"),
                )
            self._page += 1
            self._failures = 0
            self.detail = f"Cards page {self._page} ({len(self._seen_items)} seen)"
            if self._page < _MAX_SCROLL_PAGES and new_cards > 0:
                sx, sy = fresh.shape[1] / float(detectors.REF_W), fresh.shape[0] / float(detectors.REF_H)
                self._swipe(
                    (int(round(540 * sx)), int(round(2050 * sy))),
                    (int(round(540 * sx)), int(round(1150 * sy))),
                    fresh,
                    duration_ms=550,
                    reason=f"battle_menu:scroll_cards_{self._page}",
                    input_display=disp,
                )
                self._next_step_at = now + self._step_delay_sec
                return True
            self.phase = "return_to_game"
            self._next_step_at = now + 0.4
            return True

        if task == "modules":
            hdr = self._read_header(fresh)
            if "MODULE" not in hdr and self._page == 0:
                self._failures += 1
                if self._failures >= _MAX_FAILURES:
                    return self._abort_via_return(f"expected MODULES, saw '{hdr[:32]}'")
                self._next_step_at = now + self._step_delay_sec
                return True
            obs = loadouts.parse_modules_equipped(fresh)
            slots = obs.get("slots") or {}
            preset = obs.get("active_preset")
            for slot_key, entry in slots.items():
                if not isinstance(entry, dict):
                    continue
                if entry.get("level") is None and not entry.get("rarity") and not entry.get("slug"):
                    continue
                self._account_store.record_module_slot(
                    preset,
                    slot_key,
                    {
                        "slug": entry.get("slug"),
                        "name": entry.get("name"),
                        "level": entry.get("level"),
                        "rarity": entry.get("rarity") or "",
                    },
                )
                self._seen_items.add(str(entry.get("slug") or slot_key))
            self._page += 1
            self.detail = f"Modules read ({len(self._seen_items)} slots)"
            self.phase = "return_to_game"
            self._failures = 0
            self._next_step_at = now + 0.4
            return True

        if task == "daily_quests":
            if self._waiting_dismiss:
                self._waiting_dismiss = False
                self._tap_verified_reward_dismiss(fresh, disp, reason="battle_menu:dismiss_daily_reward")
                if not self.active:
                    return False
                self._next_step_at = now + self._step_delay_sec
                return True
            hdr = self._read_header(fresh)
            if "DAILY" not in hdr and "MISSION" not in hdr:
                return self._abort_via_return(f"expected DAILY MISSIONS, saw '{hdr[:32]}'")

            lines = self._read_lines(fresh, scale=1.5)
            found = detect_daily_missions_claimables(fresh, lines, button_ocr_fn=self._button_ocr_fn)

            # Verify any pending claim from previous tick before tapping again
            if self._pending_claim is not None:
                pk = self._pending_claim.get("kind")
                if pk == "daily_quest":
                    prev_cnt = int(self._pending_claim.get("prev_count", 0))
                    still = len(found["mission_claims"]) >= prev_cnt
                    self._confirm_pending_claim(kind="daily_quest", still_present=still)
                elif pk == "daily_chest":
                    ms = self._pending_claim.get("key")
                    still = any(m == ms for m, _ in found["chest_claims"])
                    self._confirm_pending_claim(kind="daily_chest", still_present=still)

            if self._claim_attempts < _MAX_CLAIMS_PER_RUN:
                if found["mission_claims"]:
                    rect = found["mission_claims"][0]
                    pt = detectors.sample_interior_point(rect, inset_px=10)
                    res = self._safe_tap(pt, fresh, reason="battle_menu:claim_daily_quest", input_display=disp)
                    if res is not None:
                        self._claim_attempts += 1
                        self._pending_claim = {"kind": "daily_quest", "prev_count": len(found["mission_claims"])}
                        self._failures = 0
                        self.detail = f"Claiming daily quest ({self._claim_attempts})"
                        self._next_step_at = now + self._step_delay_sec
                    return self.active
                if found["chest_claims"]:
                    ms, rect = found["chest_claims"][0]
                    pt = detectors.sample_interior_point(rect, inset_px=14)
                    res = self._safe_tap(pt, fresh, reason=f"battle_menu:claim_weekly_{ms}", input_display=disp)
                    if res is not None:
                        self._claim_attempts += 1
                        self._pending_claim = {"kind": "daily_chest", "key": ms}
                        self._waiting_dismiss = True
                        self._failures = 0
                        self.detail = f"Claiming weekly chest ({ms})"
                        self._next_step_at = now + self._step_delay_sec
                    return self.active
            self.phase = "return_to_game"
            self._failures = 0
            self._next_step_at = now + 0.4
            return True

        if task == "guild_rewards":
            if self._waiting_dismiss:
                self._waiting_dismiss = False
                self._tap_verified_reward_dismiss(fresh, disp, reason="battle_menu:dismiss_guild_reward")
                if not self.active:
                    return False
                self._next_step_at = now + self._step_delay_sec
                return True
            hdr = self._read_header(fresh)
            if "GUILD" not in hdr:
                return self._abort_via_return(f"expected GUILD, saw '{hdr[:32]}'")

            lines = self._read_lines(fresh, scale=1.5)
            found = detect_guild_claimables(fresh, lines)

            if self._pending_claim is not None and self._pending_claim.get("kind") == "guild_chest":
                thr = self._pending_claim.get("key")
                still = any(t == thr for t, _ in found["chest_claims"])
                self._confirm_pending_claim(kind="guild_chest", still_present=still)

            if self._claim_attempts < _MAX_CLAIMS_PER_RUN and found["chest_claims"]:
                thr, rect = found["chest_claims"][0]
                pt = detectors.sample_interior_point(rect, inset_px=12)
                res = self._safe_tap(
                    pt,
                    fresh,
                    reason=f"battle_menu:claim_guild_{thr}",
                    input_display=disp,
                    guild_guard=True,
                    allow_guild_750_chest=(thr == 750),
                )
                if res is not None:
                    self._claim_attempts += 1
                    self._pending_claim = {
                        "kind": "guild_chest",
                        "key": thr,
                        "total_contribution": found["total_contribution"],
                    }
                    self._waiting_dismiss = True
                    self._failures = 0
                    self.detail = f"Claiming Guild chest ({thr})"
                    self._next_step_at = now + self._step_delay_sec
                return self.active
            self.phase = "return_to_game"
            self._failures = 0
            self._next_step_at = now + 0.4
            return True

        self.phase = "return_to_game"
        return True
