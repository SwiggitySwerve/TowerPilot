"""Synthetic fonts only: reward confirmation must refuse ambiguous HUD pixels."""
import cv2
import numpy as np
import pytest

from vision import ocr


@pytest.fixture
def font(monkeypatch):
    glyphs = {}
    for digit in '0123456789':
        canvas = np.zeros((70, 60), np.uint8)
        cv2.putText(canvas, digit, (5, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.5, 255, 2)
        _, canvas = cv2.threshold(canvas, 180, 255, cv2.THRESH_BINARY)
        x, y, w, h = cv2.boundingRect(cv2.findNonZero(canvas))
        glyphs[digit] = canvas[y:y+h, x:x+w]
    monkeypatch.setattr(ocr, '_load', lambda: glyphs)
    return glyphs


def hud(font, text='747'):
    frame = np.zeros((2560, 1080, 3), np.uint8)
    x, y, _, _ = ocr.GEM_BALANCE_REGION
    x += 6
    for ch in text:
        glyph = font[ch]
        h, w = glyph.shape
        frame[y+10:y+10+h, x:x+w] = glyph[:, :, None]
        x += w+5
    return frame


def test_reads_integer_balance_using_existing_font(font):
    assert ocr.read_gem_balance(hud(font)) == 747
    assert ocr.read_gem_balance(hud(font, '1029')) == 1029


def test_missing_font_is_not_a_zero_balance(font):
    frame = hud(font)
    del font['0']
    assert ocr.read_gem_balance(frame) is None


def test_ambiguous_digit_is_not_a_collection(font):
    frame = hud(font)
    font['9'] = font['7'].copy()
    assert ocr.read_gem_balance(frame) is None


def test_wrong_resolution_blank_and_clipped_digits_fail_closed(font):
    assert ocr.read_gem_balance(np.zeros((1280, 540, 3), np.uint8)) is None
    assert ocr.read_gem_balance(np.zeros((2560, 1080, 3), np.uint8)) is None
    frame = hud(font)
    x, y, w, h = ocr.GEM_BALANCE_REGION
    frame[y:y+h, x:x+w] = 0
    glyph = font['7']
    frame[y:y+glyph.shape[0], x+6:x+6+glyph.shape[1]] = glyph[:, :, None]
    assert ocr.read_gem_balance(frame) is None
