# Action history leftovers
> **Status:** Done
> **Type:** Task
> **Created:** 2026-10-30
> **Updated:** 2026-10-30
> **Priority:** Low
> **Tags:** actions, history, roadmap-item-7, r18h

## Problem

The action-lifecycle foundation (`d89b808c`, fork PR #11) landed with four items its
review left open, listed in that commit's message:

1. **N3, crash before flush:** an execution recorded in memory is lost if the process dies
   before it is written; needs a seam in `ActionSession`.
2. **True execution start time:** `ActionSession.record` stamps when the row is written,
   not when the action started.
3. **Refused-row count:** history readback drops refused rows without publishing how many.
4. **Unbounded prune:** prune reads every candidate body with no `LIMIT` (no production
   caller yet, so no live cost today).

---

## What Needs to Happen

1. Take each item as its own small PR with a failing test first; 4 and 3 are the smallest.
2. For 1 and 2, add the seam the review asked for in `backend/runtime/action_session.py`
   rather than a workaround in callers.
3. Publish the refused-row count through the existing history read model.

---

## Key Files

| File | Why |
|---|---|
| `backend/runtime/action_session.py` | Recording, flush and start time |
| `backend/towerpilot_workflows/action_history.py` | Readback, refused rows, prune |
| `git show d89b808c` | The review's exact wording of the four items |

---

## Context

Opus approved `d89b808c` with nits: 10 of 11 fix removals turn tests red and live rows
cannot be refused. The local review lane is `backend/logs/reviews/roadmap-item7-r18h-foundation/`.

---

## Outcome

Landed in [SwiggitySwerve/TowerPilot#30](https://github.com/SwiggitySwerve/TowerPilot/pull/30), merge commit `1903c697`, on 2026-10-30. UW history rows are now written when the toggle returns, so a crash cannot lose a buffered row; the retry deadline is taken before the write.
