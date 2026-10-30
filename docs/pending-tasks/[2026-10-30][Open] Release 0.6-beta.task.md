# Release 0.6-beta
> **Status:** Open
> **Type:** Task
> **Created:** 2026-10-30
> **Updated:** 2026-10-30
> **Priority:** Medium
> **Tags:** release, roadmap-item-10

## Problem

Everything since 0.5-beta (the new dashboard, run lifecycle, persistent harvesting,
takeover backend, preview, observability) is unreleased. `VERSION` is `0.5-beta`, there is
no `v0.6-beta` tag, and `docs/RELEASE_0.6_BETA.md` is a draft whose user-facing change list
is still to be written.

---

## What Needs to Happen

1. Land [Portable build qualification in the release workflow](%5B2026-10-30%5D%5BOpen%5D%20Portable%20build%20qualification%20in%20the%20release%20workflow.task.md) first.
2. Write the user-facing change list in `docs/RELEASE_0.6_BETA.md` from the merged PRs
   (`gh pr list -R SwiggitySwerve/TowerPilot --state merged`).
3. Raise `VERSION` to `0.6-beta` in a release PR; follow `docs/GITHUB_RELEASE.md` for the tag.
4. Record E1 and E3 by hand on Windows 11 and E2 from the workflow run
   (`docs/PORTABLE_BUILD.md`), then set the note's status from Draft to final.

---

## Key Files

| File | Why |
|---|---|
| `VERSION` | Release version the tag check reads |
| `docs/RELEASE_0.6_BETA.md` | The note; its Environment limits must match the recorded checks |
| `docs/GITHUB_RELEASE.md`, `docs/PORTABLE_BUILD.md` | Tag procedure and E1-E3 |
| `.github/workflows/release.yml` | Builds and publishes on the tag |

---

## Context

The note's builder-packaging warning was stale (`tools/build_release.py:25` already lists
`RELEASE_0.6_BETA.md`) and was removed on 2026-10-30. Whether to release from the fork, or
to wait for upstream to take [the upstream sync](%5B2026-10-30%5D%5BIn%20Progress%5D%20Upstream%20sync%20of%20the%20fork.task.md)
and release there, is the person's call.

---

## Success Criteria

- [ ] `v0.6-beta` tag published by `release.yml` with both ZIPs and their `.sha256` files.
- [ ] E1, E2 and E3 recorded; the note's limits match them.
- [ ] Release note status is final and its change list matches the merged PRs.
