"""Structural HUD recognition shared by calibration and runtime readers."""
import cv2


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

