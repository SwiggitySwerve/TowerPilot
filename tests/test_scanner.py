"""Offline unit tests for InventoryScanner, boundary queueing, safety rails, and /api/account scan routes."""
from __future__ import annotations

import copy
import random
import threading
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import pytest

from app import create_app
from towerpilot import adb, detectors, loadouts, screens
from towerpilot.collector import GemCollector
from towerpilot.config import DEFAULT_CONFIG
from towerpilot.scanner import InventoryScanner

_SHAPE = (2560, 1080, 3)


def _blank_frame(fill: int = 0) -> np.ndarray:
    return np.full(_SHAPE, fill, dtype=np.uint8)


def _inv_page_frame(page_id: int) -> np.ndarray:
    """Create a distinct synthetic frame inside INVENTORY (y=1000..2360) per page_id."""
    frame = np.zeros(_SHAPE, dtype=np.uint8)
    # Paint distinct high-contrast stripes inside inventory so MAD >> 2.5 across pages
    base_val = ((page_id + 1) * 53) % 240
    frame[1050:2300, 60:1020] = base_val
    band_y = 1100 + (page_id % 4) * 250
    frame[band_y : band_y + 180, 100:980] = (base_val + 110) % 255
    return frame


def _battle_frame() -> np.ndarray:
    frame = np.zeros(_SHAPE, dtype=np.uint8)
    x, y, w, h = detectors.REF_SIDE_MENU_TOGGLE
    cv2.rectangle(frame, (x + 2, y + 2), (x + w - 3, y + h - 3), (250, 250, 250), 2)
    for by in (22, 43, 64):
        cv2.rectangle(frame, (x + 20, y + by), (x + w - 20, y + by + 7), (250, 250, 250), -1)
    return frame


def _make_home_screen(tier: int = 9) -> screens.Screen:
    return screens.Screen(
        "home",
        {"tier": tier, "highest_wave": 4200, "has_resume": False, "tournament_open": False, "tournament_timer": None},
        {
            "battle": screens.Target("battle", detectors.REF_HOME_BATTLE_BTN, "BATTLE", ("battle",)),
            "tier_prev": screens.Target("tier_prev", screens.REF_HOME_TIER_PREV, "<", ("home",)),
            "tier_next": screens.Target("tier_next", screens.REF_HOME_TIER_NEXT, ">", ("home",)),
            "nav_cards": screens.Target("nav_cards", screens.REF_NAV_CARDS, "CARDS", ("cards",)),
            "nav_modules": screens.Target("nav_modules", screens.REF_NAV_MODULES, "MODULES", ("modules",)),
        },
    )


def _make_game_stats_screen(tier: int = 9) -> screens.Screen:
    return screens.Screen(
        "game_stats",
        {"has_retry": True, "tier": tier},
        {
            "home": screens.Target("home", screens.REF_STATS_DEFAULT_HOME, "HOME", ("home",)),
            "retry": screens.Target("retry", screens.REF_STATS_DEFAULT_RETRY, "RETRY", ("battle",)),
        },
    )


def _make_cards_screen(active_preset: str = "Preset 1", presets: list[str] | None = None) -> screens.Screen:
    preset_list = presets or ["Preset 1", "Preset 2"]
    targets: dict[str, screens.Target] = {}
    for p in preset_list:
        num = int(p.split()[-1])
        targets[f"preset_{num}"] = screens.Target(
            f"preset_{num}", screens.REF_CARDS_DEFAULT_PILLS[num - 1], f"Preset {num}", ("cards",)
        )
    targets["nav_home"] = screens.Target("nav_home", screens.REF_NAV_HOME, "HOME", ("home",))
    targets["nav_modules"] = screens.Target("nav_modules", screens.REF_NAV_MODULES, "MODULES", ("modules",))
    return screens.Screen("cards", {"active_preset": active_preset, "presets": preset_list}, targets)


def _make_modules_screen(active_preset: str = "Preset 1", presets: list[str] | None = None) -> screens.Screen:
    preset_list = presets or ["Preset 1", "Preset 2"]
    targets: dict[str, screens.Target] = {}
    for p in preset_list:
        num = int(p.split()[-1])
        targets[f"preset_{num}"] = screens.Target(
            f"preset_{num}", screens.REF_MODULES_DEFAULT_PILLS[num - 1], f"Preset {num}", ("modules",)
        )
    targets["nav_home"] = screens.Target("nav_home", screens.REF_NAV_HOME, "HOME", ("home",))
    targets["nav_cards"] = screens.Target("nav_cards", screens.REF_NAV_CARDS, "CARDS", ("cards",))
    return screens.Screen("modules", {"active_preset": active_preset, "presets": preset_list}, targets)


def _in_rect(pt: tuple[int, int], rect: tuple[int, int, int, int]) -> bool:
    rx, ry, rw, rh = rect
    return rx <= pt[0] <= rx + rw and ry <= pt[1] <= ry + rh


class FakeEmulatorFrames:
    def __init__(self, frame: np.ndarray | None = None) -> None:
        self.frame = frame if frame is not None else _blank_frame()
        self.last_frame = self.frame
        self.active_backend = "mumu"
        self.last_error = None
        self.last_frame_size = (self.frame.shape[1], self.frame.shape[0])
        self.input_display = None
        self.adb_grabs = 0

    def set_frame(self, frame: np.ndarray) -> None:
        self.frame = frame
        self.last_frame = frame

    def latest_or_grab(self, max_age_sec: float = 1.2):
        return self.frame.copy(), "mumu"

    def grab_adb(self):
        self.adb_grabs += 1
        return self.frame.copy()

    def read_frame(self, *, prefer_preview: bool = True):
        return self.frame.copy(), "mumu"

    def close(self) -> None:
        pass


def test_cards_sweep_multi_page_presets_and_restore(tmp_path: Path):
    """Cards sweep scrolls until MAD < 2.5 bottom stall, sweeps Preset 1 -> Preset 2, restores Preset 1."""
    store = loadouts.AccountStore(tmp_path / "account.json")
    stop_event = threading.Event()
    logs: list[dict[str, Any]] = []
    notifies: list[tuple[str, str]] = []
    taps: list[tuple[tuple[int, int], str]] = []
    swipes: list[tuple[tuple[int, int], tuple[int, int], int, str]] = []

    emu = {"screen": "home", "card_preset": "Preset 1", "page": 0}
    max_page = 2  # Pages 0, 1, 2 (3 pages total; swiping past page 2 stalls)

    cards_by_preset_and_page = {
        ("Preset 1", 0): [
            {"slug": "card:damage", "name": "Damage", "owned": True, "maxed": True, "stars": 7, "progress": "Max", "equipped": True, "level_text": "7★ Max"},
            {"slug": "card:health", "name": "Health", "owned": True, "maxed": False, "stars": 5, "progress": "10/20", "equipped": True, "level_text": "5★ 10/20"},
        ],
        ("Preset 1", 1): [
            {"slug": "card:cash", "name": "Cash", "owned": True, "maxed": True, "stars": 7, "progress": "Max", "equipped": False, "level_text": "7★ Max"},
        ],
        ("Preset 1", 2): [
            {"slug": "card:coins", "name": "Coins", "owned": True, "maxed": True, "stars": 7, "progress": "Max", "equipped": True, "level_text": "7★ Max"},
        ],
        ("Preset 2", 0): [
            {"slug": "card:damage", "name": "Damage", "owned": True, "maxed": True, "stars": 7, "progress": "Max", "equipped": False, "level_text": "7★ Max"},
            {"slug": "card:health", "name": "Health", "owned": True, "maxed": False, "stars": 5, "progress": "10/20", "equipped": True, "level_text": "5★ 10/20"},
        ],
        ("Preset 2", 1): [
            {"slug": "card:cash", "name": "Cash", "owned": True, "maxed": True, "stars": 7, "progress": "Max", "equipped": True, "level_text": "7★ Max"},
        ],
        ("Preset 2", 2): [
            {"slug": "card:coins", "name": "Coins", "owned": True, "maxed": True, "stars": 7, "progress": "Max", "equipped": False, "level_text": "7★ Max"},
        ],
    }

    def current_frame() -> np.ndarray:
        if emu["screen"] == "cards":
            return _inv_page_frame(emu["page"])
        return _blank_frame()

    def identify(frame: np.ndarray) -> screens.Screen:
        if emu["screen"] == "home":
            return _make_home_screen()
        if emu["screen"] == "cards":
            return _make_cards_screen(emu["card_preset"], ["Preset 1", "Preset 2"])
        return screens.Screen("unknown", {}, {})

    def parse_cards(frame: np.ndarray) -> dict[str, Any]:
        return {
            "active_slots": "20/20",
            "active_preset": emu["card_preset"],
            "cards": cards_by_preset_and_page[(emu["card_preset"], emu["page"])],
        }

    def do_tap(pt, frame, *, reason="", input_display=None):
        taps.append((pt, reason))
        if emu["screen"] == "home" and _in_rect(pt, screens.REF_NAV_CARDS):
            emu["screen"] = "cards"
        elif emu["screen"] == "cards":
            # Safety rail assertion: NEVER tap inside card inventory grid (y=950..2399) or buy buttons
            assert pt[1] <= 475 or pt[1] >= 2400, f"Forbidden tap on cards screen: {pt}"
            if _in_rect(pt, screens.REF_CARDS_DEFAULT_PILLS[0]):
                emu["card_preset"] = "Preset 1"
            elif _in_rect(pt, screens.REF_CARDS_DEFAULT_PILLS[1]):
                emu["card_preset"] = "Preset 2"
            elif _in_rect(pt, screens.REF_NAV_HOME):
                emu["screen"] = "home"
        return {"x": pt[0], "y": pt[1], "dispatched": True}

    def do_swipe(start, end, frame, *, duration_ms=550, reason="", input_display=None):
        swipes.append((start, end, duration_ms, reason))
        assert duration_ms == 550
        assert start[0] == 540 and end[0] == 540
        assert 1000 <= start[1] <= 2350 and 1000 <= end[1] <= 2350
        if start[1] > end[1]:  # scroll down
            emu["page"] = min(max_page, emu["page"] + 1)
        else:  # scroll up to top
            emu["page"] = max(0, emu["page"] - 1)
        return {"x1": start[0], "y1": start[1], "x2": end[0], "y2": end[1], "duration_ms": duration_ms, "dispatched": True}

    scanner = InventoryScanner(
        grab_verified_frame=lambda: (current_frame(), None),
        check_foreground=lambda disp: (True, "ok"),
        tap=do_tap,
        swipe=do_swipe,
        log=lambda msg, **kw: logs.append({"msg": msg, **kw}),
        notify=lambda msg, title="Tower Pilot": notifies.append((msg, title)),
        stop_event=stop_event,
        account_store=store,
        rng=random.Random(7),
        step_delay_sec=(0.0, 0.0),
        identify_fn=identify,
        parse_cards_fn=parse_cards,
    )

    st = scanner.request_scan(scope="cards", battle_live=False)
    assert st["running"] is True and st["phase"] == "starting"

    now = 100.0
    for _ in range(40):
        if not scanner.running:
            break
        scanner.step(current_frame(), now)
        now += 1.0

    assert scanner.running is False
    assert scanner.phase == "done"
    assert scanner.error is None
    assert scanner.last_scan_at is not None
    assert emu["screen"] == "home"
    assert emu["card_preset"] == "Preset 1"  # Restored original preset!
    assert len(swipes) >= 6  # Downward sweeps + bottom stall + scroll-to-top
    assert any(r["event"] == "inventory_scan_completed" for r in logs)

    snap = store.snapshot()
    assert snap["active_card_slots"] == "20/20"
    assert set(snap["card_presets"]["Preset 1"]) == {"card:damage", "card:health", "card:coins"}
    assert set(snap["card_presets"]["Preset 2"]) == {"card:health", "card:cash"}
    by_slug = {c["slug"]: c for c in snap["catalog"]["cards"]}
    assert by_slug["card:damage"]["owned"] is True
    assert by_slug["card:damage"]["maxed"] is True
    assert by_slug["card:damage"]["stars"] == 7
    assert by_slug["card:health"]["owned"] is True
    assert by_slug["card:health"]["maxed"] is False
    assert by_slug["card:health"]["stars"] == 5
    assert by_slug["card:cash"]["owned"] is True
    assert by_slug["card:coins"]["owned"] is True


def test_modules_sweep_two_presets_four_slots_and_restore(tmp_path: Path):
    """Modules sweep checks Preset 1 -> Preset 2, taps all 4 slots inside y=450..870, reads detail, restores Preset 1, returns home."""
    store = loadouts.AccountStore(tmp_path / "account.json")
    stop_event = threading.Event()
    taps: list[tuple[tuple[int, int], str]] = []

    emu: dict[str, Any] = {"screen": "home", "mod_preset": "Preset 1", "open_slot": None}

    equipped_data = {
        "Preset 1": {
            "cannon": {"level": 132, "rarity": "Ancestral", "slug": "module:death_penalty", "name": "Death Penalty", "substats": ["+5% Attack Speed"], "close_center": (910, 460)},
            "armor": {"level": 100, "rarity": "Legendary", "slug": "module:anti_cube_portal", "name": "Anti-Cube Portal", "substats": ["+8% Defense %"], "close_center": None},  # Tests fallback (540, 140)!
            "generator": {"level": 131, "rarity": "Mythic", "slug": "module:galaxy_compressor", "name": "Galaxy Compressor", "substats": ["+0.4x Coins/Kill Bonus"], "close_center": (905, 470)},
            "core": {"level": 100, "rarity": "Legendary", "slug": "module:multiverse_nexus", "name": "Multiverse Nexus", "substats": ["+2s GT Duration"], "close_center": (905, 470)},
        },
        "Preset 2": {
            "cannon": {"level": 110, "rarity": "Mythic", "slug": "module:astral_deliverance", "name": "Astral Deliverance", "substats": ["+3% Bounce Chance"], "close_center": (910, 460)},
            "armor": {"level": 100, "rarity": "Legendary", "slug": "module:wormhole_redirector", "name": "Wormhole Redirector", "substats": ["+200% Health Regen"], "close_center": (910, 460)},
            "generator": {"level": 120, "rarity": "Ancestral", "slug": "module:black_hole_digestor", "name": "Black Hole Digestor", "substats": ["+6% Free Attack"], "close_center": (910, 460)},
            "core": {"level": 115, "rarity": "Mythic", "slug": "module:dimension_core", "name": "Dimension Core", "substats": ["+10x CL Damage"], "close_center": (910, 460)},
        },
    }

    def identify(frame: np.ndarray) -> screens.Screen:
        if emu["open_slot"] is not None:
            return screens.Screen("unknown", {}, {})
        if emu["screen"] == "home":
            return _make_home_screen()
        if emu["screen"] == "modules":
            return _make_modules_screen(emu["mod_preset"], ["Preset 1", "Preset 2"])
        return screens.Screen("unknown", {}, {})

    def parse_modules(frame: np.ndarray) -> dict[str, Any]:
        preset_map = equipped_data[emu["mod_preset"]]
        slots_out = {}
        for slot in loadouts.MODULE_SLOT_ORDER:
            rect = loadouts.REF_MODULE_SLOTS[slot]
            slots_out[slot] = {
                "rect": rect,
                "center": (rect[0] + rect[2] // 2, rect[1] + rect[3] // 2),
                "level": preset_map[slot]["level"],
                "rarity": preset_map[slot]["rarity"],
            }
        return {"active_preset": emu["mod_preset"], "slots": slots_out}

    def parse_detail(frame: np.ndarray) -> dict[str, Any] | None:
        slot = emu["open_slot"]
        if slot is None:
            return None
        info = equipped_data[emu["mod_preset"]][slot]
        return {
            "slug": info["slug"],
            "name": info["name"],
            "slot": slot,
            "rarity": info["rarity"],
            "level": info["level"],
            "substats": list(info["substats"]),
            "close_center": info["close_center"],
        }

    def do_tap(pt, frame, *, reason="", input_display=None):
        taps.append((pt, reason))
        # Hard safety check: NEVER tap Buy Module (y=316..411) or Merge/Shatter (y=990..1080)
        assert not (316 <= pt[1] <= 411), f"Touched Buy Module zone: {pt} ({reason})"
        assert not (990 <= pt[1] <= 1080), f"Touched Merge/Shatter zone: {pt} ({reason})"

        if emu["open_slot"] is not None:
            # Must be close_center or safe header (540, 140)
            assert pt == (540, 140) or (pt[0] >= 680 and pt[1] <= 900)
            emu["open_slot"] = None
            return {"x": pt[0], "y": pt[1], "dispatched": True}

        if emu["screen"] == "home" and _in_rect(pt, screens.REF_NAV_MODULES):
            emu["screen"] = "modules"
        elif emu["screen"] == "modules":
            if _in_rect(pt, screens.REF_MODULES_DEFAULT_PILLS[0]):
                emu["mod_preset"] = "Preset 1"
            elif _in_rect(pt, screens.REF_MODULES_DEFAULT_PILLS[1]):
                emu["mod_preset"] = "Preset 2"
            elif _in_rect(pt, screens.REF_NAV_HOME):
                emu["screen"] = "home"
            else:
                # Must be one of the 4 equipped slots strictly inside y=450..870
                assert 450 <= pt[1] <= 870, f"Module slot tap outside 450..870: {pt}"
                for slot, rect in loadouts.REF_MODULE_SLOTS.items():
                    if _in_rect(pt, rect):
                        emu["open_slot"] = slot
                        break
                assert emu["open_slot"] is not None, f"Tap did not hit any slot: {pt}"
        return {"x": pt[0], "y": pt[1], "dispatched": True}

    scanner = InventoryScanner(
        grab_verified_frame=lambda: (_blank_frame(), None),
        check_foreground=lambda disp: (True, "ok"),
        tap=do_tap,
        swipe=lambda *a, **kw: {"dispatched": True},
        log=lambda *a, **kw: None,
        notify=lambda *a, **kw: None,
        stop_event=stop_event,
        account_store=store,
        rng=random.Random(11),
        step_delay_sec=(0.0, 0.0),
        identify_fn=identify,
        parse_modules_fn=parse_modules,
        parse_detail_fn=parse_detail,
    )

    scanner.request_scan(scope="modules", battle_live=False)
    now = 200.0
    for _ in range(50):
        if not scanner.running:
            break
        scanner.step(_blank_frame(), now)
        now += 1.0

    assert scanner.running is False
    assert scanner.phase == "done"
    assert scanner.error is None
    assert emu["screen"] == "home"
    assert emu["mod_preset"] == "Preset 1"  # Restored!
    # Verify fallback header dismiss (540, 140) was used for Preset 1 armor
    assert ((540, 140), "scan:module_close_armor") in taps

    snap = store.snapshot()
    assert snap["counts"]["modules_owned"] == 8
    assert snap["module_presets"]["Preset 1"]["cannon"]["slug"] == "module:death_penalty"
    assert snap["module_presets"]["Preset 1"]["generator"]["slug"] == "module:galaxy_compressor"
    assert snap["module_presets"]["Preset 2"]["core"]["slug"] == "module:dimension_core"
    assert snap["module_presets"]["Preset 2"]["core"]["substats"] == ["+10x CL Damage"]


def test_queued_scan_blocks_retry_on_game_stats_taps_home_then_scans(tmp_path: Path, monkeypatch):
    """Queueing scan while battle_live=True refuses RETRY on game_stats, taps HOME, then runs scan on home."""
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    cfg["run_flow"]["auto_home"] = True
    cfg["run_flow"]["auto_retry"] = True
    cfg["run_flow"]["auto_battle"] = True
    cfg["ad_gems"]["enabled"] = False
    cfg["floating_gems"]["enabled"] = False

    emu = {"state": "battle", "card_preset": "Preset 1"}
    frames = FakeEmulatorFrames(_battle_frame())
    store = loadouts.AccountStore(tmp_path / "account.json")

    def fake_identify(frame: np.ndarray) -> screens.Screen:
        if emu["state"] == "battle":
            return screens.Screen("battle", {"menu_state": "closed"}, {})
        if emu["state"] == "game_stats":
            return _make_game_stats_screen(tier=9)
        if emu["state"] == "home":
            return _make_home_screen(tier=9)
        if emu["state"] == "cards":
            return _make_cards_screen("Preset 1", ["Preset 1"])
        return screens.Screen("unknown", {}, {})

    monkeypatch.setattr(screens, "identify", fake_identify)
    monkeypatch.setattr(detectors, "read_end_stats", lambda frame: None)
    monkeypatch.setattr(adb, "visible_windows", lambda *a, **kw: [f"{adb.GAME_PKG}/Activity"])
    monkeypatch.setattr(
        loadouts,
        "parse_cards_page",
        lambda frame: {
            "active_slots": "15/15",
            "active_preset": "Preset 1",
            "cards": [
                {"slug": "card:wave_skip", "name": "Wave Skip", "owned": True, "maxed": True, "stars": 7, "progress": "Max", "equipped": True, "level_text": "7★ Max"}
            ],
        },
    )

    shell_cmds: list[str] = []

    def fake_shell(serial: str, cmd: str, **kw):
        shell_cmds.append(cmd)
        parts = cmd.split()
        x1, y1, x2, y2 = int(parts[2]), int(parts[3]), int(parts[4]), int(parts[5])
        if emu["state"] == "game_stats":
            # Must tap HOME (x ~ 556..1004), NEVER RETRY (x ~ 77..524)!
            assert x1 >= 540, f"Tapped RETRY instead of HOME while scan queued! ({x1}, {y1})"
            emu["state"] = "home"
            frames.set_frame(_blank_frame())
        elif emu["state"] == "home":
            if _in_rect((x1, y1), screens.REF_NAV_CARDS):
                emu["state"] = "cards"
                frames.set_frame(_inv_page_frame(0))
        elif emu["state"] == "cards":
            if _in_rect((x1, y1), screens.REF_NAV_HOME):
                emu["state"] = "home"
                frames.set_frame(_blank_frame())
        return b""

    monkeypatch.setattr(adb, "shell", fake_shell)

    collector = GemCollector(
        frames,
        cfg,
        flow_delay_sec=(0.0, 0.0),
        max_taps_per_sec=100.0,
        account_store=store,
        scan_step_delay_sec=(0.0, 0.0),
    )
    # 1) Live battle -> request_scan refuses when Harvesting OFF, then queues when Harvesting ON
    collector.step_once()
    assert collector.battle_live is True
    with pytest.raises(RuntimeError, match="Harvesting ON"):
        collector.request_scan(scope="cards", queue_if_battle=True)
    collector.running = True
    scan_st = collector.request_scan(scope="cards", queue_if_battle=True)
    assert scan_st["queued"] is True and scan_st["running"] is False

    # 2) Run ends -> GAME STATS appears -> must tap HOME (never RETRY!)
    emu["state"] = "game_stats"
    frames.set_frame(_blank_frame())
    collector.flow_last_scan = 0.0
    collector.step_once()
    assert emu["state"] == "home"
    assert collector.runs_restarted == 0

    # 3) Next ticks on home -> scanner promotes queued -> running, sweeps cards, returns home!
    for _ in range(15):
        if collector.scan_status()["phase"] == "done":
            break
        collector.step_once()

    final = collector.scan_status()
    assert final["running"] is False
    assert final["queued"] is False
    assert final["phase"] == "done"
    assert emu["state"] == "home"
    assert store.snapshot()["counts"]["cards_owned"] == 1


def test_scanner_immediate_abort_on_battle_or_blocker_and_three_strike_abort(tmp_path: Path):
    """Immediate abort on live battle or foreground blocker; 3-strike abort on unexpected screen."""
    store = loadouts.AccountStore(tmp_path / "account.json")
    stop_event = threading.Event()
    notifies: list[str] = []
    taps: list[Any] = []

    # Case 1: Live battle appears mid-scan -> immediate abort, zero taps
    scanner = InventoryScanner(
        grab_verified_frame=lambda: (_battle_frame(), None),
        check_foreground=lambda disp: (True, "ok"),
        tap=lambda *a, **kw: taps.append(a) or {"x": 0, "y": 0},
        swipe=lambda *a, **kw: taps.append(a) or {"dispatched": True},
        log=lambda *a, **kw: None,
        notify=lambda msg, title="Tower Pilot": notifies.append(msg),
        stop_event=stop_event,
        account_store=store,
        step_delay_sec=(0.0, 0.0),
    )
    scanner.request_scan(scope="all", battle_live=False)
    scanner.step(_blank_frame(), 10.0)
    assert scanner.running is False
    assert scanner.phase == "error"
    assert "battle" in (scanner.error or "").lower()
    assert taps == []
    assert len(notifies) == 1

    # Case 2: Foreground blocker appears mid-scan -> immediate abort, zero taps
    notifies.clear()
    scanner2 = InventoryScanner(
        grab_verified_frame=lambda: (_blank_frame(), None),
        check_foreground=lambda disp: (False, "covered_by:com.mumu.store"),
        tap=lambda *a, **kw: taps.append(a) or {"x": 0, "y": 0},
        swipe=lambda *a, **kw: taps.append(a) or {"dispatched": True},
        log=lambda *a, **kw: None,
        notify=lambda msg, title="Tower Pilot": notifies.append(msg),
        stop_event=stop_event,
        account_store=store,
        step_delay_sec=(0.0, 0.0),
    )
    scanner2.request_scan(scope="all", battle_live=False)
    scanner2.step(_blank_frame(), 20.0)
    assert scanner2.running is False
    assert scanner2.phase == "error"
    assert "covered_by:com.mumu.store" in (scanner2.error or "")
    assert taps == []
    assert len(notifies) == 1

    # Case 3: Unexpected screen ('unknown') -> 3-strike abort with zero taps and notify on 3rd strike
    notifies.clear()
    scanner3 = InventoryScanner(
        grab_verified_frame=lambda: (_blank_frame(), None),
        check_foreground=lambda disp: (True, "ok"),
        tap=lambda *a, **kw: taps.append(a) or {"x": 0, "y": 0},
        swipe=lambda *a, **kw: taps.append(a) or {"dispatched": True},
        log=lambda *a, **kw: None,
        notify=lambda msg, title="Tower Pilot": notifies.append(msg),
        stop_event=stop_event,
        account_store=store,
        step_delay_sec=(0.0, 0.0),
        identify_fn=lambda f: screens.Screen("unknown", {}, {}),
    )
    scanner3.request_scan(scope="cards", battle_live=False)
    scanner3.step(_blank_frame(), 30.0)
    assert scanner3.running is True  # Strike 1
    scanner3.step(_blank_frame(), 31.0)
    assert scanner3.running is True  # Strike 2
    assert notifies == []
    scanner3.step(_blank_frame(), 32.0)
    assert scanner3.running is False  # Strike 3 -> abort
    assert scanner3.phase == "error"
    assert scanner3.error is not None
    assert taps == []
    assert len(notifies) == 1

    # Case 4: Forbidden prompt ('BUY' / 'SHATTER') on module detail popup -> immediate abort, zero taps
    notifies.clear()
    scanner4 = InventoryScanner(
        grab_verified_frame=lambda: (_blank_frame(), None),
        check_foreground=lambda disp: (True, "ok"),
        tap=lambda *a, **kw: taps.append(a) or {"x": 0, "y": 0},
        swipe=lambda *a, **kw: taps.append(a) or {"dispatched": True},
        log=lambda *a, **kw: None,
        notify=lambda msg, title="Tower Pilot": notifies.append(msg),
        stop_event=stop_event,
        account_store=store,
        step_delay_sec=(0.0, 0.0),
        identify_fn=lambda f: _make_modules_screen(),
        parse_detail_fn=lambda f: {"slug": "bad", "name": "SHATTER ALL", "close_center": (900, 400)},
    )
    scanner4.request_scan(scope="modules", battle_live=False)
    scanner4.phase = "modules"
    scanner4._substate = "read_detail"
    scanner4._mod_presets = ["Preset 1"]
    scanner4._mod_current_slot = "cannon"
    scanner4.step(_blank_frame(), 40.0)
    assert scanner4.running is False
    assert scanner4.phase == "error"
    assert taps == []
    assert len(notifies) == 1


def test_flask_api_account_scan_and_cancel_routes(tmp_path: Path):
    """Flask GET/POST /api/account supports catalog/counts/scan, scan start/queue/cancel, and 409 when live."""
    cfg_path = tmp_path / "config.yaml"
    frames = FakeEmulatorFrames(_battle_frame())
    app = create_app(config_path=cfg_path, frame_source=frames)
    client = app.test_client()

    try:
        # GET /api/account includes catalog, counts, and scan state
        res_get = client.get("/api/account")
        assert res_get.status_code == 200
        acc = res_get.get_json()
        assert "catalog" in acc and set(acc["catalog"].keys()) == {"cards", "modules", "uws", "workshop"}
        assert "counts" in acc and acc["counts"]["cards_total"] == 31
        assert "scan" in acc and acc["scan"]["running"] is False and acc["scan"]["queued"] is False

        # GET /api/status also includes scan
        st = client.get("/api/status").get_json()
        assert "scan" in st and st["scan"]["phase"] == "idle"

        # Invalid scope returns 400 (even before running check? check with running ON and OFF)
        # When Harvesting is OFF, POST /api/account scan returns 409 telling user to turn Harvesting ON
        off_conflict = client.post("/api/account", json={"action": "scan", "scope": "all"})
        assert off_conflict.status_code == 409
        assert "harvesting" in off_conflict.get_json()["error"].lower()

        # Enable Harvesting state on collector (without racing a live thread on dummy frames)
        app.extensions["towerpilot"]["collector"].running = True

        # Invalid scope returns 400
        bad_scope = client.post("/api/account", json={"action": "scan", "scope": "relics"})
        assert bad_scope.status_code == 400

        # Battle is live & queue_if_battle=False -> 409 Conflict
        conflict = client.post(
            "/api/account",
            json={"action": "scan", "scope": "all", "queue_if_battle": False},
        )
        assert conflict.status_code == 409
        assert "error" in conflict.get_json()

        # Battle is live & queue_if_battle=True -> 200 queued
        queued = client.post(
            "/api/account",
            json={"action": "scan", "scope": "cards", "queue_if_battle": True},
        )
        assert queued.status_code == 200
        q_body = queued.get_json()
        assert q_body["scan"]["queued"] is True
        assert q_body["scan"]["running"] is False
        assert q_body["scan"]["scope"] == "cards"
        assert q_body["account"]["scan"]["queued"] is True

        # Cancel scan -> idle
        cancelled = client.post("/api/account", json={"action": "cancel_scan"})
        assert cancelled.status_code == 200
        c_body = cancelled.get_json()
        assert c_body["scan"]["queued"] is False
        assert c_body["scan"]["running"] is False
        assert c_body["scan"]["phase"] == "idle"

        # Off-battle frame -> immediate start
        frames.set_frame(_blank_frame())
        started = client.post("/api/account", json={"action": "scan", "scope": "all"})
        assert started.status_code == 200
        s_body = started.get_json()
        assert s_body["scan"]["running"] is True
        assert s_body["scan"]["queued"] is False
        assert s_body["scan"]["phase"] == "starting"

        # Stopping collector cancels any active or queued scan cleanly
        app.extensions["towerpilot"]["collector"].stop()
        after_stop = client.get("/api/status").get_json()["scan"]
        assert after_stop["running"] is False and after_stop["queued"] is False and after_stop["phase"] == "idle"
    finally:
        app.extensions["towerpilot"]["shutdown"]()


def test_real_parse_module_detail_forbidden_popup_and_safety_fences(tmp_path: Path):
    """Regression tests for real loadouts.parse_module_detail forbidden prompts, Buy Module close fence, and Home RESUME guard."""
    store = loadouts.AccountStore(tmp_path / "account.json")
    taps: list[Any] = []
    notifies: list[str] = []

    def _make_scanner(parse_detail_fn, identify_fn=None):
        return InventoryScanner(
            grab_verified_frame=lambda: (_blank_frame(), None),
            check_foreground=lambda disp: (True, "ok"),
            tap=lambda pt, frame, **kw: taps.append((pt, kw.get("reason", ""))) or {"x": pt[0], "y": pt[1]},
            swipe=lambda *a, **kw: {"dispatched": True},
            log=lambda *a, **kw: None,
            notify=lambda msg, title="Tower Pilot": notifies.append(msg),
            stop_event=threading.Event(),
            account_store=store,
            step_delay_sec=(0.0, 0.0),
            identify_fn=identify_fn or (lambda f: _make_modules_screen()),
            parse_detail_fn=parse_detail_fn,
        )

    # 1) Real parse_module_detail with forbidden prompt mentioning a real module ("SHATTER Galaxy Compressor?") -> immediate abort, 0 taps
    shatter_lines = [
        [
            (620, 420, "SHATTER Galaxy Compressor?"),
            (720, 500, "Mythic Lv.131"),
            (500, 910, "X"),
        ]
    ]
    s1 = _make_scanner(lambda f: loadouts.parse_module_detail(f, lines_fn=lambda _: shatter_lines))
    s1.request_scan(scope="modules", battle_live=False)
    s1.phase, s1._substate, s1._mod_presets, s1._mod_current_slot = "modules", "read_detail", ["Preset 1"], "generator"
    s1.step(_blank_frame(), 10.0)
    assert s1.running is False and s1.phase == "error"
    assert taps == []
    assert store.snapshot()["counts"]["modules_owned"] == 0
    assert len(notifies) == 1

    # 2) Real parse_module_detail with forbidden spend prompt and NO module name -> immediate abort, 0 taps
    notifies.clear()
    spend_lines = [[(700, 350, "BUY 200 Gems for $4.99"), (500, 910, "X")]]
    s2 = _make_scanner(lambda f: loadouts.parse_module_detail(f, lines_fn=lambda _: spend_lines))
    s2.request_scan(scope="modules", battle_live=False)
    s2.phase, s2._substate, s2._mod_presets, s2._mod_current_slot = "modules", "read_detail", ["Preset 1"], "cannon"
    s2.step(_blank_frame(), 20.0)
    assert s2.running is False and s2.phase == "error"
    assert taps == []
    assert len(notifies) == 1

    # 3) Close-X inside Buy Module band (y=310..420) MUST fall back to safe top header (540, 140)
    #    and dimmed background chrome ("BUY MODULE" at y=360, "SHATTER" at y=1020) must NOT false-positive
    normal_lines = [
        [
            (360, 420, "BUY MODULE"),
            (1020, 750, "SHATTER"),
            (365, 900, "X"),  # inside Buy Module y=310..420 band!
            (620, 400, "Galaxy Compressor"),
            (680, 400, "Mythic Lv.131"),
            (800, 300, "+0.4x Coins/Kill Bonus"),
        ]
    ]
    s3 = _make_scanner(lambda f: loadouts.parse_module_detail(f, lines_fn=lambda _: normal_lines))
    s3.request_scan(scope="modules", battle_live=False)
    s3.phase, s3._substate, s3._mod_presets, s3._mod_current_slot = "modules", "read_detail", ["Preset 1"], "generator"
    s3.step(_blank_frame(), 30.0)
    assert s3.running is True
    assert taps == [((540, 140), "scan:module_close_generator")]
    assert store.snapshot()["module_presets"]["Preset 1"]["generator"]["slug"] == "module:galaxy_compressor"

    # 4) Home screen with crashed-run RESUME button: refuse try_start_from_frame and abort _route_to with 0 taps
    taps.clear()
    notifies.clear()
    resume_home = screens.Screen(
        "home",
        {"tier": 9, "highest_wave": 4200, "has_resume": True, "tournament_open": False, "tournament_timer": None},
        {
            "resume": screens.Target("resume", detectors.REF_HOME_BATTLE_BTN, "RESUME", ("battle",)),
            "nav_cards": screens.Target("nav_cards", screens.REF_NAV_CARDS, "CARDS", ("cards",)),
            "nav_modules": screens.Target("nav_modules", screens.REF_NAV_MODULES, "MODULES", ("modules",)),
        },
    )
    s4 = _make_scanner(lambda f: None, identify_fn=lambda f: resume_home)
    s4.request_scan(scope="cards", battle_live=True, queue_if_battle=True)
    assert s4.try_start_from_frame(_blank_frame(), 40.0) is False
    assert s4.queued is True and s4.running is False

    s4.cancel()
    s4.request_scan(scope="cards", battle_live=False)
    s4.step(_blank_frame(), 41.0)
    assert s4.running is False and s4.phase == "error"
    assert "resume" in (s4.error or "").lower()
    assert taps == []
    assert len(notifies) == 1


def test_full_scope_all_sweeps_cards_then_modules_and_returns_home(tmp_path: Path):
    """scope='all' routes home -> cards -> modules -> home in one automated pass."""
    store = loadouts.AccountStore(tmp_path / "account.json")
    emu: dict[str, Any] = {"screen": "home", "open_slot": None}

    def identify(frame: np.ndarray) -> screens.Screen:
        if emu["open_slot"] is not None:
            return screens.Screen("unknown", {}, {})
        if emu["screen"] == "home":
            return _make_home_screen()
        if emu["screen"] == "cards":
            return _make_cards_screen("Preset 1", ["Preset 1"])
        if emu["screen"] == "modules":
            return _make_modules_screen("Preset 1", ["Preset 1"])
        return screens.Screen("unknown", {}, {})

    def do_tap(pt, frame, *, reason="", input_display=None):
        if emu["open_slot"] is not None:
            emu["open_slot"] = None
            return {"x": pt[0], "y": pt[1], "dispatched": True}
        if emu["screen"] == "home" and _in_rect(pt, screens.REF_NAV_CARDS):
            emu["screen"] = "cards"
        elif emu["screen"] == "cards" and _in_rect(pt, screens.REF_NAV_MODULES):
            emu["screen"] = "modules"
        elif emu["screen"] == "modules":
            if _in_rect(pt, screens.REF_NAV_HOME):
                emu["screen"] = "home"
            else:
                for slot, rect in loadouts.REF_MODULE_SLOTS.items():
                    if _in_rect(pt, rect):
                        emu["open_slot"] = slot
                        break
        return {"x": pt[0], "y": pt[1], "dispatched": True}

    scanner = InventoryScanner(
        grab_verified_frame=lambda: (_inv_page_frame(0) if emu["screen"] == "cards" else _blank_frame(), None),
        check_foreground=lambda disp: (True, "ok"),
        tap=do_tap,
        swipe=lambda *a, **kw: {"dispatched": True},
        log=lambda *a, **kw: None,
        notify=lambda *a, **kw: None,
        stop_event=threading.Event(),
        account_store=store,
        rng=random.Random(3),
        step_delay_sec=(0.0, 0.0),
        identify_fn=identify,
        parse_cards_fn=lambda f: {
            "active_slots": "10/10",
            "active_preset": "Preset 1",
            "cards": [{"slug": "card:damage", "name": "Damage", "owned": True, "maxed": True, "stars": 7, "progress": "Max", "equipped": True, "level_text": "7★ Max"}],
        },
        parse_modules_fn=lambda f: {
            "active_preset": "Preset 1",
            "slots": {
                s: {"rect": r, "center": (r[0] + r[2] // 2, r[1] + r[3] // 2), "level": 80, "rarity": "Epic"}
                for s, r in loadouts.REF_MODULE_SLOTS.items()
            },
        },
        parse_detail_fn=lambda f: (
            {
                "cannon": {"slug": "module:death_penalty", "name": "Death Penalty", "slot": "cannon", "rarity": "Epic", "level": 80, "substats": [], "close_center": (900, 450)},
                "armor": {"slug": "module:anti_cube_portal", "name": "Anti-Cube Portal", "slot": "armor", "rarity": "Epic", "level": 80, "substats": [], "close_center": (900, 450)},
                "generator": {"slug": "module:galaxy_compressor", "name": "Galaxy Compressor", "slot": "generator", "rarity": "Epic", "level": 80, "substats": [], "close_center": (900, 450)},
                "core": {"slug": "module:multiverse_nexus", "name": "Multiverse Nexus", "slot": "core", "rarity": "Epic", "level": 80, "substats": [], "close_center": (900, 450)},
            }.get(emu["open_slot"])
            if emu["open_slot"]
            else None
        ),
    )

    scanner.request_scan(scope="all", battle_live=False)
    now = 500.0
    for _ in range(30):
        if not scanner.running:
            break
        scanner.step(_blank_frame(), now)
        now += 1.0

    assert scanner.running is False
    assert scanner.phase == "done"
    assert emu["screen"] == "home"
    snap = store.snapshot()
    assert snap["counts"]["cards_owned"] == 1
    assert snap["counts"]["modules_owned"] == 4

