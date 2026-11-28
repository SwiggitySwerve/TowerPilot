"""Loadout screen parsers (OCR + HSV) and local git-ignored AccountStore.

Provides:
- `observe_frame`: zero-tap single-frame OCR observer (Cards / Modules / UWs / Home)
- `parse_cards_page`: pure Cards inventory grid parser (titles, stars, Max/progress, equipped green checkmark, active slots)
- `parse_modules_equipped`: pure Modules 4-slot parser (cannon/armor/generator/core rects, centers, levels, rarity rings)
- `parse_module_detail`: pure Module Detail popup parser (name, slug, slot, rarity, level, substats, close-X center)
- `AccountStore`: thread-safe atomic JSON store (`data/account.json`) merging master catalog with per-preset inventory
"""
from __future__ import annotations

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

from towerpilot import detectors, ocr, screens, wiki

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ACCOUNT_PATH = ROOT / "data" / "account.json"

REF_W = detectors.REF_W
REF_H = detectors.REF_H

# Reference 1080x2560 Card inventory grid geometry (4 equal columns)
REF_CARD_COLS: tuple[int, ...] = (32, 289, 546, 803)
REF_CARD_W = 245
REF_CARD_H = 301
REF_CARD_INV_Y0 = 1000
REF_CARD_INV_Y1 = 2380

# Reference 1080x2560 Equipped Module slot geometry (x, y, w, h)
REF_MODULE_SLOTS: dict[str, tuple[int, int, int, int]] = {
    "cannon": (200, 425, 210, 210),
    "armor": (200, 665, 210, 210),
    "generator": (665, 425, 210, 210),
    "core": (665, 665, 210, 210),
}
# Reference 1080x2560 Level badge crops directly beneath each module ring
REF_MODULE_LEVEL_BOXES: dict[str, tuple[int, int, int, int]] = {
    "cannon": (235, 582, 160, 52),
    "armor": (235, 822, 175, 56),
    "generator": (700, 582, 160, 52),
    "core": (685, 810, 175, 60),
}
REF_CARDS_ACTIVE_SLOTS_BOX = (300, 475, 480, 130)
MODULE_SLOT_ORDER: tuple[str, ...] = ("cannon", "armor", "generator", "core")

# Reference 1080x2560 Modules Inventory 5-column grid geometry (pixel-calibrated from live_modules_grid.png)
REF_MODULE_INV_COLS: tuple[int, ...] = (50, 249, 448, 647, 846)
REF_MODULE_INV_TILE_W = 188
REF_MODULE_INV_TILE_H = 188
REF_MODULE_INV_Y0 = 1090
REF_MODULE_INV_Y1 = 2260
MODULE_EPIC_PLUS_RARITIES: frozenset[str] = frozenset({"Ancestral", "Mythic", "Legendary", "Epic"})
_MODULE_RARITY_RANK: dict[str, int] = {
    "ancestral": 7,
    "mythic+": 6,
    "mythic": 5,
    "legendary+": 4,
    "legendary": 3,
    "epic+": 2,
    "epic": 1,
    "rare+": 0,
    "rare": 0,
    "common": 0,
}

_RARITY_RE = re.compile(r"\b(Ancestral|Mythic\+?|Legendary\+?|Epic\+?|Rare\+?|Common)(?!\w)", re.IGNORECASE)
_LEVEL_RE = re.compile(r"\b(?:Lv\.?|Level|L[cvg]\.?)\s*[:.-]?\s*([0-9OoIl|]{1,4})\b", re.IGNORECASE)
_LEVEL_SLASH_RE = re.compile(r"\b(\d{1,3})\s*/\s*(\d{2,3})\b")
_PRESET_RE = re.compile(r"\b(Preset\s*\d+)\b", re.IGNORECASE)
_TIER_RE = re.compile(r"\bTier\s*[:#-]?\s*(\d{1,3})\b", re.IGNORECASE)
_SLOTS_RE = re.compile(r"\b(\d{1,2}\s*/\s*\d{1,2})\b")
_PROGRESS_RE = re.compile(r"\b(\d{1,3}\s*/\s*\d{1,3})\b")
_MAX_WORD_RE = re.compile(r"\bma[xy]\b", re.IGNORECASE)
_SUBSTAT_RE = re.compile(r"(?:[+\-]\s*\d|\d\s*%|\d\s*x\b)", re.IGNORECASE)

_OCR_DIGIT_TRANS = str.maketrans({"O": "0", "o": "0", "I": "1", "l": "1", "i": "1", "|": "1"})


def _normalize_rarity(raw: str) -> str:
    cleaned = (raw or "").strip()
    if not cleaned:
        return ""
    plus = "+" if cleaned.endswith("+") else ""
    base = cleaned.rstrip("+").strip().lower()
    mapping = {
        "ancestral": "Ancestral",
        "mythic": "Mythic",
        "legendary": "Legendary",
        "epic": "Epic",
        "rare": "Rare",
        "common": "Common",
    }
    return f"{mapping[base]}{plus}" if base in mapping else cleaned


def _parse_level_int(text: str, *, strict: bool = False, max_val: int = 500) -> int | None:
    """Parse level integer from OCR text like 'Lv.132', 'LC.131', 'Lv.ioo'.

    When `strict=True`, requires an explicit `Lv.`/`Level` prefix so stat multipliers
    like `x1.35` or bare numbers never produce bogus levels.
    """
    raw = (text or "").strip()
    if not raw:
        return None
    m = _LEVEL_RE.search(raw)
    if m:
        digits = m.group(1).translate(_OCR_DIGIT_TRANS)
        if digits.isdigit():
            val = int(digits)
            if 1 <= val <= max_val:
                return val
    if strict:
        return None
    # Fallback: fuzzy Lv prefix or standalone 1-3 digit token after fixing common OCR slips
    fixed = re.sub(r"\bL[a-zA-Z0-9]?[\s.:_-]+", "Lv.", raw)
    m2 = _LEVEL_RE.search(fixed)
    if m2:
        digits = m2.group(1).translate(_OCR_DIGIT_TRANS)
        if digits.isdigit():
            val = int(digits)
            if 1 <= val <= max_val:
                return val
    # Fallback for 'Lv.132' missing the 'v' like 'L .132' or '.132'
    m3 = re.search(r"(?:^|[\s.:-])([0-9OoIl]{2,3})\b", raw)
    if m3:
        digits = m3.group(1).translate(_OCR_DIGIT_TRANS)
        if digits.isdigit():
            val = int(digits)
            if 1 <= val <= max_val:
                return val
    return None


def _classify_screen(lines: list[tuple[int, int, str]]) -> str:
    joined = " ".join(text for _, _, text in lines).upper()
    if "GAME STATS" in joined and ("RETRY" in joined or "HOME" in joined):
        return "game_stats"
    if "ULTIMATE WEAPON" in joined:
        return "ultimate_weapons"
    if any(hdr in joined for hdr in ("ATTACK UPGRADE", "DEFENSE UPGRADE", "UTILITY UPGRADE")):
        return "workshop"
    if "SHATTER" in joined or "MERGE" in joined or "BUY MODULE" in joined or "MODULES" in joined:
        return "modules"
    if "CARDS" in joined or "BUY CARD" in joined or "EQUIPPED" in joined:
        return "cards"
    if "DIFFICULTY" in joined and ("BATTLE" in joined or "RESUME" in joined):
        return "home"
    return "unknown"


def _extract_detail(text: str, nearby: list[str]) -> str:
    """Pull optional rarity/level/max detail from a line or adjacent OCR lines."""
    pool = " ".join([text] + nearby)
    bits: list[str] = []
    m_rar = _RARITY_RE.search(pool)
    if m_rar:
        bits.append(_normalize_rarity(m_rar.group(1)))
    lv = _parse_level_int(pool, strict=True, max_val=5000)
    if lv is not None:
        bits.append(f"Lv.{lv}")
    elif re.search(r"\bMAX\b", pool, re.IGNORECASE):
        bits.append("Max")
    return " ".join(bits)


def _candidate_phrases(text: str) -> list[str]:
    """Generate clean sub-phrases from an OCR line (e.g. 'Lv.120 Galaxy Compressor')."""
    cleaned = " ".join(text.strip().split())
    if not cleaned:
        return []
    phrases = [cleaned]
    stripped = _LEVEL_RE.sub("", cleaned)
    stripped = _RARITY_RE.sub("", stripped)
    stripped = re.sub(r"\b(?:Equipped|Owned|Locked|Mastered|Max)\b", "", stripped, flags=re.IGNORECASE)
    stripped = re.sub(r"[^A-Za-z0-9\-\s]", " ", stripped)
    stripped = " ".join(stripped.split())
    if stripped and stripped != cleaned:
        phrases.append(stripped)
    return phrases


def observe_frame(
    frame: np.ndarray,
    *,
    lines_fn: Callable[[list[np.ndarray]], list[list[tuple[int, int, str]]]] | None = None,
    timeout: float = 4.0,
) -> dict[str, Any]:
    """Read positioned OCR lines on `frame` and match known game items (zero taps).

    Never reads live-battle HUD panels (Workshop / Ultimate Weapons) into permanent
    base inventory — battle perks (e.g. Unlock Random Ultimate Weapon) and in-run
    upgrades do not represent base account unlocks.
    """
    if frame is None or frame.ndim != 3:
        raise ValueError("Valid frame required")

    # Never infer permanent base unlocks from an active battle HUD
    if detectors.menu_toggle_visible(frame):
        return {
            "screen": "battle",
            "observed_at": round(time.time(), 1),
            "tier": None,
            "presets": [],
            "items": [],
            "line_count": 0,
        }

    reader = lines_fn if lines_fn is not None else (lambda items: ocr.read_lines(items, scale=1.5, timeout=timeout))
    batches = reader([frame])
    lines = batches[0] if batches else []

    screen = _classify_screen(lines)
    preferred_cats: tuple[str, ...] = {
        "cards": ("card",),
        "modules": ("module",),
        "ultimate_weapons": ("uw_plus", "uw"),
        "workshop": ("workshop",),
    }.get(screen, ())

    tier: int | None = None
    presets: list[str] = []
    matched: dict[str, dict[str, Any]] = {}

    for idx, (y, x, text) in enumerate(lines):
        m_tier = _TIER_RE.search(text)
        if m_tier and tier is None:
            tier = int(m_tier.group(1))
        for m_pre in _PRESET_RE.finditer(text):
            label = " ".join(m_pre.group(1).split()).title()
            if label not in presets:
                presets.append(label)

        # Only record loadout items from recognized off-battle loadout/workshop screens
        if not preferred_cats:
            continue

        nearby = [
            other_text
            for j, (oy, ox, other_text) in enumerate(lines)
            if j != idx and abs(oy - y) <= 90 and abs(ox - x) <= 260
        ]
        # Skip locked items / "Unlock New ..." buttons on off-battle Workshop / UW screens
        if screen in ("workshop", "ultimate_weapons"):
            local_text = " ".join([text] + nearby)
            if re.search(r"\b(?:UNLOCK|LOCKED)\b", local_text, re.IGNORECASE):
                continue

        hit: wiki.IndexItem | None = None
        for phrase in _candidate_phrases(text):
            # Ignore exact topic headings (e.g. "CARDS", "MODULES") so they never fuzzy-match an item
            if wiki.match_name(phrase, category="topic", exact_only=True) is not None:
                hit = None
                break
            for cat in preferred_cats:
                hit = wiki.match_name(phrase, category=cat, exact_only=True)
                if hit is not None:
                    break
            if hit is not None:
                break
            for cat in preferred_cats:
                hit = wiki.match_name(phrase, category=cat)
                if hit is not None:
                    break
            if hit is not None:
                break

        if hit is None:
            continue

        detail = _extract_detail(text, nearby)
        existing = matched.get(hit.slug)
        if existing is None or (detail and not existing.get("detail")):
            matched[hit.slug] = {
                "slug": hit.slug,
                "name": hit.name,
                "category": hit.category,
                "detail": detail,
                "y": int(y),
                "x": int(x),
                "raw": text,
            }

    return {
        "screen": screen,
        "observed_at": round(time.time(), 1),
        "tier": tier,
        "presets": presets,
        "items": sorted(matched.values(), key=lambda it: (it["category"], it["name"])),
        "line_count": len(lines),
    }


# --- Pure Cards Page Parser (OCR + HSV) ----------------------------------

def _count_stars_in_band(band: np.ndarray) -> tuple[int, int]:
    """Count (magenta_stars, yellow_stars) peaks in a card tile's star band."""
    if band is None or band.size == 0 or band.shape[0] < 4 or band.shape[1] < 10:
        return 0, 0
    hsv = cv2.cvtColor(band, cv2.COLOR_BGR2HSV)
    # Magenta/pink stars: H 135..175, S>=110, V>=140
    m_mask = cv2.inRange(hsv, (135, 110, 140), (175, 255, 255))
    # Yellow/gold stars: H 18..38, S>=110, V>=140
    y_mask = cv2.inRange(hsv, (18, 110, 140), (38, 255, 255))

    min_area = max(8.0, float(band.shape[0] * band.shape[1]) * 0.0025)

    def _count_blobs(mask: np.ndarray) -> int:
        cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        blobs = [cv2.boundingRect(c) for c in cnts if cv2.contourArea(c) >= min_area]
        if not blobs:
            return 0
        # Merge only overlapping x-intervals (keep adjacent stars distinct)
        blobs.sort(key=lambda b: b[0])
        merged: list[list[int]] = []
        for x, _, w, _ in blobs:
            if not merged or x >= merged[-1][1]:
                merged.append([x, x + w])
            else:
                merged[-1][1] = max(merged[-1][1], x + w)
        return len(merged)

    return _count_blobs(m_mask), _count_blobs(y_mask)


def _has_green_checkmark(frame: np.ndarray, tile_rect: tuple[int, int, int, int]) -> bool:
    """Detect equipped green checkmark at the bottom-right corner of a card tile."""
    fh, fw = frame.shape[:2]
    sx, sy = fw / REF_W, fh / REF_H
    tx, ty, tw, th = tile_rect
    x0 = max(0, int(round(tx + tw - 55 * sx)))
    x1 = min(fw, int(round(tx + tw + 22 * sx)))
    y0 = max(0, int(round(ty + th - 42 * sy)))
    y1 = min(fh, int(round(ty + th + 32 * sy)))
    if x1 <= x0 + 4 or y1 <= y0 + 4:
        return False
    patch = frame[y0:y1, x0:x1]
    hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, (45, 110, 140), (85, 255, 255))
    ratio = float(np.count_nonzero(mask)) / float(mask.size)
    return ratio >= 0.045


def _parse_card_footer(text: str) -> tuple[bool, str]:
    """Parse a card footer string ('Max', '12/32', etc.) into (maxed, progress)."""
    cleaned = " ".join((text or "").strip().split())
    if not cleaned:
        return False, ""
    if _MAX_WORD_RE.search(cleaned):
        return True, "Max"
    m = _PROGRESS_RE.search(cleaned)
    if m:
        return False, m.group(1).replace(" ", "")
    return False, ""


_MASTERY_LEVEL_RE = re.compile(
    r"(?:\b(?:MASTERY|M|LV\.?)\s*([0-9])(?!\s*[★*])\b|\+\s*([0-9])(?!\s*[★*])\b|\bMAX\s+([0-9])(?!\s*[★*])\b)",
    re.IGNORECASE,
)


def _parse_card_mastery(footer_text: str, extra_text: str = "", *, maxed: bool = False) -> tuple[bool, int | None]:
    """Parse Tier 16 Card Mastery enhancement level (0..9) appearing after card stars/Max.

    Only accepts mastery when the card footer independently indicates Max (no `n/m` progress
    fraction) so OCR noise on non-maxed cards can never promote them to 7★ Max + Mastery.
    """
    if not maxed or _PROGRESS_RE.search(footer_text or ""):
        return False, None
    for chunk in (footer_text, extra_text):
        cleaned = (chunk or "").strip()
        if not cleaned:
            continue
        m = _MASTERY_LEVEL_RE.search(cleaned)
        if m:
            lvl_str = next(g for g in m.groups() if g is not None)
            return True, int(lvl_str)
    # Standalone single mastery digit 0..9 in star/badge band on an already-maxed card
    if extra_text:
        m_bare = re.fullmatch(r"\s*[★*#•·+]?\s*([0-9])\s*", extra_text)
        if m_bare:
            return True, int(m_bare.group(1))
    return False, None


def _build_card_entry(
    hit: wiki.IndexItem,
    frame: np.ndarray,
    tile_rect: tuple[int, int, int, int],
    footer_text: str,
    *,
    star_band_text: str = "",
) -> dict[str, Any]:
    fh, fw = frame.shape[:2]
    sx, sy = fw / REF_W, fh / REF_H
    tx, ty, tw, th = tile_rect

    # Star band inside tile: y_title + 205..265 (approx ty + 220..292 in 1080x2560)
    sb_y0 = max(0, min(fh - 1, int(round(ty + 221 * sy))))
    sb_y1 = max(sb_y0 + 1, min(fh, int(round(ty + 294 * sy))))
    sb_x0 = max(0, min(fw - 1, int(round(tx + 8 * sx))))
    sb_x1 = max(sb_x0 + 1, min(fw, int(round(tx + tw - 8 * sx))))
    m_stars, y_stars = _count_stars_in_band(frame[sb_y0:sb_y1, sb_x0:sb_x1])

    maxed, progress = _parse_card_footer(footer_text)
    mastery_unlocked, mastery_level = _parse_card_mastery(footer_text, star_band_text, maxed=maxed)

    raw_stars = min(7, m_stars + y_stars)
    if maxed:
        stars = 7
    elif m_stars >= 5 and progress.endswith("/32"):
        stars = 6
    else:
        stars = raw_stars

    equipped = _has_green_checkmark(frame, tile_rect)
    bits: list[str] = []
    if stars > 0:
        bits.append(f"{stars}★")
    if mastery_unlocked and mastery_level is not None:
        bits.append(f"M{mastery_level}")
    elif progress:
        bits.append(progress)
    level_text = " ".join(bits)

    return {
        "slug": hit.slug,
        "name": hit.name,
        "owned": True,
        "maxed": maxed,
        "stars": stars,
        "mastery_unlocked": mastery_unlocked,
        "mastery_level": mastery_level,
        "progress": progress,
        "equipped": equipped,
        "level_text": level_text,
    }


def _detect_card_grid_tiles(frame: np.ndarray) -> list[tuple[int, int, int, int]]:
    """Detect visible 4-column card tiles inside INVENTORY via phase-locked border projection."""
    fh, fw = frame.shape[:2]
    sx, sy = fw / REF_W, fh / REF_H
    inv_y0 = int(round(REF_CARD_INV_Y0 * sy))
    inv_y1 = min(fh, int(round(REF_CARD_INV_Y1 * sy)))
    if inv_y1 - inv_y0 < int(round(230 * sy)):
        return []

    inv = frame[inv_y0:inv_y1, :]
    hsv = cv2.cvtColor(inv, cv2.COLOR_BGR2HSV)
    border_row = (hsv[..., 2] > 165).astype(np.float32)

    cols = [int(round(c * sx)) for c in REF_CARD_COLS]
    cw = max(20, int(round(REF_CARD_W * sx)))
    ch = max(20, int(round(REF_CARD_H * sy)))
    margin_x = max(4, int(round(20 * sx)))

    prof = np.zeros(inv.shape[0], dtype=np.float32)
    for cx in cols:
        x0 = max(0, cx + margin_x)
        x1 = min(fw, cx + cw - margin_x)
        if x1 <= x0:
            continue
        row_frac = border_row[:, x0:x1].mean(axis=1)
        prof += (row_frac > 0.72).astype(np.float32) * row_frac

    d_title = int(round(50 * sy))
    d_star = int(round(223 * sy))
    d_bot = int(round(295 * sy))
    d_mid1 = int(round(25 * sy))
    d_mid2 = int(round(135 * sy))
    tol = max(2, int(round(3 * sy)))
    mid_tol = max(2, int(round(4 * sy)))
    min_spacing = int(round(300 * sy))

    def _pk(yy: int) -> float:
        if 0 <= yy < len(prof):
            return float(prof[max(0, yy - tol) : min(len(prof), yy + tol + 1)].max())
        return 0.0

    def _mid(yy: int) -> float:
        if 0 <= yy < len(prof):
            return float(prof[max(0, yy - mid_tol) : min(len(prof), yy + mid_tol + 1)].mean())
        return 0.0

    max_y = len(prof) - int(round(230 * sy))
    scores: list[tuple[float, int]] = []
    for y in range(0, max(0, max_y)):
        s = (
            _pk(y)
            + 1.3 * _pk(y + d_title)
            + 1.3 * _pk(y + d_star)
            + (0.8 * _pk(y + d_bot) if y + d_bot < len(prof) else 0.0)
            - 1.5 * _mid(y + d_mid1)
            - 1.5 * _mid(y + d_mid2)
        )
        if s >= 1.8:
            scores.append((s, y))

    scores.sort(reverse=True)
    row_ys: list[int] = []
    for _, y in scores:
        if all(abs(y - ry) >= min_spacing for ry in row_ys):
            row_ys.append(y)
    row_ys.sort()

    tiles: list[tuple[int, int, int, int]] = []
    for rel_y in row_ys:
        ry = inv_y0 + rel_y
        if ry < inv_y0 + int(round(2 * sy)) or ry + int(round(235 * sy)) > inv_y1:
            continue
        for cx in cols:
            x0 = max(0, cx + margin_x)
            x1 = min(fw, cx + cw - margin_x)
            if x1 <= x0:
                continue
            b1_y0, b1_y1 = max(0, rel_y + d_title - tol - 1), min(len(prof), rel_y + d_title + tol + 2)
            b2_y0, b2_y1 = max(0, rel_y + d_star - tol - 1), min(len(prof), rel_y + d_star + tol + 2)
            b1 = float(border_row[b1_y0:b1_y1, x0:x1].mean(axis=1).max()) if b1_y1 > b1_y0 else 0.0
            b2 = float(border_row[b2_y0:b2_y1, x0:x1].mean(axis=1).max()) if b2_y1 > b2_y0 else 0.0
            if b1 >= 0.65 and b2 >= 0.65:
                tiles.append((cx, ry, cw, ch))
    return tiles


def _match_card_phrase(text: str) -> wiki.IndexItem | None:
    for phrase in _candidate_phrases(text):
        if wiki.match_name(phrase, category="topic", exact_only=True) is not None:
            continue
        hit = wiki.match_name(phrase, category="card", exact_only=True)
        if hit is not None:
            return hit
        hit = wiki.match_name(phrase, category="card")
        if hit is not None:
            return hit
    return None


def _parse_cards_from_lines(
    frame: np.ndarray,
    lines: list[tuple[int, int, str]],
) -> dict[str, Any]:
    """Parse cards page using positioned OCR lines + HSV star/checkmark checks."""
    fh, fw = frame.shape[:2]
    sx, sy = fw / REF_W, fh / REF_H

    active_slots: str | None = None
    active_preset: str | None = None

    # 1) Active slots ("20/20") in ACTIVE header region (y < 940 * sy)
    for y, _, text in lines:
        if y < int(round(940 * sy)):
            m = _SLOTS_RE.search(text)
            if m and active_slots is None:
                active_slots = m.group(1).replace(" ", "")

    # 2) Active preset via green pill border detection + matching OCR line
    detected_pills = screens._detect_preset_pills(frame, screens.REF_CARDS_PRESET_BAND, min_w_ref=130, max_w_ref=240)
    for (px, py, pw, ph), is_active in detected_pills:
        if not is_active:
            continue
        inside = " ".join(t for ly, lx, t in lines if px <= lx <= px + pw and py <= ly <= py + ph)
        m_pre = _PRESET_RE.search(inside)
        if m_pre:
            active_preset = " ".join(m_pre.group(1).split()).title()
            break

    # 3) Cards inside INVENTORY grid (y >= 1020 and y <= 2360 scaled)
    inv_y0 = int(round(1000 * sy))
    inv_y1 = int(round(2360 * sy))
    col_xs = [int(round(c * sx)) for c in REF_CARD_COLS]
    cw = max(20, int(round(REF_CARD_W * sx)))
    ch = max(20, int(round(REF_CARD_H * sy)))

    inv_lines = [(int(y), int(x), str(t).strip()) for y, x, t in lines if inv_y0 <= y <= inv_y1 and str(t).strip()]
    consumed: set[int] = set()
    cards: list[dict[str, Any]] = []
    seen_slugs: set[str] = set()

    for idx, (y, x, text) in enumerate(inv_lines):
        if idx in consumed:
            continue
        # Skip footer lines ("Max", "12/32")
        if _MAX_WORD_RE.fullmatch(text) or _PROGRESS_RE.fullmatch(text):
            continue

        # Check wrapped two-line titles in same column (e.g. "Recovery Package" + "Chance")
        combined_text = text
        col_idx = min(range(len(col_xs)), key=lambda ci: abs((col_xs[ci] + cw // 2) - x))
        tile_x = col_xs[col_idx]
        for j, (ny, nx, ntext) in enumerate(inv_lines):
            if j <= idx or j in consumed:
                continue
            if 0 < (ny - y) <= int(round(36 * sy)) and tile_x - int(round(20 * sx)) <= nx <= tile_x + cw + int(round(20 * sx)):
                if not (_MAX_WORD_RE.fullmatch(ntext) or _PROGRESS_RE.fullmatch(ntext)):
                    if _match_card_phrase(f"{text} {ntext}") is not None:
                        combined_text = f"{text} {ntext}"
                        consumed.add(j)
                        break

        hit = _match_card_phrase(combined_text)
        if hit is None or hit.slug in seen_slugs:
            continue

        tile_y = max(0, int(round(y - 16 * sy)))
        tile_rect = (tile_x, tile_y, cw, ch)

        # Find star-band mastery digit & footer OCR line below this tile
        footer_text = ""
        star_band_text = ""
        star_y0 = int(round(y + 195 * sy))
        star_y1 = int(round(y + 275 * sy))
        foot_y0 = int(round(y + 255 * sy))
        foot_y1 = int(round(y + 340 * sy))
        for _, (fy, fx, ftext) in enumerate(inv_lines):
            if tile_x - int(round(15 * sx)) <= fx <= tile_x + cw + int(round(15 * sx)):
                if star_y0 <= fy <= star_y1 and (re.fullmatch(r"\s*[0-9]\s*", ftext) or _MASTERY_LEVEL_RE.search(ftext)):
                    star_band_text = ftext
                if foot_y0 <= fy <= foot_y1 and (_MAX_WORD_RE.search(ftext) or _PROGRESS_RE.search(ftext) or _MASTERY_LEVEL_RE.search(ftext)):
                    footer_text = ftext

        cards.append(_build_card_entry(hit, frame, tile_rect, footer_text, star_band_text=star_band_text))
        seen_slugs.add(hit.slug)

    return {
        "active_slots": active_slots,
        "active_preset": active_preset,
        "cards": cards,
    }


def parse_cards_page(
    frame: np.ndarray,
    *,
    lines_fn: Callable[[list[np.ndarray]], list[list[tuple[int, int, str]]]] | None = None,
    timeout: float = 6.0,
) -> dict[str, Any]:
    """Parse the Cards INVENTORY screen: active slots, active preset, and visible card tiles."""
    if frame is None or frame.ndim != 3:
        raise ValueError("Valid frame required")

    if lines_fn is not None:
        batches = lines_fn([frame])
        lines = batches[0] if batches else []
        return _parse_cards_from_lines(frame, lines)

    fh, fw = frame.shape[:2]
    sx, sy = fw / REF_W, fh / REF_H
    tiles = _detect_card_grid_tiles(frame)
    if not tiles:
        batches = ocr.read_lines([frame], scale=1.5, timeout=timeout)
        lines = batches[0] if batches else []
        return _parse_cards_from_lines(frame, lines)

    # Batch-OCR: [0] ACTIVE header, [1] optional active preset pill, then (title, star_band, footer) per tile
    crops: list[np.ndarray] = []
    ax, ay, aw, ah = detectors.scale_rect(REF_CARDS_ACTIVE_SLOTS_BOX, frame.shape)
    crops.append(frame[ay : ay + ah, ax : ax + aw])

    active_pill_rect: tuple[int, int, int, int] | None = None
    for rect, is_active in screens._detect_preset_pills(frame, screens.REF_CARDS_PRESET_BAND, min_w_ref=130, max_w_ref=240):
        if is_active:
            active_pill_rect = rect
            break
    has_pill_crop = active_pill_rect is not None
    if active_pill_rect is not None:
        px, py, pw, ph = active_pill_rect
        crops.append(frame[py : py + ph, px : px + pw])

    pad_t = max(2, int(round(5 * sy)))
    title_h = max(12, int(round(49 * sy)))
    pad_x = max(2, int(round(4 * sx)))
    star_pad_x = max(2, int(round(8 * sx)))
    star_y0_off = int(round(221 * sy))
    star_y1_off = int(round(294 * sy))
    foot_pad_x = max(4, int(round(20 * sx)))
    foot_offset = int(round(292 * sy))
    foot_h = max(12, int(round(56 * sy)))

    for tx, ty, tw, th in tiles:
        tc = frame[max(0, ty + pad_t) : min(fh, ty + title_h), max(0, tx + pad_x) : min(fw, tx + tw - pad_x)]
        sy0 = min(fh - 1, ty + star_y0_off)
        sy1 = min(fh, ty + star_y1_off)
        sx0 = max(0, tx + star_pad_x)
        sx1 = min(fw, tx + tw - star_pad_x)
        sc = frame[sy0:sy1, sx0:sx1] if (sy1 - sy0 >= 8 and sx1 - sx0 >= 8) else np.zeros((0, 0, 3), dtype=np.uint8)
        fy0 = min(fh - 1, ty + foot_offset)
        fy1 = min(fh, fy0 + foot_h)
        fx0 = max(0, tx + foot_pad_x)
        fx1 = min(fw, tx + tw - foot_pad_x)
        fc = frame[fy0:fy1, fx0:fx1] if (fy1 - fy0 >= 8 and fx1 - fx0 >= 8) else np.zeros((0, 0, 3), dtype=np.uint8)
        crops.extend([tc, sc, fc])

    texts = ocr.read_texts(crops, scale=2.5, timeout=timeout)

    active_slots: str | None = None
    if texts:
        m = _SLOTS_RE.search(texts[0])
        if m:
            active_slots = m.group(1).replace(" ", "")

    offset = 1
    active_preset: str | None = None
    if has_pill_crop:
        if len(texts) > 1:
            m_pre = _PRESET_RE.search(texts[1])
            if m_pre:
                active_preset = " ".join(m_pre.group(1).split()).title()
        offset = 2

    cards: list[dict[str, Any]] = []
    seen_slugs: set[str] = set()
    for idx, tile_rect in enumerate(tiles):
        t_idx = offset + 3 * idx
        title_txt = texts[t_idx] if t_idx < len(texts) else ""
        star_txt = texts[t_idx + 1] if (t_idx + 1) < len(texts) else ""
        foot_txt = texts[t_idx + 2] if (t_idx + 2) < len(texts) else ""
        hit = _match_card_phrase(title_txt)
        if hit is None or hit.slug in seen_slugs:
            continue
        cards.append(_build_card_entry(hit, frame, tile_rect, foot_txt, star_band_text=star_txt))
        seen_slugs.add(hit.slug)

    return {
        "active_slots": active_slots,
        "active_preset": active_preset,
        "cards": cards,
    }


# --- Pure Modules Equipped Slots Parser (OCR + HSV) ----------------------

def _detect_rarity_ring(patch: np.ndarray) -> str:
    """Classify a module slot's rarity color ring via HSV hue voting."""
    if patch is None or patch.size == 0:
        return ""
    hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
    mask = (hsv[..., 1] >= 100) & (hsv[..., 2] >= 125)
    hvals = hsv[..., 0][mask]
    if hvals.size < max(25, int(patch.shape[0] * patch.shape[1] * 0.004)):
        return ""

    counts = {
        "Ancestral": int(np.sum((hvals >= 42) & (hvals <= 85))),
        "Mythic": int(np.sum((hvals <= 10) | (hvals >= 170))),
        "Legendary": int(np.sum((hvals >= 11) & (hvals <= 30))),
        "Epic": int(np.sum((hvals >= 130) & (hvals <= 168))),
        "Rare": int(np.sum((hvals >= 95) & (hvals <= 128))),
    }
    best_rarity, best_cnt = max(counts.items(), key=lambda kv: kv[1])
    return best_rarity if best_cnt >= max(20, int(hvals.size * 0.15)) else ""


def _enhance_level_crop(crop: np.ndarray) -> np.ndarray:
    """Isolate bright white/orange Lv text on white canvas so WinRT OCR reads colored levels."""
    if crop is None or crop.size == 0:
        return crop
    # Both white (Ancestral/Mythic) and orange (Legendary) Lv text have high R channel (>185),
    # while the dark navy/teal background stays low (<50).
    r = crop[:, :, 2]
    mask = (r > 185).astype(np.uint8) * 255
    inv = cv2.copyMakeBorder(255 - mask, 24, 24, 24, 24, cv2.BORDER_CONSTANT, value=255)
    return cv2.cvtColor(inv, cv2.COLOR_GRAY2BGR)


def parse_modules_equipped(
    frame: np.ndarray,
    *,
    ocr_fn: Callable[[list[np.ndarray]], list[str]] | None = None,
    timeout: float = 4.0,
) -> dict[str, Any]:
    """Read the 4 equipped module slots (cannon/armor/generator/core): rect, center, level, rarity."""
    if frame is None or frame.ndim != 3:
        raise ValueError("Valid frame required")

    fh, fw = frame.shape[:2]
    slot_rects: dict[str, tuple[int, int, int, int]] = {}
    rarities: dict[str, str] = {}
    raw_level_crops: list[np.ndarray] = []

    for slot in MODULE_SLOT_ORDER:
        rx, ry, rw, rh = detectors.scale_rect(REF_MODULE_SLOTS[slot], frame.shape)
        slot_rects[slot] = (rx, ry, rw, rh)
        ring_h = max(10, int(round(rh * 0.78)))
        rarities[slot] = _detect_rarity_ring(frame[ry : min(fh, ry + ring_h), rx : min(fw, rx + rw)])

        lx, ly, lw, lh = detectors.scale_rect(REF_MODULE_LEVEL_BOXES[slot], frame.shape)
        raw_level_crops.append(frame[ly : min(fh, ly + lh), lx : min(fw, lx + lw)])

    levels: dict[str, int | None] = {slot: None for slot in MODULE_SLOT_ORDER}
    active_preset: str | None = None

    if ocr_fn is not None:
        texts = ocr_fn(raw_level_crops)
        for slot, txt in zip(MODULE_SLOT_ORDER, texts):
            levels[slot] = _parse_level_int(txt)
    else:
        # Single batch: 4 raw level crops + 4 enhanced-V level crops + optional active preset pill
        enhanced = [_enhance_level_crop(c) for c in raw_level_crops]
        batch = raw_level_crops + enhanced

        active_pill_rect: tuple[int, int, int, int] | None = None
        for rect, is_active in screens._detect_preset_pills(frame, screens.REF_MODULES_PRESET_BAND, min_w_ref=350, max_w_ref=560):
            if is_active:
                active_pill_rect = rect
                break
        if active_pill_rect is not None:
            px, py, pw, ph = active_pill_rect
            batch.append(frame[py : py + ph, px : px + pw])

        texts = ocr.read_texts(batch, scale=2.5, timeout=timeout)
        for idx, slot in enumerate(MODULE_SLOT_ORDER):
            lv_raw = _parse_level_int(texts[idx] if idx < len(texts) else "")
            lv_enh = _parse_level_int(texts[4 + idx] if (4 + idx) < len(texts) else "")
            levels[slot] = lv_raw if lv_raw is not None else lv_enh
        if active_pill_rect is not None and len(texts) > 8:
            m_pre = _PRESET_RE.search(texts[8])
            if m_pre:
                active_preset = " ".join(m_pre.group(1).split()).title()

    slots_out: dict[str, dict[str, Any]] = {}
    for slot in MODULE_SLOT_ORDER:
        rx, ry, rw, rh = slot_rects[slot]
        slots_out[slot] = {
            "rect": (rx, ry, rw, rh),
            "center": (rx + rw // 2, ry + rh // 2),
            "level": levels[slot],
            "rarity": rarities[slot],
        }

    return {
        "active_preset": active_preset,
        "slots": slots_out,
    }


def _module_tile_signature(patch: np.ndarray) -> np.ndarray:
    """Compact 16x16 grayscale inner-icon fingerprint for deduplicating identical fodder copies."""
    if patch is None or patch.size == 0:
        return np.zeros((16, 16), dtype=np.float32)
    h, w = patch.shape[:2]
    inner = patch[int(h * 0.22) : max(int(h * 0.22) + 1, int(h * 0.78)), int(w * 0.22) : max(int(w * 0.22) + 1, int(w * 0.78))]
    gray = cv2.cvtColor(inner, cv2.COLOR_BGR2GRAY) if inner.ndim == 3 else inner
    return cv2.resize(gray, (16, 16), interpolation=cv2.INTER_AREA).astype(np.float32)


def is_duplicate_module_sig(
    rarity: str,
    sig: np.ndarray,
    seen_sigs: list[tuple[str, np.ndarray]],
    *,
    threshold: float = 14.0,
) -> bool:
    """Return True if an identical (rarity, icon) tile was already inspected during this sweep."""
    for prev_rar, prev_sig in seen_sigs:
        if prev_rar == rarity and prev_sig.shape == sig.shape:
            if float(np.mean(np.abs(prev_sig - sig))) < threshold:
                return True
    return False


def detect_module_inventory_tiles(
    frame: np.ndarray,
    *,
    min_rarities: frozenset[str] = MODULE_EPIC_PLUS_RARITIES,
) -> dict[str, Any]:
    """Detect fully visible Epic+ module tiles in the 5-column Modules Inventory grid.

    Skips lower-tier Rare (blue) and Common (grey) fodder tiles and reports `has_lower_tier=True`
    once lower-tier tiles appear so callers can stop scrolling the descending-rarity list.
    """
    if frame is None or frame.ndim != 3:
        return {"tiles": [], "has_lower_tier": False, "total_tiles": 0}

    fh, fw = frame.shape[:2]
    sx, sy = fw / REF_W, fh / REF_H
    inv_y0 = max(0, int(round(REF_MODULE_INV_Y0 * sy)))
    inv_y1 = min(fh, int(round(REF_MODULE_INV_Y1 * sy)))
    tile_w = max(20, int(round(REF_MODULE_INV_TILE_W * sx)))
    tile_h = max(20, int(round(REF_MODULE_INV_TILE_H * sy)))
    if inv_y1 - inv_y0 < tile_h:
        return {"tiles": [], "has_lower_tier": False, "total_tiles": 0}

    inv = frame[inv_y0:inv_y1, :]
    hsv = cv2.cvtColor(inv, cv2.COLOR_BGR2HSV)
    active = ((hsv[..., 1] >= 75) & (hsv[..., 2] >= 110)).astype(np.float32)
    # Also allow bright grey Common tiles to contribute weak row energy so lower-tier rows are detected
    bright_grey = ((hsv[..., 1] < 60) & (hsv[..., 2] >= 145)).astype(np.float32) * 0.6
    row_energy = np.maximum(active, bright_grey).mean(axis=1)

    scores: list[tuple[float, int]] = []
    gap_px = max(4, int(round(10 * sy)))
    for rel_y in range(0, inv.shape[0] - tile_h + 1):
        inside = float(row_energy[rel_y : rel_y + tile_h].mean())
        if inside < 0.12:
            continue
        top_gap = float(row_energy[max(0, rel_y - gap_px) : rel_y].mean()) if rel_y >= 4 else 0.0
        bot_gap = (
            float(row_energy[rel_y + tile_h : min(inv.shape[0], rel_y + tile_h + gap_px)].mean())
            if rel_y + tile_h + 4 <= inv.shape[0]
            else 0.0
        )
        scores.append((inside - 0.6 * (top_gap + bot_gap), rel_y))

    scores.sort(reverse=True)
    min_row_gap = max(20, int(round(170 * sy)))
    row_ys: list[int] = []
    for _, ry in scores:
        if all(abs(ry - prev) >= min_row_gap for prev in row_ys):
            row_ys.append(ry)
    row_ys.sort()

    col_xs = [int(round(c * sx)) for c in REF_MODULE_INV_COLS]
    tiles: list[dict[str, Any]] = []
    has_lower_tier = False
    total_tiles = 0

    for rel_y in row_ys:
        ay = inv_y0 + rel_y
        if ay + tile_h > inv_y1:
            continue
        for cx in col_xs:
            if cx < 0 or cx + tile_w > fw:
                continue
            patch = frame[ay : ay + tile_h, cx : cx + tile_w]
            rar = _detect_rarity_ring(patch)
            if rar in min_rarities:
                total_tiles += 1
                tiles.append(
                    {
                        "rect": (cx, ay, tile_w, tile_h),
                        "center": (cx + tile_w // 2, ay + tile_h // 2),
                        "rarity": rar,
                        "sig": _module_tile_signature(patch),
                    }
                )
            elif rar == "Rare":
                total_tiles += 1
                has_lower_tier = True
            else:
                # Check if an unsaturated bright Common tile occupies this slot
                p_hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
                grey_ratio = float(np.count_nonzero((p_hsv[..., 1] < 55) & (p_hsv[..., 2] >= 145))) / float(patch.shape[0] * patch.shape[1])
                if grey_ratio >= 0.09:
                    total_tiles += 1
                    has_lower_tier = True

    return {
        "tiles": tiles,
        "has_lower_tier": has_lower_tier,
        "total_tiles": total_tiles,
    }


# --- Pure Module Detail Popup Parser -------------------------------------

def _is_static_modules_chrome(y: int, text: str, sy: float) -> bool:
    """Ignore dimmed background chrome labels on the base Modules screen."""
    up = " ".join(text.strip().upper().split())
    if int(round(310 * sy)) <= y <= int(round(420 * sy)) and up == "BUY MODULE":
        return True
    if int(round(980 * sy)) <= y <= int(round(1085 * sy)) and up in ("MERGE", "SHATTER", "INVENTORY MERGE SHATTER"):
        return True
    return False


def parse_module_detail(
    frame: np.ndarray,
    *,
    lines_fn: Callable[[list[np.ndarray]], list[list[tuple[int, int, str]]]] | None = None,
    timeout: float = 4.0,
) -> dict[str, Any] | None:
    """Parse an opened Module Detail popup; flag forbidden prompts even without a module match."""
    if frame is None or frame.ndim != 3:
        raise ValueError("Valid frame required")

    reader = lines_fn if lines_fn is not None else (lambda items: ocr.read_lines(items, scale=1.5, timeout=timeout))
    batches = reader([frame])
    lines = batches[0] if batches else []
    if not lines:
        return None

    fh, fw = frame.shape[:2]
    sx, sy = fw / REF_W, fh / REF_H

    hit: wiki.IndexItem | None = None
    name_y: int | None = None
    rarity = ""
    level: int | None = None
    substats: list[str] = []
    close_center: tuple[int, int] | None = None
    popup_lines: list[str] = []
    forbidden_hits: list[str] = []

    top_bar_y = int(round(200 * sy))
    body_lines: list[tuple[int, int, str]] = []

    for y, x, text in lines:
        cleaned = " ".join(str(text).strip().split())
        if not cleaned:
            continue

        iy = int(y)
        is_chrome = _is_static_modules_chrome(iy, cleaned, sy)
        if not is_chrome:
            popup_lines.append(cleaned)
            if screens.is_forbidden_label(cleaned) or screens._has_promo_text(cleaned):
                if cleaned not in forbidden_hits:
                    forbidden_hits.append(cleaned)

        # Ignore top currency/ticket status bar (e.g. '10' tickets) for popup fields
        if iy < top_bar_y:
            continue
        body_lines.append((iy, int(x), cleaned))

        # Detect close 'X' button in top-right popup region
        if close_center is None and cleaned.upper() in ("X", "×", "✕") and x >= int(round(680 * sx)) and iy <= int(round(900 * sy)):
            close_center = (int(x), iy)

        if hit is None:
            for phrase in _candidate_phrases(cleaned):
                if wiki.match_name(phrase, category="topic", exact_only=True) is not None:
                    break
                cand = wiki.match_name(phrase, category="module", exact_only=True) or wiki.match_name(phrase, category="module")
                if cand is not None:
                    hit = cand
                    name_y = iy
                    break

    # Fallback: join adjacent vertically stacked title lines in case a module name wrapped
    if hit is None and len(body_lines) >= 2:
        max_dy = max(12, int(round(60 * sy)))
        for idx in range(len(body_lines) - 1):
            y1, _x1, t1 = body_lines[idx]
            y2, _x2, t2 = body_lines[idx + 1]
            if 0 <= (y2 - y1) <= max_dy:
                joined_title = f"{t1} {t2}"
                for phrase in _candidate_phrases(joined_title):
                    if wiki.match_name(phrase, category="topic", exact_only=True) is not None:
                        break
                    cand = wiki.match_name(phrase, category="module", exact_only=True) or wiki.match_name(phrase, category="module")
                    if cand is not None:
                        hit = cand
                        name_y = y2
                        break
            if hit is not None:
                break

    # Extract rarity & level relative to the popup title (`name_y`) so dimmed background
    # equipped slot levels (e.g. Cannon Lv.137 at y=582) never bleed into inventory popups.
    rar_min_y = (name_y - int(round(160 * sy))) if name_y is not None else top_bar_y
    rar_max_y = (name_y + int(round(200 * sy))) if name_y is not None else fh
    lv_min_y = name_y if name_y is not None else top_bar_y
    for iy, _ix, cleaned in body_lines:
        if not rarity and rar_min_y <= iy <= rar_max_y:
            m_rar = _RARITY_RE.search(cleaned)
            if m_rar:
                rarity = _normalize_rarity(m_rar.group(1))
        if level is None and iy >= lv_min_y:
            lv = _parse_level_int(cleaned, strict=True, max_val=500)
            if lv is None:
                m_sl = _LEVEL_SLASH_RE.search(cleaned)
                if m_sl:
                    cand_lv, cand_cap = int(m_sl.group(1)), int(m_sl.group(2))
                    if 1 <= cand_lv <= 500 and cand_cap >= 40:
                        lv = cand_lv
            if lv is not None:
                level = lv

    popup_text = "\n".join(popup_lines)
    forbidden = bool(forbidden_hits)
    forbidden_text = " | ".join(forbidden_hits)

    if hit is None:
        if forbidden:
            return {
                "slug": None,
                "name": "",
                "slot": "",
                "rarity": rarity,
                "level": level,
                "substats": [],
                "close_center": close_center,
                "forbidden": True,
                "forbidden_text": forbidden_text,
                "popup_text": popup_text,
                "raw_text": popup_text,
            }
        # Generic / fodder module detail popup (e.g. Solar Dyson Sphere): open modal, not in 28-module catalog
        has_modal_chrome = bool(
            close_center is not None
            or re.search(r"\b(?:EQUIP|UNEQUIP|RESTORE|SUB-?MODULE|FAVORITE)\b", popup_text, re.IGNORECASE)
        )
        if has_modal_chrome and (rarity or level is not None or close_center is not None):
            return {
                "slug": None,
                "name": "",
                "slot": "",
                "rarity": rarity,
                "level": level,
                "substats": [],
                "close_center": close_center,
                "forbidden": False,
                "forbidden_text": "",
                "non_unique": True,
                "popup_text": popup_text,
                "raw_text": popup_text,
            }
        return None

    # Collect substat lines (e.g. "+5% Attack Speed", "+0.4x Coins/Kill Bonus", "+12% Crit Factor")
    seen_sub: set[str] = set()
    for y, _, text in lines:
        cleaned = " ".join(str(text).strip().split())
        if not cleaned or len(cleaned) > 64:
            continue
        if name_y is not None and y <= name_y:
            continue
        if _LEVEL_RE.search(cleaned) or _LEVEL_SLASH_RE.fullmatch(cleaned):
            continue
        if re.search(r"\b(UNIQUE\s+EFFECT|EQUIP|UNEQUIP|RESTORE|FAVORITE|REROLL|LEVEL\s+UP|UPGRADE|BUY|MERGE|SHATTER)\b", cleaned, re.IGNORECASE):
            continue
        # Sub-module stats begin with '+' or '-' and are not prose sentences from Unique Effect descriptions
        if (
            cleaned.startswith(("+", "-"))
            and not cleaned.endswith(".")
            and ". " not in cleaned
            and _SUBSTAT_RE.search(cleaned)
            and re.search(r"[A-Za-z]{2,}", cleaned)
        ):
            key = cleaned.lower()
            if key not in seen_sub:
                seen_sub.add(key)
                substats.append(cleaned)

    return {
        "slug": hit.slug,
        "name": hit.name,
        "slot": hit.slot,
        "rarity": rarity,
        "level": level,
        "substats": substats,
        "close_center": close_center,
        "forbidden": forbidden,
        "forbidden_text": forbidden_text,
        "popup_text": popup_text,
        "raw_text": popup_text,
    }


# --- Enriched Thread-Safe AccountStore -----------------------------------

def _preset_sort_key(name: str) -> tuple[int, str]:
    m = re.search(r"(\d+)", name)
    return (int(m.group(1)), name) if m else (999, name)


class AccountStore:
    """Thread-safe local JSON store (`data/account.json`, git-ignored) for observed loadout."""

    def __init__(self, path: Path = DEFAULT_ACCOUNT_PATH) -> None:
        self._path = path
        self._lock = threading.RLock()

    @staticmethod
    def _empty() -> dict[str, Any]:
        return {
            "updated_at": None,
            "last_screen": None,
            "last_tier": None,
            "active_card_slots": None,
            "presets": [],
            "card_presets": {},
            "module_presets": {},
            "items": {},
        }

    def _read_unlocked(self) -> dict[str, Any]:
        if not self._path.is_file():
            return self._empty()
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            if isinstance(raw, dict) and isinstance(raw.get("items"), dict):
                base = self._empty()
                base.update(raw)
                if not isinstance(base.get("card_presets"), dict):
                    base["card_presets"] = {}
                if not isinstance(base.get("module_presets"), dict):
                    base["module_presets"] = {}
                return base
        except (OSError, json.JSONDecodeError):
            pass
        return self._empty()

    def _write_unlocked(self, data: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(data, ensure_ascii=False, indent=2)
        fd, tmp_name = tempfile.mkstemp(prefix=".account_", suffix=".tmp", dir=str(self._path.parent))
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(text)
            os.replace(tmp_name, self._path)
        except BaseException:
            try:
                os.remove(tmp_name)
            except OSError:
                pass
            raise

    def _build_catalog(self, data: dict[str, Any]) -> tuple[dict[str, list[dict[str, Any]]], dict[str, int]]:
        items_by_slug: dict[str, dict[str, Any]] = data.get("items") or {}
        card_presets: dict[str, list[str]] = data.get("card_presets") or {}
        module_presets: dict[str, dict[str, Any]] = data.get("module_presets") or {}

        # Build reverse equipped_in maps
        card_equipped_in: dict[str, list[str]] = {}
        for preset, slugs in card_presets.items():
            if not isinstance(slugs, list):
                continue
            for slug in slugs:
                card_equipped_in.setdefault(slug, []).append(preset)

        mod_equipped_in: dict[str, list[str]] = {}
        for preset, slot_map in module_presets.items():
            if not isinstance(slot_map, dict):
                continue
            for entry in slot_map.values():
                if isinstance(entry, dict) and entry.get("slug"):
                    mod_equipped_in.setdefault(str(entry["slug"]), []).append(preset)

        master = wiki.master_catalog()
        merged: dict[str, list[dict[str, Any]]] = {"cards": [], "modules": [], "uws": [], "uw_plus": [], "workshop": []}

        for group_key in ("cards", "modules", "uws", "uw_plus", "workshop"):
            for base in master[group_key]:
                slug = base["slug"]
                obs = items_by_slug.get(slug)
                owned = obs is not None
                eq_src = card_equipped_in if group_key == "cards" else (mod_equipped_in if group_key == "modules" else {})
                equipped_in = sorted(set(eq_src.get(slug, [])), key=_preset_sort_key)

                obs_rarity = (obs.get("rarity") or "") if obs else ""
                rarity = obs_rarity or base.get("rarity", "")
                level = obs.get("level") if obs else None
                stars = obs.get("stars") if obs else None
                maxed = bool(obs.get("maxed")) if obs else False
                mastery_unlocked = bool(obs.get("mastery_unlocked")) if obs else False
                mastery_level = obs.get("mastery_level") if obs else None
                progress = (obs.get("progress") or "") if obs else ""
                detail = (obs.get("detail") or "") if obs else ""
                substats = list(obs.get("substats") or []) if obs else []
                last_seen = obs.get("last_seen") if obs else None

                merged[group_key].append(
                    {
                        "slug": slug,
                        "name": base["name"],
                        "category": base["category"],
                        "aliases": list(base["aliases"]),
                        "slot": base.get("slot", ""),
                        "rarity": rarity,
                        "owned": owned,
                        "level": level,
                        "stars": stars,
                        "maxed": maxed,
                        "mastery_unlocked": mastery_unlocked,
                        "mastery_level": mastery_level,
                        "progress": progress,
                        "detail": detail,
                        "equipped_in": equipped_in,
                        "substats": substats,
                        "last_seen": last_seen,
                    }
                )

        counts = {
            "cards_owned": sum(1 for it in merged["cards"] if it["owned"]),
            "cards_total": len(merged["cards"]),
            "cards_mastered": sum(1 for it in merged["cards"] if it["mastery_unlocked"]),
            "modules_owned": sum(1 for it in merged["modules"] if it["owned"]),
            "modules_total": len(merged["modules"]),
            "uws_owned": sum(1 for it in merged["uws"] if it["owned"]),
            "uws_total": len(merged["uws"]),
            "uw_plus_owned": sum(1 for it in merged["uw_plus"] if it["owned"]),
            "uw_plus_total": len(merged["uw_plus"]),
            "workshop_owned": sum(1 for it in merged["workshop"] if it["owned"]),
            "workshop_total": len(merged["workshop"]),
        }
        return merged, counts

    def snapshot(self, include_catalog: bool = True) -> dict[str, Any]:
        with self._lock:
            data = self._read_unlocked()
        grouped: dict[str, list[dict[str, Any]]] = {"card": [], "module": [], "uw": [], "workshop": [], "enemy": []}
        for item in data["items"].values():
            cat = item.get("category")
            if cat in grouped:
                grouped[cat].append(item)
        for items in grouped.values():
            items.sort(key=lambda it: it.get("name", ""))

        catalog_data, counts = self._build_catalog(data)
        out: dict[str, Any] = {
            "updated_at": data.get("updated_at"),
            "last_screen": data.get("last_screen"),
            "last_tier": data.get("last_tier"),
            "active_card_slots": data.get("active_card_slots"),
            "presets": list(data.get("presets") or []),
            "card_presets": {k: list(v) for k, v in (data.get("card_presets") or {}).items()},
            "module_presets": {
                k: {sk: dict(sv) for sk, sv in v.items()} if isinstance(v, dict) else {}
                for k, v in (data.get("module_presets") or {}).items()
            },
            "cards": grouped["card"],
            "modules": grouped["module"],
            "uws": grouped["uw"],
            "workshop": grouped["workshop"],
            "enemies": grouped["enemy"],
            "total_items": len(data["items"]),
            "counts": counts,
        }
        if include_catalog:
            out["catalog"] = catalog_data
        return out

    def merge_observation(self, obs: dict[str, Any]) -> dict[str, Any]:
        # Never mutate base account unlocks from a live battle HUD frame
        if str(obs.get("screen") or "").strip().lower() == "battle":
            return self.snapshot()
        with self._lock:
            data = self._read_unlocked()
            now = obs.get("observed_at") or round(time.time(), 1)
            data["updated_at"] = now
            data["last_screen"] = obs.get("screen")
            if obs.get("tier") is not None:
                data["last_tier"] = obs["tier"]

            existing_presets = list(data.get("presets") or [])
            for p in obs.get("presets") or []:
                if p not in existing_presets:
                    existing_presets.append(p)
            data["presets"] = existing_presets

            for item in obs.get("items") or []:
                slug = item["slug"]
                meta = wiki.BY_SLUG.get(slug)
                prev = data["items"].get(slug) or {}
                detail = item.get("detail") or prev.get("detail") or ""
                m_rar = _RARITY_RE.search(detail)
                rarity = _normalize_rarity(m_rar.group(1)) if m_rar else (prev.get("rarity") or "")
                lv = _parse_level_int(detail, strict=True, max_val=5000)
                if lv is None:
                    lv = prev.get("level")
                if item["category"] == "module":
                    lv = None  # modules have no level; only the player's slot does
                maxed = bool(re.search(r"\bMAX\b", detail, re.IGNORECASE)) or bool(prev.get("maxed"))
                merged_item = dict(prev)
                merged_item.update(
                    {
                        "slug": slug,
                        "name": item["name"],
                        "category": item["category"],
                        "slot": (meta.slot if meta else prev.get("slot", "")),
                        "owned": True,
                        "detail": detail,
                        "rarity": rarity,
                        "level": lv,
                        "maxed": maxed,
                        "last_seen": now,
                        "screen": obs.get("screen"),
                    }
                )
                data["items"][slug] = merged_item

            self._write_unlocked(data)
        return self.snapshot()

    def record_cards_scan(
        self,
        preset_name: str | None,
        cards: list[dict[str, Any]],
        *,
        active_slots: str | None = None,
        replace_preset: bool = False,
    ) -> dict[str, Any]:
        """Merge scanned card tiles into inventory and update per-preset equipped slugs."""
        with self._lock:
            data = self._read_unlocked()
            now = round(time.time(), 1)
            data["updated_at"] = now
            data["last_screen"] = "cards"
            if active_slots:
                data["active_card_slots"] = str(active_slots).strip()

            clean_preset = " ".join(preset_name.strip().split()) if preset_name else None
            if clean_preset:
                if clean_preset not in data["presets"]:
                    data["presets"].append(clean_preset)
                    data["presets"].sort(key=_preset_sort_key)
                if replace_preset or clean_preset not in data["card_presets"]:
                    data["card_presets"][clean_preset] = []
                equipped_list: list[str] = list(data["card_presets"][clean_preset])
            else:
                equipped_list = []

            for card in cards or []:
                slug = card.get("slug")
                item_meta = wiki.BY_SLUG.get(slug) if slug else None
                if item_meta is None and card.get("name"):
                    item_meta = wiki.match_name(str(card["name"]), category="card")
                    slug = item_meta.slug if item_meta is not None else slug
                if not slug:
                    continue
                name = card.get("name") or (item_meta.name if item_meta else slug)
                prev = data["items"].get(slug) or {}

                raw_progress = str(card.get("progress") or "").strip()
                explicit_non_max = bool(_PROGRESS_RE.search(raw_progress)) and not bool(card.get("maxed"))

                if explicit_non_max:
                    # Allow a clean non-maxed rescan (e.g. '5/32') to correct any prior OCR false positive
                    maxed = False
                    raw_stars = card.get("stars")
                    stars = int(raw_stars) if raw_stars is not None else (prev.get("stars") or None)
                    mastery_unlocked = False
                    mastery_level: int | None = None
                    progress = raw_progress
                else:
                    maxed = bool(card.get("maxed")) or bool(prev.get("maxed"))
                    raw_stars = card.get("stars")
                    prev_stars = prev.get("stars") or 0
                    stars = max(int(prev_stars), int(raw_stars)) if raw_stars is not None else (int(prev_stars) or None)
                    if maxed and (stars is None or stars < 7):
                        stars = 7

                    raw_mlvl = card.get("mastery_level")
                    prev_mlvl = prev.get("mastery_level")
                    if raw_mlvl is not None:
                        mastery_level = int(raw_mlvl)
                        mastery_unlocked = True
                    elif card.get("mastery_unlocked") is True:
                        mastery_unlocked = True
                        mastery_level = int(prev_mlvl) if prev_mlvl is not None else None
                    else:
                        mastery_unlocked = bool(prev.get("mastery_unlocked"))
                        mastery_level = int(prev_mlvl) if prev_mlvl is not None else None
                    if mastery_unlocked:
                        maxed = True
                        stars = 7
                    progress = "Max" if maxed else (raw_progress or prev.get("progress") or "")
                bits = [f"{stars}★"] if stars else []
                if mastery_unlocked and mastery_level is not None:
                    bits.append(f"M{mastery_level}")
                elif progress:
                    bits.append(progress)
                level_text = " ".join(bits)
                detail = level_text or prev.get("detail") or ""

                merged_item = dict(prev)
                merged_item.update(
                    {
                        "slug": slug,
                        "name": name,
                        "category": "card",
                        "owned": True,
                        "maxed": maxed,
                        "stars": stars,
                        "mastery_unlocked": mastery_unlocked,
                        "mastery_level": mastery_level,
                        "progress": progress,
                        "detail": detail,
                        "last_seen": now,
                        "screen": "cards",
                    }
                )
                data["items"][slug] = merged_item

                if clean_preset:
                    eq = card.get("equipped")
                    if eq is True and slug not in equipped_list:
                        equipped_list.append(slug)
                    elif eq is False and slug in equipped_list:
                        equipped_list.remove(slug)

            if clean_preset:
                data["card_presets"][clean_preset] = equipped_list

            self._write_unlocked(data)
        return self.snapshot()

    @staticmethod
    def _best_rarity(new_rarity: str, prev_rarity: str) -> str:
        if not new_rarity:
            return prev_rarity
        if not prev_rarity:
            return new_rarity
        nr = _MODULE_RARITY_RANK.get(new_rarity.strip().lower(), -1)
        pr = _MODULE_RARITY_RANK.get(prev_rarity.strip().lower(), -1)
        return new_rarity if nr >= pr else prev_rarity

    def _upsert_module_item(
        self,
        data: dict[str, Any],
        *,
        slug: str,
        name: str,
        slot: str,
        rarity: str,
        substats: list[str],
        now: float,
        from_equipped: bool = False,
    ) -> None:
        # Modules carry no level of their own; only the player's slot has one (module_presets).
        prev = data["items"].get(slug) or {}
        prev_rarity = str(prev.get("rarity") or "")
        new_rank = _MODULE_RARITY_RANK.get(rarity.strip().lower(), -1) if rarity else -1
        prev_rank = _MODULE_RARITY_RANK.get(prev_rarity.strip().lower(), -1) if prev_rarity else -1
        is_better_or_eq = from_equipped or not prev or new_rank >= prev_rank
        eff_rarity = self._best_rarity(rarity, prev_rarity)
        prev_substats = list(prev.get("substats") or [])
        if substats and (is_better_or_eq or not prev_substats):
            eff_substats = substats
        else:
            eff_substats = prev_substats
        detail = eff_rarity

        merged_item = dict(prev)
        merged_item.update(
            {
                "slug": slug,
                "name": name or prev.get("name") or slug,
                "category": "module",
                "slot": slot or prev.get("slot") or "",
                "owned": True,
                "level": None,
                "rarity": eff_rarity,
                "substats": eff_substats,
                "detail": detail,
                "last_seen": now,
                "screen": "modules",
            }
        )
        data["items"][slug] = merged_item

    def record_module_item(self, info: dict[str, Any]) -> dict[str, Any]:
        """Record an owned unique module observed in the Modules Inventory grid (preserves highest rarity)."""
        with self._lock:
            data = self._read_unlocked()
            now = round(time.time(), 1)
            data["updated_at"] = now
            data["last_screen"] = "modules"

            slug = info.get("slug")
            item_meta = wiki.BY_SLUG.get(slug) if slug else None
            if item_meta is None and info.get("name"):
                item_meta = wiki.match_name(str(info["name"]), category="module")
                if item_meta is not None:
                    slug = item_meta.slug

            if slug and (item_meta is None or item_meta.category == "module"):
                name = info.get("name") or (item_meta.name if item_meta is not None else "")
                rarity = _normalize_rarity(str(info.get("rarity") or ""))
                if rarity.rstrip("+") in ("Rare", "Common"):
                    # Blue Rare / grey Common copies are fodder; the inventory tracks Epic+ only.
                    return self.snapshot()
                substats = [str(s).strip() for s in (info.get("substats") or []) if str(s).strip()]
                slot = (item_meta.slot if item_meta and item_meta.slot else str(info.get("slot") or "").strip().lower())
                self._upsert_module_item(
                    data,
                    slug=slug,
                    name=name,
                    slot=slot,
                    rarity=rarity,
                    substats=substats,
                    now=now,
                    from_equipped=False,
                )
                self._write_unlocked(data)
        return self.snapshot()

    def record_module_slot(
        self,
        preset_name: str | None,
        slot: str,
        info: dict[str, Any],
    ) -> dict[str, Any]:
        """Record an observed module slot (owned item + per-preset slot assignment)."""
        clean_slot = (slot or "").strip().lower()
        if not clean_slot:
            raise ValueError("slot is required")

        with self._lock:
            data = self._read_unlocked()
            now = round(time.time(), 1)
            data["updated_at"] = now
            data["last_screen"] = "modules"

            slug = info.get("slug")
            item_meta = wiki.BY_SLUG.get(slug) if slug else None
            if item_meta is None and info.get("name"):
                item_meta = wiki.match_name(str(info["name"]), category="module")
                if item_meta is not None:
                    slug = item_meta.slug

            name = info.get("name") or (item_meta.name if item_meta is not None else "")
            level = info.get("level")
            level = int(level) if level is not None else None
            rarity = _normalize_rarity(str(info.get("rarity") or ""))
            substats = [str(s).strip() for s in (info.get("substats") or []) if str(s).strip()]

            if slug:
                self._upsert_module_item(
                    data,
                    slug=slug,
                    name=name,
                    slot=(item_meta.slot if item_meta and item_meta.slot else clean_slot),
                    rarity=rarity,
                    substats=substats,
                    now=now,
                    from_equipped=True,
                )

            clean_preset = " ".join(preset_name.strip().split()) if preset_name else None
            if clean_preset:
                if clean_preset not in data["presets"]:
                    data["presets"].append(clean_preset)
                    data["presets"].sort(key=_preset_sort_key)
                slot_map = data["module_presets"].setdefault(clean_preset, {})
                prev_slot = slot_map.get(clean_slot) if isinstance(slot_map.get(clean_slot), dict) else {}
                slot_entry = {
                    "slug": slug or prev_slot.get("slug"),
                    "name": name or prev_slot.get("name") or "",
                    "slot": clean_slot,
                    "level": level if level is not None else prev_slot.get("level"),
                    "rarity": rarity or prev_slot.get("rarity") or "",
                    "substats": substats if substats else list(prev_slot.get("substats") or []),
                }
                slot_map[clean_slot] = slot_entry

            self._write_unlocked(data)
        return self.snapshot()

    def reset(self) -> dict[str, Any]:
        with self._lock:
            empty = self._empty()
            self._write_unlocked(empty)
        return self.snapshot()
