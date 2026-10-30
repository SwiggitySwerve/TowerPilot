# Visual acceptance of the dashboard pages
> **Status:** Open
> **Type:** Task
> **Created:** 2026-10-30
> **Updated:** 2026-10-30
> **Priority:** Medium
> **Tags:** dashboard, acceptance, needs-person

## Problem

The dashboard pages have no recorded visual sign-off on their current layout. The item 4
(Dashboard and top bar) and item 5 (Runs and Schedule) acceptance records from 2026-10-23 are
still `partial`, and PRs #20-#24 have since rebuilt the layout. Item 8 (the remaining pages
under `frontend/app/src/features/*`) has no acceptance record at all. The feedback brief's
step 7 (retry, duration and scope affordances, history, chip visuals) is waiting on the same check.

---

## What Needs to Happen

1. Build the app (`npm run build` in `frontend/app`) and open the running dashboard.
2. Walk every page at a desktop and a narrow width, and note what is wrong per page.
3. File each defect as its own task file; record "accepted" per page below.

| Page group | Last record | Status |
|---|---|---|
| Dashboard and top bar (item 4) | 2026-10-23, partial; layout changed since | open |
| Runs and Schedule (item 5) | 2026-10-23, partial (84 failing frontend tests at the time; rerun first) | open |
| Remaining pages (item 8) | none | open |

---

## Key Files

| File | Why |
|---|---|
| `frontend/app/src/features/` | One folder per page |
| `frontend/app/README.md` | Build, dev server and test commands |
| `backend/logs/reviews/dashboard-visual-acceptance.md` (local) | Earlier acceptance notes |

---

## Context

Visual acceptance is the person's call (`docs/FOCUS.md`, needs the person). Screenshots for
a review can be attached to the PR that fixes a page.

---

## Success Criteria

- [ ] Every page group is accepted, or its defects are filed as tasks.
