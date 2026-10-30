# Portable archive gate rejects pinned dependency text
> **Status:** Done
> **Type:** Task
> **Created:** 2026-10-30
> **Updated:** 2026-10-30
> **Priority:** High
> **Tags:** release, portable, privacy-gate, roadmap-item-10

## Problem

No portable ZIP can pass the release archive gate, so `release.yml` cannot publish a
portable build. Running `python tools/check_release_zips.py` (and the single-archive mode
`--archive ... --kind portable`) on a fresh `tools/build_portable.py` build on 2026-10-30
reported content-marker hits in third-party files only, all under `runtime/` (the bundled
interpreter and the pinned wheels):

| Marker | Where (examples) |
|---|---|
| `email` | author addresses in `*.dist-info/METADATA` of ~30 packages; source headers in `PIL`, `numpy`, `jinja2`, `werkzeug`, `six.py`, `cv2`; `runtime/LICENSE.txt` |
| `url-credentials` | 6 files under `runtime/Lib/site-packages/fsspec/` (documentation examples) |
| `windows-user-profile` | `numpy`, `numpy-2.5.2.dist-info`, `opencv_python-5.0.0.93.dist-info` |

The gate (`tools/release_archive_policy.py`, `content_problems`) waives only dependency
licence files for the `email` marker and deliberately does not waive `METADATA`, `RECORD`
or code, because archive-supplied files cannot vouch for themselves.

---

## What Needs to Happen

1. Inspect each `windows-user-profile` hit: decide whether it is upstream text in the
   pinned wheel (identical bytes) or a path our build wrote. A build-written path is a
   real leak and must be fixed in `tools/build_portable.py`, not waived.
2. Waive by provenance, never by location: extend the trusted, generated checker data
   (the pattern of `tools/dependency_images.json` and `tools/generate_dependency_images.py`)
   with the exact path and SHA-256 of every installed file whose bytes are identical to a
   member of a hash-pinned artifact. A marker in such a file is upstream's text, not ours.
   Files that differ from their pinned source (generated `RECORD`, `INSTALLER`, `.pyc`, the
   embedded interpreter's files) get no waiver and are checked as now.
3. Keep every other marker check and the local forbid list for every file; keep the
   generator stale-checked against `tools/portable_pins.json`, as images are.
4. Tests with synthetic archives: a pinned identical file with an author address passes;
   the same path with one changed byte fails; a build-written file with a user path fails.

---

## Key Files

| File | Why |
|---|---|
| `tools/release_archive_policy.py` | `content_problems`, `_dependency_licence`, `dependency_images` |
| `tools/check_release_zips.py` | Both gate modes call `_check_archive` |
| `tools/generate_dependency_images.py`, `tools/dependency_images.json` | Trusted provenance data to extend |
| `tools/portable_pins.json`, `requirements-portable.lock` | Hash-pinned artifacts |
| `tools/build_portable.py` | Where a build-written path would come from |

---

## Context

Found while proving [Portable build qualification in the release workflow](%5B2026-10-30%5D%5BDone%5D%20Portable%20build%20qualification%20in%20the%20release%20workflow.task.md)
(PR #26): with only this gate bypassed, `tools/qualify_portable.py` passes every check on the
real ZIP (archive, imports, identity, app, config, unchanged). The failure predates PR #26:
the existing "Check release archives" step fails on the same build. The fork has not
published a release since 0.5-beta, so this was never exercised.

---

## Success Criteria

- [ ] `tools/check_release_zips.py` passes on a fresh portable build with no waiver by location.
- [ ] Every `windows-user-profile` hit is explained as upstream bytes or fixed in the build.
- [ ] Synthetic tests prove a changed byte or a build-written path still fails.
- [ ] `tools/qualify_portable.py` passes on the same build, gate included.

---

## Outcome

Landed in [SwiggitySwerve/TowerPilot#28](https://github.com/SwiggitySwerve/TowerPilot/pull/28), merge commit `582af228`, on 2026-10-30. All three windows-user-profile hits were upstream wheel bytes; nothing was written by the build. The pins hash is taken over LF bytes so a CRLF checkout cannot break the gate.
