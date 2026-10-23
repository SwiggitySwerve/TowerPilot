# Latency gate fixtures (roadmap item 7, spec 3.7)

> **Status:** Active (package r18c: the gate exists and passes on the unmigrated code; no behaviour changed)
> **Type:** Rules
> **Created:** 2026-10-23
> **Owner:** Backend
> **Spec:** [roadmap-items-6-7/spec.md](../../../logs/reviews/roadmap-items-6-7/spec.md) section 3.7
> **Tags:** latency, fast rules, rescue, fleet nuke, orchestrator

## What this protects

The fast wall loop of the orchestrator (`_fast_wall_watch`) races a wall drain that is faster than a main-loop pass. A rescue tap that is late loses the run. Rows C-3 (fast rescue)
and C-4 (fleet nuke) of the caller checklist move the timing of those paths onto the shared schedule policies. Before either moves, this gate must exist and pass on the unmigrated code,
so that what a migration adds can be measured against the code as it was.

## The files

| File | What it is |
|---|---|
| `orchestrator_unmigrated.py.txt` | A byte copy of `backend/orchestrator.py` as it was when the gate was built. It is the reference of the timing replay and it must NEVER change (a test pins its hash). Its eleven fast-path functions are byte-identical to the checkout's `orchestrator.py` of the day (the report records the comparison). It is a `.txt` so nothing imports, compiles or lints it. |
| `baseline_structural_v1.json` | The I/O of one pass of each of fourteen paths of that snapshot (sqlite connections, file opens, lock acquisitions, image writes, log events, shots), up to the first tap and in total. |
| `../../latency_gate.py` | The harness: scripted worlds, instruments, the paired replay, the verdicts, the artifact. |
| `../../test_action_latency_gate.py` | The gate and its negative controls. |

## The two gates

1. **Structural (hard).** No path may do more I/O than the baseline, before its first tap or in total. A policy check is a comparison on host state; an execution record is written after the
   fire returns, never before the tap. A log event is counted as a file open and append (it is one in production).
2. **Timing (measured; the targets are provisional).** A seeded workload of 10,000 iterations is replayed through the snapshot and the live orchestrator, back to back, in alternating
   order, on identical scripted worlds. p99 of the added whole-call cost must be at most 100 microseconds, and p99 of the added time from the deciding frame to the first tap at most
   1 millisecond, overall and on every path. A miss is repeated once on another seed; the gate fails only if the repeat misses too.

## What it does not measure

Detection, capture and the adb round trip are fakes: it bounds what a migration ADDS, not the absolute latency of a rescue. The timing replay stubs `BattleSession.checkpoint` (its body is
identical on both sides); the structural pass runs the real checkpoint over a temporary ledger.

## Regenerating

Only the structural baseline can be regenerated, only on the snapshot, and only if the harness itself changed:

    TP_REGENERATE_LATENCY_BASELINE=1 python -m pytest backend/tests/test_action_latency_gate.py -k capture_the_structural_baseline

Never after a migration: the baseline is the proof of what the code did before. To keep the artifact of a run (source and build hashes, hardware, runtime, warm-up, distributions):

    TP_LATENCY_GATE_ARTIFACT=<path> python -m pytest backend/tests/test_action_latency_gate.py -k added_cost_of_the_live
