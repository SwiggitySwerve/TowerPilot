# Timed actions: the contract, the history and the rules

> **Status:** Active (item 6: the pilot, and the control surface generated from the catalog)
> **Type:** Rules
> **Created:** 2026-10-22
> **Updated:** 2026-10-24 (item 7, A3a; item 6, A2-7: what a page reads)
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
| The bindings a driver registers (control, Run now, routine status) | `backend/runtime/action_bindings.py` | no device, adb, capture or settings module |
| Saved settings: the adapters the definitions name | `backend/player/saved_controls.py` (read by `player/run_controls.py` and `control/run_workspace.py`) | profile and gather modules |
| Control validation (`FIELDS`, documents) generated from the catalog | `backend/towerpilot_workflows/control_settings.py` | the contract |
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
9. **Controls reuse the existing routes.** A new action adds a catalog entry, a binding and (when it has saved settings) a saved
   adapter, never a route and never a dashboard branch. The single read route is `GET /api/actions/executions`. Nothing that
   dispatches a control, accepts or follows a Run now, publishes a routine or reads and writes a saved setting names an action
   (`test_action_dispatch_generated.py` checks the code, not the behaviour): each asks the catalog and the binding or adapter registered for it.
10. **Collection-only authority stays gem-only.** Harvest's overlay and guard name the two gem routines on purpose.

## Pilot coverage (this batch)

| Action | Policy | Callers recorded |
|---|---|---|
| `ad_gems` | `StartToStart` | all six `GemWatch` hosts: orchestrator, collector, shard batch, quest SM, quest ILM, harness |
| `floating_gems` | `AppearanceDriven` | the same six hosts (r14g made the tapper appearance-driven; the contract follows the shipped behaviour) |
| `shopping` | `AfterCompletion` | the orchestrator's `Shopper` (a sweep that sends input is a row; input-free sweeps are counted checks) |
| `harvest_launch` | `Backoff` | the dashboard's reconciler: every accepted launch, refusal and failure |

## What a page reads (A2-7)

A page renders any timed action from one item of `battle.runtime.actions` (built only by `ActionSession.project`) and the history reads, with no table of its own:

- **The item** names the action (`id`, `label`) and the configured instance (`instance`); `key` is the routine key, which is both the prefix of its live-control paths
  (`routines.<key>.<field>`) and its Run now token (`<key>[:<variant>]`). `descriptor.fields` lists what can be edited; `values` carries the value in force of EVERY listed field
  (the ledger's applied controls, so a control still waiting is not yet in force; a field the controls do not hold is `null`, unknown, never zero; `enabled` is the routine's own gate).
- **`last`** is the newest finished execution of the instance. `last.command_id` is the Run now command that started it (`null` for an automatic one), so one read links a command to its execution.
- **Staleness:** a publish that builds the projection stamps it `observed_at` with the epoch it writes as `runtime.server_time`; a publish that cannot build it leaves the last projection
  and its stamp behind, so a reader that sees `observed_at` older than `server_time` knows the item is not current.
- **History rows** (`GET /api/actions/executions`, and `executions.items` of `GET /api/battles/<id>`) carry `label`, the label the action has in the catalog in force (`null` for an action
  it no longer holds), added when the row is read and never stored. A battle block cut off at a page says `truncated` and hands out `next_before`, the cursor that
  `GET /api/actions/executions?battle_id=<id>&before=<next_before>` continues from (a complete block has no `next_before` key).
- **Recordings** for a page's tests: `dashboard_contract_pages_v1.json` (`battle_actions_projection`, `action_executions`, `action_executions_more`) for the production actions, and the TEST-ONLY
  `synthetic_action_contract_v1.json` for an action no production file names (`synthetic_action_contract.py` generates it through the real routes with `use_catalog`; it must never be copied
  into the app's own generated contract).

## Item 7, A3a: rewards and chores

The side-menu reward upkeep and the between-run chores are migrated to the same contract. Their numbers live in the catalog and nowhere else:

| Action | Policy (shared object) | Whose state | Recorded by |
|---|---|---|---|
| `daily_missions`, `guild_progress`, `event_missions` | `Cooldown(300)` (`REWARD_CHECK`) over `global_rewards:<account>:<key>:next` | account | `runtime/flow_history.py` (a check that finds no badge is one counted no-op row; a flow is an execution) |
| `quest_visit`, `guild_visit` | `Cooldown` with a sampled delay (`VISIT_SCHEDULE`: a repeat within 1200 s of the last visit draws 1500-2400 s) | this run | the same |
| `guild_store` | `EventOnly('guild_claim')`, raised by a guild flow that claimed something | this run | the same, trigger `dependency`, `host.parent_execution` = the guild visit |
| `free_store_gems` | `DailyCalendar(utc, 01:00 +/- 600 s, retry 300 s, close on confirmed)` | account | the same, `occurrence_key` = the UTC day |
| `quest_scan`, `shatter`, `housekeeping` | `DailyCalendar(local, floor 03:00, close on attempted)` | installation | `scheduling/chores.py` through an operation-scoped session |

- **The day is the date, the hour is a floor.** A chore is closed for the local date (it rolls at local midnight); 03:00 is only the hour from which the first Home gap may run it.
- **One attempted chore per gap (C1).** A chore that raised used the gap like one that completed. Before this, a failing chore let the next one run in the same gap, and a limit of two let three run.
- **Handler completion is not a game effect.** A flow that ends normally is `succeeded` with effect `unknown`, unless the host proved one (`FlowHistory.proved`): a guild flow that claimed
  milestones (`milestones_claimed`), a free-gems flow that saw the cooldown on the card (`cooldown_shown`). An action whose definition lists evidence is `succeeded` only with it; a flow that
  completed without proof is `no_op`.
- **A daily-state write the file refuses** (its lock stayed held) is logged (`daystate_write_failed`) and kept in this process (`global_rewards._unsaved`, `chores._unsaved`), so one busy
  file does not make a check or a chore repeat on every pass. A restart forgets it, which is the old crash behaviour.
- **Unreadable inputs are `blocked`, never zero.** NaN, infinity, a negative or a non-number clock reads as `invalid_state`; a time the calendar cannot express reads the same.
- **Removed:** `global_rewards.check_due/checked/store_due/store_claimed`, the orchestrator's free-gems cap helpers and the daily-state UTC counters (nothing called them).

## Adding an action (what the contract asks, and nothing else)

1. **A definition** in the catalog (`action_contract.py`): id, label, family, the driver kinds that may run it, a schedule policy, its
   `Field`s (`live`, `saved`, bounds, unit), its `Capabilities` (`live_controls`, `pause`, `run_now`, `variants`), the name of its saved
   adapter (or none), the blueprint kinds that carry its saved settings (`saved_kinds`, none = every kind), any whole-object control it owns
   (`documents`, with a validator registered through `control_settings.register_document_validator`). A definition with `restricted` set,
   or whose `run_now` is not `True`, is never offered a Run now whatever its binding says.
2. **A binding** for each configured instance, registered by the driver (`rs.action_bindings = {routine key: binding}`; the routine key is
   the action id, or `<action>@<instance>` for one of several instances, the instance being lower-case letters, digits, `_` and `-`): how a
   value is installed (`configure`, `configure_document`), whether a request is accepted (`request_now`) and how far it has come
   (`progress()`, which acknowledges the command from THIS binding's own evidence: `pending`, `started`, `terminal`), the routine status
   (`routine`), and `busy()` while it owns the foreground. A binding that reports no `progress()` has no Run now.
3. **A recorder** call pair in the handler (`session.recorder(action, instance).opened(...)` and `.closed(...)`, or `record` / `check`): the
   execution row, its timing and its evidence. The row is written after the input, never before.
4. **A saved adapter** when the action saves numbers (`SavedAdapter`: `keys`, `read`, `apply`, `prepare`, `write`, `finish`, `extras`),
   registered by name in `player/saved_controls.py`. Its `enabled` flag needs none: blueprint `automation` is validated against the catalog.
   The profile schema is closed on purpose, so a saved number also needs its row there (a key in the policy that holds it).

`test_action_synthetic_extension.py` does exactly this for a test-local `synthetic_probe` (two instances) in a COPY of the catalog and
drives it through the real routes.

## Tests

Golden traces captured before any edit pin the cadence of every pilot caller (`backend/tests/fixtures/action_golden_v1.json`,
explicit regeneration only: `TP_REGENERATE_ACTION_GOLDEN=1 python -m pytest backend/tests/unit/test_action_golden_capture.py`).
Golden traces of the control dispatch, the Run now acknowledgements, the published routines and the saved-setting transforms were captured
the same way before the dispatch was generated (`backend/tests/fixtures/action_dispatch_golden_v1.json`, `TP_REGENERATE_ACTION_DISPATCH_GOLDEN=1
python -m pytest backend/tests/unit/test_action_dispatch_capture.py`); `test_action_dispatch_parity.py` replays them.
Parity, interruption, ownership, ledger, session, route and synthetic-extension tests are the `backend/tests/unit/test_action_*.py` files;
`test_action_declared_proofs.py` holds the proofs the declaration of item 6 still needed and the map from the declaration to the tests.