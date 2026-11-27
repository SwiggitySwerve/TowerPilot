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
    # Mark chest 100 as claimed (green checkmark around x=170, y=700), leave 250 unclaimed
    cv2.rectangle(frame, (130, 665), (210, 735), (40, 230, 50), -1)

    lines = [
        (760, 110, "100"),
        (760, 300, "250"),
        (760, 600, "500"),
        (840, 660, "Total Contribution: 300"),
    ]
    res = battle_menu.detect_guild_claimables(frame, lines)
    assert res["total_contribution"] == 300
    assert [thr for thr, _ in res["chest_claims"]] == [250]


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
    ]
    hstore = battle_menu.BattleHistoryStore(tmp_path / "battle_history.json")
    astore = loadouts.AccountStore(tmp_path / "account.json")

    routine = battle_menu.BattleMenuRoutine(
        grab_verified_frame=lambda: (current_f(), None),
        check_foreground=lambda d: (True, "ok"),
        tap=fake_tap,
        swipe=fake_swipe,
        log=lambda *a, **kw: None,
        history_store=hstore,
        account_store=astore,
        step_delay_sec=0.0,
        lines_fn=lambda imgs: [page_lines],
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
