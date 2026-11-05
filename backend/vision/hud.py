"""Structural HUD recognition shared by calibration and runtime readers."""
import cv2
import numpy as np

from player.bootstrap_layout import manifest, reference_manifest


def three_bars(crop):
    """The hamburger: three white horizontal bars inside a white outline box.
    Rows that are mostly-but-not-entirely bright (the bars, not the box's
    edges) must form exactly three bands of similar height. A chevron, a
    checkmark or the green X never do (a plain 'white' check accepted Home's
    chevron, 2026-09-08)."""
    hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
    lit = (hsv[..., 1] < 70) & (hsv[..., 2] > 190)
    frac = lit.mean(axis=1)
    rows = (frac > 0.35) & (frac < 0.9)
    bands, start = [], None
    for i, r in enumerate(list(rows) + [False]):
        if r and start is None:
            start = i
        elif not r and start is not None:
            bands.append((start, i))
            start = None
    # interior bands only: the outline box's own top/bottom edge reads as a
    # mostly-bright band too (0.8 on the live HUD), so anything within 8 rows
    # of the crop's edges is the box, not a bar
    bands = [(a, b) for a, b in bands if b - a >= 5 and a >= 8 and b <= len(rows) - 8]
    if len(bands) != 3:
        return False
    heights = [b - a for a, b in bands]
    return max(heights) <= 2.5 * min(heights)


def close_cross(crop):
    """The open side menu's close-X: white diagonals with a cyan/green glow
    (the glow hue varies by theme), nothing white off the diagonals."""
    hh, ww = crop.shape[:2]
    inner = crop[int(hh*.2):int(hh*.8), int(ww*.2):int(ww*.8)]
    white = inner.min(axis=2) > 210
    yy, xx = np.indices(white.shape)
    diagonal = ((abs(xx/white.shape[1]-yy/white.shape[0]) < .18)
                | (abs(xx/white.shape[1]+yy/white.shape[0]-1) < .18))
    return bool(white[diagonal].mean() > .55 and white[~diagonal].mean() < .35)


def _toggle_crop(frame: np.ndarray) -> np.ndarray | None:
    """The side-menu toggle at the detectors' reference size, or None when the
    display-bound geometry does not fit this frame."""
    layout = manifest()
    if frame.shape != (layout['layout']['height'], layout['layout']['width'], 3):
        return None
    x, y, w, h = layout['side_menu']['toggle']['rect']
    if min(x, y) < 0 or min(w, h) <= 0 or x+w > frame.shape[1] or y+h > frame.shape[0]:
        return None
    crop = frame[y:y+h, x:x+w]
    # Keep the established detector's reference-pixel band sizes unchanged.
    # Native geometry comes from the display-bound manifest on every call.
    _, _, rw, rh = reference_manifest()['side_menu']['toggle']['rect']
    if (w, h) != (rw, rh):
        crop = cv2.resize(crop, (rw, rh), interpolation=cv2.INTER_NEAREST)
    return crop


def menu_toggle_visible(frame: np.ndarray) -> bool:
    """Positive, undimmed battle HUD evidence, without any stored template.

    The side-menu toggle shows three bright bars while the menu is closed and
    a bright X while it is open; battles run with either (saved live frames
    show the menu open). An in-game modal's scrim dims the toggle so it shows
    neither. Unknown geometry or an unreadable glyph refuses collection. The
    caller must also verify battle and wave: this landmark alone is not a
    screen classifier.
    """
    crop = _toggle_crop(frame)
    return crop is not None and bool(three_bars(crop) or close_cross(crop))


def side_menu_closed(frame: np.ndarray) -> bool:
    """Positive evidence that the side menu is shut: the toggle shows its bars.
    An X, a dimmed toggle or unknown geometry is not: the menu may be open."""
    crop = _toggle_crop(frame)
    return crop is not None and three_bars(crop)
