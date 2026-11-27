"""OpenTelemetry-standardized event logger and persistent multi-iteration metrics engine.

Pure Python stdlib only (zero new pip packages, zero SQLite). Appends backwards-compatible
JSONL records with OpenTelemetry Log Record fields to `logs/events.jsonl` and rebuilds
all-time / per-profile / per-iteration metrics across restarts.
"""
from __future__ import annotations

import json
import math
import os
import re
import threading
import time
import urllib.request
import uuid
from collections import deque
from pathlib import Path
from typing import Any, Callable

from towerpilot import __version__, run_rules

SCHEMA_VERSION = 1
SERVICE_NAME = "towerpilot"
DEFAULT_EVENT_LOG_PATH = Path(__file__).resolve().parents[1] / "logs" / "events.jsonl"

_ITER_ID_RE = re.compile(r"^iter-(\d+)$")
_ENVELOPE_KEYS = frozenset({
    "ts", "iso", "event", "msg", "schema_version", "time_unix_nano", "severity_text",
    "otel_event", "service", "session_id", "iteration_id", "profile_id", "profile_name", "attributes",
})
_SEVERITY_NUMBERS = {"INFO": 9, "WARN": 13, "ERROR": 17}

EVENT_OTEL_MAP: dict[str, str] = {
    "ad_gem_collected": "towerpilot.gem.ad.collected",
    "ad_gem_attempted": "towerpilot.gem.ad.attempted",
    "ad_gem_spotted": "towerpilot.gem.ad.spotted",
    "ad_gem_skipped": "towerpilot.gem.ad.skipped",
    "ad_gem_error": "towerpilot.gem.ad.error",
    "ad_gem_gone": "towerpilot.gem.ad.gone",
    "floating_gem_collected": "towerpilot.gem.floating.collected",
    "floating_gem_attempted": "towerpilot.gem.floating.attempted",
    "floating_gem_spotted": "towerpilot.gem.floating.spotted",
    "floating_gem_skipped": "towerpilot.gem.floating.skipped",
    "floating_gem_error": "towerpilot.gem.floating.error",
    "run_ended": "towerpilot.run.ended",
    "run_hold": "towerpilot.run.hold",
    "run_count_reset": "towerpilot.run.count.reset",
    "home_battle_tapped": "towerpilot.nav.battle.start",
    "home_resume_tapped": "towerpilot.nav.battle.resume",
    "end_stats_retry_tapped": "towerpilot.nav.retry",
    "end_stats_home_tapped": "towerpilot.nav.home",
    "tournament_entered": "towerpilot.nav.tournament.enter",
    "tournament_stats_ok_tapped": "towerpilot.nav.tournament.ok",
    "nav_step": "towerpilot.nav.step",
    "profile_switched": "towerpilot.profile.switched",
    "battle_frozen": "towerpilot.battle.frozen",
    "battle_unfrozen": "towerpilot.battle.unfrozen",
    "battle_live": "towerpilot.battle.live",
    "battle_waiting": "towerpilot.battle.waiting",
    "harvest_started": "towerpilot.harvest.started",
    "harvest_stopped": "towerpilot.harvest.stopped",
    "tap_refused": "towerpilot.tap.refused",
    "tap_skipped": "towerpilot.tap.skipped",
}

_BATTLE_START_EVENTS = frozenset({"home_battle_tapped", "end_stats_retry_tapped", "tournament_entered"})
_ITER_ATTACH_EVENTS = frozenset({
    "battle_live", "home_resume_tapped", "ad_gem_collected", "ad_gem_attempted",
    "floating_gem_collected", "floating_gem_attempted",
})
_NAV_TAP_EVENTS = frozenset({
    "nav_step", "nav_tap", "end_stats_home_tapped", "end_stats_retry_tapped",
    "home_battle_tapped", "home_resume_tapped", "tournament_entered", "tournament_stats_ok_tapped",
})
_SCALAR_COUNTERS = (
    ("runs_completed", "towerpilot_runs_completed_total", "towerpilot.runs.completed", "{run}", "Completed runs recorded."),
    ("runs_restarted", "towerpilot_runs_restarted_total", "towerpilot.runs.restarted", "{run}", "Runs started or restarted."),
    ("nav_taps", "towerpilot_nav_taps_total", "towerpilot.nav.taps", "{tap}", "Navigation taps executed."),
    ("holds", "towerpilot_holds_total", "towerpilot.holds", "{hold}", "Run-rule hold transitions."),
    ("errors", "towerpilot_errors_total", "towerpilot.errors", "{error}", "Error events recorded."),
    ("freezes", "towerpilot_freezes_total", "towerpilot.freezes", "{freeze}", "Battle freeze alerts."),
    ("total_coins", "towerpilot_coins_total", "towerpilot.coins.earned", "{coin}", "Total coins earned across runs."),
    ("total_duration_sec", "towerpilot_duration_seconds_total", "towerpilot.duration.seconds", "s", "Total recorded run duration."),
)


def otel_event_name(event: str) -> str:
    """Map an internal snake_case event name to its canonical dotted OTEL event name."""
    name = str(event or "info").strip()
    return EVENT_OTEL_MAP.get(name) or f"towerpilot.{name.replace('_', '.').strip('.') or 'info'}"


def derive_severity(event: str, severity: str | None = None) -> str:
    """Return 'INFO', 'WARN', or 'ERROR', auto-derived from `event` when omitted."""
    if severity:
        norm = str(severity).strip().upper()
        if norm == "WARNING":
            return "WARN"
        if norm in _SEVERITY_NUMBERS:
            return norm
    name = str(event or "").strip().lower()
    if name.endswith(("_error", "_failed")) or name in {"tap_refused", "error"}:
        return "ERROR"
    if name.endswith(("_skipped", "_gone")) or name in {"run_hold", "battle_frozen", "warn", "warning"}:
        return "WARN"
    return "INFO"


def _num(val: Any) -> float | None:
    return float(val) if isinstance(val, (int, float)) and not isinstance(val, bool) and math.isfinite(val) else None


def _int_val(val: Any) -> int | None:
    return val if isinstance(val, int) and not isinstance(val, bool) else None


def _prom_escape(val: str) -> str:
    return str(val).replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _prom_num(val: int | float) -> str:
    if isinstance(val, int) and not isinstance(val, bool):
        return str(val)
    f = float(val)
    return f"{f:.6e}" if abs(f) >= 1e12 else (f"{f:.4f}".rstrip("0").rstrip(".") or "0")


def _otlp_attr(key: str, val: Any) -> dict[str, Any]:
    if isinstance(val, bool):
        return {"key": key, "value": {"boolValue": val}}
    if isinstance(val, int):
        return {"key": key, "value": {"intValue": str(val)}}
    if isinstance(val, float) and math.isfinite(val):
        return {"key": key, "value": {"doubleValue": val}}
    return {"key": key, "value": {"stringValue": str(val)}}


def _otlp_resource(session_id: str) -> dict[str, Any]:
    return {"attributes": [_otlp_attr("service.name", SERVICE_NAME), _otlp_attr("service.version", __version__), _otlp_attr("service.instance.id", session_id)]}


def _empty_counters() -> dict[str, Any]:
    return {
        "ad_gems": 0, "floating_gems": 0, "total_gems": 0, "ad_attempts": 0, "floating_attempts": 0,
        "runs_completed": 0, "runs_restarted": 0, "nav_taps": 0, "holds": 0, "errors": 0, "freezes": 0,
        "total_coins": 0.0, "total_duration_sec": 0.0,
    }


def recover_open_run(
    event_log_path: Path | None,
    *,
    max_age_sec: float = 48.0 * 3600.0,
    now: float | None = None,
) -> dict[str, Any] | None:
    """Recover an in-progress run's exact start timestamp from logs/events.jsonl after restart.

    Returns `{started_at, exact, tier, iteration_id}` when the most recent run lifecycle
    event is a battle start (`home_battle_tapped`, `end_stats_retry_tapped`, `home_resume_tapped`)
    with no subsequent `run_ended` or `setup_test_surrendered`.
    """
    if event_log_path is None or not event_log_path.is_file():
        return None
    latest: dict[str, Any] | None = None
    try:
        with open(event_log_path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                if not any(
                    tok in line
                    for tok in (
                        '"home_battle_tapped"',
                        '"end_stats_retry_tapped"',
                        '"home_resume_tapped"',
                        '"run_ended"',
                        '"setup_test_surrendered"',
                    )
                ):
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(row, dict):
                    ev = row.get("event")
                    if ev in (
                        "home_battle_tapped",
                        "end_stats_retry_tapped",
                        "home_resume_tapped",
                        "run_ended",
                        "setup_test_surrendered",
                    ):
                        latest = row
    except OSError:
        return None

    if latest is None or latest.get("event") in ("run_ended", "setup_test_surrendered"):
        return None

    ts = latest.get("ts")
    if not isinstance(ts, (int, float)):
        return None
    cur_now = time.time() if now is None else float(now)
    if ts > cur_now + 60.0 or (cur_now - float(ts)) > max_age_sec:
        return None

    exact = latest.get("event") in ("home_battle_tapped", "end_stats_retry_tapped")
    attrs = latest.get("attributes") if isinstance(latest.get("attributes"), dict) else {}
    tier = latest.get("tier") if isinstance(latest.get("tier"), int) else attrs.get("tier")
    return {
        "started_at": float(ts),
        "exact": exact,
        "tier": tier if isinstance(tier, int) and not isinstance(tier, bool) else None,
        "iteration_id": latest.get("iteration_id"),
    }


class MetricsStore:
    """In-memory + JSONL-rehydrated multi-iteration metrics accumulator and exporter."""

    def __init__(self, *, session_id: str, started_at: float | None = None, now_fn: Callable[[], float] | None = None) -> None:
        self._session_id = session_id
        self._now_fn = now_fn or time.time
        self._started_at = round(started_at if started_at is not None else self._now_fn(), 3)
        self._all_time: dict[str, Any] = _empty_counters()
        self._session: dict[str, Any] = _empty_counters()
        self._profiles: dict[str, dict[str, Any]] = {}
        self._all_runs: list[dict[str, Any]] = []
        self._iterations: deque[dict[str, Any]] = deque(maxlen=100)
        self._iter_gems: dict[str, list[int]] = {}
        self._legacy_gems: list[int] = [0, 0, 0, 0]
        self._legacy_seq = 0
        self.max_iter_seq = 0

    def _ensure_profile(self, key: str, pid: str | None, pname: str | None) -> dict[str, Any]:
        b = self._profiles.get(key)
        if b is None:
            b = {
                "profile_id": pid, "profile_name": pname or pid or key, "runs": 0, "ad_gems": 0,
                "floating_gems": 0, "waves": [], "total_coins": 0.0, "cph_coins": 0.0, "cph_sec": 0.0, "durations": [],
            }
            self._profiles[key] = b
        else:
            if pid and not b["profile_id"]:
                b["profile_id"] = pid
            if pname:
                b["profile_name"] = pname
        return b

    def _apply_counters(self, target: dict[str, Any], event: str, severity: str, record: dict[str, Any]) -> None:
        if event == "ad_gem_collected":
            target["ad_gems"] += 1
            target["total_gems"] += 1
        elif event == "floating_gem_collected":
            target["floating_gems"] += 1
            target["total_gems"] += 1
        elif event == "ad_gem_attempted":
            target["ad_attempts"] += 1
        elif event == "floating_gem_attempted":
            target["floating_attempts"] += 1
        elif event == "run_ended":
            target["runs_completed"] += 1
            tc, dur = _num(record.get("total_coins")), _num(record.get("duration_sec"))
            if tc is not None and tc > 0:
                target["total_coins"] += tc
            if dur is not None and dur > 0:
                target["total_duration_sec"] = round(target["total_duration_sec"] + dur, 1)
        elif event == "run_hold":
            target["holds"] += 1
        elif event == "battle_frozen":
            target["freezes"] += 1
        if event in _BATTLE_START_EVENTS:
            target["runs_restarted"] += 1
        schema_ver = _int_val(record.get("schema_version")) or 0
        if schema_ver >= 1:
            if event == "nav_step":
                target["nav_taps"] += 1
        elif event in _NAV_TAP_EVENTS:
            target["nav_taps"] += 1
        if severity == "ERROR":
            target["errors"] += 1

    def ingest(self, record: dict[str, Any], *, is_session: bool = False) -> None:
        """Fold a single JSONL record (legacy or OTEL schema_version=1) into metrics state."""
        if not isinstance(record, dict):
            return
        event = str(record.get("event") or "info").strip()
        severity = derive_severity(event, record.get("severity_text"))
        raw_iter = record.get("iteration_id")
        iter_id = raw_iter if isinstance(raw_iter, str) else None
        if iter_id and (m := _ITER_ID_RE.match(iter_id)):
            self.max_iter_seq = max(self.max_iter_seq, int(m.group(1)))

        self._apply_counters(self._all_time, event, severity, record)
        if is_session:
            self._apply_counters(self._session, event, severity, record)

        pid = str(record.get("profile_id") or "").strip() or None
        pname = str(record.get("profile_name") or record.get("profile") or "").strip() or None
        pkey = pid or pname

        if event in ("ad_gem_collected", "floating_gem_collected"):
            idx = 0 if event == "ad_gem_collected" else 1
            slot = self._iter_gems.setdefault(iter_id, [0, 0, 0, 0]) if iter_id else self._legacy_gems
            slot[idx] += 1
            if pkey:
                self._ensure_profile(pkey, pid, pname)["ad_gems" if idx == 0 else "floating_gems"] += 1
            else:
                slot[idx + 2] += 1
        elif event == "run_ended":
            if iter_id:
                ad_g, fg_g, un_ad, un_fg = self._iter_gems.pop(iter_id, [0, 0, 0, 0])
            else:
                self._legacy_seq += 1
                iter_id = f"legacy-{self._legacy_seq:04d}"
                ad_g, fg_g, un_ad, un_fg = self._legacy_gems
                self._legacy_gems = [0, 0, 0, 0]
                self.max_iter_seq = max(self.max_iter_seq, self._legacy_seq)

            tier, wave, high_w = _int_val(record.get("tier")), _int_val(record.get("wave")), _int_val(record.get("highest_wave"))
            dur, dur_exact = _num(record.get("duration_sec")), bool(record.get("duration_exact", True))
            tc, coins_ok = _num(record.get("total_coins")), bool(record.get("coins_verified", True))
            cph = _num(record.get("coins_per_hour"))
            if cph is None and dur_exact and coins_ok and tc is not None and tc > 0 and dur is not None and dur >= 30.0:
                cph = tc / (dur / 3600.0)
            cph_fmt = record.get("coins_per_hour_fmt") or (run_rules.format_coins(cph) if cph is not None else None)

            if pkey:
                b = self._ensure_profile(pkey, pid, pname)
                b["runs"] += 1
                b["ad_gems"] += un_ad
                b["floating_gems"] += un_fg
                if wave is not None:
                    b["waves"].append(wave)
                if tc is not None and tc > 0:
                    b["total_coins"] += tc
                if dur is not None and dur > 0:
                    b["durations"].append(dur)
                if dur_exact and coins_ok and tc is not None and tc > 0 and dur is not None and dur >= 30.0:
                    b["cph_coins"] += tc
                    b["cph_sec"] += dur

            self._all_runs.append({**record, "profile": pname or pid or ""})
            self._iterations.appendleft({
                "iteration_id": iter_id, "profile_id": pid, "profile_name": pname, "tier": tier, "wave": wave,
                "highest_wave": high_w, "killed_by": record.get("killed_by"), "duration_sec": dur,
                "duration_exact": dur_exact, "total_coins": tc, "total_coins_raw": record.get("total_coins_raw"),
                "coins_per_hour": cph, "coins_per_hour_fmt": cph_fmt, "ad_gems": ad_g, "floating_gems": fg_g,
                "ended_at": record.get("iso"),
            })

    def load_jsonl(self, path: Path | None) -> int:
        """Rehydrate metrics from an existing JSONL file (legacy + OTEL rows)."""
        if path is None or not path.is_file():
            return 0
        loaded = 0
        try:
            with open(path, "r", encoding="utf-8") as fh:
                for raw in fh:
                    line = raw.strip()
                    if not line:
                        continue
                    try:
                        item = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(item, dict):
                        self.ingest(item, is_session=False)
                        loaded += 1
        except OSError:
            pass
        return loaded

    def _profile_summary(self) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for key, b in sorted(self._profiles.items()):
            waves, durs = b["waves"], b["durations"]
            total_gems, total_dur = b["ad_gems"] + b["floating_gems"], sum(durs)
            cph = (b["cph_coins"] / (b["cph_sec"] / 3600.0)) if b["cph_sec"] > 0 else None
            out[key] = {
                "profile_id": b["profile_id"], "profile_name": b["profile_name"], "runs": b["runs"],
                "ad_gems": b["ad_gems"], "floating_gems": b["floating_gems"], "total_gems": total_gems,
                "avg_wave": int(round(sum(waves) / len(waves))) if waves else None,
                "best_wave": max(waves) if waves else None, "total_coins": b["total_coins"],
                "coins_per_hour": cph, "coins_per_hour_fmt": run_rules.format_coins(cph) if cph is not None else None,
                "gems_per_hour": round(total_gems / (total_dur / 3600.0), 2) if total_dur >= 30.0 else None,
                "avg_duration_sec": round(total_dur / len(durs), 1) if durs else None,
            }
        return out

    def runs_ledger(self, limit: int = 50) -> dict[str, Any]:
        return {"runs": list(reversed(self._all_runs))[:limit], "by_tier": run_rules.summarize_by_tier(self._all_runs)}

    def snapshot(self, *, iteration_id: str | None = None, profile_id: str | None = None, profile_name: str | None = None) -> dict[str, Any]:
        uptime = round(max(0.0, self._now_fn() - self._started_at), 1)
        return {
            "schema_version": SCHEMA_VERSION, "service": SERVICE_NAME, "session_id": self._session_id,
            "current_iteration_id": iteration_id,
            "active_profile": {"profile_id": profile_id, "profile_name": profile_name},
            "all_time": dict(self._all_time),
            "session": {**self._session, "session_id": self._session_id, "started_at": self._started_at, "uptime_sec": uptime},
            "by_profile": self._profile_summary(),
            "by_tier": run_rules.summarize_by_tier(self._all_runs),
            "iterations": list(self._iterations),
        }

    def to_prometheus(self) -> str:
        """Render current metrics in Prometheus / OpenMetrics text exposition format."""
        snap = self.snapshot()
        lines: list[str] = []

        def emit(name: str, mtype: str, help_text: str, samples: list[tuple[dict[str, str], int | float]]) -> None:
            if not samples:
                return
            lines.extend((f"# HELP {name} {help_text}", f"# TYPE {name} {mtype}"))
            for labels, val in samples:
                lstr = ",".join(f'{k}="{_prom_escape(v)}"' for k, v in labels.items())
                lines.append(f"{name}{{{lstr}}} {_prom_num(val)}" if lstr else f"{name} {_prom_num(val)}")

        scopes = (("all_time", snap["all_time"]), ("session", snap["session"]))
        emit("towerpilot_gems_collected_total", "counter", "Confirmed gems collected.", [({"kind": k, "scope": sc}, d[f"{k}_gems"]) for sc, d in scopes for k in ("ad", "floating")])
        emit("towerpilot_gem_attempts_total", "counter", "Timer-mode gem tap attempts.", [({"kind": k, "scope": sc}, d[f"{k}_attempts"]) for sc, d in scopes for k in ("ad", "floating")])
        for key, prom_name, _, _, desc in _SCALAR_COUNTERS:
            emit(prom_name, "counter", desc, [({"scope": sc}, d[key]) for sc, d in scopes])
        emit("towerpilot_session_uptime_seconds", "gauge", "Current session uptime in seconds.", [({"session_id": self._session_id}, snap["session"]["uptime_sec"])])

        by_prof = snap["by_profile"]
        if by_prof:
            emit("towerpilot_profile_runs_total", "counter", "Completed runs per profile.", [({"profile": k, "profile_name": v["profile_name"]}, v["runs"]) for k, v in by_prof.items()])
            emit("towerpilot_profile_gems_total", "counter", "Gems collected per profile.", [({"profile": k, "profile_name": v["profile_name"], "kind": kd}, v[f"{kd}_gems"]) for k, v in by_prof.items() for kd in ("ad", "floating")])
            emit("towerpilot_profile_coins_per_hour", "gauge", "Coins per hour per profile.", [({"profile": k, "profile_name": v["profile_name"]}, v["coins_per_hour"]) for k, v in by_prof.items() if v["coins_per_hour"] is not None])
            emit("towerpilot_profile_gems_per_hour", "gauge", "Gems per hour per profile.", [({"profile": k, "profile_name": v["profile_name"]}, v["gems_per_hour"]) for k, v in by_prof.items() if v["gems_per_hour"] is not None])
        return "\n".join(lines) + "\n"

    def to_otlp_json(self) -> dict[str, Any]:
        """Export current metrics as a standard OpenTelemetry OTLP/JSON resourceMetrics payload."""
        snap = self.snapshot()
        now_ns, start_ns = str(int(self._now_fn() * 1e9)), str(int(self._started_at * 1e9))

        def dp(val: int | float, attrs: dict[str, Any], *, is_sum: bool) -> dict[str, Any]:
            pt: dict[str, Any] = {"timeUnixNano": now_ns, "attributes": [_otlp_attr(k, v) for k, v in attrs.items()]}
            if is_sum:
                pt["startTimeUnixNano"] = start_ns
            pt["asInt" if isinstance(val, int) and not isinstance(val, bool) else "asDouble"] = str(val) if isinstance(val, int) and not isinstance(val, bool) else float(val)
            return pt

        def sum_m(name: str, unit: str, desc: str, pts: list[dict[str, Any]]) -> dict[str, Any]:
            return {"name": name, "description": desc, "unit": unit, "sum": {"dataPoints": pts, "aggregationTemporality": 2, "isMonotonic": True}}

        def gauge_m(name: str, unit: str, desc: str, pts: list[dict[str, Any]]) -> dict[str, Any]:
            return {"name": name, "description": desc, "unit": unit, "gauge": {"dataPoints": pts}}

        scopes = (("all_time", snap["all_time"]), ("session", snap["session"]))
        metrics: list[dict[str, Any]] = [
            sum_m("towerpilot.gems.collected", "{gem}", "Confirmed gems collected.", [dp(d[f"{k}_gems"], {"kind": k, "scope": sc}, is_sum=True) for sc, d in scopes for k in ("ad", "floating")]),
            sum_m("towerpilot.gems.attempts", "{attempt}", "Timer-mode gem tap attempts.", [dp(d[f"{k}_attempts"], {"kind": k, "scope": sc}, is_sum=True) for sc, d in scopes for k in ("ad", "floating")]),
            *[sum_m(otlp_name, unit, desc, [dp(d[key], {"scope": sc}, is_sum=True) for sc, d in scopes]) for key, _, otlp_name, unit, desc in _SCALAR_COUNTERS],
            gauge_m("towerpilot.session.uptime", "s", "Session uptime in seconds.", [dp(snap["session"]["uptime_sec"], {"session_id": self._session_id}, is_sum=False)]),
        ]
        for field, name, unit, desc in (
            ("coins_per_hour", "towerpilot.profile.coins_per_hour", "{coin}/h", "Coins per hour by profile."),
            ("gems_per_hour", "towerpilot.profile.gems_per_hour", "{gem}/h", "Gems per hour by profile."),
        ):
            pts = [dp(v[field], {"profile": k, "profile_name": v["profile_name"]}, is_sum=False) for k, v in snap["by_profile"].items() if v[field] is not None]
            if pts:
                metrics.append(gauge_m(name, unit, desc, pts))
        return {"resourceMetrics": [{"resource": _otlp_resource(self._session_id), "scopeMetrics": [{"scope": {"name": "towerpilot.telemetry", "version": __version__}, "metrics": metrics}]}]}


class EventLogger:
    """Thread-safe OTEL JSONL event logger + persistent multi-iteration metrics engine."""

    def __init__(self, event_log_path: Path | None = DEFAULT_EVENT_LOG_PATH, *, session_id: str | None = None, now_fn: Callable[[], float] | None = None, otlp_endpoint: str | None = None) -> None:
        self._lock = threading.RLock()
        self._path = Path(event_log_path) if event_log_path is not None else None
        self._session_id = session_id or uuid.uuid4().hex[:8]
        self._now_fn = now_fn or time.time
        self._otlp_endpoint = otlp_endpoint
        self._recent: deque[dict[str, Any]] = deque(maxlen=40)
        self.metrics = MetricsStore(session_id=self._session_id, now_fn=self._now_fn)
        self.metrics.load_jsonl(self._path)
        self._iter_seq = self.metrics.max_iter_seq
        self._iteration_id: str | None = None
        self._iter_has_battle = False
        self._profile_id: str | None = None
        self._profile_name: str | None = None
        self._push_sem = threading.BoundedSemaphore(4)

    @property
    def session_id(self) -> str: return self._session_id
    @property
    def iteration_id(self) -> str | None: return self._iteration_id
    @property
    def profile_id(self) -> str | None: return self._profile_id
    @property
    def profile_name(self) -> str | None: return self._profile_name
    @property
    def event_log_path(self) -> Path | None: return self._path

    def set_profile(self, profile_id: str | None, profile_name: str | None = None) -> None:
        with self._lock:
            self._profile_id = str(profile_id).strip() or None if profile_id is not None else None
            self._profile_name = str(profile_name).strip() or None if profile_name is not None else None

    def _allocate_iteration(self) -> str:
        self._iter_seq += 1
        self._iteration_id = f"iter-{self._iter_seq:04d}"
        self._iter_has_battle = False
        return self._iteration_id

    def start_iteration(self, *, profile_id: str | None = None, profile_name: str | None = None) -> str:
        with self._lock:
            if profile_id is not None or profile_name is not None:
                self.set_profile(profile_id, profile_name)
            return self._allocate_iteration()

    def end_iteration(self) -> None:
        with self._lock:
            self._iteration_id, self._iter_has_battle = None, False

    def _resolve_iteration(self, event: str, explicit_id: str | None) -> str | None:
        if explicit_id is not None:
            return explicit_id
        if event in _BATTLE_START_EVENTS:
            if self._iteration_id is None or self._iter_has_battle:
                self._allocate_iteration()
            self._iter_has_battle = True
        elif event in _ITER_ATTACH_EVENTS:
            if self._iteration_id is None:
                self._allocate_iteration()
            self._iter_has_battle = True
        elif event in ("nav_step", "run_ended") and self._iteration_id is None:
            self._allocate_iteration()
        return self._iteration_id

    def log(self, msg: str, *, event: str = "info", severity: str | None = None, profile_id: str | None = None, profile_name: str | None = None, iteration_id: str | None = None, **data: Any) -> dict[str, Any]:
        with self._lock:
            now = float(self._now_fn())
            ts, iso, sev = round(now, 3), time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now)), derive_severity(event, severity)
            if event == "profile_switched":
                sw_pid = profile_id if profile_id is not None else data.get("profile_id")
                sw_pname = profile_name if profile_name is not None else data.get("profile_name")
                if sw_pid is not None or sw_pname is not None:
                    self.set_profile(sw_pid, sw_pname)
            eff_pid = profile_id if profile_id is not None else (data.get("profile_id") or self._profile_id)
            eff_pname = profile_name if profile_name is not None else (data.get("profile_name") or data.get("profile") or self._profile_name)
            eff_iter = self._resolve_iteration(event, iteration_id)
            attrs = {k: v for k, v in data.items() if k not in _ENVELOPE_KEYS}
            entry: dict[str, Any] = {
                "ts": ts, "iso": iso, "event": event, "msg": msg, "schema_version": SCHEMA_VERSION,
                "time_unix_nano": int(now * 1_000_000_000), "severity_text": sev, "otel_event": otel_event_name(event),
                "service": SERVICE_NAME, "session_id": self._session_id, "iteration_id": eff_iter,
                "profile_id": eff_pid, "profile_name": eff_pname, "attributes": attrs, **attrs,
            }
            self._recent.appendleft({
                "ts": ts, "iso": iso, "event": event, "otel_event": entry["otel_event"], "severity_text": sev,
                "msg": msg, "iteration_id": eff_iter, "profile_id": eff_pid, "profile_name": eff_pname,
            })
            if self._path is not None:
                try:
                    self._path.parent.mkdir(parents=True, exist_ok=True)
                    with open(self._path, "a", encoding="utf-8") as fh:
                        fh.write(json.dumps(entry, separators=(",", ":"), default=str) + "\n")
                except OSError:
                    pass
            self.metrics.ingest(entry, is_session=True)
            if event == "run_ended" and iteration_id is None:
                self._iteration_id, self._iter_has_battle = None, False
        self._maybe_push_otlp(entry)
        return entry

    def recent(self, limit: int = 40) -> list[dict[str, Any]]:
        with self._lock:
            return list(self._recent)[: max(0, int(limit))]

    def runs_ledger(self, limit: int = 50) -> dict[str, Any]:
        with self._lock:
            return self.metrics.runs_ledger(limit=limit)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return self.metrics.snapshot(iteration_id=self._iteration_id, profile_id=self._profile_id, profile_name=self._profile_name)

    def to_prometheus(self) -> str:
        with self._lock:
            return self.metrics.to_prometheus()

    def to_otlp_json(self) -> dict[str, Any]:
        with self._lock:
            return self.metrics.to_otlp_json()

    def _maybe_push_otlp(self, entry: dict[str, Any]) -> None:
        endpoint = (self._otlp_endpoint if self._otlp_endpoint is not None else os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "")).strip()
        if not endpoint or not self._push_sem.acquire(blocking=False):
            return
        url = endpoint if endpoint.rstrip("/").endswith("/v1/logs") else f"{endpoint.rstrip('/')}/v1/logs"
        attrs = [_otlp_attr("event.name", entry["otel_event"])]
        for k in ("iteration_id", "profile_id"):
            if entry.get(k):
                attrs.append(_otlp_attr(f"towerpilot.{k}", entry[k]))
        attrs.extend(_otlp_attr(f"towerpilot.{k}", v) for k, v in (entry.get("attributes") or {}).items() if v is not None)
        body = json.dumps({
            "resourceLogs": [{
                "resource": _otlp_resource(self._session_id),
                "scopeLogs": [{
                    "scope": {"name": "towerpilot.telemetry", "version": __version__},
                    "logRecords": [{
                        "timeUnixNano": str(entry["time_unix_nano"]), "severityNumber": _SEVERITY_NUMBERS.get(entry["severity_text"], 9),
                        "severityText": entry["severity_text"], "body": {"stringValue": entry["msg"]}, "attributes": attrs,
                    }],
                }],
            }]
        }, separators=(",", ":")).encode("utf-8")

        def _send() -> None:
            try:
                req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
                with urllib.request.urlopen(req, timeout=2.0):
                    pass
            except Exception:
                pass
            finally:
                self._push_sem.release()

        threading.Thread(target=_send, name="otlp-log-push", daemon=True).start()


Telemetry = EventLogger
