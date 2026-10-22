"""Read an orbit gem using its square and the same frame's HUD diamond.

No stored artwork, template writes, device I/O or absent/reward inference.
The caller establishes battle ownership and decides whether input is permitted.
"""
from dataclasses import dataclass

import cv2
import numpy as np

from player.bootstrap_layout import manifest


@dataclass(frozen=True)
class OrbitGem:
    center: tuple[float, float]
    rect: tuple[int, int, int, int]
    score: float


def reference_geometry() -> tuple[tuple[float, float], float]:
    """Read the current display's reference geometry, without caching it."""
    region = manifest()['interface']['screens']['battle']['orbiting_gem']
    return tuple(region['reference_center']), float(region['reference_radius_pixels'])


def field_region(layout_offset: int = 0) -> tuple[int, int, int, int]:
    """The manifest's battlefield, extended when the upgrade panel closes."""
    geometry = manifest()
    x, y, w, h = geometry['runtime_layout']['rois']['field']
    return x, y, w, min(geometry['layout']['height']-y, h+layout_offset)


def _hud_glyph(frame: np.ndarray, rect: list[int]) -> np.ndarray | None:
    x, y, w, h = rect
    crop = frame[y:y+h, x:x+w]
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
    if not (0 < gx and 0 < gy and gx+gw < w and gy+gh < h
            and .6*w <= gw and .55*h <= gh):
        return None
    polygon = cv2.approxPolyDP(contour, .025*cv2.arcLength(contour, True), True)
    # A plain triangle, filled diamond or clipped icon cannot teach a matcher.
    holes = [i for i, row in enumerate(hierarchy[0]) if row[3] == index
             and cv2.contourArea(contours[i]) >= .03*gw*gh]
    if len(polygon) != 5 or len(holes) != 5:
        return None
    return mask[gy:gy+gh, gx:gx+gw]


def find_orbit_gem(frame: np.ndarray, *, layout_offset: int = 0) -> OrbitGem | None:
    """Return one verified visible gem; None means not established, not absent.

    Require a square white border with pink pixels and a faceted inner glyph
    matching the independently validated HUD diamond. Rectification handles
    rotation; duplicate inner/outer border contours count as one object.
    """
    geometry = manifest()
    layout = geometry['layout']
    if getattr(frame, 'shape', None) != (layout['height'], layout['width'], 3):
        return None
    region = geometry['interface']['screens']['battle']['orbiting_gem']
    glyph = _hud_glyph(frame, region['hud_icon_rect'])
    if glyph is None:
        return None
    fx, fy, fw, fh = field_region(layout_offset)
    field = frame[fy:fy+fh, fx:fx+fw]
    white = cv2.inRange(field, (180, 180, 180), (255, 255, 255))
    contours, _ = cv2.findContours(white, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    glyph_width = glyph.shape[1]
    found: list[OrbitGem] = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if not (1.1*glyph_width <= w <= 3.3*glyph_width
                and 1.1*glyph_width <= h <= 3.3*glyph_width and .65 <= w/h <= 1.55):
            continue
        quad = cv2.approxPolyDP(contour, .025*cv2.arcLength(contour, True), True)
        if len(quad) != 4 or not cv2.isContourConvex(quad):
            continue
        points = quad.reshape(4, 2).astype(np.float32)
        vectors = np.roll(points, -1, axis=0)-points
        sides = np.linalg.norm(vectors, axis=1)
        if sides.min() == 0 or sides.max()/sides.min() > 1.15:
            continue
        if not 1.2*glyph_width <= sides.mean() <= 2.4*glyph_width:
            continue
        cosines = np.sum(vectors*np.roll(vectors, -1, axis=0), axis=1)/(sides*np.roll(sides, -1))
        if np.max(np.abs(cosines)) > .18:
            continue
        transform = cv2.getPerspectiveTransform(points, np.float32([[0, 0], [99, 0], [99, 99], [0, 99]]))
        warped = cv2.warpPerspective(white, transform, (100, 100), flags=cv2.INTER_NEAREST)
        color = cv2.warpPerspective(field, transform, (100, 100)).astype(np.int16)
        b, g, r = cv2.split(color)
        pink = (b-g > 15) & (r-g > 15) & (r > 180) & (b > 180)
        border = np.ones((100, 100), bool)
        border[8:92, 8:92] = False
        if np.count_nonzero(pink & border) < 40:
            continue
        inner = warped[15:85, 15:85]
        pixels = cv2.findNonZero(inner)
        if pixels is None:
            continue
        ix, iy, iw, ih = cv2.boundingRect(pixels)
        if iw < 35 or ih < 35:
            continue
        patch = inner[iy:iy+ih, ix:ix+iw]
        scores = []
        for rotation in range(4):
            template = np.rot90(glyph, rotation).copy()
            normalized = cv2.resize(patch, (template.shape[1], template.shape[0]))
            scores.append(float(cv2.matchTemplate(normalized, template, cv2.TM_CCOEFF_NORMED)[0, 0]))
        scores.sort(reverse=True)
        if scores[0] < .8 or scores[0]-scores[1] < .1:
            continue
        center = points.mean(axis=0)+np.array([fx, fy])
        gem = OrbitGem((float(center[0]), float(center[1])), (x+fx, y+fy, w, h), scores[0])
        duplicate = next((old for old in found if np.linalg.norm(center-np.array(old.center)) < .3*glyph_width), None)
        if duplicate is None:
            found.append(gem)
        elif gem.score > duplicate.score:
            found[found.index(duplicate)] = gem
    return found[0] if len(found) == 1 else None
