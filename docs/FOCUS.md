# Tower Pilot: current focus
> **Status:** Active
> **Type:** Queue
> **Created:** 2026-10-24
> **Updated:** 2026-10-30
> **Tags:** backlog, queue, planning

The order of the open work, and nothing else. Each row links one task file in
[pending-tasks](pending-tasks/); the task file holds the problem, steps, files and done
criteria. How a task moves from filed to landed and live-checked, the definition of done,
and the upstream sync are in the [delivery flow](../.claude/skills/delivery-flow/SKILL.md).
`backend/tests/unit/test_backlog.py` fails when an open task is missing here or a link
breaks.

## Goal for this stretch

Put what the fork has built into users' hands: the takeover control on the new dashboard,
a qualified 0.6-beta release, and the fork's work offered back upstream.

---

## Next (code work, in order)

| # | Task | Blocked by |
|---|---|---|
| 1 | [Takeover controls on the new dashboard](pending-tasks/%5B2026-10-30%5D%5BOpen%5D%20Takeover%20controls%20on%20the%20new%20dashboard.task.md) | - |
| 2 | [Portable build qualification in the release workflow](pending-tasks/%5B2026-10-30%5D%5BOpen%5D%20Portable%20build%20qualification%20in%20the%20release%20workflow.task.md) | - |
| 3 | [Release 0.6-beta](pending-tasks/%5B2026-10-30%5D%5BOpen%5D%20Release%200.6-beta.task.md) | 2; the person records E1/E3 |
| 4 | [Setup scan metrics and identity](pending-tasks/%5B2026-10-30%5D%5BOpen%5D%20Setup%20scan%20metrics%20and%20identity.task.md) | - |
| 5 | [Setup scan sides and capture swap](pending-tasks/%5B2026-10-30%5D%5BOpen%5D%20Setup%20scan%20sides%20and%20capture%20swap.task.md) | 4; live gates D3, D5, D8 |
| 6 | [Guild store sold-out recognition](pending-tasks/%5B2026-10-19%5D%5BOpen%5D%20Guild%20store%20sold-out%20recognition.task.md) | a calibration session the person starts |
| 7 | [Guild store terminal section evidence](pending-tasks/%5B2026-10-20%5D%5BOpen%5D%20Guild%20store%20terminal%20section%20evidence.task.md) | a calibration session the person starts |
| 8 | [Action history leftovers](pending-tasks/%5B2026-10-30%5D%5BOpen%5D%20Action%20history%20leftovers.task.md) | - |
| 9 | [Render-time latency measurement](pending-tasks/%5B2026-10-30%5D%5BOpen%5D%20Render-time%20latency%20measurement.task.md) | the person: is the harness sample enough? |

At most two in flight, and only when they touch different files.

---

## Needs the person

| Task | What is asked |
|---|---|
| [Live acceptance checks owed](pending-tasks/%5B2026-10-30%5D%5BOpen%5D%20Live%20acceptance%20checks%20owed.task.md) | Natural live occurrences of six landed behaviors |
| [Visual acceptance of the dashboard pages](pending-tasks/%5B2026-10-30%5D%5BOpen%5D%20Visual%20acceptance%20of%20the%20dashboard%20pages.task.md) | Sign-off per page group on the rebuilt layout |
| [Open policy decisions](pending-tasks/%5B2026-10-30%5D%5BOpen%5D%20Open%20policy%20decisions.task.md) | Six rule questions from the 2026-10-24 council |

---

## Upstream

| Task | State |
|---|---|
| [Upstream sync of the fork](pending-tasks/%5B2026-10-30%5D%5BIn%20Progress%5D%20Upstream%20sync%20of%20the%20fork.task.md) | [TaBuPeH/TowerPilot#28](https://github.com/TaBuPeH/TowerPilot/pull/28) waits for a maintainer review |
