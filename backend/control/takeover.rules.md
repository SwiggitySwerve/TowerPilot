# Takeover, server side

> **Status:** Active
> **Type:** Rules
> **Created:** 2026-10-24
> **Updated:** 2026-10-24
> **Owner:** `control/takeover.py`, `control/battle_lineage.py`, the `takeover` routes of `dashboard.py`

This is the one place the server's takeover rules are written down. The policy (what an attached preset keeps, strips or needs a tier for, the request and
envelope shapes) belongs to `player/attach_policy.py` ([rules](../player/attach_policy.rules.md)); the worker's entry gate belongs to the orchestrator (T3b).

## Routes

| Route | Meaning |
|---|---|
| `GET /api/takeover/preview[?preset=]` | Read-only. Without `preset`: every runnable run with a verdict. With one: verdict, plan, `policy_revision`, attached readiness, setup-battle guard, owners, `current_battle`, `blockers`. Never launches, retires or records anything |
| `POST /api/control {action: "takeover"}` | Admission, then the transfer and launch `start` uses, with the restricted envelope |
| `GET /api/battles/active`, `/api/battles/<id>` | Additive `attach` and `lineage` on a battle launched by a takeover; absent on every other battle |

## Admission order (nothing before the collector's input stops may change state)

1. Body shape (`parse`): unknown, missing or reserved keys (`harvest`, `desire_revision`, `battle_envelope`) are 400 `invalid_request` with `reason` and `field`.
   Then an identical recorded key replays its operation; the same key with any other request is the uncoded 409 of `operation_api.retry`.
2. `expected_context` equals the context now, else 409 `context_changed` (with `current_context`).
3. The run exists and is runnable (else 400 `unknown_preset`) and `attach_policy.compatibility` is clear, else 409 `takeover_not_compatible` with `reasons[]`.
4. `policy_revision` equals the revision recomputed now, else 409 `policy_changed` (with `current_policy_revision`).
5. The run-scope setup-battle guard; no collection handoff counts.
6. Attached readiness: 409 `tournament_recognition_missing` when the trophy badge is among the missing, else 409 `calibration_needed`, both with `missing`.
7. Owners: none, or only standalone collectors; any other owner is the shared `device_owned` body.
8. `expected_battle` against the collector's active ledger record: same battle id and generation, and the record's wave no more than `WAVE_MARGIN` below the wave the
   person saw (a battle only moves forward). Else 409 `attach_battle_changed` (with `current_battle`). With no collector all three ids are null.
9. The envelope (`restrict_parts`): `attach_policy.restrict_envelope` over the effective preset, controls and frozen configuration, plus `envelope.attach`
   (policy revision, tier as declared, stripped keys, the collector's `{battle_id, generation, operation_id}` or null). Server-derived facts live only in the envelope,
   which the receipt comparison ignores, so an honest retry still matches.
10. `_transfer_from_collector` and `_launch_operation(..., restrict=...)`, `end_transfer` in a `finally`, exactly as `start`.

## The observed wave

The server reads no screen. `current_battle.observed_wave` is the last wave the standalone collector published on its battle record, and `wave_source` says so
(`collector_record`); with no collector record everything is null and `wave_source` is `none`. The worker proves the battle from the screen before its first input.

## Invariants

- No device import: the takeover modules import no `device`, `cv2` or `numpy` (a test pins it).
- A preview and a refused takeover write nothing: no ledger is created, no operation is retired.
- A takeover is a `run` operation; there is no new operation kind and no battle command.
- `lineage` is computed on read (bounded by `LINEAGE_LIMIT`, same device only); it is never stored.
