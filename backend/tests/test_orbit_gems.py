"""Synthetic recognition failures and optional ignored native-frame replay."""
import json
import math
import os
from pathlib import Path

import cv2
import numpy as np
import pytest

from player.bootstrap_layout import manifest
from player.geometry import Display
from vision import orbit_gems


def diamond():
    """A geometric five-facet fixture, generated without captured artwork."""
    glyph = np.zeros((50, 54), np.uint8)
    polygon = np.array([[3, 16], [14, 3], [39, 3], [50, 16], [27, 46]], np.int32)
    cv2.polylines(glyph, [polygon], True, 255, 2)
    for start, end in [((3, 16), (50, 16)), ((14, 3), (27, 16)),
                       ((39, 3), (27, 16)), ((27, 16), (27, 46))]:
        cv2.line(glyph, start, end, 255, 2)
    return glyph


def scene(angle=0., center=(786, 1038), kind='gem'):
    frame = np.zeros((2560, 1080, 3), np.uint8)
    x, y, w, h = manifest()['interface']['screens']['battle']['orbiting_gem']['hud_icon_rect']
    glyph = diamond()
    frame[y:y+glyph.shape[0], x:x+glyph.shape[1]] = glyph[:, :, None]
    tile = np.zeros((150, 150, 3), np.uint8)
    color = (255, 220, 255) if kind != 'red' else (0, 0, 255)
    cv2.rectangle(tile, (37, 37), (113, 113), (255, 40, 255) if kind != 'red' else color, 6)
    cv2.rectangle(tile, (37, 37), (113, 113), color, 2)
    if kind in ('gem', 'red'):
        tile[50:100, 48:102] = np.maximum(tile[50:100, 48:102], glyph[:, :, None])
    elif kind == 'filled':
        cv2.rectangle(tile, (50, 50), (100, 100), (255, 255, 255), -1)
    elif kind == 'boss':
        cv2.rectangle(tile, (44, 44), (106, 106), color, 4)
    tile = cv2.warpAffine(tile, cv2.getRotationMatrix2D((75, 75), angle, 1), (150, 150))
    cx, cy = center
    frame[cy-75:cy+75, cx-75:cx+75] = tile
    return frame


@pytest.mark.parametrize('angle', [0, 20, 45, 90, 135, 225, 300])
def test_recognizes_rotated_gem_without_saved_templates(angle):
    gem = orbit_gems.find_orbit_gem(scene(angle))
    assert gem is not None
    assert math.dist(gem.center, (786, 1038)) <= 2
    assert gem.score >= .8


@pytest.mark.parametrize('kind', ['empty', 'filled', 'boss', 'red'])
def test_square_enemies_and_plain_shapes_are_unknown(kind):
    assert orbit_gems.find_orbit_gem(scene(kind=kind)) is None


@pytest.mark.parametrize('damage', ['missing', 'filled', 'clipped'])
def test_unverified_hud_icon_cannot_supply_a_template(damage):
    frame = scene()
    x, y, w, h = manifest()['interface']['screens']['battle']['orbiting_gem']['hud_icon_rect']
    if damage == 'missing':
        frame[y:y+h, x:x+w] = 0
    elif damage == 'filled':
        frame[y:y+h, x:x+w] = 255
    else:
        frame[y:y+8, x:x+w] = 0
    assert orbit_gems.find_orbit_gem(frame) is None


def test_multiple_candidates_and_wrong_resolution_remain_unknown():
    first = scene(center=(786, 1038))
    second = scene(center=(250, 600))
    assert orbit_gems.find_orbit_gem(np.maximum(first, second)) is None
    assert orbit_gems.find_orbit_gem(first[::2, ::2]) is None


def test_manifest_geometry_is_read_per_call_and_scales(monkeypatch):
    native = manifest()
    scaled = manifest(Display(540, 1280, 180))
    monkeypatch.setattr(orbit_gems, 'manifest', lambda: native)
    assert orbit_gems.reference_geometry() == ((510, 805), 170.)
    monkeypatch.setattr(orbit_gems, 'manifest', lambda: scaled)
    assert orbit_gems.reference_geometry() == ((255, 402), 85.)
    assert scaled['interface']['screens']['battle']['orbiting_gem']['hud_icon_rect'] == [12, 95, 28, 27]


def test_local_frame_replay():
    configured = os.environ.get('TOWERPILOT_R14C_FIXTURES')
    if not configured:
        pytest.skip('Captured game frames stay local; set TOWERPILOT_R14C_FIXTURES for incident replay')
    root = Path(configured)
    labels = json.loads((root / 'replay-labels.json').read_text(encoding='utf-8'))
    assert labels
    for row in labels:
        frame = cv2.imread(str(root / 'frames' / row['frame']))
        assert frame is not None, row['frame']
        gem = orbit_gems.find_orbit_gem(frame)
        if row['center'] is None:
            assert gem is None, row['frame']
        else:
            assert gem is not None, row['frame']
            assert math.dist(gem.center, row['center']) <= row.get('tolerance', 2), row['frame']
