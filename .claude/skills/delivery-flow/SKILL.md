---
name: delivery-flow
description: How a Tower Pilot feature or fix goes from idea to landed and live-checked - the backlog (docs/pending-tasks), the queue (docs/FOCUS.md), one branch and PR per task, definition of done, live checks, and syncing with upstream TaBuPeH/TowerPilot in both directions. Load when picking up, filing, ordering or closing work, when asked "what's left", and before any upstream sync.
---

# Delivery Flow

**Every unit of work is one task file, one branch, one pull request, and one live check. The task file is the only place its state lives.**

## The four places

| What | Where | Rule |
|---|---|---|
| A unit of work: problem, steps, files, context, done criteria | `docs/pending-tasks/[YYYY-MM-DD][Status] Title.task.md` | Format and lifecycle: [pending-tasks](../pending-tasks/SKILL.md). Tracked in git. |
| What is next, in order | `docs/FOCUS.md` | Links to task files only; no task content is copied there. |
| Evidence for one task (logs, screenshots, review output) | `backend/logs/reviews/<task-slug>/` | Git-ignored and local. The task file links the folder and pastes the finding that matters. |
| Branch and PR mechanics | [git-workflow](../git-workflow/SKILL.md) | `--merge` only; never push to `master`. |

`backend/tests/unit/test_backlog.py` enforces the first two: names match headers, required sections exist, every open task is queued, and every queue link resolves.

---

## Lifecycle

```
idea / finding -> task file (Open) -> queued in FOCUS.md -> branch + PR (In Progress)
  -> review -> merged -> live check -> task Done (rename) -> next upstream sync
```

1. **File it.** A finding becomes a task file when [pending-tasks](../pending-tasks/SKILL.md)' rubric says file; otherwise fold it into the current PR. Search `docs/pending-tasks/` first and update an existing task over a near-duplicate.
2. **Queue it.** Add one row to the right `docs/FOCUS.md` table: *Next* (code work, in order), *Needs the person* (a live run, visual acceptance or a decision), or *Upstream*.
3. **Start it.** Rename to `[In Progress]`, branch `feat|fix|test|docs|ci|chore/<slug>` off the current `master`, write the failing test first.
4. **Land it.** One PR to the fork's `master` per task; CI must be green. The PR description links the task file.
5. **Check it live.** Anything that reaches the collector or dashboard is deployed between battles (`python tools/collector_restart.py`, README) and checked with `python tools/gem_health.py`. Ad and orbit successes keep their usual rate, or new work stops until the drop is explained.
6. **Close it.** Rename to `[Done]`, set `> **Status:** Done`, add the merge commit and the live-check result, and remove its `FOCUS.md` row.

---

## Definition of done

1. One purpose, small diff (aim for a few thousand lines, well under 100,000 with fixtures; split regenerated fixtures into their own PR).
2. A test that fails before and passes after, or a stated reason none is possible.
3. Focused tests pass; the full backend suite (`python -m pytest backend/tests/unit`) passes when shared code moves; frontend changes run typecheck, lint and affected tests.
4. Moved recorded fixtures are regenerated through their writers, every moved value explained.
5. One independent review of the final diff; changes to the live collection path or safety rules get a second.
6. Merged with CI green, deployed between battles if runtime files changed, and checked on the live Dashboard (step 5 above).

At most two PRs in flight, and only when they touch different files.

---

## Upstream sync

The fork (`origin`, SwiggitySwerve) and the original (`upstream`, TaBuPeH) both move.

| Direction | When | Steps |
|---|---|---|
| Intake: upstream -> fork | Upstream merges to `develop`, or before an outbound sync | `python tools/upstream_parity.py` -> merge each reported upstream branch into a `chore/upstream-intake-<date>` branch (merge, never cherry-pick, so upstream's later merges do not conflict) -> PR to fork `master` |
| Outbound: fork -> upstream | A set of landed tasks is worth offering | Branch off fork `master` -> `tools/upstream_parity.py` must PASS -> PR to `TaBuPeH/TowerPilot:develop` |

Upstream `develop` requires a maintainer approval and runs no CI on pull requests (both repos' CI triggers on `master` only), so the full backend suite run locally is the proof in the PR description. A removal the parity tool reports is either restored or listed in `tools/upstream_parity_allow.json` with its reason.

---

## Working rules

- Never stop, restart or touch the emulator (MuMu) or adb; only the dashboard and collector are restarted, and only between battles. Hard rules: [CLAUDE.md](../../../CLAUDE.md).
- Tests never reach live ports (`backend/tests/conftest.py` refuses 5037, 8620 and 8630).
- Do not edit a tree a long test run or a live process is using; work in a separate worktree when a runner launches from the checkout.

---

## Anti-Patterns

| Wrong | Right | Why |
|---|---|---|
| Remaining work written in a git-ignored `STATE.md` or review folder | A task file in `docs/pending-tasks/` that links the evidence folder | Ignored files are invisible to every other clone and session |
| Task details copied into `FOCUS.md` | One link per task in `FOCUS.md` | Two copies diverge on the first status change |
| Status changed in the header but not the filename | Rename the file and edit the header together | `test_backlog.py` fails on a mismatch |
| Cherry-picking an upstream fix | Merging the upstream branch | Upstream's own merge of the same branch then conflicts |
| One-off parity scripts in a scratch folder | `tools/upstream_parity.py` plus its allowlist | The check is repeatable and its exceptions carry reasons |

---

## See Also

- [pending-tasks](../pending-tasks/SKILL.md) - task file format, lifecycle and the file-or-fold rubric
- [git-workflow](../git-workflow/SKILL.md) - branch, commit and merge mechanics
- [finish-the-scope](../finish-the-scope/SKILL.md) - mid-task discoveries become task files, not pivots
