"""Offline unit tests for towerpilot.screens classifier, safety fences, and BFS nav graph."""
from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np
import pytest

from towerpilot import detectors, screens

FIXTURE_PATH = Path(__file__).resolve().parent / "fixtures" / "screens_ocr.json"


def _load_fixtures() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _blank_frame(w: int = 1080, h: int = 2560) -> np.ndarray:
    return np.zeros((h, w, 3), dtype=np.uint8)


def _draw_three_bars(frame: np.ndarray) -> None:
    x, y, w, h = detectors.REF_SIDE_MENU_TOGGLE
    cv2.rectangle(frame, (x + 2, y + 2), (x + w - 3, y + h - 3), (250, 250, 250), 2)
    for by in (22, 43, 64):
        cv2.rectangle(frame, (x + 20, y + by), (x + w - 20, y + by + 7), (250, 250, 250), -1)


def test_scrubbed_ocr_fixtures_replay():
    data = _load_fixtures()
    shape = tuple(data["frame_shape"])
    fx = data["screens"]

    # 1. Home screen (tournament closed despite lower event "Ends in" tiles)
    home = screens.identify_from_ocr(
        fx["home"]["header_text"],
        fx["home"]["lines"],
        frame_shape=shape,
        buttons=fx["home"]["buttons"],
    )
    assert home.name == "home"
    assert home.facts["tier"] == 10
    assert home.facts["highest_wave"] == 1200
    assert home.facts["has_resume"] is False
    assert home.facts["tournament_open"] is False
    assert home.facts["tournament_timer"] == "Next in 12h 00m"
    assert set(home.targets) == {"battle", "tier_prev", "tier_next", "nav_cards", "nav_modules"}
    assert "tournament" not in home.targets
    assert home.targets["battle"].rect[1] + home.targets["battle"].rect[3] <= 2145

    # 2. Home promo popup ($14.99 / EVENT BOOST) fails closed to unknown with ZERO targets
    promo = screens.identify_from_ocr(
        fx["home_promo"]["header_text"],
        fx["home_promo"]["lines"],
        frame_shape=shape,
        buttons=fx["home_promo"]["buttons"],
    )
    assert promo.name == "unknown"
    assert promo.targets == {}

    # Even if header still reads BATTLE behind an EVENT BOOST popup, overlays-first fails closed
    promo_with_hdr = screens.identify_from_ocr(
        "BATTLE",
        fx["home_promo"]["lines"],
        frame_shape=shape,
    )
    assert promo_with_hdr.name == "unknown"
    assert promo_with_hdr.targets == {}

    # 3. Cards screen
    cards = screens.identify_from_ocr(
        fx["cards"]["header_text"],
        fx["cards"]["lines"],
        frame_shape=shape,
        active_preset=fx["cards"]["active_preset"],
        buttons=fx["cards"]["buttons"],
    )
    assert cards.name == "cards"
    assert cards.facts["active_preset"] == "Preset 1"
    assert {"preset_1", "preset_2", "preset_3", "preset_4", "preset_5", "nav_home", "nav_modules"} == set(
        cards.targets
    )
    for idx in range(1, 6):
        _, y, _, h = cards.targets[f"preset_{idx}"].rect
        assert y >= 360 and y + h <= 475

    # 4. Modules screen
    mods = screens.identify_from_ocr(
        fx["modules"]["header_text"],
        fx["modules"]["lines"],
        frame_shape=shape,
        active_preset=fx["modules"]["active_preset"],
        buttons=fx["modules"]["buttons"],
    )
    assert mods.name == "modules"
    assert mods.facts["active_preset"] == "Preset 1"
    assert set(mods.targets) == {"preset_1", "preset_2", "nav_home", "nav_cards"}
    for idx in (1, 2):
        _, y, _, h = mods.targets[f"preset_{idx}"].rect
        assert y >= 190 and y + h <= 300

    # 5. Game stats screen (EXIT BATTLE present in background must never become a target)
    stats = screens.identify_from_ocr(
        fx["game_stats"]["header_text"],
        fx["game_stats"]["lines"],
        frame_shape=shape,
        buttons=fx["game_stats"]["buttons"],
    )
    assert stats.name == "game_stats"
    assert set(stats.targets) == {"home", "retry"}
    assert stats.targets["home"].expects == ("home",)
    assert stats.targets["retry"].expects == ("battle",)

    # 6. Live battle always yields ZERO targets
    battle = screens.identify_from_ocr("BATTLE", fx["home"]["lines"], frame_shape=shape, menu_visible=True)
    assert battle.name == "battle"
    assert battle.targets == {}


def test_home_tournament_open_emits_tournament_target():
    data = _load_fixtures()
    shape = tuple(data["frame_shape"])
    lines = [
        (115, 33, "BATTLE"),
        (532, 76, "Ends in 14h 10m"),
        (1273, 416, "Difficulty"),
        (1385, 479, "Tier 10"),
        (1476, 325, "Highest Wave: 1200"),
        (2049, 452, "BATTLE"),
    ]
    scr = screens.identify_from_ocr(
        "BATTLE",
        lines,
        frame_shape=shape,
        buttons={"tournament": (48, 344, 149, 149)},
    )
    assert scr.name == "home"
    assert scr.facts["tournament_open"] is True
    assert "tournament" in scr.targets
    assert scr.targets["tournament"].expects == ("tournament_modal",)


@pytest.mark.parametrize(
    "label",
    [
        "BUY",
        "Buy Module",
        "MERGE",
        "Shatter",
        "Dissonant Run",
        "$14.99",
        "$ 4.99",
        "200 gems",
        "20 Gem",
        "EXIT BATTLE",
        "END ROUND",
        "Surrender",
        "QUIT",
        "CLAIM",
    ],
)
def test_denylist_rejects_all_forbidden_labels(label: str):
    assert screens.is_forbidden_label(label) is True
    bad = screens.Target(name="battle", rect=(300, 1970, 510, 160), label=label, expects=("battle",))
    assert screens.validate_target("home", bad) is False


def test_loadout_preset_rejects_forbidden_raw_label_before_rewrite():
    # Forbidden tokens paired with "Preset N" must be rejected BEFORE rewriting to "Preset N"
    lines = [
        (115, 32, "CARDS"),
        (410, 60, "Buy Preset 1"),
        (410, 280, "$4.99 Preset 2"),
        (410, 490, "Preset 3"),
        (495, 437, "ACTIVE"),
    ]
    scr = screens.identify_from_ocr("CARDS", lines)
    assert scr.name == "cards"
    assert "preset_1" not in scr.targets
    assert "preset_2" not in scr.targets
    assert "preset_3" in scr.targets
    assert scr.targets["preset_3"].label == "Preset 3"

    # Same protection on live identify() pill OCR
    cards_frame = _blank_frame()
    for x, y, w, h in screens.REF_CARDS_DEFAULT_PILLS[:3]:
        cv2.rectangle(cards_frame, (x, y), (x + w, y + h), (230, 220, 20), 6)

    def poisoned_ocr(crops: list[np.ndarray]) -> list[str]:
        if len(crops) == 1:
            return ["CARDS"]
        if len(crops) == 2:
            return ["ACTIVE", "INVENTORY"]
        return ["Buy Preset 1", "$4.99 Preset 2", "Preset 3"]

    live_scr = screens.identify(cards_frame, ocr_fn=poisoned_ocr)
    assert live_scr.name == "cards"
    assert "preset_1" not in live_scr.targets
    assert "preset_2" not in live_scr.targets
    assert "preset_3" in live_scr.targets


def test_loadout_never_invents_presets_from_position_on_unreadable_or_numeric_pills():
    # 1) Detected pills with green active border on "500" and empty "" must be dropped
    #    with NO invented preset_1/preset_2 targets and NO false active_preset.
    cards_frame = _blank_frame()
    for idx, (x, y, w, h) in enumerate(screens.REF_CARDS_DEFAULT_PILLS[:3], start=1):
        color = (0, 220, 40) if idx == 1 else (230, 220, 20)  # pill 1 green ("500")
        cv2.rectangle(cards_frame, (x, y), (x + w, y + h), color, 6)

    def numeric_or_empty_ocr(crops: list[np.ndarray]) -> list[str]:
        if len(crops) == 1:
            return ["CARDS"]
        if len(crops) == 2:
            return ["ACTIVE", "INVENTORY"]
        return ["500", "", "Preset 3"]

    scr = screens.identify(cards_frame, ocr_fn=numeric_or_empty_ocr)
    assert scr.name == "cards"
    assert scr.facts["active_preset"] is None
    assert scr.facts["presets"] == ["Preset 3"]
    assert "preset_1" not in scr.targets
    assert "preset_2" not in scr.targets
    assert "preset_3" in scr.targets

    # 2) Default-pill fallback (blank frame, no HSV borders) with "" and "500" produces ZERO preset targets
    blank_mods = _blank_frame()

    def empty_mods_ocr(crops: list[np.ndarray]) -> list[str]:
        if len(crops) == 1:
            return ["MODULES"] if crops[0].shape[1] < 700 else ["Inventory Merge Shatter"]
        return ["500", ""]

    m_scr = screens.identify(blank_mods, ocr_fn=empty_mods_ocr)
    assert m_scr.name == "modules"
    assert m_scr.facts["active_preset"] is None
    assert m_scr.facts["presets"] == []
    assert [k for k in m_scr.targets if k.startswith("preset_")] == []

    # 3) identify_from_ocr never invents presets for empty or numeric pills either
    ocr_scr = screens.identify_from_ocr(
        "MODULES",
        [(114, 33, "MODULES"), (240, 200, "500"), (1013, 63, "Inventory")],
        active_preset="Preset 1",
    )
    assert ocr_scr.name == "modules"
    assert ocr_scr.facts["active_preset"] is None
    assert ocr_scr.facts["presets"] == []
    assert [k for k in ocr_scr.targets if k.startswith("preset_")] == []


def test_coordinate_safety_fences_and_nav_edge_invariants():
    # Home: Dissonant Run sits at y=2159..2239 -> rejected by y+h <= 2145 fence
    dissonant = screens.Target("battle", (281, 2159, 518, 80), "BATTLE", ("battle",))
    assert screens.validate_target("home", dissonant) is False
    safe_battle = screens.Target("battle", (300, 1970, 510, 160), "BATTLE", ("battle",))
    assert screens.validate_target("home", safe_battle) is True

    # Modules: Buy Module at y=316..411 and Merge/Shatter at y=990..1080 -> rejected
    buy_mod = screens.Target("preset_1", (315, 316, 468, 95), "Preset 1", ("modules",))
    merge_btn = screens.Target("preset_2", (400, 990, 200, 90), "Preset 2", ("modules",))
    assert screens.validate_target("modules", buy_mod) is False
    assert screens.validate_target("modules", merge_btn) is False
    assert screens.validate_target("modules", screens.Target("preset_1", (41, 209, 490, 77), "Preset 1", ("modules",)))

    # Cards: gem buys above y=360 and card tiles below y=475 -> rejected
    gem_buy = screens.Target("preset_1", (400, 220, 200, 90), "Preset 1", ("cards",))
    card_tile = screens.Target("preset_1", (50, 580, 180, 180), "Preset 1", ("cards",))
    assert screens.validate_target("cards", gem_buy) is False
    assert screens.validate_target("cards", card_tile) is False
    assert screens.validate_target("cards", screens.Target("preset_1", (21, 382, 194, 77), "Preset 1", ("cards",)))

    # Battle and unknown screens may NEVER validate any target
    assert screens.validate_target("battle", safe_battle) is False
    assert screens.validate_target("unknown", safe_battle) is False

    # Every edge in NAV_EDGES must have a non-forbidden target name and never exit battle
    for edge in screens.NAV_EDGES:
        assert edge.src != "battle"
        assert not screens.is_forbidden_label(edge.target_name)

    # Every target emitted across all scrubbed fixtures must pass validate_target & denylist
    data = _load_fixtures()
    shape = tuple(data["frame_shape"])
    for entry in data["screens"].values():
        scr = screens.identify_from_ocr(
            entry["header_text"],
            entry["lines"],
            frame_shape=shape,
            active_preset=entry.get("active_preset"),
            buttons=entry.get("buttons"),
        )
        for tgt in scr.targets.values():
            assert not screens.is_forbidden_label(tgt.label)
            assert screens.validate_target(scr.name, tgt, shape)


def test_plan_path_bfs_and_battle_no_exit():
    # Shortest paths across menu graph
    p_stats_cards = screens.plan_path("game_stats", "cards")
    assert p_stats_cards is not None
    assert [(e.src, e.dst, e.target_name) for e in p_stats_cards] == [
        ("game_stats", "home", "home"),
        ("home", "cards", "nav_cards"),
    ]

    p_cards_mods = screens.plan_path("cards", "modules")
    assert p_cards_mods is not None
    assert [(e.src, e.dst, e.target_name) for e in p_cards_mods] == [
        ("cards", "modules", "nav_modules"),
    ]

    p_mods_battle = screens.plan_path("modules", "battle")
    assert p_mods_battle is not None
    assert [(e.src, e.dst, e.target_name) for e in p_mods_battle] == [
        ("modules", "home", "nav_home"),
        ("home", "battle", "battle"),
    ]

    assert screens.plan_path("home", "home") == []

    # Structurally impossible to leave battle!
    assert screens.plan_path("battle", "home") is None
    assert screens.plan_path("battle", "cards") is None
    assert screens.plan_path("battle", "game_stats") is None

    # Tournament modal gated by policy
    assert screens.plan_path("home", "tournament_modal") is None
    p_tourney = screens.plan_path(
        "home",
        "tournament_modal",
        allowed_policies=frozenset({"tournament_capture_ready"}),
    )
    assert p_tourney is not None
    assert [(e.src, e.dst, e.target_name) for e in p_tourney] == [
        ("home", "tournament_modal", "tournament"),
    ]


def test_identify_synthetic_frames_battle_cards_modules_home():
    # 1. Synthetic battle frame (hamburger visible -> battle, zero targets, zero OCR needed)
    battle_frame = _blank_frame()
    _draw_three_bars(battle_frame)
    b_scr = screens.identify(battle_frame, ocr_fn=lambda crops: (_ for _ in ()).throw(AssertionError("no OCR")))
    assert b_scr.name == "battle"
    assert b_scr.facts["menu_state"] == "closed"
    assert b_scr.targets == {}

    # 2. Synthetic Cards frame with green Preset 2 border and cyan borders on 1,3,4,5
    cards_frame = _blank_frame()
    for idx, (x, y, w, h) in enumerate(screens.REF_CARDS_DEFAULT_PILLS, start=1):
        # BGR green (0, 220, 40) -> HSV H~54; BGR cyan (230, 220, 20) -> HSV H~92
        color = (0, 220, 40) if idx == 2 else (230, 220, 20)
        cv2.rectangle(cards_frame, (x, y), (x + w, y + h), color, 6)

    def fake_cards_ocr(crops: list[np.ndarray]) -> list[str]:
        if len(crops) == 1:
            return ["CARDS"]
        if len(crops) == 2:
            return ["ACTIVE", "INVENTORY"]
        return [f"Preset {i}" for i in range(1, len(crops) + 1)]

    c_scr = screens.identify(cards_frame, ocr_fn=fake_cards_ocr)
    assert c_scr.name == "cards"
    assert c_scr.facts["active_preset"] == "Preset 2"
    assert len([k for k in c_scr.targets if k.startswith("preset_")]) == 5

    # 3. Synthetic Home frame with yellow left-rail trophy + "Ends in 2h"
    home_frame = _blank_frame()
    # BGR yellow (20, 220, 240) -> HSV H~27
    cv2.rectangle(home_frame, (50, 350), (195, 495), (20, 220, 240), -1)
    call_idx = {"n": 0}

    def fake_home_ocr(crops: list[np.ndarray]) -> list[str]:
        call_idx["n"] += 1
        if call_idx["n"] == 1:
            return ["BATTLE"]
        if call_idx["n"] == 2:
            return ["BATTLE", "Difficulty Tier 11", "BATTLE"]
        if call_idx["n"] == 3:
            return ["Difficulty Tier 11 Highest Wave: 4321"]
        return ["Ends in 2h 15m"]

    h_scr = screens.identify(home_frame, ocr_fn=fake_home_ocr)
    assert h_scr.name == "home"
    assert h_scr.facts["tier"] == 11
    assert h_scr.facts["highest_wave"] == 4321
    assert h_scr.facts["tournament_open"] is True
    assert "tournament" in h_scr.targets
