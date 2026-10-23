# Timed actions: the contract, the history and the rules

> **Status:** Active (item 6, first batch: the pilot only)
> **Type:** Rules
> **Created:** 2026-10-22
> **Updated:** 2026-10-22
> **Owner:** Backend
> **Spec:** [roadmap-items-6-7/spec.md](../logs/reviews/roadmap-items-6-7/spec.md)
> **Tags:** actions, scheduling, history, gems, shopping, harvest

## What it is

One contract for a timed action, called by the drivers that already exist. A driver asks a schedule policy "is this due?",
runs its own handler behind its own guards, and records the execution. There is no scheduler, no resident thread and no
second input owner: the device lease and the operations ledger stay the only owners of input and of recorded state.

| Concern | Owner | Imports |
|---|---|---|
| Definitions, schedule policies, field schema, catalog | `backend/towerpilot_workflows/action_contract.py` | stdlib only |
| The execution table and its transitions | `backend/towerpilot_workflows/actions.py` (`Actions`, a subclass of `Operations`) | the contract, the ledger |
| Host adapter and the `runtime.actions` projection | `backend/runtime/action_session.py` (`ActionSession`) | no device, adb or capture module |
| Dashboard query and the refresher's settlement | `backend/control/actions.py` | the above |

## The rules

1. **The policy decides "due" and "next".** `StartToStart` (ad gems), `AppearanceDriven` (floating gems: an attempt opens when the host recognizes the gem, with spacing only after input that was
   not confirmed), `AfterCompletion` (shopping) and
   `Backoff` (harvest launch attempts) are the only expressions of those cadences. A policy reads no clock, random source or
   file: the host passes `now` and draws its own random numbers, in the order the old code did.
2. **The host owns the state.** Reset scope does not change: gem windows and shopping reset per process, the harvest circuit is
   read from the operations rows.
3. **One writer.** `Actions.begin` / `finish` (each a `BEGIN IMMEDIATE` compare-and-set), `record_check`, `record_terminal` and
   settlement are the only writers of `action_executions`.
4. **Recording never changes behaviour.** A failure to record is counted (`ActionSession.unrecorded`) and logged, never raised.
5. **An execution is only as proven as its evidence.** A window or sweep that sent input and proved nothing is
   `failed` with effect `unconfirmed`; `succeeded` is `confirmed` evidence only. Unknown is `null`, never zero.
6. **Settlement needs an exact fence.** An open row is closed `interrupted` only when its operation is terminal, its battle ended,
   or its battle moved to another generation. It keeps `finished_at` and `duration_ms` null. Settlement runs from the existing
   refresher, from a driver's own finalization, and as a courtesy in `begin` for the same instance. A GET never settles.
7. **Coalescing is narrow.** Only an automatic, no-input check that ended `refused` or `no_op` shares a row, with the open aggregate
   of the identical scope. A started, manual or key-linked execution is its own row.
8. **Reads never create anything.** Every read goes through `operations.readonly`; a checkout with no ledger answers an empty history.
9. **Controls reuse the existing routes.** A new action adds a catalog entry and a binding, never a route. The single read route is
   `GET /api/actions/executions`.
10. **Collection-only authority stays gem-only.** Harvest's overlay and guard name the two gem routines on purpose.

## Pilot coverage (this batch)

| Action | Policy | Callers recorded |
|---|---|---|
| `ad_gems` | `StartToStart` | all six `GemWatch` hosts: orchestrator, collector, shard batch, quest SM, quest ILM, harness |
| `floating_gems` | `AppearanceDriven` | the same six hosts (r14g made the tapper appearance-driven; the contract follows the shipped behaviour) |
| `shopping` | `AfterCompletion` | the orchestrator's `Shopper` (a sweep that sends input is a row; input-free sweeps are counted checks) |
| `harvest_launch` | `Backoff` | the dashboard's reconciler: every accepted launch, refusal and failure |

Not done in this batch: deriving the live-control dispatch (`BattleSession._apply_control`), Run now's `progress()` binding and the
saved-setting adapters from the catalog (spec 2.4 and 2.6). `control_settings.FIELDS` is generated from the catalog for the pilot
actions; the four gates that are not timed actions (rewards, abilities, rescue, repeat) stay literal until their migration.

## Tests

Golden traces captured before any edit pin the cadence of every pilot caller (`backend/tests/fixtures/action_golden_v1.json`,
explicit regeneration only: `TP_REGENERATE_ACTION_GOLDEN=1 python -m pytest backend/tests/test_action_golden_capture.py`).
Parity, interruption, ownership, ledger, session, route and synthetic-extension tests are the `backend/tests/test_action_*.py` files.