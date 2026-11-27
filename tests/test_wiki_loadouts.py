"""Offline unit tests for towerpilot.wiki, towerpilot.loadouts, ocr.read_lines, and Flask routes."""
from __future__ import annotations

from pathlib import Path

import numpy as np

from app import create_app
from towerpilot import loadouts, ocr, wiki


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
