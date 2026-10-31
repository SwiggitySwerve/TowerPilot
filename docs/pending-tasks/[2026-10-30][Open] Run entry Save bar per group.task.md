# Run entry Save bar per group

> **Status:** Open
> **Created:** 2026-10-30
> **Updated:** 2026-10-30
> **Priority:** High
> **Tags:** ui, runs, run-entry, profile-patch, fencing

## Problem

The Runs page "Entry and equipment" form has one "Save field" button per field (about twelve), each
with its own status line. In the 2026-10-30 hillclimb of the Runs page all three independent
reviewers marked it down in every round (Hierarchy, Content, Controls and states, Grouping), and it is
the largest single reason no cell reached 9.0. The person chose, on 2026-10-30: **one Save bar per
group** (Identity, Entry behavior, Policies), with each changed field still sent as its own save.

That is not a layout change, so the hillclimb (UI only) did not do it:

- Every field save is `commands.patchRunEntry(command)` (`frontend/app/src/app/wiring.ts`, the
  `patchRunEntry` entry), one `POST /api/profile-patch` with `expected_revision` = the field's base
  revision (`command.revision`).
- The base revision is pinned per field by the draft marker
  (`entryDraftMarker` / `entryDraftSnapshot`, `frontend/app/src/core/runEntry.ts`); the selector
  (`frontend/app/src/store/selectors/runEntry.ts`, the `blocked` computation) marks a field
  `revision` when its draft's base differs from the current read, and `pending` while any profile
  save is unsettled (`settingsSavePending(state, ['profileSource'])`), so a field's command is
  `null` while another save is in flight.
- `patchRunEntry` also refuses a second send while one is reserved (`collectionChecks`,
  `collection_write_in_flight`).
- The backend serialises per profile and refuses a stale `expected_revision` with
  `409 revision_conflict` (`backend/dashboard.py`, `api_profile_patch`); on success it answers the
  new `revision`, so chaining is possible server side.

A Save that loops over the group's commands therefore either is refused client side (in flight) or
the second field meets `revision_conflict` (its base is the pre-save revision).

## What Needs to Happen

1. Add a group save command (for example `commands.saveRunEntryGroup(commands)`) that sends the
   group's changed fields ONE AT A TIME: each POST waits for the previous answer, and each next
   `expected_revision` is the revision the previous 200 answered (that revision is base plus only
   this page's own write, so chaining it does not hide another writer's change).
2. Stop at the first refusal or unknown outcome; the remaining fields keep their drafts, and the
   refused field shows its existing outcome (`SaveOutcome`) and continuation.
3. Re-point each remaining field's draft marker to the chained revision as it is sent, so the
   selector does not mark it `revision` because of this page's own earlier write.
4. Render one `ActionRow` per group (Save, Discard) in `frontend/app/src/features/runs/RunEntry.tsx`;
   the group Discard calls `commands.discardDraft(scope)` for each dirty field. Field-level errors,
   Clear label, Restore quest default and Continue stay beside their field.
5. Record new contract fixtures for a two-field chained save (both answered, and second refused) in
   `backend/tests/fixtures/dashboard_contract_pages_v1.json` through the generator, and add fake
   backend scenarios (`frontend/app/tests/support/fake-backend/scenarios.mjs`).
6. Rewrite the per-field "Save field" assertions (39 call sites, list below) to the group bar while
   keeping every fencing assertion: pending, unknown, revision, continuation, inactive target,
   click-time target check.

## Key Files

| File | Why |
|---|---|
| `frontend/app/src/features/runs/RunEntry.tsx` | Per-field ActionRow today; the group bar goes here |
| `frontend/app/src/store/selectors/runEntry.ts` | Field command, `blocked` and continuation logic |
| `frontend/app/src/app/wiring.ts` | `patchRunEntry`: fences, reservation, click-time target check |
| `frontend/app/src/store/commands.ts` | Command interface (`patchRunEntry`) |
| `frontend/app/src/core/runEntry.ts` | Draft marker (base revision per field) |
| `backend/dashboard.py` | `api_profile_patch`: revision guard and returned revision |
| `frontend/app/tests/unit/features/runs/runEntry*.test.tsx`, `tests/unit/features/profilePatchFenced.test.tsx`, `tests/unit/features/profiles/targetSourceGeneration.test.tsx` | Unit assertions on the per-field Save |
| `frontend/app/tests/e2e/runs-entry*.spec.ts`, `tests/e2e/profile-patch-fenced.spec.ts` | Browser assertions on the per-field Save |

## Context

- Hillclimb captures and reviewer reports: `backend/logs/reviews/ui-legacy-parity/runs/hillclimb/`
  (git-ignored; rounds r0 to r4, `brief.md`, `capture.mjs`, `contrast.py`).
- The same hillclimb moved each field's Save beside its control (one row per field) and made hints
  one size; that layout is the starting point.
- Untouched fields can carry an enabled Save (for example Perk bans, Restart via Home): their
  saved value is absent, so saving writes an explicit value. The group bar must decide whether an
  untouched-but-saveable field counts as a change (recommended: only dirty fields).

## Success Criteria

- Changing two fields in one group and pressing the group Save sends two POSTs in order, the second
  with the first answer's revision, and both fields read back saved.
- A refusal of the second leaves its draft and shows its reason; nothing after it is sent.
- Every existing fencing behaviour still has a passing test.
- Runs page reviewers no longer cite repeated Save buttons.

## Architectural Reasoning

Chaining on the returned revision keeps the server's last-writer-safe guard intact: each write is
still judged against exactly the state this page last wrote. Batching all fields into one request
was rejected: `api_profile_patch` is documented as one typed field per request, and a new batch
endpoint is a wider contract change than the person asked for.
