# Upstream sync of the fork
> **Status:** In Progress
> **Type:** Task
> **Created:** 2026-10-30
> **Updated:** 2026-10-31
> **Priority:** Medium
> **Tags:** upstream, release

## Problem

The fork (SwiggitySwerve/TowerPilot) carries everything since 0.5-beta; the original
(TaBuPeH/TowerPilot) has none of it. Upstream's own open fix #27 (fleet scan from the mark)
is not on the fork's `master`.

---

## What Needs to Happen

1. Wait for a maintainer review on [TaBuPeH/TowerPilot#28](https://github.com/TaBuPeH/TowerPilot/pull/28)
   (`feat/upstream-parity` into `develop`); answer review comments on that branch.
2. Done 2026-10-31: fork PR #39 merged `feat/upstream-parity` into fork `master` (merge
   commit, SHAs kept), closing the fork's missing #27 and the two fixes made on that branch.
3. After both merge, run `python tools/upstream_parity.py`; it must PASS with no branch gaps.

---

## Key Files

| File | Why |
|---|---|
| `tools/upstream_parity.py`, `tools/upstream_parity_allow.json` | The repeatable parity check and its reasoned exceptions |
| `.claude/skills/delivery-flow/SKILL.md` | The intake and outbound sync procedure |

---

## Context

PR #28 (head `7d9bed13`) contains: upstream #27 merged with history kept; a fix so
`fleet.sighting.enabled: false` waits for mark+`after_waves`; and a fix for the psutil
`.info` race (`KeyError: 'pid'` in runner discovery). Proof: full backend suite 7045 passed,
96 skipped; Sol approved after 2 rounds. Upstream `develop` requires a maintainer approval
and runs no CI on pull requests. Since fork PR #39 (2026-10-31) the parity tool reports
0 gaps on the fork's `master`; what remains is upstream merging #28.

---

## Success Criteria

- [ ] PR #28 merged upstream, or closed with the maintainer's reason recorded here.
- [x] Fork `master` contains #27; `tools/upstream_parity.py` passes on `master` (fork PR #39, merged 2026-10-31; the tool reports 0 gaps).
