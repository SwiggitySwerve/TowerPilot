# Gem collector in-battle overlay exclusion
> **Status:** Open
> **Type:** Task
> **Created:** 2026-11-04
> **Updated:** 2026-11-04
> **Priority:** Medium
> **Tags:** gem-collector, recognition, safety

## Problem

The gem collector collects only while the screen classifier says `battle` with a readable
wave (`backend/gem_collector.py`, the `live` check). The classifier in
`backend/vision/screen.py` checks its `OVERLAYS` list first, then, when no screen header
matches, returns `Screen("battle", ...)` for any frame where `wave_reader.read_wave(frame)`
reads a wave (the `if best_s < HDR_THRESH:` fallback near the end of `identify`). The
`OVERLAYS` list has no entry for the in-battle perk dialog or other in-game panels drawn over
a running battle, so a frame with such a panel open and the wave still readable classifies
as `battle`.

Ad claims also check foreground windows (`backend/device/overlays.py`), but that check
accepts the game's own package, so it does not detect an in-game panel. Orbit collection
adds motion, geometry and per-tap screen checks (`backend/flows/shard.py`).

No real mis-tap over an overlay was found: a log audit on 2026-11-04 of 102 collector process
logs under `backend/logs/main/` found no input event naming an overlay. Taps logged while
the collector state is `collecting` carry no `surface`, so the screen under them is not
recorded either way.

---

## What Needs to Happen

1. List the in-game panels that can open over a running battle with the wave still visible
   (perk choice dialog, and any others found on the player's own screens) and how each is
   recognized today, if at all.
2. Make the collector refuse input while one is up: either new `OVERLAYS` entries
   (account-local templates cut by the human-started calibrator, per CLAUDE.md rule 6 and
   the image-free release boundary) or a battle check that needs more than a readable wave.
3. Keep the dispatch-time input gate (`backend/device/act.py`, `input_scope`) and Abort
   propagation (`backend/interactions/ad_gems.py`) unchanged.
4. Add synthetic regressions: a frame with a readable wave plus each overlay classifies as
   not-`battle` (or the collector sends no input on it); a clean battle frame still collects.

---

## Key Files

| File | Why |
|---|---|
| `backend/vision/screen.py` | `OVERLAYS` list and the readable-wave `battle` fallback in `identify` |
| `backend/gem_collector.py` | The `live` battle check that gates collection |
| `backend/interactions/ad_gems.py` | Ad claim verification before dispatch; Abort handling |
| `backend/flows/shard.py` | Orbit collection's motion, geometry and per-tap screen checks |
| `backend/device/overlays.py` | Foreground-window check (accepts the game package) |
| `backend/device/act.py` | The one input boundary (`input_scope`) that must stay as is |

---

## Context

- Found while removing Home claims from the collector (2026-11-04). The person chose
  battle-only collection, and chose to track overlay hardening here instead of in that PR.
- The research notes and log audit are local, in `backend/logs/reviews/` (git-ignored).
  Counts from the audit: ad claims in battles 710 started / 709 finished, 681 confirmed;
  orbit windows 336 started / 333 finished, 198 confirmed, 135 `attempt_timeout`.
- This touches screen recognition that every flow uses, so changes need the per-machine
  variant approach from CLAUDE.md ("never by lowering thresholds") and a live check.

---

## Success Criteria

1. With a known in-battle overlay open, the collector sends no input; synthetic tests prove it.
2. Ad and orbit success rates in battle keep their usual level after a deploy between
   battles (`python tools/gem_health.py`).
