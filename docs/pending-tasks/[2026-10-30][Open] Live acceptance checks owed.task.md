# Live acceptance checks owed
> **Status:** Open
> **Type:** Task
> **Created:** 2026-10-30
> **Updated:** 2026-10-30
> **Priority:** Medium
> **Tags:** live, acceptance, needs-person

## Problem

Several landed behaviors have passed every offline test but have never been seen working on
the real game. Each needs one natural occurrence on a live run, read from the events log
(`backend/logs/<instance>/events_*.jsonl`, newest file per process). None may be
manufactured by interrupting a farm (hard rules 2-5).

---

## What Needs to Happen

Run the activity named in each row, then record the evidence (event, timestamp, log file) in the row.

| Check | How it shows up | Evidence so far (2026-10-30) |
|---|---|---|
| Shopping buys an upgrade (roadmap item 6; feedback step 6) | an `action_executions` row with action `shopping`; a `shop_sweep_end` that is not `skipped` | 0 shopping rows in `backend/logs/operations.sqlite3`; all 14,259 `shop_sweep_end` events are `skipped`, mostly `reserve_or_no_eligible_upgrades` |
| Taking over a live battle (roadmap item 3) | `attach_*` events | none in any events log; the Dashboard control landed in #27 |
| Setup scan metrics on a real scan (L1: clean Home, no battle, harvesting paused) | the sealed metrics of the setup operation (`/api/calibrate/metrics`, #29) | no live scan since #29 |
| `ensure_home` treats the END ROUND confirmation as a battle (r18g, `de0db599`) | the confirmation frame held, not tapped through | not observed |
| Perk bans applied before a run (0.6 release note) | `perk_bans_applied` or `perk_bans_failed` | none in any events log |
| Collect on a person's manual battle (roadmap item 1) | `roadmap-item1/acceptance.json` (local) still partial at P4 | needs a fresh live run, or the person accepts P4 as is |
| Learning flows (`docs/LEARNING_FLOWS.md`) and a natural run end (`docs/RUN_LIFECYCLE_PLAN.md`) | the events those docs name | not observed |

---

## Key Files

| File | Why |
|---|---|
| `backend/logs/<instance>/events_*.jsonl` | Where each occurrence is recorded |
| `backend/logs/operations.sqlite3` | Action executions (open read-only) |
| `tools/gem_health.py` | Read-only collection health after any live change |

---

## Context

Already observed live: ad-gem collection, 13 of 13 claims confirmed between 18:23 and 21:08
on 2026-10-29 (`backend/logs/main/events_20261029_182347_48124_6ba9505a.jsonl`).

---

## Success Criteria

- [ ] Every row has a recorded natural occurrence, or the person accepts it without one, in writing here.
- [ ] Any failure found becomes its own task file.
