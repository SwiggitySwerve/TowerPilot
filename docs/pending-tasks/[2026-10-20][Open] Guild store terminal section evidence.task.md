# Guild store terminal section evidence
> **Status:** Open
> **Type:** Task
> **Created:** 2026-10-20
> **Updated:** 2026-10-30
> **Priority:** Medium
> **Tags:** guild-store, calibration, purchase-evidence

## Problem

The final Tower Guardian store section has no independent terminal landmark or
extent in the current shipped capture metadata. A stationary swipe and a visible
section heading cannot prove that all chips have been seen. The final review of
PR [#5](https://github.com/SwiggitySwerve/TowerPilot/pull/5) reproduced a lower-priority
background purchase while a higher-priority chip remained entirely below the
viewport, even with one complete owned chip and a clear bottom margin visible.

The remediation therefore requires section coverage for priority decisions and
refuses lower-priority buying when final chip-section coverage is unproven.
Relic-section boundaries and positively observed chip offers can still support
their own priority decisions. This task concerns the missing terminal evidence,
not weakening that refusal.

---

## What Needs to Happen

1. During a sanctioned human-started calibration session, inspect the actual
   final store section for an independent terminal landmark, scrollbar endpoint,
   or other reliable extent evidence. Preserve human-owned screens and live runs.
2. Validate the evidence against multiple layouts and partially visible final
   rows. Neither a fixed row/card count inferred from synthetic fixtures, blank
   margin, nor repeated motionless swipes alone establishes terminal extent.
3. Integrate a positive completeness result into the existing section evidence
   contract. Keep missing, stale, conflicting, or unreadable evidence incomplete.
   Calibration images must remain account-local; runtime never creates them.
4. Restore lower-priority purchases only when all higher-priority section states
   are positively accounted for. Retain concrete item reacquisition, price and
   balance validation, one dispatch, and independent item/debit outcome proof.

---

## Key Files

| File | Purpose |
| --- | --- |
| `backend/interactions/store.py` | Observed cards, section coverage, priority selection |
| `backend/player/bootstrap_manifest.json` | Current guild-store geometry and capture metadata |
| `backend/player/scan_targets.json` | Text-only calibration target metadata |
| `backend/player/calibrate.py` | Human-started calibration |
| `backend/tests/unit/test_store_purchase_evidence.py` | Real synthetic pixel scan and interrupted-scroll regressions |

---

## Context

Still open on master `076c4bc4` (checked 2026-10-30): `_catalogue` returns
`frozenset(expected[:-1])` (`backend/interactions/store.py:357`), so the final
(Tower Guardian) section is never complete and `_target` refuses lower-priority buys.

The first reproduction caps the existing synthetic world's scroll offset at 900,
marks the relic owned and the background priced, and leaves both chips priced.
The second places a complete owned chip at content y=1470, height=200, and a
priced chip at y=1740, height=100. At the capped viewport the priced chip is
entirely invisible. Both previously authorized a background purchase.

Closed-card detection and explicit clipped-outline evidence address partial
cards, but cannot establish that another row is not wholly off-screen. The
shipped manifest currently supplies section/title targets, a collection viewport,
and a page bound, not an independently verified terminal marker. Do not introduce
an assumed two-chip limit. Sold-out recognition is separately tracked in
[the existing task](%5B2026-10-19%5D%5BOpen%5D%20Guild%20store%20sold-out%20recognition.task.md).

---

## Success Criteria

- [ ] Terminal evidence distinguishes true final extent from both interrupted-scroll reproductions.
- [ ] Unseen higher-priority merchandise never authorizes a lower-priority purchase.
- [ ] A completely evidenced catalogue can select eligible lower-priority items.
- [ ] No game pixels or account data enter Git, and runtime adds no template writer.
- [ ] Offline regressions pass; live claims require a newly running observation.

---

## Architectural Reasoning

Use the existing image evidence and section coverage contract. A second scanner,
new background service, fixed retry count, or guessed cardinality would not
resolve the missing observation. The prerequisite is trustworthy terminal
evidence from the real interface, acquired through the existing human-started
calibration surface.
