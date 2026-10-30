# Guild store sold-out recognition
> **Status:** Open
> **Type:** Task
> **Created:** 2026-10-19
> **Updated:** 2026-10-30
> **Priority:** Medium
> **Tags:** guild-store, calibration, recognition

## Problem

The purchase-evidence remediation in commit `a10d445` refuses complete cards
whose state cannot be positively identified. Saved local guild-store captures
examined during that work contain SOLD OUT panels. The current store reader
recognizes price controls and OWNED controls only. Refusal preserves purchase
priority and prevents unknown merchandise from silently disappearing from the
catalogue, but an unsupported sold-out card can prevent otherwise valid buying.

---

## What Needs to Happen

1. Add a text-only acquisition target for the sold-out state through the
   existing human-started calibration workflow, with card-local bounds and
   distinctiveness verification. Keep every resulting image account-local.
2. Extend the store reader with a positive unavailable state that remains
   identity-bound and distinct from owned, missing, and unreadable evidence.
3. Decide availability policy explicitly: an unavailable item cannot be bought;
   unknown state must continue to refuse the catalogue. Preserve the existing
   priority ladder, concrete target reacquisition, and one dispatch per flow.
4. Add synthetic regressions for sold-out cards, unknown glyphs, and changing
   availability. Verify the first supported observation on newly deployed code
   at a safe run boundary; never navigate over a human-owned screen.

---

## Key Files

| File | Purpose |
| --- | --- |
| `backend/interactions/store.py` | `scan_frame` state classification and `_target` priority selection |
| `backend/player/scan_targets.json` | Existing text-only calibration acquisition metadata |
| `backend/player/calibrate.py` | Sanctioned human-started image acquisition |
| `backend/tests/unit/test_store_purchase_evidence.py` | Synthetic evidence and purchase regressions |

---

## Context

Still open on master `076c4bc4` (checked 2026-10-30): cards are read only as
`price` or `owned` (`backend/interactions/store.py:227-229`), any other complete
card raises "no recognized price/owned state", and `backend/player/scan_targets.json`
has no sold-out target.

Do not use runtime template writing or add subprocess OCR to the store flow.
The current safe refusal is intentional and covered by
`test_complete_unknown_state_cannot_hide_higher_priority_merchandise`. A complete
card with no recognized state must not be silently skipped. Purchase success
still requires an item-specific outcome and expected debit; balance reduction
alone is insufficient. All captures stay local and ignored by Git.

---

## Success Criteria

- [ ] Supported sold-out cards are positively identified within their own panel.
- [ ] Unknown and ambiguous state continues to block purchasing.
- [ ] The priority decision and purchased identity remain bound through scrolling.
- [ ] No game images, account state, runtime template writers, or OCR subprocesses
  are added to the release.
- [ ] Offline regressions pass; any live claim includes a newly deployed observation.
