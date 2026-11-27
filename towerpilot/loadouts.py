"""Zero-tap passive OCR loadout observer and local git-ignored AccountStore.

Human navigates to Cards / Modules / Ultimate Weapons / Home; clicking Observe
runs positioned WinRT OCR over the current frame, matches lines against the
names-only index in `towerpilot.wiki`, and merges results into `data/account.json`.
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

import numpy as np

from towerpilot import ocr, wiki

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ACCOUNT_PATH = ROOT / "data" / "account.json"

_RARITY_RE = re.compile(r"\b(Ancestral|Mythic\+?|Legendary\+?|Epic\+?|Rare\+?|Common)\b", re.IGNORECASE)
_LEVEL_RE = re.compile(r"\b(?:Lv\.?|Level)\s*(\d{1,4})\b", re.IGNORECASE)
_PRESET_RE = re.compile(r"\b(Preset\s*\d+)\b", re.IGNORECASE)
_TIER_RE = re.compile(r"\bTier\s*[:#-]?\s*(\d{1,3})\b", re.IGNORECASE)


def _classify_screen(lines: list[tuple[int, int, str]]) -> str:
    joined = " ".join(text for _, _, text in lines).upper()
    if "GAME STATS" in joined and ("RETRY" in joined or "HOME" in joined):
        return "game_stats"
    if "ULTIMATE WEAPON" in joined:
        return "ultimate_weapons"
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
        bits.append(m_rar.group(1))
    m_lv = _LEVEL_RE.search(pool)
    if m_lv:
        bits.append(f"Lv.{m_lv.group(1)}")
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
    """Read positioned OCR lines on `frame` and match known game items (zero taps)."""
    if frame is None or frame.ndim != 3:
        raise ValueError("Valid frame required")

    reader = lines_fn if lines_fn is not None else (lambda items: ocr.read_lines(items, scale=1.5, timeout=timeout))
    batches = reader([frame])
    lines = batches[0] if batches else []

    screen = _classify_screen(lines)
    preferred_cat: str | None = {
        "cards": "card",
        "modules": "module",
        "ultimate_weapons": "uw",
    }.get(screen)

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

        # Only record loadout items from recognized loadout screens (never from battle HUD or Home)
        if preferred_cat is None:
            continue

        nearby = [
            other_text
            for j, (oy, ox, other_text) in enumerate(lines)
            if j != idx and abs(oy - y) <= 90 and abs(ox - x) <= 260
        ]

        hit: wiki.IndexItem | None = None
        for phrase in _candidate_phrases(text):
            # Ignore exact topic headings (e.g. "CARDS", "MODULES") so they never fuzzy-match an item
            if wiki.match_name(phrase, category="topic", exact_only=True) is not None:
                hit = None
                break
            hit = wiki.match_name(phrase, category=preferred_cat, exact_only=True)
            if hit is not None:
                break
            hit = wiki.match_name(phrase, category=preferred_cat)
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
            "presets": [],
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

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            data = self._read_unlocked()
        grouped: dict[str, list[dict[str, Any]]] = {"card": [], "module": [], "uw": [], "enemy": []}
        for item in data["items"].values():
            cat = item.get("category")
            if cat in grouped:
                grouped[cat].append(item)
        for items in grouped.values():
            items.sort(key=lambda it: it.get("name", ""))
        return {
            "updated_at": data.get("updated_at"),
            "last_screen": data.get("last_screen"),
            "last_tier": data.get("last_tier"),
            "presets": list(data.get("presets") or []),
            "cards": grouped["card"],
            "modules": grouped["module"],
            "uws": grouped["uw"],
            "enemies": grouped["enemy"],
            "total_items": len(data["items"]),
        }

    def merge_observation(self, obs: dict[str, Any]) -> dict[str, Any]:
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
                prev = data["items"].get(slug) or {}
                data["items"][slug] = {
                    "slug": slug,
                    "name": item["name"],
                    "category": item["category"],
                    "detail": item.get("detail") or prev.get("detail") or "",
                    "last_seen": now,
                    "screen": obs.get("screen"),
                }

            self._write_unlocked(data)
        return self.snapshot()

    def reset(self) -> dict[str, Any]:
        with self._lock:
            empty = self._empty()
            self._write_unlocked(empty)
        return self.snapshot()
