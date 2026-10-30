# Open policy decisions
> **Status:** Open
> **Type:** Task
> **Created:** 2026-10-30
> **Updated:** 2026-10-30
> **Priority:** Medium
> **Tags:** decisions, needs-person

## Problem

Six questions from the 2026-10-24 council synthesis (section 5) have no recorded answer.
Each blocks or shapes later work. A search of the git log since 2026-10-24, `docs/` and
`CLAUDE.md` on 2026-10-30 found no decision for any of them.

---

## What Needs to Happen

The person answers each row; the answer is written here and, if it changes a rule, in its
canonical home (`CLAUDE.md` hard rules, or the skill that owns the rule).

| # | Question | Bears on |
|---|---|---|
| 1 | Are golden test fixtures exempt from hard rule 8 (no account data in shipped files)? | `backend/tests/fixtures/golden_profile.yaml`, release-clean test |
| 2 | Keep or drop the strict schema layer (31% of the shipped JavaScript)? | `frontend/app/src/contract/` |
| 3 | May recognition use native preview frames? | `backend/device/preview/`, vision |
| 4 | How does a person's leftover run differ from a scheduler handoff for surrender rules? | hard rule 3, `scheduling/combo.py`, `flows/shard.py` |
| 5 | May a runner-side learner cut the ad claim template? | hard rule 6, `interactions/ad_gems.py` |
| 6 | May installed APK art be a live matcher? | hard rule 6, image-free release boundary |

---

## Key Files

| File | Why |
|---|---|
| `CLAUDE.md` | Hard rules 3, 6 and 8, and the image-free release boundary |
| `backend/logs/reviews/quality-council-20261024/synthesis.md` (local) | The questions' full context, section 5 |

---

## Context

Already decided (from `docs/FOCUS.md` before 2026-10-30): ad-gem interval 600-660 s on the
farm run, tap cap 5 per second, the ad delay clamp, preview auto-start only when the emulator
is already up, and the person starts MuMu.

---

## Success Criteria

- [ ] Each of the six rows has an answer and a date.
- [ ] Every answer that changes a rule is written in that rule's canonical home.
