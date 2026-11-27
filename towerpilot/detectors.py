"""Zero-template battle HUD guard, Ad Gem OCR detector, and Floating Gem vision detector.

Reference geometry is 1080x2560 portrait; all regions scale automatically to the
actual captured frame size. No game artwork templates are required.
"""
from __future__ import annotations

import math
import random
import re
from dataclasses import dataclass
from typing import Callable

import cv2
import numpy as np

from towerpilot import ocr

REF_W = 1080
REF_H = 2560

# Reference 1080x2560 layout boxes (x, y, w, h)
REF_SIDE_MENU_TOGGLE = (965, 18, 95, 92)
REF_SIDE_MENU_COLUMN = (840, 0, 240, 1100)
REF_AD_GEM_RAIL = (0, 200, 320, 2200)
REF_HUD_DIAMOND = (25, 190, 55, 54)
REF_FIELD = (0, 300, 1080, 1330)
REF_ABILITY_ROW = (10, 1495, 420, 120)
REF_ABILITY_ROW_CLOSED_SHIFT = 679
REF_WAVE_BOX = (690, 1678, 170, 45)
REF_WAVE_PANEL = (540, 1630, 360, 100)
REF_HUD_COINS = (0, 80, 420, 120)
REF_EXIT_MENU_BAND = (820, 540, 260, 280)
REF_CONFIRM_DIALOG = (100, 760, 880, 1040)

# Reference 1080x2560 end-of-run GAME STATS and Home screen ROIs
REF_STATS_HEADER = (108, 665, 864, 230)
REF_STATS_UPPER = (108, 700, 864, 560)
REF_STATS_COINS = (80, 1450, 920, 180)
REF_STATS_BUTTON_BAND = (0, 1536, 1080, 460)
REF_HOME_HEADER = (20, 105, 590, 65)
REF_HOME_DIFFICULTY = (300, 1200, 560, 160)
REF_HOME_BATTLE_BTN = (300, 1970, 510, 160)


@dataclass(frozen=True)
class AdGemHit:
    rect: tuple[int, int, int, int]
    center: tuple[int, int]
    text: str


@dataclass(frozen=True)
class FloatingGemHit:
    rect: tuple[int, int, int, int]
    center: tuple[int, int]
    score: float


@dataclass(frozen=True)
class ButtonHit:
    rect: tuple[int, int, int, int]
    center: tuple[int, int]
    label: str
    screen: str
    tier: int | None = None
    retry_rect: tuple[int, int, int, int] | None = None


def scale_rect(rect: tuple[int, int, int, int], frame_shape: tuple[int, ...]) -> tuple[int, int, int, int]:
    """Scale a 1080x2560 reference (x, y, w, h) rectangle to `frame_shape`."""
    fh, fw = frame_shape[:2]
    sx, sy = fw / REF_W, fh / REF_H
    x, y, w, h = rect
    rx = max(0, min(fw - 1, int(round(x * sx))))
    ry = max(0, min(fh - 1, int(round(y * sy))))
    rw = max(1, min(fw - rx, int(round(w * sx))))
    rh = max(1, min(fh - ry, int(round(h * sy))))
    return rx, ry, rw, rh


def scale_point(pt: tuple[float, float], frame_shape: tuple[int, ...]) -> tuple[float, float]:
    fh, fw = frame_shape[:2]
    return pt[0] * (fw / REF_W), pt[1] * (fh / REF_H)


# --- Battle HUD safety guard (side-menu toggle: 3 bars or close-X) -------

def _three_bars(crop: np.ndarray) -> bool:
    """Closed side-menu hamburger: three bright white horizontal bars inside a box."""
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    lit = (hsv[..., 1] < 70) & (hsv[..., 2] > 190)
    frac = lit.mean(axis=1)
    rows = (frac > 0.35) & (frac < 0.90)
    bands: list[tuple[int, int]] = []
    start: int | None = None
    for i, active in enumerate(list(rows) + [False]):
        if active and start is None:
            start = i
        elif not active and start is not None:
            bands.append((start, i))
            start = None
    bands = [(a, b) for a, b in bands if b - a >= 5 and a >= 8 and b <= len(rows) - 8]
    if len(bands) != 3:
        return False
    heights = [b - a for a, b in bands]
    return max(heights) <= 2.5 * min(heights)


def _close_cross(crop: np.ndarray) -> bool:
    """Open side-menu close-X: bright white diagonals, dark off-diagonals."""
    hh, ww = crop.shape[:2]
    inner = crop[int(hh * 0.2) : int(hh * 0.8), int(ww * 0.2) : int(ww * 0.8)]
    if inner.size == 0:
        return False
    white = inner.min(axis=2) > 210
    yy, xx = np.indices(white.shape)
    diagonal = (abs(xx / white.shape[1] - yy / white.shape[0]) < 0.18) | (
        abs(xx / white.shape[1] + yy / white.shape[0] - 1) < 0.18
    )
    return bool(white[diagonal].mean() > 0.55 and white[~diagonal].mean() < 0.35)


def side_menu_state(frame: np.ndarray) -> str:
    """Return 'closed' (bars), 'open' (close-X), or 'obscured' (not an undimmed battle HUD)."""
    if frame is None or frame.ndim != 3 or frame.shape[2] != 3:
        return "obscured"
    x, y, w, h = scale_rect(REF_SIDE_MENU_TOGGLE, frame.shape)
    crop = frame[y : y + h, x : x + w]
    if crop.size == 0:
        return "obscured"
    _, _, rw, rh = REF_SIDE_MENU_TOGGLE
    if (w, h) != (rw, rh):
        crop = cv2.resize(crop, (rw, rh), interpolation=cv2.INTER_NEAREST)
    if _three_bars(crop):
        return "closed"
    if _close_cross(crop):
        return "open"
    return "obscured"


def menu_toggle_visible(frame: np.ndarray) -> bool:
    """True when the battle side-menu toggle is visibly undimmed (open or closed)."""
    return side_menu_state(frame) in ("closed", "open")


# --- Tap safety exclusion zones ------------------------------------------

def in_ability_row(pt: tuple[int, int], frame_shape: tuple[int, ...], margin: int = 25) -> bool:
    """Never tap on Nuke / Demon Mode buttons (either panel-open or panel-closed position)."""
    px, py = pt
    for shift in (0, REF_ABILITY_ROW_CLOSED_SHIFT):
        rx, ry, rw, rh = scale_rect(
            (REF_ABILITY_ROW[0], REF_ABILITY_ROW[1] + shift, REF_ABILITY_ROW[2], REF_ABILITY_ROW[3]),
            frame_shape,
        )
        if rx - margin <= px <= rx + rw + margin and ry - margin <= py <= ry + rh + margin:
            return True
    return False


def in_open_side_menu(pt: tuple[int, int], frame: np.ndarray, pad: int = 10) -> bool:
    """True if `pt` lands inside the side-menu column while the menu is not confirmed closed."""
    rx, ry, rw, rh = scale_rect(REF_SIDE_MENU_COLUMN, frame.shape)
    px, py = pt
    inside = (rx - pad <= px < rx + rw + pad) and (ry - pad <= py < ry + rh + pad)
    return inside and side_menu_state(frame) != "closed"


# --- Ad Gem detector (left HUD cyan/white offer box + WinRT OCR) ---------

def detect_ad_gem(
    frame: np.ndarray,
    *,
    search_roi: tuple[int, int, int, int] | list[int] | None = None,
    ocr_fn: Callable[[list[np.ndarray]], list[str]] | None = None,
    timeout: float = 2.0,
) -> AdGemHit | None:
    """Find the Ad Gem CLAIM button in the left HUD rail using color + OCR.

    Returns AdGemHit(rect, center, text) when OCR confirms `CLAIM` inside a
    valid offer box, or None when absent.
    """
    if frame is None or frame.ndim != 3:
        return None
    base_roi = tuple(search_roi) if search_roi is not None else REF_AD_GEM_RAIL
    rx, ry, rw, rh = scale_rect(base_roi, frame.shape)
    rail = frame[ry : ry + rh, rx : rx + rw]
    if rail.size == 0:
        return None

    sx = frame.shape[1] / REF_W
    sy = frame.shape[0] / REF_H
    min_w, max_w = int(round(100 * sx)), int(round(300 * sx))
    min_h, max_h = int(round(55 * sy)), int(round(180 * sy))

    hsv = cv2.cvtColor(rail, cv2.COLOR_BGR2HSV)
    cyan_mask = cv2.inRange(hsv, (75, 60, 150), (110, 255, 255))
    white_mask = cv2.inRange(rail, (180, 180, 180), (255, 255, 255))

    candidates: set[tuple[int, int, int, int]] = set()
    for idx, mask in enumerate((cyan_mask, white_mask)):
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            x, y, w, h = cv2.boundingRect(contour)
            if not (min_w <= w <= max_w and min_h <= h <= max_h):
                continue
            if idx == 1 and cv2.contourArea(contour) < 0.85 * w * h:
                continue
            candidates.add((x, y, w, h))

    if not candidates:
        return None

    ordered = sorted(candidates, key=lambda r: (r[1], r[0]))
    crops = [rail[y : y + h, x : x + w] for x, y, w, h in ordered]
    reader = ocr_fn if ocr_fn is not None else (lambda items: ocr.read_texts(items, scale=2.0, timeout=timeout))
    texts = reader(crops)

    for (x, y, w, h), raw_text in zip(ordered, texts):
        upper = raw_text.upper()
        if re.search(r"\bCLAIM\b", upper):
            rect = (rx + x, ry + y, w, h)
            center = (rect[0] + w // 2, rect[1] + h // 2)
            return AdGemHit(rect=rect, center=center, text=raw_text.strip())
    return None


def sample_interior_point(
    rect: tuple[int, int, int, int],
    *,
    inset_px: int = 12,
    rng: random.Random | None = None,
) -> tuple[int, int]:
    """Pick a safe interior tap point inside a detected button rect."""
    gen = rng or random
    x, y, w, h = rect
    margin_x = min(inset_px, max(0, w // 4))
    margin_y = min(inset_px, max(0, h // 4))
    return (
        gen.randint(x + margin_x, x + w - 1 - margin_x),
        gen.randint(y + margin_y, y + h - 1 - margin_y),
    )


# --- Floating / Orbit Gem detector (zero-template HUD glyph match) -------

def _hud_diamond_glyph(frame: np.ndarray) -> np.ndarray | None:
    x, y, w, h = scale_rect(REF_HUD_DIAMOND, frame.shape)
    crop = frame[y : y + h, x : x + w]
    if crop.size == 0:
        return None
    mask = cv2.inRange(crop, (200, 200, 200), (255, 255, 255))
    contours, hierarchy = cv2.findContours(mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None:
        return None
    outer = [i for i, row in enumerate(hierarchy[0]) if row[3] == -1]
    if len(outer) != 1:
        return None
    index = outer[0]
    contour = contours[index]
    gx, gy, gw, gh = cv2.boundingRect(contour)
    if not (0 < gx and 0 < gy and gx + gw < w and gy + gh < h and 0.6 * w <= gw and 0.55 * h <= gh):
        return None
    polygon = cv2.approxPolyDP(contour, 0.025 * cv2.arcLength(contour, True), True)
    holes = [
        i
        for i, row in enumerate(hierarchy[0])
        if row[3] == index and cv2.contourArea(contours[i]) >= 0.03 * gw * gh
    ]
    if len(polygon) != 5 or len(holes) != 5:
        return None
    return mask[gy : gy + gh, gx : gx + gw]


def _glyph_scores(inner: np.ndarray, glyph: np.ndarray) -> list[float] | None:
    if min(inner.shape) < 35 or not np.any(inner):
        return None
    scores: list[float] = []
    for rotation in range(4):
        template = np.rot90(glyph, rotation).copy()
        best = -1.0
        for width in range(35, inner.shape[1] + 1, 2):
            height = round(width * template.shape[0] / template.shape[1])
            if not 35 <= height <= inner.shape[0]:
                continue
            scaled = cv2.resize(template, (width, height))
            score = float(cv2.matchTemplate(inner, scaled, cv2.TM_CCOEFF_NORMED).max())
            best = max(best, score)
        scores.append(best)
    return sorted(scores, reverse=True)


def detect_floating_gem(frame: np.ndarray) -> FloatingGemHit | None:
    """Detect the orbiting pink-square floating diamond on the battlefield."""
    if frame is None or frame.ndim != 3:
        return None
    glyph = _hud_diamond_glyph(frame)
    if glyph is None:
        return None

    # Search full possible battlefield (extended down for closed upgrade panel)
    fx, fy, fw, fh = scale_rect(
        (REF_FIELD[0], REF_FIELD[1], REF_FIELD[2], min(REF_H - REF_FIELD[1], REF_FIELD[3] + REF_ABILITY_ROW_CLOSED_SHIFT)),
        frame.shape,
    )
    field = frame[fy : fy + fh, fx : fx + fw]
    white = cv2.inRange(field, (180, 180, 180), (255, 255, 255))
    contours, _ = cv2.findContours(white, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    glyph_w = glyph.shape[1]
    same_square = 0.3 * glyph_w

    found: list[FloatingGemHit] = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if not (1.1 * glyph_w <= w <= 3.3 * glyph_w and 1.1 * glyph_w <= h <= 3.3 * glyph_w and 0.65 <= w / h <= 1.55):
            continue
        quad = cv2.approxPolyDP(contour, 0.025 * cv2.arcLength(contour, True), True)
        if len(quad) != 4 or not cv2.isContourConvex(quad):
            continue
        points = quad.reshape(4, 2).astype(np.float32)
        vectors = np.roll(points, -1, axis=0) - points
        sides = np.linalg.norm(vectors, axis=1)
        if sides.min() == 0 or sides.max() / sides.min() > 1.15 or sides.mean() > 2.4 * glyph_w:
            continue
        cosines = np.sum(vectors * np.roll(vectors, -1, axis=0), axis=1) / (sides * np.roll(sides, -1))
        if np.max(np.abs(cosines)) > 0.18:
            continue

        transform = cv2.getPerspectiveTransform(points, np.float32([[0, 0], [99, 0], [99, 99], [0, 99]]))
        warped = cv2.warpPerspective(white, transform, (100, 100), flags=cv2.INTER_NEAREST)
        color = cv2.warpPerspective(field, transform, (100, 100)).astype(np.int16)
        b, g, r = cv2.split(color)
        pink = (b - g > 15) & (r - g > 15) & (r > 180) & (b > 180)
        interior = slice(8, 92)
        border = np.ones((100, 100), bool)
        border[interior, interior] = False
        if np.count_nonzero(pink & border) < 40:
            continue

        scores = _glyph_scores(warped[interior, interior], glyph)
        if scores is None or scores[0] < 0.80 or scores[0] - scores[1] < 0.10:
            continue

        center_f = points.mean(axis=0) + np.array([fx, fy])
        hit = FloatingGemHit(
            rect=(x + fx, y + fy, w, h),
            center=(int(round(center_f[0])), int(round(center_f[1]))),
            score=round(scores[0], 3),
        )
        dup = next(
            (old for old in found if math.hypot(hit.center[0] - old.center[0], hit.center[1] - old.center[1]) < same_square),
            None,
        )
        if dup is None:
            found.append(hit)
        elif hit.score > dup.score:
            found[found.index(dup)] = hit

    return found[0] if len(found) == 1 else None


def orbit_tap_points(
    center: tuple[float, float],
    radius: float,
    angle_deg: float,
    taps: int,
    spread_deg: float,
    jitter: float = 0.03,
    rng: random.Random | None = None,
) -> list[tuple[int, int]]:
    """Generate `taps` points along the orbiting-gem arc around `center`."""
    gen = rng or random
    cx, cy = center
    pts: list[tuple[int, int]] = []
    for k in range(taps):
        wobble = gen.uniform(-2.0, 2.0) if jitter else 0.0
        angle = angle_deg + spread_deg * (k - (taps - 1) / 2.0) + wobble
        rad = radius * (1.0 + (gen.uniform(-jitter, jitter) if jitter else 0.0))
        px = cx + rad * math.cos(math.radians(angle))
        py = cy - rad * math.sin(math.radians(angle))
        pts.append((int(round(px)), int(round(py))))
    return pts


def _parse_wave_from_text(text: str) -> int | None:
    """Extract wave integer from OCR text, tolerating progress-bar underscores like '5750___'."""
    if not text:
        return None
    cleaned = text.replace(",", "")
    m_wave = re.search(r"\bWAVE\s*[:#-]?\s*(\d{1,6})(?!\d)", cleaned, flags=re.IGNORECASE)
    if m_wave:
        return int(m_wave.group(1))
    # Strip any 'Tier <n>' token so a partial read never reports Tier as Wave.
    cleaned_no_tier = re.sub(r"\bTIER\s*[:#-]?\s*\d{1,3}(?!\d)", "", cleaned, flags=re.IGNORECASE)
    m_num = re.search(r"(?<!\d)(\d{1,6})(?!\d)", cleaned_no_tier)
    return int(m_num.group(1)) if m_num else None


def read_wave_ocr(
    frame: np.ndarray,
    *,
    ocr_fn: Callable[[list[np.ndarray]], list[str]] | None = None,
    timeout: float = 1.5,
) -> int | None:
    """Zero-template wave number read via WinRT OCR (immune to progress-bar underscores)."""
    if frame is None or frame.ndim != 3:
        return None
    crops = []
    # Use the wider wave panel crop first (reads 'Tier 10 Wave 5758' cleanly); fallback to tight wave box
    for shift in (0, REF_ABILITY_ROW_CLOSED_SHIFT):
        x, y, w, h = scale_rect(
            (REF_WAVE_PANEL[0], REF_WAVE_PANEL[1] + shift, REF_WAVE_PANEL[2], REF_WAVE_PANEL[3]),
            frame.shape,
        )
        crops.append(frame[y : y + h, x : x + w])
    if not any(int(c.max()) >= 40 for c in crops if c.size > 0):
        return None
    reader = ocr_fn if ocr_fn is not None else (lambda items: ocr.read_texts(items, scale=2.5, timeout=timeout))
    try:
        texts = reader(crops)
    except Exception:
        return None
    for text in texts:
        m_wave = re.search(r"\bWAVE\s*[:#-]?\s*(\d{1,6})(?!\d)", text.replace(",", ""), flags=re.IGNORECASE)
        if m_wave:
            return int(m_wave.group(1))
    for text in texts:
        val = _parse_wave_from_text(text)
        if val is not None:
            return val
    return None


def read_battle_hud_meta(
    frame: np.ndarray,
    *,
    ocr_fn: Callable[[list[np.ndarray]], list[str]] | None = None,
    timeout: float = 2.0,
) -> dict[str, object]:
    """Passively read battle Tier and top-left HUD Coins balance in one WinRT batch."""
    out: dict[str, object] = {"tier": None, "coins": None, "coins_raw": None, "tournament": False}
    if frame is None or frame.ndim != 3:
        return out
    rects = [
        scale_rect(REF_WAVE_PANEL, frame.shape),
        scale_rect(
            (REF_WAVE_PANEL[0], REF_WAVE_PANEL[1] + REF_ABILITY_ROW_CLOSED_SHIFT, REF_WAVE_PANEL[2], REF_WAVE_PANEL[3]),
            frame.shape,
        ),
        scale_rect(REF_HUD_COINS, frame.shape),
    ]
    crops = [frame[y : y + h, x : x + w] for x, y, w, h in rects]
    if not any(int(c.max()) >= 40 for c in crops if c.size > 0):
        return out
    reader = ocr_fn if ocr_fn is not None else (lambda items: ocr.read_texts(items, scale=2.5, timeout=timeout))
    try:
        texts = reader(crops)
    except Exception:
        return out
    if len(texts) < 3:
        return out

    from towerpilot import run_rules

    for txt in texts[:2]:
        up = txt.upper()
        if any(tok in up for tok in ("TOURNAMENT", "TOURNEY", "LEAGUE", "CHAMPION", "LEGENDS", "PLATINUM")):
            out["tournament"] = True
        if out["tier"] is None:
            out["tier"] = parse_tier_from_text(txt)

    coins_txt = texts[2]
    m = re.search(r"(\d[\d,]*(?:\.\d+)?)\s*([kKmMbBtTqQsSoOnNdD])?", coins_txt)
    if m:
        raw = f"{m.group(1).replace(',', '')}{m.group(2) or ''}"
        val = run_rules.parse_coins(raw)
        if val is not None:
            out["coins"] = val
            out["coins_raw"] = raw
    return out


def detect_exit_battle_button(
    frame: np.ndarray,
    *,
    lines_fn: Callable[[list[np.ndarray]], list[list[tuple[int, int, str]]]] | None = None,
    timeout: float = 2.0,
) -> ButtonHit | None:
    """Locate EXIT BATTLE or END ROUND inside an OPEN battle side menu (OCR-only)."""
    if frame is None or frame.ndim != 3 or side_menu_state(frame) != "open":
        return None
    bx, by, bw, bh = scale_rect(REF_EXIT_MENU_BAND, frame.shape)
    crop = frame[by : by + bh, bx : bx + bw]
    if crop.size == 0 or int(crop.max()) < 40:
        return None
    reader = lines_fn if lines_fn is not None else (lambda items: ocr.read_lines(items, scale=2.0, timeout=timeout))
    try:
        batches = reader([crop])
    except Exception:
        return None
    lines = batches[0] if batches else []
    sx, sy = frame.shape[1] / REF_W, frame.shape[0] / REF_H
    for ly, lx, text in lines:
        up = " ".join(text.upper().split())
        if "EXIT BATTLE" in up or "END ROUND" in up:
            # Build a tight safe button box around the OCR line inside the side-menu panel
            rw = int(round(190 * sx))
            rh = int(round(68 * sy))
            cx = min(frame.shape[1] - rw // 2 - 4, max(bx + rw // 2, bx + lx + int(round(65 * sx))))
            cy = by + ly + int(round(14 * sy))
            rect = (cx - rw // 2, cy - rh // 2, rw, rh)
            label = "END ROUND" if "END ROUND" in up else "EXIT BATTLE"
            return ButtonHit(rect=rect, center=(cx, cy), label=label, screen="battle_menu")
    return None


def detect_surrender_confirm(
    frame: np.ndarray,
    *,
    lines_fn: Callable[[list[np.ndarray]], list[list[tuple[int, int, str]]]] | None = None,
    timeout: float = 2.0,
) -> ButtonHit | None:
    """Locate SURRENDER (preferred) or YES on the exit-battle confirmation modal (OCR-only)."""
    if frame is None or frame.ndim != 3:
        return None
    bx, by, bw, bh = scale_rect(REF_CONFIRM_DIALOG, frame.shape)
    crop = frame[by : by + bh, bx : bx + bw]
    if crop.size == 0 or int(crop.max()) < 40:
        return None
    reader = lines_fn if lines_fn is not None else (lambda items: ocr.read_lines(items, scale=2.0, timeout=timeout))
    try:
        batches = reader([crop])
    except Exception:
        return None
    lines = batches[0] if batches else []
    joined = " ".join(t.upper() for _, _, t in lines)
    # Require explicit exit/surrender dialog context and reject any spend/purchase dialog
    if "$" in joined or "BUY" in joined or "GEM" in joined or "SHATTER" in joined:
        return None
    if not any(tok in joined for tok in ("SURRENDER", "END ROUND", "EXIT BATTLE", "LEAVE")):
        return None

    sx, sy = frame.shape[1] / REF_W, frame.shape[0] / REF_H
    surrender_line: tuple[int, int, str] | None = None
    yes_line: tuple[int, int, str] | None = None
    for ly, lx, text in lines:
        up = " ".join(text.upper().split())
        if re.search(r"\bSURRENDER\b", up) and "GO HOME" not in up and "CANCEL" not in up:
            # Prefer the lower button row (y > 250 inside dialog) over dialog title
            if surrender_line is None or ly > surrender_line[0]:
                surrender_line = (ly, lx, up)
        elif re.fullmatch(r"YES", up):
            if yes_line is None or ly > yes_line[0]:
                yes_line = (ly, lx, up)

    chosen = surrender_line or yes_line
    if chosen is None:
        return None
    ly, lx, label = chosen
    rw = int(round(260 * sx))
    rh = int(round(90 * sy))
    cx = bx + lx + int(round(70 * sx))
    cy = by + ly + int(round(16 * sy))
    cx = max(bx + rw // 2, min(bx + bw - rw // 2, cx))
    cy = max(by + rh // 2, min(by + bh - rh // 2, cy))
    return ButtonHit(rect=(cx - rw // 2, cy - rh // 2, rw, rh), center=(cx, cy), label=label, screen="surrender_confirm")


# --- End-of-run GAME STATS -> HOME and Home -> BATTLE detectors ----------

def detect_end_stats_home(
    frame: np.ndarray,
    *,
    ocr_fn: Callable[[list[np.ndarray]], list[str]] | None = None,
    timeout: float = 2.5,
) -> ButtonHit | None:
    """Detect the green HOME button on the normal GAME STATS modal via OCR.

    Rejects tournament stats screens and live battle screens.
    """
    if frame is None or frame.ndim != 3:
        return None
    if menu_toggle_visible(frame):
        return None

    hx, hy, hw, hh = scale_rect(REF_STATS_HEADER, frame.shape)
    header_crop = frame[hy : hy + hh, hx : hx + hw]

    bx, by, bw, bh = scale_rect(REF_STATS_BUTTON_BAND, frame.shape)
    band = frame[by : by + bh, bx : bx + bw]
    if header_crop.size == 0 or band.size == 0:
        return None

    sx = frame.shape[1] / REF_W
    sy = frame.shape[0] / REF_H
    min_w, max_w = int(round(200 * sx)), int(round(560 * sx))
    min_h, max_h = int(round(80 * sy)), int(round(240 * sy))

    hsv = cv2.cvtColor(band, cv2.COLOR_BGR2HSV)
    green = cv2.inRange(hsv, (35, 60, 120), (95, 255, 255))
    contours, _ = cv2.findContours(green, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    candidates: list[tuple[int, int, int, int]] = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if min_w <= w <= max_w and min_h <= h <= max_h:
            candidates.append((bx + x, by + y, w, h))

    if not candidates:
        return None
    candidates.sort(key=lambda r: (r[0], r[1]))

    crops = [header_crop] + [frame[y : y + h, x : x + w] for x, y, w, h in candidates]
    reader = ocr_fn if ocr_fn is not None else (lambda items: ocr.read_texts(items, scale=2.0, timeout=timeout))
    texts = reader(crops)
    if len(texts) != len(crops):
        return None

    header_text = texts[0].upper()
    if "GAME STATS" not in header_text or "TOURNAMENT" in header_text:
        return None

    home_rect: tuple[int, int, int, int] | None = None
    retry_rect: tuple[int, int, int, int] | None = None
    for (x, y, w, h), raw in zip(candidates, texts[1:]):
        upper = raw.upper()
        if re.search(r"\bRETRY\b", upper) and "HOME" not in upper:
            retry_rect = (x, y, w, h)
        elif re.search(r"\bHOME\b", upper) and "RETRY" not in upper:
            home_rect = (x, y, w, h)

    if home_rect is not None and retry_rect is not None:
        x, y, w, h = home_rect
        return ButtonHit(
            rect=(x, y, w, h),
            center=(x + w // 2, y + h // 2),
            label="HOME",
            screen="game_stats",
            retry_rect=retry_rect,
        )
    return None


def parse_tier_from_text(text: str) -> int | None:
    """Extract a tier integer from OCR text like 'DIFFICULTY Tier 11' or 'TIER 9'."""
    if not text:
        return None
    m = re.search(r"\bTIER\s*[:#-]?\s*(\d{1,3})\b", text, flags=re.IGNORECASE)
    return int(m.group(1)) if m else None


def read_end_stats(
    frame: np.ndarray,
    *,
    ocr_fn: Callable[[list[np.ndarray]], list[str]] | None = None,
    timeout: float = 2.5,
) -> dict[str, object] | None:
    """Scrape Tier, Wave, Highest Wave, Killed By, and Coins from a GAME STATS modal."""
    if frame is None or frame.ndim != 3:
        return None
    ux, uy, uw, uh = scale_rect(REF_STATS_UPPER, frame.shape)
    cx, cy, cw, ch = scale_rect(REF_STATS_COINS, frame.shape)
    upper_crop = frame[uy : uy + uh, ux : ux + uw]
    coins_crop = frame[cy : cy + ch, cx : cx + cw]
    if upper_crop.size == 0 or coins_crop.size == 0:
        return None
    if int(upper_crop.max()) < 40 and int(coins_crop.max()) < 40:
        return None

    reader = ocr_fn if ocr_fn is not None else (lambda items: ocr.read_texts(items, scale=2.0, timeout=timeout))
    texts = reader([upper_crop, coins_crop])
    if len(texts) != 2:
        return None

    from towerpilot import run_rules

    parsed = run_rules.parse_end_stats(texts[0], texts[1])
    if (
        parsed["wave"] is None
        and parsed["tier"] is None
        and parsed["killed_by"] is None
        and parsed["total_coins_raw"] is None
    ):
        return None
    return parsed


def read_home_tier(
    frame: np.ndarray,
    *,
    ocr_fn: Callable[[list[np.ndarray]], list[str]] | None = None,
    timeout: float = 2.0,
) -> int | None:
    """Read the selected Tier number from the Home screen difficulty banner."""
    if frame is None or frame.ndim != 3:
        return None
    x, y, w, h = scale_rect(REF_HOME_DIFFICULTY, frame.shape)
    crop = frame[y : y + h, x : x + w]
    if crop.size == 0:
        return None
    reader = ocr_fn if ocr_fn is not None else (lambda items: ocr.read_texts(items, scale=2.0, timeout=timeout))
    texts = reader([crop])
    if not texts:
        return None
    return parse_tier_from_text(texts[0])


def detect_end_stats_retry(
    frame: np.ndarray,
    *,
    ocr_fn: Callable[[list[np.ndarray]], list[str]] | None = None,
    timeout: float = 2.5,
) -> ButtonHit | None:
    """Detect the green RETRY button on a normal GAME STATS modal (requires HOME sibling too)."""
    home_hit = detect_end_stats_home(frame, ocr_fn=ocr_fn, timeout=timeout)
    if home_hit is None or home_hit.retry_rect is None:
        return None
    x, y, w, h = home_hit.retry_rect
    return ButtonHit(
        rect=(x, y, w, h),
        center=(x + w // 2, y + h // 2),
        label="RETRY",
        screen="game_stats",
        retry_rect=home_hit.retry_rect,
    )


def detect_home_battle(
    frame: np.ndarray,
    *,
    allow_resume: bool = False,
    ocr_fn: Callable[[list[np.ndarray]], list[str]] | None = None,
    timeout: float = 2.5,
) -> ButtonHit | None:
    """Detect the Home screen BATTLE (or optionally RESUME) button via triple-anchored OCR.

    Requires:
    - Not in an active battle (side-menu toggle not visible)
    - Top header reads BATTLE (not TOURNAMENT)
    - Center difficulty region reads DIFFICULTY or TIER
    - Lower button region reads BATTLE (or RESUME when `allow_resume=True`), never TOURNAMENT
    """
    if frame is None or frame.ndim != 3:
        return None
    if menu_toggle_visible(frame):
        return None

    hdr_rect = scale_rect(REF_HOME_HEADER, frame.shape)
    diff_rect = scale_rect(REF_HOME_DIFFICULTY, frame.shape)
    btn_rect = scale_rect(REF_HOME_BATTLE_BTN, frame.shape)
    crops = [frame[y : y + h, x : x + w] for x, y, w, h in (hdr_rect, diff_rect, btn_rect)]
    if any(c.size == 0 for c in crops):
        return None

    reader = ocr_fn if ocr_fn is not None else (lambda items: ocr.read_texts(items, scale=2.0, timeout=timeout))
    texts = reader(crops)
    if len(texts) != 3:
        return None

    hdr_text, diff_text, btn_text = (t.upper() for t in texts)
    if "TOURNAMENT" in hdr_text or "TOURNAMENT" in btn_text:
        return None
    if not re.search(r"\bBATTLE\b", hdr_text):
        return None
    if not (re.search(r"\bDIFFICULTY\b", diff_text) or re.search(r"\bTIER\b", diff_text)):
        return None

    is_resume = bool(re.search(r"\bRESUME\b", btn_text))
    is_battle = bool(re.search(r"\bBATTLE\b", btn_text))
    if is_resume:
        if not allow_resume:
            return None
        label = "RESUME"
    elif is_battle:
        label = "BATTLE"
    else:
        return None

    bx, by, bw, bh = btn_rect
    return ButtonHit(
        rect=btn_rect,
        center=(bx + bw // 2, by + bh // 2),
        label=label,
        screen="home",
        tier=parse_tier_from_text(texts[1]),
    )
