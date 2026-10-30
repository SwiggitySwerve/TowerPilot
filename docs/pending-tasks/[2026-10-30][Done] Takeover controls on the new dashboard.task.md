# Takeover controls on the new dashboard
> **Status:** Done
> **Type:** Task
> **Created:** 2026-10-30
> **Updated:** 2026-10-30
> **Priority:** High
> **Tags:** takeover, dashboard, roadmap-item-3

## Problem

Taking over a battle already on screen is implemented in the backend but cannot be
started from the Dashboard. The operation worker adopts a live battle (T3b,
`b6f9b415`) and the dashboard has admission and routes for it (T3c, `794022d0`:
`backend/control/takeover.py`, routes registered in `backend/dashboard.py:79,198-204`).
No file under `frontend/app/src` mentions takeover (`git grep -il takeover -- frontend/app/src`
returns nothing on `076c4bc4`), so the only way to use it is a hand-built request.

---

## What Needs to Happen

1. Read the landed contract `backend/tests/fixtures/dashboard_contract_takeover_v1.json`
   and `backend/control/takeover.py` for the admission states and refusals.
2. Add the takeover intent in `frontend/app/src/api/` and its schema in
   `frontend/app/src/contract/`, following how Start and Stop are wired
   (`frontend/app/src/store/commands.ts`, `frontend/app/src/api/wire.ts`).
3. Add the control to the This Battle surface (`frontend/app/src/features/dashboard/thisBattle/ThisBattle.tsx`) behind a
   confirmation (`frontend/app/src/ui/ConfirmDialog.tsx`), shown only when a live battle has no owning
   runner. Copy lives in `frontend/app/src/copy/`.
4. Show the admission result as the backend reports it (accepted, refused with
   reason, unconfirmed until the worker attaches). Never claim an attach the
   backend has not confirmed.
5. Component and contract tests; regenerate pinned fixtures through their writers.

---

## Key Files

| File | Why |
|---|---|
| `backend/control/takeover.py` | Admission rules and refusal reasons |
| `backend/dashboard.py` (routes near lines 79, 198-204) | The endpoints the UI calls |
| `backend/tests/fixtures/dashboard_contract_takeover_v1.json` | Published response shapes |
| `frontend/app/src/store/commands.ts`, `frontend/app/src/api/wire.ts` | Existing command wiring to copy |
| `frontend/app/src/features/dashboard/thisBattle/ThisBattle.tsx`, `frontend/app/src/ui/ConfirmDialog.tsx` | Where the control and its confirmation go |

---

## Context

The old U3 snapshot (`backend/logs/reviews/roadmap-item3-u3/`, git-ignored) was built
on the dashboard before PRs #20-#24 rewrote its layout; 7 of its 21 base files have
changed since its base `38e15ec9`. Use it only as a reference for intent, not as a
patch. Hard rule 3 applies: a takeover adopts a live run and must never end one.

---

## Success Criteria

- [ ] The Dashboard offers takeover only for an unowned live battle and confirms first.
- [ ] Refusals show the backend's reason; success is shown only after the worker attaches.
- [ ] Frontend typecheck, lint and unit tests pass; contract fixtures match the routes.
- [ ] First live takeover observed in the events log (`attach_*` events), see
  [Live acceptance checks owed](%5B2026-10-30%5D%5BOpen%5D%20Live%20acceptance%20checks%20owed.task.md).

---

## Outcome

Landed in [SwiggitySwerve/TowerPilot#27](https://github.com/SwiggitySwerve/TowerPilot/pull/27), merge commit `49efad7c`, on 2026-10-30. The first live takeover is still owed; it is a row in Live acceptance checks owed.
