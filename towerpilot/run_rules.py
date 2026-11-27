"""Pure run-restart rules, GAME STATS parser, coin-suffix math, and JSONL run ledger.

Zero external dependencies, zero I/O in decision helpers, zero extra threads.
"""
from __future__ import annotations

import json
import math
import re
from datetime import datetime
from pathlib import Path
from typing import Any

# The Tower coin/currency suffixes (case-sensitive for q/Q and s/S).
_COIN_SUFFIXES: dict[str, float] = {
    "": 1.0,
    "K": 1e3,
    "k": 1e3,
    "M": 1e6,
    "m": 1e6,
    "B": 1e9,
    "b": 1e9,
    "T": 1e12,
    "t": 1e12,
    "q": 1e15,
    "Q": 1e18,
    "s": 1e21,
    "S": 1e24,
    "O": 1e27,
    "o": 1e27,
    "N": 1e30,
    "n": 1e30,
    "D": 1e33,
    "d": 1e33,
}

_FORMAT_UNITS: tuple[tuple[float, str], ...] = (
    (1e33, "D"),
    (1e30, "N"),
    (1e27, "O"),
    (1e24, "S"),
    (1e21, "s"),
    (1e18, "Q"),
    (1e15, "q"),
    (1e12, "T"),
    (1e9, "B"),
    (1e6, "M"),
    (1e3, "K"),
)

_HHMM_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
# Match numeric amounts like "11.84T", "5.90T", "950K", "1,234", "4.2q", "1.5Q", "3.1s", "2.8S"
# followed by optional coin-icon OCR noise (@, ©, C, G, O after space).
_COIN_TOKEN_RE = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s*([kKmMbBtTqQsSoOnNdD])?(?=\s|$|[+=@©()])")


def valid_hhmm(value: str) -> bool:
    return isinstance(value, str) and bool(_HHMM_RE.match(value.strip()))


def parse_hhmm_minutes(value: str) -> int | None:
    if not isinstance(value, str):
        return None
    m = _HHMM_RE.match(value.strip())
    if not m:
        return None
    return int(m.group(1)) * 60 + int(m.group(2))


def in_time_window(now_local: datetime, start_hhmm: str, end_hhmm: str) -> bool:
    """True when `now_local` falls inside [start, end), supporting midnight wrap."""
    start = parse_hhmm_minutes(start_hhmm)
    end = parse_hhmm_minutes(end_hhmm)
    if start is None or end is None or start == end:
        return False
    cur = now_local.hour * 60 + now_local.minute
    if start < end:
        return start <= cur < end
    return cur >= start or cur < end


def parse_coins(raw: str | None) -> float | None:
    """Parse a Tower currency string such as '17.75T' or '4.20q' into a float."""
    if not raw or not isinstance(raw, str):
        return None
    cleaned = raw.strip().replace(",", "")
    m = re.match(r"^(\d+(?:\.\d+)?)\s*([kKmMbBtTqQsSoOnNdD])?$", cleaned)
    if not m:
        return None
    try:
        base = float(m.group(1))
    except ValueError:
        return None
    suffix = m.group(2) or ""
    mult = _COIN_SUFFIXES.get(suffix)
    if mult is None or not math.isfinite(base):
        return None
    val = base * mult
    return val if math.isfinite(val) else None


def format_coins(value: float | None) -> str:
    """Format a coin amount compactly using The Tower's suffix scale."""
    if value is None or not math.isfinite(value) or value < 0:
        return ""
    if value == 0:
        return "0"
    for threshold, suffix in _FORMAT_UNITS:
        if value >= threshold:
            scaled = value / threshold
            if scaled >= 100:
                return f"{scaled:.1f}{suffix}"
            return f"{scaled:.2f}{suffix}"
    return f"{int(round(value))}"


def format_duration_compact(sec: float | None) -> str:
    if sec is None or not math.isfinite(sec) or sec < 0:
        return ""
    total = int(round(sec))
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    if h > 0:
        return f"{h}h{m:02d}m"
    if m > 0:
        return f"{m}m{s:02d}s"
    return f"{s}s"


def _extract_coin_equation(coins_text: str) -> tuple[str | None, str | None, str | None]:
    """Extract (coins_raw, ad_coins_raw, total_coins_raw) from the GAME STATS coin line."""
    if not coins_text:
        return None, None, None
    # Focus on the portion starting at the first digit (skip headers like "coins earned ...")
    first_digit = re.search(r"\d", coins_text)
    if not first_digit:
        return None, None, None
    segment = coins_text[first_digit.start() :]
    # Fix occasional OCR split inside a decimal like "5.9 OT" -> "5.90T"
    segment = re.sub(r"(\d\.\d)\s+[Oo]([kKmMbBtTqQsSoOnNdD])\b", r"\g<1>0\2", segment)
    # Split on + and = when present for clearest positional mapping
    if "+" in segment and "=" in segment:
        left, rest = segment.split("+", 1)
        mid, right = rest.split("=", 1)
        parts = [left, mid, right]
        found: list[str | None] = []
        for part in parts:
            m = _COIN_TOKEN_RE.search(part)
            if m:
                num = m.group(1).replace(",", "")
                suf = m.group(2) or ""
                found.append(f"{num}{suf}")
            else:
                found.append(None)
        return found[0], found[1], found[2]

    tokens = [f"{m.group(1).replace(',', '')}{m.group(2) or ''}" for m in _COIN_TOKEN_RE.finditer(segment)]
    if len(tokens) >= 3:
        return tokens[0], tokens[1], tokens[2]
    if len(tokens) == 1:
        return None, None, tokens[0]
    return None, None, None


def _coins_sum_consistent(base: float | None, ad: float | None, total: float | None) -> bool:
    """Built-in OCR sanity check: base + ad_coins should equal total_coins within rounding."""
    if total is None:
        return False
    if base is None or ad is None:
        return True
    expected = base + ad
    if total == 0 and expected == 0:
        return True
    denom = max(abs(total), abs(expected), 1.0)
    # Two-decimal displayed values can round by ~0.01 of the displayed unit (~2% worst case on small mantissas).
    return abs(expected - total) / denom <= 0.03


def parse_end_stats(upper_text: str, coins_text: str = "") -> dict[str, Any]:
    """Parse OCR text from the GAME STATS modal into structured run metrics."""
    upper = " ".join((upper_text or "").split())
    coins_line = " ".join((coins_text or "").split())

    tier: int | None = None
    m_tier = re.search(r"\bTier\s*[:#-]?\s*(\d{1,3})\b", upper, flags=re.IGNORECASE)
    if m_tier:
        tier = int(m_tier.group(1))

    highest_wave: int | None = None
    m_high = re.search(r"\bHighest\s+Wave\s*[:#-]?\s*([\d,]{1,8})\b", upper, flags=re.IGNORECASE)
    if m_high:
        highest_wave = int(m_high.group(1).replace(",", ""))

    # Match standalone "Wave 8996" (avoid matching "Highest Wave: 9020")
    wave: int | None = None
    for m_wave in re.finditer(r"(?<!Highest\s)\bWave\s*[:#-]?\s*([\d,]{1,8})\b", upper, flags=re.IGNORECASE):
        wave = int(m_wave.group(1).replace(",", ""))
        break

    killed_by: str | None = None
    m_kill = re.search(
        r"\bKilled\s+By\s+(.+?)(?=\s+\b(?:Death|MORE\s+STATS|PERKS|coins|RETRY|HOME)\b|$)",
        upper,
        flags=re.IGNORECASE,
    )
    if m_kill:
        candidate = m_kill.group(1).strip(" :-|.,")
        if candidate:
            killed_by = candidate[:48]

    coins_raw, ad_coins_raw, total_coins_raw = _extract_coin_equation(coins_line)
    coins_val = parse_coins(coins_raw)
    ad_coins_val = parse_coins(ad_coins_raw)
    total_coins_val = parse_coins(total_coins_raw)
    coins_verified = _coins_sum_consistent(coins_val, ad_coins_val, total_coins_val)

    return {
        "tier": tier,
        "wave": wave,
        "highest_wave": highest_wave,
        "killed_by": killed_by,
        "coins_raw": coins_raw,
        "ad_coins_raw": ad_coins_raw,
        "total_coins_raw": total_coins_raw,
        "coins_earned": coins_val,
        "ad_coins_earned": ad_coins_val,
        "total_coins": total_coins_val,
        "coins_verified": coins_verified,
        "raw_upper": upper,
        "raw_coins": coins_line,
    }


def decide_home_action(
    now_local: datetime,
    *,
    runs_restarted: int,
    rules: dict[str, Any],
    detected_tier: int | None = None,
    check_tier: bool = False,
) -> tuple[str, str]:
    """Pure decision for starting a new run (BATTLE or RETRY): ('battle', 'ok') or ('hold', reason)."""
    if bool(rules.get("finish_and_stop", False)):
        return "hold", "finish_and_stop"

    max_runs = int(rules.get("max_runs", 0) or 0)
    if max_runs > 0 and runs_restarted >= max_runs:
        return "hold", "max_runs"

    if bool(rules.get("no_start_enabled", False)):
        start = str(rules.get("no_start_from", "") or "")
        end = str(rules.get("no_start_until", "") or "")
        if in_time_window(now_local, start, end):
            return "hold", "no_start_window"

    if check_tier:
        expected_tier = int(rules.get("expected_tier", 0) or 0)
        if expected_tier > 0 and detected_tier != expected_tier:
            return "hold", "tier_mismatch"

    return "battle", "ok"


def hold_label(
    reason: str | None,
    rules: dict[str, Any],
    runs_restarted: int,
    *,
    detected_tier: int | None = None,
) -> str:
    if reason == "finish_and_stop":
        return "holding (finish & stop)"
    if reason == "max_runs":
        max_runs = int(rules.get("max_runs", 0) or 0)
        return f"holding (max runs {runs_restarted}/{max_runs})"
    if reason == "no_start_window":
        start = str(rules.get("no_start_from", "") or "")
        end = str(rules.get("no_start_until", "") or "")
        return f"holding (quiet {start}-{end})"
    if reason == "tier_mismatch":
        expected_tier = int(rules.get("expected_tier", 0) or 0)
        got = f"T{detected_tier}" if detected_tier is not None else "T?"
        return f"holding (tier {got} != T{expected_tier})"
    return f"holding ({reason})" if reason else ""


def format_death_toast(record: dict[str, Any]) -> str:
    """Build a compact death summary like 'T9 W8996, 3h12m, 17.75T (5.55T/hr), killed by Scatter'."""
    parts: list[str] = []
    head: list[str] = []
    if record.get("tier") is not None:
        head.append(f"T{record['tier']}")
    if record.get("wave") is not None:
        head.append(f"W{record['wave']}")
    if head:
        parts.append(" ".join(head))

    dur = format_duration_compact(record.get("duration_sec"))
    if dur:
        parts.append(dur)

    coins_str = record.get("total_coins_raw") or format_coins(record.get("total_coins"))
    cph = record.get("coins_per_hour")
    if coins_str:
        if cph is not None and cph > 0 and record.get("coins_verified", True):
            parts.append(f"{coins_str} ({format_coins(cph)}/hr)")
        else:
            parts.append(coins_str)

    if record.get("killed_by"):
        parts.append(f"killed by {record['killed_by']}")

    return ", ".join(parts) if parts else "Run ended"


def load_run_ledger(event_log_path: Path | None, *, limit: int = 100) -> list[dict[str, Any]]:
    """Read recent `run_ended` records from logs/events.jsonl, newest first."""
    if event_log_path is None or not event_log_path.is_file():
        return []
    records: list[dict[str, Any]] = []
    try:
        with open(event_log_path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or '"run_ended"' not in line:
                    continue
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(item, dict) and item.get("event") == "run_ended":
                    records.append(item)
    except OSError:
        return []
    records.reverse()
    return records[:limit]


def summarize_by_tier(runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Aggregate completed runs by (tier, profile) to measure real Coins/hr."""
    buckets: dict[tuple[int, str], list[dict[str, Any]]] = {}
    for run in runs:
        tier = run.get("tier")
        if not isinstance(tier, int) or isinstance(tier, bool):
            continue
        profile = str(run.get("profile") or "").strip()
        buckets.setdefault((tier, profile), []).append(run)

    summary: list[dict[str, Any]] = []
    for (tier, profile), items in sorted(buckets.items(), key=lambda kv: (-kv[0][0], kv[0][1])):
        waves = [r["wave"] for r in items if isinstance(r.get("wave"), int)]
        durs = [float(r["duration_sec"]) for r in items if isinstance(r.get("duration_sec"), (int, float)) and r["duration_sec"] > 0]
        # Sum total coins and duration across runs that have both verified coins & positive duration
        cph_coins = 0.0
        cph_sec = 0.0
        for r in items:
            tc = r.get("total_coins")
            dur = r.get("duration_sec")
            if (
                r.get("duration_exact", True)
                and r.get("coins_verified", True)
                and isinstance(tc, (int, float))
                and tc > 0
                and isinstance(dur, (int, float))
                and dur >= 30.0
            ):
                cph_coins += float(tc)
                cph_sec += float(dur)

        cph = (cph_coins / (cph_sec / 3600.0)) if cph_sec > 0 else None
        summary.append(
            {
                "tier": tier,
                "profile": profile,
                "runs": len(items),
                "avg_wave": int(round(sum(waves) / len(waves))) if waves else None,
                "best_wave": max(waves) if waves else None,
                "avg_duration_sec": round(sum(durs) / len(durs), 1) if durs else None,
                "coins_per_hour": cph,
                "coins_per_hour_fmt": format_coins(cph) if cph is not None else None,
            }
        )
    return summary
