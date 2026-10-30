# Setup scan metrics and identity
> **Status:** Done
> **Type:** Task
> **Created:** 2026-10-30
> **Updated:** 2026-10-30
> **Priority:** Medium
> **Tags:** setup, metrics, roadmap-item-9, p9a

## Problem

Setup cannot prove a scan got faster or name which build ran it. Phase durations in a
sealed setup state carry over between operations (the spec's G8: `cards` 163.0 s and
`modules` 127.1 s appear in two operations, one of which ran `bootstrap` only), and
there is no count of OCR processes, captures or inputs per scan (G7). Every speed
claim on record is offline or synthetic (G9). This is package P9-A of roadmap item 9;
P9-B ([Setup scan sides and capture swap](%5B2026-10-30%5D%5BOpen%5D%20Setup%20scan%20sides%20and%20capture%20swap.task.md))
builds on it.

---

## What Needs to Happen

1. Re-implement P9-A on current `master`; the built package is against base `38e15ec9`
   and 5 of its 12 modified targets have changed since (`backend/runtime/build_info.py`,
   `backend/vision/textocr.py`, `backend/device/act.py`, `backend/dashboard.py`,
   `backend/tests/fixtures/dashboard_contract_pages_v1.json`).
2. New modules: `backend/runtime/scan_identity.py` (which build and account a scan ran
   under) and `backend/runtime/scan_metrics.py` (per-scan duration and OCR, capture
   and input counters, reset per operation).
3. Count at the sources: `backend/vision/textocr.py` (OCR processes), `backend/device/capture.py`
   (captures), `backend/device/act.py` (inputs); wire into `backend/player/calibrate.py` and
   `backend/runtime/operations.py`; publish through `backend/dashboard.py`.
4. Fix the open review advisories A1-A7 recorded in the package review before opening the PR.
5. Tests: `test_scan_metrics.py`, `test_scan_metrics_worker.py`, `test_scan_identity.py`,
   recorded dashboard cases; regenerate `dashboard_contract_pages_v1.json` through its writer.

---

## Key Files

| File | Why |
|---|---|
| `backend/logs/reviews/roadmap-item9/spec.md` (local) | Design, gaps G1-G11, decisions D1-D9 |
| `backend/logs/reviews/roadmap-item9-p9a/` (local) | Built package (`p9a.diff`), reviews, advisories A1-A7 |
| `backend/vision/textocr.py`, `backend/device/capture.py`, `backend/device/act.py` | Counter sources |
| `backend/player/calibrate.py`, `backend/runtime/operations.py`, `backend/runtime/build_info.py` | Where a scan starts, ends and records identity |
| `backend/dashboard.py` | Publishes the metrics |

---

## Context

Checked 2026-10-30: `backend/runtime/scan_metrics.py` and `scan_identity.py` do not exist
on `076c4bc4`. The package passed one Opus review (APPROVE); its Astra review never
finished, so treat the diff as a draft. Instruments only: offline tests prove counters
and comparability; live scans (L1, clean Home, no battle) prove the numbers. A live scan
needs the gem collector stopped (`POST /api/calibrate/start` is refused as `device_owned`
while it runs).

---

## Success Criteria

- [ ] A sealed setup operation reports only its own phase durations and its own counters.
- [ ] Each scan names the build and account it ran under.
- [ ] Offline tests prove the counters; full backend suite passes; contract fixtures regenerated.
- [ ] One L1 live scan on the new build shows plausible counts (live check, person).

---

## Outcome

Landed in [SwiggitySwerve/TowerPilot#29](https://github.com/SwiggitySwerve/TowerPilot/pull/29), merge commit `6de745eb`, on 2026-10-30. The L1 live scan that shows real counts is still owed; it is a row in Live acceptance checks owed.
