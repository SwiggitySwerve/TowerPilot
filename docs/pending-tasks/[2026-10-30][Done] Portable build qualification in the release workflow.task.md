# Portable build qualification in the release workflow
> **Status:** Done
> **Type:** Task
> **Created:** 2026-10-30
> **Updated:** 2026-10-30
> **Priority:** Medium
> **Tags:** release, portable, ci, roadmap-item-10, p10d, p10e

## Problem

Nothing checks that the portable ZIP installs and runs. `docs/PORTABLE_BUILD.md`
("Release workflow") says there is no scripted check of the installed ZIP and E3 (a
clean extraction) is done by hand. The same doc's environment table already describes
E2 as running "through `release.yml`", but `.github/workflows/release.yml` on master has
no full offline suite and no qualification step. Packages p10d (qualification tools)
and the workflow half of p10e were built and never landed.

---

## What Needs to Happen

1. Re-implement p10d on current `master`: `tools/qualify_portable.py` (extract the
   portable ZIP to a fresh folder and run its self-checks), `tools/validate_acceptance.py`
   (validate an acceptance report), and `backend/tests/unit/test_qualify_portable.py`.
2. Fix the blocking review finding first: a stub acceptance report is accepted with exit
   code 0 (`backend/logs/reviews/item10-p10d/evidence/acceptance-probe.json`, local). The
   validator must refuse a report that was not produced by a real qualification run.
3. Add to `.github/workflows/release.yml`: the full offline backend suite and a
   "Qualify portable archive" step that runs `tools/qualify_portable.py` on the built ZIP (E2/E3).
4. Update `docs/PORTABLE_BUILD.md` so the table and the workflow section match what runs.

---

## Key Files

| File | Why |
|---|---|
| `.github/workflows/release.yml` | Where E2/E3 qualification must run |
| `tools/build_portable.py`, `tools/check_release_zips.py` | Existing build and archive checks to chain from |
| `docs/PORTABLE_BUILD.md` | Environment table E1-E3 and the workflow description |
| `backend/logs/reviews/item10-p10d/` (local) | Built package `p10d.diff`, interrupted review, probe evidence |

---

## Context

Checked 2026-10-30: `tools/qualify_portable.py` and `tools/validate_acceptance.py` are
absent on `076c4bc4`; p10a (build identity, `19a37269`) and the p10e docs (`c52fc703`)
landed. The package base is `38e15ec9`; re-read every target before re-implementing. A
qualification run must never touch an emulator or adb (the tests refuse ports 5037,
8620 and 8630).

---

## Success Criteria

- [ ] `tools/validate_acceptance.py` refuses a stub report; a real qualification report passes.
- [ ] `release.yml` runs the offline suite and qualifies the portable ZIP before publishing.
- [ ] `docs/PORTABLE_BUILD.md` describes exactly the checks that run.
- [ ] One workflow run on a test tag shows the qualification step green.

---

## Outcome

Landed in [SwiggitySwerve/TowerPilot#26](https://github.com/SwiggitySwerve/TowerPilot/pull/26), merge commit `11a649ed`, on 2026-10-30. With the archive gate fixed (#28), the real portable ZIP qualifies with every check, gate included.
