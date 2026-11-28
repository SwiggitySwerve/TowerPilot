"""Offline tests for Battle Menu routines, Battle History parser & ledger reconciliation, Daily Quests, and Guild Rewards."""
from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import pytest

from app import create_app
from towerpilot import battle_menu, detectors, loadouts, run_rules
from towerpilot.collector import GemCollector
from towerpilot.config import DEFAULT_CONFIG


def _battle_frame(*, menu_open: bool = False) -> np.ndarray:
    frame = np.zeros((2560, 1080, 3), dtype=np.uint8)
    x, y, w, h = detectors.REF_SIDE_MENU_TOGGLE
    cv2.rectangle(frame, (x + 2, y + 2), (x + w - 3, y + h - 3), (250, 250, 250), 2)
    for by in (22, 43, 64):
        cv2.rectangle(frame, (x + 20, y + by), (x + w - 20, y + by + 7), (250, 250, 250), -1)
    if menu_open:
        cv2.rectangle(frame, (860, 15), (1065, 730), (220, 220, 220), 2)
    return frame


class DummyFrames:
    def __init__(self, frame: np.ndarray) -> None:
        self.frame = frame
        self.last_frame = frame
        self.active_backend = "mumu"
        self.last_error = None
        self.last_frame_size = (frame.shape[1], frame.shape[0])
        self.input_display = None

    def latest_or_grab(self, max_age_sec: float = 1.2):
        return self.frame.copy(), "mumu"

    def grab_adb(self):
        return self.frame.copy()

    def read_frame(self, *, prefer_preview: bool = True):
        return self.frame.copy(), "mumu"

    def close(self) -> None:
        pass


# --- 1. Battle History OCR parser & Ledger timing reconciliation ---------


def test_parse_battle_history_page_real_ocr_fixture():
    lines = [
        (114, 33, "BATTLE HISTORY"),
        (323, 784, "11/27/2026"),
        (327, 184, "Tier 10 Wave 8186"),
        (400, 185, "Coins: 18.94T Coins/Hour: 1.74T"),
        (401, 789, "Cells: 210.45K"),
        (518, 791, "11/25/2026"),
        (522, 184, "Tier 8+ Wave 1661"),
        (595, 185, "Coins: 1.51M Coins/Hour: 4.61M Cells: 6.25K"),
        (713, 791, "11/24/2026"),
        (717, 184, "Tier IO Wave 141"),
        (790, 185, "Coins: 6.65B Coins/Hour: 29.17B"),
        (791, 855, "Cells: O"),
        (908, 794, "11/23/2026"),
        (911, 184, "TieriO Wave 2"),
        (985, 185, "Coins: 542.70K Coins/Hour: 151.25M Cells: O"),
        (2438, 235, "Tap To Return To Game"),
    ]
    rows = battle_menu.parse_battle_history_page(lines, frame_height=2560)
    assert len(rows) == 4

    r0 = rows[0]
    assert r0["tier"] == 10
    assert r0["tournament"] is False
    assert r0["wave"] == 8186
    assert r0["date"] == "11/27/2026"
    assert r0["total_coins_raw"] == "18.94T"
    assert r0["coins_per_hour_fmt"] == "1.74T"
    assert r0["cells_raw"] == "210.45K"
    assert r0["duration_exact"] is True
    # 18.94 / 1.74 * 3600 = 39186.2s (~10h 53m)
    assert r0["duration_sec"] == pytest.approx(39186.2, rel=1e-2)

    r1 = rows[1]
    assert r1["tier"] == 8
    assert r1["tournament"] is True
    assert r1["wave"] == 1661
    assert r1["profile"] == "Tournament"

    r2 = rows[2]
    assert r2["tier"] == 10
    assert r2["wave"] == 141
    assert r2["cells_raw"] == "0"


def test_reconcile_inexact_ledger_run_from_battle_history():
    live_runs = [
        {
            "event": "run_ended",
            "tier": 10,
            "wave": 8186,
            "total_coins_raw": "18.94T",
            "total_coins": 18.94e12,
            "coins_verified": True,
            "duration_sec": 15622.4,  # clipped by mid-run tray restart!
            "duration_exact": False,
            "coins_per_hour": None,
            "coins_per_hour_fmt": None,
            "killed_by": "Fast",
            "profile": "Farming",
        }
    ]
    hist_runs = [
        {
            "source": "battle_history",
            "date": "11/27/2026",
            "tier": 10,
            "tournament": False,
            "wave": 8186,
            "total_coins_raw": "18.94T",
            "total_coins": 18.94e12,
            "coins_verified": True,
            "coins_per_hour": 1.74e12,
            "coins_per_hour_fmt": "1.74T",
            "cells_raw": "210.45K",
            "cells": 210450.0,
            "duration_sec": 39186.2,
            "duration_exact": True,
            "profile": "",
        },
        {
            "source": "battle_history",
            "date": "11/25/2026",
            "tier": 8,
            "tournament": True,
            "wave": 1661,
            "total_coins_raw": "1.51M",
            "total_coins": 1.51e6,
            "coins_verified": True,
            "coins_per_hour": 4.61e6,
            "coins_per_hour_fmt": "4.61M",
            "cells_raw": "6.25K",
            "cells": 6250.0,
            "duration_sec": 1179.2,
            "duration_exact": True,
            "profile": "Tournament",
        },
    ]

    # Before reconciliation, inexact duration must NOT pollute avg_duration_sec
    pre_summary = run_rules.summarize_by_tier(live_runs)
    assert pre_summary[0]["avg_duration_sec"] is None
    assert pre_summary[0]["coins_per_hour"] is None

    # After reconciliation, T10 W8186 is repaired in-place & T8+ tournament is kept separate
    merged = run_rules.merge_battle_history_runs(live_runs, hist_runs)
    assert len(merged) == 2
    assert merged[0]["duration_exact"] is True
    assert merged[0]["duration_sec"] == pytest.approx(39186.2)
    assert merged[0]["coins_per_hour_fmt"] == "1.74T"
    assert merged[0]["cells_raw"] == "210.45K"
    assert merged[0]["killed_by"] == "Fast"
    assert merged[0]["reconciled_from_history"] is True

    post_summary = run_rules.summarize_by_tier(merged)
    assert len(post_summary) == 2
    t10 = next(r for r in post_summary if r["tier"] == 10)
    assert t10["coins_per_hour_fmt"] == "1.74T"
    assert t10["avg_duration_sec"] == pytest.approx(39186.2)
    t8 = next(r for r in post_summary if r["tier"] == 8)
    assert t8["tournament"] is True


# --- 2. Daily Missions & Guild Rewards claimable detection ---------------


def test_detect_daily_missions_claimables_excludes_reroll_and_checked_chests():
    frame = np.zeros((2560, 1080, 3), dtype=np.uint8)
    # Draw green checkmark inside chest 15 (claimed) at x~140, y~350; leave chest 20 clean (unclaimed)
    cv2.rectangle(frame, (110, 310), (190, 390), (40, 230, 50), -1)  # bright green BGR
    # Draw white padlock inside chest 25 at x~510
    cv2.rectangle(frame, (485, 325), (535, 375), (250, 250, 250), -1)

    lines = [
        (180, 750, "completed 20/35"),
        (430, 128, "15"),
        (430, 310, "20"),
        (430, 492, "25"),
        (780, 420, "CLAIM"),       # safe mission claim
        (780, 960, "CLAIM 5 GEM"), # unsafe right-edge / gem text -> ignored
        (1080, 420, "BUY $4.99"),  # unsafe spend -> ignored
    ]
    res = battle_menu.detect_daily_missions_claimables(frame, lines)
    assert res["completed"] == 20
    assert len(res["mission_claims"]) == 1
    assert [ms for ms, _ in res["chest_claims"]] == [20]


def test_detect_guild_claimables_excludes_checked_and_leave_button():
    frame = np.zeros((2560, 1080, 3), dtype=np.uint8)
    # Mark chest 100 (cx=181, cy=706) and chest 750 (cx=1015, cy=706) as claimed; leave 250 unclaimed
    cv2.rectangle(frame, (150, 680), (210, 730), (40, 230, 50), -1)
    cv2.rectangle(frame, (985, 680), (1045, 730), (40, 230, 50), -1)

    lines = [
        (755, 113, "100"),
        (755, 306, "250"),
        (755, 625, "500"),
        (755, 947, "750"),
        (834, 727, "Total Contribution: 845"),
    ]
    res = battle_menu.detect_guild_claimables(frame, lines)
    assert res["total_contribution"] == 845
    assert [thr for thr, _ in res["chest_claims"]] == [250, 500]


# --- 3. Full BattleMenuRoutine offline state machine ---------------------


def test_battle_menu_routine_history_sync_end_to_end(tmp_path: Path, monkeypatch):
    taps: list[str] = []
    swipes: list[str] = []
    stage = {"name": "battle_closed"}

    closed_f = _battle_frame(menu_open=False)
    open_f = _battle_frame(menu_open=True)
    hist_f = np.zeros((2560, 1080, 3), dtype=np.uint8)

    def current_f() -> np.ndarray:
        return {"battle_closed": closed_f, "battle_open": open_f, "history": hist_f}[stage["name"]]

    def fake_tap(pt, frame, *, reason="", input_display=None):
        taps.append(reason)
        if reason == "battle_menu:open":
            stage["name"] = "battle_open"
        elif reason == "battle_menu:open_history":
            stage["name"] = "history"
        elif reason == "battle_menu:return_history":
            stage["name"] = "battle_open"
        elif reason == "battle_menu:close":
            stage["name"] = "battle_closed"
        return {"x": pt[0], "y": pt[1]}

    def fake_swipe(start, end, frame, *, duration_ms=550, reason="", input_display=None):
        swipes.append(reason)
        return {"start": start, "end": end}

    monkeypatch.setattr(
        detectors,
        "side_menu_state",
        lambda f: "closed" if stage["name"] == "battle_closed" else ("open" if stage["name"] == "battle_open" else "obscured"),
    )

    page_lines = [
        (114, 33, "BATTLE HISTORY"),
        (323, 784, "11/27/2026"),
        (327, 184, "Tier 10 Wave 8186"),
        (400, 185, "Coins: 18.94T Coins/Hour: 1.74T"),
        (401, 789, "Cells: 210.45K"),
        (2438, 235, "Tap To Return To Game"),
    ]
    hstore = battle_menu.BattleHistoryStore(tmp_path / "battle_history.json")
    astore = loadouts.AccountStore(tmp_path / "account.json")

    def fake_lines(imgs):
        crop = imgs[0]
        if crop.shape[0] <= 150:
            return [[(10, 10, "BATTLE HISTORY")]] if crop.shape[1] > 760 else [[(10, 10, "Tap To Return To Game")]]
        return [page_lines]

    routine = battle_menu.BattleMenuRoutine(
        grab_verified_frame=lambda: (current_f(), None),
        check_foreground=lambda d: (True, "ok"),
        tap=fake_tap,
        swipe=fake_swipe,
        log=lambda *a, **kw: None,
        history_store=hstore,
        account_store=astore,
        step_delay_sec=0.0,
        lines_fn=fake_lines,
    )

    routine.start("history", battle_live=True, trigger="manual")
    now = 100.0
    for _ in range(15):
        if not routine.active:
            break
        routine.step(current_f(), now)
        now += 2.0

    assert routine.active is False
    assert routine.phase == "done"
    assert taps == [
        "battle_menu:open",
        "battle_menu:open_history",
        "battle_menu:return_history",
        "battle_menu:close",
    ]
    assert len(swipes) == 1  # scrolled once, saw same page -> stopped early
    snap = hstore.snapshot()
    assert len(snap["runs"]) == 1
    assert snap["runs"][0]["wave"] == 8186
    assert snap["runs"][0]["coins_per_hour_fmt"] == "1.74T"


# --- 4. Flask /api/routines toggles + on-demand run ----------------------


def test_routines_api_toggles_and_manual_trigger(tmp_path: Path):
    cfg_path = tmp_path / "config.yaml"
    frames = DummyFrames(_battle_frame(menu_open=False))
    app = create_app(config_path=cfg_path, frame_source=frames)
    client = app.test_client()
    collector = app.extensions["towerpilot"]["collector"]

    try:
        # GET defaults
        g = client.get("/api/routines")
        assert g.status_code == 200
        body = g.get_json()
        assert body["routines"]["auto_sync_history"] is False
        assert body["battle_menu"]["active"] is False

        # Toggle auto routines ON and persist to config.yaml
        p = client.post(
            "/api/routines",
            json={"auto_sync_history": True, "auto_claim_daily": True, "auto_claim_guild": True},
        )
        assert p.status_code == 200
        st = p.get_json()
        assert st["routines"]["auto_sync_history"] is True
        assert st["routines"]["auto_claim_daily"] is True
        assert st["routines"]["auto_claim_guild"] is True

        # Reject invalid routine key with 400
        assert client.post("/api/routines", json={"bogus": True}).status_code == 400
        assert client.post("/api/routines", json={"action": "run", "task": "store"}).status_code == 400

        # Manual run refused with 409 while harvesting is OFF
        assert client.post("/api/routines", json={"action": "run", "task": "history"}).status_code == 409

        # Armed when harvesting is ON and battle is live, then cancelled cleanly
        collector.running = True
        collector.battle_live = True
        ok = client.post("/api/routines", json={"action": "run", "task": "history"})
        assert ok.status_code == 200
        assert ok.get_json()["battle_menu"]["active"] is True
        assert ok.get_json()["battle_menu"]["task"] == "history"

        c = client.post("/api/routines", json={"action": "cancel"})
        assert c.status_code == 200
        assert c.get_json()["battle_menu"]["active"] is False
    finally:
        collector.running = False
        app.extensions["towerpilot"]["shutdown"]()


# --- 5. Fable Audit Regression Tests (P1-1, P2-1, P2-2, P2-5, P2-7) ------


def test_p1_1_zero_blind_taps_on_purchase_or_unidentified_overlay(tmp_path: Path, monkeypatch):
    """P1-1: Never tap dismiss/return on a purchase dialog, GAME STATS, or unidentified overlay."""
    taps: list[str] = []
    notified: list[str] = []
    promo_frame = np.zeros((2560, 1080, 3), dtype=np.uint8)

    monkeypatch.setattr(detectors, "side_menu_state", lambda f: "obscured")
    routine = battle_menu.BattleMenuRoutine(
        grab_verified_frame=lambda: (promo_frame, None),
        check_foreground=lambda d: (True, "ok"),
        tap=lambda pt, f, **kw: taps.append(kw.get("reason", "")) or {"x": pt[0], "y": pt[1]},
        swipe=lambda *a, **kw: None,
        log=lambda *a, **kw: None,
        notify=lambda msg: notified.append(msg),
        history_store=battle_menu.BattleHistoryStore(tmp_path / "h.json"),
        account_store=loadouts.AccountStore(tmp_path / "a.json"),
        step_delay_sec=0.0,
        lines_fn=lambda imgs: [[(20, 20, "SPECIAL OFFER $4.99 BUY")]],
    )
    routine.start("guild_rewards", battle_live=True)
    routine.phase = "work"  # Simulate landing directly on a promo popup
    routine.step(promo_frame, 100.0)

    assert routine.active is False
    assert routine.phase == "aborted"
    assert taps == []  # ZERO blind taps!
    assert len(notified) == 1

    # Also refuses to enter work when open_target sees an unexpected obscured frame
    routine2 = battle_menu.BattleMenuRoutine(
        grab_verified_frame=lambda: (promo_frame, None),
        check_foreground=lambda d: (True, "ok"),
        tap=lambda pt, f, **kw: taps.append(kw.get("reason", "")) or {"x": pt[0], "y": pt[1]},
        swipe=lambda *a, **kw: None,
        log=lambda *a, **kw: None,
        history_store=battle_menu.BattleHistoryStore(tmp_path / "h2.json"),
        account_store=loadouts.AccountStore(tmp_path / "a2.json"),
        step_delay_sec=0.0,
        lines_fn=lambda imgs: [[(20, 20, "UNKNOWN")]],
    )
    routine2.start("history", battle_live=True)
    routine2.phase = "open_target"
    routine2.step(promo_frame, 100.0)
    assert routine2.active is False
    assert routine2.phase == "aborted"
    assert taps == []


def test_p2_2_in_battle_cards_and_modules_persist_to_account_store(tmp_path: Path, monkeypatch):
    """P2-2: In-battle Cards and Modules routines record into AccountStore via record_cards_scan/record_module_slot."""
    astore = loadouts.AccountStore(tmp_path / "account.json")
    hstore = battle_menu.BattleHistoryStore(tmp_path / "history.json")
    dummy_f = np.zeros((2560, 1080, 3), dtype=np.uint8)
    stage = {"s": "overlay"}

    monkeypatch.setattr(detectors, "side_menu_state", lambda f: "closed" if stage["s"] == "closed" else "obscured")
    monkeypatch.setattr(
        loadouts,
        "parse_cards_page",
        lambda f: {
            "active_preset": "Preset 1",
            "active_slots": "20/20",
            "cards": [{"slug": "card:damage", "name": "Damage", "equipped": True, "maxed": True}],
        },
    )
    monkeypatch.setattr(
        loadouts,
        "parse_modules_equipped",
        lambda f: {
            "active_preset": "Preset 1",
            "slots": {
                "cannon": {"slug": "module:death_penalty", "name": "Death Penalty", "level": 120, "rarity": "Ancestral"},
            },
        },
    )

    def tap_close(pt, f, **kw):
        if "return_" in kw.get("reason", ""):
            stage["s"] = "closed"
        return {"x": pt[0], "y": pt[1]}

    # Cards scan
    r_cards = battle_menu.BattleMenuRoutine(
        grab_verified_frame=lambda: (dummy_f, None),
        check_foreground=lambda d: (True, "ok"),
        tap=tap_close,
        swipe=lambda *a, **kw: None,
        log=lambda *a, **kw: None,
        history_store=hstore,
        account_store=astore,
        step_delay_sec=0.0,
        lines_fn=lambda imgs: [[(10, 10, "CARDS")] if imgs[0].shape[1] > 760 else [(10, 10, "Tap To Return To Game")]],
    )
    r_cards.start("cards", battle_live=True)
    r_cards.phase = "work"
    now = 100.0
    for _ in range(8):
        if not r_cards.active:
            break
        r_cards.step(dummy_f, now)
        now += 2.0
    snap = astore.snapshot()
    assert snap["total_items"] >= 1
    assert any(c["slug"] == "card:damage" for c in snap["cards"])
    assert snap["active_card_slots"] == "20/20"

    # Modules scan
    stage["s"] = "overlay"
    r_mods = battle_menu.BattleMenuRoutine(
        grab_verified_frame=lambda: (dummy_f, None),
        check_foreground=lambda d: (True, "ok"),
        tap=tap_close,
        swipe=lambda *a, **kw: None,
        log=lambda *a, **kw: None,
        history_store=hstore,
        account_store=astore,
        step_delay_sec=0.0,
        lines_fn=lambda imgs: [[(10, 10, "MODULES")] if imgs[0].shape[1] > 760 else [(10, 10, "Tap To Return To Game")]],
    )
    r_mods.start("modules", battle_live=True)
    r_mods.phase = "work"
    for _ in range(8):
        if not r_mods.active:
            break
        r_mods.step(dummy_f, now)
        now += 2.0
    snap2 = astore.snapshot()
    assert any(m["slug"] == "module:death_penalty" for m in snap2["modules"])


def test_p2_5_battle_history_skips_clipped_coinless_card_and_parses_zero_o():
    """P2-5: Clipped bottom card without Coins line is skipped; 'Coins: O' parses as 0."""
    lines = [
        (327, 184, "Tier 10 Wave 8186"),
        (400, 185, "Coins: O Coins/Hour: O Cells: O"),
        (2295, 184, "Tier 10 Wave 9999"),  # Clipped at bottom — no Coins line!
    ]
    rows = battle_menu.parse_battle_history_page(lines, frame_height=2560)
    assert len(rows) == 1
    assert rows[0]["wave"] == 8186
    assert rows[0]["total_coins"] == 0.0


def test_p2_7_merged_chest_lines_map_distinct_rects_and_unverified_claims_not_counted(tmp_path: Path, monkeypatch):
    """P2-7: Merged '100 250 500 750' line maps to 4 distinct x rects, and persistent claim isn't counted."""
    frame = np.zeros((2560, 1080, 3), dtype=np.uint8)
    lines = [
        (760, 110, "100 250 500 750"),
        (840, 660, "Total Contribution: 800"),
    ]
    res = battle_menu.detect_guild_claimables(frame, lines)
    xs = [rect[0] for _, rect in res["chest_claims"]]
    assert len(xs) == 4
    assert len(set(xs)) == 4  # Four distinct chest positions!

    # Also verify merged description + CLAIM aims near CLAIM token, not description start
    daily_res = battle_menu.detect_daily_missions_claimables(
        frame,
        [(780, 60, "Destroy 5000 Enemies CLAIM")],
    )
    assert len(daily_res["mission_claims"]) == 1
    rx, _ry, rw, _rh = daily_res["mission_claims"][0]
    assert rx + rw // 2 > 300  # Aimed at CLAIM, NOT at 'Destroy' (x=60)


def test_p2_d_exit_and_store_fence_unconditional_except_verified_guild_750(tmp_path: Path):
    import threading

    obscured_frame = np.zeros((2560, 1080, 3), dtype=np.uint8)
    taps: list[tuple[int, int]] = []
    store = loadouts.AccountStore(tmp_path / "account.json")
    hist = battle_menu.BattleHistoryStore(tmp_path / "history.json")
    ctrl = battle_menu.BattleMenuRoutine(
        grab_verified_frame=lambda: (obscured_frame.copy(), None),
        check_foreground=lambda disp: (True, ""),
        tap=lambda pt, frame, **k: (taps.append(pt) or {"ok": True}),
        swipe=lambda *a, **k: {"ok": True},
        log=lambda *a, **k: None,
        notify=lambda *a, **k: None,
        stop_event=threading.Event(),
        account_store=store,
        history_store=hist,
    )
    ctrl.active = True
    ctrl.task = "daily_quests"
    ctrl.phase = "work"

    # Point inside REF_FORBIDDEN_EXIT (850..1080, 640..750) is blocked EVEN on obscured frames
    res_blocked = ctrl._safe_tap((960, 690), obscured_frame, reason="battle_menu:claim_daily", input_display=None)
    assert res_blocked is None
    assert taps == []

    # Only an explicit header-verified Guild 750 chest tap is exempted from EXIT rect overlap
    ctrl.active = True
    ctrl.task = "guild_rewards"
    ctrl.phase = "work"
    res_guild750 = ctrl._safe_tap(
        (1015, 690),
        obscured_frame,
        reason="battle_menu:claim_guild_750",
        input_display=None,
        guild_guard=True,
        allow_guild_750_chest=True,
    )
    assert res_guild750 is not None
    assert len(taps) == 1


def test_never_records_battle_perks_or_in_battle_workshop_as_base_unlocks(tmp_path: Path):
    import threading

    live_frame = _battle_frame(menu_open=False)
    store = loadouts.AccountStore(tmp_path / "account.json")
    hist = battle_menu.BattleHistoryStore(tmp_path / "history.json")
    ctrl = battle_menu.BattleMenuRoutine(
        grab_verified_frame=lambda: (live_frame.copy(), None),
        check_foreground=lambda disp: (True, ""),
        tap=lambda *a, **k: {"ok": True},
        swipe=lambda *a, **k: {"ok": True},
        log=lambda *a, **k: None,
        notify=lambda *a, **k: None,
        stop_event=threading.Event(),
        account_store=store,
        history_store=hist,
    )
    # 1) BattleMenuRoutine rejects 'workshop' task (never scrapes live battle panel)
    with pytest.raises(ValueError):
        ctrl.start("workshop", battle_live=True)

    # 2) Live battle frame (menu toggle visible) is ignored by observe_frame()
    obs_battle = loadouts.observe_frame(
        live_frame,
        lines_fn=lambda crops: [[(1820, 40, "ULTIMATE WEAPONS"), (1950, 80, "Poison Swamp"), (2050, 80, "Inner Land Mines")]],
    )
    assert obs_battle["screen"] == "battle"
    assert obs_battle["items"] == []

    # 3) Off-battle Home Workshop & Home UWs screens record permanently unlocked items while skipping locked UNLOCK rows
    home_frame = np.zeros((2560, 1080, 3), dtype=np.uint8)
    obs_ws = loadouts.observe_frame(
        home_frame,
        lines_fn=lambda crops: [[
            (1820, 40, "ATTACK UPGRADES"),
            (1940, 60, "Damage"),
            (1960, 260, "x1.35 250"),
            (2120, 60, "Rend Armor Chance"),
            (2140, 240, "UNLOCK 500B"),
        ]],
    )
    assert obs_ws["screen"] == "workshop"
    ws_by_slug = {it["slug"]: it for it in obs_ws["items"]}
    assert "workshop:damage" in ws_by_slug
    assert "Lv." not in ws_by_slug["workshop:damage"]["detail"]  # P3: x1.35 must not parse as Lv.35
    assert "workshop:rend_armor_chance" not in ws_by_slug

    obs_uw = loadouts.observe_frame(
        home_frame,
        lines_fn=lambda crops: [[
            (1820, 40, "ULTIMATE WEAPONS"),
            (1940, 60, "Golden Tower"),
            (2080, 60, "Golden Comb0"),  # P3: noisy UW+ must resolve to uw_plus:golden_combo, not base UW
            (2220, 60, "Unlock New Ultimate Weapon"),
        ]],
    )
    assert obs_uw["screen"] == "ultimate_weapons"
    uw_slugs = {it["slug"] for it in obs_uw["items"]}
    assert "uw:golden_tower" in uw_slugs
    assert "uw_plus:golden_combo" in uw_slugs
    snap = store.merge_observation(obs_uw)
    assert snap["counts"]["uws_owned"] == 1
    assert snap["counts"]["uw_plus_owned"] == 1


def test_p2_c_api_observe_refuses_workshop_when_collector_reports_battle_live(tmp_path: Path, monkeypatch):
    cfg_path = tmp_path / "config.yaml"
    dimmed_frame = np.zeros((2560, 1080, 3), dtype=np.uint8)
    frames = DummyFrames(dimmed_frame)
    app = create_app(config_path=cfg_path, frame_source=frames)
    client = app.test_client()
    collector = app.extensions["towerpilot"]["collector"]
    collector.running = True
    collector.battle_live = True
    collector._last_battle_state = (True, "closed")

    monkeypatch.setattr(
        loadouts,
        "observe_frame",
        lambda frame: {
            "screen": "workshop",
            "observed_at": 123.0,
            "tier": None,
            "presets": [],
            "items": [{"slug": "workshop:damage", "name": "Damage", "category": "workshop", "detail": ""}],
            "line_count": 2,
        },
    )
    res = client.post("/api/account", json={"action": "observe"})
    assert res.status_code == 200
    body = res.get_json()
    assert body["observed"]["screen"] == "battle"
    assert body["observed"]["items"] == []
    assert body["account"]["counts"]["workshop_owned"] == 0


def test_battle_menu_modules_sweep_reads_main_slots_and_epic_plus_inventory(tmp_path: Path):
    import threading

    mod_frame = np.zeros((2560, 1080, 3), dtype=np.uint8)
    battle_closed = _battle_frame(menu_open=False)
    state = {"popup": None, "frame": mod_frame}
    taps: list[tuple[int, int, str]] = []
    store = loadouts.AccountStore(tmp_path / "account.json")
    hist = battle_menu.BattleHistoryStore(tmp_path / "history.json")

    slot_details = {
        "cannon": {"slug": "module:death_penalty", "name": "Death Penalty", "slot": "cannon", "level": 137, "rarity": "Ancestral", "substats": ["+5% Attack Speed"], "close_center": (820, 260), "forbidden": False},
        "armor": {"slug": "module:anti_cube_portal", "name": "Anti-Cube Portal", "slot": "armor", "level": 100, "rarity": "Legendary", "substats": [], "close_center": (820, 260), "forbidden": False},
        "generator": {"slug": "module:galaxy_compressor", "name": "Galaxy Compressor", "slot": "generator", "level": 136, "rarity": "Mythic", "substats": [], "close_center": (820, 260), "forbidden": False},
        "core": {"slug": "module:dimension_core", "name": "Dimension Core", "slot": "core", "level": 100, "rarity": "Legendary", "substats": [], "close_center": (820, 260), "forbidden": False},
    }
    inv_details = [
        {"slug": "module:multiverse_nexus", "name": "Multiverse Nexus", "slot": "core", "level": 1, "rarity": "Epic+", "substats": [], "close_center": (820, 260), "forbidden": False},
        {"slug": None, "name": "", "slot": "", "level": 1, "rarity": "Legendary+", "substats": [], "close_center": (820, 260), "forbidden": False, "non_unique": True},
    ]

    def fake_tap(pt, frame, *, reason="", input_display=None):
        taps.append((pt[0], pt[1], reason))
        if reason.startswith("battle_menu:mod_slot_"):
            slot = reason.split("battle_menu:mod_slot_")[1]
            state["popup"] = slot_details[slot]
        elif reason.startswith("battle_menu:mod_inv_close") or reason.startswith("battle_menu:mod_close_"):
            state["popup"] = None
        elif reason.startswith("battle_menu:mod_inv_"):
            idx = int(reason.split("battle_menu:mod_inv_")[1])
            state["popup"] = inv_details[idx]
        elif reason.startswith("battle_menu:return_"):
            state["frame"] = battle_closed
        return {"ok": True}

    def fake_lines(crops):
        if state["frame"] is battle_closed:
            return [[]]
        if len(crops) == 1 and crops[0].shape[0] <= 150:
            if crops[0].shape[1] == 820:
                return [[(100, 40, "MODULES")]]
            return [[(40, 200, "Tap To Return To Game")]]
        return [[]]

    ctrl = battle_menu.BattleMenuRoutine(
        grab_verified_frame=lambda: (state["frame"].copy(), None),
        check_foreground=lambda disp: (True, ""),
        tap=fake_tap,
        swipe=lambda *a, **k: {"ok": True},
        log=lambda *a, **k: None,
        notify=lambda *a, **k: None,
        stop_event=threading.Event(),
        account_store=store,
        history_store=hist,
        step_delay_sec=0.0,
        lines_fn=fake_lines,
        parse_modules_fn=lambda f: {
            "active_preset": "Preset 1",
            "slots": {
                "cannon": {"center": (305, 530), "level": 137, "rarity": "Ancestral"},
                "armor": {"center": (305, 770), "level": 100, "rarity": "Legendary"},
                "generator": {"center": (770, 530), "level": 136, "rarity": "Mythic"},
                "core": {"center": (770, 770), "level": 100, "rarity": "Legendary"},
            },
        },
        parse_detail_fn=lambda f: state["popup"],
        detect_mod_inv_fn=lambda f: {
            "tiles": [
                {"center": (144, 1198), "rarity": "Epic", "sig": np.full((16, 16), 10.0, dtype=np.float32)},
                {"center": (343, 1198), "rarity": "Legendary", "sig": np.full((16, 16), 80.0, dtype=np.float32)},
                # Identical signature to tile 2 -> must be skipped without tapping
                {"center": (542, 1198), "rarity": "Legendary", "sig": np.full((16, 16), 80.0, dtype=np.float32)},
            ],
            "has_lower_tier": True,  # stops scrolling once lower-tier Rare/Common appears
            "total_tiles": 5,
        },
    )
    ctrl.active = True
    ctrl.task = "modules"
    ctrl.phase = "work"

    now = 100.0
    for _ in range(40):
        now += 1.0
        if not ctrl.step(state["frame"], now):
            break

    assert ctrl.active is False
    assert ctrl.error is None
    snap = store.snapshot()
    # 4 main slots + 1 unique Epic+ inventory module (generic fodder ignored, duplicate fodder skipped)
    assert snap["counts"]["modules_owned"] == 5
    owned_slugs = {m["slug"] for m in snap["catalog"]["modules"] if m["owned"]}
    assert owned_slugs == {
        "module:death_penalty",
        "module:anti_cube_portal",
        "module:galaxy_compressor",
        "module:dimension_core",
        "module:multiverse_nexus",
    }
    # Only 2 inventory tiles tapped (3rd was visual duplicate)
    inv_taps = [r for _, _, r in taps if r.startswith("battle_menu:mod_inv_") and not r.startswith("battle_menu:mod_inv_close")]
    assert len(inv_taps) == 2


def test_battle_menu_modules_scrolls_inventory_to_top_when_opened_at_bottom(tmp_path: Path):
    """If the game opens Modules scrolled down to Rare/Common, sweep scrolls back to top before scanning Epic+."""
    import threading

    def page_frame(pg: int) -> np.ndarray:
        f = np.zeros((2560, 1080, 3), dtype=np.uint8)
        f[1100:2200, 50:1030] = (pg + 1) * 70
        return f

    battle_closed = _battle_frame(menu_open=False)
    state = {"page": 2, "popup": None, "returned": False}
    swipes: list[tuple[tuple[int, int], tuple[int, int], str]] = []
    store = loadouts.AccountStore(tmp_path / "account.json")
    hist = battle_menu.BattleHistoryStore(tmp_path / "history.json")

    def current_frame() -> np.ndarray:
        return battle_closed if state["returned"] else page_frame(state["page"])

    def fake_tap(pt, frame, *, reason="", input_display=None):
        if reason.startswith("battle_menu:mod_slot_"):
            state["popup"] = {"slug": "module:gilded_sniper", "name": "Gilded Sniper", "slot": "cannon", "level": 137, "rarity": "Ancestral", "substats": [], "close_center": (820, 260), "forbidden": False}
        elif reason.startswith("battle_menu:mod_inv_close") or reason.startswith("battle_menu:mod_close_"):
            state["popup"] = None
        elif reason.startswith("battle_menu:mod_inv_"):
            state["popup"] = {"slug": "module:infinity_threshold", "name": "Infinity Threshold", "slot": "generator", "level": 136, "rarity": "Mythic+", "substats": [], "close_center": (820, 260), "forbidden": False}
        elif reason.startswith("battle_menu:return_"):
            state["returned"] = True
        return {"ok": True}

    def fake_swipe(start, end, frame, *, duration_ms=500, reason="", input_display=None):
        swipes.append((start, end, reason))
        if start[1] < end[1]:  # finger drags down -> scroll content UP to top
            state["page"] = max(0, state["page"] - 1)
        else:
            state["page"] = min(2, state["page"] + 1)
        return {"ok": True}

    def fake_lines(crops):
        if state["returned"]:
            return [[]]
        if len(crops) == 1 and crops[0].shape[0] <= 150:
            if crops[0].shape[1] == 820:
                return [[(100, 40, "MODULES")]]
            return [[(40, 200, "Tap To Return To Game")]]
        return [[]]

    def fake_detect(frame):
        # Page 2 has only lower-tier Rare/Common; Page 0 has top Epic+ module
        if state["page"] == 0:
            return {
                "tiles": [{"center": (144, 1198), "rarity": "Mythic", "sig": np.full((16, 16), 25.0, dtype=np.float32)}],
                "has_lower_tier": True,
                "total_tiles": 4,
            }
        return {"tiles": [], "has_lower_tier": True, "total_tiles": 10}

    ctrl = battle_menu.BattleMenuRoutine(
        grab_verified_frame=lambda: (current_frame().copy(), None),
        check_foreground=lambda disp: (True, ""),
        tap=fake_tap,
        swipe=fake_swipe,
        log=lambda *a, **k: None,
        notify=lambda *a, **k: None,
        stop_event=threading.Event(),
        account_store=store,
        history_store=hist,
        step_delay_sec=0.0,
        lines_fn=fake_lines,
        parse_modules_fn=lambda f: {"active_preset": "Preset 1", "slots": {}},
        parse_detail_fn=lambda f: state["popup"],
        detect_mod_inv_fn=fake_detect,
    )
    ctrl.active = True
    ctrl.task = "modules"
    ctrl.phase = "work"

    now = 100.0
    for _ in range(50):
        now += 1.0
        if not ctrl.step(current_frame(), now):
            break

    assert ctrl.active is False
    assert ctrl.error is None
    assert state["page"] == 0
    top_swipes = [r for _, _, r in swipes if r.startswith("battle_menu:scroll_mod_inv_top_")]
    assert len(top_swipes) >= 2
    owned_slugs = {m["slug"] for m in store.snapshot()["catalog"]["modules"] if m["owned"]}
    assert "module:gilded_sniper" in owned_slugs
    assert "module:infinity_threshold" in owned_slugs





