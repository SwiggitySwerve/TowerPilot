"""Tests for towerpilot.telemetry OTEL event logging and persistent metrics engine."""
from __future__ import annotations

import json
import re
import threading
import urllib.request

from towerpilot import run_rules
from towerpilot.telemetry import (
    SCHEMA_VERSION,
    SERVICE_NAME,
    Telemetry,
    derive_severity,
    otel_event_name,
)

_PROM_NAME_RE = re.compile(r"^[a-zA-Z_:][a-zA-Z0-9_:]*$")


def test_otel_envelope_and_backwards_compat_keys(tmp_path, monkeypatch):
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    log_file = tmp_path / "events.jsonl"
    clock = [1_732_680_000.25]
    tel = Telemetry(log_file, session_id="deadbeef", now_fn=lambda: clock[0])
    tel.set_profile("farm-default", "Farm T9")

    tel.log("Start battle", event="home_battle_tapped", x=540, y=2060, tier=9)
    clock[0] += 12.5
    entry = tel.log("Ad Gem collected (ocr)", event="ad_gem_collected", trigger="ocr", count=1, x=130, y=670)
    clock[0] += 1.0
    tel.log("Tap refused", event="tap_refused", reason="ad_gem:ocr", error="rate_limit")
    clock[0] += 1.0
    tel.log("Holding max runs", event="run_hold", reason="max_runs")
    clock[0] += 1.0
    tel.log("Custom event", event="custom_widget_ping", flag=True)

    # Return value & JSONL file contents match
    lines = [json.loads(line) for line in log_file.read_text(encoding="utf-8").splitlines()]
    assert len(lines) == 5

    ad_row = lines[1]
    assert ad_row == entry
    # Backwards-compatible flat keys
    assert ad_row["ts"] == 1_732_680_012.75
    assert isinstance(ad_row["iso"], str) and "T" in ad_row["iso"]
    assert ad_row["event"] == "ad_gem_collected"
    assert ad_row["msg"] == "Ad Gem collected (ocr)"
    assert ad_row["trigger"] == "ocr"
    assert ad_row["count"] == 1
    # Standardized OTEL Log Record fields
    assert ad_row["schema_version"] == SCHEMA_VERSION
    assert ad_row["time_unix_nano"] == int(1_732_680_012.75 * 1_000_000_000)
    assert ad_row["severity_text"] == "INFO"
    assert ad_row["otel_event"] == "towerpilot.gem.ad.collected"
    assert ad_row["service"] == SERVICE_NAME
    assert ad_row["session_id"] == "deadbeef"
    assert ad_row["iteration_id"] == "iter-0001"
    assert ad_row["profile_id"] == "farm-default"
    assert ad_row["profile_name"] == "Farm T9"
    assert ad_row["attributes"] == {"trigger": "ocr", "count": 1, "x": 130, "y": 670}

    # Severity auto-derivation & canonical OTEL event mapping + fallback
    assert lines[0]["otel_event"] == "towerpilot.nav.battle.start"
    assert lines[0]["iteration_id"] == "iter-0001"
    assert lines[2]["severity_text"] == "ERROR"
    assert lines[2]["otel_event"] == "towerpilot.tap.refused"
    assert lines[3]["severity_text"] == "WARN"
    assert lines[3]["otel_event"] == "towerpilot.run.hold"
    assert lines[4]["severity_text"] == "INFO"
    assert lines[4]["otel_event"] == "towerpilot.custom.widget.ping"

    # Direct helper checks
    assert derive_severity("ad_gem_error") == "ERROR"
    assert derive_severity("ad_gem_skipped") == "WARN"
    assert derive_severity("battle_frozen") == "WARN"
    assert derive_severity("info", severity="warning") == "WARN"
    assert otel_event_name("end_stats_retry_tapped") == "towerpilot.nav.retry"
    assert otel_event_name("profile_switched") == "towerpilot.profile.switched"


def test_multi_iteration_persistence_across_restarts(tmp_path, monkeypatch):
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    log_file = tmp_path / "events.jsonl"
    clock = [1_732_700_000.0]

    tel1 = Telemetry(log_file, session_id="sess0001", now_fn=lambda: clock[0])
    tel1.set_profile("farm-default", "Farm T9")

    # Iteration 1: nav_step -> BATTLE -> 2 ad gems + 1 floating gem -> run_ended (1 hour, 12T coins)
    e_nav = tel1.log("Select preset", event="nav_step", screen="cards", preset="Preset 1")
    e_start = tel1.log("Tap BATTLE", event="home_battle_tapped", tier=9)
    e_ad1 = tel1.log("Ad gem 1", event="ad_gem_collected", trigger="ocr", count=1)
    e_ad2 = tel1.log("Ad gem 2", event="ad_gem_collected", trigger="ocr", count=2)
    e_fg1 = tel1.log("FG 1", event="floating_gem_collected", trigger="vision", count=1)
    e_end1 = tel1.log(
        "Run ended",
        event="run_ended",
        tier=9,
        wave=6000,
        highest_wave=6200,
        killed_by="Scatter",
        duration_sec=3600.0,
        duration_exact=True,
        total_coins=12e12,
        total_coins_raw="12.00T",
        coins_verified=True,
    )
    assert {e_nav["iteration_id"], e_start["iteration_id"], e_ad1["iteration_id"], e_ad2["iteration_id"], e_fg1["iteration_id"], e_end1["iteration_id"]} == {
        "iter-0001"
    }

    # Iteration 2: switch profile -> RETRY -> 1 ad gem + 2 floating gems + freeze + error -> run_ended (30 min, 6T coins)
    clock[0] += 3700.0
    tel1.log("Switched to push", event="profile_switched", profile_id="tier-push", profile_name="Tier Push")
    e_retry = tel1.log("Tap RETRY", event="end_stats_retry_tapped", tier=11)
    e_ad3 = tel1.log("Ad gem 3", event="ad_gem_collected", trigger="ocr", count=3)
    e_fg2 = tel1.log("FG 2", event="floating_gem_collected", trigger="vision", count=2)
    e_fg3 = tel1.log("FG 3", event="floating_gem_collected", trigger="vision", count=3)
    tel1.log("Ad timer tap", event="ad_gem_attempted", trigger="timer")
    tel1.log("FG timer tap", event="floating_gem_attempted", trigger="timer")
    tel1.log("Frozen", event="battle_frozen", wave=4200)
    tel1.log("OCR error", event="ad_gem_error", error="timeout")
    tel1.log("Hold quiet", event="run_hold", reason="no_start_window")
    e_end2 = tel1.log(
        "Run ended",
        event="run_ended",
        tier=11,
        wave=4500,
        highest_wave=4500,
        killed_by="Boss",
        duration_sec=1800.0,
        duration_exact=True,
        total_coins=6e12,
        total_coins_raw="6.00T",
        coins_verified=True,
    )
    assert {e_retry["iteration_id"], e_ad3["iteration_id"], e_fg2["iteration_id"], e_fg3["iteration_id"], e_end2["iteration_id"]} == {
        "iter-0002"
    }

    # Restart: reload a brand-new Telemetry instance from the same events.jsonl
    clock[0] += 50.0
    tel2 = Telemetry(log_file, session_id="sess0002", now_fn=lambda: clock[0])
    clock[0] += 15.0
    snap = tel2.snapshot()

    # Session counters start fresh at 0 on restart
    assert snap["session"]["session_id"] == "sess0002"
    assert snap["session"]["uptime_sec"] == 15.0
    assert snap["session"]["ad_gems"] == 0
    assert snap["session"]["runs_completed"] == 0

    # All-time counters persisted accurately
    at = snap["all_time"]
    assert at["ad_gems"] == 3
    assert at["floating_gems"] == 3
    assert at["total_gems"] == 6
    assert at["ad_attempts"] == 1
    assert at["floating_attempts"] == 1
    assert at["runs_completed"] == 2
    assert at["runs_restarted"] == 2
    assert at["nav_taps"] == 1  # schema_version>=1 counts only nav_step (no double-count with *_tapped)
    assert at["holds"] == 1
    assert at["errors"] == 1
    assert at["freezes"] == 1
    assert at["total_coins"] == 18e12
    assert at["total_duration_sec"] == 5400.0

    # Per-profile aggregates persisted accurately
    farm = snap["by_profile"]["farm-default"]
    assert farm["profile_name"] == "Farm T9"
    assert farm["runs"] == 1
    assert farm["ad_gems"] == 2
    assert farm["floating_gems"] == 1
    assert farm["total_gems"] == 3
    assert farm["avg_wave"] == 6000
    assert farm["best_wave"] == 6000
    assert farm["total_coins"] == 12e12
    assert farm["coins_per_hour"] == 12e12
    assert farm["coins_per_hour_fmt"] == "12.00T"
    assert farm["gems_per_hour"] == 3.0
    assert farm["avg_duration_sec"] == 3600.0

    push = snap["by_profile"]["tier-push"]
    assert push["runs"] == 1
    assert push["ad_gems"] == 1
    assert push["floating_gems"] == 2
    assert push["total_gems"] == 3
    assert push["coins_per_hour"] == 12e12
    assert push["gems_per_hour"] == 6.0  # 3 gems / 0.5 hr

    # Iterations array is newest-first with exact per-iteration gem counts
    iters = snap["iterations"]
    assert len(iters) == 2
    assert iters[0]["iteration_id"] == "iter-0002"
    assert iters[0]["profile_id"] == "tier-push"
    assert iters[0]["ad_gems"] == 1
    assert iters[0]["floating_gems"] == 2
    assert iters[0]["coins_per_hour_fmt"] == "12.00T"
    assert iters[1]["iteration_id"] == "iter-0001"
    assert iters[1]["profile_id"] == "farm-default"
    assert iters[1]["ad_gems"] == 2
    assert iters[1]["floating_gems"] == 1

    # by_tier aligns with run_rules.summarize_by_tier
    assert len(snap["by_tier"]) == 2
    assert snap["by_tier"][0]["tier"] == 11
    assert snap["by_tier"][1]["tier"] == 9

    # Next iteration after restart continues monotonically at iter-0003
    e_next = tel2.log("Battle 3", event="home_battle_tapped", tier=9)
    assert e_next["iteration_id"] == "iter-0003"
    # Legacy run_rules.load_run_ledger still parses the OTEL-enriched file cleanly
    ledger = run_rules.load_run_ledger(log_file)
    assert len(ledger) == 2
    assert ledger[0]["wave"] == 4500


def test_legacy_jsonl_backwards_compatibility(tmp_path, monkeypatch):
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    log_file = tmp_path / "events.jsonl"
    legacy_rows = [
        json.dumps({"ts": 1700000001.0, "iso": "2025-01-01T00:00:01", "event": "battle_live", "msg": "Battle live"}),
        json.dumps({"ts": 1700000100.0, "iso": "2025-01-01T00:01:40", "event": "ad_gem_collected", "msg": "Ad gem", "trigger": "ocr", "count": 1}),
        json.dumps({"ts": 1700000200.0, "iso": "2025-01-01T00:03:20", "event": "floating_gem_collected", "msg": "FG", "trigger": "vision", "count": 1}),
        "not-valid-json{{{",
        "[1, 2, 3]",
        "",
        json.dumps(
            {
                "ts": 1700003601.0,
                "iso": "2025-01-01T01:00:01",
                "event": "run_ended",
                "msg": "Run ended: T9 W5000",
                "tier": 9,
                "wave": 5000,
                "highest_wave": 5100,
                "killed_by": "Fast",
                "total_coins": 5e12,
                "total_coins_raw": "5.00T",
                "coins_verified": True,
                "duration_sec": 3600.0,
                "duration_exact": True,
                "profile": "Legacy Farm",
            }
        ),
        json.dumps({"ts": 1700003610.0, "iso": "2025-01-01T01:00:10", "event": "capture_error", "msg": "ADB lost"}),
    ]
    log_file.write_text("\n".join(legacy_rows) + "\n", encoding="utf-8")

    tel = Telemetry(log_file, session_id="new00001")
    snap = tel.snapshot()

    assert snap["all_time"]["ad_gems"] == 1
    assert snap["all_time"]["floating_gems"] == 1
    assert snap["all_time"]["runs_completed"] == 1
    assert snap["all_time"]["errors"] == 1
    assert snap["iterations"][0]["iteration_id"] == "legacy-0001"
    assert snap["iterations"][0]["profile_name"] == "Legacy Farm"
    assert snap["iterations"][0]["ad_gems"] == 1
    assert snap["iterations"][0]["floating_gems"] == 1
    assert snap["by_profile"]["Legacy Farm"]["total_gems"] == 2
    assert snap["by_profile"]["Legacy Farm"]["coins_per_hour_fmt"] == "5.00T"


def test_prometheus_export_format_and_escaping(tmp_path, monkeypatch):
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    log_file = tmp_path / "events.jsonl"
    tel = Telemetry(log_file, session_id="prom1234", now_fn=lambda: 1_732_700_000.0)
    tel.set_profile("p1", 'Farm "T9"\nAlpha\\Beta')
    tel.log("Ad gem", event="ad_gem_collected", trigger="ocr")
    tel.log("Run ended", event="run_ended", tier=9, wave=4000, duration_sec=3600.0, total_coins=4e12, coins_verified=True)

    text = tel.to_prometheus()
    assert text.endswith("\n")
    lines = [line for line in text.splitlines() if line]
    type_lines = [line for line in lines if line.startswith("# TYPE ")]
    help_lines = [line for line in lines if line.startswith("# HELP ")]
    assert len(type_lines) >= 10
    assert len(help_lines) == len(type_lines)

    for line in type_lines:
        _, _, name, mtype = line.split(" ", 3)
        assert _PROM_NAME_RE.match(name), f"Invalid Prometheus metric name: {name}"
        assert mtype in ("counter", "gauge")

    # Verify proper Prometheus label escaping
    assert r'profile_name="Farm \"T9\"\nAlpha\\Beta"' in text
    assert 'towerpilot_gems_collected_total{kind="ad",scope="all_time"} 1' in text
    assert 'towerpilot_runs_completed_total{scope="session"} 1' in text
    assert 'towerpilot_profile_coins_per_hour{profile="p1",profile_name="Farm \\"T9\\"\\nAlpha\\\\Beta"}' in text


def test_otlp_json_export_structure(tmp_path, monkeypatch):
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    tel = Telemetry(tmp_path / "events.jsonl", session_id="otlp5678", now_fn=lambda: 1_732_700_000.0)
    tel.set_profile("farm-default", "Farm T9")
    tel.log("Ad gem", event="ad_gem_collected", trigger="ocr")
    tel.log("Run ended", event="run_ended", tier=9, wave=3000, duration_sec=1800.0, total_coins=3e12, coins_verified=True)

    payload = tel.to_otlp_json()
    assert "resourceMetrics" in payload and len(payload["resourceMetrics"]) == 1
    rm = payload["resourceMetrics"][0]
    res_attrs = {a["key"]: a["value"] for a in rm["resource"]["attributes"]}
    assert res_attrs["service.name"] == {"stringValue": "towerpilot"}
    assert res_attrs["service.instance.id"] == {"stringValue": "otlp5678"}

    scope_metrics = rm["scopeMetrics"]
    assert len(scope_metrics) == 1
    metrics = {m["name"]: m for m in scope_metrics[0]["metrics"]}
    assert "towerpilot.gems.collected" in metrics
    assert "towerpilot.runs.completed" in metrics
    assert "towerpilot.session.uptime" in metrics
    assert "towerpilot.profile.coins_per_hour" in metrics
    assert "towerpilot.profile.gems_per_hour" in metrics

    gems_sum = metrics["towerpilot.gems.collected"]["sum"]
    assert gems_sum["aggregationTemporality"] == 2
    assert gems_sum["isMonotonic"] is True
    assert len(gems_sum["dataPoints"]) == 4

    uptime_gauge = metrics["towerpilot.session.uptime"]["gauge"]
    assert len(uptime_gauge["dataPoints"]) == 1


def test_zero_network_calls_when_otlp_endpoint_unset_and_fire_and_forget_when_set(tmp_path, monkeypatch):
    calls: list[tuple[str, bytes]] = []
    done = threading.Event()

    class _DummyResp:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

    def fake_urlopen(req, timeout=2.0):
        calls.append((req.full_url, req.data))
        done.set()
        return _DummyResp()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)

    tel = Telemetry(tmp_path / "events.jsonl", session_id="net00001")
    tel.log("No network push", event="ad_gem_collected", trigger="ocr")
    assert calls == []

    # Now enable OTLP endpoint and confirm async fire-and-forget POST to /v1/logs
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318")
    tel.log("With network push", event="ad_gem_collected", trigger="ocr")
    assert done.wait(timeout=2.0)
    assert len(calls) == 1
    url, body = calls[0]
    assert url == "http://127.0.0.1:4318/v1/logs"
    decoded = json.loads(body.decode("utf-8"))
    assert decoded["resourceLogs"][0]["scopeLogs"][0]["logRecords"][0]["body"] == {"stringValue": "With network push"}

    # Verify unreachable endpoint never raises
    def failing_urlopen(req, timeout=2.0):
        raise OSError("connection refused")

    monkeypatch.setattr(urllib.request, "urlopen", failing_urlopen)
    tel.log("Safe on failure", event="ad_gem_collected", trigger="ocr")


def test_recent_ring_buffer_maxlen_40(tmp_path, monkeypatch):
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    tel = Telemetry(tmp_path / "events.jsonl", session_id="ring0001")
    for idx in range(55):
        tel.log(f"Event {idx}", event="info", seq=idx)
    recent = tel.recent()
    assert len(recent) == 40
    assert recent[0]["msg"] == "Event 54"
    assert recent[-1]["msg"] == "Event 15"


def test_nav_taps_no_double_count_and_legacy_fallback(tmp_path, monkeypatch):
    """Fable #6a: schema_version>=1 counts only nav_step; legacy pre-OTEL *_tapped still counts."""
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_ENDPOINT", raising=False)
    log_file = tmp_path / "events.jsonl"
    # Seed 1 legacy pre-OTEL home_battle_tapped (no schema_version)
    log_file.write_text(
        json.dumps({"ts": 1700000001.0, "iso": "2025-01-01T00:00:01", "event": "home_battle_tapped", "msg": "Legacy BATTLE"}) + "\n",
        encoding="utf-8",
    )

    tel = Telemetry(log_file, session_id="nav00001")
    assert tel.snapshot()["all_time"]["nav_taps"] == 1
    assert tel.snapshot()["session"]["nav_taps"] == 0

    # New schema_version=1 nav_step + home_battle_tapped -> only 1 physical nav tap
    tel.log("Tap BATTLE", event="nav_step", screen="home", target="battle")
    tel.log("Home -> BATTLE tapped", event="home_battle_tapped", tier=9)
    tel.log("End Stats -> RETRY tapped", event="end_stats_retry_tapped", tier=9)

    snap = tel.snapshot()
    assert snap["session"]["nav_taps"] == 1
    assert snap["all_time"]["nav_taps"] == 2

    # Reload from disk and verify persisted counts remain identical
    reloaded = Telemetry(log_file, session_id="nav00002")
    assert reloaded.snapshot()["all_time"]["nav_taps"] == 2
    assert reloaded.snapshot()["session"]["nav_taps"] == 0
