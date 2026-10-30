# Render-time latency measurement
> **Status:** Open
> **Type:** Task
> **Created:** 2026-10-30
> **Updated:** 2026-10-30
> **Priority:** Low
> **Tags:** dashboard, observability, latency

## Problem

The feedback brief's step 1 asked to measure the whole path from a control press to what
the page shows: intent, accepted response, applied revision, first observed effect,
published state, rendered state. The backend half exists (events carry trace, operation,
span and attempt IDs). The app measures nothing at render time: the only `performance.now`
use is in `frontend/app/src/api/preview.ts`. The one latency sample on record (10 samples,
median 2.45 ms) measures response body to page update in an external harness, not
publication to render.

---

## What Needs to Happen

1. Decide with the person whether the harness sample is enough (if yes, close as Won't Fix).
2. Otherwise record, per command, the monotonic times of press, accepted reply and first
   render of the published effect, keyed by the operation ID the backend already returns.
3. Keep it in memory with a bounded buffer and expose it on the Runtime page; never log
   every frame.

---

## Key Files

| File | Why |
|---|---|
| `frontend/app/src/store/commands.ts` | Where a press becomes a request |
| `frontend/app/src/api/poller.ts` | Where published state arrives |
| `frontend/app/src/core/runtime.ts` | Runtime page view model |

---

## Context

Source: `backend/logs/reviews/pending/[2026-10-20][In Progress] Feedback and subsystem polish.task.md`
(local). Its steps 2, 3, 4 and 8 are done on master (`19a37269`, `b27d9efa`, `364ea567`,
`b5ef0779`); step 5 is mostly done; steps 6, 7 and 9 need a live run or visual acceptance
and are tracked in the person's tasks queued in `docs/FOCUS.md`.
