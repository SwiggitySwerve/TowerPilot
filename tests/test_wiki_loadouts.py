"""Offline unit tests for towerpilot.wiki, towerpilot.loadouts, ocr.read_lines, and Flask routes."""
from __future__ import annotations

from pathlib import Path
import threading

import cv2
import numpy as np
import pytest

from app import create_app
from towerpilot import adb, loadouts, ocr, wiki
from towerpilot.input import TapRefused, Tapper


def test_wiki_index_slugs_aliases_and_fuzzy_ocr_repair():
    # Community module abbreviations and canonical slugs
    gc = wiki.match_name("GCOMP")
    assert gc is not None and gc.slug == "module:galaxy_compressor"
    mvn = wiki.match_name("MVN")
    assert mvn is not None and mvn.slug == "module:multiverse_nexus"
    gt = wiki.match_name("GT")
    assert gt is not None and gt.slug == "uw:golden_tower"

    # OCR slip repair (mirrors v1 card_names.py guarantees)
    fu = wiki.match_name("Free LJpgrades", category="card")
    assert fu is not None and fu.slug == "card:free_upgrades"
    sa = wiki.match_name("Stow Aura", category="card")
    assert sa is not None and sa.slug == "card:slow_aura"

    # Ambiguous or unknown strings stay None (never mis-mapped)
    assert wiki.match_name("Cish", category="card") is None
    assert wiki.match_name("Totally Unknown Relic") is None

    # Search index returns category-prefixed hits offline
    hits = wiki.search_index("scatter")
    assert any(h["slug"] == "enemy:scatter" for h in hits)


def test_wiki_clean_wikitext_strips_images_and_extracts_section():
    raw = """
[[File:EnemiesBanner.png|thumb|Enemies]]
== Enemies ==
Normal text with [[The Tower|Tower]] link and {{Stub}}.
{| class="wikitable"
! Name !! Notes
|-
| [[File:Scatter.png]] Scatter || Splits into smaller triangles on death.
|-
| Vampire || Drains tower health over time.
|}
"""
    cleaned = wiki.clean_wikitext(raw)
    assert "File:" not in cleaned
    assert "EnemiesBanner.png" not in cleaned
    assert "Scatter.png" not in cleaned
    assert "Scatter | Splits into smaller triangles on death." in cleaned

    excerpt = wiki.extract_relevant_excerpt(cleaned, "Scatter")
    assert "Scatter" in excerpt
    assert "Splits into smaller triangles" in excerpt


def test_wiki_fetch_entry_caches_locally_and_falls_back_on_error(tmp_path: Path):
    cache_path = tmp_path / "wiki_cache.json"
    calls: list[dict[str, str]] = []

    def fake_fetch(params: dict[str, str]):
        calls.append(params)
        return {
            "query": {
                "pages": {
                    "187": {
                        "title": "Enemies",
                        "revisions": [
                            {
                                "revid": 5245,
                                "slots": {
                                    "main": {
                                        "*": "== Scatter ==\n[[File:Scatter.png]] Splits into children on death."
                                    }
                                },
                            }
                        ],
                    }
                }
            }
        }

    # 1) Cold miss fetches once and caches
    res1 = wiki.fetch_entry("enemy:scatter", cache_path=cache_path, fetch_fn=fake_fetch)
    assert len(calls) == 1
    assert res1["cached"] is False
    assert res1["revid"] == 5245
    assert "Splits into children" in res1["excerpt"]
    assert "File:" not in res1["excerpt"]
    assert cache_path.is_file()

    # 2) Second call serves from cache with zero network calls
    res2 = wiki.fetch_entry("Scatter", cache_path=cache_path, fetch_fn=lambda p: (_ for _ in ()).throw(AssertionError()))
    assert res2["cached"] is True
    assert "Splits into children" in res2["excerpt"]

    # 3) Refresh failure gracefully falls back to cached content with error note
    def broken_fetch(params):
        raise OSError("offline")

    res3 = wiki.fetch_entry("enemy:scatter", refresh=True, cache_path=cache_path, fetch_fn=broken_fetch)
    assert res3["cached"] is True
    assert res3["error"] is not None
    assert "Splits into children" in res3["excerpt"]


def test_loadouts_observe_frame_and_account_store_merge(tmp_path: Path):
    frame = np.zeros((2560, 1080, 3), dtype=np.uint8)
    cards_lines = [
        [
            (120, 80, "CARDS"),
            (180, 100, "Preset 1"),
            (180, 300, "Preset 2"),
            (400, 100, "Attack Speed"),
            (450, 100, "Max"),
            (400, 420, "Free LJpgrades"),
            # Non-card text on cards screen must NOT bleed in
            (700, 100, "Galaxy Compressor"),
            (920, 100, "Golden Tower"),
        ]
    ]
    modules_lines = [
        [
            (120, 80, "MODULES"),
            (200, 80, "Shatter"),
            (500, 100, "Damage"),  # substat label must NOT be recorded as a card
            (700, 100, "Galaxy Compressor"),
            (745, 100, "Ancestral Lv.120"),
        ]
    ]
    uw_lines = [
        [
            (120, 80, "ULTIMATE WEAPONS"),
            (500, 100, "Golden Tower"),
        ]
    ]
    battle_hud_lines = [
        [
            (100, 50, "Damage"),
            (150, 50, "Attack Speed"),
            (200, 50, "Coins"),
            (250, 50, "Boss"),
        ]
    ]

    # Non-loadout screen (battle HUD / unknown) records ZERO items
    battle_obs = loadouts.observe_frame(frame, lines_fn=lambda crops: battle_hud_lines)
    assert battle_obs["screen"] == "unknown"
    assert battle_obs["items"] == []

    # Cards screen records ONLY cards (plus presets)
    obs_cards = loadouts.observe_frame(frame, lines_fn=lambda crops: cards_lines)
    assert obs_cards["screen"] == "cards"
    assert obs_cards["presets"] == ["Preset 1", "Preset 2"]
    by_slug = {it["slug"]: it for it in obs_cards["items"]}
    assert set(by_slug) == {"card:attack_speed", "card:free_upgrades"}
    assert by_slug["card:attack_speed"]["detail"] == "Max"

    # Modules screen records ONLY modules (ignoring Damage substat)
    obs_mods = loadouts.observe_frame(frame, lines_fn=lambda crops: modules_lines)
    assert obs_mods["screen"] == "modules"
    assert [it["slug"] for it in obs_mods["items"]] == ["module:galaxy_compressor"]
    assert "Ancestral" in obs_mods["items"][0]["detail"]
    assert "Lv.120" in obs_mods["items"][0]["detail"]

    # Ultimate Weapons screen records ONLY UWs
    obs_uws = loadouts.observe_frame(frame, lines_fn=lambda crops: uw_lines)
    assert [it["slug"] for it in obs_uws["items"]] == ["uw:golden_tower"]

    store = loadouts.AccountStore(tmp_path / "account.json")
    store.merge_observation(obs_cards)
    store.merge_observation(obs_mods)
    snap = store.merge_observation(obs_uws)
    assert len(snap["cards"]) == 2
    assert len(snap["modules"]) == 1
    assert len(snap["uws"]) == 1
    assert snap["presets"] == ["Preset 1", "Preset 2"]

    # Reset clears store cleanly
    cleared = store.reset()
    assert cleared["total_items"] == 0
    assert cleared["cards"] == []


def test_wiki_module_page_target_and_tier_24_index():
    gc = wiki.match_name("GCOMP")
    assert gc is not None and gc.wiki_page == "Epic Module Unique Effect"
    t24 = wiki.match_name("T24")
    assert t24 is not None and t24.slug == "tier:24"


def test_ocr_read_lines_scales_coordinates_back(monkeypatch):
    crop = np.full((100, 200, 3), 255, dtype=np.uint8)
    monkeypatch.setattr(
        ocr._WARM,
        "recognize",
        lambda entries, deadline: ["TP_OCR_IMAGE\t0", "40\t100\tAttack Speed", "80\t100\tMax"],
    )
    batches = ocr.read_lines([crop], scale=2.0)
    assert batches == [[(20, 50, "Attack Speed"), (40, 50, "Max")]]


def test_flask_account_and_wiki_routes(tmp_path: Path, monkeypatch):
    class DummyFrames:
        active_backend = "mumu"
        last_error = None
        last_frame_size = (1080, 2560)
        input_display = None
        last_frame = np.zeros((2560, 1080, 3), dtype=np.uint8)

        def latest_or_grab(self, max_age_sec: float = 1.2):
            return self.last_frame.copy(), "mumu"

        def close(self) -> None:
            pass

    app = create_app(config_path=tmp_path / "config.yaml", frame_source=DummyFrames())
    client = app.test_client()
    try:
        # GET /api/account starts empty
        r0 = client.get("/api/account")
        assert r0.status_code == 200
        assert r0.get_json()["total_items"] == 0

        # POST /api/account observe (zero taps)
        monkeypatch.setattr(
            loadouts,
            "observe_frame",
            lambda frame: {
                "screen": "modules",
                "observed_at": 1234.0,
                "tier": None,
                "presets": ["Preset 1"],
                "items": [
                    {
                        "slug": "module:multiverse_nexus",
                        "name": "Multiverse Nexus",
                        "category": "module",
                        "detail": "Mythic Lv.95",
                        "y": 500,
                        "x": 200,
                        "raw": "Multiverse Nexus",
                    }
                ],
                "line_count": 3,
            },
        )
        r1 = client.post("/api/account", json={"action": "observe"})
        assert r1.status_code == 200
        body = r1.get_json()
        assert body["account"]["modules"][0]["slug"] == "module:multiverse_nexus"

        # POST /api/account reset
        r2 = client.post("/api/account", json={"action": "reset"})
        assert r2.status_code == 200
        assert r2.get_json()["account"]["total_items"] == 0

        # GET /api/wiki?mode=search
        ws = client.get("/api/wiki?mode=search&q=gcomp")
        assert ws.status_code == 200
        assert any(it["slug"] == "module:galaxy_compressor" for it in ws.get_json()["results"])

        # GET /api/wiki?q=enemy:scatter (mocked fetch)
        monkeypatch.setattr(
            wiki,
            "fetch_entry",
            lambda q, **kw: {
                "slug": "enemy:scatter",
                "name": "Scatter",
                "category": "enemy",
                "aliases": [],
                "page_title": "Enemies",
                "url": "https://example.test/wiki/Enemies",
                "revid": 5245,
                "fetched_at": 1234.0,
                "cached": False,
                "excerpt": "Splits on death.",
                "error": None,
            },
        )
        we = client.get("/api/wiki?q=enemy:scatter")
        assert we.status_code == 200
        assert we.get_json()["name"] == "Scatter"
    finally:
        app.extensions["towerpilot"]["shutdown"]()


def _base_tap_cfg(*, dry_run: bool = False, allow_taps: bool = True, jitter_px: int = 0) -> dict:
    return {
        "screen": {"width": 1080, "height": 2560},
        "safety": {
            "dry_run": dry_run,
            "allow_taps": allow_taps,
            "jitter_px": jitter_px,
            "max_taps_per_sec": 100.0,
            "press_ms": [40, 60],
        },
    }


def test_tapper_swipe_gates_and_dispatch(monkeypatch):
    tapper = Tapper()
    calls: list[tuple[str, str, float]] = []

    def fake_shell(serial: str, cmd: str, timeout: float = 8.0) -> bytes:
        calls.append((serial, cmd, timeout))
        return b""

    monkeypatch.setattr(adb, "shell", fake_shell)

    # 1) dry_run never calls ADB
    res_dry = tapper.swipe(
        "emulator-5554",
        540,
        1900,
        540,
        1100,
        duration_ms=450,
        cfg=_base_tap_cfg(dry_run=True, allow_taps=False),
        reason="scroll_cards",
    )
    assert res_dry["dry_run"] is True
    assert res_dry["dispatched"] is False
    assert (res_dry["x1"], res_dry["y1"], res_dry["x2"], res_dry["y2"]) == (540, 1900, 540, 1100)
    assert res_dry["duration_ms"] == 450
    assert calls == []

    # 2) Bounds check for both start and end
    with pytest.raises(TapRefused):
        tapper.swipe("emulator-5554", -1, 500, 500, 500, cfg=_base_tap_cfg(dry_run=True))
    with pytest.raises(TapRefused):
        tapper.swipe("emulator-5554", 500, 500, 1080, 500, cfg=_base_tap_cfg(dry_run=True))
    with pytest.raises(TapRefused):
        tapper.swipe("emulator-5554", 500, 500, 500, 2600, cfg=_base_tap_cfg(dry_run=True))
    with pytest.raises(TapRefused):
        tapper.swipe("emulator-5554", 500, 500, 500, 800, duration_ms=0, cfg=_base_tap_cfg(dry_run=True))

    # 3) allow_taps / serial / stop_event gates
    with pytest.raises(TapRefused):
        tapper.swipe("emulator-5554", 500, 1800, 500, 1000, cfg=_base_tap_cfg(allow_taps=False))
    with pytest.raises(TapRefused):
        tapper.swipe("", 500, 1800, 500, 1000, cfg=_base_tap_cfg())
    stop = threading.Event()
    stop.set()
    with pytest.raises(TapRefused):
        tapper.swipe("emulator-5554", 500, 1800, 500, 1000, cfg=_base_tap_cfg(), stop_event=stop)

    # 4) Live dispatch with input_display
    res_live = tapper.swipe(
        "emulator-5554",
        540,
        1900,
        540,
        1100,
        duration_ms=500,
        cfg=_base_tap_cfg(),
        input_display=2,
        reason="scroll_cards",
    )
    assert res_live["dispatched"] is True
    assert len(calls) == 1
    assert calls[0][0] == "emulator-5554"
    assert calls[0][1] == "input -d 2 swipe 540 1900 540 1100 500"

    # 5) Non-empty stdout or AdbError raises TapRefused
    monkeypatch.setattr(adb, "shell", lambda serial, cmd, timeout=8.0: b"Error: Unknown display")
    with pytest.raises(TapRefused):
        tapper.swipe("emulator-5554", 540, 1900, 540, 1100, cfg=_base_tap_cfg())

    def raise_adb(serial, cmd, timeout=8.0):
        raise adb.AdbError("socket reset")

    monkeypatch.setattr(adb, "shell", raise_adb)
    with pytest.raises(TapRefused):
        tapper.swipe("emulator-5554", 540, 1900, 540, 1100, cfg=_base_tap_cfg())


def test_wiki_master_catalog_slots_and_rarities():
    cat = wiki.master_catalog()
    assert cat == wiki.catalog()
    assert len(cat["cards"]) == 31
    assert len(cat["modules"]) == 25
    assert len(cat["uws"]) == 9

    card_by_name = {c["name"]: c for c in cat["cards"]}
    assert sum(1 for c in cat["cards"] if c["rarity"] == "common") == 12
    assert sum(1 for c in cat["cards"] if c["rarity"] == "rare") == 9
    assert sum(1 for c in cat["cards"] if c["rarity"] == "epic") == 10
    assert card_by_name["Damage"]["rarity"] == "common"
    assert card_by_name["Free Upgrades"]["rarity"] == "rare"
    assert card_by_name["Death Ray"]["rarity"] == "epic"
    assert all(c["slot"] == "" for c in cat["cards"])

    mod_by_name = {m["name"]: m for m in cat["modules"]}
    assert sum(1 for m in cat["modules"] if m["slot"] == "cannon") == 6
    assert sum(1 for m in cat["modules"] if m["slot"] == "armor") == 6
    assert sum(1 for m in cat["modules"] if m["slot"] == "generator") == 6
    assert sum(1 for m in cat["modules"] if m["slot"] == "core") == 7
    assert mod_by_name["Amplifying Strike"]["slot"] == "cannon"
    assert mod_by_name["Anti-Cube Portal"]["slot"] == "armor"
    assert mod_by_name["Galaxy Compressor"]["slot"] == "generator"
    assert mod_by_name["Solar Dyson Sphere"]["slot"] == "core"

    # IndexItem keeps backwards-compatible empty defaults for UWs/enemies
    gt = wiki.match_name("GT")
    assert gt is not None and gt.slot == "" and gt.rarity == ""


def test_parse_cards_page_synthetic_stars_progress_and_checkmarks():
    frame = np.zeros((2560, 1080, 3), dtype=np.uint8)

    # Green active preset pill around Preset 2 (235, 385, 188, 72)
    cv2.rectangle(frame, (235, 385), (235 + 188, 385 + 72), (60, 230, 80), 4)

    # Tile 0 (col 0, x=32, y_title=1071 -> tile_y=1055): 5 magenta stars + green checkmark
    # Magenta in BGR: ~(220, 30, 240) -> HSV H~153, S~223, V~240
    for i in range(5):
        sx = 44 + i * 44
        cv2.rectangle(frame, (sx, 1290), (sx + 34, 1326), (220, 30, 240), -1)
    # Green checkmark at bottom-right of tile 0 (x=230..290, y=1325..1375)
    cv2.rectangle(frame, (235, 1325), (285, 1375), (40, 230, 60), -1)

    # Tile 1 (col 1, x=289, y_title=1071 -> tile_y=1055): 3 yellow stars, NO checkmark
    # Yellow in BGR: ~(20, 220, 240) -> HSV H~27, S~234, V~240
    for i in range(3):
        sx = 305 + i * 48
        cv2.rectangle(frame, (sx, 1290), (sx + 34, 1326), (20, 220, 240), -1)

    synthetic_lines = [
        [
            (115, 32, "CARDS"),
            (415, 280, "Preset 2"),
            (495, 437, "ACTIVE"),
            (545, 479, "20/20"),
            (966, 377, "INVENTORY"),
            (1071, 97, "Damage"),
            (1365, 129, "Max"),
            (1071, 355, "Range"),
            (1365, 387, "12/32"),
            (1422, 835, "Recovery Package"),
            (1445, 870, "Chance"),
            (1716, 900, "Max"),
        ]
    ]

    parsed = loadouts.parse_cards_page(frame, lines_fn=lambda crops: synthetic_lines)
    assert parsed["active_slots"] == "20/20"
    assert parsed["active_preset"] == "Preset 2"
    by_slug = {c["slug"]: c for c in parsed["cards"]}
    assert set(by_slug) == {"card:damage", "card:range", "card:recovery_package_chance"}

    dmg = by_slug["card:damage"]
    assert dmg["owned"] is True
    assert dmg["maxed"] is True
    assert dmg["stars"] == 7
    assert dmg["progress"] == "Max"
    assert dmg["equipped"] is True
    assert "Max" in dmg["level_text"]

    rng = by_slug["card:range"]
    assert rng["owned"] is True
    assert rng["maxed"] is False
    assert rng["stars"] == 3
    assert rng["progress"] == "12/32"
    assert rng["equipped"] is False


def test_parse_modules_equipped_synthetic_rings_and_levels():
    frame = np.zeros((2560, 1080, 3), dtype=np.uint8)
    # Draw distinct rarity rings inside each slot rect (BGR colors)
    ring_colors = {
        "cannon": (40, 230, 60),       # green -> Ancestral
        "armor": (20, 150, 245),       # orange -> Legendary
        "generator": (30, 30, 235),    # red -> Mythic
        "core": (210, 40, 190),        # purple -> Epic
    }
    for slot, bgr in ring_colors.items():
        rx, ry, rw, rh = loadouts.REF_MODULE_SLOTS[slot]
        cv2.circle(frame, (rx + rw // 2, ry + int(rh * 0.38)), 65, bgr, 12)

    parsed = loadouts.parse_modules_equipped(
        frame,
        ocr_fn=lambda crops: ["Lv.132", "Lv.100", "LC.131", "Lv.88"],
    )
    slots = parsed["slots"]
    assert slots["cannon"]["level"] == 132
    assert slots["cannon"]["rarity"] == "Ancestral"
    assert slots["cannon"]["center"] == (305, 530)

    assert slots["armor"]["level"] == 100
    assert slots["armor"]["rarity"] == "Legendary"

    assert slots["generator"]["level"] == 131
    assert slots["generator"]["rarity"] == "Mythic"

    assert slots["core"]["level"] == 88
    assert slots["core"]["rarity"] == "Epic"

    # Also verify blue ring -> Rare
    frame_blue = np.zeros((2560, 1080, 3), dtype=np.uint8)
    rx, ry, rw, rh = loadouts.REF_MODULE_SLOTS["core"]
    cv2.circle(frame_blue, (rx + rw // 2, ry + int(rh * 0.38)), 65, (235, 110, 20), 12)
    parsed_blue = loadouts.parse_modules_equipped(frame_blue, ocr_fn=lambda crops: ["", "", "", "Lv.20"])
    assert parsed_blue["slots"]["core"]["rarity"] == "Rare"
    assert parsed_blue["slots"]["core"]["level"] == 20


def test_parse_module_detail_popup_and_non_module():
    frame = np.zeros((2560, 1080, 3), dtype=np.uint8)
    popup_lines = [
        [
            (420, 920, "X"),
            (470, 320, "Galaxy Compressor"),
            (530, 320, "Ancestral"),
            (580, 320, "Lv.132"),
            (840, 220, "+8% Package Chance"),
            (900, 220, "+0.4x Coins/Kill Bonus"),
            (1100, 220, "Unique Effect"),
            (1400, 220, "Level Up"),
        ]
    ]
    detail = loadouts.parse_module_detail(frame, lines_fn=lambda crops: popup_lines)
    assert detail is not None
    assert detail["slug"] == "module:galaxy_compressor"
    assert detail["name"] == "Galaxy Compressor"
    assert detail["slot"] == "generator"
    assert detail["rarity"] == "Ancestral"
    assert detail["level"] == 132
    assert detail["substats"] == ["+8% Package Chance", "+0.4x Coins/Kill Bonus"]
    assert detail["close_center"] == (920, 420)
    assert detail["forbidden"] is False
    assert detail["forbidden_text"] == ""
    assert "Galaxy Compressor" in detail["popup_text"]

    # Forbidden shatter/spend popup WITH a module name must flag forbidden=True
    shatter_lines = [
        [
            (420, 920, "X"),
            (500, 300, "SHATTER Galaxy Compressor?"),
            (620, 300, "Confirm"),
        ]
    ]
    shatter_detail = loadouts.parse_module_detail(frame, lines_fn=lambda crops: shatter_lines)
    assert shatter_detail is not None
    assert shatter_detail["slug"] == "module:galaxy_compressor"
    assert shatter_detail["forbidden"] is True
    assert "SHATTER" in shatter_detail["forbidden_text"]
    assert "SHATTER" in shatter_detail["raw_text"]

    # Forbidden spend popup WITHOUT any module name must STILL return forbidden=True (never None!)
    buy_lines = [
        [
            (480, 320, "Special Offer"),
            (600, 320, "BUY 200 Gems"),
            (720, 320, "$9.99"),
        ]
    ]
    buy_detail = loadouts.parse_module_detail(frame, lines_fn=lambda crops: buy_lines)
    assert buy_detail is not None
    assert buy_detail["slug"] is None
    assert buy_detail["forbidden"] is True
    assert "BUY 200 Gems" in buy_detail["forbidden_text"]

    # Base Modules screen chrome ('Buy Module' at y=349, 'Merge'/'Shatter' at y=1013) must NOT false-positive
    base_modules_lines = [
        [
            (114, 33, "MODULES"),
            (349, 431, "Buy Module"),
            (1013, 63, "Inventory"),
            (1013, 469, "Merge"),
            (1013, 817, "Shatter"),
        ]
    ]
    assert loadouts.parse_module_detail(frame, lines_fn=lambda crops: base_modules_lines) is None

    # Non-module screen returns None
    non_mod = loadouts.parse_module_detail(frame, lines_fn=lambda crops: [[(115, 32, "HOME"), (1300, 400, "Tier 11")]])
    assert non_mod is None


def test_account_store_enriched_catalog_and_presets(tmp_path: Path):
    store = loadouts.AccountStore(tmp_path / "account.json")

    # Empty snapshot still exposes full master catalog (31 cards, 25 modules, 9 UWs) with owned=False
    empty = store.snapshot()
    assert empty["counts"] == {
        "cards_owned": 0,
        "cards_total": 31,
        "modules_owned": 0,
        "modules_total": 25,
        "uws_owned": 0,
        "uws_total": 9,
        "workshop_owned": 0,
        "workshop_total": 48,
    }
    assert len(empty["catalog"]["cards"]) == 31
    assert len(empty["catalog"]["modules"]) == 25
    assert len(empty["catalog"]["uws"]) == 9
    assert all(it["owned"] is False for it in empty["catalog"]["cards"])

    # Record cards scan across Preset 1 & Preset 2
    store.record_cards_scan(
        "Preset 1",
        [
            {"slug": "card:damage", "name": "Damage", "maxed": True, "stars": 7, "progress": "Max", "equipped": True, "level_text": "7★ Max"},
            {"slug": "card:coins", "name": "Coins", "maxed": False, "stars": 5, "progress": "12/32", "equipped": False, "level_text": "5★ 12/32"},
        ],
        active_slots="20/20",
    )
    store.record_cards_scan(
        "Preset 2",
        [
            {"slug": "card:damage", "name": "Damage", "maxed": True, "stars": 7, "progress": "Max", "equipped": True},
            {"slug": "card:coins", "name": "Coins", "maxed": False, "stars": 5, "progress": "12/32", "equipped": True},
        ],
    )
    snap = store.record_module_slot(
        "Preset 1",
        "generator",
        {
            "slug": "module:galaxy_compressor",
            "name": "Galaxy Compressor",
            "level": 132,
            "rarity": "Ancestral",
            "substats": ["+8% Package Chance"],
        },
    )

    assert snap["active_card_slots"] == "20/20"
    assert snap["card_presets"]["Preset 1"] == ["card:damage"]
    assert snap["card_presets"]["Preset 2"] == ["card:damage", "card:coins"]
    assert snap["module_presets"]["Preset 1"]["generator"]["slug"] == "module:galaxy_compressor"
    assert snap["module_presets"]["Preset 1"]["generator"]["level"] == 132
    assert snap["counts"]["cards_owned"] == 2
    assert snap["counts"]["modules_owned"] == 1

    cat_cards = {c["slug"]: c for c in snap["catalog"]["cards"]}
    assert cat_cards["card:damage"]["owned"] is True
    assert cat_cards["card:damage"]["maxed"] is True
    assert cat_cards["card:damage"]["stars"] == 7
    assert cat_cards["card:damage"]["equipped_in"] == ["Preset 1", "Preset 2"]
    assert cat_cards["card:damage"]["rarity"] == "common"
    assert cat_cards["card:nuke"]["owned"] is False
    assert cat_cards["card:nuke"]["rarity"] == "epic"

    cat_mods = {m["slug"]: m for m in snap["catalog"]["modules"]}
    gc = cat_mods["module:galaxy_compressor"]
    assert gc["owned"] is True
    assert gc["slot"] == "generator"
    assert gc["rarity"] == "Ancestral"
    assert gc["level"] == 132
    assert gc["substats"] == ["+8% Package Chance"]
    assert gc["equipped_in"] == ["Preset 1"]

    # include_catalog=False omits catalog while keeping counts
    slim = store.snapshot(include_catalog=False)
    assert "catalog" not in slim
    assert slim["counts"]["cards_owned"] == 2

    # Unequipping on re-scan removes from preset equipped_in
    snap2 = store.record_cards_scan("Preset 1", [{"slug": "card:damage", "equipped": False}])
    assert snap2["card_presets"]["Preset 1"] == []
    cat_cards2 = {c["slug"]: c for c in snap2["catalog"]["cards"]}
    assert cat_cards2["card:damage"]["equipped_in"] == ["Preset 2"]

    # Reset clears everything cleanly
    cleared = store.reset()
    assert cleared["total_items"] == 0
    assert cleared["counts"]["cards_owned"] == 0
    assert cleared["card_presets"] == {}
    assert cleared["module_presets"] == {}
    assert cleared["active_card_slots"] is None
