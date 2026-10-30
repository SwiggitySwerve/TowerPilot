# Setup scan sides and capture swap
> **Status:** Open
> **Type:** Task
> **Created:** 2026-10-30
> **Updated:** 2026-10-30
> **Priority:** Medium
> **Tags:** setup, speed, roadmap-item-9, p9b

## Problem

A "setup is faster" claim needs a fair before/after pair: the same dashboard, ledger,
account state and gates, with only the claimed change different. Item 9's design
(spec section 1.3) makes the before side the landed code with the reverse of the
claim's own pause changes applied as an overlay. Nothing on master can run that
comparison: `backend/tools/scan_sides.py` does not exist. P9-B also carries the
temporary capture swap the live comparison uses and the Range candidate producer
(gap G11: the flow can never cut a candidate for an existing but wrong stats image,
`backend/player/flow_capture.py`, `capture_upgrade_labels`).

---

## What Needs to Happen

1. Land [Setup scan metrics and identity](%5B2026-10-30%5D%5BDone%5D%20Setup%20scan%20metrics%20and%20identity.task.md) first; this builds on its counters.
2. Re-implement the permanent P9-B files on current `master`: `backend/tools/scan_sides.py`,
   `backend/tools/scan_sides.rules.md`, `backend/tools/overlays/p9b_pauses.json`,
   `backend/tests/support/scan_sides_loader.py` and their tests.
3. Re-implement the swap on `backend/player/bootstrap.py`, `card_inventory.py`,
   `collection_scan.py` and `mapping_session.py` (unchanged since the package base, so the
   built diff should still apply).
4. Finish the open reviews (both Astra and Opus were incomplete), one PR per package.
5. Live gates, person-authorized: D3 (consent popup), D5 (L1 Home scans with harvesting
   paused), D8 (approve or reject the Range candidate and its backup).

---

## Key Files

| File | Why |
|---|---|
| `backend/logs/reviews/roadmap-item9/spec.md`, `root-decisions.md` (local) | Design and decisions D1-D9 |
| `backend/logs/reviews/roadmap-item9-p9b/`, `roadmap-item9-p9b-swap/` (local) | Built packages, report, 1125-test verification |
| `backend/player/flow_capture.py` | Range candidate step (G11) |
| `backend/player/bootstrap.py`, `card_inventory.py`, `collection_scan.py`, `mapping_session.py` | Swap targets |

---

## Context

Progress 2026-10-30: [#31](https://github.com/SwiggitySwerve/TowerPilot/pull/31) (merge `6693eb30`)
landed steps 1-2: `backend/tools/scan_sides.py` declares both sides from committed LF bytes and
never writes source, and the existing Range candidate step now verifies its files byte for byte
and records the rect on the first frame. Still open: step 3, the swap, deferred because the old
process guard cannot stop a worker from starting or lazily importing while files are swapped;
it needs a race-free guard first. Step 5 (D3, D5, D8) remains the person's.

Checked 2026-10-30: `backend/tools/scan_sides.py` is absent on `076c4bc4`. The package
report records 1125 tests across 47 files passing, swap verify 15/15, and all mutants
killed, against base `38e15ec9`. No real Range candidate has been captured yet. Hard
rule 6 applies: the Range step writes a candidate only, never a template, and the person
approves any replacement.

---

## Success Criteria

- [ ] `scan_sides.py` produces a comparable before/after pair or refuses with the reason.
- [ ] The Range step writes a candidate only; the person's approval replaces the template.
- [ ] Full backend suite passes; each package lands as its own PR.
- [ ] D3, D5 and D8 recorded with the person's decision.
