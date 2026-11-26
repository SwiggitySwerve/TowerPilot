"""Unit tests for zero-template HUD guard, Ad Gem OCR, and Floating Gem detectors."""
from __future__ import annotations

import cv2
import numpy as np

from towerpilot import detectors


def _blank_frame(w: int = 1080, h: int = 2560) -> np.ndarray:
    return np.zeros((h, w, 3), dtype=np.uint8)


def _draw_three_bars(frame: np.ndarray) -> None:
    x, y, w, h = detectors.REF_SIDE_MENU_TOGGLE
    # Outer white box
    cv2.rectangle(frame, (x + 2, y + 2), (x + w - 3, y + h - 3), (250, 250, 250), 2)
    # Three horizontal white bars inside
    for by in (22, 43, 64):
        cv2.rectangle(frame, (x + 20, y + by), (x + w - 20, y + by + 7), (250, 250, 250), -1)


def _draw_close_cross(frame: np.ndarray) -> None:
    x, y, w, h = detectors.REF_SIDE_MENU_TOGGLE
    cv2.line(frame, (x + 18, y + 18), (x + w - 18, y + h - 18), (255, 255, 255), 8)
    cv2.line(frame, (x + w - 18, y + 18), (x + 18, y + h - 18), (255, 255, 255), 8)


def test_side_menu_state_and_visibility():
    empty = _blank_frame()
    assert detectors.side_menu_state(empty) == "obscured"
    assert detectors.menu_toggle_visible(empty) is False

    closed = _blank_frame()
    _draw_three_bars(closed)
    assert detectors.side_menu_state(closed) == "closed"
    assert detectors.menu_toggle_visible(closed) is True

    opened = _blank_frame()
    _draw_close_cross(opened)
    assert detectors.side_menu_state(opened) == "open"
    assert detectors.menu_toggle_visible(opened) is True


def test_safety_exclusions():
    frame = _blank_frame()
    _draw_close_cross(frame)
    assert detectors.in_ability_row((100, 1540), frame.shape) is True
    assert detectors.in_ability_row((100, 500), frame.shape) is False
    assert detectors.in_open_side_menu((950, 400), frame) is True

    closed = _blank_frame()
    _draw_three_bars(closed)
    assert detectors.in_open_side_menu((950, 400), closed) is False


def test_detect_ad_gem_uses_cyan_candidate_and_ocr():
    frame = _blank_frame()
    # Draw cyan-bordered offer box inside left HUD rail
    cv2.rectangle(frame, (40, 620), (240, 740), (240, 220, 20), 6)

    seen_crops: list[np.ndarray] = []

    def fake_ocr(crops: list[np.ndarray]) -> list[str]:
        seen_crops.extend(crops)
        return ["CLAIM 6" for _ in crops]

    hit = detectors.detect_ad_gem(frame, ocr_fn=fake_ocr)
    assert hit is not None
    assert len(seen_crops) == 1
    assert hit.text == "CLAIM 6"
    assert 40 <= hit.center[0] <= 240
    assert 620 <= hit.center[1] <= 740

    # Non-CLAIM OCR text is rejected
    miss = detectors.detect_ad_gem(frame, ocr_fn=lambda crops: ["BONUS COIN" for _ in crops])
    assert miss is None


def test_orbit_tap_points_deterministic_without_jitter():
    pts = detectors.orbit_tap_points((510, 805), 170.0, 135.0, 3, 6.0, jitter=0.0)
    assert len(pts) == 3
    # Top-left quadrant: x < center_x, y < center_y
    for x, y in pts:
        assert x < 510
        assert y < 805
