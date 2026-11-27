"""Stateless screen classifier, safety fence, and declarative menu navigation graph.

Zero-template OCR + HSV screen identification for off-battle menu screens
(`game_stats`, `home`, `cards`, `modules`) plus live `battle` detection and
fail-closed `unknown` handling for promo/unrecognized overlays.
"""
from __future__ import annotations

import re
from collections import deque
from collections.abc import Callable, Sequence, Set as AbstractSet
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np

from towerpilot import detectors, ocr

REF_W = detectors.REF_W
REF_H = detectors.REF_H

# Reference 1080x2560 layout regions (x, y, w, h)
REF_SCREEN_HEADER = (10, 85, 620, 110)
REF_HOME_DIFFICULTY_PANEL = (240, 1240, 600, 300)
REF_HOME_TIER_PREV = (365, 1367, 51, 66)
REF_HOME_TIER_NEXT = (664, 1367, 51, 66)
REF_HOME_LEFT_RAIL = (10, 215, 230, 1285)
REF_HOME_DEFAULT_TROPHY = (48, 344, 149, 149)

REF_NAV_HOME = (15, 2420, 140, 100)
REF_NAV_CARDS = (378, 2420, 140, 100)
REF_NAV_MODULES = (560, 2420, 140, 100)

REF_CARDS_ACTIVE_HDR = (300, 475, 480, 100)
REF_CARDS_INVENTORY_HDR = (300, 940, 480, 100)
REF_CARDS_PRESET_BAND = (0, 360, 1080, 115)
REF_CARDS_DEFAULT_PILLS: tuple[tuple[int, int, int, int], ...] = (
    (21, 382, 194, 77), (235, 385, 188, 72), (446, 385, 188, 72), (657, 385, 188, 72), (868, 385, 188, 72),
)

REF_MODULES_SUBTABS = (20, 985, 1040, 100)
REF_MODULES_PRESET_BAND = (0, 190, 1080, 110)
REF_MODULES_DEFAULT_PILLS: tuple[tuple[int, int, int, int], ...] = (
    (41, 209, 490, 77), (551, 212, 485, 72),
)

REF_STATS_DEFAULT_RETRY = (77, 1663, 447, 148)
REF_STATS_DEFAULT_HOME = (556, 1663, 448, 148)

# Hard denylist patterns: no menu target may ever carry these labels (Rule 2).
DENYLIST_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\$\s*\d"),
    re.compile(r"\b\d+\s*gems?\b", re.IGNORECASE),
    re.compile(r"\bBUY\b", re.IGNORECASE),
    re.compile(r"\bMERGE\b", re.IGNORECASE),
    re.compile(r"\bSHATTER\b", re.IGNORECASE),
    re.compile(r"\bCLAIM\b", re.IGNORECASE),
    re.compile(r"\bDISSONANT\b", re.IGNORECASE),
    re.compile(r"\bEXIT\s+BATTLE\b", re.IGNORECASE),
    re.compile(r"\bEND\s+ROUND\b", re.IGNORECASE),
    re.compile(r"\bSURRENDER\b", re.IGNORECASE),
    re.compile(r"\bQUIT\b", re.IGNORECASE),
)

_PROMO_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\b(EVENT\s+BOOST|SPECIAL\s+OFFER|LIMITED\s+OFFER|GET\s+ANOTHER\s+TICKET)\b", re.IGNORECASE),
    re.compile(r"\$\s*\d"),
)
_HIGHEST_WAVE_RE = re.compile(r"HIGHEST\s+WAVE\s*[:#-]?\s*([\d,]+)", re.IGNORECASE)
_PRESET_NUM_RE = re.compile(r"\bPRESET\s*(\d{1,2})\b", re.IGNORECASE)


@dataclass(frozen=True)
class Target:
    """Allowlisted, safety-fenced tap target on an identified off-battle screen."""

    name: str
    rect: tuple[int, int, int, int]
    label: str
    expects: tuple[str, ...]
    inset_px: int = 16

    @property
    def center(self) -> tuple[int, int]:
        x, y, w, h = self.rect
        return (x + w // 2, y + h // 2)


@dataclass(frozen=True)
class Screen:
    """Identified screen state, extracted facts, and validated tap targets."""

    name: str
    facts: dict[str, Any] = field(default_factory=dict)
    targets: dict[str, Target] = field(default_factory=dict)


@dataclass(frozen=True)
class NavEdge:
    """Directed transition between screens via an allowlisted target name."""

    src: str
    dst: str
    target_name: str
    requires_policy: str | None = None


# Declarative navigation graph: `battle` intentionally has ZERO outgoing edges.
NAV_EDGES: tuple[NavEdge, ...] = (
    NavEdge("game_stats", "home", "home"),
    NavEdge("game_stats", "battle", "retry"),
    NavEdge("home", "cards", "nav_cards"),
    NavEdge("home", "modules", "nav_modules"),
    NavEdge("home", "battle", "battle"),
    NavEdge("home", "tournament_modal", "tournament", requires_policy="tournament_capture_ready"),
    NavEdge("cards", "home", "nav_home"),
    NavEdge("cards", "modules", "nav_modules"),
    NavEdge("modules", "home", "nav_home"),
    NavEdge("modules", "cards", "nav_cards"),
)


def is_forbidden_label(text: str) -> bool:
    """Return True if `text` matches any spend, surrender, or danger-zone pattern."""
    return bool(text) and any(pat.search(text) is not None for pat in DENYLIST_PATTERNS)


def _has_promo_text(text: str) -> bool:
    return bool(text) and any(pat.search(text) is not None for pat in _PROMO_PATTERNS)


def parse_highest_wave(text: str) -> int | None:
    """Extract the Highest Wave integer from OCR text like 'Highest Wave: 9020'."""
    m = _HIGHEST_WAVE_RE.search(text or "")
    digits = m.group(1).replace(",", "") if m else ""
    return int(digits) if digits.isdigit() else None


def validate_target(
    screen_name: str,
    target: Target,
    frame_shape: tuple[int, ...] = (REF_H, REF_W, 3),
) -> bool:
    """Enforce hard label denylist and scaled coordinate safety fences."""
    if screen_name in ("battle", "unknown") or len(frame_shape) < 2:
        return False
    fh, fw = int(frame_shape[0]), int(frame_shape[1])
    x, y, w, h = target.rect
    if fh <= 0 or fw <= 0 or w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > fw or y + h > fh:
        return False
    if target.inset_px < 0 or is_forbidden_label(target.label) or is_forbidden_label(target.name):
        return False

    sx, sy = fw / REF_W, fh / REF_H
    if screen_name == "home":
        if target.name in ("battle", "resume"):
            return y + h <= int(round(2145 * sy))
        if target.name in ("tier_prev", "tier_next"):
            return int(round(1240 * sy)) <= y and y + h <= int(round(1540 * sy))
        if target.name == "tournament":
            return x + w <= int(round(260 * sx)) and int(round(200 * sy)) <= y and y + h <= int(round(1520 * sy))
        return target.name in ("nav_cards", "nav_modules") and y >= int(round(2400 * sy))
    if screen_name == "modules":
        if target.name.startswith("preset_"):
            return y >= int(round(190 * sy)) and y + h <= int(round(300 * sy))
        return target.name in ("nav_home", "nav_cards") and y >= int(round(2400 * sy))
    if screen_name == "cards":
        if target.name.startswith("preset_"):
            return y >= int(round(360 * sy)) and y + h <= int(round(475 * sy))
        return target.name in ("nav_home", "nav_modules") and y >= int(round(2400 * sy))
    if screen_name == "game_stats":
        return target.name in ("home", "retry") and y >= int(round(1500 * sy)) and y + h <= int(round(2050 * sy))
    return False


def _filter_targets(screen_name: str, raw: dict[str, Target], shape: tuple[int, ...]) -> dict[str, Target]:
    return {k: v for k, v in raw.items() if validate_target(screen_name, v, shape)}


def _crop(frame: np.ndarray, rect: tuple[int, int, int, int]) -> np.ndarray:
    x, y, w, h = rect
    return frame[y : y + h, x : x + w]


def _parse_tournament_pill(timer_text: str) -> tuple[bool, str | None]:
    cleaned = " ".join(timer_text.split()).strip()
    if not cleaned:
        return False, None
    upper = cleaned.upper()
    if re.search(r"\bNEXT\s+IN\b", upper):
        return False, cleaned
    return bool(re.search(r"\b(ENDS\s+IN|JOIN)\b", upper)), cleaned


def _build_home_screen(
    frame_shape: tuple[int, ...],
    *,
    btn_label: str,
    btn_rect: tuple[int, int, int, int],
    tier: int | None,
    highest_wave: int | None,
    tournament_open: bool,
    tournament_timer: str | None,
    trophy_rect: tuple[int, int, int, int] | None,
) -> Screen:
    sr = detectors.scale_rect
    btn_key = btn_label.lower()
    raw: dict[str, Target] = {
        btn_key: Target(btn_key, btn_rect, btn_label, ("battle",)),
        "tier_prev": Target("tier_prev", sr(REF_HOME_TIER_PREV, frame_shape), "<", ("home",)),
        "tier_next": Target("tier_next", sr(REF_HOME_TIER_NEXT, frame_shape), ">", ("home",)),
        "nav_cards": Target("nav_cards", sr(REF_NAV_CARDS, frame_shape), "CARDS", ("cards",)),
        "nav_modules": Target("nav_modules", sr(REF_NAV_MODULES, frame_shape), "MODULES", ("modules",)),
    }
    if tournament_open and trophy_rect is not None:
        raw["tournament"] = Target("tournament", trophy_rect, "TOURNAMENT", ("tournament_modal",))
    facts = {
        "tier": tier,
        "highest_wave": highest_wave,
        "has_resume": btn_label == "RESUME",
        "tournament_open": tournament_open,
        "tournament_timer": tournament_timer,
    }
    return Screen("home", facts, _filter_targets("home", raw, frame_shape))


def _build_loadout_screen(
    screen_name: str,
    pills: list[tuple[tuple[int, int, int, int], bool, str]],
    frame_shape: tuple[int, ...],
    *,
    fallback_active: str | None = None,
) -> Screen:
    sr = detectors.scale_rect
    raw: dict[str, Target] = {}
    active_preset: str | None = None
    labels: list[str] = []
    for rect, is_active, raw_label in pills:
        if is_forbidden_label(raw_label):
            continue
        m = _PRESET_NUM_RE.search(raw_label)
        if not m:
            continue
        slot_num = int(m.group(1))
        clean_label = f"Preset {slot_num}"
        tgt = Target(f"preset_{slot_num}", rect, clean_label, (screen_name,))
        if validate_target(screen_name, tgt, frame_shape):
            raw[tgt.name] = tgt
            labels.append(clean_label)
            if is_active and active_preset is None:
                active_preset = clean_label
    raw["nav_home"] = Target("nav_home", sr(REF_NAV_HOME, frame_shape), "HOME", ("home",))
    if screen_name == "cards":
        raw["nav_modules"] = Target("nav_modules", sr(REF_NAV_MODULES, frame_shape), "MODULES", ("modules",))
    else:
        raw["nav_cards"] = Target("nav_cards", sr(REF_NAV_CARDS, frame_shape), "CARDS", ("cards",))
    safe_fallback = fallback_active if fallback_active in labels else None
    facts = {"active_preset": active_preset or safe_fallback, "presets": labels}
    return Screen(screen_name, facts, _filter_targets(screen_name, raw, frame_shape))


def _detect_preset_pills(
    frame: np.ndarray,
    band_ref: tuple[int, int, int, int],
    *,
    min_w_ref: int,
    max_w_ref: int,
    min_h_ref: int = 45,
    max_h_ref: int = 105,
) -> list[tuple[tuple[int, int, int, int], bool]]:
    """Detect green-active / cyan-inactive preset pills inside `band_ref`."""
    bx, by, bw, bh = detectors.scale_rect(band_ref, frame.shape)
    band = frame[by : by + bh, bx : bx + bw]
    if band.size == 0:
        return []
    sx, sy = frame.shape[1] / REF_W, frame.shape[0] / REF_H
    min_w, max_w = max(10, int(round(min_w_ref * sx))), int(round(max_w_ref * sx))
    min_h, max_h = max(10, int(round(min_h_ref * sy))), int(round(max_h_ref * sy))
    pad = max(4, int(round(14 * min(sx, sy))))

    hsv = cv2.cvtColor(band, cv2.COLOR_BGR2HSV)
    green = cv2.inRange(hsv, (38, 70, 100), (60, 255, 255))
    cyan = cv2.inRange(hsv, (85, 70, 100), (112, 255, 255))
    border = cv2.bitwise_or(green, cyan)
    contours, hierarchy = cv2.findContours(border, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return []

    candidates: list[tuple[int, int, int, int, bool]] = []
    for idx, contour in enumerate(contours):
        x, y, w, h = cv2.boundingRect(contour)
        if not (min_w <= w <= max_w and min_h <= h <= max_h):
            continue
        is_hole, has_child = hierarchy[0][idx][3] != -1, hierarchy[0][idx][2] != -1
        if not is_hole and has_child:
            continue
        rx0, ry0, rx1, ry1 = max(0, x - pad), max(0, y - pad), min(bw, x + w + pad), min(bh, y + h + pad)
        if is_hole:
            ring = np.full((ry1 - ry0, rx1 - rx0), 255, dtype=np.uint8)
            ring[y - ry0 : y + h - ry0, x - rx0 : x + w - rx0] = 0
            g_cnt = int(np.count_nonzero(green[ry0:ry1, rx0:rx1] & ring))
            c_cnt = int(np.count_nonzero(cyan[ry0:ry1, rx0:rx1] & ring))
        else:
            g_cnt = int(np.count_nonzero(green[ry0:ry1, rx0:rx1]))
            c_cnt = int(np.count_nonzero(cyan[ry0:ry1, rx0:rx1]))
        if g_cnt or c_cnt:
            candidates.append((bx + x, by + y, w, h, g_cnt > c_cnt))

    # Deduplicate nested glow/stroke rings by keeping tightest interior box first.
    candidates.sort(key=lambda item: item[2] * item[3])
    kept: list[tuple[tuple[int, int, int, int], bool]] = []
    for x, y, w, h, is_active in candidates:
        cx, cy = x + w // 2, y + h // 2
        if any(
            (kx <= cx <= kx + kw and ky <= cy <= ky + kh)
            or (x <= kx + kw // 2 <= x + w and y <= ky + kh // 2 <= y + h)
            for (kx, ky, kw, kh), _ in kept
        ):
            continue
        kept.append(((x, y, w, h), is_active))
    kept.sort(key=lambda item: item[0][0])
    return kept


def _detect_home_trophy(
    frame: np.ndarray,
    reader: Callable[[list[np.ndarray]], list[str]],
) -> tuple[tuple[int, int, int, int] | None, bool, str | None]:
    """Locate the left-rail yellow tournament trophy and OCR its timer pill below."""
    rx, ry, rw, rh = detectors.scale_rect(REF_HOME_LEFT_RAIL, frame.shape)
    rail = frame[ry : ry + rh, rx : rx + rw]
    if rail.size == 0:
        return None, False, None
    sx, sy = frame.shape[1] / REF_W, frame.shape[0] / REF_H
    min_w, max_w = int(round(80 * sx)), int(round(210 * sx))
    min_h, max_h = int(round(80 * sy)), int(round(210 * sy))

    hsv = cv2.cvtColor(rail, cv2.COLOR_BGR2HSV)
    yellow = cv2.inRange(hsv, (18, 80, 140), (38, 255, 255))
    k = max(3, int(round(9 * min(sx, sy))) | 1)
    closed = cv2.morphologyEx(yellow, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    best: tuple[float, tuple[int, int, int, int]] | None = None
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if min_w <= w <= max_w and min_h <= h <= max_h and 0.65 <= w / h <= 1.55:
            area = float(cv2.contourArea(contour))
            if best is None or area > best[0]:
                best = (area, (rx + x, ry + y, w, h))
    if best is None:
        return None, False, None

    tx, ty, tw, th = best[1]
    fh, fw = frame.shape[:2]
    pill = frame[
        min(fh, ty + th + int(round(5 * sy))) : min(fh, ty + th + int(round(125 * sy))),
        max(0, tx - int(round(40 * sx))) : min(fw, tx + tw + int(round(40 * sx))),
    ]
    texts = reader([pill]) if pill.size > 0 else []
    t_open, t_timer = _parse_tournament_pill(texts[0] if texts else "")
    return (tx, ty, tw, th), t_open, t_timer


def identify_from_ocr(
    header_text: str,
    lines: Sequence[Sequence[Any]],
    *,
    frame_shape: tuple[int, int, int] = (REF_H, REF_W, 3),
    active_preset: str | None = None,
    menu_visible: bool = False,
    buttons: dict[str, tuple[int, int, int, int]] | None = None,
) -> Screen:
    """Pure offline screen classifier from scrubbed OCR lines + layout coords."""
    if menu_visible:
        return Screen("battle", {"menu_state": "closed"}, targets={})

    norm = [(int(it[0]), int(it[1]), str(it[2]).strip()) for it in lines if len(it) >= 3 and str(it[2]).strip()]
    btns = buttons or {}
    sr = detectors.scale_rect
    sx, sy = frame_shape[1] / REF_W, frame_shape[0] / REF_H

    # Overlays first: reject promo/purchase modals before checking base screens.
    mid = [t for y, _, t in norm if int(round(450 * sy)) <= y <= int(round(2050 * sy))]
    if _has_promo_text(header_text) or any(_has_promo_text(t) for t in mid):
        return Screen("unknown", {}, {})

    # End-of-run GAME STATS overlay.
    stats_hdr = f"{header_text} {' '.join(t for y, _, t in norm if int(round(600 * sy)) <= y <= int(round(950 * sy)))}".upper()
    if "GAME STATS" in stats_hdr and "TOURNAMENT" not in stats_hdr:
        band_txt = " ".join(t for y, _, t in norm if y >= int(round(1500 * sy))).upper()
        if ("home" in btns or re.search(r"\bHOME\b", band_txt)) and ("retry" in btns or re.search(r"\bRETRY\b", band_txt)):
            home_rect = tuple(btns["home"]) if "home" in btns else sr(REF_STATS_DEFAULT_HOME, frame_shape)
            retry_rect = tuple(btns["retry"]) if "retry" in btns else sr(REF_STATS_DEFAULT_RETRY, frame_shape)
            full_text = " ".join(t for _, _, t in norm)
            raw = {
                "home": Target("home", home_rect, "HOME", ("home",)),
                "retry": Target("retry", retry_rect, "RETRY", ("battle",)),
            }
            facts = {
                "has_retry": True,
                "tier": detectors.parse_tier_from_text(full_text),
                "highest_wave": parse_highest_wave(full_text),
            }
            return Screen("game_stats", facts, _filter_targets("game_stats", raw, frame_shape))
        return Screen("unknown", {}, {})

    hdr = header_text.strip().upper()
    if not hdr:
        hdr = " ".join(
            t for y, x, t in norm if int(round(80 * sy)) <= y <= int(round(200 * sy)) and x <= int(round(620 * sx))
        ).upper()
    if not hdr or "TOURNAMENT" in hdr:
        return Screen("unknown", {}, {})

    if re.search(r"\bBATTLE\b", hdr):
        diff_txt = " ".join(t for y, _, t in norm if int(round(1200 * sy)) <= y <= int(round(1580 * sy)))
        btn_txt = " ".join(t for y, _, t in norm if int(round(1920 * sy)) <= y <= int(round(2145 * sy))).upper()
        is_resume = bool(re.search(r"\bRESUME\b", btn_txt))
        is_battle = bool(re.search(r"\bBATTLE\b", btn_txt))
        if not re.search(r"\b(DIFFICULTY|TIER)\b", diff_txt, re.IGNORECASE) or not (is_resume or is_battle):
            return Screen("unknown", {}, {})
        trophy_rect = tuple(btns["tournament"]) if "tournament" in btns else sr(REF_HOME_DEFAULT_TROPHY, frame_shape)
        tx, ty, tw, th = trophy_rect
        pill_txt = " ".join(
            t for y, x, t in norm if ty + th <= y <= ty + th + int(round(140 * sy)) and x <= tx + tw + int(round(80 * sx))
        )
        t_open, t_timer = _parse_tournament_pill(pill_txt)
        btn_label = "RESUME" if is_resume else "BATTLE"
        btn_rect = tuple(btns[btn_label.lower()]) if btn_label.lower() in btns else sr(detectors.REF_HOME_BATTLE_BTN, frame_shape)
        return _build_home_screen(
            frame_shape,
            btn_label=btn_label,
            btn_rect=btn_rect,
            tier=detectors.parse_tier_from_text(diff_txt),
            highest_wave=parse_highest_wave(diff_txt),
            tournament_open=t_open,
            tournament_timer=t_timer,
            trophy_rect=trophy_rect,
        )

    for screen_name, hdr_tok, body_y, body_re, default_pills in (
        ("cards", r"\bCARDS\b", 450, r"\b(ACTIVE|INVENTORY)\b", REF_CARDS_DEFAULT_PILLS),
        ("modules", r"\bMODULES\b", 900, r"\b(INVENTORY|MERGE|SHATTER)\b", REF_MODULES_DEFAULT_PILLS),
    ):
        if not re.search(hdr_tok, hdr):
            continue
        body = " ".join(t for y, _, t in norm if y >= int(round(body_y * sy)))
        if not re.search(body_re, body, re.IGNORECASE):
            return Screen("unknown", {}, {})
        pills: list[tuple[tuple[int, int, int, int], bool, str]] = []
        for idx, ref_rect in enumerate(default_pills, start=1):
            rect = tuple(btns[f"preset_{idx}"]) if f"preset_{idx}" in btns else sr(ref_rect, frame_shape)
            rx, ry, rw, rh = rect
            inside = " ".join(t for ly, lx, t in norm if rx <= lx <= rx + rw and ry <= ly <= ry + rh)
            is_act = active_preset is not None and inside.lower() == active_preset.strip().lower()
            pills.append((rect, is_act, inside))
        return _build_loadout_screen(screen_name, pills, frame_shape, fallback_active=active_preset)

    return Screen("unknown", {}, {})


def identify(
    frame: np.ndarray,
    *,
    ocr_fn: Callable[[list[np.ndarray]], list[str]] | None = None,
    lines_fn: Callable[[list[np.ndarray]], list[list[tuple[int, int, str]]]] | None = None,
    timeout: float = 2.5,
) -> Screen:
    """Identify the current game screen (overlays-first) and return allowlisted targets."""
    if frame is None or frame.ndim != 3 or frame.shape[2] != 3:
        return Screen("unknown", {}, {})

    menu_state = detectors.side_menu_state(frame)
    if menu_state in ("closed", "open"):
        return Screen("battle", {"menu_state": menu_state}, targets={})

    if lines_fn is not None and ocr_fn is None:
        batches = lines_fn([frame])
        lines = batches[0] if batches else []
        hx, hy, hw, hh = detectors.scale_rect(REF_SCREEN_HEADER, frame.shape)
        hdr_text = " ".join(t for y, x, t in lines if hx <= x <= hx + hw and hy <= y <= hy + hh)
        return identify_from_ocr(hdr_text, lines, frame_shape=frame.shape)

    reader = ocr_fn if ocr_fn is not None else (lambda items: ocr.read_texts(items, scale=2.0, timeout=timeout))
    pill_reader = ocr_fn if ocr_fn is not None else (lambda items: ocr.read_texts(items, scale=2.5, timeout=timeout))
    sr = detectors.scale_rect

    end_hit = detectors.detect_end_stats_home(frame, ocr_fn=ocr_fn, timeout=timeout)
    if end_hit is not None:
        raw = {"home": Target("home", end_hit.rect, "HOME", ("home",))}
        if end_hit.retry_rect is not None:
            raw["retry"] = Target("retry", end_hit.retry_rect, "RETRY", ("battle",))
        return Screen("game_stats", {"has_retry": end_hit.retry_rect is not None}, _filter_targets("game_stats", raw, frame.shape))

    hdr_texts = reader([_crop(frame, sr(REF_SCREEN_HEADER, frame.shape))])
    hdr = (hdr_texts[0] if hdr_texts else "").strip().upper()
    if not hdr or "TOURNAMENT" in hdr or _has_promo_text(hdr):
        return Screen("unknown", {}, {})

    if re.search(r"\bBATTLE\b", hdr):
        home_hit = detectors.detect_home_battle(frame, allow_resume=True, ocr_fn=ocr_fn, timeout=timeout)
        if home_hit is None:
            return Screen("unknown", {}, {})
        diff_texts = reader([_crop(frame, sr(REF_HOME_DIFFICULTY_PANEL, frame.shape))])
        diff_txt = diff_texts[0] if diff_texts else ""
        if _has_promo_text(diff_txt):
            return Screen("unknown", {}, {})
        tier = detectors.parse_tier_from_text(diff_txt)
        trophy_rect, t_open, t_timer = _detect_home_trophy(frame, reader)
        return _build_home_screen(
            frame.shape,
            btn_label=home_hit.label,
            btn_rect=home_hit.rect,
            tier=tier if tier is not None else home_hit.tier,
            highest_wave=parse_highest_wave(diff_txt),
            tournament_open=t_open,
            tournament_timer=t_timer,
            trophy_rect=trophy_rect,
        )

    for screen_name, hdr_tok, body_refs, body_re, band_ref, min_w, max_w, default_pills in (
        ("cards", r"\bCARDS\b", (REF_CARDS_ACTIVE_HDR, REF_CARDS_INVENTORY_HDR), r"\b(ACTIVE|INVENTORY)\b", REF_CARDS_PRESET_BAND, 130, 240, REF_CARDS_DEFAULT_PILLS),
        ("modules", r"\bMODULES\b", (REF_MODULES_SUBTABS,), r"\b(INVENTORY|MERGE|SHATTER)\b", REF_MODULES_PRESET_BAND, 350, 560, REF_MODULES_DEFAULT_PILLS),
    ):
        if not re.search(hdr_tok, hdr):
            continue
        body_txt = " ".join(reader([_crop(frame, sr(r, frame.shape)) for r in body_refs]))
        if _has_promo_text(body_txt) or not re.search(body_re, body_txt, re.IGNORECASE):
            return Screen("unknown", {}, {})
        detected = _detect_preset_pills(frame, band_ref, min_w_ref=min_w, max_w_ref=max_w)
        if not detected:
            detected = [(sr(r, frame.shape), False) for r in default_pills]
        pill_texts = pill_reader([_crop(frame, rect) for rect, _ in detected])
        pills = [(rect, is_act, txt) for (rect, is_act), txt in zip(detected, pill_texts)]
        return _build_loadout_screen(screen_name, pills, frame.shape)

    return Screen("unknown", {}, {})


def plan_path(
    src: str,
    dst: str,
    *,
    allowed_policies: AbstractSet[str] = frozenset(),
) -> list[NavEdge] | None:
    """Return the shortest declarative path from `src` to `dst`, or None if unreachable."""
    if src == dst:
        return []
    if src == "battle":
        return None
    queue: deque[tuple[str, list[NavEdge]]] = deque([(src, [])])
    visited: set[str] = {src}
    while queue:
        node, path = queue.popleft()
        for edge in NAV_EDGES:
            if edge.src != node:
                continue
            if edge.requires_policy is not None and edge.requires_policy not in allowed_policies:
                continue
            if is_forbidden_label(edge.target_name):
                continue
            next_path = path + [edge]
            if edge.dst == dst:
                return next_path
            if edge.dst not in visited:
                visited.add(edge.dst)
                queue.append((edge.dst, next_path))
    return None
